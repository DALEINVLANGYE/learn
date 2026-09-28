/* Shared, dependency-free decisions. No network or player mutations here. */
(() => {
  "use strict";
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  function courseFromUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== "https://buaa.yuketang.cn") return null;
      return url.pathname.match(/^\/ai-workspace\/lms-graph\/(\d+)(?:\/|$)/)?.[1] || null;
    } catch { return null; }
  }
  function chooseNext(rows) {
    const active = rows.map((row, index) => row.active ? index : -1).filter(i => i >= 0);
    if (active.length !== 1) return { kind: "error", message: "无法唯一确定当前目录项，请展开课程目录。" };
    const index = active[0];
    if (normalize(rows[index].type) !== "视频") return { kind: "error", message: "当前不是视频单元，自动续播已停止。" };
    const next = rows.findIndex((row, i) => i > index && normalize(row.type) === "视频");
    if (next < 0) return { kind: "complete" };
    if (!normalize(rows[next].title)) return { kind: "error", message: "下一段视频标题为空，已停止。" };
    return { kind: "next", index: next, title: normalize(rows[next].title) };
  }
  function naturallyEnded(video) {
    return Boolean(video && video.ended === true && Number.isFinite(video.duration) && video.duration > 0);
  }
  const api = Object.freeze({ normalize, courseFromUrl, chooseNext, naturallyEnded });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.YKPlaybackLogic = api;
})();
