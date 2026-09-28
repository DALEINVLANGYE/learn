/* The worker stores only per-tab switches. Playback runs in the content script. */
"use strict";
const prefix = "yk-playback-tab-";
const queues = new Map();
function courseFromUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://buaa.yuketang.cn"
      ? url.pathname.match(/^\/ai-workspace\/lms-graph\/(\d+)(?:\/|$)/)?.[1] : null;
  } catch { return null; }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!["YK_STATE_GET", "YK_STATE_SET"].includes(message?.type)) return;
  const tabId = sender.tab?.id;
  const courseId = courseFromUrl(sender.url);
  const disabling = message.type === "YK_STATE_SET" && message.enabled === false;
  if (!Number.isInteger(tabId) || sender.frameId !== 0 || (!courseId && !disabling)) {
    respond({ error: "不支持的页面" });
    return;
  }
  const key = prefix + tabId;
  const operation = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(async () => {
    if (message.type === "YK_STATE_GET") {
      const record = (await chrome.storage.session.get(key))[key];
      return record?.courseId === courseId ? record : { enabled: false, courseId, pending: null };
    }
    const raw = message.pending;
    const pending = raw && typeof raw.title === "string" && typeof raw.fromKey === "string"
      ? { title: raw.title.slice(0,300), fromKey: raw.fromKey.slice(0,500), at: Date.now() } : null;
    const record = { courseId, enabled: message.enabled === true, pending: message.enabled ? pending : null };
    await chrome.storage.session.set({ [key]: record });
    return record;
  });
  queues.set(tabId, operation);
  operation.then(respond, () => respond({ error: "无法保存标签页状态，请重新加载扩展。" })).finally(() => {
    if (queues.get(tabId) === operation) queues.delete(tabId);
  });
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(prefix + tabId).catch(() => {});
});
