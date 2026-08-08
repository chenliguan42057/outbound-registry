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
  var Stock = window.App.Stock;

  var picker = null;
  var photos = null;
  var editingId = null;
  var els = null;
  /** 当前选中的用途值（chip 单选，互斥高亮） */
  var selectedPurpose = "";
  /** 结算法人单位默认值：预设第一项「深圳细胞法人」，仅手动点击赛迪斯或自定义后才切换 */
  var DEFAULT_ENTITY = (Config.ENTITY_PRESETS && Config.ENTITY_PRESETS[0]) || "";
  /** 当前选中的结算法人单位值（chip 单选，互斥高亮；必填，默认深圳细胞法人） */
  var selectedEntity = DEFAULT_ENTITY;

  function render(container) {
    container.innerHTML =
      '<div class="card">' +
        '<h2>出库登记 <span class="tag">基础登记</span></h2>' +
        '<div class="field">' +
          '<label>结算法人单位<span class="req">*</span></label>' +
          '<div id="outEntityChips" class="chip-group"></div>' +
          '<div class="purpose-add-row">' +
            '<button type="button" class="chip-add" id="outEntityAdd">+ 添加</button>' +
            '<span class="purpose-add-inline" id="outEntityAddInline" style="display:none;">' +
              '<input type="text" id="outEntityInput" class="purpose-add-input" placeholder="输入自定义法人" maxlength="30" autocomplete="off" />' +
              '<button type="button" class="btn mini" id="outEntityOk">确定</button>' +
              '<button type="button" class="btn ghost mini" id="outEntityCancel">取消</button>' +
            '</span>' +
          '</div>' +
        '</div>' +
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
            '<label>领取人 and 工号or手机<span class="req">*</span></label>' +
            '<div class="search-wrap">' +
              '<input type="text" id="outPicker" placeholder="请输入领取人姓名、工号或手机" autocomplete="off" />' +
              '<div class="suggest" id="outPickerSuggest"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="field">' +
          '<label>用途 / 项目<span class="req">*</span></label>' +
          '<div id="outPurposeChips" class="chip-group"></div>' +
          '<div class="purpose-add-row">' +
            '<button type="button" class="chip-add" id="outPurposeAdd">+ 添加</button>' +
            '<span class="purpose-add-inline" id="outPurposeAddInline" style="display:none;">' +
              '<input type="text" id="outPurposeInput" class="purpose-add-input" placeholder="输入自定义用途" maxlength="30" autocomplete="off" />' +
              '<button type="button" class="btn mini" id="outPurposeOk">确定</button>' +
              '<button type="button" class="btn ghost mini" id="outPurposeCancel">取消</button>' +
            '</span>' +
          '</div>' +
        '</div>' +
        '<div class="field">' +
          '<label>货物名称<span class="req">*</span></label>' +
          '<div id="outProductPicker"></div>' +
        '</div>' +
        '<div class="field">' +
          '<label>备注</label>' +
          '<textarea id="outNote" rows="2" maxlength="500" placeholder="如有任何补充说明…" autocomplete="off"></textarea>' +
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
      entityChips: Util.$("outEntityChips"),
      entityAdd: Util.$("outEntityAdd"),
      entityAddInline: Util.$("outEntityAddInline"),
      entityInput: Util.$("outEntityInput"),
      entityOk: Util.$("outEntityOk"),
      entityCancel: Util.$("outEntityCancel"),
      dept: Util.$("outDept"),
      time: Util.$("outTime"),
      picker: Util.$("outPicker"),
      note: Util.$("outNote"),
      purposeChips: Util.$("outPurposeChips"),
      purposeAdd: Util.$("outPurposeAdd"),
      purposeAddInline: Util.$("outPurposeAddInline"),
      purposeInput: Util.$("outPurposeInput"),
      purposeOk: Util.$("outPurposeOk"),
      purposeCancel: Util.$("outPurposeCancel"),
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

    // 结算法人单位 chip 单选：事件委托（互斥高亮），与用途/项目同模式
    els.entityChips.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest(".chip") : null;
      if (!btn) return;
      closeEntityAdd();
      setEntitySelected(btn.getAttribute("data-val") || "");
    });
    els.entityAdd.addEventListener("click", openEntityAdd);
    els.entityOk.addEventListener("click", confirmEntityAdd);
    els.entityCancel.addEventListener("click", closeEntityAdd);
    els.entityInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { ev.preventDefault(); closeEntityAdd(); }
      else if (ev.key === "Enter") { ev.preventDefault(); confirmEntityAdd(); }
    });
    renderEntityChips();

    // 自动保存草稿（用途 chip 选中/新增时在对应逻辑里单独触发）
    ["outDept", "outTime", "outPicker", "outNote"].forEach(function (id) {
      Util.$(id).addEventListener("input", saveDraft);
    });
    picker.onChange = saveDraft;
    photos.onChange = saveDraft;

    restoreDraft();
  }

  /* ---------- 用途/项目 chip 单选 ---------- */

  /** 组装 chip 选项：预设 + 历史（历史按使用频次降序，同次数按最近使用在前，去重，最多前 8）。
      注：Store.addHistory 通用实现为「去重+置顶」，历史数组本身一般不含重复项；
      此处仍按原始数组做频次统计排序，以兼容历史/导入/手工数据含重复项的频次口径。
      presets = 预设数组；historyKey = 历史 localStorage 键；selected = 当前选中值（保证其 chip 始终可见）。 */
  function getHistoryChipOptions(presets, historyKey, selected) {
    var presetArr = (presets || []).slice();
    var raw = Store.getHistory(historyKey);
    // 频次统计：遍历原始数组计数；order 保留首次出现顺序（即最近使用在前），用于同次数稳定排序
    var count = {};
    var order = [];
    raw.forEach(function (v) {
      if (!v || presetArr.indexOf(v) !== -1) return; // 空值与预设值不进历史排序区
      if (!count[v]) { count[v] = 0; order.push(v); }
      count[v]++;
    });
    var history = order
      .map(function (v, i) { return { val: v, c: count[v], i: i }; })
      .sort(function (a, b) { return b.c - a.c || a.i - b.i; }) // 次数降序，同次数最近使用在前
      .map(function (o) { return o.val; })
      .slice(0, 8);
    var out = presetArr.concat(history);
    // 确保当前选中值始终有 chip 可见（草稿/编辑恢复历史值时可能不在前 8 内）
    if (selected && out.indexOf(selected) === -1) out.push(selected);
    return out;
  }

  /** 组装「用途/项目」chip 选项 */
  function getPurposeOptions() {
    return getHistoryChipOptions(Config.PURPOSE_PRESETS, Config.PURPOSE_HISTORY_KEY, selectedPurpose);
  }

  /** 组装「结算法人单位」chip 选项 */
  function getEntityOptions() {
    return getHistoryChipOptions(Config.ENTITY_PRESETS, Config.ENTITY_HISTORY_KEY, selectedEntity);
  }

  /** 渲染 chip 列表（用户数据经 Util.esc 转义，防 XSS） */
  function renderPurposeChips() {
    var wrap = els.purposeChips;
    if (!wrap) return;
    wrap.innerHTML = getPurposeOptions().map(function (val) {
      var cls = "chip" + (val === selectedPurpose ? " selected" : "");
      return '<button type="button" class="' + cls + '" data-val="' + Util.esc(val) + '">' + Util.esc(val) + '</button>';
    }).join("");
  }

  /** 读取当前选中的用途值 */
  function getPurposeSelected() {
    return selectedPurpose;
  }

  /** 选中某个用途（互斥高亮），并触发草稿保存 */
  function setPurposeSelected(val) {
    selectedPurpose = val || "";
    renderPurposeChips();
    saveDraft();
  }

  /** 打开「+ 添加」inline 输入框 */
  function openPurposeAdd() {
    els.purposeAdd.style.display = "none";
    els.purposeAddInline.style.display = "inline-flex";
    els.purposeInput.value = "";
    els.purposeInput.focus();
  }

  /** 关闭 inline 输入框并还原「+ 添加」按钮 */
  function closePurposeAdd() {
    if (!els.purposeAdd) return;
    els.purposeAdd.style.display = "";
    els.purposeAddInline.style.display = "none";
    els.purposeInput.value = "";
  }

  /** 确认新增自定义用途：非空 + 不重复 → 写历史 → 重排 chips → 自动选中 */
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

  /* ---------- 结算法人单位 chip 单选（与用途/项目同模式） ---------- */

  /** 渲染结算法人单位 chip 列表（用户数据经 Util.esc 转义，防 XSS） */
  function renderEntityChips() {
    var wrap = els.entityChips;
    if (!wrap) return;
    wrap.innerHTML = getEntityOptions().map(function (val) {
      var cls = "chip" + (val === selectedEntity ? " selected" : "");
      return '<button type="button" class="' + cls + '" data-val="' + Util.esc(val) + '">' + Util.esc(val) + '</button>';
    }).join("");
  }

  /** 读取当前选中的结算法人单位值 */
  function getEntitySelected() {
    return selectedEntity;
  }

  /** 选中某个结算法人单位（互斥高亮），并触发草稿保存 */
  function setEntitySelected(val) {
    selectedEntity = val || "";
    renderEntityChips();
    saveDraft();
  }

  /** 打开「+ 添加」inline 输入框 */
  function openEntityAdd() {
    els.entityAdd.style.display = "none";
    els.entityAddInline.style.display = "inline-flex";
    els.entityInput.value = "";
    els.entityInput.focus();
  }

  /** 关闭 inline 输入框并还原「+ 添加」按钮 */
  function closeEntityAdd() {
    if (!els.entityAdd) return;
    els.entityAdd.style.display = "";
    els.entityAddInline.style.display = "none";
    els.entityInput.value = "";
  }

  /** 确认新增自定义法人：非空 + 不重复 → 写历史 → 重排 chips → 自动选中 */
  function confirmEntityAdd() {
    var val = els.entityInput.value.trim();
    if (!val) { Util.toast("请输入结算法人单位", true); els.entityInput.focus(); return; }
    if (getEntityOptions().indexOf(val) !== -1) { Util.toast("该法人已存在，请直接选择", true); return; }
    Store.addHistory(Config.ENTITY_HISTORY_KEY, val);
    closeEntityAdd();
    selectedEntity = val;
    renderEntityChips();
    saveDraft();
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
    // 聚焦不显示建议列表（用户只点输入框不显示历史），仅输入文字时由 input 事件触发
    inp.addEventListener("blur", function () { setTimeout(function () { sug.style.display = "none"; }, 120); });
  }

  function saveDraft() {
    if (editingId) return; // 编辑中不覆盖草稿
    Store.saveDraft("out", {
      time: els.time.value,
      picker: els.picker.value,
      dept: els.dept.value,
      note: els.note.value,
      purpose: getPurposeSelected(),
      entity: getEntitySelected(),
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
    els.note.value = d.note || "";
    if (d.purpose) { selectedPurpose = d.purpose; renderPurposeChips(); }  // 旧草稿为字符串，直接匹配高亮对应 chip
    if (d.entity) { selectedEntity = d.entity; renderEntityChips(); }      // 结算法人单位同款回填
    picker.setSelected(d.items || []);
    photos.setPhotos(d.photos || []);
  }

  function clearDraft() { Store.clearDraft("out"); }

  /** 出库单自动编号：ORD-YYYYMMDD-NNN（当日序号；纯追加字段 orderNo，不影响既有 schema） */
  function genOrderNo() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    var today = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
    var count = (State.list || []).filter(function (r) {
      return (r.type || "out") !== "in" && (r.time || "").indexOf(today) === 0;
    }).length;
    var seq = count + 1;
    return "ORD-" + today.replace(/-/g, "") + "-" + (seq >= 1000 ? String(seq) : ("00" + seq).slice(-3));
  }

  function submit() {
    var time = els.time.value;
    var pickerVal = els.picker.value.trim();
    var purpose = getPurposeSelected();
    var entity = getEntitySelected();
    var dept = els.dept.value.trim();
    if (!time) return Util.toast("请填写领取时间", true);
    if (!pickerVal) return Util.toast("请填写领取人", true);
    if (!dept) return Util.toast("请填写部门/领取单位（必填）", true);
    if (!purpose) return Util.toast("请选择用途/项目（必填）", true);
    if (!entity) return Util.toast("请选择结算法人单位", true);
    var items = picker.getItems();
    if (!items.length) return Util.toast("请至少选择一项货品", true);
    // 库存下限校验：扣减后不得为负（B7）
    var short = items.filter(function (it) { return (Stock.getStock(it.name) - it.qty) < 0; });
    if (short.length) {
      return Util.toast("库存不足：" + short.map(function (it) {
        return it.name + "（剩 " + Stock.getStock(it.name) + "）";
      }).join("、"), true);
    }

    var wasEditing = !!editingId;
    var payload = {
      time: time,
      picker: pickerVal,
      dept: dept,
      note: (els.note && els.note.value || "").trim(),  // 备注非必填，纯追加字段
      purpose: purpose,
      entity: entity,                                    // 结算法人单位必填，纯追加字段（与 note 同类，不破坏 schema）
      items: items,
      photos: photos.getPhotos(),
      affectsStock: true  // 新记录才参与库存计算
    };
    if (!wasEditing) {
      payload.status = "pending";      // 新建出库记录默认「未提单」；编辑不携带 → 合并保留原值
      payload.orderNo = genOrderNo();   // 出库单自动编号（纯追加字段）
    }
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
    // 先上传照片并写回 photoUrls（首推即含图）；再统一推送
    submitPush(rec, wasEditing);
    // D1 成功动效：刷新最近提交 + 打勾涟漪（含出库单号）并滚动定位
    if (window.App.Views.landing && window.App.Views.landing.renderRecent) {
      window.App.Views.landing.renderRecent();
    }
    UI.celebrate({ orderNo: rec.orderNo || "" });
  }

  /** 异步推送：先写回 photoUrls，再推记录，确保通知含图 */
  async function submitPush(rec, wasEditing) {
    rec = await pushPhotosToCloud(rec);
    pushToCloud(rec, wasEditing ? "修改已保存，正在同步到云端…" : "登记成功，正在同步到云端…");
  }

  /** 照片上传云端（可选）：将 photos 上传到 data/photos/ 并把 photoUrls 写回本地记录；不推送记录本身。
      返回更新后的记录（含 photoUrls），无照片或失败时返回原记录。
      由 submitPush 先 await 此函数再调 pushToCloud，确保首推已含 photoUrls。 */
  async function pushPhotosToCloud(rec) {
    if (!Cloud.hasToken() || !rec) return rec;
    var photos = (rec.photos || []);
    if (!photos.length) return rec;
    try {
      var urls = await Cloud.pushPhotos(rec);
      if (urls && urls.length) {
        var updated = Records.update(rec.id, { photoUrls: urls });
        return updated || rec;
      }
    } catch (e) {}
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
    els.picker.value = "";
    selectedPurpose = "";
    renderPurposeChips();
    closePurposeAdd();
    selectedEntity = DEFAULT_ENTITY;   // 清空后回默认「深圳细胞法人」
    renderEntityChips();
    closeEntityAdd();
    els.dept.value = "";
    els.time.value = Util.nowLocal();
    els.note.value = "";
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
    els.note.value = r.note || "";
    // 编辑初始化选中态：有值则选中，无值（旧记录/导入记录）必须清空，避免先前选中态残留带出
    selectedPurpose = r.purpose || "";
    renderPurposeChips();
    selectedEntity = r.entity || DEFAULT_ENTITY;   // 旧记录无法人字段时回默认「深圳细胞法人」
    renderEntityChips();
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
