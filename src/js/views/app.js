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
    { id: "out-records", icon: "records", label: "出库记录" },
    { id: "in-records", icon: "records", label: "入库记录" },
    { id: "report", icon: "report", label: "报表统计" }
  ];

  /* 模块 id → 视图注册名 */
  var VIEW_MAP = {
    dashboard: "dashboard",
    stock: "stock",
    in: "in",
    sync: "sync",
    "in-records": "inRecords",
    "out-records": "outRecords",
    report: "report"
  };

  var MODULE_TITLES = {
    dashboard: "仪表盘", stock: "库存查询", in: "入库管理", sync: "云端同步",
    "in-records": "入库记录", "out-records": "出库记录", report: "报表统计"
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
    autoSync();
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
    if (!Cloud.hasToken()) {
      setSyncStatus("本机模式", true);
      return;
    }
    setSyncStatus("同步中…", false);
    Cloud.syncPull({ onStatus: function () {} }).then(function (res) {
      if (res.ok) setSyncStatus("就绪", false);
      else setSyncStatus("同步失败", true);
      var cur = State.nav.active;
      var viewName = VIEW_MAP[cur];
      var view = viewName && window.App.Views[viewName];
      if (view && view.refresh) view.refresh();
      updateStatusBar();
    }).catch(function () {
      setSyncStatus("同步失败", true);
    });
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
    closeDrawer: closeDrawer
  };
})();
