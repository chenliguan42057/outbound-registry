/**
 * records.js — 记录 CRUD + 云端合并排序 + CSV 导出
 * 记录 schema 冻结：{id, time, picker?, dept?, purpose, items:[{name,qty}], photos:[dataURL], _ts, affectsStock, type?, status?}
 * status?: "pending" | "submitted" —— 仅出库记录（type 非 "in"）使用的可选字段；入库不写。
 * entity?: 结算法人单位（仅出库记录，chip 必填）；note?: 备注（非必填）——均为纯追加可选字段。
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
      if (it && it.name) it.stock = Stock.getStock(it.name);
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

  /** 更新记录（保留原字段，强制刷新 _ts，affectsStock 恒为 true）
      仅当 patch 自带新 items 数组时重打库存快照；status/photoUrls 等非货品更新保留原快照，避免覆盖。 */
  function update(id, patch) {
    var idx = State.list.findIndex(function (r) { return r.id === id; });
    if (idx < 0) return null;
    var rec = Object.assign({}, State.list[idx], patch, { _ts: Date.now(), affectsStock: true });
    State.list[idx] = rec;
    if (patch && Object.prototype.hasOwnProperty.call(patch, "items")) stampStock(rec);
    State.save();
    return rec;
  }

  /** 删除记录（本地） */
  function remove(id) {
    var gone = null;
    State.list.forEach(function (r) { if (r.id === id) gone = r; });
    State.list = State.list.filter(function (r) { return r.id !== id; });
    State.save();
    try {
      if (window.App.Audit && gone) window.App.Audit.log("delete", {
        id: id,
        summary: ((gone.picker || "") + " " + (gone.purpose || "")).slice(0, 200)
      });
    } catch (e) {}
  }

  /** 清空本地记录 */
  function clear() {
    State.list = [];
    State.save();
    try { if (window.App.Audit) window.App.Audit.log("clear-all", {}); } catch (e) {}
  }

  /** 合并策略：同 id 云端覆盖本地；排序 = time 降序，次 _ts 降序（与现网一致） */
  function mergeAndSort(local, remote) {
    var map = new Map();
    (local || []).forEach(function (r) { map.set(r.id, r); });
    (remote || []).forEach(function (r) { map.set(r.id, r); });
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
    var hasClearAll = tombstones.some(function (t) { return t && t.type === "clear-all"; });
    if (hasClearAll) return [];
    var dead = {};
    tombstones.forEach(function (t) { if (t && t.id) dead[t.id] = true; });
    return (list || []).filter(function (r) { return !dead[r.id]; });
  }

  /** CSV 序列化（与现网一致，含 BOM 由导出时添加）；出库记录列表含「状态」列，入库列表无 */
  function toCsv(list) {
    var Stock = window.App.Stock;
    var hasOut = (list || []).some(function (r) { return (r.type || "out") !== "in"; });
    var head = ["序号", "时间", "领取人", "部门", "用途/项目", "备注", "货物名称及数量", "库存", "照片数"];
    if (hasOut) head.splice(3, 0, "状态", "结算法人单位");   // 状态/结算法人单位列插在「领取人」「部门」之间（保持既有状态列 splice 语义）
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
    Util.download("出库登记_" + new Date().toISOString().slice(0, 10) + ".csv", csv, "text/csv;charset=utf-8");
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
    var head = ["单号", "时间", "结算法人单位", "领取人", "部门", "用途/项目", "货品名称", "数量", "单价", "金额"];
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
    Util.download("对账_" + new Date().toISOString().slice(0, 10) + ".csv", csv, "text/csv;charset=utf-8");
    Util.toast("已导出对账 CSV");
  }

  window.App = window.App || {};
  window.App.Records = {
    create: create,
    update: update,
    remove: remove,
    clear: clear,
    mergeAndSort: mergeAndSort,
    applyTombstones: applyTombstones,
    getStatus: getStatus,
    toCsv: toCsv,
    exportCsv: exportCsv,
    toReconCsv: toReconCsv,
    exportReconCsv: exportReconCsv
  };
})();
