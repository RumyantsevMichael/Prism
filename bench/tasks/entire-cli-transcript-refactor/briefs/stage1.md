# Shared transcript parser

The Entire CLI has duplicate JSONL file readers with different behavior.
Add one shared file parser to the existing transcript package.
The parser must support incremental reads from a line offset and report the total physical line count.
Do not migrate existing consumers in this stage.

Ask the product owner about malformed records, offsets, final records, and file errors before you design the interface.
