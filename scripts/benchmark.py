"""Reproducible single-writer storage benchmark; does not claim HTTP throughput."""
import argparse
import json
import os
import platform
from pathlib import Path
import statistics
import sys
import tempfile
import time

from edgepulse.models import Sample
from edgepulse.store import Store


def percentile(values, p):
    ordered = sorted(values)
    return ordered[min(len(ordered)-1, int((len(ordered)-1)*p))]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=int, default=10000)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--output", default="work/benchmark.json")
    args = parser.parse_args()
    if args.samples < 1 or not 1 <= args.batch_size <= 500 or args.repeat < 1:
        parser.error("positive samples/repeats and batch-size 1..500 required")
    reports = []
    for run in range(args.repeat):
        with tempfile.TemporaryDirectory(prefix="edgepulse-bench-") as directory:
            store = Store(Path(directory)/"bench.db")
            points = [Sample(device_id=f"bench-{i%10}", boot_id="bench", seq=i//10,
                             ts=1700000000000+i*10, temperature=40+i%5, vibration=1, current=5)
                      for i in range(args.samples)]
            durations = []
            start = time.perf_counter()
            for i in range(0, args.samples, args.batch_size):
                batch_start = time.perf_counter()
                store.ingest(points[i:i+args.batch_size])
                durations.append((time.perf_counter()-batch_start)*1000)
            elapsed = time.perf_counter()-start
            snapshot = store.snapshot()
            assert snapshot["stats"]["accepted"] == args.samples
            duplicate_count = 0
            for i in range(0, args.samples, args.batch_size):
                duplicate_count += store.ingest(points[i:i+args.batch_size])["duplicates"]
            assert duplicate_count == args.samples
            assert store.snapshot()["stats"]["accepted"] == args.samples
            reports.append({"run":run+1,"seconds":round(elapsed,4),"samples_per_second":round(args.samples/elapsed),
                            "batch_latency_ms":{"p50":round(statistics.median(durations),3),"p95":round(percentile(durations,.95),3),"p99":round(percentile(durations,.99),3)},
                            "accepted":args.samples,"retransmissions_deduplicated":duplicate_count})
    result = {"method":"Direct Store.ingest, real SQLite WAL file, synchronous=FULL default, one writer. Models prevalidated; excludes HTTP, network and device collection. Fresh database per run; no warm-up.",
              "environment":{"python":sys.version.split()[0],"os":platform.system()+" "+platform.release(),"logical_cpus":os.cpu_count(),"sqlite":__import__('sqlite3').sqlite_version},
              "samples":args.samples,"batch_size":args.batch_size,"devices":10,"runs":reports}
    output = Path(args.output)
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__ == "__main__":
    main()
