import pytest

from edgepulse.models import Sample
from edgepulse.store import ConflictError, Store


def point(seq=0, temperature=40, vibration=1, current=5, ts=None, boot_id="boot-a"):
    return Sample(device_id="pump-01", boot_id=boot_id, seq=seq,
                  ts=1700000000000 + seq * 1000 if ts is None else ts,
                  temperature=temperature, vibration=vibration, current=current)


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "telemetry.db")


def test_duplicate_delivery_is_idempotent(store):
    assert store.ingest([point()])["accepted"] == 1
    assert store.ingest([point()])["duplicates"] == 1
    assert len(store.history("pump-01")) == 1


def test_conflicting_retransmission_rolls_back_entire_batch(store):
    store.ingest([point()])
    with pytest.raises(ConflictError):
        store.ingest([point(1), point(0, temperature=99)])
    assert len(store.history("pump-01")) == 1
    assert store.snapshot()["stats"]["accepted"] == 1


def test_late_sample_is_stored_but_does_not_regress_live_state(store):
    store.ingest([point(10, temperature=50)])
    assert store.ingest([point(2, temperature=99)])["late"] == 1
    assert store.snapshot()["devices"][0]["temperature"] == 50
    assert len(store.history("pump-01")) == 2


def test_boot_id_allows_sequence_reset(store):
    store.ingest([point(10)])
    store.ingest([point(0, ts=1700000020000, boot_id="boot-b")])
    assert len(store.history("pump-01")) == 2
    assert store.snapshot()["devices"][0]["boot_id"] == "boot-b"


def test_three_consecutive_high_samples_open_one_alert(store):
    store.ingest([point(0, temperature=80), point(1, temperature=80)])
    assert store.snapshot()["alerts"] == []
    store.ingest([point(2, temperature=80), point(3, temperature=90)])
    alerts = store.snapshot()["alerts"]
    assert len(alerts) == 1
    assert alerts[0]["status"] == "open"
    assert alerts[0]["metric"] == "temperature"


def test_nonconsecutive_spikes_do_not_open_alert(store):
    store.ingest([point(0, temperature=80), point(1), point(2, temperature=80)])
    assert store.snapshot()["alerts"] == []


def test_hysteresis_and_ack_do_not_pretend_fault_recovered(store):
    store.ingest([point(i, temperature=80) for i in range(3)])
    alert_id = store.snapshot()["alerts"][0]["id"]
    assert store.acknowledge(alert_id)
    assert not store.acknowledge(alert_id)
    store.ingest([point(i, temperature=72) for i in range(3, 6)])
    assert store.snapshot()["alerts"][0]["status"] == "acknowledged"
    store.ingest([point(i, temperature=65) for i in range(6, 9)])
    assert store.snapshot()["alerts"][0]["status"] == "recovered"
    assert len(store.audit(alert_id)) == 3


def test_debounce_survives_service_restart(tmp_path):
    path = tmp_path / "persist.db"
    Store(path).ingest([point(0, vibration=6), point(1, vibration=6)])
    restarted = Store(path)
    restarted.ingest([point(2, vibration=6)])
    assert restarted.snapshot()["alerts"][0]["metric"] == "vibration"


def test_late_high_samples_do_not_trigger_alerts(store):
    store.ingest([point(10)])
    store.ingest([point(i, temperature=90) for i in range(3)])
    assert store.snapshot()["alerts"] == []


def test_history_time_filter_and_order(store):
    store.ingest([point(3), point(1), point(2)])
    rows = store.history("pump-01", from_ts=1700000002000, to_ts=1700000003000)
    assert [r["seq"] for r in rows] == [2, 3]
    assert [r["seq"] for r in store.history("pump-01", limit=2)] == [2, 3]


def test_gap_counter_counts_forward_holes_only(store):
    store.ingest([point(0), point(3), point(1)])
    assert store.snapshot()["stats"]["sequence_gaps"] == 2


def test_ewma_smooths_live_temperature(store):
    store.ingest([point(0, temperature=40), point(1, temperature=60)])
    assert store.snapshot()["devices"][0]["temperature_ewma"] == 44


def test_dense_event_window_can_fetch_first_samples_after_event(store):
    store.ingest([point(i, ts=1700000000000+i*20) for i in range(2500)])
    rows = store.history("pump-01", from_ts=1700000002000, limit=30, earliest=True)
    assert [r["seq"] for r in rows] == list(range(100, 130))
