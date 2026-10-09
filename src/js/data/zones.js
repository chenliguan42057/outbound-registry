/**
 * zones.js — 仓库 / 现场「双区库存」数据层（2026-10-09 新增，主理人需求）
 *
 * 背景（主理人原话提炼）：
 *   把每个产品的库存拆成两个区——
 *     ① 仓库库存（锁定）：整箱存放，只能「转入现场」，不能直接出库；
 *     ② 现场库存（可用）：日常出库从这里扣，要看得到流水（谁拿了多少、还剩多少）；
 *   两者相加 = 该产品的全部库存；现场跌破临界线时，每次登入给警示。
 *
 * 模型（增量锁定法：零改动现有出库/入库/报表/钉钉/金山逻辑）：
 *   总库存(name)   = Stock.getStock(name)          ← 现有口径，本模块不碰
 *   仓库锁定(name) = 分区事件流折算（见下）
 *   现场可用(name) = max(0, 总库存 − 仓库锁定)
 *   —— 出库一扣总库存，现场数自动跟着减；入库一加总库存，现场数自动跟着涨。
 *      因此不需要改任何一条现有出库/入库代码，风险最低。
 *
 * 分区事件（存 data/zones/<id>.json，随云端同步；不进库存计算、不进金山、不触发登记通知）：
 *   { kind:"zone", mode:"set",    product, qty }        设定仓库锁定数（绝对基准，重置之前累计）
 *   { kind:"zone", dir:"to_wh",   product, qty }        现场 → 仓库（锁定 +qty）
 *   { kind:"zone", dir:"to_site", product, qty }        仓库 → 现场（锁定 −qty）
 *   { kind:"zone", mode:"warn",   product, siteWarnAt } 设定现场警示线
 *
 * 折算规则（同 product 事件按 _ts 升序回放）：
 *   base=0, acc=0
 *   set     → base=qty, acc=0     （重置基准）
 *   to_wh   → acc += qty
 *   to_site → acc -= qty
 *   仓库锁定 = max(0, base + acc)
 *
 * ⚠️ 只读展示 + 分区写入；绝不改 State.list / 出库入库逻辑。
 */
