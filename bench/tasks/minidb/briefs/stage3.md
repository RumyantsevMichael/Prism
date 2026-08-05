# Product request: durability and transactions

The database loses everything on restart, and our users are starting to keep real data in it.
Two capabilities are now required.

**Persistence.**
`minidb.Database(directory)` opens a database that lives in the given directory.
Everything committed must survive: a new `Database(directory)` on the same directory recovers tables, rows, and types.
Durability must be real: data our application wrote must be recoverable even if the process dies right after the write, without any shutdown call.
`Database()` without a directory stays a purely in-memory engine, as before.

**Transactions.**
`BEGIN`, `COMMIT`, and `ROLLBACK` statements.
A transaction groups statements: `ROLLBACK` undoes everything since `BEGIN`, and `COMMIT` makes it permanent.
Only committed data may ever be recovered after a crash.
Transactions must also work for the in-memory engine.

Everything from the earlier requests keeps working unchanged.
The product owner has settled the details, such as crash behavior, transaction misuse, and what happens to schema changes inside a transaction.
Ask about the cases you need decided.
