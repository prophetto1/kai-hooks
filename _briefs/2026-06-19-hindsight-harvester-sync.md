# Hindsight harvester sync on stop hook

**Date:** 2026-06-19
**Goal:** After memory-harvester writes new SQLite rows, automatically sync_retain the same facts to Hindsight with sqlite-memory document ids.
**Inherits from:** none

## Files Touched

- `memory-harvester/harvest_hindsight.py` — MCP sync_retain client + document_id/metadata builder
- `memory-harvester/harvest_core.py` — call hindsight sync after SQLite store
- `memory-harvester/harvest-stop.py` — system message includes hindsight sync count
- `memory-harvester/test-harvest-hindsight-readonly.py` — unit tests for arg building (no network)
- `config.json` — enable hindsight block under memory-harvester settings
- `_core/config-model.mjs` — validate optional hindsight settings
- `changelog-hooks.md` — entry

## Acceptance

1. Stop harvester syncs newly stored rows to Hindsight via sync_retain when enabled
2. document_id uses sqlite-memory:{content_hash}; metadata carries sqlite_content_hash
3. Hindsight failures fail-open; SQLite harvest still succeeds
4. Readonly tests pass without network
