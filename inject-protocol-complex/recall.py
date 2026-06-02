#!/usr/bin/env python
import json
import re
import sqlite3
import sys
import time


IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def identifier(value, label):
    if not isinstance(value, str) or not IDENTIFIER_RE.match(value):
        raise ValueError(f"{label} must be a SQL identifier")
    return value


def positive_int(value, label):
    if not isinstance(value, int) or value <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return value


def number(value, label):
    if not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric")
    return float(value)


def positive_number(value, label):
    value = number(value, label)
    if value <= 0:
        raise ValueError(f"{label} must be positive")
    return value


def score(value, label):
    value = number(value, label)
    if value < 0 or value > 100:
        raise ValueError(f"{label} must be 0..100")
    return value


def unit_weight(value, label):
    value = number(value, label)
    if value < 0 or value > 1:
        raise ValueError(f"{label} must be 0..1")
    return value


def truncate(text, limit):
    text = text.replace("\n", " ").strip()
    if len(text) <= limit:
        return text
    trimmed = text[:limit].rsplit(" ", 1)[0] or text[:limit]
    return trimmed + " ..."


def scoring_policy(config):
    scoring = config["scoring"]
    scale = scoring["scoreScale"]
    if scale.get("min") != 0 or scale.get("max") != 100 or scale.get("baseline") != 0:
        raise ValueError("scoreScale must be {min:0,max:100,baseline:0}")
    if scoring.get("missingSignalPolicy") != "drop-candidate":
        raise ValueError("missingSignalPolicy must be drop-candidate")
    signals = scoring["signals"]
    weights = {
        "fts": unit_weight(signals["fts"]["weight"], "signals.fts.weight"),
        "recency": unit_weight(signals["recency"]["weight"], "signals.recency.weight"),
        "confidence": unit_weight(signals["confidence"]["weight"], "signals.confidence.weight"),
    }
    if abs(sum(weights.values()) - 1.0) > 0.000001:
        raise ValueError("signal weights must sum to 1.0")
    return {
        "min_final_score": score(scoring["minFinalScore"], "minFinalScore"),
        "relative_floor": score(scoring["relativeFloor"], "relativeFloor"),
        "weights": weights,
        "half_life_days": positive_number(signals["recency"]["halfLifeDays"], "signals.recency.halfLifeDays"),
    }


def main(argv):
    if len(argv) != 5:
        raise ValueError("usage: recall.py <db> <query> <project> <config-json>")

    db, query, project, raw_config = argv[1], argv[2], argv[3], argv[4]
    config = json.loads(raw_config)

    fts_table = identifier(config["ftsTable"], "ftsTable")
    join_table = identifier(config["joinTable"], "joinTable")
    filters = config.get("filtersSql") or []
    if not filters or any(";" in item for item in filters):
        raise ValueError("filtersSql must contain allowlisted SQL predicates")

    candidate_pool = positive_int(config["candidatePool"], "candidatePool")
    output_max = positive_int(config["max"], "max")
    snippet_chars = positive_int(config["snippetChars"], "snippetChars")
    scoring = scoring_policy(config)
    cross_project_tag = config["crossProjectTag"]

    sql = (
        f"SELECT m.content, rank, m.created_at, m.confidence "
        f"FROM {fts_table} f JOIN {join_table} m ON m.id=f.rowid "
        f"WHERE f.{fts_table} MATCH ? AND ({' AND '.join(filters)}) "
    )
    params = [query]
    if project:
        sql += "AND (','||coalesce(m.tags,'')||',' LIKE ? OR ','||coalesce(m.tags,'')||',' LIKE ?) "
        params.extend([f"%,{project},%", f"%,{cross_project_tag},%"])
    sql += f"ORDER BY rank LIMIT {candidate_pool}"

    now = time.time()
    conn = sqlite3.connect(db)
    candidates = []
    try:
        for content, rank, created_at, confidence in conn.execute(sql, params).fetchall():
            fts_feature = -float(rank) if rank is not None else 0.0
            candidates.append([content, fts_feature, created_at, confidence])
    finally:
        conn.close()

    if not candidates:
        return 0

    top_fts_feature = max(row[1] for row in candidates) or 0.0
    if top_fts_feature <= 0:
        return 0

    def recency_score(value):
        if value is None:
            return None
        age_days = max(0.0, (now - float(value)) / 86400)
        return 100.0 / (1.0 + age_days / scoring["half_life_days"])

    def confidence_score(value):
        if value is None:
            return None
        return max(0.0, min(100.0, float(value) * 100.0))

    rows = []
    for candidate in candidates:
        try:
            fts = max(0.0, min(100.0, candidate[1] / top_fts_feature * 100.0))
            recency = recency_score(candidate[2])
            confidence = confidence_score(candidate[3])
        except Exception:
            continue
        if fts is None or recency is None or confidence is None:
            continue
        final_score = (
            scoring["weights"]["fts"] * fts
            + scoring["weights"]["recency"] * recency
            + scoring["weights"]["confidence"] * confidence
        )
        rows.append((final_score, candidate, fts, recency, confidence))

    rows.sort(key=lambda row: -row[0])
    if not rows:
        return 0
    top_final_score = rows[0][0]
    final_floor = max(scoring["min_final_score"], top_final_score * scoring["relative_floor"] / 100.0)
    for final_score, candidate, fts, recency, confidence in rows[:output_max]:
        if final_score < final_floor:
            continue
        print(json.dumps({
            "text": truncate(candidate[0], snippet_chars),
            "score": final_score,
            "signals": {
                "fts": fts,
                "recency": recency,
                "confidence": confidence,
            },
        }, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except Exception as exc:
        print(f"recall.py failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
