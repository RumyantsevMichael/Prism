#!/usr/bin/env python3
"""Benchmark harness for the prism workflow plugin.

Subcommands:
  selfcheck  Verify that every task's oracle passes its hidden tests, per stage.
  run        Run benchmark arms over the task suite and score the results.
  score      Score one existing workspace directory against one task.
  report     Aggregate results.jsonl records into a Markdown report.

The methodology lives in bench/README.md.
The harness uses the Python standard library only.
Scoring runs pytest from a private venv under bench/.venv.

Tasks can be staged: a sequence of product requests implemented in fresh
sessions over one persistent workspace, scored cumulatively after each stage.
Agent sessions are interactive: a simulated product owner answers the agent's
questions using a hidden per-stage reference spec, and nothing else.
"""
import argparse
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree

SCHEMA_VERSION = 2
BENCH_DIR = Path(__file__).resolve().parents[1]
TASKS_DIR = BENCH_DIR / "tasks"
REPO_ROOT = BENCH_DIR.parent
PYTEST_SPEC = "pytest>=8,<9"
BOOTSTRAP_RESAMPLES = 10_000
PHASE_DONE_MARKER = "PHASE COMPLETE"
PO_TIMEOUT_S = 600
TOKEN_KEYS = ("input_tokens", "cached_input_tokens", "output_tokens")

INTERACTION_RULES = f"""
You are running inside a benchmark harness, driven over a text channel.
A product owner is available: when you need requirements, decisions, or acceptance, end your message with concise numbered questions, and the answers arrive as the next message.
The product owner knows the intended behavior in detail but only answers what is asked. Elicit what you need instead of inventing unstated requirements.
Never use the AskUserQuestion tool. Ask in plain text.
Do not commit and do not push. The harness snapshots files directly.
The deliverable interface named in BRIEF.md is a hard contract: do not rename or move it.
When this session's work is finished, end your message with the exact line:
{PHASE_DONE_MARKER}
""".strip()

DESIGN_PROMPT = """Read BRIEF.md at the repository root. It is the product request for {stage_intro}.
Run the prism design workflow for it now: {invocation}.
Produce the full spec: ADR, contracts, build plan, feature files, and the handoff under the plans directory.
The product owner is available throughout: interview them about requirements the request leaves open, and present the finished artifacts for acceptance.
Write no implementation code in this session.
{rules}"""

IMPLEMENT_PROMPT = """This repository contains a spec that an earlier design session produced under docs/plans/{slug}/.
Run the prism implementation workflow now: {invocation}.
Follow the skill fully: validate the spec, write tests first, implement to green, verify, and audit.
If validation finds spec gaps, report them as questions: the product owner will answer or delegate the decision to you.
Finish only when the deliverable in BRIEF.md is complete and your own tests pass.
{rules}"""

BASELINE_PROMPT = """Read BRIEF.md at the repository root. It is the product request for {stage_intro}.
Implement it in this repository until it is complete: write the code and the tests, and make the tests pass.
The product owner is available for questions about intended behavior.
{rules}"""

STAGE_ZERO_INTRO = "a new product"
STAGE_LATER_INTRO = "a change request on the product already built in this repository"

PO_PROMPT = """You simulate the product owner of a software project inside a benchmark.
The reference specification below is your only source of truth.
An engineer sends you a message: questions, a status report, or work presented for acceptance.

Rules:
- Answer only from the reference specification. Restate or quote its rules.
- If the reference does not settle an asked question, reply for that item exactly: "Not specified. Your decision."
- Do not volunteer requirements the engineer did not ask about.
- Do not write code and do not prescribe implementation choices.
- When asked to accept or approve work and nothing in the message contradicts the reference, approve briefly.
- If the message contains no question and no acceptance request, reply: "Acknowledged. Continue."
- Be concise. Answer each numbered question directly, in the same numbering.
{reactive_rule}{diff_rule}
=== REFERENCE SPECIFICATION ===
{spec}
{diff_section}
=== ENGINEER'S MESSAGE ===
{message}
"""

WORKFLOW_CONFIG_TEMPLATE = """# Workflow config
<!-- Read by the workflow skills. Created by the benchmark harness. -->

## Product
- Name: {name}
- One-line description: {summary}

## Paths
- ADRs: /docs/ADRs/
- Plans (scratch): /docs/plans/
- Feature files: /docs/Features/
- Roadmap: /docs/roadmap.md
- Glossary: /docs/Glossary.md
- User guide: /docs/user-guide/
- Product strategy: n/a

## Stack
- Languages: {language}
- Test command: {test_command}
- BDD harness: none, feature files are spec-only
- Typecheck: n/a
- Lint/format: n/a

## Verification
- {verification}

## Tracker
- System: n/a (benchmark run, no tracker)
- Labels: n/a

## Commits
- Scopes: free-form
- Notes: committing is disabled in benchmark runs.

## Interaction
- Interaction style: plain-text

## Constraints
- This is a benchmark session driven over a text channel.
- The user on the channel is the product owner. Deliver gates and questions as plain text and wait for the reply.
- Do not use the AskUserQuestion tool.
- Do not commit and do not push.
"""

CONFTEST = """import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
"""


HOME = str(Path.home())
REPO_ROOT_TEXT = str(REPO_ROOT.resolve())


def redact(text):
    """Remove local filesystem paths from text destined for saved records."""
    if not text:
        return text
    return text.replace(REPO_ROOT_TEXT, "<repo>").replace(HOME, "<home>")


