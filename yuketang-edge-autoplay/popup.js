"use strict";

const phaseNames = {
  playing: "正在播放 · 自动续播已开启",
  paused: "已暂停 · 等待你继续播放",
  waiting: "自动续播已开启 · 等待视频",
  switching: "正在切换下一视频…",
  stopped: "自动续播已停止",
  complete: "本次续播已完成",
  error: "需要处理",
};

const ui = {
  phase: document.getElementById("phase"),
  message: document.getElementById("message"),
  rate: document.getElementById("rate"),
  current: document.getElementById("current-title"),
  next: document.getElementById("next-title"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  refresh: document.getElementById("refresh"),
};

let tabId = null;
let busy = false;
let lastStatus = null;

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function updateButtons() {
  const supported = lastStatus?.supported === true;
  const enabled = lastStatus?.enabled === true;
  ui.start.disabled = busy || !supported || enabled;
  ui.stop.disabled = busy || !supported || !enabled;
  ui.refresh.disabled = busy;
}

function showUnavailable(message) {
  lastStatus = null;
  setText(ui.phase, "尚未连接课程页");
  setText(ui.message, message || "请在 Edge 打开北航雨课堂课程视频，并刷新页面一次，再重新连接。");
  setText(ui.current, "—");
  setText(ui.next, "—");
  ui.rate.hidden = true;
  updateButtons();
}

function renderStatus(status) {
  if (!status || typeof status !== "object" || status.supported !== true) {
    showUnavailable(status?.message);
    return;
  }

  lastStatus = status;
  const name = status.enabled
    ? (phaseNames[status.phase] || "自动续播已开启")
    : (status.phase === "complete" || status.phase === "error" ? phaseNames[status.phase] : phaseNames.stopped);
  setText(ui.phase, name);
  setText(ui.message, typeof status.message === "string" ? status.message : "");
  setText(ui.current, status.currentTitle || "等待识别当前视频");
  setText(ui.next, status.nextTitle || (status.phase === "complete" ? "没有下一视频" : "暂未识别"));
  const hasRate = typeof status.rate === "number" && Number.isFinite(status.rate) && status.rate > 0;
  ui.rate.hidden = !hasRate;
  if (hasRate) setText(ui.rate, `${status.rate} 倍速`);
  updateButtons();
}

async function connect() {
  if (busy) return;
  busy = true;
  updateButtons();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) throw new Error("No active tab");
    tabId = tab.id;
    renderStatus(await chrome.tabs.sendMessage(tabId, { type: "YK_ASSIST_GET_STATUS" }));
  } catch {
    tabId = null;
    showUnavailable();
  } finally {
    busy = false;
    updateButtons();
  }
}

async function setEnabled(enabled) {
  if (busy || tabId === null) return;
  busy = true;
  updateButtons();
  try {
    renderStatus(await chrome.tabs.sendMessage(tabId, {
      type: "YK_ASSIST_SET_ENABLED",
      enabled,
    }));
  } catch {
    showUnavailable();
  } finally {
    busy = false;
    updateButtons();
  }
}

async function refreshStatus() {
  if (busy || tabId === null || document.hidden) return;
  busy = true;
  try {
    renderStatus(await chrome.tabs.sendMessage(tabId, { type: "YK_ASSIST_GET_STATUS" }));
  } catch {
    showUnavailable();
  } finally {
    busy = false;
    updateButtons();
  }
}

ui.start.addEventListener("click", () => { void setEnabled(true); });
ui.stop.addEventListener("click", () => { void setEnabled(false); });
ui.refresh.addEventListener("click", () => { void connect(); });
void connect();
// Only refresh the visible popup's status; playback automation lives in the course page.
const refreshTimer = setInterval(() => { void refreshStatus(); }, 1500);
window.addEventListener("pagehide", () => clearInterval(refreshTimer), { once: true });
