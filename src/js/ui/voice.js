/**
 * voice.js — 语音填单（A3，2026-08-08 第二批）
 * 在出库表单「领取人 / 部门 / 备注」旁注入 🎤 按钮，点击语音输入（Web Speech API，仅 Chrome/Edge）。
 * 能力缺失时静默不注入；识别结果填入对应输入框并触发 input 事件（联动联想/草稿）。
 * 通过 MutationObserver 自动跟随表单渲染挂载，零侵入 out.js。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  var TARGETS = [
    { id: "outPicker", ta: false },
    { id: "outDept", ta: false },
    { id: "outNote", ta: true }
  ];

  function attach() {
    if (!SR) return;   // 浏览器不支持：静默降级
    TARGETS.forEach(function (t) {
      var input = document.getElementById(t.id);
      if (!input) return;
      var wrap = t.ta ? input.closest(".field") : input.closest(".search-wrap");
      if (!wrap || wrap.getAttribute("data-voice")) return;
      wrap.setAttribute("data-voice", "1");
      if (!t.ta) wrap.style.position = "relative";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "voice-btn" + (t.ta ? " ta" : "");
      btn.title = "语音输入";
      btn.textContent = "🎤";
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        toggleRec(btn, input);
      });
      wrap.appendChild(btn);
    });
  }

  var rec = null;
  function toggleRec(btn, input) {
    if (rec && rec.listening) { rec.stop(); return; }
    try {
      rec = new SR();
      rec.lang = "zh-CN";
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onstart = function () { btn.classList.add("rec"); btn.textContent = "⏺"; Util.toast("正在聆听，请说话…"); };
      rec.onresult = function (e) {
        var t = (e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript) || "";
        if (t) {
          input.value = t;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          Util.toast("已填入：" + t);
        }
      };
      rec.onerror = function (e) { Util.toast("语音识别失败：" + (e.error || "未知错误"), true); };
      rec.onend = function () { btn.classList.remove("rec"); btn.textContent = "🎤"; };
      rec.start();
    } catch (e) {
      Util.toast("当前浏览器不支持语音输入", true);
    }
  }

  // 跟随表单渲染挂载（落地页每次进入都会重建表单）
  var obs = new MutationObserver(function () { attach(); });
  obs.observe(document.body, { childList: true, subtree: true });
  attach();
})();
