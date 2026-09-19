"use strict";
const $ = (id) => document.getElementById(id);
const labels = {
  temperature: "温度",
  vibration: "振动",
  current: "电流"
};
const units = {
  temperature: "°C",
  vibration: "mm/s",
  current: "A"
};
const statusNames = {
  healthy: "正常",
  warning: "异常",
  offline: "离线",
  open: "待确认",
  acknowledged: "已确认",
  recovered: "已恢复"
};
const state = {
  token: "",
  snapshot: null,
  device: null,
  metric: "temperature",
  history: [],
  replay: [],
  replayIndex: 0,
  playing: null,
  ws: null,
  reconnect: null,
  retry: 1000,
  view: "overview",
  historyRequest: 0,
  replayRequest: 0,
  filter: "all",
  windowSize: 120,
  frozen: false,
  focusTs: null,
  hoverTs: null
};
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, c => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
} [c]));
const number = value => Number(value).toLocaleString("en-US");
const timeLabel = ts => new Date(ts).toLocaleTimeString("zh-CN", {
  hour12: false
});

function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").hidden = true, 4200);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? {
        "Content-Type": "application/json"
      } : {}),
      ...(state.token ? {
        Authorization: `Bearer ${state.token}`
      } : {})
    }
  });
  if (!response.ok) {
    if (response.status === 401 && !$("token-dialog").open) $("token-dialog").showModal();
    let detail = "";
    try {
      detail = (await response.json()).detail;
    } catch (_) {
      /* Non-JSON proxy error. */
    }
    throw new Error(response.status === 401 ? "请输入正确的访问令牌" : `请求失败 (${response.status})${typeof detail==="string"?": "+detail:""}`);
  }
  return response;
}

function setConnection(online, text) {
  $("connection-text").textContent = text;
  $("connection-dot").classList.toggle("muted-dot", !online);
}

function connect() {
  clearTimeout(state.reconnect);
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
  }
  setConnection(false, "正在连接");
  const ws = new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({
    token: state.token
  }));
  ws.onmessage = event => {
    state.retry = 1000;
    setConnection(true, "实时连接");
    renderSnapshot(JSON.parse(event.data));
  };
  ws.onclose = event => {
    if (event.code === 1008) {
      setConnection(false, "需要认证");
      if (!$("token-dialog").open) $("token-dialog").showModal();
      return;
    }
    setConnection(false, "连接中断 · 重试中");
    state.reconnect = setTimeout(connect, state.retry);
    state.retry = Math.min(10000, state.retry * 2);
  };
  ws.onerror = () => setConnection(false, "连接暂不可用");
}


const deviceNames = {
  "demo-pump-01": "水泵 01",
  "demo-motor-02": "电机 02",
  "demo-fan-03": "风机 03",
  "demo-compressor-04": "压缩机 04"
};
const metricColors = {
  temperature: "#4978b8",
  vibration: "#57978b",
  current: "#9585ad"
};

function deviceName(id) {
  return deviceNames[id] || id || "选择设备";
}

function selectedAlerts(device = state.device) {
  return (state.snapshot?.alerts || []).filter(a => a.device_id === device);
}

function windowRows(rows = state.history) {
  if (!rows.length) return [];
  if (state.focusTs !== null) {
    const center = nearestIndex(rows, state.focusTs);
    const from = Math.max(0, Math.min(rows.length - state.windowSize, center - Math.floor(state.windowSize / 2)));
    return rows.slice(from, from + state.windowSize);
  }
  return rows.slice(-state.windowSize);
}

function nearestIndex(rows, ts) {
  return rows.reduce((best, row, i) => Math.abs(row.ts - ts) < Math.abs(rows[best].ts - ts) ? i : best, 0);
}

