# EdgePulse Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a runnable and tested telemetry reliability and fault monitoring portfolio project, then publish to the user's private GitHub repository.

**Architecture:** SQLite transactions own durable samples, device state, alert debounce and audit. FastAPI exposes authenticated ingestion and dashboard APIs. A separate durable edge agent exercises at-least-once delivery over HTTP.

**Tech Stack:** Python 3.10+, FastAPI, SQLite, vanilla browser JavaScript, pytest, Playwright for UI verification.

**Spec:** ../specs/2026-09-18-edgepulse-design.md

## Global Constraints

- Independent EdgePulse directory and Git repository; sole user Git authorship.
- Localhost default; configurable API token; no secrets in repository.
- Simulated data explicitly labeled; measured benchmark with conditions.
- No external frontend assets, paid services or hardware required.

## Tasks

- [x] 1. Core contracts and persistence: tests/test_store.py specifies dedup, atomic conflict rollback, late points, persistent debounce and hysteresis, acknowledgement. Implement edgepulse/models.py and store.py. Run `python -m pytest tests/test_store.py -q`.
- [x] 2. API and simulation: tests/test_api.py specifies invalid input, authentication, bounded history, CSV and demo controls. Implement edgepulse/app.py and simulator.py. Run `python -m pytest tests/test_api.py -q`.
- [x] 3. Durable edge agent: tests/test_agent.py specifies retention on lost acknowledgement and replay across restart. Implement edgepulse/agent.py. Run `python -m pytest tests/test_agent.py -q`.
- [x] 4. Dashboard: build edgepulse/static/index.html, style.css, app.js. Browser exercise real server: start demo, select fault, inspect alert, acknowledge, recover and replay history. Capture screenshot and check mobile layout.
- [ ] 5. Delivery: add CLI, pyproject.toml, Dockerfile, workflow, README and architecture/demo docs. Run full pytest, measured benchmark, package build and fresh installation smoke check. Review staged files for secrets and generated artifacts, commit with user identity, create private repo and push; compare local HEAD to remote main.

## Core test contracts

```python
result = store.ingest([sample])
assert result['accepted'] == 1
assert store.ingest([sample])['duplicates'] == 1
assert len(store.history('pump-01')) == 1
# Conflicting content with the same device/boot/seq must roll back the batch.
with pytest.raises(ConflictError):
    store.ingest([next_sample, changed_original])
assert len(store.history('pump-01')) == 1
```

API contract: `create_app(db_path, token=None)`; `POST /api/ingest` receives `{"samples": [...]}` and returns accepted/duplicates/late counts. `GET /api/snapshot` returns devices, alerts, stats and demo state. `GET /api/history/{device_id}` accepts from_ts/to_ts/limit. Outbox contract: `enqueue(sample)`, `pending(limit)`, `flush(url, token=None)`, `count()`.
