"""Reference solution for the mdtable task. Never shown to the agent."""
import re

_ALIGN_CELL = re.compile(r":?-+:?")


def _parse_row(line):
    row = line.strip()
    if len(row) < 2 or not row.startswith("|") or not row.endswith("|"):
        raise ValueError(f"not a table row: {line!r}")
    return [cell.strip() for cell in row[1:-1].split("|")]


def _alignment(cell):
    if not _ALIGN_CELL.fullmatch(cell):
        raise ValueError(f"bad alignment cell: {cell!r}")
    left = cell.startswith(":")
    right = cell.endswith(":")
    if left and right:
        return "center"
    if right:
        return "right"
    if left:
        return "left"
    return "default"


def _pad(cell, width, align):
    if align == "right":
        return cell.rjust(width)
    if align == "center":
        extra = width - len(cell)
        left_pad = extra // 2
        return " " * left_pad + cell + " " * (extra - left_pad)
    return cell.ljust(width)


def _align_cell(width, align):
    if align == "left":
        return ":" + "-" * (width - 1)
    if align == "right":
        return "-" * (width - 1) + ":"
    if align == "center":
        return ":" + "-" * (width - 2) + ":"
    return "-" * width


def format_table(text):
    lines = text.split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    if len(lines) < 2:
        raise ValueError("a table needs a header row and an alignment row")
    rows = [_parse_row(line) for line in lines]
    columns = len(rows[0])
    if any(len(row) != columns for row in rows):
        raise ValueError("all rows must have the same cell count")
    aligns = [_alignment(cell) for cell in rows[1]]
    content_rows = [rows[0]] + rows[2:]
    widths = [
        max(3, max(len(row[i]) for row in content_rows)) for i in range(columns)
    ]
    out = []
    for index, row in enumerate(rows):
        if index == 1:
            cells = [_align_cell(widths[i], aligns[i]) for i in range(columns)]
        else:
            cells = [_pad(row[i], widths[i], aligns[i]) for i in range(columns)]
        out.append("| " + " | ".join(cells) + " |")
    return "\n".join(out)
