/**
 * app.js — Windows 桌面管理壳：窗口标题栏 + 渐变顶栏 + 深色侧栏（6 菜单）+ 内容区
 * 底部状态栏「就绪｜本地N条｜已同步HH:MM」+ 导入数据（JSON 数组或 {records:[]}）。
 * 模块 id 与子路由映射：#/app/<id>；「出库记录」为默认模块；顶栏☁️直达云端同步。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Store = window.App.Store;
  var State = window.App.State;
  var Router = window.App.Router;
  var Cloud = window.App.Cloud;
  var Records = window.App.Records;
  var Config = window.App.Config;

  var NAV_ITEMS = [
    { id: "dashboard", icon: "report", label: "仪表盘" },
    { id: "stock", icon: "stock", label: "库存查询" },
    { id: "in", icon: "in", label: "入库管理" },
    { id: "pickups", icon: "box", label: "待取货" },
    { id: "out-records", icon: "records", label: "出库记录" },
    { id: "in-records", icon: "records", label: "入库记录" },
    { id: "report", icon: "report", label: "报表统计" },
    { id: "memos", icon: "edit", label: "备忘录" },
    { id: "ai", icon: "box", label: "AI 助手" }
  ];

  /* 模块 id → 视图注册名 */
  var VIEW_MAP = {
    dashboard: "dashboard",
    stock: "stock",
    in: "in",
    pickups: "pickups",
    memos: "memos",
    sync: "sync",
    "in-records": "inRecords",
    "out-records": "outRecords",
    report: "report",
    ai: "ai"
  };

  var MODULE_TITLES = {
    dashboard: "仪表盘", stock: "库存查询", in: "入库管理", pickups: "待取货", memos: "备忘录", sync: "云端同步",
    "in-records": "入库记录", "out-records": "出库记录", report: "报表统计", ai: "AI 助手"
  };

  var shellEl = null;
  var statusText = "就绪";
  var statusIsErr = false;

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  /** 渲染应用壳；已挂载则仅切换模块并保持壳状态 */
  function render(module) {
    var el = Util.$("view-app");
    if (!el) return;
    if (State.appMounted && shellEl && document.body.contains(shellEl)) {
      el.style.display = "";
      mount(module || State.nav.active || "out-records");
      return;
    }
    State.appMounted = true;
    el.innerHTML =
      '<div class="win-shell" id="winShell">' +
        '<div class="win-overlay" id="winOverlay"></div>' +
        '<div class="win-titlebar">' +
          '<span class="win-titlebar-title">' + Util.esc(Config.BRAND_TITLE) + '</span>' +
          '<div class="win-titlebar-btns">' +
            '<button type="button" class="win-titlebar-btn" id="winMin" title="最小化">&#8211;</button>' +
            '<button type="button" class="win-titlebar-btn" id="winMax" title="最大化">&#9633;</button>' +
            '<button type="button" class="win-titlebar-btn close" id="winClose" title="关闭">&#10005;</button>' +
          '</div>' +
        '</div>' +
        '<div class="win-topbar">' +
          '<button type="button" class="win-topbar-menu" id="winMenu" title="菜单">' + UI.icon("menu", 20) + '</button>' +
          '<span class="win-topbar-title">' + Util.esc(Config.BRAND_TITLE) + '</span>' +
          '<div class="win-topbar-right">' +
            '<button type="button" class="win-topbar-sync" id="winSync" title="云端同步">' + UI.icon("sync", 18) + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="win-main">' +
          '<aside class="win-sidebar" id="winSidebar">' +
            '<nav class="win-sidebar-nav" id="winNav"></nav>' +
            '<div class="win-sidebar-foot">' +
              '<div class="win-status" id="winStatus">就绪</div>' +
              '<button type="button" class="win-import-btn" id="winImport">导入数据</button>' +
              '<input type="file" id="winImportFile" accept="application/json,.json" hidden />' +
            '</div>' +
          '</aside>' +
          '<div class="win-content" id="winContent"></div>' +
        '</div>' +
      '</div>';
    shellEl = Util.$("winShell");
    renderNav();
    wireShell();
    mount(module || State.nav.active || "out-records");
    window.addEventListener("hashchange", onRouteChange);
    startAutoSync();
  }

  function renderNav() {
    var navEl = Util.$("winNav");
    navEl.innerHTML = NAV_ITEMS.map(function (item) {
      return '<a href="#/app/' + item.id + '" class="win-sidebar-item" data-mod="' + item.id + '">' +
        '<span class="win-sidebar-item-icon">' + UI.icon(item.icon, 18) + '</span>' +
        '<span class="win-sidebar-item-label">' + item.label + '</span>' +
      '</a>';
    }).join("");
    navEl.addEventListener("click", function (e) {
      var a = e.target.closest(".win-sidebar-item");
      if (!a) return;
      e.preventDefault();
      Router.navigate("/app/" + a.getAttribute("data-mod"));
    });
  }

  function wireShell() {
    Util.$("winClose").addEventListener("click", function () {
      closeDrawer();
      Router.navigate("/");
    });
    Util.$("winMin").addEventListener("click", function () {
      /* 装饰按钮：无实际窗口行为 */
    });
    Util.$("winMax").addEventListener("click", function () {
      if (shellEl) shellEl.classList.toggle("win-maximized");
    });
    Util.$("winMenu").addEventListener("click", toggleDrawer);
    Util.$("winOverlay").addEventListener("click", closeDrawer);
    Util.$("winSync").addEventListener("click", function () { mount("sync"); });
    Util.$("winImport").addEventListener("click", function () {
      Util.$("winImportFile").click();
    });
    Util.$("winImportFile").addEventListener("change", handleImport);
  }

  /** 挂载模块：切换内容区 + 高亮导航 + 记忆最后停留项 */
  function mount(moduleName) {
    var viewName = VIEW_MAP[moduleName] || "out-records";
    var view = window.App.Views[viewName];
    if (!view) return;
    State.nav.active = moduleName;
    Store.saveNav(State.nav);
    var items = Util.$("winNav").querySelectorAll(".win-sidebar-item");
    items.forEach(function (it) {
      it.classList.toggle("active", it.getAttribute("data-mod") === moduleName);
    });
    closeDrawer();
    var content = Util.$("winContent");
    var viewEl = document.createElement("div");
    viewEl.className = "module-view";
    content.innerHTML = "";
    content.appendChild(viewEl);
    view.render(viewEl);
    updateStatusBar();
  }

  /* 底部状态栏：就绪｜本地N条｜已同步HH:MM */
  function updateStatusBar() {
    var el = Util.$("winStatus");
    if (!el) return;
    var sync = State.lastSync
      ? "已同步" + pad2(State.lastSync.getHours()) + ":" + pad2(State.lastSync.getMinutes())
      : "未同步";
    el.textContent = (statusText || "就绪") + "｜本地" + State.list.length + "条｜" + sync;
    el.className = "win-status" + (statusIsErr ? " err" : "");
  }

  /** 同步状态（out/in/records 调用）：更新底部状态栏 */
  function setSyncStatus(text, isErr) {
    statusText = text || "就绪";
    statusIsErr = !!isErr;
    updateStatusBar();
  }

  /** 首次进入自动拉取云端；完成后刷新数据型模块 */
  function autoSync() {
    startAutoSync();
  }

  /* ================= 自动同步（30 秒轮询 + 可见性/聚焦即时触发） =================
     背景：手机端提交后只推送（pushAllLocal），电脑端需要主动从云端拉取才能看到。
     因此 #/app 挂载期间每 AUTO_SYNC_INTERVAL_MS 拉取一次；切回页面/聚焦时立即拉取。 */
  var autoSyncTimer = null;     // setInterval id
  var autoSyncOn = false;       // 自动同步是否开启
  var syncing = false;          // 并发锁：同步进行中跳过本轮，防止请求重叠
  var nextSyncAt = 0;           // 下次自动同步时间戳（毫秒），供同步面板倒计时

  /** 触发一次同步；syncing 并发锁 + 无令牌降级本机模式 */
  function triggerSync(reason) {
    if (!autoSyncOn) return;
    if (syncing) return;        // 并发防护：上一轮未结束则跳过本轮
    if (!Cloud.hasToken()) {
      setSyncStatus("本机模式", true);
      return;
    }
    syncing = true;
    setSyncStatus("同步中…", false);
    var before = State.list.length;
    Cloud.syncPull({ onStatus: function () {} }).then(function (res) {
      syncing = false;
      if (res.ok) {
        setSyncStatus("就绪", false);
        var added = State.list.length - before;
        if (added > 0) Util.toast("已同步 " + added + " 条新记录");
      } else {
        setSyncStatus("同步失败", true);
      }
      refreshActiveView();
      scheduleNextSync();
      // 每次自动同步后顺带冲刷「待补推队列」（空队列无 API 开销）
      Cloud.flushQueue().then(function (fres) {
        if (fres && fres.ok > 0) Util.toast("已补推 " + fres.ok + " 条记录");
      }).catch(function () {});
    }).catch(function () {
      syncing = false;
      setSyncStatus("同步失败", true);
      refreshActiveView();
      scheduleNextSync();
    });
  }

  /** 刷新当前模块视图 + 底部状态栏（同步完成后调用） */
  function refreshActiveView() {
    var cur = State.nav.active;
    var viewName = VIEW_MAP[cur];
    var view = viewName && window.App.Views[viewName];
    if (view && view.refresh) view.refresh();
    updateStatusBar();
  }

  /** 设定下次自动同步时间并重置定时器（同步完成/手动同步后调用，倒计时从完成时刻重新计） */
  function scheduleNextSync(ms) {
    var interval = ms || Config.AUTO_SYNC_INTERVAL_MS;
    nextSyncAt = Date.now() + interval;
    if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
    autoSyncTimer = setInterval(function () { triggerSync("timer"); }, interval);
  }

  /** 页面重新可见：立即同步（不等定时器） */
  function onVisibilityChange() {
    if (document.visibilityState === "visible") triggerSync("visible");
  }

  /** 窗口重新聚焦：立即同步（不等定时器） */
  function onWindowFocus() {
    triggerSync("focus");
  }

  /** 启动自动同步：立即同步一次 + 定时轮询 + 可见性/聚焦监听（幂等） */
  function startAutoSync() {
    if (autoSyncOn || !State.appMounted) return;
    if (!Cloud.hasToken()) {
      setSyncStatus("本机模式", true);
      return;
    }
    autoSyncOn = true;
    window.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);
    scheduleNextSync();
    triggerSync("start");
    // 启动时冲刷「待补推队列」：把之前因页面关闭而没推上去的记录补推到云端
    Cloud.flushQueue().then(function (fres) {
      if (fres && fres.ok > 0) Util.toast("已补推 " + fres.ok + " 条记录");
    }).catch(function () {});
  }

  /** 停止自动同步：清理定时器与窗口监听（离开 #/app 或应用壳卸载时调用） */
  function stopAutoSync() {
    autoSyncOn = false;
    if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
    window.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", onWindowFocus);
    nextSyncAt = 0;
  }

  /** 路由守卫：进入 #/app 启动自动同步，离开 #/app 停止（防泄漏） */
  function onRouteChange() {
    if (Router.parse().base !== "app") stopAutoSync();
    else if (State.appMounted && !autoSyncOn && Cloud.hasToken()) startAutoSync();
  }

  /** 同步面板查询：自动同步是否开启 */
  function isAutoSyncOn() { return autoSyncOn; }

  /** 同步面板查询：距下次自动同步剩余秒数（未开启返回 null） */
  function nextSyncRemainSec() {
    if (!autoSyncOn || !nextSyncAt) return null;
    return Math.max(0, Math.ceil((nextSyncAt - Date.now()) / 1000));
  }

  /** 导入 JSON：数组或 {records:[]} → mergeAndSort 合并 → 保存 → 刷新 → 有 token 自动推送 */
  function handleImport() {
    var input = Util.$("winImportFile");
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        var arr = Array.isArray(data) ? data : (data && Array.isArray(data.records) ? data.records : null);
        if (!arr || !arr.length) { Util.toast("导入文件为空或格式不正确", true); return; }
        var valid = arr.filter(function (r) {
          return r && typeof r === "object" && (r.id || r.time) && Array.isArray(r.items);
        });
        if (!valid.length) { Util.toast("未识别到有效记录", true); return; }
        State.list = Records.mergeAndSort(State.list, valid);
        State.save();
        Util.toast("已导入 " + valid.length + " 条记录");
        var cur = State.nav.active;
        var viewName = VIEW_MAP[cur];
        var view = viewName && window.App.Views[viewName];
        if (view && view.refresh) view.refresh();
        else mount(cur);
        updateStatusBar();
        if (Cloud.hasToken()) {
          Cloud.pushAllLocal().then(function (res) {
            setSyncStatus(res.fail > 0 ? "部分推送失败" : "已推送云端", res.fail > 0);
          });
        }
      } catch (e) {
        Util.toast("导入失败：" + e.message, true);
      }
      input.value = "";
    };
    reader.readAsText(file, "utf-8");
  }

  function toggleDrawer() {
    if (shellEl) shellEl.classList.toggle("drawer-open");
  }

  function closeDrawer() {
    if (shellEl) shellEl.classList.remove("drawer-open");
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.app = {
    render: render,
    mount: mount,
    setSyncStatus: setSyncStatus,
    updateStatusBar: updateStatusBar,
    closeDrawer: closeDrawer,
    autoSync: autoSync,
    startAutoSync: startAutoSync,
    stopAutoSync: stopAutoSync,
    triggerSync: triggerSync,
    scheduleNextSync: scheduleNextSync,
    isAutoSyncOn: isAutoSyncOn,
    nextSyncRemainSec: nextSyncRemainSec
  };
})();
