/**
 * nlparse.js — 一句话快速登记（A5，2026-08-08 第二批；2026-08-08 体验微调）
 * 在出库表单顶部注入「✨ 一句话快速登记」条，竖排两行布局（手机端友好）：
 *   第 1 行：输入框 + 麦克风按钮
 *   第 2 行：「填入表单」按钮 + 必填项提示
 * 本地规则解析中文自然语言 → 预填表单（仅预填，不落库）：
 *   货品按名称最长优先匹配 + 前置数量；用途/法人按关键词命中 chip；
 *   部门按「部门/单位：xx」提取；剩余文本首段作为领取人。
 * 失败/缺项时 toast 明确指出「还差什么」（部门/姓名+工号/产品和规模/用途）。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Config = window.App.Config;

  var UNIT_RE = "[个盒支瓶件包份套片张袋]";

  /* ---------- 解析 ---------- */

  /** 提取「数量+货品」对；返回 {items:[{name,qty}], rest} */
  function extractItems(text) {
    var items = [];
    var rest = text;
    var prods = (Config.PRODUCTS || []).slice().sort(function (a, b) { return b.length - a.length; });
    prods.forEach(function (name) {
      var idx = rest.indexOf(name);
      if (idx === -1) return;
      var before = rest.slice(0, idx);
      var qtyRe = new RegExp("(\\d+(?:\\.\\d+)?)\\s*" + UNIT_RE + "?\\s*$");
      var m = before.match(qtyRe);
      var qty = m ? parseFloat(m[1]) : 1;
      items.push({ name: name, qty: qty });
      rest = rest.slice(0, idx - (m ? m[0].length : 0)) + rest.slice(idx + name.length);
    });
    return { items: items, rest: rest };
  }

  function extractPurpose(text) {
    var presets = Config.PURPOSE_PRESETS || [];
    for (var i = 0; i < presets.length; i++) {
      var p = presets[i];
      var kw = {
        "客户销售": ["客户销售", "销售", "卖给"],
        "赠送客户": ["赠送", "送客户", "送礼", "赠"],
        "内部员工使用": ["内部", "员工", "自用"]
      }[p] || [p];
      for (var j = 0; j < kw.length; j++) {
        if (text.indexOf(kw[j]) !== -1) return p;
      }
    }
    return "";
  }

  function extractEntity(text) {
    var presets = Config.ENTITY_PRESETS || [];
    if (text.indexOf("赛迪斯") !== -1) return presets[presets.length - 1] || "赛迪斯法人";
    if (text.indexOf("深圳") !== -1 || text.indexOf("细胞") !== -1) return presets[0] || "深圳细胞法人";
    return "";
  }

  // 部门后缀（中文组织结构常见）。启发式匹配"销售部/研发组/技术科"等
  var DEPT_SUFFIX = ["部", "组", "科", "室", "中心", "队", "处", "课"];

  function extractDept(text) {
    // 模式1：显式标注「部门：xxx」/「单位：xxx」/「客户：xxx」/「公司：xxx」
    var m = text.match(/(?:部门|单位|客户|公司)[：:]\s*([^\s，,。；;]+)/);
    if (m) return m[1];
    // 模式2：文本开头是 2-5 字纯中文 + 部门后缀（销售部、研发组、技术科 等）
    var first = (text.match(/^\s*([^\s，,。；:：]+)/) || [])[1] || "";
    if (first && /^[\u4e00-\u9fa5]{2,5}$/.test(first)) {
      var lastCh = first.charAt(first.length - 1);
      if (DEPT_SUFFIX.indexOf(lastCh) !== -1) return first;
    }
    return "";
  }

  function extractPicker(rest) {
    var s = String(rest || "").trim();
    s = s.replace(/^(请?给|帮|让我|我来)?(领用|领取|领走|领了|领|取|拿)/, "").trim();
    s = s.replace(/[，,。.;；、\s]+$/, "");
    ["客户销售", "赠送客户", "内部员工使用"].forEach(function (p) {
      if (s.indexOf(p) !== -1) s = s.replace(p, "");
    });
    s = s.trim();
    return s.slice(0, 20);
  }

  function parse(text) {
    if (!text || !text.trim()) return null;
    var items = extractItems(text);
    var purpose = extractPurpose(items.rest + text);
    var entity = extractEntity(text);
    var dept = extractDept(text);
    // 修复：识别到部门后从原文剥离，避免污染领取人字段（例：「销售部 陈利冠」→ 部门=销售部 / 领取人=陈利冠）
    var stripped = text;
    if (dept && dept.length >= 2) {
      try {
        var re = new RegExp("^\\s*" + dept.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "\\s*");
        stripped = text.replace(re, "");
      } catch (e) {}
    }
    var picker = extractPicker(stripped);
    return { items: items.items, purpose: purpose, entity: entity, dept: dept, picker: picker };
  }

  /* ---------- 填表（纯 DOM 模拟，不依赖 out.js 内部） ---------- */

  function fillResult(res) {
    var filled = [];
    if (res.picker) {
      var p = document.getElementById("outPicker");
      if (p) { p.value = res.picker; p.dispatchEvent(new Event("input", { bubbles: true })); filled.push("领取人"); }
    }
    if (res.dept) {
      var d = document.getElementById("outDept");
      if (d) { d.value = res.dept; d.dispatchEvent(new Event("input", { bubbles: true })); filled.push("部门"); }
    }
    if (res.purpose) {
      var pc = document.querySelector('#outPurposeChips .chip[data-val="' + Util.esc(res.purpose) + '"]');
      if (pc) { pc.click(); filled.push("用途"); }
    }
    if (res.entity) {
      var ec = document.querySelector('#outEntityChips .chip[data-val="' + Util.esc(res.entity) + '"]');
      if (ec) { ec.click(); filled.push("法人"); }
    }
    (res.items || []).forEach(function (it) {
      if (addProductSim(it.name, it.qty)) filled.push(it.name);
    });
    return filled;
  }

  function addProductSim(name, qty) {
    var search = document.querySelector(".search-wrap .search");
    var suggest = search && search.closest(".search-wrap").querySelector(".suggest");
    if (!search || !suggest) return false;
    search.value = name;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    var div = null;
    var divs = suggest.querySelectorAll("div");
    for (var i = 0; i < divs.length; i++) {
      if (divs[i].textContent.indexOf(name) !== -1) { div = divs[i]; break; }
    }
    if (!div) return false;
    div.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    var rows = document.querySelectorAll(".sel-item");
    for (var j = 0; j < rows.length; j++) {
      var nm = rows[j].querySelector(".name");
      if (nm && nm.textContent.indexOf(name) !== -1) {
        var q = rows[j].querySelector(".qty");
        if (q && Number(qty) > 0) {
          q.value = qty;
          q.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return true;
      }
    }
    return true;
  }

  /* ---------- 注入快速登记条（竖排两行） ---------- */

  function inject() {
    var form = document.getElementById("landingForm");
    if (!form || form.getAttribute("data-qr")) return;
    form.setAttribute("data-qr", "1");
    var box = document.createElement("div");
    box.className = "quick-reg";
    box.innerHTML =
      '<div class="qr-row">' +
        '<input id="quickRegInput" type="text" placeholder="✨ 一句话登记：如 张三 领 2个面膜 客户赠送" autocomplete="off" />' +
        // 🎤 按钮由 voice.js 自动追加到 input 旁边（data-voice 标记防重复）
      '</div>' +
      '<div class="qr-row2">' +
        '<button type="button" class="btn sm" id="quickRegBtn">填入表单</button>' +
        '<span class="qr-hint">完整登记需：<b>部门</b> + <b>姓名和工号</b> + <b>产品和规模（如 面膜 5 片装）</b> + <b>用途</b></span>' +
      '</div>';
    form.insertBefore(box, form.firstChild);
    var inp = box.querySelector("#quickRegInput");
    var btn = box.querySelector("#quickRegBtn");

    function run() {
      var text = inp.value.trim();
      if (!text) { Util.toast("请输入一句话，例如：张三 领 2个面膜 客户赠送", true); return; }
      var res = parse(text);
      // 缺项明细：用户反馈「提示登记不完整」应明确告知缺什么
      var missing = [];
      if (!res || (!res.picker && !res.dept && !res.purpose && !res.entity && !res.items.length)) {
        Util.toast("一句话未识别出有效信息，请按提示补全「部门 + 姓名和工号 + 产品和规模 + 用途」", true);
        return;
      }
      var filled = fillResult(res);
      // 关键必填核对：结算法人由默认预设首项兜底，不视为缺失
      if (!res.picker) missing.push("领取人（姓名+工号/手机）");
      if (!res.dept) missing.push("部门/领取单位");
      if (!res.items.length) missing.push("产品和规模");
      if (!res.purpose) missing.push("用途/项目");
      var msg = "已填入：" + (filled.length ? filled.join("、") : "（无）") + "，核对后提交";
      if (missing.length) msg += " · 待补充：" + missing.join("、");
      Util.toast(msg);
    }
    btn.addEventListener("click", run);
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); run(); } });
  }

  var obs = new MutationObserver(function () { inject(); });
  obs.observe(document.body, { childList: true, subtree: true });
  inject();

  window.App = window.App || {};
  window.App.NLParse = { parse: parse, fill: fillResult };
})();