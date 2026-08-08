/**
 * dingtalk.js — 钉钉卡片跳转网页适配（2026-08-08 第三轮）
 * 从钉钉卡片点「打开出库登记」进入落地页时：
 *   - URL 带 ?from=card 或运行于钉钉内置浏览器（UA 含 DingTalk）
 *   - 自动聚焦「一句话快速登记」输入框并滚动到可视区，方便直接输入/语音登记
 * 纯新增文件，MutationObserver 幂等，不影响普通访问。
 */
(function () {
  'use strict';

  var UA = navigator.userAgent || "";
  var fromCard = /from=card/.test(location.search || "");
  var inDing = /dingtalk/i.test(UA) || /ali-app/i.test(UA);

  if (!fromCard && !inDing) return;   // 普通访问不做任何事

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
      clearInterval(timer);   // 8 秒内没等到表单则放弃
    }
  }, 400);
})();
