"""Reference solution for the kvstore task. Never shown to the agent."""
import os
from pathlib import Path

_LOG_NAME = "data.log"


def _escape(text):
    return text.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n")


def _unescape(text):
    out = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            nxt = text[i + 1]
            if nxt == "\\":
                out.append("\\")
            elif nxt == "t":
                out.append("\t")
            elif nxt == "n":
                out.append("\n")
            else:
                raise ValueError("bad escape")
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


class KVStore:
    def __init__(self, directory):
        self._dir = Path(directory)
        self._path = self._dir / _LOG_NAME
        self._data = {}
        self._closed = False
        valid_bytes = self._recover()
        # Drop the torn tail so later appends start at a record boundary.
        if self._path.exists() and valid_bytes < self._path.stat().st_size:
            with open(self._path, "r+b") as fh:
                fh.truncate(valid_bytes)
        self._fh = open(self._path, "ab")

    def _recover(self):
        if not self._path.exists():
            return 0
        raw = self._path.read_bytes()
        offset = 0
        for line in raw.split(b"\n")[:-1]:
            try:
                record = line.decode("utf-8")
            except UnicodeDecodeError:
                break
            parts = record.split("\t")
            try:
                if len(parts) == 3 and parts[0] == "S":
                    self._data[_unescape(parts[1])] = _unescape(parts[2])
                elif len(parts) == 2 and parts[0] == "D":
                    self._data.pop(_unescape(parts[1]), None)
                else:
                    break
            except ValueError:
                break
            offset += len(line) + 1
        return offset

    def _check_open(self):
        if self._closed:
            raise ValueError("store is closed")

    def _append(self, record):
        self._fh.write(record.encode("utf-8"))
        self._fh.flush()
        os.fsync(self._fh.fileno())

    @staticmethod
    def _check_key(key):
        if not isinstance(key, str) or not key or "\n" in key:
            raise ValueError("key must be a non-empty string without newlines")

    def set(self, key, value):
        self._check_open()
        self._check_key(key)
        if not isinstance(value, str):
            raise ValueError("value must be a string")
        self._append(f"S\t{_escape(key)}\t{_escape(value)}\n")
        self._data[key] = value

    def get(self, key):
        self._check_open()
        self._check_key(key)
        return self._data.get(key)

    def delete(self, key):
        self._check_open()
        self._check_key(key)
        if key not in self._data:
            return False
        self._append(f"D\t{_escape(key)}\n")
        del self._data[key]
        return True

    def keys(self):
        self._check_open()
        return sorted(self._data)

    def compact(self):
        self._check_open()
        self._fh.close()
        tmp_path = self._dir / (_LOG_NAME + ".tmp")
        with open(tmp_path, "wb") as tmp:
            for key in sorted(self._data):
                record = f"S\t{_escape(key)}\t{_escape(self._data[key])}\n"
                tmp.write(record.encode("utf-8"))
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_path, self._path)
        self._fh = open(self._path, "ab")

    def close(self):
        if self._closed:
            return
        self._fh.close()
        self._closed = True
