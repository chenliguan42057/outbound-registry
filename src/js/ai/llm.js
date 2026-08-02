/**
 * llm.js — AI 助手 B 部分：DeepSeek / OpenAI 兼容对话接口对接
 * 仅原生 fetch；配置经 Store.loadAiKey()/loadAiSettings() 读取（Key 仅存本机 localStorage）。
 * 错误归一化 Promise<{ok, text?, err?}>：401/403→invalid-key；429→rate-limit；≥500→server；
 * AbortError→timeout；fetch reject→network。
 * 挂载到 window.App.AI.LLM。
 */
(function () {
  'use strict';

  var Config = window.App.Config;
  var Store = window.App.Store;
  var State = window.App.State;
  var Stock = window.App.Stock;
  var Records = window.App.Records;

  /** HTTP 状态码 → 归一化错误类型 */
  function errKey(status) {
    if (status === 401 || status === 403) return "invalid-key";
    if (status === 429) return "rate-limit";
    if (status >= 500) return "server";
    return "unknown";
  }

  /** 错误类型 → 用户友好文案 */
  function errText(err) {
    var map = {
      "invalid-key": "API Key 无效，请在 AI 设置中重新填写",
      "rate-limit": "请求过于频繁，请稍后再试",
      "server": "AI 服务暂时不可用，请稍后再试",
      "timeout": "响应超时，请重试",
      "network": "网络异常或服务商不支持直连，已退回本地问答",
      "unknown": "AI 服务返回异常，请稍后再试"
    };
    return map[err] || map.unknown;
  }

  /**
   * 构建有界系统数据上下文（控制 token 成本）：
   * 库存 TOP15、低库存货品数、今日出库件数、最近 10 条记录摘要、本地记录总数。
   * @returns {string}
   */
  function buildSystemContext() {
    var lines = [];
    var sum = Stock.summarize(State.list).slice().sort(function (a, b) { return b.stock - a.stock; });
    var top = sum.slice(0, Config.AI_CONTEXT_TOP_N);
    lines.push("你是进销存管理系统的 AI 助手，以下为系统当前数据上下文（仅作参考）：");
    lines.push("【当前库存 TOP" + top.length + "】");
    top.forEach(function (x) { lines.push("- " + x.name + "：" + x.stock + "件"); });
    var low = sum.filter(function (x) { return x.stock < Config.LOW_STOCK_THRESHOLD; });
    lines.push("【低库存货品数】" + low.length + "（阈值 " + Config.LOW_STOCK_THRESHOLD + " 件）");

    var now = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var todayStr = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    var todayOut = 0;
    (State.list || []).forEach(function (r) {
      if (String(r.time || "").slice(0, 10) !== todayStr) return;
      if ((r.type || "out") === "in") return;
      todayOut += (r.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
    });
    lines.push("【今日出库件数】" + todayOut);

    var recent = (State.list || []).slice(0, Config.AI_CONTEXT_RECENT);
    lines.push("【最近记录摘要（" + recent.length + " 条）】");
    recent.forEach(function (r) {
      var items = (r.items || []).map(function (it) { return it.name + "×" + it.qty; }).join("；");
      var st = Records.getStatus(r);
      var stLabel = st === "pending" ? "未提单" : (st === "submitted" ? "已提单" : "入库");
      lines.push("- " + (r.time || "") + "｜" + (r.picker || "-") + "｜" + (items || "-") + "｜" + stLabel);
    });
    lines.push("【本地记录总数】" + (State.list || []).length);
    return lines.join("\n");
  }

  /**
   * 对话请求（OpenAI Chat Completions 兼容）。
   * @param {Array<{role: string, content: string}>} messages
   * @param {{key?: string, baseUrl?: string, model?: string, timeout?: number}} [opts]
   * @returns {Promise<{ok: boolean, text?: string, err?: string}>}
   */
  function chat(messages, opts) {
    opts = opts || {};
    var key = opts.key != null ? opts.key : Store.loadAiKey();
    if (!key) {
      return Promise.resolve({ ok: false, err: "invalid-key", text: errText("invalid-key") });
    }
    var settings = Store.loadAiSettings();
    var baseUrl = String(opts.baseUrl || settings.baseUrl || Config.AI_BASE_URL || "").replace(/\/+$/, "");
    if (!baseUrl) baseUrl = Config.AI_BASE_URL;
    var model = opts.model || settings.model || Config.AI_DEFAULT_MODEL;
    var timeout = opts.timeout || Config.AI_TIMEOUT_MS;

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeout);

    return fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        stream: false,
        temperature: 0.7
      }),
      signal: controller.signal
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) {
          var msg = (json && json.error && json.error.message) || ("HTTP " + res.status);
          return { ok: false, err: errKey(res.status), text: msg };
        }
        var content = json && json.choices && json.choices[0] &&
          json.choices[0].message && json.choices[0].message.content;
        if (!content) {
          return { ok: false, err: "unknown", text: "AI 返回内容为空" };
        }
        return { ok: true, text: String(content) };
      });
    }).catch(function (e) {
      if (e && e.name === "AbortError") {
        return { ok: false, err: "timeout", text: errText("timeout") };
      }
      return { ok: false, err: "network", text: errText("network") };
    }).finally(function () {
      clearTimeout(timer);
    });
  }

  /**
   * 测试连接：最小请求验证 Key 有效性（P1）。
   * @param {{key?: string, baseUrl?: string, model?: string}} [opts]
   * @returns {Promise<{ok: boolean, text?: string, err?: string}>}
   */
  function testConnection(opts) {
    return chat([{ role: "user", content: "你好，请只回复 OK" }], opts);
  }

  window.App = window.App || {};
  window.App.AI = window.App.AI || {};
  window.App.AI.LLM = {
    chat: chat,
    buildSystemContext: buildSystemContext,
    testConnection: testConnection,
    errText: errText
  };
})();
