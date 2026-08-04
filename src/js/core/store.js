/**
 * store.js — localStorage 封装 + AppState（记录列表 / 导航 / 草稿 / 搜索条件）
 * 认证改为会话级内存标志（auth.js），本模块不再提供任何认证存取。
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

    /* ---- 导航状态（最后停留目录项 / 折叠状态） ---- */
    loadNav: function () {
      return Object.assign(
        { active: "out-records", sidebarCollapsed: false, moduleCollapse: {} },
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

    /* ---- 待取货（localStorage 键 outbound_pickups_v2，纯追加不动既有键） ---- */
    loadPickups: function () { return Store.get(Config.PICKUP_STORE_KEY, []); },
    savePickups: function (list) { Store.set(Config.PICKUP_STORE_KEY, list); },

    /* ---- 待取货登记草稿（outbound_pickup_draft） ---- */
    loadPickupsDraft: function () { return Store.get(Config.PICKUP_DRAFT_KEY, null); },
    savePickupsDraft: function (draft) { Store.set(Config.PICKUP_DRAFT_KEY, draft); },
    clearPickupsDraft: function () { Store.remove(Config.PICKUP_DRAFT_KEY); },

    /* ---- 备忘录（localStorage 键 outbound_memos_v2，纯追加不动既有键） ---- */
    loadMemos: function () { return Store.get(Config.MEMO_STORE_KEY, []); },
    saveMemos: function (list) { Store.set(Config.MEMO_STORE_KEY, list); },

    /* ---- 历史补全（部门 / 领取人，冻结键） ---- */
    getHistory: function (key) { return Store.get(key, []); },
    addHistory: function (key, val) {
      val = String(val || "").trim();
      if (!val) return;
      var arr = Store.getHistory(key).filter(function (x) { return x !== val; });
      arr.unshift(val);
      if (arr.length > 30) arr = arr.slice(0, 30);
      Store.set(key, arr);
    },

    /* ---- AI 助手存取（第四轮增量；Key 为原始字符串不 JSON 包裹，仅存本机） ---- */
    loadAiKey: function () {
      try { return localStorage.getItem(Config.AI_KEY_KEY) || ""; }
      catch (e) { return ""; }
    },
    saveAiKey: function (k) {
      try { localStorage.setItem(Config.AI_KEY_KEY, String(k || "")); }
      catch (e) { console.warn("localStorage set ai key failed:", e); }
    },
    clearAiKey: function () {
      try { localStorage.removeItem(Config.AI_KEY_KEY); } catch (e) {}
    },
    loadAiSettings: function () {
      return Object.assign(
        { provider: Config.AI_DEFAULT_PROVIDER, model: Config.AI_DEFAULT_MODEL, baseUrl: Config.AI_BASE_URL },
        Store.get(Config.AI_SETTINGS_KEY, {})
      );
    },
    saveAiSettings: function (s) { Store.set(Config.AI_SETTINGS_KEY, s); },
    loadAiChat: function () { return Store.get(Config.AI_CHAT_KEY, []); },
    saveAiChat: function (msgs) {
      Store.set(Config.AI_CHAT_KEY, (msgs || []).slice(-Config.AI_CHAT_HISTORY_LIMIT));
    },
    clearAiChat: function () { Store.remove(Config.AI_CHAT_KEY); },

    /* ---- AI 联网搜索存取（第五轮增量；搜索 Key 为原始字符串不 JSON 包裹，仅存本机） ---- */
    loadSearchKey: function () {
      try { return localStorage.getItem(Config.SEARCH_KEY_KEY) || ""; }
      catch (e) { return ""; }
    },
    saveSearchKey: function (k) {
      try { localStorage.setItem(Config.SEARCH_KEY_KEY, String(k || "")); }
      catch (e) { console.warn("localStorage set search key failed:", e); }
    },
    clearSearchKey: function () {
      try { localStorage.removeItem(Config.SEARCH_KEY_KEY); } catch (e) {}
    },
    loadSearchSettings: function () {
      return Object.assign(
        { provider: "tavily", enabledWeather: true, enabledWiki: true, enabledNews: false },
        Store.get(Config.SEARCH_SETTINGS_KEY, {})
      );
    },
    saveSearchSettings: function (s) { Store.set(Config.SEARCH_SETTINGS_KEY, s); }
  };

  /* ---- 应用级状态（内存） ---- */
  var State = {
    list: [],
    pickups: [],
    memos: [],
    lastSync: null,
    nav: null,
    appMounted: false,
    init: function () {
      State.list = Store.loadRecords();
      State.pickups = Store.loadPickups();
      State.memos = Store.loadMemos();
      State.nav = Store.loadNav();
    },
    save: function () { Store.saveRecords(State.list); },
    savePickups: function () { Store.savePickups(State.pickups); },
    saveMemos: function () { Store.saveMemos(State.memos); }
  };

  window.App = window.App || {};
  window.App.Store = Store;
  window.App.State = State;
})();
