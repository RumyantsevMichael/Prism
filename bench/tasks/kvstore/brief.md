# Product brief: durable key-value store

Build an embedded key-value store that survives crashes.
A host application will use it as its local state store and must never lose an acknowledged write, even when the process dies mid-operation.

This is a system with real design decisions: an append-only log format, escaping, recovery, and compaction.
The internal architecture and the record format are yours to design, within the rules below.
Split the code into as many modules as the design needs.

## Deliverable interface

This interface is a hard contract.
Hidden acceptance tests drive your code through it, so do not rename or move any part of it.

- A module `kvstore.py` or a package `kvstore/` at the repository root, importable as `import kvstore`.
- Use the Python standard library only.
- `kvstore` exposes a class `KVStore` with these methods:

```python
class KVStore:
    def __init__(self, directory): ...
    def set(self, key: str, value: str) -> None: ...
    def get(self, key: str): ...
    def delete(self, key: str) -> bool: ...
    def keys(self) -> list: ...
    def compact(self) -> None: ...
    def close(self) -> None: ...
```

## Data model

1. Keys and values are strings.
2. A key must be a non-empty `str` without `"\n"`.
   A value must be a `str`, and the empty string is a valid value.
   Any other key or value raises `ValueError`.
3. Keys and values may contain spaces, tabs, backslashes, `=`, and any non-ASCII text.
   Values may also contain `"\n"`.
4. `get` returns the current value, or `None` for an absent key.
5. `delete` removes the key.
   It returns `True` when the key existed and `False` when it did not.
6. `keys` returns all current keys sorted ascending.

## Persistence rules

1. `KVStore(directory)` opens the store in an existing directory and recovers the state from disk.
   A directory never used by the store before is an empty store.
2. The store persists to an append-only log file named exactly `data.log` inside the directory.
3. Every `set` and `delete` is durable when the call returns: the bytes are flushed and synced to `data.log` before the method returns.
   A copy of the directory taken at any moment after the call must recover the write, even when `close` was never called.
4. Reopening a directory recovers the latest state: overwrites keep the last value, and deleted keys stay deleted.

## Crash recovery

1. A crash can leave `data.log` with a torn tail: the file ends mid-record.
2. Opening such a store must not raise.
3. Recovery keeps every complete record and drops the torn tail.
   The recovered state must equal the state after some prefix of the operation history.
4. Writes after a torn-tail recovery must work normally.

## Compaction

1. `compact` rewrites the log so it holds only the live state: one record per current key and no deleted keys.
2. After many overwrites, `compact` must make `data.log` smaller.
3. Compaction must not lose data: the state before and after is identical, including after a reopen.
4. The store stays usable after `compact`, and later writes are durable as before.

## Lifecycle

1. `close` releases the file handles.
   Calling `close` twice is allowed.
2. Every other method raises `ValueError` after `close`.
3. Two stores on different directories are fully independent.

## Quality bar

- Test your code with `unittest` from the standard library.
- Cover recovery from a torn log tail, durability without `close`, and compaction.
