"""Reference solution for the minidb task. Never shown to the agent."""
import copy
import json
import os
import re
from pathlib import Path

_DB_FILE = "db.json"


class QueryError(Exception):
    pass


_TOKEN_RE = re.compile(
    r"""\s*(?:
      (?P<str>'(?:[^']|'')*')
    | (?P<num>-?[0-9]+)
    | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
    | (?P<op><=|>=|!=|=|<|>)
    | (?P<punct>[(),*;])
    )""",
    re.VERBOSE,
)


def _tokenize(sql):
    tokens = []
    pos = 0
    while pos < len(sql):
        match = _TOKEN_RE.match(sql, pos)
        if match is None:
            if sql[pos:].strip() == "":
                break
            raise QueryError(f"bad token at: {sql[pos:pos + 10]!r}")
        pos = match.end()
        for kind in ("str", "num", "ident", "op", "punct"):
            value = match.group(kind)
            if value is not None:
                tokens.append((kind, value))
                break
    return tokens


class _Tokens:
    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0

    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else (None, None)

    def next(self):
        token = self.peek()
        if token[0] is None:
            raise QueryError("unexpected end of statement")
        self.pos += 1
        return token

    def keyword(self):
        """The upper-cased value when the next token is an identifier."""
        kind, value = self.peek()
        return value.upper() if kind == "ident" else None

    def expect_keyword(self, word):
        kind, value = self.next()
        if kind != "ident" or value.upper() != word:
            raise QueryError(f"expected {word}")

    def accept_keyword(self, word):
        if self.keyword() == word:
            self.next()
            return True
        return False

    def expect_punct(self, char):
        kind, value = self.next()
        if kind != "punct" or value != char:
            raise QueryError(f"expected {char!r}")

    def identifier(self):
        kind, value = self.next()
        if kind != "ident":
            raise QueryError("expected an identifier")
        return value

    def done(self):
        if self.peek()[0] is not None:
            raise QueryError("unexpected trailing input")


def _literal(token):
    """Token -> (python value, type tag). Type tag: 'INT', 'TEXT', or None."""
    kind, value = token
    if kind == "num":
        return int(value), "INT"
    if kind == "str":
        return value[1:-1].replace("''", "'"), "TEXT"
    if kind == "ident" and value.upper() == "NULL":
        return None, None
    raise QueryError("expected a literal")


# Conditions are tuples:
#   ("or", a, b) ("and", a, b) ("cmp", op, left, right)
# Operands: ("col", name) ("lit", value, type_tag)


def _parse_condition(tokens):
    node = _parse_and(tokens)
    while tokens.accept_keyword("OR"):
        node = ("or", node, _parse_and(tokens))
    return node


def _parse_and(tokens):
    node = _parse_atom(tokens)
    while tokens.accept_keyword("AND"):
        node = ("and", node, _parse_atom(tokens))
    return node


def _parse_atom(tokens):
    if tokens.peek() == ("punct", "("):
        tokens.next()
        node = _parse_condition(tokens)
        tokens.expect_punct(")")
        return node
    left = _parse_operand(tokens)
    kind, value = tokens.next()
    if kind != "op":
        raise QueryError("expected a comparison operator")
    right = _parse_operand(tokens)
    return ("cmp", value, left, right)


def _parse_operand(tokens):
    kind, value = tokens.peek()
    if kind == "ident" and value.upper() != "NULL":
        tokens.next()
        return ("col", value)
    return ("lit", *_literal(tokens.next()))


_OPS = {
    "=": lambda a, b: a == b,
    "!=": lambda a, b: a != b,
    "<": lambda a, b: a < b,
    "<=": lambda a, b: a <= b,
    ">": lambda a, b: a > b,
    ">=": lambda a, b: a >= b,
}


class _Table:
    def __init__(self, columns):
        self.columns = columns  # list of (name, type)
        self.rows = []

    def column_type(self, name):
        for column, ctype in self.columns:
            if column == name:
                return ctype
        raise QueryError(f"unknown column: {name}")

    def index(self, name):
        for i, (column, _) in enumerate(self.columns):
            if column == name:
                return i
        raise QueryError(f"unknown column: {name}")


