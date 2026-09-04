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
  /** 进入编辑时的原始照片（base64 数组）快照：提交时若照片未变则复用已有 photoUrls，避免重复上传 */
  var editingOriginalPhotos = null;
  var els = null;
  /** 提交互斥锁：防止移动端双击 / 快速连点产生重复出库单（编号也会随之错乱） */
  var submitting = false;
  /** 当前选中的用途值（chip 单选，互斥高亮） */
  var selectedPurpose = "";
  /** 出货仓库单位默认值：固定「深圳细胞法人」（2026-09-04 升级：深圳细胞 / 赛迪斯二选一，定死选项） */
  var DEFAULT_ENTITY = (Config.ENTITY_PRESETS && Config.ENTITY_PRESETS[0]) || "";
  /** 当前选中的出货仓库单位（chip 单选，互斥高亮；必填，默认深圳细胞，不记忆上次选择） */
  var selectedEntity = DEFAULT_ENTITY;

  function render(container) {
    container.innerHTML =
      '<div class="card">' +
        '<h2>出库登记 <span class="tag">基础登记</span></h2>' +
        '<div class="field">' +
          '<span class="field-label" id="outEntityLabel">出货仓库单位（已默认选择深圳细胞）<span class="req">*</span></span>' +
          '<div id="outEntityChips" class="chip-group" role="group" aria-labelledby="outEntityLabel"></div>' +
          '<div class="hint" style="margin-top:-4px">仓库二选一：所选仓库的登记数据将写入对应独立系统</div>' +
        '</div>' +
        '<div class="field">' +
          '<label for="outDept">部门 / 领取单位<span class="req">*</span></label>' +
          '<div class="search-wrap">' +
            '<input type="text" id="outDept" placeholder="请输入部门 / 领取单位" autocomplete="organization" inputmode="text" enterkeyhint="next" />' +
            '<div class="suggest" id="outDeptSuggest"></div>' +
          '</div>' +
        '</div>' +
        '<div class="grid2">' +
          '<div class="field">' +
            '<label for="outTime">领取时间<span class="req">*</span></label>' +
            '<input type="datetime-local" id="outTime" />' +
            '<div class="hint"><span class="auto" id="outFillNow">📎 自动填入当前时间</span></div>' +
          '</div>' +
          '<div class="field">' +
            '<label for="outPicker">领取人+工号/电话<span class="req">*</span></label>' +
            '<div class="search-wrap">' +
              '<input type="text" id="outPicker" placeholder="请输入领取人姓名+工号或手机" autocomplete="name" inputmode="text" enterkeyhint="next" />' +
              '<div class="suggest" id="outPickerSuggest"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="field">' +
          '<span class="field-label" id="outPurposeLabel">用途 / 项目<span class="req">*</span></span>' +
          '<div id="outPurposeChips" class="chip-group" role="group" aria-labelledby="outPurposeLabel"></div>' +
          '<div class="purpose-add-row">' +
            '<button type="button" class="chip-add" id="outPurposeAdd">+ 添加</button>' +
            '<span class="purpose-add-inline" id="outPurposeAddInline" style="display:none;">' +
              '<input type="text" id="outPurposeInput" class="purpose-add-input" placeholder="输入自定义用途" maxlength="30" autocomplete="off" enterkeyhint="done" aria-label="自定义用途 / 项目" />' +
              '<button type="button" class="btn mini" id="outPurposeOk">确定</button>' +
              '<button type="button" class="btn ghost mini" id="outPurposeCancel">取消</button>' +
            '</span>' +
          '</div>' +
        '</div>' +
        '<div class="field">' +
          '<span class="field-label" id="outProductLabel">货物名称<span class="req">*</span></span>' +
          '<div id="outProductPicker" role="group" aria-labelledby="outProductLabel"></div>' +
        '</div>' +
        '<div class="field">' +
          '<label for="outNote">备注（<small style="color:var(--ink-500);font-weight:400;">如有特殊情况请备注，如暂借、先借后还等</small>）</label>' +
          '<textarea id="outNote" rows="2" maxlength="500" placeholder="如有任何补充说明…" autocomplete="off" enterkeyhint="enter"></textarea>' +
        '</div>' +
        '<div class="field">' +
          '<label>现场照片（选填）</label>' +
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

    // Enter 键：在普通文本框内按回车 → 跳到下一个待填字段，而不是提交整单（避免误触）。
    // 货品搜索框的 Enter 由 ProductPicker 自行处理（选中候选项，兼容扫码枪），此处放行。
    container.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" || ev.defaultPrevented) return;
      var t = ev.target;
      if (!t || t.tagName !== "INPUT") return;
      if (t.type === "textarea" || t.classList.contains("search")) return;
      if (t.classList.contains("purpose-add-input")) return;   // 已有各自的确认逻辑
      if (t.classList.contains("qty")) { ev.preventDefault(); t.blur(); return; }
      ev.preventDefault();
      var focusables = container.querySelectorAll('input:not([type=hidden]):not([disabled]), textarea');
      var arr = Array.prototype.slice.call(focusables).filter(function (n) { return n.offsetParent !== null; });
      var i = arr.indexOf(t);
      if (i > -1 && i < arr.length - 1) arr[i + 1].focus();
      else t.blur();
    });

    // 用户开始修正时立即撤掉该字段的错误标注，避免「已改好但仍标红」的割裂感
    function dismissErrorAt(target) {
      var f = target && target.closest ? target.closest(".field.has-error") : null;
      if (!f) return;
      f.classList.remove("has-error");
      var tip = f.querySelector(":scope > .field-error");
      if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
      if (target.removeAttribute) target.removeAttribute("aria-invalid");
    }
    container.addEventListener("input", function (ev) { dismissErrorAt(ev.target); });
    container.addEventListener("click", function (ev) {
      // chip 选择、货品选择等非 input 交互
      if (ev.target && ev.target.closest && ev.target.closest(".chip, .suggest div, .sel-item")) {
        dismissErrorAt(ev.target);
      }
    });

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

    // 出货仓库单位 chip 单选：事件委托（互斥高亮）；选项固定二选一（深圳细胞/赛迪斯），无「+ 添加」
    els.entityChips.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest(".chip") : null;
      if (!btn) return;
      setEntitySelected(btn.getAttribute("data-val") || "");
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

  /** 组装「出货仓库单位」chip 选项：固定二选一（深圳细胞/赛迪斯），不可自定义新增；
      编辑历史旧记录若含自定义法人值，临时回显该值以便原样保存或切回固定两项。 */
  function getEntityOptions() {
    var out = (Config.ENTITY_PRESETS || []).slice();
    if (selectedEntity && out.indexOf(selectedEntity) === -1) out.push(selectedEntity);
    return out;
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

  /* 自定义「+ 添加」入口已移除：出货仓库单位固定二选一（深圳细胞/赛迪斯，见 getEntityOptions） */

  /** 历史补全（部门 / 领取人）
   *  2026-08-11 升级：合并「本地提交历史(lcoalStorage)」+「仓库所有登记记录中的字段全集(State.list)」
   *  全用户共享，新设备/清缓存后 也能看到全公司以往填过的 dept/picker。去重、本地优先。*/
  function setupHistorySuggest(inputId, suggestId, historyKey) {
    var inp = Util.$(inputId), sug = Util.$(suggestId);
    var field = historyKey === Config.PICKER_HISTORY_KEY ? "picker" : "dept";
    function getEffectiveHistory() {
      var local = Store.getHistory(historyKey) || [];
      var global = (State.list || [])
        .filter(function (r) { return r && typeof r[field] === "string" && r[field].trim(); })
        .map(function (r) { return r[field].trim(); });
      var seen = new Set();
      var merged = [];
      local.concat(global).forEach(function (v) {
        if (typeof v === "string" && v.trim() && !seen.has(v)) {
          seen.add(v);
          merged.push(v);
        }
      });
      return merged;
    }
    function render() {
      var q = inp.value.trim().toLowerCase();
      if (!q) { sug.style.display = "none"; return; }
      var matches = getEffectiveHistory().filter(function (v) { return v.toLowerCase().includes(q); });
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
    var today = Util.todayLocal();   // 统一走 Util，避免各文件各写一份补零逻辑
    var count = (State.list || []).filter(function (r) {
      return (r.type || "out") !== "in" && (r.time || "").indexOf(today) === 0;
    }).length;
    var seq = count + 1;
    return "ORD-" + today.replace(/-/g, "") + "-" + (seq >= 1000 ? String(seq) : ("00" + seq).slice(-3));
  }

  /** 切换提交按钮的加载态。注意不要改 textContent——resetForm() 会把它重置为「提交登记」 */
  function setSubmitting(on) {
    submitting = !!on;
    if (!els || !els.submit) return;
    els.submit.disabled = !!on;
    els.submit.classList.toggle("loading", !!on);
    els.submit.setAttribute("aria-busy", on ? "true" : "false");
  }

  function submit() {
    if (submitting) return;   // 连点二次直接吞掉

    var time = els.time.value;
    var pickerVal = els.picker.value.trim();
    var purpose = getPurposeSelected();
    var entity = getEntitySelected();
    var dept = els.dept.value.trim();

    // 一次性收集全部缺失项，字段级标红 + 滚动定位到第一处，替代「一次只弹一条 toast」
    var errs = [];
    if (!entity) errs.push({ el: els.entityChips, msg: "请选择出货仓库单位" });
    if (!dept) errs.push({ el: els.dept, msg: "请填写部门 / 领取单位" });
    if (!time) errs.push({ el: els.time, msg: "请填写领取时间" });
    if (!pickerVal) errs.push({ el: els.picker, msg: "请填写领取人" });
    if (!purpose) errs.push({ el: els.purposeChips, msg: "请选择用途 / 项目" });

    var items = picker.getItems();
    var qtyProblems = picker.validateItems ? picker.validateItems() : [];
    if (!items.length) {
      errs.push({
        el: Util.$("outProductPicker"),
        msg: qtyProblems.length ? ("请填写数量：" + qtyProblems.join("、")) : "请至少选择一项货品"
      });
    } else if (qtyProblems.length) {
      errs.push({ el: Util.$("outProductPicker"), msg: "以下货品数量无效：" + qtyProblems.join("、") });
    }

    if (!UI.reportFieldErrors(errs, els.submit.closest(".card") || document)) {
      return;
    }

    // 库存下限校验：扣减后不得为负（B7）。属聚合信息，保留 toast，同时给货品区标红。
    var short = items.filter(function (it) { return (Stock.getStock(it.name) - it.qty) < 0; });
    if (short.length) {
      var shortMsg = "库存不足：" + short.map(function (it) {
        return it.name + "（剩 " + Stock.getStock(it.name) + "）";
      }).join("、");
      UI.reportFieldErrors([{ el: Util.$("outProductPicker"), msg: shortMsg }], els.submit.closest(".card") || document);
      Util.toast(shortMsg, true);
      return;
    }

    setSubmitting(true);
    var wasEditing = !!editingId;
    // 照片去重后再入库：同一张照片重复选中/重复压缩只保留一份（P4 防重复上传）
    var photoList = dedupePhotos(photos.getPhotos());
    if (photos.getPhotos().length !== photoList.length) {
      Util.toast("⚠️ 检测到重复照片，已自动去重", true);
      photos.setPhotos(photoList);
    }
    var payload = {
      time: time,
      picker: pickerVal,
      dept: dept,
      note: (els.note && els.note.value || "").trim(),  // 备注非必填，纯追加字段
      purpose: purpose,
      entity: entity,                                    // 结算法人单位必填，纯追加字段（与 note 同类，不破坏 schema）
      items: items,
      photos: photoList,
      affectsStock: true  // 新记录才参与库存计算
    };
    if (!wasEditing) {
      payload.status = "pending";      // 新建出库记录默认「未提单」；编辑不携带 → 合并保留原值
      payload.orderNo = genOrderNo();   // 出库单自动编号（纯追加字段）
    }
    var rec;
    if (editingId) {
      rec = Records.update(editingId, payload);
      if (!rec) { Util.toast("记录不存在", true); setSubmitting(false); return; }
    } else {
      rec = Records.create(payload);
    }
    Store.addHistory(Config.DEPT_HISTORY_KEY, dept);
    Store.addHistory(Config.PICKER_HISTORY_KEY, pickerVal);
    resetForm();
    // 先上传照片并写回 photoUrls（首推即含图）；再统一推送。
    // submitPush 是 async，无论成功/失败/无令牌早退，都要在 finally 里解锁。
    submitPush(rec, wasEditing)["catch"](function () {})["finally"](function () { setSubmitting(false); });
    // D1 成功动效：刷新最近提交 + 打勾涟漪（含出库单号）并滚动定位
    if (window.App.Views.landing && window.App.Views.landing.renderRecent) {
      window.App.Views.landing.renderRecent();
    }
    UI.celebrate({ orderNo: rec.orderNo || "" });
  }

  /** 异步推送：先写回 photoUrls，再推记录，确保通知含图。
      P1 修复：照片上传失败绝不能阻断记录推送。
      旧逻辑 `rec = await pushPhotosToCloud(rec)` 一旦抛异常（弱网/配额/超时），
      后续 pushToCloud 被整个跳过 → 照片已进仓库、记录 JSON 却没推 →
      系统里看不到这单、钉钉也收不到，且本地与云端就此分叉。
      现在改为：照片环节整体 try/catch，失败也照常推记录，失败照片走本机补传队列。 */
  async function submitPush(rec, wasEditing) {
    var finalRec = rec;
    try {
      finalRec = (await pushPhotosToCloud(rec)) || rec;
    } catch (e) {
      Util.toast("⚠️ 照片上传失败，记录仍会照常保存（照片可到「云同步」页补传）", true);
      finalRec = rec;
    }
    pushToCloud(finalRec, wasEditing ? "修改已保存，正在同步到云端…" : "登记成功，正在同步到云端…");
  }

  /** 照片上传云端（可选）：将 photos 上传到 data/photos/ 并把 photoUrls 写回本地记录；不推送记录本身。
      返回更新后的记录（含 photoUrls），无照片或失败时返回原记录。
      失败照片不静默：toast 明确提示 + 入本机补传队列（云同步页可补传），dataURL 保留不丢。
      由 submitPush 先 await 此函数再调 pushToCloud，确保首推已含 photoUrls。
      P4 修复：编辑场景照片未变时，复用已有 photoUrls，不重复上传——
      旧逻辑每次编辑都重新上传全部照片生成新 URL，叠加旧版 mergeAndSort 的 photoUrls 并集
      → 钉钉推送同一张图出现两份。 */
  async function pushPhotosToCloud(rec) {
    if (!Cloud.hasToken() || !rec) return rec;
    var photos = dedupePhotos(rec.photos || []);
    if (!photos.length) {
      // 照片已清空：同步清掉 photoUrls，否则钉钉/记录仍展示已删除的旧图
      var emptyRec = Records.update(rec.id, { photoUrls: [] });
      return emptyRec || rec;
    }
    if (Cloud.getRate && Cloud.getRate().low) {
      Util.toast("⚠️ API 配额紧张，照片可能上传较慢或失败；失败可到「云同步」页补传", true);
    }
    // 编辑场景且照片数组与进入编辑时完全一致（用户没动照片）→ 直接复用已有 photoUrls
    if (editingOriginalPhotos && photosEqual(photos, editingOriginalPhotos)) {
      var oldUrls = (rec.photoUrls || []).filter(function (u) { return u; });
      if (oldUrls.length >= photos.length) {
        var keptRec = Records.update(rec.id, { photoUrls: oldUrls.slice(0, photos.length) });
        return keptRec || rec;
      }
    }
    var r = await Cloud.pushPhotosDetailed(Object.assign({}, rec, { photos: photos }));
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

  /** base64 去重：同一照片被重复选中/重复压缩时只保留一份，杜绝上传重复图 */
  function dedupePhotos(arr) {
    var out = [];
    (arr || []).forEach(function (src) {
      if (src && out.indexOf(src) === -1) out.push(src);
    });
    return out;
  }

  /** 比较两组照片 base64 是否完全一致（用户编辑时是否动过照片） */
  function photosEqual(a, b) {
    if ((a || []).length !== (b || []).length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
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
        // 失败可见（P1）：明确提示数量 + 指引去「云同步 → 一键重推」，而不是模糊的"稍后自动补推"
        window.App.Views.app.setSyncStatus("⚠️ " + remain + " 条未推上云端（已存本机队列），可在「云同步」页一键重推", true);
        Util.toast("⚠️ 有 " + remain + " 条记录未同步到云端，已存本机队列；打开「管理 → 云同步 → 一键重推」即可补推", true);
        return;
      }
      if (r.pushed) watchWpsReceipt(rec);
    }).catch(function (e) {
      window.App.Views.app.setSyncStatus("云端同步失败：" + e.message + "（已存本机队列，可在「云同步」页一键重推）", true);
      Util.toast("⚠️ 云端同步失败：" + e.message + "，已存本机队列，可在「云同步」页一键重推", true);
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
    selectedEntity = DEFAULT_ENTITY;   // 清空后回默认「深圳细胞」
    renderEntityChips();
    els.dept.value = "";
    els.time.value = Util.nowLocal();
    els.note.value = "";
    picker.setSelected([]);
    photos.setPhotos([]);
    editingId = null;
    editingOriginalPhotos = null;
    els.submit.textContent = "提交登记";
    els.cancelEdit.style.display = "none";
    UI.clearFieldErrors(els.submit.closest(".card") || document);
    clearDraft();
  }

  /** 编辑已有出库记录（由记录管理模块调用） */
  function edit(id) {
    var r = State.list.find(function (x) { return x.id === id; });
    if (!r) return;
    editingId = id;
    editingOriginalPhotos = (r.photos || []).slice();   // 记录编辑前的照片快照（编辑时复用 photoUrls 的依据）
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
