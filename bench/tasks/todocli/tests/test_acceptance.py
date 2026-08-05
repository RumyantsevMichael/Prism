"""Hidden acceptance tests for the todocli task.

These tests are never shown to the agent. They test only behavior
that bench/tasks/todocli/brief.md states.
"""
import json
import subprocess
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "todo.py"


def run(args, cwd, env_extra=None):
    import os

    env = dict(os.environ)
    env.pop("TODO_FILE", None)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, str(APP), *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def read_store(cwd):
    return json.loads((Path(cwd) / "todo.json").read_text())


def test_add_prints_and_exits_zero(tmp_path):
    result = run(["add", "buy milk"], tmp_path)
    assert result.returncode == 0
    assert result.stdout.strip() == "added 1: buy milk"


def test_add_persists_schema(tmp_path):
    run(["add", "buy milk"], tmp_path)
    store = read_store(tmp_path)
    assert store == [{"id": 1, "text": "buy milk", "done": False}]


def test_ids_increment(tmp_path):
    run(["add", "a"], tmp_path)
    run(["add", "b"], tmp_path)
    result = run(["add", "c"], tmp_path)
    assert result.stdout.strip() == "added 3: c"


def test_id_is_max_plus_one_after_remove(tmp_path):
    run(["add", "a"], tmp_path)
    run(["add", "b"], tmp_path)
    run(["remove", "2"], tmp_path)
    result = run(["add", "c"], tmp_path)
    assert result.stdout.strip() == "added 2: c"


def test_add_empty_text_fails(tmp_path):
    result = run(["add", "   "], tmp_path)
    assert result.returncode == 1
    assert result.stderr.strip() == "error: empty text"


def test_list_empty_prints_nothing(tmp_path):
    result = run(["list"], tmp_path)
    assert result.returncode == 0
    assert result.stdout == ""


def test_list_format_and_order(tmp_path):
    run(["add", "first"], tmp_path)
    run(["add", "second"], tmp_path)
    run(["done", "2"], tmp_path)
    result = run(["list"], tmp_path)
    assert result.returncode == 0
    assert result.stdout.splitlines() == ["[ ] 1 first", "[x] 2 second"]


def test_done_marks_task(tmp_path):
    run(["add", "a"], tmp_path)
    result = run(["done", "1"], tmp_path)
    assert result.returncode == 0
    assert result.stdout.strip() == "done 1"
    assert read_store(tmp_path)[0]["done"] is True


def test_done_is_idempotent(tmp_path):
    run(["add", "a"], tmp_path)
    run(["done", "1"], tmp_path)
    result = run(["done", "1"], tmp_path)
    assert result.returncode == 0
    assert result.stdout.strip() == "done 1"


def test_done_unknown_id_fails(tmp_path):
    result = run(["done", "5"], tmp_path)
    assert result.returncode == 1
    assert result.stderr.strip() == "error: no task 5"


def test_done_non_integer_id_fails(tmp_path):
    result = run(["done", "abc"], tmp_path)
    assert result.returncode == 1
    assert result.stderr.strip() == "error: invalid id"


def test_remove_deletes_task(tmp_path):
    run(["add", "a"], tmp_path)
    run(["add", "b"], tmp_path)
    result = run(["remove", "1"], tmp_path)
    assert result.returncode == 0
    assert result.stdout.strip() == "removed 1"
    store = read_store(tmp_path)
    assert [t["id"] for t in store] == [2]


def test_remove_unknown_id_fails(tmp_path):
    result = run(["remove", "9"], tmp_path)
    assert result.returncode == 1
    assert result.stderr.strip() == "error: no task 9"


def test_no_command_is_usage_error(tmp_path):
    result = run([], tmp_path)
    assert result.returncode == 2
    assert result.stderr.startswith("error:")


def test_unknown_command_is_usage_error(tmp_path):
    result = run(["frobnicate"], tmp_path)
    assert result.returncode == 2
    assert result.stderr.startswith("error:")


def test_add_without_text_is_usage_error(tmp_path):
    result = run(["add"], tmp_path)
    assert result.returncode == 2
    assert result.stderr.startswith("error:")


def test_add_with_extra_args_is_usage_error(tmp_path):
    result = run(["add", "a", "b"], tmp_path)
    assert result.returncode == 2
    assert result.stderr.startswith("error:")


def test_todo_file_env_var_is_respected(tmp_path):
    store_path = tmp_path / "custom" / "store.json"
    store_path.parent.mkdir()
    result = run(["add", "a"], tmp_path, env_extra={"TODO_FILE": str(store_path)})
    assert result.returncode == 0
    assert json.loads(store_path.read_text()) == [
        {"id": 1, "text": "a", "done": False}
    ]
    assert not (tmp_path / "todo.json").exists()


def test_corrupt_store_fails(tmp_path):
    (tmp_path / "todo.json").write_text("{not json")
    result = run(["list"], tmp_path)
    assert result.returncode == 1
    assert result.stderr.strip() == "error: corrupt store"


def test_non_array_store_is_corrupt(tmp_path):
    (tmp_path / "todo.json").write_text('{"id": 1}')
    result = run(["add", "a"], tmp_path)
    assert result.returncode == 1
    assert result.stderr.strip() == "error: corrupt store"
