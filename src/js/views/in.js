/**
 * in.js — 入库登记模块
 * 货品多选+数量、用途/来源、照片、确定入库/清空/编辑；确认前显示库存变化预览（当前库存 → 入库后）
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

  function render(container) {
    container.innerHTML =
      '<div class="card">' +
        '<h2>入库登记 <span class="tag">库存补充</span></h2>' +
        '<div class="field">' +
          '<label>货品名称<span class="req">*</span></label>' +
          '<div id="inProductPicker"></div>' +
        '</div>' +
        '<div class="field">' +
          '<label>用途 / 来源</label>' +
          '<input type="text" id="inPurpose" placeholder="例如：采购入库、退货入库、盘点补录等" />' +
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
      submit: Util.$("inSubmit"),
      reset: Util.$("inReset"),
      cancelEdit: Util.$("inCancelEdit"),
      preview: Util.$("inPreview")
    };

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
    renderPreview();
    restoreDraft();
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
      items: picker.selected,
      photos: photos.getPhotos()
    });
  }

  function restoreDraft() {
    var d = Store.loadDraft("in");
    if (!d) return;
    els.purpose.value = d.purpose || "";
    picker.setSelected(d.items || []);
    photos.setPhotos(d.photos || []);
    renderPreview();
  }

  function clearDraft() { Store.clearDraft("in"); }

  function submit() {
    var items = picker.getItems();
    if (!items.length) return Util.toast("请至少选择一项货品", true);
    var purpose = els.purpose.value.trim();
    var wasEditing = !!editingId;
    var payload = {
      time: Util.nowLocal(),
      type: "in",
      items: items,
      purpose: purpose,
      photos: photos.getPhotos(),
      affectsStock: true
    };
    var rec;
    if (editingId) {
      rec = Records.update(editingId, payload);
      if (!rec) { Util.toast("记录不存在", true); return; }
    } else {
      rec = Records.create(payload);
    }
    resetForm();
    pushPhotosToCloud(rec);
    pushToCloud(wasEditing ? "修改已保存，正在同步到云端…" : "入库成功，正在同步到云端…");
  }

  /** 照片上传云端（可选）：成功后记录 photoUrls，供钉钉通知渲染图片；失败不阻塞 */
  function pushPhotosToCloud(rec) {
    if (!Cloud.hasToken()) return;
    var photos = (rec && rec.photos) || [];
    if (!photos.length) return;
    Cloud.pushPhotos(rec).then(function (urls) {
      if (!urls || !urls.length) return;
      var updated = Records.update(rec.id, { photoUrls: urls });
      if (updated && Cloud.hasToken()) {
        Cloud.push(updated).catch(function () {});
      }
    }).catch(function () {});
  }

  function pushToCloud(msg) {
    if (!Cloud.hasToken()) {
      Util.toast("入库成功（已存本机）");
      return;
    }
    Util.toast(msg);
    Cloud.pushAllLocal().then(function (res) {
      State.lastSync = new Date();
      window.App.Views.app.setSyncStatus("已同步 " + State.lastSync.toLocaleString(), false);
      if (res.fail > 0) {
        window.App.Views.app.setSyncStatus("部分同步失败（" + res.fail + " 条）", true);
        Util.toast("已存本地，云端同步 " + res.ok + " 成功 / " + res.fail + " 失败", true);
      }
    }).catch(function (e) {
      window.App.Views.app.setSyncStatus("云端同步失败：" + e.message + "（已存本地）", true);
    });
  }

  function resetForm() {
    els.purpose.value = "";
    picker.setSelected([]);
    photos.setPhotos([]);
    editingId = null;
    els.submit.textContent = "确定入库";
    els.cancelEdit.style.display = "none";
    renderPreview();
    clearDraft();
  }

  /** 编辑已有入库记录（由记录管理模块调用） */
  function edit(id) {
    var r = State.list.find(function (x) { return x.id === id; });
    if (!r) return;
    editingId = id;
    els.purpose.value = r.purpose || "";
    picker.setSelected(r.items || []);
    photos.setPhotos(r.photos || []);
    els.submit.textContent = "保存修改";
    els.cancelEdit.style.display = "inline-flex";
    renderPreview();
    Util.toast("正在编辑该记录，修改后点「保存修改」");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.in = { render: render, edit: edit };
})();
