# Product brief: todo CLI

Build a command-line todo list manager.
A person runs it from a shell to track short tasks in a local JSON file.

## Deliverable interface

This interface is a hard contract.
Hidden acceptance tests drive your program through it, so do not rename or move any part of it.

- One file `todo.py` at the repository root.
- Use the Python standard library only.
- The program runs as `python3 todo.py <command> [args]`.

## Storage rules

1. The store is a JSON file.
   If the environment variable `TODO_FILE` is set, use its value as the file path.
   Otherwise use `todo.json` in the current working directory.
2. The file holds a JSON array of objects.
   Each object has exactly the keys `id` (integer), `text` (string), and `done` (boolean).
3. A missing store file means an empty list.
4. If the file exists but does not parse as a JSON array, every command fails.
   It prints `error: corrupt store` to stderr and exits with code 1.
5. Commands that change state write the store back to the same path.

## Commands

### `add TEXT`

1. `TEXT` is exactly one argument.
2. The new task id is 1 plus the highest existing id, or 1 for an empty store.
3. The new task starts not done.
4. Print `added <id>: <text>` to stdout and exit with code 0.
5. If `TEXT` is empty or contains only whitespace, print `error: empty text` to stderr and exit with code 1.

### `list`

1. Print one line per task to stdout, in ascending id order.
2. A not-done task prints as `[ ] <id> <text>`.
3. A done task prints as `[x] <id> <text>`.
4. An empty store prints nothing.
5. Exit with code 0.

### `done ID`

1. Mark the task with id `ID` as done.
2. Print `done <id>` to stdout and exit with code 0.
3. The command is idempotent: a task that is already done succeeds again.
4. If no task has that id, print `error: no task <id>` to stderr and exit with code 1.
5. If `ID` is not an integer, print `error: invalid id` to stderr and exit with code 1.

### `remove ID`

1. Delete the task with id `ID`.
2. Print `removed <id>` to stdout and exit with code 0.
3. The error rules of `done` apply unchanged.

## Usage errors

A usage error prints one line that starts with `error:` to stderr and exits with code 2.
Usage errors are:

- no command,
- an unknown command,
- a wrong argument count for any command.

## Quality bar

- Test your code with `unittest` from the standard library.
- Cover exit codes, output format, and storage behavior.
