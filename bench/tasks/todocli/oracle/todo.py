"""Reference solution for the todocli task. Never shown to the agent."""
import json
import os
import sys
from pathlib import Path
from typing import NoReturn


def store_path():
    return Path(os.environ.get("TODO_FILE", "todo.json"))


def load_store():
    path = store_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise CorruptStore()
    if not isinstance(data, list):
        raise CorruptStore()
    return data


def save_store(tasks):
    store_path().write_text(json.dumps(tasks, indent=2) + "\n")


class CorruptStore(Exception):
    pass


def fail(message, code) -> NoReturn:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def usage_error() -> NoReturn:
    fail("error: usage: todo.py add|list|done|remove", 2)


def parse_id(raw):
    try:
        return int(raw)
    except ValueError:
        fail("error: invalid id", 1)


def find_task(tasks, task_id):
    for task in tasks:
        if task["id"] == task_id:
            return task
    fail(f"error: no task {task_id}", 1)


def cmd_add(args):
    if len(args) != 1:
        usage_error()
    text = args[0]
    if not text.strip():
        fail("error: empty text", 1)
    tasks = load_store()
    new_id = max((t["id"] for t in tasks), default=0) + 1
    tasks.append({"id": new_id, "text": text, "done": False})
    save_store(tasks)
    print(f"added {new_id}: {text}")


def cmd_list(args):
    if args:
        usage_error()
    for task in sorted(load_store(), key=lambda t: t["id"]):
        mark = "x" if task["done"] else " "
        print(f"[{mark}] {task['id']} {task['text']}")


def cmd_done(args):
    if len(args) != 1:
        usage_error()
    task_id = parse_id(args[0])
    tasks = load_store()
    find_task(tasks, task_id)["done"] = True
    save_store(tasks)
    print(f"done {task_id}")


def cmd_remove(args):
    if len(args) != 1:
        usage_error()
    task_id = parse_id(args[0])
    tasks = load_store()
    find_task(tasks, task_id)
    tasks = [t for t in tasks if t["id"] != task_id]
    save_store(tasks)
    print(f"removed {task_id}")


def main(argv):
    if not argv:
        usage_error()
    commands = {
        "add": cmd_add,
        "list": cmd_list,
        "done": cmd_done,
        "remove": cmd_remove,
    }
    handler = commands.get(argv[0])
    if handler is None:
        usage_error()
    try:
        handler(argv[1:])
    except CorruptStore:
        fail("error: corrupt store", 1)


if __name__ == "__main__":
    main(sys.argv[1:])
