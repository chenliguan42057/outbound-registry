/**
 * views/ai.js — 管理后台「AI 助手」页面（#/app/ai）
 * 内嵌渲染聊天面板（与落地页浮动面板共用 window.App.AI.Chat 单例）。
 */
(function () {
  'use strict';

  /**
   * 渲染页面：把聊天面板挂载到容器内（position:static 填满）。
   * @param {HTMLElement} el
   */
  function render(el) {
    window.App.AI.Chat.renderEmbedded(el);
  }

  /** 刷新（页面重新激活时调用；聊天面板为单例无需重建） */
  function refresh() {}

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.ai = { render: render, refresh: refresh };
})();
