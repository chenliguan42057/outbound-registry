/**
 * pickups.js — 待取货 CRUD + 云端合并排序
 * 待取货 schema（新增，不影响既有记录 schema）：{id, time, picker, dept, purpose,
 *   items:[{name,qty}], note?, confirmed:false, shipped:false, _ts}
 *   confirmed = 已确认提单（默认 false）；shipped = 已出库（默认 false）。
 * 注意：待取货记录绝不影响库存计算（stock.js 只遍历 State.list，天然隔离）。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Store = window.App.Store;
  var State = window.App.State;

  /** 新增待取货登记（本地保存 + 返回记录） */
  function create(payload) {
    var pk = Object.assign({
      id: Util.genId(),
      _ts: Date.now(),
      confirmed: false,
      shipped: false,
      items: [],
      note: ""
    }, payload);
    State.pickups.unshift(pk);
    State.savePickups();
    return pk;
  }

  /** 更新待取货（保留原字段，强制刷新 _ts） */
  function update(id, patch) {
    var idx = State.pickups.findIndex(function (p) { return p.id === id; });
    if (idx < 0) return null;
    var pk = Object.assign({}, State.pickups[idx], patch, { _ts: Date.now() });
    State.pickups[idx] = pk;
    State.savePickups();
    return pk;
  }

  /** 删除待取货（本地） */
  function remove(id) {
    State.pickups = State.pickups.filter(function (p) { return p.id !== id; });
    State.savePickups();
  }

  /** 合并策略：同 id 冲突时，若本地已出库而云端旧副本未出库，保留本地版本（操作状态以本地为准，
      防止推送失败后云端旧副本把「已出库」回退成「未出库」导致重复确认出库）；其余情况云端覆盖本地；
      排序 = time 降序，次 _ts 降序（与记录一致） */
  function mergeAndSort(local, remote) {
    var map = new Map();
    (local || []).forEach(function (p) { map.set(p.id, p); });
    (remote || []).forEach(function (p) {
      var lp = map.get(p.id);
      if (lp && lp.shipped === true && p.shipped !== true) return;   // 保留本地「已出库」操作状态
      if (lp && (lp.photos && lp.photos.length) && !(p.photos && p.photos.length) && (p.photoUrls && p.photoUrls.length)) {
        map.set(p.id, Object.assign({}, p, { photos: lp.photos }));   // 保留本地 photos 原始凭证
        return;
      }
      map.set(p.id, p);
    });
    return Array.from(map.values()).sort(function (a, b) {
      return (b.time || "").localeCompare(a.time || "") || (b._ts || 0) - (a._ts || 0);
    });
  }

  /** 转为出库记录 payload（确认出库时调用；不含 confirmed/shipped）。
      结算法人单位：待取货表单不收集，按系统默认「深圳细胞法人」补全（Config.ENTITY_PRESETS[0]），
      与出库登记表单的空值回退规则一致（out.js DEFAULT_ENTITY）；备注原样透传，信息不断链。 */
  function toOutboundPayload(pk) {
    var entity = (window.App.Config && window.App.Config.ENTITY_PRESETS && window.App.Config.ENTITY_PRESETS[0]) || "深圳细胞法人";
    return {
      time: Util.nowLocal(),
      picker: pk.picker,
      dept: pk.dept,
      purpose: pk.purpose,
      note: pk.note || "",
      items: (pk.items || []).map(function (it) { return { name: it.name, qty: it.qty }; }),
      affectsStock: true,
      status: "submitted",
      entity: entity,
      pickupId: pk.id
    };
  }

  window.App = window.App || {};
  window.App.Pickups = {
    create: create,
    update: update,
    remove: remove,
    mergeAndSort: mergeAndSort,
    toOutboundPayload: toOutboundPayload
  };
})();
