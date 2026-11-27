/**
 * batches.js — 批次余量计算（2026-11-27）
 *
 * ★ 总原则：本模块只是「库存的第二层视图」，**绝不改动 stock.js 的库存公式**。
 *   库存总量仍由 Config.INVENTORY + 出入库净额 + 盘点增量 决定（见 stock.js 头部注释）；
 *   批次余量单独按「入库批号 − 出库分配」算出，两者对不上的差额统一显示为「未归批」。
 *   这样库存/冻结/低库存/报表/AI/金山台账/钉钉推送全部零改动。
 *
 * ★ 数据来源（不新建云端目录，全部从 records 反推）：
 *     入库 item: { name, qty, stock, batch: "批号" }
 *     出库 item: { name, qty, stock, batches: [{ no, qty }] }
 *   同产品内同批号 = 同一批次；跨产品批号互不干扰。
 *
 * ★ 出库三分桶（只用 Stock.countsAsStock 会把冻结单漏掉 → 可用量虚高 → 超发）：
 *     ① 已实扣 outQty：Stock.countsAsStock(r) 为真            → 扣该批次剩余
 *     ② 冻结占用 reserved：affectsStock===true && freezeStock===true（借出看 frozenQtyOf）
 *                                                          → 只预占，不扣剩余；沿 batches 顺序取满真实冻结量
 *     ③ 忽略：affectsStock!==true（纸质差额单 / 旧快照）
 *
 * ★ 未归批用残差，不单独累计：
 *     未归批 = Stock.getStock(name) − Σ(各批次剩余)
 *   历史 INVENTORY 期初、调拨调入、借还归还入库都会自动落进「未归批」，避免逐条特判；
 *   残差为负 = 出库吃掉了未归批（批次账超出总量），页面标警号，不改数据。
 *
 * ★ 已分配即短路（P0 护栏）：
 *   item.batches 存在且合计 == item.qty → applyToRecord 一律不动。
 *   否则「编辑出库单（备注/照片）」会把历史批次分配重排一遍，历史批次账被改写。
 */
