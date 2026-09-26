/**
 * util.js — 通用工具：esc / genId / nowLocal / b64 编解码 / toast / 下载 / DOM 快捷
 */
(function () {
  'use strict';

  /** getElementById 快捷 */
  function $(id) {
    return document.getElementById(id);
  }

  /** HTML 转义（XSS 防护），所有用户数据渲染前必须经过 */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /** ID 生成：Date.now().toString(36) + 5 位随机（与现网一致，保证云文件不冲突） */
  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /** 两位补零：9 → "09" */
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  /** 当前时间（本地时区），格式 datetime-local："YYYY-MM-DDTHH:mm" */
  function nowLocal() {
    var d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  /**
   * 本地日期串 "YYYY-MM-DD"。
   * 统一入口：全站禁止再用 toISOString().slice(0,10)——那是 UTC，东八区 08:00 前会算成前一天。
   * @param {Date|string|number} [d] 缺省取当前时间
   * @returns {string} 非法输入返回 ""
   */
  function todayLocal(d) {
    var date = (d == null) ? new Date() : (d instanceof Date ? d : new Date(d));
    if (isNaN(date.getTime())) return "";
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }

  /** 本地月份串 "YYYY-MM"（同 todayLocal 的时区口径） */
  function monthLocal(d) {
    var s = todayLocal(d);
    return s ? s.slice(0, 7) : "";
  }

  /** 时间显示格式化："YYYY-MM-DD HH:mm" */
  function fmtDateTime(d) {
    if (!d) return "-";
    var date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) return "-";
    return todayLocal(date) + " " + pad2(date.getHours()) + ":" + pad2(date.getMinutes());
  }

  /** Base64 编解码（UTF-8 安全，与现网一致） */

  /* ================= 安全 URL（XSS 防护补丁，2026-09-06） =================
     photoUrls/外链等"用户可控 URL"渲染进 img src / a href 前，必须：
     ① safeUrl 掐掉危险协议（javascript: / data:text/html 等）；
     ② 再经 esc 转义（防 " onerror= 属性逃逸）。
     两件事缺一不可：只 esc 不拦协议 → javascript: 链接仍可点；只拦协议不 esc → 引号仍可逃逸。 */
  function safeUrl(s) {
    s = String(s == null ? "" : s);
    if (/^(https?:)?\/\//i.test(s)) return s;    // http(s) 或协议相对 //host/path
    if (/^data:image\//i.test(s)) return s;      // 本地照片 dataURL（仅图片）
    if (/^blob:/i.test(s)) return s;             // 本地预览 blob
    return "";
  }

  /* ================= 服务器时钟校正（2026-09-06） =================
     多设备"冲突取较新 / 库存时序"此前依赖各自本地 Date.now()，
     设备时钟不准时旧数据会覆盖新数据、库存时序算错。
     方案：每次 GitHub API 成功响应都读 Date 响应头（HTTP GMT 时间），
     算并缓存本机与服务器的时钟偏移；serverNow() 返回校正后的"现在"。
     只要设备联网同步过一次，后续时间戳即与服务器对齐；从未联网时退化为 Date.now()。 */
  var _clockOffset = 0;
  var CLOCK_OFFSET_KEY = "outbound_clock_offset_v1";   // 设备级属性（非业务数据），不按仓隔离

  function loadClockOffset() {
    try {
      var v = Number(localStorage.getItem(CLOCK_OFFSET_KEY) || 0);
      if (isFinite(v)) _clockOffset = v;
    } catch (e) {}
  }
  loadClockOffset();

  /** 观测服务器时间（由 API 层在成功响应时调用；serverDateMs = Date.parse(res.headers.date)）。
      偏移 <30s 不追：Date 头精度仅秒级，避免无谓抖动。 */
  function observeServerTime(serverDateMs) {
    if (!serverDateMs || isNaN(serverDateMs)) return;
    var off = serverDateMs - Date.now();
    if (Math.abs(off) < 30000) return;
    _clockOffset = Math.round(off);
    try { localStorage.setItem(CLOCK_OFFSET_KEY, String(_clockOffset)); } catch (e) {}
  }

  /** 服务器校正后的当前时间戳（毫秒）。新建/编辑/删除等写入时间戳统一走这里。 */
  function serverNow() {
    return Date.now() + _clockOffset;
  }
  function b64enc(str) { return btoa(unescape(encodeURIComponent(str))); }
  function b64dec(b64) { return decodeURIComponent(escape(atob(String(b64).replace(/\s/g, "")))); }

  /** Toast queue: up to 3 stacked; err 3.5s / normal 2.2s (P2.2) */
  function toast(msg, isErr) {
    var root = $("toast-root");
    if (!root) return;
    var shown = root.querySelectorAll(".toast.show");
    if (shown.length >= 3) shown[0].classList.remove("show");   // over quota: fade oldest
    var el = document.createElement("div");
    el.className = "toast" + (isErr ? " err" : "");
    el.textContent = msg;
    el.style.bottom = (34 + root.querySelectorAll(".toast.show").length * 54) + "px";
    root.appendChild(el);
    void el.offsetWidth;  /* force reflow so entry transition runs */
    el.classList.add("show");
    setTimeout(function () {
      el.classList.remove("show");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 400);
    }, isErr ? 3500 : 2200);
  }

  /* 底部可操作提示条（snackbar）：独立于 .toast。
     .toast 在 theme.css 里设了 pointer-events:none，承载不了「撤销」这类可点按钮，
     所以这里自建元素挂到 body，并显式声明 pointer-events:auto。 */
  function snackbar(msg, opts) {
    opts = opts || {};
    var old = document.querySelector(".snackbar");
    if (old && old.parentNode) old.parentNode.removeChild(old);   // 同时只留一条，避免叠罗汉

    var box = document.createElement("div");
    box.className = "snackbar";
    var span = document.createElement("span");
    span.textContent = msg;
    box.appendChild(span);

    var btn = null;
    if (opts.actionText) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "snackbar-action";
      btn.textContent = opts.actionText;
      box.appendChild(btn);
    }
    document.body.appendChild(box);
    requestAnimationFrame(function () { box.classList.add("show"); });

    function close() {
      box.classList.remove("show");
      setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 250);
    }
    var timer = setTimeout(function () {
      close();
      if (opts.onTimeout) opts.onTimeout();
    }, opts.duration || 4000);

    if (btn) {
      btn.addEventListener("click", function () {
        clearTimeout(timer);
        close();
        if (opts.onAction) opts.onAction();
      });
    }
    return box;
  }

  /* 特性开关：读 window.App.FEATURES，缺省一律视为开启。
     这样即使总开关脚本被删除或未执行，也不会让功能意外失效。 */
  function feature(name) {
    var f = (window.App && window.App.FEATURES) || {};
    return f[name] !== false;
  }

  /** 下载文件（Blob） */
  function download(filename, content, mime) {
    var blob = content instanceof Blob
      ? content
      : new Blob([content], { type: mime || "text/plain;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  window.App = window.App || {};
  /** 批量写入影响面统计（2026-09-26 A3）：{add 新增 / upd 被覆盖 / same 无变化}
      导入、恢复备份这类操作会一次性改掉成百上千条，动手前必须让用户看清「会动到多少条」。 */
  function bulkStat(localArr, incoming) {
    var have = {};
    (localArr || []).forEach(function (r) { if (r && r.id) have[r.id] = r; });
    var add = 0, upd = 0, same = 0;
    (incoming || []).forEach(function (r) {
      if (!r || !r.id) { add++; return; }
      if (!have[r.id]) { add++; return; }
      if (JSON.stringify(have[r.id]) === JSON.stringify(r)) { same++; } else { upd++; }
    });
    return { add: add, upd: upd, same: same };
  }

  /** 批量写入前的自动快照（2026-09-26 A3）。
      导入/恢复一旦执行就覆盖成百上千条，选错文件只能干瞪眼。现在动手前先自动把当前
      全量数据下载到「下载」目录（文件名带操作名 + 时间戳），真出事拿这份文件再走一次
      「恢复备份」就能原地回滚。下载失败不阻断主流程，但会明确提示用户。 */
  function snapshotBeforeBulk(label) {
    try {
      var St = (window.App && window.App.State) || {};
      var pkg = {
        exportedAt: new Date().toISOString(),
        _snapshot: String(label || "bulk"),
        records: St.list || [],
        pickups: St.pickups || [],
        memos: St.memos || [],
        catalog: (window.App.Catalog && window.App.Catalog.get()) || null
      };
      var d = new Date();
      var ts = todayLocal() + "_" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
      download("回滚快照_" + String(label || "bulk") + "_" + ts + ".json",
        JSON.stringify(pkg, null, 1), "application/json;charset=utf-8");
      return true;
    } catch (e) { return false; }
  }

  window.App.Util = {
    $: $,
    esc: esc,
    genId: genId,
    pad2: pad2,
    nowLocal: nowLocal,
    todayLocal: todayLocal,
    monthLocal: monthLocal,
    fmtDateTime: fmtDateTime,
    b64enc: b64enc,
    b64dec: b64dec,
    toast: toast,
    snackbar: snackbar,
    feature: feature,
    download: download,
    bulkStat: bulkStat,
    snapshotBeforeBulk: snapshotBeforeBulk,
    safeUrl: safeUrl,
    observeServerTime: observeServerTime,
    serverNow: serverNow
  };
})();
