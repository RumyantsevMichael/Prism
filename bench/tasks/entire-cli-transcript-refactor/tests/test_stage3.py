"""Hidden tests for transcript records without a fixed size limit."""

import subprocess
from pathlib import Path


REPO = Path(__file__).resolve().parents[1] / "repo"
PACKAGE = REPO / "cmd" / "entire" / "cli" / "transcript"


def run_large_test(name, body):
    test_file = PACKAGE / f"prism_bench_{name.lower()}_test.go"
    test_file.write_text(
        "package transcript\n\n"
        'import (\n  "os"\n  "path/filepath"\n  "strings"\n  "testing"\n)\n\n'
        + body
    )
    try:
        result = subprocess.run(
            ["go", "test", ".", "-run", f"^{name}$", "-count=1"],
            cwd=PACKAGE,
            capture_output=True,
            text=True,
            timeout=300,
        )
    finally:
        test_file.unlink(missing_ok=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_record_larger_than_old_limit():
    run_large_test(
        "TestPrismLargeRecord",
        r'''
func TestPrismLargeRecord(t *testing.T) {
    path := filepath.Join(t.TempDir(), "transcript.jsonl")
    data := "{\"type\":\"user\",\"uuid\":\"large\",\"message\":{\"content\":\"" + strings.Repeat("x", 11*1024*1024) + "\"}}"
    if err := os.WriteFile(path, []byte(data), 0o600); err != nil { t.Fatal(err) }
    lines, total, err := ParseFromFileAtLine(path, 0)
    if err != nil { t.Fatal(err) }
    if total != 1 || len(lines) != 1 || lines[0].UUID != "large" { t.Fatalf("total=%d parsed=%d", total, len(lines)) }
}
''',
    )


def test_large_record_after_offset():
    run_large_test(
        "TestPrismLargeRecordAfterOffset",
        r'''
func TestPrismLargeRecordAfterOffset(t *testing.T) {
    path := filepath.Join(t.TempDir(), "transcript.jsonl")
    data := "{\"type\":\"user\",\"uuid\":\"skip\"}\n{\"type\":\"user\",\"uuid\":\"large\",\"message\":{\"content\":\"" + strings.Repeat("x", 11*1024*1024) + "\"}}"
    if err := os.WriteFile(path, []byte(data), 0o600); err != nil { t.Fatal(err) }
    lines, total, err := ParseFromFileAtLine(path, 1)
    if err != nil { t.Fatal(err) }
    if total != 2 || len(lines) != 1 || lines[0].UUID != "large" { t.Fatalf("total=%d parsed=%d", total, len(lines)) }
}
''',
    )


def test_file_parser_streams_without_scanner_limit():
    source = (PACKAGE / "parse.go").read_text()
    start = source.index("func ParseFromFileAtLine")
    body = source[start:]
    assert "bufio.NewReader" in body
    assert "bufio.NewScanner" not in body
    assert "os.ReadFile" not in body
    assert ".Buffer(" not in body