function renderSnapshot(snapshot) {
  state.snapshot = snapshot;
  for (const [id, key] of [
      ["stat-online", "online"],
      ["stat-total", "devices"],
      ["stat-alerts", "active_alerts"],
      ["stat-accepted", "accepted"],
      ["stat-duplicates", "duplicates"],
      ["stat-late", "late"],
      ["stat-gaps", "sequence_gaps"]
    ]) {
    $(id).textContent = number(snapshot.stats[key]);
  }
  $("fleet-count").textContent = `${snapshot.stats.devices} 个节点`;
  $("demo-toggle").textContent = snapshot.demo.running ? "Ⅱ 停止演示" : "▶ 启动演示";
  $("demo-state").textContent = snapshot.demo.running ? "运行中" : "未启动";
  $("apply-scenario").disabled = !snapshot.demo.running;
  if (!state.device && snapshot.devices.length) state.device = snapshot.devices.find(d => d.device_id === snapshot.demo.target)?.device_id || snapshot.devices[0].device_id;
  const signature = snapshot.devices.map(d => d.device_id).join(",");
  if ($("replay-device").dataset.signature !== signature) {
    $("replay-device").innerHTML = snapshot.devices.map(d => `<option value="${escapeHTML(d.device_id)}">${escapeHTML(deviceName(d.device_id))}</option>`).join("");
    $("replay-device").dataset.signature = signature;
    if (state.device) $("replay-device").value = state.device;
  }
  renderDevices();
  renderDeviceHeading();
  renderAlerts();
  renderLiveChart();
}

function renderDeviceHeading() {
  const d = state.snapshot?.devices.find(d => d.device_id === state.device);
  $("page-title").textContent = deviceName(state.device);
  $("selected-badge").textContent = state.device || "等待设备";
  $("selected-status").textContent = d ? statusNames[d.status] : "未接入";
  $("selected-status").className = `pill ${d?.status || "neutral"}`;
  $("source-label").textContent = d ? (d.device_id.startsWith("demo-") ? "模拟节点" : "HTTP 设备") : "";
  $("last-received").textContent = d ? timeLabel(d.last_seen) : "—";
  $("current-seq").textContent = d ? d.seq : "—";
  $("current-boot").textContent = d ? d.boot_id : "—";
  const active = selectedAlerts().filter(a => a.status !== "recovered");
  $("fault-banner").hidden = !active.length;
  $("fault-banner").innerHTML = active.length ? `<strong>${escapeHTML(state.snapshot.rules[active[0].metric].label)}</strong><span>${active.length} 项异常待恢复</span><small>确认告警不会关闭异常</small>` : "";
}

function renderDevices() {
  const query = $("device-search").value.toLowerCase().trim();
  const devices = (state.snapshot?.devices || []).filter(d =>
    (state.filter === "all" || d.status === state.filter) && `${d.device_id} ${deviceName(d.device_id)}`.toLowerCase().includes(query));
  $("devices-body").innerHTML = devices.length ? devices.map(d => {
    const age = Math.max(0, Math.floor((state.snapshot.server_time - d.last_seen) / 1000));
    return `<button class="device-item ${d.device_id===state.device?"selected":""}" data-device="${escapeHTML(d.device_id)}" aria-pressed="${d.device_id===state.device}"><span class="device-item-top"><strong>${escapeHTML(deviceName(d.device_id))}</strong><span class="pill ${d.status}">${statusNames[d.status]}</span></span><code>${escapeHTML(d.device_id)}</code><span class="device-item-bottom"><b>${d.temperature.toFixed(1)} °C</b><span>${age<1?"刚刚":age+" 秒前"}</span></span></button>`;
  }).join("") : `<div class="sidebar-empty">${state.snapshot?.devices.length?"没有匹配的设备":"暂无接入设备"}</div>`;
}

