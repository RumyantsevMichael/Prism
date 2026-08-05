"""Hidden acceptance tests for minidb stage 1 (core).

These tests are never shown to the agent. They test only behavior
that bench/tasks/minidb/specs/stage1.md states.
"""
import pytest

import minidb
from minidb import Database, QueryError


@pytest.fixture
def db():
    d = Database()
    d.execute("CREATE TABLE users (id INT, name TEXT)")
    return d


def test_queryerror_is_exception_subclass():
    assert issubclass(minidb.QueryError, Exception)


def test_create_table_returns_none():
    db = Database()
    assert db.execute("CREATE TABLE t (a INT)") is None


def test_insert_returns_none(db):
    assert db.execute("INSERT INTO users VALUES (1, 'ada')") is None


def test_select_star_insertion_order(db):
    db.execute("INSERT INTO users VALUES (2, 'bob')")
    db.execute("INSERT INTO users VALUES (1, 'ada')")
    rows = db.execute("SELECT * FROM users")
    assert rows == [{"id": 2, "name": "bob"}, {"id": 1, "name": "ada"}]


def test_select_specific_columns(db):
    db.execute("INSERT INTO users VALUES (1, 'ada')")
    assert db.execute("SELECT name FROM users") == [{"name": "ada"}]


def test_value_types_are_python_types(db):
    db.execute("INSERT INTO users VALUES (7, 'x')")
    row = db.execute("SELECT * FROM users")[0]
    assert isinstance(row["id"], int)
    assert isinstance(row["name"], str)


def test_where_equality_int(db):
    db.execute("INSERT INTO users VALUES (1, 'ada')")
    db.execute("INSERT INTO users VALUES (2, 'bob')")
    assert db.execute("SELECT name FROM users WHERE id = 2") == [{"name": "bob"}]


def test_where_equality_text(db):
    db.execute("INSERT INTO users VALUES (1, 'ada')")
    db.execute("INSERT INTO users VALUES (2, 'bob')")
    assert db.execute("SELECT id FROM users WHERE name = 'ada'") == [{"id": 1}]


def test_where_no_match_returns_empty(db):
    db.execute("INSERT INTO users VALUES (1, 'ada')")
    assert db.execute("SELECT * FROM users WHERE id = 99") == []


def test_null_insert_and_read(db):
    db.execute("INSERT INTO users VALUES (NULL, 'ghost')")
    assert db.execute("SELECT * FROM users") == [{"id": None, "name": "ghost"}]


def test_where_null_matches_nothing(db):
    db.execute("INSERT INTO users VALUES (NULL, 'ghost')")
    db.execute("INSERT INTO users VALUES (1, 'ada')")
    assert db.execute("SELECT * FROM users WHERE id = NULL") == []


def test_string_quote_escape(db):
    db.execute("INSERT INTO users VALUES (1, 'it''s')")
    assert db.execute("SELECT name FROM users") == [{"name": "it's"}]


def test_keywords_case_insensitive(db):
    db.execute("insert into users values (1, 'ada')")
    assert db.execute("select * from users where id = 1") == [
        {"id": 1, "name": "ada"}
    ]


def test_identifiers_case_sensitive(db):
    with pytest.raises(QueryError):
        db.execute("SELECT * FROM Users")


def test_trailing_semicolon_allowed(db):
    db.execute("INSERT INTO users VALUES (1, 'ada');")
    assert db.execute("SELECT id FROM users;") == [{"id": 1}]


def test_negative_int_literal(db):
    db.execute("INSERT INTO users VALUES (-5, 'neg')")
    assert db.execute("SELECT * FROM users WHERE id = -5") == [
        {"id": -5, "name": "neg"}
    ]


def test_multiple_tables_independent():
    db = Database()
    db.execute("CREATE TABLE a (x INT)")
    db.execute("CREATE TABLE b (x INT)")
    db.execute("INSERT INTO a VALUES (1)")
    assert db.execute("SELECT * FROM b") == []


def test_duplicate_table_raises(db):
    with pytest.raises(QueryError):
        db.execute("CREATE TABLE users (a INT)")


def test_duplicate_column_in_create_raises():
    db = Database()
    with pytest.raises(QueryError):
        db.execute("CREATE TABLE t (a INT, a TEXT)")


def test_unknown_table_raises(db):
    with pytest.raises(QueryError):
        db.execute("SELECT * FROM missing")
    with pytest.raises(QueryError):
        db.execute("INSERT INTO missing VALUES (1)")


def test_unknown_column_select_raises(db):
    with pytest.raises(QueryError):
        db.execute("SELECT nope FROM users")


def test_unknown_column_where_raises(db):
    with pytest.raises(QueryError):
        db.execute("SELECT * FROM users WHERE nope = 1")


def test_duplicate_column_in_select_raises(db):
    with pytest.raises(QueryError):
        db.execute("SELECT id, id FROM users")


def test_arity_mismatch_raises(db):
    with pytest.raises(QueryError):
        db.execute("INSERT INTO users VALUES (1)")
    with pytest.raises(QueryError):
        db.execute("INSERT INTO users VALUES (1, 'a', 2)")


def test_insert_type_mismatch_raises(db):
    with pytest.raises(QueryError):
        db.execute("INSERT INTO users VALUES ('x', 'ada')")
    with pytest.raises(QueryError):
        db.execute("INSERT INTO users VALUES (1, 2)")


def test_where_type_mismatch_raises(db):
    with pytest.raises(QueryError):
        db.execute("SELECT * FROM users WHERE id = 'x'")


def test_where_type_mismatch_is_static(db):
    # The table is empty, and the rule still applies.
    with pytest.raises(QueryError):
        db.execute("SELECT * FROM users WHERE name = 5")


@pytest.mark.parametrize(
    "sql",
    [
        "",
        "CREATE TABLE",
        "SELEC * FROM users",
        "INSERT INTO users VALUES 1, 'a'",
        "SELECT * FROM users WHERE",
        "CREATE TABLE empty ()",
    ],
)
def test_malformed_sql_raises(db, sql):
    with pytest.raises(QueryError):
        db.execute(sql)


def test_non_string_sql_raises(db):
    with pytest.raises(QueryError):
        db.execute(42)
