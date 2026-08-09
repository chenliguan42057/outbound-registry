/**
 * ux.js — 体验增强总控（D2 深色模式 / D3 微交互 / D5 无障碍，2026-08-08 第二批）
 * 提供：主题设置面板（深色 / 字号 / 高对比 / 强调色 / 音效）+ 顶部细进度条 + count-up 动画
 * 设置存 localStorage(outbound_ux_v1)；纯新增文件，不侵入既有模块。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;

  var KEY = "outbound_ux_v1";
  var SETTINGS = { theme: "auto", font: "md", contrast: false, accent: "mint", sound: false };

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || "{}");
      for (var k in SETTINGS) if (s[k] !== undefined) SETTINGS[k] = s[k];
    } catch (e) {}
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(SETTINGS)); } catch (e) {} }
  function apply() {
    var root = document.documentElement;
    var theme = SETTINGS.theme;
    // “自动”跟随系统深色偏好（prefers-color-scheme）；不支持 matchMedia 时回退浅色
    if (theme === "auto") {
      theme = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
    }
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-font", SETTINGS.font);
    root.setAttribute("data-accent", SETTINGS.accent);
    root.setAttribute("data-contrast", SETTINGS.contrast ? "high" : "");
  }

  /* ================= 顶部细进度条 ================= */
  var barEl = null;
  function ensureBar() {
    if (barEl) return barEl;
    barEl = document.createElement("div");
    barEl.className = "ux-bar";
    document.body.appendChild(barEl);
    return barEl;
  }
  var barTimer = null;
  function startProgress() {
    var b = ensureBar();
    b.classList.add("on");
    b.style.width = "70%";
    if (barTimer) clearTimeout(barTimer);
    barTimer = setTimeout(function () { b.style.width = "100%"; }, 500);
  }
  function doneProgress() {
    var b = ensureBar();
    b.style.width = "100%";
    if (barTimer) clearTimeout(barTimer);
    setTimeout(function () {
      b.classList.remove("on");
      b.style.width = "0";
    }, 260);
  }

  /* ================= 音效（默认关） ================= */
  var audioCtx = null;
  function beep(ok) {
    if (!SETTINGS.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.type = "sine";
      o.frequency.value = ok ? 880 : 320;
      g.gain.setValueAtTime(0.001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.28);
      o.start();
      o.stop(audioCtx.currentTime + 0.3);
    } catch (e) {}
  }

  /* ================= count-up 数字动画 ================= */
  function countUp(el, to, dur) {
    if (!el) return;
    to = Number(to) || 0;
    dur = dur || 600;
    var start = null;
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min(1, (ts - start) / dur);
      el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = to;
    }
    requestAnimationFrame(step);
  }

  /* ================= 设置面板 ================= */
  function openSettings() {
    var chip = function (val, label, cur, group) {
      return '<button type="button" class="ux-settings-chip' + (cur === val ? " on" : "") +
        '" data-group="' + group + '" data-val="' + val + '">' + label + '</button>';
    };
    var body =
      '<div class="ux-settings-row"><span class="k">🌙 深色模式</span><span class="v">' +
        chip("auto", "自动", SETTINGS.theme, "theme") +
        chip("light", "浅色", SETTINGS.theme, "theme") +
        chip("dark", "深色", SETTINGS.theme, "theme") + '</span></div>' +
      '<div class="ux-settings-row"><span class="k">🔠 字号</span><span class="v">' +
        chip("md", "标准", SETTINGS.font, "font") +
        chip("lg", "大", SETTINGS.font, "font") +
        chip("xl", "特大", SETTINGS.font, "font") + '</span></div>' +
      '<div class="ux-settings-row"><span class="k">🎨 强调色</span><span class="v">' +
        chip("mint", "薄荷", SETTINGS.accent, "accent") +
        chip("cyan", "浅青", SETTINGS.accent, "accent") +
        chip("lavender", "淡紫", SETTINGS.accent, "accent") +
        chip("warm", "暖阳", SETTINGS.accent, "accent") + '</span></div>' +
      '<div class="ux-settings-row"><span class="k">👁 高对比</span><span class="v">' +
        chip("off", "关闭", SETTINGS.contrast ? "on" : "off", "contrast") +
        chip("on", "开启", SETTINGS.contrast ? "on" : "off", "contrast") + '</span></div>' +
      '<div class="ux-settings-row"><span class="k">🔔 操作音效</span><span class="v">' +
        chip("off", "关闭", SETTINGS.sound ? "on" : "off", "sound") +
        chip("on", "开启", SETTINGS.sound ? "on" : "off", "sound") + '</span></div>' +
      '<div class="hint" style="margin-top:12px">深色模式适合夜间/弱光环境；字号放大与高对比可减轻长时间用眼负担。设置仅保存在本机。</div>';
    UI.Modal.show("⚙️ 显示与体验", body, { width: "440px" });
    var mBody = UI.Modal.body();
    mBody.addEventListener("click", function (e) {
      var b = e.target.closest(".ux-settings-chip");
      if (!b) return;
      var g = b.getAttribute("data-group");
      var v = b.getAttribute("data-val");
      if (g === "theme") SETTINGS.theme = v;
      else if (g === "font") SETTINGS.font = v;
      else if (g === "accent") SETTINGS.accent = v;
      else if (g === "contrast") SETTINGS.contrast = (v === "on");
      else if (g === "sound") SETTINGS.sound = (v === "on");
      save(); apply();
      // 更新当前面板内高亮
      var chips = mBody.querySelectorAll(".ux-settings-chip[data-group='" + g + "']");
      chips.forEach(function (c) { c.classList.toggle("on", c.getAttribute("data-val") === v); });
      beep(true);
    });
  }

  /* ================= 注入 ⚙ 按钮 ================= */
  function injectButtons() {
    // 管理后台顶栏右侧（同步按钮前）
    var right = document.querySelector(".win-topbar-right");
    if (right && !right.querySelector(".ux-settings-btn")) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "win-topbar-sync ux-settings-btn";
      btn.title = "显示与体验设置";
      btn.innerHTML = UI.icon("settings", 18);
      btn.addEventListener("click", openSettings);
      right.insertBefore(btn, right.firstChild);
    }
    // 落地页顶栏（管理按钮前）
    var landing = document.querySelector(".landing-topbar");
    if (landing && !landing.querySelector(".ux-settings-btn")) {
      var lb = document.createElement("button");
      lb.type = "button";
      lb.className = "win-topbar-sync ux-settings-btn";
      lb.title = "显示与体验设置";
      lb.style.width = "34px"; lb.style.height = "34px";
      lb.innerHTML = UI.icon("settings", 17);
      lb.addEventListener("click", openSettings);
      landing.insertBefore(lb, landing.querySelector(".landing-admin"));
    }
  }

  /* ================= 初始化 ================= */
  load();
  apply();
  // 用户选择“自动”时，跟随系统深浅色实时切换（切换浅/深手动档则不受影响）
  if (window.matchMedia) {
    var _mq = window.matchMedia("(prefers-color-scheme: dark)");
    var _onMq = function () { if (SETTINGS.theme === "auto") apply(); };
    if (_mq.addEventListener) _mq.addEventListener("change", _onMq);
    else if (_mq.addListener) _mq.addListener(_onMq);   // 旧版 Safari 兼容
  }

  /**
   * 顶栏（.win-topbar-right / .landing-topbar）是路由渲染视图之后才存在的 DOM。
   * 本文件在 index.html 里同步执行，此刻 Router 尚未 start，两个挂载点都还不存在，
   * 于是「⚙ 显示与体验设置」按钮从未被插入 —— 深色模式、字号、音效整套设置都无从触达。
   * 修法：DOM 就绪后先试一次，之后由下面的 MutationObserver 持续补挂（injectButtons 自身幂等）。
   */
  function boot() {
    ensureBar();
    injectButtons();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // 路由/加载时进度条
  window.addEventListener("hashchange", function () {
    startProgress();
    setTimeout(doneProgress, 650);
    injectButtons();          // 落地页 ⇄ 管理页切换会重建顶栏，需要重新补挂
  });
  window.addEventListener("load", function () {
    startProgress();
    setTimeout(doneProgress, 700);
    boot();
  });

  // DOM 变动观察：① 成功页出现时响一声 ② 顶栏出现时补挂设置按钮
  // 用 rAF 合并高频变动，避免视图批量重建时反复查询。
  var obsPending = false;
  var fxObs = new MutationObserver(function () {
    if (obsPending) return;
    obsPending = true;
    requestAnimationFrame(function () {
      obsPending = false;
      if (document.querySelector(".fx-success")) beep(true);
      injectButtons();
    });
  });
  if (document.body) {
    fxObs.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener("DOMContentLoaded", function () {
      fxObs.observe(document.body, { childList: true, subtree: true });
    });
  }

  window.App = window.App || {};
  window.App.UX = {
    openSettings: openSettings,
    countUp: countUp,
    beep: beep,
    get: function () { return SETTINGS; },
    set: function (k, v) { SETTINGS[k] = v; save(); apply(); }
  };
})();
