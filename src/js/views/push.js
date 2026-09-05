/**
 * push.js — 推送信息中心（2026-09-05）
 *
 * 向「当前仓库」的钉钉群推送常用信息或自定义文字：
 *   · 预设一键推送：库存总览 / 低库存清单 / 最近流水 / 今日出入库统计 / 待取货待办
 *   · 自定义编辑：自己写文字，点发送即推送到群
 * 推送对象 = 顶栏系统切换器所在仓库（切到深圳细胞 → 发深圳群；切到赛迪斯 → 发赛迪斯群）。
 *
 * 实现：把 {type:"pushmenu", text} 写到云端 data|data-saidis/notify/pushmenu/<ts>.json，
 * 由 GitHub Actions「DingTalk Pushmenu」读取并推送到对应钉钉群（密钥在 repo secrets，页面不接触）。
 * 发送到群里约需 30~60 秒（Actions 排队）。
 * 消息首行统一带「【仓名】出入库登记 · 标题」，同时覆盖两个群机器人的关键词安全设置。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Config = window.App.Config;
  var Stock = window.App.Stock;
  var State = window.App.State;
  var Cloud = window.App.Cloud;

  var container = null;

  function curName() { return Config.Sys.name(); }

  /** 消息首行：带群机器人关键词（深圳=出入库登记 / 赛迪斯=赛迪斯） */
  function header(title) {
    return "【" + curName() + "】出入库登记 · " + title;
  }

  /** 货品预警线（每品 warnAt，缺省全局阈值） */
  function warnAtOf(name) {
    var w = Config.WARN_AT && Config.WARN_AT[name];
    return (w !== undefined && w !== null && !isNaN(Number(w))) ? Number(w) : (Config.LOW_STOCK_THRESHOLD || 95);
  }

  /** 短时间 MM-DD HH:mm */
  function shortTime(t) {
    return String(t || "").slice(5, 16) || "-";
  }

  /* ---------- 预设内容生成 ---------- */

  function buildStockText() {
    var summary = (Stock && Stock.summarize) ? Stock.summarize() : [];
    if (!summary.length) return "";
    var lines = [], low = [];
    summary.forEach(function (s, i) {
      var isLow = s.stock < warnAtOf(s.name);
      if (isLow) low.push(s.name + "(剩" + s.stock + "/预警" + warnAtOf(s.name) + ")");
      lines.push((i + 1) + ". " + s.name + "：库存 " + s.stock + (isLow ? " ⚠️" : ""));
    });
    return header("库存总览") +
      "\n\n📦 当前库存（共 " + summary.length + " 项）：\n" + lines.join("\n") +
      (low.length ? "\n\n⚠️ 低库存：" + low.join("、") : "\n\n✅ 无低库存货品");
  }

  function buildLowText() {
    var summary = (Stock && Stock.summarize) ? Stock.summarize() : [];
    var low = summary.filter(function (s) { return s.stock < warnAtOf(s.name); });
    if (!low.length) return header("低库存清单") + "\n\n✅ 当前无低库存货品";
    return header("低库存清单") + "\n\n⚠️ 共 " + low.length + " 项低于预警线：\n" +
      low.map(function (s, i) { return (i + 1) + ". " + s.name + "：库存 " + s.stock + "（预警线 " + warnAtOf(s.name) + "）"; }).join("\n");
  }

  function recTag(r) {
    if (r.fromBorrowId) return "（借还）";
    if (r.transferId) return "（调拨）";
    return "";
  }

  function buildFlowText() {
    var list = (State && State.list) || [];
    var recent = list.slice().sort(function (a, b) { return (b._ts || 0) - (a._ts || 0); }).slice(0, 10);
    if (!recent.length) return header("最近流水") + "\n\n暂无出入库记录";
    var lines = recent.map(function (r) {
      var items = (r.items || []).map(function (it) { return it.name + "×" + it.qty; }).join("、");
      var kind = r.type === "in" ? "入库" : "出库";
      return "· [" + shortTime(r.time) + "] " + kind + " " + items + recTag(r) + "　经办：" + (r.picker || "-");
    });
    return header("最近流水") + "\n\n🕘 最近 " + recent.length + " 条出入库：\n" + lines.join("\n");
  }

  function buildTodayText() {
    var list = (State && State.list) || [];
    var today = Util.todayLocal ? Util.todayLocal() : new Date().toISOString().slice(0, 10);
    var todayRecs = list.filter(function (r) { return String(r.time || "").indexOf(today) === 0; });
    var inQty = 0, inN = 0, outQty = 0, outN = 0;
    todayRecs.forEach(function (r) {
      (r.items || []).forEach(function (it) {
        var q = Number(it.qty) || 0;
        if (r.type === "in") { inQty += q; inN++; } else { outQty += q; outN++; }
      });
    });
    return header("今日出入库统计") + "\n\n📅 今天 " + today + "：\n· 入库：共 " + inN + " 笔 / " + inQty + " 件\n· 出库：共 " + outN + " 笔 / " + outQty + " 件";
  }

  function buildPickupsText() {
    var list = (State && State.pickups) || [];
    var pending = list.filter(function (p) { return !p.shipped; }).slice(0, 8);
    if (!pending.length) return header("待取货待办") + "\n\n✅ 暂无待取货";
    var lines = pending.map(function (p, i) {
      var items = (p.items || []).map(function (it) { return it.name + "×" + it.qty; }).join("、");
      return (i + 1) + ". [" + shortTime(p.time || p._ts) + "] " + items + (p.note ? "（" + p.note + "）" : "");
    });
    return header("待取货待办") + "\n\n🕘 当前待取货 " + pending.length + " 条：\n" + lines.join("\n");
  }

  /* ---------- 发送 ---------- */

  function lockBtn(btn) {
    if (!btn) return { unlock: function () {} };
    if (btn.dataset.busy === "1") return { locked: true, unlock: function () {} };
    btn.dataset.busy = "1";
    btn.disabled = true;
    btn.classList.add("loading");
    return {
      locked: false,
      unlock: function () {
        if (!btn.isConnected) return;
        btn.dataset.busy = "0";
        btn.disabled = false;
        btn.classList.remove("loading");
      }
    };
  }

  /** 富文本预览确认弹窗：bodyHtml 原样渲染（内容里的动态文本需自行转义）。
      UI.confirmDialog 会对文本整体做 Util.esc，不适合带样式的预览，故这里直接走 Modal。
      点「确认发送」→ resolve(true)；取消按钮 / 点 X / 点遮罩 → resolve(false)。 */
  function confirmSend(bodyHtml, title) {
    return new Promise(function (resolve) {
      UI.Modal.show(title || "请确认", bodyHtml, { width: "min(92vw, 540px)" });
      var body = UI.Modal.body();
      function done(v) { try { UI.Modal.hide(); } catch (e) {} resolve(v); }
      var okBtn = body.querySelector("[data-act=ok]");
      var noBtn = body.querySelector("[data-act=cancel]");
      if (okBtn) okBtn.onclick = function () { done(true); };
      if (noBtn) noBtn.onclick = function () { done(false); };
      // X / 遮罩关闭 = 取消（组件自带的 hide 不会 resolve，这里补一个一次性监听）
      var modalEl = document.querySelector("#modal-root .modal");
      if (modalEl) {
        modalEl.addEventListener("click", function (e) {
          if (e.target === modalEl || (e.target.getAttribute && e.target.getAttribute("data-act") === "close")) {
            done(false);
          }
        }, { once: true });
      }
    });
  }

  /** 预览 + 确认 + 写入云端 pushmenu 文件（由 Actions 推群） */
  function askSend(title, text, btn) {
    if (!text || !text.trim()) { Util.toast("没有可发送的内容", true); return; }
    if (!Cloud || !Cloud.hasToken()) {
      Util.toast("⚠️ 未配置云端令牌，推送需要云端同步，请先联系管理员", true);
      return;
    }
    var preview =
      '<div class="hint" style="margin:0 0 10px">将推送到 <b>' + Util.esc(curName()) + '</b> 钉钉群（约 <b>30~60 秒</b>送达）：</div>' +
      '<div style="max-height:46vh;overflow:auto;padding:10px 12px;border:1px solid var(--line-soft,#DCE6E0);border-radius:10px;background:var(--input-bg,#FBFCFA);white-space:pre-wrap;word-break:break-all;font-size:13px;line-height:1.75">' +
      Util.esc(text) + '</div>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
        '<button type="button" class="btn sm" data-act="ok">确认发送</button>' +
      '</div>';
    confirmSend(preview, "📣 " + title).then(function (ok) {
      if (!ok) return;
      var lock = lockBtn(btn);
      if (lock.locked) return;
      doSend(text, title, lock);
    })["catch"](function () {});
  }

  async function doSend(text, title, lock) {
    try {
      var ts = Date.now();
      var id = String(ts) + "-" + Math.random().toString(36).slice(2, 7);
      var ok = await Cloud.putJsonFile({
        dataDir: Config.Sys.current().dataDir,
        subdir: "notify/pushmenu",
        id: id,
        payload: { type: "pushmenu", time: new Date().toISOString(), title: title, text: text },
        message: "pushmenu " + title + " " + id
      });
      if (ok) {
        Util.toast("✅ 已提交推送，约 30~60 秒内送达「" + curName() + "」钉钉群");
      } else {
        Util.toast("❌ 推送提交失败（网络/令牌），请重试", true);
      }
    } catch (e) {
      Util.toast("推送失败：" + ((e && e.message) || e), true);
    } finally {
      if (lock) lock.unlock();
    }
  }

  /* ---------- 渲染 ---------- */

  function presetBtn(id, icon, label, tip) {
    return '<button type="button" class="btn ghost sm" id="' + id + '" style="justify-content:flex-start;padding:9px 12px;height:auto;line-height:1.5">' +
      icon + ' ' + Util.esc(label) + '<br><span class="hint" style="margin:0;font-size:12px">' + Util.esc(tip) + '</span></button>';
  }

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="card">' +
        '<h2>推送信息 <span class="tag">群通知</span></h2>' +
        '<div class="hint" style="margin:-4px 0 14px;line-height:1.9">' +
          '把系统里的信息推送到钉钉群。当前推送对象：<b>' + Util.esc(curName()) + '</b> 群 —— 在左侧栏顶部切换仓库即切换推送对象。' +
          '发送后约 <b>30~60 秒</b>送达（由云端任务转发）。推送内容取自本机已同步数据，若刚在其他设备登记过，请先到「云端同步」拉取最新再推送。' +
        '</div>' +
        '<div class="field"><label>一键推送</label>' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px">' +
            presetBtn("pmStock", "📦", "库存总览", "全部货品当前库存 + 低库存提示") +
            presetBtn("pmLow", "⚠️", "低库存清单", "低于预警线的货品") +
            presetBtn("pmFlow", "🕘", "最近流水", "最近 10 条出入库明细") +
            presetBtn("pmToday", "📅", "今日出入库统计", "今天入库/出库笔数与件数") +
            presetBtn("pmPickups", "🛍️", "待取货待办", "当前未出库的待取货清单") +
          '</div>' +
        '</div>' +
        '<div class="field" style="margin-top:16px"><label for="pmCustom">自定义发送</label>' +
          '<textarea id="pmCustom" rows="5" maxlength="1500" placeholder="在这里编辑要发送到群里的文字，可自由编写，如：今天下午 2 点盘点，请大家先不要领用。" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--input-line,#C6DAD1);border-radius:10px;background:var(--input-bg,#FBFCFA);font-family:inherit;font-size:13.5px;line-height:1.8;resize:vertical"></textarea>' +
          '<div class="actions" style="margin-top:8px">' +
            '<button type="button" class="btn sm" id="pmSend">📣 发送到群</button>' +
            '<span class="hint" style="margin-left:10px">消息首部会自动加「【' + Util.esc(curName()) + '】出入库登记」标识</span>' +
          '</div>' +
        '</div>' +
        '<div id="pmLog" style="margin-top:10px"></div>' +
      '</div>';

    var bind = function (id, title, fn) {
      var b = Util.$(id);
      if (b) b.addEventListener("click", function () {
        var text = fn();
        if (!text) { Util.toast("没有可发送的内容", true); return; }
        askSend(title, text, b);
      });
    };
    bind("pmStock", "库存总览", buildStockText);
    bind("pmLow", "低库存清单", buildLowText);
    bind("pmFlow", "最近流水", buildFlowText);
    bind("pmToday", "今日出入库统计", buildTodayText);
    bind("pmPickups", "待取货待办", buildPickupsText);

    var sendBtn = Util.$("pmSend");
    if (sendBtn) sendBtn.addEventListener("click", function () {
      var t = (Util.$("pmCustom").value || "").trim();
      if (!t) { Util.toast("请先输入要发送的内容", true); return; }
      askSend("自定义消息", header("自定义消息") + "\n\n" + t, sendBtn);
    });
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.push = { render: render };
})();
