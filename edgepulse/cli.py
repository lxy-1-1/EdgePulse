import argparse
import math
import os
import time
import uuid

import httpx
import uvicorn

from .agent import Outbox
from .app import create_app
from .models import Sample


def main():
    parser = argparse.ArgumentParser(description="EdgePulse telemetry engineering lab")
    commands = parser.add_subparsers(dest="command", required=True)
    server = commands.add_parser("serve", help="Start the dashboard and HTTP receiver")
    server.add_argument("--host", default="127.0.0.1")
    server.add_argument("--port", type=int, default=8000)
    server.add_argument("--db", default="data/edgepulse.db")
    agent = commands.add_parser("agent", help="Run a simulated device through a durable HTTP outbox")
    agent.add_argument("--url", default="http://127.0.0.1:8000")
    agent.add_argument("--device", default="edge-sensor-01")
    agent.add_argument("--outbox", default="data/outbox.db")
    agent.add_argument("--offline-seconds", type=float, default=0)
    args = parser.parse_args()
    token = os.getenv("EDGEPULSE_TOKEN") or None
    if args.command == "serve":
        if args.host not in ("127.0.0.1", "localhost", "::1") and not token:
            parser.error("Set EDGEPULSE_TOKEN before binding to a network interface")
        uvicorn.run(create_app(args.db, token), host=args.host, port=args.port)
        return
    queue = Outbox(args.outbox)
    boot = uuid.uuid4().hex
    start = time.monotonic()
    seq = 0
    failures = 0
    next_retry = 0.0
    try:
        while True:
            queue.enqueue(Sample(device_id=args.device, boot_id=boot, seq=seq, ts=int(time.time()*1000),
                                 temperature=45+math.sin(seq/5)*3, vibration=1.2, current=5.2))
            seq += 1
            if time.monotonic() - start >= args.offline_seconds and time.monotonic() >= next_retry:
                try:
                    sent = queue.flush(args.url, token)
                    failures = 0
                    print(f"delivered={sent} pending={queue.count()}", flush=True)
                except (OSError, ValueError, httpx.HTTPError) as error:
                    failures += 1
                    delay = min(30, 2 ** min(failures, 5))
                    next_retry = time.monotonic() + delay
                    print(f"delivery failed ({type(error).__name__}); retry={delay}s pending={queue.count()}", flush=True)
            else:
                print(f"buffering pending={queue.count()}", flush=True)
            time.sleep(1)
    except KeyboardInterrupt:
        print(f"Stopped. {queue.count()} samples remain safely in {args.outbox}")


if __name__ == "__main__":
    main()
