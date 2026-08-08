/**
 * dingtalk.js — 钉钉卡片跳转网页适配（2026-08-08 第三轮；2026-08-08 修复版）
 *
 * 工作机制：
 *   - 钉钉内置浏览器对 hash 路由 URL 兼容性不佳，所以管理后台按钮改用 ?goto=app 查询形式，
 *     本脚本检测 query 参数后用 location.hash 触发 SPA 路由跳转（hashchange 走 router）。
 *   - from=card 或运行于钉钉内置浏览器时，自动聚焦「一句话快速登记」输入框。
 *   - ?goto=app → 跳转到管理后台（#/app/out-records，触发登录框）。
 *
 * 普通访问（非钉钉、非 from 参数）不做任何事。
 */
(function () {
  'use strict';

  var UA = navigator.userAgent || "";
  var search = location.search || "";
  var inDing = /dingtalk/i.test(UA) || /ali-app/i.test(UA);
  var fromCard = /from=card/.test(search);
  var gotoApp = /(?:\?|&)goto=app\b/.test(search);

  // 1) ?goto=app：跳管理后台（避开钉钉内置浏览器 hash 直接加载失效的问题）
  if (gotoApp) {
    var triesG = 0;
    var tG = setInterval(function () {
      triesG++;
      // 等待 router / App 注册完成
      if (window.App && window.App.Router) {
        clearInterval(tG);
        try { window.App.Router.navigate("/app/out-records"); }
        catch (e) { location.hash = "#/app/out-records"; }
      } else if (triesG > 25) {
        clearInterval(tG);
        location.hash = "#/app/out-records";
      }
    }, 200);
  }

  // 2) from=card 或钉钉内置浏览器：自动聚焦快速登记条 + 提示
  if (!fromCard && !inDing) return;

  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var inp = document.getElementById("quickRegInput");
    if (inp) {
      clearInterval(timer);
      try {
        inp.scrollIntoView({ behavior: "smooth", block: "center" });
        inp.focus();
        var toast = window.App && window.App.Util && window.App.Util.toast;
        if (toast) toast("🌿 欢迎从钉钉进入，可直接登记或点 🎤 语音");
      } catch (e) {}
    } else if (tries > 30) {
      clearInterval(timer);
    }
  }, 400);
})();