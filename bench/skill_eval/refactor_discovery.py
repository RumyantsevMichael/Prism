#!/usr/bin/env python3
"""Measure how many known refactoring candidates a refactor analysis finds in a pinned repository."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CATALOG = Path(__file__).resolve().parent / "refactor-discovery" / "prism-d146852.json"
PROMPT = (
    "/prism:refactor Analyze this whole repository for refactoring candidates. "
    "This is an analysis request: do not change any files. "
    "Return the ranked candidates with their evidence, the proposed transformation for each, and the discovery coverage."
)
# A scoped run names its target, as a developer who knows what to refactor would.
SCOPED_PROMPT = (
    "/prism:refactor Analyze {paths} for refactoring candidates. "
    "This is an analysis request: do not change the code. "
    "Return the ranked candidates with their evidence, the proposed transformation for each, and the discovery coverage."
)
# A concept delta and its review projections are server-managed evidence, not edits to the analyzed code.
MANAGED_OUTPUT = re.compile(r"(^|/)(concept-delta\.json|review\.json|review\.md)(\.lock)?$")
# The machine-readable tail is the only harness addition to the user request; scoring reads nothing else.
RESULT_INSTRUCTION = (
    "\n\nEnd your answer with one fenced json block of the form "
    '{"candidates": [{"title": "...", "verdict": "candidate" or "keep", "locations": [{"file": "repo-relative path", "lines": "start-end"}]}]}. '
    "List every candidate you propose with verdict candidate, and every similarity you investigated and decided to keep with verdict keep. "
    "Give each place the candidate involves as a file and its line range."
)
# Analysis must not edit, so the agent gets read, search, read-only git, subagents, and Prism's own tools.
ALLOWED_TOOLS = [
    "Read", "Grep", "Glob", "Task", "Agent", "ToolSearch",
    "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)", "Bash(git ls-files:*)", "Bash(wc:*)",
    "mcp__plugin_prism_prism-review__*",
]
# The plain variant asks for the list only after the analysis ends, in a resumed turn with no tools, so the list cannot steer the investigation.
LIST_FOLLOW_UP = "Without investigating further, restate the candidates and kept similarities from your answer above." + RESULT_INSTRUCTION
STATUS_TOOL = "mcp__plugin_prism_prism-review__get_repository_intelligence_status"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


def clean_env(config_dir: Path | None) -> dict[str, str]:
    # A nested or cloud session exports CLAUDE* variables, including memory paths, that would leak context into a blind run.
    env = {key: value for key, value in os.environ.items() if not key.startswith("CLAUDE")}
    if config_dir:
        env["CLAUDE_CONFIG_DIR"] = str(config_dir)
    return env


def parse_stream(stdout: str) -> dict[str, object]:
    tools: dict[str, int] = {}
    denied = 0
    result: dict[str, object] = {}
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_use":
                    tools[block["name"]] = tools.get(block["name"], 0) + 1
        elif event.get("subtype") == "permission_denied":
            denied += 1
        elif event.get("type") == "result":
            result = event
    usage = result.get("usage") or {}
    return {
        "output": result.get("result") or "",
        "session_id": result.get("session_id"),
        "error": "agent reported an error" if result.get("is_error") else (None if result else "no result event"),
        "cost_usd": result.get("total_cost_usd"),
        "turns": result.get("num_turns"),
        "usage": {
            "input_tokens": usage.get("input_tokens") or 0,
            "cached_input_tokens": (usage.get("cache_creation_input_tokens") or 0) + (usage.get("cache_read_input_tokens") or 0),
            "output_tokens": usage.get("output_tokens") or 0,
        },
        "tool_calls": sum(tools.values()),
        "status_polls": tools.get(STATUS_TOOL, 0),
        "prism_tool_calls": sum(count for name, count in tools.items() if name.startswith("mcp__plugin_prism_")),
        "permission_denials": denied,
    }


def extract_candidates(output: str) -> list[dict[str, object]] | None:
    blocks = re.findall(r"```json\s*(\{.*?\})\s*```", output, re.DOTALL)
    for block in reversed(blocks):
        try:
            payload = json.loads(block)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and isinstance(payload.get("candidates"), list):
            return [candidate for candidate in payload["candidates"] if isinstance(candidate, dict)]
    return None


# A span is one contiguous place: a definition or line range in one file.
Span = tuple[str, set[int]]


class Source:
    """Files of the catalog commit, read through git so scoring needs no checkout."""

    def __init__(self, repository: Path, commit: str):
        self.repository, self.commit, self.cache = repository, commit, {}
        self.paths = git(repository, "ls-tree", "-r", "--name-only", commit).splitlines()

    def lines(self, path: str) -> list[str] | None:
        if path not in self.cache:
            self.cache[path] = git(self.repository, "show", f"{self.commit}:{path}").splitlines() if path in self.paths else None
        return self.cache[path]


def definition_range(lines: list[str], start: int, python: bool) -> tuple[int, int]:
    # A definition ends where its brackets close, or for Python where the indentation returns to the definition's level.
    if python and lines[start].lstrip().startswith(("def ", "class ")):
        indent = len(lines[start]) - len(lines[start].lstrip())
        end = start
        for index in range(start + 1, len(lines)):
            if lines[index].strip() and len(lines[index]) - len(lines[index].lstrip()) <= indent:
                break
            if lines[index].strip():
                end = index
        return start + 1, end + 1
    depth, opened = 0, False
    for index in range(start, len(lines)):
        for char in lines[index]:
            if char in "{[":
                depth, opened = depth + 1, True
            elif char in "}]":
                depth -= 1
        if opened and depth <= 0 or not opened:
            return start + 1, index + 1
    return start + 1, start + 1


def symbol_spans(source: Source, path: str, symbol: str) -> list[Span]:
    name = re.escape(symbol)
    pattern = re.compile(rf"(\bfunction\s*\*?\s+{name}\s*\(|^(export\s+)?(const|let|var|class)\s+{name}\b|^\s*(async\s+)?{name}\s*\([^)]*\)\s*\{{|^\s*def\s+{name}\s*\(|^{name}\s*=)")
    found: list[Span] = []
    for candidate in [p for p in source.paths if p.startswith(path)] if path.endswith("/") else [path]:
        lines = source.lines(candidate) or []
        for index, line in enumerate(lines):
            if pattern.search(line):
                first, last = definition_range(lines, index, candidate.endswith(".py"))
                found.append((candidate, set(range(first, last + 1))))
    return found


def item_spans(source: Source, item: dict[str, object]) -> list[Span]:
    spans: list[Span] = []
    for location in item["locations"]:
        if "symbol" in location:
            resolved = symbol_spans(source, location["file"], location["symbol"])
            if not resolved:
                raise SystemExit(f"{item['id']}: {location['symbol']} not found in {location['file']} at {source.commit}")
            spans += resolved
        else:
            first, last = location["lines"]
            spans.append((location["file"], set(range(first, last + 1))))
    return spans


def reported_spans(source: Source, candidate: dict[str, object]) -> list[Span]:
    # A location without a usable line range stands for its whole file, so a vague citation is as large as the file.
    spans: list[Span] = []
    for location in candidate.get("locations") or []:
        if not isinstance(location, dict):
            continue
        path = str(location.get("file") or "").strip().lstrip("./").split(":")[0]
        content = source.lines(path)
        if content is None:
            continue
        numbers = re.findall(r"\d+", str(location.get("lines") or ""))
        first, last = (int(numbers[0]), int(numbers[-1])) if numbers else (1, len(content))
        spans.append((path, set(range(first, last + 1))))
    return spans


def pins(cited: Span, site: Span) -> bool:
    # A citation pins a site when it is about as tight as the site and mostly overlaps it, so a whole function does not pin one call inside it.
    overlap = len(cited[1] & site[1]) if cited[0] == site[0] else 0
    return overlap > 0 and overlap >= 0.5 * min(len(cited[1]), len(site[1])) and len(cited[1]) <= 4 * len(site[1]) + 5


def candidate_matches(cited: list[Span], sites: list[Span]) -> bool:
    # One site must be pinned, and an item with several sites needs a second one at least touched, because the item is their relationship.
    touched = sum(any(path == site[0] and numbers & site[1] for path, numbers in cited) for site in sites)
    return any(pins(span, site) for span in cited for site in sites) and touched >= min(2, len(sites))


def in_scope(path: str, scope: list[str]) -> bool:
    return not scope or any(path == entry.rstrip("/") or path.startswith(entry.rstrip("/") + "/") for entry in scope)


def score_run(record: dict[str, object], catalog: dict[str, object], source: Source) -> dict[str, object]:
    # A scoped run counts only items with a site in its scope, and matches them by those sites alone.
    scope = list(record.get("scope") or [])
    candidates = extract_candidates(str(record.get("output") or ""))
    if candidates is None:
        return {"parsed": False}
    proposed = [candidate for candidate in candidates if candidate.get("verdict") == "candidate"]
    kept = [candidate for candidate in candidates if candidate.get("verdict") == "keep"]
    proposed_spans = [reported_spans(source, candidate) for candidate in proposed]
    kept_spans = [reported_spans(source, candidate) for candidate in kept]
    items = {}
    matched_candidates: set[int] = set()
    for item in catalog["items"]:
        sites = [site for site in item_spans(source, item) if in_scope(site[0], scope)]
        if not sites:
            continue
        found = [index for index, spans in enumerate(proposed_spans) if candidate_matches(spans, sites)]
        matched_candidates.update(found)
        outcome = "found" if found else "kept" if any(candidate_matches(spans, sites) for spans in kept_spans) else "missed"
        items[item["id"]] = {"label": item["label"], "outcome": outcome}
    expected = [value for value in items.values() if value["label"] == "expected"]
    return {
        "parsed": True,
        "expected_found": sum(value["outcome"] == "found" for value in expected),
        "expected_total": len(expected),
        "recall": round(sum(value["outcome"] == "found" for value in expected) / len(expected), 3) if expected else None,
        "proposed": len(proposed),
        "kept": len(kept),
        # Unmatched proposals are neither right nor wrong until a person labels them into the catalog.
        "unmatched": [str(candidate.get("title")) for index, candidate in enumerate(proposed) if index not in matched_candidates],
        "items": items,
    }


def mock_output(catalog: dict[str, object], source: Source, rep: int) -> str:
    # Alternate halves of the catalog so the mock exercises found, missed, kept, and unmatched outcomes.
    candidates = []
    for index, item in enumerate(catalog["items"]):
        locations = [{"file": path, "lines": f"{min(numbers)}-{max(numbers)}"} for path, numbers in item_spans(source, item)[:2]]
        if index % 2 == rep % 2:
            candidates.append({"title": item["summary"], "verdict": "candidate", "locations": locations})
        elif index % 3 == 0:
            candidates.append({"title": item["summary"], "verdict": "keep", "locations": locations})
    candidates.append({"title": "Unlabeled mock finding", "verdict": "candidate", "locations": [{"file": "README.md", "lines": "1-5"}]})
    return "Mock analysis.\n\n```json\n" + json.dumps({"candidates": candidates}) + "\n```\n"


def changed_files(workspace: Path) -> tuple[list[str], list[str]]:
    paths = [line[3:] for line in git(workspace, "status", "--porcelain", "--untracked-files=all").splitlines()]
    return [path for path in paths if not MANAGED_OUTPUT.search(path)], [path for path in paths if MANAGED_OUTPUT.search(path)]


def concept_deltas(workspace: Path, managed: list[str]) -> dict[str, object]:
    deltas = {}
    for path in managed:
        if path.endswith("concept-delta.json") and (workspace / path).is_file():
            try:
                deltas[path] = json.loads((workspace / path).read_text())
            except json.JSONDecodeError:
                deltas[path] = None
    return deltas


def invoke(workspace: Path, config_dir: Path | None, timeout: int, prompt: str, *extra: str, model: str) -> tuple[str, str | None]:
    command = ["claude", "-p", prompt, "--model", model, "--output-format", "stream-json", "--verbose", *extra]
    try:
        completed = subprocess.run(command, cwd=workspace, env=clean_env(config_dir), capture_output=True, text=True, timeout=timeout)
        return completed.stdout, f"exit {completed.returncode}" if completed.returncode else None
    except subprocess.TimeoutExpired as exc:
        return (exc.stdout.decode(errors="replace") if isinstance(exc.stdout, bytes) else exc.stdout or ""), "timeout"


def run(args: argparse.Namespace) -> None:
    catalog = json.loads(Path(args.catalog).read_text())
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    plugin = Path(args.plugin).resolve()
    config_dir = Path(args.config_dir).resolve() if args.config_dir else None
    source = Path(args.source).resolve()
    files = Source(source, catalog["commit"])
    for rep in range(args.reps):
        with tempfile.TemporaryDirectory(prefix="refactor-discovery-") as temporary:
            workspace = Path(temporary) / "repo"
            git(source, "worktree", "add", "--detach", str(workspace), catalog["commit"])
            try:
                started = time.monotonic()
                if args.mock:
                    stdout, error = "", None
                    parsed = {"output": mock_output(catalog, files, rep), "session_id": None, "error": None, "cost_usd": 0.0, "turns": 0, "usage": {}, "tool_calls": 0, "status_polls": 0, "prism_tool_calls": 0, "permission_denials": 0}
                else:
                    request = SCOPED_PROMPT.format(paths=" and ".join(f"`{path}`" for path in args.scope)) if args.scope else PROMPT
                    prompt = request + (RESULT_INSTRUCTION if args.variant == "listed" else "")
                    stdout, error = invoke(workspace, config_dir, args.timeout, prompt, "--plugin-dir", str(plugin), "--allowedTools", *ALLOWED_TOOLS, model=args.model)
                    parsed = parse_stream(stdout)
                    if args.variant == "plain" and parsed["session_id"] and not error:
                        follow_stdout, follow_error = invoke(workspace, config_dir, args.timeout, LIST_FOLLOW_UP, "--plugin-dir", str(plugin), "--resume", str(parsed["session_id"]), "--tools", "", model=args.model)
                        follow = parse_stream(follow_stdout)
                        stdout += follow_stdout
                        error = follow_error or follow["error"]
                        parsed["analysis_output"] = parsed["output"]
                        parsed["output"] = follow["output"]
                        parsed["list_cost_usd"] = follow["cost_usd"]
                changed, managed = changed_files(workspace)
                record = {
                    "schema_version": 2,
                    "rep": rep,
                    "started_at": utc_now(),
                    "duration_s": round(time.monotonic() - started, 1),
                    "mock": args.mock,
                    "variant": args.variant,
                    "scope": args.scope or [],
                    "model": args.model,
                    "plugin": str(plugin),
                    "plugin_commit": git(plugin, "rev-parse", "HEAD").strip(),
                    "target_commit": catalog["commit"],
                    **parsed,
                    "error": error or parsed["error"],
                    "changed_files": changed,
                    "managed_files": managed,
                    "concept_deltas": concept_deltas(workspace, managed),
                }
                record["score"] = score_run(record, catalog, files)
                name = f"rep-{rep}"
                (out / f"{name}.json").write_text(json.dumps(record, indent=2) + "\n")
                if not args.mock:
                    (out / f"{name}.stream.jsonl").write_text(stdout)
                print(f"{name}: recall {record['score'].get('recall')} cost {record['cost_usd']} changed {len(record['changed_files'])} error {record['error']}")
            finally:
                git(source, "worktree", "remove", "--force", str(workspace))


def report(args: argparse.Namespace) -> None:
    catalog = json.loads(Path(args.catalog).read_text())
    files = Source(Path(args.source).resolve(), catalog["commit"])
    records = [json.loads(path.read_text()) for path in sorted(Path(args.results).glob("rep-*.json"))]
    for record in records:
        record["score"] = score_run(record, catalog, files)
    scored = [record for record in records if record["score"].get("parsed")]
    print(f"runs {len(records)}, scored {len(scored)}")
    if not scored:
        return
    recalls = [record["score"]["recall"] for record in scored]
    costs = [record["cost_usd"] for record in records if isinstance(record.get("cost_usd"), (int, float))]
    print(f"recall per run {recalls}, mean {sum(recalls) / len(recalls):.3f}")
    if costs:
        print(f"cost per run {[round(cost, 2) for cost in costs]}, total {sum(costs):.2f}")
    print(f"status polls per run {[record.get('status_polls') for record in records]}")
    print(f"changed files per run {[len(record.get('changed_files') or []) for record in records]}")
    if any(record.get("scope") for record in records):
        print(f"scope {sorted({path for record in records for path in record.get('scope') or []})}")
    findings = [sum(len((delta or {}).get("discoveryEvidence", {}).get("findings", [])) for delta in (record.get("concept_deltas") or {}).values()) for record in records]
    if any(findings):
        print(f"recorded discovery verdicts per run {findings}")
    print("\nitem                         label       found/runs  kept")
    for item in catalog["items"]:
        if item["id"] not in scored[0]["score"]["items"]:
            continue
        outcomes = [record["score"]["items"][item["id"]]["outcome"] for record in scored]
        print(f"{item['id']:<28} {item['label']:<11} {outcomes.count('found')}/{len(scored):<9} {outcomes.count('kept')}")
    union = {item_id for record in scored for item_id, value in record["score"]["items"].items() if value["outcome"] == "found" and value["label"] == "expected"}
    print(f"\nexpected items found by at least one run: {len(union)}/{scored[0]['score']['expected_total']}")
    print("\nunmatched proposals to label:")
    for record in scored:
        for title in record["score"]["unmatched"]:
            print(f"  rep {record['rep']}: {title}")


def locations(args: argparse.Namespace) -> None:
    catalog = json.loads(Path(args.catalog).read_text())
    files = Source(Path(args.source).resolve(), catalog["commit"])
    for item in catalog["items"]:
        resolved: dict[str, set[int]] = {}
        for path, numbers in item_spans(files, item):
            resolved.setdefault(path, set()).update(numbers)
        print(f"{item['id']} ({sum(len(numbers) for numbers in resolved.values())} lines)")
        for path, numbers in sorted(resolved.items()):
            ranges, ordered = [], sorted(numbers)
            for number in ordered:
                if ranges and number == ranges[-1][1] + 1:
                    ranges[-1][1] = number
                else:
                    ranges.append([number, number])
            print(f"  {path}: {', '.join(f'{a}-{b}' if a != b else str(a) for a, b in ranges)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run_parser = commands.add_parser("run", help="run repeated analysis-only refactor sessions against the pinned commit")
    run_parser.add_argument("--plugin", default=str(REPO_ROOT), help="Prism checkout to load with --plugin-dir")
    run_parser.add_argument("--source", default=str(REPO_ROOT), help="git repository that contains the catalog commit")
    run_parser.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    run_parser.add_argument("--out", required=True)
    run_parser.add_argument("--reps", type=int, default=3)
    run_parser.add_argument("--model", default="claude-opus-5-5")
    run_parser.add_argument("--config-dir", help="separate CLAUDE_CONFIG_DIR, so no memory or project history reaches the run")
    run_parser.add_argument("--timeout", type=int, default=3600)
    run_parser.add_argument("--variant", choices=("listed", "plain"), default="listed",
                            help="listed asks for the candidate list in the request; plain asks for it in a tool-less follow-up turn")
    run_parser.add_argument("--scope", nargs="+", help="repository paths that a targeted analysis covers; recall then counts only items with a site there")
    run_parser.add_argument("--mock", action="store_true", help="score generated output instead of invoking an agent")
    report_parser = commands.add_parser("report", help="score and summarize a results directory")
    report_parser.add_argument("results")
    report_parser.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    report_parser.add_argument("--source", default=str(REPO_ROOT), help="git repository that contains the catalog commit")
    locations_parser = commands.add_parser("locations", help="print the line ranges each catalog item resolves to")
    locations_parser.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    locations_parser.add_argument("--source", default=str(REPO_ROOT))
    args = parser.parse_args()
    {"run": run, "report": report, "locations": locations}[args.command](args)


if __name__ == "__main__":
    main()
