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
  replayRequest: 0
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
      /* Non-JSON proxy error. */ }
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

function renderSnapshot(snapshot) {
  state.snapshot = snapshot;
  const stats = snapshot.stats;
  for (const [id, key] of [
      ["stat-online", "online"],
      ["stat-total", "devices"],
      ["stat-alerts", "active_alerts"],
      ["stat-accepted", "accepted"],
      ["stat-duplicates", "duplicates"],
      ["stat-late", "late"],
      ["stat-gaps", "sequence_gaps"],
      ["integrity-total", "accepted"]
    ]) $(id).textContent = number(stats[key]);
  $("fleet-count").textContent = `${stats.devices} 个节点`;
  $("demo-toggle").textContent = snapshot.demo.running ? "Ⅱ 停止演示" : "▶ 启动演示";
  $("demo-state").textContent = snapshot.demo.running ? "演示运行中" : "未启动";
  $("demo-state").className = `pill ${snapshot.demo.running?"healthy":"neutral"}`;
  $("apply-scenario").disabled = !snapshot.demo.running;
  if (!state.device && snapshot.devices.length) state.device = snapshot.devices.find(d => d.device_id === snapshot.demo.target)?.device_id || snapshot.devices[0].device_id;
  renderDevices();
  renderAlerts();
  const signature = snapshot.devices.map(d => d.device_id).join(",");
  if ($("replay-device").dataset.signature !== signature) {
    const previous = $("replay-device").value;
    $("replay-device").innerHTML = snapshot.devices.map(d => `<option value="${escapeHTML(d.device_id)}">${escapeHTML(d.device_id)}</option>`).join("");
    $("replay-device").dataset.signature = signature;
    if (snapshot.devices.some(d => d.device_id === previous)) $("replay-device").value = previous;
    else if (snapshot.devices.some(d => d.device_id === state.device)) $("replay-device").value = state.device;
  }
  renderLiveChart();
}

function renderDevices() {
  const devices = state.snapshot.devices;
  if (!devices.length) return;
  $("devices-body").innerHTML = devices.map(d => {
    const id = escapeHTML(d.device_id),
      selected = state.device === d.device_id;
    const age = Math.max(0, Math.floor((state.snapshot.server_time - d.last_seen) / 1000));
    return `<tr class="${selected?"selected":""}"><td><div class="device-cell"><span class="device-icon">▣</span><button class="device-name" data-device="${id}">${id}<small>${d.device_id.startsWith("demo-")?"SIMULATED NODE":"HTTP EDGE NODE"}</small></button></div></td><td><span class="pill ${d.status}">${statusNames[d.status]}</span></td><td>${d.temperature.toFixed(1)}<span class="unit">°C</span></td><td>${d.vibration.toFixed(2)}<span class="unit">mm/s</span></td><td>${d.current.toFixed(1)}<span class="unit">A</span></td><td class="last-seen">${age<1?"刚刚":age+" 秒前"}</td><td><button class="select-device" data-device="${id}" aria-label="查看 ${id}">↗</button></td></tr>`;
  }).join("");
}

function renderAlerts() {
  const alerts = state.snapshot.alerts;
  $("alert-count").textContent = `${alerts.length} 条`;
  if (!alerts.length) return;
  $("alerts-list").innerHTML = alerts.map(a => `<div class="alert-row"><span class="alert-symbol">${a.status==="recovered"?"✓":"△"}</span><div class="alert-main"><strong>${escapeHTML(state.snapshot.rules[a.metric].label)}</strong><p>${escapeHTML(a.device_id)} · 触发值 ${a.value.toFixed(1)} ${units[a.metric]}</p></div><time>${timeLabel(a.opened_at)}</time><span class="pill ${a.status}">${statusNames[a.status]}</span>${a.status==="open"?`<button class="button secondary" data-ack="${a.id}">确认告警</button>`:""}</div>`).join("");
}

