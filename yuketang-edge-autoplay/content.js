(() => {
  "use strict";
  const VERSION = "1.2.6";
  const { normalize, courseFromUrl, chooseNext, naturallyEnded } = globalThis.YKPlaybackLogic;
  const SELECTOR = {
    rows: ".leaf-item", type: ".leaf-item-tag", title: ".leaf-item-title",
    // 雨课堂新版播放器有时不再保留 xt_video_player class；普通 video 仍是唯一稳定标识。
    video: "video.xt_video_player, video", headings: ".nav-item-title",
    speed: 'xt-speedbutton li[data-speed="2"]', search: 'input[placeholder="搜索学习单元"]'
  };
  const state = {
    enabled: false, courseId: courseFromUrl(location.href), phase: "stopped",
    message: "点击开始：当前视频播完后自动续播。", pending: null,
    video: null, key: "", generation: 0, switching: false, ready: false,
    backgroundResume: false, backgroundResumeAttempts: 0, backgroundPlayTimer: null,
    foregroundResumeUntil: 0, foregroundExpiryTimer: null,
    handled: new Set(), metadataReady: new WeakSet(), speedApplied: new WeakMap(), speedControlApplied: new WeakMap()
  };
  let panel, ui, observerTimer, navigationTimer, switchTimer, mediaAbort, speedTimer;
  const title = () => normalize(document.querySelector(".unit-title")?.textContent);
  const unitKey = () => location.pathname + "?node_id=" + (new URL(location.href).searchParams.get("node_id") || "");
  const isVideoPage = () => /\/video\/\d+/.test(location.pathname);
  function rows() {
    return Array.from(document.querySelectorAll(SELECTOR.rows)).map(element => ({
      element, active: element.classList.contains("is-active"),
      type: normalize(element.querySelector(SELECTOR.type)?.textContent),
      title: normalize(element.querySelector(SELECTOR.title)?.textContent)
    }));
  }
  function status() {
    const next = chooseNext(rows());
    return {
      version: VERSION,
      supported: Boolean(courseFromUrl(location.href) && isVideoPage()),
      enabled: state.enabled, currentTitle: title(),
      nextTitle: next.kind === "next" ? next.title : null,
      phase: state.phase, message: state.message,
      rate: state.video ? state.video.playbackRate : null
    };
  }
  function show(phase, message) {
    state.phase = phase; state.message = message;
    render();
  }
  function render() {
    if (!ui) return;
    const next = chooseNext(rows());
    ui.status.textContent = state.message;
    ui.current.textContent = title() || "正在等待课程页面";
    ui.next.textContent = next.kind === "next" ? "下一节：" + next.title : "";
    ui.toggle.textContent = state.enabled ? "停止自动续播" : "开始自动续播";
    ui.toggle.setAttribute("aria-pressed", String(state.enabled));
    ui.resume.hidden = !(state.enabled && state.video?.paused && !state.video?.ended && !state.switching);
    ui.toggle.disabled = !state.ready || !isVideoPage();
    ui.badge.textContent = "v" + VERSION + " · " + (state.enabled ? "已开启 · 实际 " + (state.video?.playbackRate ?? "—") + "×" : "未开启");
  }
  function makePanel() {
    panel = document.createElement("div");
    panel.id = "yk-playback-assist-host";
    panel.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const shadow = panel.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
      :host{color-scheme:light} *{box-sizing:border-box} aside{width:290px;padding:16px;background:#fff;color:#17243a;border:1px solid #ccd8e7;border-radius:16px;box-shadow:0 8px 32px #152d552b;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif}
      header{display:flex;align-items:center;justify-content:space-between;gap:8px} strong{font-size:15px} p{margin:8px 0;overflow-wrap:anywhere} small{color:#536477} button{border:0;border-radius:9px;min-height:42px;padding:9px 12px;font:inherit;cursor:pointer;background:#1459c7;color:#fff} button:focus-visible{outline:3px solid #e2960b;outline-offset:3px} button:disabled{opacity:.5;cursor:default} #collapse{background:#edf2f8;color:#20344f;min-width:42px} #toggle,#resume{width:100%;margin-top:8px} #resume{background:#e6effe;color:#134791}[hidden]{display:none!important} #badge{font-size:12px;color:#426078}
    </style><aside aria-label="雨课堂自动续播"><header><strong>雨课堂自动续播</strong><button id="collapse" aria-expanded="true" aria-label="收起续播面板">−</button></header><div id="badge"></div><div id="details"><p id="current"></p><small id="next"></small><p id="status" role="status" aria-live="polite"></p></div><button id="toggle" aria-pressed="false">开始自动续播</button><button id="resume" hidden>继续播放当前视频</button></aside>`;
    ui = Object.fromEntries(["collapse","badge","details","current","next","status","toggle","resume"].map(id=>[id,shadow.getElementById(id)]));
    ui.toggle.addEventListener("click", () => setEnabled(!state.enabled));
    ui.resume.addEventListener("click", () => tryPlay(state.video));
    ui.collapse.addEventListener("click", () => {
      const collapsed = !ui.details.hidden;
      ui.details.hidden = collapsed;
      ui.collapse.textContent = collapsed ? "+" : "−";
      ui.collapse.setAttribute("aria-expanded", String(!collapsed));
      ui.collapse.setAttribute("aria-label", collapsed ? "展开续播面板" : "收起续播面板");
    });
    document.documentElement.append(panel);
  }
  async function save() {
    const response = await chrome.runtime.sendMessage({ type: "YK_STATE_SET", enabled: state.enabled, pending: state.pending });
    if (response?.error) throw new Error(response.error);
  }
  function cancelPending() {
    clearTimeout(navigationTimer); clearTimeout(switchTimer);
    clearTimeout(state.backgroundPlayTimer);
    clearTimeout(state.foregroundExpiryTimer);
    state.backgroundPlayTimer = null;
    state.foregroundExpiryTimer = null;
    state.generation++; state.switching = false; state.pending = null;
  }
  function isDocumentHidden() {
    return document.visibilityState === "hidden" || document.hidden === true;
  }
  function shouldRestorePlayback(video) {
    return state.enabled && state.backgroundResume && !state.switching &&
      state.video === video && !video.ended &&
      (isDocumentHidden() || Date.now() < state.foregroundResumeUntil);
  }
  function scheduleContinuityResume(video) {
    clearTimeout(state.backgroundPlayTimer);
    state.backgroundPlayTimer = setTimeout(() => {
      state.backgroundPlayTimer = null;
      if (!shouldRestorePlayback(video) || !video.paused || state.backgroundResumeAttempts >= 6) return;
      state.backgroundResumeAttempts += 1;
      tryPlay(video, { continuity: true });
    }, 120);
  }
  async function stop(phase, message) {
    state.enabled = false; state.backgroundResume = false; state.backgroundResumeAttempts = 0;
    state.foregroundResumeUntil = 0;
    cancelPending(); clearInterval(speedTimer); speedTimer = null; show(phase, message);
    try { await save(); } catch { /* Local switch is already off. */ }
  }
  async function setEnabled(enabled) {
    if (!enabled) {
      await stop("stopped", "已停止自动续播；当前视频由你控制。");
      return status();
    }
    if (!isVideoPage() || !courseFromUrl(location.href)) return status();
    cancelPending(); state.handled.clear();
    state.courseId = courseFromUrl(location.href); state.enabled = true;
    clearInterval(speedTimer);
    speedTimer = setInterval(() => {
      if (state.enabled && state.video) applySpeed(state.video);
    }, 250);
    try { await save(); } catch {
      await stop("error", "无法保存开关，请刷新页面或重新加载扩展。");
      return status();
    }
    reconcile();
    if (state.video?.ended) onEnded(state.video);
    else if (state.video?.paused) show("paused", "已开启。视频当前暂停；点击“继续播放当前视频”即可播放。");
    return status();
  }
  async function tryPlay(video, options = {}) {
    if (!state.enabled || !video || video !== state.video) return;
    const continuity = options.continuity === true;
    try {
      await video.play();
      if (continuity) state.backgroundResume = true;
      if (state.enabled && video === state.video) show("playing", "正在播放；播完后自动切换下一节。");
    } catch {
      if (continuity && shouldRestorePlayback(video) && state.backgroundResumeAttempts < 6) {
        scheduleContinuityResume(video);
      } else if (state.enabled) {
        state.backgroundResume = false;
        show("paused", "浏览器没有允许自动播放，请点击下面的“继续播放当前视频”。");
      }
    }
  }
  function applySpeed(video) {
    if (!state.enabled || !video || video.readyState < 1) return;
    const key = unitKey();
    const previousControlKey = state.speedControlApplied.get(video);
    if (previousControlKey !== key) {
      // 雨课堂的右下角显示由自定义速度控件维护。只在每个媒体源首次加载时
      // 同步一次 2.00×，避免在定时校正中反复触发控件导致 1/2 倍速闪烁。
      const wrap = video.closest("xt-wrap") || video.parentElement?.closest("xt-wrap");
      const speedOption = wrap?.querySelector(SELECTOR.speed);
      if (speedOption) {
        try { speedOption.click(); } catch { /* 原生速率校正仍可继续。 */ }
        state.speedControlApplied.set(video, key);
      }
    }
    if (Math.abs(video.playbackRate - 2) < 0.01) return;
    // 雨课堂播放器会在 play/ratechange 后把速率重置为 1；只改原生属性，
    // 不再点击页面菜单项，避免菜单组件把 1/2 倍速状态反复切换。
    try {
      video.defaultPlaybackRate = 2;
      video.playbackRate = 2;
    } catch {
      show("waiting", "正在等待播放器接受 2 倍速设置……");
    }
  }

  function attachVideo(video) {
    mediaAbort?.abort(); state.video = video;
    clearTimeout(state.backgroundPlayTimer);
    state.backgroundPlayTimer = null;
    state.backgroundResumeAttempts = 0;
    if (!video) return;
    mediaAbort = new AbortController();
    const listen = (event, handler) => video.addEventListener(event, handler, { signal: mediaAbort.signal });
    if (video.readyState >= 1) state.metadataReady.add(video);
    listen("loadedmetadata", () => { state.metadataReady.add(video); state.speedApplied.delete(video); state.speedControlApplied.delete(video); reconcile(); });
    listen("emptied", () => { state.metadataReady.delete(video); state.speedApplied.delete(video); state.speedControlApplied.delete(video); scheduleReconcile(); });
    for (const event of ["loadeddata", "canplay", "playing", "durationchange"]) listen(event, scheduleReconcile);
    listen("play", () => {
      if (!state.enabled) return;
      if (isDocumentHidden()) state.backgroundResume = true;
      applySpeed(video);
      show("playing", "正在播放；播完后自动切换下一节。");
    });
    listen("pause", () => {
      if (!state.enabled || video.ended || state.switching) return;
      if (shouldRestorePlayback(video)) {
        show("waiting", "页面切换后正在恢复播放……");
        scheduleContinuityResume(video);
      } else show("paused", "已暂停；自动续播会等待你继续播放。");
    });
    listen("ratechange", () => {
      if (!state.enabled) return;
      applySpeed(video);
      render();
    });
    listen("ended", () => onEnded(video));
    listen("error", () => { if (state.enabled) stop("error", "视频加载失败，自动续播已停止。"); });
  }
  async function onEnded(video) {
    if (!state.enabled || video !== state.video || state.switching || !naturallyEnded(video)) return;
    const key = unitKey();
    if (state.handled.has(key)) return;
    state.handled.add(key); state.switching = true;
    const generation = state.generation;
    show("switching", "本节已播完，正在准备下一节……");
    switchTimer = setTimeout(async () => {
      if (!state.enabled || generation !== state.generation || unitKey() !== key || !naturallyEnded(video)) {
        state.switching = false; return;
      }
      if (normalize(document.querySelector(SELECTOR.search)?.value)) {
        await stop("error", "目录正在搜索筛选。请清空目录搜索后重新开启，以保证续播顺序。"); return;
      }
      const stillValid = () => state.enabled && generation === state.generation && unitKey() === key && state.video === video && naturallyEnded(video);
      const collapsed = Array.from(document.querySelectorAll(SELECTOR.headings)).filter(e => e.querySelector(".expand-icon") && !e.classList.contains("is-expand"));
      if (collapsed.length) {
        await stop("error", "有折叠的目录，无法保证视频顺序。请展开全部目录后重新开启。"); return;
      }
      switchTimer = setTimeout(async () => {
        if (!stillValid()) { state.switching = false; return; }
        if (document.querySelector(".nav-item-title:not(.is-expand) .expand-icon")) {
          await stop("error", "部分目录未展开，自动续播已停止，请展开目录后重新开启。"); return;
        }
        const all = rows(), next = chooseNext(all);
        if (next.kind === "complete") { await stop("complete", "目录中的后续视频已全部播完。"); return; }
        if (next.kind === "error") { await stop("error", next.message); return; }
        state.pending = { title: next.title, fromKey: key, at: Date.now() };
        try { await save(); } catch { await stop("error", "无法保存切换状态，已停止。"); return; }
        if (!stillValid()) {
          if (generation === state.generation) { state.pending = null; state.switching = false; save().catch(() => {}); }
          return;
        }
        show("switching", "正在打开：" + next.title);
        navigationTimer = setTimeout(() => {
          if (state.enabled && state.pending) stop("error", "下一节未能在 45 秒内加载，自动续播已停止。");
        }, 45000);
        all[next.index].element.click();
      }, 0);
    }, 1500);
  }
  function reconcile() {
    if (!state.ready) return;
    const courseId = courseFromUrl(location.href);
    if (state.enabled && (courseId !== state.courseId || !isVideoPage())) {
      stop("stopped", "已离开当前课程视频，自动续播已停止。"); return;
    }
    const candidates = Array.from(document.querySelectorAll(SELECTOR.video));
    const videos = candidates.filter(video => video.getClientRects().length > 0);
    // 同一页面可能同时挂着隐藏的预加载 video，只接受可见且已进入播放器区域的节点。
    const playable = videos.filter(video => video.closest(".xt-wrap,.video-player,.player-container,[class*='player']") || video.readyState > 0);
    const video = playable.length === 1 ? playable[0] : (videos.length === 1 ? videos[0] : null);
    if (video !== state.video) attachVideo(video);
    const key = unitKey();
    if (key !== state.key) {
      state.key = key;
      if (state.enabled && state.switching && !state.pending) {
        clearTimeout(switchTimer); state.switching = false;
      }
      if (state.pending && key !== state.pending.fromKey && title() !== state.pending.title) {
        // A SPA can update the URL before its title: wait for a coherent directory state.
        render(); return;
      }
    }
    if (!state.enabled) { render(); return; }
    if (!video) { show("waiting", videos.length > 1 ? "发现多个播放器，等待唯一课程视频。" : "等待课程播放器加载……"); return; }
    if (state.pending) {
      if (Date.now() - state.pending.at > 45000) { stop("error", "下一节加载超时，自动续播已停止。"); return; }
      if (key === state.pending.fromKey || title() !== state.pending.title || video.readyState < 1 || video.ended) return;
      clearTimeout(navigationTimer);
      state.pending = null; state.switching = false;
      save().catch(() => stop("error", "标签页状态保存失败。"));
      applySpeed(video); tryPlay(video, { continuity: state.backgroundResume && isDocumentHidden() }); return;
    }
    applySpeed(video);
    if (!state.switching) {
      if (video.ended) onEnded(video);
      else if (video.paused && shouldRestorePlayback(video)) {
        if (!state.backgroundPlayTimer && state.backgroundResumeAttempts < 6) scheduleContinuityResume(video);
        show("waiting", "页面切换后正在恢复播放……");
      }
      else show(video.paused ? "paused" : "playing", video.paused ? "已暂停；等待你继续播放。" : "正在播放；播完后自动切换下一节。");
    }
  }
  function scheduleReconcile() {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(reconcile, 120);
  }
  const observer = new MutationObserver(records => {
    const relevant = records.some(record => {
      if (record.target === panel) return false;
      if (record.type === "attributes") return record.target.matches?.(".leaf-item,.nav-item-title,video,xt-wrap");
      if (record.type === "characterData") return record.target.parentElement?.closest(".unit-title,.leaf-item-title");
      return Array.from(record.addedNodes).concat(Array.from(record.removedNodes)).some(node =>
        node.nodeType === 1 && (node.matches("video,.leaf-item,.unit-title,xt-speedbutton") || node.querySelector("video,.leaf-item,.unit-title,xt-speedbutton"))
      );
    });
    if (relevant) scheduleReconcile();
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "YK_ASSIST_GET_STATUS") { respond(status()); return; }
    if (message?.type === "YK_ASSIST_SET_ENABLED") {
      setEnabled(message.enabled === true).then(respond, () => respond(status())); return true;
    }
  });
  window.addEventListener("popstate", scheduleReconcile);
  window.addEventListener("pageshow", scheduleReconcile);
  document.addEventListener("visibilitychange", () => {
    if (isDocumentHidden()) {
      clearTimeout(state.foregroundExpiryTimer);
      state.foregroundResumeUntil = 0;
      if (state.enabled && state.video && !state.video.paused && !state.video.ended) {
        state.backgroundResume = true;
        state.backgroundResumeAttempts = 0;
      }
    } else if (state.enabled && state.backgroundResume && state.video && !state.video.ended) {
      state.foregroundResumeUntil = Date.now() + 3000;
      state.backgroundResumeAttempts = 0;
      if (state.video.paused) scheduleContinuityResume(state.video);
      state.foregroundExpiryTimer = setTimeout(() => {
        if (!isDocumentHidden() && Date.now() >= state.foregroundResumeUntil) {
          state.backgroundResume = false;
          state.foregroundResumeUntil = 0;
        }
      }, 3100);
    }
    scheduleReconcile();
  });
  function cancelResumeOnUserInput() {
    if (isDocumentHidden()) return;
    state.backgroundResume = false;
    state.foregroundResumeUntil = 0;
    clearTimeout(state.backgroundPlayTimer);
    state.backgroundPlayTimer = null;
  }
  document.addEventListener("pointerdown", cancelResumeOnUserInput, true);
  document.addEventListener("keydown", cancelResumeOnUserInput, true);
  function watchdog() {
    setTimeout(() => {
      if (state.ready && state.enabled) reconcile();
      watchdog();
    }, 1000);
  }
  watchdog();
  makePanel();
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class","src","style","hidden"], characterData: true });
  (async () => {
    try {
      const saved = await chrome.runtime.sendMessage({ type: "YK_STATE_GET" });
      if (saved?.enabled && saved.courseId === state.courseId) {
        state.enabled = true;
        clearInterval(speedTimer);
        speedTimer = setInterval(() => {
          if (state.enabled && state.video) applySpeed(state.video);
        }, 250);
        state.pending = saved.pending || null;
        state.switching = Boolean(state.pending);
        if (state.pending) {
          navigationTimer = setTimeout(() => {
            if (state.enabled && state.pending) stop("error", "下一节未能加载，自动续播已停止。");
          }, Math.max(0, 45000 - (Date.now() - state.pending.at)));
        }
      }
    } catch { state.message = "连接扩展失败，请刷新课程页面。"; }
    state.ready = true; reconcile();
  })();
})();
