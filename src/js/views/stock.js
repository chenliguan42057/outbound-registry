/**
 * stock.js — 库存查询模块：全货品库存表格 + 搜索 + 低库存（<95）高亮
 * 第六轮增量：新增「全部库存排名」卡片（全量展示 + 4 种排序 + 低库存红色高亮），
 *             与现有搜索表格完全解耦（renderTable / renderRank 互不干扰）。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Config = window.App.Config;
  var Stock = window.App.Stock;
  var State = window.App.State;
  var Records = window.App.Records;
  var Cloud = window.App.Cloud;

  var container = null;
  var tableBox = null;
  var rankBox = null;
  var q = "";

  /* 排名排序模式（默认库存多→少；不持久化，页面重进回到默认） */
  var rankMode = "stock_desc";

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="card">' +
        '<h2>库存查询 <span class="tag">实时计算</span></h2>' +
        '<div id="stockLowBanner" style="display:none"></div>' +
        '<div class="field">' +
          '<input type="text" id="stockSearch" class="search" placeholder="搜索货品名称…" autocomplete="off" />' +
        '</div>' +
        '<div class="actions" style="margin:-6px 0 14px">' +
          '<button type="button" class="btn sm" id="stockAddBtn">＋ 新增货品</button>' +
          '<button type="button" class="btn ghost sm" id="stockCatalogBtn">📋 货品目录</button>' +
          '<button type="button" class="btn ghost sm" id="stockTakeBtn">📊 盘点平账</button>' +
        '</div>' +
        '<div class="stock-summary" id="stockSummary"></div>' +
        '<div id="stockTableBox"></div>' +
        '<div class="hint" style="margin-top:10px">💡 点行内 <b>📊 流水</b> 按钮，或<b>双击</b>该行，可查看该货品完整出入库流水并导出 CSV。</div>' +
      '</div>' +
      '<div class="card">' +
        '<h2>全部库存排名 <span class="tag">全量</span></h2>' +
        '<div class="rank-sort">' +
          '<label>排序：</label>' +
          '<select id="rankSort">' + sortOptionsHtml() + '</select>' +
        '</div>' +
        '<div id="rankBox"></div>' +
      '</div>';
    tableBox = Util.$("stockTableBox");
    rankBox = Util.$("rankBox");
    var search = Util.$("stockSearch");
    search.addEventListener("input", function () {
      q = search.value.trim().toLowerCase();
      renderTable();
    });
    var sort = Util.$("rankSort");
    sort.addEventListener("change", function () {
      rankMode = sort.value;
      renderRank();
    });
    Util.$("stockCatalogBtn").addEventListener("click", function () {
      if (window.App.Catalog && window.App.Catalog.openManager) window.App.Catalog.openManager();
      else Util.toast("目录模块未加载", true);
    });
    Util.$("stockTakeBtn").addEventListener("click", openStocktake);
    Util.$("stockAddBtn").addEventListener("click", openQuickAdd);
    wireHistory();
    renderTable();
    renderRank();
  }

  /** 云端同步后刷新（仅重建表格与排名，不重置搜索框；保留当前排序状态） */
  function refresh() {
    if (tableBox) renderTable();
    if (rankBox) renderRank();
  }

  /** 名称截断（超长加省略号，避免顶出 SVG 画布） */
  function truncate(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  /** 单个货品独立预警线（2026-08-14）：用户在目录管理里设的 warnAt；缺省时回退全局 LOW_STOCK_THRESHOLD */
  function getWarnAt(name) {
    var w = Number((Config.WARN_AT || {})[name]);
    return (!isNaN(w) && w >= 0) ? w : Config.LOW_STOCK_THRESHOLD;
  }

  function renderTable() {
    if (!tableBox) return;
    var summary = Stock.summarize();
    var rows = summary.filter(function (s) { return q === "" || s.name.toLowerCase().includes(q); });
    var lowCount = summary.filter(function (s) { return s.stock < getWarnAt(s.name); }).length;
    Util.$("stockSummary").innerHTML =
      '<span class="badge">货品总数 ' + summary.length + '</span> ' +
      '<span class="badge low">低库存 ' + lowCount + ' 项</span>';
    // 低库存醒目 banner：每个货品显示「剩余/预警线」，不再用统一阈值
    var banner = Util.$("stockLowBanner");
    if (banner) {
      var lowItems = summary.filter(function (s) { return s.stock < getWarnAt(s.name); })
        .map(function (s) { return Util.esc(s.name) + "(剩" + s.stock + "/预警" + getWarnAt(s.name) + ")"; });
      if (lowItems.length) {
        banner.style.display = "block";
        banner.innerHTML = '<div class="stock-low-banner" style="margin:0 0 12px;padding:10px 14px;border:1px solid #f5c6c0;border-radius:10px;background:#fff1f0;color:#a8071a;font-size:13.5px;line-height:1.7">' +
          '⚠️ <b>低库存预警：</b>' + lowItems.join("、") +
          '</div>';
      } else {
        banner.style.display = "none";
      }
    }
    if (!rows.length) {
      tableBox.innerHTML = '<div class="empty">未找到匹配货品</div>';
      return;
    }
    var html = '<div class="table-wrap"><table class="table stock-table"><thead><tr>' +
      '<th>货品名称</th><th>当前库存</th><th>累计入库</th><th>累计出库</th><th>状态</th><th></th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (s) {
      var low = s.stock < getWarnAt(s.name);
      html += '<tr class="' + (low ? "low-stock" : "") + '" data-name="' + Util.esc(s.name) + '" title="双击或点📊查看出入库流水" style="cursor:pointer">' +
        '<td>' + Util.esc(s.name) + '</td>' +
        '<td class="stock-num" data-name="' + Util.esc(s.name) + '">' + s.stock + '</td>' +
        '<td>' + s.inQty + '</td>' +
        '<td>' + s.outQty + '</td>' +
        '<td>' + (low ? '<span class="tag danger-tag">低库存</span>' : '<span class="tag ok-tag">正常</span>') + '</td>' +
        '<td><button type="button" class="btn ghost sm flow-btn" data-name="' + Util.esc(s.name) + '">📊 流水</button></td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    tableBox.innerHTML = html;
  }

  /* ================= 全部库存排名（第六轮增量） ================= */

  /** 排序下拉 HTML（选项来自 Config.RANK_SORT_OPTIONS，当前 rankMode 选中） */
  function sortOptionsHtml() {
    return (Config.RANK_SORT_OPTIONS || []).map(function (o) {
      return '<option value="' + Util.esc(o.value) + '"' + (o.value === rankMode ? " selected" : "") + '>' +
        Util.esc(o.label) + '</option>';
    }).join("");
  }

  /** 名称排序：localeCompare("zh-Hans-CN")，异常回落码点比较（决策 D-4） */
  function compareName(x, y) {
    try {
      return x.localeCompare(y, "zh-Hans-CN");
    } catch (e) {
      return x < y ? -1 : (x > y ? 1 : 0);
    }
  }

  /** 按当前 rankMode 比较两个汇总项 */
  function rankCompare(a, b) {
    if (rankMode === "stock_asc") return a.stock - b.stock;
    if (rankMode === "name_asc") return compareName(a.name, b.name);
    if (rankMode === "name_desc") return compareName(b.name, a.name);
    return b.stock - a.stock;   // stock_desc（默认）
  }

  /** 全量排名渲染：排名/货品名称/当前库存/状态；低库存行红色高亮 + tag */
  function renderRank() {
    if (!rankBox) return;
    var summary = Stock.summarize();
    if (!summary.length) {
      rankBox.innerHTML = '<div class="empty">暂无数据</div>';
      return;
    }
    var arr = summary.slice().sort(rankCompare);
    var html = '<div class="table-wrap"><table class="table stock-table rank-table"><thead><tr>' +
      '<th>排名</th><th>货品名称</th><th>当前库存</th><th>状态</th><th></th>' +
      '</tr></thead><tbody>';
    arr.forEach(function (s, i) {
      var low = s.stock < getWarnAt(s.name);
      html += '<tr class="' + (low ? "low-stock" : "") + '" data-name="' + Util.esc(s.name) + '" title="双击或点📊查看出入库流水" style="cursor:pointer">' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + Util.esc(s.name) + '</td>' +
        '<td class="stock-num' + (low ? " danger-text" : "") + '" data-name="' + Util.esc(s.name) + '">' + s.stock + '</td>' +
        '<td>' + (low ? '<span class="tag danger-tag">低库存</span>' : '<span class="tag ok-tag">正常</span>') + '</td>' +
        '<td><button type="button" class="btn ghost sm flow-btn" data-name="' + Util.esc(s.name) + '">📊 流水</button></td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    rankBox.innerHTML = html;
  }

  /* ================= B3 库存流水追溯 ================= */
  function wireHistory() {
    if (!container || container.getAttribute("data-his")) return;
    container.setAttribute("data-his", "1");
    // ① 点「📊 流水」按钮 → 弹窗（手机/电脑通用，主入口）
    container.addEventListener("click", function (e) {
      var btn = e.target.closest(".flow-btn");
      if (btn && btn.getAttribute("data-name")) {
        e.stopPropagation();
        showHistory(btn.getAttribute("data-name"));
        return;
      }
      // ② 点「当前库存」数字 → 弹窗（兼容旧习惯）
      var el = e.target.closest(".stock-num");
      if (el && el.getAttribute("data-name")) showHistory(el.getAttribute("data-name"));
    });
    // ③ 双击整行 → 弹窗（桌面端快捷操作；触屏无 dblclick，走按钮）
    container.addEventListener("dblclick", function (e) {
      var tr = e.target.closest("tr[data-name]");
      if (!tr) return;
      showHistory(tr.getAttribute("data-name"));
    });
  }

  /** 过滤出与指定货品相关的所有出入记录（按 NAME_MAP 归一化） */
  function rowsForProduct(name) {
    var nm = (window.App.Config.NAME_MAP && window.App.Config.NAME_MAP[name]) || name;
    return (State.list || []).filter(function (r) {
      return (r.items || []).some(function (it) {
        var n = (window.App.Config.NAME_MAP && window.App.Config.NAME_MAP[it.name]) || it.name;
        return n === nm;
      });
    });
  }

  /** 在记录的 items 里找到与指定货品名（已归一化）匹配的那一项 */
  function findItemFor(rows, name) {
    var nm = (window.App.Config.NAME_MAP && window.App.Config.NAME_MAP[name]) || name;
    for (var i = 0; i < rows.length; i++) {
      var items = (rows[i].items || []);
      for (var j = 0; j < items.length; j++) {
        var n = (window.App.Config.NAME_MAP && window.App.Config.NAME_MAP[items[j].name]) || items[j].name;
        if (n === nm) return { record: rows[i], item: items[j] };
      }
    }
    return { record: null, item: null };
  }

  /** 把货品的所有出入库记录导出为 CSV 并触发下载（UTF-8 BOM 兼容 Excel） */
  function exportProductCSV(name) {
    var rows = rowsForProduct(name);
    if (!rows.length) { Util.toast("该货品暂无出入记录，无法导出", true); return; }
    var esc = Util.esc;
    var headers = ["时间", "类型", "部门/客户", "领取人", "货品名称", "数量", "当时库存", "备注"];
    var lines = [headers.map(esc).join(",")];
    rows.forEach(function (r) {
      var info = findItemFor([r], name);
      var it = info.item;
      if (!it) return;
      var isIn = (r.type || "out") === "in";
      var stockCell = it ? String(Stock.getRecordStock(name, r, it)) : "";
      var row = [
        esc(String(r.time || "").replace("T", " ")),
        esc(isIn ? "入库" : "出库"),
        esc(r.dept || ""),
        esc(r.picker || ""),
        esc(it.name || ""),
        esc(String(it.qty || "")),
        esc(stockCell),
        esc(r.note || "")
      ];
      lines.push(row.join(","));
    });
    var csv = "\ufeff" + lines.join("\r\n");   // BOM 防 Excel 乱码，CRLF 兼容
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name.replace(/[\\/:*?"<>|]/g, "_") + "_出入库流水_" +
      (new Date().toISOString().slice(0, 10)) + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  function showHistory(name) {
    var rows = rowsForProduct(name);
    if (!rows.length) { Util.toast("该货品暂无出入记录", true); return; }
    var html = '<div class="table-wrap" style="max-height:50vh;overflow:auto">' +
      '<table class="table" style="min-width:0;width:100%"><thead><tr>' +
      '<th>时间</th><th>类型</th><th>部门/领取人</th><th>数量</th><th>当时库存</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        var info = findItemFor([r], name);
        var it = info.item;
        var isIn = (r.type || "out") === "in";
        // P1 修复：流水"当时库存"必须按当前事件实时推算，不能再用 it.stock 死快照——
        // 死快照与 INVENTORY 基准、事件归一化、affectsStock 修正后的口径都不一致，
        // 会显示 134+14≠165 这种"对不上"的怪现象。
        var stock = Stock.getRecordStock(name, r, it);
        return '<tr>' +
          '<td>' + Util.esc(String(r.time || "").replace("T", " ")) + '</td>' +
          '<td>' + (isIn ? '<span class="tag ok-tag">入库</span>' : '<span class="tag danger-tag">出库</span>') + '</td>' +
          '<td>' + Util.esc((r.dept || "") + (r.picker ? "（" + r.picker + "）" : "")) + '</td>' +
          '<td>' + (isIn ? "+" : "-") + (it ? it.qty : "") + '</td>' +
          '<td>' + stock + '</td>' +
        '</tr>';
      }).join("") +
      '</tbody></table></div>' +
      '<div class="hint">「当时库存」为该笔完成后的快照；当前库存 ' + Util.esc(String(window.App.Stock.getStock(name))) + '</div>';
    UI.Modal.show("📦 库存流水 · " + Util.esc(name),
      '<div class="modal-actions" style="margin:-6px 0 12px;justify-content:flex-end">' +
        '<button type="button" class="btn ghost sm" data-act="export">📥 导出 CSV</button>' +
      '</div>' + html,
      { width: "640px" });
    var mBody = UI.Modal.body();
    var exp = mBody.querySelector('[data-act="export"]');
    if (exp) exp.addEventListener("click", function () { exportProductCSV(name); });
  }

  /* ================= B2 库存盘点平账 ================= */
  function openStocktake() {
    var summary = Stock.summarize();
    if (!summary.length) { Util.toast("暂无货品可盘点", true); return; }
    var rows = summary.map(function (s, i) {
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed var(--line-soft,#DCE6E0)">' +
        '<span style="flex:1;font-size:13.5px">' + Util.esc(s.name) + '</span>' +
        '<span class="hint" style="margin:0;flex:0 0 74px;text-align:right">当前 ' + s.stock + '</span>' +
        '<input type="number" step="any" min="0" value="' + s.stock + '" data-i="' + i + '" class="st-in" style="width:92px;padding:8px 10px;border:1px solid var(--input-line,#C6DAD1);border-radius:10px;background:var(--input-bg,#FBFCFA)" />' +
      '</div>';
    }).join("");
    var body =
      '<div class="hint" style="margin-bottom:10px">盘点模式：把「实存数」改成实际清点数量，保存后直接校准库存基准到实存数（不生成出入库记录、不进金山台账）。</div>' +
      '<div style="max-height:46vh;overflow:auto">' + rows + '</div>' +
      '<div class="modal-actions" style="margin-top:14px">' +
      '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
      '<button type="button" class="btn sm" id="stSave">保存盘点</button>' +
      '</div>';
    UI.Modal.show("📊 库存盘点平账", body, { width: "580px" });
    var mBody = UI.Modal.body();
    mBody.querySelector('[data-act="cancel"]').addEventListener("click", function () { UI.Modal.hide(); });
    mBody.querySelector("#stSave").addEventListener("click", async function () {
      var diffs = [];
      summary.forEach(function (s, i) {
        var inp = mBody.querySelector('.st-in[data-i="' + i + '"]');
        var actual = inp ? (Number(inp.value) || 0) : s.stock;
        var diff = actual - s.stock;
        if (diff !== 0) diffs.push({ name: s.name, diff: diff });
      });
      if (!diffs.length) { Util.toast("盘点数与当前库存一致，无需调整"); UI.Modal.hide(); return; }
      var inSum = 0, outSum = 0;
      diffs.forEach(function (d) { if (d.diff > 0) inSum += d.diff; else outSum -= d.diff; });
      // P1 改进：盘点改为「校准库存基准」，不再生成出入库记录。
      // 旧逻辑生成 affectsStock=true 的调整记录：系统多一笔流水、金山又没有 → 每次盘点后系统就偏离金山一笔。
      // 直接改 catalog.inventory 基准则：1) 不产生流水记录，流水干净；2) 不进金山，金山不变，两边长期一致；
      // 3) 系统库存 = 用户输入的实存数。
      var ok = await UI.confirmDialog(
        "差异汇总：实存比账面多 +" + inSum + "、少 -" + outSum + "。\n将直接校准库存基准到实存数（不生成出入库记录、不进金山台账）。确认执行？", "盘点校准确认");
      if (!ok) { UI.Modal.hide(); return; }
      var Catalog = window.App.Catalog;
      var cat = Catalog && Catalog.get();
      if (!cat || !cat.inventory) { Util.toast("目录未就绪，无法校准", true); return; }
      diffs.forEach(function (d) {
        var base = Number(cat.inventory[d.name]) || 0;
        cat.inventory[d.name] = base + d.diff;
      });
      if (window.App.Stock) window.App.Stock.markDirty();
      Catalog.save(cat, function (okSave, msg) {
        UI.Modal.hide();
        if (okSave) {
          Util.toast("盘点校准完成：库存基准已更新为实存数");
          refresh();
          try { if (window.App.Views.dashboard && window.App.Views.dashboard.refresh) window.App.Views.dashboard.refresh(); } catch (e) {}
          try { if (window.App.Views.records && window.App.Views.records.refresh) window.App.Views.records.refresh(); } catch (e) {}
        } else {
          Util.toast("目录保存失败：" + (msg || ""), true);
        }
      });
    });
  }

  /* ================= ＋ 新增货品（2026-08-14） =================
     在库存查询页提供「+ 新增货品」按钮 → 弹窗填名称/单位/初始库存/预警线/单价/条码
     → Catalog.quickAdd() 写入云端 catalog.json → 全站生效 → 钉钉推送"新货品已添加"通知。
     与 Catalog.openManager 全功能编辑（增删改）并存：openManager 给管理员维护用，
     本弹窗只做"快速新增一条"，覆盖高频轻量场景。 */
  function openQuickAdd() {
    var body =
      '<div class="hint" style="margin-bottom:10px">新增货品并设置初始库存；保存后立即在出库登记、落地页登记表、库存表中可见，并推送钉钉群通知。</div>' +
      '<div class="field"><label for="qaName">货品名称<span class="req">*</span></label>' +
      '<input type="text" id="qaName" maxlength="60" autocomplete="off" placeholder="例：神仙水 150ml" /></div>' +
      '<div class="grid2">' +
        '<div class="field"><label for="qaUnit">单位</label>' +
        '<input type="text" id="qaUnit" maxlength="10" placeholder="盒/支/瓶/箱" autocomplete="off" /></div>' +
        '<div class="field"><label for="qaStock">初始库存<span class="req">*</span></label>' +
        '<input type="number" id="qaStock" min="0" step="any" value="0" inputmode="decimal" /></div>' +
      '</div>' +
      '<div class="grid2">' +
        '<div class="field"><label for="qaWarn">预警线（低于即标红）</label>' +
        '<input type="number" id="qaWarn" min="0" step="any" value="' + Config.LOW_STOCK_THRESHOLD + '" inputmode="decimal" /></div>' +
        '<div class="field"><label for="qaPrice">单价（元，可选）</label>' +
        '<input type="number" id="qaPrice" min="0" step="0.01" value="0" inputmode="decimal" /></div>' +
      '</div>' +
      '<div class="field"><label for="qaBarcode">条码（可选）</label>' +
      '<input type="text" id="qaBarcode" maxlength="40" autocomplete="off" /></div>' +
      '<div class="modal-actions" style="margin-top:14px">' +
        '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
        '<button type="button" class="btn sm" id="qaSave">保存并通知钉钉</button>' +
      '</div>';
    UI.Modal.show("＋ 新增货品", body, { width: "560px" });
    var mBody = UI.Modal.body();
    mBody.querySelector('[data-act="cancel"]').addEventListener('click', function () { UI.Modal.hide(); });
    setTimeout(function () { try { mBody.querySelector('#qaName').focus(); } catch (e) {} }, 50);

    // Enter 在 qaSave 之外触发表单提交（点 qaSave 同理）
    var saveBtn = mBody.querySelector('#qaSave');
    saveBtn.addEventListener('click', async function () {
      var btn = saveBtn;
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      btn.disabled = true;
      try {
        var name = (mBody.querySelector('#qaName').value || '').trim();
        var unit = (mBody.querySelector('#qaUnit').value || '').trim();
        var stock = Number(mBody.querySelector('#qaStock').value) || 0;
        var warn = Number(mBody.querySelector('#qaWarn').value) || Config.LOW_STOCK_THRESHOLD;
        var price = Number(mBody.querySelector('#qaPrice').value) || 0;
        var barcode = (mBody.querySelector('#qaBarcode').value || '').trim();

        if (!name) { Util.toast('请填写货品名称', true); try { mBody.querySelector('#qaName').focus(); } catch (e) {} return; }
        if ((Config.PRODUCTS || []).indexOf(name) !== -1) { Util.toast('该货品已存在，请改用其他名称', true); try { mBody.querySelector('#qaName').focus(); } catch (e) {} return; }

        var ok = await UI.confirmDialog(
          '新增货品「' + Util.esc(name) + '」（初始库存 ' + stock + ' ' + (unit || '件') + '），保存后立即全站生效并推送钉钉通知。确认？',
          '确认新增');
        if (!ok) return;
        UI.Modal.hide();

        if (!window.App.Catalog || !window.App.Catalog.quickAdd) {
          Util.toast('目录模块未加载，无法新增', true); return;
        }
        var result = await window.App.Catalog.quickAdd({
          name: name, unit: unit, stock: stock,
          warnAt: warn, price: price, barcode: barcode
        });
        if (!result.ok) { Util.toast(result.msg || '保存失败', true); return; }

        Util.toast(result.msg || ('已添加「' + name + '」'));
        refresh();
        try { if (window.App.Views.dashboard && window.App.Views.dashboard.refresh) window.App.Views.dashboard.refresh(); } catch (e) {}
        try { if (window.App.Views.report && window.App.Views.report.refresh) window.App.Views.report.refresh(); } catch (e) {}
      } finally {
        btn.dataset.busy = '0';
        btn.disabled = false;
      }
    });
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.stock = { render: render, refresh: refresh };
})();
