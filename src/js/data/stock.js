/**
 * stock.js — 库存计算与报表数据
 * getStock(name) = INVENTORY[name] + Σ(affectsStock===true && type==='in' ? +qty : -qty)
 * 旧记录（无 affectsStock=true）不参与计算，已包含在 INVENTORY 快照中。
 */
(function () {
  'use strict';

  var Config = window.App.Config;
  var State = window.App.State;

  /** 名称归一化：旧名（历史记录）折算到新名；已是新名则原样返回。
      2026-08-10 商品改名后，data/records 里历史 items.name 仍是旧名，
      而 INVENTORY/PRODUCTS 已用新名——库存计算必须统一口径，否则历史出入库不计入。 */
  function norm(name) {
    var m = Config.NAME_MAP || {};
    return m[name] || name;
  }

  /** 库存预计算索引：name → 按时序排序的出入库事件 + 前缀和。
      解决原来 getRecordStock 每行每 item 各做一次 O(N) 全表扫描（上千条变 O(N²) 卡死）的问题。
      改为一次建索引 O(N·items)，之后每次取值 O(事件数) 线性扫描（事件数=该货品记录数）。 */
  var _stockIndex = null;
  var _stockIndexDirty = true;
  function markDirty() { _stockIndexDirty = true; }
  function buildStockIndex() {
    var idx = {};
    (Config.PRODUCTS || []).forEach(function (name) {
      idx[name] = { inv: Config.INVENTORY[name] || 0, events: [] };
    });
    (State.list || []).forEach(function (r) {
      if (r.affectsStock !== true) return; // 旧记录已含在 INVENTORY 快照，不重复计算
      (r.items || []).forEach(function (it) {
        var name = norm(it.name);
        if (!idx[name]) idx[name] = { inv: Config.INVENTORY[name] || 0, events: [] };
        var q = Number(it.qty) || 0;
        idx[name].events.push({ ts: Number(r._ts) || 0, delta: r.type === "in" ? q : -q });
      });
    });
    Object.keys(idx).forEach(function (name) {
      var ev = idx[name].events.sort(function (a, b) { return a.ts - b.ts; });
      var sum = 0;
      for (var i = 0; i < ev.length; i++) { sum += ev[i].delta; ev[i].prefix = sum; }
      idx[name].events = ev;
    });
    _stockIndex = idx;
    _stockIndexDirty = false;
  }

  /** 单货品当前库存。list 显式传入时退化为即时计算（报表汇总，避免依赖全局索引）；
      否则走预计算索引 O(1)。 */
  function getStock(name, list) {
    name = norm(name);
    if (list) { // 即时计算（显式 list）
      var init = Config.INVENTORY[name] || 0, inQty = 0, outQty = 0;
      list.forEach(function (r) {
        if (r.affectsStock !== true) return;
        (r.items || []).forEach(function (it) {
          if (norm(it.name) !== name) return;
          var q = Number(it.qty) || 0;
          if (r.type === "in") inQty += q; else outQty += q;
        });
      });
      return init + inQty - outQty;
    }
    if (_stockIndexDirty || !_stockIndex) buildStockIndex();
    var entry = _stockIndex[name];
    if (!entry) return Config.INVENTORY[name] || 0;
    var ev = entry.events;
    return entry.inv + (ev.length ? ev[ev.length - 1].prefix : 0);
  }

  /**
   * 历史记录库存：返回「基于当前记录的实时推算值」，不再优先返回 item.stock 死快照。
   * - 始终按 _ts 推算：getStock(name) - 该记录之后记录的净变化。
   * - 这样前面/中间的出入库记录被删改后，后面的"当时库存"自动跟着重算，
   *   不会出现"删了前置单但下游还显示固定快照值"的失真。
   * - 原始 item.stock 仍保存在记录文件里（弹窗明细单独读取用于历史追溯），
   *   不再用它作为"当时库存"的快捷返回，避免历史快照覆盖实时推算。
   * - 无 _ts 极端情况 → 退回当前实时库存。
   */
  function getRecordStock(name, rec, item) {
    name = norm(name);
    var t = rec && rec._ts;
    if (!t) return getStock(name);                  // 无 _ts 极端情况 → 退回当前实时库存
    if (_stockIndexDirty || !_stockIndex) buildStockIndex();
    var entry = _stockIndex[name];
    if (!entry) return getStock(name);
    var ev = entry.events;
    // 当时库存 = 初始 + 截止到该记录时刻（含自身）的前缀和
    var sum = 0;
    for (var i = 0; i < ev.length; i++) {
      if (ev[i].ts <= t) sum = ev[i].prefix; else break;
    }
    return entry.inv + sum;
  }

  /** 全部货品汇总：{name, stock, inQty, outQty} */
  function summarize(list) {
    return Config.PRODUCTS.map(function (name) {
      var inQty = 0, outQty = 0;
      (list || State.list).forEach(function (r) {
        if (r.affectsStock !== true) return;
        (r.items || []).forEach(function (it) {
          if (norm(it.name) !== name) return;
          var q = Number(it.qty) || 0;
          if (r.type === "in") inQty += q; else outQty += q;
        });
      });
      return {
        name: name,
        stock: Config.INVENTORY[name] + inQty - outQty,
        inQty: inQty,
        outQty: outQty
      };
    });
  }

  /** 趋势：近 N 天按日期聚合 {date, outQty, inQty}（仅 affectsStock 记录） */
  function trend(list, days) {
    days = days || 7;
    var out = [];
    var now = new Date();
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      out.push({
        // 统一走 Util（本文件未在顶部捕获 Util，用全限定名避免加载顺序依赖）
        date: window.App.Util.todayLocal(d),
        outQty: 0,
        inQty: 0
      });
    }
    (list || State.list).forEach(function (r) {
      if (r.affectsStock !== true) return;
      var t = String(r.time || "").slice(0, 10);
      var row = null;
      for (var j = 0; j < out.length; j++) {
        if (out[j].date === t) { row = out[j]; break; }
      }
      if (!row) return;
      var total = (r.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
      if (r.type === "in") row.inQty += total; else row.outQty += total;
    });
    return out;
  }

  window.App = window.App || {};
  window.App.Stock = {
    getStock: getStock,
    getRecordStock: getRecordStock,
    markDirty: markDirty,
    summarize: summarize,
    trend: trend
  };
})();
