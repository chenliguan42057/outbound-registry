/**
 * voice.js — 语音填单（A3，2026-08-08 第二批；2026-08-08 体验微调）
 * 只在「一句话快速登记」输入框旁挂一个 🎤 按钮，语音识别结果直接填入 #quickRegInput，
 * 用户点「填入表单」即可批量解析。用户反馈：领取人/部门/备注三处麦克风太多了，
 * 只需在快速登记处保留一个即可（说一句同时识别多个字段）。
 * 能力缺失时静默不注入；MutationObserver 跟随 nlparse.js 注入。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  var rec = null;

  function attach() {
    if (!SR) return;   // 浏览器不支持：静默降级
    var input = document.getElementById("quickRegInput");
    if (!input) return;
    var wrap = input.parentNode;
    if (!wrap || wrap.getAttribute("data-voice")) return;
    wrap.setAttribute("data-voice", "1");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "voice-btn qr-mic";
    btn.title = "语音输入（识别后说一段话，再点「填入表单」）";
    btn.textContent = "🎤";
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      toggle(btn, input);
    });
    wrap.insertBefore(btn, input.nextSibling);
  }

  function toggle(btn, input) {
    if (rec && rec.listening) { rec.stop(); return; }
    try {
      rec = new SR();
      rec.lang = "zh-CN";
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onstart = function () {
        btn.classList.add("rec");
        btn.textContent = "⏺";
        Util.toast("正在聆听，请说一句话（如：张三 领 2个面膜 客户赠送）…");
      };
      rec.onresult = function (e) {
        var t = (e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript) || "";
        if (t) {
          input.value = t;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.focus();
          Util.toast("语音已识别，请点「填入表单」");
        }
      };
      rec.onerror = function (e) { Util.toast("语音识别失败：" + (e.error || "未知错误"), true); };
      rec.onend = function () { btn.classList.remove("rec"); btn.textContent = "🎤"; };
      rec.start();
    } catch (e) {
      Util.toast("当前浏览器不支持语音输入", true);
    }
  }

  var obs = new MutationObserver(function () { attach(); });
  obs.observe(document.body, { childList: true, subtree: true });
  attach();
})();