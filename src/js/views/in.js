/**
 * in.js — 入库登记模块
 * 货品多选+数量、入库来源（预设 chips + 自定义即存）、用途/说明、照片、确定入库/清空/编辑；
 * 确认前显示库存变化预览（当前库存 → 入库后）
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Store = window.App.Store;
  var State = window.App.State;
  var Records = window.App.Records;
  var Cloud = window.App.Cloud;

  var picker = null;
  var photos = null;
  var editingId = null;
  var els = null;
  var submitting = false;   // 提交互斥锁：防止连点造成重复入库
  var sourceVal = "";       // 当前选中的入库来源
  var editingTransfer = false; // 编辑的是调拨/回滚生成的入库单 → 来源由系统固定，禁止改

  function render(container) {
    container.innerHTML =
      '<div class="card">' +
        '<h2>入库登记 <span class="tag">库存补充</span></h2>' +
        '<div class="field">' +
          '<label>货品名称<span class="req">*</span></label>' +
          '<div id="inProductPicker"></div>' +
        '</div>' +
        '<div class="field">' +
          '<label>入库来源<span class="req">*</span></label>' +
          '<div class="src-pick">' +
            '<div class="src-chips" id="inSourceChips"></div>' +
            '<div class="src-custom-row">' +
              '<input type="text" id="inSourceCustom" class="search" style="min-width:0;flex:1;" placeholder="填新来源（如：样品、赠品、内部领用…）" maxlength="20" autocomplete="off" inputmode="text" enterkeyhint="done" />' +
              '<button type="button" class="btn ghost sm" id="inSourceAdd" style="white-space:nowrap;">＋ 自定义</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="field">' +
          '<label for="inPurpose">用途 / 补充说明</label>' +
          '<input type="text" id="inPurpose" placeholder="例如：采购订单号、活动名称、备注等（选填）" maxlength="60" autocomplete="off" inputmode="text" enterkeyhint="done" />' +
        '</div>' +
        '<div class="field">' +
          '<label for="inHandler">经办人<span class="req">*</span></label>' +
          '<input type="text" id="inHandler" placeholder="谁经手的入库（默认带出上次）" maxlength="20" autocomplete="off" inputmode="text" enterkeyhint="next" />' +
        '</div>' +
        '<div class="field">' +
          '<label>现场照片（留存）</label>' +
          '<div id="inPhotoUpload"></div>' +
        '</div>' +
        '<div class="inventory-preview" id="inPreview"></div>' +
        '<div class="actions">' +
          '<button type="button" class="btn" id="inSubmit">确定入库</button>' +
          '<button type="button" class="btn ghost" id="inReset">清空</button>' +
          '<button type="button" class="btn ghost" id="inCancelEdit" style="display:none;">取消编辑</button>' +
        '</div>' +
      '</div>';

    els = {
      purpose: Util.$("inPurpose"),
      handler: Util.$("inHandler"),
      submit: Util.$("inSubmit"),
      reset: Util.$("inReset"),
      cancelEdit: Util.$("inCancelEdit"),
      preview: Util.$("inPreview"),
      srcBox: Util.$("inSourceChips"),
      srcCustom: Util.$("inSourceCustom")
    };

    // 经办人默认带出上次值
    try { var _lh = localStorage.getItem("outbound_in_last_handler"); if (_lh) Util.$("inHandler").value = _lh; } catch (e) {}

    picker = new UI.ProductPicker({
      showInStock: true,
      showStock: false,
      placeholder: "搜索并选择货品（可多选，每个单独填数量）"
    });
    picker.attach(Util.$("inProductPicker"));
    photos = new UI.PhotoUpload({});
    photos.attach(Util.$("inPhotoUpload"));

    Util.$("inReset").addEventListener("click", resetForm);
    Util.$("inCancelEdit").addEventListener("click", function () { resetForm(); Util.toast("已取消编辑"); });
    Util.$("inSubmit").addEventListener("click", submit);

    Util.$("inPurpose").addEventListener("input", saveDraft);
    picker.onChange = function () { saveDraft(); renderPreview(); };
    photos.onChange = saveDraft;
    // 来源自定义：点按钮或回车即保存入库（自动持久化到本仓自定义来源库）
    Util.$("inSourceAdd").addEventListener("click", addCustomSource);
    Util.$("inSourceCustom").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); addCustomSource(); }
    });
    renderSourceChips();
    renderPreview();
    restoreDraft();
  }

  /** 当前可用来源全集（预设 + 本仓自定义），无词典时降级空数组 */
  function srcApi() {
    return (Records && Records.InSource) || { options: function () { return []; }, loadCustom: function () { return []; } };
  }

  /** 来源 chips 渲染：预设 + 自定义（自定义带 × 可删）；编辑调拨/回滚单时锁定为系统来源 */
  function renderSourceChips() {
    var box = els && els.srcBox;
    if (!box) return;
    var INS = srcApi();
    if (editingTransfer) {
      box.innerHTML = '<span class="src-chip on static" title="该记录由调拨/系统自动生成，来源固定不可改">' +
        Util.esc(sourceVal || "调拨（系统）") + '</span>' +
        '<span class="hint" style="margin-left:8px;">（系统来源，登记时自动打标）</span>';
      return;
    }
    var custom = (INS.loadCustom && INS.loadCustom()) || [];
    var opts = INS.options();
    // 当前值不在可选列表（编辑旧单，值为自定义但被删/或旧数据）时补一颗，避免"选了却没高亮"
    if (sourceVal && opts.indexOf(sourceVal) === -1) opts = opts.concat([sourceVal]);
    box.innerHTML = opts.map(function (s) {
      var isCustom = custom.indexOf(s) !== -1;
      var html = '<button type="button" class="src-chip' + (s === sourceVal ? " on" : "") + '" data-src="' + Util.esc(s) + '" title="点击选择；再次点击取消">' + Util.esc(s);
      if (isCustom) html += '<span class="src-x" data-x="' + Util.esc(s) + '" title="删除自定义来源「' + Util.esc(s) + '」">×</span>';
      html += '</button>';
      return html;
    }).join("") || '<span class="hint">请选择来源</span>';
    // 委托处理 chip 点击与 × 删除；onclick 单实例赋值，重建不叠加监听
    box.onclick = function (ev) {
      var t = ev.target;
      if (t && t.classList && t.classList.contains("src-x")) {
        ev.stopPropagation();
        removeCustomSource(t.getAttribute("data-x"));
        return;
      }
      var btn = t && t.closest ? t.closest(".src-chip") : null;
      if (!btn) return;
      var s = btn.getAttribute("data-src");
      if (!s) return;
      sourceVal = (sourceVal === s) ? "" : s;   // 单选，再点同一颗取消
      renderSourceChips();
      saveDraft();
    };
  }

  /** 自定义来源：立即存入本仓自定义库并选中（"自定义之后自动保存到系统"） */
  function addCustomSource() {
    var input = els && els.srcCustom;
    if (!input) return;
    var v = input.value.trim();
    if (!v) { Util.toast("请先输入自定义来源名称", true); return; }
    if (srcApi().options().indexOf(v) !== -1) {
      sourceVal = v;   // 已存在则直接选中
    } else {
      var saved = srcApi().addCustom(v);
      sourceVal = saved || sourceVal;
      Util.toast("已添加自定义来源「" + saved + "」，本仓永久可用");
    }
    input.value = "";
    renderSourceChips();
    saveDraft();
  }

  /** 删除自定义来源（仅自定义库，预设不受影响） */
  function removeCustomSource(name) {
    if (!name) return;
    if (srcApi().loadCustom().indexOf(name) === -1) return;
    if (sourceVal === name) sourceVal = "";
    srcApi().removeCustom(name);
    renderSourceChips();
    saveDraft();
    Util.toast("已删除自定义来源「" + name + "」");
  }

  /** 库存变化预览：当前库存 → 入库后 */
  function renderPreview() {
    var items = picker.getItems();
    if (!items.length) { els.preview.innerHTML = ""; els.preview.style.display = "none"; return; }
    var rows = items.map(function (it) {
      var cur = window.App.Stock.getStock(it.name);
      var after = cur + it.qty;
      return '<div class="preview-row">' +
        '<span>' + Util.esc(it.name) + '</span>' +
        '<span class="preview-cur">当前 ' + cur + '</span>' +
        '<span class="preview-arrow">→</span>' +
        '<span class="preview-after">入库后 ' + after + '</span>' +
      '</div>';
    }).join("");
    els.preview.innerHTML = '<div class="preview-title">库存变化预览</div>' + rows;
    els.preview.style.display = "";
  }

  function saveDraft() {
    if (editingId) return;
    Store.saveDraft("in", {
      purpose: els.purpose.value,
      source: sourceVal,
      items: picker.selected,
      photos: photos.getPhotos()
    });
  }

  function restoreDraft() {
    var d = Store.loadDraft("in");
    if (!d) return;
    els.purpose.value = d.purpose || "";
    sourceVal = d.source || "";
    picker.setSelected(d.items || []);
    photos.setPhotos(d.photos || []);
    renderPreview();
    renderSourceChips();
  }

  function clearDraft() { Store.clearDraft("in"); }

  /** 切换提交按钮的加载态。不改 textContent——resetForm()/edit() 会重写它 */
  function setSubmitting(on) {
    submitting = !!on;
    if (!els || !els.submit) return;
    els.submit.disabled = !!on;
    els.submit.classList.toggle("loading", !!on);
    els.submit.setAttribute("aria-busy", on ? "true" : "false");
  }

  function submit() {
    if (submitting) return;   // 连点二次直接吞掉

    var items = picker.getItems();
    var qtyProblems = picker.validateItems ? picker.validateItems() : [];
    var handlerVal = (els.handler ? els.handler.value : "").trim();
    var errs = [];
    if (!handlerVal) {
      errs.push({ el: Util.$("inHandler"), msg: "请填写经办人" });
    }
    if (!editingTransfer && !sourceVal) {
      errs.push({ el: els.srcBox, msg: "请选择入库来源" });
    }
    if (!items.length) {
      errs.push({
        el: Util.$("inProductPicker"),
        msg: qtyProblems.length ? ("请填写数量：" + qtyProblems.join("、")) : "请至少选择一项货品"
      });
    } else if (qtyProblems.length) {
      errs.push({ el: Util.$("inProductPicker"), msg: "以下货品数量无效：" + qtyProblems.join("、") });
    }
    if (!UI.reportFieldErrors(errs, els.submit.closest(".card") || document)) return;

    setSubmitting(true);
    var purpose = els.purpose.value.trim();
    var wasEditing = !!editingId;
    var payload = {
      time: Util.nowLocal(),
      type: "in",
      items: items,
      purpose: purpose,
      picker: handlerVal,
      photos: photos.getPhotos(),
      affectsStock: true
    };
    if (sourceVal) payload.source = sourceVal;   // 来源写入记录本体 → 列表/报表按来源筛选用
    try { localStorage.setItem("outbound_in_last_handler", handlerVal); } catch (e) {}
    var rec;
    if (editingId) {
      rec = Records.update(editingId, payload);
      if (!rec) { Util.toast("记录不存在", true); setSubmitting(false); return; }
    } else {
      rec = Records.create(payload);
    }
    resetForm();
    // 先上传照片并写回 photoUrls（首推即含图）；再统一推送。
    // submitPush 是 async，无论成功/失败/无令牌早退，都要在 finally 里解锁。
    submitPush(rec, wasEditing)["catch"](function () {})["finally"](function () { setSubmitting(false); });
  }

  /** 异步推送：先写回 photoUrls，再推记录，确保通知含图。
      P1 修复（与 out.js 同源问题）：照片上传失败绝不能阻断记录推送，
      否则照片已进仓库、记录 JSON 却没推 → 系统看不到、钉钉收不到、本地与云端分叉。 */
  async function submitPush(rec, wasEditing) {
    var finalRec = rec;
    try {
      finalRec = (await pushPhotosToCloud(rec)) || rec;
    } catch (e) {
      Util.toast("⚠️ 照片上传失败，记录仍会照常保存（照片可到「云同步」页补传）", true);
      finalRec = rec;
    }
    pushToCloud(finalRec, wasEditing ? "修改已保存，正在同步到云端…" : "入库成功，正在同步到云端…");
  }

  /** 照片上传云端（可选）：将 photos 上传到 data/photos/ 并把 photoUrls 写回本地记录；不推送记录本身。
      返回更新后的记录（含 photoUrls），无照片或失败时返回原记录。
      失败照片不静默：toast 明确提示 + 入本机补传队列（云同步页可补传），dataURL 保留不丢。
      由 submitPush 先 await 此函数再调 pushToCloud，确保首推已含 photoUrls。 */
  async function pushPhotosToCloud(rec) {
    if (!Cloud.hasToken() || !rec) return rec;
    var photos = (rec.photos || []);
    if (!photos.length) return rec;
    if (Cloud.getRate && Cloud.getRate().low) {
      Util.toast("⚠️ API 配额紧张，照片可能上传较慢或失败；失败可到「云同步」页补传", true);
    }
    var r = await Cloud.pushPhotosDetailed(rec);
    if (r.urls && r.urls.length) {
      var updated = Records.update(rec.id, { photoUrls: r.urls });
      rec = updated || rec;
    }
    if (r.failedIndexes && r.failedIndexes.length) {
      Cloud.markPhotoPending(rec.id, r.failedIndexes);
      var names = r.failedIndexes.map(function (i) { return "第 " + (i + 1) + " 张"; }).join("、");
      Util.toast("⚠️ 照片 " + names + " 上传失败（弱网/配额），已存本机，可到「云同步」页补传", true);
    }
    return rec;
  }

  function pushToCloud(rec, msg) {
    if (!Cloud.hasToken()) {
      // 令牌缺失＝只存在本机浏览器，换设备看不到、也不会进金山台账。必须醒目告警，否则用户会误以为已同步。
      Util.toast("⚠️ 仅存本机，未上传云端！请联系管理员检查同步令牌", true);
      window.App.Views.app.setSyncStatus("⚠️ 未配置云端令牌，本条只存在本机，换设备看不到", true);
      return;
    }
    Util.toast(msg);
    // 优先单条带重试推送本条；失败自动入持久化队列，下次启动/自动同步时补推（关页面也不丢）
    Cloud.pushRecord(rec).then(function (pushed) {
      return Cloud.flushQueue().then(function (fres) { return { pushed: pushed, fres: fres }; });
    }).then(function (r) {
      var fres = r.fres;
      State.lastSync = new Date();
      window.App.Views.app.setSyncStatus("已同步 " + State.lastSync.toLocaleString(), false);
      var remain = (fres && fres.remain) || 0;
      if (remain > 0) {
        window.App.Views.app.setSyncStatus("部分待补推（" + remain + " 条稍后自动重试）", true);
        Util.toast("已存本地，云端稍后自动补推", true);
        return;
      }
      if (r.pushed) watchWpsReceipt(rec);
    }).catch(function (e) {
      window.App.Views.app.setSyncStatus("云端同步失败：" + e.message + "（已存本地，稍后重试）", true);
    });
  }

  /** 追踪金山台账回执：上云只是第一步，真正落进台账才算数，把这一步也显示给用户看 */
  function watchWpsReceipt(rec) {
    if (!Cloud.waitWpsReceipt) return;
    window.App.Views.app.setSyncStatus("⏳ 已上云，正在写入金山台账…", false);
    Cloud.waitWpsReceipt(rec.id, function (st) {
      if (!st || st.phase === "waiting") return;
      var d = Cloud.describeWpsReceipt(st);
      if (!d) return;
      window.App.Views.app.setSyncStatus(d.text, d.isErr);
      if (d.toast) Util.toast(d.toast, d.isErr);
    });
  }

  function resetForm() {
    UI.clearFieldErrors(els.submit.closest(".card") || document);
    els.purpose.value = "";
    sourceVal = "";
    editingTransfer = false;
    picker.setSelected([]);
    photos.setPhotos([]);
    editingId = null;
    els.submit.textContent = "确定入库";
    els.cancelEdit.style.display = "none";
    renderPreview();
    renderSourceChips();
    clearDraft();
  }

  /** 编辑已有入库记录（由记录管理模块调用） */
  function edit(id) {
    var r = State.list.find(function (x) { return x.id === id; });
    if (!r) return;
    editingId = id;
    els.purpose.value = r.purpose || "";
    // 来源：调拨/回滚生成的入库单锁定系统来源（编辑旧调拨单时顺带补上 source 字段），普通单带出原值
    editingTransfer = !!(r.transferRole);
    sourceVal = Records.InSource.of(r) || "";
    picker.setSelected(r.items || []);
    photos.setPhotos(r.photos || []);
    els.submit.textContent = "保存修改";
    els.cancelEdit.style.display = "inline-flex";
    renderPreview();
    renderSourceChips();
    Util.toast("正在编辑该记录，修改后点「保存修改」");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.in = { render: render, edit: edit };
})();
