"""Deterministic synthetic fleet. Demo traffic is explicitly prefixed demo-."""
import asyncio
import math
import time
import uuid

from .models import Sample


class Simulator:
    def __init__(self, store):
        self.store = store
        self.task = None
        self.scenario = "normal"
        self.boot_id = ""
        self.seq = 0
        self.stop_requested = asyncio.Event()
        self.lifecycle_lock = asyncio.Lock()

    def status(self):
        return {"running": self.task is not None and not self.task.done(),
                "scenario": self.scenario, "source": "synthetic", "target": "demo-pump-01"}

    async def command(self, action):
        async with self.lifecycle_lock:
            return await self._command(action)

    async def _command(self, action):
        if action == "stop":
            if self.task:
                # Cooperative shutdown joins the current to_thread write. Cancelling
                # the coroutine would leave its SQLite worker running after stop.
                self.stop_requested.set()
                await self.task
                self.task = None
        elif action == "start":
            if not self.status()["running"]:
                self.scenario = "normal"
                self.boot_id = "demo-" + uuid.uuid4().hex[:12]
                self.seq = 0
                self.stop_requested.clear()
                self.task = asyncio.create_task(self.run())
        else:
            self.scenario = action
        return self.status()

    def batch(self, ts):
        points = []
        for index, name in enumerate(("pump-01", "motor-02", "fan-03", "compressor-04")):
            if index == 0 and self.scenario == "offline":
                continue
            wave = math.sin(self.seq / 6 + index)
            temperature = 43 + index * 5 + wave * 3 + math.sin(self.seq / 2) * 0.5
            vibration = 1.1 + index * 0.3 + wave * 0.15
            if index == 0 and self.scenario == "overheat":
                temperature = 85 + wave * 2
            if index == 0 and self.scenario == "vibration":
                vibration = 6.5 + wave * 0.4
            points.append(Sample(device_id="demo-" + name, boot_id=self.boot_id,
                                 seq=self.seq, ts=ts, temperature=round(temperature, 2),
                                 vibration=round(vibration, 3), current=round(4.2 + index + wave * 0.3, 2)))
        self.seq += 1
        return points

    async def run(self):
        # Seed one minute of labeled synthetic history so replay is immediately useful.
        start = int(time.time() * 1000) - 60_000
        history = []
        for tick in range(60):
            history.extend(self.batch(start + tick * 1000))
        await asyncio.to_thread(self.store.ingest, history)
        while not self.stop_requested.is_set():
            await asyncio.to_thread(self.store.ingest, self.batch(int(time.time() * 1000)))
            try:
                await asyncio.wait_for(self.stop_requested.wait(), timeout=1)
            except asyncio.TimeoutError:
                pass
