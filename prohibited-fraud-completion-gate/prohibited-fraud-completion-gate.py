#!/usr/bin/env python
"""Stop gate for Jon's prohibited fraudulent implementation methods contract.

This gate is intentionally narrow in authority and broad in coverage:

- It requires the canonical governance document to exist in every configured
  target repo.
- It requires each document to contain every configured prohibited class phrase.
- For the active target repo, it scans newly added implementation lines against
  deterministic detectors for the prohibited classes.

It does not replace semantic review. It blocks obvious mechanical bypasses and
prevents completion when the canonical document is missing, hollow, or ignored.
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HOOK_ID = "prohibited-fraud-completion-gate"
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[1] / "config.json"
MAX_FILE_BYTES = 1_000_000


RULES = [
    {
        "id": "browser-storage-product-authority",
        "title": "Browser storage as product authority",
        "regex": (
            r"\b(localStorage|sessionStorage|indexedDB|IndexedDB|createSyncStoragePersister|"
            r"persistQueryClient|persistedQueryClient|inMemory|memoryFallback)\b.*\b("
            r"workspace|tenant|auth|session|chat|api|scope|store|library|asset|metadata|"
            r"agent|skill|provider|model|profile|operator|role|permission|runtime|health|"
            r"verification|evidence|settings)[A-Za-z0-9_ -]*\b|"
            r"\b(workspace|tenant|auth|session|chat|api|scope|store|library|asset|metadata|"
            r"agent|skill|provider|model|profile|operator|role|permission|runtime|health|"
            r"verification|evidence|settings)\b.*\b(localStorage|sessionStorage|indexedDB|"
            r"IndexedDB|createSyncStoragePersister|persistQueryClient|persistedQueryClient|"
            r"inMemory|memoryFallback)\b"
        ),
    },
    {
        "id": "default-fallback-product-identity",
        "title": "Default/fallback product identity",
        "regex": (
            r"\b(DEFAULT|FALLBACK|REMEMBERED|SAFE|LOCAL|MOCK|DEMO|SAMPLE)_[A-Z0-9_]*"
            r"(WORKSPACE|TENANT|USER|PROJECT|STORE|SESSION|CHAT|PROVIDER|MODEL|PROFILE|"
            r"OPERATOR|ROLE|PERMISSION)[A-Z0-9_]*\b|"
            r"\b(workspace|tenant|user|project|store|session|chat|provider|model|profile|"
            r"operator|role|permission)[A-Za-z0-9_]*(Id|ID|Slug|Key)\b\s*[:=]\s*"
            r"['\"](local|demo|sample|mock|default|test|fallback)"
        ),
    },
    {
        "id": "fake-product-rows",
        "title": "Fake product rows",
        "regex": (
            r"\b(mock|demo|sample|fake|placeholder|seeded)\b.*\b(users?|workspaces?|"
            r"stores?|projects?|skills?|providers?|models?|metrics?|files?|sessions?|"
            r"credentials?|health|workflow|catalog|rows?)\b|"
            r"\b(users?|workspaces?|stores?|projects?|skills?|providers?|models?|metrics?|"
            r"files?|sessions?|credentials?|health|workflow|catalog|rows?)\b.*\b(mock|demo|"
            r"sample|fake|placeholder|seeded)\b"
        ),
    },
    {
        "id": "backend-api-bypass",
        "title": "Backend/API bypass",
        "regex": (
            r"\b(static array|static arrays|hardcoded|local json|filesystem|browser state|"
            r"route constants?)\b.*\b(source of truth|product truth|authority|backend|api)\b|"
            r"\b(source of truth|product truth|authority)\b.*\b(static array|static arrays|"
            r"hardcoded|local json|filesystem|browser state|route constants?)\b"
        ),
    },
    {
        "id": "tenant-isolation-shortcut",
        "title": "Tenant isolation shortcuts",
        "regex": (
            r"\b(unscoped|global)\b.*\b(workspace|tenant|row|rows|cache|query|queries)\b|"
            r"\b(missing|skip|bypass)\b.*\b(membership|ownership|tenant|workspace)\b.*\b(check|"
            r"checks|resolution|scoping)\b|"
            r"\b(public|external)\b.*\b(internal|uuid)\b.*\bid\b"
        ),
    },
    {
        "id": "fake-misleading-ui",
        "title": "Fake or misleading UI",
        "regex": (
            r"\b(connected|healthy|available|liveApi|verified|operational)\b\s*[:=]\s*"
            r"(true|['\"]true['\"])|"
            r"\bplaceholder\b.*\b(panel|card|table|badge|status|metric|connected|healthy|"
            r"available|operational)\b"
        ),
    },
    {
        "id": "static-runtime-catalog-authority",
        "title": "Static runtime catalogs as authority",
        "regex": (
            r"\b(provider|providers|model|models|tool|tools|profile|profiles|embedding|"
            r"embeddings)\b.*\b(static|catalog|inventory|source of truth|authority)\b|"
            r"\b(OpenAI|Anthropic|Gemini|Ollama|providerId|modelId)\b.*\b\[\b"
        ),
    },
    {
        "id": "silent-fallback-behavior",
        "title": "Silent fallback behavior",
        "regex": (
            r"\b(assigned|selected|current|active)[A-Za-z0-9_]*(Model|Provider|Profile|"
            r"Workspace|Tenant|Session|User|Role|Setting)?\b\s*(\|\||\?\?)\s*\b(default|"
            r"fallback|local)[A-Za-z0-9_]*\b|"
            r"\bexcept\b.*\breturn\b.*\b(default|fallback|local)\b|"
            r"\bcatch\b.*\breturn\b.*\b(default|fallback|local)\b"
        ),
    },
    {
        "id": "loopback-product-runtime",
        "title": "Loopback product runtime config",
        "regex": (
            r"\b(NEXT_PUBLIC|VITE_|PUBLIC_)[A-Z0-9_]*(API|DOCS|URL|ORIGIN|ENDPOINT)[A-Z0-9_]*"
            r"\b.*\b(localhost|127\.0\.0\.1)\b|"
            r"\b(localhost|127\.0\.0\.1):\d+\b.*\b(build|deploy|production|product|runtime)\b"
        ),
    },
    {
        "id": "verification-fraud",
        "title": "Verification fraud",
        "includeTests": True,
        "regex": (
            r"\b(route\.fulfill|page\.route|intercept|mock|fixture|demo|sample|cached)\b.*"
            r"\b(verification|evidence|liveApi|backend|api|runtime|screenshot|run\.json)\b|"
            r"\b(verification|evidence|liveApi|screenshot|run\.json)\b.*\b(route\.fulfill|"
            r"page\.route|intercept|mock|fixture|demo|sample|cached)\b"
        ),
    },
    {
        "id": "test-fixture-leakage",
        "title": "Test fixture leakage",
        "regex": (
            r"\b(from|import|require)\b.*\b(test|tests|fixture|fixtures|mock|mocks|__mocks__)\b|"
            r"\b(production-looking|opaque)\b.*\b(fixture|test id|test data)\b"
        ),
    },
    {
        "id": "client-only-durable-settings",
        "title": "Client-only durable settings",
        "regex": (
            r"\b(appearance|ai|workspace|account|operator|role|runtime|product|platform)"
            r"[A-Za-z0-9_ -]*(setting|settings|state)\b.*\b(localStorage|sessionStorage|"
            r"indexedDB|browser storage)\b|"
            r"\b(localStorage|sessionStorage|indexedDB|browser storage)\b.*\b(appearance|ai|"
            r"workspace|account|operator|role|runtime|product|platform)[A-Za-z0-9_ -]*"
            r"(setting|settings|state)\b"
        ),
    },
    {
        "id": "secrets-credentials-shortcut",
        "title": "Secrets/credentials shortcuts",
        "regex": (
            r"\b(api[_-]?key|token|credential|secret|access[_-]?key|provider[_-]?key)\b.*"
            r"\b(localStorage|sessionStorage|frontend state|browser storage|screenshot|"
            r"console\.log|print\(|committed|docs?)\b"
        ),
    },
    {
        "id": "governance-bypass",
        "title": "Governance bypass",
        "includeTests": True,
        "regex": (
            r"\b(skip|disable|bypass|ignore)\b.*\b(governance|contract|gate|no-mock|"
            r"anti-fraud|prohibited|fraud|changelog|migration)\b|"
            r"\ballowAfterRepeatedBlocks\b\s*[:=]\s*true"
        ),
    },
    {
        "id": "cross-repo-path-fabrication",
        "title": "Cross-repo/path fabrication",
        "regex": (
            r"\b(guess|invent|assume|pretend)\b.*\b(repo path|hook path|docs path|planned path|"
            r"authority location|E:/hooks|E:/jwc-global|E:/kai-chattr|E:/tfo|E:/kai-agent|"
            r"E:/dbase)\b"
        ),
    },
]


def read_stdin_json() -> dict:
    try:
        raw = sys.stdin.read().strip()
        return json.loads(raw) if raw else {}
    except Exception:
        return {}


def load_config() -> dict:
    path = Path(os.environ.get("HOOKS_CONFIG_PATH") or DEFAULT_CONFIG_PATH)
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def hook_settings(config: dict) -> dict:
    for hook in config.get("hooks", []):
        if hook.get("id") == HOOK_ID:
            return hook.get("settings") or {}
    return {}


def settings_error(settings: dict) -> str | None:
    docs = settings.get("documents") or []
    phrases = settings.get("requiredPhrases") or []
    if len(docs) != 5:
        return "gate settings must list exactly five governed repository documents"
    if not phrases:
        return "gate settings.requiredPhrases must not be empty"
    if settings.get("failureMode") != "block":
        return "gate settings.failureMode must be block"
    if settings.get("documentName") != "PROHIBITED FRAUDULENT IMPLEMENTATION METHODS.md":
        return "gate settings.documentName mismatch"
    return None


def norm(path: str | Path) -> str:
    return str(path).replace("\\", "/").rstrip("/")


def git(repo: str, *args: str, timeout: int = 8) -> tuple[int, str, str]:
    proc = subprocess.run(
        ["git", "-C", repo, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return proc.returncode, proc.stdout, proc.stderr


def repo_root(cwd: str) -> str | None:
    try:
      code, stdout, _stderr = git(cwd, "rev-parse", "--show-toplevel")
    except Exception:
      return None
    if code != 0:
        return None
    return norm(stdout.strip())


def matches_any(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns or [])


def is_test_path(path: str) -> bool:
    lowered = path.lower()
    return (
        ".test." in lowered
        or ".spec." in lowered
        or "/__tests__/" in lowered
        or "/__mocks__/" in lowered
        or "/tests/" in lowered
        or lowered.startswith("tests/")
    )


def configured_documents(settings: dict) -> list[dict]:
    out = []
    for item in settings.get("documents") or []:
        root = norm(item.get("root") or "")
        rel = norm(item.get("path") or "")
        if not root or not rel:
            continue
        out.append({
            "repo": item.get("repo") or root,
            "root": root,
            "path": rel,
            "absolute": norm(Path(root) / rel),
        })
    return out


def compact_ws(text: str) -> str:
    return " ".join(text.split())


def check_documents(settings: dict) -> list[dict]:
    findings = []
    required = settings.get("requiredPhrases") or []
    for doc in configured_documents(settings):
        path = Path(doc["absolute"])
        if not path.exists():
            findings.append({"repo": doc["repo"], "path": doc["absolute"], "issue": "missing document"})
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except Exception as exc:
            findings.append({"repo": doc["repo"], "path": doc["absolute"], "issue": f"unreadable document: {exc}"})
            continue
        text_lower = text.lower()
        compact_text_lower = compact_ws(text).lower()
        for phrase in required:
            phrase_lower = phrase.lower()
            compact_phrase_lower = compact_ws(phrase).lower()
            if phrase_lower not in text_lower and compact_phrase_lower not in compact_text_lower:
                findings.append({
                    "repo": doc["repo"],
                    "path": doc["absolute"],
                    "issue": f"missing required phrase: {phrase}",
                })
    return findings


def target_for_repo(root: str | None, settings: dict) -> dict | None:
    if not root:
        return None
    root_norm = norm(root).lower()
    for doc in configured_documents(settings):
        if norm(doc["root"]).lower() == root_norm:
            return doc
    return None


def allowed_extensions(extensions: list[str]) -> set[str]:
    return {f".{str(ext).lstrip('.').lower()}" for ext in (extensions or ["ts", "tsx", "js", "py", "md"])}


def has_allowed_extension(path: str, extensions: set[str]) -> bool:
    return Path(path).suffix.lower() in extensions


def added_lines(repo: str, extensions: list[str]) -> list[tuple[str, int, str]]:
    added: list[tuple[str, int, str]] = []
    allowed = allowed_extensions(extensions)
    code, stdout, _stderr = git(repo, "diff", "--unified=0", "HEAD", timeout=20)
    diff = stdout if code == 0 else ""
    path = None
    new_line = 0
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            path = line[6:].strip()
            new_line = 0
        elif line.startswith("@@"):
            match = re.search(r"\+(\d+)", line)
            new_line = int(match.group(1)) if match else 0
        elif line.startswith("+") and not line.startswith("+++"):
            if path and has_allowed_extension(path, allowed):
                added.append((norm(path), new_line, line[1:]))
            new_line += 1
        elif line.startswith(" "):
            new_line += 1

    code, stdout, _stderr = git(repo, "ls-files", "--others", "--exclude-standard", timeout=20)
    if code != 0:
        return added
    for rel in stdout.splitlines():
        rel = rel.strip()
        if not rel:
            continue
        if not has_allowed_extension(rel, allowed):
            continue
        full = Path(repo) / rel
        try:
            if full.stat().st_size > MAX_FILE_BYTES:
                continue
            with full.open(encoding="utf-8", errors="ignore") as handle:
                for index, text in enumerate(handle, 1):
                    added.append((norm(rel), index, text.rstrip("\n")))
        except Exception:
            continue
    return added


def scan_repo(repo: str, settings: dict) -> list[dict]:
    excludes = settings.get("scanPathExcludes") or []
    extensions = settings.get("scanExtensions") or []
    compiled = []
    for rule in RULES:
        compiled.append({
            **rule,
            "rx": re.compile(rule["regex"], re.IGNORECASE),
            "includeTests": bool(rule.get("includeTests")),
        })

    findings = []
    for rel, line_no, text in added_lines(repo, extensions):
        path = norm(rel)
        if matches_any(path, excludes):
            continue
        test_path = is_test_path(path)
        for rule in compiled:
            if test_path and not rule["includeTests"]:
                continue
            if rule["rx"].search(text):
                findings.append({
                    "file": path,
                    "line": line_no,
                    "rule": rule["id"],
                    "title": rule["title"],
                })
    return findings


def block(reason: str) -> int:
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
    return 0


def allow(message: str) -> int:
    print(json.dumps({"continue": True, "systemMessage": message}, ensure_ascii=False))
    return 0


def run_for_repo(repo: str, settings: dict, docs_only: bool = False) -> dict:
    doc_findings = check_documents(settings)
    scan_findings = [] if docs_only else scan_repo(repo, settings)
    return {"docFindings": doc_findings, "scanFindings": scan_findings}


def render_findings(doc_findings: list[dict], scan_findings: list[dict]) -> str:
    parts = []
    if doc_findings:
        details = "\n".join(
            f"  {finding['repo']}: {finding['path']} - {finding['issue']}"
            for finding in doc_findings[:20]
        )
        more = f"\n  ...and {len(doc_findings) - 20} more" if len(doc_findings) > 20 else ""
        parts.append(f"Document enforcement failed:\n{details}{more}")
    if scan_findings:
        details = "\n".join(
            f"  {finding['file']}:{finding['line']} [{finding['rule']}] {finding['title']}"
            for finding in scan_findings[:30]
        )
        more = f"\n  ...and {len(scan_findings) - 30} more" if len(scan_findings) > 30 else ""
        parts.append(f"Prohibited implementation methods detected in added lines:\n{details}{more}")
    return "\n\n".join(parts)


def handle(payload: dict) -> int:
    config = load_config()
    settings = hook_settings(config)
    config_error = settings_error(settings)
    if config_error:
        return block(f"prohibited-fraud-completion-gate configuration invalid: {config_error}")
    doc_findings = check_documents(settings)
    cwd = payload.get("cwd") or os.getcwd()
    root = repo_root(cwd)
    target = target_for_repo(root, settings)
    scan_findings = scan_repo(root, settings) if root and target else []

    if doc_findings or scan_findings:
        return block(
            "prohibited-fraud-completion-gate blocked completion.\n"
            + render_findings(doc_findings, scan_findings)
        )

    doc_count = len(configured_documents(settings))
    repo_part = f" and scanned changed lines for {target['repo']}" if target else ""
    return allow(f"prohibited-fraud-completion-gate checked {doc_count} governance document(s){repo_part}.")


def self_test() -> int:
    with tempfile.TemporaryDirectory(prefix="prohibited-fraud-gate-") as tmp:
        repo = Path(tmp) / "repo"
        repo.mkdir()
        subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.email", "t@example.test"], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.name", "T"], check=True)

        docs = repo / "_governance"
        docs.mkdir()
        required = ["Browser storage as product authority", "Required Behavior Instead"]
        (docs / "PROHIBITED FRAUDULENT IMPLEMENTATION METHODS.md").write_text("\n".join(required), encoding="utf-8")
        old = repo / "apps" / "web" / "src"
        old.mkdir(parents=True)
        (old / "old.ts").write_text("const historical = localStorage.getItem('theme')\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-qm", "init"], check=True)

        (old / "new.ts").write_text(
            "const workspaceId = localStorage.getItem('workspaceId')\n"
            "const selectedModel = assignedModel || defaultModel\n",
            encoding="utf-8",
        )
        settings = {
            "documents": [{"repo": "fixture", "root": norm(repo), "path": "_governance/PROHIBITED FRAUDULENT IMPLEMENTATION METHODS.md"}],
            "requiredPhrases": required,
            "scanExtensions": ["ts", "md"],
            "scanPathExcludes": ["**/PROHIBITED FRAUDULENT IMPLEMENTATION METHODS.md"],
        }
        doc_findings = check_documents(settings)
        scan_findings = scan_repo(norm(repo), settings)
        rules = sorted({item["rule"] for item in scan_findings})
        ok = not doc_findings and "browser-storage-product-authority" in rules and "silent-fallback-behavior" in rules
        print(json.dumps({"pass": ok, "rules": rules, "docFindings": doc_findings}, indent=2))
        return 0 if ok else 1


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    config = load_config()
    settings = hook_settings(config)
    config_error = settings_error(settings)
    if config_error:
        print(json.dumps({"configurationError": config_error}, indent=2))
        return 1
    if "--repo" in sys.argv:
        repo = sys.argv[sys.argv.index("--repo") + 1]
        result = run_for_repo(norm(repo), settings, docs_only="--docs-only" in sys.argv)
        print(json.dumps(result, indent=2))
        return 1 if result["docFindings"] or result["scanFindings"] else 0
    return handle(read_stdin_json())


if __name__ == "__main__":
    raise SystemExit(main())
