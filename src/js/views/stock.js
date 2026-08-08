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
  var State = window.App.State;
  var Records = window.App.Records;
  var Cloud = window.App.Cloud;

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
        '<div class="actions" style="margin:-6px 0 14px">' +
          '<button type="button" class="btn ghost sm" id="stockCatalogBtn">📋 货品目录</button>' +
          '<button type="button" class="btn ghost sm" id="stockTakeBtn">📊 盘点平账</button>' +
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
    Util.$("stockCatalogBtn").addEventListener("click", function () {
      if (window.App.Catalog && window.App.Catalog.openManager) window.App.Catalog.openManager();
      else Util.toast("目录模块未加载", true);
    });
    Util.$("stockTakeBtn").addEventListener("click", openStocktake);
    wireHistory();
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
        '<td class="stock-num" data-name="' + Util.esc(s.name) + '" style="cursor:pointer;text-decoration:underline dotted rgba(111,160,138,.5)">' + s.stock + '</td>' +
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
        '<td class="stock-num' + (low ? " danger-text" : "") + '" data-name="' + Util.esc(s.name) + '" style="cursor:pointer;text-decoration:underline dotted rgba(111,160,138,.5)">' + s.stock + '</td>' +
        '<td>' + (low ? '<span class="tag danger-tag">低库存</span>' : '<span class="tag ok-tag">正常</span>') + '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    rankBox.innerHTML = html;
  }

  /* ================= B3 库存流水追溯 ================= */
  function wireHistory() {
    if (!container || container.getAttribute("data-his")) return;
    container.setAttribute("data-his", "1");
    container.addEventListener("click", function (e) {
      var el = e.target.closest(".stock-num");
      if (!el || !el.getAttribute("data-name")) return;
      showHistory(el.getAttribute("data-name"));
    });
  }
  function showHistory(name) {
    var rows = (State.list || []).filter(function (r) {
      return (r.items || []).some(function (it) { return it.name === name; });
    });
    if (!rows.length) { Util.toast("该货品暂无出入记录", true); return; }
    var html = '<div class="table-wrap" style="max-height:50vh;overflow:auto">' +
      '<table class="table" style="min-width:0;width:100%"><thead><tr>' +
      '<th>时间</th><th>类型</th><th>部门/领取人</th><th>数量</th><th>当时库存</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        var it = null;
        for (var x = 0; x < (r.items || []).length; x++) { if (r.items[x].name === name) { it = r.items[x]; break; } }
        var isIn = (r.type || "out") === "in";
        var stock = (it && typeof it.stock === "number") ? it.stock : "-";
        return '<tr>' +
          '<td>' + Util.esc(String(r.time || "").replace("T", " ")) + '</td>' +
          '<td>' + (isIn ? '<span class="tag ok-tag">入库</span>' : '<span class="tag danger-tag">出库</span>') + '</td>' +
          '<td>' + Util.esc((r.dept || "") + (r.picker ? "（" + r.picker + "）" : "")) + '</td>' +
          '<td>' + (isIn ? "+" : "-") + (it ? it.qty : "") + '</td>' +
          '<td>' + stock + '</td>' +
        '</tr>';
      }).join("") +
      '</tbody></table></div>' +
      '<div class="hint">「当时库存」为该笔完成后的快照；当前库存 ' + Util.esc(String(window.App.Stock.getStock(name))) + '</div>';
    UI.Modal.show("📦 库存流水 · " + Util.esc(name), html, { width: "620px" });
  }

  /* ================= B2 库存盘点平账 ================= */
  function openStocktake() {
    var summary = Stock.summarize();
    if (!summary.length) { Util.toast("暂无货品可盘点", true); return; }
    var rows = summary.map(function (s, i) {
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed var(--line-soft,#DCE6E0)">' +
        '<span style="flex:1;font-size:13.5px">' + Util.esc(s.name) + '</span>' +
        '<span class="hint" style="margin:0;flex:0 0 74px;text-align:right">当前 ' + s.stock + '</span>' +
        '<input type="number" step="any" min="0" value="' + s.stock + '" data-i="' + i + '" class="st-in" style="width:92px;padding:8px 10px;border:1px solid var(--input-line,#C6DAD1);border-radius:10px;background:var(--input-bg,#FBFCFA)" />' +
      '</div>';
    }).join("");
    var body =
      '<div class="hint" style="margin-bottom:10px">盘点模式：把「实存数」改成实际清点数量，保存后自动生成差异记录（多=入库、少=出库，用途=盘点调整）。</div>' +
      '<div style="max-height:46vh;overflow:auto">' + rows + '</div>' +
      '<div class="modal-actions" style="margin-top:14px">' +
      '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
      '<button type="button" class="btn sm" id="stSave">保存盘点</button>' +
      '</div>';
    UI.Modal.show("📊 库存盘点平账", body, { width: "580px" });
    var mBody = UI.Modal.body();
    mBody.querySelector('[data-act="cancel"]').addEventListener("click", function () { UI.Modal.hide(); });
    mBody.querySelector("#stSave").addEventListener("click", async function () {
      var diffs = [];
      summary.forEach(function (s, i) {
        var inp = mBody.querySelector('.st-in[data-i="' + i + '"]');
        var actual = inp ? (Number(inp.value) || 0) : s.stock;
        var diff = actual - s.stock;
        if (diff !== 0) diffs.push({ name: s.name, diff: diff });
      });
      if (!diffs.length) { Util.toast("盘点数与当前库存一致，无需调整"); UI.Modal.hide(); return; }
      var inSum = 0, outSum = 0;
      diffs.forEach(function (d) { if (d.diff > 0) inSum += d.diff; else outSum -= d.diff; });
      var ok = await UI.confirmDialog(
        "差异汇总：需入库 +" + inSum + "，需出库 -" + outSum + "。将自动生成盘点调整记录（用途=盘点调整）。确认执行？", "盘点平账确认");
      if (!ok) { UI.Modal.hide(); return; }
      var now = Util.nowLocal();
      diffs.forEach(function (d) {
        var payload = {
          time: now, picker: "盘点", dept: "盘点", purpose: "盘点调整",
          note: "盘点平账（实存调整 " + (d.diff > 0 ? "+" : "") + d.diff + "）",
          items: [{ name: d.name, qty: Math.abs(d.diff) }],
          photos: [], affectsStock: true
        };
        if (d.diff > 0) payload.type = "in";
        var rec = Records.create(payload);
        try { if (Cloud && Cloud.pushRecord) Cloud.pushRecord(rec); } catch (e) {}
      });
      UI.Modal.hide();
      Util.toast("盘点完成：入库 +" + inSum + "，出库 -" + outSum);
      refresh();
      try { if (window.App.Views.dashboard && window.App.Views.dashboard.refresh) window.App.Views.dashboard.refresh(); } catch (e) {}
      try { if (window.App.Views.records && window.App.Views.records.refresh) window.App.Views.records.refresh(); } catch (e) {}
    });
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.stock = { render: render, refresh: refresh };
})();
