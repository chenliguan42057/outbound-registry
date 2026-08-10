/**
 * chat.js — AI 助手聊天面板（单例，落地页浮动 / 管理后台 #/app/ai 内嵌双入口复用）
 * A 部分：本地引擎直接回答（type !== "fallback" 一律本地，有 Key 也不走 LLM）；
 * B 部分：fallback 且有 Key → LLM 多轮真对话（带系统数据上下文 + 最近 N 轮历史），失败回退本地 + hint。
 * 第五轮增量：
 *   - pending 异步（weather/wiki/news）由 chat.js 调 Web.* 完成，失败只渲染错误文案，绝不送 LLM
 *   - 新卡片：tool / qr（二维码图 + 复制）/ weather / wiki / news
 *   - 头部 🧹 清空上下文（保留界面消息）；🗑 清空对话（全部清 + 重开 intro）
 *   - intro 次级 chips（Config.AI_EXTRA_CHIPS）
 *   - 设置弹窗新增「🔍 联网搜索」区块（天气/百科/新闻开关 + 服务商 + 搜索 Key）
 * 会话历史：内存数组 + P1 持久化 outbound_ai_chat（上限 50 条，设置开关默认开）。
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
  var Web = null;

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

  /** pending 类型 → 思考中状态文案 */
  function pendingLabel(type) {
    if (type === "weather") return "正在查询天气…";
    if (type === "news") return "正在联网搜索…";
    return "正在联网查询…";
  }

  /* ================= 面板构建 ================= */

  function ensurePanel() {
    if (panel) return panel;
    Engine = window.App.AI.Engine;
    LLM = window.App.AI.LLM;
    Web = window.App.AI.Web || null;
    panel = document.createElement("div");
    panel.className = "ai-panel";
    panel.innerHTML =
      '<div class="ai-header">' +
        '<span class="ai-header-title">🤖 AI 助手</span>' +
        '<div class="ai-header-btns">' +
          '<button type="button" class="ai-hbtn" data-act="settings" title="AI 设置">⚙</button>' +
          '<button type="button" class="ai-hbtn" data-act="clearctx" title="清空上下文（保留消息）">🧹</button>' +
          '<button type="button" class="ai-hbtn" data-act="clear" title="清空对话">🗑</button>' +
          '<button type="button" class="ai-hbtn" data-act="close" title="关闭">✕</button>' +
        '</div>' +
      '</div>' +
      '<div class="ai-msgs" id="aiMsgs"></div>' +
      '<div class="ai-inputbar">' +
        '<input type="text" class="ai-input" id="aiInput" placeholder="输入你的问题…" autocomplete="off" />' +
        '<button type="button" class="ai-hbtn ai-check-btn" data-act="check" title="库存核对">📷</button>' +
        '<button type="button" class="ai-send" id="aiSend">发送</button>' +
      '</div>';
    document.body.appendChild(panel);
    msgsEl = panel.querySelector(".ai-msgs");
    inputEl = panel.querySelector(".ai-input");
    sendBtn = panel.querySelector(".ai-send");

    panel.addEventListener("click", function (e) {
      /* 1) data-act 按钮：header 操作 / 📷 库存核对 / 引导卡快捷按钮（优先于 chip，因引导按钮同时带 ai-chip 类） */
      var actBtn = e.target.closest("[data-act]");
      if (actBtn) {
        var act = actBtn.getAttribute("data-act");
        if (act === "check" || act === "openCheck") { openCheckModal(); return; }
        if (act === "close") { close(); return; }
        if (act === "clear") { doClear(); return; }
        if (act === "clearctx") { doClearCtx(); return; }
        if (act === "settings") { openSettings(); return; }
      }
      var copy = e.target.closest(".ai-copy");
      if (copy) { copyToClipboard(copy.getAttribute("data-copy")); return; }
      var link = e.target.closest(".ai-wiki-link, .ai-news-item a");
      if (link) { e.preventDefault(); window.open(link.getAttribute("href"), "_blank", "noopener"); return; }
      /* 2) 普通 chip：「重新核对」特判重开弹窗；其余照常发送 */
      var chip = e.target.closest(".ai-chip");
      if (chip) {
        if (chip.textContent === "重新核对") { openCheckModal(); return; }
        send(chip.textContent); return;
      }
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

  /** 渲染首条介绍消息（能力介绍 + 主 chips + 次级 chips） */
  function renderIntro() {
    var intro = {
      type: "help",
      title: "🤖 你好！我是你的进销存助手",
      text:
        "我可以帮你查库存、看低库存预警、统计今日/近 N 天出入库、检索出库记录、库存排行与趋势。\n" +
        "还能做本地小工具（计算/换算/日期/二维码/快递/文案），以及联网查天气、百科。\n" +
        "无需任何配置即可使用；点击下方快捷问题，或直接输入你的问题。",
      chips: Config.AI_QUICK_CHIPS.slice()
    };
    appendAnswer(intro, null, true);
    // 次级 chips（第五轮增量）
    var extra = Config.AI_EXTRA_CHIPS || [];
    if (extra.length && msgsEl) {
      msgsEl.insertAdjacentHTML("beforeend",
        '<div class="ai-chips ai-chips-sub">' + extra.map(function (c) {
          return '<button type="button" class="ai-chip">' + Util.esc(c) + '</button>';
        }).join("") + '</div>');
      scrollBottom();
    }
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

  /** 渲染表格（全部值 esc）；支持 r.cls → <tr class="ck-{cls}">（核对结果 5 类着色，仅允许白名单类名） */
  function renderTable(table) {
    var clsMap = { ok: 1, warn: 1, miss: 1, nf: 1, unk: 1 };
    var html = '<div class="ai-table-wrap"><table class="ai-table"><thead><tr>';
    (table.head || []).forEach(function (h) { html += "<th>" + Util.esc(h) + "</th>"; });
    html += "</tr></thead><tbody>";
    (table.rows || []).forEach(function (r) {
      var trCls = (r.low ? "low" : "") + (clsMap[r.cls] ? " ck-" + r.cls : "");
      html += '<tr class="' + trCls.trim() + '">';
      (r.cells || []).forEach(function (c) { html += "<td>" + Util.esc(c) + "</td>"; });
      html += "</tr>";
    });
    html += "</tbody></table></div>";
    return html;
  }

  /** 复制按钮 HTML（data-copy 属性，esc 转义） */
  function copyBtnHTML(copyText) {
    return '<button type="button" class="ai-copy" data-copy="' + Util.esc(copyText) + '">复制</button>';
  }

  /** 渲染一条 AI 回复（本地 Answer，支持 tool/qr/copyText）；noPersist=true 时不写入历史（如首条介绍） */
  function appendAnswer(answer, hint, noPersist) {
    if (!msgsEl) return;
    var qrHtml = "";
    if (answer.type === "qr" && answer.dataUrl) {
      qrHtml =
        '<div class="ai-qr-card">' +
          '<img src="' + Util.esc(answer.dataUrl) + '" alt="二维码" class="ai-qr-img" />' +
          '<div class="ai-qr-content">' + Util.esc(answer.content || "") + '</div>' +
          (answer.copyText ? copyBtnHTML(answer.copyText) : "") +
        '</div>';
    }
    var copyHtml = (!qrHtml && answer.copyText) ? copyBtnHTML(answer.copyText) : "";
    /* 第六轮增量：引导卡快捷按钮（data-act 由面板委托处理） */
    var guideHtml = (answer.guideAct && answer.guideAct.act)
      ? '<button type="button" class="ai-chip" data-act="' + Util.esc(answer.guideAct.act) + '">' +
          Util.esc(answer.guideAct.label || "打开") + '</button>'
      : "";
    /* 核对结果汇总徽章行（type="check"） */
    var summaryHtml = (answer.type === "check" && answer.summaryText)
      ? '<div class="ck-summary">' + Util.esc(answer.summaryText) + '</div>'
      : "";
    var bubble =
      '<div class="ai-msg ai-msg-ai">' +
        '<div class="ai-bubble ai-type-' + Util.esc(answer.type || "text") + '">' +
          '<div class="ai-title">' + Util.esc(answer.title || "") + '</div>' +
          qrHtml +
          summaryHtml +
          (answer.text ? '<div class="ai-text">' + nl2br(Util.esc(answer.text)) + '</div>' : "") +
          (answer.table ? renderTable(answer.table) : "") +
          guideHtml +
          copyHtml +
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

  /** 渲染 LLM/联网错误文案（不写入历史） */
  function appendLlmError(errText) {
    if (!msgsEl) return;
    msgsEl.insertAdjacentHTML("beforeend",
      '<div class="ai-msg ai-msg-ai"><div class="ai-bubble ai-type-error">' +
        '<div class="ai-text">' + Util.esc(errText) + '</div>' +
      '</div></div>');
    scrollBottom();
  }

  /** 仅渲染 chips（pending 失败后的本地引导，不产生气泡） */
  function appendChipsOnly(chips) {
    if (!msgsEl || !chips || !chips.length) return;
    msgsEl.insertAdjacentHTML("beforeend",
      '<div class="ai-chips">' + chips.map(function (c) {
        return '<button type="button" class="ai-chip">' + Util.esc(c) + '</button>';
      }).join("") + '</div>');
    scrollBottom();
  }

  /** 渲染天气卡（pending 异步结果） */
  function appendWeather(data) {
    if (!msgsEl) return;
    var d = data || {};
    var tempStr = d.temp != null ? Math.round(d.temp) + "°C" : "-";
    var maxStr = d.max != null ? Math.round(d.max) + "°" : "-";
    var minStr = d.min != null ? Math.round(d.min) + "°" : "-";
    var windStr = d.wind != null ? d.wind + " m/s" : "-";
    var humStr = d.humidity != null ? d.humidity + "%" : "-";
    var html =
      '<div class="ai-msg ai-msg-ai"><div class="ai-bubble ai-type-weather ai-weather-card">' +
        '<div class="ai-title">' + Util.esc(d.emoji || "🌤") + ' ' + Util.esc(d.city || "") + ' 天气</div>' +
        '<div class="ai-weather-main">' +
          '<span class="ai-weather-temp">' + Util.esc(tempStr) + '</span>' +
          '<span class="ai-weather-desc">' + Util.esc(d.desc || "") + '</span>' +
        '</div>' +
        '<div class="ai-weather-meta">最高 ' + Util.esc(maxStr) + ' / 最低 ' + Util.esc(minStr) +
          ' ｜ 风速 ' + Util.esc(windStr) + ' ｜ 湿度 ' + Util.esc(humStr) + '</div>' +
      '</div></div>';
    msgsEl.insertAdjacentHTML("beforeend", html);
    history.push({
      role: "ai",
      text: (d.city || "") + "天气：" + (d.desc || "") + "，当前 " + tempStr +
        "，最高 " + maxStr + "，最低 " + minStr + "，风速 " + windStr + "，湿度 " + humStr
    });
    saveHistory();
    scrollBottom();
  }

  /** 渲染百科卡（pending 异步结果） */
  function appendWiki(data) {
    if (!msgsEl) return;
    var d = data || {};
    var extract = String(d.extract || "").slice(0, 300);
    var thumb = d.thumb
      ? '<img class="ai-wiki-thumb" src="' + Util.esc(d.thumb) + '" alt="' + Util.esc(d.title || "词条") + '" />'
      : "";
    var link = d.url
      ? '<a class="ai-wiki-link" href="' + Util.esc(d.url) + '" target="_blank" rel="noopener">查看完整词条 ↗</a>'
      : "";
    var html =
      '<div class="ai-msg ai-msg-ai"><div class="ai-bubble ai-type-wiki ai-wiki-card">' +
        '<div class="ai-title">🔍 ' + Util.esc(d.title || "") + '（维基百科）</div>' +
        thumb +
        '<div class="ai-text">' + nl2br(Util.esc(extract)) + '</div>' +
        link +
      '</div></div>';
    msgsEl.insertAdjacentHTML("beforeend", html);
    history.push({ role: "ai", text: (d.title || "") + "：" + extract });
    saveHistory();
    scrollBottom();
  }

  /** 渲染新闻列表（pending 异步结果） */
  function appendNews(data) {
    if (!msgsEl) return;
    var items = (data && data.items) || [];
    if (!items.length) {
      appendLlmError("没有找到相关新闻。");
      return;
    }
    var list = items.map(function (it, i) {
      var title = it.title || "（无标题）";
      var snippet = it.snippet ? '<div class="ai-news-snippet">' + Util.esc(it.snippet) + '</div>' : "";
      var url = it.url ? it.url : "#";
      return '<li class="ai-news-item">' +
        '<a href="' + Util.esc(url) + '" target="_blank" rel="noopener">' + (i + 1) + '. ' + Util.esc(title) + '</a>' +
        snippet +
      '</li>';
    }).join("");
    var html =
      '<div class="ai-msg ai-msg-ai"><div class="ai-bubble ai-type-news ai-news-card">' +
        '<div class="ai-title">📰 新闻搜索 TOP' + items.length + '</div>' +
        '<ul class="ai-news-list">' + list + '</ul>' +
      '</div></div>';
    msgsEl.insertAdjacentHTML("beforeend", html);
    history.push({ role: "ai", text: "新闻搜索 TOP" + items.length + "：" +
      items.map(function (it, i) { return (i + 1) + "." + (it.title || ""); }).join("；") });
    saveHistory();
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

  /** 正在思考…（pending 可细分文案） */
  function appendThinking(label) {
    if (!msgsEl) return;
    msgsEl.insertAdjacentHTML("beforeend",
      '<div class="ai-msg ai-msg-ai ai-thinking"><div class="ai-bubble">' +
        Util.esc(label || "正在思考…") + '</div></div>');
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

  /* ================= 复制 ================= */

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      Util.toast("已复制");
    } catch (e) {
      Util.toast("复制失败", true);
    }
    document.body.removeChild(ta);
  }

  /** 复制到剪贴板（file:// 下回退 textarea + execCommand） */
  function copyToClipboard(text) {
    text = String(text == null ? "" : text);
    if (!text) { Util.toast("没有可复制的内容"); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        Util.toast("已复制");
      }).catch(function () {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  /* ================= 库存核对弹窗（第六轮增量） ================= */

  /**
   * 打开「📷 库存核对」弹窗：引导文案 + textarea + 示例 + 取消/开始核对。
   * 隐私红线：粘贴文本仅局部变量 → Engine.checkStock(text) 解析；
   * 原始文本绝不写入 history / localStorage / 云端；结果 Answer 走常规 appendAnswer 持久化。
   */
  function openCheckModal() {
    if (busy) { Util.toast("请等待当前回复完成", true); return; }
    var body = document.createElement("div");
    body.className = "ai-check-modal";
    body.innerHTML =
      '<div class="ai-check-guide">📌 从库存截图里复制文字，粘贴到下方（本功能识别的是你粘贴的文字，不是图片本身）。<br/>每行格式：货品名 数量</div>' +
      '<div class="ai-check-example">示例：<br/>精华液 20支装 95<br/>面膜 5片装 120件<br/>洁面慕斯 150ml: 85</div>' +
      '<textarea id="aiCheckText" class="ai-check-textarea" rows="8" placeholder="在此粘贴截图文字…" autocomplete="off"></textarea>' +
      '<div class="ai-check-hint" id="aiCheckHint">粘贴后点击「开始核对」，结果将显示在聊天面板。</div>' +
      '<div class="ai-check-actions">' +
        '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
        '<button type="button" class="btn sm" data-act="start">开始核对</button>' +
      '</div>';
    UI.Modal.show("📷 库存核对", body, { width: "420px" });
    var mBody = UI.Modal.body();
    var ta = mBody.querySelector("#aiCheckText");
    var hint = mBody.querySelector("#aiCheckHint");

    /** 提交核对：空输入 → toast 提示且不关弹窗；非空 → 解析 → 关弹窗 → 渲染结果卡 */
    function doCheck() {
      var text = (ta.value || "").trim();
      if (!text) {
        hint.textContent = "⚠️ 请先粘贴文字（从库存截图复制后粘贴）";
        hint.classList.add("err");
        ta.focus();
        return;
      }
      UI.Modal.hide();
      var eng = Engine || window.App.AI.Engine;
      var ans = (eng && eng.checkStock) ? eng.checkStock(text) : {
        type: "check",
        title: "📋 库存核对",
        text: "库存核对模块加载失败，请刷新页面后重试。",
        chips: ["重新核对"]
      };
      appendAnswer(ans);
    }
    mBody.querySelector('[data-act="start"]').onclick = doCheck;
    mBody.querySelector('[data-act="cancel"]').onclick = function () { UI.Modal.hide(); };
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCheck(); }
    });
    setTimeout(function () { ta.focus(); }, 50);
  }

  /* ================= 消息流 ================= */

  /**
   * pending 异步处理：weather/wiki/news → 查开关 → 调 Web.* → 成功渲染卡片 / 失败错误文案 + 本地 chips。
   * @param {{type:string, pending:boolean, city?:string, topic?:string, query?:string, chips?:string[]}} answer
   */
  function handlePending(answer) {
    var settings = Store.loadSearchSettings();
    var fail = function (res) {
      removeThinking();
      var text = (Web && Web.errText) ? Web.errText(res.err) : "请求失败，请稍后再试";
      appendLlmError(text);
      appendChipsOnly(answer.chips);
      setBusy(false);
    };

    if (answer.type === "weather") {
      if (!settings.enabledWeather) { fail({ err: "disabled" }); return; }
      if (!Web) { fail({ err: "network" }); return; }
      Web.weather(answer.city).then(function (res) {
        removeThinking();
        if (res.ok) appendWeather(res.data);
        else { appendLlmError(Web.errText(res.err)); appendChipsOnly(answer.chips); }
        setBusy(false);
      }).catch(function () { fail({ err: "network" }); });
      return;
    }

    if (answer.type === "wiki") {
      if (!settings.enabledWiki) { fail({ err: "disabled" }); return; }
      if (!Web) { fail({ err: "network" }); return; }
      Web.wiki(answer.topic).then(function (res) {
        removeThinking();
        if (res.ok) appendWiki(res.data);
        else { appendLlmError(Web.errText(res.err)); appendChipsOnly(answer.chips); }
        setBusy(false);
      }).catch(function () { fail({ err: "network" }); });
      return;
    }

    if (answer.type === "news") {
      if (!settings.enabledNews) { fail({ err: "disabled" }); return; }
      if (!Web) { fail({ err: "network" }); return; }
      Web.news(answer.query).then(function (res) {
        removeThinking();
        if (res.ok) appendNews(res.data);
        else { appendLlmError(Web.errText(res.err)); appendChipsOnly(answer.chips); }
        setBusy(false);
      }).catch(function () { fail({ err: "network" }); });
      return;
    }

    // 未知 pending 类型 → 兜底本地
    removeThinking();
    appendAnswer({ type: "tool", title: answer.title || "🤔", text: "该功能暂不可用，请稍后再试。", chips: answer.chips });
    setBusy(false);
  }

  /**
   * 发送问题：用户气泡 → 正在思考… → Engine.answer(q)：
   *  - answer.pending → handlePending（异步联网，仅失败渲染错误，绝不送 LLM）
   *  - 非 fallback → 本地渲染（appendAnswer，支持 tool/qr/copyText）
   *  - fallback → 无 Key 本地帮助；有 Key → LLM.chatWithHistory 多轮真对话
   * @param {string} q
   */
  function send(q) {
    q = String(q == null ? "" : q).trim();
    if (!q || busy) return;
    if (inputEl) inputEl.value = "";
    appendUser(q);
    setBusy(true);

    var answer = Engine.answer(q);

    if (answer.pending) {
      appendThinking(pendingLabel(answer.type));
      handlePending(answer);
      return;
    }

    if (answer.type !== "fallback") {
      // 数据/工具类意图：本地直答（准确 + 免费）
      appendThinking();
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
      appendThinking();
      window.setTimeout(function () {
        removeThinking();
        appendAnswer(answer);
        setBusy(false);
      }, 180);
      return;
    }

    // 有 Key：B 模式，携带系统数据上下文 + 最近多轮历史走 LLM 真对话
    appendThinking();
    LLM.chatWithHistory(history, q).then(function (res) {
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

  /** 清空上下文：仅清 LLM 将携带的历史（内存+持久化），界面消息保留展示 */
  function doClearCtx() {
    history = [];
    Store.clearAiChat();
    Util.toast("已清空上下文（界面消息保留）");
  }

  /** 清空对话（二次确认，复用 UI.confirmDialog）：全部清 + 重开 intro */
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

  /** 按 id 查找搜索服务商（Config.SEARCH_PROVIDERS） */
  function getSearchProvider(id) {
    id = String(id || "");
    var list = Config.SEARCH_PROVIDERS || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return list[0] || null;
  }

  function openSettings() {
    var key = Store.loadAiKey();
    var settings = Store.loadAiSettings();
    var provider = getProvider(settings.provider) || getProvider(Config.AI_DEFAULT_PROVIDER) || Config.AI_PROVIDERS[0];
    var searchKey = Store.loadSearchKey();
    var searchSettings = Store.loadSearchSettings();
    var searchProvider = getSearchProvider(searchSettings.provider) || (Config.SEARCH_PROVIDERS || [])[0];
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
        '<div class="field">' +
          '<label class="ai-context-hint">上下文：最近 ' + Config.AI_CONTEXT_ROUNDS + ' 轮（' +
            Config.AI_CONTEXT_MAX_CHARS + ' 字符预算）</label>' +
        '</div>' +
        '<div class="hint" id="aiProviderHint"></div>' +
        '<div class="ai-sec-title">🔍 联网搜索</div>' +
        '<div class="field">' +
          '<label class="ai-check"><input type="checkbox" id="aiWeatherBox"' +
            (searchSettings.enabledWeather === false ? "" : " checked") + ' /> 启用天气（免费，无需 Key）</label>' +
        '</div>' +
        '<div class="field">' +
          '<label class="ai-check"><input type="checkbox" id="aiWikiBox"' +
            (searchSettings.enabledWiki === false ? "" : " checked") + ' /> 启用百科（免费，无需 Key）</label>' +
        '</div>' +
        '<div class="field">' +
          '<label class="ai-check"><input type="checkbox" id="aiNewsBox"' +
            (searchSettings.enabledNews ? " checked" : "") + ' /> 启用新闻搜索（需 Key）</label>' +
        '</div>' +
        '<div class="field">' +
          '<label>搜索服务商</label>' +
          '<select id="aiSearchProviderSelect">' +
            (Config.SEARCH_PROVIDERS || []).map(function (p) {
              return '<option value="' + Util.esc(p.id) + '"' +
                ((searchProvider && searchProvider.id === p.id) ? " selected" : "") + ">" +
                Util.esc(p.label) + "</option>";
            }).join("") +
          '</select>' +
        '</div>' +
        '<div class="field">' +
          '<label>搜索 API Key（可选，新闻搜索用）</label>' +
          '<input type="password" id="aiSearchKeyInput" class="ai-key-input" placeholder="' +
            (searchKey ? "已保存：" + Util.esc(maskKey(searchKey)) : "粘贴搜索 API Key（可选）") +
            '" autocomplete="off" />' +
        '</div>' +
        '<div class="ai-sec-note-search">🌐 天气/百科免费无需 Key；新闻搜索需自行申请 Tavily Key（免费额度 1000 次/月）。</div>' +
        '<div class="ai-sec-note-search lock">🔒 搜索 API Key 仅保存在本机浏览器（localStorage），不会上传到服务器，也不会写入代码或仓库。</div>' +
        '<div class="ai-settings-actions">' +
          '<button type="button" class="btn ghost sm" id="aiClearSearchKeyBtn">清除搜索 Key</button>' +
        '</div>' +
        '<div class="ai-sec-note">🔒 API Key 仅保存在本机浏览器（localStorage），不会上传到服务器，也不会写入代码或仓库；' +
          'AI 数据查询仅在提问时发送给所选服务商；不同服务商需填写对应服务商的 API Key（DeepSeek 与智谱 AI 的 Key 格式不同）。</div>' +
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
    var searchKeyInput = mBody.querySelector("#aiSearchKeyInput");
    var searchProviderSelect = mBody.querySelector("#aiSearchProviderSelect");
    var weatherBox = mBody.querySelector("#aiWeatherBox");
    var wikiBox = mBody.querySelector("#aiWikiBox");
    var newsBox = mBody.querySelector("#aiNewsBox");

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

      // 联网搜索区块
      var sv = (searchKeyInput.value || "").trim();
      if (sv) Store.saveSearchKey(sv);
      var sp = getSearchProvider(searchProviderSelect.value) || (Config.SEARCH_PROVIDERS || [])[0];
      Store.saveSearchSettings({
        provider: sp ? sp.id : "tavily",
        enabledWeather: weatherBox.checked,
        enabledWiki: wikiBox.checked,
        enabledNews: newsBox.checked
      });

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
    mBody.querySelector("#aiClearSearchKeyBtn").onclick = function () {
      UI.confirmDialog("确定清除本机保存的搜索 API Key？清除后新闻搜索将不可用。", "清除搜索 API Key").then(function (ok) {
        if (!ok) return;
        Store.clearSearchKey();
        searchKeyInput.value = "";
        searchKeyInput.placeholder = "粘贴搜索 API Key（可选）";
        Util.toast("已清除搜索 API Key");
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
    clear: doClear,
    clearContext: doClearCtx,
    openCheckModal: openCheckModal
  };
})();
