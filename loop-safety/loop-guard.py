#!/usr/bin/env python
"""loop-safety (PreToolUse): native retry circuit-breaker.

Reads the telemetry substrate (`hook_events` in shared.paths.hooksDb) to count how many
times the SAME operation has failed CONSECUTIVELY with the SAME error fingerprint in the
current session, then:
  - softMax <= count < hardMax  -> ALLOW, but inject a "change approach" directive
  - count >= hardMax            -> DENY the tool call (break the loop)

No external state store: the hook_events log IS the state (reset-on-success falls out of
the walk-until-first-success scan).

Output is the cross-runtime PreToolUse JSON contract (verified against both vendor docs):
  HARD: {"hookSpecificOutput": {"hookEventName": "PreToolUse",
         "permissionDecision": "deny", "permissionDecisionReason": <text>}}
  SOFT: {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": <text>},
         "systemMessage": <text>}
Claude reads permissionDecision + additionalContext; Codex reads permissionDecision +
systemMessage. Plain stdout/stderr is ignored by Codex, so the decision rides in JSON.
The hook always exits 0 (fail-open); the decision is carried by the JSON, never the code.
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from hook_runtime import connect, extract_target, hooks_db, run, safe_table  # noqa: E402

# Wrapper tokens that prefix a real command; skipped (with their flags/args) when finding
# the base command. cd/pushd/popd only change directory -> their whole segment is skipped.
_BASH_SKIP = frozenset({
    "sudo", "doas", "env", "nice", "time", "nohup", "timeout", "stdbuf",
    "command", "exec", "builtin", "cd", "pushd", "popd",
})
_DIR_ONLY = frozenset({"cd", "pushd", "popd"})

# Tools grouped at the subcommand level (base:sub) so e.g. `git commit` and `git push`
# are distinct operations rather than sharing one counter.
_SUBCOMMAND_TOOLS = {
    "terraform": 1, "tofu": 1, "pulumi": 1, "kubectl": 1, "k": 1, "helm": 1,
    "kustomize": 1, "argocd": 2, "flux": 1, "aws": 2, "gcloud": 1, "az": 1,
    "docker": 1, "podman": 1, "docker-compose": 1,
    "git": 1, "npm": 1, "pnpm": 1, "yarn": 1, "pip": 1, "cargo": 1, "go": 1,
}

# Cross-runtime edit family: Claude reports Edit/Write/MultiEdit/NotebookEdit; Codex reports
# apply_patch. All unify to edit:<file> so the breaker counts edits to ONE file together and
# across runtimes, and keeps edits to DIFFERENT files separate.
_EDIT_FAMILY = frozenset({"edit", "write", "multiedit", "notebookedit", "apply_patch"})

# Split a Bash command into segments on shell separators (&& || ; | and newlines).
_SEG_RE = re.compile(r"\s*(?:&&|\|\||;|\||\n)\s*")
# Strip variable content so similar errors across retries fingerprint identically.
# \d+ (not \b\d+\b) so digits glued to units collapse too: "30000ms" and "45000ms" match.
_STRIP_RE = re.compile(
    r"0x[0-9a-fA-F]+|\b\d{4}-\d{2}-\d{2}|\b\d{2}:\d{2}:\d{2}|/[\w./\\-]+|\d+"
)


def _unwrap(token):
    return token.strip().strip("\"'`(){}").strip()


def _segment_base(seg):
    """Return (base_command, index_in_tokens, tokens) for the real command in a segment,
    or None if the segment is only a directory change / has no command."""
    toks = seg.split()
    i = 0
    while i < len(toks):
        t = _unwrap(toks[i])
        if not t:
            i += 1
            continue
        if "=" in t and not t.startswith("-"):  # leading VAR=val env assignment
            i += 1
            continue
        base = t.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        if base in _BASH_SKIP:
            if base in _DIR_ONLY:
                return None  # `cd X` (and the rest is just the dir) -> try next segment
            i += 1
            # skip the wrapper's flags and their values until the real command token
            while i < len(toks):
                t2 = _unwrap(toks[i])
                if t2.startswith("-") or t2.isdigit() or ("=" in t2 and not t2.startswith("-")):
                    i += 1
                    continue
                break
            continue
        return base, i, toks
    return None


def operation_key(tool_name, command_or_target):
    """Fingerprint the operation. Bash -> base command (+ subcommand for grouped tools),
    resilient to separators, wrappers (sudo/env/nice/cd &&), quotes and parens. Edit family
    -> edit:<file>. Any other tool -> tool:<target>."""
    if tool_name == "Bash":
        for seg in (s for s in _SEG_RE.split((command_or_target or "").strip()) if s.strip()):
            found = _segment_base(seg)
            if not found:
                continue
            base, idx, toks = found
            depth = _SUBCOMMAND_TOOLS.get(base, 0)
            if depth > 0:
                subs = []
                for tok in toks[idx + 1:]:
                    tok = _unwrap(tok)
                    if not tok:
                        continue
                    if tok.startswith("-") or "=" in tok:
                        break
                    subs.append(tok)
                    if len(subs) >= depth:
                        break
                if subs:
                    return f"bash:{base}:{':'.join(subs)}"
            return f"bash:{base}"
        return "bash:unknown"

    tn = (tool_name or "").lower()
    target = (command_or_target or "").strip()
    if tn in _EDIT_FAMILY:
        return f"edit:{target}" if target else "edit"
    return f"{tn}:{target}" if target else tn


def error_key(text):
    normalized = _STRIP_RE.sub("", (text or "").lower()).strip()
    return re.sub(r"\s+", " ", normalized)[:80]


def consecutive_failures(con, table, session_id, op_key, lookback):
    """Walk this session's events newest-first; for rows matching op_key, count the trailing
    run of same-error failures. A success (or a different error fingerprint) breaks the run."""
    rows = con.execute(
        f"SELECT tool_name, target, status, detail FROM {table} "
        "WHERE session_id=? ORDER BY ts DESC, id DESC LIMIT ?",
        (session_id, int(lookback)),
    ).fetchall()
    count, chain_key = 0, None
    for tool_name, target, status, detail in rows:
        if operation_key(tool_name, target) != op_key:
            continue  # different operation: irrelevant to this counter
        if status != "error":
            break  # most-recent same-op event succeeded -> chain broken
        ek = error_key(detail)
        if chain_key is None:
            chain_key, count = ek, 1
        elif ek == chain_key:
            count += 1
        else:
            break  # different error fingerprint -> chain broken
    return count, chain_key


def _emit_hard(op_key, count):
    reason = (
        f"loop-safety: '{op_key}' has failed {count}x consecutively with the same error. "
        f"STOP retrying the same operation — an identical approach yields an identical failure. "
        f"Read the actual error, investigate the root cause (docs / source / web search), and "
        f"choose a DIFFERENT approach before re-running this operation."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))


def _emit_soft(op_key, count, hard_max):
    msg = (
        f"loop-safety: '{op_key}' has failed {count}x consecutively (hard block at {hard_max}). "
        f"Same approach = same failure. Investigate the root cause and change approach rather "
        f"than retrying the same operation."
    )
    print(json.dumps({
        "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": msg},
        "systemMessage": msg,
    }))


def _load_policy(settings):
    """Let config.json override the fingerprint policy data (defaults = the module
    constants). Reassigned per-invocation; each hook run is a fresh process."""
    global _SUBCOMMAND_TOOLS, _BASH_SKIP, _EDIT_FAMILY
    sc = settings.get("subcommandTools")
    if isinstance(sc, dict) and sc:
        _SUBCOMMAND_TOOLS = {str(k): int(v) for k, v in sc.items()}
    sk = settings.get("bashSkipTokens")
    if isinstance(sk, list) and sk:
        _BASH_SKIP = frozenset(str(x) for x in sk) | _DIR_ONLY
    ef = settings.get("editFamily")
    if isinstance(ef, list) and ef:
        _EDIT_FAMILY = frozenset(str(x).lower() for x in ef)


def handler(payload, config, hcfg):
    session_id = payload.get("session_id", "")
    tool_name = payload.get("tool_name", "")
    if not session_id or not tool_name:
        return  # not enough context -> allow silently

    settings = hcfg.get("settings", {})
    _load_policy(settings)
    soft_max = int(settings.get("softMax", 3))
    hard_max = int(settings.get("hardMax", 5))
    lookback = int(settings.get("lookback", 60))
    table = safe_table(settings.get("table", "hook_events"), "hook_events")
    if hard_max < 1 or soft_max < 1:
        return  # degenerate config -> do nothing rather than block spuriously

    op_key = operation_key(tool_name, extract_target(tool_name, payload.get("tool_input", {})))

    con = connect(hooks_db(config))
    try:
        count, _ = consecutive_failures(con, table, session_id, op_key, lookback)
    finally:
        con.close()

    if count >= hard_max:
        _emit_hard(op_key, count)
    elif count >= soft_max:
        _emit_soft(op_key, count, hard_max)
    # else: allow silently
    return  # decision (if any) is in the printed JSON; always exit 0 (fail-open)


if __name__ == "__main__":
    run("loop-safety", handler)
