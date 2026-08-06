# Product request: embeddable mini SQL database

Our Python application needs a small embedded SQL database.
We do not want an external dependency, so build it in pure Python with the standard library only.

What we need first is the core:

- Create tables with typed columns.
  Two types are enough for now: integers and text.
- Insert rows.
- Read rows back: all columns or a chosen list of columns, with a simple equality filter.

## Interface

This part is a hard contract.
Hidden acceptance tests drive your code through it, so do not rename or move any part of it.

- A module `minidb.py` or a package `minidb/` at the repository root, importable as `import minidb`.
- `minidb.Database` is the engine: `db = minidb.Database()` gives an empty in-memory database.
- `db.execute(sql)` runs one SQL statement and returns the result.
- A `SELECT` returns a list of dicts that map column names to Python values.
- Anything wrong, such as bad SQL, an unknown table or column, or a value that does not fit the column, raises `minidb.QueryError`.

We care about predictable SQL semantics: types, NULL handling, string quoting, and exact error behavior.
The product owner has settled these details, so ask about the cases you need decided.
