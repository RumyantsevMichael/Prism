"""Hidden acceptance tests for the kvstore task.

These tests are never shown to the agent. They test only behavior
that bench/tasks/kvstore/brief.md states.
"""
import shutil

import pytest

from kvstore import KVStore


@pytest.fixture
def store_dir(tmp_path):
    d = tmp_path / "store"
    d.mkdir()
    return d


def dump(store):
    return {key: store.get(key) for key in store.keys()}


def test_get_missing_returns_none(store_dir):
    store = KVStore(store_dir)
    assert store.get("nope") is None
    store.close()


def test_set_get_roundtrip(store_dir):
    store = KVStore(store_dir)
    store.set("alpha", "1")
    assert store.get("alpha") == "1"
    store.close()


def test_overwrite_keeps_last_value(store_dir):
    store = KVStore(store_dir)
    store.set("k", "old")
    store.set("k", "new")
    assert store.get("k") == "new"
    store.close()


def test_delete_removes_key(store_dir):
    store = KVStore(store_dir)
    store.set("k", "v")
    assert store.delete("k") is True
    assert store.get("k") is None
    store.close()


def test_delete_missing_returns_false(store_dir):
    store = KVStore(store_dir)
    assert store.delete("ghost") is False
    store.close()


def test_keys_sorted(store_dir):
    store = KVStore(store_dir)
    for key in ["banana", "apple", "cherry"]:
        store.set(key, "x")
    assert store.keys() == ["apple", "banana", "cherry"]
    store.close()


def test_keys_empty_store(store_dir):
    store = KVStore(store_dir)
    assert store.keys() == []
    store.close()


def test_reopen_recovers_state(store_dir):
    store = KVStore(store_dir)
    store.set("a", "1")
    store.set("b", "2")
    store.close()
    reopened = KVStore(store_dir)
    assert dump(reopened) == {"a": "1", "b": "2"}
    reopened.close()


def test_reopen_keeps_last_overwrite(store_dir):
    store = KVStore(store_dir)
    store.set("k", "v1")
    store.set("k", "v2")
    store.set("k", "v3")
    store.close()
    reopened = KVStore(store_dir)
    assert reopened.get("k") == "v3"
    reopened.close()


def test_reopen_keeps_deletes(store_dir):
    store = KVStore(store_dir)
    store.set("keep", "1")
    store.set("gone", "2")
    store.delete("gone")
    store.close()
    reopened = KVStore(store_dir)
    assert dump(reopened) == {"keep": "1"}
    reopened.close()


def test_delete_then_set_across_reopen(store_dir):
    store = KVStore(store_dir)
    store.set("k", "old")
    store.delete("k")
    store.set("k", "back")
    store.close()
    reopened = KVStore(store_dir)
    assert reopened.get("k") == "back"
    reopened.close()


def test_many_keys_survive_reopen(store_dir):
    store = KVStore(store_dir)
    expected = {}
    for i in range(50):
        key = f"key-{i:03d}"
        expected[key] = f"value-{i}"
        store.set(key, expected[key])
    store.close()
    reopened = KVStore(store_dir)
    assert dump(reopened) == expected
    reopened.close()


def test_newlines_in_values_survive_reopen(store_dir):
    store = KVStore(store_dir)
    value = "line one\nline two\n\nline four"
    store.set("multi", value)
    store.set("after", "still works")
    store.close()
    reopened = KVStore(store_dir)
    assert reopened.get("multi") == value
    assert reopened.get("after") == "still works"
    reopened.close()


def test_unicode_survives_reopen(store_dir):
    store = KVStore(store_dir)
    store.set("ключ", "значение")
    store.set("emoji", "🎉 done")
    store.close()
    reopened = KVStore(store_dir)
    assert reopened.get("ключ") == "значение"
    assert reopened.get("emoji") == "🎉 done"
    reopened.close()


def test_tabs_backslashes_equals_survive(store_dir):
    store = KVStore(store_dir)
    pairs = {
        "tab\tkey": "tab\tvalue",
        "back\\slash": "c:\\temp\\x",
        "eq=key": "a=b=c",
    }
    for key, value in pairs.items():
        store.set(key, value)
    store.close()
    reopened = KVStore(store_dir)
    assert dump(reopened) == pairs
    reopened.close()


def test_empty_string_value(store_dir):
    store = KVStore(store_dir)
    store.set("empty", "")
    store.close()
    reopened = KVStore(store_dir)
    assert reopened.get("empty") == ""
    assert "empty" in reopened.keys()
    reopened.close()


def test_log_file_is_named_data_log(store_dir):
    store = KVStore(store_dir)
    store.set("k", "v")
    assert (store_dir / "data.log").exists()
    store.close()


def test_durable_without_close(store_dir, tmp_path):
    store = KVStore(store_dir)
    store.set("k", "survives")
    snapshot = tmp_path / "snapshot"
    shutil.copytree(store_dir, snapshot)
    recovered = KVStore(snapshot)
    assert recovered.get("k") == "survives"
    recovered.close()
    store.close()


