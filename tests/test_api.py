import time

import pytest
from fastapi.testclient import TestClient

from edgepulse.app import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / "api.db")) as client:
        yield client


def payload(**changes):
    sample = dict(device_id="sensor-01", boot_id="boot", seq=0, ts=int(time.time()*1000),
                  temperature=40, vibration=1, current=5)
    sample.update(changes)
    return {"samples": [sample]}


def test_http_ingestion_history_and_conflict(client):
    data = payload()
    assert client.post("/api/ingest", json=data).json()["accepted"] == 1
    assert client.post("/api/ingest", json=data).json()["duplicates"] == 1
    data["samples"][0]["temperature"] = 99
    assert client.post("/api/ingest", json=data).status_code == 409
    assert client.get("/api/history/sensor-01").json()[0]["temperature"] == 40


@pytest.mark.parametrize("changes", [dict(seq=-1), dict(ts=int(time.time()*1000)+120000),
    dict(temperature="NaN"), dict(device_id="<script>"), dict(vibration=-1), dict(seq=True)])
def test_invalid_samples_are_rejected_without_writes(client, changes):
    assert client.post("/api/ingest", json=payload(**changes)).status_code == 422
    assert client.get("/api/snapshot").json()["stats"]["accepted"] == 0


def test_empty_and_oversized_batches_rejected(client):
    assert client.post("/api/ingest", json={"samples": []}).status_code == 422
    assert client.post("/api/ingest", json={"samples": payload()["samples"] * 501}).status_code == 422


def test_nonstandard_json_nan_returns_validation_error_not_server_error(client):
    import json
    data = payload()
    data["samples"][0]["temperature"] = float("nan")
    response = client.post("/api/ingest", content=json.dumps(data), headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert client.get("/api/snapshot").json()["stats"]["accepted"] == 0


def test_token_protects_reads_writes_and_websocket(tmp_path):
    with TestClient(create_app(tmp_path / "secure.db", token="test-secret")) as client:
        assert client.get("/api/snapshot").status_code == 401
        assert client.post("/api/ingest", json=payload()).status_code == 401
        assert client.get("/api/snapshot", headers={"Authorization": "Bearer test-secret"}).status_code == 200
        with client.websocket_connect("/ws") as ws:
            ws.send_json({"token": "test-secret"})
            assert ws.receive_json()["stats"]["accepted"] == 0


def test_history_bounds_and_csv(client):
    client.post("/api/ingest", json=payload())
    assert client.get("/api/history/sensor-01?limit=10001").status_code == 422
    assert client.get("/api/history/sensor-01?from_ts=20&to_ts=10").status_code == 422
    result = client.get("/api/export/sensor-01")
    assert "text/csv" in result.headers["content-type"]
    assert "device_id,boot_id,seq,ts,temperature,vibration,current" in result.text
    assert "sensor-01" in result.text


def test_unknown_alert_returns_not_found(client):
    assert client.post("/api/alerts/999/ack").status_code == 404


def test_history_earliest_anchor_keeps_event_following_samples(client):
    data = payload()
    start = data["samples"][0]["ts"] - 10000
    data["samples"] = [dict(data["samples"][0], seq=i, ts=start+i*20) for i in range(10)]
    client.post("/api/ingest", json=data)
    result = client.get(f"/api/history/sensor-01?from_ts={start+40}&limit=3&earliest=true")
    assert [row["seq"] for row in result.json()] == [2, 3, 4]


def test_demo_start_fault_and_stop(client):
    assert client.post("/api/demo", json={"action": "start"}).json()["running"]
    assert client.post("/api/demo", json={"action": "overheat"}).json()["scenario"] == "overheat"
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        snapshot = client.get("/api/snapshot").json()
        if snapshot["stats"]["devices"] == 4:
            break
        time.sleep(0.05)
    assert snapshot["stats"]["devices"] == 4
    assert not client.post("/api/demo", json={"action": "stop"}).json()["running"]
