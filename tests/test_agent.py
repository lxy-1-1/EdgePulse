import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

from edgepulse.agent import Outbox
from edgepulse.models import Sample


def sample():
    return Sample(device_id="edge-01", boot_id="abc", seq=0, ts=1700000000000,
                  temperature=40, vibration=1, current=5)


@pytest.fixture
def endpoint():
    class Handler(BaseHTTPRequestHandler):
        mode = "ok"
        received = []

        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            self.received.extend(data["samples"])
            self.send_response(503 if self.mode == "fail" else 200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            body = [] if self.mode == "malformed" else {"accepted": len(data["samples"]) if self.mode == "ok" else 0, "duplicates": 0}
            self.wfile.write(json.dumps(body).encode())

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}", Handler
    server.shutdown()
    server.server_close()
    thread.join()


def test_outbox_persists_across_restart(tmp_path):
    path = tmp_path / "outbox.db"
    Outbox(path).enqueue(sample())
    assert Outbox(path).count() == 1
    assert Outbox(path).pending()[0]["sample"]["device_id"] == "edge-01"


def test_http_failure_preserves_queue_until_success(tmp_path, endpoint):
    url, handler = endpoint
    queue = Outbox(tmp_path / "outbox.db")
    queue.enqueue(sample())
    handler.mode = "fail"
    with pytest.raises(Exception):
        queue.flush(url)
    assert queue.count() == 1
    handler.mode = "ok"
    assert queue.flush(url) == 1
    assert queue.count() == 0
    assert len(handler.received) == 2


def test_partial_acknowledgement_never_deletes_unsent_data(tmp_path, endpoint):
    url, handler = endpoint
    queue = Outbox(tmp_path / "outbox.db")
    queue.enqueue(sample())
    handler.mode = "partial"
    with pytest.raises(ValueError, match="acknowledgement"):
        queue.flush(url)
    assert queue.count() == 1


def test_non_object_ack_is_retryable_and_preserves_queue(tmp_path, endpoint):
    url, handler = endpoint
    queue = Outbox(tmp_path / "outbox.db")
    queue.enqueue(sample())
    handler.mode = "malformed"
    with pytest.raises(ValueError, match="acknowledgement"):
        queue.flush(url)
    assert queue.count() == 1
    handler.mode = "ok"
    assert queue.flush(url) == 1