function renderAlerts() {
  const alerts = selectedAlerts();
  $("alert-count").textContent = alerts.length;
  $("alerts-list").innerHTML = alerts.length ? alerts.map(a => `<article class="alert-row ${state.focusTs===a.opened_at?"focused":""}"><div class="alert-main"><div class="alert-title"><strong>${escapeHTML(state.snapshot.rules[a.metric].label)}</strong></div><p>触发值 ${a.value.toFixed(1)} ${units[a.metric]} · 连续 3 点越限</p></div><span class="pill ${a.status}">${statusNames[a.status]}</span><div class="alert-actions"><button class="text-button" data-focus="${a.opened_at}" title="定位告警发生时的采样">${timeLabel(a.opened_at)} ↗ 定位</button>${a.status==="open"?`<button class="button" data-ack="${a.id}">确认告警</button>`:""}</div>${a.recovered_at?`<div class="subtle">${timeLabel(a.recovered_at)} 指标恢复</div>`:""}</article>`).join("") : '<div class="empty-event">当前设备暂无告警</div>';
}

function drawChart(svg, rows, metric, width = 800, height = 130, cursor = null) {
  width = svg.clientWidth || width;
  svg.setAttribute?.("viewBox", `0 0 ${width} ${height}`);
  svg.dataset.end = rows.at(-1)?.ts || "";
  const left = 32,
    right = 12,
    top = 17,
    bottom = 24,
    w = width - left - right,
    h = height - top - bottom;
  const threshold = state.snapshot?.rules[metric]?.high ?? {
    temperature: 75,
    vibration: 4.5,
    current: 12
  } [metric];
  const values = rows.map(r => r[metric]);
  const lo = Math.min(...values, threshold * .45),
    hi = Math.max(...values, threshold),
    padding = (hi - lo) * .1 || 1;
  const min = lo - padding,
    max = hi + padding;
  const y = v => top + h - (v - min) / (max - min) * h;
  const first = rows[0]?.ts || 0,
    last = rows.at(-1)?.ts || first;
  const x = ts => left + (last === first ? .5 : (ts - first) / (last - first)) * w;
  let html = "";
  const device = rows[0]?.device_id || state.device;
  for (const alert of selectedAlerts(device)) {
    if (alert.metric === metric && alert.opened_at <= last && (alert.recovered_at || last) >= first && rows.length) {
      const start = x(Math.max(first, alert.opened_at)),
        end = x(Math.min(last, alert.recovered_at || last));
      html += `<rect x="${start}" y="${top}" width="${Math.max(0,end-start)}" height="${h}" fill="#fff5e9"/>`;
    }
  }
  for (let i = 0; i <= 2; i++) {
    const value = min + (max - min) * i / 2,
      yy = y(value);
    html += `<line x1="${left}" y1="${yy}" x2="${width-right}" y2="${yy}" stroke="#e9edf2"/><text x="${left-7}" y="${yy+3}" fill="#98a3b1" font-size="9" text-anchor="end">${value.toFixed(metric==="vibration"?1:0)}</text>`;
  }
  html += `<line x1="${left}" y1="${y(threshold)}" x2="${width-right}" y2="${y(threshold)}" stroke="#d6bda3" stroke-dasharray="3 4"/>`;
  if (rows.length) {
    const path = rows.map((r, i) => `${i?"L":"M"}${x(r.ts).toFixed(2)},${y(r[metric]).toFixed(2)}`).join(" ");
    html += `<path d="${path}" fill="none" stroke="${metricColors[metric]}" stroke-width="1.7" stroke-linejoin="round"/>`;
    const ticks = width < 400 ? 2 : 4;
    for (let i = 0; i <= ticks; i++) html += `<text x="${left+w*i/ticks}" y="${height-5}" fill="#98a3b1" font-size="9" text-anchor="${i===0?"start":i===ticks?"end":"middle"}">${timeLabel(first+(last-first)*i/ticks)}</text>`;
    for (const alert of selectedAlerts(device)) {
      if (alert.opened_at >= first && alert.opened_at <= last) html += `<g class="event-marker"><line x1="${x(alert.opened_at)}" x2="${x(alert.opened_at)}" y1="${top}" y2="${top+h}" stroke="#c38649" stroke-dasharray="2 3"/><circle cx="${x(alert.opened_at)}" cy="${top-5}" r="2.5" fill="#c38649"/></g>`;
    }
    const index = cursor === null ? rows.length - 1 : cursor,
      row = rows[index];
    if (row) {
      if (cursor !== null) html += `<line x1="${x(row.ts)}" x2="${x(row.ts)}" y1="${top}" y2="${top+h}" stroke="#788ca3" stroke-dasharray="3 3"/>`;
      html += `<circle cx="${x(row.ts)}" cy="${y(row[metric])}" r="3" fill="${metricColors[metric]}" stroke="white" stroke-width="1.5"/>`;
    }
  }
  svg.innerHTML = html;
}
async function loadLiveHistory() {
  if (!state.device || state.view !== "overview" || state.frozen || state.focusTs !== null) return;
  const device = state.device,
    request = ++state.historyRequest;
  try {
    const rows = await (await api(`/api/history/${encodeURIComponent(device)}?limit=600`)).json();
    if (device === state.device && request === state.historyRequest && !state.frozen && state.focusTs === null) {
      state.history = rows;
      renderLiveChart();
    }
  } catch (error) {
    setConnection(false, "数据读取失败");
  }
}

