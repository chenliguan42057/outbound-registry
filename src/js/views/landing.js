/**
 * landing.js — 落地页：顶栏（品牌标题 + 卡通管理按钮）+ 免密出库表单（复用 Views.out 全能力）
 * 表单下方「最近提交」记录区域：只读展示最新 5 条（时间/领取人/部门/货物×数量/状态徽标）。
 * 页面渲染时先展示本地缓存，再自动从云端 syncPull 拉取最新并重渲染（刷新首页即可看到客户最新提交）。
 * 管理入口：未登录弹登录框（UI.showLoginDialog），成功后跳 #/app/out-records；已登录直接进入。
 * pendingEditId：出库记录模块编辑某条记录时设置，落地页渲染后自动进入编辑态（保留照片等全字段）。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Router = window.App.Router;
  var Config = window.App.Config;
  var Auth = window.App.Auth;
  var State = window.App.State;
  var Records = window.App.Records;
  var Cloud = window.App.Cloud;

  var pendingEditId = null;

  var RECENT_LIMIT = 5;

  /* 云端首拉进行中标记。
     换设备/无痕/清缓存首次进入时 State.list 为空，若直接渲染「暂无提交记录」，
     用户会误以为自己之前提交的数据丢了（假空态）。拉取期间改显加载态。 */
  var recentLoading = false;

  /** 时间短格式：当年省略年份 "MM-DD HH:mm"，跨年补全 "YYYY-MM-DD HH:mm" */
  function fmtRecentTime(t) {
    if (!t) return "-";
    var d = new Date(t);
    if (isNaN(d.getTime())) return String(t);
    var p = Util.pad2;
    var full = Util.todayLocal(d);                       // "YYYY-MM-DD"
    var datePart = (d.getFullYear() === new Date().getFullYear()) ? full.slice(5) : full;
    return datePart + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /** 货物文案：「名称×数量」逗号连接（超长由 CSS 截断） */
  function fmtItems(rec) {
    var items = (rec && rec.items) || [];
    if (!items.length) return "-";
    return items.map(function (it) {
      return String(it.name == null ? "" : it.name) + "×" + String(it.qty == null ? "" : it.qty);
    }).join("，");
  }

  /** 状态徽标 HTML：pending 红点「未提单」/ submitted 绿点「已提单」/ 入库无徽标 */
  function statusBadge(rec) {
    var st = Records.getStatus(rec);
    if (st === "pending") return '<span class="status-pill static pending"><span class="dot"></span>未提单</span>';
    if (st === "submitted") return '<span class="status-pill static submitted"><span class="dot"></span>已提单</span>';
    return "";
  }

  /** 单条骨架行（列表加载态用） */
  function skelRow() {
    return '<div class="recent-skel-row">' +
      '<span class="skeleton recent-skel-avatar" aria-hidden="true"></span>' +
      '<span class="skeleton recent-skel-line" aria-hidden="true"></span>' +
      '<span class="skeleton recent-skel-line short" aria-hidden="true"></span>' +
      '</div>';
  }

  /** 渲染最近提交列表（读 State.list，按 time 降序取最新 5 条；无记录显示空态） */
  function renderRecent() {
    var listEl = Util.$("recentList");
    if (!listEl) return;
    var arr = State.list.slice().sort(function (a, b) {
      return (b.time || "").localeCompare(a.time || "") || (b._ts || 0) - (a._ts || 0);
    }).slice(0, RECENT_LIMIT);

    if (!arr.length) {
      if (recentLoading) {
        // 骨架屏：列表加载态，避免「暂无记录」假空态闪现
        listEl.innerHTML = '<div class="recent-skel" role="status" aria-live="polite" aria-label="正在从云端加载最近提交…">' +
          skelRow() + skelRow() + skelRow() + '</div>';
      } else {
        listEl.innerHTML = '<div class="recent-empty">暂无提交记录，填写上方表单提交后会自动显示在这里。</div>';
      }
      return;
    }

    listEl.innerHTML = arr.map(function (rec) {
      var who = [];
      if (rec.picker) who.push(Util.esc(rec.picker));
      if (rec.dept) who.push(Util.esc(rec.dept));
      // 出库记录结算法人单位（若有）：追加展示，便于快速识别法人口径
      if (rec.entity && rec.type !== "in") who.push(Util.esc(rec.entity));
      var whoHtml = who.length ? who.join(" · ") : "—";
      return '<div class="recent-item" data-id="' + Util.esc(rec.id || "") + '">' +
        '<div class="recent-item-main">' +
          '<div class="recent-item-top">' +
            '<span class="recent-item-time">' + Util.esc(fmtRecentTime(rec.time)) + '</span>' +
            (rec.orderNo ? '<span class="recent-item-no">' + Util.esc(rec.orderNo) + '</span>' : '') +
            '<span class="recent-item-who">' + whoHtml + '</span>' +
          '</div>' +
          '<div class="recent-item-items">' + Util.esc(fmtItems(rec)) + '</div>' +
        '</div>' +
        '<div class="recent-item-side">' + statusBadge(rec) + '</div>' +
      '</div>';
    }).join("");
  }

  /** 云端刷新最近提交：有 token → syncPull → 重渲染；失败/无 token → 本地缓存 + 可选轻提示 */
  function refreshRecentWithCloud() {
    if (!Cloud.hasToken()) {
      recentLoading = false;
      renderRecent();
      return Promise.resolve(false);
    }
    recentLoading = true;
    renderRecent();   // 同一帧内把空态换成加载态，用户看不到「暂无提交记录」的闪现
    return Cloud.syncPull({ onStatus: function () {} }).then(function (res) {
      recentLoading = false;
      renderRecent();
      if (!res || !res.ok) {
        Util.toast("云端同步失败，已显示本地缓存", true);
        return false;
      }
      return true;
    }).catch(function () {
      recentLoading = false;
      renderRecent();
      Util.toast("云端同步失败，已显示本地缓存", true);
      return false;
    });
  }

  function render() {
    var el = Util.$("view-landing");
    if (!el) return;
    el.innerHTML =
      '<div class="landing">' +
        '<header class="landing-topbar">' +
          '<span class="landing-brand">' + Util.esc(Config.BRAND_TITLE) + '</span>' +
          '<button type="button" class="landing-admin" id="landingAdmin"><span class="landing-admin-emoji">🖥️</span> 管理 ➜</button>' +
        '</header>' +
        '<div class="landing-body">' +
          '<div class="landing-form" id="landingForm"></div>' +
          '<section class="recent-card" id="recentBox" aria-label="最近提交">' +
            '<div class="recent-card-head">' +
              '<span class="recent-icon">🕘</span>' +
              '<span class="recent-card-title">最近提交</span>' +
              '<span class="recent-card-tag">最新 ' + RECENT_LIMIT + ' 条 · 刷新自动同步</span>' +
            '</div>' +
            '<div class="recent-list" id="recentList"></div>' +
          '</section>' +
        '</div>' +
        '<button type="button" class="ai-fab" id="aiFab" title="AI 助手">🤖</button>' +
      '</div>';

    Util.$("landingAdmin").addEventListener("click", function () {
      if (Auth.isAuthed()) { Router.navigate("/app/out-records"); return; }
      UI.showLoginDialog().then(function (ok) {
        if (ok) Router.navigate("/app/out-records");
      });
    });

    // AI 助手浮动气泡（免登录即可用）
    Util.$("aiFab").addEventListener("click", function () {
      window.App.AI.Chat.openFloat();
    });

    // 最近提交列表事件委托（只读：点击提示前往管理后台；本项目禁止内联 onclick）
    Util.$("recentList").addEventListener("click", function (e) {
      var t = e.target;
      var item = t && t.closest ? t.closest(".recent-item") : null;
      if (!item) return;
      Util.toast("查看完整记录请前往管理后台");
    });

    // 复用 out.js 免密出库表单（out* 前缀 id 仅存在于落地页）
    window.App.Views.out.render(Util.$("landingForm"));

    // pendingEditId：从出库记录跳回编辑（保留照片等全字段）
    if (pendingEditId) {
      var id = pendingEditId;
      pendingEditId = null;
      window.App.Views.out.edit(id);
    }

    // 最近提交：先本地立即显示（有 token 时空列表显加载态而非假空态），再云端拉取刷新
    recentLoading = Cloud.hasToken();
    renderRecent();
    refreshRecentWithCloud();
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.landing = {
    render: render,
    renderRecent: renderRecent,
    refreshRecentWithCloud: refreshRecentWithCloud,
    get pendingEditId() { return pendingEditId; },
    set pendingEditId(v) { pendingEditId = v; }
  };
})();
