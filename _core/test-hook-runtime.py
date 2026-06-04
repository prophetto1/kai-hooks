#!/usr/bin/env python
from __future__ import annotations

import os
import sqlite3
import tempfile

import hook_runtime


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def test_connect_readonly_reads_existing_db() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "runtime.db")
        writable = hook_runtime.connect(db_path)
        try:
            writable.execute("CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT)")
            writable.execute("INSERT INTO sample(value) VALUES(?)", ("ok",))
            writable.commit()
        finally:
            writable.close()

        readonly = hook_runtime.connect_readonly(db_path)
        try:
            value = readonly.execute("SELECT value FROM sample WHERE id = 1").fetchone()[0]
            assert_true(value == "ok", "read-only connection should read existing rows")
            try:
                readonly.execute("INSERT INTO sample(value) VALUES('write')")
            except sqlite3.OperationalError as exc:
                assert_true("readonly" in str(exc).lower(), f"unexpected write error: {exc}")
            else:
                raise AssertionError("read-only connection accepted a write")
        finally:
            readonly.close()


def test_connect_readonly_does_not_create_missing_db() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        missing_path = os.path.join(tmp, "missing", "runtime.db")
        try:
            hook_runtime.connect_readonly(missing_path)
        except sqlite3.OperationalError:
            pass
        else:
            raise AssertionError("read-only connection created or opened a missing database")
        assert_true(not os.path.exists(missing_path), "missing database should not be created")


def main() -> int:
    test_connect_readonly_reads_existing_db()
    test_connect_readonly_does_not_create_missing_db()
    print("hook runtime tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
