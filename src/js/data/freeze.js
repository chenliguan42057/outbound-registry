/**
 * freeze.js — 待取货「冻结库存」只读口径（2026-09-26，主理人要求）
 *
 * 冻结量 = 所有「未出库」（shipped !== true）的待取货单据占用的货品数量合计。
 * 可用库存 = Stock.getStock(name)（真实库存） − 冻结量   ← 纯虚拟参考数，不写库、不进任何库存计算。
 * 单据确认出库（shipped=true）或删除后，冻结自动消失，可用数自动还原。
 *
 * 铁律：本模块只读。绝不修改 State.pickups、绝不参与 buildStockIndex / summarize 的真实库存口径，
 * 真实库存永远以 Stock.getStock() 为准，待取货对它的隔离由 stock.js 天然保证。
 */
(function () {
  'use strict';

  var State = window.App.State;
  var Config = window.App.Config;

  /** 名称归一化：与 stock.js norm() 同口径（NAME_MAP 折算历史名→现名） */
  function norm(name) {
    var m = (Config && Config.NAME_MAP) || {};
    return m[name] || name;
  }

  /** 归属当前仓库判定（与 pickups.js mergeAndSort 的 owns 同口径：无 warehouse 标记的旧记录按迁移兼容保留） */
  function owns(p) {
    var wid = (Config && Config.Sys && Config.Sys.current && Config.Sys.current().id) || "shenzhen";
    return !!p && (p.warehouse === wid || !p.warehouse);
  }

  /** 占用中的单据：未出库 + 归属当前仓 */
  function pending() {
    return (State.pickups || []).filter(function (p) { return p.shipped !== true && owns(p); });
  }

  /** { name: 冻结数量 } */
  function map() {
    var m = {};
    pending().forEach(function (p) {
      (p.items || []).forEach(function (it) {
        var name = norm(it.name);
        var q = Number(it.qty) || 0;
        if (q > 0) m[name] = (m[name] || 0) + q;
      });
    });
    return m;
  }

  /** 单货品冻结量 */
  function of(name) {
    var m = map();
    return m[norm(name)] || 0;
  }

  /** 单货品可用库存（虚拟参考）= 真实库存 − 冻结量 */
  function available(name) {
    return window.App.Stock.getStock(norm(name)) - of(name);
  }

  /** 某货品被哪些单据占用：[{id, picker, dept, qty, ts}]（点冻结数字弹窗用） */
  function detail(name) {
    var key = norm(name);
    var out = [];
    pending().forEach(function (p) {
      (p.items || []).forEach(function (it) {
        if (norm(it.name) !== key) return;
        out.push({
          id: p.id,
          picker: p.picker || "-",
          dept: p.dept || "-",
          qty: Number(it.qty) || 0,
          ts: Number(p.createdAt) || Number(p._ts) || 0,
          confirmed: p.confirmed === true
        });
      });
    });
    return out.sort(function (a, b) { return a.ts - b.ts; });
  }

  /**
   * 全货品冻结总览：[{name, stock, frozen, avail, warnAt, state}]
   * state: "over"（可用为负，超预占）｜"tight"（实际够但扣除后低于预警线）｜"low"（本身就低库存）｜"ok"
   * 未产生冻结的货品不返回，避免表格里全是 0。
   */
  function overview() {
    var m = map();
    var out = [];
    Object.keys(m).forEach(function (name) {
      var products = Config.PRODUCTS || [];
      if (products.length && products.indexOf(name) < 0) return;   // 目录外货品不参与冻结展示
      var frozen = m[name];
      var stock = window.App.Stock.getStock(name);
      var avail = stock - frozen;
      var state = "ok";
      if (avail < 0) state = "over";
      else if (stock < warnAt(name)) state = "low";
      else if (avail < warnAt(name)) state = "tight";
      out.push({ name: name, stock: stock, frozen: frozen, avail: avail, warnAt: warnAt(name), state: state });
    });
    return out.sort(function (a, b) {
      var rank = { over: 0, tight: 1, low: 2, ok: 3 };
      return (rank[a.state] - rank[b.state]) || (a.avail - b.avail);
    });
  }

  /** 单个货品独立预警线（与 views/stock.js getWarnAt 同口径） */
  function warnAt(name) {
    var w = Number((Config.WARN_AT || {})[name]);
    return (!isNaN(w) && w >= 0) ? w : Config.LOW_STOCK_THRESHOLD;
  }

  /** 汇总：{docs, kinds, total, over:[], tight:[]} */
  function stats() {
    var rows = overview();
    return {
      docs: pending().length,
      kinds: rows.length,
      total: rows.reduce(function (a, r) { return a + r.frozen; }, 0),
      over: rows.filter(function (r) { return r.state === "over"; }),
      tight: rows.filter(function (r) { return r.state === "tight"; })
    };
  }

  window.App = window.App || {};
  window.App.Freeze = {
    pending: pending,
    map: map,
    of: of,
    available: available,
    detail: detail,
    overview: overview,
    warnAt: warnAt,
    stats: stats
  };
})();