def apply_ops(ops):
    state = {}
    for op in ops:
        if op[0] == "set":
            state[op[1]] = op[2]
        else:
            state.pop(op[1], None)
    return state


def build_history(store_dir):
    """Run a deterministic op sequence and return every prefix state."""
    ops = []
    for i in range(60):
        key = f"k{i % 5}"
        if i % 7 == 3:
            ops.append(("del", key))
        else:
            ops.append(("set", key, f"v{i}"))
    store = KVStore(store_dir)
    prefixes = [apply_ops(ops[:n]) for n in range(len(ops) + 1)]
    for op in ops:
        if op[0] == "set":
            store.set(op[1], op[2])
        else:
            store.delete(op[1])
    store.close()
    return prefixes


def test_torn_tail_drops_last_record_only(store_dir):
    prefixes = build_history(store_dir)
    log = store_dir / "data.log"
    data = log.read_bytes()
    log.write_bytes(data[:-1])
    recovered = KVStore(store_dir)
    state = dump(recovered)
    recovered.close()
    assert state in prefixes
    assert state != {}


def test_truncation_recovers_a_prefix(store_dir, tmp_path):
    prefixes = build_history(store_dir)
    data = (store_dir / "data.log").read_bytes()
    cuts = [len(data) - 3, len(data) // 2, len(data) // 3, 17, 5, 1]
    for index, cut in enumerate(cuts):
        copy_dir = tmp_path / f"cut{index}"
        shutil.copytree(store_dir, copy_dir)
        (copy_dir / "data.log").write_bytes(data[:cut])
        recovered = KVStore(copy_dir)
        state = dump(recovered)
        recovered.close()
        assert state in prefixes, f"cut at {cut} bytes gave a non-prefix state"


def test_writes_work_after_torn_tail_recovery(store_dir):
    store = KVStore(store_dir)
    store.set("a", "1")
    store.set("b", "2")
    store.close()
    log = store_dir / "data.log"
    log.write_bytes(log.read_bytes()[:-1])
    recovered = KVStore(store_dir)
    recovered.set("c", "3")
    recovered.close()
    final = KVStore(store_dir)
    assert final.get("a") == "1"
    assert final.get("c") == "3"
    final.close()


def test_compact_shrinks_log(store_dir):
    store = KVStore(store_dir)
    for i in range(200):
        store.set("hot", f"value-{i}")
    size_before = (store_dir / "data.log").stat().st_size
    store.compact()
    size_after = (store_dir / "data.log").stat().st_size
    assert size_after < size_before
    assert store.get("hot") == "value-199"
    store.close()


def test_compact_preserves_state_across_reopen(store_dir):
    store = KVStore(store_dir)
    store.set("a", "1")
    store.set("b", "2")
    store.set("a", "1-final")
    store.delete("b")
    store.set("c", "3")
    store.compact()
    store.close()
    reopened = KVStore(store_dir)
    assert dump(reopened) == {"a": "1-final", "c": "3"}
    reopened.close()


def test_writes_after_compact_are_durable(store_dir):
    store = KVStore(store_dir)
    store.set("a", "1")
    store.compact()
    store.set("b", "2")
    store.close()
    reopened = KVStore(store_dir)
    assert dump(reopened) == {"a": "1", "b": "2"}
    reopened.close()


@pytest.mark.parametrize("key", ["", "bad\nkey", 5, None])
def test_invalid_keys_raise(store_dir, key):
    store = KVStore(store_dir)
    with pytest.raises(ValueError):
        store.set(key, "v")
    store.close()


@pytest.mark.parametrize("value", [5, None, b"bytes"])
def test_invalid_values_raise(store_dir, value):
    store = KVStore(store_dir)
    with pytest.raises(ValueError):
        store.set("k", value)
    store.close()


def test_methods_after_close_raise(store_dir):
    store = KVStore(store_dir)
    store.set("k", "v")
    store.close()
    for call in (
        lambda: store.set("k", "v2"),
        lambda: store.get("k"),
        lambda: store.delete("k"),
        lambda: store.keys(),
        lambda: store.compact(),
    ):
        with pytest.raises(ValueError):
            call()


def test_close_twice_is_allowed(store_dir):
    store = KVStore(store_dir)
    store.close()
    store.close()


def test_stores_in_different_dirs_independent(tmp_path):
    dir_a = tmp_path / "a"
    dir_b = tmp_path / "b"
    dir_a.mkdir()
    dir_b.mkdir()
    store_a = KVStore(dir_a)
    store_b = KVStore(dir_b)
    store_a.set("k", "from-a")
    assert store_b.get("k") is None
    store_b.set("k", "from-b")
    assert store_a.get("k") == "from-a"
    store_a.close()
    store_b.close()
