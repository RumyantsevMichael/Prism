"""Hidden acceptance tests for minidb stage 3 (durability and transactions).

These tests are never shown to the agent. They test only behavior
that bench/tasks/minidb/specs/stage3.md states.
"""
import shutil

import pytest

from minidb import Database, QueryError


@pytest.fixture
def db_dir(tmp_path):
    d = tmp_path / "db"
    d.mkdir()
    return d


def seeded(directory):
    db = Database(directory)
    db.execute("CREATE TABLE t (id INT, name TEXT)")
    db.execute("INSERT INTO t VALUES (1, 'ada')")
    db.execute("INSERT INTO t VALUES (2, 'bob')")
    return db


def test_reopen_recovers_tables_and_rows(db_dir):
    seeded(db_dir)
    reopened = Database(db_dir)
    assert reopened.execute("SELECT * FROM t") == [
        {"id": 1, "name": "ada"},
        {"id": 2, "name": "bob"},
    ]


def test_fresh_directory_is_empty_database(db_dir):
    db = Database(db_dir)
    with pytest.raises(QueryError):
        db.execute("SELECT * FROM t")


def test_reopen_preserves_types(db_dir):
    seeded(db_dir)
    reopened = Database(db_dir)
    with pytest.raises(QueryError):
        reopened.execute("INSERT INTO t VALUES ('text', 'x')")


def test_reopen_preserves_insertion_order(db_dir):
    db = Database(db_dir)
    db.execute("CREATE TABLE t (id INT)")
    for value in [5, 3, 9, 1]:
        db.execute(f"INSERT INTO t VALUES ({value})")
    reopened = Database(db_dir)
    assert [r["id"] for r in reopened.execute("SELECT * FROM t")] == [5, 3, 9, 1]


def test_update_and_delete_are_durable(db_dir):
    db = seeded(db_dir)
    db.execute("UPDATE t SET name = 'ADA' WHERE id = 1")
    db.execute("DELETE FROM t WHERE id = 2")
    reopened = Database(db_dir)
    assert reopened.execute("SELECT * FROM t") == [{"id": 1, "name": "ADA"}]


def test_durable_without_shutdown_via_copy(db_dir, tmp_path):
    db = seeded(db_dir)
    db.execute("INSERT INTO t VALUES (3, 'eve')")
    snapshot = tmp_path / "snapshot"
    shutil.copytree(db_dir, snapshot)
    recovered = Database(snapshot)
    assert [r["id"] for r in recovered.execute("SELECT * FROM t")] == [1, 2, 3]


def test_accumulates_across_reopens(db_dir):
    seeded(db_dir)
    second = Database(db_dir)
    second.execute("INSERT INTO t VALUES (3, 'eve')")
    third = Database(db_dir)
    assert len(third.execute("SELECT * FROM t")) == 3


def test_two_directories_independent(tmp_path):
    dir_a = tmp_path / "a"
    dir_b = tmp_path / "b"
    dir_a.mkdir()
    dir_b.mkdir()
    seeded(dir_a)
    db_b = Database(dir_b)
    with pytest.raises(QueryError):
        db_b.execute("SELECT * FROM t")


def test_transaction_commit_visible_and_durable(db_dir):
    db = seeded(db_dir)
    db.execute("BEGIN")
    db.execute("INSERT INTO t VALUES (3, 'eve')")
    db.execute("COMMIT")
    assert len(db.execute("SELECT * FROM t")) == 3
    reopened = Database(db_dir)
    assert len(reopened.execute("SELECT * FROM t")) == 3


def test_changes_inside_transaction_visible_on_same_connection(db_dir):
    db = seeded(db_dir)
    db.execute("BEGIN")
    db.execute("UPDATE t SET name = 'x' WHERE id = 1")
    assert db.execute("SELECT name FROM t WHERE id = 1") == [{"name": "x"}]
    db.execute("ROLLBACK")


def test_rollback_reverts_insert(db_dir):
    db = seeded(db_dir)
    db.execute("BEGIN")
    db.execute("INSERT INTO t VALUES (3, 'eve')")
    db.execute("ROLLBACK")
    assert len(db.execute("SELECT * FROM t")) == 2


def test_rollback_reverts_update_and_delete(db_dir):
    db = seeded(db_dir)
    db.execute("BEGIN")
    db.execute("UPDATE t SET name = 'x'")
    db.execute("DELETE FROM t WHERE id = 2")
    db.execute("ROLLBACK")
    assert db.execute("SELECT * FROM t") == [
        {"id": 1, "name": "ada"},
        {"id": 2, "name": "bob"},
    ]


def test_rollback_reverts_create_table(db_dir):
    db = seeded(db_dir)
    db.execute("BEGIN")
    db.execute("CREATE TABLE extra (x INT)")
    db.execute("ROLLBACK")
    with pytest.raises(QueryError):
        db.execute("SELECT * FROM extra")


def test_copy_during_open_transaction_recovers_committed_state_only(db_dir, tmp_path):
    db = seeded(db_dir)
    db.execute("BEGIN")
    db.execute("INSERT INTO t VALUES (3, 'eve')")
    snapshot = tmp_path / "snapshot"
    shutil.copytree(db_dir, snapshot)
    recovered = Database(snapshot)
    assert [r["id"] for r in recovered.execute("SELECT * FROM t")] == [1, 2]
    db.execute("ROLLBACK")


def test_commit_without_begin_raises(db_dir):
    db = Database(db_dir)
    with pytest.raises(QueryError):
        db.execute("COMMIT")


def test_rollback_without_begin_raises(db_dir):
    db = Database(db_dir)
    with pytest.raises(QueryError):
        db.execute("ROLLBACK")


def test_nested_begin_raises(db_dir):
    db = Database(db_dir)
    db.execute("BEGIN")
    with pytest.raises(QueryError):
        db.execute("BEGIN")


def test_transaction_keywords_case_insensitive(db_dir):
    db = seeded(db_dir)
    db.execute("begin")
    db.execute("INSERT INTO t VALUES (3, 'eve')")
    db.execute("commit")
    assert len(db.execute("SELECT * FROM t")) == 3


def test_committed_survives_later_rollback(db_dir):
    db = seeded(db_dir)
    db.execute("BEGIN")
    db.execute("INSERT INTO t VALUES (3, 'eve')")
    db.execute("COMMIT")
    db.execute("BEGIN")
    db.execute("DELETE FROM t")
    db.execute("ROLLBACK")
    assert len(db.execute("SELECT * FROM t")) == 3
    reopened = Database(db_dir)
    assert len(reopened.execute("SELECT * FROM t")) == 3


def test_transactions_work_in_memory():
    db = Database()
    db.execute("CREATE TABLE t (id INT)")
    db.execute("BEGIN")
    db.execute("INSERT INTO t VALUES (1)")
    db.execute("ROLLBACK")
    assert db.execute("SELECT * FROM t") == []
    db.execute("BEGIN")
    db.execute("INSERT INTO t VALUES (2)")
    db.execute("COMMIT")
    assert db.execute("SELECT * FROM t") == [{"id": 2}]


def test_in_memory_database_writes_nothing(tmp_path):
    before = sorted(tmp_path.rglob("*"))
    db = Database()
    db.execute("CREATE TABLE t (id INT)")
    db.execute("INSERT INTO t VALUES (1)")
    assert sorted(tmp_path.rglob("*")) == before
