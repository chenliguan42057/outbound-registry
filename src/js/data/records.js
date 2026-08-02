/**
 * records.js — 记录 CRUD + 云端合并排序 + CSV 导出
 * 记录 schema 冻结：{id, time, picker?, dept?, purpose, items:[{name,qty}], photos:[dataURL], _ts, affectsStock, type?, status?}
 * status?: "pending" | "submitted" —— 仅出库记录（type 非 "in"）使用的可选字段；入库不写。
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
    State.save();
    return rec;
  }

  /** 更新记录（保留原字段，强制刷新 _ts，affectsStock 恒为 true） */
  function update(id, patch) {
    var idx = State.list.findIndex(function (r) { return r.id === id; });
    if (idx < 0) return null;
    var rec = Object.assign({}, State.list[idx], patch, { _ts: Date.now(), affectsStock: true });
    State.list[idx] = rec;
    State.save();
    return rec;
  }

  /** 删除记录（本地） */
  function remove(id) {
    State.list = State.list.filter(function (r) { return r.id !== id; });
    State.save();
  }

  /** 清空本地记录 */
  function clear() {
    State.list = [];
    State.save();
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

  /** CSV 序列化（与现网一致，含 BOM 由导出时添加）；出库记录列表含「状态」列，入库列表无 */
  function toCsv(list) {
    var Stock = window.App.Stock;
    var hasOut = (list || []).some(function (r) { return (r.type || "out") !== "in"; });
    var head = ["序号", "时间", "领取人", "部门", "用途/项目", "货物名称及数量", "库存", "照片数"];
    if (hasOut) head.splice(3, 0, "状态");   // 状态列插在「领取人」「部门」之间
    var rows = list.map(function (r, i) {
      var items = (r.items || []).map(function (it) { return it.name + "×" + it.qty; }).join("； ");
      var stocks = (r.items || []).map(function (it) { return String(Stock.getStock(it.name)); }).join("； ");
      var row = [list.length - i, r.time || "", r.picker || "", r.dept || "", r.purpose || "", items, stocks, (r.photos || []).length];
      if (hasOut) row.splice(3, 0, getStatus(r) === "pending" ? "未提单" : "已提单");
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

  window.App = window.App || {};
  window.App.Records = {
    create: create,
    update: update,
    remove: remove,
    clear: clear,
    mergeAndSort: mergeAndSort,
    getStatus: getStatus,
    toCsv: toCsv,
    exportCsv: exportCsv
  };
})();
