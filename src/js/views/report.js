/**
 * report.js — 报表统计模块
 * 出/入库汇总卡片 + 库存排行 TOP10 + 近 7/30 天出入库趋势（纯前端，基于 State.list + getStock）
 * v2 增强：日期范围筛选（本周/本月/全部/自定义）+ 筛选区间出入库明细表 + CSV 导出
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Config = window.App.Config;
  var State = window.App.State;
  var Stock = window.App.Stock;
  var Records = window.App.Records;

  var container = null;
  var range = { start: "", end: "" };   // 日期范围（YYYY-MM-DD），空=不限制

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="report">' +
        '<div class="card">' +
          '<div class="actions" style="justify-content:space-between;flex-wrap:wrap;">' +
            '<div class="report-range">' +
              '<button type="button" class="btn ghost sm active" data-range="week">本周</button>' +
              '<button type="button" class="btn ghost sm" data-range="month">本月</button>' +
              '<button type="button" class="btn ghost sm" data-range="all">全部</button>' +
              '<input type="date" id="reportStart" style="width:130px;" />' +
              '<span class="muted">至</span>' +
              '<input type="date" id="reportEnd" style="width:130px;" />' +
              '<button type="button" class="btn sm" id="reportApply">筛选</button>' +
            '</div>' +
            '<button type="button" class="btn ghost sm" id="reportExport">&#11015; 导出 CSV</button>' +
          '</div>' +
        '</div>' +
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
        '<div class="card">' +
          '<h2>区间出入库明细 <span class="badge" id="reportRangeLabel"></span></h2>' +
          '<div id="reportTable"></div>' +
        '</div>' +
      '</div>';

    // 日期范围快捷按钮
    var rangeBtns = el.querySelectorAll("[data-range]");
    for (var i = 0; i < rangeBtns.length; i++) {
      (function (b) {
        b.addEventListener("click", function () {
          for (var j = 0; j < rangeBtns.length; j++) rangeBtns[j].classList.remove("active");
          b.classList.add("active");
          applyPreset(b.getAttribute("data-range"));
        });
      })(rangeBtns[i]);
    }
    // 自定义筛选
    el.querySelector("#reportApply").addEventListener("click", function () {
      var s = el.querySelector("#reportStart").value;
      var e = el.querySelector("#reportEnd").value;
      range = { start: s, end: e };
      for (var j = 0; j < rangeBtns.length; j++) rangeBtns[j].classList.remove("active");
      refresh();
    });
    // CSV 导出（导出当前筛选区间明细）
    el.querySelector("#reportExport").addEventListener("click", function () {
      var arr = filteredRecords();
      if (!arr.length) { Util.toast("当前区间没有记录可导出", true); return; }
      Records.exportCsv(arr);
    });

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
    applyPreset("week");
  }

  /** 按当前 range 过滤记录（日期基于 time 前 10 位 YYYY-MM-DD） */
  function filteredRecords() {
    var list = State.list;
    if (!range.start && !range.end) return list;
    return list.filter(function (r) {
      var t = String(r.time || "").slice(0, 10);
      if (range.start && t < range.start) return false;
      if (range.end && t > range.end) return false;
      return true;
    });
  }

  /** 预设快捷范围：本周/本月/全部 */
  function applyPreset(kind) {
    var now = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    if (kind === "week") {
      var day = now.getDay() || 7;   // 周一=1...周日=7
      var monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (day - 1));
      range = {
        start: monday.getFullYear() + "-" + pad(monday.getMonth() + 1) + "-" + pad(monday.getDate()),
        end: now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate())
      };
    } else if (kind === "month") {
      range = {
        start: now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-01",
        end: now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate())
      };
    } else {
      range = { start: "", end: "" };
    }
    if (container) {
      container.querySelector("#reportStart").value = range.start;
      container.querySelector("#reportEnd").value = range.end;
    }
    refresh();
  }

  /** 云端同步后刷新（保留当前筛选） */
  function refresh() {
    if (!container) return;
    renderCards();
    renderRank();
    renderTable();
    var active = container.querySelector(".trend-tabs .btn.active");
    renderTrend(active ? Number(active.getAttribute("data-days")) : 7);
  }

  function renderCards() {
    var list = filteredRecords();
    var summary = Stock.summarize();
    var totalOut = 0, totalIn = 0;
    list.forEach(function (r) {
      if (r.affectsStock !== true) return;
      var q = (r.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
      if (r.type === "in") totalIn += q; else totalOut += q;
    });
    var lowCount = summary.filter(function (s) { return s.stock < Config.LOW_STOCK_THRESHOLD; }).length;
    var cards = [
      { label: "区间出库数量", value: totalOut, icon: "out" },
      { label: "区间入库数量", value: totalIn, icon: "in" },
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

  /** 区间出入库明细表（筛选区间内的记录，最新在前） */
  function renderTable() {
    var list = filteredRecords().slice().sort(function (a, b) {
      return String(b.time || "").localeCompare(String(a.time || "")) || (b._ts || 0) - (a._ts || 0);
    });
    var label = range.start
      ? (range.start + (range.end && range.end !== range.start ? " ~ " + range.end : ""))
      : "全部";
    container.querySelector("#reportRangeLabel").textContent = label + " · " + list.length + " 条";
    if (!list.length) {
      container.querySelector("#reportTable").innerHTML = '<div class="empty">该区间暂无出入库记录</div>';
      return;
    }
    var rows = list.map(function (r) {
      var items = (r.items || []).map(function (it) { return Util.esc(it.name) + " ×" + it.qty; }).join("； ");
      return '<tr>' +
        '<td>' + Util.esc(String(r.time || "").replace("T", " ")) + '</td>' +
        '<td>' + (r.type === "in" ? "入库" : "出库") + '</td>' +
        '<td>' + Util.esc(r.picker || "-") + '</td>' +
        '<td>' + Util.esc(r.purpose || "-") + '</td>' +
        '<td>' + items + '</td>' +
      '</tr>';
    }).join("");
    container.querySelector("#reportTable").innerHTML =
      '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>时间</th><th>类型</th><th>领取人</th><th>用途</th><th>货品</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.report = { render: render, refresh: refresh };
})();
