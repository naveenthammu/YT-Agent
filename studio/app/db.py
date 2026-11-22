"""Tiny SQLite store: every video the pipeline makes, its status and its stats."""
from __future__ import annotations

import os
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB_PATH = Path(os.getenv("DATA_DIR", "/data")) / "studio.db"
_lock = threading.Lock()

FIELDS = ("topic", "angle", "title", "format", "status", "youtube_id",
          "video_url", "thumb_url", "views", "likes", "comments", "stats_at", "notes")


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    with _lock, _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS videos (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                topic TEXT, angle TEXT, title TEXT, format TEXT,
                status TEXT, youtube_id TEXT, video_url TEXT, thumb_url TEXT,
                views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0, comments INTEGER DEFAULT 0,
                stats_at TEXT, notes TEXT
            )""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_videos_yt ON videos(youtube_id)")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def upsert(data: dict) -> dict:
    vid = str(data.get("id") or "").strip()
    if not vid:
        raise ValueError("id is required")
    values = {k: data[k] for k in FIELDS if k in data and data[k] is not None}
    with _lock, _conn() as c:
        exists = c.execute("SELECT 1 FROM videos WHERE id=?", (vid,)).fetchone()
        if exists:
            if values:
                sets = ", ".join(f"{k}=?" for k in values)
                c.execute(f"UPDATE videos SET {sets} WHERE id=?", (*values.values(), vid))
        else:
            cols = ["id", "created_at", *values.keys()]
            c.execute(f"INSERT INTO videos ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                      (vid, _now(), *values.values()))
        row = c.execute("SELECT * FROM videos WHERE id=?", (vid,)).fetchone()
    return dict(row)


def list_recent(days: int = 120) -> list[dict]:
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
    with _lock, _conn() as c:
        rows = c.execute("SELECT * FROM videos WHERE created_at >= ? ORDER BY created_at DESC",
                         (since,)).fetchall()
    return [dict(r) for r in rows]


def update_stats(updates: list[dict]) -> int:
    """updates: [{id? , youtube_id, views, likes, comments}] - matched by id, else youtube_id."""
    n = 0
    with _lock, _conn() as c:
        for u in updates:
            vals = (int(u.get("views") or 0), int(u.get("likes") or 0),
                    int(u.get("comments") or 0), _now())
            if u.get("id"):
                cur = c.execute(
                    "UPDATE videos SET views=?, likes=?, comments=?, stats_at=?, "
                    "youtube_id=COALESCE(?, youtube_id), "
                    "status=CASE WHEN status IN ('ready_manual','rendered') THEN 'published' ELSE status END "
                    "WHERE id=?", (*vals, u.get("youtube_id"), u["id"]))
            elif u.get("youtube_id"):
                cur = c.execute("UPDATE videos SET views=?, likes=?, comments=?, stats_at=? "
                                "WHERE youtube_id=?", (*vals, u["youtube_id"]))
            else:
                continue
            n += cur.rowcount
    return n
