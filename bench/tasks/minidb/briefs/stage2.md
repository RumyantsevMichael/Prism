# Product request: real querying

The database core works, but users hit its limits immediately.
Equality-only filtering is not enough, and there is no way to change data after insert.

Extend the engine:

- Rich filters: comparison operators (equal, not equal, less, less-or-equal, greater, greater-or-equal), combined with `AND`, `OR`, and parentheses.
- Sorting: `ORDER BY` a column, ascending or descending.
- `LIMIT` for the first N rows.
- `UPDATE ... SET ... [WHERE ...]` to change rows.
- `DELETE FROM ... [WHERE ...]` to remove rows.
- `UPDATE` and `DELETE` return the number of affected rows.

Everything from the first request keeps working unchanged.
The semantics have edge cases: operator precedence, how NULL behaves in comparisons and in sorting, type rules, tie-breaking.
The product owner has settled these details, so ask about the cases you need decided.
