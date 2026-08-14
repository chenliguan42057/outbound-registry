/**
 * batch.js — 呆滞管理页（批次台账 + 产品维度汇总 + 呆滞预警）
 * 数据来自 window.App.Batch（src/js/data/batch.js）：
 *   - 批次台账：初始批次快照 + 入库批次 - 出库 batchAlloc 扣减
 *   - 呆滞三档：<90天「3个月以内」/ 90-180天「3-6个月」/ >180天「6个月以上」（红标）
 * 导航位置：先借后还 与 备忘录 之间（2026-08-14）
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Config = window.App.Config;
  var Cloud = window.App.Cloud;

  var container = null;

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="card">' +
        '<h2>呆滞管理 <span class="tag">批次台账</span></h2>' +
        '<div class="actions" style="margin-bottom:10px">' +
          '<button type="button" class="btn ghost sm" id="batchSync">&#128260; 立即同步</button>' +
        '</div>' +
        '<div class="dash-cards" id="batchKpi"></div>' +
      '</div>' +
      '<div class="card">' +
        '<h2>批次库存台账 <span class="tag">FIFO 先进先出</span></h2>' +
        '<div id="batchLedgerBox"></div>' +
      '</div>' +
      '<div class="card">' +
        '<h2>产品维度汇总</h2>' +
        '<div id="batchSummaryBox"></div>' +
      '</div>';
    Util.$("batchSync").addEventListener("click", doSync);
    renderAll();
  }

  /** 云端同步后刷新：整体重建 */
  function refresh() {
    if (!container) return;
    renderAll();
  }

  function doSync() {
    if (!Cloud.hasToken()) { Util.toast("未配置云端令牌，无法同步", true); return; }
    Util.toast("正在同步…");
    Cloud.syncPull({ onStatus: function (text, isErr) {
      window.App.Views.app.setSyncStatus(text, isErr);
    } }).then(function () {
      if (window.App.Batch && window.App.Batch.load) window.App.Batch.load();
      renderAll();
    });
  }

  function renderAll() {
    if (!window.App.Batch) { return; }
    var ledger = window.App.Batch.getLedger();
    var summary = window.App.Batch.productSummary();
    renderKpi(ledger);
    renderLedger(ledger);
    renderSummary(summary);
  }

  function renderKpi(ledger) {
    var totalQty = ledger.reduce(function (s, r) { return s + r.qty; }, 0);
    var sluggish = ledger.filter(function (r) { return r.sluggish === "6个月以上"; }).length;
    var mid = ledger.filter(function (r) { return r.sluggish === "3-6个月"; }).length;
    var cards = [
      { label: "批次总数", value: ledger.length, icon: "box" },
      { label: "在库总数量", value: totalQty, icon: "stock" },
      { label: "呆滞批次(>180天)", value: sluggish, icon: "stock" },
      { label: "3-6个月批次", value: mid, icon: "report" }
    ];
    Util.$("batchKpi").innerHTML = cards.map(function (c) {
      return '<div class="dash-card">' +
        '<div class="dash-card-icon">' + UI.icon(c.icon, 22) + '</div>' +
        '<div class="dash-card-value' + (c.label.indexOf("呆滞") !== -1 && c.value > 0 ? " danger-text" : "") + '">' + c.value + '</div>' +
        '<div class="dash-card-label">' + Util.esc(c.label) + '</div>' +
      '</div>';
    }).join("");
  }

  function renderLedger(ledger) {
    var box = Util.$("batchLedgerBox");
    if (!box) return;
    if (!ledger.length) {
      box.innerHTML = '<div class="empty">暂无批次库存数据（请先同步初始台账）</div>';
      return;
    }
    var html = '<div class="table-wrap"><table class="table stock-table"><thead><tr>' +
      '<th>产品名称</th><th>生产批号</th><th>数量</th><th>呆滞预警</th><th>入库时间</th><th>库龄(天)</th><th>到期时间</th><th>剩余天数</th>' +
      '</tr></thead><tbody>';
    ledger.forEach(function (r) {
      var isSluggish = r.sluggish === "6个月以上";
      var expSoon = r.expLeftDays > 0 && r.expLeftDays <= 90;
      html += '<tr class="' + (isSluggish ? "low-stock" : "") + '">' +
        '<td title="' + Util.esc(r.name) + '">' + Util.esc(r.name) + '</td>' +
        '<td>' + Util.esc(r.batchNo) + '</td>' +
        '<td class="stock-num">' + r.qty + '</td>' +
        '<td>' + (isSluggish
          ? '<span class="tag danger-tag">6个月以上</span>'
          : r.sluggish === "3-6个月"
            ? '<span class="tag warn-tag">3-6个月</span>'
            : '<span class="tag ok-tag">3个月以内</span>') + '</td>' +
        '<td>' + Util.esc(String(r.inTime || "-").replace("T", " ")) + '</td>' +
        '<td>' + r.ageDays + '</td>' +
        '<td>' + Util.esc(String(r.expDate || "-").replace("T", " ").slice(0, 16)) + '</td>' +
        '<td class="' + (expSoon ? "danger-text" : "") + '">' + (r.expLeftDays > 0 ? r.expLeftDays : (r.expDate ? "已过期" : "-")) + '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>' +
      '<div class="hint" style="margin-top:8px">💡 出库时系统自动按批次早（入库时间）、生产时间早的顺序扣减（FIFO）；呆滞批次按库龄 &gt; 180 天（6个月）标红。</div>';
    box.innerHTML = html;
  }

  function renderSummary(summary) {
    var box = Util.$("batchSummaryBox");
    if (!box) return;
    if (!summary.length) {
      box.innerHTML = '<div class="empty">暂无产品汇总</div>';
      return;
    }
    var html = '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>产品名称</th><th>批号数</th><th>库存总数量</th><th>最早入库时间</th><th>最近到期时间</th>' +
      '</tr></thead><tbody>';
    summary.forEach(function (s) {
      html += '<tr>' +
        '<td>' + Util.esc(s.name) + '</td>' +
        '<td>' + s.batchCount + '</td>' +
        '<td class="stock-num">' + s.totalQty + '</td>' +
        '<td>' + Util.esc(String(s.earliestIn || "-").replace("T", " ")) + '</td>' +
        '<td>' + Util.esc(String(s.nearestExp || "-").replace("T", " ").slice(0, 16)) + '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    box.innerHTML = html;
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.batch = { render: render, refresh: refresh };
})();
