/**
 * formkit.js — 表单填写手感套件（2026-09-26 精修 P2）
 * ------------------------------------------------------------------
 * 纯 UI 层，只负责"填得爽"，不参与任何业务计算、不写任何业务数据：
 *   1. bindSuggest  —— 历史补全升级：键盘 ↑↓ 选、Enter 确认、Esc 关闭、关键词高亮
 *   2. draftBar     —— 草稿恢复提示条：告诉用户"这是上次没交的内容"，可一键清空
 *   3. photoGuide   —— 拍照上传引导：拍什么、怎么拍、拍几张
 * 红线：本文件不调用 Store.saveRecords / Records.create / Cloud.push 等任何写接口。
 */
(function () {
  'use strict';

  var Util = window.App.Util;

  function esc(s) { return Util.esc(String(s == null ? "" : s)); }

  /** 把 text 中命中的关键词包成 <mark>（先转义再拼接，防 XSS） */
  function mark(text, q) {
    var s = String(text == null ? "" : text);
    if (!q) return esc(s);
    var i = s.toLowerCase().indexOf(String(q).toLowerCase());
    if (i < 0) return esc(s);
    return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
  }

  /**
   * 绑定输入框的历史补全（键盘可操作）
   * @param {HTMLInputElement} inp
   * @param {HTMLElement} sug 建议容器（.suggest）
   * @param {Object} opts { source:()=>string[], onPick:(val)=>void, max:number, showOnFocus:boolean, emptyText:string }
   */
  function bindSuggest(inp, sug, opts) {
    opts = opts || {};
    if (!inp || !sug) return null;
    var max = opts.max || 8;
    var list = [];
    var idx = -1;
    var open = false;

    function close() {
      open = false; idx = -1;
      sug.style.display = "none";
      sug.innerHTML = "";
      inp.removeAttribute("aria-expanded");
    }

    function paint() {
      sug.innerHTML = list.map(function (v, i) {
        return '<div class="fk-item' + (i === idx ? " on" : "") + '" data-i="' + i + '" role="option">' +
          mark(v, inp.value.trim()) + '</div>';
      }).join("") +
        '<div class="fk-tip">↑↓ 选择 · Enter 确认 · Esc 关闭</div>';
      // 高亮项滚进可视区
      var on = sug.querySelector(".fk-item.on");
      if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
    }

    function setIdx(i) {
      if (!list.length) return;
      idx = (i + list.length) % list.length;
      Array.prototype.forEach.call(sug.querySelectorAll(".fk-item"), function (el, n) {
        el.classList.toggle("on", n === idx);
      });
      var on = sug.querySelector(".fk-item.on");
      if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
    }

    function pick(i) {
      var v = list[i];
      if (v == null) return;
      inp.value = v;
      close();
      if (opts.onPick) opts.onPick(v);
    }

    function render() {
      var q = inp.value.trim().toLowerCase();
      var all = (opts.source ? opts.source() : []) || [];
      var seen = {};
      var pool = all.filter(function (v) {
        if (typeof v !== "string" || !v.trim() || seen[v]) return false;
        seen[v] = 1; return true;
      });
      if (!q) {
        // 空输入：聚焦时给最近用过的几个（下拉但不抢焦点）
        list = pool.slice(0, max);
      } else {
        var head = [], tail = [];
        pool.forEach(function (v) {
          if (v.toLowerCase().indexOf(q) === 0) head.push(v);
          else if (v.toLowerCase().indexOf(q) > -1) tail.push(v);
        });
        list = head.concat(tail).slice(0, max);
      }
      if (!list.length) { close(); return; }
      idx = -1; open = true;
      sug.innerHTML = "";
      paint();
      sug.style.display = "block";
      inp.setAttribute("aria-expanded", "true");
    }

    inp.addEventListener("input", render);
    if (opts.showOnFocus !== false) {
      inp.addEventListener("focus", function () { render(); });
    }
    inp.addEventListener("keydown", function (e) {
      if (!open) return;
      if (e.key === "ArrowDown") { e.preventDefault(); setIdx(idx + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setIdx(idx - 1); }
      else if (e.key === "Enter") { if (idx >= 0) { e.preventDefault(); pick(idx); } else close(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    inp.addEventListener("blur", function () { setTimeout(close, 150); });
    sug.addEventListener("mousedown", function (e) {
      var it = e.target.closest(".fk-item");
      if (!it) return;
      e.preventDefault();
      pick(Number(it.getAttribute("data-i")));
    });
    sug.addEventListener("mousemove", function (e) {
      var it = e.target.closest(".fk-item");
      if (it) setIdx(Number(it.getAttribute("data-i")));
    });

    return { close: close, refresh: render };
  }

  /**
   * 草稿恢复提示条：插到容器最前面
   * @param {Object} o { host, savedAt:number, summary:string, onClear:()=>void }
   */
  function draftBar(o) {
    var host = o && o.host;
    if (!host) return null;
    var old = host.querySelector(".fk-draft");
    if (old) old.remove();
    var age = "";
    if (o.savedAt) {
      var m = Math.floor((Date.now() - o.savedAt) / 60000);
      age = m < 1 ? "刚刚" : (m < 60 ? m + " 分钟前" : (m < 1440 ? Math.floor(m / 60) + " 小时前" : Math.floor(m / 1440) + " 天前"));
    }
    var el = document.createElement("div");
    el.className = "fk-draft";
    el.innerHTML =
      '<span class="fk-draft-ico">📝</span>' +
      '<span class="fk-draft-txt"><b>已恢复上次没提交的内容</b>' +
      (age ? ' <i>（' + esc(age) + '）</i>' : "") +
      (o.summary ? '<br/><span class="fk-draft-sub">' + esc(o.summary) + '</span>' : "") +
      '</span>' +
      '<span class="fk-draft-acts">' +
      '<button type="button" class="btn ghost mini fk-draft-clear">清空草稿</button>' +
      '<button type="button" class="fk-draft-x" title="知道了" aria-label="关闭">✕</button>' +
      '</span>';
    el.querySelector(".fk-draft-clear").addEventListener("click", function () {
      if (o.onClear) o.onClear();
      el.remove();
    });
    el.querySelector(".fk-draft-x").addEventListener("click", function () { el.remove(); });
    host.insertBefore(el, host.firstChild);
    return el;
  }

  /** 清除容器里的草稿条 */
  function clearDraftBar(host) {
    if (!host) return;
    var old = host.querySelector(".fk-draft");
    if (old) old.remove();
  }

  /** 拍照上传引导：挂在照片上传框下面（静态文案，可折叠） */
  function photoGuide(host) {
    if (!host) return null;
    var old = host.parentNode && host.parentNode.querySelector(".fk-photo-guide");
    if (old) old.remove();
    var el = document.createElement("details");
    el.className = "fk-photo-guide";
    el.innerHTML =
      '<summary>📸 拍照要点（点开看 3 条）</summary>' +
      '<ol>' +
      '<li><b>拍全</b>：货物正面平放，箱唛 / 批次号拍进画面</li>' +
      '<li><b>拍清</b>：光线均匀别逆光，别抖，一张看不清就补一张</li>' +
      '<li><b>拍够</b>：多箱货建议「整堆 1 张 + 单箱明细 1 张」</li>' +
      '</ol>' +
      '<div class="fk-photo-note">照片会自动压缩后随记录上传，作为现场留存凭证；没拍也能先提交。</div>';
    if (host.nextSibling) host.parentNode.insertBefore(el, host.nextSibling);
    else host.parentNode.appendChild(el);
    return el;
  }

  window.App = window.App || {};
  window.App.Formkit = {
    bindSuggest: bindSuggest,
    draftBar: draftBar,
    clearDraftBar: clearDraftBar,
    photoGuide: photoGuide
  };
})();
