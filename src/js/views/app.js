/**
 * app.js — 应用壳：左侧导航 + 顶栏 + 内容区 + 模块注册表 + 状态记忆恢复
 * 模块 id 与 window.App.Views.* 一一对应。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Store = window.App.Store;
  var State = window.App.State;
  var Router = window.App.Router;
  var Cloud = window.App.Cloud;

  var NAV_ITEMS = [
    { id: "out", icon: "out", label: "出库登记" },
    { id: "in", icon: "in", label: "入库登记" },
    { id: "stock", icon: "stock", label: "库存查询" },
    { id: "records", icon: "records", label: "记录管理" },
    { id: "report", icon: "report", label: "报表统计" },
    { id: "sync", icon: "sync", label: "云端同步" }
  ];

  var MODULE_TITLES = {
    out: "出库登记", in: "入库登记", stock: "库存查询",
    records: "记录管理", report: "报表统计", sync: "云端同步"
  };

  var shellEl = null;

  /** 渲染应用壳；已挂载则仅刷新标题并保持模块状态 */
  function render() {
    var el = Util.$("view-app");
    if (!el) return;
    if (State.appMounted && shellEl && document.body.contains(shellEl)) {
      el.style.display = "";
      updateTitle();
      return;
    }
    State.appMounted = true;
    el.innerHTML =
      '<div class="app-shell" id="appShell">' +
        '<div class="app-overlay" id="appOverlay"></div>' +
        '<aside class="app-sidebar" id="appSidebar">' +
          '<div class="sidebar-head">' +
            '<span class="sidebar-logo">' + UI.icon("box", 22) + '</span>' +
            '<span class="sidebar-brand">出入库登记</span>' +
          '</div>' +
          '<nav class="sidebar-nav" id="sidebarNav"></nav>' +
          '<div class="sidebar-foot">' +
            '<button type="button" class="sidebar-collapse-btn" id="sidebarCollapse" title="折叠/展开">' + UI.icon("menu", 18) + '</button>' +
          '</div>' +
        '</aside>' +
        '<div class="app-main">' +
          '<header class="app-topbar">' +
            '<button type="button" class="topbar-btn" id="topbarMenu" title="菜单">' + UI.icon("menu", 20) + '</button>' +
            '<h2 class="topbar-title" id="topbarTitle">出库登记</h2>' +
            '<div class="topbar-sync" id="topbarSync"></div>' +
            '<button type="button" class="topbar-btn" id="topbarBack" title="返回落地页">' + UI.icon("back", 20) + '</button>' +
          '</header>' +
          '<main class="app-content" id="appContent"></main>' +
        '</div>' +
      '</div>';
    shellEl = Util.$("appShell");
    renderNav();
    wireShell();
    applyCollapsed(State.nav.sidebarCollapsed);
    mount(State.nav.active || "out");
    // 首次进入自动拉取云端
    autoSync();
    // 回到页面自动同步，缓解微信等内置浏览器缓存导致数据不同步
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && Router.current() === "/app") autoSync();
    });
  }

  function renderNav() {
    var navEl = Util.$("sidebarNav");
    navEl.innerHTML = NAV_ITEMS.map(function (item) {
      return '<a href="#/app" class="sidebar-item" data-mod="' + item.id + '" title="' + item.label + '">' +
        '<span class="sidebar-item-icon">' + UI.icon(item.icon, 19) + '</span>' +
        '<span class="sidebar-item-label">' + item.label + '</span>' +
      '</a>';
    }).join("");
    navEl.addEventListener("click", function (e) {
      var a = e.target.closest(".sidebar-item");
      if (!a) return;
      e.preventDefault();
      mount(a.getAttribute("data-mod"));
    });
  }

  function wireShell() {
    Util.$("topbarMenu").addEventListener("click", toggleSidebar);
    Util.$("sidebarCollapse").addEventListener("click", function () {
      if (window.innerWidth <= 768) { closeDrawer(); return; }
      State.nav.sidebarCollapsed = !State.nav.sidebarCollapsed;
      Store.saveNav(State.nav);
      applyCollapsed(State.nav.sidebarCollapsed);
    });
    Util.$("topbarBack").addEventListener("click", function () {
      closeDrawer();
      Router.navigate("/");
    });
    Util.$("appOverlay").addEventListener("click", closeDrawer);
  }

  function applyCollapsed(collapsed) {
    shellEl.classList.toggle("sidebar-collapsed", !!collapsed);
  }

  /** 顶栏汉堡 / 侧栏折叠按钮：桌面折叠窄栏，移动端开关抽屉 */
  function toggleSidebar() {
    if (window.innerWidth <= 768) {
      shellEl.classList.toggle("drawer-open");
    } else {
      State.nav.sidebarCollapsed = !State.nav.sidebarCollapsed;
      Store.saveNav(State.nav);
      applyCollapsed(State.nav.sidebarCollapsed);
    }
  }

  function closeDrawer() {
    if (shellEl) shellEl.classList.remove("drawer-open");
  }

  /** 挂载模块：切换内容区 + 高亮导航 + 记忆最后停留项 */
  function mount(moduleName) {
    var view = window.App.Views[moduleName];
    if (!view) return;
    State.nav.active = moduleName;
    Store.saveNav(State.nav);
    var items = Util.$("sidebarNav").querySelectorAll(".sidebar-item");
    items.forEach(function (it) {
      it.classList.toggle("active", it.getAttribute("data-mod") === moduleName);
    });
    updateTitle();
    closeDrawer();
    var content = Util.$("appContent");
    var viewEl = document.createElement("div");
    viewEl.className = "module-view";
    content.innerHTML = "";
    content.appendChild(viewEl);
    view.render(viewEl);
  }

  function updateTitle() {
    var t = Util.$("topbarTitle");
    if (t) t.textContent = MODULE_TITLES[State.nav.active] || "出入库登记";
  }

  /** 顶栏同步状态 */
  function setSyncStatus(text, isErr) {
    var el = Util.$("topbarSync");
    if (el) {
      el.textContent = text || "";
      el.className = "topbar-sync" + (isErr ? " err" : "");
    }
  }

  /** 自动拉取云端；完成后仅刷新数据型模块（不重置表单） */
  function autoSync() {
    if (!Cloud.hasToken()) {
      setSyncStatus("未配置云端令牌（本机模式）", true);
      return;
    }
    Cloud.syncPull({ onStatus: setSyncStatus }).then(function (res) {
      var cur = State.nav.active;
      if (cur && window.App.Views[cur] && window.App.Views[cur].refresh) {
        window.App.Views[cur].refresh();
      }
    });
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.app = {
    render: render,
    mount: mount,
    setSyncStatus: setSyncStatus,
    closeDrawer: closeDrawer
  };
})();
