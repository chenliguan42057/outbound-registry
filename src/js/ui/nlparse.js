/**
 * nlparse.js — 一句话快速登记（A5，2026-08-08 第二批）
 * 在出库表单顶部注入「✨ 一句话快速登记」输入条，本地规则解析中文自然语言
 * 例如：『张三 领 2个面膜 客户赠送』→ 预填领取人/货品数量/用途（仅预填表单，不落库）。
 * 解析策略（本地规则，不联网）：货品按名称最长优先匹配 + 前置数量；用途/法人按关键词命中 chip；
 * 部门按「部门/单位：xx」提取；剩余文本首段作为领取人。失败项自动跳过，用户可手动补。
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
      // 前置数量：name 前最近的「数字 + 可选单位」
      var before = rest.slice(0, idx);
      var qtyRe = new RegExp("(\\d+(?:\\.\\d+)?)\\s*" + UNIT_RE + "?\\s*$");
      var m = before.match(qtyRe);
      var qty = m ? parseFloat(m[1]) : 1;
      items.push({ name: name, qty: qty });
      // 从原文移除「数量+货品名」片段
      rest = rest.slice(0, idx - (m ? m[0].length : 0)) + rest.slice(idx + name.length);
    });
    return { items: items, rest: rest };
  }

  /** 关键词命中 chip 值：返回 Config.PURPOSE_PRESETS 中匹配项（未命中返回 ""） */
  function extractPurpose(text) {
    var presets = Config.PURPOSE_PRESETS || [];
    for (var i = 0; i < presets.length; i++) {
      var p = presets[i];
      // 关键词表：预设 → 常用说法
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

  /** 结算法人：命中「深圳/细胞」或「赛迪斯」返回对应预设 */
  function extractEntity(text) {
    var presets = Config.ENTITY_PRESETS || [];
    if (text.indexOf("赛迪斯") !== -1) return presets[presets.length - 1] || "赛迪斯法人";
    if (text.indexOf("深圳") !== -1 || text.indexOf("细胞") !== -1) return presets[0] || "深圳细胞法人";
    return "";
  }

  /** 部门/领取单位：「部门/单位：xx」提取 */
  function extractDept(text) {
    var m = text.match(/(?:部门|单位)[：:]\s*([^\s，,。；;]+)/);
    return m ? m[1] : "";
  }

  /** 领取人：移除已识别片段后的剩余文本，取首个连续词（去「领/领取/领用」前缀） */
  function extractPicker(rest) {
    var s = String(rest || "").trim();
    s = s.replace(/^(请?给|帮|让我|我来)?(领用|领取|领走|领了|领|取|拿)/, "").trim();
    s = s.replace(/[，,。.;；、\s]+$/, "");
    // 去掉尾部可能残留的用途词
    ["客户销售", "赠送客户", "内部员工使用"].forEach(function (p) {
      if (s.indexOf(p) !== -1) s = s.replace(p, "");
    });
    s = s.trim();
    return s.slice(0, 20);
  }

  /** 主入口：解析一句话 → 填表动作清单 */
  function parse(text) {
    if (!text || !text.trim()) return null;
    var items = extractItems(text);
    var purpose = extractPurpose(items.rest + text);   // 用途可能在货品前后，全文搜
    var entity = extractEntity(text);
    var dept = extractDept(text);
    var picker = extractPicker(items.rest);
    return { items: items.items, purpose: purpose, entity: entity, dept: dept, picker: picker };
  }

  /* ---------- 填表（纯 DOM 模拟，不依赖 out.js 内部） ---------- */

  function fillResult(res) {
    var filled = [];

    // 领取人
    if (res.picker) {
      var p = document.getElementById("outPicker");
      if (p) { p.value = res.picker; p.dispatchEvent(new Event("input", { bubbles: true })); filled.push("领取人"); }
    }
    // 部门
    if (res.dept) {
      var d = document.getElementById("outDept");
      if (d) { d.value = res.dept; d.dispatchEvent(new Event("input", { bubbles: true })); filled.push("部门"); }
    }
    // 用途 chip（点击选中，互斥高亮由 out.js 处理）
    if (res.purpose) {
      var pc = document.querySelector('#outPurposeChips .chip[data-val="' + Util.esc(res.purpose) + '"]');
      if (pc) { pc.click(); filled.push("用途"); }
    }
    // 结算法人 chip
    if (res.entity) {
      var ec = document.querySelector('#outEntityChips .chip[data-val="' + Util.esc(res.entity) + '"]');
      if (ec) { ec.click(); filled.push("法人"); }
    }
    // 货品：模拟搜索→点击建议→设置数量
    (res.items || []).forEach(function (it) {
      if (addProductSim(it.name, it.qty)) filled.push(it.name);
    });

    return filled;
  }

  /** 通过 ProductPicker 的 DOM 行为添加货品并设数量 */
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
    // 设置数量：找到刚加入的 sel-item 行
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

  /* ---------- 注入快速登记条 ---------- */

  function inject() {
    var form = document.getElementById("landingForm");
    if (!form || form.getAttribute("data-qr")) return;
    form.setAttribute("data-qr", "1");
    var box = document.createElement("div");
    box.className = "quick-reg";
    box.innerHTML =
      '<input id="quickRegInput" type="text" placeholder="✨ 一句话登记：如 张三 领 2个面膜 客户赠送" autocomplete="off" />' +
      '<button type="button" class="btn sm" id="quickRegBtn">填入表单</button>';
    form.insertBefore(box, form.firstChild);
    var inp = box.querySelector("#quickRegInput");
    var btn = box.querySelector("#quickRegBtn");
    function run() {
      var text = inp.value.trim();
      if (!text) { Util.toast("请输入一句话，例如：张三 领 2个面膜 客户赠送", true); return; }
      var res = parse(text);
      if (!res || (!res.picker && !res.dept && !res.purpose && !res.entity && !res.items.length)) {
        Util.toast("没识别出来，试试：张三 领 2个面膜 客户赠送", true);
        return;
      }
      var filled = fillResult(res);
      Util.toast("已填入：" + (filled.length ? filled.join("、") : "（请手动补充）") + "，核对后提交");
    }
    btn.addEventListener("click", run);
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); run(); } });
  }

  // 跟随落地页表单渲染注入
  var obs = new MutationObserver(function () { inject(); });
  obs.observe(document.body, { childList: true, subtree: true });
  inject();

  window.App = window.App || {};
  window.App.NLParse = { parse: parse, fill: fillResult };
})();
