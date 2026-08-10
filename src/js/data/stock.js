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

  /** 单货品当前库存 */
  function getStock(name, list) {
    name = norm(name);
    var init = Config.INVENTORY[name] || 0;
    var inQty = 0, outQty = 0;
    (list || State.list).forEach(function (r) {
      if (r.affectsStock !== true) return; // 旧记录已包含在 INVENTORY 快照里，不再重复计算
      (r.items || []).forEach(function (it) {
        if (norm(it.name) !== name) return;
        var q = Number(it.qty) || 0;
        if (r.type === "in") inQty += q; else outQty += q;
      });
    });
    return init + inQty - outQty;
  }

  /**
   * 历史记录库存：返回「该笔业务完成时」该货品的库存快照。
   * - 新记录（item.stock 为数字）→ 直接返回快照，随后续出入库变动而固定不变。
   * - 旧记录（无快照字段）→ 由 rec._ts 推算：当前实时库存 - 该记录之后记录的净变化。
   * - 无 _ts 极端情况 → 退回当前实时库存。
   */
  function getRecordStock(name, rec, item) {
    name = norm(name);
    if (item && typeof item.stock === "number") return item.stock;
    var t = rec && rec._ts;
    if (t) {
      var netAfter = 0;
      (State.list || []).forEach(function (r) {
        if (!r || r.id === rec.id) return;         // 跳过自身
        if (r.affectsStock !== true) return;        // 只统计参与库存的记录
        if ((r._ts || 0) <= t) return;              // 只统计该记录之后（_ts 更大）的记录
        (r.items || []).forEach(function (it) {
          if (!it || norm(it.name) !== name) return;
          var q = Number(it.qty) || 0;
          netAfter += (r.type === "in" ? q : -q);   // 之后入库 +，出库 -
        });
      });
      return getStock(name) - netAfter;             // 当前实时库存 - 之后的变化 = 当时的库存
    }
    return getStock(name);
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
    summarize: summarize,
    trend: trend
  };
})();
