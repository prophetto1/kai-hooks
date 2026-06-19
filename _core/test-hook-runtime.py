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


def test_resolve_match_tools_expands_memory_mutation_group() -> None:
    config = {"shared": {}}
    hcfg = {"match": {"toolGroup": "memoryMutation"}}
    tools = hook_runtime.resolve_match_tools(hcfg, config)
    assert_true("memory_store" in tools, "bare memory_store should match")
    assert_true("mcp__mcp-router__memory_update" in tools, "MCP-prefixed memory_update should match")
    assert_true(len(tools) == 50, f"memoryMutation should expand to 50 tools, got {len(tools)}")


def test_matches_tool_honors_tool_group() -> None:
    config = {"shared": {}}
    hcfg = {"match": {"toolGroup": "memoryMutation"}}
    assert_true(
        hook_runtime.matches_tool(hcfg, "mcp__memory_sqlite__memory_store", config),
        "toolGroup match should allow configured MCP memory tools",
    )
    assert_true(
        not hook_runtime.matches_tool(hcfg, "Bash", config),
        "toolGroup match should exclude unrelated tools",
    )


def main() -> int:
    test_connect_readonly_reads_existing_db()
    test_connect_readonly_does_not_create_missing_db()
    test_resolve_match_tools_expands_memory_mutation_group()
    test_matches_tool_honors_tool_group()
    print("hook runtime tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
