#!/usr/bin/env python
"""browser-verify-gate (Stop): require an in-browser Playwright verification before
completing a LARGE turn.

A Stop hook cannot run Playwright itself, so it gates. On Stop it reads the hook_events
telemetry substrate (shared.paths.hooksDb) to:
  - count this turn's tool firings (rows since the last gate pass for this session), and
  - detect whether a Playwright browser navigate (+ snapshot/screenshot) happened this turn.

If the turn is large (> minToolUses tool calls), browser-relevant, and no in-browser
verification was seen, it BLOCKS completion with a directive (Stop `decision:block`), so
the agent must open the browser and verify. Long read-only research, handoff, and docs
turns are allowed because they have no affected route to verify. Once telemetry shows the
browser calls, the gate releases. Loop-safe:
after maxRepeatedBlocks consecutive blocks it releases with a manual-verify message so it
can never trap the agent. Fail-open: any error allows completion.

Depends on broad PostToolUse telemetry (hook-telemetry) being enabled + firing, the same
substrate loop-safety/thinking-gate read. Honors enabled/failPolicy via _core/hook_runtime.py.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_core"))
from hook_runtime import connect_readonly, hooks_db, run, safe_table  # noqa: E402

HOOK_ID = "browser-verify-gate"
DEFAULT_TELEMETRY_HOOK_ID = "hook-telemetry"
DEFAULT_NAVIGATE = ["browser_navigate", "navigate_page"]
DEFAULT_INSPECT = ["browser_snapshot", "take_snapshot", "browser_take_screenshot", "take_screenshot"]
DEFAULT_RELEVANT_TOOLS = []
DEFAULT_RELEVANT_TARGETS = [
    "apps/web/",
    "npm run dev",
    "npm run build",
    "npm run test",
    "pnpm run dev",
    "pnpm run build",
    "pnpm run test",
    "yarn dev",
    "yarn build",
    "yarn test",
    "bun run dev",
    "bun run build",
    "bun run test",
    "next dev",
    "next build",
    "vite",
    "playwright",
    "ui-snapshot",
]


def _table_exists(con, table: str) -> bool:
    return con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone() is not None


def _resolve_state_dir(config: dict, settings: dict) -> str:
    raw = settings.get("stateDir") or ".state/browser-verify-gate"
    path = Path(raw)
    if path.is_absolute():
        return str(path)
    hooks_dir = config.get("shared", {}).get("paths", {}).get("hooksDir", "E:/hooks")
    return str(Path(hooks_dir) / raw)


def _state_path(state_dir: str, session_id: str) -> Path:
    safe = hashlib.sha256((session_id or "").encode("utf-8")).hexdigest()[:16]
    return Path(state_dir) / f"{safe}.json"


def _read_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_state(path: Path, value: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")
    except Exception:
        pass  # state-write failure must never break the gate


def _matches_any(tool_name: str, patterns) -> bool:
    lowered = (tool_name or "").lower()
    return any(pattern and str(pattern).lower() in lowered for pattern in patterns)


def _relevance_target(tool_name: str, target: str) -> str:
    if "apply_patch" not in (tool_name or "").lower():
        return target or ""
    prefixes = ("*** Update File:", "*** Add File:", "*** Delete File:")
    return "\n".join(line for line in (target or "").splitlines() if line.startswith(prefixes))


def _row_matches(tool_name: str, target: str, tool_patterns, target_patterns) -> bool:
    return _matches_any(tool_name, tool_patterns) or _matches_any(
        _relevance_target(tool_name, target),
        target_patterns,
    )


def handler(payload, config, hcfg):
    settings = hcfg.get("settings", {})
    session_id = payload.get("session_id", "")
    min_tool_uses = int(settings.get("minToolUses", 15))
    max_repeated = int(settings.get("maxRepeatedBlocks", 2))
    require_snapshot = settings.get("requireSnapshot", True) is not False
    navigate_patterns = settings.get("navigatePatterns") or DEFAULT_NAVIGATE
    inspect_patterns = settings.get("inspectPatterns") or DEFAULT_INSPECT
    relevant_tool_patterns = settings.get("relevantToolPatterns", DEFAULT_RELEVANT_TOOLS)
    relevant_target_patterns = settings.get("relevantTargetPatterns") or DEFAULT_RELEVANT_TARGETS
    table = safe_table(settings.get("table", "hook_events"), "hook_events")
    telemetry_hook_id = settings.get("telemetryHookId", DEFAULT_TELEMETRY_HOOK_ID)

    state_file = _state_path(_resolve_state_dir(config, settings), session_id)
    state = _read_state(state_file)
    last_stop_id = int(state.get("lastStopId", 0) or 0)
    block_count = int(state.get("blockCount", 0) or 0)

    db_path = hooks_db(config)
    if not os.path.exists(db_path):
        return  # no telemetry yet -> nothing to gate, allow silently

    con = connect_readonly(db_path)
    try:
        if not _table_exists(con, table):
            return  # telemetry table not created yet -> allow
        max_row = con.execute(f"SELECT MAX(id) FROM {table} WHERE session_id=?", (session_id,)).fetchone()
        current_max_id = int(max_row[0]) if max_row and max_row[0] is not None else 0
        rows = con.execute(
            f"SELECT tool_name, target FROM {table} WHERE session_id=? AND id>? AND hook_id=?",
            (session_id, last_stop_id, telemetry_hook_id),
        ).fetchall()
    finally:
        con.close()

    tool_uses = len(rows)
    navigated = any(_matches_any(row[0], navigate_patterns) for row in rows)
    inspected = any(_matches_any(row[0], inspect_patterns) for row in rows)
    browser_relevant = any(
        _row_matches(row[0], row[1], relevant_tool_patterns, relevant_target_patterns)
        for row in rows
    )
    browser_verified = navigated and (inspected or not require_snapshot)

    # PASS: small turn, read-only/non-rendering turn, or already verified in-browser.
    if tool_uses <= min_tool_uses or not browser_relevant or browser_verified:
        _write_state(state_file, {"lastStopId": current_max_id, "blockCount": 0})
        return

    # RELEASE valve: after maxRepeatedBlocks consecutive blocks, stop blocking so the
    # agent is never trapped. Advance the watermark and reset.
    if block_count >= max_repeated:
        _write_state(state_file, {"lastStopId": current_max_id, "blockCount": 0})
        print(json.dumps({
            "continue": True,
            "systemMessage": (
                f"browser-verify-gate: in-browser verification still not detected after "
                f"{block_count} block(s) — allowing completion. Verify the rendered page manually."
            ),
        }))
        return

    # BLOCK: large, unverified turn. Keep the watermark so the continuation's tool calls
    # (including the Playwright verification) accumulate into the same window next Stop.
    _write_state(state_file, {"lastStopId": last_stop_id, "blockCount": block_count + 1})
    reason = (
        f"browser-verify-gate: this browser-relevant turn made {tool_uses} tool calls (> {min_tool_uses}) "
        f"but no in-browser verification was detected. Before completing, use the Playwright MCP browser "
        f"to open the affected route(s), check the console for errors, and capture a snapshot/screenshot. "
        f"A passing build or HTTP 200 is not proof of render."
    )
    print(json.dumps({"decision": "block", "reason": reason}))


if __name__ == "__main__":
    run(HOOK_ID, handler)
