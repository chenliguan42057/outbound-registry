/**
 * store.js — localStorage 封装 + AppState（记录列表 / 导航 / 认证 / 草稿 / 搜索条件）
 */
(function () {
  'use strict';

  var Config = window.App.Config;

  var Store = {
    /** 读取 JSON；失败或不存在返回 def */
    get: function (key, def) {
      try {
        var v = localStorage.getItem(key);
        return v === null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set: function (key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); }
      catch (e) { console.warn("localStorage set failed:", key, e); }
    },
    remove: function (key) {
      try { localStorage.removeItem(key); } catch (e) {}
    },

    /* ---- 记录（冻结键 outbound_records_v2） ---- */
    loadRecords: function () { return Store.get(Config.STORE_KEY, []); },
    saveRecords: function (list) { Store.set(Config.STORE_KEY, list); },

    /* ---- 认证（记住登录） ---- */
    loadAuth: function () { return Store.get(Config.AUTH_KEY, null); },
    saveAuth: function (auth) { Store.set(Config.AUTH_KEY, auth); },
    clearAuth: function () { Store.remove(Config.AUTH_KEY); },

    /* ---- 导航状态（最后停留目录项 / 折叠状态） ---- */
    loadNav: function () {
      return Object.assign(
        { active: "out", sidebarCollapsed: false, moduleCollapse: {} },
        Store.get(Config.NAV_KEY, {})
      );
    },
    saveNav: function (nav) { Store.set(Config.NAV_KEY, nav); },

    /* ---- 表单草稿：name = "out" | "in" ---- */
    loadDraft: function (name) {
      return Store.get(name === "in" ? Config.DRAFT_IN_KEY : Config.DRAFT_OUT_KEY, null);
    },
    saveDraft: function (name, draft) {
      Store.set(name === "in" ? Config.DRAFT_IN_KEY : Config.DRAFT_OUT_KEY, draft);
    },
    clearDraft: function (name) {
      Store.remove(name === "in" ? Config.DRAFT_IN_KEY : Config.DRAFT_OUT_KEY);
    },

    /* ---- 记录搜索条件 ---- */
    loadSearch: function () {
      return Object.assign(
        { q: "", dept: "", picker: "", type: "", from: "", to: "" },
        Store.get(Config.SEARCH_KEY, {})
      );
    },
    saveSearch: function (s) { Store.set(Config.SEARCH_KEY, s); },

    /* ---- 历史补全（部门 / 领取人，冻结键） ---- */
    getHistory: function (key) { return Store.get(key, []); },
    addHistory: function (key, val) {
      val = String(val || "").trim();
      if (!val) return;
      var arr = Store.getHistory(key).filter(function (x) { return x !== val; });
      arr.unshift(val);
      if (arr.length > 30) arr = arr.slice(0, 30);
      Store.set(key, arr);
    }
  };

  /* ---- 应用级状态（内存） ---- */
  var State = {
    list: [],
    lastSync: null,
    nav: null,
    appMounted: false,
    init: function () {
      State.list = Store.loadRecords();
      State.nav = Store.loadNav();
    },
    save: function () { Store.saveRecords(State.list); }
  };

  window.App = window.App || {};
  window.App.Store = Store;
  window.App.State = State;
})();
