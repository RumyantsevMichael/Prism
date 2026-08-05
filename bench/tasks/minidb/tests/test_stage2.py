"""Hidden acceptance tests for minidb stage 2 (querying).

These tests are never shown to the agent. They test only behavior
that bench/tasks/minidb/specs/stage2.md states.
"""
import pytest

from minidb import Database, QueryError


@pytest.fixture
def db():
    d = Database()
    d.execute("CREATE TABLE items (id INT, name TEXT, score INT)")
    d.execute("INSERT INTO items VALUES (1, 'apple', 10)")
    d.execute("INSERT INTO items VALUES (2, 'banana', 5)")
    d.execute("INSERT INTO items VALUES (3, 'cherry', 10)")
    d.execute("INSERT INTO items VALUES (4, 'date', NULL)")
    return d


def ids(rows):
    return [row["id"] for row in rows]


def test_where_less_than(db):
    assert ids(db.execute("SELECT id FROM items WHERE score < 10")) == [2]


def test_where_lte_and_gte(db):
    assert ids(db.execute("SELECT id FROM items WHERE score <= 10")) == [1, 2, 3]
    assert ids(db.execute("SELECT id FROM items WHERE score >= 10")) == [1, 3]


def test_where_not_equal(db):
    assert ids(db.execute("SELECT id FROM items WHERE score != 10")) == [2]


def test_where_and(db):
    rows = db.execute("SELECT id FROM items WHERE score = 10 AND id > 1")
    assert ids(rows) == [3]


def test_where_or(db):
    rows = db.execute("SELECT id FROM items WHERE id = 1 OR id = 4")
    assert ids(rows) == [1, 4]


def test_and_binds_tighter_than_or(db):
    # a OR b AND c reads as a OR (b AND c).
    rows = db.execute(
        "SELECT id FROM items WHERE id = 2 OR id = 3 AND score = 10"
    )
    assert ids(rows) == [2, 3]


def test_parentheses_override_precedence(db):
    rows = db.execute(
        "SELECT id FROM items WHERE (id = 2 OR id = 3) AND score = 10"
    )
    assert ids(rows) == [3]


def test_text_comparison_lexicographic(db):
    rows = db.execute("SELECT id FROM items WHERE name < 'banana'")
    assert ids(rows) == [1]


def test_null_cells_fail_every_comparison(db):
    assert ids(db.execute("SELECT id FROM items WHERE score < 100")) == [1, 2, 3]
    assert ids(db.execute("SELECT id FROM items WHERE score != 5")) == [1, 3]
    assert ids(db.execute("SELECT id FROM items WHERE score >= 0")) == [1, 2, 3]


def test_null_literal_matches_nothing(db):
    assert db.execute("SELECT id FROM items WHERE score != NULL") == []


def test_column_vs_column_comparison(db):
    db.execute("INSERT INTO items VALUES (10, 'self', 10)")
    rows = db.execute("SELECT id FROM items WHERE id = score")
    assert ids(rows) == [10]


def test_column_vs_column_type_mismatch_raises(db):
    with pytest.raises(QueryError):
        db.execute("SELECT id FROM items WHERE id = name")


def test_order_by_ascending_default(db):
    rows = db.execute("SELECT id FROM items WHERE id < 4 ORDER BY score")
    assert ids(rows) == [2, 1, 3]


def test_order_by_descending(db):
    rows = db.execute("SELECT id FROM items WHERE id < 4 ORDER BY score DESC")
    assert ids(rows) == [1, 3, 2]


def test_order_by_nulls_first_ascending(db):
    rows = db.execute("SELECT id FROM items ORDER BY score")
    assert ids(rows) == [4, 2, 1, 3]


def test_order_by_nulls_last_descending(db):
    rows = db.execute("SELECT id FROM items ORDER BY score DESC")
    assert ids(rows) == [1, 3, 2, 4]


def test_order_by_stable_for_ties(db):
    rows = db.execute("SELECT id FROM items WHERE score = 10 ORDER BY score")
    assert ids(rows) == [1, 3]


def test_order_by_unselected_column_allowed(db):
    rows = db.execute("SELECT name FROM items WHERE id < 3 ORDER BY score")
    assert [r["name"] for r in rows] == ["banana", "apple"]


def test_order_by_unknown_column_raises(db):
    with pytest.raises(QueryError):
        db.execute("SELECT id FROM items ORDER BY missing")


def test_limit_basic(db):
    rows = db.execute("SELECT id FROM items ORDER BY id LIMIT 2")
    assert ids(rows) == [1, 2]


def test_limit_zero(db):
    assert db.execute("SELECT id FROM items LIMIT 0") == []


def test_limit_larger_than_result(db):
    rows = db.execute("SELECT id FROM items LIMIT 100")
    assert len(rows) == 4


def test_limit_negative_raises(db):
    with pytest.raises(QueryError):
        db.execute("SELECT id FROM items LIMIT -1")


def test_limit_applies_after_order(db):
    rows = db.execute("SELECT id FROM items ORDER BY score DESC LIMIT 1")
    assert ids(rows) == [1]


def test_update_returns_count_and_changes_rows(db):
    count = db.execute("UPDATE items SET score = 99 WHERE score = 10")
    assert count == 2
    rows = db.execute("SELECT id FROM items WHERE score = 99")
    assert ids(rows) == [1, 3]


def test_update_without_where_updates_all(db):
    assert db.execute("UPDATE items SET name = 'same'") == 4
    names = {r["name"] for r in db.execute("SELECT name FROM items")}
    assert names == {"same"}


def test_update_multiple_columns(db):
    db.execute("UPDATE items SET name = 'renamed', score = 1 WHERE id = 2")
    assert db.execute("SELECT name, score FROM items WHERE id = 2") == [
        {"name": "renamed", "score": 1}
    ]


def test_update_set_null(db):
    db.execute("UPDATE items SET score = NULL WHERE id = 1")
    assert db.execute("SELECT score FROM items WHERE id = 1") == [{"score": None}]


def test_update_type_mismatch_raises(db):
    with pytest.raises(QueryError):
        db.execute("UPDATE items SET score = 'high' WHERE id = 1")


def test_update_unknown_column_raises(db):
    with pytest.raises(QueryError):
        db.execute("UPDATE items SET missing = 1")


def test_update_no_match_returns_zero(db):
    assert db.execute("UPDATE items SET score = 1 WHERE id = 999") == 0


def test_delete_returns_count_and_removes(db):
    assert db.execute("DELETE FROM items WHERE score = 10") == 2
    assert ids(db.execute("SELECT id FROM items")) == [2, 4]


def test_delete_without_where_deletes_all(db):
    assert db.execute("DELETE FROM items") == 4
    assert db.execute("SELECT * FROM items") == []


def test_delete_no_match_returns_zero(db):
    assert db.execute("DELETE FROM items WHERE id = 999") == 0
