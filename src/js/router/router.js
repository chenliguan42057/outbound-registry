/**
 * router.js — hash 路由：#/ 落地页（免密出库表单）、#/app[/module] 管理页
 * 子路由：#/app/xxx → {base:"app", module:"xxx"}；#/app 等价 #/app/out-records；未知一律回落 #/。
 * 未登录访问 #/app* → 记录 pendingHash → UI.showLoginDialog()（Promise）→ 成功跳回、取消回 #/。
 * 旧 #/verify 链接（首版）不再存在，兼容回落 #/。
 */
(function () {
  'use strict';

  var Auth = window.App.Auth;
  var State = window.App.State;
  /* 注意：UI（components.js）按脚本顺序在 router 之后加载，
     因此此处不捕获 UI 引用，使用时经 window.App.UI 延迟访问。 */

  var current = null;
  var pendingHash = null;   // 未登录时记录的目标 hash，登录成功后跳回
  var started = false;

  /* 管理页合法模块（与 app.js NAV_ITEMS 一一对应；sync 为顶栏☁️按钮直达，不进菜单） */
  var KNOWN_MODULES = {
    dashboard: 1, stock: 1, in: 1, pickups: 1, sync: 1,
    "in-records": 1, "out-records": 1, report: 1, ai: 1
  };

  /** 解析当前 hash 到合法路由对象 */
  function parse() {
    var raw = location.hash.replace(/^#/, "") || "/";
    var parts = raw.split("/").filter(function (s) { return s; });
    if (parts.length && parts[0] === "app") {
      var module = parts[1] || "out-records";
      if (!KNOWN_MODULES[module]) module = "out-records";
      return { base: "app", module: module };
    }
    return { base: "landing" };
  }

  /** 跳转（写入 location.hash，触发 hashchange） */
  function navigate(hash) {
    location.hash = hash;
  }

  /** 切换容器显示 */
  function showView(id) {
    ["view-landing", "view-app"].forEach(function (v) {
      var el = document.getElementById(v);
      if (el) el.style.display = (v === id) ? "" : "none";
    });
  }

  /** 路由处理：守卫弹登录框 + 子路由驱动 mount */
  function handle() {
    var route = parse();

    // 守卫：未认证访问管理页 → 记录目标并弹登录框
    if (route.base === "app" && !Auth.isAuthed()) {
      pendingHash = location.hash || "#/app/out-records";
      window.App.UI.showLoginDialog().then(function (ok) {
        var target = pendingHash;
        pendingHash = null;
        if (ok && target) navigate(target);
        else navigate("/");
      });
      return;
    }

    current = route;

    if (route.base === "landing") {
      showView("view-landing");
      window.App.Views.landing.render();
      return;
    }

    showView("view-app");
    var module = route.module || "out-records";
    if (State.appMounted) window.App.Views.app.mount(module);
    else window.App.Views.app.render(module);
  }

  function start() {
    if (started) return;
    started = true;
    window.addEventListener("hashchange", handle);
    handle();
  }

  /** 认证守卫（供外部查询） */
  function guard() {
    return Auth.isAuthed();
  }

  window.App = window.App || {};
  window.App.Router = {
    current: function () { return current; },
    navigate: navigate,
    start: start,
    handle: handle,
    guard: guard,
    parse: parse
  };
})();
