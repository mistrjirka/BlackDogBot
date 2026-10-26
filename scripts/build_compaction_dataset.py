#!/usr/bin/env python3
"""Create a PRIVATE, redacted offline checkpoint benchmark from recorded BlackDogBot archives.
No raw transcripts, bearer tokens or full shell commands are copied to git.
Outputs live under ~/.blackdogbot/benchmarks and must not be committed.
"""
from __future__ import annotations
import argparse, json, os, pathlib, re, stat
from collections import Counter

HOME = pathlib.Path.home()
SOURCE = HOME / ".blackdogbot" / "sessions"
DEST = HOME / ".blackdogbot" / "benchmarks" / "compaction-20261026"

REDACTIONS = [
    (re.compile(r"\b(?:pp|po|pr)_[A-Za-z0-9_-]{10,}\b"), "[REDACTED_PARK_CREDENTIAL]"),
    (re.compile(r"(?i)(Authorization:\\?s*Bearer\\?s+)[A-Za-z0-9._~-]+"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(api[_-]?key|access[_-]?token|password|secret)\\?\"?\s*[:=]\s*\\?\"?[^\s,;\\\"']+"), "[REDACTED_SECRET_FIELD]"),
    (re.compile(r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b"), "[REDACTED_API_KEY]"),
    (re.compile(r"\b[A-Za-z0-9+/]{150,}={0,2}\b"), "[REDACTED_BINARY_DATA]"),
    (re.compile(r"(?i)\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b"), "[REDACTED_EMAIL]"),
]

def redact(s: str) -> str:
    for pattern, replacement in REDACTIONS:
        s = pattern.sub(replacement, s)
    return s

def text_from_content(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(x.get("text", "")) for x in content if isinstance(x, dict) and x.get("type") == "text")
    return ""

def summarize_message(message: dict) -> dict | None:
    role = message.get("role")
    content = message.get("content")
    if role == "user":
        t = redact(text_from_content(content))[:1900]
        return {"role": "user", "text": t} if t else None
    if role == "assistant":
        if isinstance(content, str):
            t = content[:550]
        else:
            parts = content if isinstance(content, list) else []
            texts = [str(x.get("text", "")) for x in parts if isinstance(x, dict) and x.get("type") == "text"]
            tools = [str(x.get("toolName")) for x in parts if isinstance(x, dict) and x.get("type") == "tool-call"]
            t = " ".join(texts)[:450]
            if tools:
                t += " [TOOLS: " + ", ".join(tools[:5]) + "]"
        t = redact(t)
        return {"role": "assistant", "text": t} if t else None
    if role == "tool" and isinstance(content, list):
        parts = []
        for x in content[:4]:
            if not isinstance(x, dict) or x.get("type") != "tool-result":
                continue
            out = x.get("output")
            if not isinstance(out, dict):
                continue
            value = out.get("value")
            if isinstance(value, dict):
                if isinstance(value.get("stdout"), str):
                    result = value["stdout"]
                else:
                    result = json.dumps(value, ensure_ascii=False)
            elif isinstance(value, str):
                result = value
            elif isinstance(value, list):
                result = " ".join(str(item.get("text", "")) for item in value if isinstance(item, dict))
            else:
                result = ""
            # Preserve the key result/error; no shell commands or reasoning traces.
            parts.append(str(x.get("toolName", "tool")) + ": " + redact(result)[:900])
        return {"role": "tool", "text": "\n".join(parts)} if parts else None
    return None

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--case-limit", type=int, default=6)
    ap.add_argument("--tail-messages", type=int, default=24)
    args = ap.parse_args()
    DEST.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(DEST, 0o700)

    sources = sorted(SOURCE.glob("checkpoint-archive-2026-10-26T*.json"))
    if not sources:
        raise SystemExit("No checkpoint archives found")
    cases = []
    for archive in sources[-args.case_limit:]:
        history = json.loads(archive.read_text())
        if not isinstance(history, list) or not history:
            continue
        first = text_from_content(history[0].get("content", ""))
        if "[EARLIER CONTEXT SUMMARY" in first:
            m = re.search(r"\[LATEST USER REQUEST\]\s*([^\n]+)", first)
            original = m.group(1).strip() if m else ""
        else:
            original = first.strip().split("\n<user_context>")[0].strip()
        # A second repeated compaction can lose the original question entirely.
        if archive.name.startswith("checkpoint-archive-2026-10-26T14-59-"):
            original = "do you remember how we went to a park"
        elif archive.name.startswith("checkpoint-archive-2026-10-26T14-40-"):
            original = "do you remember how we went to a park"

        start = summarize_message(history[0])
        last = [m for row in history[-args.tail_messages:] if (m := summarize_message(row))]
        selected = ([start] if start else []) + last
        # Cap to keep repeated model inference inexpensive while preserving real errors.
        case_id = archive.name.split("T")[1][:8].replace("-", "") + "_" + archive.name.split("T")[0][-2:]
        raw_blob = json.dumps(selected, ensure_ascii=False)
        case = {
            "id": case_id,
            "source_date": archive.name[19:38],
            "original_request": redact(original[:2000]),
            "original_available_in_history": bool(original and original.lower() in first.lower()),
            "history": selected,
            "history_chars": len(raw_blob),
            "expected_park": "park" in original.lower() or "Hive Park" in raw_blob,
        }
        cases.append(case)

    dataset = {
        "description": "SANITIZED excerpts of real BlackDogBot checkpoint archives; NOT an exact production replay",
        "redaction_note": "Never copy original archives into source control; evaluate semantic quality manually in addition to heuristics",
        "cases": cases,
    }
    out = DEST / "dataset.json"
    fd = os.open(out, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf8") as f:
        json.dump(dataset, f, ensure_ascii=False, indent=2)
    print("DATASET", str(out), "CASES", len(cases), "TOTAL_BYTES", out.stat().st_size)
    for item in cases:
        print("CASE", item["id"], "messages", len(item["history"]), "chars", item["history_chars"],
              "had_original", item["original_available_in_history"],
              "is_park", item["expected_park"], "original_len", len(item["original_request"]))

if __name__ == "__main__":
    main()
