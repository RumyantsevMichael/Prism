# Product brief: spreadsheet formula engine

Build the calculation engine of a spreadsheet.
A host application will embed it to store cell values, evaluate formulas, and keep dependent cells consistent as inputs change.

This is a system with real design decisions: formula parsing, a dependency structure, cycle handling, and error semantics.
The internal architecture is yours to design.
Split the code into as many modules as the design needs.

## Deliverable interface

This interface is a hard contract.
Hidden acceptance tests drive your code through it, so do not rename or move any part of it.

- A module `sheetcalc.py` or a package `sheetcalc/` at the repository root, importable as `import sheetcalc`.
- Use the Python standard library only.
- `sheetcalc` exposes a class `Spreadsheet` with these methods:

```python
class Spreadsheet:
    def set(self, address: str, raw: str) -> None: ...
    def get(self, address: str): ...
    def raw(self, address: str): ...
    def delete(self, address: str) -> None: ...
```

## Addresses

1. An address is one or more ASCII letters followed by a row number without leading zeros, such as `A1`, `c7`, or `AA10`.
2. Addresses are case-insensitive: `a1` and `A1` name the same cell.
3. Rows start at 1.
4. Every method validates its address and raises `ValueError` for an invalid one, such as `A0`, `1A`, or an empty string.

## Cell content

1. `set` stores a raw string for a cell.
   A raw value that is not a string raises `ValueError`.
2. A raw string that starts with `=` is a formula.
3. Otherwise, if Python's `float()` accepts the raw string, the cell is a number.
4. Otherwise the cell is text.
5. `raw` returns the exact stored string, or `None` for an empty cell.
6. `delete` empties the cell.
   Deleting an empty cell is allowed and does nothing.

## Evaluation: `get`

1. `get` returns the computed value of a cell: `None` for an empty cell, a `float` for a number, a `str` for text, or an error marker string.
2. A number cell returns its numeric value as a `float`.
3. A formula cell returns the result of its expression as a `float`, or an error marker.
4. After any `set` or `delete`, a later `get` of any cell must reflect the change, including cells that depend on the changed cell through any number of formula references.

## Formula language

A formula is `=` followed by an expression.
Whitespace between tokens is allowed.

1. Operands: decimal number literals and cell references.
2. Operators: `+`, `-`, `*`, `/`, unary minus, and parentheses.
   `*` and `/` bind tighter than `+` and `-`, and equal precedence associates left.
3. Functions: `SUM`, `MIN`, and `MAX`.
   Function names are case-insensitive.
   Each takes exactly one range argument, such as `=SUM(A1:B3)`.
4. A range names two corner cells separated by `:` and covers the rectangle between them.
   The corners may arrive in any order: `B2:A1` covers the same cells as `A1:B2`.
5. A range is only valid as a function argument.
   A range anywhere else in an expression is an error.

## Evaluation rules

1. In arithmetic, a reference to an empty cell counts as `0.0`.
2. In arithmetic, a reference to a text cell is an error: the formula returns `#ERROR!`.
3. `SUM`, `MIN`, and `MAX` skip empty and text cells in their range.
4. `SUM` of a range with no numeric cells returns `0.0`.
5. `MIN` or `MAX` of a range with no numeric cells returns `#ERROR!`.
6. Division by zero returns `#DIV/0!`.
7. A formula that does not parse returns `#ERROR!`.
8. A reference to a cell whose value is an error marker returns that same marker.
   This applies inside ranges as well.
9. A formula whose evaluation depends on itself through any reference chain returns `#CYCLE!`.
   Every cell whose evaluation reaches the cycle returns `#CYCLE!`.
10. When a later `set` or `delete` breaks a cycle, the involved cells return normal values again.

The error markers are exactly the strings `#ERROR!`, `#DIV/0!`, and `#CYCLE!`.

## Quality bar

- Test your code with `unittest` from the standard library.
- Cover the formula grammar, the recalculation behavior, every error marker, and cycle recovery.
