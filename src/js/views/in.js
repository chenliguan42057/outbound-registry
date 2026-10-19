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
  var Formkit = window.App.Formkit;

  var picker = null;
  var confirming = false;      // 2026-09-24：提交前「核对清单」弹窗是否开着（防连点弹两次）
  var confirmedOnce = false;   // 确认通过后二次进入 submit()，跳过弹窗直接写库
  var photos = null;
  var editingId = null;
  var els = null;
  var submitting = false;   // 提交互斥锁：防止连点造成重复入库
  var optimisticNotified = false;   // 顺捷感一：乐观 UI 已弹过提示，后台推送就不再重复弹
  /** 2026-09-29：本单是否来自「自动识别」回填 —— 提交成功后补推一条钉钉确认。取一次即清，
      避免用户在识别填入后又手动登记时被误标成「自动识别」。值为 "in"（=本视图类型）。 */
  var recognizeConfirm = null;
  var sourceVal = "";       // 当前选中的入库来源
  /** 2026-10-18：入库去向 —— "wh" = 进仓库锁定（默认），"site" = 直接进现场库存。
      默认锁进仓库，是主理人定稿口径：货到先整箱上架，要出库时才「转入现场」，
      避免现场账面数字虚高（现场的每一件都必须是随时能拿走的）。 */
  var zoneVal = "wh";
  /** 2026-10-19：本单里「其中转入现场」的数量 {货品名: 数量}。
      只在「仓库锁定」模式下有意义：填了 = 这部分直接从仓库转到现场（立即可出库），
      不填 / 0 = 全部锁在仓库。用途是省掉「先入库、再回仪表盘逐项转入现场」这一步。 */
  var moveMap = {};
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
          '<label>入库去向<span class="req">*</span></label>' +
          '<div class="iz-seg" id="inZoneSeg">' +
            '<button type="button" class="iz-btn on" data-zone="wh"><i>🏬</i>仓库锁定</button>' +
            '<button type="button" class="iz-btn" data-zone="site"><i>🏪</i>现场库存</button>' +
          '</div>' +
          '<div class="iz-hint" id="inZoneHint"></div>' +
          '<div class="zm-wrap" id="inZoneMove" style="display:none"></div>' +
        '</div>' +
        '<div class="field">' +
          '<label for="inPurpose">用途 / 补充说明</label>' +
          '<input type="text" id="inPurpose" placeholder="例如：采购订单号、活动名称、备注等（选填）" maxlength="60" autocomplete="off" inputmode="text" enterkeyhint="done" />' +
        '</div>' +
        '<div class="field">' +
          '<label for="inHandler">经办人<span class="req">*</span></label>' +
          '<input type="text" id="inHandler" placeholder="谁经手的入库（默认带出上次）" maxlength="20" autocomplete="off" inputmode="text" enterkeyhint="next" />' +
          '<div class="suggest" id="inHandlerSuggest"></div>' +
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
      form: container,                 // 草稿提示条挂点（P2）
      purpose: Util.$("inPurpose"),
      handler: Util.$("inHandler"),
      submit: Util.$("inSubmit"),
      reset: Util.$("inReset"),
      cancelEdit: Util.$("inCancelEdit"),
      preview: Util.$("inPreview"),
      srcBox: Util.$("inSourceChips"),
      srcCustom: Util.$("inSourceCustom"),
      zoneSeg: Util.$("inZoneSeg"),
      zoneHint: Util.$("inZoneHint"),
      zoneMove: Util.$("inZoneMove")
    };

    // 经办人默认带出上次值
    try { var _lh = localStorage.getItem("outbound_in_last_handler"); if (_lh) Util.$("inHandler").value = _lh; } catch (e) {}

    // 2026-09-24：与出库统一为「按产品名分类多选 → 最后统一步填数量」（bulkPick）
    picker = new UI.ProductPicker({
      showInStock: true,
      showStock: false,
      bulkPick: true,
      placeholder: "搜索并选择货品（可多选，每个单独填数量）"
    });
    picker.attach(Util.$("inProductPicker"));
    photos = new UI.PhotoUpload({});
    photos.attach(Util.$("inPhotoUpload"));
    // 2026-09-26 P2：拍照上传引导
    if (Formkit && Formkit.photoGuide) Formkit.photoGuide(Util.$("inPhotoUpload"));

    // 2026-09-26 P2：经办人历史补全（全部入库记录里填过的人，键盘可选）
    if (Formkit && Formkit.bindSuggest) {
      var _inpH = Util.$("inHandler"), _sugH = Util.$("inHandlerSuggest");
      Formkit.bindSuggest(_inpH, _sugH, {
        source: function () {
          var seen = {}, out = [];
          (State.list || []).forEach(function (r) {
            var v = r && (r.handler || r.picker);
            if (typeof v === "string" && v.trim() && !seen[v]) { seen[v] = 1; out.push(v.trim()); }
          });
          try {
            var lh = localStorage.getItem("outbound_in_last_handler");
            if (lh && !seen[lh]) out.unshift(lh);
          } catch (e) {}
          return out;
        },
        max: 8,
        showOnFocus: true,
        onPick: saveDraft
      });
    }

    Util.$("inReset").addEventListener("click", resetForm);
    Util.$("inCancelEdit").addEventListener("click", function () { resetForm(); Util.toast("已取消编辑"); });
    Util.$("inSubmit").addEventListener("click", submit);

    Util.$("inPurpose").addEventListener("input", saveDraft);
    picker.onChange = function () { renderZoneMove(); saveDraft(); renderPreview(); };
    photos.onChange = saveDraft;
    // 来源自定义：点按钮或回车即保存入库（自动持久化到本仓自定义来源库）
    Util.$("inSourceAdd").addEventListener("click", addCustomSource);
    Util.$("inSourceCustom").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); addCustomSource(); }
    });
    // 入库去向：仓库锁定 / 现场库存（默认仓库锁定，2026-10-18）
    if (els.zoneSeg) {
      els.zoneSeg.addEventListener("click", function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest(".iz-btn") : null;
        if (!b) return;
        var z = b.getAttribute("data-zone");
        if (z !== "wh" && z !== "site") return;
        if (z === zoneVal) return;
        zoneVal = z;
        renderZoneSeg();
        renderZoneMove();
        renderPreview();
        saveDraft();
      });
    }
    /* 「其中转入现场」（2026-10-19）：事件委托到容器，重绘不叠加监听；
       input 时只改状态+刷预览，不重绘这块，否则光标会跑。 */
    if (els.zoneMove) {
      els.zoneMove.addEventListener("input", onMoveInput);
      els.zoneMove.addEventListener("click", onMoveClick);
    }
    renderSourceChips();
    renderZoneSeg();
    renderZoneMove();
    renderPreview();
    var _d = restoreDraft();
    if (_d) showDraftBar(_d);

    // 自动识别回填（2026-09-26）：从「自动识别」页跳转过来时取走待填数据（取一次即清空）
    var _pendIn = window.App.Views.recognize && window.App.Views.recognize.takePending("in");
    if (_pendIn) fillRecognized(_pendIn);
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

  /** 入库去向分段控件（2026-10-18）：仓库锁定（默认）/ 现场库存 */
  function renderZoneSeg() {
    var seg = els && els.zoneSeg;
    if (!seg) return;
    var btns = seg.querySelectorAll(".iz-btn");
    for (var i = 0; i < btns.length; i++) {
      var z = btns[i].getAttribute("data-zone");
      if (z === zoneVal) btns[i].classList.add("on");
      else btns[i].classList.remove("on");
    }
    if (els.zoneHint) {
      els.zoneHint.innerHTML = (zoneVal === "wh")
        ? '先<b>整箱锁进仓库</b>；急用的在下面填「转现场」数量，填多少就当场多少可出库，不填=全锁仓库。'
        : '<b>直接进现场</b>，立即可出库——适合临时到货、当天就要发的货。';
    }
  }

  /** 本单某货品「其中转入现场」的数量（已按入库量夹紧，绝不大于入库数） */
  function moveOf(name, qty) {
    var q = Math.max(0, Math.round(Number(qty) || 0));
    var m = Math.round(Number(moveMap[name]) || 0);
    if (!isFinite(m) || m < 0) m = 0;
    if (m > q) m = q;
    return m;
  }

  /** 收集提交用的 {货品: 转现场数量}；只有「仓库锁定」模式才有意义 */
  function collectMoves(items) {
    var out = {};
    if (zoneVal !== "wh") return out;
    (items || []).forEach(function (it) {
      var m = moveOf(it.name, it.qty);
      if (m > 0) out[it.name] = m;
    });
    return out;
  }

  /** 「其中转入现场」小表（2026-10-19）：只在「仓库锁定 + 已选货品」时出现。
      每行一个已选货品，填多少 = 这部分直接进现场；现场低于警示线的给一个建议值，一键填。 */
  function renderZoneMove() {
    var box = els && els.zoneMove;
    if (!box) return;
    var items = picker ? picker.getItems() : [];
    if (zoneVal !== "wh" || !items.length) {
      box.style.display = "none";
      box.innerHTML = "";
      return;
    }
    var Z = window.App.Zones;
    var rows = items.map(function (it) {
      var name = it.name;
      var qty = Math.max(0, Math.round(Number(it.qty) || 0));
      var mv = moveOf(name, qty);
      moveMap[name] = mv;
      var site = null, wa = null;
      try {
        if (Z && Z.siteStock) { site = Z.siteStock(name); wa = Z.warnAt(name); }
      } catch (e) { site = null; }
      var sug = (site !== null && wa !== null && site < wa)
        ? Math.max(1, Math.min(qty, wa - site)) : 0;
      var tip = "";
      /* 只在「现场低于警示线」时提示（红字）——现场够用时不必占一行，预览区已经写了现场数 */
      if (site !== null && wa !== null && site < wa) {
        tip = '<span class="zm-warn" title="现场低于警示线，出库前需要先转一部分进来">现场 ' + site + ' ＜ 警示线 ' + wa + '</span>';
      }
      return '<div class="zm-row" data-name="' + Util.esc(name) + '">' +
          '<span class="zm-name" title="' + Util.esc(name) + '">' + Util.esc(name) + '</span>' +
          '<span class="zm-qty">入库 ' + qty + '</span>' +
          '<input type="number" class="zm-in" data-name="' + Util.esc(name) + '" data-max="' + qty + '"' +
            ' min="0" max="' + qty + '" step="1" inputmode="numeric" enterkeyhint="done"' +
            ' placeholder="0" value="' + (mv > 0 ? mv : "") + '"' +
            ' aria-label="' + Util.esc(name) + ' 转入现场数量" />' +
          '<span class="zm-unit">个转现场</span>' +
          (sug > 0
            ? '<button type="button" class="zm-sug" data-name="' + Util.esc(name) + '" data-sug="' + sug + '"' +
              ' title="按警示线补到 ' + wa + '（现场还差 ' + (wa - site) + '）">用建议 ' + sug + '</button>'
            : '<span></span>') +
          tip +
        '</div>';
    }).join("");
    box.innerHTML =
      '<div class="zm-head">其中转入现场 <span class="zm-sub">（选填 · 不填 = 全部锁在仓库）</span></div>' +
      rows;
    box.style.display = "";
  }

  /** 输入「转现场」数量：夹紧到 0~入库量，只刷预览不重绘本块（否则光标会跳） */
  function onMoveInput(ev) {
    var inp = ev.target;
    if (!inp || !inp.classList || !inp.classList.contains("zm-in")) return;
    var name = inp.getAttribute("data-name");
    var max = Math.round(Number(inp.getAttribute("data-max")) || 0);
    var raw = String(inp.value || "").replace(/[^\d]/g, "");
    var v = raw === "" ? 0 : Math.round(Number(raw));
    if (!isFinite(v) || v < 0) v = 0;
    if (v > max) { v = max; inp.value = String(v); }
    moveMap[name] = v;
    renderPreview();
    saveDraft();
  }

  /** 「用建议 N」：按警示线一键填 */
  function onMoveClick(ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest(".zm-sug") : null;
    if (!b || !els.zoneMove) return;
    var name = b.getAttribute("data-name");
    var sug = Math.round(Number(b.getAttribute("data-sug")) || 0);
    if (!name || !(sug > 0)) return;
    moveMap[name] = sug;
    var ins = els.zoneMove.querySelectorAll(".zm-in");
    for (var i = 0; i < ins.length; i++) {
      if (ins[i].getAttribute("data-name") === name) ins[i].value = String(sug);
    }
    renderPreview();
    saveDraft();
  }

  /** 库存变化预览：当前库存 → 入库后 */
  function renderPreview() {
    var items = picker.getItems();
    if (!items.length) { els.preview.innerHTML = ""; els.preview.style.display = "none"; return; }
    var rows = items.map(function (it) {
      var cur = window.App.Stock.getStock(it.name);
      var q = Number(it.qty) || 0;
      var after = cur + q;
      /* 现场数变化：进仓库锁定时现场只加「其中转入现场」那部分；
         直接进现场时现场 +qty。用 Zones.siteStock 取，与仪表盘「现场可用」严格同口径。 */
      var siteNow = null, siteAfter = null;
      try {
        if (window.App.Zones && window.App.Zones.siteStock) {
          siteNow = window.App.Zones.siteStock(it.name, cur);
          siteAfter = (zoneVal === "wh") ? siteNow + moveOf(it.name, q) : siteNow + q;
        }
      } catch (e) { siteNow = null; }
      return '<div class="preview-row">' +
        '<span>' + Util.esc(it.name) + '</span>' +
        '<span class="preview-cur">当前 ' + cur + '</span>' +
        '<span class="preview-arrow">→</span>' +
        '<span class="preview-after">入库后 ' + after + '</span>' +
        (siteNow === null ? '' :
          '<span class="preview-site">现场 ' + siteNow + (siteAfter === siteNow ? '（不变）' : ' → ' + siteAfter) + '</span>') +
      '</div>';
    }).join("");
    els.preview.innerHTML = '<div class="preview-title">库存变化预览' +
      '<span class="iz-tag' + (zoneVal === "wh" ? "" : " site") + '">' +
      (zoneVal === "wh" ? '🏬 进仓库锁定' : '🏪 进现场库存') + '</span></div>' + rows;
    els.preview.style.display = "block";
  }

  function saveDraft() {
    if (editingId) return;
    Store.saveDraft("in", {
      _t: Date.now(),               // 草稿保存时刻（P2 提示条用）
      purpose: els.purpose.value,
      source: sourceVal,
      zone: zoneVal,
      zoneMove: collectMoves(picker.getItems()),
      items: picker.selected,
      photos: photos.getPhotos()
    });
  }

  /** 恢复草稿（P2：返回草稿对象，供调用方显示提示条） */
  function restoreDraft() {
    var d = Store.loadDraft("in");
    if (!d) return null;
    els.purpose.value = d.purpose || "";
    sourceVal = d.source || "";
    zoneVal = (d.zone === "site") ? "site" : "wh";
    moveMap = {};
    if (d.zoneMove && typeof d.zoneMove === "object") {
      Object.keys(d.zoneMove).forEach(function (k) { moveMap[k] = Math.round(Number(d.zoneMove[k]) || 0); });
    }
    picker.setSelected(d.items || []);
    photos.setPhotos(d.photos || []);
    renderPreview();
    renderSourceChips();
    renderZoneSeg();
    renderZoneMove();
    return d;
  }

  /** 草稿摘要（P2 提示条） */
  function draftSummary(d) {
    if (!d) return "";
    var n = (d.items || []).length;
    var parts = [];
    if (n) parts.push("货品 " + n + " 项");
    if (d.source) parts.push(d.source);
    if (d.purpose) parts.push(d.purpose);
    return parts.join(" · ") || "（有内容）";
  }

  /** 显示草稿提示条（P2） */
  function showDraftBar(d) {
    if (!d || !Formkit || !els || !els.form) return;
    Formkit.draftBar({
      host: els.form,
      savedAt: d._t || 0,
      summary: draftSummary(d),
      onClear: function () { clearDraft(); resetForm(); Util.toast("草稿已清空"); }
    });
  }

  function clearDraft() {
    Store.clearDraft("in");
    if (Formkit && els && els.form) Formkit.clearDraftBar(els.form);
  }

  /** 切换提交按钮的加载态。不改 textContent——resetForm()/edit() 会重写它 */
  function setSubmitting(on) {
    submitting = !!on;
    if (!els || !els.submit) return;
    els.submit.disabled = !!on;
    els.submit.classList.toggle("loading", !!on);
    els.submit.setAttribute("aria-busy", on ? "true" : "false");
  }

  function submit() {
    if (submitting || confirming) return;   // 连点二次直接吞掉

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

    /* 2026-10-19：本单里「其中转入现场」的数量（选填）。合计只用于核对清单展示。 */
    var moveVals = collectMoves(items);
    var moveTotal = 0;
    Object.keys(moveVals).forEach(function (k) { moveTotal += moveVals[k]; });
    var zoneLabel = (zoneVal === "wh")
      ? ("🏬 进仓库锁定" + (moveTotal > 0 ? "，其中 " + moveTotal + " 个当场转现场" : "（现场不变）"))
      : "🏪 直接进现场库存";

    // 2026-09-24：提交前「核对清单」（与出库统一口径）；确认后二次进入 submit() 跳过弹窗直接写库
    if (!confirmedOnce) {
      confirming = true;
      UI.confirmSubmit({
        title: "确认提交这单入库？",
        okText: "确认入库",
        meta: [
          ["经办人", handlerVal],
          ["入库来源", editingTransfer ? "（调拨自动带入，不可改）" : (sourceVal || "")],
          ["入库去向", zoneLabel]
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
    var purpose = els.purpose.value.trim();
    var wasEditing = !!editingId;
    var zSel = zoneVal;          // 去向：wh = 进仓库锁定 / site = 进现场
    var payload = {
      /* 2026-09-29：来源标记落进记录本身（口径同出库），供后续状态确认时补推钉钉 */
      fromRecognize: !!recognizeConfirm,
      time: Util.nowLocal(),
      type: "in",
      items: items,
      purpose: purpose,
      picker: handlerVal,
      photos: photos.getPhotos(),
      /* 2026-10-18：入库去向（wh/site）随记录落库，删单/编辑时据此冲抵仓库锁定 */
      zone: zSel,
      /* 2026-10-19：其中转入现场的数量（选填，空 = 全部锁仓库）。
         存进记录是为了编辑回显、详情展示；实际锁定按「入库量 − 转入现场」计算。 */
      zoneMove: Object.keys(moveVals).length ? moveVals : null
      // 2026-09-29 加固：affectsStock 不再恒写 true，见下方分支（仅新建时给 true）。
      // 否则编辑一条历史上非库存单会把它强行纳入库存计算 → 凭空增减。
    };
    if (!wasEditing) payload.affectsStock = true;  // 仅新记录参与库存计算
    if (sourceVal) payload.source = sourceVal;   // 来源写入记录本体 → 列表/报表按来源筛选用
    try { localStorage.setItem("outbound_in_last_handler", handlerVal); } catch (e) {}
    var rec;
    if (editingId) {
      rec = Records.update(editingId, payload);
      if (!rec) { Util.toast("记录不存在", true); setSubmitting(false); return; }
    } else {
      rec = Records.create(payload);
    }
    syncZoneLock(rec, zSel, handlerVal, wasEditing);
    resetForm();
    // 顺捷感一（乐观 UI）：本地已落库 = 这件事已经成了，不必等云端回话。
    // 立刻解锁按钮、给提示、把记录放进同步队列（列表行会显示转圈），云端推送转后台慢慢跑。
    // 云端失败时队列会留着，云同步页一键重推即可，数据不会丢。
    if (Util.feature("optimistic")) {
      optimisticNotified = true;
      if (Cloud.enqueue) Cloud.enqueue(rec.id);
      setSubmitting(false);
      Util.toast(wasEditing ? "✅ 修改已保存（本地已生效，云端后台同步中）" : "✅ 入库成功（本地已生效，云端后台同步中）");
    }
    // 先上传照片并写回 photoUrls（首推即含图）；再统一推送。
    // submitPush 是 async，无论成功/失败/无令牌早退，都要在 finally 里解锁。
    submitPush(rec, wasEditing)["catch"](function () {})["finally"](function () { setSubmitting(false); });
  }

  /** 一条入库记录「应锁进仓库」的明细 = 入库量 − 其中转入现场的量。
      2026-10-19：填了「转现场」，就只有剩下的部分需要锁进仓库（那部分已天然留在现场）。 */
  function lockItemsOf(rec) {
    var mv = (rec && rec.zoneMove) || {};
    return ((rec && rec.items) || []).map(function (it) {
      var q = Math.max(0, Math.round(Number(it.qty) || 0));
      var m = Math.max(0, Math.min(q, Math.round(Number(mv[it.name]) || 0)));
      return { name: it.name, qty: q - m };
    });
  }

  /** 把「入库去向」落成仓库锁定事件（2026-10-18，主理人需求）。
      「进现场」→ 什么都不写：入库记录本身让总库存 +qty，现场数自然跟着涨（原口径不变）。
      「进仓库锁定」→ 按记录 id 打 ref 写一条 to_wh：总库存照样 +qty、仓库锁定也 +qty，
                      两相抵消 → 现场数不动，货算在仓库里。
                      2026-10-19：只锁「入库量 − 其中转入现场」，转过去的那部分现场立刻可用。
      幂等：重复提交/改为进现场/删单，都由 Zones.reconcileInbound 按差额冲抵，不会写重复锁定。 */
  function syncZoneLock(rec, zSel, operator, wasEditing) {
    if (!rec || !rec.id) return;
    var Z = window.App.Zones;
    if (!Z || !Z.reconcileInbound) return;
    try {
      var mvSum = 0;
      var _mv = (rec.zoneMove || {});
      Object.keys(_mv).forEach(function (k) { mvSum += Math.round(Number(_mv[k]) || 0); });
      Z.reconcileInbound(rec.id, zSel === "wh" ? lockItemsOf(rec) : [], {
        note: (sourceVal ? sourceVal + " · " : "") + (zSel === "wh" ? "入库锁定" : "入库进现场") +
          (zSel === "wh" && mvSum > 0 ? "（其中 " + mvSum + " 转现场）" : ""),
        operator: operator || "",
        /* 新建时把事件时间对齐到记录时间，现场流水里「当时剩余」才不会错位；
           编辑时用当前时间，避免把冲抵事件塞回过去、被之后的「设定仓库数」抹掉。 */
        ts: wasEditing ? 0 : (Number(rec._ts) || 0)
      });
    } catch (e) {}
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
    /* 2026-09-29：识别标记取一次即清 —— 无论本次推送成功与否都不再保留，
       防止「识别填入后没提交 / 推送失败」时，下一次手动登记被误标成自动识别来源。 */
    var rcKind = recognizeConfirm; recognizeConfirm = null;
    if (!Cloud.hasToken()) {
      // 令牌缺失＝只存在本机浏览器，换设备看不到、也不会进金山台账。必须醒目告警，否则用户会误以为已同步。
      Util.toast("⚠️ 仅存本机，未上传云端！请联系管理员检查同步令牌", true);
      window.App.Views.app.setSyncStatus("⚠️ 未配置云端令牌，本条只存在本机，换设备看不到", true);
      return;
    }
    // 乐观 UI 已提前提示过，这里就不再重复弹（否则用户会看到两条「成功」提示）
    if (!optimisticNotified) Util.toast(msg);
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
      if (r.pushed) {
        watchWpsReceipt(rec);
        /* 2026-09-29 方案 A：来自自动识别的单，正式提交成功后再补一条钉钉确认（用最终实际数据） */
        if (rcKind && Cloud.pushRecognizeConfirm) Cloud.pushRecognizeConfirm(rec, rcKind);
        /* 2026-09-29 方案 A（追加）：手工登记的入库同样要推钉钉（此前历史上一律不推）。
           与上一行互斥二选一 —— 每条入库恰好发一条，不会既发识别确认又发新入库。 */
        else if (Cloud.pushInNew) Cloud.pushInNew(rec);
      }
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
    zoneVal = "wh";            // 复位为默认：进仓库锁定
    moveMap = {};              // 复位「其中转入现场」
    editingTransfer = false;
    picker.setSelected([]);
    photos.setPhotos([]);
    editingId = null;
    els.submit.textContent = "确定入库";
    els.cancelEdit.style.display = "none";
    renderPreview();
    renderSourceChips();
    renderZoneSeg();
    renderZoneMove();
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
    /* 2026-10-18 去向：老记录没有 zone 字段（当年入库一律计入现场）→ 按「现场」回显，
       避免一编辑旧单就被凭空锁进仓库、把现场数扣没。 */
    zoneVal = (r.zone === "wh") ? "wh" : "site";
    /* 「其中转入现场」回显：记录里存过才带出，没有就空着 */
    moveMap = {};
    if (r.zoneMove && typeof r.zoneMove === "object") {
      Object.keys(r.zoneMove).forEach(function (k) { moveMap[k] = Math.round(Number(r.zoneMove[k]) || 0); });
    }
    picker.setSelected(r.items || []);
    photos.setPhotos(r.photos || []);
    els.submit.textContent = "保存修改";
    els.cancelEdit.style.display = "inline-flex";
    renderPreview();
    renderSourceChips();
    renderZoneSeg();
    renderZoneMove();
    Util.toast("正在编辑该记录，修改后点「保存修改」");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  /**
   * 自动识别回填（2026-09-26）：由「自动识别」页经 Views.recognize.takePending 传入。
   * @param {{picker?:string, items?:Array<{name:string,qty:number}>}} d
   * 入库页口径（主理人 2026-09-26 确认）：
   *   · 经办人    ← 订单编号（入库 payload 里写入的键名是 picker，见 submit 内构造）
   *   · 入库来源  ← 留空，由人工手动选（吉客云订单文字里没有这个信息）
   * 注意：ProductPicker.setSelected 不触发 onChange，必须手动补 saveDraft + renderPreview。
   */
  function fillRecognized(d) {
    if (!d || !els) return;
    /* 经办人：主理人 2026-09-26 定稿 —— 「沿用上次填的人」（render 时已自动带出），本函数**不覆盖**它。
       这里只处理「用途 ← 入库号」（粘贴格式第 1 行的 DB 号）。 */
    if (d.purpose != null && els.purpose) els.purpose.value = d.purpose;
    if (d.items && d.items.length) picker.setSelected(d.items);
    recognizeConfirm = "in";   // 2026-09-29：标记本单来自自动识别，提交成功后补推钉钉确认
    saveDraft();
    renderPreview();                 // 入库有「库存变化预览」，回填后必须刷新
    var n = (d.items || []).length;
    Util.toast("已填入" + (n ? " " + n + " 项货品" : "") + "，记得选入库来源再提交");
    try {
      var R = window.App.Views.recognize;
      if (R && R.showBanner) R.showBanner(els.submit);
    } catch (e) {}
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) { window.scrollTo(0, 0); }
  }

  window.App.Views.in = { render: render, edit: edit, fill: fillRecognized };
})();
