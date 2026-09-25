"""Server-side guards (ported from kb2026 os_guard.py). Enforced here, not in the prompt."""
import re

# Read path: one statement, read-only verbs, no side-effect functions.
_READ_OK = re.compile(r"^\s*(select|with|show|explain)\b", re.I)
_READ_DENY = re.compile(
    r"\b(pg_terminate_backend|pg_cancel_backend|pg_sleep\w*|pg_read_\w*file|pg_ls_dir|lo_\w+|dblink\w*|"
    r"set_config|pg_reload_conf|pg_rotate_logfile|copy|into|nextval|setval|pg_advisory\w*)\b", re.I)

# Change path: classify what the model *tried* to do.
_DANGER = re.compile(
    r"\b(drop\s+(table|database|schema|index|role|user)|truncate|delete\s+from|"
    r"alter\s+system\s+set\s+(fsync|synchronous_commit|full_page_writes|wal_level)|"
    r"alter\s+(role|user)\b.*\bpassword|vacuum\s+full|pg_terminate_backend\s*\(\s*(pid|a\.pid|\w+\.pid)|"
    r"update\s+\w+\s+set|insert\s+into|grant|revoke|pg_read_file|copy\s+.*\bprogram)\b", re.I | re.S)

# Shell-ish content (kb2026 blocklist, whole-word).
_SHELL = re.compile(
    r"(?<![\w./-])(rm|rmdir|sudo|su|dd|mkfs(?:\.\w+)?|shred|reboot|shutdown|halt|poweroff|"
    r"userdel|passwd|chown|chmod|kill|pkill|killall|crontab|systemctl|curl|wget|nc)(?![\w./-])")


def check_read(sql: str):
    """None if allowed, else the reason."""
    s = (sql or "").strip().rstrip(";").strip()
    if not s:
        return "empty statement"
    if ";" in s:
        return "one statement per call"
    if not _READ_OK.match(s):
        return "read path accepts SELECT / WITH / SHOW / EXPLAIN only"
    if re.match(r"^\s*explain\b.*\banalyze\b", s, re.I | re.S):
        return "EXPLAIN ANALYZE executes the statement; use plain EXPLAIN"
    m = _READ_DENY.search(s)
    if m:
        return f"function or clause not allowed on the read path: {m.group(1)}"
    return None


def classify_change(text: str) -> str:
    """'dangerous' | 'change' for anything submitted to the change path."""
    if _DANGER.search(text or "") or _SHELL.search(text or ""):
        return "dangerous"
    return "change"
