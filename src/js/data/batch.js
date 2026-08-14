/**
 * batch.js — 批次台账 / FIFO 出库 / 呆滞分级（2026-08-14）
 *
 * 数据源：data/batches/initial.json（导入时刻的批次库存快照，40 条）
 *   + 入库记录 items[].batchNo（新批次入库，纯追加字段）
 *   - 出库记录 items[].batchAlloc（按批扣减，纯追加字段）
 * 旧出库记录（无 batchAlloc）不扣批次——initial 是快照，旧记录已体现在快照中，不重复计算。
 *
 * 呆滞三档（库龄 = 今天 - 入库时间）：<90 天「3个月以内」/ 90-180 天「3-6个月」/ >180 天「6个月以上」。
 * FIFO：批次早（入库时间 asc）→ 生产时间早（prodDate asc）优先扣减。
 * 纯新增文件；schema 独立，不触碰 records/pickups/memos 既有结构。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Config = window.App.Config;
  var State = window.App.State;

  var CLOUD_PATH = "data/batches/initial.json";
  var NAME_MAP_PATH = "data/batches/name-map.json";   // 吉客云全名 → 前端精简名（2026-08-14）
  var LS_KEY = "outbound_batches_v1";
  var LS_NAME_MAP_KEY = "outbound_batches_namemap_v1";
  var initial = null;          // {warehouse, unit, importedAt, batches:[]}
  var fullNameMap = {};        // 全名 → 精简名（保证初始批次与出入库记录可匹配）
  var loaded = false;

  var SLUGGISH_DAYS = 180;     // 6 个月（呆滞线）
  var MID_DAYS = 90;           // 3 个月（三档分界）
  var loadPromise = null;      // 缓存进行中的加载，重复调用返回同一 Promise（幂等且可 await）

  /* ---------- 加载 ---------- */

  function hasToken() {
    return window.App.Cloud && window.App.Cloud.hasToken();
  }

  /** 名称归一化：先查 Config.NAME_MAP（旧名→新名），再查全名映射（吉客云全名→精简名） */
  function norm(name) {
    if (!name) return name;
    var m = Config.NAME_MAP || {};
    if (m[name]) return m[name];
    if (fullNameMap[name]) return fullNameMap[name];
    return name;
  }

  /** 读取云端指定 json；404 返回 null */
  async function fetchCloudJson(path) {
    if (!hasToken()) return null;
    try {
      var res = await fetch("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path +
        "?ref=" + Config.GH.branch, { headers: { "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + Config.GH.token } });
      if (!res.ok) return null;
      var j = await res.json();
      return JSON.parse(Util.b64dec(j.content));
    } catch (e) { return null; }
  }

  /** 读取 name-map.json（全名→精简名），失败回落 localStorage/空 */
  async function loadNameMap() {
    var cloud = await fetchCloudJson(NAME_MAP_PATH);
    if (cloud && cloud.nameMap) {
      fullNameMap = cloud.nameMap;
      try { localStorage.setItem(LS_NAME_MAP_KEY, JSON.stringify(cloud.nameMap)); } catch (e) {}
      return;
    }
    try {
      var cached = JSON.parse(localStorage.getItem(LS_NAME_MAP_KEY) || "null");
      if (cached) { fullNameMap = cached; return; }
    } catch (e) {}
    fullNameMap = {};
  }

  /** 加载完成后刷新依赖视图（batch.js 加载顺序早于 views/*，延迟到下一个宏任务） */
  function refreshDependents() {
    var fire = function () {
      try { if (window.App.Views.batch && window.App.Views.batch.refresh) window.App.Views.batch.refresh(); } catch (e) {}
    };
    if (typeof setTimeout === "function") setTimeout(fire, 0);
    else fire();
  }

  /** 启动加载：云端优先 → localStorage 缓存 → 空台账。返回 Promise，幂等（重复调用返回同一加载）。 */
  function load() {
    if (!loadPromise) {
      loadPromise = (async function () {
        if (loaded) return;
        loaded = true;
        await loadNameMap();
        var cloud = await fetchCloudJson(CLOUD_PATH);
        if (cloud && Array.isArray(cloud.batches)) {
          initial = cloud;
          try { localStorage.setItem(LS_KEY, JSON.stringify(cloud)); } catch (e) {}
          refreshDependents();
          return;
        }
        try {
          var cached = JSON.parse(localStorage.getItem(LS_KEY) || "null");
          if (cached && Array.isArray(cached.batches)) {
            initial = cached;
            refreshDependents();
            return;
          }
        } catch (e) {}
        initial = { warehouse: "深圳细胞-时空仓", unit: "件", importedAt: "", batches: [] };
        refreshDependents();
      })();
    }
    return loadPromise;
  }

  /* ---------- 派生计算 ---------- */

  /** 解析 "YYYY-MM-DD HH:MM:SS" 或 "YYYY-MM-DDTHH:MM" 或时间戳 → Date；无效返回 null */
  function parseDate(v) {
    if (!v) return null;
    var s = String(v).trim().replace(" ", "T");
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  /** 库龄天数 = 今天 - 入库时间（向下取整）；无效返回 0 */
  function ageDays(inTime) {
    var d = parseDate(inTime);
    if (!d) return 0;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  /** 剩余天数 = 到期时间 - 今天（向下取整）；无效返回 0 */
  function expLeftDays(expDate) {
    var d = parseDate(expDate);
    if (!d) return 0;
    return Math.floor((d.getTime() - Date.now()) / 86400000);
  }

  /** 呆滞三档标签 */
  function sluggishLabel(age) {
    if (age > SLUGGISH_DAYS) return "6个月以上";
    if (age >= MID_DAYS) return "3-6个月";
    return "3个月以内";
  }

  /**
   * 批次台账推导。
   * 返回 [{name, batchNo, qty, unit, inTime, expDate, prodDate, ageDays, expLeftDays, sluggish}]，
   * 按 inTime asc → prodDate asc → name asc 排序（FIFO 口径）。
   */
  function getLedger() {
    var map = {};   // name|batchNo -> row
    function upsert(row) {
      var key = row.name + "|" + row.batchNo;
      if (map[key]) { map[key].qty += row.qty; return map[key]; }
      map[key] = row;
      return row;
    }
    // 1) 初始批次快照（名称归一为精简名，与出入库记录同口径）
    ((initial && initial.batches) || []).forEach(function (b) {
      upsert({
        name: norm(b.name), batchNo: b.batchNo, qty: Number(b.qty) || 0,
        unit: (initial && initial.unit) || "件",
        inTime: b.inTime || "", expDate: b.expDate || "", prodDate: b.prodDate || ""
      });
    });
    // 2) 入库记录（带批次字段）→ 增加批次
    (State.list || []).forEach(function (r) {
      if (r.type !== "in" || r.affectsStock !== true) return;
      (r.items || []).forEach(function (it) {
        if (!it.batchNo) return;
        upsert({
          name: norm(it.name), batchNo: it.batchNo, qty: Number(it.qty) || 0,
          unit: "件", inTime: r.time || "", expDate: it.expDate || "", prodDate: it.prodDate || ""
        });
      });
    });
    // 3) 出库记录（带 batchAlloc）→ 按批扣减
    (State.list || []).forEach(function (r) {
      if ((r.type || "out") === "in" || r.affectsStock !== true) return;
      (r.items || []).forEach(function (it) {
        (it.batchAlloc || []).forEach(function (al) {
          var key = norm(it.name) + "|" + al.batchNo;
          if (map[key]) map[key].qty -= Number(al.qty) || 0;
        });
      });
    });
    // 4) 过滤空批次 + 派生字段 + 排序
    var out = [];
    Object.keys(map).forEach(function (k) {
      var row = map[k];
      if (row.qty <= 0) return;
      var age = ageDays(row.inTime);
      out.push(Object.assign({}, row, {
        ageDays: age,
        expLeftDays: expLeftDays(row.expDate),
        sluggish: sluggishLabel(age)
      }));
    });
    out.sort(function (a, b) {
      return String(a.inTime).localeCompare(String(b.inTime)) ||
        String(a.prodDate).localeCompare(String(b.prodDate)) ||
        String(a.name).localeCompare(String(b.name));
    });
    return out;
  }

  /**
   * FIFO 分配：按 inTime asc → prodDate asc 依次扣减，返回 [{batchNo, prodDate, expDate, qty}]。
   * 该货品无批次记录、或批次总库存不足 → 返回空数组（调用方退化为无批次普通扣减，不半扣避免账目错乱）。
   */
  function allocate(name, qty) {
    var need = Number(qty) || 0;
    if (need <= 0) return [];
    var rows = getLedger().filter(function (r) { return r.name === norm(name); });
    if (!rows.length) return [];
    var alloc = [];
    var remain = need;
    for (var i = 0; i < rows.length && remain > 0; i++) {
      var take = Math.min(remain, rows[i].qty);
      if (take > 0) {
        alloc.push({ batchNo: rows[i].batchNo, prodDate: rows[i].prodDate, expDate: rows[i].expDate, qty: take });
        remain -= take;
      }
    }
    return remain > 0 ? [] : alloc;
  }

  /** 产品维度汇总：{name, batchCount, totalQty, earliestIn, nearestExp}，按名称（中文拼音）排序 */
  function productSummary() {
    var map = {};
    getLedger().forEach(function (r) {
      var s = map[r.name] || (map[r.name] = { name: r.name, batchCount: 0, totalQty: 0, earliestIn: "", nearestExp: "" });
      s.batchCount++;
      s.totalQty += r.qty;
      if (!s.earliestIn || String(r.inTime) < String(s.earliestIn)) s.earliestIn = r.inTime;
      if (!s.nearestExp || (r.expDate && String(r.expDate) < String(s.nearestExp))) s.nearestExp = r.expDate;
    });
    var arr = Object.keys(map).map(function (k) { return map[k]; });
    arr.sort(function (a, b) {
      try { return a.name.localeCompare(b.name, "zh-Hans-CN"); } catch (e) {
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
      }
    });
    return arr;
  }

  /* ---------- Excel 行生成（供前端导出 / 周报脚本同构参考） ---------- */

  /** 生成两 sheet 数据行：{ledgerRows, summaryRows}，每行首元素为表头。
      台账行按「产品名 → 入库时间」排序，保证同产品多批次连续（导出时按参考格式合并产品名列）。 */
  function toExcelRows() {
    var wh = (initial && initial.warehouse) || "深圳细胞-时空仓";
    var unit = (initial && initial.unit) || "件";
    var ledgerRows = [[wh, "产品名称", "生产批号", "库存数量", "呆滞预警", "单位", "入库时间", "库龄(天)", "到期时间", "剩余天数"]];
    var sorted = getLedger().slice().sort(function (a, b) {
      var cmp = String(a.name).localeCompare(String(b.name), "zh-Hans-CN");
      return (isNaN(cmp) ? (a.name < b.name ? -1 : 1) : cmp) ||
        String(a.inTime).localeCompare(String(b.inTime));
    });
    sorted.forEach(function (r) {
      ledgerRows.push([wh, r.name, r.batchNo, r.qty, r.sluggish, unit, r.inTime, r.ageDays, r.expDate || "", r.expLeftDays]);
    });
    var summaryRows = [[wh, "产品名称", "批号数", "库存总数量", "最早入库时间", "最近到期时间"]];
    productSummary().forEach(function (s) {
      summaryRows.push([wh, s.name, s.batchCount, s.totalQty, s.earliestIn, s.nearestExp]);
    });
    return { ledgerRows: ledgerRows, summaryRows: summaryRows };
  }

  /* ---------- 初始化 ---------- */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { load(); });
  } else {
    load();
  }

  window.App = window.App || {};
  window.App.Batch = {
    load: load,
    getLedger: getLedger,
    allocate: allocate,
    productSummary: productSummary,
    sluggishLabel: sluggishLabel,
    ageDays: ageDays,
    expLeftDays: expLeftDays,
    toExcelRows: toExcelRows,
    getWarehouse: function () { return (initial && initial.warehouse) || "深圳细胞-时空仓"; },
    getUnit: function () { return (initial && initial.unit) || "件"; },
    isLoaded: function () { return loaded; }
  };
})();
