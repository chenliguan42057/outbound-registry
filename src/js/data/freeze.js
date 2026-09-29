/**
 * freeze.js — 「冻结占用 / 可用库存」只读口径（2026-09-26 建立，2026-09-28 定稿）
 *
 * 冻结来源（两路）：
 *   ① 待取货：未出库（shipped !== true）的单据占用 → 客户已提单但货还没拿走
 *   ② 在途出库：显式标记 freezeStock === true 的出库单占用
 *        · 普通未提弹出库单 → 冻结全额
 *        · 先借后还借出中（borrowed && borrowDone!==true）→ 只冻结【尚未归还的剩余量】
 * 可用库存 = 实际库存 − 冻结量   ← 虚拟参考数，不写库
 *
 * 2026-09-28 主理人定稿（重要）：
 *   **只冻结「活单」，不翻历史账。** 2026-09-23 之前的 15 张历史未提单单据
 *   虽然状态字段还挂着 pending，但货早已实际出去/已由差额单处理完毕
 *   （borrowDone=true 的差额单 affectsStock=false 不参与库存）——一律视为真实库存，不冻结。
 *   因此判据不能靠「status === pending」推断（历史单无法与活单区分），
 *   改用**显式字段 freezeStock === true**：只有明确标记的活单才冻结。
 *
 * 字段写入时机（见 out.js / borrow.js）：
 *   · out.js 新建出库单 → freezeStock: true
 *   · borrow.js 转入先借后还 → freezeStock: true
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

  /** 在途出库单（2026-09-28 定稿 / 2026-09-29 加固）：**只认显式标记 freezeStock === true**。
      排除：入库单 / 差额单（affectsStock!==true）/ 非当前仓。
      历史未提单旧单没有这个标记 → 天然不冻结（主理人要求「不翻旧账」）。

      ★ 2026-09-29 加固（历史隔离）：先借后还单**必须带 borrowEngine === "v2"** 才纳入冻结体系。
        背景：2026-09-28 曾对 mumb4tttgtabo / muknuun9xx2l1 两张历史单误打 freezeStock:true，
        它们的借出【未扣库存】但按旧 doReturn 归还时会写入库单 → 会把库存凭空虚增。
        现规定：无 borrowEngine 标记的 borrowed 单 = 历史单 → 冻结体系一律不认（既不算占用、
        也不参与库存扣除，由历史口径自行处理），保证历史数据绝不串进新口径。 */
  function pendingOut() {
    return (State.list || []).filter(function (r) {
      if (!r) return false;
      if ((r.type || "out") === "in") return false;
      if (r.affectsStock !== true) return false;   // 差额单/旧快照：已扣过或不参与，绝不冻结
      if (r.freezeStock !== true) return false;    // ★ 核心：必须是显式标记的活单
      // ★ 历史隔离：借出单必须有 v2 引擎标记；无标记的 borrowed 单视为历史单，不纳入冻结
      if (r.borrowed === true && r.borrowEngine !== "v2") return false;
      return owns(r);
    });
  }

  /** 某在途出库单的**应冻结数量**（按货品计）。
      先借后还：
        · 已全部还清（borrowDone === true）→ 冻结 0（借出已结清，不再占用）；
        · 借出中 → 只冻结剩余未还量（借出2还1剩1，只冻1）；
      普通未提单出库单 → 冻结全额。
      ⚠️ 2026-09-29 修复：原实现只在 borrowDone!==true 时扣减已还量，
         全部还清时反而 fall through 返回【全额】→ 归还完冻结不归零。
         现改为：borrowed 且 borrowDone===true 直接返回 0。 */
  function frozenQtyOf(r, itemName) {
    var it = (r.items || []).find(function (x) { return norm(x.name) === norm(itemName); });
    if (!it) return 0;
    var q = Number(it.qty) || 0;
    if (q <= 0) return 0;
    // 先借后还：已结清 → 不占用；借出中 → 扣掉已归还部分
    if (r.borrowed === true) {
      if (r.borrowDone === true) return 0;   // ★ 全部还清：冻结归零
      var ret = 0;
      (r.borrowReturned || []).forEach(function (x) {
        if (x && norm(x.name) === norm(itemName)) ret += (Number(x.qty) || 0);
      });
      q = Math.max(0, q - ret);
    }
    return q;
  }

  /** { name: 冻结数量 } —— 待取货 + 在途出库 合并 */
  function map() {
    var m = {};
    pending().forEach(function (p) {
      (p.items || []).forEach(function (it) {
        var name = norm(it.name);
        var q = Number(it.qty) || 0;
        if (q > 0) m[name] = (m[name] || 0) + q;
      });
    });
    pendingOut().forEach(function (r) {
      (r.items || []).forEach(function (it) {
        var name = norm(it.name);
        var q = frozenQtyOf(r, name);
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
      (r.items || []).forEach(function (it) { if (norm(it.name) === key) res.out += frozenQtyOf(r, key); });
    });
    return res;
  }

  /** 某货品被哪些单据占用：[{id, picker, dept, qty, ts, src, confirmed, borrowed, returned}]
      src: "pickup"（待取货未出库）｜"out"（在途出库单）
      qty 为**实际冻结量**（先借后还只算剩余未还部分）。 */
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
        var q = frozenQtyOf(r, key);
        if (q <= 0) return;                       // 已全部归还 → 不再占用
        var total = Number(it.qty) || 0;
        out.push({
          id: r.id,
          picker: r.picker || "-",
          dept: r.dept || "-",
          qty: q,
          total: total,
          borrowed: r.borrowed === true && r.borrowDone !== true,
          returned: Math.max(0, total - q),
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
