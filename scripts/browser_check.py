"""Exercise the real UI against a real HTTP server and capture delivery screenshots.

Install playwright separately, then: python scripts/browser_check.py --channel chrome
Use --channel chromium with `python -m playwright install chromium` on CI/Linux.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import tempfile
from threading import Thread
import time

import httpx
from playwright.sync_api import sync_playwright, expect
import uvicorn

from edgepulse.app import create_app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--channel", default="chrome")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    artifacts = root / "docs" / "assets"
    artifacts.mkdir(parents=True, exist_ok=True)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="edgepulse-ui-") as temp:
        with open(os.devnull, "w"):
            server = uvicorn.Server(uvicorn.Config(create_app(Path(temp) / "ui.db"), host="127.0.0.1", port=port, log_level="error"))
            thread = Thread(target=server.run, daemon=True)
            thread.start()
            try:
                with httpx.Client(trust_env=False) as client:
                    deadline = time.monotonic() + 20
                    while True:
                        try:
                            if client.get(url + "/health").status_code == 200:
                                break
                        except httpx.HTTPError:
                            pass
                        if time.monotonic() > deadline:
                            raise RuntimeError("test server failed to start")
                        time.sleep(.1)
                with sync_playwright() as p:
                    browser = p.chromium.launch(channel=args.channel, headless=True)
                    page = browser.new_page(viewport={"width": 1440, "height": 1100}, device_scale_factor=1)
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.goto(url)
                    expect(page.locator("#connection-text")).to_have_text("实时连接")
                    page.locator("#demo-toggle").click()
                    expect(page.locator("#stat-total")).to_have_text("4", timeout=10000)
                    expect(page.locator("#chart-empty")).to_be_hidden(timeout=10000)
                    page.locator("#scenario").select_option("overheat")
                    page.locator("#apply-scenario").click()
                    expect(page.locator("#stat-alerts")).to_have_text("1", timeout=12000)
                    expect(page.locator("#alerts-list")).to_contain_text("温度过高")
                    page.locator("#toast").wait_for(state="hidden", timeout=8000)
                    page.screenshot(path=str(artifacts / "overview.png"), full_page=True)
                    page.get_by_role("button", name="确认告警", exact=True).click()
                    expect(page.locator("#alerts-list")).to_contain_text("已确认")
                    page.locator("#scenario").select_option("normal")
                    page.locator("#apply-scenario").click()
                    expect(page.locator("#stat-alerts")).to_have_text("0", timeout=12000)
                    expect(page.locator("#alerts-list")).to_contain_text("已恢复")
                    page.locator('[data-view="replay"]').click()
                    expect(page.locator("#play-replay")).to_be_enabled()
                    page.locator("#play-replay").click()
                    expect(page.locator("#play-replay")).to_have_text("Ⅱ 暂停")
                    page.wait_for_function("Number(document.getElementById('replay-position').value) >= 3")
                    page.locator("#play-replay").click()
                    page.locator("#replay-position").fill("50")
                    expect(page.locator("#replay-progress")).to_contain_text("51 /")
                    page.locator("#toast").wait_for(state="hidden", timeout=8000)
                    page.screenshot(path=str(artifacts / "replay.png"), full_page=True)
                    with page.expect_download() as download:
                        page.locator("#export").click()
                    assert download.value.suggested_filename.endswith("telemetry.csv")
                    page.locator('[data-view="overview"]').click()
                    page.locator("#scenario").select_option("offline")
                    page.locator("#apply-scenario").click()
                    expect(page.locator("#stat-online")).to_have_text("3", timeout=12000)
                    page.locator("#scenario").select_option("normal")
                    page.locator("#apply-scenario").click()
                    expect(page.locator("#stat-online")).to_have_text("4", timeout=10000)
                    page.set_viewport_size({"width": 390, "height": 844})
                    page.locator("#toast").wait_for(state="hidden", timeout=8000)
                    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "mobile document overflows"
                    page.screenshot(path=str(artifacts / "mobile.png"), full_page=True)
                    page.locator("#demo-toggle").click()
                    expect(page.locator("#demo-state")).to_have_text("未启动")
                    assert not errors, errors
                    browser.close()
                print(json.dumps({"passed": True, "browser": args.channel,
                                  "checks": ["websocket", "demo", "overheat", "acknowledge", "recovery", "replay", "seek", "csv", "offline", "mobile", "stop"],
                                  "javascript_errors": errors}, ensure_ascii=False))
            finally:
                server.should_exit = True
                thread.join(timeout=15)
                assert not thread.is_alive(), "test server did not shut down"


if __name__ == "__main__":
    main()
