/**
 * stock.js — 库存查询模块：全货品库存表格 + 搜索 + 低库存（<95）高亮
 * 第六轮增量：新增「全部库存排名」卡片（全量展示 + 4 种排序 + 低库存红色高亮），
 *             与现有搜索表格完全解耦（renderTable / renderRank 互不干扰）。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Config = window.App.Config;
  var Stock = window.App.Stock;

  var container = null;
  var tableBox = null;
  var rankBox = null;
  var q = "";

  /* 排名排序模式（默认库存多→少；不持久化，页面重进回到默认） */
  var rankMode = "stock_desc";

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
      '</div>' +
      '<div class="card">' +
        '<h2>全部库存排名 <span class="tag">全量</span></h2>' +
        '<div class="rank-sort">' +
          '<label>排序：</label>' +
          '<select id="rankSort">' + sortOptionsHtml() + '</select>' +
        '</div>' +
        '<div id="rankBox"></div>' +
      '</div>';
    tableBox = Util.$("stockTableBox");
    rankBox = Util.$("rankBox");
    var search = Util.$("stockSearch");
    search.addEventListener("input", function () {
      q = search.value.trim().toLowerCase();
      renderTable();
    });
    var sort = Util.$("rankSort");
    sort.addEventListener("change", function () {
      rankMode = sort.value;
      renderRank();
    });
    renderTable();
    renderRank();
  }

  /** 云端同步后刷新（仅重建表格与排名，不重置搜索框；保留当前排序状态） */
  function refresh() {
    if (tableBox) renderTable();
    if (rankBox) renderRank();
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

  /* ================= 全部库存排名（第六轮增量） ================= */

  /** 排序下拉 HTML（选项来自 Config.RANK_SORT_OPTIONS，当前 rankMode 选中） */
  function sortOptionsHtml() {
    return (Config.RANK_SORT_OPTIONS || []).map(function (o) {
      return '<option value="' + Util.esc(o.value) + '"' + (o.value === rankMode ? " selected" : "") + '>' +
        Util.esc(o.label) + '</option>';
    }).join("");
  }

  /** 名称排序：localeCompare("zh-Hans-CN")，异常回落码点比较（决策 D-4） */
  function compareName(x, y) {
    try {
      return x.localeCompare(y, "zh-Hans-CN");
    } catch (e) {
      return x < y ? -1 : (x > y ? 1 : 0);
    }
  }

  /** 按当前 rankMode 比较两个汇总项 */
  function rankCompare(a, b) {
    if (rankMode === "stock_asc") return a.stock - b.stock;
    if (rankMode === "name_asc") return compareName(a.name, b.name);
    if (rankMode === "name_desc") return compareName(b.name, a.name);
    return b.stock - a.stock;   // stock_desc（默认）
  }

  /** 全量排名渲染：排名/货品名称/当前库存/状态；低库存行红色高亮 + tag */
  function renderRank() {
    if (!rankBox) return;
    var summary = Stock.summarize();
    if (!summary.length) {
      rankBox.innerHTML = '<div class="empty">暂无数据</div>';
      return;
    }
    var arr = summary.slice().sort(rankCompare);
    var html = '<div class="table-wrap"><table class="table stock-table rank-table"><thead><tr>' +
      '<th>排名</th><th>货品名称</th><th>当前库存</th><th>状态</th>' +
      '</tr></thead><tbody>';
    arr.forEach(function (s, i) {
      var low = s.stock < Config.LOW_STOCK_THRESHOLD;
      html += '<tr class="' + (low ? "low-stock" : "") + '">' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + Util.esc(s.name) + '</td>' +
        '<td class="stock-num' + (low ? " danger-text" : "") + '">' + s.stock + '</td>' +
        '<td>' + (low ? '<span class="tag danger-tag">低库存</span>' : '<span class="tag ok-tag">正常</span>') + '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    rankBox.innerHTML = html;
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.stock = { render: render, refresh: refresh };
})();
