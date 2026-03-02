"""
File Integrity Monitoring (FIM) Engine
Core logic: hashing, baseline management, change detection, and event handling.
"""

import hashlib
import json
import os
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer


DB_PATH = os.path.join(os.path.dirname(__file__), "fim_data.db")


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS baseline (
                path        TEXT PRIMARY KEY,
                hash        TEXT NOT NULL,
                size        INTEGER NOT NULL,
                mtime       REAL NOT NULL,
                created_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type  TEXT NOT NULL,
                path        TEXT NOT NULL,
                old_hash    TEXT,
                new_hash    TEXT,
                severity    TEXT NOT NULL DEFAULT 'info',
                details     TEXT,
                timestamp   TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS monitored_paths (
                path        TEXT PRIMARY KEY,
                recursive   INTEGER NOT NULL DEFAULT 1,
                active      INTEGER NOT NULL DEFAULT 1,
                added_at    TEXT NOT NULL
            );
        """)


# ---------------------------------------------------------------------------
# Hashing
# ---------------------------------------------------------------------------

def compute_hash(filepath: str, algorithm: str = "sha256") -> Optional[str]:
    """Return hex digest of file, or None if unreadable."""
    try:
        h = hashlib.new(algorithm)
        with open(filepath, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except (OSError, PermissionError):
        return None


# ---------------------------------------------------------------------------
# Baseline management
# ---------------------------------------------------------------------------

def build_baseline(directory: str, recursive: bool = True) -> Dict[str, dict]:
    """Walk a directory and hash every file, storing results in DB."""
    records: Dict[str, dict] = {}
    now = datetime.utcnow().isoformat()

    walk = os.walk(directory) if recursive else [(directory, [], os.listdir(directory))]

    with get_db() as conn:
        for root, _dirs, files in walk:
            for fname in files:
                fpath = os.path.join(root, fname)
                try:
                    stat = os.stat(fpath)
                    fhash = compute_hash(fpath)
                    if fhash is None:
                        continue
                    record = {
                        "path": fpath,
                        "hash": fhash,
                        "size": stat.st_size,
                        "mtime": stat.st_mtime,
                        "created_at": now,
                    }
                    conn.execute(
                        """INSERT OR REPLACE INTO baseline
                           (path, hash, size, mtime, created_at)
                           VALUES (:path, :hash, :size, :mtime, :created_at)""",
                        record,
                    )
                    records[fpath] = record
                except OSError:
                    continue

    return records


def get_baseline() -> Dict[str, dict]:
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM baseline").fetchall()
    return {r["path"]: dict(r) for r in rows}


def remove_from_baseline(path: str) -> None:
    with get_db() as conn:
        conn.execute("DELETE FROM baseline WHERE path = ?", (path,))


def update_baseline_entry(path: str) -> Optional[dict]:
    try:
        stat = os.stat(path)
        fhash = compute_hash(path)
        if fhash is None:
            return None
        record = {
            "path": path,
            "hash": fhash,
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "created_at": datetime.utcnow().isoformat(),
        }
        with get_db() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO baseline
                   (path, hash, size, mtime, created_at)
                   VALUES (:path, :hash, :size, :mtime, :created_at)""",
                record,
            )
        return record
    except OSError:
        return None


# ---------------------------------------------------------------------------
# Event logging
# ---------------------------------------------------------------------------

SEVERITY = {
    "created": "warning",
    "modified": "critical",
    "deleted":  "critical",
    "moved":    "warning",
}


