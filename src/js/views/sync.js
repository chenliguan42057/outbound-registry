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
        '<h2>照片补传 <span class="tag">弱网恢复</span></h2>' +
        '<div class="sync-row"><span class="sync-k">待补传</span><span class="sync-v" id="syncPhotoPending">—</span></div>' +
        '<div class="actions">' +
          '<button type="button" class="btn sm" id="syncRetryPhotos">📷 补传照片</button>' +
        '</div>' +
        '<div class="hint">提交时因弱网/配额上传失败的照片会列在这里（原始照片保留在本机不会丢）。点击「补传照片」自动重试。</div>' +
      '</div>' +
      '<div class="card">' +
        '<h2>待推送队列 <span class="tag">未同步恢复</span></h2>' +
        '<div class="sync-row"><span class="sync-k">待推送</span><span class="sync-v" id="syncQueueCount">—</span></div>' +
        '<div class="sync-queue-list" id="syncQueueList"></div>' +
        '<div class="actions">' +
          '<button type="button" class="btn sm" id="syncFlushQueue">↻ 一键重推</button>' +
        '</div>' +
        '<div class="hint">提交时因网络/配额/令牌问题未推上云端的记录会暂存在本机队列（不丢数据）。' +
          '点击「一键重推」立即补推并触发钉钉通知；也可完全关闭页面后重新打开自动补推。</div>' +
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
        '<h2>数据备份与恢复 <span class="tag">本地文件</span></h2>' +
        '<div class="actions">' +
          '<button type="button" class="btn sm" id="syncBackup">&#11015; 导出备份</button>' +
          '<button type="button" class="btn ghost sm" id="syncRestore">&#128260; 恢复备份</button>' +
          '<button type="button" class="btn ghost sm" id="syncConflict">⚠️ 冲突检查</button>' +
          '<input type="file" id="syncRestoreFile" accept="application/json,.json" hidden />' +
        '</div>' +
        '<div class="hint">备份=下载全部数据（记录/待取货/备忘录/货品目录）为单个 JSON；恢复=合并导入该文件；冲突检查=发现被云端覆盖的本地较新修改并可恢复。</div>' +
      '</div>' +
      '<div class="card">' +
        '<h2>页面二维码 <span class="tag">扫码打开</span></h2>' +
        '<div id="syncQr"></div>' +
        '<div class="hint">手机扫码即可打开同一网址，数据自动同步。</div>' +
      '</div>';
    statusEl = Util.$("syncStateText");
    Util.$("syncNow").addEventListener("click", doSync);
    Util.$("syncRetryPhotos").addEventListener("click", retryAllPhotos);
    renderPhotoPending();
    renderSyncQueue();
    var flushBtn = Util.$("syncFlushQueue");
    if (flushBtn) flushBtn.addEventListener("click", flushSyncQueue);
    Util.$("syncLogout").addEventListener("click", async function () {
      var ok = await UI.confirmDialog("退出登录后需重新输入密码。确定退出？", "退出登录");
      if (!ok) return;
      Auth.logout();
      Util.toast("已退出登录");
      Router.navigate("/");
    });
    Util.$("syncTokenSave").addEventListener("click", saveToken);
    Util.$("syncTokenClear").addEventListener("click", clearToken);
    Util.$("syncBackup").addEventListener("click", doBackup);
    Util.$("syncRestore").addEventListener("click", function () { Util.$("syncRestoreFile").click(); });
    Util.$("syncRestoreFile").addEventListener("change", doRestore);
    Util.$("syncConflict").addEventListener("click", showConflicts);
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

  /* ================= C1 一键备份/恢复 ================= */
  function doBackup() {
    var pkg = {
      exportedAt: new Date().toISOString(),
      records: State.list,
      pickups: State.pickups || [],
      memos: State.memos || [],
      catalog: (window.App.Catalog && window.App.Catalog.get()) || null
    };
    // 文件名用本地日期（toISOString 是 UTC，东八区 08:00 前会写成前一天）；
    // pkg.exportedAt 保留 ISO/UTC，那是机器可解析的绝对时刻，无歧义。
    Util.download("进销存备份_" + Util.todayLocal() + ".json",
      JSON.stringify(pkg, null, 1), "application/json;charset=utf-8");
    Util.toast("备份已下载");
  }
  function doRestore() {
    var input = Util.$("syncRestoreFile");
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      input.value = "";
      var data;
      try { data = JSON.parse(reader.result); } catch (e) { Util.toast("备份文件解析失败", true); return; }
      var hasRecords = Array.isArray(data.records);
      var hasPickups = Array.isArray(data.pickups);
      var hasMemos = Array.isArray(data.memos);
      if (!hasRecords && !hasPickups && !hasMemos) { Util.toast("未识别到备份数据（需含 records/pickups/memos 数组）", true); return; }
      var ok = await UI.confirmDialog(
        "将合并导入备份：记录 " + (data.records || []).length + " 条、待取货 " + (data.pickups || []).length +
        " 条、备忘录 " + (data.memos || []).length + " 条。同 id 以备份覆盖本地。继续？", "恢复备份");
      if (!ok) return;
      if (hasRecords) {
        State.list = window.App.Records.mergeAndSort(State.list, data.records);
        Store.saveRecords(State.list);
      }
      if (hasPickups) {
        State.pickups = window.App.Pickups.mergeAndSort(State.pickups, data.pickups);
        Store.savePickups(State.pickups);
      }
      if (hasMemos) {
        State.memos = window.App.Memos.mergeAndSort(State.memos, data.memos);
        Store.saveMemos(State.memos);
      }
      if (data.catalog && window.App.Catalog && window.App.Catalog.save) {
        await window.App.Catalog.save(data.catalog, function () {});
      }
      if (Cloud.hasToken()) {
        try {
          await Cloud.pushAllLocal();
          await Cloud.pushAllPickups();
          await Cloud.pushAllMemos();
        } catch (e) {}
      }
      Util.toast("备份已恢复并合并");
      if (window.App.Views.app && window.App.Views.app.updateStatusBar) window.App.Views.app.updateStatusBar();
      refresh();
    };
    reader.readAsText(file, "utf-8");
  }

  /* ================= C2 同步冲突可视化 ================= */
  async function showConflicts() {
    if (!Cloud.hasToken()) { Util.toast("未配置云端令牌，无法检查", true); return; }
    var lastSync = State.lastSync ? State.lastSync.getTime() : 0;
    var before = {};
    State.list.forEach(function (r) { if ((r._ts || 0) > lastSync) before[r.id] = r; });
    var res = await Cloud.syncPull({ onStatus: function () {} });
    if (!res.ok) { Util.toast("同步失败，无法检查冲突", true); return; }
    var now = {};
    State.list.forEach(function (r) { now[r.id] = r; });
    var conflicts = [];
    Object.keys(before).forEach(function (id) {
      var b = before[id];
      var n = now[id];
      if (n && JSON.stringify(b) !== JSON.stringify(n)) conflicts.push({ id: id, local: b, remote: n });
    });
    if (!conflicts.length) { Util.toast("未发现冲突：本地修改均已同步"); return; }
    var rows = conflicts.map(function (c) {
      var fmt = function (r) {
        return String(r.time || "").replace("T", " ") + "　" + (r.picker || "") + "　" +
          (r.items || []).map(function (it) { return it.name + "×" + it.qty; }).join("、");
      };
      return '<div style="border:1px solid var(--line-soft,#DCE6E0);border-radius:12px;padding:10px 12px;margin-bottom:10px">' +
        '<div style="font-size:13px;font-weight:600;color:var(--err,#C9877F)">' + Util.esc(c.id.slice(0, 12)) + ' · 本地较新却被云端覆盖</div>' +
        '<div class="hint" style="margin:6px 0">本地：' + Util.esc(fmt(c.local)) + '</div>' +
        '<div class="hint" style="margin-bottom:8px">云端：' + Util.esc(fmt(c.remote)) + '</div>' +
        '<button type="button" class="btn sm" data-restore="' + Util.esc(c.id) + '">恢复本地版本</button>' +
      '</div>';
    }).join("");
    UI.Modal.show("⚠️ 同步冲突（" + conflicts.length + " 处）", rows, { width: "560px" });
    var mBody = UI.Modal.body();
    mBody.addEventListener("click", async function (e) {
      var b = e.target.closest("[data-restore]");
      if (!b) return;
      var id = b.getAttribute("data-restore");
      var local = null;
      conflicts.forEach(function (c) { if (c.id === id) local = c.local; });
      if (!local) return;
      b.disabled = true; b.textContent = "恢复中…";
      var rec = window.App.Records.update(id, local);
      try { await Cloud.pushRecord(rec); } catch (e) {}
      Util.toast("已恢复本地版本并推送云端");
      b.textContent = "✓ 已恢复";
    });
  }

  /* 倒计时只在「云端同步」面板真正可见时运行。
     原判据是 `container` 是否存在，但 container 一经 render 就永久保留，
     用户切到别的模块后倒计时仍在空转，每秒操作一次已被移除的 DOM。 */
  function syncPanelVisible() {
    var S = window.App.State;
    return window.App.Router.parse().base === "app" &&
           S && S.nav && S.nav.active === "sync" &&
           !!(container && container.isConnected);
  }
  window.addEventListener("hashchange", function () {
    if (syncPanelVisible()) startCountdown();
    else stopCountdown();
  });

  // 队列变化实时刷新本页列表（模块级只绑一次；去重由 cloud.js onQueueChange 保证）
  if (Cloud.onQueueChange) Cloud.onQueueChange(function () { if (syncPanelVisible()) renderSyncQueue(); });

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  // destroy：由 app.mount 在切换模块前调用，回收本视图持有的定时器
  window.App.Views.sync = { render: render, refresh: refresh, doSync: doSync, startCountdown: startCountdown, stopCountdown: stopCountdown, destroy: stopCountdown };

  /* ================= 照片补传（弱网失败恢复） ================= */

  /** 刷新「待补传」统计文案 */
  function renderPhotoPending() {
    var el = Util.$("syncPhotoPending");
    if (!el) return;
    var q = (Cloud.loadPhotoPending && Cloud.loadPhotoPending()) || [];
    var extra = 0;
    (State.list || []).forEach(function (r) {
      if ((r.photos || []).length > (r.photoUrls || []).length) extra++;
    });
    (window.App.State.memos || []).forEach(function (m) {
      if ((m.photos || []).length > (m.photoUrls || []).length) extra++;
    });
    var n = q.length + extra;
    el.textContent = n > 0 ? n + " 条记录（" + (q.length ? "队列 " + q.length : "") + (q.length && extra ? " + " : "") + (extra ? "缺失 " + extra : "") + "）" : "无";
  }

  /** 渲染「待推送队列」列表：每条显示领取人 + 时间 + 货品摘要 */
  function renderSyncQueue() {
    var cnt = Util.$("syncQueueCount");
    var listEl = Util.$("syncQueueList");
    if (!cnt) return;
    var items = (Cloud.getQueue ? Cloud.getQueue() : []) || [];
    cnt.textContent = items.length ? items.length + " 条" : "无";
    if (!listEl) return;
    if (!items.length) { listEl.innerHTML = ""; return; }
    listEl.innerHTML = items.map(function (it) {
      var rec = it.rec;
      var head = "⚠️ " + Util.esc(it.id.slice(0, 12));
      if (rec) {
        head = "⚠️ " + Util.esc(rec.picker || "-") +
          (rec.time ? "　📅 " + Util.esc(String(rec.time).replace("T", " ")) : "");
      }
      var goods = "";
      if (rec && (rec.items || []).length) {
        goods = '<div class="hint" style="margin:4px 0 0 0">' + Util.esc(
          (rec.items || []).map(function (x) { return x.name + "×" + x.qty; }).join("、")
        ) + '</div>';
      }
      return '<div style="border:1px solid var(--line-soft,#DCE6E0);border-radius:10px;padding:8px 10px;margin-bottom:8px;font-size:13px">' +
        head + goods + '</div>';
    }).join("");
  }

  /** 一键重推待推送队列（无令牌 / 无队列给明确提示） */
  async function flushSyncQueue() {
    if (!Cloud.hasToken()) { Util.toast("未配置云端令牌，无法重推", true); return; }
    var items = (Cloud.getQueue ? Cloud.getQueue() : []) || [];
    if (!items.length) { Util.toast("没有待推送的记录"); return; }
    var btn = Util.$("syncFlushQueue");
    if (btn) { btn.disabled = true; btn.textContent = "重推中…"; }
    try {
      var r = await Cloud.flushQueue();
      renderSyncQueue();
      updateStatusBar();
      var msg = r.ok > 0 ? "已重推 " + r.ok + " 条" : "本次无成功";
      if (r.remain > 0) msg += "，剩 " + r.remain + " 条仍失败（可稍后再试或检查令牌/网络）";
      Util.toast(msg, r.remain > 0);
      // 重推成功后刷新记录列表，让「已提单」状态及时体现
      try { if (window.App.Views.records && window.App.Views.records.refresh) window.App.Views.records.refresh(); } catch (e) {}
      try { if (window.App.Views.landing && window.App.Views.landing.renderRecent) window.App.Views.landing.renderRecent(); } catch (e) {}
    } catch (e) {
      Util.toast("重推失败：" + ((e && e.message) || "未知错误"), true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "↻ 一键重推"; }
    }
  }

  function updateStatusBar() {
    try { if (window.App.Views.app && window.App.Views.app.updateStatusBar) window.App.Views.app.updateStatusBar(); } catch (e) {}
  }

  /** 补传全部缺失照片：队列项 + 本机 photos > photoUrls 的记录/备忘录 */
  async function retryAllPhotos() {
    if (!Cloud.hasToken()) { Util.toast("未配置云端令牌，无法补传", true); return; }
    Util.toast("正在补传照片…");
    var ok = 0, fail = 0;
    var targets = [];
    // ① 补传队列中的记录
    var q = (Cloud.loadPhotoPending && Cloud.loadPhotoPending()) || [];
    (q || []).forEach(function (x) {
      var rec = (State.list || []).filter(function (r) { return r.id === x.id; })[0];
      if (rec) targets.push(rec);
    });
    // ② photos > photoUrls 的本地记录（队列遗漏/无队列项场景）
    (State.list || []).forEach(function (r) {
      if ((r.photos || []).length > (r.photoUrls || []).length) {
        if (!targets.some(function (t) { return t.id === r.id; })) targets.push(r);
      }
    });
    // ③ 备忘录（memos 也有照片）
    (window.App.State.memos || []).forEach(function (m) {
      if ((m.photos || []).length > (m.photoUrls || []).length) {
        if (!targets.some(function (t) { return t.id === m.id; })) targets.push(m);
      }
    });
    if (!targets.length) { Util.toast("没有需要补传的照片"); renderPhotoPending(); return; }
    for (var i = 0; i < targets.length; i++) {
      try {
        var r = await Cloud.retryPhotosFor(targets[i]);
        ok += r.ok || 0;
        fail += r.fail || 0;
        if (r.updated && window.App.Records) {
          // 若记录本体未上云，补传成功后可顺带推送记录（含 photoUrls）
          try {
            if (window.App.State.list.some(function (x) { return x.id === r.updated.id; })) {
              await Cloud.pushRecord(r.updated);
            } else if (window.App.Memos && window.App.Memos.update) {
              // 备忘录已在 retryPhotosFor 内更新；这里确保推送本体
              try { await Cloud.pushMemo(r.updated); } catch (e) {}
            }
          } catch (e) {}
        }
      } catch (e) { fail++; }
    }
    renderPhotoPending();
    if (ok || fail) {
      Util.toast(fail ? "补传完成：成功 " + ok + "，失败 " + fail + "（可再试）" : "补传完成：成功 " + ok + " 张照片", !!fail);
    }
    try { if (window.App.Views.records && window.App.Views.records.refresh) window.App.Views.records.refresh(); } catch (e) {}
  }
})();