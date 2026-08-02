/**
 * router.js — hash 路由：#/ 落地页、#/verify 验证页、#/app 应用页
 * 未登录访问 #/app 自动重定向 #/verify；index.html 恒为入口。
 */
(function () {
  'use strict';

  var Auth = window.App.Auth;

  var ROUTES = {
    "/": "landing",
    "/verify": "verify",
    "/app": "app"
  };

  var current = "";
  var started = false;

  /** 解析当前 hash 到合法路由（未知一律回落地页） */
  function parse() {
    var raw = location.hash.replace(/^#/, "") || "/";
    return ROUTES[raw] ? raw : "/";
  }

  /** 跳转（写入 location.hash，触发 hashchange） */
  function navigate(hash) {
    location.hash = hash;
  }

  /** 路由处理：切换容器显示 + 调用对应视图渲染 */
  function handle() {
    var route = parse();
    if (route === "/app" && !Auth.isAuthed()) {
      if (location.hash !== "#/verify") location.hash = "/verify";
      return;
    }
    current = route;
    var name = ROUTES[route];
    var view = window.App.Views[name];
    if (!view) return;
    ["view-landing", "view-verify", "view-app"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = (id === "view-" + name) ? "" : "none";
    });
    view.render();
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
    routes: ROUTES,
    current: function () { return current; },
    navigate: navigate,
    start: start,
    handle: handle,
    guard: guard
  };
})();
