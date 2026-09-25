/**
 * dict.js — 吉客云产品名 ↔ 系统产品名「对照字典」（2026-09-26 新增）
 *
 * 为什么要它：吉客云的货品名（如「韶初泌语鹿茸凝时抗皱冻干精华液-20支装」）与系统
 * 精简名（「精华液 20支装」）是两套命名，靠模糊匹配能覆盖一部分，规格相近的（120ml / 30ml）
 * 会同时命中多个候选。字典是「一次确认、永久生效」的确定解，且用户可自行维护。
 *
 * 存储：
 *   · 云端 data/dict/jikeyun.json —— 固定写 data/ 目录，**不随双仓切换**（产品名对照与仓库无关，全店共用一份）
 *   · 本地缓存 localStorage["outbound_dict_jikeyun_v1"] —— 全局键，不带 outbound_saidis_ 前缀
 * 结构：{version, updatedAt, entries:[{from:"吉客云名", to:"系统名", note:""}]}
 *
 * 铁律：绝不改写 src/js/data/product-map.js —— 它是构建期静态文件（改动要发版），
 *       且后台 .github/scripts/wps_sync.py 用 json.loads 直解其对象体，用运行时数据污染风险极高。
 *
 * 挂载到 window.App.Dict。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Config = window.App.Config;

  /* 本文件在 index.html 中先于 js/ui/components.js 加载，解析到这里时 window.App.UI 还不存在。
     必须调用时惰性取值，否则一打开弹窗就抛 TypeError。 */
  function UI() { return window.App.UI; }

  var DICT_LS_KEY = "outbound_dict_jikeyun_v1";
  var CLOUD_DATA_DIR = "data";
  var CLOUD_SUBDIR = "dict";
  var CLOUD_ID = "jikeyun";

  var dict = null;       // {version, updatedAt, entries:[]}
  var loaded = false;
  /* 加载状态（供视图区分「加载中 / 已从云端拉到 / 用本机缓存 / 真的没有」，避免一律显示「（空）」造成误解） */
  var loadState = "idle";   // idle | loading | cloud | cache | empty
  var dirty = false;     // learn() 后置位，供静默上云

  /* ---------- 工具 ---------- */

  function hasToken() {
    try { return !!(window.App.Cloud && window.App.Cloud.hasToken && window.App.Cloud.hasToken()); }
    catch (e) { return false; }
  }

  /** 归一化（与 Jikeyun.normName / Engine.normalize 同规则）；Jikeyun 未加载时本地兜底 */
  function normKey(s) {
    try {
      var J = window.App.Jikeyun;
      if (J && typeof J.normName === "function") return J.normName(s);
    } catch (e) {}
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function defaultDict() { return { version: 1, updatedAt: 0, entries: [] }; }

  function cacheLocal() {
    try { localStorage.setItem(DICT_LS_KEY, JSON.stringify(dict)); } catch (e) {}
  }

  /** 清洗条目：去空、去重（按 from 归一化键）、截断备注 */
  function sanitize(arr) {
    var out = [], seen = {};
    (arr || []).forEach(function (e) {
      if (!e) return;
      var from = String(e.from == null ? "" : e.from).trim();
      var to = String(e.to == null ? "" : e.to).trim();
      if (!from || !to) return;
      var k = normKey(from) + "|" + to;   /* 按 (from,to) 组合去重：一个吉客云货品名可对应多个系统货品（1:N） */
      if (!k || seen[k]) return;
      seen[k] = 1;
      out.push({ from: from, to: to, note: String(e.note == null ? "" : e.note).slice(0, 60) });
    });
    return out;
  }

  /* ---------- 加载 ---------- */

  /** 读云端 data/dict/jikeyun.json；无令牌 / 404 / 失败均返回 null（不抛错） */
  async function fetchCloud() {
    if (!hasToken()) return null;
    try {
      var C = window.App.Cloud;
      if (!C || typeof C.fetchJsonFile !== "function") return null;
      return await C.fetchJsonFile({ dataDir: CLOUD_DATA_DIR, subdir: CLOUD_SUBDIR, id: CLOUD_ID });
    } catch (e) { return null; }
  }

  /** 启动加载：云端优先 → 本地缓存 → 空字典 */
  async function load() {
    if (loaded) return;
    loaded = true;
    loadState = "loading";
    var cloud = await fetchCloud();
    if (cloud && Array.isArray(cloud.entries)) {
      dict = { version: cloud.version || 1, updatedAt: cloud.updatedAt || 0, entries: sanitize(cloud.entries) };
      cacheLocal();
      loadState = "cloud";
      return;
    }
    try {
      var cached = JSON.parse(localStorage.getItem(DICT_LS_KEY) || "null");
      if (cached && Array.isArray(cached.entries)) { dict = cached; loadState = "cache"; return; }
    } catch (e) {}
    dict = defaultDict();
    loadState = "empty";
  }

  /* ---------- 查表 / 学习 ---------- */

  /**
   * 查字典：吉客云货品名 → 系统货品名（按归一化键精确比对）。
   * @param {string} rawName
   * @returns {?string} 命中返回系统货品名；未命中返回 null
   */
  /**
   * 查字典（返回全部命中）：一个吉客云货品名可以对应多个系统货品（1:N），
   * 如「一人一方定制套装礼盒（配套硫酸纸）」= 大号礼盒 + 大号拎袋。
   * @param {string} rawName
   * @returns {string[]} 命中的系统货品名数组；未命中返回空数组
   */
  function lookupAll(rawName) {
    var key = normKey(rawName);
    var out = [];
    if (!key) return out;
    var list = (dict && dict.entries) || [];
    for (var i = 0; i < list.length; i++) {
      if (normKey(list[i].from) === key && list[i].to) out.push(list[i].to);
    }
    return out;
  }

  /**
   * 查字典（取第一个命中）。
   * @param {string} rawName
   * @returns {?string} 命中返回系统货品名；未命中返回 null
   */
  function lookup(rawName) {
    var all = lookupAll(rawName);
    return all.length ? all[0] : null;
  }

  /**
   * 记忆一条对应关系（人工确认后调用，越用越准）。同 from 已存在则更新 to。
   * 只写内存 + 本地缓存并标记 dirty，云端提交由 flush()/save() 统一完成，避免频繁写。
   */
  function learn(raw, sysName) {
    var from = String(raw == null ? "" : raw).trim();
    var to = String(sysName == null ? "" : sysName).trim();
    if (!from || !to) return;
    if (!dict) dict = defaultDict();
    if (!Array.isArray(dict.entries)) dict.entries = [];
    var key = normKey(from);
    for (var i = 0; i < dict.entries.length; i++) {
      if (normKey(dict.entries[i].from) === key) {
        if (dict.entries[i].to !== to) { dict.entries[i].to = to; dirty = true; cacheLocal(); }
        return;
      }
    }
    dict.entries.push({ from: from, to: to, note: "" });
    dirty = true;
    cacheLocal();
  }

  /** 是否已「记住」某条对应（视图用于提示「已记住」） */
  function isKnown(rawName) { return !!lookup(rawName); }

  /* ---------- 保存 ---------- */

  /**
   * 保存整份字典：云端 PUT（幂等 upsert）；无令牌降级本地。
   * @param {Object} next {entries:[...]} 或完整 dict 对象
   * @param {Function} [cb] cb(ok:boolean, msg:string)
   */
  async function save(next, cb) {
    var entries = sanitize((next && next.entries) || (next || []));
    var payload = { version: 1, updatedAt: Date.now(), entries: entries };
    dict = payload;
    cacheLocal();
    if (!hasToken()) {
      dirty = false;
      if (cb) cb(true, "本机模式：对照字典已保存到本机");
      return;
    }
    try {
      var C = window.App.Cloud;
      if (!C || typeof C.putJsonFile !== "function") {
        if (cb) cb(false, "云端同步组件未就绪，已存本机");
        return;
      }
      var okCloud = await C.putJsonFile({
        dataDir: CLOUD_DATA_DIR,
        subdir: CLOUD_SUBDIR,
        id: CLOUD_ID,
        payload: payload,
        message: "update jikeyun dict (" + entries.length + " entries)"
      });
      if (!okCloud) { if (cb) cb(false, "云端保存失败，已存本机（可稍后在字典弹窗重试）"); return; }
      dirty = false;
      loadState = "cloud";
      if (cb) cb(true, "对照字典已保存到云端（" + entries.length + " 条）");
    } catch (e) {
      if (cb) cb(false, "云端保存异常：" + ((e && e.message) || e));
    }
  }

  /** 静默上云：仅当 learn() 置过 dirty 时提交，失败不打扰用户 */
  function flush(cb) {
    if (!dirty) { if (cb) cb(true, ""); return; }
    save(dict, function (ok, msg) { if (cb) cb(ok, msg); });
  }

  /* ---------- 管理界面 ---------- */

  /** 生成系统货品名下拉（选项 = Config.PRODUCTS 实时值；已失效的旧值补一个标记项） */
  function buildOptions(selected, includeEmpty) {
    var prods = (Config.PRODUCTS || []).slice();
    var html = includeEmpty ? '<option value="">（请选择）</option>' : "";
    if (selected && prods.indexOf(selected) === -1) {
      html += '<option value="' + Util.esc(selected) + '" selected>' + Util.esc(selected) + '（已失效）</option>';
    }
    prods.forEach(function (p) {
      html += '<option value="' + Util.esc(p) + '"' + (p === selected ? " selected" : "") + '>' + Util.esc(p) + '</option>';
    });
    return html;
  }

  /**
   * 打开「产品对照字典」管理弹窗：查看 / 修改 / 新增 / 删除 + 保存。
   * @param {Function} [onSaved] 保存成功回调（视图用于刷新提示）
   */
  function openManager(onSaved) {
    var work = JSON.parse(JSON.stringify(dict || defaultDict()));
    work.entries = sanitize(work.entries);
    var body =
      '<div class="hint" style="margin-bottom:8px;line-height:1.7">' +
        '左边填<b>吉客云里的货品名</b>，右边选<b>系统里的货品名</b>。保存后立即生效，下次粘贴同类订单自动对上，不用再手动选。' +
      '</div>' +
      '<div class="field" style="margin-bottom:8px">' +
        '<input type="text" id="dictFilter" placeholder="🔍 筛选（输入吉客云货品名的片段）" autocomplete="off" />' +
      '</div>' +
      '<div class="table-wrap" style="max-height:50vh;overflow:auto">' +
        '<table class="table" style="min-width:0;width:100%">' +
          '<thead><tr><th style="width:42%">吉客云货品名</th><th style="width:42%">对应系统货品名</th>' +
          '<th style="width:10%">备注</th><th style="width:6%"></th></tr></thead>' +
          '<tbody id="dictRows"></tbody>' +
        '</table>' +
      '</div>' +
      '<div class="actions" style="margin-top:10px">' +
        '<button type="button" class="btn ghost sm" id="dictAdd">＋ 新增一条</button>' +
        '<span class="hint" style="align-self:center" id="dictCount"></span>' +
      '</div>' +
      '<div class="modal-actions" style="margin-top:14px">' +
        '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
        '<button type="button" class="btn sm" id="dictSave">保存字典</button>' +
      '</div>';
    UI().Modal.show("📖 产品对照字典", body, { width: "820px" });
    var mBody = UI().Modal.body();
    var tbody = mBody.querySelector("#dictRows");
    var filterEl = mBody.querySelector("#dictFilter");
    var countEl = mBody.querySelector("#dictCount");

    function visibleIndexes() {
      var q = String(filterEl.value || "").trim().toLowerCase();
      var idx = [];
      work.entries.forEach(function (e, i) {
        if (!q || String(e.from || "").toLowerCase().indexOf(q) !== -1 ||
            String(e.to || "").toLowerCase().indexOf(q) !== -1) idx.push(i);
      });
      return idx;
    }

    function draw() {
      var idx = visibleIndexes();
      tbody.innerHTML = idx.map(function (i) {
        var e = work.entries[i];
        return '<tr>' +
          '<td><input type="text" data-i="' + i + '" data-f="from" class="dict-in" value="' + Util.esc(e.from) + '" ' +
            'placeholder="吉客云里的名字" style="width:100%;padding:8px 10px;border:1px solid var(--input-line,#C6DAD1);border-radius:10px;background:var(--input-bg,#FBFCFA)" /></td>' +
          '<td><select data-i="' + i + '" data-f="to" class="dict-in" style="width:100%;padding:8px 10px;border:1px solid var(--input-line,#C6DAD1);border-radius:10px;background:var(--input-bg,#FBFCFA)">' +
            buildOptions(e.to, true) + '</select></td>' +
          '<td><input type="text" data-i="' + i + '" data-f="note" class="dict-in" value="' + Util.esc(e.note || "") + '" style="width:100%;padding:8px 10px;border:1px solid var(--input-line,#C6DAD1);border-radius:10px;background:var(--input-bg,#FBFCFA)" /></td>' +
          '<td><button type="button" class="btn-clear" data-i="' + i + '" data-del="1">✕</button></td>' +
        '</tr>';
      }).join("") || '<tr><td colspan="4" style="text-align:center;color:var(--muted,#8A9995);padding:16px">还没有对照条目，点下面「＋ 新增一条」开始</td></tr>';
      countEl.textContent = "共 " + work.entries.length + " 条" + (idx.length !== work.entries.length ? "（显示 " + idx.length + "）" : "");
    }
    draw();

    tbody.addEventListener("input", function (ev) {
      var el = ev.target.closest(".dict-in");
      if (!el) return;
      var i = Number(el.getAttribute("data-i"));
      var f = el.getAttribute("data-f");
      if (work.entries[i]) work.entries[i][f] = el.value;
    });
    tbody.addEventListener("change", function (ev) {
      var el = ev.target.closest("select.dict-in");
      if (!el) return;
      var i = Number(el.getAttribute("data-i"));
      if (work.entries[i]) work.entries[i].to = el.value;
    });
    tbody.addEventListener("click", function (ev) {
      var btn = ev.target.closest("[data-del]");
      if (!btn) return;
      work.entries.splice(Number(btn.getAttribute("data-i")), 1);
      draw();
    });
    filterEl.addEventListener("input", draw);
    mBody.querySelector("#dictAdd").addEventListener("click", function () {
      work.entries.unshift({ from: "", to: "", note: "" });
      filterEl.value = "";
      draw();
      var first = tbody.querySelector(".dict-in");
      if (first) first.focus();
    });
    mBody.querySelector("#dictSave").addEventListener("click", async function () {
      var btn = mBody.querySelector("#dictSave");
      if (btn.dataset.busy === "1") return;
      btn.dataset.busy = "1"; btn.disabled = true;
      try {
        var cleaned = sanitize(work.entries);
        if (work.entries.length && !cleaned.length) { Util.toast("每一行都需要填写吉客云名称和对应的系统货品名", true); return; }
        if (cleaned.length < work.entries.length) {
          var okDrop = await UI().confirmDialog("有 " + (work.entries.length - cleaned.length) + " 行没填全（或重复），保存时会被丢弃。继续保存？", "保存字典");
          if (!okDrop) return;
        }
        save({ entries: cleaned }, function (ok2, msg) {
          Util.toast(msg, !ok2);
          if (ok2) {
            UI().Modal.hide();
            if (typeof onSaved === "function") { try { onSaved(); } catch (e) {} }
          }
        });
      } finally {
        btn.dataset.busy = "0"; btn.disabled = false;
      }
    });
    mBody.querySelector('[data-act="cancel"]').addEventListener("click", function () { UI().Modal.hide(); });
  }

  /* ---------- 初始化 ---------- */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { load(); });
  } else {
    load();
  }

  window.App = window.App || {};
  window.App.Dict = {
    load: load,
    reload: async function () { loaded = false; dict = null; await load(); },
    get: function () { return dict; },
    count: function () { return ((dict && dict.entries) || []).length; },
    lookup: lookup,
    lookupAll: lookupAll,
    state: function () { return loadState; },
    isKnown: isKnown,
    learn: learn,
    save: save,
    flush: flush,
    openManager: openManager
  };
})();
