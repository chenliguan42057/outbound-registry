/**
 * out.js — 出库登记模块
 * 部门/领取单位、领取时间（自动填入）、领取人、用途/项目、
 * 货品多选+搜索+数量、现场照片（多张拖拽/点击上传、压缩）、提交/清空、编辑已有记录
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Store = window.App.Store;
  var State = window.App.State;
  var Config = window.App.Config;
  var Records = window.App.Records;
  var Cloud = window.App.Cloud;

  var picker = null;
  var photos = null;
  var editingId = null;
  var els = null;

  function render(container) {
    container.innerHTML =
      '<div class="card">' +
        '<h2>出库登记 <span class="tag">基础登记</span></h2>' +
        '<div class="field">' +
          '<label>部门 / 领取单位<span class="req">*</span></label>' +
          '<div class="search-wrap">' +
            '<input type="text" id="outDept" placeholder="请输入部门 / 领取单位" autocomplete="off" />' +
            '<div class="suggest" id="outDeptSuggest"></div>' +
          '</div>' +
        '</div>' +
        '<div class="grid2">' +
          '<div class="field">' +
            '<label>领取时间<span class="req">*</span></label>' +
            '<input type="datetime-local" id="outTime" />' +
            '<div class="hint"><span class="auto" id="outFillNow">📎 自动填入当前时间</span></div>' +
          '</div>' +
          '<div class="field">' +
            '<label>领取人<span class="req">*</span></label>' +
            '<div class="search-wrap">' +
              '<input type="text" id="outPicker" placeholder="请输入领取人姓名" autocomplete="off" />' +
              '<div class="suggest" id="outPickerSuggest"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="field">' +
          '<label>用途 / 项目<span class="req">*</span></label>' +
          '<input type="text" id="outPurpose" placeholder="请输入用途或项目（必填）" />' +
        '</div>' +
        '<div class="field">' +
          '<label>货物名称<span class="req">*</span></label>' +
          '<div id="outProductPicker"></div>' +
        '</div>' +
        '<div class="field">' +
          '<label>现场照片（留存）</label>' +
          '<div id="outPhotoUpload"></div>' +
        '</div>' +
        '<div class="actions">' +
          '<button type="button" class="btn" id="outSubmit">提交登记</button>' +
          '<button type="button" class="btn ghost" id="outReset">清空</button>' +
          '<button type="button" class="btn ghost" id="outCancelEdit" style="display:none;">取消编辑</button>' +
        '</div>' +
      '</div>';

    els = {
      dept: Util.$("outDept"),
      time: Util.$("outTime"),
      picker: Util.$("outPicker"),
      purpose: Util.$("outPurpose"),
      submit: Util.$("outSubmit"),
      reset: Util.$("outReset"),
      cancelEdit: Util.$("outCancelEdit")
    };

    picker = new UI.ProductPicker({ showStock: true });
    picker.attach(Util.$("outProductPicker"));
    photos = new UI.PhotoUpload({});
    photos.attach(Util.$("outPhotoUpload"));

    Util.$("outFillNow").addEventListener("click", function () { els.time.value = Util.nowLocal(); });
    els.time.value = Util.nowLocal();
    Util.$("outReset").addEventListener("click", resetForm);
    Util.$("outCancelEdit").addEventListener("click", function () { resetForm(); Util.toast("已取消编辑"); });
    Util.$("outSubmit").addEventListener("click", submit);

    setupHistorySuggest("outDept", "outDeptSuggest", Config.DEPT_HISTORY_KEY);
    setupHistorySuggest("outPicker", "outPickerSuggest", Config.PICKER_HISTORY_KEY);

    // 自动保存草稿
    ["outDept", "outTime", "outPicker", "outPurpose"].forEach(function (id) {
      Util.$(id).addEventListener("input", saveDraft);
    });
    picker.onChange = saveDraft;
    photos.onChange = saveDraft;

    restoreDraft();
  }

  /** 历史补全（部门 / 领取人），与现网一致 */
  function setupHistorySuggest(inputId, suggestId, historyKey) {
    var inp = Util.$(inputId), sug = Util.$(suggestId);
    function render() {
      var q = inp.value.trim().toLowerCase();
      if (!q) { sug.style.display = "none"; return; }
      var matches = Store.getHistory(historyKey).filter(function (v) { return v.toLowerCase().includes(q); });
      if (!matches.length) { sug.style.display = "none"; return; }
      sug.innerHTML = "";
      matches.slice(0, 30).forEach(function (v) {
        var d = document.createElement("div");
        d.textContent = v;
        d.addEventListener("mousedown", function (ev) {
          ev.preventDefault();
          inp.value = v;
          sug.style.display = "none";
          saveDraft();
        });
        sug.appendChild(d);
      });
      sug.style.display = "block";
    }
    inp.addEventListener("input", render);
    inp.addEventListener("focus", function () { if (inp.value.trim()) render(); });
    inp.addEventListener("blur", function () { setTimeout(function () { sug.style.display = "none"; }, 120); });
  }

  function saveDraft() {
    if (editingId) return; // 编辑中不覆盖草稿
    Store.saveDraft("out", {
      time: els.time.value,
      picker: els.picker.value,
      dept: els.dept.value,
      purpose: els.purpose.value,
      items: picker.selected,
      photos: photos.getPhotos()
    });
  }

  function restoreDraft() {
    var d = Store.loadDraft("out");
    if (!d) return;
    els.time.value = d.time || Util.nowLocal();
    els.picker.value = d.picker || "";
    els.dept.value = d.dept || "";
    els.purpose.value = d.purpose || "";
    picker.setSelected(d.items || []);
    photos.setPhotos(d.photos || []);
  }

  function clearDraft() { Store.clearDraft("out"); }

  function submit() {
    var time = els.time.value;
    var pickerVal = els.picker.value.trim();
    var purpose = els.purpose.value.trim();
    var dept = els.dept.value.trim();
    if (!time) return Util.toast("请填写领取时间", true);
    if (!pickerVal) return Util.toast("请填写领取人", true);
    if (!dept) return Util.toast("请填写部门/领取单位（必填）", true);
    if (!purpose) return Util.toast("请填写用途/项目（必填）", true);
    var items = picker.getItems();
    if (!items.length) return Util.toast("请至少选择一项货品", true);

    var wasEditing = !!editingId;
    var payload = {
      time: time,
      picker: pickerVal,
      dept: dept,
      purpose: purpose,
      items: items,
      photos: photos.getPhotos(),
      affectsStock: true  // 新记录才参与库存计算
    };
    if (!wasEditing) payload.status = "pending";   // 新建出库记录默认「未提单」；编辑不携带 → 合并保留原值
    var rec;
    if (editingId) {
      rec = Records.update(editingId, payload);
      if (!rec) { Util.toast("记录不存在", true); return; }
    } else {
      rec = Records.create(payload);
    }
    Store.addHistory(Config.DEPT_HISTORY_KEY, dept);
    Store.addHistory(Config.PICKER_HISTORY_KEY, pickerVal);
    resetForm();
    // 提交成功滚顶（落地页表单较长，便于看到成功反馈）
    window.scrollTo({ top: 0, behavior: "smooth" });
    pushToCloud(wasEditing ? "修改已保存，正在同步到云端…" : "登记成功，正在同步到云端…");
  }

  function pushToCloud(msg) {
    if (!Cloud.hasToken()) {
      Util.toast("登记成功（已存本机）");
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
    els.picker.value = "";
    els.purpose.value = "";
    els.dept.value = "";
    els.time.value = Util.nowLocal();
    picker.setSelected([]);
    photos.setPhotos([]);
    editingId = null;
    els.submit.textContent = "提交登记";
    els.cancelEdit.style.display = "none";
    clearDraft();
  }

  /** 编辑已有出库记录（由记录管理模块调用） */
  function edit(id) {
    var r = State.list.find(function (x) { return x.id === id; });
    if (!r) return;
    editingId = id;
    els.time.value = r.time || Util.nowLocal();
    els.picker.value = r.picker || "";
    els.dept.value = r.dept || "";
    els.purpose.value = r.purpose || "";
    picker.setSelected(r.items || []);
    photos.setPhotos(r.photos || []);
    els.submit.textContent = "保存修改";
    els.cancelEdit.style.display = "inline-flex";
    Util.toast("正在编辑该记录，修改后点「保存修改」");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.out = { render: render, edit: edit };
})();