(function () {
  'use strict';

  var _index = null;
  var _indexDirty = true;

  function markDirty() { _indexDirty = true; _index = null; }

  function Cfg() { return window.App.Config; }
  function St() { return window.App.State; }
  function Stock() { return window.App.Stock; }
  function Freeze() { return window.App.Freeze; }

  function norm(name) {
    var m = (Cfg() && Cfg().NAME_MAP) || {};
    return m[name] || name;
  }

  function isManaged(name) {
    var C = Cfg();
    return !!(C && C.isBatchManaged && C.isBatchManaged(name));
  }

  /** 该出库单是否处于「冻结占用」状态（口径与 freeze.js pendingOut 完全一致） */
  function isFreezeHold(r) {
    if (!r) return false;
    if ((r.type || "out") === "in") return false;
    if (r.affectsStock !== true) return false;
    if (r.freezeStock !== true) return false;
    if (r.borrowed === true && r.borrowEngine !== "v2") return false;  // 历史借出单：不认冻结
    return true;
  }

  function emptyLot(no) {
    return {
      no: no,
      inQty: 0,        // 入库合计
      outQty: 0,       // 已实扣
      reserved: 0,     // 冻结占用
      firstTs: Infinity,
      lastTs: 0,
      events: []       // 流水 [{id,type,time,qty,ts}]
    };
  }

  function lotOf(bucket, no) {
    var lot = bucket.lots[no];
    if (!lot) { lot = bucket.lots[no] = emptyLot(no); bucket.order.push(no); }
    return lot;
  }

  /** 单次遍历建全量索引：{ 货品名: { lots:{批号:lot}, order:[批号] } }
      ——— 禁止「逐个产品全表扫描」（库存页 O(N²) 卡死的旧教训）。 */
  function buildIndex(excludeId) {
    var idx = {};
    var list = (St() && St().list) || [];
    var ST = Stock();

    function bucket(name) {
      if (!idx[name]) idx[name] = { lots: {}, order: [] };
      return idx[name];
    }

    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r) continue;
      if (excludeId && r.id === excludeId) continue;   // 编辑场景：把本单自己的旧消耗排除，避免自我抵消
      var isIn = (r.type || "out") === "in";

      if (isIn) {
        // 入库：只有计入实际库存的才形成批次（未被冻结、非旧快照）
        if (!ST || !ST.countsAsStock(r)) continue;
        var its = r.items || [];
        for (var j = 0; j < its.length; j++) {
          var it = its[j];
          if (!it || !it.name) continue;
          var no = String(it.batch == null ? "" : it.batch).trim();
          if (!no) continue;                            // 无批号 → 不进批次账（落「未归批」）
          var nm = norm(it.name);
          var b = bucket(nm);
          var lot = lotOf(b, no);
          var q = Number(it.qty) || 0;
          var ts = Number(r._ts) || 0;
          lot.inQty += q;
          if (ts < lot.firstTs) lot.firstTs = ts;
          if (ts > lot.lastTs) lot.lastTs = ts;
          lot.events.push({ id: r.id, type: "in", time: r.time, qty: q, ts: ts });
        }
        continue;
      }

      // 出库类：区分「已实扣」与「冻结占用」
      var real = !!(ST && ST.countsAsStock(r));
      var hold = isFreezeHold(r);
      if (!real && !hold) continue;

      var items = r.items || [];
      for (var k = 0; k < items.length; k++) {
        var oit = items[k];
        if (!oit || !oit.name) continue;
        var alloc = oit.batches;
        if (!Array.isArray(alloc) || !alloc.length) continue;   // 没分配批次 → 落「未归批」
        var onm = norm(oit.name);
        var ob = bucket(onm);
        var ts2 = Number(r._ts) || 0;

        if (real) {
          for (var m = 0; m < alloc.length; m++) {
            var a = alloc[m];
            if (!a || !a.no) continue;
            var aq = Number(a.qty) || 0;
            if (!aq) continue;
            var l1 = lotOf(ob, String(a.no));
            l1.outQty += aq;
            l1.events.push({ id: r.id, type: "out", time: r.time, qty: -aq, ts: ts2 });
          }
        } else {
          // 冻结：只预占「该单真实未还量」，沿 batches 顺序从前往后取满
          var fq = (Freeze() && Freeze().frozenQtyOf) ? Freeze().frozenQtyOf(r, oit.name) : (Number(oit.qty) || 0);
          var left = Math.max(0, Number(fq) || 0);
          for (var n2 = 0; n2 < alloc.length && left > 0; n2++) {
            var a2 = alloc[n2];
            if (!a2 || !a2.no) continue;
            var aq2 = Number(a2.qty) || 0;
            if (aq2 <= 0) continue;
            var take = Math.min(aq2, left);
            var l2 = lotOf(ob, String(a2.no));
            l2.reserved += take;
            left -= take;
          }
        }
      }
    }

    // 收尾：算剩余/可用 + 按首次入库时间升序（先进先出顺序）
    Object.keys(idx).forEach(function (name) {
      var b = idx[name];
      var lots = b.order.map(function (no) {
        var l = b.lots[no];
        l.remain = l.inQty - l.outQty;
        l.avail = l.remain - l.reserved;
        return l;
      });
      lots.sort(function (x, y) {
        if (x.firstTs !== y.firstTs) return x.firstTs - y.firstTs;
        return String(x.no).localeCompare(String(y.no));
      });
      b.lotsArr = lots;
    });

    return idx;
  }

  function index() {
    if (_indexDirty || !_index) {
      _index = buildIndex(null);
      _indexDirty = false;
    }
    return _index;
  }

  /** 某货品的全部批次（按先进先出顺序）。opts.excludeId：编辑场景排除本单自身消耗 */
  function lotsOf(name, opts) {
    var nm = norm(name);
    var idx = (opts && opts.excludeId) ? buildIndex(opts.excludeId) : index();
    var b = idx[nm];
    return b ? b.lotsArr : [];
  }

  /** 批次剩余合计（不含冻结占用） */
  function lotsTotal(name, opts) {
    return lotsOf(name, opts).reduce(function (s, l) { return s + l.remain; }, 0);
  }

  /** 未归批 = 总库存 − 批次剩余合计（残差；可为负 = 批次账超出总量） */
  function unbatchedOf(name, opts) {
    var ST = Stock();
    var total = (ST && ST.getStock) ? ST.getStock(name) : 0;
    return total - lotsTotal(name, opts);
  }

  /** 先进先出分配：从可用量（剩余 − 冻结）最多的最早批次依次扣。
      可用量不够时能分多少算多少（系统本来就允许负库存），不阻断。 */
  function planFifo(name, qty, opts) {
    var need = Number(qty) || 0;
    var out = [];
    if (need <= 0) return out;
    var lots = lotsOf(name, opts);
    for (var i = 0; i < lots.length && need > 0; i++) {
      var av = Number(lots[i].avail) || 0;
      if (av <= 0) continue;
      var take = Math.min(av, need);
      out.push({ no: lots[i].no, qty: take });
      need -= take;
    }
    return out;
  }

  /** 纯文本摘要：B2026110×3 + B2026115×2；无分配返回 "" */
  function textOf(item) {
    var alloc = (item && item.batches) || [];
    var parts = [];
    alloc.forEach(function (a) {
      if (a && a.no && Number(a.qty) > 0) parts.push(a.no + "×" + Number(a.qty));
    });
    return parts.join(" + ");
  }

  function sumOf(item) {
    var alloc = (item && item.batches) || [];
    return alloc.reduce(function (s, a) { return s + (Number(a && a.qty) || 0); }, 0);
  }

  /**
   * 唯一写入兜底：给出库记录的每个「启用批次」货品补齐 item.batches。
   *  - 入库记录一律不动（批号由入库表单 / 识别结果带上来）。
   *  - 已有合法分配（合计 == qty）直接短路 —— 保护历史批次不被编辑重排。
   *  - 其余按先进先出自动分配，并打 batchAuto 标记（记录是系统替人分配的）。
   * 全程 try/catch：这是 出库/入库/借出/调拨/待取货/回滚 的公共咽喉，
   * 任何异常都不能让「提交」失败。
   */
  function applyToRecord(rec) {
    var assigned = false;
    try {
      if (!rec) return rec;
      if ((rec.type || "out") === "in") return rec;
      var items = rec.items || [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it || !it.name) continue;
        if (!isManaged(it.name)) continue;
        var q = Number(it.qty) || 0;
        if (!q) continue;
        var cur = Array.isArray(it.batches) ? it.batches.filter(function (a) {
          return a && a.no && Number(a.qty) > 0;
        }) : [];
        if (cur.length && sumOf({ batches: cur }) === q) continue;   // 已合法分配 → 不动
        var plan = planFifo(it.name, q, { excludeId: rec.id });
        if (plan.length) { it.batches = plan; assigned = true; }
        else { delete it.batches; }
      }
      if (assigned) rec.batchAuto = true;
      markDirty();
    } catch (e) {
      /* 批次只是第二层视图，绝不能因为算批次把登记搞挂 */
    }
    return rec;
  }

  /** 页面汇总：单次建索引用完全部货品，避免 O(P×N) */
  function summary() {
    var C = Cfg();
    var ST = Stock();
    var idx = index();
    var out = [];
    ((C && C.PRODUCTS) || []).forEach(function (name) {
      var managed = isManaged(name);
      var b = idx[norm(name)];
      var lots = (b && b.lotsArr) ? b.lotsArr : [];
      var total = (ST && ST.getStock) ? ST.getStock(name) : 0;
      var batchTotal = lots.reduce(function (s, l) { return s + l.remain; }, 0);
      var reserved = lots.reduce(function (s, l) { return s + l.reserved; }, 0);
      out.push({
        name: name,
        managed: managed,
        total: total,
        lots: lots,
        lotCount: lots.length,
        batchTotal: batchTotal,
        reserved: reserved,
        unbatched: total - batchTotal
      });
    });
    return out;
  }

  window.App = window.App || {};
  window.App.Batches = {
    isManaged: isManaged,
    markDirty: markDirty,
    lotsOf: lotsOf,
    lotsTotal: lotsTotal,
    unbatchedOf: unbatchedOf,
    planFifo: planFifo,
    applyToRecord: applyToRecord,
    summary: summary,
    textOf: textOf,
    sumOf: sumOf
  };
})();
