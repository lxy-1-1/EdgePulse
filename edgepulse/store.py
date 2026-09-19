"""Transactional telemetry store. One batch commits samples, state and alerts atomically."""
import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from .models import RULES, Sample


class ConflictError(ValueError):
    """An existing idempotency key was reused with a different payload."""


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS samples (
                    id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, boot_id TEXT NOT NULL,
                    seq INTEGER NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL,
                    UNIQUE(device_id, boot_id, seq));
                CREATE INDEX IF NOT EXISTS samples_device_time ON samples(device_id, ts, id);
                CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, state TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS alerts (
                    id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, metric TEXT NOT NULL,
                    status TEXT NOT NULL, opened_at INTEGER NOT NULL, recovered_at INTEGER,
                    acknowledged_at INTEGER, value REAL NOT NULL);
                CREATE UNIQUE INDEX IF NOT EXISTS active_alert ON alerts(device_id, metric)
                    WHERE status != 'recovered';
                CREATE TABLE IF NOT EXISTS audit (
                    id INTEGER PRIMARY KEY, alert_id INTEGER NOT NULL, action TEXT NOT NULL,
                    ts INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
            """)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _increment(db, name, value):
        db.execute("INSERT INTO counters VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=value+excluded.value",
                   (name, value))

    def ingest(self, samples: list[Sample]):
        counts = {"accepted": 0, "duplicates": 0, "late": 0, "sequence_gaps": 0}
        now = int(time.time() * 1000)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            for sample in samples:
                payload = sample.model_dump_json()
                existing = db.execute("SELECT payload FROM samples WHERE device_id=? AND boot_id=? AND seq=?",
                                      (sample.device_id, sample.boot_id, sample.seq)).fetchone()
                if existing:
                    if existing["payload"] != payload:
                        raise ConflictError(f"conflicting sample: {sample.device_id}/{sample.boot_id}/{sample.seq}")
                    counts["duplicates"] += 1
                    continue
                db.execute("INSERT INTO samples(device_id,boot_id,seq,ts,payload) VALUES (?,?,?,?,?)",
                           (sample.device_id, sample.boot_id, sample.seq, sample.ts, payload))
                counts["accepted"] += 1
                previous = db.execute("SELECT state FROM devices WHERE device_id=?", (sample.device_id,)).fetchone()
                state = json.loads(previous["state"]) if previous else {}
                same_boot = state.get("boot_id") == sample.boot_id
                late = bool(state) and (sample.ts < state["ts"] or
                       (same_boot and sample.seq <= state["seq"]) or
                       (not same_boot and sample.ts == state["ts"]))
                if late:
                    counts["late"] += 1
                    continue
                if same_boot:
                    counts["sequence_gaps"] += max(0, sample.seq - state["seq"] - 1)
                ewma = state.get("temperature_ewma", sample.temperature)
                debounce = state.get("debounce", {})
                state.update(sample.model_dump())
                state.update(last_seen=now, temperature_ewma=round(0.2 * sample.temperature + 0.8 * ewma, 4))
                state["debounce"] = debounce
                self._evaluate(db, state)
                db.execute("INSERT INTO devices VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET state=excluded.state",
                           (sample.device_id, json.dumps(state)))
            for name, count in counts.items():
                self._increment(db, name, count)
        return counts

    @staticmethod
    def _evaluate(db, state):
        for metric, rule in RULES.items():
            value = state[metric]
            streak = state["debounce"].setdefault(metric, {"high": 0, "low": 0})
            streak["high"] = min(3, streak["high"] + 1) if value > rule["high"] else 0
            streak["low"] = min(3, streak["low"] + 1) if value < rule["low"] else 0
            alert = db.execute("SELECT id FROM alerts WHERE device_id=? AND metric=? AND status!='recovered'",
                               (state["device_id"], metric)).fetchone()
            if not alert and streak["high"] >= 3:
                cursor = db.execute("INSERT INTO alerts(device_id,metric,status,opened_at,value) VALUES (?,?,'open',?,?)",
                                    (state["device_id"], metric, state["ts"], value))
                db.execute("INSERT INTO audit(alert_id,action,ts) VALUES (?,'opened',?)", (cursor.lastrowid, state["ts"]))
            elif alert and streak["low"] >= 3:
                db.execute("UPDATE alerts SET status='recovered',recovered_at=? WHERE id=?", (state["ts"], alert["id"]))
                db.execute("INSERT INTO audit(alert_id,action,ts) VALUES (?,'recovered',?)", (alert["id"], state["ts"]))

    def acknowledge(self, alert_id):
        now = int(time.time() * 1000)
        with self.connection() as db:
            cursor = db.execute("UPDATE alerts SET status='acknowledged',acknowledged_at=? WHERE id=? AND status='open'",
                                (now, alert_id))
            if cursor.rowcount:
                db.execute("INSERT INTO audit(alert_id,action,ts) VALUES (?,'acknowledged',?)", (alert_id, now))
            return bool(cursor.rowcount)

    def audit(self, alert_id):
        with self.connection() as db:
            return [dict(row) for row in db.execute("SELECT * FROM audit WHERE alert_id=? ORDER BY id", (alert_id,))]

    def history(self, device_id, from_ts=0, to_ts=2**53 - 1, limit=600, earliest=False):
        with self.connection() as db:
            direction = "ASC" if earliest else "DESC"
            rows = db.execute(f"SELECT payload FROM samples WHERE device_id=? AND ts BETWEEN ? AND ? ORDER BY ts {direction},id {direction} LIMIT ?",
                              (device_id, from_ts, to_ts, min(max(limit, 1), 10000))).fetchall()
            return [json.loads(row["payload"]) for row in (rows if earliest else reversed(rows))]

    def snapshot(self):
        now = int(time.time() * 1000)
        with self.connection() as db:
            db.execute("BEGIN")
            devices = [json.loads(row["state"]) for row in db.execute("SELECT state FROM devices ORDER BY device_id")]
            active = [dict(row) for row in db.execute("SELECT * FROM alerts WHERE status!='recovered' ORDER BY id DESC LIMIT 500")]
            recovered = [dict(row) for row in db.execute("SELECT * FROM alerts WHERE status='recovered' ORDER BY id DESC LIMIT 50")]
            active_count = db.execute("SELECT COUNT(*) FROM alerts WHERE status!='recovered'").fetchone()[0]
            stats = {name: 0 for name in ("accepted", "duplicates", "late", "sequence_gaps")}
            stats.update({row["name"]: row["value"] for row in db.execute("SELECT * FROM counters")})
        active_devices = {alert["device_id"] for alert in active}
        for device in devices:
            device.pop("debounce", None)
            device["status"] = "offline" if now - device["last_seen"] > 5000 else (
                "warning" if device["device_id"] in active_devices else "healthy")
        stats.update(devices=len(devices), active_alerts=active_count,
                     online=sum(d["status"] != "offline" for d in devices))
        return {"devices": devices, "alerts": active + recovered, "stats": stats, "server_time": now}
