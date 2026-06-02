#!/usr/bin/env python
# Memory tag normalizer — enforces the locked project-tag taxonomy on the memory-vector store.
# Rules (deterministic, safe — only touches the `tags` metadata column; FTS/vector key off `content`):
#   1. legacy `global` -> `all`            (the global scheme is retired)
#   2. any cross-project entry (`all`) embeds every active rebuild slug: blockdata, kai-chattr, kai
#   3. single-project / legacy (chattr, writing-system) entries are left untouched
#   4. entries with NO project tag are REPORTED, not guessed (write-time tagging is the real fix)
# Usage:  python normalize-memory-tags.py                 (dry-run, shows diff)
#         python normalize-memory-tags.py --summary-only  (dry-run, grouped summary)
#         python normalize-memory-tags.py --hash <prefix> (inspect one memory)
#         python normalize-memory-tags.py --apply         (writes changes)
from collections import Counter
import sqlite3, sys, time

DB = "E:/memory/memory-sqlite.db"
ACTIVE = ["blockdata", "kai-chattr", "kai"]                       # all-embed set
PROJECT = {"blockdata", "kai-chattr", "kai", "chattr", "writing-system", "all"}
apply = "--apply" in sys.argv
summary_only = "--summary-only" in sys.argv

def arg_after(flag):
    if flag not in sys.argv:
        return None
    i = sys.argv.index(flag)
    return sys.argv[i + 1] if i + 1 < len(sys.argv) else None

c = sqlite3.connect(DB)
hash_prefix = arg_after("--hash")
if hash_prefix:
    rows = c.execute("SELECT content_hash, tags, content FROM memories "
                     "WHERE content_hash LIKE ? ORDER BY updated_at DESC LIMIT 10",
                     (hash_prefix + "%",)).fetchall()
    if not rows:
        print(f"No memory matched hash prefix: {hash_prefix}")
    for h, tags, content in rows:
        snippet = (content or "").replace("\n", " ").strip()
        if len(snippet) > 500:
            snippet = snippet[:500].rsplit(" ", 1)[0] + " ..."
        print(f"{h}\n  tags: {tags}\n  content: {snippet}\n")
    sys.exit(0)

rows = c.execute("SELECT content_hash, tags FROM memories "
                 "WHERE deleted_at IS NULL AND (superseded_by IS NULL OR superseded_by='')").fetchall()

changes, noproj = [], []
for h, tags in rows:
    parts = [x.strip() for x in (tags or "").split(",") if x.strip()]
    cur = set(parts)
    cross = ("global" in cur) or ("all" in cur)
    new = set(parts)
    if "global" in new:
        new.discard("global"); cross = True
    if cross:
        new.add("all"); new.update(ACTIVE)
    if not (new & PROJECT):
        noproj.append((h, tags))
    if new != cur:
        nonproj = [x for x in parts if x not in PROJECT and x != "global"]
        projt = sorted(x for x in new if x in PROJECT)
        new_tags = ",".join(nonproj + projt)
        changes.append((h, tags, new_tags))

if not summary_only:
    for h, old, new in changes:
        print(f"{h[:10]}: [{old}] -> [{new}]")
        if apply:
            c.execute("UPDATE memories SET tags=?, updated_at=? WHERE content_hash=?", (new, time.time(), h))
else:
    for h, old, new in changes:
        if apply:
            c.execute("UPDATE memories SET tags=?, updated_at=? WHERE content_hash=?", (new, time.time(), h))
if apply:
    c.commit()

print(f"\n{'APPLIED' if apply else 'DRY-RUN'}: {len(changes)} entries change; {len(noproj)} have NO project tag (reported, not auto-fixed).")
if summary_only:
    print("NO-PROJECT tag groups:")
    for tags, count in Counter(t or "" for _, t in noproj).most_common():
        print(f"  {count:3} [{tags}]")
else:
    print("NO-PROJECT entries (need a project tag - write-time hook is the fix):")
    for h, t in noproj:
        print(f"  {h[:10]} [{t}]")
