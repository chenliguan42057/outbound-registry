/**
 * sync.js — 云端同步模块
 * 同步状态 / 上次同步时间 / 数据量统计 / 立即同步 / 令牌信息 / 云端令牌设置 / 页面二维码（可选）
 * 云端令牌设置：查看（掩码展示）/ 保存（localStorage gh_token）/ 清除；部署注入令牌优先，本地兜底。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Config = window.App.Config;
  var State = window.App.State;
  var Cloud = window.App.Cloud;
  var Auth = window.App.Auth;
  var Router = window.App.Router;

  var container = null;
  var statusEl = null;
  var countdownTimer = null;   // 「下次自动同步」倒计时定时器（仅同步面板挂载期间运行）

  /** 令牌掩码：ghp_****abcd（>8 位保留前 4 后 4，短令牌仅留后 4） */
  function maskToken(t) {
    t = String(t || "");
    return t.length > 8 ? t.slice(0, 4) + "****" + t.slice(-4) : "****" + t.slice(-4);
  }

  /**
   * 令牌状态三元组：
   * { source: "部署注入" | "本地设置" | "未配置", mask, has }
   * 优先判断是否等于注入令牌；否则若本地有保存则视为本地设置；其余为未配置。
   */
  function tokenInfo() {
    var injected = (window.__GH_TOKEN__ && window.__GH_TOKEN__.indexOf("__") !== 0)
      ? window.__GH_TOKEN__ : "";
    var local = localStorage.getItem(Config.GH_TOKEN_KEY) || "";
    var t = Config.GH.token || "";
    if (!t) return { source: "未配置", mask: "", has: false };
    if (injected === t) return { source: "部署注入", mask: maskToken(t), has: true };
    return { source: "本地设置", mask: maskToken(t), has: true };
  }

  function render(el) {
    container = el;
    stopCountdown();   // 重新渲染前清理旧倒计时，防止重复定时器
    var hasToken = Cloud.hasToken();
    var info = tokenInfo();
    var autoSec = Math.round(Config.AUTO_SYNC_INTERVAL_MS / 1000);
    el.innerHTML =
      '<div class="card">' +
        '<h2>云端同步 <span class="tag">GitHub Pages</span></h2>' +
        '<div class="sync-panel">' +
          '<div class="sync-row"><span class="sync-k">同步状态</span><span class="sync-v" id="syncStateText">' +
            (hasToken ? "就绪" : "未配置令牌（本机模式）") + '</span></div>' +
          '<div class="sync-row"><span class="sync-k">自动同步</span><span class="sync-v"><span class="tag" id="syncAutoBadge">' +
            (hasToken ? "已开启（每 " + autoSec + " 秒）" : "未开启") + '</span></span></div>' +
          '<div class="sync-row"><span class="sync-k">下次自动同步</span><span class="sync-v" id="syncNextSync">' +
            (hasToken ? "即将同步…" : "—") + '</span></div>' +
          '<div class="sync-row"><span class="sync-k">上次同步</span><span class="sync-v" id="syncLastTime">' +
            (State.lastSync ? Util.fmtDateTime(State.lastSync) : "尚未同步") + '</span></div>' +
          '<div class="sync-row"><span class="sync-k">本地记录数</span><span class="sync-v" id="syncLocalCount">' +
            State.list.length + ' 条</span></div>' +
          '<div class="sync-row"><span class="sync-k">云端令牌</span><span class="sync-v" id="syncTokenInfo">' +
            (info.has ? info.source : "未配置（本机模式）") + '</span></div>' +
          '<div class="sync-row"><span class="sync-k">令牌掩码</span><span class="sync-v" id="syncTokenMask">' +
            (info.has ? info.mask : "—") + '</span></div>' +
        '</div>' +
        '<div class="actions">' +
          '<button type="button" class="btn" id="syncNow">' + UI.icon("sync", 16) + '<span>立即同步</span></button>' +
          '<button type="button" class="btn ghost" id="syncLogout">退出登录</button>' +
        '</div>' +
        '<div class="hint">自动同步：手机/电脑只要打开页面就会定时从云端拉取，最迟约 ' + autoSec +
          ' 秒；切回页面会立即同步，无需手动操作。</div>' +
        '<div class="sync-err" id="syncErr"></div>' +
      '</div>' +
      '<div class="card">' +
        '<h2>云端令牌设置 <span class="tag">Contents API</span></h2>' +
        '<div class="field">' +
          '<label>设置 GitHub 令牌</label>' +
          '<input type="password" id="syncTokenInput" placeholder="粘贴 GitHub 令牌" autocomplete="off" />' +
        '</div>' +
        '<div class="actions">' +
          '<button type="button" class="btn sm" id="syncTokenSave">保存令牌</button>' +
          '<button type="button" class="btn ghost sm" id="syncTokenClear">清除本地令牌</button>' +
        '</div>' +
        '<div class="hint">部署版已自动注入令牌，通常无需手动设置；此处用于本地调试 / 未注入场景。' +
          '令牌仅保存在本机 localStorage（gh_token），不会写入记录数据。</div>' +
      '</div>' +
      '<div class="card">' +
        '<h2>页面二维码 <span class="tag">扫码打开</span></h2>' +
        '<div id="syncQr"></div>' +
        '<div class="hint">手机扫码即可打开同一网址，数据自动同步。</div>' +
      '</div>';
    statusEl = Util.$("syncStateText");
    Util.$("syncNow").addEventListener("click", doSync);
    Util.$("syncLogout").addEventListener("click", async function () {
      var ok = await UI.confirmDialog("退出登录后需重新输入密码。确定退出？", "退出登录");
      if (!ok) return;
      Auth.logout();
      Util.toast("已退出登录");
      Router.navigate("/");
    });
    Util.$("syncTokenSave").addEventListener("click", saveToken);
    Util.$("syncTokenClear").addEventListener("click", clearToken);
    renderQr();
    startCountdown();
  }

  /** 「下次自动同步」倒计时：每秒刷新徽标与剩余秒数 */
  function startCountdown() {
    stopCountdown();
    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 1000);
  }

  /** 停止倒计时（重新渲染 / 离开 #/app 时调用） */
  function stopCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  /** 刷新自动同步徽标 + 倒计时文案；未开启则显示「未开启」 */
  function updateCountdown() {
    var appView = window.App.Views.app;
    var on = !!(appView && appView.isAutoSyncOn && appView.isAutoSyncOn());
    var badge = Util.$("syncAutoBadge");
    if (badge) {
      badge.textContent = on
        ? "已开启（每 " + Math.round(Config.AUTO_SYNC_INTERVAL_MS / 1000) + " 秒）"
        : "未开启";
    }
    var el = Util.$("syncNextSync");
    if (!el) return;
    if (!on) { el.textContent = "未开启"; return; }
    var sec = appView.nextSyncRemainSec();
    el.textContent = sec === null ? "即将同步…" : (sec + " 秒后");
  }

  /** 保存本地令牌：写 localStorage gh_token → 刷新 Config.GH.token → 更新状态行 */
  function saveToken() {
    var input = Util.$("syncTokenInput");
    var val = (input && input.value || "").trim();
    if (!val) { Util.toast("请输入令牌", true); return; }
    localStorage.setItem(Config.GH_TOKEN_KEY, val);
    Config.refreshToken();
    if (input) input.value = "";
    Util.toast("令牌已保存");
    if (window.App.Views.app && window.App.Views.app.startAutoSync) {
      window.App.Views.app.startAutoSync();   // 令牌就绪后立即开启自动同步（幂等）
    }
    renderTokenInfo();
  }

  /** 清除本地令牌：确认后删除 → 刷新 Config.GH.token（恢复为仅依赖注入令牌或未配置） */
  async function clearToken() {
    var ok = await UI.confirmDialog("确定清除本地保存的令牌？清除后仅依赖部署注入令牌（若有）。", "清除本地令牌");
    if (!ok) return;
    localStorage.removeItem(Config.GH_TOKEN_KEY);
    Config.refreshToken();
    Util.toast("已清除本地令牌");
    if (!Cloud.hasToken() && window.App.Views.app && window.App.Views.app.stopAutoSync) {
      window.App.Views.app.stopAutoSync();    // 令牌消失则停止自动同步
    }
    renderTokenInfo();
  }

  /** 更新令牌状态行（保存/清除后调用） */
  function renderTokenInfo() {
    var info = tokenInfo();
    var tInfo = Util.$("syncTokenInfo");
    var tMask = Util.$("syncTokenMask");
    if (tInfo) tInfo.textContent = info.has ? info.source : "未配置（本机模式）";
    if (tMask) tMask.textContent = info.has ? info.mask : "—";
    var st = Util.$("syncStateText");
    if (st) st.textContent = info.has ? "就绪" : "未配置令牌（本机模式）";
  }

  /** 云端同步后刷新统计 */
  function refresh() {
    if (!container) return;
    renderTokenInfo();
    var last = Util.$("syncLastTime");
    if (last) last.textContent = State.lastSync ? Util.fmtDateTime(State.lastSync) : "尚未同步";
    var cnt = Util.$("syncLocalCount");
    if (cnt) cnt.textContent = State.list.length + " 条";
  }

  function renderQr() {
    var box = Util.$("syncQr");
    if (!box) return;
    box.innerHTML = "";
    if (typeof qrcode === "undefined") {
      box.innerHTML = '<div class="hint">二维码组件未加载。</div>';
      return;
    }
    var url = location.href.split("#")[0];
    var qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    var img = document.createElement("img");
    img.src = qr.createDataURL(5, 5);
    img.alt = "页面二维码";
    img.style.width = "160px";
    img.style.height = "160px";
    box.appendChild(img);
  }

  function doSync() {
    if (!Cloud.hasToken()) {
      Util.toast("未配置云端令牌，无法同步", true);
      var err = Util.$("syncErr");
      if (err) err.textContent = "未配置云端令牌：请检查部署配置或在下方「云端令牌设置」保存 gh_token。";
      return;
    }
    var err = Util.$("syncErr");
    if (err) err.textContent = "";
    Util.toast("正在同步…");
    Cloud.syncPull({ onStatus: function (text, isErr) {
      window.App.Views.app.setSyncStatus(text, isErr);
      if (statusEl) statusEl.textContent = text;
    } }).then(function (res) {
      refresh();
      if (res.ok && window.App.Views.app && window.App.Views.app.scheduleNextSync) {
        window.App.Views.app.scheduleNextSync();   // 手动同步成功后重置倒计时
      }
      updateCountdown();
      if (!res.ok && err) {
        err.textContent = "同步失败：" + (res.error && res.error.message ? res.error.message : "未知错误");
      }
    });
  }

  /* 离开 #/app 时停止倒计时（返回时 render 会重新启动），避免残留定时器 */
  window.addEventListener("hashchange", function () {
    if (window.App.Router.parse().base !== "app") stopCountdown();
    else if (container) startCountdown();
  });

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.sync = { render: render, refresh: refresh, doSync: doSync, startCountdown: startCountdown, stopCountdown: stopCountdown };
})();
