/**
 * views/ai.js — 管理后台「自动识别」页面（#/app/ai）
 *
 * 2026-09-26：原「AI 助手」入口已被「自动识别」功能区替代。
 *   AI 助手代码（src/js/ai/* 七个模块）**完整保留在仓库中**，随时可恢复，只是不再挂在这个入口上。
 *   本文件仅作路由外壳（模块 id 仍为 ai，保证 #/app/ai 旧链接与书签不失效），
 *   把容器交给 Views.recognize 渲染。
 */
(function () {
  'use strict';

  function recognize() {
    return window.App.Views && window.App.Views.recognize;
  }

  /**
   * 渲染页面：交给「自动识别」视图。
   * @param {HTMLElement} el
   */
  function render(el) {
    var R = recognize();
    if (R && typeof R.render === "function") { R.render(el); return; }
    el.innerHTML = '<div class="card"><h2>自动识别</h2>' +
      '<div class="hint">识别组件未就绪，请刷新页面重试。</div></div>';
  }

  /** 刷新（页面重新激活时调用） */
  function refresh() {
    var R = recognize();
    if (R && typeof R.refresh === "function") R.refresh();
  }

  /** 跨页传参代理（目标视图也可直接取 Views.recognize.takePending） */
  function takePending(viewName) {
    var R = recognize();
    return (R && typeof R.takePending === "function") ? R.takePending(viewName) : null;
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.ai = { render: render, refresh: refresh, takePending: takePending };
})();