function renderLiveChart() {
  const rows = windowRows(),
    focus = state.focusTs ?? state.hoverTs;
  const cursor = focus === null ? null : nearestIndex(rows, focus),
    row = rows[cursor === null ? rows.length - 1 : cursor];
  for (const [id, metric] of [
      ["metric-value", "temperature"],
      ["vibration-value", "vibration"],
      ["current-value", "current"]
    ]) $(id).textContent = row ? row[metric].toFixed(metric === "vibration" ? 2 : 1) : "—";
  $("chart-empty").hidden = rows.length > 0;
  $("inspection-time").textContent = focus !== null && row ? `${timeLabel(row.ts)} · 序号 ${row.seq}` : state.frozen ? "曲线已冻结" : "跟随最新样本";
  $("clear-focus").hidden = state.focusTs === null;
  $("freeze-chart").textContent = state.frozen ? "恢复跟踪" : "冻结曲线";
  const offline = state.snapshot?.devices.find(d => d.device_id === state.device)?.status === "offline";
  $("stream-label").textContent = offline ? "设备离线" : state.frozen || state.focusTs !== null ? "查看历史窗口" : "自动刷新";
  $("window-info").textContent = `${rows.length} 个样本${rows.length?" · "+Math.round((rows.at(-1).ts-rows[0].ts)/1000)+" 秒":""}`;
  drawChart($("live-chart"), rows, "temperature", 800, 130, cursor);
  drawChart($("chart-vibration"), rows, "vibration", 800, 130, cursor);
  drawChart($("chart-current"), rows, "current", 800, 130, cursor);
  $("sample-rows").innerHTML = rows.length ? rows.slice(-6).reverse().map(r => `<tr class="${row?.ts===r.ts?"selected":""}"><td>${timeLabel(r.ts)}</td><td>${r.seq}</td><td>${r.temperature.toFixed(1)}</td><td>${r.vibration.toFixed(2)}</td><td>${r.current.toFixed(1)}</td></tr>`).join("") : '<tr><td colspan="5">等待数据</td></tr>';
  $("sample-json").textContent = row ? JSON.stringify(row, null, 2) : "暂无数据";
}

