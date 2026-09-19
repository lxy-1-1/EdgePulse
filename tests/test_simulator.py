import asyncio
from threading import Event

from edgepulse.simulator import Simulator
from edgepulse.store import Store


def test_stop_waits_for_inflight_database_commit(tmp_path):
    entered, release = Event(), Event()

    class SlowStore(Store):
        def ingest(self, points):
            entered.set()
            assert release.wait(3)
            return super().ingest(points)

    async def exercise():
        store = SlowStore(tmp_path / "slow.db")
        simulator = Simulator(store)
        await simulator.command("start")
        assert await asyncio.to_thread(entered.wait, 2)
        stop = asyncio.create_task(simulator.command("stop"))
        try:
            await asyncio.sleep(.03)
            assert not stop.done(), "stop must wait for the in-flight transaction"
        finally:
            release.set()
            await stop
        assert not simulator.status()["running"]
        count = store.snapshot()["stats"]["accepted"]
        assert count == 240
        await asyncio.sleep(.02)
        assert store.snapshot()["stats"]["accepted"] == count

    asyncio.run(exercise())
