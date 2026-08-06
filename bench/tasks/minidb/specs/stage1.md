# Reference specification: core engine

This is the settled product behavior for the first request.

## General

1. Keywords (`CREATE`, `TABLE`, `INSERT`, `INTO`, `VALUES`, `SELECT`, `FROM`, `WHERE`, `INT`, `TEXT`, `NULL`) are case-insensitive.
2. Identifiers (table and column names) match `[A-Za-z_][A-Za-z0-9_]*` and are case-sensitive: `Users` and `users` are different names.
3. Whitespace between tokens is free.
4. One optional trailing `;` is allowed at the end of a statement.
5. Every violation of this specification raises `minidb.QueryError`: malformed SQL, unknown table or column, arity mismatch, or a type violation.
6. `execute` input that is not a string raises `QueryError`.
7. `QueryError` is a subclass of `Exception`.

## Literals

1. Integer literals: optional `-`, then digits. They become Python `int`.
2. String literals: single quotes. Two single quotes inside a string mean one literal quote: `'it''s'` is `it's`. They become Python `str`.
3. `NULL` becomes Python `None`.

## CREATE TABLE

1. Form: `CREATE TABLE name (col TYPE, col TYPE, ...)` with at least one column.
2. Types: `INT` and `TEXT`.
3. Creating a table whose name already exists raises `QueryError`.
4. A duplicate column name inside one `CREATE TABLE` raises `QueryError`.
5. Returns `None`.

## INSERT

1. Form: `INSERT INTO name VALUES (lit, lit, ...)`.
2. The value count must equal the column count, otherwise `QueryError`.
3. Type rules: an `INT` column accepts an integer literal or `NULL`.
   A `TEXT` column accepts a string literal or `NULL`.
   Anything else raises `QueryError`.
4. Returns `None`.

## SELECT

1. Form: `SELECT collist FROM name [WHERE col = lit]`.
2. `collist` is `*` or a comma-separated list of column names.
   Naming the same column twice in the list raises `QueryError`.
3. Returns a list of dicts mapping the selected column names to values.
4. Row order is insertion order.
5. Values come back as Python `int`, `str`, or `None`.
6. `WHERE col = lit` keeps rows where the column equals the literal.
7. Comparing with `NULL` never matches: `WHERE col = NULL` returns no rows, even for rows where the column is `NULL`.
8. The literal type must match the column type (`INT` column with integer literal, `TEXT` column with string literal, or the literal `NULL`), otherwise `QueryError`.
   This is a static rule: it applies even when the table has no rows.
