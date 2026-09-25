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
  var confirming = false;      // 2026-09-24：提交前「核对清单」弹窗是否开着（防连点弹两次）
  var confirmedOnce = false;   // 确认通过后二次进入 submit()，跳过弹窗直接写库
  var selectedPurpose = "";
  var activeTab = "todo";   // "todo"（待取货）| "shipped"（已出库）
  var submitting = false;   // 提交互斥锁：防止连点造成重复登记

  /** 登记时间戳（毫秒）。
      2026-09-13 去掉「预计取货时间」字段后新增：
        新记录用 createdAt；老记录（只有 time=预计取货时间）回退用它；再回退 _ts（最后修改时间）。 */
  function regTs(p) {
    if (!p) return 0;
    if (p.createdAt) return Number(p.createdAt) || 0;
    if (p.time) {
      var d = new Date(String(p.time).replace(" ", "T"));
      if (!isNaN(d.getTime())) return d.getTime();
    }
    return Number(p._ts) || 0;
  }

  /** 毫秒 → "YYYY-MM-DD HH:mm"（本地时区），用于列表「登记时间」列 */
  function fmtTs(ms) {
    var n = Number(ms) || 0;
    if (!n) return "-";
    var d = new Date(n);
    if (isNaN(d.getTime())) return "-";
    function p2(x) { return ("0" + x).slice(-2); }
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) +
           " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
  }

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="card">' +
        '<h2>待取货登记 <span class="tag">已提单未出库</span></h2>' +
        '<div class="grid2">' +
          '<div class="field">' +
            '<label for="pkDept">部门 / 客户<span class="req">*</span></label>' +
            '<div class="search-wrap">' +
              '<input type="text" id="pkDept" placeholder="请输入部门 / 客户" autocomplete="off" inputmode="text" enterkeyhint="next" />' +
              '<div class="suggest" id="pkDeptSuggest"></div>' +
            '</div>' +
          '</div>' +
          '<div class="field">' +
            '<label for="pkPicker">取货人<span class="req">*</span></label>' +
            '<div class="search-wrap">' +
              '<input type="text" id="pkPicker" placeholder="请输入取货人姓名" autocomplete="off" inputmode="text" enterkeyhint="next" />' +
              '<div class="suggest" id="pkPickerSuggest"></div>' +
            '</div>' +
          '</div>' +
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
        '<div class="field">' +
          '<label>货品名称<span class="req">*</span></label>' +
          '<div id="pkProductPicker"></div>' +
        '</div>' +
        '<div class="field">' +
          '<label for="pkNote">备注（可选）</label>' +
          '<textarea id="pkNote" rows="2" maxlength="500" placeholder="备注信息，如取货凭证号、联系方式等（可选）" autocomplete="off" enterkeyhint="enter"></textarea>' +
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
        '<div class="stat-cards" id="pkStats"></div>' +
        '<div class="pickups-tabs">' +
          '<button type="button" class="pickups-tab active" data-tab="todo">待取货</button>' +
          '<button type="button" class="pickups-tab" data-tab="shipped">已出库</button>' +
        '</div>' +
        '<div id="pkListBox"></div>' +
      '</div>';

    els = {
      dept: Util.$("pkDept"),
      picker: Util.$("pkPicker"),
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

    // 2026-09-24：与出库统一为「按产品名分类多选 → 最后统一步填数量」（bulkPick）
    picker = new UI.ProductPicker({ showStock: true, bulkPick: true });
    picker.attach(Util.$("pkProductPicker"));

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
    ["pkDept", "pkPicker", "pkNote"].forEach(function (id) {
      Util.$(id).addEventListener("input", saveDraft);
    });
    picker.onChange = saveDraft;

    bindTabs();
    listBox.addEventListener("click", onListClick);

    restoreDraft();

    // 自动识别回填（2026-09-26）：从「自动识别」页跳转过来时取走待填数据（取一次即清空）
    var _pend = window.App.Views.recognize && window.App.Views.recognize.takePending("pickups");
    if (_pend) fillRecognized(_pend);
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
    els.picker.value = d.picker || "";
    els.dept.value = d.dept || "";
    if (d.purpose) { selectedPurpose = d.purpose; renderPurposeChips(); }
    picker.setSelected(d.items || []);
    els.note.value = d.note || "";
  }

  function clearDraft() { Store.clearPickupsDraft(); }

  /* ---------- 提交登记 ---------- */

  /** 切换提交按钮的加载态。不改 textContent——resetForm() 不重写它 */
  function setSubmitting(on) {
    submitting = !!on;
    if (!els || !els.submit) return;
    els.submit.disabled = !!on;
    els.submit.classList.toggle("loading", !!on);
    els.submit.setAttribute("aria-busy", on ? "true" : "false");
  }

  function submit() {
    if (submitting || confirming) return;   // 连点二次直接吞掉

    var pickerVal = els.picker.value.trim();
    var dept = els.dept.value.trim();
    var purpose = selectedPurpose;

    // 一次性收集全部缺失项，字段级标红 + 滚动定位到第一处，替代「一次只弹一条 toast」
    var errs = [];
    if (!dept) errs.push({ el: els.dept, msg: "请填写部门 / 客户" });
    if (!pickerVal) errs.push({ el: els.picker, msg: "请填写取货人" });
    if (!purpose) errs.push({ el: els.purposeChips, msg: "请选择用途 / 项目" });

    var items = picker.getItems();
    var qtyProblems = picker.validateItems ? picker.validateItems() : [];
    if (!items.length) {
      errs.push({
        el: Util.$("pkProductPicker"),
        msg: qtyProblems.length ? ("请填写数量：" + qtyProblems.join("、")) : "请至少选择一项货品"
      });
    } else if (qtyProblems.length) {
      errs.push({ el: Util.$("pkProductPicker"), msg: "以下货品数量无效：" + qtyProblems.join("、") });
    }

    if (!UI.reportFieldErrors(errs, els.submit.closest(".card") || document)) return;

    // 2026-09-24：提交前「核对清单」（与出库统一口径）；确认后二次进入 submit() 跳过弹窗直接写库
    if (!confirmedOnce) {
      confirming = true;
      UI.confirmSubmit({
        title: "确认提交这单待取货？",
        okText: "确认提交",
        meta: [
          ["部门 / 客户", dept],
          ["取货人", pickerVal],
          ["用途 / 项目", purpose]
        ],
        items: items
      }).then(function (ok) {
        confirming = false;
        if (!ok) return;
        confirmedOnce = true;
        submit();
        confirmedOnce = false;
      });
      return;
    }

    setSubmitting(true);
    var pk = Pickups.create({
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
      })["finally"](function () { setSubmitting(false); });
      Util.toast("登记成功，正在同步到云端…");
    } else {
      // 令牌缺失＝只存在本机浏览器，换设备看不到。必须醒目告警，否则用户会误以为已同步。
      Util.toast("⚠️ 仅存本机，未上传云端！请联系管理员检查同步令牌", true);
      window.App.Views.app.setSyncStatus("⚠️ 未配置云端令牌，本条只存在本机，换设备看不到", true);
      setSubmitting(false);
    }
  }

  function resetForm() {
    UI.clearFieldErrors(els.submit.closest(".card") || document);
    els.picker.value = "";
    selectedPurpose = "";
    renderPurposeChips();
    closePurposeAdd();
    els.dept.value = "";
    picker.setSelected([]);
    els.note.value = "";
    clearDraft();
  }

  /* ---------- 列表渲染 ---------- */

  function renderList() {
    if (!listBox) return;
    var list = State.pickups;
    var nowMs = Date.now();
    var todo = list.filter(function (p) { return p.shipped !== true; });
    // A8 超时置顶（2026-09-13 调整）：原按「预计取货时间已过」判定，该字段已移除，
    // 现改为「登记后超过 24 小时仍未出库」→ 标红并置顶。阈值改这里一处即可。
    var OVERDUE_MS = 24 * 60 * 60 * 1000;
    todo.forEach(function (p) {
      var t = regTs(p);
      p.__overdue = !!(t && (nowMs - t) > OVERDUE_MS);
    });
    todo.sort(function (a, b) {
      return ((b.__overdue ? 1 : 0) - (a.__overdue ? 1 : 0)) || (regTs(a) - regTs(b));
    });
    var overCount = todo.filter(function (p) { return p.__overdue; }).length;
    var shipped = list.filter(function (p) { return p.shipped === true; });
    var shown = activeTab === "shipped" ? shipped : todo;
    Util.$("pkCount").textContent = shown.length + " 条" + (activeTab === "todo" && overCount ? "（超时 " + overCount + "）" : "");
    // 统计数字卡（第 12/13 轮）
    var pkStatsEl = Util.$("pkStats");
    if (pkStatsEl) {
      pkStatsEl.innerHTML =
        '<div class="stat-card">' +
          '<span class="stat-num">' + todo.length + '</span>' +
          '<span class="stat-label">待取货</span>' +
          '<span class="stat-hint">已提单但还没出库</span>' +
        '</div>' +
        '<div class="stat-card ' + (overCount ? "warn" : "ok") + '">' +
          '<span class="stat-num">' + overCount + '</span>' +
          '<span class="stat-label">已超时</span>' +
          '<span class="stat-hint">' + (overCount ? "超过约定时间还没被取走，催一下" : "没有超时的待取货") + '</span>' +
        '</div>' +
        '<div class="stat-card">' +
          '<span class="stat-num">' + shipped.length + '</span>' +
          '<span class="stat-label">已出库</span>' +
          '<span class="stat-hint">已经完成出库的待取货</span>' +
        '</div>';
    }
    if (!shown.length) {
      listBox.innerHTML = '<div class="empty">' +
        (activeTab === "shipped" ? "<b>还没有已出库的待取货</b><i>出库后会出现在这里</i>" : "<b>还没有待取货登记</b><i>在上方表单登记一单即可</i>") +
        '</div>';
      return;
    }
    var html = '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>序号</th><th>登记时间</th><th>取货人</th><th>部门/客户</th><th>货品名称</th><th>数量</th><th>出库状态</th><th>操作</th>' +
      '</tr></thead><tbody>';
    shown.forEach(function (p, i) {
      var items = (p.items || []).map(function (it, idx, arr) {
        return '<div class="item-line' + (arr.length > 1 ? " multi-line" : "") + '">' + Util.esc(it.name) + '</div>';
      }).join("");
      var qtys = (p.items || []).map(function (it, idx, arr) {
        return '<div class="item-line' + (arr.length > 1 ? " multi-line" : "") + '">' + it.qty + '</div>';
      }).join("");
      html += '<tr' + (p.__overdue ? ' style="background:rgba(201,135,127,.09)"' : '') + '>' +
        '<td><div>' + (shown.length - i) + '</div></td>' +
        '<td>' + Util.esc(fmtTs(regTs(p))) + (p.__overdue ? ' <span class="tag danger-tag">⏰ 超时</span>' : '') + '</td>' +
        '<td>' + Util.esc(p.picker || "-") + '</td>' +
        '<td>' + Util.esc(p.dept || "-") + '</td>' +
        '<td class="items-cell">' + items + '</td>' +
        '<td>' + qtys + '</td>' +
        '<td>' + shippedPill(p) + '</td>' +
        '<td>' +
          ((p.shipped !== true && p.confirmed !== true)
            ? '<button type="button" class="btn ghost sm" data-act="confirm" data-id="' + p.id + '">确认提单</button> '
            : '') +
          '<button type="button" class="btn danger sm" data-act="del" data-id="' + p.id + '">删除</button>' +
        '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    listBox.innerHTML = html;
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

  /** 确认提单：confirmed false→true（记录 confirmedAt），本地保存 + 推送云端 + 推送钉钉对比 */
  async function toggleConfirmed(id) {
    var pk = State.pickups.find(function (x) { return x.id === id; });
    if (!pk) return;
    if (pk.shipped === true) return;   // 已出库的记录提单徽章不可点击
    var ok = await UI.confirmDialog("标记为已确认提单？", "确认提单");
    if (!ok) return;
    var confirmedAt = new Date().toISOString();
    var updated = Pickups.update(id, { confirmed: true, confirmedAt: confirmedAt });
    if (!updated) { Util.toast("记录不存在", true); return; }
    renderList();
    Util.toast("已确认提单");
    if (Cloud.hasToken()) {
      try {
        await Cloud.pushPickup(updated);
        window.App.Views.app.setSyncStatus("已同步", false);
      } catch (e) {
        window.App.Views.app.setSyncStatus("云端同步失败", true);
      }
      // 推送钉钉「提单对比」消息（登记时间 vs 提单时间），失败不阻塞主流程
      try {
        await Cloud.pushNotifyFile("pickup-confirm", {
          type: "pickup-confirm",
          pickup: {
            id: updated.id,
            picker: updated.picker || "",
            dept: updated.dept || "",
            items: updated.items || [],
            time: updated.time || "",
            confirmedAt: confirmedAt
          }
        });
      } catch (e) {
        Util.toast("对比消息推送失败（可稍后重试）", true);
      }
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
  /**
   * 自动识别回填（2026-09-26）：由「自动识别」页经 Views.recognize.takePending 传入。
   * @param {{dept?:string, picker?:string, purpose?:string, items?:Array<{name:string,qty:number}>}} d
   * 注意：ProductPicker.setSelected 内部只 render、不触发 onChange，
   *       所以回填后必须手动补一次 saveDraft，否则刷新页面草稿会丢。
   */
  function fillRecognized(d) {
    if (!d || !els) return;
    if (d.dept != null) els.dept.value = d.dept;
    if (d.picker != null) els.picker.value = d.picker;
    if (d.purpose) setPurposeSelected(d.purpose);            // 内部已触发 saveDraft
    else if (!selectedPurpose) setPurposeSelected((Config.PURPOSE_PRESETS || [])[0] || "");   // 用途为必填，回填时先给预设首项
    if (d.items && d.items.length) picker.setSelected(d.items);
    saveDraft();
    var n = (d.items || []).length;
    Util.toast("已填入" + (n ? " " + n + " 项货品" : "") + "，请核对后提交");
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) { window.scrollTo(0, 0); }
  }

  window.App.Views.pickups = { render: render, refresh: refresh, doSync: doSync, fill: fillRecognized };
})();
