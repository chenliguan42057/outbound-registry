/**
 * landing.js — 落地页：品牌图标 + 标题"出入库登记表" + 副标题 + 「设置」主按钮 + 页脚
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Router = window.App.Router;

  var rendered = false;

  function render() {
    var el = Util.$("view-landing");
    if (!el) return;
    if (rendered) return;
    rendered = true;
    el.innerHTML =
      '<div class="landing">' +
        '<div class="landing-hero">' + UI.icon("box", 56) + '</div>' +
        '<h1 class="landing-title">出入库登记表</h1>' +
        '<p class="landing-sub">现场出库 / 入库登记与库存管理</p>' +
        '<button type="button" class="btn btn-hero" id="landingSettings">' +
          UI.icon("settings", 18) + '<span>设置</span>' +
        '</button>' +
        '<footer class="landing-foot">© 出入库登记系统 · 数据同步至云端</footer>' +
      '</div>';
    Util.$("landingSettings").addEventListener("click", function () {
      Router.navigate("/verify");
    });
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.landing = { render: render };
})();
