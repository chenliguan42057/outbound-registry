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
    { id: "stock", icon: "stock", label: "库存查询" },
    { id: "dashboard", icon: "report", label: "仪表盘" },
    { id: "in", icon: "in", label: "入库管理" },
    { id: "pickups", icon: "box", label: "待取货" },
    { id: "out-records", icon: "records", label: "出库记录" },
    { id: "in-records", icon: "records", label: "入库记录" },
    { id: "borrow", icon: "box", label: "先借后还" },
    { id: "transfer", icon: "swap", label: "调拨" },
    { id: "memos", icon: "edit", label: "备忘录" },
    { id: "push", icon: "bell", label: "推送信息" },
    { id: "trash", icon: "box", label: "回收站" },
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
    "in-remind": "remind",
    "out-remind": "remind",
    borrow: "borrow",
    transfer: "transfer",
    push: "push",
    trash: "trash",
    report: "report",
    ai: "ai"
  };

  var MODULE_TITLES = {
    dashboard: "仪表盘", stock: "库存查询", in: "入库管理", pickups: "待取货", memos: "备忘录", sync: "云端同步",
    "in-records": "入库记录", "out-records": "出库记录", report: "报表统计", ai: "AI 助手",
    borrow: "先借后还", transfer: "调拨", push: "推送信息", trash: "回收站",
    "in-remind": "入库提醒", "out-remind": "出库提醒"
  };

  var shellEl = null;
  var statusText = "就绪";
  var statusIsErr = false;

  var pad2 = Util.pad2;   // 统一走 Util，避免各文件各写一份补零逻辑
  var routeBound = false;  // hashchange 只绑一次：壳被移除后重渲染不得重复叠加监听
  var queueBound = false;  // 队列变更监听只绑一次：状态栏徽标实时刷新

  /** 渲染应用壳；已挂载则仅切换模块并保持壳状态 */
  function render(module) {
    var el = Util.$("view-app");
    if (!el) return;
    if (!queueBound && Cloud.onQueueChange) {
      queueBound = true;
      Cloud.onQueueChange(function () {
        if (State.appMounted) updateStatusBar();
      });
    }
    if (State.appMounted && shellEl && document.body.contains(shellEl)) {
      el.style.display = "";
      mount(module || State.nav.active || "stock");
      return;
    }
    State.appMounted = true;
    el.innerHTML =
      '<div class="win-shell" id="winShell">' +
        '<div class="win-overlay" id="winOverlay"></div>' +
        '<div class="win-titlebar">' +
          '<span class="win-titlebar-title" id="winBrandTitle">' + Util.esc(brandLabel()) + '</span>' +
          '<div class="win-titlebar-btns">' +
            '<button type="button" class="win-titlebar-btn" id="winMin" title="最小化">&#8211;</button>' +
            '<button type="button" class="win-titlebar-btn" id="winMax" title="最大化">&#9633;</button>' +
            '<button type="button" class="win-titlebar-btn close" id="winClose" title="关闭">&#10005;</button>' +
          '</div>' +
        '</div>' +
        '<div class="win-topbar">' +
          '<button type="button" class="win-topbar-menu" id="winMenu" title="菜单">' + UI.icon("menu", 20) + '</button>' +
          '<span class="win-topbar-title" id="winBrandTitleTop">' + Util.esc(brandLabel()) + '</span>' +
          '<div class="win-topbar-search">' +
            '<!-- 全局搜索已移除（2026-08-08 用户要求） -->' +
          '</div>' +
          '<div class="win-topbar-right">' +
            '<button type="button" class="win-topbar-sync" id="winSync" title="云端同步">' + UI.icon("sync", 18) + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="win-main">' +
          '<aside class="win-sidebar" id="winSidebar">' +
            '<div class="win-sysbar" id="winSysbar" role="group" aria-label="出货仓库单位">' +
              '<button type="button" class="win-sysbar-trigger" id="winSysbarTrigger" aria-haspopup="listbox" aria-expanded="false">' +
                '<span class="win-sysbar-dot" aria-hidden="true"></span>' +
                '<span id="winSysbarName"></span>' +
                '<svg class="win-sysbar-caret" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>' +
              '</button>' +
              '<ul class="win-sysbar-menu" id="winSysbarMenu" role="listbox" hidden>' +
                '<li><button type="button" class="win-sysbar-item" data-sys="shenzhen" role="option"><span class="win-sysbar-name">深圳细胞</span></button></li>' +
                '<li><button type="button" class="win-sysbar-item" data-sys="saidis" role="option"><span class="win-sysbar-name">赛迪斯</span></button></li>' +
              '</ul>' +
            '</div>' +
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
    bindSysBar();
    mount(module || State.nav.active || "stock");
    if (!routeBound) {
      window.addEventListener("hashchange", onRouteChange);
      routeBound = true;
    }
    startAutoSync();
  }

  /* ---------- 双仓库系统切换器（2026-09-04：深圳细胞 / 赛迪斯） ---------- */

  /** 品牌标题：主标题 + 当前系统名（如「进销存管理系统 · 深圳细胞」） */
  function brandLabel() {
    return Config.BRAND_TITLE + " · " + Config.Sys.name();
  }

  /** 更新顶栏/标题栏的品牌文本与系统按钮高亮（切换系统后调用） */
  function updateBrand() {
    var b1 = Util.$("winBrandTitle"), b2 = Util.$("winBrandTitleTop");
    var label = brandLabel();
    if (b1) b1.textContent = label;
    if (b2) b2.textContent = label;
    var cur = Config.Sys.current().id;
    var nameEl = Util.$("winSysbarName");
    if (nameEl) nameEl.textContent = Config.Sys.name();
    var trigger = Util.$("winSysbarTrigger");
    if (trigger) {
      trigger.setAttribute("data-sys", cur);
      trigger.setAttribute("aria-expanded", "false");
    }
    var menu = Util.$("winSysbarMenu");
    if (menu) menu.hidden = true;
    var items = document.querySelectorAll(".win-sysbar-item");
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle("active", items[i].getAttribute("data-sys") === cur);
    }
  }

  var sysBarBound = false;
  /** 关闭下拉菜单（切换系统 / 点外部 / 按 Esc 时调用） */
  function closeSysMenu() {
    var trigger = Util.$("winSysbarTrigger");
    var menu = Util.$("winSysbarMenu");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    if (menu) menu.hidden = true;
  }
  function bindSysBar() {
    if (sysBarBound) return;
    sysBarBound = true;
    var bar = Util.$("winSysbar");
    if (!bar) return;
    var trigger = Util.$("winSysbarTrigger");
    var menu = Util.$("winSysbarMenu");
    if (trigger) {
      trigger.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!menu) return;
        var open = !menu.hidden;
        trigger.setAttribute("aria-expanded", open ? "false" : "true");
        menu.hidden = open;
      });
    }
    if (menu) {
      menu.addEventListener("click", function (e) {
        var it = e.target.closest && e.target.closest(".win-sysbar-item");
        if (!it) return;
        e.stopPropagation();
        var id = it.getAttribute("data-sys");
        closeSysMenu();
        switchSystem(id);
      });
    }
    document.addEventListener("click", function () {
      if (menu && !menu.hidden) closeSysMenu();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && menu && !menu.hidden) closeSysMenu();
    });
    updateBrand();
  }

  /** 切换系统：数据目录/本地缓存键/catalog 基准全部按新系统热切换（不整页刷新，避免退出登录） */
  function switchSystem(id) {
    if (!id || id === Config.Sys.current().id) return;
    Config.Sys.set(id);
    updateBrand();
    // 重读新系统的本地缓存（记录/待取货/备忘/盘点，键已按系统隔离）
    window.App.State.init();
    if (window.App.Stock) window.App.Stock.markDirty();
    // 清掉当前视图并重新挂载当前模块，保证表格/统计基于新系统数据
    if (currentView && typeof currentView.destroy === "function") {
      try { currentView.destroy(); } catch (e) { console.warn("[app] 视图清理失败", e); }
      currentView = null;
    }
    var cur = State.nav.active || "stock";
    // catalog 按新系统重载（异步）；完成后刷新依赖目录的视图
    if (window.App.Catalog && window.App.Catalog.reload) {
      window.App.Catalog.reload().then(function () {
        try { window.App.Views.dashboard && window.App.Views.dashboard.refresh && window.App.Views.dashboard.refresh(); } catch (e) {}
        try { window.App.Views.stock && window.App.Views.stock.refresh && window.App.Views.stock.refresh(); } catch (e) {}
        try { window.App.Views.records && window.App.Views.records.refresh && window.App.Views.records.refresh(); } catch (e) {}
        try { window.App.Views.report && window.App.Views.report.refresh && window.App.Views.report.refresh(); } catch (e) {}
        if (window.App.Stock) window.App.Stock.markDirty();
      })["catch"](function () {});
    }
    // 有令牌则从云端拉取新系统数据；完成后再次挂载保证最新
    var remount = function () {
      if (currentView && typeof currentView.destroy === "function") {
        try { currentView.destroy(); } catch (e) {}
        currentView = null;
      }
      mount(cur);
    };
    if (Cloud && Cloud.hasToken && Cloud.hasToken()) {
      Cloud.syncPull({ onStatus: function () {} }).then(remount)["catch"](function () { remount(); });
    } else {
      remount();
    }
    Util.toast("已切换到「" + Config.Sys.name() + "」系统");
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

  var currentView = null;   // 当前挂载的视图对象，用于切换前回收资源

  /** 挂载模块：切换内容区 + 高亮导航 + 记忆最后停留项 */
  function mount(moduleName) {
    var viewName = VIEW_MAP[moduleName] || "stock";
    var view = window.App.Views[viewName];
    if (!view) return;
    // 切走之前先让上一个视图清理自己的定时器/监听。
    // 下面的 content.innerHTML = "" 只会移除 DOM，视图内的 setInterval 仍在空转
    // （「云端同步」面板的倒计时就是这样泄漏的：切到别的模块后仍每秒跑一次）。
    if (currentView && currentView !== view && typeof currentView.destroy === "function") {
      try { currentView.destroy(); } catch (e) { console.warn("[app] 视图清理失败", e); }
    }
    currentView = view;
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

  /* 底部状态栏：就绪｜本地N条｜已同步HH:MM（含待同步队列计数） */
  function updateStatusBar() {
    var el = Util.$("winStatus");
    if (!el) return;
    var sync = State.lastSync
      ? "已同步" + pad2(State.lastSync.getHours()) + ":" + pad2(State.lastSync.getMinutes())
      : "未同步";
    var q = (Cloud.loadQueue ? Cloud.loadQueue() : []);
    var pending = q.length ? "｜⚠️待同步" + q.length + "条" : "";
    el.textContent = (statusText || "就绪") + "｜本地" + State.list.length + "条｜" + sync + pending;
    el.className = "win-status" + (statusIsErr || q.length ? " err" : "");
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

  /** 配额告急时的退避间隔：10 分钟看一次，等额度自然恢复 */
  var RATE_BACKOFF_MS = 10 * 60 * 1000;
  var rateWarned = false;

  /** 触发一次同步；syncing 并发锁 + 无令牌降级本机模式 + 配额告急自动停表 */
  function triggerSync(reason) {
    if (!autoSyncOn) return;
    if (syncing) return;        // 并发防护：上一轮未结束则跳过本轮
    if (!Cloud.hasToken()) {
      setSyncStatus("本机模式", true);
      return;
    }
    // GitHub 认证请求限额 5000 次/小时且所有设备共用。轮询若把额度耗到 0，
    // 用户连出库单都推不上去。余量告急时主动停表，把剩余额度留给写入操作。
    var r = Cloud.getRate ? Cloud.getRate() : null;
    if (r && r.low) {
      setSyncStatus("API 额度不足，已暂停自动同步", true);
      if (!rateWarned) {
        rateWarned = true;
        Util.toast("云端调用额度将尽（剩 " + r.remaining + " 次），自动同步已暂停，稍后自动恢复。手动提交不受影响。", true);
      }
      scheduleNextSync(RATE_BACKOFF_MS);
      return;
    }
    rateWarned = false;

    syncing = true;
    setSyncStatus("同步中…", false);
    var before = State.list.length;
    Cloud.syncPull({ onStatus: function () {} }).then(function (res) {
      if (res.ok) {
        setSyncStatus("就绪", false);
        var added = State.list.length - before;
        if (added > 0) Util.toast("已同步 " + added + " 条新记录");
      } else {
        setSyncStatus("同步失败", true);
      }
      // 每次自动同步后顺带冲刷「待补推队列」（空队列无 API 开销）
      Cloud.flushQueue().then(function (fres) {
        if (fres && fres.ok > 0) Util.toast("已补推 " + fres.ok + " 条记录");
      }).catch(function () {});
    }).catch(function (e) {
      setSyncStatus("同步失败：" + ((e && e.message) || "未知原因"), true);
    }).finally(function () {
      // 复位与排程放在 finally：即便上面的 then 内部抛错，
      // 也不会把 syncing 永久锁死导致自动同步彻底停摆。
      syncing = false;
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
    if (document.visibilityState === "visible") { triggerSync("visible"); checkMemoReminders(); }
  }

  /** 窗口重新聚焦：立即同步（不等定时器） */
  function onWindowFocus() {
    triggerSync("focus");
    checkMemoReminders();
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
    wireOnlineOffline();       // PWA 离线状态横幅 + 恢复自动同步（优化 3）
    startMemoReminder();       // 备忘录提醒前端兜底（每分钟轮询本地，不依赖后台）
    scheduleNextSync();
    triggerSync("start");
    // 启动时冲刷「待补推队列」：把之前因页面关闭而没推上去的记录补推到云端
    Cloud.flushQueue().then(function (fres) {
      if (fres && fres.ok > 0) Util.toast("已补推 " + fres.ok + " 条记录");
    }).catch(function () {});
  }

  /* ================= 备忘录提醒前端兜底（优化 2.3） =================
     不依赖 GitHub 定时任务：进 App 后每分钟轮询本地 State.memos，
     到点未完成弹醒目横幅 + 系统通知。后台任务常被延迟/停用也不漏提醒。 */
  var memoReminderTimer = null;
  var memoLocalNotified = {};   // id -> true，避免同一条重复弹
  function ensureMemoBanner() {
    var b = document.getElementById("memoReminderBanner");
    if (!b) {
      b = document.createElement("div");
      b.id = "memoReminderBanner";
      b.className = "memo-reminder-banner";
      b.style.display = "none";
      document.body.appendChild(b);
    }
    return b;
  }
  function checkMemoReminders() {
    var due = (State.memos || []).filter(function (m) {
      if (!m || m.done || !m.remindAt || memoLocalNotified[m.id]) return false;
      try { return new Date(m.remindAt).getTime() <= Date.now(); } catch (e) { return false; }
    });
    var banner = ensureMemoBanner();
    if (!due.length) { banner.style.display = "none"; return; }
    due.forEach(function (m) { memoLocalNotified[m.id] = true; });   // 已通知，避免重复
    var titles = due.map(function (m) { return "• " + Util.esc(m.text || m.title || m.content || "备忘"); }).join("<br>");
    banner.innerHTML = '<div class="mr-title">⏰ 备忘提醒（' + due.length + ' 项到点未完成）</div>' +
      '<div class="mr-body">' + titles + '</div>' +
      '<button type="button" class="mr-close" onclick="this.parentNode.style.display=\'none\'">知道了</button>';
    banner.style.display = "block";
    if ("Notification" in window && Notification.permission === "granted") {
      try { due.forEach(function (m) { new Notification("备忘提醒", { body: (m.text || m.title || m.content || "备忘") }); }); } catch (e) {}
    }
  }
  function startMemoReminder() {
    if (memoReminderTimer) return;
    checkMemoReminders();
    memoReminderTimer = setInterval(checkMemoReminders, 60 * 1000);
  }
  /** 请求系统通知授权（需在用户手势内调用，故在添加备忘时触发） */
  function requestMemoNotification() {
    try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch (e) {}
  }

  /* ================= PWA 离线状态（优化 3） ================= */
  var onlineBound = false;
  function wireOnlineOffline() {
    if (onlineBound) return;
    onlineBound = true;
    function update() {
      if (navigator.onLine) {
        setSyncStatus(statusText || "就绪", statusIsErr);   // 恢复在线：还原之前状态
        // 离线期间可能积累的补推/提交，恢复后立即冲刷
        if (autoSyncOn && Cloud.hasToken()) {
          Cloud.flushQueue().then(function (fres) {
            if (fres && fres.ok > 0) Util.toast("已补推 " + fres.ok + " 条记录");
          }).catch(function () {});
          triggerSync("online");
        }
      } else {
        setSyncStatus("📴 离线模式（数据仅存本机，联网后自动同步）", true);
      }
    }
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();   // 初始化一次，反映当前在线状态
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
    nextSyncRemainSec: nextSyncRemainSec,
    requestMemoNotification: requestMemoNotification,
    checkMemoReminders: checkMemoReminders,
    switchSystem: switchSystem,
    updateBrand: updateBrand
  };
})();
