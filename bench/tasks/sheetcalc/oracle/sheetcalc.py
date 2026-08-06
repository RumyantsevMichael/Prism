"""Reference solution for the sheetcalc task. Never shown to the agent."""
import re

ERROR = "#ERROR!"
DIV0 = "#DIV/0!"
CYCLE = "#CYCLE!"

_ADDRESS = re.compile(r"([A-Za-z]+)([1-9][0-9]*)")
_NUMBER = re.compile(r"[0-9]*\.?[0-9]+")
_NAME = re.compile(r"[A-Za-z]+[0-9]*")


class _EvalError(Exception):
    def __init__(self, marker):
        super().__init__(marker)
        self.marker = marker


def _normalize(address):
    if not isinstance(address, str) or not _ADDRESS.fullmatch(address):
        raise ValueError(f"invalid address: {address!r}")
    return address.upper()


def _col_number(letters):
    value = 0
    for ch in letters:
        value = value * 26 + (ord(ch) - ord("A") + 1)
    return value


def _col_letters(number):
    letters = ""
    while number:
        number, rem = divmod(number - 1, 26)
        letters = chr(ord("A") + rem) + letters
    return letters


class _Tokenizer:
    def __init__(self, text):
        self.text = text
        self.pos = 0

    def peek(self):
        while self.pos < len(self.text) and self.text[self.pos].isspace():
            self.pos += 1
        if self.pos >= len(self.text):
            return None
        return self.text[self.pos]

    def take_name(self):
        match = _NAME.match(self.text, self.pos)
        if not match:
            raise _EvalError(ERROR)
        self.pos = match.end()
        return match.group()

    def take_number(self):
        match = _NUMBER.match(self.text, self.pos)
        if not match:
            raise _EvalError(ERROR)
        self.pos = match.end()
        return float(match.group())

    def expect(self, ch):
        if self.peek() != ch:
            raise _EvalError(ERROR)
        self.pos += 1


# Expression AST nodes are tuples:
#   ("num", value) ("ref", addr) ("bin", op, left, right) ("neg", node)
#   ("func", name, range_cells)


class _Parser:
    def __init__(self, text):
        self.tok = _Tokenizer(text)

    def parse(self):
        node = self.expr()
        if self.tok.peek() is not None:
            raise _EvalError(ERROR)
        return node

    def expr(self):
        node = self.term()
        while self.tok.peek() in ("+", "-"):
            op = self.tok.peek()
            self.tok.pos += 1
            node = ("bin", op, node, self.term())
        return node

    def term(self):
        node = self.factor()
        while self.tok.peek() in ("*", "/"):
            op = self.tok.peek()
            self.tok.pos += 1
            node = ("bin", op, node, self.factor())
        return node

    def factor(self):
        if self.tok.peek() == "-":
            self.tok.pos += 1
            return ("neg", self.factor())
        return self.primary()

    def primary(self):
        ch = self.tok.peek()
        if ch is None:
            raise _EvalError(ERROR)
        if ch == "(":
            self.tok.pos += 1
            node = self.expr()
            self.tok.expect(")")
            return node
        if ch.isdigit() or ch == ".":
            return ("num", self.tok.take_number())
        if ch.isalpha():
            name = self.tok.take_name()
            if self.tok.peek() == "(":
                self.tok.pos += 1
                cells = self.range_cells()
                self.tok.expect(")")
                if name.upper() not in ("SUM", "MIN", "MAX"):
                    raise _EvalError(ERROR)
                return ("func", name.upper(), cells)
            if self.tok.peek() == ":":
                raise _EvalError(ERROR)  # a range outside a function
            if not _ADDRESS.fullmatch(name):
                raise _EvalError(ERROR)
            return ("ref", name.upper())
        raise _EvalError(ERROR)

    def range_cells(self):
        first = self.tok.take_name()
        self.tok.expect(":")
        second = self.tok.take_name()
        corners = []
        for name in (first, second):
            match = _ADDRESS.fullmatch(name)
            if not match:
                raise _EvalError(ERROR)
            corners.append((_col_number(match.group(1).upper()), int(match.group(2))))
        (col_a, row_a), (col_b, row_b) = corners
        cells = []
        for col in range(min(col_a, col_b), max(col_a, col_b) + 1):
            for row in range(min(row_a, row_b), max(row_a, row_b) + 1):
                cells.append(f"{_col_letters(col)}{row}")
        return cells


class Spreadsheet:
    def __init__(self):
        self._cells = {}

    def set(self, address, raw):
        address = _normalize(address)
        if not isinstance(raw, str):
            raise ValueError("raw must be a string")
        self._cells[address] = raw

    def raw(self, address):
        return self._cells.get(_normalize(address))

    def delete(self, address):
        self._cells.pop(_normalize(address), None)

    def get(self, address):
        address = _normalize(address)
        try:
            return self._value(address, frozenset())
        except _EvalError as exc:
            return exc.marker

    def _value(self, address, stack):
        raw = self._cells.get(address)
        if raw is None:
            return None
        if raw.startswith("="):
            if address in stack:
                raise _EvalError(CYCLE)
            node = _Parser(raw[1:]).parse()
            return self._eval(node, stack | {address})
        try:
            return float(raw)
        except ValueError:
            return raw

    def _number(self, address, stack):
        value = self._value(address, stack)
        if value is None:
            return 0.0
        if isinstance(value, float):
            return value
        raise _EvalError(ERROR)  # text where arithmetic needs a number

    def _eval(self, node, stack):
        kind = node[0]
        if kind == "num":
            return node[1]
        if kind == "ref":
            return self._number(node[1], stack)
        if kind == "neg":
            return -self._eval(node[1], stack)
        if kind == "bin":
            _, op, left, right = node
            a = self._eval(left, stack)
            b = self._eval(right, stack)
            if op == "+":
                return a + b
            if op == "-":
                return a - b
            if op == "*":
                return a * b
            if b == 0:
                raise _EvalError(DIV0)
            return a / b
        if kind == "func":
            _, name, cells = node
            numbers = []
            for cell in cells:
                value = self._value(cell, stack)
                if isinstance(value, float):
                    numbers.append(value)
            if name == "SUM":
                return sum(numbers, 0.0)
            if not numbers:
                raise _EvalError(ERROR)
            return min(numbers) if name == "MIN" else max(numbers)
        raise _EvalError(ERROR)
