/**
 * landing.js — 落地页：顶栏（品牌标题 + 当前仓标识 + 隐形管理入口）+ 免密出库表单（复用 Views.out 全能力）
 * 2026-09-06 精简：移除「最近提交」卡片与 AI 浮动小机器人；「管理」按钮隐形但保留原位可点（弹密码框）。
 * 顶栏仓标识（#landingSysTag）随法人切换实时更新（由 out.js 在 switchSystem 后写入）。
 * 管理入口：未登录弹登录框（UI.showLoginDialog），成功后跳 #/app/out-records；已登录直接进入。
 * pendingEditId：出库记录模块编辑某条记录时设置，落地页渲染后自动进入编辑态（保留照片等全字段）。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Router = window.App.Router;
  var Config = window.App.Config;
  var Auth = window.App.Auth;

  var pendingEditId = null;

  function render() {
    var el = Util.$("view-landing");
    if (!el) return;
    el.innerHTML =
      '<div class="landing">' +
        '<header class="landing-topbar">' +
          '<span class="landing-brand">' + Util.esc(Config.BRAND_TITLE) +
            '<span class="landing-sys" id="landingSysTag" style="display:inline-block;margin-left:8px;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;vertical-align:2px;background:linear-gradient(120deg,#A79ED0 0%,#7FB3A5 100%)">' +
              Util.esc(Config.Sys.name()) + '</span></span>' +
          '<button type="button" class="landing-admin" id="landingAdmin"><span class="landing-admin-emoji">🖥️</span> 管理 ➜</button>' +
        '</header>' +
        '<div class="landing-body">' +
          '<div class="landing-form" id="landingForm"></div>' +
        '</div>' +
      '</div>';

    // 顶栏「管理」按钮：位置不变、肉眼不可见（CSS opacity:0），点击仍弹登录框 —— 主理人 2026-09-06 要求
    Util.$("landingAdmin").addEventListener("click", function () {
      if (Auth.isAuthed()) { Router.navigate("/app/out-records"); return; }
      UI.showLoginDialog().then(function (ok) {
        if (ok) Router.navigate("/app/out-records");
      });
    });

    // 复用 out.js 免密出库表单（out* 前缀 id 仅存在于落地页）
    window.App.Views.out.render(Util.$("landingForm"));

    // pendingEditId：从出库记录跳回编辑（保留照片等全字段）
    if (pendingEditId) {
      var id = pendingEditId;
      pendingEditId = null;
      window.App.Views.out.edit(id);
    }
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.landing = {
    render: render,
    get pendingEditId() { return pendingEditId; },
    set pendingEditId(v) { pendingEditId = v; }
  };
})();
