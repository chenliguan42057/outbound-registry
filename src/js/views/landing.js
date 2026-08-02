/**
 * landing.js — 落地页：顶栏（品牌标题 + 管理按钮）+ 免密出库表单（复用 Views.out 全能力）
 * 管理入口：未登录弹登录框（UI.showLoginDialog），成功后跳 #/app/out；已登录直接进入。
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
          '<span class="landing-brand">' + Util.esc(Config.BRAND_TITLE) + '</span>' +
          '<button type="button" class="btn ghost sm" id="landingAdmin">管理</button>' +
        '</header>' +
        '<div class="landing-body">' +
          '<div class="landing-form" id="landingForm"></div>' +
        '</div>' +
      '</div>';

    Util.$("landingAdmin").addEventListener("click", function () {
      if (Auth.isAuthed()) { Router.navigate("/app/out"); return; }
      UI.showLoginDialog().then(function (ok) {
        if (ok) Router.navigate("/app/out");
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
