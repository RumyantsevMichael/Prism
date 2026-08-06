"""Hidden tests for the shared transcript file parser."""

import subprocess
from pathlib import Path


REPO = Path(__file__).resolve().parents[1] / "repo"
PACKAGE = REPO / "cmd" / "entire" / "cli" / "transcript"


def run_go_test(name, body):
    test_file = PACKAGE / f"prism_bench_{name.lower()}_test.go"
    test_file.write_text(
        "package transcript\n\n"
        'import (\n  "os"\n  "path/filepath"\n  "testing"\n)\n\n'
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


def test_valid_records_and_final_record():
    run_go_test(
        "TestPrismValidRecords",
        r'''
func TestPrismValidRecords(t *testing.T) {
    path := filepath.Join(t.TempDir(), "transcript.jsonl")
    data := []byte("{\"type\":\"user\",\"uuid\":\"one\"}\n{\"type\":\"assistant\",\"uuid\":\"two\"}")
    if err := os.WriteFile(path, data, 0o600); err != nil { t.Fatal(err) }
    lines, total, err := ParseFromFileAtLine(path, 0)
    if err != nil { t.Fatal(err) }
    if total != 2 || len(lines) != 2 { t.Fatalf("total=%d parsed=%d", total, len(lines)) }
    if lines[0].UUID != "one" || lines[1].UUID != "two" { t.Fatalf("wrong records: %#v", lines) }
}
''',
    )


def test_malformed_records_are_skipped_and_counted():
    run_go_test(
        "TestPrismMalformedRecords",
        r'''
func TestPrismMalformedRecords(t *testing.T) {
    path := filepath.Join(t.TempDir(), "transcript.jsonl")
    data := []byte("{\"type\":\"user\",\"uuid\":\"one\"}\nnot json\n{\"type\":\"user\",\"uuid\":\"three\"}\n")
    if err := os.WriteFile(path, data, 0o600); err != nil { t.Fatal(err) }
    lines, total, err := ParseFromFileAtLine(path, 0)
    if err != nil { t.Fatal(err) }
    if total != 3 || len(lines) != 2 { t.Fatalf("total=%d parsed=%d", total, len(lines)) }
}
''',
    )


def test_offset_uses_physical_lines():
    run_go_test(
        "TestPrismPhysicalOffset",
        r'''
func TestPrismPhysicalOffset(t *testing.T) {
    path := filepath.Join(t.TempDir(), "transcript.jsonl")
    data := []byte("{\"type\":\"user\",\"uuid\":\"zero\"}\nbad\n{\"type\":\"user\",\"uuid\":\"two\"}\n{\"type\":\"user\",\"uuid\":\"three\"}")
    if err := os.WriteFile(path, data, 0o600); err != nil { t.Fatal(err) }
    lines, total, err := ParseFromFileAtLine(path, 2)
    if err != nil { t.Fatal(err) }
    if total != 4 || len(lines) != 2 { t.Fatalf("total=%d parsed=%d", total, len(lines)) }
    if lines[0].UUID != "two" { t.Fatalf("first uuid=%q", lines[0].UUID) }
}
''',
    )


def test_offset_beyond_end_and_file_error():
    run_go_test(
        "TestPrismBoundaryAndError",
        r'''
func TestPrismBoundaryAndError(t *testing.T) {
    path := filepath.Join(t.TempDir(), "transcript.jsonl")
    if err := os.WriteFile(path, []byte("{\"type\":\"user\",\"uuid\":\"one\"}"), 0o600); err != nil { t.Fatal(err) }
    lines, total, err := ParseFromFileAtLine(path, 9)
    if err != nil { t.Fatal(err) }
    if total != 1 || len(lines) != 0 { t.Fatalf("total=%d parsed=%d", total, len(lines)) }
    if _, _, err := ParseFromFileAtLine(path+".missing", 0); err == nil { t.Fatal("expected file error") }
}
''',
    )