def log(message):
    print(message, flush=True)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run_cmd(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


# ---------------------------------------------------------------- tasks


def all_task_ids():
    return sorted(p.parent.name for p in TASKS_DIR.glob("*/task.json"))


def load_task(task_id):
    task_dir = TASKS_DIR / task_id
    task = json.loads((task_dir / "task.json").read_text())
    task["dir"] = task_dir
    if "stages" not in task:
        # Legacy single-stage layout: brief.md + tests/ + top-level counts.
        task["stages"] = [
            {
                "name": "build",
                "brief": "brief.md",
                "spec": task.get("spec", "brief.md"),
                "tests": sorted(
                    p.relative_to(task_dir).as_posix()
                    for p in (task_dir / "tests").glob("*.py")
                ),
                "test_count": task["test_count"],
                "phases": task["phases"],
            }
        ]
    return task


def select_tasks(selector):
    if selector in (None, "all"):
        ids = all_task_ids()
    else:
        ids = [t.strip() for t in selector.split(",") if t.strip()]
        unknown = [t for t in ids if not (TASKS_DIR / t / "task.json").exists()]
        if unknown:
            sys.exit(f"unknown tasks: {', '.join(unknown)}")
    return [load_task(t) for t in ids]


def cumulative_tests(task, upto_stage):
    """Test files and expected count for stages 0..upto_stage."""
    files = []
    count = 0
    for stage in task["stages"][: upto_stage + 1]:
        files.extend(task["dir"] / rel for rel in stage["tests"])
        count += stage["test_count"]
    return files, count


def stage_spec_text(task, upto_stage):
    """The product owner's reference: specs of all stages so far."""
    parts = []
    for index, stage in enumerate(task["stages"][: upto_stage + 1]):
        text = (task["dir"] / stage["spec"]).read_text()
        parts.append(f"# Stage {index + 1}: {stage['name']}\n\n{text}")
    return "\n\n---\n\n".join(parts)


# ---------------------------------------------------------------- venv


def venv_python(venv_dir):
    for candidate in (venv_dir / "bin" / "python", venv_dir / "Scripts" / "python.exe"):
        if candidate.exists():
            return candidate
    return None


def ensure_venv():
    venv_dir = BENCH_DIR / ".venv"
    py = venv_python(venv_dir)
    if py is None:
        log(f"creating scoring venv at {venv_dir}")
        result = run_cmd([sys.executable, "-m", "venv", str(venv_dir)])
        if result.returncode != 0:
            sys.exit(f"venv creation failed: {result.stderr}")
        py = venv_python(venv_dir)
    check = run_cmd([str(py), "-c", "import pytest"])
    if check.returncode != 0:
        log(f"installing {PYTEST_SPEC} into the scoring venv")
        result = run_cmd([str(py), "-m", "pip", "install", "--quiet", PYTEST_SPEC])
        if result.returncode != 0:
            sys.exit(f"pytest install failed: {result.stderr}")
    return py


# ---------------------------------------------------------------- scoring


def parse_junit(xml_path):
    totals = {"tests": 0, "failures": 0, "errors": 0, "skipped": 0}
    root = ElementTree.parse(xml_path).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    for suite in suites:
        for key in totals:
            totals[key] += int(suite.get(key, 0))
    return totals


def score_workspace(workspace, task, upto_stage, venv_py, keep_dir=None):
    """Copy the workspace, overlay the hidden tests, run pytest, parse."""
    workspace = Path(workspace)
    test_files, expected = cumulative_tests(task, upto_stage)
    if keep_dir is not None:
        scoring = Path(keep_dir)
        if scoring.exists():
            shutil.rmtree(scoring)
    else:
        scoring = Path(tempfile.mkdtemp(prefix=f"prism-score-{task['id']}-"))
    shutil.copytree(
        workspace,
        scoring / "ws",
        ignore=shutil.ignore_patterns(".git", "_bench_tests", "__pycache__"),
    )
    ws = scoring / "ws"
    tests_dir = ws / "_bench_tests"
    tests_dir.mkdir()
    (tests_dir / "conftest.py").write_text(CONFTEST)
    for test_file in test_files:
        shutil.copy2(test_file, tests_dir / test_file.name)
    xml_path = scoring / "junit.xml"
    # A task may override the runner. Seeded brownfield tasks are not Python,
    # so they supply their own command; it must write JUnit XML to {junit} so
    # the parser below stays the single scoring path. {venv_py} is available
    # for tasks that still want the private venv.
    command = task.get("test_command")
    if command:
        command = [
            part.format(junit=str(xml_path), venv_py=str(venv_py), tests="_bench_tests")
            for part in command
        ]
    else:
        command = [
            str(venv_py),
            "-m",
            "pytest",
            "_bench_tests",
            "-q",
            "-p",
            "no:cacheprovider",
            f"--junitxml={xml_path}",
        ]
    result = run_cmd(command, cwd=ws, timeout=task.get("test_timeout_s", 600))
    score = {
        "tests_expected": expected,
        "tests_collected": 0,
        "tests_passed": 0,
        "pass_fraction": 0.0,
        "resolved": False,
        "error": None,
    }
    if xml_path.exists():
        totals = parse_junit(xml_path)
        collected = totals["tests"]
        passed = collected - totals["failures"] - totals["errors"] - totals["skipped"]
        score["tests_collected"] = collected
        if collected < expected:
            # A collection failure hides tests, so the missing ones count as failed.
            score["error"] = "collection incomplete (missing deliverable or import error)"
        score["tests_passed"] = max(0, min(passed, expected))
        score["pass_fraction"] = round(score["tests_passed"] / expected, 4)
        score["resolved"] = score["tests_passed"] == expected
        if result.returncode != 0 and score["error"] is None:
            output = (result.stdout + result.stderr).strip()
            score["error"] = f"test command exited {result.returncode}: {output[-400:]}"
    else:
        score["error"] = f"pytest produced no report: {result.stderr[-400:]}"
    if keep_dir is None:
        shutil.rmtree(scoring, ignore_errors=True)
    return score


def artifact_checks(workspace):
    """Mechanical checks on the durable artifacts the workflow promises."""
    ws = Path(workspace)
    adr_files = list((ws / "docs" / "ADRs").rglob("*.md")) if (ws / "docs" / "ADRs").exists() else []
    adr_files = [p for p in adr_files if p.name.lower() != "readme.md"]
    accepted = any("status: accepted" in p.read_text(errors="ignore").lower() for p in adr_files)
    features_dir = ws / "docs" / "Features"
    feature_files = list(features_dir.rglob("*.feature")) if features_dir.exists() else []
    guide_dir = ws / "docs" / "user-guide"
    guide_files = [p for p in guide_dir.rglob("*.md")] if guide_dir.exists() else []
    guide_files = [p for p in guide_files if p.name.lower() != "readme.md" or len(p.read_text(errors="ignore")) > 200]
    agent_tests = [
        p
        for pattern in ("test*.py", "*_test.go")
        for p in ws.rglob(pattern)
        if "_bench_tests" not in p.parts and ".git" not in p.parts
    ]
    return {
        "adr_count": len(adr_files),
        "adr_accepted": accepted,
        "feature_file_count": len(feature_files),
        "user_guide_present": len(guide_files) > 0,
        "agent_test_files": len(agent_tests),
    }


# ---------------------------------------------------------------- workspaces


def git(workspace, *args):
    return run_cmd(
        [
            "git",
            "-c",
            "user.name=prism-bench",
            "-c",
            "user.email=bench@localhost",
            *args,
        ],
        cwd=workspace,
    )


def make_workspace(dest, task, with_config):
    dest = Path(dest)
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    seed = task["dir"] / "seed"
    if seed.exists():
        shutil.copytree(seed, dest, dirs_exist_ok=True)
    seed_repo = task.get("seed_repo")
    if seed_repo:
        cache = BENCH_DIR / ".cache" / "seeds" / hashlib.sha256(
            seed_repo["url"].encode()
        ).hexdigest()[:16]
        if not cache.exists():
            cache.parent.mkdir(parents=True, exist_ok=True)
            result = run_cmd(
                ["git", "clone", "--mirror", "--quiet", seed_repo["url"], str(cache)]
            )
            if result.returncode != 0:
                shutil.rmtree(cache, ignore_errors=True)
                sys.exit(f"seed_repo clone failed for {task['id']}: {result.stderr.strip()}")
        seed_path = dest / seed_repo.get("path", "repo")
        result = run_cmd(["git", "clone", "--quiet", str(cache), str(seed_path)])
        if result.returncode != 0:
            sys.exit(f"seed_repo cache clone failed for {task['id']}: {result.stderr.strip()}")
        checkout = run_cmd(
            ["git", "checkout", "--quiet", seed_repo["commit"]],
            cwd=seed_path,
        )
        if checkout.returncode != 0:
            sys.exit(f"seed_repo checkout failed for {task['id']}: {checkout.stderr.strip()}")
        shutil.rmtree(seed_path / ".git", ignore_errors=True)
    if with_config:
        claude_dir = dest / ".claude"
        claude_dir.mkdir(exist_ok=True)
        (claude_dir / "workflow-config.md").write_text(
            WORKFLOW_CONFIG_TEMPLATE.format(
                name=task["name"],
                summary=task["summary"],
                language=task.get("workflow_language", "Python 3 (standard library only)"),
                test_command=task.get(
                    "workflow_test_command", "python3 -m unittest discover -s tests -v"
                ),
                verification=task.get(
                    "workflow_verification",
                    "Run the unittest suite. Exercise the deliverable exactly as BRIEF.md describes.",
                ),
            )
        )
    write_stage_brief(dest, task, 0)
    git(dest, "init", "--quiet")
    git(dest, "add", "-A")
    git(dest, "commit", "--quiet", "-m", "chore: seed benchmark workspace")
    return dest


def external_source_text(source):
    """Read one file from a pinned external repository without vendoring it."""
    commit = source["commit"]
    candidates = []
    env_name = source.get("local_env")
    if env_name and os.environ.get(env_name):
        candidates.append(Path(os.environ[env_name]).expanduser())
    if source.get("sibling"):
        candidates.append(REPO_ROOT.parent / source["sibling"])
    cache = BENCH_DIR / ".cache" / "sources" / hashlib.sha256(
        source["repo_url"].encode()
    ).hexdigest()[:16]
    candidates.append(cache)
    repo = next(
        (
            path
            for path in candidates
            if (path / ".git").exists()
            and run_cmd(["git", "-C", str(path), "cat-file", "-e", f"{commit}^{{commit}}"])
            .returncode
            == 0
        ),
        None,
    )
    if repo is None:
        cache.parent.mkdir(parents=True, exist_ok=True)
        result = run_cmd(
            ["git", "clone", "--quiet", "--filter=blob:none", source["repo_url"], str(cache)]
        )
        if result.returncode != 0:
            sys.exit(f"external source clone failed: {result.stderr.strip()}")
        repo = cache
    result = run_cmd(
        ["git", "-C", str(repo), "show", f"{commit}:{source['path']}"]
    )
    if result.returncode != 0:
        sys.exit(f"external source read failed: {result.stderr.strip()}")
    return result.stdout


def apply_oracle(workspace, task):
    """Apply a local oracle tree or an externally stored patch."""
    workspace = Path(workspace)
    oracle_dir = task["dir"] / "oracle"
    if oracle_dir.exists():
        for oracle_file in sorted(oracle_dir.iterdir()):
            target = workspace / oracle_file.name
            if oracle_file.is_dir():
                shutil.copytree(oracle_file, target, dirs_exist_ok=True)
            else:
                shutil.copy2(oracle_file, target)
        return
    config = task.get("oracle_patch")
    if not config:
        sys.exit(f"task {task['id']} has no oracle or oracle_patch")
    document = json.loads(external_source_text(config["source"]))
    patch = document[config.get("json_field", "patch")]
    directory = task.get("seed_repo", {}).get("path", ".")
    base = ["git", "apply", "--whitespace=nowarn"]
    if directory != ".":
        base += [f"--directory={directory}"]
    # mock_solve runs once per stage. A full external oracle is already present
    # after stage one, so a successful reverse check makes later calls no-ops.
    reverse = run_cmd(base + ["--reverse", "--check", "-"], cwd=workspace, input=patch)
    if reverse.returncode == 0:
        return
    result = run_cmd(base + ["-"], cwd=workspace, input=patch)
    if result.returncode != 0:
        sys.exit(f"oracle patch failed for {task['id']}: {result.stderr.strip()}")


def write_stage_brief(workspace, task, stage_index):
    """Install the stage's product request as BRIEF.md, archiving the old one."""
    workspace = Path(workspace)
    brief = workspace / "BRIEF.md"
    if stage_index > 0 and brief.exists():
        archive = workspace / "BRIEF-archive"
        archive.mkdir(exist_ok=True)
        previous = task["stages"][stage_index - 1]
        shutil.move(brief, archive / f"stage-{stage_index}-{previous['name']}.md")
    stage = task["stages"][stage_index]
    shutil.copy2(task["dir"] / stage["brief"], brief)


def stage_activity(workspace, phases):
    """Mechanical evidence that the agent actually did work this stage.

    A scored run that produced no edits is an infrastructure failure wearing a
    result's clothes: it reports a plausible low pass fraction with no error,
    and nothing in the record says the agent never ran. That is exactly how a
    malformed model name presented in an earlier SWE-Together trial, so the
    check is cheap insurance on every result.

    Stats come from git against the previous stage snapshot, so they measure
    this stage only. Staging happens here rather than in snapshot_stage so
    untracked files count as work.
    """
    git(workspace, "add", "-A")
    numstat = git(workspace, "diff", "--cached", "--numstat", "HEAD").stdout or ""
    files, insertions, deletions = 0, 0, 0
    for line in numstat.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        files += 1
        # "-" marks a binary file, which has no line counts.
        insertions += int(parts[0]) if parts[0].isdigit() else 0
        deletions += int(parts[1]) if parts[1].isdigit() else 0
    turns = sum(p.get("num_turns") or 0 for p in phases)
    return {
        "files_changed": files,
        "insertions": insertions,
        "deletions": deletions,
        "agent_turns": turns,
        # Flagged, never fatal: the record still scores (intent-to-treat), but
        # a reader can exclude these instead of averaging them in as zeros.
        "no_agent_progress": files == 0 or turns == 0,
    }


def snapshot_stage(workspace, stage_name):
    git(workspace, "add", "-A")
    git(workspace, "commit", "--quiet", "-m", f"chore: snapshot after stage {stage_name}")


# ---------------------------------------------------------------- agent runs


def parse_claude_json(stdout):
    try:
        return json.loads(stdout)
    except (json.JSONDecodeError, TypeError):
        return None


def parse_codex_jsonl(stdout):
    """Normalize Codex JSONL into the payload shape used by the harness."""
    thread_id = None
    messages = []
    usage = dict.fromkeys(TOKEN_KEYS, 0)
    turns = 0
    is_error = False
    parsed = 0
    for line in (stdout or "").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        parsed += 1
        event_type = event.get("type")
        if event_type == "thread.started":
            thread_id = event.get("thread_id") or thread_id
        elif event_type == "item.completed":
            item = event.get("item") or {}
            if item.get("type") == "agent_message" and item.get("text"):
                messages.append(item["text"])
        elif event_type == "turn.completed":
            turns += 1
            event_usage = event.get("usage") or {}
            for key in usage:
                usage[key] += event_usage.get(key) or 0
        elif event_type in ("error", "turn.failed"):
            is_error = True
    if not parsed:
        return None
    return {
        "result": messages[-1] if messages else "",
        "session_id": thread_id,
        "num_turns": turns,
        "total_cost_usd": 0.0,
        "usage": usage,
        "is_error": is_error,
    }


def claude_call(prompt, cwd, model, extra_args, timeout):
    cmd = [
        "claude",
        "-p",
        prompt,
        "--output-format",
        "json",
        "--model",
        model,
        *extra_args,
    ]
    started = time.monotonic()
    error = None
    try:
        result = run_cmd(cmd, cwd=cwd, timeout=timeout)
        stdout, stderr = result.stdout, result.stderr
        if result.returncode != 0:
            error = f"claude exited {result.returncode}"
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout if isinstance(exc.stdout, str) else (exc.stdout or b"").decode(errors="replace")
        stderr = exc.stderr if isinstance(exc.stderr, str) else (exc.stderr or b"").decode(errors="replace")
        error = "timeout"
    duration = round(time.monotonic() - started, 1)
    payload = parse_claude_json(stdout)
    if payload is None and error is None:
        error = "unparsable claude output"
    return payload, stdout, stderr, duration, error


def prepare_codex_marketplace(plugin_dir):
    """Build a Codex-compatible copy without changing the Claude plugin."""
    root = BENCH_DIR / ".cache" / "codex-marketplace"
    plugin = root / "plugin"
    if root.exists():
        shutil.rmtree(root)
    (root / ".agents" / "plugins").mkdir(parents=True)
    (plugin / ".codex-plugin").mkdir(parents=True)
    shutil.copytree(Path(plugin_dir) / "skills", plugin / "skills")
    for skill_file in (plugin / "skills").glob("*/SKILL.md"):
        text = skill_file.read_text()
        skill_file.write_text(
            text.replace(
                "disable-model-invocation: true", "disable-model-invocation: false"
            )
        )
    claude_manifest = json.loads(
        (Path(plugin_dir) / ".claude-plugin" / "plugin.json").read_text()
    )
    manifest = {
        "name": "prism",
        "version": claude_manifest["version"],
        "description": claude_manifest["description"],
        "skills": "./skills",
        "author": claude_manifest["author"],
        "interface": {
            "displayName": "Prism",
            "shortDescription": "Design and implement software from explicit specifications.",
            "longDescription": "Prism separates product design from implementation and stores the approved specification as project artifacts.",
            "developerName": claude_manifest["author"]["name"],
            "category": "Engineering",
            "capabilities": [
                "Product design",
                "Architecture decisions",
                "Implementation planning",
                "Test-driven implementation",
            ],
            "defaultPrompt": "Use Prism to design and implement this change.",
        },
    }
    (plugin / ".codex-plugin" / "plugin.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )
    marketplace = {
        "name": "prism",
        "interface": {"displayName": "Prism"},
        "plugins": [
            {
                "name": "prism",
                "source": {"source": "local", "path": "./plugin"},
                "policy": {
                    "installation": "AVAILABLE",
                    "authentication": "ON_INSTALL",
                },
                "category": "Engineering",
            }
        ],
    }
    (root / ".agents" / "plugins" / "marketplace.json").write_text(
        json.dumps(marketplace, indent=2) + "\n"
    )
    return root


def codex_call(prompt, cwd, model, plugin_dir, session_id, timeout, extra_args=None):
    common = [
        "--json",
        "--skip-git-repo-check",
        "--model",
        model,
        "-c",
        'approval_policy="never"',
        "-c",
        "sandbox_workspace_write.network_access=true",
        *(extra_args or []),
    ]
    if session_id:
        cmd = ["codex", "exec", "resume", *common, session_id, prompt]
    else:
        cmd = [
            "codex",
            "exec",
            *common,
            "--sandbox",
            "workspace-write",
            "--cd",
            str(cwd),
            prompt,
        ]
    started = time.monotonic()
    error = None
    try:
        result = run_cmd(cmd, cwd=cwd, timeout=timeout)
        stdout, stderr = result.stdout, result.stderr
        if result.returncode != 0:
            error = f"codex exited {result.returncode}"
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout if isinstance(exc.stdout, str) else (exc.stdout or b"").decode(errors="replace")
        stderr = exc.stderr if isinstance(exc.stderr, str) else (exc.stderr or b"").decode(errors="replace")
        error = "timeout"
    duration = round(time.monotonic() - started, 1)
    payload = parse_codex_jsonl(stdout)
    if payload is None and error is None:
        error = "unparsable codex output"
    elif payload and payload.get("is_error") and error is None:
        error = "codex turn failed"
    return payload, stdout, stderr, duration, error


def agent_call(agent, prompt, cwd, model, plugin_dir, session_id, timeout, extra_args=None):
    if agent == "codex":
        return codex_call(
            prompt, cwd, model, plugin_dir, session_id, timeout, extra_args=extra_args
        )
    args = list(extra_args or [])
    if session_id:
        args += ["--resume", session_id]
    return claude_call(prompt, cwd, model, args, timeout)


def skill_invocation(agent, skill, slug):
    """Return the agent-specific syntax for one prism skill call."""
    if agent == "claude":
        return f"invoke /prism:{skill} {slug} for a standalone feature"
    return f'use the `prism:{skill}` skill for the standalone feature "{slug}"'


UNSPECIFIED_REPLY = "Not specified. Your decision."
_ENUM_ITEM = re.compile(r"^\s*(?:\d+[.)]|[-*])\s+\S", re.M)


def count_items(text):
    """Number of enumerated items in a message, at least 1 for non-empty text.

    Both the agent's questions and the product owner's reply are asked for as
    numbered lists, so this counts either. Falls back to 1 rather than 0 so a
    single unnumbered question still registers.
    """
    if not text or not text.strip():
        return 0
    return len(_ENUM_ITEM.findall(text)) or 1


CORRECTION_TAG = "CORRECTION:"
REACTIVE_RULE = (
    "- If the engineer's work or stated plan CONTRADICTS the reference "
    f"specification, correct it. Start that part of your reply with {CORRECTION_TAG} "
    "and quote the rule being broken.\n"
    "- Correct only genuine contradictions with the reference. Never volunteer a "
    "requirement the engineer did not ask about and has not broken: an engineer "
    "who fails to elicit a requirement must still lose that ground."
)
DIFF_RULE = (
    "- The engineer's changes so far are shown below. Judge what the code does, "
    "not only what the message claims.\n"
    "- Still answer only from the reference specification. Do not review style "
    "and do not prescribe implementation."
)
DIFF_LIMIT_CHARS = 20_000


def workspace_diff(workspace, limit=DIFF_LIMIT_CHARS):
    """The agent's uncommitted changes this stage, as a truncated diff.

    `git add -N` registers untracked files so new files appear in the diff.
    It touches the index only, never HEAD, so the per-stage numstat in
    stage_activity still compares against the previous stage snapshot.

    Truncated from the front: the tail holds the most recent edits, which is
    what a reviewer looking at "what did you just do" wants.
    """
    workspace = Path(workspace)
    if not (workspace / ".git").exists():
        return ""
    git(workspace, "add", "-N", ".")
    text = git(workspace, "diff").stdout or ""
    if len(text) > limit:
        text = "...[earlier hunks elided]...\n" + text[-limit:]
    return text


def ask_product_owner(
    spec_text,
    message,
    po_agent,
    po_model,
    log_dir,
    tag,
    diff="",
    reactive=False,
):
    """One product-owner reply, generated strictly from the reference spec.

    Also returns elicitation stats for the exchange. `unspecified` counts the
    items the spec did not settle, which is how well the agent aimed its
    questions, not how many it asked.
    """
    prompt = PO_PROMPT.format(
        spec=spec_text,
        message=message,
        reactive_rule=f"{REACTIVE_RULE}\n" if reactive else "",
        diff_rule=f"{DIFF_RULE}\n" if diff else "",
        diff_section=f"\n=== ENGINEER'S CHANGES SO FAR (diff) ===\n{diff}\n" if diff else "",
    )
    payload, stdout, _, duration, error = agent_call(
        po_agent,
        prompt,
        log_dir,
        po_model,
        plugin_dir=None,
        session_id=None,
        timeout=PO_TIMEOUT_S,
        extra_args=(
            ["--ignore-user-config"]
            if po_agent == "codex"
            else ["--max-turns", "2"]
        ),
    )
    (Path(log_dir) / f"{tag}.po.json").write_text(redact(stdout) or "")
    answer = (payload or {}).get("result") or UNSPECIFIED_REPLY
    cost = (payload or {}).get("total_cost_usd") or 0.0
    if error:
        answer = UNSPECIFIED_REPLY
    # A harness error produces the same fallback text as a genuine "the spec
    # does not cover this". Flag it so a timed-out product owner is never
    # counted as the agent asking an off-spec question.
    stats = {
        "asked": count_items(message),
        "answer_items": count_items(answer),
        "unspecified": 0 if error else answer.count(UNSPECIFIED_REPLY),
        # The product owner's own count of times it had to correct work that
        # contradicted the spec. Lower is better, and unlike pass fraction it
        # is not pinned at a ceiling.
        "corrections": 0 if error else answer.count(CORRECTION_TAG),
        "po_error": bool(error),
        "usage": (payload or {}).get("usage") or {},
    }
    return answer, cost, duration, stats


def run_phase(
    phase,
    initial_prompt,
    workspace,
    agent,
    model,
    plugin_dir,
    max_turns,
    timeout,
    log_dir,
    spec_text,
    po_agent,
    po_model,
    max_exchanges,
    po_sees_diff=False,
    po_reactive=False,
):
    """One agent session with a product-owner question loop."""
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    base_args = []
    if agent == "claude":
        base_args = ["--dangerously-skip-permissions", "--max-turns", str(max_turns)]
        if plugin_dir is not None:
            base_args += ["--plugin-dir", str(plugin_dir)]
    record = {
        "name": phase,
        "agent": agent,
        "model": model,
        "max_turns": max_turns,
        "timeout_s": timeout,
        "started_at": utc_now(),
        "duration_s": 0.0,
        "num_turns": 0,
        "total_cost_usd": 0.0,
        "po_cost_usd": 0.0,
        "usage": dict.fromkeys(TOKEN_KEYS, 0),
        "po_usage": dict.fromkeys(TOKEN_KEYS, 0),
        "exchanges": 0,
        # Elicitation. `asked` and `answered` measure whether the agent aimed
        # its questions at what the spec actually settles. Raw exchange count
        # cannot: an agent that asks nothing spends zero exchanges and looks
        # maximally efficient while inventing every unstated requirement.
        "po_asked": 0,
        "po_answered": 0,
        "po_unspecified": 0,
        "po_errors": 0,
        "po_corrections": 0,
        "completed_marker": False,
        "is_error": None,
        "error": None,
    }
    prompt = initial_prompt
    session_id = None
    for exchange in range(max_exchanges + 1):
        payload, stdout, stderr, duration, error = agent_call(
            agent,
            prompt,
            workspace,
            model,
            plugin_dir,
            session_id,
            timeout,
            extra_args=base_args,
        )
        (log_dir / f"{phase}.{exchange}.stdout.json").write_text(redact(stdout) or "")
        if stderr:
            (log_dir / f"{phase}.{exchange}.stderr.txt").write_text(redact(stderr))
        record["duration_s"] = round(record["duration_s"] + duration, 1)
        record["exchanges"] = exchange + 1
        if payload:
            record["num_turns"] += payload.get("num_turns") or 0
            record["total_cost_usd"] += payload.get("total_cost_usd") or 0.0
            record["is_error"] = payload.get("is_error")
            session_id = payload.get("session_id") or session_id
            for key in TOKEN_KEYS:
                record["usage"][key] += ((payload.get("usage") or {}).get(key) or 0)
        if error:
            record["error"] = error
            break
        text = (payload or {}).get("result") or ""
        if PHASE_DONE_MARKER in text:
            record["completed_marker"] = True
            break
        if exchange == max_exchanges:
            break
        answer, po_cost, po_duration, po_stats = ask_product_owner(
            spec_text,
            text,
            po_agent,
            po_model,
            log_dir,
            f"{phase}.{exchange}",
            diff=workspace_diff(workspace) if po_sees_diff else "",
            reactive=po_reactive,
        )
        record["po_asked"] += po_stats["asked"]
        record["po_unspecified"] += po_stats["unspecified"]
        record["po_errors"] += 1 if po_stats["po_error"] else 0
        record["po_corrections"] += po_stats["corrections"]
        for key in TOKEN_KEYS:
            record["po_usage"][key] += po_stats["usage"].get(key) or 0
        record["po_answered"] += max(
            0, po_stats["answer_items"] - po_stats["unspecified"]
        )
        record["po_cost_usd"] += po_cost
        record["duration_s"] = round(record["duration_s"] + po_duration, 1)
        prompt = (
            f"Product owner reply:\n{answer}\n\n"
            f"Continue this session's work. End with the line {PHASE_DONE_MARKER} when it is finished."
        )
    record["total_cost_usd"] = round(record["total_cost_usd"], 4)
    record["po_cost_usd"] = round(record["po_cost_usd"], 4)
    return record


def mock_solve(workspace, task, prism_arm):
    """Copy the oracle into the workspace instead of invoking an agent.

    This exists to test the pipeline without model cost. It never
    stands in for a real measurement.
    """
    apply_oracle(workspace, task)
    if prism_arm:
        docs = Path(workspace) / "docs"
        adr_dir = docs / "ADRs" / "0001-mock-decision"
        adr_dir.mkdir(parents=True, exist_ok=True)
        (adr_dir / "ADR.md").write_text("# ADR 0001: mock decision\n\nStatus: Accepted\n")
        features = docs / "Features"
        features.mkdir(parents=True, exist_ok=True)
        (features / "mock.feature").write_text(
            "Feature: mock\n  Scenario: mock\n    Given a mock run\n"
        )
        guide = docs / "user-guide"
        guide.mkdir(parents=True, exist_ok=True)
        (guide / "usage.md").write_text("# Usage\n\nMock user guide for pipeline tests.\n")
    return [
        {
            "name": "mock",
            "error": None,
            "duration_s": 0.0,
            "total_cost_usd": 0.0,
            "po_cost_usd": 0.0,
            "num_turns": 0,
            "exchanges": 0,
            "completed_marker": True,
        }
    ]


# ---------------------------------------------------------------- arms


def resolve_arm(name, ref, out_dir):
    """Resolve an arm ref into (plugin_dir, sha, worktree_created)."""
    if ref == "none":
        return None, None, None
    candidate = Path(ref).expanduser()
    if candidate.is_dir():
        plugin_dir = candidate.resolve()
        sha_result = run_cmd(["git", "-C", str(plugin_dir), "rev-parse", "HEAD"])
        sha = sha_result.stdout.strip() if sha_result.returncode == 0 else None
        dirty = run_cmd(["git", "-C", str(plugin_dir), "status", "--porcelain"])
        if sha and dirty.stdout.strip():
            sha += "-dirty"
        return plugin_dir, sha, None
    worktree = Path(out_dir) / "plugins" / name
    result = run_cmd(
        ["git", "-C", str(REPO_ROOT), "worktree", "add", "--detach", str(worktree), ref]
    )
    if result.returncode != 0:
        sys.exit(f"arm {name}: cannot resolve {ref!r} as a directory or git ref:\n{result.stderr}")
    sha = run_cmd(["git", "-C", str(worktree), "rev-parse", "HEAD"]).stdout.strip()
    return worktree, sha, worktree


def env_fingerprint():
    """Record machine context that leaks into every agent session."""
    global_claude_md = Path.home() / ".claude" / "CLAUDE.md"
    version = run_cmd(["claude", "--version"])
    codex_version = run_cmd(["codex", "--version"])
    return {
        "global_claude_md": sha256_file(global_claude_md)[:16] if global_claude_md.exists() else None,
        "claude_version": version.stdout.strip() if version.returncode == 0 else None,
        "codex_version": codex_version.stdout.strip() if codex_version.returncode == 0 else None,
        "platform": sys.platform,
        "python": sys.version.split()[0],
    }


# ---------------------------------------------------------------- commands


def configure_codex_prism(plugin_dir):
    plugins = run_cmd(["codex", "plugin", "list"])
    if re.search(r"^prism@prism\s+installed", plugins.stdout, re.M):
        result = run_cmd(["codex", "plugin", "remove", "prism@prism"])
        if result.returncode != 0:
            sys.exit(f"cannot remove the prism plugin: {result.stderr.strip()}")
    if plugin_dir is None:
        return
    marketplace = prepare_codex_marketplace(plugin_dir)
    marketplaces = run_cmd(["codex", "plugin", "marketplace", "list"])
    if re.search(r"^prism\s", marketplaces.stdout, re.M):
        result = run_cmd(["codex", "plugin", "marketplace", "remove", "prism"])
        if result.returncode != 0:
            sys.exit(f"cannot remove the old prism marketplace: {result.stderr.strip()}")
    result = run_cmd(["codex", "plugin", "marketplace", "add", str(marketplace)])
    if result.returncode != 0:
        sys.exit(f"cannot add the prism marketplace: {result.stderr.strip()}")
    result = run_cmd(["codex", "plugin", "add", "prism@prism"])
    if result.returncode != 0:
        sys.exit(f"cannot install the prism plugin: {result.stderr.strip()}")
    return marketplace


def cmd_setup_codex(args):
    marketplace = configure_codex_prism(args.plugin)
    log(f"Codex benchmark plugin installed from {marketplace}")


def cmd_selfcheck(args):
    venv_py = ensure_venv()
    failures = []
    for task in select_tasks(args.tasks):
        for stage_index in range(len(task["stages"])):
            stage = task["stages"][stage_index]
            with tempfile.TemporaryDirectory(prefix=f"prism-oracle-{task['id']}-") as tmp:
                ws = Path(tmp) / "ws"
                make_workspace(ws, task, with_config=False)
                apply_oracle(ws, task)
                score = score_workspace(ws, task, stage_index, venv_py)
            _, expected = cumulative_tests(task, stage_index)
            ok = score["resolved"] and score["tests_collected"] == expected
            status = "ok" if ok else "FAIL"
            label = f"{task['id']}" + (
                f"[stage {stage_index + 1}: {stage['name']}]" if len(task["stages"]) > 1 else ""
            )
            log(
                f"[{status}] {label}: {score['tests_passed']}/{expected} passed, "
                f"{score['tests_collected']} collected"
            )
            if not ok:
                failures.append((label, score))
    if failures:
        for label, score in failures:
            log(f"  {label}: {json.dumps(score)}")
        sys.exit(1)
    log("selfcheck passed: every oracle passes its hidden tests at every stage")


def parse_arms(arm_args):
    arms = []
    for arm in arm_args:
        if "=" not in arm:
            sys.exit(f"bad --arm {arm!r}: expected name=ref (ref: path, git ref, or 'none')")
        name, ref = arm.split("=", 1)
        arms.append((name, ref))
    return arms


def run_stage_phases(args, plugin_dir, task, stage_index, wdir, log_dir):
    """All agent sessions for one stage of one rep. Returns phase records."""
    stage = task["stages"][stage_index]
    prism_arm = plugin_dir is not None
    slug = stage["name"]
    stage_intro = STAGE_ZERO_INTRO if stage_index == 0 else STAGE_LATER_INTRO
    spec_text = stage_spec_text(task, stage_index)
    common = dict(
        workspace=wdir,
        agent=args.agent,
        model=args.model,
        log_dir=log_dir,
        spec_text=spec_text,
        po_agent=args.po_agent,
        po_model=args.po_model,
        max_exchanges=args.max_exchanges,
        po_sees_diff=args.po_sees_diff,
        po_reactive=args.po_reactive,
    )
    if not prism_arm:
        return [
            run_phase(
                "solve",
                BASELINE_PROMPT.format(stage_intro=stage_intro, rules=INTERACTION_RULES),
                plugin_dir=None,
                max_turns=stage["phases"]["implement"]["max_turns"],
                timeout=stage["phases"]["implement"]["timeout_s"],
                **common,
            )
        ]
    design_invocation = skill_invocation(args.agent, "design", slug)
    implement_invocation = skill_invocation(args.agent, "implement", slug)
    phases = [
        run_phase(
            "design",
            DESIGN_PROMPT.format(
                stage_intro=stage_intro,
                invocation=design_invocation,
                rules=INTERACTION_RULES,
            ),
            plugin_dir=plugin_dir,
            max_turns=stage["phases"]["design"]["max_turns"],
            timeout=stage["phases"]["design"]["timeout_s"],
            **common,
        )
    ]
    phases.append(
        run_phase(
            "implement",
            IMPLEMENT_PROMPT.format(
                slug=slug,
                invocation=implement_invocation,
                rules=INTERACTION_RULES,
            ),
            plugin_dir=plugin_dir,
            max_turns=stage["phases"]["implement"]["max_turns"],
            timeout=stage["phases"]["implement"]["timeout_s"],
            **common,
        )
    )
    return phases


def cmd_run(args):
    arms = parse_arms(args.arm)
    tasks = select_tasks(args.tasks)
    out_dir = Path(args.out) if args.out else BENCH_DIR / "results" / datetime.now(timezone.utc).strftime("run-%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    venv_py = ensure_venv()
    codex_was_installed = False
    if args.agent == "codex" and not args.mock:
        plugins = run_cmd(["codex", "plugin", "list"])
        codex_was_installed = bool(
            re.search(r"^prism@prism\s+installed", plugins.stdout, re.M)
        )
    worktrees = []
    resolved = {}
    plugin_dirs = {}
    for name, ref in arms:
        plugin_dir, sha, worktree = resolve_arm(name, ref, out_dir)
        plugin_dirs[name] = plugin_dir
        resolved[name] = {"ref": ref, "sha": sha}
        if worktree:
            worktrees.append(worktree)
    meta = {
        "schema_version": SCHEMA_VERSION,
        "started_at": utc_now(),
        "model": args.model,
        "agent": args.agent,
        "po_model": args.po_model,
        "po_agent": args.po_agent,
        "max_exchanges": args.max_exchanges,
        "po_sees_diff": args.po_sees_diff,
        "po_reactive": args.po_reactive,
        "reps": args.reps,
        "mock": args.mock,
        "arms": resolved,
        "tasks": [t["id"] for t in tasks],
        "env": env_fingerprint(),
    }
    (out_dir / "run.json").write_text(json.dumps(meta, indent=2) + "\n")
    results_path = out_dir / "results.jsonl"
    log(f"run output: {out_dir}")
    try:
        with results_path.open("a") as results_file:
            for name, ref in arms:
                arm_info = resolved[name]
                prism_arm = plugin_dirs[name] is not None
                if args.agent == "codex" and not args.mock:
                    configure_codex_prism(plugin_dirs[name])
                for task in tasks:
                    stages_to_run = task["stages"][: args.stages] if args.stages else task["stages"]
                    for rep in range(1, args.reps + 1):
                        wdir = out_dir / "work" / name / task["id"] / f"rep{rep}"
                        make_workspace(wdir, task, with_config=prism_arm)
                        for stage_index, stage in enumerate(stages_to_run):
                            label = f"{name}/{task['id']}/rep{rep}/stage{stage_index + 1}:{stage['name']}"
                            log(f"--- {label}")
                            if stage_index > 0:
                                write_stage_brief(wdir, task, stage_index)
                            log_dir = out_dir / "logs" / name / task["id"] / f"rep{rep}" / f"stage{stage_index + 1}"
                            if args.mock:
                                phases = mock_solve(wdir, task, prism_arm)
                            else:
                                phases = run_stage_phases(args, plugin_dirs[name], task, stage_index, wdir, log_dir)
                            score = score_workspace(wdir, task, stage_index, venv_py)
                            record = {
                                "schema_version": SCHEMA_VERSION,
                                "timestamp": utc_now(),
                                "arm": name,
                                "arm_sha": arm_info["sha"],
                                "task": task["id"],
                                "stage_index": stage_index,
                                "stage_name": stage["name"],
                                "final_stage": stage_index == len(stages_to_run) - 1,
                                "rep": rep,
                                "model": args.model,
                                "po_model": args.po_model,
                                "mock": args.mock,
                                "phases": phases,
                                "phase_error": any(p.get("error") for p in phases),
                                "score": score,
                                "activity": stage_activity(wdir, phases),
                                "artifacts": artifact_checks(wdir) if prism_arm else None,
                            }
                            results_file.write(json.dumps(record) + "\n")
                            results_file.flush()
                            log(
                                f"    passed {score['tests_passed']}/{score['tests_expected']}"
                                + (" (resolved)" if score["resolved"] else "")
                                + (
                                    f" [phase error: {[p.get('error') for p in phases if p.get('error')]}]"
                                    if record["phase_error"]
                                    else ""
                                )
                            )
                            snapshot_stage(wdir, stage["name"])
                        if not args.keep_work:
                            shutil.rmtree(wdir, ignore_errors=True)
    finally:
        if args.agent == "codex" and not args.mock:
            configure_codex_prism(REPO_ROOT if codex_was_installed else None)
        for worktree in worktrees:
            run_cmd(["git", "-C", str(REPO_ROOT), "worktree", "remove", "--force", str(worktree)])
    log(f"done. report with:\n  python3 bench/harness/bench.py report {results_path}")


def cmd_score(args):
    venv_py = ensure_venv()
    task = load_task(args.task)
    upto = args.stage - 1 if args.stage else len(task["stages"]) - 1
    score = score_workspace(args.workspace, task, upto, venv_py, keep_dir=args.keep_dir)
    print(json.dumps(score, indent=2))
    if not score["resolved"]:
        sys.exit(1)


# ---------------------------------------------------------------- report


def load_results(paths):
    records = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            path = path / "results.jsonl"
        if not path.exists():
            sys.exit(f"no results file at {path}")
        for line in path.read_text().splitlines():
            if line.strip():
                record = json.loads(line)
                record.setdefault("stage_index", 0)
                record.setdefault("stage_name", "build")
                record.setdefault("final_stage", True)
                records.append(record)
    return records


def mean(values):
    values = list(values)
    return sum(values) / len(values) if values else 0.0


def paired_bootstrap(deltas, resamples=BOOTSTRAP_RESAMPLES, seed=0):
    """Percentile CI for the mean of per-task deltas, resampling tasks."""
    rng = random.Random(seed)
    tasks = list(deltas)
    means = []
    for _ in range(resamples):
        sample = [deltas[rng.choice(tasks)] for _ in tasks]
        means.append(mean(sample))
    means.sort()
    low = means[int(0.025 * resamples)]
    high = means[int(0.975 * resamples) - 1]
    return mean(deltas.values()), low, high


def cmd_report(args):
    records = load_results(args.results)
    if not records:
        sys.exit("no records found")
    arms = sorted({r["arm"] for r in records})
    cells = sorted({(r["task"], r["stage_index"], r["stage_name"]) for r in records})
    lines = []
    out = lines.append
    out("# prism benchmark report")
    out("")
    models = sorted({r.get("model") for r in records if r.get("model")})
    out(f"- generated: {utc_now()}")
    out(f"- records: {len(records)}, arms: {', '.join(arms)}")
    out(f"- model(s): {', '.join(models) if models else 'unknown'}")
    if any(r.get("mock") for r in records):
        out("- **WARNING: this report contains mock records. Mock runs test the pipeline, not the workflow.**")
    shas = {r["arm"]: r.get("arm_sha") for r in records}
    for arm in arms:
        out(f"- arm `{arm}` sha: `{shas.get(arm)}`")
    out("")
    out("## Hidden-test pass fraction per task stage (mean over reps)")
    out("")
    out("| task / stage | " + " | ".join(arms) + " |")
    out("|------|" + "|".join(["------"] * len(arms)) + "|")
    cell_means = {}
    for task, stage_index, stage_name in cells:
        row_label = task if stage_name == "build" else f"{task} / s{stage_index + 1} {stage_name}"
        row = [row_label]
        for arm in arms:
            cell_records = [
                r
                for r in records
                if r["arm"] == arm and r["task"] == task and r["stage_index"] == stage_index
            ]
            value = mean(r["score"]["pass_fraction"] for r in cell_records)
            cell_means[(arm, task, stage_index)] = value
            row.append(f"{value:.3f} (n={len(cell_records)})" if cell_records else "-")
        out("| " + " | ".join(row) + " |")
    out("")
    final_cells = sorted({(r["task"], r["stage_index"]) for r in records if r["final_stage"]})
    out("## Aggregates per arm (final stages only)")
    out("")
    out("| arm | macro pass fraction | resolved rate | phase-error rate | mean agent cost usd | mean po cost usd | mean turns | mean duration s |")
    out("|-----|---------------------|---------------|------------------|---------------------|------------------|------------|-----------------|")
    for arm in arms:
        final_records = [r for r in records if r["arm"] == arm and r["final_stage"]]
        arm_records = [r for r in records if r["arm"] == arm]
        macro = mean(cell_means.get((arm, task, stage), 0.0) for task, stage in final_cells)
        resolved = mean(1.0 if r["score"]["resolved"] else 0.0 for r in final_records)
        errored = mean(1.0 if r.get("phase_error") else 0.0 for r in arm_records)
        costs = [sum(p.get("total_cost_usd") or 0.0 for p in r["phases"]) for r in arm_records]
        po_costs = [sum(p.get("po_cost_usd") or 0.0 for p in r["phases"]) for r in arm_records]
        turns = [sum(p.get("num_turns") or 0 for p in r["phases"]) for r in arm_records]
        durations = [sum(p.get("duration_s") or 0.0 for p in r["phases"]) for r in arm_records]
        out(
            f"| {arm} | {macro:.3f} | {resolved:.2f} | {errored:.2f} "
            f"| {mean(costs):.2f} | {mean(po_costs):.2f} | {mean(turns):.0f} | {mean(durations):.0f} |"
        )
    out("")
    flagged = [r for r in records if (r.get("activity") or {}).get("no_agent_progress")]
    if flagged:
        out("## Infrastructure warnings")
        out("")
        out(
            f"**{len(flagged)} of {len(records)} records show no agent progress** "
            "(no files changed, or no agent turns)."
        )
        out("")
        out("| arm | task | stage | rep | files changed | agent turns | pass fraction |")
        out("|-----|------|-------|-----|---------------|-------------|---------------|")
        for r in flagged:
            a = r["activity"]
            out(
                f"| {r['arm']} | {r['task']} | {r['stage_index'] + 1} | {r['rep']} "
                f"| {a['files_changed']} | {a['agent_turns']} | {r['score']['pass_fraction']:.3f} |"
            )
        out("")
        out(
            "These scored without the agent editing anything, so they measure the "
            "harness, not the arm. Fix the cause and re-run before quoting any "
            "number above, because a broken session averages in as a low score "
            "rather than as an error."
        )
        out("")
    if any(p.get("po_asked") for r in records for p in r["phases"]):
        out("## Elicitation (all stages, mean per repetition)")
        out("")
        out("| arm | items asked | answered from spec | not specified | yield | corrections | po errors |")
        out("|-----|-------------|--------------------|---------------|-------|-------------|-----------|")
        for arm in arms:
            arm_records = [r for r in records if r["arm"] == arm]
            def per_rep(field):
                return [sum(p.get(field) or 0 for p in r["phases"]) for r in arm_records]
            asked = per_rep("po_asked")
            answered = per_rep("po_answered")
            unspec = per_rep("po_unspecified")
            errors = per_rep("po_errors")
            corrections = per_rep("po_corrections")
            total_items = sum(answered) + sum(unspec)
            yield_ = (sum(answered) / total_items) if total_items else 0.0
            out(
                f"| {arm} | {mean(asked):.1f} | {mean(answered):.1f} "
                f"| {mean(unspec):.1f} | {yield_:.2f} | {mean(corrections):.1f} "
                f"| {mean(errors):.1f} |"
            )
        out("")
        out(
            "Yield is answered / (answered + not specified): how well the arm aimed its "
            "questions at what the spec settles."
        )
        out(
            "Read it with items asked, never alone. An arm that asks nothing scores no "
            "yield at all, and an arm that asks a lot off-spec scores low yield."
        )
        out(
            "Corrections counts the times the product owner had to correct work that "
            "contradicted the spec (--po-reactive only). Lower is better."
        )
        out("")
    staged_tasks = sorted({r["task"] for r in records if r["stage_index"] > 0})
    if staged_tasks:
        out("## Stage progression (mean pass fraction by stage index)")
        out("")
        stage_indexes = sorted({r["stage_index"] for r in records if r["task"] in staged_tasks})
        out("| arm | " + " | ".join(f"stage {i + 1}" for i in stage_indexes) + " |")
        out("|-----|" + "|".join(["------"] * len(stage_indexes)) + "|")
        for arm in arms:
            row = [arm]
            for stage_index in stage_indexes:
                values = [
                    cell_means[(arm, task, stage_index)]
                    for task in staged_tasks
                    if (arm, task, stage_index) in cell_means
                ]
                row.append(f"{mean(values):.3f}" if values else "-")
            out("| " + " | ".join(row) + " |")
        out("")
        out("A workflow that pays off should hold its pass fraction as stages accumulate, while the baseline decays.")
        out("")
    if len(arms) >= 2:
        out("## Pairwise comparison on final stages (paired bootstrap over tasks)")
        out("")
        out(f"Resamples: {BOOTSTRAP_RESAMPLES}, seed 0, 95% percentile interval.")
        out("A difference is supported only when the interval excludes zero.")
        out("")
        for i, arm_a in enumerate(arms):
            for arm_b in arms[i + 1 :]:
                deltas = {
                    task: cell_means.get((arm_b, task, stage), 0.0) - cell_means.get((arm_a, task, stage), 0.0)
                    for task, stage in final_cells
                }
                if not deltas:
                    continue
                delta, low, high = paired_bootstrap(deltas)
                verdict = "supported" if (low > 0 or high < 0) else "not supported by this sample"
                out(
                    f"- `{arm_b}` minus `{arm_a}`: mean delta {delta:+.3f}, "
                    f"95% CI [{low:+.3f}, {high:+.3f}] -> {verdict}"
                )
        out("")
        if len(final_cells) < 5:
            out(
                f"Caution: only {len(final_cells)} task(s). "
                "A task-level bootstrap needs more tasks before a small delta can reach significance."
            )
        out("")
    prism_records = [r for r in records if r.get("artifacts") and r["final_stage"]]
    if prism_records:
        out("## Artifact discipline (prism arms, final stages, mean over runs)")
        out("")
        out("| arm | ADRs present | ADR accepted | feature files | user guide | agent test files |")
        out("|-----|--------------|--------------|---------------|------------|------------------|")
        for arm in arms:
            arm_records = [r for r in prism_records if r["arm"] == arm]
            if not arm_records:
                continue
            adr = mean(1.0 if r["artifacts"]["adr_count"] else 0.0 for r in arm_records)
            accepted = mean(1.0 if r["artifacts"]["adr_accepted"] else 0.0 for r in arm_records)
            features = mean(r["artifacts"]["feature_file_count"] for r in arm_records)
            guide = mean(1.0 if r["artifacts"]["user_guide_present"] else 0.0 for r in arm_records)
            agent_tests = mean(r["artifacts"]["agent_test_files"] for r in arm_records)
            out(
                f"| {arm} | {adr:.2f} | {accepted:.2f} | {features:.1f} | {guide:.2f} | {agent_tests:.1f} |"
            )
        out("")
    report = "\n".join(lines)
    if args.out:
        Path(args.out).write_text(report + "\n")
        log(f"wrote {args.out}")
    else:
        print(report)


def arm_version(records):
    """Label an arm by its plugin commit: short sha, '*' when dirty, or 'baseline'."""
    sha = next((r.get("arm_sha") for r in records if r.get("arm_sha")), None)
    if sha is None:
        return "baseline"
    dirty = sha.endswith("-dirty")
    return sha.split("-")[0][:9] + ("*" if dirty else "")


def cmd_summary(args):
    results_root = BENCH_DIR / "results"
    run_dirs = sorted(
        d for d in results_root.iterdir() if d.is_dir() and (d / "results.jsonl").exists()
    )
    if not run_dirs:
        sys.exit("no runs under bench/results/")
    lines = []
    out = lines.append
    out("# prism benchmark results")
    out("")
    out("One row per arm per run, newest last.")
    out(f"Regenerate with: `python3 bench/harness/bench.py summary --out bench/results/RESULTS.md`")
    out("The version column is the plugin commit the arm ran (`*` marks a dirty tree), or `baseline` for no plugin.")
    out("Stage cells are mean hidden-test pass fractions, cumulative per stage.")
    out("")
    out("| run | date | model | task | version | stages | final | cost/rep | reps |")
    out("|-----|------|-------|------|---------|--------|-------|----------|------|")
    for run_dir in run_dirs:
        records = load_results([run_dir])
        if not records:
            continue
        meta = {}
        if (run_dir / "run.json").exists():
            meta = json.loads((run_dir / "run.json").read_text())
        date = (meta.get("started_at") or records[0]["timestamp"])[:10]
        for arm in sorted({r["arm"] for r in records}):
            arm_records = [r for r in records if r["arm"] == arm]
            version = arm_version(arm_records)
            models = sorted({r.get("model", "?") for r in arm_records})
            tasks = sorted({r["task"] for r in arm_records})
            reps = len({r["rep"] for r in arm_records})
            by_stage = {}
            for r in arm_records:
                by_stage.setdefault(r["stage_index"], []).append(r["score"]["pass_fraction"])
            stages = " / ".join(f"{mean(v):.3f}" for _, v in sorted(by_stage.items()))
            final = mean(
                r["score"]["pass_fraction"] for r in arm_records if r["final_stage"]
            )
            cost = sum(
                sum(p.get("total_cost_usd") or 0.0 for p in r["phases"]) for r in arm_records
            ) / max(reps, 1)
            mock = " (mock)" if any(r.get("mock") for r in arm_records) else ""
            out(
                f"| {run_dir.name}{mock} | {date} | {', '.join(models)} | {', '.join(tasks)} "
                f"| `{version}` | {stages} | {final:.3f} | ${cost:.2f} | {reps} |"
            )
    out("")
    out("Compare arms only within a run, or across runs that share the model, the task, and the product-owner setup.")
    report = "\n".join(lines)
    if args.out:
        Path(args.out).write_text(report + "\n")
        log(f"wrote {args.out}")
    else:
        print(report)


# ---------------------------------------------------------------- main


def cmd_backfill(args):
    """Recover elicitation counts from a finished run's saved logs.

    Runs made before the harness recorded po_asked/po_answered/po_unspecified
    still have the raw exchanges on disk: `<phase>.<n>.po.json` holds the
    product owner's reply and `<phase>.<n>.stdout.json` the agent message that
    prompted it. That is everything the counters need, so an old run can get
    the metric without being re-run.

    Corrections are NOT backfilled. They need --po-reactive, which did not
    exist for those runs, so the count would be a true zero rather than a
    missing value and would read as "never corrected".
    """
    run_dir = Path(args.run_dir)
    results_path = run_dir / "results.jsonl" if run_dir.is_dir() else run_dir
    if not results_path.exists():
        sys.exit(f"no results.jsonl at {results_path}")
    logs_root = results_path.parent / "logs"
    if not logs_root.exists():
        sys.exit(f"no logs directory at {logs_root}")

    records = [json.loads(line) for line in results_path.read_text().splitlines() if line.strip()]
    patched, skipped = 0, 0
    for record in records:
        log_dir = (
            logs_root
            / record["arm"]
            / record["task"]
            / f"rep{record['rep']}"
            / f"stage{record['stage_index'] + 1}"
        )
        if not log_dir.exists():
            skipped += 1
            continue
        for phase in record["phases"]:
            totals = {"po_asked": 0, "po_answered": 0, "po_unspecified": 0, "po_errors": 0}
            for po_file in sorted(log_dir.glob(f"{phase['name']}.*.po.json")):
                exchange = po_file.name.split(".")[-3]
                try:
                    answer = (json.loads(po_file.read_text() or "{}") or {}).get("result") or ""
                except json.JSONDecodeError:
                    continue
                message = ""
                agent_file = log_dir / f"{phase['name']}.{exchange}.stdout.json"
                if agent_file.exists():
                    try:
                        message = (json.loads(agent_file.read_text() or "{}") or {}).get("result") or ""
                    except json.JSONDecodeError:
                        message = ""
                unspecified = answer.count(UNSPECIFIED_REPLY)
                totals["po_asked"] += count_items(message)
                totals["po_unspecified"] += unspecified
                totals["po_answered"] += max(0, count_items(answer) - unspecified)
            phase.update(totals)
            phase.setdefault("po_corrections", None)
        patched += 1

    if not args.write:
        log(f"dry run: would patch {patched} records ({skipped} without logs)")
        log("re-run with --write to update results.jsonl in place")
        return
    backup = results_path.with_suffix(".jsonl.bak")
    shutil.copy2(results_path, backup)
    results_path.write_text("".join(json.dumps(r) + "\n" for r in records))
    log(f"patched {patched} records ({skipped} without logs); backup at {backup}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_selfcheck = sub.add_parser("selfcheck", help="verify oracles against hidden tests, per stage")
    p_selfcheck.add_argument("--tasks", default="all")
    p_selfcheck.set_defaults(func=cmd_selfcheck)

    p_setup_codex = sub.add_parser(
        "setup-codex", help="install the generated Codex adapter for benchmark runs"
    )
    p_setup_codex.add_argument("--plugin", default=str(REPO_ROOT))
    p_setup_codex.set_defaults(func=cmd_setup_codex)

    p_run = sub.add_parser("run", help="run benchmark arms")
    p_run.add_argument(
        "--arm",
        action="append",
        required=True,
        metavar="NAME=REF",
        help="arm to run; REF is a plugin directory, a git ref of this repo, or 'none' for the no-plugin baseline",
    )
    p_run.add_argument("--tasks", default="all")
    p_run.add_argument("--reps", type=int, default=3)
    p_run.add_argument("--agent", choices=["claude", "codex"], default="claude")
    p_run.add_argument("--model", default=None)
    p_run.add_argument("--po-agent", choices=["claude", "codex"], default=None)
    p_run.add_argument("--po-model", default=None, help="model that simulates the product owner")
    p_run.add_argument("--max-exchanges", type=int, default=4, help="max product-owner replies per agent session")
    p_run.add_argument(
        "--po-reactive",
        action="store_true",
        help="let the product owner correct work that contradicts the reference spec, "
             "tagged CORRECTION:, and count those corrections. It still never "
             "volunteers a requirement that was not asked about, so elicitation stays "
             "measurable. Changes the product owner's behavior, so results are NOT "
             "comparable to runs made without it. Off by default.",
    )
    p_run.add_argument(
        "--po-sees-diff",
        action="store_true",
        help="show the product owner the agent's uncommitted diff alongside its message, "
             "so it reacts to what was written rather than only what was claimed. "
             "Changes what the product owner sees, so results are NOT comparable to "
             "runs made without it. Off by default.",
    )
    p_run.add_argument("--stages", type=int, default=None, help="run only the first N stages of each task")
    p_run.add_argument("--out", default=None)
    p_run.add_argument("--mock", action="store_true", help="copy oracles instead of invoking agents (pipeline test)")
    p_run.add_argument("--keep-work", action="store_true", help="keep workspace directories after scoring")
    p_run.set_defaults(func=cmd_run)

    p_score = sub.add_parser("score", help="score one workspace")
    p_score.add_argument("task")
    p_score.add_argument("workspace")
    p_score.add_argument("--stage", type=int, default=None, help="1-based stage to score up to (default: all stages)")
    p_score.add_argument("--keep-dir", default=None)
    p_score.set_defaults(func=cmd_score)

    p_report = sub.add_parser("report", help="aggregate results into Markdown")
    p_report.add_argument("results", nargs="+", help="results.jsonl files or run directories")
    p_report.add_argument("--out", default=None)
    p_report.set_defaults(func=cmd_report)

    p_backfill = sub.add_parser(
        "backfill", help="recover elicitation counts for an old run from its saved logs"
    )
    p_backfill.add_argument("run_dir", help="run directory or results.jsonl")
    p_backfill.add_argument(
        "--write", action="store_true", help="rewrite results.jsonl in place (keeps a .bak)"
    )
    p_backfill.set_defaults(func=cmd_backfill)

    p_summary = sub.add_parser("summary", help="consolidated table over all runs, one row per arm")
    p_summary.add_argument("--out", default=None)
    p_summary.set_defaults(func=cmd_summary)

    args = parser.parse_args()
    go_cache = Path(tempfile.gettempdir()) / "prism-bench-go"
    os.environ.setdefault("GOCACHE", str(go_cache / "build"))
    os.environ.setdefault("GOMODCACHE", str(go_cache / "pkg" / "mod"))
    if getattr(args, "po_agent", None) is None:
        args.po_agent = getattr(args, "agent", "claude")
    if hasattr(args, "model") and args.model is None:
        args.model = "gpt-5.4" if args.agent == "codex" else "claude-sonnet-5"
    if hasattr(args, "po_model") and args.po_model is None:
        if args.po_agent == args.agent:
            args.po_model = args.model
        else:
            args.po_model = (
                "gpt-5.4"
                if args.po_agent == "codex"
                else "claude-haiku-4-5-20251001"
            )
    args.func(args)


if __name__ == "__main__":
    main()
