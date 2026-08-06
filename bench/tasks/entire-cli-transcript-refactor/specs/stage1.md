# Shared transcript parser requirements

Add `ParseFromFileAtLine(path string, startLine int) ([]Line, int, error)` to `cmd/entire/cli/transcript/parse.go`.
Use the existing `Line` type.
Treat `startLine` as a zero-based physical line offset.
Count every physical line in `totalLines`, including malformed records and skipped records.
Silently skip malformed JSON records.
Return an empty result when the offset is beyond the file end.
Parse a final valid record without a trailing newline.
Return file open and file read errors.
Do not add a convenience wrapper.
Do not migrate consumers in this stage.