(function () {
  'use strict';

  var Config = window.App.Config;
  var State = window.App.State;

  function uid() { return "z" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function evTs(r) { return num(r && r._ts); }
  function normName(n) { var m = Config.NAME_MAP || {}; return m[n] || n; }

  /** 与 stock.js 的 countsAsStock 完全同口径（是否计入实际库存）。
      本模块只读判断，不改库存逻辑；两处口径必须一致，否则流水「当时剩余」会漂。 */
  function countsAsStock(r) {
    if (!r || r.affectsStock !== true) return false;
    if (r.freezeStock === true && !(r.borrowed === true && r.borrowEngine !== "v2")) return false;
    return true;
  }

  function all() { return (State && State.zones) || []; }

  /** 某产品的分区事件（仅当前仓，按 _ts 升序） */
  function eventsOf(name) {
    var wid = Config.Sys.current().id;
    return all().filter(function (r) {
      return r && r.kind === "zone" && r.product === name && (!r.warehouse || r.warehouse === wid);
    }).sort(function (a, b) { return evTs(a) - evTs(b); });
  }

  /** 仓库锁定数。ts 省略 / 为 0 表示「截止到现在」；传具体时间戳表示「截止到那一刻」。 */
  function warehouseLockedAt(name, ts) {
    var base = 0, acc = 0;
    var evs = eventsOf(name);
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (ts && evTs(e) > ts) break;
      if (e.mode === "set") { base = num(e.qty); acc = 0; }
      else if (e.dir === "to_wh") acc += num(e.qty);
      else if (e.dir === "to_site") acc -= num(e.qty);
    }
    return Math.max(0, base + acc);
  }
  function warehouseLocked(name) { return warehouseLockedAt(name, 0); }

  /** 现场警示线：取该产品最后一次 warn 事件；从未设过 → 用全局默认值 */
  function warnAt(name) {
    var evs = eventsOf(name);
    var v = null;
    for (var i = 0; i < evs.length; i++) if (evs[i].mode === "warn") v = num(evs[i].siteWarnAt);
    return (v === null) ? num(Config.SITE_WARN_DEFAULT) : v;
  }
  function hasWarn(name) { return eventsOf(name).some(function (e) { return e.mode === "warn"; }); }
  function hasWarehouse(name) { return eventsOf(name).some(function (e) { return e.mode === "set" || e.dir; }); }

  /** 在途出库冻结量（**不含待取货**）：未提单出库单全额 + 先借后还未还剩余量。
      复用 Freeze.detail（src === "out" 的项）—— 与全站「冻结占用」同口径、自动跟随其改进。
      主理人 2026-10-09 定稿：现场库存要扣「已出库/未提单」，但**不扣待取货**（货还在现场）。
      先借后还与盘点天然涵盖：借出单 affectsStock+freezeStock → 计入；盘点调整在 Stock 实际库存里。 */
  function outFrozenOf(name) {
    var F = window.App.Freeze;
    if (!F || !F.detail) return 0;
    var det = F.detail(normName(name)) || [];
    var s = 0;
    for (var i = 0; i < det.length; i++) if (det[i] && det[i].src === "out") s += num(det[i].qty);
    return s;
  }

  /** 现场可用 = 总库存 − 仓库锁定 − 在途出库（未提单 / 先借后还未还）。
      出库单一经创建即扣现场（无需等提单）；待取货不影响现场。 */
  function siteStock(name, total) {
    var t = (typeof total === "number") ? total : window.App.Stock.getStock(name);
    return Math.max(0, t - warehouseLocked(name) - outFrozenOf(name));
  }

  /** 全产品分区汇总（仪表盘用） */
  function summary() {
    var Stock = window.App.Stock;
    var ov = baseOverlayMap();
    return (Config.PRODUCTS || []).map(function (name) {
      var total = Stock.getStock(name);
      var wh = warehouseLocked(name);
      var tr = outFrozenOf(name);                       // 在途（已出未提单）
      var site = Math.max(0, total - wh - tr);
      var wa = warnAt(name);
      return {
        name: name, total: total, warehouse: wh, inTransit: tr, site: site,
        warnAt: wa, low: site < wa,
        manuallySet: Object.prototype.hasOwnProperty.call(ov, name)
      };
    });
  }

  /** 现场库存低于警示线的产品（登入警示 / 徽标用） */
  function lowList() { return summary().filter(function (s) { return s.low; }); }

  /* ================= 总库存手动覆盖（2026-10-09 追加，主理人需求） =================
     主理人要求：总库存要能自己直接设定（如「精华液20支装 50 盒」），
     而「仓库锁定 / 现场」的拆分也由自己设。
     做法：记一条 base 事件，把「目标总库存」换算成该产品的新期初基准，写回
     Config.INVENTORY —— 全站库存口径（库存页/报表/仪表盘）随之一致；
     之后出入库流水照常叠加，所以「仓库管理里的数据怎么变，总库存就怎么变」。
     应用时机：必须在 catalog.applyToConfig（覆盖目录基准）之后调用，否则被冲掉。 */

  /** 各产品的手动基准覆盖 {name: base}（已清除的不出现）。仅当前仓的 base 事件。 */
  function baseOverlayMap() {
    var m = {};
    var wid = Config.Sys.current().id;
    all().filter(function (r) {
      return r && r.kind === "zone" && r.mode === "base" && (!r.warehouse || r.warehouse === wid);
    }).sort(function (a, b) { return evTs(a) - evTs(b); }).forEach(function (r) {
      var n = normName(r.product);
      if (r.base === null || r.base === undefined) delete m[n];
      else m[n] = num(r.base);
    });
    return m;
  }

  /** 该产品是否被手动设定过总库存 */
  function hasBase(name) {
    return Object.prototype.hasOwnProperty.call(baseOverlayMap(), normName(name));
  }

  /** 把「总库存覆盖」应用到 Config.INVENTORY（幂等：先还原目录原始基准，再叠加覆盖）。
      目录原始基准由 catalog.js 写入 Config._INVENTORY_RAW。 */
  function applyBaseOverrides() {
    var raw = Config._INVENTORY_RAW;
    if (!raw) return;                         // catalog 尚未提供原始基准 → 不动，等它加载后再调
    Object.keys(raw).forEach(function (n) { Config.INVENTORY[n] = raw[n]; });
    var ov = baseOverlayMap();
    Object.keys(ov).forEach(function (n) { Config.INVENTORY[n] = ov[n]; });
    try { if (window.App.Stock) window.App.Stock.markDirty(); } catch (e) {}
  }

  /* ================= 写入 ================= */

  function append(rec) {
    if (!State.zones) State.zones = [];
    State.zones.push(rec);
    try { window.App.Store.saveZones(State.zones); } catch (e) {}
    push(rec);
    return rec;
  }

  /** 推送到云端 data/zones/<id>.json；失败保持 _local 标记，待下次同步补推 */
  function push(rec) {
    var Cloud = window.App.Cloud;
    if (!Cloud || !Cloud.putJsonFile || !Cloud.hasToken || !Cloud.hasToken()) { rec._local = true; return; }
    try {
      Cloud.putJsonFile({
        dataDir: Config.Sys.root(),
        subdir: "zones",
        id: rec.id,
        payload: rec,
        message: "zone " + (rec.mode || rec.dir) + " " + rec.product
      }).then(function (ok) {
        if (ok) {
          rec._local = false; rec._pushed = true;
          try { window.App.Store.saveZones(State.zones); } catch (e) {}
          try { window.App.Cloud.flushZonesPending && window.App.Cloud.flushZonesPending(); } catch (e) {}
        }
      }).catch(function () {});
    } catch (e) { rec._local = true; }
  }

  function baseRec(o) {
    return Object.assign({
      id: uid(),
      kind: "zone",
      warehouse: Config.Sys.current().id,
      _ts: Date.now(),
      time: new Date().toISOString().slice(0, 16),
      _local: true
    }, o);
  }

  /** 设定仓库锁定数（绝对基准） */
  function setWarehouse(name, qty) {
    qty = Math.max(0, Math.round(num(qty)));
    return append(baseRec({ mode: "set", product: normName(name), qty: qty }));
  }

  /** 仓库 ⇄ 现场 转移。dir: "to_site"（仓库→现场）| "to_wh"（现场→仓库）。
      仓库不够时返回 null（调用方给提示），不写脏事件。 */
  function transfer(name, dir, qty, meta) {
    name = normName(name);
    qty = Math.max(1, Math.round(num(qty)));
    if (dir === "to_site" && qty > warehouseLocked(name)) return null;
    var rec = { product: name, qty: qty, dir: dir };
    if (meta && meta.operator) rec.operator = String(meta.operator);
    if (meta && meta.note) rec.note = String(meta.note);
    return append(baseRec(rec));
  }

  /** 设定现场警示线 */
  function setWarn(name, v) {
    v = Math.max(0, Math.round(num(v)));
    return append(baseRec({ mode: "warn", product: normName(name), siteWarnAt: v }));
  }

  /** 直接设定某产品的「总库存」= target（自动换算期初基准，保证设定后 Stock 立刻等于 target）。
      delta 法：新基准 = 当前生效基准 + (目标 − 当前总库存)，无需重算全部流水，且多次设定自洽。 */
  function setBase(name, target) {
    name = normName(name);
    target = Math.max(0, Math.round(num(target)));
    var cur = window.App.Stock.getStock(name);
    var newBase = num(Config.INVENTORY[name]) + (target - cur);
    var rec = append(baseRec({ mode: "base", product: name, base: newBase, target: target }));
    Config.INVENTORY[name] = newBase;                 // 立即生效（不等 catalog 回调）
    try { if (window.App.Stock) window.App.Stock.markDirty(); } catch (e) {}
    return rec;
  }

  /** 清除手动设定，恢复跟随目录基准 */
  function clearBase(name) {
    var rec = append(baseRec({ mode: "base", product: normName(name), base: null, target: null }));
    try { applyBaseOverrides(); } catch (e) {}
    return rec;
  }

  /* ================= 现场流水 ================= */

  /** 现场流水：该产品的出入库流水 + 逐条「出/入库后现场剩余」，倒序（最新在前）。
      剩余 = 当时总库存（Stock.getRecordStock） − 当时仓库锁定数（warehouseLockedAt）。 */
  function siteFlow(name, limit) {
    name = normName(name);
    limit = limit || 40;
    var Stock = window.App.Stock;
    var rows = ((State && State.list) || []).filter(function (r) {
      if (!countsAsStock(r)) return false;
      return (r.items || []).some(function (it) { return normName(it.name) === name; });
    }).map(function (r) {
      var qty = (r.items || []).reduce(function (s, it) {
        return s + (normName(it.name) === name ? num(it.qty) : 0);
      }, 0);
      if (!qty) return null;
      var totalAfter = 0;
      try { totalAfter = Stock.getRecordStock(name, r); } catch (e) { totalAfter = Stock.getStock(name); }
      var whAfter = warehouseLockedAt(name, evTs(r));
      return {
        id: r.id,
        time: r.time || "",
        _ts: evTs(r),
        type: (r.type === "in") ? "in" : "out",
        qty: qty,
        picker: r.picker || r.applicant || "",
        dept: r.dept || "",
        purpose: r.purpose || "",
        note: r.note || "",
        entity: r.entity || "",
        siteAfter: Math.max(0, totalAfter - whAfter - outFrozenOf(name))
      };
    }).filter(Boolean).sort(function (a, b) { return b._ts - a._ts; });
    return rows.slice(0, limit);
  }

  window.App = window.App || {};
  window.App.Zones = {
    summary: summary,
    lowList: lowList,
    warehouseLocked: warehouseLocked,
    warehouseLockedAt: warehouseLockedAt,
    siteStock: siteStock,
    warnAt: warnAt,
    hasWarn: hasWarn,
    hasWarehouse: hasWarehouse,
    setWarehouse: setWarehouse,
    transfer: transfer,
    setWarn: setWarn,
    setBase: setBase,
    clearBase: clearBase,
    hasBase: hasBase,
    applyBaseOverrides: applyBaseOverrides,
    siteFlow: siteFlow,
    eventsOf: eventsOf,
    _countsAsStock: countsAsStock
  };
})();
