/**
 * memos.js — 备忘录 CRUD + 云端合并排序
 * 备忘录 schema（新增，不影响既有记录 schema）：{id, text, time, done, _ts, remindAt?, reminded?}
 *   text = 事项内容；time = 添加时间（Util.nowLocal() "YYYY-MM-DDTHH:mm"）；
 *   done = 是否已完成（默认 false，手动点击改为 true）。
 *   remindAt = 每条备忘各自绑定的提醒时间（可选，"" 或 "YYYY-MM-DDTHH:mm" 北京时间本地表示；空=不提醒）；
 *   reminded = 该提醒是否已推送过（默认 false，防重复推送；改提醒时间时重置为 false）。
 * 注意：备忘录绝不影响库存计算（stock.js 只遍历 State.list，天然隔离）。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var State = window.App.State;

  /** 新增备忘录（本地保存 + 返回记录）；remindAt/reminded 为纯追加可选字段，create 合并默认值 */
  function create(payload) {
    var memo = Object.assign({
      id: Util.genId(),
      time: Util.nowLocal(),
      _ts: Date.now(),
      done: false,
      remindAt: "",
      reminded: false
    }, payload);
    State.memos.unshift(memo);
    State.saveMemos();
    return memo;
  }

  /** 更新备忘录（保留原字段，强制刷新 _ts） */
  function update(id, patch) {
    var idx = State.memos.findIndex(function (m) { return m.id === id; });
    if (idx < 0) return null;
    var memo = Object.assign({}, State.memos[idx], patch, { _ts: Date.now() });
    State.memos[idx] = memo;
    State.saveMemos();
    return memo;
  }

  /** 设/改提醒时间：置 remindAt 并重置 reminded:false（改时间后允许再次推送）；remindAt 传空串表示清除提醒 */
  function updateRemind(id, remindAt) {
    return update(id, { remindAt: String(remindAt || ""), reminded: false });
  }

  /** 删除备忘录（本地） */
  function remove(id) {
    State.memos = State.memos.filter(function (m) { return m.id !== id; });
    State.saveMemos();
  }

  /** 合并策略：同 id 冲突时云端覆盖本地（与待取货一致，云端为准），
      但「本地有 photos 而云端已剥离（photos 空但 photoUrls 有值）」时保留本地 photos
      （dataURL 为本机编辑回填/补传所需原始凭证）；
      排序 = time 降序，次 _ts 降序（与记录一致） */
  function mergeAndSort(local, remote) {
    var map = new Map();
    (local || []).forEach(function (m) { map.set(m.id, m); });
    (remote || []).forEach(function (m) {
      var prev = map.get(m.id);
      if (prev && (prev.photos && prev.photos.length) && !(m.photos && m.photos.length) && (m.photoUrls && m.photoUrls.length)) {
        map.set(m.id, Object.assign({}, m, { photos: prev.photos }));
      } else {
        map.set(m.id, m);
      }
    });
    return Array.from(map.values()).sort(function (a, b) {
      return (b.time || "").localeCompare(a.time || "") || (b._ts || 0) - (a._ts || 0);
    });
  }

  window.App = window.App || {};
  window.App.Memos = {
    create: create,
    update: update,
    updateRemind: updateRemind,
    remove: remove,
    mergeAndSort: mergeAndSort
  };
})();
