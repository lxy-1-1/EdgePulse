"""Disk-first edge outbox; HTTP retries are safe through server idempotency."""
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

import httpx

from .models import Sample


class Outbox:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL)")

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def enqueue(self, sample: Sample):
        with self.connection() as db:
            db.execute("INSERT INTO outbox(payload) VALUES (?)", (sample.model_dump_json(),))

    def count(self):
        with self.connection() as db:
            return db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]

    def pending(self, limit=100):
        with self.connection() as db:
            return [{"id": row["id"], "sample": json.loads(row["payload"])}
                    for row in db.execute("SELECT * FROM outbox ORDER BY id LIMIT ?", (limit,))]

    def flush(self, url, token=None):
        rows = self.pending()
        if not rows:
            return 0
        headers = {"Authorization": "Bearer " + token} if token else {}
        # Honor TLS verification, avoid accidental localhost requests via system proxy.
        with httpx.Client(timeout=5, trust_env=False) as client:
            response = client.post(url.rstrip("/") + "/api/ingest", json={"samples": [r["sample"] for r in rows]}, headers=headers)
        response.raise_for_status()
        result = response.json()
        if not isinstance(result, dict):
            raise ValueError("invalid server acknowledgement; expected an object")
        accepted, duplicates = result.get("accepted"), result.get("duplicates")
        if (type(accepted) is not int or type(duplicates) is not int or
                min(accepted, duplicates) < 0 or accepted + duplicates != len(rows)):
            raise ValueError("incomplete server acknowledgement; keeping outbox")
        with self.connection() as db:
            db.executemany("DELETE FROM outbox WHERE id=?", [(r["id"],) for r in rows])
        return len(rows)
