/**
 * chat.js — AI 助手聊天面板（单例，落地页浮动 / 管理后台 #/app/ai 内嵌双入口复用）
 * A 部分：本地引擎直接回答（type !== "fallback" 一律本地，有 Key 也不走 LLM）；
 * B 部分：fallback 且有 Key → LLM 真对话（带系统数据上下文），失败回退本地 + hint。
 * 会话历史：内存数组 + P1 持久化 outbound_ai_chat（上限 50 条，设置开关默认开）。
 * 设置弹窗：服务商下拉（DeepSeek / 智谱 AI，Config.AI_PROVIDERS）+ 模型联动；Key 沿用 outbound_ai_key。
 * 挂载到 window.App.AI.Chat。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Store = window.App.Store;
  var Config = window.App.Config;

  var Engine = null;   // 延迟获取，避免脚本顺序强依赖
  var LLM = null;

  var panel = null;      // 面板根节点（单例，懒创建）
  var msgsEl = null;
  var inputEl = null;
  var sendBtn = null;
  var history = [];      // 内存会话 [{role:"user"|"ai", text}]
  var busy = false;
  var embedded = false;

  /** 换行 → <br/>（配合 esc 防 XSS） */
  function nl2br(s) {
    return String(s).replace(/\n/g, "<br/>");
  }

  /** API Key 掩码（绝不回显明文） */
  function maskKey(k) {
    k = String(k || "");
    return k.length > 8 ? k.slice(0, 3) + "***" + k.slice(-3) : "***" + k.slice(-3);
  }

  /** Answer 对象 → 可持久化/可读的纯文本摘要 */
  function answerText(answer) {
    var lines = [];
    if (answer && answer.title) lines.push(answer.title);
    if (answer && answer.text) lines.push(answer.text);
    if (answer && answer.table) {
      answer.table.rows.forEach(function (r) {
        lines.push(r.cells.join(" | "));
      });
    }
    return lines.join("\n");
  }

  /* ================= 面板构建 ================= */

  function ensurePanel() {
    if (panel) return panel;
    Engine = window.App.AI.Engine;
    LLM = window.App.AI.LLM;
    panel = document.createElement("div");
    panel.className = "ai-panel";
    panel.innerHTML =
      '<div class="ai-header">' +
        '<span class="ai-header-title">🤖 AI 助手</span>' +
        '<div class="ai-header-btns">' +
          '<button type="button" class="ai-hbtn" data-act="settings" title="AI 设置">⚙</button>' +
          '<button type="button" class="ai-hbtn" data-act="clear" title="清空对话">🗑</button>' +
          '<button type="button" class="ai-hbtn" data-act="close" title="关闭">✕</button>' +
        '</div>' +
      '</div>' +
      '<div class="ai-msgs" id="aiMsgs"></div>' +
      '<div class="ai-inputbar">' +
        '<input type="text" class="ai-input" id="aiInput" placeholder="输入你的问题…" autocomplete="off" />' +
        '<button type="button" class="ai-send" id="aiSend">发送</button>' +
      '</div>';
    document.body.appendChild(panel);
    msgsEl = panel.querySelector(".ai-msgs");
    inputEl = panel.querySelector(".ai-input");
    sendBtn = panel.querySelector(".ai-send");

    panel.addEventListener("click", function (e) {
      var chip = e.target.closest(".ai-chip");
      if (chip) { send(chip.textContent); return; }
      var btn = e.target.closest(".ai-hbtn");
      if (!btn) return;
      var act = btn.getAttribute("data-act");
      if (act === "close") close();
      else if (act === "clear") doClear();
      else if (act === "settings") openSettings();
    });
    sendBtn.addEventListener("click", function () { send(inputEl.value); });
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); send(inputEl.value); }
    });
    loadHistory();
    if (history.length) renderHistory();
    else renderIntro();
    return panel;
  }

  /** 恢复持久化历史（P1） */
  function loadHistory() {
    var settings = Store.loadAiSettings();
    if (settings.persistChat === false) return;
    var saved = Store.loadAiChat();
    history = (saved || []).filter(function (m) {
      return m && typeof m === "object" && (m.role === "user" || m.role === "ai") && typeof m.text === "string";
    }).slice(-Config.AI_CHAT_HISTORY_LIMIT);
  }

  /** 保存历史（截断 50 条） */
  function saveHistory() {
    var settings = Store.loadAiSettings();
    if (settings.persistChat === false) return;
    Store.saveAiChat(history);
  }

  /** 渲染首条介绍消息（能力介绍 + 快捷 chips） */
  function renderIntro() {
    var intro = {
      type: "help",
      title: "🤖 你好！我是你的进销存助手",
      text:
        "我可以帮你查库存、看低库存预警、统计今日/近 N 天出入库、检索出库记录、库存排行与趋势。\n" +
        "无需任何配置即可使用；点击下方快捷问题，或直接输入你的问题。",
      chips: Config.AI_QUICK_CHIPS.slice()
    };
    appendAnswer(intro, null, true);
  }

  /** 渲染恢复的历史消息（纯文本气泡） */
  function renderHistory() {
    if (!msgsEl) return;
    history.forEach(function (m) {
      if (m.role === "user") {
        msgsEl.insertAdjacentHTML("beforeend",
          '<div class="ai-msg ai-msg-user"><div class="ai-bubble">' + Util.esc(m.text) + '</div></div>');
      } else {
        msgsEl.insertAdjacentHTML("beforeend",
          '<div class="ai-msg ai-msg-ai"><div class="ai-bubble">' + nl2br(Util.esc(m.text)) + '</div></div>');
      }
    });
    scrollBottom();
  }

  /* ================= 渲染 ================= */

  function scrollBottom() {
    if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  /** 渲染表格（全部值 esc） */
  function renderTable(table) {
    var html = '<div class="ai-table-wrap"><table class="ai-table"><thead><tr>';
    (table.head || []).forEach(function (h) { html += "<th>" + Util.esc(h) + "</th>"; });
    html += "</tr></thead><tbody>";
    (table.rows || []).forEach(function (r) {
      html += '<tr class="' + (r.low ? "low" : "") + '">';
      (r.cells || []).forEach(function (c) { html += "<td>" + Util.esc(c) + "</td>"; });
      html += "</tr>";
    });
    html += "</tbody></table></div>";
    return html;
  }

  /** 渲染一条 AI 回复（本地 Answer）；noPersist=true 时不写入历史（如首条介绍） */
  function appendAnswer(answer, hint, noPersist) {
    if (!msgsEl) return;
    var bubble =
      '<div class="ai-msg ai-msg-ai">' +
        '<div class="ai-bubble ai-type-' + Util.esc(answer.type || "text") + '">' +
          '<div class="ai-title">' + Util.esc(answer.title || "") + '</div>' +
          (answer.text ? '<div class="ai-text">' + nl2br(Util.esc(answer.text)) + '</div>' : "") +
          (answer.table ? renderTable(answer.table) : "") +
          (hint ? '<div class="ai-hint">' + Util.esc(hint) + '</div>' : "") +
        '</div>' +
      '</div>';
    var chips = (answer.chips && answer.chips.length)
      ? '<div class="ai-chips">' + answer.chips.map(function (c) {
          return '<button type="button" class="ai-chip">' + Util.esc(c) + '</button>';
        }).join("") + '</div>'
      : "";
    msgsEl.insertAdjacentHTML("beforeend", bubble + chips);
    if (!noPersist) {
      history.push({ role: "ai", text: answerText(answer) });
      saveHistory();
    }
    scrollBottom();
  }

  /** 渲染 LLM 纯文本回复 */
  function appendLlmText(text) {
    if (!msgsEl) return;
    msgsEl.insertAdjacentHTML("beforeend",
      '<div class="ai-msg ai-msg-ai"><div class="ai-bubble ai-type-llm">' +
        '<div class="ai-title">💬 AI 对话</div>' +
        '<div class="ai-text">' + nl2br(Util.esc(text)) + '</div>' +
      '</div></div>');
    history.push({ role: "ai", text: text });
    saveHistory();
    scrollBottom();
  }

  /** 渲染 LLM 错误文案（不写入历史） */
  function appendLlmError(errText) {
    if (!msgsEl) return;
    msgsEl.insertAdjacentHTML("beforeend",
      '<div class="ai-msg ai-msg-ai"><div class="ai-bubble ai-type-error">' +
        '<div class="ai-text">' + Util.esc(errText) + '</div>' +
      '</div></div>');
    scrollBottom();
  }

  /** 渲染用户气泡 */
  function appendUser(q) {
    if (!msgsEl) return;
    msgsEl.insertAdjacentHTML("beforeend",
      '<div class="ai-msg ai-msg-user"><div class="ai-bubble">' + Util.esc(q) + '</div></div>');
    history.push({ role: "user", text: q });
    saveHistory();
    scrollBottom();
  }

  /** 正在思考… */
  function appendThinking() {
    if (!msgsEl) return;
    msgsEl.insertAdjacentHTML("beforeend",
      '<div class="ai-msg ai-msg-ai ai-thinking"><div class="ai-bubble">正在思考…</div></div>');
    scrollBottom();
  }

  function removeThinking() {
    if (!msgsEl) return;
    var t = msgsEl.querySelector(".ai-thinking");
    if (t) t.remove();
  }

  /** 输入区禁用/启用（busy 防抖：同一时刻仅一个在途请求） */
  function setBusy(v) {
    busy = !!v;
    if (inputEl) inputEl.disabled = busy;
    if (sendBtn) sendBtn.disabled = busy;
    if (panel) panel.classList.toggle("ai-busy", busy);
  }

  /* ================= 消息流 ================= */

  /**
   * 发送问题：用户气泡 → 正在思考… → Engine.answer(q)：
   *  - 非 fallback：直接渲染本地结果（有 Key 也不走 LLM）
   *  - fallback：无 Key → 渲染帮助文案；有 Key → LLM 真对话，失败回退本地 + hint
   * @param {string} q
   */
  function send(q) {
    q = String(q == null ? "" : q).trim();
    if (!q || busy) return;
    if (inputEl) inputEl.value = "";
    appendUser(q);
    appendThinking();
    setBusy(true);

    var answer = Engine.answer(q);

    if (answer.type !== "fallback") {
      // 数据类意图：本地直答（准确 + 免费）
      window.setTimeout(function () {
        removeThinking();
        appendAnswer(answer);
        setBusy(false);
      }, 180);
      return;
    }

    var key = Store.loadAiKey();
    if (!key) {
      // 无 Key：A 模式，本地兜底帮助文案
      window.setTimeout(function () {
        removeThinking();
        appendAnswer(answer);
        setBusy(false);
      }, 180);
      return;
    }

    // 有 Key：B 模式，携带系统数据上下文走 LLM 真对话
    var sysCtx = LLM.buildSystemContext();
    LLM.chat([
      { role: "system", content: sysCtx },
      { role: "user", content: q }
    ]).then(function (res) {
      removeThinking();
      if (res.ok) {
        appendLlmText(res.text);
      } else {
        appendLlmError(LLM.errText(res.err));
        appendAnswer(answer, "已退回本地问答");
      }
      setBusy(false);
    }).catch(function () {
      removeThinking();
      appendLlmError(LLM.errText("network"));
      appendAnswer(answer, "已退回本地问答");
      setBusy(false);
    });
  }

  /* ================= 头部操作 ================= */

  /** 清空对话（二次确认，复用 UI.confirmDialog） */
  function doClear() {
    UI.confirmDialog("确定清空当前 AI 对话？", "清空对话").then(function (ok) {
      if (!ok) return;
      history = [];
      Store.clearAiChat();
      if (msgsEl) msgsEl.innerHTML = "";
      renderIntro();
      Util.toast("已清空对话");
    });
  }

  /* ================= 设置弹窗 ================= */

  /** 按 id 查找服务商配置（Config.AI_PROVIDERS）；未命中返回 null */
  function getProvider(id) {
    id = String(id || "");
    for (var i = 0; i < Config.AI_PROVIDERS.length; i++) {
      if (Config.AI_PROVIDERS[i].id === id) return Config.AI_PROVIDERS[i];
    }
    return null;
  }

  function openSettings() {
    var key = Store.loadAiKey();
    var settings = Store.loadAiSettings();
    var provider = getProvider(settings.provider) || getProvider(Config.AI_DEFAULT_PROVIDER) || Config.AI_PROVIDERS[0];
    var body = document.createElement("div");
    body.innerHTML =
      '<div class="ai-settings">' +
        '<div class="ai-mode-hint">当前模式：' +
          (key ? '<span class="ai-mode-hybrid">对话式 AI（混合模式，数据类问题走本地引擎）</span>'
                : '<span class="ai-mode-local">本地问答（免费零配置）</span>') +
        '</div>' +
        '<div class="field">' +
          '<label>API Key（可选）</label>' +
          '<input type="password" id="aiKeyInput" class="ai-key-input" placeholder="' +
            (key ? "已保存：" + Util.esc(maskKey(key)) : "粘贴你的 API Key（可选）") +
            '" autocomplete="off" />' +
        '</div>' +
        '<div class="field">' +
          '<label>服务商</label>' +
          '<select id="aiProviderSelect">' +
            Config.AI_PROVIDERS.map(function (p) {
              return '<option value="' + Util.esc(p.id) + '"' + (provider.id === p.id ? " selected" : "") + ">" +
                Util.esc(p.label) + "</option>";
            }).join("") +
          '</select>' +
        '</div>' +
        '<div class="field">' +
          '<label>模型</label>' +
          '<select id="aiModelSelect"></select>' +
        '</div>' +
        '<div class="field">' +
          '<label class="ai-check"><input type="checkbox" id="aiPersistChat"' +
            (settings.persistChat === false ? "" : " checked") + ' /> 保存会话历史（最多 50 条）</label>' +
        '</div>' +
        '<div class="hint" id="aiProviderHint"></div>' +
        '<div class="ai-sec-note">🔒 API Key 仅保存在本机浏览器（localStorage），不会上传到服务器，也不会写入代码或仓库；' +
          'AI 数据查询仅在提问时发送给所选服务商；不同服务商需填写对应服务商的 API Key（DeepSeek 为 sk-…，智谱 AI 为 {id}.{secret}）。</div>' +
        '<div class="ai-settings-actions">' +
          '<button type="button" class="btn ghost sm" id="aiTestBtn">测试连接</button>' +
          '<button type="button" class="btn ghost sm" id="aiClearKeyBtn">清除 Key</button>' +
          '<button type="button" class="btn sm" id="aiSaveBtn">保存</button>' +
          '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
        '</div>' +
        '<div class="ai-test-result" id="aiTestResult"></div>' +
      '</div>';
    UI.Modal.show("⚙ AI 设置", body, { width: "400px" });

    var mBody = UI.Modal.body();
    var keyInput = mBody.querySelector("#aiKeyInput");
    var providerSelect = mBody.querySelector("#aiProviderSelect");
    var modelSelect = mBody.querySelector("#aiModelSelect");
    var persistBox = mBody.querySelector("#aiPersistChat");
    var hintEl = mBody.querySelector("#aiProviderHint");
    var testResult = mBody.querySelector("#aiTestResult");

    /** 根据当前服务商渲染模型下拉 + 提示文案；服务商切换时模型自动切到该服务商首模型 */
    function renderModels() {
      var p = getProvider(providerSelect.value) || Config.AI_PROVIDERS[0];
      var current = settings.model;
      var selected = (p.models && p.models.indexOf(current) !== -1) ? current : (p.models && p.models[0]);
      modelSelect.innerHTML = (p.models || []).map(function (m) {
        return '<option value="' + Util.esc(m) + '"' + (selected === m ? " selected" : "") + ">" +
          Util.esc(m) + "</option>";
      }).join("");
      hintEl.textContent = "服务商：" + p.label + "（浏览器直连，支持 CORS）；默认模型 " +
        ((p.models && p.models[0]) || "-") + "；切换服务商后请确认 Key 为对应服务商的 Key。";
    }
    renderModels();

    providerSelect.onchange = function () { renderModels(); };

    mBody.querySelector('[data-act="cancel"]').onclick = function () { UI.Modal.hide(); };
    mBody.querySelector("#aiSaveBtn").onclick = function () {
      var val = (keyInput.value || "").trim();
      if (val) Store.saveAiKey(val);
      var p = getProvider(providerSelect.value) || Config.AI_PROVIDERS[0];
      var settings2 = Store.loadAiSettings();
      settings2.provider = p.id;
      settings2.model = modelSelect.value;
      settings2.baseUrl = p.baseUrl;   // 与服务商保持一致，避免旧 baseUrl 残留串服务商
      settings2.persistChat = persistBox.checked;
      Store.saveAiSettings(settings2);
      UI.Modal.hide();
      Util.toast("AI 设置已保存" + (val ? "（已更新 Key）" : ""));
    };
    mBody.querySelector("#aiClearKeyBtn").onclick = function () {
      UI.confirmDialog("确定清除本机保存的 API Key？清除后回到纯本地问答模式。", "清除 API Key").then(function (ok) {
        if (!ok) return;
        Store.clearAiKey();
        UI.Modal.hide();
        Util.toast("已清除 API Key，回到本地问答");
      });
    };
    mBody.querySelector("#aiTestBtn").onclick = function () {
      var val = (keyInput.value || "").trim() || Store.loadAiKey();
      if (!val) { testResult.textContent = "请先填写 API Key"; return; }
      testResult.textContent = "测试中…";
      LLM.testConnection({ key: val, provider: providerSelect.value, model: modelSelect.value }).then(function (res) {
        testResult.textContent = res.ok ? "✅ 连接成功" : "❌ " + LLM.errText(res.err);
      });
    };
  }

  /* ================= 对外 API ================= */

  /** 打开浮动面板（落地页 FAB / 管理后台均可调用，免登录） */
  function openFloat() {
    ensurePanel();
    embedded = false;
    panel.classList.remove("embedded");
    if (panel.parentNode !== document.body) document.body.appendChild(panel);
    panel.classList.add("show");
    inputEl.focus();
  }

  /** 内嵌渲染（管理后台 #/app/ai 容器填满） */
  function renderEmbedded(el) {
    ensurePanel();
    embedded = true;
    panel.classList.add("embedded");
    el.appendChild(panel);
    panel.classList.add("show");
  }

  /** 关闭浮动面板 */
  function close() {
    if (panel) panel.classList.remove("show");
    setBusy(false);
  }

  window.App = window.App || {};
  window.App.AI = window.App.AI || {};
  window.App.AI.Chat = {
    openFloat: openFloat,
    renderEmbedded: renderEmbedded,
    close: close,
    send: send,
    clear: doClear
  };
})();
