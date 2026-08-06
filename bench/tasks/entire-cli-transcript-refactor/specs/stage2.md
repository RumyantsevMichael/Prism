# Consumer migration requirements

Remove `parseTranscript`, `parseTranscriptFromLine`, and `parseTranscriptFromBytes` from the CLI package.
Remove `ParseTranscript`, `parseTranscriptFromLine`, and `scannerBufferSize` from the Claude Code agent package.
Do not keep compatibility shims.
Use `transcript.ParseFromFileAtLine` for file parsing.
Use `transcript.ParseFromBytes` for byte parsing.
Migrate hooks, debug output, rewind, the Claude Code agent, and manual commit condensation.
Move file parser tests to the shared transcript package.
Keep unrelated extraction and utility tests in their current packages.
The complete CLI package tree must compile and pass its tests.
