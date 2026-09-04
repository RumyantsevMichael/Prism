#!/usr/bin/env python3
"""Run a direct A/B evaluation of a configured Prism skill."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from implement_scenarios import SCENARIOS as IMPLEMENT_SCENARIOS
from scenarios import Assertion, SCENARIOS as WRITE_ADR_SCENARIOS, Scenario


REPO_ROOT = Path(__file__).resolve().parents[2]
TOKEN_KEYS = ("input_tokens", "cached_input_tokens", "output_tokens")
ARM_NAMES = ("original", "candidate")
CRITICAL_KINDS = {
    "changed_paths_exact",
    "file_appended",
    "file_not_contains",
    "file_unchanged",
    "path_absent",
}
CLAUDE_PLUGIN_MANIFEST = ".claude-plugin/plugin.json"
CODEX_PLUGIN_MANIFEST = ".codex-plugin/plugin.json"
CODEX_MARKETPLACE_MANIFEST = ".agents/plugins/marketplace.json"


@dataclass(frozen=True)
class SkillConfig:
    """Files and scenarios for one direct skill evaluation."""

    name: str
    original: Path
    candidate: Path
    scenarios: tuple[Scenario, ...]
    staged_files: tuple[str, ...]


SKILL_CONFIGS = {
    "write-adr": SkillConfig(
        name="write-adr",
        original=REPO_ROOT / "skills" / "write-adr" / "SKILL.md",
        candidate=REPO_ROOT / "docs" / "write-adr-sdm-experiment.md",
        scenarios=WRITE_ADR_SCENARIOS,
        staged_files=(
            "skills/write-adr/SKILL.md",
            "skills/workflow/SKILL.md",
        ),
    ),
    "implement": SkillConfig(
        name="implement",
        original=REPO_ROOT / "skills" / "implement" / "SKILL.md",
        candidate=REPO_ROOT / "docs" / "implement-sdm-experiment.md",
        scenarios=IMPLEMENT_SCENARIOS,
        staged_files=(
            "skills/implement/SKILL.md",
            "skills/workflow/SKILL.md",
            "skills/review/SKILL.md",
            "skills/review/references/review-format.md",
        ),
    ),
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def write_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def stage_plugin(destination: Path, config: SkillConfig, overlay: Path) -> None:
    """Stage only the manifests and files needed for one direct evaluation."""
    claude_manifest = json.loads((REPO_ROOT / CLAUDE_PLUGIN_MANIFEST).read_text())
    claude_manifest.pop("mcpServers", None)
    write_json(destination / CLAUDE_PLUGIN_MANIFEST, claude_manifest)

    codex_manifest = json.loads((REPO_ROOT / CODEX_PLUGIN_MANIFEST).read_text())
    codex_manifest.pop("mcpServers", None)
    codex_manifest["skills"] = "./skills/"
    write_json(destination / CODEX_PLUGIN_MANIFEST, codex_manifest)

    marketplace_manifest = json.loads(
        (REPO_ROOT / CODEX_MARKETPLACE_MANIFEST).read_text()
    )
    write_json(destination / CODEX_MARKETPLACE_MANIFEST, marketplace_manifest)

    tested_path = f"skills/{config.name}/SKILL.md"
    for relative in config.staged_files:
        source = overlay if relative == tested_path else REPO_ROOT / relative
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def make_plugin_arms(root: Path, config: SkillConfig) -> dict[str, Path]:
    arms: dict[str, Path] = {}
    for name, overlay in (("original", config.original), ("candidate", config.candidate)):
        arm = root / "plugins" / name
        stage_plugin(arm, config, overlay)
        arms[name] = arm
    return arms


def write_workspace(workspace: Path, scenario: Scenario) -> dict[str, bytes]:
    seeded: dict[str, bytes] = {}
    workspace.mkdir(parents=True, exist_ok=True)
    for relative, text in scenario.workspace_files.items():
        path = workspace / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        content = text.encode()
        path.write_bytes(content)
        seeded[relative] = content
    return seeded


def workspace_files(workspace: Path) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    for path in workspace.rglob("*"):
        if path.is_file() and ".git" not in path.parts:
            files[path.relative_to(workspace).as_posix()] = path.read_bytes()
    return files


def changed_paths(workspace: Path, seeded: dict[str, bytes]) -> list[str]:
    completed = workspace_files(workspace)
    return sorted(
        path
        for path in set(seeded) | set(completed)
        if seeded.get(path) != completed.get(path)
    )


def matches(workspace: Path, target: str) -> list[Path]:
    if not any(character in target for character in "*?["):
        path = workspace / target
        return [path] if path.exists() else []
    return sorted(path for path in workspace.glob(target) if path.is_file())


def score_assertion(
    assertion: Assertion, workspace: Path, output: str, seeded: dict[str, bytes]
) -> dict[str, object]:
    paths = matches(workspace, assertion.target)
    kind = assertion.kind
    detail = ""
    try:
        if kind == "changed_paths_exact":
            expected = sorted(str(path) for path in assertion.value)
            actual = changed_paths(workspace, seeded)
            passed = actual == expected
            detail = f"expected {expected}, found {actual}"
        elif kind == "file_appended":
            current = workspace / assertion.target
            original = seeded.get(assertion.target)
            completed = current.read_bytes() if current.is_file() else None
            passed = (
                original is not None
                and completed is not None
                and len(completed) > len(original)
                and completed.startswith(original)
            )
            detail = "seeded bytes are an unchanged prefix" if passed else "file was not appended to seeded bytes"
        elif kind == "file_contains":
            passed = any(re.search(str(assertion.value), path.read_text(errors="replace")) for path in paths)
            detail = f"matched {len(paths)} file(s)"
        elif kind == "file_not_contains":
            passed = bool(paths) and all(
                not re.search(str(assertion.value), path.read_text(errors="replace"))
                for path in paths
            )
            detail = f"matched {len(paths)} file(s)"
        elif kind == "file_unchanged":
            current = workspace / assertion.target
            passed = assertion.target in seeded and current.is_file() and current.read_bytes() == seeded[assertion.target]
            detail = "seeded bytes match" if passed else "seeded bytes differ or file is missing"
        elif kind == "glob_count":
            passed = len(paths) == int(assertion.value)
            detail = f"expected {assertion.value}, found {len(paths)}"
        elif kind == "output_contains":
            passed = re.search(str(assertion.value), output, flags=re.DOTALL) is not None
            detail = "output regular expression matched" if passed else "output regular expression did not match"
        elif kind == "path_absent":
            passed = not (workspace / assertion.target).exists()
            detail = "path is absent" if passed else "path exists"
        elif kind == "path_exists":
            passed = (workspace / assertion.target).exists()
            detail = "path exists" if passed else "path is absent"
        else:
            raise ValueError(f"unknown assertion kind: {kind}")
    except (OSError, re.error, TypeError, ValueError) as exc:
        passed = False
        detail = f"scoring error: {exc}"
    return {
        "kind": kind,
        "target": assertion.target,
        "value": assertion.value,
        "passed": passed,
        "critical": kind in CRITICAL_KINDS,
        "detail": detail,
    }


def score_scenario(
    scenario: Scenario,
    workspace: Path,
    output: str,
    seeded: dict[str, bytes],
    invocation_error: str | None = None,
) -> dict[str, object]:
    results = [score_assertion(item, workspace, output, seeded) for item in scenario.assertions]
    passed = sum(bool(item["passed"]) for item in results)
    critical_failures = sum(
        bool(item["critical"]) and not bool(item["passed"]) for item in results
    ) + int(invocation_error is not None)
    return {
        "passed": invocation_error is None and passed == len(results),
        "assertions_passed": passed,
        "assertions_total": len(results),
        "assertion_rate": passed / len(results) if results else 1.0,
        "critical_failures": critical_failures,
        "invocation_error": invocation_error,
        "assertions": results,
    }


def parse_claude_json(stdout: str) -> dict[str, object] | None:
    try:
        payload = json.loads(stdout)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    raw_usage = payload.get("usage") or {}
    cache_creation = raw_usage.get("cache_creation_input_tokens") or 0
    cache_read = raw_usage.get("cache_read_input_tokens") or 0
    has_claude_cache_fields = (
        "cache_creation_input_tokens" in raw_usage
        or "cache_read_input_tokens" in raw_usage
    )
    payload["usage"] = {
        "input_tokens": raw_usage.get("input_tokens") or 0,
        "cached_input_tokens": cache_creation + cache_read
        if has_claude_cache_fields
        else (raw_usage.get("cached_input_tokens") or 0),
        "output_tokens": raw_usage.get("output_tokens") or 0,
    }
    return payload


def parse_codex_jsonl(stdout: str) -> dict[str, object] | None:
    messages: list[str] = []
    usage = dict.fromkeys(TOKEN_KEYS, 0)
    turns = 0
    parsed = 0
    failed = False
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        parsed += 1
        if event.get("type") == "item.completed":
            item = event.get("item") or {}
            if item.get("type") == "agent_message" and item.get("text"):
                messages.append(item["text"])
        elif event.get("type") == "turn.completed":
            turns += 1
            turn_usage = event.get("usage") or {}
            cached_input = turn_usage.get("cached_input_tokens") or 0
            usage["input_tokens"] += max(
                0, (turn_usage.get("input_tokens") or 0) - cached_input
            )
            usage["cached_input_tokens"] += cached_input
            usage["output_tokens"] += turn_usage.get("output_tokens") or 0
        elif event.get("type") in {"error", "turn.failed"}:
            failed = True
    if not parsed:
        return None
    return {
        "result": messages[-1] if messages else "",
        "usage": usage,
        "num_turns": turns,
        "total_cost_usd": None,
        "is_error": failed,
    }


def run_command(command: list[str], cwd: Path, timeout: int, env: dict[str, str] | None = None) -> tuple[str, str, float, str | None]:
    started = time.monotonic()
    error = None
    try:
        result = subprocess.run(
            command, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout
        )
        stdout, stderr = result.stdout, result.stderr
        if result.returncode:
            error = f"command exited {result.returncode}"
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout if isinstance(exc.stdout, str) else (exc.stdout or b"").decode(errors="replace")
        stderr = exc.stderr if isinstance(exc.stderr, str) else (exc.stderr or b"").decode(errors="replace")
        error = "timeout"
    return stdout, stderr, round(time.monotonic() - started, 3), error


def setup_codex_arm(marketplace: Path, codex_home: Path, timeout: int) -> str | None:
    codex_home.mkdir(parents=True, exist_ok=True)
    source_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    source_auth = source_home / "auth.json"
    if source_auth.is_file():
        (codex_home / "auth.json").symlink_to(source_auth)
    env = dict(os.environ, CODEX_HOME=str(codex_home))
    commands = (
        ["codex", "plugin", "marketplace", "add", str(marketplace)],
        ["codex", "plugin", "add", "prism@prism"],
    )
    for command in commands:
        _, stderr, _, error = run_command(command, marketplace, timeout, env)
        if error:
            return f"Codex plugin setup failed: {error}: {stderr[-400:]}"
    return None


def invoke_agent(args: argparse.Namespace, plugin: Path, workspace: Path, codex_home: Path | None) -> dict[str, object]:
    if args.agent == "claude":
        prompt = f"/prism:{args.skill}\n\n{args.prompt}"
        command = [
            "claude", "-p", prompt, "--output-format", "json", "--model", args.model,
            "--plugin-dir", str(plugin), "--max-turns", str(args.max_turns),
            "--dangerously-skip-permissions",
        ]
        env = None
    else:
        prompt = f"Use the prism:{args.skill} skill\n\n{args.prompt}"
        command = [
            "codex", "exec", "--json", "--skip-git-repo-check", "--model", args.model,
            "-c", 'approval_policy="never"', "--sandbox", "workspace-write", "--cd", str(workspace),
            prompt,
        ]
        env = dict(os.environ, CODEX_HOME=str(codex_home))
    stdout, stderr, duration, error = run_command(command, workspace, args.timeout, env)
    payload = parse_claude_json(stdout) if args.agent == "claude" else parse_codex_jsonl(stdout)
    if payload is None and error is None:
        error = f"unparsable {args.agent} output"
    if payload and payload.get("is_error") and error is None:
        error = f"{args.agent} reported an error"
    if error and stderr.strip():
        error = f"{error}: {stderr.strip()[-400:]}"
    return {
        "output": (payload or {}).get("result") or "",
        "usage": (payload or {}).get("usage") or {},
        "cost_usd": (payload or {}).get("total_cost_usd"),
        "turns": (payload or {}).get("num_turns") or 0,
        "duration_s": duration,
        "error": error,
        "stdout": stdout,
        "stderr": stderr,
    }


def mock_agent(scenario: Scenario, agent: str) -> dict[str, object]:
    return {
        "output": f"Mock result for {scenario.id}.",
        "usage": dict.fromkeys(TOKEN_KEYS, 0),
        "cost_usd": None if agent == "codex" else 0.0,
        "turns": 0,
        "duration_s": 0.0,
        "error": None,
        "stdout": "",
        "stderr": "",
    }


def select_scenarios(
    catalog: tuple[Scenario, ...], selector: str | None
) -> list[Scenario]:
    if not selector or selector == "all":
        return list(catalog)
    requested = selector.split(",")
    by_id = {scenario.id: scenario for scenario in catalog}
    unknown = [item for item in requested if item not in by_id]
    if unknown:
        raise SystemExit(f"unknown scenarios: {', '.join(unknown)}")
    return [by_id[item] for item in requested]


def run_evaluation(args: argparse.Namespace) -> Path:
    config = SKILL_CONFIGS[args.skill]
    if args.candidate:
        candidate = Path(args.candidate).resolve()
        if not candidate.is_file():
            raise SystemExit(f"candidate skill does not exist: {candidate}")
        config = SkillConfig(
            name=config.name,
            original=config.original,
            candidate=candidate,
            scenarios=config.scenarios,
            staged_files=config.staged_files,
        )
    scenarios = select_scenarios(config.scenarios, args.scenarios)
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    results_path = out_dir / "results.jsonl"
    rng = random.Random(args.seed)
    with tempfile.TemporaryDirectory(prefix="prism-skill-eval-") as temporary:
        temp_root = Path(temporary)
        arms = make_plugin_arms(temp_root, config)
        codex_homes: dict[str, Path] = {}
        if args.agent == "codex" and not args.mock:
            for arm in ARM_NAMES:
                codex_home = temp_root / "codex-home" / arm
                setup_error = setup_codex_arm(arms[arm], codex_home, args.timeout)
                if setup_error:
                    raise SystemExit(setup_error)
                codex_homes[arm] = codex_home
        with results_path.open("w") as results:
            for rep in range(1, args.reps + 1):
                for scenario in scenarios:
                    order = list(ARM_NAMES)
                    rng.shuffle(order)
                    for order_index, arm in enumerate(order):
                        run_root = out_dir / "work" / f"rep-{rep}" / scenario.id / arm
                        if run_root.exists():
                            shutil.rmtree(run_root)
                        workspace = run_root / "workspace"
                        seeded = write_workspace(workspace, scenario)
                        invocation = argparse.Namespace(**vars(args), prompt=scenario.prompt)
                        agent_result = mock_agent(scenario, args.agent) if args.mock else invoke_agent(
                            invocation, arms[arm], workspace, codex_homes.get(arm)
                        )
                        score = score_scenario(
                            scenario,
                            workspace,
                            str(agent_result["output"]),
                            seeded,
                            str(agent_result["error"]) if agent_result["error"] else None,
                        )
                        record = {
                            "schema_version": 2,
                            "timestamp": utc_now(),
                            "skill": config.name,
                            "scenario": scenario.id,
                            "rep": rep,
                            "arm": arm,
                            "order": order_index + 1,
                            "seed": args.seed,
                            "agent": args.agent,
                            "model": args.model,
                            "mock": args.mock,
                            "plugin_skill_sha256": sha256_bytes(
                                (arms[arm] / f"skills/{config.name}/SKILL.md").read_bytes()
                            ),
                            "seed_snapshot": {path: sha256_bytes(content) for path, content in sorted(seeded.items())},
                            "changed_paths": changed_paths(workspace, seeded),
                            "output": agent_result["output"],
                            "usage": agent_result["usage"],
                            "cost_usd": agent_result["cost_usd"],
                            "turns": agent_result["turns"],
                            "duration_s": agent_result["duration_s"],
                            "error": agent_result["error"],
                            "score": score,
                        }
                        results.write(json.dumps(record, sort_keys=True) + "\n")
                        results.flush()
                        if args.keep:
                            logs = run_root / "logs"
                            logs.mkdir(parents=True, exist_ok=True)
                            (logs / "stdout.log").write_text(str(agent_result["stdout"]))
                            (logs / "stderr.log").write_text(str(agent_result["stderr"]))
                            seed_dir = run_root / "seed"
                            for relative, content in seeded.items():
                                seed_path = seed_dir / relative
                                seed_path.parent.mkdir(parents=True, exist_ok=True)
                                seed_path.write_bytes(content)
                        else:
                            shutil.rmtree(run_root, ignore_errors=True)
    return results_path


def selfcheck() -> None:
    with tempfile.TemporaryDirectory(prefix="prism-skill-score-check-") as temporary:
        workspace = Path(temporary)
        seeded = write_workspace(
            workspace,
            Scenario("check", "", {"same.txt": "same\n", "content.txt": "alpha\n"}, ()),
        )
        (workspace / "exists.txt").write_text("present\n")
        assertions = (
            Assertion("changed_paths_exact", "", ("content.txt", "exists.txt")),
            Assertion("file_appended", "content.txt"),
            Assertion("file_contains", "*.txt", r"alpha"),
            Assertion("file_not_contains", "*.txt", r"omega"),
            Assertion("file_unchanged", "same.txt"),
            Assertion("glob_count", "*.txt", 3),
            Assertion("output_contains", "", r"created.*Proposed"),
            Assertion("path_absent", "missing.txt"),
            Assertion("path_exists", "exists.txt"),
        )
        scenario = Scenario("check", "", {}, assertions)
        (workspace / "content.txt").write_text("alpha\nbeta\n")
        score = score_scenario(scenario, workspace, "created ADR\nStatus: Proposed", seeded)
        if not score["passed"]:
            raise SystemExit(json.dumps(score, indent=2))
        missing_match = score_assertion(
            Assertion("file_not_contains", "missing-*.txt", r"omega"),
            workspace,
            "",
            seeded,
        )
        if missing_match["passed"]:
            raise SystemExit("file_not_contains passed without a matched file")
        wrong_paths = score_assertion(
            Assertion("changed_paths_exact", "", ("content.txt",)),
            workspace,
            "",
            seeded,
        )
        if wrong_paths["passed"]:
            raise SystemExit("changed_paths_exact passed with an unexpected added path")
        rewritten = workspace / "content.txt"
        rewritten.write_text("replacement\n")
        invalid_append = score_assertion(
            Assertion("file_appended", "content.txt"), workspace, "", seeded
        )
        if invalid_append["passed"]:
            raise SystemExit("file_appended passed after seeded content was replaced")
        rewritten.write_text("alpha\nbeta\n")
        errored = score_scenario(scenario, workspace, "created ADR\nStatus: Proposed", seeded, "timeout")
        if errored["passed"] or errored["critical_failures"] != 1:
            raise SystemExit(f"invocation error did not force scenario failure: {errored}")
        claude = parse_claude_json(
            json.dumps(
                {
                    "usage": {
                        "input_tokens": 2,
                        "cache_creation_input_tokens": 3,
                        "cache_read_input_tokens": 5,
                        "output_tokens": 7,
                    }
                }
            )
        )
        expected_usage = {
            "input_tokens": 2,
            "cached_input_tokens": 8,
            "output_tokens": 7,
        }
        if claude is None or claude["usage"] != expected_usage:
            raise SystemExit(f"Claude usage normalization failed: {claude}")
        codex = parse_codex_jsonl(
            json.dumps(
                {
                    "type": "turn.completed",
                    "usage": {
                        "input_tokens": 10,
                        "cached_input_tokens": 6,
                        "output_tokens": 7,
                    },
                }
            )
        )
        expected_codex_usage = {
            "input_tokens": 4,
            "cached_input_tokens": 6,
            "output_tokens": 7,
        }
        if codex is None or codex["usage"] != expected_codex_usage:
            raise SystemExit(f"Codex usage normalization failed: {codex}")
        if codex["total_cost_usd"] is not None:
            raise SystemExit(f"Codex cost must be unavailable: {codex}")

    for config in SKILL_CONFIGS.values():
        with tempfile.TemporaryDirectory(
            prefix=f"prism-{config.name}-stage-check-"
        ) as temporary:
            root = Path(temporary)
            arms = make_plugin_arms(root, config)
            expected = {
                CLAUDE_PLUGIN_MANIFEST,
                CODEX_PLUGIN_MANIFEST,
                CODEX_MARKETPLACE_MANIFEST,
                *config.staged_files,
            }
            for arm in arms.values():
                staged_files = {
                    path.relative_to(arm).as_posix()
                    for path in arm.rglob("*")
                    if path.is_file()
                }
                if staged_files != expected:
                    unexpected = sorted(staged_files ^ expected)
                    raise SystemExit(
                        f"unexpected {config.name} staged plugin files: {unexpected}"
                    )
            original = workspace_files(arms["original"])
            candidate = workspace_files(arms["candidate"])
            differences = {
                path
                for path in set(original) | set(candidate)
                if original.get(path) != candidate.get(path)
            }
            tested_path = f"skills/{config.name}/SKILL.md"
            if differences != {tested_path}:
                raise SystemExit(
                    f"{config.name} plugin arms differ outside the tested skill: "
                    f"{sorted(differences)}"
                )
            hidden_catalogs = {"scenarios.py", "implement_scenarios.py"}
            if hidden_catalogs & set(original):
                raise SystemExit(f"{config.name} plugin contains a hidden catalog")
            scenario = config.scenarios[0]
            workspace = root / "workspace"
            write_workspace(workspace, scenario)
            if hidden_catalogs & set(workspace_files(workspace)):
                raise SystemExit(f"{config.name} workspace contains a hidden catalog")
    print("selfcheck passed: scoring and both isolated plugin configurations are valid")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run", help="run both direct-evaluation arms")
    run_parser.add_argument(
        "--skill", choices=tuple(SKILL_CONFIGS), default="write-adr"
    )
    run_parser.add_argument("--candidate", default=None, help="candidate skill path")
    run_parser.add_argument("--agent", choices=("claude", "codex"), default="claude")
    run_parser.add_argument("--model", default=None)
    run_parser.add_argument("--reps", type=int, default=1)
    run_parser.add_argument("--seed", type=int, default=0)
    run_parser.add_argument("--scenarios", default="all")
    run_parser.add_argument("--timeout", type=int, default=600)
    run_parser.add_argument("--max-turns", type=int, default=20)
    run_parser.add_argument("--out", default="bench/skill_eval/results/latest")
    run_parser.add_argument("--keep", action="store_true", help="retain workspaces and raw logs")
    run_parser.add_argument("--mock", action="store_true", help="score seeded workspaces without a model")
    subparsers.add_parser("selfcheck", help="test all mechanical assertion kinds")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "selfcheck":
        selfcheck()
        return
    if args.reps < 1:
        parser.error("--reps must be at least 1")
    if args.model is None:
        args.model = "gpt-5.6-terra" if args.agent == "codex" else "sonnet"
    results = run_evaluation(args)
    print(f"wrote {results}")


if __name__ == "__main__":
    main()
