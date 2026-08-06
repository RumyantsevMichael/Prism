# Reference specification: durability and transactions

This is the settled product behavior for the third request.
It extends the earlier specifications, which stay in force.

## Persistence

1. `minidb.Database(directory)` opens a persistent database in `directory`, an existing directory.
2. A directory never used by the engine before is an empty database.
3. The on-disk format is the engineer's design.
   All files live inside `directory`.
4. A new `Database(directory)` on the same directory recovers everything committed: tables, column names, column types, rows, and row insertion order.
5. Type enforcement still holds after recovery: an insert that violates a recovered table's types raises `QueryError`.
6. Durability is synchronous: when `execute` returns for a committed data change (`CREATE TABLE`, `INSERT`, `UPDATE`, `DELETE` outside a transaction, or `COMMIT`), the change is flushed and synced to disk.
   A copy of the directory taken at any moment after the call recovers the change, with no shutdown call required.
7. `Database()` without a directory stays purely in-memory and writes nothing to disk.

## Transactions

1. Statements: `BEGIN`, `COMMIT`, `ROLLBACK`.
   Keywords are case-insensitive.
   Each returns `None`.
2. `BEGIN` starts a transaction.
   `BEGIN` inside an open transaction raises `QueryError`.
3. `COMMIT` or `ROLLBACK` without an open transaction raises `QueryError`.
4. Inside a transaction, changes are immediately visible to later statements on the same `Database` object.
5. `ROLLBACK` reverts every change since `BEGIN`, including `CREATE TABLE`.
6. `COMMIT` makes the transaction's changes permanent, and for a persistent database syncs them to disk before returning.
7. Crash rule: while a transaction is open, nothing of it may reach the recoverable state.
   A copy of the directory taken before `COMMIT` recovers exactly the state as of the last committed change.
8. Transactions work identically for the in-memory engine, minus persistence.
9. Committing a transaction and then rolling back a later transaction keeps the first transaction's changes.
