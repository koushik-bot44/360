"""Tiny SQLite job store (stdlib only). No ORM, no migrations — POC scope."""
import sqlite3
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "jobs.db"


def _conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def init():
    with _conn() as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                title TEXT,
                status TEXT,           -- created|uploaded|reconstructing|ready|failed
                engine TEXT,           -- colmap|mock|''
                num_images INTEGER DEFAULT 0,
                error TEXT,
                created_at REAL,
                updated_at REAL
            )"""
        )


def create_job(job_id: str, title: str):
    now = time.time()
    with _conn() as c:
        c.execute(
            "INSERT INTO jobs (id,title,status,engine,num_images,error,created_at,updated_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (job_id, title, "created", "", 0, None, now, now),
        )


def update_job(job_id: str, **fields):
    if not fields:
        return
    fields["updated_at"] = time.time()
    cols = ", ".join(f"{k}=?" for k in fields)
    with _conn() as c:
        c.execute(f"UPDATE jobs SET {cols} WHERE id=?", (*fields.values(), job_id))


def get_job(job_id: str):
    with _conn() as c:
        row = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return dict(row) if row else None


def list_jobs():
    with _conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM jobs ORDER BY created_at DESC")]
