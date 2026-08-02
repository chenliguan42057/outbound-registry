/**
 * stock.js — 库存查询模块：全货品库存表格 + 搜索 + 低库存（<30）高亮
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Config = window.App.Config;
  var Stock = window.App.Stock;

  var container = null;
  var tableBox = null;
  var q = "";

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="card">' +
        '<h2>库存查询 <span class="tag">实时计算</span></h2>' +
        '<div class="field">' +
          '<input type="text" id="stockSearch" class="search" placeholder="搜索货品名称…" autocomplete="off" />' +
        '</div>' +
        '<div class="stock-summary" id="stockSummary"></div>' +
        '<div id="stockTableBox"></div>' +
      '</div>';
    tableBox = Util.$("stockTableBox");
    var search = Util.$("stockSearch");
    search.addEventListener("input", function () {
      q = search.value.trim().toLowerCase();
      renderTable();
    });
    renderTable();
  }

  /** 云端同步后刷新（仅重建表格，不重置搜索框） */
  function refresh() {
    if (tableBox) renderTable();
  }

  function renderTable() {
    if (!tableBox) return;
    var summary = Stock.summarize();
    var rows = summary.filter(function (s) { return q === "" || s.name.toLowerCase().includes(q); });
    var lowCount = summary.filter(function (s) { return s.stock < Config.LOW_STOCK_THRESHOLD; }).length;
    Util.$("stockSummary").innerHTML =
      '<span class="badge">货品总数 ' + summary.length + '</span> ' +
      '<span class="badge low">低库存（&lt;' + Config.LOW_STOCK_THRESHOLD + '）' + lowCount + ' 项</span>';
    if (!rows.length) {
      tableBox.innerHTML = '<div class="empty">未找到匹配货品</div>';
      return;
    }
    var html = '<div class="table-wrap"><table class="table stock-table"><thead><tr>' +
      '<th>货品名称</th><th>当前库存</th><th>累计入库</th><th>累计出库</th><th>状态</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (s) {
      var low = s.stock < Config.LOW_STOCK_THRESHOLD;
      html += '<tr class="' + (low ? "low-stock" : "") + '">' +
        '<td>' + Util.esc(s.name) + '</td>' +
        '<td class="stock-num">' + s.stock + '</td>' +
        '<td>' + s.inQty + '</td>' +
        '<td>' + s.outQty + '</td>' +
        '<td>' + (low ? '<span class="tag danger-tag">低库存</span>' : '<span class="tag ok-tag">正常</span>') + '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    tableBox.innerHTML = html;
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.stock = { render: render, refresh: refresh };
})();