function drawChart(svg, rows, metric, width = 760, height = 210, cursor = null) {
  const left = 40,
    right = 18,
    top = 20,
    bottom = 30,
    w = width - left - right,
    h = height - top - bottom;
  const threshold = state.snapshot?.rules[metric]?.high ?? ({
    temperature: 75,
    vibration: 4.5,
    current: 12
  } [metric]);
  const values = rows.map(r => r[metric]);
  const min = Math.max(0, Math.floor(Math.min(...values, threshold * .5) * .8));
  const max = Math.ceil(Math.max(...values, threshold) * 1.15);
  const y = v => top + h - (v - min) / (max - min) * h;
  const first = rows[0]?.ts || 0,
    last = rows.at(-1)?.ts || first;
  const x = (r, i) => left + (last === first ? (rows.length <= 1 ? .5 : i / (rows.length - 1)) : (r.ts - first) / (last - first)) * w;
  let html = `<defs><linearGradient id="${svg.id}-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#78ecc0" stop-opacity=".2"/><stop offset="100%" stop-color="#78ecc0" stop-opacity="0"/></linearGradient></defs>`;
  for (let i = 0; i <= 4; i++) {
    const value = min + (max - min) * i / 4,
      yy = y(value);
    html += `<line x1="${left}" y1="${yy}" x2="${width-right}" y2="${yy}" stroke="#29353e" stroke-dasharray="3 5"/><text x="${left-10}" y="${yy+3}" fill="#738995" font-size="9" text-anchor="end">${value.toFixed(metric==="vibration"?1:0)}</text>`;
  }
  html += `<line x1="${left}" y1="${y(threshold)}" x2="${width-right}" y2="${y(threshold)}" stroke="#b88854" stroke-dasharray="5 5"/><text x="${width-right}" y="${y(threshold)-7}" fill="#c39866" font-size="8" text-anchor="end">阈值 ${threshold}</text>`;
  if (rows.length) {
    const path = rows.map((r, i) => `${i?"L":"M"}${x(r,i).toFixed(2)},${y(r[metric]).toFixed(2)}`).join(" ");
    html += `<path d="${path} L${x(rows.at(-1),rows.length-1)},${top+h} L${x(rows[0],0)},${top+h} Z" fill="url(#${svg.id}-fill)"/><path d="${path}" fill="none" stroke="#78ecc0" stroke-width="2" stroke-linejoin="round"/>`;
    for (let i = 0; i <= 4; i++) {
      const idx = Math.round((rows.length - 1) * i / 4);
      html += `<text x="${left+w*i/4}" y="${height-7}" fill="#738995" font-size="9" text-anchor="middle">${timeLabel(first+(last-first)*i/4)}</text>`;
    }
    const idx = cursor === null ? rows.length - 1 : cursor,
      row = rows[idx];
    if (row) {
      const xx = x(row, idx),
        yy = y(row[metric]);
      if (cursor !== null) html += `<line x1="${xx}" y1="${top}" x2="${xx}" y2="${top+h}" stroke="#c8ded3" stroke-dasharray="3 3"/>`;
      html += `<circle cx="${xx}" cy="${yy}" r="4" fill="#78ecc0" stroke="#122e22" stroke-width="3"/>`;
    }
  }
  svg.innerHTML = html;
}
async function loadLiveHistory() {
  if (!state.device || state.view !== "overview") return;
  const device = state.device,
    request = ++state.historyRequest;
  try {
    const response = await api(`/api/history/${encodeURIComponent(device)}?limit=120`);
    const rows = await response.json();
    if (device === state.device && request === state.historyRequest) {
      state.history = rows;
      renderLiveChart();
    }
  } catch (error) {
    if (error.message.includes("401")) return;
    setConnection(false, "数据读取失败");
  }
}

function renderLiveChart() {
  const device = state.snapshot?.devices.find(d => d.device_id === state.device);
  $("selected-badge").textContent = state.device || "等待设备";
  $("metric-value").textContent = device ? device[state.metric].toFixed(state.metric === "vibration" ? 2 : 1) : "—";
  $("metric-unit").textContent = units[state.metric];
  $("legend-metric").textContent = labels[state.metric];
  $("metric-description").textContent = device ? (state.metric === "temperature" ? `EWMA ${device.temperature_ewma.toFixed(1)} °C · α = 0.2` : `事件时间 ${timeLabel(device.ts)}`) : "等待遥测数据";
  $("chart-empty").hidden = state.history.length > 0;
  $("stream-label").textContent = device ? (device.status === "offline" ? "○ 设备已离线" : "● 实时数据流") : "○ 等待数据流";
  drawChart($("live-chart"), state.history, state.metric);
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
  $("page-name").textContent = state.view === "overview" ? "实时总览" : "历史回放";
  $("page-title").textContent = state.view === "overview" ? "让设备状态，一目了然." : "回到故障发生的那一刻.";
  $("page-subtitle").textContent = state.view === "overview" ? "从实时遥测到故障恢复，追踪每一个关键变化。" : "沿着真实存储的时间线，复盘每一次异常。";
  if (state.view === "replay") loadReplay();
  else {
    stopReplay();
    loadLiveHistory();
  }
}));
document.querySelectorAll("[data-metric]").forEach(button => button.addEventListener("click", () => {
  state.metric = button.dataset.metric;
  document.querySelectorAll("[data-metric]").forEach(b => b.classList.toggle("active", b === button));
  renderLiveChart();
}));
$("devices-body").addEventListener("click", event => {
  const button = event.target.closest("[data-device]");
  if (!button) return;
  state.device = button.dataset.device;
  state.history = [];
  renderDevices();
  renderLiveChart();
  loadLiveHistory();
});
$("alerts-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-ack]");
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/alerts/${button.dataset.ack}/ack`, {
      method: "POST"
    });
    toast("已确认，等待指标恢复后关闭告警");
    await refresh();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
});
$("demo-toggle").onclick = () => command(state.snapshot?.demo.running ? "stop" : "start");
$("apply-scenario").onclick = () => command($("scenario").value);
$("load-replay").onclick = loadReplay;
$("replay-device").onchange = loadReplay;
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
