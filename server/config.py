"""Runtime configuration, from environment (systemd EnvironmentFile=/opt/sparkdba/.env)."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("SPARKDBA_DATA", ROOT / "data"))
DATA.mkdir(parents=True, exist_ok=True)

PG_HOST = os.environ.get("PG_HOST", "127.0.0.1")
PG_DB = os.environ.get("PG_DB", "lab")


def _dsn(user: str, pw_var: str) -> str:
    return f"host={PG_HOST} dbname={PG_DB} user={user} password={os.environ.get(pw_var, '')}"


RO_DSN = _dsn("sparkdba_ro", "PG_RO_PASS")
OPS_DSN = _dsn("sparkdba_ops", "PG_OPS_PASS")
CHAOS_DSN = _dsn("sparkdba_chaos", "PG_CHAOS_PASS")

LLM_URL = os.environ.get("LLM_URL", "http://127.0.0.1:8000/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "nemotron")

TOKEN = os.environ.get("SPARKDBA_TOKEN", "")
SKILLS_DIR = ROOT / "skills"


def env(key: str) -> str:
    return os.environ.get(key, "")
