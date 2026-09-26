/**
 * trash.js — 回收站（3.4）
 *
 * 数据源是删除墓碑 data/deleted/<id>.json，墓碑里带原记录完整快照（pushTombstone 写入 rec 字段），
 * 所以「误删找回」不需要额外的备份文件，直接从墓碑还原即可。
 *
 * 还原顺序必须是「先删墓碑、再写回记录」：
 * 反过来的话，下一轮 syncPull 会拿残留的墓碑再把刚还原的记录删一次，用户看到的现象是「还原了又没了」。
 *
 * 每日快照（.github/workflows/backup.yml → data/backups/YYYY-MM-DD.json）是第二道防线：
 * 墓碑被清理、或整库被误清空时，从快照文件里捞历史数据。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var State = window.App.State;
  var Records = window.App.Records;
  var Cloud = window.App.Cloud;

  var container = null;
  var listBox = null;
  var loading = false;

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="card">' +
        '<h2>回收站 <span class="tag">误删找回</span></h2>' +
        '<div class="hint" style="margin-bottom:10px;">' +
          '这里列出所有<strong>已删除但可还原</strong>的记录（来自云端删除标记）。' +
          '点「还原」会把单据连同原始编号、时间一起放回记录列表，库存自动重算。' +
          '被撤销的<strong>盘点记录</strong>同样列在下方，可一键还原。' +
          '<br/>另外系统每天凌晨自动生成一份全量数据快照，保留最近 7 天（每月 1 号那份长期保留），存放在仓库 <code>data/backups/</code>。' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;">' +
          '<button type="button" class="btn" id="trashRefresh">刷新列表</button>' +
          '<span class="hint" id="trashCount"></span>' +
        '</div>' +
        '<div id="trashList"><div class="empty">加载中…</div></div>' +
      '</div>';

    listBox = Util.$("trashList");
    Util.$("trashRefresh").addEventListener("click", function () { load(true); });
    listBox.addEventListener("click", onListClick);

    load(!(State.tombstones && State.tombstones.length));
  }

  /** 拉取墓碑。force=true 时强制走网络，否则优先用上一轮同步缓存在内存里的结果 */
  async function load(force) {
    if (loading) return;
    if (!force && State.tombstones && State.tombstones.length) {
      renderList(State.tombstones, State.stkTombstones);
      return;
    }
    if (!Cloud.hasToken()) {
      // 无 token 时只能用内存态；至少让用户知道为什么是空的，而不是以为"没有可还原的"
      renderList(State.tombstones || [], State.stkTombstones || []);
      return;
    }
    loading = true;
    listBox.innerHTML = '<div class="empty">加载中…</div>';
    try {
      var toms = await Cloud.pullTombstones();
      State.tombstones = toms || [];
      // 2026-09-26 A2：被撤销的盘点也进回收站，同样可还原
      var stkToms = [];
      try { if (Cloud.pullStocktakeTombstones) stkToms = (await Cloud.pullStocktakeTombstones()) || []; } catch (e) { stkToms = []; }
      State.stkTombstones = stkToms;
      renderList(State.tombstones, State.stkTombstones);
    } catch (e) {
      listBox.innerHTML = '<div class="empty">读取失败：' + Util.esc(e.message || String(e)) + '</div>';
    } finally {
      loading = false;
    }
  }

  function fmtTime(ms) {
    if (!ms) return "—";
    var d = new Date(Number(ms));
    if (isNaN(d.getTime())) return "—";
    return d.getFullYear() + "-" + Util.pad2(d.getMonth() + 1) + "-" + Util.pad2(d.getDate()) +
      " " + Util.pad2(d.getHours()) + ":" + Util.pad2(d.getMinutes());
  }

  function summary(rec) {
    if (!rec) return "（无快照，无法还原）";
    var items = (rec.items || []).map(function (it) {
      return Util.esc(it.name || "") + "×" + (Number(it.qty) || 0);
    }).join("、");
    return items || Util.esc(rec.purpose || "（无货品）");
  }

  /** 盘点记录的摘要：货品 账面→实存（±差额） */
  function stkSummary(rec) {
    if (!rec) return "—";
    var items = (rec.items || []).map(function (it) {
      var d = Number(it.diff) || 0;
      return Util.esc(it.name || "") + " " + it.book + "→" + it.actual + "（" + (d > 0 ? "+" : "") + d + "）";
    }).join("、");
    return items || "（无货品）";
  }

  function renderList(toms, stkToms) {
    var list = (toms || []).filter(function (t) { return t && t.type !== "clear-all"; });
    var clearAll = (toms || []).filter(function (t) { return t && t.type === "clear-all"; })[0];

    // 已在记录列表里的（比如已被还原过）不再显示，避免用户重复点
    var alive = {};
    (State.list || []).forEach(function (r) { alive[r.id] = true; });
    list = list.filter(function (t) { return !alive[t.id]; });

    list.sort(function (a, b) { return (b.deletedAt || 0) - (a.deletedAt || 0); });

    var countEl = Util.$("trashCount");
    if (countEl) countEl.textContent = list.length ? ("共 " + list.length + " 条可还原") : "";

    var html = "";
    if (clearAll) {
      html += '<div class="hint" style="color:#B54708;background:#FFFAEB;border:1px solid #FEDF89;border-radius:8px;padding:8px 10px;margin-bottom:10px;">' +
        '⚠️ 存在一次「清空全部」操作（' + fmtTime(clearAll.deletedAt) + '）。' +
        '该操作只清除此时间点之前的记录，之后新建的不受影响。如需找回被清空的数据，请从 data/backups/ 快照恢复。' +
        '</div>';
    }

    if (!list.length) {
      listBox.innerHTML = html + '<div class="empty">没有可还原的记录</div>';
      return;
    }

    html += '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>删除时间</th><th>类型</th><th>经办人</th><th>货品</th><th>删除理由</th><th>操作</th>' +
      '</tr></thead><tbody>';
    list.forEach(function (t) {
      var rec = t.rec;
      var isIn = rec && (rec.type || "") === "in";
      html += '<tr>' +
        '<td>' + fmtTime(t.deletedAt) + '</td>' +
        '<td>' + (isIn ? '<span class="tag">入库</span>' : '<span class="tag">出库</span>') + '</td>' +
        '<td>' + Util.esc((rec && (rec.picker || rec.dept)) || "—") + '</td>' +
        '<td>' + summary(rec) + '</td>' +
        '<td>' + Util.esc(t.reason || "—") + '</td>' +
        '<td>' + (rec
          ? '<button type="button" class="btn mini" data-restore="' + Util.esc(t.id) + '">还原</button>'
          : '<span class="hint">无快照</span>') +
        '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';

    // 被撤销的盘点记录（2026-09-26 A2）：同样可一键还原
    var sList = (stkToms || []).filter(function (t) { return t && t.type === "stocktake-tombstone" && t.rec; });
    var aliveStk = {};
    (State.stocktakes || []).forEach(function (s) { if (s && s.id) aliveStk[s.id] = true; });
    sList = sList.filter(function (t) { return !aliveStk[t.id]; });
    sList.sort(function (a, b) { return (b.deletedAt || 0) - (a.deletedAt || 0); });
    if (sList.length) {
      html += '<div class="hint" style="margin:16px 0 8px">以下 <b>' + sList.length + '</b> 笔<strong>已撤销的盘点</strong>可还原（还原后差额重新计入库存）：</div>';
      html += '<div class="table-wrap"><table class="table"><thead><tr>' +
        '<th>撤销时间</th><th>类型</th><th>涉及货品（账面→实存）</th><th>理由</th><th>操作</th>' +
        '</tr></thead><tbody>';
      sList.forEach(function (t) {
        html += '<tr>' +
          '<td>' + fmtTime(t.deletedAt) + '</td>' +
          '<td><span class="tag" style="background:#F0E7D2;color:#8a6d3b">盘点</span></td>' +
          '<td>' + stkSummary(t.rec) + '</td>' +
          '<td>' + Util.esc(t.reason || "—") + '</td>' +
          '<td><button type="button" class="btn mini" data-restore-stk="' + Util.esc(t.id) + '">还原</button></td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
    }

    listBox.innerHTML = html;
  }

  async function onListClick(e) {
    var sBtn = e.target.closest("[data-restore-stk]");
    if (sBtn) { onRestoreStocktake(sBtn); return; }
    var btn = e.target.closest("[data-restore]");
    if (!btn) return;
    var id = btn.getAttribute("data-restore");
    var tomb = (State.tombstones || []).filter(function (t) { return t && t.id === id; })[0];
    if (!tomb || !tomb.rec) { Util.toast("找不到该记录的快照"); return; }

    var ok = await UI.confirmDialog(
      "还原后该单据会回到记录列表，并重新参与库存计算。确定还原吗？",
      "还原这条记录"
    );
    if (!ok) return;

    btn.disabled = true;
    btn.textContent = "还原中…";
    try {
      if (Cloud.hasToken()) {
        await Cloud.delTombstone(id);        // 必须先删墓碑，否则下一轮同步会把它再删掉
        await Cloud.push(tomb.rec);          // 再把记录写回云端
      }
      Records.restore(tomb.rec);             // 本地列表放回（保留原 id/_ts，库存时序不乱）
      State.tombstones = (State.tombstones || []).filter(function (t) { return t.id !== id; });
      Util.toast("已还原，库存已重新计算");
      renderList(State.tombstones);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "还原";
      Util.toast("还原失败：" + (err.message || err));
    }
  }

  /** 还原被撤销的盘点：必须先删墓碑再写回事件文件，顺序颠倒会让下一轮同步把它再删掉 */
  async function onRestoreStocktake(btn) {
    var id = btn.getAttribute("data-restore-stk");
    var tomb = (State.stkTombstones || []).filter(function (t) { return t && t.id === id; })[0];
    if (!tomb || !tomb.rec) { Util.toast("找不到该盘点记录的快照"); return; }
    var ok = await UI.confirmDialog(
      "还原后这笔盘点的差额会重新计入库存。确定还原吗？",
      "还原这笔盘点"
    );
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = "还原中…";
    try {
      if (Cloud.hasToken()) {
        await Cloud.delStocktakeTombstone(id);   // 先删墓碑
        await Cloud.pushStocktake(tomb.rec);     // 再写回盘点事件
      }
      State.stocktakes = (State.stocktakes || []).concat([tomb.rec]);
      try { if (window.App.Store && window.App.Store.saveStocktakes) window.App.Store.saveStocktakes(State.stocktakes); } catch (e) {}
      try { if (window.App.Stock && window.App.Stock.markDirty) window.App.Stock.markDirty(); } catch (e) {}
      State.stkTombstones = (State.stkTombstones || []).filter(function (t) { return t.id !== id; });
      Util.toast("已还原，库存已重新计算");
      renderList(State.tombstones, State.stkTombstones);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "还原";
      Util.toast("还原失败：" + ((err && err.message) || err));
    }
  }

  function refresh() { if (container) load(true); }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.trash = { render: render, refresh: refresh };
})();
