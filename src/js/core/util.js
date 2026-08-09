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
  function b64enc(str) { return btoa(unescape(encodeURIComponent(str))); }
  function b64dec(b64) { return decodeURIComponent(escape(atob(String(b64).replace(/\s/g, "")))); }

  /** Toast 提示（复用 #toast-root 容器） */
  var toastTimer = null;
  function toast(msg, isErr) {
    var root = $("toast-root");
    if (!root) return;
    var el = root.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      root.appendChild(el);
    }
    el.textContent = msg;
    el.className = "toast show" + (isErr ? " err" : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, 2200);
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
    download: download
  };
})();
