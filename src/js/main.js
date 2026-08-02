/**
 * main.js — 启动器：初始化 State → 兼容旧 #/verify → 启动 Router
 * 必须在所有模块之后加载（index.html 中脚本顺序固定）。
 */
(function () {
  'use strict';

  function init() {
    window.App.State.init();
    // 首版遗留 #/verify 链接兼容：一律回落 #/（router.parse 亦兜底）
    if (location.hash.indexOf("#/verify") === 0) {
      location.replace("#/");
    }
    window.App.Router.start();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
