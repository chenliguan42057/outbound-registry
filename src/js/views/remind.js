/**
 * remind.js — 订单提醒推送模块
 * 从「出库记录 / 入库记录」页面的「提醒推送」按钮进入（#/app/out-remind / #/app/in-remind）。
 * 列出对应类型订单，勾选后点「发送到钉钉」→ 把所选订单紧凑摘要写入 data/notify/<id>.json，
 * 由 GitHub Action「DingTalk Remind」读取并以机器人身份推送钉钉群。
 * 整体样式沿用 records 卡片/表格风格，保持界面统一。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var State = window.App.State;
  var Cloud = window.App.Cloud;
  var Records = window.App.Records;
  var Router = window.App.Router;

  var container = null;
  var isIn = false;       // true=入库提醒，false=出库提醒
  var checked = {};       // id -> true
  var list = [];          // 当前过滤后的列表
  var SEND_LABEL = "\u{1F514} 发送到钉钉";

  function render(el) {
    container = el;
    isIn = State.nav.active === "in-remind";
    var title = isIn ? "入库提醒推送" : "出库提醒推送";
    el.innerHTML =
      '<div class="card">' +
        '<h2>' + title + ' <span class="badge" id="rmCount">0 条</span></h2>' +
        '<div class="actions rec-actions">' +
          '<button type="button" class="btn ghost sm" id="rmBack">&#8592; 返回记录</button>' +
          '<button type="button" class="btn ghost sm" id="rmSelectAll">全选</button>' +
          '<button type="button" class="btn ghost sm" id="rmClearSel">清空勾选</button>' +
        '</div>' +
        '<div class="rec-filters">' +
          '<input type="text" id="rmQ" class="search" placeholder="搜索：部门 / 领取人 / 货品名 / 用途" autocomplete="off" />' +
        '</div>' +
        '<div id="rmListBox"></div>' +
        '<div class="actions remind-bar">' +
          '<span id="rmPicked" style="color:var(--muted);">已选 0 条</span>' +
          '<button type="button" class="btn" id="rmSend">' + SEND_LABEL + '</button>' +
        '</div>' +
      '</div>';

    Util.$("rmBack").addEventListener("click", function () {
      Router.navigate("/app/" + (isIn ? "in-records" : "out-records"));
    });
    Util.$("rmSelectAll").addEventListener("click", function () {
      list.forEach(function (r) { checked[r.id] = true; });
      renderList();
    });
    Util.$("rmClearSel").addEventListener("click", function () {
      checked = {};
      renderList();
    });
    Util.$("rmSend").addEventListener("click", send);
    Util.$("rmQ").addEventListener("input", renderList);

    renderList();
  }

  /** 过滤当前类型订单（与记录页 filter 口径一致） */
  function filter() {
    var q = (Util.$("rmQ").value || "").trim().toLowerCase();
    return State.list.filter(function (r) {
      var recType = r.type || "out";
      if (isIn ? recType !== "in" : recType === "in") return false;
      if (!q) return true;
      var hay = (r.dept || "") + " " + (r.picker || "") + " " + (r.purpose || "") + " " +
        (r.entity || "") + " " + (r.note || "") + " " +
        (r.items || []).map(function (it) { return it.name; }).join(" ");
      return hay.toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderList() {
    list = filter();
    Util.$("rmCount").textContent = list.length + " 条";
    var box = Util.$("rmListBox");
    if (!list.length) {
      box.innerHTML = '<div class="empty">暂无记录，请先登记。</div>';
      updatePicked();
      return;
    }
    var html = '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th style="width:34px;"><input type="checkbox" id="rmHeadCk" title="全选" /></th>' +
      '<th>序号</th><th>时间</th><th>' + (isIn ? "经办人" : "领取人") + '</th>' +
      (!isIn ? '<th>状态</th>' : '') +
      '<th>' + (isIn ? "来源" : "部门") + '</th><th>用途/项目</th><th>货物名称</th><th>数量</th>' +
      '</tr></thead><tbody>';
    list.forEach(function (r, i) {
      var items = (r.items || []).map(function (it) {
        return '<div class="item-line">' + Util.esc(it.name) + ' × ' + it.qty + '</div>';
      }).join("");
      var qtySum = (r.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
      var st = Records.getStatus(r);
      html += '<tr>' +
        '<td><input type="checkbox" class="rm-row" value="' + r.id + '"' + (checked[r.id] ? " checked" : "") + ' /></td>' +
        '<td>' + (list.length - i) + '</td>' +
        '<td>' + Util.esc(r.time || "-") + '</td>' +
        '<td>' + Util.esc(r.picker || "-") + '</td>' +
        (!isIn ? '<td>' + (st === "pending" ? "未提单" : "已提单") + '</td>' : '') +
        '<td>' + Util.esc(r.dept || "-") + '</td>' +
        '<td>' + Util.esc(r.purpose || "-") + '</td>' +
        '<td class="items-cell">' + items + '</td>' +
        '<td>' + qtySum + '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    box.innerHTML = html;

    // 行勾选
    box.querySelectorAll(".rm-row").forEach(function (ck) {
      ck.addEventListener("change", function () {
        if (ck.checked) checked[ck.value] = true; else delete checked[ck.value];
        updatePicked();
      });
    });
    // 表头全选
    var headCk = Util.$("rmHeadCk");
    if (headCk) {
      headCk.checked = list.length > 0 && list.every(function (r) { return !!checked[r.id]; });
      headCk.addEventListener("change", function () {
        list.forEach(function (r) {
          if (headCk.checked) checked[r.id] = true; else delete checked[r.id];
        });
        renderList();
      });
    }
    updatePicked();
  }

  function updatePicked() {
    Util.$("rmPicked").textContent = "已选 " + Object.keys(checked).length + " 条";
  }

  /** 发送：勾选订单 → 紧凑摘要 → data/notify/<id>.json → Actions 推钉钉 */
  function send() {
    var ids = Object.keys(checked);
    if (!ids.length) return Util.toast("请先勾选要推送的订单", true);
    var orders = ids.map(function (id) {
      var r = State.list.find(function (x) { return x.id === id; });
      if (!r) return null;
      return {
        id: r.id,
        type: r.type || "out",
        time: r.time || "",
        picker: r.picker || "",
        dept: r.dept || "",
        purpose: r.purpose || "",
        entity: r.entity || "",
        note: r.note || "",
        status: r.status || "submitted",
        items: (r.items || []).map(function (it) { return { name: it.name, qty: it.qty }; })
      };
    }).filter(Boolean);
    if (!orders.length) return Util.toast("所选记录不存在，请刷新后重试", true);

    var btn = Util.$("rmSend");
    btn.disabled = true;
    btn.textContent = "发送中…";
    var payload = { _ts: Date.now(), type: "remind", kind: isIn ? "in" : "out", orders: orders };

    var attempt = 0;
    function tryPush() {
      Cloud.pushRemind(payload).then(function () {
        btn.disabled = false;
        btn.textContent = SEND_LABEL;
        Util.toast("已提交推送，" + orders.length + " 条订单稍后到达钉钉群");
        window.App.Views.app.setSyncStatus("提醒已提交", false);
        checked = {};
        renderList();
      }).catch(function (e) {
        attempt++;
        if (attempt < 3) { setTimeout(tryPush, 600 * attempt); return; }
        btn.disabled = false;
        btn.textContent = SEND_LABEL;
        Util.toast("推送提交失败：" + e.message + "（请重试）", true);
        window.App.Views.app.setSyncStatus("提醒提交失败", true);
      });
    }
    tryPush();
  }

  function refresh() {
    if (container) render(container);
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.remind = { render: render, refresh: refresh };
})();
