"""Same-origin HTTP/WebSocket application. Run one worker per database."""
import asyncio
import csv
import hmac
import io
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .models import Batch, DemoCommand, RULES
from .simulator import Simulator
from .store import ConflictError, Store


def create_app(db_path="data/edgepulse.db", token=None):
    store = Store(db_path)
    simulator = Simulator(store)

    @asynccontextmanager
    async def lifespan(app):
        yield
        await simulator.command("stop")

    app = FastAPI(title="EdgePulse", version="0.1.0", lifespan=lifespan,
                  description="Durable telemetry & deterministic fault simulation. Single-instance laboratory.")
    app.state.store = store

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        # Echoing raw inputs can itself fail JSON encoding for NaN/Infinity.
        # Return the location and reason without reflecting arbitrary payloads.
        return JSONResponse(status_code=422, content={"detail": [
            {"loc": item["loc"], "msg": item["msg"], "type": item["type"]}
            for item in error.errors()
        ]})

    def authorize(request: Request, authorization: str = Header(default="")):
        origin = request.headers.get("origin")
        if origin and urlparse(origin).netloc != request.headers.get("host"):
            raise HTTPException(403, "cross-origin API access is disabled")
        if token and not hmac.compare_digest(authorization, "Bearer " + token):
            raise HTTPException(401, "Bearer token required", headers={"WWW-Authenticate": "Bearer"})

    api = APIRouter(prefix="/api", dependencies=[Depends(authorize)])

    @api.post("/ingest")
    def ingest(batch: Batch):
        try:
            return store.ingest(batch.samples)
        except ConflictError as error:
            raise HTTPException(409, str(error)) from error

    def snapshot():
        return {**store.snapshot(), "demo": simulator.status(), "rules": RULES}

    @api.get("/snapshot")
    def get_snapshot():
        return snapshot()

    @api.get("/history/{device_id}")
    def history(device_id: str, from_ts: int = Query(0, ge=0),
                to_ts: int = Query(2**53-1, ge=0), limit: int = Query(600, ge=1, le=10000),
                earliest: bool = False):
        if from_ts > to_ts:
            raise HTTPException(422, "from_ts must be <= to_ts")
        return store.history(device_id, from_ts, to_ts, limit, earliest=earliest)

    @api.get("/export/{device_id}")
    def export(device_id: str):
        rows = store.history(device_id, limit=10000)
        output = io.StringIO(newline="")
        writer = csv.DictWriter(output, fieldnames=["device_id", "boot_id", "seq", "ts", "temperature", "vibration", "current"])
        writer.writeheader()
        writer.writerows(rows)
        return Response(output.getvalue(), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": 'attachment; filename="edgepulse-telemetry.csv"'})

    @api.post("/alerts/{alert_id}/ack")
    def acknowledge(alert_id: int):
        if not store.acknowledge(alert_id):
            raise HTTPException(404, "alert missing or no longer open")
        return {"acknowledged": True}

    @api.get("/alerts/{alert_id}/audit")
    def audit(alert_id: int):
        return store.audit(alert_id)

    @api.post("/demo")
    async def demo(command: DemoCommand):
        return await simulator.command(command.action)

    @app.get("/health")
    def health():
        return {"status": "ok", "version": "0.1.0"}

    @app.websocket("/ws")
    async def websocket(ws: WebSocket):
        origin = ws.headers.get("origin")
        if origin and urlparse(origin).netloc != ws.headers.get("host"):
            await ws.close(code=1008)
            return
        await ws.accept()
        try:
            hello = await asyncio.wait_for(ws.receive_json(), timeout=5)
            supplied = hello.get("token", "") if isinstance(hello, dict) else ""
            if token and (not isinstance(supplied, str) or not hmac.compare_digest(supplied, token)):
                await ws.close(code=1008)
                return
            while True:
                await ws.send_json(await asyncio.to_thread(snapshot))
                try:
                    await asyncio.wait_for(ws.receive_text(), timeout=1)
                except asyncio.TimeoutError:
                    pass
        except (WebSocketDisconnect, asyncio.TimeoutError, ValueError):
            return

    static = Path(__file__).parent / "static"
    if static.exists():
        app.mount("/static", StaticFiles(directory=static), name="static")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(static / "index.html")

    app.include_router(api)
    return app
