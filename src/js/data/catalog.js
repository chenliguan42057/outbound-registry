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

  /* 云端 catalog 路径与本地缓存键均按当前系统动态化（深圳：data/catalog/catalog.json + outbound_catalog_v1；
     赛迪斯：data-saidis/catalog/catalog.json + outbound_saidis_catalog_v1）。调用处运行时求值。 */
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
    // 每个货品独立预警线（2026-08-14）：用户在目录管理里设的 warnAt，缺省回退全局阈值
    Config.WARN_AT = Config.WARN_AT || {};
    Object.keys(Config.WARN_AT).forEach(function (k) { delete Config.WARN_AT[k]; });
    cat.products.forEach(function (p) {
      var w = Number(p.warnAt);
      Config.WARN_AT[p.name] = (!isNaN(w) && w >= 0) ? w : Config.LOW_STOCK_THRESHOLD;
    });
    // 类目归组保持可用：只保留仍在目录里的货品（新增货品归「其他」）
    var cm = Config.CATEGORY_MAP || {};
    Object.keys(cm).forEach(function (catKey) {
      cm[catKey] = (cm[catKey] || []).filter(function (n) { return names.indexOf(n) !== -1; });
    });
  }

  /** 异步加载完成后，刷新依赖目录的视图（库存/仪表盘/报表），避免首次进入页面时短暂显示统一阈值。
      catalog.js 加载顺序早于 views/*，refresh 时机延后到下一个宏任务，确保 Views 已注册。 */
  function refreshDependents() {
    var fire = function () {
      try { if (window.App.Views.stock && window.App.Views.stock.refresh) window.App.Views.stock.refresh(); } catch (e) {}
      try { if (window.App.Views.dashboard && window.App.Views.dashboard.refresh) window.App.Views.dashboard.refresh(); } catch (e) {}
      try { if (window.App.Views.report && window.App.Views.report.refresh) window.App.Views.report.refresh(); } catch (e) {}
    };
    if (typeof setTimeout === "function") setTimeout(fire, 0);
    else fire();
  }

  /** 读取云端 catalog.json；404 / 失败返回 null。
      2026-09-05 修复：改走 Cloud.fetchCatalogAt（15s 超时 + 友好报错），不再裸 fetch——
      原实现无超时，移动端/微信弱网下请求一直挂着，页面表现为「卡住 / 按钮点不上」。 */
  async function fetchCloud() {
    if (!hasToken()) return null;
    try {
      var C = window.App.Cloud;
      if (!C || !C.fetchCatalogAt) return null;
      return await C.fetchCatalogAt(Config.Sys.root());
    } catch (e) { return null; }
  }

  /** 生成默认目录（从当前配置推导，保证保存时始终有完整底稿）。
      双系统：深圳细胞沿用 Config.INVENTORY 快照；赛迪斯首次（云端与本地缓存皆无）库存基准为空
      （inventory 全 0，由 save 自动补零落盘为独立 data-saidis/catalog/catalog.json），避免误继承深圳库存。 */
  function defaultCatalog() {
    var products = Config.PRODUCTS.map(function (name) {
      return { name: name, unit: "", warnAt: Config.LOW_STOCK_THRESHOLD, price: 0, barcode: "" };
    });
    var hadLocal = false;
    try { hadLocal = !!localStorage.getItem(Config.Sys.key("catalog_v1")); } catch (e) {}
    var inv = (!hadLocal && Config.Sys.isSaidis()) ? {} : Object.assign({}, Config.INVENTORY);
    return { version: 1, updatedAt: 0, products: products, inventory: inv };
  }

  /** 启动加载：云端优先 → localStorage 缓存 → 默认 */
  async function load() {
    if (loaded) return;
    loaded = true;
    var cloud = await fetchCloud();
    if (cloud && Array.isArray(cloud.products)) {
      catalog = cloud;
      applyToConfig(cloud);
      try { localStorage.setItem(Config.Sys.key("catalog_v1"), JSON.stringify(cloud)); } catch (e) {}
      refreshDependents();
      return;
    }
    try {
      var cached = JSON.parse(localStorage.getItem(Config.Sys.key("catalog_v1")) || "null");
      if (cached && Array.isArray(cached.products)) {
        catalog = cached;
        applyToConfig(cached);
        refreshDependents();
        return;
      }
    } catch (e) {}
    catalog = defaultCatalog();
    applyToConfig(catalog);
    refreshDependents();
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
    // ===== 2026-09-05 金山列联动：diff 出本次增删，给新增货品自动登记金山归属 wps =====
    var _prevNames = (catalog && Array.isArray(catalog.products)) ? catalog.products.map(function (p) { return p.name; }) : [];
    var _addedNames = names.filter(function (n) { return _prevNames.indexOf(n) === -1; });
    var _removedNames = _prevNames.filter(function (n) { return names.indexOf(n) === -1; });
    _addedNames.forEach(function (nm) {
      var w = guessWps(nm);
      if (w) {
        for (var pi = 0; pi < cat.products.length; pi++) {
          if (cat.products[pi].name === nm) { cat.products[pi].wps = w; break; }
        }
      }
    });
    catalog = cat;
    applyToConfig(cat);
    try { localStorage.setItem(Config.Sys.key("catalog_v1"), JSON.stringify(cat)); } catch (e) {}
    function _fireWpsCol() {
      try {
        if (_addedNames.length || _removedNames.length) pushWpsColEvents(_addedNames, _removedNames);
      } catch (e2) {}
    }
    if (!hasToken()) { _fireWpsCol(); if (cb) cb(true, "本机模式：目录已保存到本机"); return; }
    // ===== 2026-09-05 修复「卡住 / 云端保存失败」：云端写入改走 Cloud 成熟封装 =====
    // 原实现裸 fetch 有三个致命缺陷，正是用户在删除/新增/盘点时反复踩坑的根源：
    //   ① 无超时 → 弱网/移动端 fetch 永久挂起，回调永不触发 → 「确定点了没反应 / 一直卡住」；
    //   ② GET-sha 失败被静默吞掉（网络闪断/额度用尽时 ej.sha 为 undefined）→ 盲 PUT 不带 sha，
    //      对已存在的 catalog.json 必然返回 409/422 → 「云端保存失败」；
    //   ③ 无全局写串行链 → 连点/多端并发 PUT 互相 409。
    // Cloud.putJsonFile：15s 超时 + 幂等（先 GET sha 再 PUT）+ 3 次退避重试 +
    // 全局限流串行写链（同一时刻仅 1 个写请求在途），从源头消除上述三类故障。
    try {
      var C = window.App.Cloud;
      if (!C || !C.putJsonFile) { if (cb) cb(false, "云端同步组件未就绪，请刷新页面后重试"); return; }
      var okCloud = await C.putJsonFile({
        dataDir: Config.Sys.root(),
        subdir: "catalog",
        id: "catalog",
        payload: cat,
        message: "update catalog"
      });
      if (!okCloud) { if (cb) cb(false, cloudFailMsg()); return; }
      _fireWpsCol();
      if (cb) cb(true, "目录已保存到云端");
    } catch (e) { if (cb) cb(false, "云端保存异常：" + ((e && e.message) || e)); }
  }

  /** putJsonFile 失败后的用户可读原因：优先判断 API 额度用尽（时间明确），否则给通用网络/令牌提示 */
  function cloudFailMsg() {
    try {
      var C = window.App.Cloud;
      var r = C && C.getRate ? C.getRate() : null;
      if (r && typeof r.remaining === "number" && r.remaining <= 0) {
        var mins = r.reset ? Math.max(1, Math.ceil((r.reset - Date.now()) / 60000)) : 0;
        return "云端保存失败：API 额度已用尽" + (mins ? "，约 " + mins + " 分钟后自动恢复" : "") + "，请稍后再试";
      }
    } catch (e) {}
    return "云端保存失败：已自动重试 3 次仍未成功，请检查网络后重试；若持续失败请到「云同步」页确认令牌状态";
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
      // 2026-09-05：防连点锁（弱网保存期间再次点击会并发 PUT → 409 → “云端保存失败”）
      var sBtn = mBody.querySelector("#catSave");
      if (sBtn.dataset.busy === "1") return;
      sBtn.dataset.busy = "1";
      sBtn.disabled = true;
      try {
        var names = {};
        for (var i = 0; i < work.products.length; i++) {
          var n = String(work.products[i].name || "").trim();
          if (!n) { Util.toast("第 " + (i + 1) + " 行货品名称为空", true); return; }
          if (names[n]) { Util.toast("货品名称重复：" + n, true); return; }
          names[n] = 1;
          work.products[i].name = n;
        }
        var oldNames = ((catalog && catalog.products) || []).map(function (p) { return p.name; });
        var newNames = work.products.map(function (p) { return p.name; });
        var ok = await UI().confirmDialog("保存后全站货品目录/库存将立即更新（新增货品初始库存为 0）。确认保存？", "保存货品目录");
        if (!ok) return;
        save(work, function (ok2, msg) {
          UI().Modal.hide();
          Util.toast(msg, !ok2);
          if (ok2) {
            // 目录增删事件（推送钉钉；新增行发 product-added，删除行发 product-deleted）
            var added = newNames.filter(function (n) { return oldNames.indexOf(n) === -1; });
            var removed = oldNames.filter(function (n) { return newNames.indexOf(n) === -1; });
            var evs = added.map(function (n) { return { type: "product-added", name: n, unit: "", stock: 0, warnAt: Config.LOW_STOCK_THRESHOLD, price: 0, barcode: "" }; })
              .concat(removed.map(function (n) { return { type: "product-deleted", name: n }; }));
            evs.forEach(function (ev, i) { ev.time = Date.now() + i; pushCatalogEvent(ev); });
          }

          // 刷新依赖目录的视图
          try { if (window.App.Views.stock && window.App.Views.stock.refresh) window.App.Views.stock.refresh(); } catch (e) {}
          try { if (window.App.Views.dashboard && window.App.Views.dashboard.refresh) window.App.Views.dashboard.refresh(); } catch (e) {}
          try { if (window.App.Views.report && window.App.Views.report.refresh) window.App.Views.report.refresh(); } catch (e) {}
        });
      } finally {
        sBtn.dataset.busy = "0";
        sBtn.disabled = false;
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

  /* ---------- 快速新增（2026-08-14） ----------
     库存查询页的「+ 新增货品」按钮调用：填名称/单位/初始库存/预警线/单价/条码，
     调 save 写云端 catalog.json → pushCatalogEvent 推钉钉"新货品已添加"通知。
     与 openManager（增删改全功能）并存：openManager 给维护用，本函数只做"新增一条"。
     返回 Promise<{ok, msg}>。 */
  /** 新货品未配置金山台账映射时的提示（防呆：避免"系统有、金山没有"的静默分叉） */
  function wpsMapHint(name) {
    try {
      // 目录中已登记金山归属（wps 字段，含快速新增/管理页保存时自动补录）→ 视为已同步
      var cur = catalog && Array.isArray(catalog.products) ? catalog.products : null;
      if (cur) {
        for (var i = 0; i < cur.length; i++) {
          if (cur[i].name === name && cur[i].wps && typeof cur[i].wps.sheet === "string") return "";
        }
      }
      var wm = window.APP_PRODUCT_MAP && window.APP_PRODUCT_MAP.wpsMap;
      if (wm && typeof wm[name] !== "undefined") return "";
    } catch (e) {}
    return "；⚠️ 该货品未配置金山台账映射，出入库不会同步到金山（如需同步请管理员在 product-map.js 登记）";
  }

  function quickAdd(data) {
    return new Promise(function (resolve) {
      if (!data || !data.name) { resolve({ ok: false, msg: "货品名称不能为空" }); return; }      var work = JSON.parse(JSON.stringify(catalog || defaultCatalog()));
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
          resolve({ ok: true, msg: (msg || "已添加") + wpsMapHint(data.name) });
        })["catch"](function () {
          // 通知失败不影响主流程（catalog 已保存成功）
          resolve({ ok: true, msg: (msg || "已添加（钉钉通知未发出）") + wpsMapHint(data.name) });
        });
      });
    });
  }

  /* ---------- 推送货品目录事件到 data/catalog/notifications/{ts}.json ----------
     仅在云端写一条事件文件，由 GitHub Actions dingtalk_notify.py 识别并推送钉钉。
     与 save 走相同 Contents API 流程；无 token 时直接跳过（不影响主流程）。
     2026-09-05：改走 Cloud.putJsonFile（超时 + 串行写链 + 重试），原裸 fetch 连点会并发冲突。 */
  function pushCatalogEvent(event, subdir) {
    return new Promise(function (resolve) {
      if (!hasToken()) { resolve(false); return; }
      try {
        var ts = event.time || Date.now();
        var C = window.App.Cloud;
        if (!C || !C.putJsonFile) { resolve(false); return; }
        C.putJsonFile({
          dataDir: Config.Sys.root(),
          subdir: subdir || "catalog/notifications",
          id: String(ts),
          payload: event,
          message: "catalog: " + (event.type || "event")
        }).then(function (ok) { resolve(!!ok); })["catch"](function () { resolve(false); });
      } catch (e) { resolve(false); }
    });
  }

  /* ================= 2026-09-05 金山列联动（产品增删 → 金山台账加/删列） =================
     产品在金山台账的归属：
       ① 优先 product-map.js 的 wpsMap（老货品列名保持旧规则，如 20支盒/洁面150ml）；
       ② 未命中则按系列词自动归属：洁面/精粹 → 2026鹿茸水乳系列；精华液/面膜/礼盒 → 2026时空鹿茸库存；
          列名 = 名称去空格（如 精华液 40支装 → 精华液40支装）。表头统一「发放<列名>/库存<列名>」。
       ③ 袋类等（牛皮纸袋/手提袋/帆布袋/透明袋…）→ null，不进金山台账。
     save() 保存目录时自动把新增货品的归属写入 catalog 的 wps 字段（前后端共用该字段）。
     增删 diff 会向 data(-saidis)/catalog/wps-events/{ts}.json 写事件，
     GitHub Actions wps_sync 把事件转发给金山 AirScript 真正执行加列/删列（幂等）。 */
  function guessWps(name) {
    try {
      var wm = window.APP_PRODUCT_MAP && window.APP_PRODUCT_MAP.wpsMap;
      var nmap = window.APP_PRODUCT_MAP && window.APP_PRODUCT_MAP.nameMap;
      var nm = (nmap && nmap[name]) || name;
      if (wm) {
        var hit = wm[nm] !== undefined ? wm[nm] : wm[name];
        if (hit !== undefined && hit !== null && hit.length >= 2) return { sheet: hit[0], col: hit[1] };
        if (hit === null) return null; // 明确不进台账（如手提袋）
      }
      var plain = nm.replace(/\s+/g, "");
      if (!plain) return null;
      if (/洁面|精粹/.test(nm)) return { sheet: "2026鹿茸水乳系列", col: plain };
      if (/精华液|面膜|礼盒/.test(nm)) return { sheet: "2026时空鹿茸库存", col: plain };
      if (/袋/.test(nm)) return null; // 牛皮纸袋/手提袋/帆布袋/透明袋等包装物不进台账
    } catch (e) {}
    return null;
  }

  /** 曾删除过金山列的产品名（localStorage 按系统记忆）：重加同名货品时需重新加列 */
  function _delMem() {
    try {
      var v = JSON.parse(localStorage.getItem(Config.Sys.key("wps_del_mem")) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function _rememberDel(name) {
    try {
      var m = _delMem();
      if (m.indexOf(name) === -1) { m.push(name); localStorage.setItem(Config.Sys.key("wps_del_mem"), JSON.stringify(m)); }
    } catch (e) {}
  }
  function _clearDelMem(name) {
    try {
      var m = _delMem().filter(function (x) { return x !== name; });
      localStorage.setItem(Config.Sys.key("wps_del_mem"), JSON.stringify(m));
    } catch (e) {}
  }
  function _wmHasCol(name) {
    try {
      var wm = window.APP_PRODUCT_MAP && window.APP_PRODUCT_MAP.wpsMap;
      var nmap = window.APP_PRODUCT_MAP && window.APP_PRODUCT_MAP.nameMap;
      var nm = (nmap && nmap[name]) || name;
      var hit = wm ? (wm[nm] !== undefined ? wm[nm] : wm[name]) : undefined;
      return !!(hit && hit.length >= 2);
    } catch (e) { return false; }
  }

  /** 把「需要加/删金山列」的产品写成 wps-events 事件文件（Actions 侧消费）。
      去噪：目录首次全量保存时老货品（wpsMap 已映射）不发加列（列本来就在）；
      重加曾删货品（本地记忆命中）必须发加列。 */
  function pushWpsColEvents(added, removed) {
    // 改名配对：同子表同列的新旧名（如"舒缓精粹水 120ml"→"精粹水 120ml"）只是换个名字，
    // 金山列原样保留 → 不删旧列、不加新列（避免误伤台账历史数据）。
    var adds = (added || []).slice();
    var dels = (removed || []).slice();
    for (var di = dels.length - 1; di >= 0; di--) {
      var dw = guessWps(dels[di]);
      if (!dw) { dels.splice(di, 1); continue; }
      for (var ai = adds.length - 1; ai >= 0; ai--) {
        var aw = guessWps(adds[ai]);
        if (aw && aw.sheet === dw.sheet && aw.col === dw.col) { dels.splice(di, 1); adds.splice(ai, 1); break; }
      }
    }
    var evs = [];
    adds.forEach(function (nm) {
      var w = guessWps(nm);
      if (!w) return;
      var needAdd = !_wmHasCol(nm) || _delMem().indexOf(nm) !== -1;
      if (needAdd) evs.push({ type: "wps-col-add", name: nm, sheet: w.sheet, col: w.col });
    });
    dels.forEach(function (nm) {
      var w = guessWps(nm);
      if (!w) return;
      evs.push({ type: "wps-col-del", name: nm, sheet: w.sheet, col: w.col });
      _rememberDel(nm);
    });
    evs.forEach(function (ev, _ei) {
      ev.time = Date.now() + _ei;   // 同批事件错开毫秒，避免事件文件互相覆盖
      pushCatalogEvent(ev, "catalog/wps-events").then(function (ok2) {
        if (ok2 && ev.type === "wps-col-add") _clearDelMem(ev.name);
      })["catch"](function () {});
    });
  }

  /** 库存页行内删除货品（深圳/赛迪斯共用）：移除目录条目 + 清库存键，
      增删事件由 save() 内部统一派发（钉钉 product-deleted + 金山 wps-col-del） */
  function removeProduct(name, cb) {
    if (!name) { if (cb) cb(false, "货品名称不能为空"); return; }
    var work = JSON.parse(JSON.stringify(catalog || defaultCatalog()));
    var idx = -1;
    for (var i = 0; i < work.products.length; i++) {
      if (work.products[i].name === name) { idx = i; break; }
    }
    if (idx === -1) { if (cb) cb(false, "货品不存在：" + name); return; }
    work.products.splice(idx, 1);
    // 保存后目录/库存全站生效；diff 事件（钉钉 + 金山删列）在 save() 内部触发
    save(work, function (ok, msg) {
      if (cb) cb(ok, ok ? ("已删除货品「" + name + "」" + (msg ? "" : "")) : msg);
    });
  }

  window.App = window.App || {};
  window.App.Catalog = {
    load: load,
    /** 切换系统后重置并重新加载当前系统的 catalog（云端优先 → 缓存 → 默认空库存） */
    reload: async function () {
      loaded = false;
      catalog = null;
      await load();
    },
    save: save,
    openManager: openManager,
    quickAdd: quickAdd,
    removeProduct: removeProduct,
    guessWps: guessWps,
    pushWpsColEvents: pushWpsColEvents,
    pushCatalogEvent: pushCatalogEvent,
    get: function () { return catalog; },
    isLoaded: function () { return loaded; }
  };
})();
