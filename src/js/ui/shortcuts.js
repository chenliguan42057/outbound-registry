/**
 * shortcuts.js — 全局快捷键（青屿体验优化 A1，2026-08-08 新增）
 * Ctrl/Cmd+Enter 提交 · g+字母 快速跳转模块 · Ctrl/Cmd+/ 快捷键面板
 * 加载方式：src/index.html 末尾 main.js 之后引入（IIFE 自启动，零依赖）。
 * 纯新增文件，不改动任何既有模块逻辑；编辑控件内不触发 g 序列，避免干扰输入。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Router = window.App.Router;

  /** g+字母 跳转表：模块 id → hash 与说明（与 app.js NAV_ITEMS / router KNOWN_MODULES 对应） */
  var GO_MAP = {
    l: { hash: "/", label: "落地页" },
    d: { hash: "/app/dashboard", label: "仪表盘" },
    s: { hash: "/app/stock", label: "库存" },
    i: { hash: "/app/in", label: "入库" },
    p: { hash: "/app/pickups", label: "待取货" },
    o: { hash: "/app/out-records", label: "出库记录" },
    n: { hash: "/app/in-records", label: "入库记录" },
    r: { hash: "/app/report", label: "报表" },
    b: { hash: "/app/borrow", label: "先借后还" },
    z: { hash: "/app/batch", label: "呆滞管理" },
    m: { hash: "/app/memos", label: "备忘录" },
    a: { hash: "/app/ai", label: "AI 助手" },
    y: { hash: "/app/sync", label: "云端同步" }
  };

  var goPending = false;   // g 序列：等待第二个字母
  var goTimer = null;

  /** 焦点是否在可编辑控件（输入框/文本域/下拉/可编辑区）——是则不响应 g 序列 */
  function inEditable(e) {
    var t = e.target;
    if (!t || !t.tagName) return false;
    var tag = t.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || t.isContentEditable === true;
  }

  /** 触发主提交：点击 #outSubmit（未加载/未禁用时），无表单则轻提示 */
  function triggerSubmit() {
    var btn = document.getElementById("outSubmit");
    if (!btn) { Util.toast("当前页面没有可提交的表单", true); return; }
    if (btn.disabled || (btn.classList && btn.classList.contains("loading"))) return;
    btn.click();
  }

  /* ---------- g 序列悬浮提示（独立小卡片，不占用 toast 通道） ---------- */
  var hintEl = null;
  function ensureHint() {
    if (hintEl) return hintEl;
    hintEl = document.createElement("div");
    hintEl.style.cssText =
      "position:fixed;left:50%;bottom:110px;transform:translateX(-50%) translateY(10px);" +
      "z-index:86;background:rgba(253,252,249,.97);border:1px solid rgba(185,214,199,.9);" +
      "border-radius:16px;box-shadow:0 14px 36px rgba(87,130,111,.25);" +
      "padding:12px 20px;font-size:13px;color:#3C4845;line-height:1.9;max-width:92vw;text-align:center;" +
      "opacity:0;transition:opacity .18s,transform .18s;pointer-events:none;";
    document.body.appendChild(hintEl);
    return hintEl;
  }
  function showGoHint() {
    var el = ensureHint();
    el.textContent = "g + 字母跳转：d 仪表盘 · s 库存 · i 入库 · p 待取货 · o 出库记录 · n 入库记录 · r 报表 · b 借用 · z 呆滞 · m 备忘录 · a AI · y 同步 · l 落地页";
    el.style.opacity = "1";
    el.style.transform = "translateX(-50%) translateY(0)";
  }
  function hideGoHint() {
    if (!hintEl) return;
    hintEl.style.opacity = "0";
    hintEl.style.transform = "translateX(-50%) translateY(10px)";
  }

  /** 快捷键面板（Ctrl+/） */
  function showHelp() {
    var rows = [
      ["Ctrl / Cmd + Enter", "提交当前出库单"],
      ["g + 字母", "快速跳转模块（如 g+s 进库存）"],
      ["Ctrl / Cmd + /", "本快捷键面板"]
    ];
    var html = '<table class="table" style="min-width:0;width:100%;font-size:13px">' +
      rows.map(function (r) {
        return '<tr><td style="white-space:nowrap;font-weight:600;color:var(--mint-600,#57826F)">' +
          Util.esc(r[0]) + '</td><td>' + Util.esc(r[1]) + '</td></tr>';
      }).join("") +
      '</table>' +
      '<div class="hint" style="margin-top:10px;color:var(--ink-500,#74837E)">g+字母：d 仪表盘 · s 库存 · i 入库 · p 待取货 · o 出库记录 · n 入库记录 · r 报表 · b 借用 · z 呆滞 · m 备忘录 · a AI · y 同步 · l 落地页</div>';
    window.App.UI.Modal.show("⌨️ 快捷键", html, { width: "400px" });
  }

  document.addEventListener("keydown", function (e) {
    var mod = e.ctrlKey || e.metaKey;

    // Ctrl/Cmd + Enter：提交出库单（从文本框/文本域内也可触发，方便快速保存）
    if (mod && e.key === "Enter") {
      e.preventDefault();
      triggerSubmit();
      return;
    }
    // Ctrl/Cmd + /：快捷键面板
    if (mod && e.key === "/") {
      e.preventDefault();
      showHelp();
      return;
    }
    // 编辑控件内 / 组合键按下：不响应 g 序列
    if (inEditable(e) || mod || e.altKey) return;

    // g 序列：先按 g（1.5s 内再按目标字母）
    if (e.key === "g" || e.key === "G") {
      e.preventDefault();
      goPending = true;
      showGoHint();
      if (goTimer) clearTimeout(goTimer);
      goTimer = setTimeout(function () { goPending = false; hideGoHint(); }, 1500);
      return;
    }
    if (goPending) {
      goPending = false;
      hideGoHint();
      if (goTimer) { clearTimeout(goTimer); goTimer = null; }
      var target = GO_MAP[e.key.toLowerCase()];
      if (target) Router.navigate(target.hash);
    }
  });
})();
