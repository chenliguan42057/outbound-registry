/**
 * pickups.js — 待取货模块（登记表单 + 待取货/已出库 tab 列表）
 * 登记：部门/客户、取货人、预计取货时间、用途/项目 chip 单选、货品、备注。
 * 状态：confirmed=已确认提单（默认未确认，可点击确认）；shipped=已出库（默认未出库，可点击确认出库）。
 * 确认出库后自动生成一条出库记录（跑到出库记录模块/列表），未确认前一直待在待取货页面。
 * 提交/变更均同步云端 data/pickups/<id>.json（无 token 存本机，下次「立即同步」自动上传）。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Store = window.App.Store;
  var State = window.App.State;
  var Config = window.App.Config;
  var Records = window.App.Records;
  var Pickups = window.App.Pickups;
  var Cloud = window.App.Cloud;

  var container = null;
  var listBox = null;
  var picker = null;
  var els = null;
  var selectedPurpose = "";
  var activeTab = "todo";   // "todo"（待取货）| "shipped"（已出库）

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="card">' +
        '<h2>待取货登记 <span class="tag">已提单未出库</span></h2>' +
        '<div class="grid2">' +
          '<div class="field">' +
            '<label>部门 / 客户<span class="req">*</span></label>' +
            '<div class="search-wrap">' +
              '<input type="text" id="pkDept" placeholder="请输入部门 / 客户" autocomplete="off" />' +
              '<div class="suggest" id="pkDeptSuggest"></div>' +
            '</div>' +
          '</div>' +
          '<div class="field">' +
            '<label>取货人<span class="req">*</span></label>' +
            '<div class="search-wrap">' +
              '<input type="text" id="pkPicker" placeholder="请输入取货人姓名" autocomplete="off" />' +
              '<div class="suggest" id="pkPickerSuggest"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="grid2">' +
          '<div class="field">' +
            '<label>预计取货时间<span class="req">*</span></label>' +
            '<input type="datetime-local" id="pkTime" />' +
            '<div class="hint"><span class="auto" id="pkFillNow">📎 自动填入当前时间</span></div>' +
          '</div>' +
          '<div class="field">' +
            '<label>用途 / 项目<span class="req">*</span></label>' +
            '<div id="pkPurposeChips" class="chip-group"></div>' +
            '<div class="purpose-add-row">' +
              '<button type="button" class="chip-add" id="pkPurposeAdd">+ 添加</button>' +
              '<span class="purpose-add-inline" id="pkPurposeAddInline" style="display:none;">' +
                '<input type="text" id="pkPurposeInput" class="purpose-add-input" placeholder="输入自定义用途" maxlength="30" autocomplete="off" />' +
                '<button type="button" class="btn mini" id="pkPurposeOk">确定</button>' +
                '<button type="button" class="btn ghost mini" id="pkPurposeCancel">取消</button>' +
              '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="field">' +
          '<label>货品名称<span class="req">*</span></label>' +
          '<div id="pkProductPicker"></div>' +
        '</div>' +
        '<div class="field">' +
          '<label>备注（可选）</label>' +
          '<textarea id="pkNote" rows="2" placeholder="备注信息，如取货凭证号、联系方式等（可选）"></textarea>' +
        '</div>' +
        '<div class="actions">' +
          '<button type="button" class="btn" id="pkSubmit">提交登记</button>' +
          '<button type="button" class="btn ghost" id="pkReset">清空</button>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<h2>待取货列表 <span class="badge" id="pkCount">0 条</span></h2>' +
        '<div class="actions rec-actions">' +
          '<button type="button" class="btn ghost sm" id="pkSync">&#128260; 立即同步</button>' +
        '</div>' +
        '<div class="pickups-tabs">' +
          '<button type="button" class="pickups-tab active" data-tab="todo">待取货</button>' +
          '<button type="button" class="pickups-tab" data-tab="shipped">已出库</button>' +
        '</div>' +
        '<div id="pkListBox"></div>' +
      '</div>';

    els = {
      dept: Util.$("pkDept"),
      picker: Util.$("pkPicker"),
      time: Util.$("pkTime"),
      note: Util.$("pkNote"),
      purposeChips: Util.$("pkPurposeChips"),
      purposeAdd: Util.$("pkPurposeAdd"),
      purposeAddInline: Util.$("pkPurposeAddInline"),
      purposeInput: Util.$("pkPurposeInput"),
      purposeOk: Util.$("pkPurposeOk"),
      purposeCancel: Util.$("pkPurposeCancel"),
      submit: Util.$("pkSubmit"),
      reset: Util.$("pkReset")
    };
    listBox = Util.$("pkListBox");

    picker = new UI.ProductPicker({ showStock: true });
    picker.attach(Util.$("pkProductPicker"));

    Util.$("pkFillNow").addEventListener("click", function () { els.time.value = Util.nowLocal(); saveDraft(); });
    els.time.value = Util.nowLocal();
    Util.$("pkReset").addEventListener("click", resetForm);
    Util.$("pkSubmit").addEventListener("click", submit);
    Util.$("pkSync").addEventListener("click", doSync);

    setupHistorySuggest("pkDept", "pkDeptSuggest", Config.DEPT_HISTORY_KEY);
    setupHistorySuggest("pkPicker", "pkPickerSuggest", Config.PICKER_HISTORY_KEY);

    // 用途 chip 单选：事件委托（互斥高亮）
    els.purposeChips.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest(".chip") : null;
      if (!btn) return;
      closePurposeAdd();
      setPurposeSelected(btn.getAttribute("data-val") || "");
    });
    els.purposeAdd.addEventListener("click", openPurposeAdd);
    els.purposeOk.addEventListener("click", confirmPurposeAdd);
    els.purposeCancel.addEventListener("click", closePurposeAdd);
    els.purposeInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { ev.preventDefault(); closePurposeAdd(); }
      else if (ev.key === "Enter") { ev.preventDefault(); confirmPurposeAdd(); }
    });
    renderPurposeChips();

    // 自动保存草稿（用途 chip 选中/新增时在对应逻辑里单独触发）
    ["pkDept", "pkPicker", "pkTime", "pkNote"].forEach(function (id) {
      Util.$(id).addEventListener("input", saveDraft);
    });
    picker.onChange = saveDraft;

    bindTabs();
    listBox.addEventListener("click", onListClick);

    restoreDraft();
    renderList();
  }

  /* ---------- 用途/项目 chip 单选（逻辑照抄 out.js） ---------- */

  function getPurposeOptions() {
    var presets = (Config.PURPOSE_PRESETS || []).slice();
    var raw = Store.getHistory(Config.PURPOSE_HISTORY_KEY);
    var count = {};
    var order = [];
    raw.forEach(function (v) {
      if (!v || presets.indexOf(v) !== -1) return;
      if (!count[v]) { count[v] = 0; order.push(v); }
      count[v]++;
    });
    var history = order
      .map(function (v, i) { return { val: v, c: count[v], i: i }; })
      .sort(function (a, b) { return b.c - a.c || a.i - b.i; })
      .map(function (o) { return o.val; })
      .slice(0, 8);
    var out = presets.concat(history);
    if (selectedPurpose && out.indexOf(selectedPurpose) === -1) out.push(selectedPurpose);
    return out;
  }

  function renderPurposeChips() {
    var wrap = els.purposeChips;
    if (!wrap) return;
    wrap.innerHTML = getPurposeOptions().map(function (val) {
      var cls = "chip" + (val === selectedPurpose ? " selected" : "");
      return '<button type="button" class="' + cls + '" data-val="' + Util.esc(val) + '">' + Util.esc(val) + '</button>';
    }).join("");
  }

  function setPurposeSelected(val) {
    selectedPurpose = val || "";
    renderPurposeChips();
    saveDraft();
  }

  function openPurposeAdd() {
    els.purposeAdd.style.display = "none";
    els.purposeAddInline.style.display = "inline-flex";
    els.purposeInput.value = "";
    els.purposeInput.focus();
  }

  function closePurposeAdd() {
    if (!els.purposeAdd) return;
    els.purposeAdd.style.display = "";
    els.purposeAddInline.style.display = "none";
    els.purposeInput.value = "";
  }

  function confirmPurposeAdd() {
    var val = els.purposeInput.value.trim();
    if (!val) { Util.toast("请输入用途/项目", true); els.purposeInput.focus(); return; }
    if (getPurposeOptions().indexOf(val) !== -1) { Util.toast("该用途已存在，请直接选择", true); return; }
    Store.addHistory(Config.PURPOSE_HISTORY_KEY, val);
    closePurposeAdd();
    selectedPurpose = val;
    renderPurposeChips();
    saveDraft();
  }

  /* ---------- 历史补全（部门 / 取货人） ---------- */

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
    // 聚焦不显示建议列表（用户只点输入框不显示历史），仅输入文字时由 input 事件触发
    inp.addEventListener("blur", function () { setTimeout(function () { sug.style.display = "none"; }, 120); });
  }

  /* ---------- 草稿 ---------- */

  function saveDraft() {
    Store.savePickupsDraft({
      time: els.time.value,
      picker: els.picker.value,
      dept: els.dept.value,
      purpose: selectedPurpose,
      items: picker.selected,
      note: els.note.value
    });
  }

  function restoreDraft() {
    var d = Store.loadPickupsDraft();
    if (!d) return;
    els.time.value = d.time || Util.nowLocal();
    els.picker.value = d.picker || "";
    els.dept.value = d.dept || "";
    if (d.purpose) { selectedPurpose = d.purpose; renderPurposeChips(); }
    picker.setSelected(d.items || []);
    els.note.value = d.note || "";
  }

  function clearDraft() { Store.clearPickupsDraft(); }

  /* ---------- 提交登记 ---------- */

  function submit() {
    var time = els.time.value;
    var pickerVal = els.picker.value.trim();
    var dept = els.dept.value.trim();
    var purpose = selectedPurpose;
    if (!time) return Util.toast("请填写预计取货时间", true);
    if (!pickerVal) return Util.toast("请填写取货人", true);
    if (!dept) return Util.toast("请填写部门/客户（必填）", true);
    if (!purpose) return Util.toast("请选择用途/项目（必填）", true);
    var items = picker.getItems();
    if (!items.length) return Util.toast("请至少选择一项货品", true);

    var pk = Pickups.create({
      time: time,
      picker: pickerVal,
      dept: dept,
      purpose: purpose,
      items: items,
      note: els.note.value.trim()
    });
    Store.addHistory(Config.DEPT_HISTORY_KEY, dept);
    Store.addHistory(Config.PICKER_HISTORY_KEY, pickerVal);
    resetForm();
    renderList();
    if (Cloud.hasToken()) {
      Cloud.pushPickup(pk).then(function () {
        window.App.Views.app.setSyncStatus("已同步", false);
      }).catch(function () {
        window.App.Views.app.setSyncStatus("云端同步失败（已存本机）", true);
      });
      Util.toast("登记成功，正在同步到云端…");
    } else {
      // 令牌缺失＝只存在本机浏览器，换设备看不到。必须醒目告警，否则用户会误以为已同步。
      Util.toast("⚠️ 仅存本机，未上传云端！请联系管理员检查同步令牌", true);
      window.App.Views.app.setSyncStatus("⚠️ 未配置云端令牌，本条只存在本机，换设备看不到", true);
    }
  }

  function resetForm() {
    els.picker.value = "";
    selectedPurpose = "";
    renderPurposeChips();
    closePurposeAdd();
    els.dept.value = "";
    els.time.value = Util.nowLocal();
    picker.setSelected([]);
    els.note.value = "";
    clearDraft();
  }

  /* ---------- 列表渲染 ---------- */

  function renderList() {
    if (!listBox) return;
    var list = State.pickups;
    var todo = list.filter(function (p) { return p.shipped !== true; });
    var shipped = list.filter(function (p) { return p.shipped === true; });
    var shown = activeTab === "shipped" ? shipped : todo;
    Util.$("pkCount").textContent = shown.length + " 条";
    if (!shown.length) {
      listBox.innerHTML = '<div class="empty">' +
        (activeTab === "shipped" ? "暂无已出库记录。" : "暂无待取货登记，请先在上方登记。") +
        '</div>';
      return;
    }
    var html = '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>序号</th><th>登记时间</th><th>取货人</th><th>部门/客户</th><th>货品名称</th><th>数量</th><th>提单状态</th><th>出库状态</th><th>操作</th>' +
      '</tr></thead><tbody>';
    shown.forEach(function (p, i) {
      var items = (p.items || []).map(function (it, idx, arr) {
        return '<div class="item-line' + (arr.length > 1 ? " multi-line" : "") + '">' + Util.esc(it.name) + '</div>';
      }).join("");
      var qtys = (p.items || []).map(function (it, idx, arr) {
        return '<div class="item-line' + (arr.length > 1 ? " multi-line" : "") + '">' + it.qty + '</div>';
      }).join("");
      html += '<tr>' +
        '<td><div>' + (shown.length - i) + '</div></td>' +
        '<td>' + Util.esc(p.time || "-") + '</td>' +
        '<td>' + Util.esc(p.picker || "-") + '</td>' +
        '<td>' + Util.esc(p.dept || "-") + '</td>' +
        '<td class="items-cell">' + items + '</td>' +
        '<td>' + qtys + '</td>' +
        '<td>' + confirmedPill(p) + '</td>' +
        '<td>' + shippedPill(p) + '</td>' +
        '<td><button type="button" class="btn danger sm" data-act="del" data-id="' + p.id + '">删除</button></td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    listBox.innerHTML = html;
  }

  /** 提单状态徽章：未确认=红（可点击确认）；已确认=绿；已出库后静态不可点 */
  function confirmedPill(p) {
    var ok = p.confirmed === true;
    var label = ok ? "已确认提单" : "未确认提单";
    var cls = "status-pill " + (ok ? "submitted" : "pending");
    if (p.shipped === true) {
      return '<span class="' + cls + ' static"><span class="dot"></span>' + label + '</span>';
    }
    return '<button type="button" class="' + cls + '" data-act="confirm" data-id="' + p.id + '"><span class="dot"></span>' + label + '</button>';
  }

  /** 出库状态徽章：未出库=红（可点击确认出库）；已出库=绿静态 */
  function shippedPill(p) {
    var done = p.shipped === true;
    if (done) {
      return '<span class="status-pill submitted static"><span class="dot"></span>已出库</span>';
    }
    return '<button type="button" class="status-pill pending" data-act="ship" data-id="' + p.id + '"><span class="dot"></span>未出库</button>';
  }

  /* ---------- 列表操作 ---------- */

  function onListClick(e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    var id = btn.getAttribute("data-id");
    if (act === "confirm") toggleConfirmed(id);
    else if (act === "ship") confirmShip(id);
    else if (act === "del") doDel(id);
  }

  /** 确认提单：confirmed false→true，本地保存 + 推送云端 */
  async function toggleConfirmed(id) {
    var pk = State.pickups.find(function (x) { return x.id === id; });
    if (!pk) return;
    if (pk.shipped === true) return;   // 已出库的记录提单徽章不可点击
    var ok = await UI.confirmDialog("标记为已确认提单？", "确认提单");
    if (!ok) return;
    var updated = Pickups.update(id, { confirmed: true });
    if (!updated) { Util.toast("记录不存在", true); return; }
    renderList();
    Util.toast("已确认提单");
    if (Cloud.hasToken()) {
      Cloud.pushPickup(updated).then(function () {
        window.App.Views.app.setSyncStatus("已同步", false);
      }).catch(function () {
        window.App.Views.app.setSyncStatus("云端同步失败", true);
      });
    }
  }

  /** 确认出库：置 confirmed/shipped=true + 生成出库记录 + 先推待取货再推记录 */
  async function confirmShip(id) {
    var pk = State.pickups.find(function (x) { return x.id === id; });
    if (!pk) return;
    if (pk.shipped === true) return;
    var ok = await UI.confirmDialog("确认该待取货已出库？确认后将生成出库记录并同步库存。", "确认出库");
    if (!ok) return;
    var updated = Pickups.update(id, { confirmed: true, shipped: true });
    if (!updated) { Util.toast("记录不存在", true); return; }
    // 幂等保护：该待取货的出库记录已存在（上次推送失败后重复确认），不再重复生成/重复扣库存，
    // 但仍复用已有记录做云端补推（Cloud.push 幂等，云端已有则更新）。
    var existing = State.list.find(function (r) { return r.pickupId === id; });
    var rec = existing || Records.create(Pickups.toOutboundPayload(updated));
    renderList();
    if (Cloud.hasToken()) {
      try {
        await Cloud.pushPickup(updated);
        await Cloud.push(rec);
        window.App.Views.app.setSyncStatus("已同步", false);
      } catch (e) {
        window.App.Views.app.setSyncStatus("云端同步失败（已存本机）", true);
      }
    } else {
      window.App.Views.app.setSyncStatus("本机模式，出库记录已存本机", true);
    }
    Util.toast(existing ? "该待取货的出库记录已存在，未重复生成" : "已确认出库，出库记录已生成");
  }

  /** 删除待取货：本地删除 + 云端直接删文件（不带墓碑，流程性数据不做删除同步） */
  async function doDel(id) {
    var pk = State.pickups.find(function (x) { return x.id === id; });
    if (!pk) return;
    var res = await UI.promptDialog("删除该待取货登记？请填写原因：", "例如：已取消 / 重复登记…", "删除待取货", "确认删除");
    if (!res.ok) return;
    Pickups.remove(id);
    renderList();
    Util.toast("已删除待取货登记");
    if (Cloud.hasToken()) {
      try { await Cloud.delPickup(id); }
      catch (e) {
        window.App.Views.app.setSyncStatus("云端删除失败（已存本机）", true);
      }
    }
  }

  /* ---------- 立即同步 + tab 切换 ---------- */

  function doSync() {
    if (!Cloud.hasToken()) { Util.toast("未配置云端令牌，无法同步", true); return; }
    Util.toast("正在同步…");
    Cloud.syncPull({ onStatus: function (text, isErr) {
      window.App.Views.app.setSyncStatus(text, isErr);
    } }).then(function () {
      renderList();
      // 确保本机未推送的待取货全部上传（幂等，失败不影响）
      Cloud.pushAllPickups(State.pickups).then(function (res) {
        if (res.fail > 0) window.App.Views.app.setSyncStatus("部分待取货推送失败（" + res.fail + "）", true);
      });
    });
  }

  function bindTabs() {
    var tabs = container.querySelectorAll(".pickups-tab");
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        activeTab = t.getAttribute("data-tab");
        tabs.forEach(function (x) { x.classList.toggle("active", x === t); });
        renderList();
      });
    });
  }

  /** 云端同步后刷新（保留表单，重建列表） */
  function refresh() {
    if (container && listBox) renderList();
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.pickups = { render: render, refresh: refresh, doSync: doSync };
})();
