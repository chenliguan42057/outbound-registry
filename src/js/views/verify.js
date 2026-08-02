/**
 * verify.js — 验证页：锁图标 + "设置访问" + 密码输入（回车提交）+ 进入/返回 + 错误提示 + 记住登录
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Auth = window.App.Auth;
  var Router = window.App.Router;

  var errTimer = null;

  function render() {
    var el = Util.$("view-verify");
    if (!el) return;
    el.innerHTML =
      '<div class="verify">' +
        '<div class="verify-card">' +
          '<div class="verify-lock">' + UI.icon("lock", 34) + '</div>' +
          '<h2 class="verify-title">设置访问</h2>' +
          '<p class="verify-sub">请输入访问密码进入应用页</p>' +
          '<input type="password" id="verifyPw" class="verify-input" placeholder="请输入密码" autocomplete="off" />' +
          '<div class="verify-err" id="verifyErr"></div>' +
          '<label class="verify-remember"><input type="checkbox" id="verifyRemember" /> 记住登录（7 天内免输密码）</label>' +
          '<div class="verify-actions">' +
            '<button type="button" class="btn" id="verifyEnter">' + UI.icon("lock", 16) + '<span>进入</span></button>' +
            '<button type="button" class="btn ghost" id="verifyBack">' + UI.icon("back", 16) + '<span>返回</span></button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var pw = Util.$("verifyPw");
    var errEl = Util.$("verifyErr");
    var remember = Util.$("verifyRemember");

    function showErr(msg) {
      errEl.textContent = msg;
      errEl.classList.add("show");
      if (errTimer) clearTimeout(errTimer);
      errTimer = setTimeout(function () { errEl.classList.remove("show"); }, 4000);
    }

    function submit() {
      var remain = Auth.remainingLock();
      if (remain > 0) {
        showErr("尝试次数过多，请 " + Math.ceil(remain / 1000) + " 秒后再试");
        return;
      }
      var res = Auth.login(pw.value, remember.checked);
      if (res.ok) {
        errEl.classList.remove("show");
        Router.navigate("/app");
      } else {
        showErr(res.err || "密码错误，请重试");
        pw.select();
      }
    }

    Util.$("verifyEnter").addEventListener("click", submit);
    pw.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    Util.$("verifyBack").addEventListener("click", function () { Router.navigate("/"); });
    setTimeout(function () { pw.focus(); }, 60);
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.verify = { render: render };
})();
