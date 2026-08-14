/**
 * catalog.js — 货品目录可配置（B1，2026-08-08 第二批）
 * 数据源：data/catalog/catalog.json（云端，无令牌时降级 localStorage 缓存 / 内置默认）
 * 启动时拉取目录并「原地覆盖」Config.PRODUCTS / Config.INVENTORY / Config.CATEGORY_MAP，
 * 所有既有消费方（搜索/库存/仪表盘/报表）自动生效；拉取失败回落默认，零破坏。
 * 提供管理界面：增删改货品（名称/单位/预警线/单价/条码）+ 保存（云端或本机）。
 * 纯新增文件；schema 完全独立，不触碰 records/pickups/memos 既有结构。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Config = window.App.Config;
  // 本文件在 index.html 中先于 js/ui/components.js 加载，解析到这里时 window.App.UI 还不存在。
  // 所以不能在顶部捕获常量，必须调用时惰性取值，否则「货品目录管理」弹窗一打开就抛 TypeError。
  function UI() { return window.App.UI; }

  var CLOUD_PATH = "data/catalog/catalog.json";
  var LS_KEY = "outbound_catalog_v1";
  var catalog = null;   // {version, updatedAt, products:[], inventory:{}}
  var loaded = false;

  /* ---------- 数据加载 ---------- */

  function hasToken() {
    return window.App.Cloud && window.App.Cloud.hasToken();
  }

  /** 用目录覆盖配置（原地变更，保证既有引用生效） */
  function applyToConfig(cat) {
    if (!cat || !Array.isArray(cat.products) || !cat.products.length) return;
    var names = cat.products.map(function (p) { return p.name; });
    Config.PRODUCTS.length = 0;
    names.forEach(function (n) { Config.PRODUCTS.push(n); });
    var inv = cat.inventory || {};
    Object.keys(Config.INVENTORY).forEach(function (k) { delete Config.INVENTORY[k]; });
    Object.keys(inv).forEach(function (k) { Config.INVENTORY[k] = Number(inv[k]) || 0; });
    // 类目归组保持可用：只保留仍在目录里的货品（新增货品归「其他」）
    var cm = Config.CATEGORY_MAP || {};
    Object.keys(cm).forEach(function (catKey) {
      cm[catKey] = (cm[catKey] || []).filter(function (n) { return names.indexOf(n) !== -1; });
    });
  }

  /** 读取云端 catalog.json；404 返回 null */
  async function fetchCloud() {
    if (!hasToken()) return null;
    try {
      var res = await fetch("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + CLOUD_PATH +
        "?ref=" + Config.GH.branch, { headers: { "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + Config.GH.token } });
      if (!res.ok) return null;
      var j = await res.json();
      return JSON.parse(Util.b64dec(j.content));
    } catch (e) { return null; }
  }

  /** 生成默认目录（从当前配置推导，保证保存时始终有完整底稿） */
  function defaultCatalog() {
    var products = Config.PRODUCTS.map(function (name) {
      return { name: name, unit: "", warnAt: Config.LOW_STOCK_THRESHOLD, price: 0, barcode: "" };
    });
    return { version: 1, updatedAt: 0, products: products, inventory: Object.assign({}, Config.INVENTORY) };
  }

  /** 启动加载：云端优先 → localStorage 缓存 → 默认 */
  async function load() {
    if (loaded) return;
    loaded = true;
    var cloud = await fetchCloud();
    if (cloud && Array.isArray(cloud.products)) {
      catalog = cloud;
      applyToConfig(cloud);
      try { localStorage.setItem(LS_KEY, JSON.stringify(cloud)); } catch (e) {}
      return;
    }
    try {
      var cached = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      if (cached && Array.isArray(cached.products)) {
        catalog = cached;
        applyToConfig(cached);
        return;
      }
    } catch (e) {}
    catalog = defaultCatalog();
    applyToConfig(catalog);
  }

  /* ---------- 保存 ---------- */

  /** 保存目录：云端 PUT（幂等 upsert）；无令牌降级 localStorage。回调 cb(ok, errMsg) */
  async function save(cat, cb) {
    if (!cat || !Array.isArray(cat.products)) { if (cb) cb(false, "目录数据无效"); return; }
    cat.updatedAt = Date.now();
    cat.inventory = cat.inventory || {};
    // 目录与库存快照对齐：新增货品补 0，移除货品删键
    var names = cat.products.map(function (p) { return p.name; });
    Object.keys(cat.inventory).forEach(function (k) { if (names.indexOf(k) === -1) delete cat.inventory[k]; });
    names.forEach(function (n) { if (cat.inventory[n] === undefined) cat.inventory[n] = 0; });
    catalog = cat;
    applyToConfig(cat);
    try { localStorage.setItem(LS_KEY, JSON.stringify(cat)); } catch (e) {}
    if (!hasToken()) { if (cb) cb(true, "本机模式：目录已保存到本机"); return; }
    try {
      var content = Util.b64enc(JSON.stringify(cat));
      var getUrl = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + CLOUD_PATH + "?ref=" + Config.GH.branch;
      var sha = null;
      try {
        var ej = await (await fetch(getUrl, { headers: { "Accept": "application/vnd.github+json",
          "Authorization": "Bearer " + Config.GH.token } })).json();
        sha = ej.sha;
      } catch (e) {}
      var body = sha
        ? { message: "update catalog", content: content, sha: sha, branch: Config.GH.branch }
        : { message: "add catalog", content: content, branch: Config.GH.branch };
      var res = await fetch("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + CLOUD_PATH, {
        method: "PUT",
        headers: { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + Config.GH.token,
          "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) { if (cb) cb(false, "云端保存失败：" + res.status); return; }
      if (cb) cb(true, "目录已保存到云端");
    } catch (e) { if (cb) cb(false, "云端保存异常：" + e.message); }
  }

  /* ---------- 管理界面 ---------- */

  /** 打开货品目录管理弹窗（增删改 + 保存） */
  function openManager() {
    var work = JSON.parse(JSON.stringify(catalog || defaultCatalog()));
    var body =
      '<div class="table-wrap" style="max-height:52vh;overflow:auto">' +
      '<table class="table cat-table" style="min-width:0;width:100%">' +
      '<thead><tr><th style="width:34%">货品名称</th><th style="width:12%">单位</th>' +
      '<th style="width:14%">预警线</th><th style="width:14%">单价</th><th style="width:18%">条码</th><th style="width:8%"></th></tr></thead>' +
      '<tbody id="catRows"></tbody></table></div>' +
      '<div class="actions" style="margin-top:10px">' +
      '<button type="button" class="btn ghost sm" id="catAdd">＋ 添加货品</button>' +
      '<span class="hint" style="align-self:center">单位如：盒/支/瓶；预警线低于即标低库存；单价暂用于对账导出。</span>' +
      '</div>' +
      '<div class="modal-actions" style="margin-top:14px">' +
      '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
      '<button type="button" class="btn sm" id="catSave">保存目录</button>' +
      '</div>';
    UI().Modal.show("📋 货品目录管理", body, { width: "760px" });
    var mBody = UI().Modal.body();
    var tbody = mBody.querySelector("#catRows");

    function draw() {
      tbody.innerHTML = work.products.map(function (p, i) {
        return '<tr>' +
          '<td><input type="text" value="' + Util.esc(p.name) + '" data-i="' + i + '" data-f="name" class="cat-in" style="width:100%;padding:8px 10px;border:1px solid var(--input-line,#C6DAD1);border-radius:10px;background:var(--input-bg,#FBFCFA)" /></td>' +
          '<td><input type="text" value="' + Util.esc(p.unit || "") + '" data-i="' + i + '" data-f="unit" class="cat-in" style="width:100%;padding:8px 10px;border:1px solid var(--input-line,#C6DAD1);border-radius:10px;background:var(--input-bg,#FBFCFA)" /></td>' +
          '<td><input type="number" value="' + (p.warnAt || 0) + '" data-i="' + i + '" data-f="warnAt" class="cat-in" style="width:100%;padding:8px 10px;border:1px solid var(--input-line,#C6DAD1);border-radius:10px;background:var(--input-bg,#FBFCFA)" /></td>' +
          '<td><input type="number" value="' + (p.price || 0) + '" data-i="' + i + '" data-f="price" class="cat-in" style="width:100%;padding:8px 10px;border:1px solid var(--input-line,#C6DAD1);border-radius:10px;background:var(--input-bg,#FBFCFA)" /></td>' +
          '<td><input type="text" value="' + Util.esc(p.barcode || "") + '" data-i="' + i + '" data-f="barcode" class="cat-in" style="width:100%;padding:8px 10px;border:1px solid var(--input-line,#C6DAD1);border-radius:10px;background:var(--input-bg,#FBFCFA)" /></td>' +
          '<td><button type="button" class="btn-clear" data-i="' + i + '" data-del="1">✕</button></td>' +
        '</tr>';
      }).join("");
    }
    draw();

    // 行内编辑：同步回 work
    tbody.addEventListener("input", function (e) {
      var inp = e.target.closest(".cat-in");
      if (!inp) return;
      var i = Number(inp.getAttribute("data-i"));
      var f = inp.getAttribute("data-f");
      var v = inp.value;
      if (f === "warnAt" || f === "price") v = Number(v) || 0;
      work.products[i][f] = v;
    });
    tbody.addEventListener("click", function (e) {
      var del = e.target.closest("[data-del]");
      if (!del) return;
      work.products.splice(Number(del.getAttribute("data-i")), 1);
      draw();
    });
    mBody.querySelector("#catAdd").addEventListener("click", function () {
      work.products.push({ name: "新货品" + (work.products.length + 1), unit: "", warnAt: Config.LOW_STOCK_THRESHOLD, price: 0, barcode: "" });
      draw();
    });
    mBody.querySelector("#catSave").addEventListener("click", async function () {
      var names = {};
      for (var i = 0; i < work.products.length; i++) {
        var n = String(work.products[i].name || "").trim();
        if (!n) { Util.toast("第 " + (i + 1) + " 行货品名称为空", true); return; }
        if (names[n]) { Util.toast("货品名称重复：" + n, true); return; }
        names[n] = 1;
        work.products[i].name = n;
      }
      var ok = await UI().confirmDialog("保存后全站货品目录/库存将立即更新（新增货品初始库存为 0）。确认保存？", "保存货品目录");
      if (!ok) return;
      save(work, function (ok2, msg) {
        UI().Modal.hide();
        Util.toast(msg, !ok2);
        // 刷新依赖目录的视图
        try { if (window.App.Views.stock && window.App.Views.stock.refresh) window.App.Views.stock.refresh(); } catch (e) {}
        try { if (window.App.Views.dashboard && window.App.Views.dashboard.refresh) window.App.Views.dashboard.refresh(); } catch (e) {}
        try { if (window.App.Views.report && window.App.Views.report.refresh) window.App.Views.report.refresh(); } catch (e) {}
      });
    });
    mBody.querySelector('[data-act="cancel"]').addEventListener("click", function () { UI().Modal.hide(); });
  }

  /* ---------- 初始化 ---------- */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { load(); });
  } else {
    load();
  }

  /* ---------- 快速新增（2026-08-14） ----------
     库存查询页的「+ 新增货品」按钮调用：填名称/单位/初始库存/预警线/单价/条码，
     调 save 写云端 catalog.json → pushCatalogEvent 推钉钉"新货品已添加"通知。
     与 openManager（增删改全功能）并存：openManager 给维护用，本函数只做"新增一条"。
     返回 Promise<{ok, msg}>。 */
  function quickAdd(data) {
    return new Promise(function (resolve) {
      if (!data || !data.name) { resolve({ ok: false, msg: "货品名称不能为空" }); return; }
      var work = JSON.parse(JSON.stringify(catalog || defaultCatalog()));
      if ((work.products || []).some(function (p) { return p.name === data.name; })) {
        resolve({ ok: false, msg: "该货品已存在，请改用其他名称" });
        return;
      }
      work.products.push({
        name: data.name,
        unit: data.unit || "",
        warnAt: Number(data.warnAt) || Config.LOW_STOCK_THRESHOLD,
        price: Number(data.price) || 0,
        barcode: data.barcode || ""
      });
      work.inventory = work.inventory || {};
      work.inventory[data.name] = Number(data.stock) || 0;
      save(work, function (ok, msg) {
        if (!ok) { resolve({ ok: false, msg: msg || "保存失败" }); return; }
        // 推送"新货品添加"事件到 data/catalog/notifications/{ts}.json
        pushCatalogEvent({
          type: "product-added",
          name: data.name,
          unit: data.unit || "",
          stock: Number(data.stock) || 0,
          warnAt: Number(data.warnAt) || Config.LOW_STOCK_THRESHOLD,
          price: Number(data.price) || 0,
          barcode: data.barcode || "",
          time: Date.now()
        }).then(function () {
          resolve({ ok: true, msg: msg || "已添加" });
        })["catch"](function () {
          // 通知失败不影响主流程（catalog 已保存成功）
          resolve({ ok: true, msg: msg || "已添加（钉钉通知未发出）" });
        });
      });
    });
  }

  /* ---------- 推送货品目录事件到 data/catalog/notifications/{ts}.json ----------
     仅在云端写一条事件文件，由 GitHub Actions dingtalk_notify.py 识别并推送钉钉。
     与 save 走相同 Contents API 流程；无 token 时直接跳过（不影响主流程）。 */
  function pushCatalogEvent(event) {
    return new Promise(function (resolve) {
      if (!hasToken()) { resolve(false); return; }
      try {
        var ts = event.time || Date.now();
        var path = "data/catalog/notifications/" + ts + ".json";
        var content = Util.b64enc(JSON.stringify(event));
        var getUrl = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path + "?ref=" + Config.GH.branch;
        var shaP = fetch(getUrl, { headers: { "Accept": "application/vnd.github+json",
          "Authorization": "Bearer " + Config.GH.token } }).then(function (r) { return r.json(); }).then(function (j) { return j.sha; })["catch"](function () { return null; });
        shaP.then(function (sha) {
          var body = { message: "catalog: " + (event.type || "event"), content: content, branch: Config.GH.branch };
          if (sha) body.sha = sha;
          return fetch("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path, {
            method: "PUT",
            headers: { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + Config.GH.token,
              "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
        }).then(function (res) { resolve(res && res.ok); })["catch"](function () { resolve(false); });
      } catch (e) { resolve(false); }
    });
  }

  window.App = window.App || {};
  window.App.Catalog = {
    load: load,
    save: save,
    openManager: openManager,
    quickAdd: quickAdd,
    pushCatalogEvent: pushCatalogEvent,
    get: function () { return catalog; },
    isLoaded: function () { return loaded; }
  };
})();
