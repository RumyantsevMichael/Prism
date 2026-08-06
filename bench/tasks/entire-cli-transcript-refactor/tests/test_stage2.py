"""Hidden tests for transcript parser consumer migration."""

import re
import subprocess
from pathlib import Path


REPO = Path(__file__).resolve().parents[1] / "repo"
CLI = REPO / "cmd" / "entire" / "cli"


def read(relative):
    return (CLI / relative).read_text()


def test_cli_duplicate_functions_are_removed():
    source = read("transcript.go")
    for name in ("parseTranscript", "parseTranscriptFromLine", "parseTranscriptFromBytes"):
        assert not re.search(rf"func\s+{name}\s*\(", source)


def test_claude_code_duplicate_functions_and_limit_are_removed():
    source = read("agent/claudecode/transcript.go")
    assert not re.search(r"func\s+ParseTranscript\s*\(", source)
    assert not re.search(r"func\s+parseTranscriptFromLine\s*\(", source)
    assert "scannerBufferSize" not in source


def test_required_consumers_use_shared_parser():
    file_calls = {
        "hooks_claudecode_handlers.go": "ParseFromFileAtLine",
        "debug.go": "ParseFromFileAtLine",
        "rewind.go": "ParseFromBytes",
        "agent/claudecode/claude.go": "ParseFromBytes",
        "agent/claudecode/transcript.go": "ParseFromFileAtLine",
        "strategy/manual_commit_condensation.go": "ParseFromBytes",
    }
    for relative, call in file_calls.items():
        source = read(relative)
        assert f"transcript.{call}" in source, f"{relative} does not use {call}"


def test_cli_package_tree_passes_go_tests():
    result = subprocess.run(
        ["go", "test", "./cmd/entire/cli/..."],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=900,
    )
    assert result.returncode == 0, result.stdout + result.stderr
