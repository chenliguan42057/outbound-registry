/**
 * report.js — 报表统计模块
 * 出/入库汇总卡片 + 库存排行 TOP10 + 近 7/30 天出入库趋势（纯前端，基于 State.list + getStock）
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
      '<div class="report">' +
        '<div class="report-cards" id="reportCards"></div>' +
        '<div class="grid2">' +
          '<div class="card">' +
            '<h2>库存排行 TOP10</h2>' +
            '<div id="reportRank"></div>' +
          '</div>' +
          '<div class="card">' +
            '<h2>出入库趋势</h2>' +
            '<div class="trend-tabs">' +
              '<button type="button" class="btn ghost sm active" data-days="7">近 7 天</button>' +
              '<button type="button" class="btn ghost sm" data-days="30">近 30 天</button>' +
            '</div>' +
            '<div id="reportTrend"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    var tabs = el.querySelectorAll(".trend-tabs .btn");
    for (var i = 0; i < tabs.length; i++) {
      (function (b) {
        b.addEventListener("click", function () {
          for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove("active");
          b.classList.add("active");
          renderTrend(Number(b.getAttribute("data-days")));
        });
      })(tabs[i]);
    }
    renderCards();
    renderRank();
    renderTrend(7);
  }

  /** 云端同步后刷新（保留当前 tab） */
  function refresh() {
    if (!container) return;
    renderCards();
    renderRank();
    var active = container.querySelector(".trend-tabs .btn.active");
    renderTrend(active ? Number(active.getAttribute("data-days")) : 7);
  }

  function renderCards() {
    var list = State.list;
    var summary = Stock.summarize();
    var totalOut = 0, totalIn = 0;
    list.forEach(function (r) {
      if (r.affectsStock !== true) return;
      var q = (r.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
      if (r.type === "in") totalIn += q; else totalOut += q;
    });
    var lowCount = summary.filter(function (s) { return s.stock < Config.LOW_STOCK_THRESHOLD; }).length;
    var cards = [
      { label: "总出库数量", value: totalOut, icon: "out" },
      { label: "总入库数量", value: totalIn, icon: "in" },
      { label: "货品种类数", value: summary.length, icon: "box" },
      { label: "低库存数", value: lowCount, icon: "stock" }
    ];
    container.querySelector("#reportCards").innerHTML = cards.map(function (c) {
      return '<div class="report-card">' +
        '<div class="report-card-icon">' + UI.icon(c.icon, 22) + '</div>' +
        '<div class="report-card-value">' + c.value + '</div>' +
        '<div class="report-card-label">' + c.label + '</div>' +
      '</div>';
    }).join("");
  }

  function renderRank() {
    var summary = Stock.summarize().sort(function (a, b) { return b.stock - a.stock; }).slice(0, 10);
    var max = summary.length ? summary[0].stock : 1;
    var html = summary.map(function (s, i) {
      var pct = Math.max(2, Math.round(s.stock / max * 100));
      return '<div class="rank-row">' +
        '<span class="rank-no">' + (i + 1) + '</span>' +
        '<span class="rank-name">' + Util.esc(s.name) + '</span>' +
        '<div class="rank-bar"><div class="rank-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="rank-val">' + s.stock + '</span>' +
      '</div>';
    }).join("");
    container.querySelector("#reportRank").innerHTML = html || '<div class="empty">暂无数据</div>';
  }

  function renderTrend(days) {
    var data = Stock.trend(State.list, days);
    var max = data.reduce(function (m, d) { return Math.max(m, d.outQty, d.inQty); }, 0) || 1;
    var html = '<div class="trend-chart">' + data.map(function (d) {
      var outH = Math.round(d.outQty / max * 100);
      var inH = Math.round(d.inQty / max * 100);
      var label = d.date.slice(5);
      return '<div class="trend-col">' +
        '<div class="trend-bars">' +
          '<div class="trend-bar out" style="height:' + (outH || 1) + '%" title="出库 ' + d.outQty + '"></div>' +
          '<div class="trend-bar in" style="height:' + (inH || 1) + '%" title="入库 ' + d.inQty + '"></div>' +
        '</div>' +
        '<div class="trend-label">' + label + '</div>' +
        '<div class="trend-total">' + (d.outQty + d.inQty) + '</div>' +
      '</div>';
    }).join("") + '</div>';
    html += '<div class="trend-legend"><span class="legend-dot out"></span>出库 <span class="legend-dot in"></span>入库</div>';
    container.querySelector("#reportTrend").innerHTML = html;
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.report = { render: render, refresh: refresh };
})();
