/**
 * transfer.js — 两仓调拨（2026-09-05）
 *
 * 调拨 = 把货品从「当前系统仓库」调到「另一系统仓库」，一次生成两条真实记录：
 *   · 调出侧：出库记录（type:"out"）→ 本系统本地立即生效（扣库存），
 *             自动触发本系统钉钉「新出库登记」通知 + 金山台账加行；
 *   · 调入侧：入库记录（type:"in"）→ 直接写入对方数据目录 records/，
 *             对方切换/云同步后可见，自动触发对方钉钉「新入库登记」通知 + 对方金山台账加行。
 * 两条记录共享同一 transferId，备注写明方向（如 两仓调拨：赛迪斯 → 深圳细胞），双向可追溯。
 *
 * 方向约定：调出方 = 当前系统（顶栏切换器所在仓库）。需要反向调拨时，
 * 先点顶栏切到对方仓库再进来操作 —— 保证「调出库存够不够」的校验用的是调出仓实时数据，
 * 也避免「当前设备上没有对方库存账」导致的误调。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Config = window.App.Config;
  var Stock = window.App.Stock;
  var Records = window.App.Records;
  var Cloud = window.App.Cloud;

  var container = null;
  var picker = null;

  /** 当前系统指向的另一系统定义（SYSTEM_DEFS 项） */
  function other() {
    return Config.Sys.current().id === "saidis" ? Config.SYSTEM_DEFS.shenzhen : Config.SYSTEM_DEFS.saidis;
  }

  function render(el) {
    container = el;
    var curName = Config.Sys.name();
    var dstName = other().name;
    el.innerHTML =
      '<div class="card">' +
        '<h2>调拨 <span class="tag">双仓互调</span></h2>' +
        '<div class="hint" style="margin:-4px 0 14px;line-height:1.9">' +
          '把货品从 <b>' + Util.esc(curName) + '</b> 调到 <b>' + Util.esc(dstName) + '</b>：' +
          Util.esc(curName) + ' 记一笔<b>出库</b>、' + Util.esc(dstName) + ' 记一笔<b>入库</b>，' +
          '两端各推钉钉通知、各进金山台账，备注自动标注方向。' +
          '<br>如需<b>反向</b>调拨（' + Util.esc(dstName) + ' → ' + Util.esc(curName) + '），' +
          '请先点左侧栏顶部的系统切换器切到 <b>' + Util.esc(dstName) + '</b> 再操作。' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;border:1px solid var(--line-soft,#DCE6E0);border-radius:12px;background:var(--card-soft,#F7FAF7);margin-bottom:14px">' +
          '<span style="font-weight:700">' + Util.esc(curName) + '</span>' +
          '<span style="color:#B03A2E">出库 −</span>' +
          '<span style="color:#8a6d3b;font-weight:700">⇄ 调拨 ⇄</span>' +
          '<span style="color:#1E8449">入库 +</span>' +
          '<span style="font-weight:700">' + Util.esc(dstName) + '</span>' +
        '</div>' +
        '<div class="field" style="margin-bottom:6px"><label>调拨货品<span class="req">*</span></label>' +
          '<div id="tfPicker"></div></div>' +
        '<div class="field"><label for="tfNote">备注（选填）</label>' +
          '<input type="text" id="tfNote" maxlength="80" placeholder="例：主仓缺货应急调配、客户加急调货等" autocomplete="off" /></div>' +
        '<div class="actions" style="margin-top:8px">' +
          '<button type="button" class="btn sm" id="tfSubmit">⇄ 确认调拨</button>' +
          '<button type="button" class="btn ghost sm" id="tfReset">清空重选</button>' +
        '</div>' +
        '<div id="tfResult" style="margin-top:12px"></div>' +
      '</div>';

    picker = new UI.ProductPicker({ placeholder: "搜索并选择要调拨的货品（可多选，逐项填数量）" });
    picker.attach(Util.$("tfPicker"));

    Util.$("tfReset").addEventListener("click", function () {
      picker.setSelected([]);
      var note = Util.$("tfNote");
      if (note) note.value = "";
      var box = Util.$("tfResult");
      if (box) box.innerHTML = "";
    });
    Util.$("tfSubmit").addEventListener("click", doTransfer);
  }

  function lockBtn(btn) {
    if (!btn) return { locked: false, unlock: function () {} };
    if (btn.dataset.busy === "1") return { locked: true, unlock: function () {} };
    btn.dataset.busy = "1";
    btn.disabled = true;
    btn.classList.add("loading");
    btn.setAttribute("aria-busy", "true");
    return {
      locked: false,
      unlock: function () {
        if (!btn.isConnected) return;
        btn.dataset.busy = "0";
        btn.disabled = false;
        btn.classList.remove("loading");
        btn.setAttribute("aria-busy", "false");
      }
    };
  }

  function doTransfer() {
    var btn = Util.$("tfSubmit");
    var lock = lockBtn(btn);
    if (lock.locked) return;
    var items = picker.getItems();
    if (!items.length) { Util.toast("请先选择要调拨的货品并填写数量", true); lock.unlock(); return; }
    // 调出方=当前系统：直接用它实时的库存校验，绝不允许调出超过现有库存
    var shortage = [];
    items.forEach(function (it) {
      var avail = (Stock.getStock && Stock.getStock(it.name)) || 0;
      if (it.qty > avail) shortage.push("「" + it.name + "」需调出 " + it.qty + "，当前库存仅 " + avail);
    });
    if (shortage.length) { Util.toast("库存不足：" + shortage.join("；"), true); lock.unlock(); return; }

    var srcName = Config.Sys.name();
    var dst = other();
    var dstName = dst.name;
    var userNote = (Util.$("tfNote").value || "").trim();
    var note = "两仓调拨：" + srcName + " → " + dstName + (userNote ? "；" + userNote : "");

    var body =
      '<div class="hint" style="margin-bottom:10px">核对本次调拨（提交后两端各推钉钉通知、各进金山台账）：</div>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>货品</th><th>数量</th></tr></thead><tbody>' +
      items.map(function (it) {
        return '<tr><td>' + Util.esc(it.name) + '</td><td>' + it.qty + '</td></tr>';
      }).join("") +
      '</tbody></table></div>' +
      '<div style="margin-top:12px;line-height:2">' +
        '<div><b>' + Util.esc(srcName) + '</b>：出库 −' + items.reduce(function (s, it) { return s + it.qty; }, 0) + '（扣库存，推钉钉「出库」通知，进金山台账）</div>' +
        '<div><b>' + Util.esc(dstName) + '</b>：入库 +（增库存，推对方钉钉「入库」通知，进对方金山台账）</div>' +
        '<div class="hint" style="margin:6px 0 0">备注：' + Util.esc(note) + '</div>' +
      '</div>';

    UI.confirmDialog(body, "⇄ 确认调拨").then(function (ok) {
      if (!ok) { lock.unlock(); return; }
      runTransfer(items, srcName, dst, dstName, note, lock);
    })["catch"](function () { lock.unlock(); });
  }

  /** 若对方仓 catalog 缺本批货品，先在对方目录里加产品 + 初始化库存基准 0 + 写 wps-col-add 事件
      （让对方金山台账自动多出对应列）。目录更新与事件按顺序串行写入，每个 PUT 是独立 commit，
      wps_sync 串行并发组会先处理加列事件再处理后续 inRec，保证 inRec 写入时列已就绪。
      返回 missing 数组；返回 false 表示有失败已中止。 */
  async function ensureTargetProducts(items, dst, dstName) {
    var cat = await Cloud.fetchCatalogAt(dst.dataDir);
    if (!cat || typeof cat !== "object") {
      cat = { version: 1, updatedAt: Date.now(), products: [], inventory: {} };
    }
    if (!Array.isArray(cat.products)) cat.products = [];
    if (!cat.inventory || typeof cat.inventory !== "object") cat.inventory = {};
    var existing = {};
    cat.products.forEach(function (p) { if (p && p.name) existing[p.name] = true; });
    var missing = items.filter(function (it) { return it.name && !existing[it.name]; });
    if (!missing.length) return [];
    /* 从源头目录拷贝缺货的产品描述（含 unit/warnAt/price/barcode/wps），wps 字段用 guessWps 兜底 */
    var srcCat = (window.App.Catalog && window.App.Catalog.get) ? window.App.Catalog.get() : null;
    var srcMap = {};
    if (srcCat && Array.isArray(srcCat.products)) srcCat.products.forEach(function (p) { if (p && p.name) srcMap[p.name] = p; });
    missing.forEach(function (it) {
      var proto = srcMap[it.name] || { name: it.name, unit: "", warnAt: Config.LOW_STOCK_THRESHOLD || 95, price: 0, barcode: "" };
      var wps = proto.wps;
      try {
        if ((!wps || !wps.sheet) && window.App.Catalog && window.App.Catalog.guessWps) {
          wps = window.App.Catalog.guessWps(it.name);
        }
      } catch (e) {}
      var prod = Object.assign({}, proto, { name: it.name });
      if (wps) prod.wps = wps;
      cat.products.push(prod);
      cat.inventory[it.name] = 0;
    });
    cat.updatedAt = Date.now();
    /* ① 写对方 catalog.json（一个 commit） */
    var catOk = await Cloud.putJsonFile({
      dataDir: dst.dataDir,
      subdir: "catalog",
      id: "catalog",
      payload: cat,
      message: "transfer: add " + missing.length + " product(s) to " + dstName
    });
    if (!catOk) {
      Util.toast("❌ " + dstName + " 目录写入失败，本次未调拨，请重试", true);
      return false;
    }
    /* ② 为每个新货品推一条 wps-col-add 事件（每个事件一个 commit） */
    var failedEvents = [];
    for (var k = 0; k < missing.length; k++) {
      var m = missing[k];
      var w = (m && window.App.Catalog && window.App.Catalog.guessWps) ? window.App.Catalog.guessWps(m.name) : null;
      if (!w || !w.sheet) continue;  // 没金山台账归属（如袋类）不建列，避免无意义事件
      var ts = Date.now() + k;
      var ev = {
        type: "wps-col-add",
        name: m.name,
        sheet: w.sheet,
        col: w.col,
        time: ts
      };
      var ok = await Cloud.putJsonFile({
        dataDir: dst.dataDir,
        subdir: "catalog/wps-events",
        id: String(ts),
        payload: ev,
        message: "transfer: wps-col-add " + m.name
      });
      if (!ok) failedEvents.push(m.name);
    }
    if (failedEvents.length) {
      Util.toast("⚠️ " + dstName + " 部分新货品金山列未生成（" + failedEvents.join("、") + "），请稍候在「云同步」页补传", true);
    }
    return missing.map(function (it) { return it.name; });
  }

  /** 执行：①若对方仓缺本批货品，先在对方目录补产品 + 写 wps-col-add 事件；
      ②写对方仓入库记录（云端直写，幂等），成功后再建本仓出库记录（本地立即可见 + 云端推送）。
      顺序保证「对方目录/列没准备好，本仓绝不出库」，避免单向扣账 / 列错位。 */
  async function runTransfer(items, srcName, dst, dstName, note, lock) {
    var btn = Util.$("tfSubmit");
    try {
      if (!Cloud.hasToken()) {
        Util.toast("⚠️ 未配置云端令牌，跨仓调拨需要云端同步才能完成，请先联系管理员", true);
        return;
      }
      var now = Util.nowLocal();
      var transferId = Util.genId();
      // ① 对方仓是否缺本批货品？缺则补目录 + 写 wps-col-add 事件（每个独立 commit，wps_sync 串行处理）
      var statusBox = Util.$("tfResult");
      var missingOk = await ensureTargetProducts(items, dst, dstName);
      if (missingOk === false) return;            // ensureTargetProducts 内部已 toast
      if (missingOk.length && statusBox) {
        statusBox.innerHTML = '<div class="hint" style="padding:8px 12px;border:1px dashed #C8E6C9;border-radius:10px;background:#F0FAF0;color:#1E6B2E">' +
          '⏳ 正在为「' + Util.esc(dstName) + '」添加 ' + missingOk.length + ' 项新货品并建金山列…' +
          '</div>';
      }
      // ② 对方仓入库记录 → 云端直写对方 records/
      var inRec = {
        id: Util.genId(),
        _ts: Date.now(),
        time: now,
        type: "in",
        items: items.map(function (it) { return { name: it.name, qty: it.qty }; }),
        purpose: "调拨入库来自" + srcName,
        picker: srcName + "（调拨）",
        dept: srcName,
        note: note,
        affectsStock: true,
        transferId: transferId,
        transferRole: "in"
      };
      var dstOk = await Cloud.pushRecordTo(inRec, dst.dataDir);
      if (!dstOk) {
        Util.toast("❌ " + dstName + " 入库记录上传失败（网络/令牌），本次未调拨，请重试", true);
        return;
      }
      // ② 本仓（调出方）出库记录：本地入列（扣库存、立即可见）+ 云端推送（失败自动入队列稍后补推）
      var outRec = Records.create({
        time: now,
        type: "out",
        items: items.map(function (it) { return { name: it.name, qty: it.qty }; }),
        purpose: "调拨出库至" + dstName,
        picker: dstName + "（调拨）",
        dept: dstName,
        entity: Config.Sys.entity(),
        note: note,
        affectsStock: true,
        transferId: transferId,
        transferRole: "out"
      });
      var pushed = await Cloud.pushRecord(outRec).catch(function () { return false; });
      // 本仓「已上云」状态栏提示（与出库/入库页一致）
      try {
        var app = window.App.Views && window.App.Views.app;
        if (app && app.setSyncStatus) {
          if (pushed) app.setSyncStatus("已同步 " + new Date().toLocaleString(), false);
          else app.setSyncStatus("已存本地，云端稍后自动补推", true);
        }
      } catch (e) {}

      var box = Util.$("tfResult");
      if (box) {
        var addedMsg = (missingOk && missingOk.length)
          ? '<br>· <span style="color:#1E6B2E">' + Util.esc(dstName) + ' 首次新增产品：</span>' + missingOk.map(function (n) { return Util.esc(n); }).join('、') + '（目录与金山列已自动创建并生效）'
          : '';
        box.innerHTML =
          '<div style="padding:12px 16px;border:1px solid #C8E6C9;border-radius:12px;background:#F0FAF0;color:#1E6B2E;font-size:13.5px;line-height:1.9">' +
          '<b>✅ 调拨成功</b>（单号 ' + Util.esc(transferId) + '）<br>' +
          '· ' + Util.esc(srcName) + '：出库 ' + items.reduce(function (s, it) { return s + it.qty; }, 0) + '（本页已生效，钉钉/金山稍后自动推送）<br>' +
          '· ' + Util.esc(dstName) + '：入库 +（对方仓库切过去即可看到；对方钉钉群会收到「入库」通知）' +
          addedMsg +
          '<br><span class="hint">备注：' + Util.esc(note) + '</span>' +
          '</div>';
      }
      Util.toast("✅ 调拨成功：" + srcName + " 出库 → " + dstName + " 入库");
      picker.setSelected([]);
      var noteEl = Util.$("tfNote");
      if (noteEl) noteEl.value = "";
      try { if (window.App.Stock) window.App.Stock.markDirty(); } catch (e) {}
      try { if (window.App.Views.dashboard && window.App.Views.dashboard.refresh) window.App.Views.dashboard.refresh(); } catch (e) {}
      try { if (window.App.Views.records && window.App.Views.records.refresh) window.App.Views.records.refresh(); } catch (e) {}
      try { if (window.App.Views.report && window.App.Views.report.refresh) window.App.Views.report.refresh(); } catch (e) {}
    } catch (e) {
      Util.toast("调拨失败：" + (e && e.message ? e.message : e), true);
    } finally {
      lock.unlock();
    }
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.transfer = { render: render };
})();
