/**
 * records.js — 出入库记录模块工厂：createRecordsModule(type) 生成「入库记录」/「出库记录」
 * 搜索筛选 + 表格 + 详情/编辑/删除 + 导出 CSV + 清空全部 + 立即同步。
 * 出库记录带「状态」列（未提单/已提单，点击切换 + 同步云端）。
 * 出库记录编辑 → LandingView.pendingEditId + 跳落地页（保留照片等全字段编辑）；
 * 入库记录编辑 → 入库模块内编辑。
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
  var Router = window.App.Router;

  function createRecordsModule(type) {
    var isIn = type === "in";
    var title = isIn ? "入库记录" : "出库记录";
    var container = null;
    var listBox = null;
    var searchState = null;
    var selected = {};        // 批量选中集合：id -> true

    function render(el) {
      container = el;
      searchState = Store.loadSearch();
      el.innerHTML =
        '<div class="card">' +
          '<h2>' + title + ' <span class="badge" id="recCount">0 条</span></h2>' +
          '<div class="actions rec-actions">' +
            '<button type="button" class="btn ghost sm" id="recExport">&#11015; 导出 CSV</button>' +
            '<button type="button" class="btn ghost sm" id="recExportAcc">&#128202; 对账 CSV</button>' +
            '<button type="button" class="btn ghost sm" id="recPrintAll">&#128424; 批量打印</button>' +
            '<button type="button" class="btn ghost sm" id="recSync">&#128260; 立即同步</button>' +
            '<button type="button" class="btn ghost sm" id="recRemind">&#128276; 提醒推送</button>' +
            '<button type="button" class="btn danger sm" id="recClearAll">清空全部记录</button>' +
          '</div>' +
          // 批量操作条：默认隐藏，勾选任意一行后出现。只确认一次，避免 20 单逐条点确认
          '<div class="bulk-bar" id="recBulkBar" style="display:none;">' +
            '<span class="bulk-count" id="recBulkCount">已选 0 条</span>' +
            (!isIn ? '<button type="button" class="btn ghost sm" id="recBulkSubmit">批量标为已提单</button>' : '') +
            (!isIn ? '<button type="button" class="btn ghost sm" id="recBulkPending">批量标为未提单</button>' : '') +
            '<button type="button" class="btn danger sm" id="recBulkDel">批量删除</button>' +
            '<button type="button" class="btn ghost sm" id="recBulkCancel">取消选择</button>' +
          '</div>' +
          '<div class="rec-filters">' +
            '<input type="text" id="recDept" class="search" placeholder="' + (isIn ? "来源" : "部门/客户") + '" autocomplete="off" />' +
            '<input type="text" id="recPicker" class="search" placeholder="' + (isIn ? "经办人" : "领取人") + '" autocomplete="off" />' +
            '<input type="date" id="recFrom" class="search" title="开始日期" />' +
            '<input type="date" id="recTo" class="search" title="结束日期" />' +
          '</div>' +
          '<div id="recListBox"></div>' +
        '</div>';

      listBox = Util.$("recListBox");
      var deptEl = Util.$("recDept"), pickerEl = Util.$("recPicker"),
          fromEl = Util.$("recFrom"), toEl = Util.$("recTo");
      deptEl.value = searchState.dept;
      pickerEl.value = searchState.picker;
      fromEl.value = searchState.from;
      toEl.value = searchState.to;

      function save() {
        searchState.dept = deptEl.value.trim();
        searchState.picker = pickerEl.value.trim();
        searchState.from = fromEl.value;
        searchState.to = toEl.value;
        Store.saveSearch(searchState);
        renderList();
      }
      [deptEl, pickerEl, fromEl, toEl].forEach(function (input) {
        input.addEventListener("input", save);
        input.addEventListener("change", save);
      });

      Util.$("recExport").addEventListener("click", function () {
        Records.exportCsv(filter());
      });
      Util.$("recExportAcc").addEventListener("click", function () {
        Records.exportReconCsv(filter());
      });
      Util.$("recPrintAll").addEventListener("click", doPrintAll);
      Util.$("recSync").addEventListener("click", function () { doSync(); });
      Util.$("recRemind").addEventListener("click", function () {
        Router.navigate("/app/" + (isIn ? "in-remind" : "out-remind"));
      });
      Util.$("recClearAll").addEventListener("click", async function () {
        var r = await UI.promptDialog("将清空全部记录（含云端），且不可恢复。请填写清空原因：", "例如：年度归档 / 数据迁移…", "清空全部记录", "确认清空");
        if (!r.ok) return;
        try { await Cloud.clearAllWithReason(r.value); } catch (e) {}
        Records.clear();
        renderList();
        window.App.Views.app.setSyncStatus("已清空全部记录", false);
        Util.toast("已清空全部记录");
      });

      // 批量操作按钮
      var bulkSubmitEl = Util.$("recBulkSubmit");
      if (bulkSubmitEl) bulkSubmitEl.addEventListener("click", function () { doBulkStatus("submitted"); });
      var bulkPendingEl = Util.$("recBulkPending");
      if (bulkPendingEl) bulkPendingEl.addEventListener("click", function () { doBulkStatus("pending"); });
      Util.$("recBulkDel").addEventListener("click", doBulkDel);
      Util.$("recBulkCancel").addEventListener("click", function () { selected = {}; renderList(); });

      // 勾选：change 事件单独处理，不能混进下面的 click 委托——
      // 行本身绑了 data-act="detail"，勾选必须阻止冒泡，否则每勾一条就弹一次详情
      listBox.addEventListener("click", function (e) {
        if (e.target && e.target.classList && e.target.classList.contains("rec-check")) {
          e.stopPropagation();
          var cid = e.target.getAttribute("data-id");
          if (e.target.checked) selected[cid] = true; else delete selected[cid];
          updateBulkBar();
          return;
        }
        if (e.target && e.target.id === "recCheckAll") {
          e.stopPropagation();
          var all = e.target.checked;
          selected = {};
          if (all) filter().forEach(function (r) { selected[r.id] = true; });
          listBox.querySelectorAll(".rec-check").forEach(function (cb) { cb.checked = all; });
          updateBulkBar();
          return;
        }
      });

      // 列表操作事件委托
      listBox.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-act]");
        if (!btn) return;
        if (e.target && e.target.classList && e.target.classList.contains("rec-check")) return;
        var act = btn.getAttribute("data-act");
        var id = btn.getAttribute("data-id");
        if (act === "detail") showDetail(id);
        else if (act === "edit") doEdit(id);
        else if (act === "del") doDel(id);
        else if (act === "status") toggleStatus(id);
        else if (act === "photo") showPhoto(btn.getAttribute("data-src"));
        else if (act === "print") doPrint(id);
      });
      renderList();
    }

    /** 按搜索条件过滤记录（类型已由模块固定） */
    function filter() {
      var from = searchState.from ? new Date(searchState.from + "T00:00:00").getTime() : null;
      var to = searchState.to ? new Date(searchState.to + "T23:59:59").getTime() : null;
      var list = State.list.filter(function (r) {
        var recType = r.type || "out";
        if (isIn ? recType !== "in" : recType === "in") return false;
        if (r.borrowed === true) return false;   // 已转入先借后还的出库单，不在普通出库记录列表显示
        if (searchState.dept && !(r.dept || "").toLowerCase().includes(searchState.dept.toLowerCase())) return false;
        if (searchState.picker && !(r.picker || "").toLowerCase().includes(searchState.picker.toLowerCase())) return false;
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
      // 置顶记录固定在最前（多条置顶按置顶时间倒序），其余保持 State.list 原顺序（time 降序）。
      // Array.sort 自 ES2019 起稳定，返回 0 即保留原相对顺序，不会打乱未置顶记录。
      return list.sort(function (a, b) {
        var pa = a.pinned === true ? 1 : 0;
        var pb = b.pinned === true ? 1 : 0;
        if (pa !== pb) return pb - pa;
        if (pa === 1) return (Number(b.pinnedAt) || 0) - (Number(a.pinnedAt) || 0);
        return 0;
      });
    }

    /** 云端同步后刷新（保留搜索框，重建表格） */
    function refresh() {
      if (listBox) renderList();
    }

    /** 出库状态徽标（可点击切换）：红点=未提单，绿点=已提单 */
    function statusPill(r) {
      var st = Records.getStatus(r);   // "pending" | "submitted"
      var label = st === "pending" ? "未提单" : "已提单";
      return '<button type="button" class="status-pill ' + st + '" data-act="status" data-id="' + r.id + '">' +
        '<span class="dot"></span>' + label + '</button>';
    }

    /** 出库状态徽标（详情弹窗展示用，不可点击） */
    function statusBadge(r) {
      var st = Records.getStatus(r);
      var label = st === "pending" ? "未提单" : "已提单";
      return '<span class="status-pill static ' + st + '"><span class="dot"></span>' + label + '</span>';
    }

    /** 点击状态徽标：确认后切换 pending↔submitted，本地保存 + 推送云端 */
    async function toggleStatus(id) {
      var r = State.list.find(function (x) { return x.id === id; });
      if (!r) return;
      var cur = Records.getStatus(r);
      var next = cur === "pending" ? "submitted" : "pending";
      var label = next === "pending" ? "未提单" : "已提单";
      var ok = await UI.confirmDialog("标记为" + label + "？", "更新状态");
      if (!ok) return;
      var rec = Records.update(id, { status: next });
      if (!rec) { Util.toast("记录不存在", true); return; }
      // 先借后还差额单提交后 → 原借出单自动结清
      if (next === "submitted" && Records.tryCloseBorrowFromDiff(rec)) {
        Util.toast("已标记为已提单，对应借出单已结清");
      } else {
        Util.toast("已标记为" + label);
      }
      renderList();
      if (Cloud.hasToken()) {
        // 走队列式推送：推送失败自动入队，下次同步/操作冲刷补推，避免状态改动丢失
        Cloud.pushRecord(rec).then(function (ok) {
          window.App.Views.app.setSyncStatus(ok ? "已同步" : "云端同步失败（已入队，稍后自动补推）", !ok);
        });
      }
    }

    function renderList() {
      var list = filter();
      Util.$("recCount").textContent = list.length + " 条";
      if (!list.length) {
        listBox.innerHTML = '<div class="empty">暂无记录，请先登记。</div>';
        selected = {};
        updateBulkBar();
        return;
      }
      var html = '<div class="table-wrap"><table class="table"><thead><tr>' +
        '<th class="check-col"><input type="checkbox" id="recCheckAll" title="全选当前筛选结果" /></th>' +
        '<th>序号</th><th>时间</th><th>' + (isIn ? "经办人" : "领取人") + '</th>' +
        (!isIn ? '<th>状态</th>' : '') +
        (!isIn ? '<th>出货仓库单位</th>' : '') +
        '<th>' + (isIn ? "来源" : "部门") + '</th><th>用途/项目</th><th>货物名称</th><th>数量</th><th>库存</th><th>照片</th><th>操作</th>' +
        '</tr></thead><tbody>';
      list.forEach(function (r, i) {
        var items = (r.items || []).map(function (it, idx, arr) {
          return '<div class="item-line' + (arr.length > 1 ? " multi-line" : "") + '">' + Util.esc(it.name) + ' × ' + it.qty + '</div>';
        }).join("");
        var stocks = (r.items || []).map(function (it, idx, arr) {
          return '<div class="item-line' + (arr.length > 1 ? " multi-line" : "") + '">' + Stock.getRecordStock(it.name, r, it) + '</div>';
        }).join("");
        var qtySum = (r.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
        var photos = (r.photoUrls && r.photoUrls.length) ? r.photoUrls : (r.photos || []);
        var photoHtml = photos.length
          ? photos.slice(0, 4).map(function (src, pi) {
              return '<img class="mini-photo" src="' + src + '" data-act="photo" data-src="' + src + '" data-id="' + r.id + '" alt="照片' + (pi + 1) + '" />';
            }).join("") + (photos.length > 4 ? '<span class="badge">+' + (photos.length - 4) + '</span>' : "")
          : '<span class="badge">无</span>';
        var inMark = r.type === "in" ? '<span class="in-tag">入库</span>' : "";
        var pinMark = r.pinned === true ? ' <span title="已置顶" style="color:#BA7517;">📌</span>' : "";
        html += '<tr data-act="detail" data-id="' + r.id + '">' +
          '<td class="check-col"><input type="checkbox" class="rec-check" data-id="' + r.id + '"' +
            (selected[r.id] ? " checked" : "") + ' /></td>' +
          '<td><div>' + (list.length - i) + pinMark + inMark + '</div></td>' +
          '<td>' + Util.esc(r.time || "-") + '</td>' +
          '<td>' + Util.esc(r.picker || "-") + '</td>' +
          (!isIn ? '<td>' + statusPill(r) + '</td>' : '') +
          (!isIn ? '<td>' + Util.esc(r.entity || "-") + '</td>' : '') +
          '<td>' + Util.esc(r.dept || "-") + '</td>' +
          '<td>' + Util.esc(r.purpose || "-") + '</td>' +
          '<td class="items-cell">' + items + '</td>' +
          '<td>' + qtySum + '</td>' +
          '<td class="items-cell">' + stocks + '</td>' +
          '<td><div class="photos-cell">' + photoHtml + '</div></td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
      listBox.innerHTML = html;
      // 列表重建后（同步/筛选变化）清理已不在结果里的选中项，避免"已选 3 条"却找不到行
      var visible = {};
      list.forEach(function (r) { visible[r.id] = true; });
      Object.keys(selected).forEach(function (id) { if (!visible[id]) delete selected[id]; });
      updateBulkBar();
    }

    /** 刷新批量操作条的显示与计数 */
    function updateBulkBar() {
      var ids = Object.keys(selected);
      var bar = Util.$("recBulkBar");
      if (!bar) return;
      bar.style.display = ids.length ? "" : "none";
      var cnt = Util.$("recBulkCount");
      if (cnt) cnt.textContent = "已选 " + ids.length + " 条";
    }

    function selectedRecords() {
      return State.list.filter(function (r) { return selected[r.id]; });
    }

    /** 批量改状态：只确认一次，逐条本地更新后统一推送云端 */
    async function doBulkStatus(next) {
      var recs = selectedRecords();
      if (!recs.length) return;
      var label = next === "pending" ? "未提单" : "已提单";
      var ok = await UI.confirmDialog("将把选中的 " + recs.length + " 条记录标记为" + label + "。", "批量更新状态");
      if (!ok) return;
      var updated = [];
      recs.forEach(function (r) {
        var rec = Records.update(r.id, { status: next });
        if (rec) updated.push(rec);
      });
      // 批量提交已提单时，自动结清对应的先借后还差额原单
      var closedBorrow = 0;
      if (next === "submitted") {
        updated.forEach(function (rec) {
          if (Records.tryCloseBorrowFromDiff(rec)) closedBorrow++;
        });
      }
      selected = {};
      renderList();
      var msg = "已标记 " + updated.length + " 条为" + label;
      if (closedBorrow) msg += "，" + closedBorrow + " 笔借出单已结清";
      Util.toast(msg);
      if (Cloud.hasToken()) {
        // 队列式推送：失败自动入队，下次同步补推，不会静默丢状态
        var fail = 0;
        for (var i = 0; i < updated.length; i++) {
          var okPush = await Cloud.pushRecord(updated[i]);
          if (!okPush) fail++;
        }
        window.App.Views.app.setSyncStatus(
          fail ? (fail + " 条同步失败（已入队，稍后自动补推）") : "已同步", !!fail
        );
      }
    }

    /** 批量删除：一次填理由、一次确认，逐条走与单条删除相同的墓碑队列 */
    async function doBulkDel() {
      var recs = selectedRecords();
      if (!recs.length) return;
      var affects = recs.some(function (r) { return r.affectsStock === true; });
      var res = await UI.promptDialog(
        "将删除选中的 " + recs.length + " 条记录" + (affects ? "，库存会自动恢复" : "") + "。请填写删除理由：",
        "例如：登记错误 / 重复登记 / 已撤销…",
        "批量删除 " + recs.length + " 条记录",
        "确认删除"
      );
      if (!res.ok) return;
      // 先全部入本地墓碑队列再删，中途失败也不会让记录在下次同步复活
      if (Cloud.hasToken()) recs.forEach(function (r) { Cloud.enqueueTomb(r.id, res.value); });
      recs.forEach(function (r) { Records.remove(r.id); });
      selected = {};
      renderList();
      Util.toast("已删除 " + recs.length + " 条" + (affects ? "，库存已自动恢复" : ""));
      if (Cloud.hasToken()) {
        var failed = 0;
        for (var i = 0; i < recs.length; i++) {
          try {
            await Cloud.delWithTombstone(recs[i], res.value);
            Cloud.dequeueTomb(recs[i].id);
          } catch (e) { failed++; }
        }
        if (failed) {
          window.App.Views.app.setSyncStatus(failed + " 条云端删除失败（已存本地墓碑，下次同步自动补推）", true);
        }
      }
    }

    function showDetail(id) {
      var r = State.list.find(function (x) { return x.id === id; });
      if (!r) return;
      var isRecIn = r.type === "in";
      var itemsHtml = (r.items || []).map(function (it) {
        return '<div class="detail-item"><span>' + Util.esc(it.name) + ' × ' + it.qty + '</span>' +
          '<span style="color:var(--muted);">库存 ' + Stock.getRecordStock(it.name, r, it) + '</span></div>';
      }).join("");
      var photosHtml = (r.photoUrls && r.photoUrls.length)
        ? '<div class="detail-photos">' + r.photoUrls.map(function (src, i) {
            return '<img src="' + src + '" data-act="photo" data-src="' + src + '" alt="照片' + (i + 1) + '" />';
          }).join("") + '</div>'
        : ((r.photos && r.photos.length)
          ? '<div class="detail-photos">' + r.photos.map(function (src, i) {
              return '<img src="' + src + '" data-act="photo" data-src="' + src + '" alt="照片' + (i + 1) + '" />';
            }).join("") + '</div>'
          : '<span style="color:var(--muted);">无照片</span>');
      var rows = "";
      rows += '<div class="detail-row"><span class="k">类型</span><span class="v">' + (isRecIn ? '<span class="in-tag">入库</span>' : "出库") + '</span></div>';
      rows += '<div class="detail-row"><span class="k">时间</span><span class="v">' + Util.esc(r.time || "-") + '</span></div>';
      if (!isRecIn) {
        rows += '<div class="detail-row"><span class="k">状态</span><span class="v">' + statusBadge(r) + '</span></div>';
        rows += '<div class="detail-row"><span class="k">领取人</span><span class="v">' + Util.esc(r.picker || "-") + '</span></div>';
        rows += '<div class="detail-row"><span class="k">部门</span><span class="v">' + Util.esc(r.dept || "-") + '</span></div>';
        if (r.entity) {
          rows += '<div class="detail-row"><span class="k">出货仓库单位</span><span class="v">' + Util.esc(r.entity) + '</span></div>';
        }
      }
      rows += '<div class="detail-row"><span class="k">' + (isRecIn ? "用途/来源" : "用途/项目") + '</span><span class="v">' + Util.esc(r.purpose || "-") + '</span></div>';
      if (r.note) {
        rows += '<div class="detail-row"><span class="k">备注</span><span class="v">' + Util.esc(r.note) + '</span></div>';
      }
      rows += '<div class="detail-row"><span class="k">货品明细</span><span class="v detail-items">' + (itemsHtml || "-") + '</span></div>';
      rows += '<div class="detail-row"><span class="k">照片</span><span class="v">' + photosHtml + '</span></div>';
      // 2026-08-08：操作按钮（打印/编辑/删除）从列表行移入详情弹窗，列表行只展示数据
      rows += '<div class="detail-row" style="display:block;border-bottom:none;padding-top:16px">' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn ' + (r.pinned === true ? "" : "ghost") + ' sm" data-detail-act="pin">' +
            (r.pinned === true ? '📌 取消置顶' : '📌 置顶') + '</button> ' +
          '<button type="button" class="btn ghost sm" data-detail-act="print">🖨 打印</button> ' +
          '<button type="button" class="btn sm" data-detail-act="edit">编辑</button> ' +
          '<button type="button" class="btn danger sm" data-detail-act="del">删除</button>' +
        '</div></div>';
      UI.Modal.show(isRecIn ? "入库详情" : "出库详情", rows, { width: "560px" });
      // 绑定详情弹窗内的操作按钮（Modal 内事件不会冒泡到 listBox）
      var actions = UI.Modal.body();
      if (actions) {
        actions.querySelectorAll("[data-detail-act]").forEach(function (b) {
          b.addEventListener("click", function () {
            var act = b.getAttribute("data-detail-act");
            if (act === "print") doPrint(id);
            else if (act === "edit") doEdit(id);
            else if (act === "del") doDel(id);
            else if (act === "pin") doTogglePin(id);
          });
        });
      }
    }

    /** 置顶 / 取消置顶：置顶记录固定在列表最前，方便快速找到重点单据（对账、待跟进等）。
        纯追加字段 pinned / pinnedAt——不含 items，不会重打库存快照；不影响库存与既有 schema。 */
    function doTogglePin(id) {
      var r = State.list.find(function (x) { return x.id === id; });
      if (!r) return;
      var next = !(r.pinned === true);
      var rec = Records.update(id, { pinned: next, pinnedAt: next ? Date.now() : 0 });
      if (!rec) { Util.toast("记录不存在", true); return; }
      UI.Modal.hide();
      renderList();
      Util.toast(next ? "已置顶，该单固定在列表最前" : "已取消置顶");
      if (Cloud.hasToken()) {
        Cloud.pushRecord(rec).then(function (ok) {
          window.App.Views.app.setSyncStatus(ok ? "已同步" : "云端同步失败（已入队，稍后自动补推）", !ok);
        });
      }
    }

    function showPhoto(src) {
      UI.Modal.show("照片预览", '<img class="preview-img" src="' + src + '" alt="" />', { width: "fit-content" });
    }

    /** 生成单据打印 HTML（单个记录，供单条打印与批量打印复用） */
    function buildPrintHtml(r) {
      var isRecIn = r.type === "in";
      var kindLabel = isRecIn ? "入库单" : "出库单";
      var itemsHtml = (r.items || []).map(function (it) {
        return '<tr><td>' + Util.esc(it.name) + '</td><td class="c">' + it.qty + '</td>' +
          '<td class="c">' + Stock.getRecordStock(it.name, r, it) + '</td></tr>';
      }).join("");
      var statusLabel = isRecIn ? "" : (Records.getStatus(r) === "pending" ? "未提单" : "已提单");
      return '<div class="print-sheet">' +
        '<h1>出入库登记 · ' + kindLabel + '</h1>' +
        '<div class="sub">单号：' + Util.esc(r.orderNo || r.id) + '　|　时间：' + Util.esc(String(r.time || "").replace("T", " ")) + '</div>' +
        '<div class="field">' +
          '<b>' + (isRecIn ? "经办人" : "领取人") + '：</b>' + Util.esc(r.picker || "-") + '<br>' +
          (isRecIn ? '' : '<b>部门/客户：</b>' + Util.esc(r.dept || "-") + '<br>') +
          (isRecIn ? '' : (r.entity ? '<b>出货仓库单位：</b>' + Util.esc(r.entity) + '<br>' : '')) +
          '<b>' + (isRecIn ? "用途/来源" : "用途/项目") + '：</b>' + Util.esc(r.purpose || "-") + '<br>' +
          (isRecIn ? '' : '<b>状态：</b>' + statusLabel + '<br>') +
          (r.note ? '<b>备注：</b>' + Util.esc(r.note) + '<br>' : '') +
        '</div>' +
        '<table><thead><tr><th>货品名称</th><th class="c">数量</th><th class="c">库存</th></tr></thead>' +
        '<tbody>' + (itemsHtml || '<tr><td colspan="3">（无明细）</td></tr>') + '</tbody></table>' +
        '<div class="sign">' +
          '<div>领取人/经办人<div class="line">签名</div></div>' +
          '<div>仓管员<div class="line">签名</div></div>' +
          '<div>审批人<div class="line">签名</div></div>' +
        '</div>' +
      '</div>';
    }

    /** 打印单据：新窗口排版该记录并触发打印（含标题/字段/货品/签名栏） */
    function doPrint(id) {
      var r = State.list.find(function (x) { return x.id === id; });
      if (!r) return;
      var win = window.open("", "_blank", "width=640,height=800");
      if (!win) { Util.toast("浏览器拦截了打印窗口，请允许弹窗", true); return; }
      win.document.write(
        '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">' +
        '<title>' + (r.type === "in" ? "入库单" : "出库单") + ' - ' + Util.esc(r.id) + '</title>' +
        '<style>' +
          printStyle() +
        '</style></head><body>' +
        buildPrintHtml(r) +
        '<script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>' +
        '</body></html>'
      );
      win.document.close();
    }

    /** 批量打印当前筛选出的全部记录：每单独立分页，一次打印 */
    function doPrintAll() {
      var list = filter();
      if (!list.length) { Util.toast("当前筛选无记录可打印", true); return; }
      if (list.length > 50) { Util.toast("一次最多打印 50 条，请先缩小筛选范围", true); return; }
      var win = window.open("", "_blank", "width=640,height=800");
      if (!win) { Util.toast("浏览器拦截了打印窗口，请允许弹窗", true); return; }
      var sheets = list.map(buildPrintHtml).join("");
      win.document.write(
        '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">' +
        '<title>批量打印（' + list.length + ' 条）</title>' +
        '<style>' +
          printStyle() +
          '.print-sheet{page-break-after:always;} .print-sheet:last-child{page-break-after:auto;}' +
        '</style></head><body>' +
        sheets +
        '<script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>' +
        '</body></html>'
      );
      win.document.close();
    }

    /** 打印样式（单条/批量共用） */
    function printStyle() {
      return 'body{font-family:"Microsoft YaHei",sans-serif;color:#222;margin:32px;} ' +
        'h1{font-size:22px;text-align:center;letter-spacing:2px;margin:0 0 4px;} ' +
        '.sub{text-align:center;color:#888;font-size:12px;margin-bottom:24px;} ' +
        'table{width:100%;border-collapse:collapse;margin:16px 0;} ' +
        'th,td{border:1px solid #999;padding:8px 10px;font-size:14px;} ' +
        'th{background:#f5f5f5;} .c{text-align:center;} ' +
        '.field{font-size:14px;line-height:2;} .field b{display:inline-block;min-width:80px;} ' +
        '.sign{display:flex;justify-content:space-between;margin-top:64px;font-size:14px;} ' +
        '.sign div{text-align:center;} .sign .line{width:120px;border-top:1px solid #666;margin-top:28px;padding-top:6px;} ' +
        '@media print{body{margin:8mm;}}';
    }

    /** 编辑：出库→落地页编辑（保留照片等全字段），入库→入库模块内编辑 */
    function doEdit(id) {
      var r = State.list.find(function (x) { return x.id === id; });
      if (!r) return;
      if (r.type === "in") {
        window.App.Views.app.mount("in");
        window.App.Views.in.edit(id);
      } else {
        window.App.Views.landing.pendingEditId = id;
        Router.navigate("/");
      }
    }

    /** 删除：必填删除理由 → 本地删除 + 云端墓碑（其他设备同步后自动清除残留） */
    async function doDel(id) {
      var r = State.list.find(function (x) { return x.id === id; });
      if (!r) return;
      var affects = r.affectsStock === true;
      var res = await UI.promptDialog(
        affects ? "删除后库存会自动恢复。请填写删除理由：" : "请填写删除理由：",
        "例如：登记错误 / 重复登记 / 已撤销…",
        "删除记录",
        "确认删除"
      );
      if (!res.ok) return;
      // 先写本地墓碑队列：即使云端失败，也会在后续 sync 冲刷补推，避免记录复活
      if (Cloud.hasToken()) Cloud.enqueueTomb(id, res.value);
      Records.remove(id);
      renderList();
      Util.toast(affects ? "已删除，库存已自动恢复" : "已删除");
      if (Cloud.hasToken()) {
        try {
          await Cloud.delWithTombstone(r, res.value);
          Cloud.dequeueTomb(id);   // 云端墓碑+删除成功才出队
        } catch (e) {
          window.App.Views.app.setSyncStatus("云端删除失败（已存本地墓碑，下次同步自动补推）", true);
        }
      }
    }

    function doSync() {
      if (!Cloud.hasToken()) { Util.toast("未配置云端令牌，无法同步", true); return; }
      Util.toast("正在同步…");
      Cloud.syncPull({ onStatus: function (text, isErr) {
        window.App.Views.app.setSyncStatus(text, isErr);
      } }).then(function () { renderList(); });
    }

    return {
      render: render,
      refresh: refresh,
      filter: filter,
      doSync: doSync
    };
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.inRecords = createRecordsModule("in");
  window.App.Views.outRecords = createRecordsModule("out");
})();
