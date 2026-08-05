# Product brief: Markdown table formatter

Build a formatter that normalizes a Markdown table.
An editor plugin will call it to align a table's columns while a person types.

## Deliverable interface

This interface is a hard contract.
Hidden acceptance tests drive your code through it, so do not rename or move any part of it.

- One file `mdtable.py` at the repository root.
- Use the Python standard library only.
- The file exposes one function: `format_table(text: str) -> str`.

## Input rules

1. Split the input on `"\n"`.
2. Discard leading and trailing lines that are empty or contain only whitespace.
3. Every remaining line is one table row.
4. Strip each row of surrounding whitespace.
   After the strip, the row must start with `|` and end with `|`, and hold at least those two characters.
   Otherwise raise `ValueError`.
5. The cells of a row are the segments between the outer pipes, split on `|`, each stripped of surrounding whitespace.
   The input never contains escaped pipes.
6. The table needs at least two rows: a header row, then an alignment row.
   Fewer rows raise `ValueError`.
7. Every row must have the same cell count.
   Otherwise raise `ValueError`.
8. Each alignment-row cell must match the regular expression `:?-+:?` in full.
   Otherwise raise `ValueError`.

## Alignment rules

- A cell of only dashes sets the default alignment, which renders like left.
- `:` on the left only sets left alignment.
- `:` on the right only sets right alignment.
- `:` on both sides sets center alignment.

## Output rules

1. The column width is the length of the longest cell among the header row and the data rows in that column, with a minimum of 3.
   Alignment-row cells do not count toward the width.
2. Pad each header and data cell with spaces to the column width:
   - left and default: content first, then spaces,
   - right: spaces first, then content,
   - center: split the spaces evenly, and give the extra space to the right side when the split is odd.
3. Render the alignment row per column at the column width `w`:
   - default: `w` dashes,
   - left: `:` then `w - 1` dashes,
   - right: `w - 1` dashes then `:`,
   - center: `:` then `w - 2` dashes then `:`.
4. Render every row as `| ` + the cells joined by ` | ` + ` |`.
5. Join the rows with `"\n"`.
   Do not add a trailing newline.
6. Formatting an already formatted table must return it unchanged.

## Quality bar

- Test your code with `unittest` from the standard library.
- Cover every `ValueError` rule and every alignment kind.
