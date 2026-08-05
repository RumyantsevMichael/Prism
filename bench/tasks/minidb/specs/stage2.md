# Reference specification: querying

This is the settled product behavior for the second request.
It extends the first specification, which stays in force.

## WHERE conditions

1. A condition is built from comparisons combined with `AND`, `OR`, and parentheses.
2. Comparison operators: `=`, `!=`, `<`, `<=`, `>`, `>=`.
3. Each comparison side is a column name or a literal.
   Comparing two columns is allowed.
4. `AND` binds tighter than `OR`.
   Same-operator chains associate left.
5. Type rule: the two sides of a comparison must have the same type, where a column has its declared type, an integer literal is `INT`, and a string literal is `TEXT`.
   `NULL` is compatible with any type.
   A mismatch raises `QueryError`, and the rule is static: it applies even when no row would be affected.
6. Any comparison whose evaluated side is `NULL` is false: `=`, `!=`, and the inequalities all fail on `NULL`, whether the `NULL` comes from a cell or the literal.
7. Integer comparison is numeric.
   Text comparison is Python string comparison (lexicographic by code point).
8. These rules apply to `WHERE` everywhere it appears: `SELECT`, `UPDATE`, and `DELETE`.

## ORDER BY

1. Form: `ORDER BY col [ASC|DESC]` at most once per `SELECT`, after `WHERE`, before `LIMIT`.
   `ASC` is the default.
2. The column must exist in the table, but it does not have to be in the select list.
   An unknown column raises `QueryError`.
3. `NULL` sorts before every value ascending, and after every value descending.
4. The sort is stable: rows with equal keys keep insertion order.

## LIMIT

1. Form: `LIMIT n` last in a `SELECT`, where `n` is an integer literal, at most once.
2. `n` must be zero or positive.
   A negative `n` raises `QueryError`.
3. `LIMIT 0` returns an empty list.
4. `LIMIT` applies after `WHERE` and `ORDER BY`.

## UPDATE

1. Form: `UPDATE name SET col = lit [, col = lit ...] [WHERE cond]`.
2. Each assigned literal must fit the column's type, with `NULL` allowed, otherwise `QueryError`.
3. An unknown table or column raises `QueryError`.
4. Without `WHERE`, every row is updated.
5. Returns the number of updated rows as an `int`.

## DELETE

1. Form: `DELETE FROM name [WHERE cond]`.
2. Without `WHERE`, every row is deleted.
3. Returns the number of deleted rows as an `int`.
