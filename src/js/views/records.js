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

    function render(el) {
      container = el;
      searchState = Store.loadSearch();
      el.innerHTML =
        '<div class="card">' +
          '<h2>' + title + ' <span class="badge" id="recCount">0 条</span></h2>' +
          '<div class="actions rec-actions">' +
            '<button type="button" class="btn ghost sm" id="recExport">&#11015; 导出 CSV</button>' +
            '<button type="button" class="btn ghost sm" id="recExportAcc">&#128202; 对账 CSV</button>' +
            '<button type="button" class="btn ghost sm" id="recSync">&#128260; 立即同步</button>' +
            '<button type="button" class="btn ghost sm" id="recRemind">&#128276; 提醒推送</button>' +
            '<button type="button" class="btn danger sm" id="recClearAll">清空全部记录</button>' +
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

      // 列表操作事件委托
      listBox.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-act]");
        if (!btn) return;
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
      return State.list.filter(function (r) {
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
      renderList();
      Util.toast("已标记为" + label);
      if (Cloud.hasToken()) {
        Cloud.push(rec).then(function () {
          window.App.Views.app.setSyncStatus("已同步", false);
        }).catch(function () {
          window.App.Views.app.setSyncStatus("云端同步失败", true);
        });
      }
    }

    function renderList() {
      var list = filter();
      Util.$("recCount").textContent = list.length + " 条";
      if (!list.length) {
        listBox.innerHTML = '<div class="empty">暂无记录，请先登记。</div>';
        return;
      }
      var html = '<div class="table-wrap"><table class="table"><thead><tr>' +
        '<th>序号</th><th>时间</th><th>' + (isIn ? "经办人" : "领取人") + '</th>' +
        (!isIn ? '<th>状态</th>' : '') +
        (!isIn ? '<th>结算法人单位</th>' : '') +
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
        html += '<tr data-act="detail" data-id="' + r.id + '">' +
          '<td><div>' + (list.length - i) + inMark + '</div></td>' +
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
          rows += '<div class="detail-row"><span class="k">结算法人单位</span><span class="v">' + Util.esc(r.entity) + '</span></div>';
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
          });
        });
      }
    }

    function showPhoto(src) {
      UI.Modal.show("照片预览", '<img class="preview-img" src="' + src + '" alt="" />', { width: "fit-content" });
    }

    /** 打印单据：新窗口排版该记录并触发打印（含标题/字段/货品/签名栏） */
    function doPrint(id) {
      var r = State.list.find(function (x) { return x.id === id; });
      if (!r) return;
      var isRecIn = r.type === "in";
      var kindLabel = isRecIn ? "入库单" : "出库单";
      var itemsHtml = (r.items || []).map(function (it) {
        return '<tr><td>' + Util.esc(it.name) + '</td><td class="c">' + it.qty + '</td>' +
          '<td class="c">' + Stock.getRecordStock(it.name, r, it) + '</td></tr>';
      }).join("");
      var statusLabel = isRecIn ? "" : (Records.getStatus(r) === "pending" ? "未提单" : "已提单");
      var win = window.open("", "_blank", "width=640,height=800");
      if (!win) { Util.toast("浏览器拦截了打印窗口，请允许弹窗", true); return; }
      win.document.write(
        '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">' +
        '<title>' + kindLabel + ' - ' + Util.esc(r.id) + '</title>' +
        '<style>' +
          'body{font-family:"Microsoft YaHei",sans-serif;color:#222;margin:32px;} ' +
          'h1{font-size:22px;text-align:center;letter-spacing:2px;margin:0 0 4px;} ' +
          '.sub{text-align:center;color:#888;font-size:12px;margin-bottom:24px;} ' +
          'table{width:100%;border-collapse:collapse;margin:16px 0;} ' +
          'th,td{border:1px solid #999;padding:8px 10px;font-size:14px;} ' +
          'th{background:#f5f5f5;} .c{text-align:center;} ' +
          '.field{font-size:14px;line-height:2;} .field b{display:inline-block;min-width:80px;} ' +
          '.sign{display:flex;justify-content:space-between;margin-top:64px;font-size:14px;} ' +
          '.sign div{text-align:center;} .sign .line{width:120px;border-top:1px solid #666;margin-top:28px;padding-top:6px;} ' +
          '@media print{body{margin:8mm;}}' +
        '</style></head><body>' +
        '<h1>出入库登记 · ' + kindLabel + '</h1>' +
        '<div class="sub">单号：' + Util.esc(r.orderNo || r.id) + '　|　时间：' + Util.esc(String(r.time || "").replace("T", " ")) + '</div>' +
        '<div class="field">' +
          '<b>' + (isRecIn ? "经办人" : "领取人") + '：</b>' + Util.esc(r.picker || "-") + '<br>' +
          (isRecIn ? '' : '<b>部门/客户：</b>' + Util.esc(r.dept || "-") + '<br>') +
          (isRecIn ? '' : (r.entity ? '<b>结算法人单位：</b>' + Util.esc(r.entity) + '<br>' : '')) +
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
        '<script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>' +
        '</body></html>'
      );
      win.document.close();
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
      Records.remove(id);
      renderList();
      Util.toast(affects ? "已删除，库存已自动恢复" : "已删除");
      if (Cloud.hasToken()) {
        try { await Cloud.delWithTombstone(r, res.value); } catch (e) {
          window.App.Views.app.setSyncStatus("云端删除失败（已存本地墓碑待同步）", true);
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
