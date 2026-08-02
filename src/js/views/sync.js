/**
 * sync.js — 云端同步模块
 * 同步状态 / 上次同步时间 / 数据量统计 / 立即同步 / 令牌信息 / 页面二维码（可选）
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var State = window.App.State;
  var Cloud = window.App.Cloud;
  var Auth = window.App.Auth;
  var Router = window.App.Router;

  var container = null;
  var statusEl = null;

  function render(el) {
    container = el;
    var hasToken = Cloud.hasToken();
    el.innerHTML =
      '<div class="card">' +
        '<h2>云端同步 <span class="tag">GitHub Pages</span></h2>' +
        '<div class="sync-panel">' +
          '<div class="sync-row"><span class="sync-k">同步状态</span><span class="sync-v" id="syncStateText">' +
            (hasToken ? "就绪" : "未配置令牌（本机模式）") + '</span></div>' +
          '<div class="sync-row"><span class="sync-k">上次同步</span><span class="sync-v" id="syncLastTime">' +
            (State.lastSync ? Util.fmtDateTime(State.lastSync) : "尚未同步") + '</span></div>' +
          '<div class="sync-row"><span class="sync-k">本地记录数</span><span class="sync-v" id="syncLocalCount">' +
            State.list.length + ' 条</span></div>' +
          '<div class="sync-row"><span class="sync-k">云端令牌</span><span class="sync-v" id="syncTokenInfo">' +
            (hasToken ? "已注入（部署时自动）" : "未注入，可在 localStorage 设置 gh_token") + '</span></div>' +
        '</div>' +
        '<div class="actions">' +
          '<button type="button" class="btn" id="syncNow">' + UI.icon("sync", 16) + '<span>立即同步</span></button>' +
          '<button type="button" class="btn ghost" id="syncLogout">退出登录</button>' +
        '</div>' +
        '<div class="sync-err" id="syncErr"></div>' +
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
    renderQr();
  }

  /** 云端同步后刷新统计 */
  function refresh() {
    if (!container) return;
    if (statusEl) statusEl.textContent = Cloud.hasToken() ? "就绪" : "未配置令牌（本机模式）";
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
      if (err) err.textContent = "未配置云端令牌：请检查部署配置或在 localStorage 设置 gh_token。";
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
      if (!res.ok && err) {
        err.textContent = "同步失败：" + (res.error && res.error.message ? res.error.message : "未知错误");
      }
    });
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.sync = { render: render, refresh: refresh, doSync: doSync };
})();
