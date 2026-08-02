/**
 * stock.js — 库存计算与报表数据
 * getStock(name) = INVENTORY[name] + Σ(affectsStock===true && type==='in' ? +qty : -qty)
 * 旧记录（无 affectsStock=true）不参与计算，已包含在 INVENTORY 快照中。
 */
(function () {
  'use strict';

  var Config = window.App.Config;
  var State = window.App.State;

  /** 单货品当前库存 */
  function getStock(name, list) {
    var init = Config.INVENTORY[name] || 0;
    var inQty = 0, outQty = 0;
    (list || State.list).forEach(function (r) {
      if (r.affectsStock !== true) return; // 旧记录已包含在 INVENTORY 快照里，不再重复计算
      (r.items || []).forEach(function (it) {
        if (it.name !== name) return;
        var q = Number(it.qty) || 0;
        if (r.type === "in") inQty += q; else outQty += q;
      });
    });
    return init + inQty - outQty;
  }

  /** 全部货品汇总：{name, stock, inQty, outQty} */
  function summarize(list) {
    return Config.PRODUCTS.map(function (name) {
      var inQty = 0, outQty = 0;
      (list || State.list).forEach(function (r) {
        if (r.affectsStock !== true) return;
        (r.items || []).forEach(function (it) {
          if (it.name !== name) return;
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
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      out.push({
        date: d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()),
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
    summarize: summarize,
    trend: trend
  };
})();