def _check_condition_types(node, table):
    kind = node[0]
    if kind in ("or", "and"):
        _check_condition_types(node[1], table)
        _check_condition_types(node[2], table)
        return
    _, _, left, right = node
    types = []
    for operand in (left, right):
        if operand[0] == "col":
            types.append(table.column_type(operand[1]))
        else:
            types.append(operand[2])
    if types[0] is not None and types[1] is not None and types[0] != types[1]:
        raise QueryError("type mismatch in comparison")


def _eval_condition(node, table, row):
    kind = node[0]
    if kind == "or":
        return _eval_condition(node[1], table, row) or _eval_condition(node[2], table, row)
    if kind == "and":
        return _eval_condition(node[1], table, row) and _eval_condition(node[2], table, row)
    _, op, left, right = node
    values = []
    for operand in (left, right):
        if operand[0] == "col":
            values.append(row[table.index(operand[1])])
        else:
            values.append(operand[1])
    if values[0] is None or values[1] is None:
        return False
    return _OPS[op](values[0], values[1])


def _check_value(value, vtype, ctype):
    if value is None:
        return
    if vtype != ctype:
        raise QueryError(f"value does not fit a {ctype} column")


class Database:
    def __init__(self, directory=None):
        self._dir = Path(directory) if directory is not None else None
        self._tables = {}
        self._txn_backup = None
        if self._dir is not None:
            self._load()

    # ------------------------------------------------------ persistence

    def _load(self):
        path = self._dir / _DB_FILE
        if not path.exists():
            return
        data = json.loads(path.read_text())
        for name, table in data.items():
            restored = _Table([tuple(column) for column in table["columns"]])
            restored.rows = [list(row) for row in table["rows"]]
            self._tables[name] = restored

    def _persist(self):
        if self._dir is None or self._txn_backup is not None:
            return
        data = {
            name: {"columns": table.columns, "rows": table.rows}
            for name, table in self._tables.items()
        }
        tmp_path = self._dir / (_DB_FILE + ".tmp")
        with open(tmp_path, "w") as tmp:
            json.dump(data, tmp)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_path, self._dir / _DB_FILE)

    # ------------------------------------------------------ statements

    def execute(self, sql):
        if not isinstance(sql, str):
            raise QueryError("sql must be a string")
        tokens = _tokenize(sql)
        if tokens and tokens[-1] == ("punct", ";"):
            tokens = tokens[:-1]
        if not tokens:
            raise QueryError("empty statement")
        stream = _Tokens(tokens)
        keyword = stream.keyword()
        handlers = {
            "CREATE": self._create,
            "INSERT": self._insert,
            "SELECT": self._select,
            "UPDATE": self._update,
            "DELETE": self._delete,
            "BEGIN": self._begin,
            "COMMIT": self._commit,
            "ROLLBACK": self._rollback,
        }
        if keyword not in handlers:
            raise QueryError(f"unknown statement: {keyword}")
        return handlers[keyword](stream)

    def _table(self, name):
        if name not in self._tables:
            raise QueryError(f"unknown table: {name}")
        return self._tables[name]

    def _create(self, stream):
        stream.expect_keyword("CREATE")
        stream.expect_keyword("TABLE")
        name = stream.identifier()
        if name in self._tables:
            raise QueryError(f"table exists: {name}")
        stream.expect_punct("(")
        columns = []
        while True:
            column = stream.identifier()
            ctype_token = stream.identifier().upper()
            if ctype_token not in ("INT", "TEXT"):
                raise QueryError(f"unknown type: {ctype_token}")
            if any(column == existing for existing, _ in columns):
                raise QueryError(f"duplicate column: {column}")
            columns.append((column, ctype_token))
            kind, value = stream.next()
            if (kind, value) == ("punct", ")"):
                break
            if (kind, value) != ("punct", ","):
                raise QueryError("expected ',' or ')'")
        stream.done()
        self._tables[name] = _Table(columns)
        self._persist()
        return None

    def _insert(self, stream):
        stream.expect_keyword("INSERT")
        stream.expect_keyword("INTO")
        table = self._table(stream.identifier())
        stream.expect_keyword("VALUES")
        stream.expect_punct("(")
        values = []
        while True:
            values.append(_literal(stream.next()))
            kind, value = stream.next()
            if (kind, value) == ("punct", ")"):
                break
            if (kind, value) != ("punct", ","):
                raise QueryError("expected ',' or ')'")
        stream.done()
        if len(values) != len(table.columns):
            raise QueryError("value count does not match column count")
        for (value, vtype), (_, ctype) in zip(values, table.columns):
            _check_value(value, vtype, ctype)
        table.rows.append([value for value, _ in values])
        self._persist()
        return None

    def _parse_where(self, stream, table):
        if not stream.accept_keyword("WHERE"):
            return None
        condition = _parse_condition(stream)
        _check_condition_types(condition, table)
        return condition

    def _select(self, stream):
        stream.expect_keyword("SELECT")
        star = stream.peek() == ("punct", "*")
        selected = []
        if star:
            stream.next()
        else:
            while True:
                column = stream.identifier()
                if column in selected:
                    raise QueryError(f"duplicate column in select list: {column}")
                selected.append(column)
                if stream.peek() == ("punct", ","):
                    stream.next()
                else:
                    break
        stream.expect_keyword("FROM")
        table = self._table(stream.identifier())
        if star:
            selected = [column for column, _ in table.columns]
        else:
            for column in selected:
                table.column_type(column)
        condition = self._parse_where(stream, table)
        order_column = None
        descending = False
        if stream.accept_keyword("ORDER"):
            stream.expect_keyword("BY")
            order_column = stream.identifier()
            table.column_type(order_column)
            if stream.accept_keyword("DESC"):
                descending = True
            else:
                stream.accept_keyword("ASC")
        limit = None
        if stream.accept_keyword("LIMIT"):
            kind, value = stream.next()
            if kind != "num":
                raise QueryError("LIMIT needs an integer literal")
            limit = int(value)
            if limit < 0:
                raise QueryError("LIMIT must be zero or positive")
        stream.done()
        rows = [
            row
            for row in table.rows
            if condition is None or _eval_condition(condition, table, row)
        ]
        if order_column is not None:
            key_index = table.index(order_column)
            null_rows = [row for row in rows if row[key_index] is None]
            value_rows = [row for row in rows if row[key_index] is not None]
            value_rows.sort(key=lambda row: row[key_index], reverse=descending)
            rows = value_rows + null_rows if descending else null_rows + value_rows
        if limit is not None:
            rows = rows[:limit]
        indexes = [table.index(column) for column in selected]
        return [
            {column: row[i] for column, i in zip(selected, indexes)} for row in rows
        ]

    def _update(self, stream):
        stream.expect_keyword("UPDATE")
        table = self._table(stream.identifier())
        stream.expect_keyword("SET")
        assignments = []
        while True:
            column = stream.identifier()
            ctype = table.column_type(column)
            kind, value = stream.next()
            if (kind, value) != ("op", "="):
                raise QueryError("expected '=' in SET")
            literal, vtype = _literal(stream.next())
            _check_value(literal, vtype, ctype)
            assignments.append((table.index(column), literal))
            if stream.peek() == ("punct", ","):
                stream.next()
            else:
                break
        condition = self._parse_where(stream, table)
        stream.done()
        count = 0
        for row in table.rows:
            if condition is None or _eval_condition(condition, table, row):
                for index, literal in assignments:
                    row[index] = literal
                count += 1
        self._persist()
        return count

    def _delete(self, stream):
        stream.expect_keyword("DELETE")
        stream.expect_keyword("FROM")
        table = self._table(stream.identifier())
        condition = self._parse_where(stream, table)
        stream.done()
        keep = [
            row
            for row in table.rows
            if condition is not None and not _eval_condition(condition, table, row)
        ]
        if condition is None:
            keep = []
        count = len(table.rows) - len(keep)
        table.rows = keep
        self._persist()
        return count

    # ------------------------------------------------------ transactions

    def _begin(self, stream):
        stream.expect_keyword("BEGIN")
        stream.done()
        if self._txn_backup is not None:
            raise QueryError("a transaction is already open")
        self._txn_backup = copy.deepcopy(self._tables)
        return None

    def _commit(self, stream):
        stream.expect_keyword("COMMIT")
        stream.done()
        if self._txn_backup is None:
            raise QueryError("no open transaction")
        self._txn_backup = None
        self._persist()
        return None

    def _rollback(self, stream):
        stream.expect_keyword("ROLLBACK")
        stream.done()
        if self._txn_backup is None:
            raise QueryError("no open transaction")
        self._tables = self._txn_backup
        self._txn_backup = None
        return None