function selectDevice(device) {
  state.device = device;
  state.history = [];
  state.focusTs = null;
  state.hoverTs = null;
  state.frozen = false;
  state.historyRequest++;
  $("replay-device").value = device;
  renderDevices();
  renderDeviceHeading();
  renderAlerts();
  renderLiveChart();
  if (state.view === "replay") loadReplay();
  else loadLiveHistory();
}
async function focusEvent(ts) {
  const device = state.device,
    request = ++state.historyRequest;
  state.focusTs = ts;
  state.hoverTs = null;
  renderAlerts();
  renderLiveChart();
  try {
    // Fetch neighbors by sample count on each side, so dense data cannot
    // truncate away the event itself as a fixed time-window query would.
    const [before, after] = await Promise.all([
      api(`/api/history/${encodeURIComponent(device)}?to_ts=${ts}&limit=120`).then(r => r.json()),
      api(`/api/history/${encodeURIComponent(device)}?from_ts=${ts}&limit=120&earliest=true`).then(r => r.json())
    ]);
    const unique = new Map([...before, ...after].map(row => [`${row.boot_id}/${row.seq}`, row]));
    const rows = [...unique.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    if (device !== state.device || request !== state.historyRequest || state.focusTs !== ts) return;
    state.history = rows;
    renderLiveChart();
  } catch (error) {
    if (device === state.device && request === state.historyRequest) toast(error.message);
  }
}
async function command(action) {
  try {
    await api("/api/demo", {
      method: "POST",
      body: JSON.stringify({
        action
      })
    });
    toast(({
      start: "演示已启动 · 正在生成模拟遥测",
      stop: "演示已停止，历史数据保留",
      normal: "已恢复正常场景，等待连续 3 点恢复",
      overheat: "已注入过热故障，连续 3 点越限后触发告警",
      vibration: "已注入振动故障",
      offline: "已暂停目标设备上报，5 秒后标记离线"
    })[action]);
    await refresh();
    await loadLiveHistory();
  } catch (error) {
    toast(error.message);
  }
}
async function refresh() {
  try {
    renderSnapshot(await (await api("/api/snapshot")).json());
  } catch (error) {
    toast(error.message);
  }
}

function stopReplay() {
  clearInterval(state.playing);
  state.playing = null;
  $("play-replay").textContent = "▶ 播放";
}

function renderReplay() {
  const row = state.replay[state.replayIndex];
  $("replay-position").value = state.replayIndex;
  $("replay-progress").textContent = `${row?state.replayIndex+1:0} / ${state.replay.length}`;
  $("replay-time").textContent = row ? new Date(row.ts).toLocaleString("zh-CN", {
    hour12: false
  }) : "—";
  for (const m of Object.keys(labels)) $("replay-" + m).textContent = row ? row[m].toFixed(2) : "—";
  drawChart($("replay-chart"), state.replay, "temperature", 1000, 270, state.replayIndex);
}
async function loadReplay() {
  stopReplay();
  const device = $("replay-device").value,
    request = ++state.replayRequest;
  if (!device) {
    toast("请先启动演示或接入设备");
    return;
  }
  state.replay = [];
  state.replayIndex = 0;
  renderReplay();
  $("play-replay").disabled = true;
  $("replay-position").disabled = true;
  $("replay-note").textContent = `正在加载 ${device} 的历史数据…`;
  try {
    const rows = await (await api(`/api/history/${encodeURIComponent(device)}?limit=2000`)).json();
    if (request !== state.replayRequest || device !== $("replay-device").value) return;
    state.replay = rows;
    state.replayIndex = 0;
    $("replay-position").max = Math.max(0, rows.length - 1);
    $("replay-position").disabled = !rows.length;
    $("play-replay").disabled = rows.length < 2;
    $("replay-note").textContent = rows.length ? `已加载 ${rows.length} 个历史样本 · ${device} · 温度曲线 · 拖动滑块定位事件` : "该设备暂无历史数据";
    renderReplay();
  } catch (error) {
    if (request === state.replayRequest) {
      $("replay-note").textContent = "历史数据加载失败，请重试";
      toast(error.message);
    }
  }
}

document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
  state.view = button.dataset.view;
  document.querySelectorAll("[data-view]").forEach(b => b.classList.toggle("active", b === button));
  $("overview-view").hidden = state.view !== "overview";
  $("replay-view").hidden = state.view !== "replay";
  $("page-name").textContent = state.view === "overview" ? "设备调试" : "历史回放";
  if (state.view === "replay") {
    $("replay-device").value = state.device || "";
    loadReplay();
  } else {
    stopReplay();
    loadLiveHistory();
  }
}));
$("device-search").oninput = renderDevices;
document.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach(b => b.classList.toggle("active", b === button));
  renderDevices();
}));
$("devices-body").addEventListener("click", event => {
  const button = event.target.closest("[data-device]");
  if (button) selectDevice(button.dataset.device);
});
$("alerts-list").addEventListener("click", async event => {
  const focus = event.target.closest("[data-focus]");
  if (focus) {
    focusEvent(Number(focus.dataset.focus));
    return;
  }
  const button = event.target.closest("[data-ack]");
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/alerts/${button.dataset.ack}/ack`, {
      method: "POST"
    });
    await refresh();
    toast("已确认，等待指标恢复");
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
});
$("window-size").onchange = () => {
  state.windowSize = Number($("window-size").value);
  renderLiveChart();
};
$("freeze-chart").onclick = () => {
  state.frozen = !state.frozen;
  state.focusTs = null;
  state.hoverTs = null;
  state.historyRequest++;
  renderAlerts();
  renderLiveChart();
  if (!state.frozen) loadLiveHistory();
};
$("clear-focus").onclick = () => {
  state.frozen = false;
  state.focusTs = null;
  state.hoverTs = null;
  state.historyRequest++;
  renderAlerts();
  renderLiveChart();
  loadLiveHistory();
};
for (const id of ["live-chart", "chart-vibration", "chart-current"]) {
  const svg = $(id);
  const tsAt = event => {
    const rows = windowRows();
    if (!rows.length) return null;
    const rect = svg.getBoundingClientRect(),
      ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - 32) / (rect.width - 44)));
    return rows[0].ts + (rows.at(-1).ts - rows[0].ts) * ratio;
  };
  svg.addEventListener("pointermove", event => {
    if (state.focusTs === null) {
      state.hoverTs = tsAt(event);
      renderLiveChart();
    }
  });
  svg.addEventListener("pointerleave", () => {
    state.hoverTs = null;
    renderLiveChart();
  });
  svg.addEventListener("click", event => {
    state.focusTs = tsAt(event);
    state.hoverTs = null;
    state.historyRequest++;
    renderLiveChart();
  });
}
window.addEventListener("resize", () => {
  renderLiveChart();
  if (state.view === "replay") renderReplay();
});
$("demo-toggle").onclick = () => command(state.snapshot?.demo.running ? "stop" : "start");
$("apply-scenario").onclick = () => command($("scenario").value);
$("load-replay").onclick = loadReplay;
$("replay-device").onchange = () => selectDevice($("replay-device").value);
$("replay-position").oninput = () => {
  stopReplay();
  state.replayIndex = Number($("replay-position").value);
  renderReplay();
};
$("play-replay").onclick = () => {
  if (state.playing) {
    stopReplay();
    return;
  }
  if (state.replayIndex >= state.replay.length - 1) state.replayIndex = 0;
  $("play-replay").textContent = "Ⅱ 暂停";
  state.playing = setInterval(() => {
    state.replayIndex++;
    renderReplay();
    if (state.replayIndex >= state.replay.length - 1) stopReplay();
  }, 200);
};
$("export").onclick = async () => {
  const device = state.view === "replay" ? $("replay-device").value : state.device;
  if (!device) {
    toast("暂无可导出的设备数据");
    return;
  }
  try {
    const response = await api(`/api/export/${encodeURIComponent(device)}`),
      url = URL.createObjectURL(await response.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `${device}-telemetry.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("已导出最近最多 10,000 条样本");
  } catch (error) {
    toast(error.message);
  }
};
$("settings").onclick = () => $("token-dialog").showModal();
$("close-settings").onclick = () => $("token-dialog").close();
$("token-form").onsubmit = event => {
  event.preventDefault();
  state.token = $("api-token").value;
  $("api-token").value = "";
  $("token-dialog").close();
  connect();
  refresh();
};
setInterval(() => $("clock").textContent = timeLabel(Date.now()), 1000);
setInterval(loadLiveHistory, 2000);
renderLiveChart();
connect();
refresh();
