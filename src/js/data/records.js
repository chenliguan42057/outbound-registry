/**
 * records.js — 记录 CRUD + 云端合并排序 + CSV 导出
 * 记录 schema 冻结：{id, time, picker?, dept?, purpose, items:[{name,qty}], photos:[dataURL], _ts, affectsStock, type?, status?}
 * status?: "pending" | "submitted" —— 仅出库记录（type 非 "in"）使用的可选字段；入库不写。
 * entity?: 出货仓库单位（仅出库记录，chip 必填）；note?: 备注（非必填）——均为纯追加可选字段。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Store = window.App.Store;
  var State = window.App.State;

  /**
   * 出库记录状态读取：入库记录 → null；缺省/未知 → "submitted"（已提单）；显式 pending → "pending"
   * @param {{type?: string, status?: string}} rec
   * @returns {("pending"|"submitted"|null)}
   */
  function getStatus(rec) {
    if (!rec || (rec.type || "") === "in") return null;
    return rec.status === "pending" ? "pending" : "submitted";
  }

  /** 写入库存快照：对 rec.items 中每个有 name 的 item 写 it.stock = 当前实时库存。
      必须在 rec 已加入 State.list 后调用（getStock 才会包含本笔影响）。
      出库记录创建后 getStock = 出库后库存（已扣本笔），入库记录 = 入库后库存（已加本笔），
      两者都正好是「该笔完成后库存」，满足历史记录库存固化需求。纯追加字段，不影响既有 schema。 */
  function stampStock(rec) {
    var Stock = window.App.Stock;   // 延迟访问（stock.js 在 records.js 之前加载，运行时必已存在）
    if (!Stock || !Stock.getStock) return;
    (rec.items || []).forEach(function (it) {
      if (it && it.name) it.stock = Stock.getStock(it.name, State.list);
    });
  }

  /** 新增记录（默认出库；payload.type='in' 为入库） */
  function create(payload) {
    var rec = Object.assign({
      id: Util.genId(),
      _ts: Date.now(),
      affectsStock: true,   // 新记录才参与库存计算
      items: [],
      photos: []
    }, payload);
    State.list.unshift(rec);
    if (window.App.Stock) window.App.Stock.markDirty();
    stampStock(rec);        // 先入列再打快照：getStock 已包含本笔影响
    State.save();
    try {
      if (window.App.Audit) window.App.Audit.log("create", {
        id: rec.id,
        summary: ((rec.picker || "") + " " + (rec.purpose || "") + " " +
          (rec.items || []).map(function (it) { return it.name + "×" + it.qty; }).join("、")).slice(0, 200)
      });
    } catch (e) {}
    return rec;
  }

  /** 更新记录：保留原 _ts（创建时间——库存时序推算依赖，不能刷新），
      改用 updatedAt 跟踪最后编辑时间。
      P1 修复：affectsStock 保留原值（仅 patch 显式指定时才覆盖），不再恒写 true。
      旧逻辑会造成两类库存错账：
        1) 先借后还差额单创建时为 false（借出原单已扣过，不能重复扣），
           用户在出库记录页点一下「已提单」→ 被改成 true → 这笔差额又扣一次，库存凭空变少；
        2) 无 affectsStock 的旧记录（数量已含在 INVENTORY 基准里）一被编辑就被纳入实时计算 → 重复计入。
      仅当 patch 自带新 items 数组时重打库存快照；status/photoUrls 等非货品更新保留原快照。 */
  function update(id, patch) {
    var idx = State.list.findIndex(function (r) { return r.id === id; });
    if (idx < 0) return null;
    var prev = State.list[idx];
    var nextAffects = (patch && Object.prototype.hasOwnProperty.call(patch, "affectsStock"))
      ? patch.affectsStock
      : prev.affectsStock;
    var rec = Object.assign({}, prev, patch, { updatedAt: Date.now(), affectsStock: nextAffects });
    State.list[idx] = rec;
    if (patch && Object.prototype.hasOwnProperty.call(patch, "items")) {
      if (window.App.Stock) window.App.Stock.markDirty();
      stampStock(rec);
    }
    State.save();
    return rec;
  }

  /**
   * 若 rec 是先借后还的差额出库单且已提单，自动把原借出单标记为已完成。
   * 实现「差额未提单 → 提交后账平」的闭环；多次调用幂等。
   * @returns {string|null} 被关闭的借出单 id，无则返回 null
   */
  function tryCloseBorrowFromDiff(rec) {
    if (!rec || !rec.fromBorrowId || (rec.type || "out") === "in") return null;
    if (getStatus(rec) !== "submitted") return null;
    var idx = State.list.findIndex(function (r) { return r.id === rec.fromBorrowId && r.borrowed === true; });
    if (idx < 0) return null;
    var borrowRec = State.list[idx];
    if (borrowRec.borrowDone === true) return null;
    State.list[idx] = Object.assign({}, borrowRec, { borrowDone: true, updatedAt: Date.now() });
    State.save();
    return borrowRec.id;
  }

  /** 删除记录（本地） */
  function remove(id) {
    var gone = null;
    State.list.forEach(function (r) { if (r.id === id) gone = r; });
    State.list = State.list.filter(function (r) { return r.id !== id; });
    State.save();
    if (window.App.Stock) window.App.Stock.markDirty();
    try {
      if (window.App.Audit && gone) window.App.Audit.log("delete", {
        id: id,
        summary: ((gone.picker || "") + " " + (gone.purpose || "")).slice(0, 200)
      });
    } catch (e) {}
  }

  /** 回收站还原：把墓碑快照原样塞回本地列表。
      不能走 create()——那会生成新的 id 与新的 _ts，既丢失原单据编号，
      又会把这笔记录挪到时间线末尾，导致它之后所有记录的「当时库存」全部算错。
      幂等：列表里已存在同 id 时直接返回，重复点还原不会产生副本。 */
  function restore(rec) {
    if (!rec || !rec.id) return null;
    var exists = State.list.some(function (r) { return r.id === rec.id; });
    if (!exists) {
      State.list = mergeAndSort(State.list.concat([rec]), []);
      if (window.App.Stock) window.App.Stock.markDirty();
      State.save();
      try {
        if (window.App.Audit) window.App.Audit.log("restore", {
          id: rec.id,
          summary: ((rec.picker || "") + " " + (rec.purpose || "")).slice(0, 200)
        });
      } catch (e) {}
    }
    return rec;
  }

  /** 清空本地记录 */
  function clear() {
    State.list = [];
    State.save();
    try { if (window.App.Audit) window.App.Audit.log("clear-all", {}); } catch (e) {}
  }

  /** 取较新的一条：updatedAt/_ts 较大者胜；相等时本地优先（避免把未推送的本地改动判输） */
  function newerOf(a, b) {
    var ta = Number((a && (a.updatedAt || a._ts)) || 0);
    var tb = Number((b && (b.updatedAt || b._ts)) || 0);
    if (ta === tb) return a;
    return tb > ta ? b : a;
  }

  /** 合并策略：同 id 取较新者（updatedAt/_ts 大者胜），不再无条件云端覆盖本地——
      修复「本地改了还没推，轮询一到被云端旧版静默覆盖、改动永久消失」的问题。
      云端较新时仍保留本地 photos（dataURL 是编辑回填/补传所需原始凭证）。
      检测到双方都改过（时间戳不同）会记入 _lastMergeConflicts，供同步状态提示。
      排序 = time 降序，次 _ts 降序（与现网一致） */
  var _lastMergeConflicts = [];

  function mergeAndSort(local, remote) {
    _lastMergeConflicts = [];
    var map = new Map();
    (local || []).forEach(function (r) { map.set(r.id, r); });
    (remote || []).forEach(function (r) {
      var prev = map.get(r.id);
      if (!prev) { map.set(r.id, r); return; }
      var win = newerOf(prev, r);
      if (win === prev) {
        // 本地较新：保留本地全部字段，photoUrls 也用本地当前值（本地刚编辑，已是最新上传状态）。
        // 之前这里做 mergePhotoUrls 并集会把「编辑前旧 URL」加回来 → 钉钉推送重复图 / photoUrls 越积越多。
        // 边界：本地尚未有 photoUrls（跨设备首次未拉到照片）但云端已有 → 采用云端 URL，避免照片丢失。
        var localUrls = prev.photoUrls || [];
        var remoteUrls = r.photoUrls || [];
        var pickUrls = (!localUrls.length && remoteUrls.length) ? remoteUrls : localUrls;
        map.set(r.id, Object.assign({}, prev, { photoUrls: pickUrls }));
        if (Number(prev.updatedAt || prev._ts) !== Number(r.updatedAt || r._ts)) {
          _lastMergeConflicts.push({ id: r.id, kept: "local" });
        }
        return;
      }
      // 云端较新：用云端，但保留本地 photos（云端瘦身后不应反向抹掉原始凭证）。
      // 云端较新时云端是当前基准，直接以云端 photoUrls 为准（本地旧的已废弃），不反向并集。
      if (prev.photos && prev.photos.length && !(r.photos && r.photos.length) && (r.photoUrls && r.photoUrls.length)) {
        map.set(r.id, Object.assign({}, r, { photos: prev.photos, photoUrls: r.photoUrls || [] }));
      } else {
        map.set(r.id, Object.assign({}, r, { photoUrls: r.photoUrls || [] }));
      }
      if (Number(prev.updatedAt || prev._ts) !== Number(r.updatedAt || r._ts)) {
        _lastMergeConflicts.push({ id: r.id, kept: "cloud" });
      }
    });
    return Array.from(map.values()).sort(function (a, b) {
      return (b.time || "").localeCompare(a.time || "") || (b._ts || 0) - (a._ts || 0);
    });
  }

  /**
   * 应用墓碑：删除 list 中已被云端标记删除的记录（解决"删除不同步"——
   * 其他设备本地残留已删除记录，同步时按墓碑清除）。
   * @param {Array} list 记录数组
   * @param {Array} tombstones 墓碑数组（元素含 id；type==="clear-all" 表示全部清空）
   * @returns {Array} 应用墓碑后的新数组
   */
  function applyTombstones(list, tombstones) {
    if (!tombstones || !tombstones.length) return list;
    var arr = list || [];
    // clear-all 墓碑带 deletedAt：只清「清空时间点之前」的记录，
    // 之后新建的记录不受影响（修复：之前直接 return [] 会把清空后新建的记录也一起抹掉，等于永久地雷）。
    var clearAll = tombstones.filter(function (t) { return t && t.type === "clear-all"; })[0];
    if (clearAll) {
      var cutoff = Number(clearAll.deletedAt) || 0;
      arr = arr.filter(function (r) {
        var ts = Number(r._ts) || Date.parse(r.time || "") || 0;
        return ts >= cutoff;
      });
    }
    // 逐条墓碑：删除对应 id（不参与库存的记录也按 id 移除本地残留）
    var dead = {};
    tombstones.forEach(function (t) { if (t && t.id && t.type !== "clear-all") dead[t.id] = true; });
    return arr.filter(function (r) { return !dead[r.id]; });
  }

  /** CSV 序列化（与现网一致，含 BOM 由导出时添加）；出库记录列表含「状态」列，入库列表无 */
  function toCsv(list) {
    var Stock = window.App.Stock;
    var hasOut = (list || []).some(function (r) { return (r.type || "out") !== "in"; });
    var head = ["序号", "时间", "领取人", "部门", "用途/项目", "备注", "货物名称及数量", "库存", "照片数"];
    if (hasOut) head.splice(3, 0, "状态", "出货仓库单位");   // 状态/出货仓库单位列插在「领取人」「部门」之间（保持既有状态列 splice 语义）
    var rows = list.map(function (r, i) {
      var items = (r.items || []).map(function (it) { return it.name + "×" + it.qty; }).join("； ");
      var stocks = (r.items || []).map(function (it) { return String(Stock.getRecordStock(it.name, r, it)); }).join("； ");
      var row = [list.length - i, r.time || "", r.picker || "", r.dept || "", r.purpose || "", r.note || "", items, stocks, (r.photos || []).length];
      if (hasOut) row.splice(3, 0, getStatus(r) === "pending" ? "未提单" : "已提单", r.entity || "");
      return row;
    });
    var escCsv = function (v) {
      var s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [head].concat(rows).map(function (row) { return row.map(escCsv).join(","); }).join("\r\n");
  }

  /** 导出 CSV（带 BOM；文件名 出库登记_YYYY-MM-DD.csv） */
  function exportCsv(list) {
    var arr = list || State.list;
    if (!arr.length) { Util.toast("没有可导出的记录", true); return; }
    var csv = "\ufeff" + toCsv(arr);
    // 文件名必须用本地日期：toISOString() 是 UTC，东八区 08:00 前导出会写成前一天
    Util.download("出库登记_" + Util.todayLocal() + ".csv", csv, "text/csv;charset=utf-8");
    Util.toast("已导出 CSV");
  }

  /** 对账模板 CSV（C4）：含单号/法人/单价/金额；单价取自货品目录（未设置则为空） */
  function toReconCsv(list) {
    var catalog = null;
    try { catalog = window.App.Catalog && window.App.Catalog.get(); } catch (e) {}
    var priceOf = function (name) {
      if (!catalog || !catalog.products) return null;
      for (var i = 0; i < catalog.products.length; i++) {
        if (catalog.products[i].name === name) return Number(catalog.products[i].price) || 0;
      }
      return null;
    };
    var head = ["单号", "时间", "出货仓库单位", "领取人", "部门", "用途/项目", "货品名称", "数量", "单价", "金额"];
    var rows = [];
    (list || []).forEach(function (r) {
      var base = [r.orderNo || r.id, r.time || "", r.entity || "", r.picker || "", r.dept || "", r.purpose || ""];
      (r.items || []).forEach(function (it) {
        var price = priceOf(it.name);
        var amt = (price === null || price === undefined || price === 0) ? "" : Math.round(price * (Number(it.qty) || 0) * 100) / 100;
        rows.push(base.concat([it.name, it.qty, price === null ? "" : price, amt === "" ? "" : amt]));
      });
      if (!(r.items || []).length) rows.push(base.concat(["", "", "", ""]));
    });
    var escCsv = function (v) {
      var s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [head].concat(rows).map(function (row) { return row.map(escCsv).join(","); }).join("\r\n");
  }
  function exportReconCsv(list) {
    var arr = list || State.list;
    if (!arr.length) { Util.toast("没有可导出的记录", true); return; }
    var csv = "\ufeff" + toReconCsv(arr);
    Util.download("对账_" + Util.todayLocal() + ".csv", csv, "text/csv;charset=utf-8");
    Util.toast("已导出对账 CSV");
  }

  window.App = window.App || {};
  window.App.Records = {
    create: create,
    update: update,
    remove: remove,
    restore: restore,
    clear: clear,
    mergeAndSort: mergeAndSort,
    applyTombstones: applyTombstones,
    getLastConflicts: function () { return _lastMergeConflicts; },
    getStatus: getStatus,
    tryCloseBorrowFromDiff: tryCloseBorrowFromDiff,
    toCsv: toCsv,
    exportCsv: exportCsv,
    toReconCsv: toReconCsv,
    exportReconCsv: exportReconCsv
  };
})();
