#!/usr/bin/env python
import json
import os
import re
import sqlite3
import sys


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


def overlap_count(text, terms):
    return sum(1 for term in terms if re.search(r"\b" + re.escape(term) + r"\b", text))


def connect_readonly(db_path):
    normalized = os.path.abspath(db_path).replace("\\", "/")
    con = sqlite3.connect(f"file:{normalized}?mode=ro", uri=True, timeout=3.0)
    con.execute("PRAGMA busy_timeout=3000")
    return con


def scoring_policy(config):
    scoring = config["scoring"]
    scale = scoring["scoreScale"]
    if scale.get("min") != 0 or scale.get("max") != 100 or scale.get("baseline") != 0:
        raise ValueError("scoreScale must be {min:0,max:100,baseline:0}")
    if scoring.get("missingSignalPolicy") != "drop-candidate":
        raise ValueError("missingSignalPolicy must be drop-candidate")
    signals = scoring["signals"]
    fts = signals["fts"]
    overlap = signals["overlap"]
    weights = {
        "fts": unit_weight(fts["weight"], "signals.fts.weight"),
        "overlap": unit_weight(overlap["weight"], "signals.overlap.weight"),
    }
    if abs(sum(weights.values()) - 1.0) > 0.000001:
        raise ValueError("signal weights must sum to 1.0")
    boosts = {
        "name": unit_weight(fts["fieldBoosts"]["name"], "signals.fts.fieldBoosts.name"),
        "description": unit_weight(fts["fieldBoosts"]["description"], "signals.fts.fieldBoosts.description"),
        "content": unit_weight(fts["fieldBoosts"]["content"], "signals.fts.fieldBoosts.content"),
    }
    if abs(sum(boosts.values()) - 1.0) > 0.000001:
        raise ValueError("fieldBoosts must sum to 1.0")
    return {
        "min_final_score": score(scoring["minFinalScore"], "minFinalScore"),
        "relative_floor": score(scoring["relativeFloor"], "relativeFloor"),
        "weights": weights,
        "field_boosts": boosts,
        "min_overlap": positive_int(overlap["minTerms"], "signals.overlap.minTerms"),
    }


def main(argv):
    if len(argv) != 6:
        raise ValueError("usage: suggest.py <db> <query> <project> <terms> <config-json>")

    db, query, project, term_string, raw_config = argv[1], argv[2], argv[3], argv[4], argv[5]
    config = json.loads(raw_config)

    fts_table = identifier(config["ftsTable"], "ftsTable")
    join_table = identifier(config["joinTable"], "joinTable")
    candidate_pool = positive_int(config["candidatePool"], "candidatePool")
    output_max = positive_int(config["max"], "max")
    scoring = scoring_policy(config)

    terms = [term for term in term_string.split() if term]
    required_overlap = min(scoring["min_overlap"], len(terms)) if terms else 1
    field_boosts = scoring["field_boosts"]

    sql = (
        f"SELECT s.name, bm25({fts_table}, {field_boosts['name']}, {field_boosts['description']}, {field_boosts['content']}) sc, "
        f"s.scope, lower(coalesce(s.name,'')||' '||coalesce(s.description,'')||' '||coalesce(s.content,'')) txt "
        f"FROM {fts_table} f JOIN {join_table} s ON s.id=f.rowid "
        f"WHERE {fts_table} MATCH ? AND s.curated=1 ORDER BY sc LIMIT {candidate_pool}"
    )

    conn = connect_readonly(db)
    try:
        rows = conn.execute(sql, [query]).fetchall()
    finally:
        conn.close()

    rows = [row for row in rows if overlap_count(row[3], terms) >= required_overlap]
    if not rows:
        return 0

    top_fts_feature = max(-row[1] for row in rows) or 0.0
    if top_fts_feature <= 0:
        return 0

    output = []
    for name, score, scope, text in rows:
        if scope != "all" and scope != project:
            continue
        count = overlap_count(text, terms)
        if count < required_overlap:
            continue
        fts_score = max(0.0, min(100.0, (-score) / top_fts_feature * 100.0))
        overlap_score = max(0.0, min(100.0, count / len(terms) * 100.0)) if terms else None
        if fts_score is None or overlap_score is None:
            continue
        final_score = scoring["weights"]["fts"] * fts_score + scoring["weights"]["overlap"] * overlap_score
        output.append({
            "name": name,
            "score": final_score,
            "signals": {
                "fts": fts_score,
                "overlap": overlap_score,
                "scope": scope,
            },
        })

    output.sort(key=lambda row: -row["score"])
    if output:
        top_final_score = output[0]["score"]
        final_floor = max(scoring["min_final_score"], top_final_score * scoring["relative_floor"] / 100.0)
        output = [row for row in output if row["score"] >= final_floor]

    for row in output[:output_max]:
        print(json.dumps(row, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except Exception as exc:
        print(f"suggest.py failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
