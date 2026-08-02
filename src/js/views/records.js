/**
 * records.js — 记录管理模块
 * 搜索筛选（部门/领取人/货品名 + 类型 + 时间范围）+ 表格 + 详情/编辑/删除 + 导出 CSV + 清空全部 + 立即同步
 * 管理操作（编辑/删除/导出/清空）均需密码（1111）。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Store = window.App.Store;
  var State = window.App.State;
  var Records = window.App.Records;
  var Cloud = window.App.Cloud;
  var Stock = window.App.Stock;

  var container = null;
  var listBox = null;
  var searchState = null;

  function render(el) {
    container = el;
    searchState = Store.loadSearch();
    el.innerHTML =
      '<div class="card">' +
        '<h2>记录管理 <span class="badge" id="recCount">0 条</span></h2>' +
        '<div class="actions rec-actions">' +
          '<button type="button" class="btn ghost sm" id="recExport">⬇ 导出 CSV</button>' +
          '<button type="button" class="btn ghost sm" id="recSync">🔄 立即同步</button>' +
          '<button type="button" class="btn danger sm" id="recClearAll">清空全部记录</button>' +
        '</div>' +
        '<div class="rec-filters">' +
          '<input type="text" id="recQ" class="search" placeholder="搜索：部门 / 领取人 / 货品名" autocomplete="off" />' +
          '<input type="text" id="recDept" class="search" placeholder="部门" autocomplete="off" />' +
          '<input type="text" id="recPicker" class="search" placeholder="领取人" autocomplete="off" />' +
          '<select id="recType" class="search">' +
            '<option value="">全部类型</option><option value="out">出库</option><option value="in">入库</option>' +
          '</select>' +
          '<input type="date" id="recFrom" class="search" title="开始日期" />' +
          '<input type="date" id="recTo" class="search" title="结束日期" />' +
        '</div>' +
        '<div id="recListBox"></div>' +
      '</div>';

    listBox = Util.$("recListBox");
    var qEl = Util.$("recQ"), deptEl = Util.$("recDept"), pickerEl = Util.$("recPicker"),
        typeEl = Util.$("recType"), fromEl = Util.$("recFrom"), toEl = Util.$("recTo");
    qEl.value = searchState.q;
    deptEl.value = searchState.dept;
    pickerEl.value = searchState.picker;
    typeEl.value = searchState.type;
    fromEl.value = searchState.from;
    toEl.value = searchState.to;

    function save() {
      searchState.q = qEl.value.trim();
      searchState.dept = deptEl.value.trim();
      searchState.picker = pickerEl.value.trim();
      searchState.type = typeEl.value;
      searchState.from = fromEl.value;
      searchState.to = toEl.value;
      Store.saveSearch(searchState);
      renderList();
    }
    [qEl, deptEl, pickerEl, typeEl, fromEl, toEl].forEach(function (input) {
      input.addEventListener("input", save);
      input.addEventListener("change", save);
    });

    Util.$("recExport").addEventListener("click", async function () {
      var ok = await UI.pwDialog("导出 CSV 需要密码");
      if (!ok) return;
      Records.exportCsv(filter());
    });
    Util.$("recSync").addEventListener("click", function () { doSync(); });
    Util.$("recClearAll").addEventListener("click", async function () {
      var ok = await UI.pwDialog("清空全部记录需要密码");
      if (!ok) return;
      var sure = await UI.confirmDialog("将清空全部记录（含云端），且不可恢复。确定继续？", "清空全部记录");
      if (!sure) return;
      try { await Cloud.clearAll(); } catch (e) {}
      Records.clear();
      renderList();
      window.App.Views.app.setSyncStatus("已清空全部记录", false);
      Util.toast("已清空全部记录");
    });

    // 列表操作事件委托
    listBox.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-act]");
      if (!btn) return;
      var act = btn.getAttribute("data-act");
      var id = btn.getAttribute("data-id");
      if (act === "detail") showDetail(id);
      else if (act === "edit") doEdit(id);
      else if (act === "del") doDel(id);
      else if (act === "photo") showPhoto(btn.getAttribute("data-src"));
    });
    renderList();
  }

  /** 按搜索条件过滤记录 */
  function filter() {
    var q = searchState.q.toLowerCase();
    var from = searchState.from ? new Date(searchState.from + "T00:00:00").getTime() : null;
    var to = searchState.to ? new Date(searchState.to + "T23:59:59").getTime() : null;
    return State.list.filter(function (r) {
      if (searchState.type && (r.type || "out") !== searchState.type) return false;
      if (searchState.dept && !(r.dept || "").toLowerCase().includes(searchState.dept.toLowerCase())) return false;
      if (searchState.picker && !(r.picker || "").toLowerCase().includes(searchState.picker.toLowerCase())) return false;
      if (q) {
        var hay = (r.dept || "") + " " + (r.picker || "") + " " + (r.purpose || "") + " " +
          (r.items || []).map(function (it) { return it.name; }).join(" ");
        if (!hay.toLowerCase().includes(q)) return false;
      }
      if (from !== null) {
        var t1 = new Date(r.time || 0).getTime();
        if (isNaN(t1) || t1 < from) return false;
      }
      if (to !== null) {
        var t2 = new Date(r.time || 0).getTime();
        if (isNaN(t2) || t2 > to) return false;
      }
      return true;
    });
  }

  /** 云端同步后刷新（保留搜索框，重建表格） */
  function refresh() {
    if (listBox) renderList();
  }

  function renderList() {
    var list = filter();
    Util.$("recCount").textContent = list.length + " 条";
    if (!list.length) {
      listBox.innerHTML = '<div class="empty">暂无记录，请先登记。</div>';
      return;
    }
    var html = '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>序号</th><th>时间</th><th>领取人</th><th>部门</th><th>用途/项目</th><th>货物名称</th><th>数量</th><th>库存</th><th>照片</th><th>操作</th>' +
      '</tr></thead><tbody>';
    list.forEach(function (r, i) {
      var items = (r.items || []).map(function (it, idx, arr) {
        return '<div class="item-line' + (arr.length > 1 ? " multi-line" : "") + '">' + Util.esc(it.name) + ' × ' + it.qty + '</div>';
      }).join("");
      var stocks = (r.items || []).map(function (it, idx, arr) {
        return '<div class="item-line' + (arr.length > 1 ? " multi-line" : "") + '">' + Stock.getStock(it.name) + '</div>';
      }).join("");
      var qtySum = (r.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
      var photos = r.photos || [];
      var photoHtml = photos.length
        ? photos.slice(0, 4).map(function (src, pi) {
            return '<img class="mini-photo" src="' + src + '" data-act="photo" data-src="' + src + '" data-id="' + r.id + '" alt="照片' + (pi + 1) + '" />';
          }).join("") + (photos.length > 4 ? '<span class="badge">+' + (photos.length - 4) + '</span>' : "")
        : '<span class="badge">无</span>';
      var inMark = r.type === "in" ? '<span class="in-tag">入库</span>' : "";
      html += '<tr>' +
        '<td><div>' + (list.length - i) + inMark + '</div>' +
          '<button type="button" class="btn ghost sm detail-btn" data-act="detail" data-id="' + r.id + '">详细</button></td>' +
        '<td>' + Util.esc(r.time || "-") + '</td>' +
        '<td>' + Util.esc(r.picker || "-") + '</td>' +
        '<td>' + Util.esc(r.dept || "-") + '</td>' +
        '<td>' + Util.esc(r.purpose || "-") + '</td>' +
        '<td class="items-cell">' + items + '</td>' +
        '<td>' + qtySum + '</td>' +
        '<td class="items-cell">' + stocks + '</td>' +
        '<td><div class="photos-cell">' + photoHtml + '</div></td>' +
        '<td>' +
          '<button type="button" class="btn ghost sm" data-act="edit" data-id="' + r.id + '">编辑</button> ' +
          '<button type="button" class="btn danger sm" data-act="del" data-id="' + r.id + '">删除</button>' +
        '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    listBox.innerHTML = html;
  }

  function showDetail(id) {
    var r = State.list.find(function (x) { return x.id === id; });
    if (!r) return;
    var isIn = r.type === "in";
    var itemsHtml = (r.items || []).map(function (it) {
      return '<div class="detail-item"><span>' + Util.esc(it.name) + ' × ' + it.qty + '</span>' +
        '<span style="color:var(--muted);">库存 ' + Stock.getStock(it.name) + '</span></div>';
    }).join("");
    var photosHtml = (r.photos && r.photos.length)
      ? '<div class="detail-photos">' + r.photos.map(function (src, i) {
          return '<img src="' + src + '" data-act="photo" data-src="' + src + '" alt="照片' + (i + 1) + '" />';
        }).join("") + '</div>'
      : '<span style="color:var(--muted);">无照片</span>';
    var rows = "";
    rows += '<div class="detail-row"><span class="k">类型</span><span class="v">' + (isIn ? '<span class="in-tag">入库</span>' : "出库") + '</span></div>';
    rows += '<div class="detail-row"><span class="k">时间</span><span class="v">' + Util.esc(r.time || "-") + '</span></div>';
    if (!isIn) {
      rows += '<div class="detail-row"><span class="k">领取人</span><span class="v">' + Util.esc(r.picker || "-") + '</span></div>';
      rows += '<div class="detail-row"><span class="k">部门</span><span class="v">' + Util.esc(r.dept || "-") + '</span></div>';
    }
    rows += '<div class="detail-row"><span class="k">' + (isIn ? "用途/来源" : "用途/项目") + '</span><span class="v">' + Util.esc(r.purpose || "-") + '</span></div>';
    rows += '<div class="detail-row"><span class="k">货品明细</span><span class="v detail-items">' + (itemsHtml || "-") + '</span></div>';
    rows += '<div class="detail-row"><span class="k">照片</span><span class="v">' + photosHtml + '</span></div>';
    UI.Modal.show(isIn ? "入库详情" : "出库详情", rows, { width: "560px" });
  }

  function showPhoto(src) {
    UI.Modal.show("照片预览", '<img class="preview-img" src="' + src + '" alt="" />', { width: "fit-content" });
  }

  /** 编辑：密码校验后跳转到对应模块（入库→入库模块，出库→出库模块） */
  async function doEdit(id) {
    var r = State.list.find(function (x) { return x.id === id; });
    if (!r) return;
    var ok = await UI.pwDialog("编辑需要密码");
    if (!ok) return;
    if (r.type === "in") {
      window.App.Views.app.mount("in");
      window.App.Views.in.edit(id);
    } else {
      window.App.Views.app.mount("out");
      window.App.Views.out.edit(id);
    }
  }

  /** 删除：密码校验 + 确认，本地删除后同步云端 */
  async function doDel(id) {
    var r = State.list.find(function (x) { return x.id === id; });
    if (!r) return;
    var ok = await UI.pwDialog("删除需要密码");
    if (!ok) return;
    var affects = r.affectsStock === true;
    var sure = await UI.confirmDialog(
      affects ? "确定删除该条记录？删除后库存会自动恢复。" : "确定删除该条记录？",
      "删除记录"
    );
    if (!sure) return;
    Records.remove(id);
    renderList();
    Util.toast(affects ? "已删除，库存已自动恢复" : "已删除");
    try { await Cloud.del(id); } catch (e) {}
  }

  function doSync() {
    if (!Cloud.hasToken()) { Util.toast("未配置云端令牌，无法同步", true); return; }
    Util.toast("正在同步…");
    Cloud.syncPull({ onStatus: function (text, isErr) {
      window.App.Views.app.setSyncStatus(text, isErr);
    } }).then(function () { renderList(); });
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.records = {
    render: render,
    refresh: refresh,
    filter: filter,
    doSync: doSync
  };
})();
