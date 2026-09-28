/**
 * freeze.js — 「冻结占用 / 可用库存」只读口径（2026-09-26 建立，2026-09-28 扩展）
 *
 * 冻结来源（两路，2026-09-28 主理人要求合并）：
 *   ① 待取货：未出库（shipped !== true）的单据占用 → 客户已提单但货还没拿走
 *   ② 未提单出库：status === "pending" 的出库单占用 → 货已谈定但提单还没走完
 * 可用库存 = 实际库存 − 冻结量   ← 虚拟参考数，不写库
 *
 * 2026-09-28 口径升级（主理人定稿）：
 *   未提单出库单从此**不再直接扣减实际库存**，改为计入冻结占用。
 *   → 实际库存 = 基准 + Σ(已提单出入库净额)：Stock.getStock 已按新口径实现，
 *     未提单出库单（status:pending 且 affectsStock===true）被排除在扣减之外。
 *   → 「先借后还」天然吻合：借出即冻结；归还生成 type:in 入库加回；
 *     未还完的差额单 affectsStock===false（已由原借出单扣过）→ 本模块必须排除，否则重复冻结。
 *
 * 铁律：本模块只读。绝不修改 State.pickups / State.list，绝不参与 buildStockIndex 的库存口径。
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

  /** 占用中的待取货单据：未出库 + 归属当前仓 */
  function pending() {
    return (State.pickups || []).filter(function (p) { return p.shipped !== true && owns(p); });
  }

  /** 占用中的未提单出库单（2026-09-28 新增）。
      判定三条件，缺一不可：
        · 出库单（type 非 "in"）
        · status === "pending"（未提单）
        · affectsStock === true（真正参与库存口径的单；差额单为 false，已由原借出单扣过，绝不能再冻结）
      排除调拨出库的「已撤销」情形由 affectsStock 天然覆盖。 */
  function pendingOut() {
    return (State.list || []).filter(function (r) {
      if (!r) return false;
      if ((r.type || "out") === "in") return false;
      if (r.status !== "pending") return false;
      if (r.affectsStock !== true) return false;
      return owns(r);
    });
  }

  /** { name: 冻结数量 } —— 待取货 + 未提单出库 合并 */
  function map() {
    var m = {};
    function add(items, qtyOf) {
      (items || []).forEach(function (it) {
        var name = norm(it.name);
        var q = qtyOf(it);
        if (q > 0) m[name] = (m[name] || 0) + q;
      });
    }
    pending().forEach(function (p) { add(p.items, function (it) { return Number(it.qty) || 0; }); });
    pendingOut().forEach(function (r) { add(r.items, function (it) { return Number(it.qty) || 0; }); });
    return m;
  }

  /** 单货品冻结量 */
  function of(name) {
    var m = map();
    return m[norm(name)] || 0;
  }

  /** 单货品可用库存（虚拟参考）= 实际库存 − 冻结量 */
  function available(name) {
    return window.App.Stock.getStock(norm(name)) - of(name);
  }

  /** { name: {pickup, out} } —— 冻结量按来源拆分（弹窗与提示文案用） */
  function splitOf(name) {
    var key = norm(name);
    var res = { pickup: 0, out: 0 };
    pending().forEach(function (p) {
      (p.items || []).forEach(function (it) { if (norm(it.name) === key) res.pickup += Number(it.qty) || 0; });
    });
    pendingOut().forEach(function (r) {
      (r.items || []).forEach(function (it) { if (norm(it.name) === key) res.out += Number(it.qty) || 0; });
    });
    return res;
  }

  /** 某货品被哪些单据占用：[{id, picker, dept, qty, ts, src, confirmed}]
      src: "pickup"（待取货未出库）｜"out"（未提单出库单） */
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
          src: "pickup",
          confirmed: p.confirmed === true
        });
      });
    });
    pendingOut().forEach(function (r) {
      (r.items || []).forEach(function (it) {
        if (norm(it.name) !== key) return;
        out.push({
          id: r.id,
          picker: r.picker || "-",
          dept: r.dept || "-",
          qty: Number(it.qty) || 0,
          ts: Number(r._ts) || 0,
          src: "out",
          confirmed: false
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

  /** 汇总：{docs, pkDocs, outDocs, kinds, total, over:[], tight:[]} */
  function stats() {
    var rows = overview();
    var pk = pending(), po = pendingOut();
    return {
      docs: pk.length + po.length,   // 占用单据总张数（待取货 + 未提单出库）
      pkDocs: pk.length,
      outDocs: po.length,
      kinds: rows.length,
      total: rows.reduce(function (a, r) { return a + r.frozen; }, 0),
      over: rows.filter(function (r) { return r.state === "over"; }),
      tight: rows.filter(function (r) { return r.state === "tight"; })
    };
  }

  window.App = window.App || {};
  window.App.Freeze = {
    pending: pending,
    pendingOut: pendingOut,
    map: map,
    of: of,
    splitOf: splitOf,
    available: available,
    detail: detail,
    overview: overview,
    warnAt: warnAt,
    stats: stats
  };
})();