def log_event(
    event_type: str,
    path: str,
    old_hash: Optional[str] = None,
    new_hash: Optional[str] = None,
    details: Optional[str] = None,
) -> dict:
    severity = SEVERITY.get(event_type, "info")
    timestamp = datetime.utcnow().isoformat()
    with get_db() as conn:
        cur = conn.execute(
            """INSERT INTO events
               (event_type, path, old_hash, new_hash, severity, details, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (event_type, path, old_hash, new_hash, severity, details, timestamp),
        )
        event_id = cur.lastrowid
    return {
        "id": event_id,
        "event_type": event_type,
        "path": path,
        "old_hash": old_hash,
        "new_hash": new_hash,
        "severity": severity,
        "details": details,
        "timestamp": timestamp,
    }


def get_events(limit: int = 200, offset: int = 0) -> List[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM events ORDER BY id DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return [dict(r) for r in rows]


def get_event_stats() -> dict:
    with get_db() as conn:
        total     = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        critical  = conn.execute("SELECT COUNT(*) FROM events WHERE severity='critical'").fetchone()[0]
        warning   = conn.execute("SELECT COUNT(*) FROM events WHERE severity='warning'").fetchone()[0]
        today_sql = "SELECT COUNT(*) FROM events WHERE date(timestamp) = date('now')"
        today     = conn.execute(today_sql).fetchone()[0]
        baseline_count = conn.execute("SELECT COUNT(*) FROM baseline").fetchone()[0]
    return {
        "total": total,
        "critical": critical,
        "warning": warning,
        "today": today,
        "baseline_files": baseline_count,
    }


# ---------------------------------------------------------------------------
# Monitored paths CRUD
# ---------------------------------------------------------------------------

def add_monitored_path(path: str, recursive: bool = True) -> dict:
    record = {"path": path, "recursive": int(recursive), "active": 1,
              "added_at": datetime.utcnow().isoformat()}
    with get_db() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO monitored_paths
               (path, recursive, active, added_at) VALUES (:path, :recursive, :active, :added_at)""",
            record,
        )
    return record


def get_monitored_paths() -> List[dict]:
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM monitored_paths WHERE active=1").fetchall()
    return [dict(r) for r in rows]


def remove_monitored_path(path: str) -> None:
    with get_db() as conn:
        conn.execute("UPDATE monitored_paths SET active=0 WHERE path=?", (path,))


# ---------------------------------------------------------------------------
# Watchdog handler
# ---------------------------------------------------------------------------

class FIMEventHandler(FileSystemEventHandler):
    def __init__(self, event_callback: Callable[[dict], None]):
        super().__init__()
        self._callback = event_callback
        self._lock = threading.Lock()

    def on_created(self, event):
        if event.is_directory:
            return
        path = event.src_path
        new_hash = compute_hash(path)
        ev = log_event("created", path, new_hash=new_hash)
        update_baseline_entry(path)
        self._callback(ev)

    def on_modified(self, event):
        if event.is_directory:
            return
        path = event.src_path
        baseline = get_baseline()
        old_hash = baseline.get(path, {}).get("hash")
        new_hash = compute_hash(path)
        if old_hash == new_hash:          # spurious event — no real change
            return
        ev = log_event("modified", path, old_hash=old_hash, new_hash=new_hash)
        update_baseline_entry(path)
        self._callback(ev)

    def on_deleted(self, event):
        if event.is_directory:
            return
        path = event.src_path
        baseline = get_baseline()
        old_hash = baseline.get(path, {}).get("hash")
        ev = log_event("deleted", path, old_hash=old_hash)
        remove_from_baseline(path)
        self._callback(ev)

    def on_moved(self, event):
        if event.is_directory:
            return
        baseline = get_baseline()
        old_hash = baseline.get(event.src_path, {}).get("hash")
        new_hash = compute_hash(event.dest_path)
        details = f"moved → {event.dest_path}"
        ev = log_event("moved", event.src_path, old_hash=old_hash, new_hash=new_hash, details=details)
        remove_from_baseline(event.src_path)
        update_baseline_entry(event.dest_path)
        self._callback(ev)


# ---------------------------------------------------------------------------
# Monitor orchestrator
# ---------------------------------------------------------------------------

class FIMMonitor:
    def __init__(self, event_callback: Callable[[dict], None]):
        self._callback = event_callback
        self._observer: Optional[Observer] = None
        self._running = False

    @property
    def running(self) -> bool:
        return self._running

    def start(self) -> None:
        if self._running:
            return
        paths = get_monitored_paths()
        if not paths:
            return

        handler = FIMEventHandler(self._callback)
        self._observer = Observer()
        for p in paths:
            if os.path.exists(p["path"]):
                self._observer.schedule(handler, p["path"], recursive=bool(p["recursive"]))
        self._observer.start()
        self._running = True

    def stop(self) -> None:
        if self._observer and self._running:
            self._observer.stop()
            self._observer.join()
            self._running = False
            self._observer = None

    def restart(self) -> None:
        self.stop()
        self.start()
