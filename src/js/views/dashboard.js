/**
 * dashboard.js — 仪表盘：数据概览卡片 + 低库存预警 + 最近出库
 * 纯前端计算，基于 State.list + Stock.summarize。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Config = window.App.Config;
  var State = window.App.State;
  var Stock = window.App.Stock;

  var container = null;

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="dash-page">' +
        '<div class="dash-cards" id="dashCards"></div>' +
        '<div class="grid2">' +
          '<div class="card"><h2>低库存预警 <span class="tag">&lt;' + Config.LOW_STOCK_THRESHOLD + '</span></h2><div id="dashLow"></div></div>' +
          '<div class="card"><h2>最近出库</h2><div id="dashRecent"></div></div>' +
        '</div>' +
      '</div>';
    renderCards();
    renderLow();
    renderRecent();
  }

  /** 云端同步后刷新 */
  function refresh() {
    if (!container) return;
    renderCards();
    renderLow();
    renderRecent();
  }

  function renderCards() {
    var list = State.list;
    var d = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var today = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    var todayOut = 0, todayIn = 0;
    list.forEach(function (r) {
      if (r.affectsStock !== true) return;
      if (String(r.time || "").slice(0, 10) !== today) return;
      var q = (r.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
      if (r.type === "in") todayIn += q; else todayOut += q;
    });
    var lowCount = Stock.summarize().filter(function (s) { return s.stock < Config.LOW_STOCK_THRESHOLD; }).length;
    var cards = [
      { label: "本地记录数", value: list.length, icon: "records" },
      { label: "今日出库", value: todayOut, icon: "out" },
      { label: "今日入库", value: todayIn, icon: "in" },
      { label: "低库存项", value: lowCount, icon: "stock" }
    ];
    Util.$("dashCards").innerHTML = cards.map(function (c) {
      return '<div class="dash-card">' +
        '<div class="dash-card-icon">' + UI.icon(c.icon, 22) + '</div>' +
        '<div class="dash-card-value">' + c.value + '</div>' +
        '<div class="dash-card-label">' + c.label + '</div>' +
      '</div>';
    }).join("");
  }

  function renderLow() {
    var low = Stock.summarize()
      .filter(function (s) { return s.stock < Config.LOW_STOCK_THRESHOLD; })
      .sort(function (a, b) { return a.stock - b.stock; })
      .slice(0, 8);
    var html = low.map(function (s) {
      return '<div class="rank-row">' +
        '<span class="rank-no">' + s.stock + '</span>' +
        '<span class="rank-name">' + Util.esc(s.name) + '</span>' +
        '<span class="rank-val danger-text">库存 ' + s.stock + '</span>' +
      '</div>';
    }).join("");
    Util.$("dashLow").innerHTML = html || '<div class="empty">暂无低库存货品</div>';
  }

  function renderRecent() {
    var recs = State.list.filter(function (r) { return (r.type || "out") !== "in"; }).slice(0, 8);
    var html = recs.map(function (r) {
      var items = (r.items || []).map(function (it) { return it.name + "×" + it.qty; }).join("、");
      return '<div class="recent-row">' +
        '<div class="recent-main">' +
          '<div class="recent-title">' + Util.esc(r.dept || "未知客户") +
            (r.picker ? "（" + Util.esc(r.picker) + "）" : "") + '</div>' +
          '<div class="recent-items">' + Util.esc(items) + '</div>' +
        '</div>' +
        '<div class="recent-time">' + Util.esc(String(r.time || "").replace("T", " ")) + '</div>' +
      '</div>';
    }).join("");
    Util.$("dashRecent").innerHTML = html || '<div class="empty">暂无出库记录</div>';
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.dashboard = { render: render, refresh: refresh };
})();
