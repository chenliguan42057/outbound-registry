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
  var chartBox = null;
  var q = "";

  /* 排名排序模式（默认库存多→少；不持久化，页面重进回到默认） */
  var rankMode = "stock_desc";

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="card">' +
        '<h2>库存可视化 <span class="tag">Top 10</span></h2>' +
        '<div id="stockChart"></div>' +
      '</div>' +
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
    chartBox = Util.$("stockChart");
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
    renderChart();
    renderTable();
    renderRank();
  }

  /** 云端同步后刷新（仅重建表格与排名，不重置搜索框；保留当前排序状态） */
  function refresh() {
    if (tableBox) renderTable();
    if (rankBox) renderRank();
    if (chartBox) renderChart();
  }

  /* ================= 库存可视化条形图（手写 SVG，零依赖） ================= */

  /** 渲染 Top 10 库存条形图：横向条形，低库存红色、正常绿色 */
  function renderChart() {
    if (!chartBox) return;
    var summary = Stock.summarize()
      .slice()
      .sort(function (a, b) { return b.stock - a.stock; })
      .slice(0, 10);
    if (!summary.length) {
      chartBox.innerHTML = '<div class="empty">暂无数据</div>';
      return;
    }
    var max = summary[0].stock || 1;
    var W = 640, H = 32 * summary.length + 30, barH = 18;
    var esc = Util.esc;
    var rows = summary.map(function (s, i) {
      var w = Math.max(2, Math.round(s.stock / max * (W - 190)));
      var low = s.stock < Config.LOW_STOCK_THRESHOLD;
      var color = low ? "#e74c3c" : "#2ecc71";
      var y = 10 + i * 32;
      return '<text x="0" y="' + (y + 14) + '" font-size="12" fill="' + (low ? "#e74c3c" : "#555") + '">' +
        esc(truncate(s.name, 14)) + '</text>' +
        '<rect x="150" y="' + y + '" width="' + w + '" height="' + barH + '" rx="4" fill="' + color + '" opacity="0.9" />' +
        '<text x="' + (158 + w) + '" y="' + (y + 14) + '" font-size="12" font-weight="bold" fill="' + color + '">' +
        s.stock + '</text>';
    }).join("");
    chartBox.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;" role="img" aria-label="库存条形图">' +
      rows + '</svg>' +
      '<div class="chart-legend">' +
        '<span class="legend-dot low"></span>低库存（&lt;' + Config.LOW_STOCK_THRESHOLD + '）' +
        '<span class="legend-dot ok"></span>正常' +
      '</div>';
  }

  /** 名称截断（超长加省略号，避免顶出 SVG 画布） */
  function truncate(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n) + "…" : s;
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
