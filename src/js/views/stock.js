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
  var Freeze = window.App.Freeze;   /* 待取货冻结库存（只读虚拟口径，见 data/freeze.js） */
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
        '<div class="tool-row" style="margin:-6px 0 12px">' +
          '<span class="tool-row-lead">货品管理</span>' +
          '<button type="button" class="btn sm" id="stockAddBtn">＋ 新增货品</button>' +
          '<button type="button" class="btn ghost sm" id="stockCatalogBtn">📋 货品目录</button>' +
          '<button type="button" class="btn ghost sm" id="stockTakeBtn">📊 盘点平账</button>' +
          '<span class="tool-spacer"></span>' +
          '<button type="button" class="btn ghost sm" id="stockDelBtn" style="color:#c0392b">🗑 删除货品</button>' +
        '</div>' +
        '<div class="stat-cards" id="stockSummary"></div>' +
        '<div id="stockFreezeBox"></div>' +
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
    Util.$("stockDelBtn").addEventListener("click", openDelProductList);
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
    /* 统计数字卡（第 12 轮）：小胶囊 → 大号数字 + 说明，一眼看清规模 */
    var totalIn = summary.reduce(function (a, s) { return a + (Number(s.inQty) || 0); }, 0);
    var totalOut = summary.reduce(function (a, s) { return a + (Number(s.outQty) || 0); }, 0);
    Util.$("stockSummary").innerHTML =
      '<div class="stat-card">' +
        '<span class="stat-num">' + summary.length + '</span>' +
        '<span class="stat-label">在册货品</span>' +
        '<span class="stat-hint">当前系统收录的货品数</span>' +
      '</div>' +
      '<div class="stat-card ' + (lowCount ? "warn" : "ok") + '">' +
        '<span class="stat-num">' + lowCount + '</span>' +
        '<span class="stat-label">低库存</span>' +
        '<span class="stat-hint">' + (lowCount ? "低于各自预警线，需要补货" : "全部货品都在预警线以上") + '</span>' +
      '</div>' +
      '<div class="stat-card">' +
        '<span class="stat-num">' + totalIn + '</span>' +
        '<span class="stat-label">累计入库</span>' +
        '<span class="stat-hint">历史入库件数合计</span>' +
      '</div>' +
      '<div class="stat-card">' +
        '<span class="stat-num">' + totalOut + '</span>' +
        '<span class="stat-label">累计出库</span>' +
        '<span class="stat-hint">历史出库件数合计</span>' +
      '</div>';
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
    renderFreezeBox();
    if (!rows.length) {
      tableBox.innerHTML = '<div class="empty"><b>没找到匹配的货品</b><i>换个关键词，或点上方「＋ 新增货品」</i></div>';
      return;
    }
    var html = '<div class="table-wrap"><table class="table stock-table freeze-table"><thead><tr>' +
      /* 1090px 窗口下 8 列要放得下：累入/累出用简写（完整名放 title），状态文案也压到 2-3 字 */
      '<th class="hd-name">货品名称</th><th class="num">实际库存</th><th class="num">冻结占用</th><th class="num">可用库存</th>' +
      '<th class="num" title="累计入库">累入</th><th class="num" title="累计出库">累出</th><th>状态</th><th></th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (s) {
      var warn = getWarnAt(s.name);
      var frozen = Freeze.of(s.name);
      var avail = s.stock - frozen;
      var low = s.stock < warn;
      var over = avail < 0;                       /* 超预占：被提单占得比库存还多 */
      var tight = !low && !over && avail < warn;  /* 预占后偏低：实际够用，扣完就紧张 */
      var st = freezeStateCell(low, over, tight);
      html += '<tr class="' + (over ? "freeze-over" : (low ? "low-stock" : (frozen ? "freeze-row" : ""))) + '" data-name="' + Util.esc(s.name) + '" title="双击或点📊查看出入库流水" style="cursor:pointer">' +
        '<td>' + Util.esc(s.name) + '</td>' +
        '<td class="stock-num num num-strong" data-name="' + Util.esc(s.name) + '">' + '<span class="stock-num-txt">' + s.stock + '</span></td>' +
        '<td class="num fx-freeze' + (frozen ? " has-fx" : "") + '" data-name="' + Util.esc(s.name) + '" title="点一下看是哪几单待取货占用">' + (frozen ? '<span class="fx-neg">−' + frozen + '</span>' : '<span class="fx-none">—</span>') + '</td>' +
        '<td class="num num-strong fx-avail' + (over ? " fx-bad" : (tight ? " fx-tight" : (avail < warn ? " fx-low" : " fx-ok"))) + '">' + avail + '</td>' +
        "<td class=\"num\">" + s.inQty + "</td>" +
        "<td class=\"num\">" + s.outQty + "</td>" +
        '<td>' + st + '</td>' +
        '<td><button type="button" class="btn ghost sm flow-btn" data-name="' + Util.esc(s.name) + '">📊 流水</button></td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    tableBox.innerHTML = html;
  }

  /** 状态徽章：超预占 > 低库存 > 预占后偏低 > 正常（短文案，完整说明见 title 与顶部提醒条） */
  function freezeStateCell(low, over, tight) {
    if (over) return '<span class="tag danger-tag" title="可用库存为负：提单占用已超过实际库存">超预占</span>';
    if (low) return '<span class="tag danger-tag" title="库存低于该货品预警线">低库存</span>';
    if (tight) return '<span class="tag warn-tag" title="实际库存够用，但扣掉待取货占用后低于预警线">偏低</span>';
    return '<span class="tag ok-tag">正常</span>';
  }

  /** 冻结总览：三张小卡 + 超预占红色提醒条（虚拟参考，明示以实际库存为准） */
  function renderFreezeBox() {
    var box = Util.$("stockFreezeBox");
    if (!box) return;
    var st = Freeze.stats();
    if (!st.docs || !st.kinds) { box.innerHTML = ""; return; }
    var overText = st.over.map(function (r) {
      return Util.esc(r.name) + "(库存" + r.stock + "/占" + r.frozen + "/可用" + r.avail + ")";
    }).join("、");
    var tightText = st.tight.map(function (r) {
      return Util.esc(r.name) + "(可用" + r.avail + "/预警" + r.warnAt + ")";
    }).join("、");
    box.innerHTML =
      '<div class="fx-strip">' +
        '<div class="stat-card fx-card">' +
          '<span class="stat-num fx-neg">' + st.total + '</span>' +
          '<span class="stat-label">冻结占用</span>' +
          '<span class="stat-hint">' + st.docs + ' 单待取货未出库</span>' +
        '</div>' +
        '<div class="stat-card fx-card">' +
          '<span class="stat-num">' + st.kinds + '</span>' +
          '<span class="stat-label">涉及货品</span>' +
          '<span class="stat-hint">这些货品被提前占住</span>' +
        '</div>' +
        '<div class="stat-card fx-card' + (st.over.length ? " warn" : " ok") + '">' +
          '<span class="stat-num">' + st.over.length + '</span>' +
          '<span class="stat-label">超预占</span>' +
          '<span class="stat-hint">' + (st.over.length ? "占用量已超过现有库存" : "没有被占超的货品") + '</span>' +
        '</div>' +
      '</div>' +
      (overText ? '<div class="stock-low-banner fx-banner fx-banner-over" style="margin:0 0 12px">❗ <b>超预占：</b>' + overText + '<i>可用库存已为负，建议催客户取货或先补这批货</i></div>' : '') +
      (tightText ? '<div class="stock-low-banner fx-banner fx-banner-tight" style="margin:0 0 12px">⚠️ <b>预占后偏低：</b>' + tightText + '<i>现在够发，但取走后就会低于预警线</i></div>' : '') +
      '<div class="hint fx-note">❄️ 「冻结占用」= 已提单但未出库的待取货数量，「可用库存」= 实际库存 − 冻结占用，仅为提前排产的<b>参考数</b>；真实库存始终以「实际库存」列为准，单据出库后自动恢复。</div>';
  }

  /** 点冻结数字 → 弹窗列出占用的单据明细 */
  function showFreezeDetail(name) {
    var rows = Freeze.detail(name);
    if (!rows.length) return;
    var stock = Stock.getStock(name);
    var avail = Freeze.available(name);
    var html = '<div class="fx-detail">' +
      '<div class="fx-detail-head">' +
        '<span>实际库存 <b>' + stock + '</b></span>' +
        '<span class="fx-neg">冻结 <b>−' + (Freeze.of(name)) + '</b></span>' +
        '<span class="' + (avail < 0 ? "fx-bad" : "fx-ok") + '">可用 <b>' + avail + '</b></span>' +
      '</div>' +
      '<table class="table" style="width:100%;min-width:0"><thead><tr>' +
        '<th>登记时间</th><th>取货人</th><th>部门/客户</th><th>占用量</th><th>提单</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' +
          '<td>' + Util.esc(fmtTs(r.ts)) + '</td>' +
          '<td>' + Util.esc(r.picker) + '</td>' +
          '<td>' + Util.esc(r.dept) + '</td>' +
          '<td class="num fx-neg">' + r.qty + '</td>' +
          '<td>' + (r.confirmed ? '<span class="tag ok-tag">已确认</span>' : '<span class="tag warn-tag">未确认</span>') + '</td>' +
        '</tr>';
      }).join("") +
      '</tbody></table>' +
      '<div class="hint">到「待取货」页点「确认出库」即可释放这部分冻结量。</div>' +
    '</div>';
    UI.Modal.show(Util.esc(name) + " 冻结明细", html, { width: "560px" });
  }

  /** 时间戳格式化（yyyy-MM-dd HH:mm） */
  function fmtTs(ts) {
    if (!ts) return "-";
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return "-";
    return Util.pad2(d.getFullYear()) + "-" + Util.pad2(d.getMonth() + 1) + "-" + Util.pad2(d.getDate()) +
      " " + Util.pad2(d.getHours()) + ":" + Util.pad2(d.getMinutes());
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
      rankBox.innerHTML = '<div class="empty"><b>还没有库存数据</b><i>先登记一笔入库，这里就会有排名</i></div>';
      return;
    }
    var arr = summary.slice().sort(rankCompare);
    var html = '<div class="table-wrap"><table class="table stock-table rank-table freeze-table"><thead><tr>' +
      '<th>排名</th><th class="hd-name">货品名称</th><th class="num">实际库存</th><th class="num">冻结占用</th><th class="num">可用库存</th><th>状态</th><th></th>' +
      '</tr></thead><tbody>';
    arr.forEach(function (s, i) {
      var warn = getWarnAt(s.name);
      var low = s.stock < warn;
      var frozen = Freeze.of(s.name);
      var avail = s.stock - frozen;
      html += '<tr class="' + (low ? "low-stock" : "") + '" data-name="' + Util.esc(s.name) + '" title="双击或点📊查看出入库流水" style="cursor:pointer">' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + Util.esc(s.name) + '</td>' +
        '<td class="stock-num num' + (low ? " danger-text" : "") + '" data-name="' + Util.esc(s.name) + '">' + '<span class="stock-num-txt">' + s.stock + '</span></td>' +
        '<td class="num fx-freeze' + (frozen ? " has-fx" : "") + '" data-name="' + Util.esc(s.name) + '" title="点一下看是哪几单待取货占用">' + (frozen ? '<span class="fx-neg">−' + frozen + '</span>' : '<span class="fx-none">—</span>') + '</td>' +
        '<td class="num num-strong fx-avail' + (avail < 0 ? " fx-bad" : (avail < warn && s.stock >= warn ? " fx-tight" : (avail < warn ? " fx-low" : " fx-ok"))) + '">' + avail + '</td>' +
        '<td>' + (avail < 0 ? '<span class="tag danger-tag" title="可用库存为负：提单占用已超过实际库存">超预占</span>' : (low ? '<span class="tag danger-tag" title="库存低于该货品预警线">低库存</span>' : (avail < warn ? '<span class="tag warn-tag" title="扣掉待取货占用后低于预警线">偏低</span>' : '<span class="tag ok-tag">正常</span>'))) + '</td>' +
        '<td><button type="button" class="btn ghost sm flow-btn fx-act" data-name="' + Util.esc(s.name) + '" title="查看出入库流水">📊 流水</button></td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    rankBox.innerHTML = html;
  }

  /* ================= 库存页行内删除货品（2026-09-05） =================
     删除 = 目录移除 + 库存归 0 + 钉钉通知 + 金山台账删列（若有列）。
     历史出入库记录仍保留在系统内可查；金山整列删除不可恢复，弹窗强提醒。 */
  function askDelProduct(name, cb, onStart) {
    if (!name) return;
    var g = (window.App.Catalog && window.App.Catalog.get) ? window.App.Catalog.get() : null;
    var p = null;
    if (g && Array.isArray(g.products)) {
      for (var i = 0; i < g.products.length; i++) {
        if (g.products[i].name === name) { p = g.products[i]; break; }
      }
    }
    var wps = null;
    try {
      if (p && p.wps && typeof p.wps.sheet === "string") wps = p.wps;
      else if (window.App.Catalog && window.App.Catalog.guessWps) wps = window.App.Catalog.guessWps(name);
    } catch (e) {}
    var extra = wps
      ? "\n\n⚠️ 该货品在金山台账子表【" + wps.sheet + "】登记着「" + wps.col + "」一列。删除后，金山文档上对应那一列（含该货品全部历史发放/库存记录）也会一并被删掉，且不可恢复！"
      : "";
    var msg = "确定删除货品「" + name + "」？\n\n删除后：\n· 系统库存目录移除、库存归 0，全站（出入库登记/库存/报表）不再可选该货品；\n· 钉钉群会收到删除通知；\n· 系统内已产生的出入库历史记录仍保留可查（不影响对账）。" + extra;
    if (!window.App.UI || !window.App.UI.confirmDialog) return;
    window.App.UI.confirmDialog(msg, "🗑 删除货品").then(function (ok) {
      if (!ok) return;
      // 2026-09-05：确认后才置忙（取消/点遮罩关闭都不会误锁），删除进行中防连点重复提交
      if (typeof onStart === "function") { try { onStart(); } catch (e) {} }
      if (!window.App.Catalog || !window.App.Catalog.removeProduct) { Util.toast("删除能力未就绪，请刷新页面", true); return; }
      window.App.Catalog.removeProduct(name, function (ok2, msg2) {
        Util.toast(msg2 || (ok2 ? "已删除" : "删除失败"), !ok2);
        if (ok2) {
          try { window.App.Stock && window.App.Stock.markDirty(); } catch (e2) {}
          refresh();
          try { if (window.App.Views.dashboard && window.App.Views.dashboard.refresh) window.App.Views.dashboard.refresh(); } catch (e3) {}
          try { if (window.App.Views.report && window.App.Views.report.refresh) window.App.Views.report.refresh(); } catch (e4) {}
        }
        if (cb) cb(ok2);
      });
    })["catch"](function () {});
  }

  /* ================= 工具栏「🗑 删除货品」（2026-09-05 改版） =================
     从每行一个小删除按钮，改为工具栏一个入口 → 弹窗列出全部货品 → 选中点删除 →
     走 askDelProduct 强确认（含金山整列删除不可恢复提醒）。删除成功后从弹窗列表移除该行。 */
  function openDelProductList() {
    var summary = Stock.summarize();
    if (!summary.length) { Util.toast("暂无货品可删除", true); return; }
    var rows = summary.map(function (s) {
      return '<div class="del-pick-row" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed var(--line-soft,#DCE6E0)">' +
        '<span style="flex:1;font-size:13.5px">' + Util.esc(s.name) + '</span>' +
        '<span class="hint" style="margin:0;flex:0 0 96px;text-align:right">当前 ' + s.stock + '</span>' +
        '<button type="button" class="btn ghost sm del-pick-btn" data-name="' + Util.esc(s.name) + '" style="color:#c0392b">🗑 删除</button>' +
      '</div>';
    }).join("");
    var body =
      '<div class="hint" style="margin-bottom:10px">选择要删除的货品：删除后系统目录移除、库存归 0、钉钉收到通知；若该货品在金山台账有列，那一列（含全部历史数据）也会一并删除且不可恢复（点删除后还会再确认一次）。</div>' +
      '<div style="max-height:46vh;overflow:auto">' + rows + '</div>' +
      '<div class="modal-actions" style="margin-top:14px">' +
        '<button type="button" class="btn ghost sm" data-act="close">关闭</button>' +
      '</div>';
    UI.Modal.show("🗑 删除货品", body, { width: "580px" });
    var mBody = UI.Modal.body();
    mBody.querySelector('[data-act="close"]').addEventListener("click", function () { UI.Modal.hide(); });
    // 修复（2026-09-05）：mBody 是 .modal-body 单例元素，Modal.show 每次只 innerHTML="" 但元素保留。
    // 若每次 openDelProductList 都 mBody.addEventListener("click", ...) 会叠加堆叠——同一点击触发多次
    // askDelProduct + 多次弹 confirmDialog。Modal 单实例下后调用者覆盖前者，前者 Promise 永不 resolve，
    // 用户感受「点击没反应，多次点击后才有一次真的删」。改为一次性绑定（mBody.dataset.delBound 标记）。
    if (!mBody.dataset.delBound) {
      mBody.dataset.delBound = "1";
      mBody.addEventListener("click", function (e) {
        var b = e.target.closest(".del-pick-btn");
        if (!b || !b.getAttribute("data-name")) return;
        if (b.dataset.busy === "1") return;   // 该行删除进行中，忽略重复点击
        var name = b.getAttribute("data-name");
        askDelProduct(name, function (ok2) {
          if (!ok2) {
            // 删除失败/未完成 → 恢复按钮可再点；成功则由下方移除行
            b.dataset.busy = "0";
            b.disabled = false;
            b.textContent = "🗑 删除";
            return;
          }
          var rowEl = b.closest(".del-pick-row");
          if (rowEl) rowEl.remove();
          var remain = mBody.querySelectorAll(".del-pick-row").length;
          if (!remain) {
            var wrap = mBody.querySelector("div[style*='max-height:46vh']");
            if (wrap) wrap.innerHTML = '<div class="empty"><b>货品已全部删除</b><i>点上方「＋ 新增货品」重新建立</i></div>';
          }
        }, function () {
          // 用户确认删除、云端保存进行中 → 锁住按钮防连点（弱网下不再叠出多个删除请求）
          b.dataset.busy = "1";
          b.disabled = true;
          b.textContent = "删除中…";
        });
      });
    }
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
      if (el && el.getAttribute("data-name")) { showHistory(el.getAttribute("data-name")); return; }
      // ③ 点「冻结占用」数字 → 弹出是哪几单待取货占用
      var fx = e.target.closest(".fx-freeze.has-fx");
      if (fx && fx.getAttribute("data-name")) { e.stopPropagation(); showFreezeDetail(fx.getAttribute("data-name")); }
    });
    // ③ 双击整行 → 弹窗（桌面端快捷操作；触屏无 dblclick，走按钮）
    container.addEventListener("dblclick", function (e) {
      var tr = e.target.closest("tr[data-name]");
      if (!tr) return;
      showHistory(tr.getAttribute("data-name"));
    });
  }

  /** 某货品的全部流水行：真实出入库记录（State.list）+ 盘点校准记录（State.stocktakes）。
      盘点记录独立存储（不进金山台账、不出现于出库/入库列表与报表统计），仅在库存流水弹窗展示。
      统一按时间降序（time 为 YYYY-MM-DDTHH:MM 字符串，字典序即时间序）；同刻按 _ts 降序。 */
  function rowsForProduct(name) {
    var nm = (window.App.Config.NAME_MAP && window.App.Config.NAME_MAP[name]) || name;
    function hit(r) {
      return (r.items || []).some(function (it) {
        var n = (window.App.Config.NAME_MAP && window.App.Config.NAME_MAP[it.name]) || it.name;
        return n === nm;
      });
    }
    var arr = (State.list || []).filter(hit)
      .concat((State.stocktakes || []).filter(hit));
    arr.sort(function (a, b) {
      var c = String(b.time || "").localeCompare(String(a.time || ""));
      if (c !== 0) return c;
      return (Number(b._ts) || 0) - (Number(a._ts) || 0);
    });
    return arr;
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
      // 盘点校准行：类型「盘点」，数量=差异，当时库存列显示 账面→实存
      if (r.kind === "stocktake") {
        var dd = Number(it.diff) || 0;
        var rowSt = [
          esc(String(r.time || "").replace("T", " ")),
          esc("盘点"),
          esc("盘点校准"),
          esc(""),
          esc(it.name || ""),
          esc((dd > 0 ? "+" : "") + String(dd)),
          esc(it.book + " → " + it.actual),
          esc("盘点校准")
        ];
        lines.push(rowSt.join(","));
        return;
      }
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
    // 未提单笔数（2026-09-13）：只统计出库记录，盘点/入库不计入
    var pendingCnt = rows.filter(function (r) {
      return r.kind !== "stocktake" && (r.type || "out") !== "in" && Records.getStatus(r) === "pending";
    }).length;
    var html = '<div class="table-wrap" style="max-height:50vh;overflow:auto">' +
      '<table class="table" style="min-width:0;width:100%"><thead><tr>' +
      '<th>时间</th><th>类型</th><th>提单</th><th>部门/领取人</th><th>数量</th><th>当时库存</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        var info = findItemFor([r], name);
        var it = info.item;
        var isIn = (r.type || "out") === "in";
        // 提单状态单元格：出库才有意义；未提单标红，一眼看出哪些单据还没完成
        var stCell = isIn
          ? '—'
          : (Records.getStatus(r) === "pending"
              ? '<span class="tag" style="background:#FFF0F0;color:#C0392B">未提单</span>'
              : '<span class="tag ok-tag">已提单</span>');
        // 盘点校准行：不进库存推算（affectsStock 无关），直接展示 账面→实存 与差异
        if (r.kind === "stocktake") {
          var d0 = it ? (Number(it.diff) || 0) : 0;
          return '<tr class="flow-row" data-kind="stocktake" title="盘点校准记录，没有登记详情页">' +
            '<td>' + Util.esc(String(r.time || "").replace("T", " ")) + '</td>' +
            '<td><span class="tag" style="background:#F0E7D2;color:#8a6d3b">盘点</span></td>' +
            '<td>—</td>' +
            '<td>盘点校准</td>' +
            '<td>' + (d0 > 0 ? "+" : "") + d0 + '</td>' +
            '<td>' + (it ? (it.book + " → " + it.actual) : "") + '</td>' +
          '</tr>';
        }
        // P1 修复：流水"当时库存"必须按当前事件实时推算，不能再用 it.stock 死快照——
        // 死快照与 INVENTORY 基准、事件归一化、affectsStock 修正后的口径都不一致，
        // 会显示 134+14≠165 这种"对不上"的怪现象。
        var stock = Stock.getRecordStock(name, r, it);
        return '<tr class="flow-row" data-id="' + Util.esc(r.id || "") + '" title="双击查看这笔的详细信息">' +
          '<td>' + Util.esc(String(r.time || "").replace("T", " ")) + '</td>' +
          '<td>' + (isIn ? '<span class="tag ok-tag">入库</span>' : '<span class="tag danger-tag">出库</span>') + '</td>' +
          '<td>' + stCell + '</td>' +
          '<td>' + Util.esc((r.dept || "") + (r.picker ? "（" + r.picker + "）" : "")) + '</td>' +
          '<td>' + (isIn ? "+" : "-") + (it ? it.qty : "") + '</td>' +
          '<td>' + stock + '</td>' +
        '</tr>';
      }).join("") +
      '</tbody></table></div>' +
      '<div class="hint">「当时库存」为该笔完成后的快照；当前库存 ' + Util.esc(String(window.App.Stock.getStock(name))) +
        (pendingCnt ? '　|　<span style="color:#C0392B">本货品有 ' + pendingCnt + ' 笔出库未完成提单</span>' : '') +
        '<br>💡 <b>双击任意一行</b>可就地展开这笔的详细信息（申请人、用途、货品明细、照片等）。' +
      '</div>';
    UI.Modal.show("📦 库存流水 · " + Util.esc(name),
      '<div class="modal-actions" style="margin:-6px 0 12px;justify-content:flex-end">' +
        '<button type="button" class="btn ghost sm" data-act="export">📥 导出 CSV</button>' +
      '</div>' + html,
      { width: "640px" });
    var mBody = UI.Modal.body();
    // 事件统一用委托挂在 .modal-body 上（这个元素本身不会被 innerHTML 替换，比绑子元素稳）
    mBody.addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-act="export"]') : null;
      if (b) exportProductCSV(name);
    });
    // 2026-09-24 第 13 轮：双击流水行 → 就地展开该笔的登记详情
    // （不用 UI.Modal.show 再开一层：Modal 是单例，会把流水列表整个换掉，体验割裂）
    mBody.addEventListener("dblclick", function (e) {
      var tr = e.target && e.target.closest ? e.target.closest("tr.flow-row") : null;
      if (!tr) return;
      if (!tr.parentNode) return;
      // 再次双击同一行 → 收起
      var next = tr.nextElementSibling;
      if (next && next.classList.contains("flow-detail")) {
        next.parentNode.removeChild(next);
        tr.classList.remove("flow-open");
        return;
      }
      // 收起其它已展开的行，保持一次只看一笔
      mBody.querySelectorAll("tr.flow-detail").forEach(function (n) { n.parentNode.removeChild(n); });
      mBody.querySelectorAll("tr.flow-row.flow-open").forEach(function (n) { n.classList.remove("flow-open"); });
      if (tr.getAttribute("data-kind") === "stocktake") {
        Util.toast("盘点校准记录没有登记详情页");
        return;
      }
      var id = tr.getAttribute("data-id");
      if (!id) return;
      var V = window.App.Views || {};
      var v = (V.outRecords && V.outRecords.detailHtml) ? V.outRecords
            : (V.inRecords && V.inRecords.detailHtml) ? V.inRecords : null;
      if (!v) { Util.toast("详情模块未加载", true); return; }
      var inner = v.detailHtml(id);
      if (!inner) { Util.toast("没找到这笔详情，可能已被删除", true); return; }
      var trDet = document.createElement("tr");
      trDet.className = "flow-detail";
      var td = document.createElement("td");
      td.colSpan = tr.children.length || 6;
      td.innerHTML = '<div class="flow-detail-box">' +
        '<div class="flow-detail-title">这笔的详细信息<span class="flow-detail-tip">再次双击本行可收起</span></div>' +
        inner +
      '</div>';
      trDet.appendChild(td);
      tr.parentNode.insertBefore(trDet, tr.nextSibling);
      tr.classList.add("flow-open");
      setTimeout(function () {
        try { trDet.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e2) {}
      }, 30);
    });
  }

  /* ================= B2 库存盘点平账 ================= */
  function openStocktake() {
    var summary = Stock.summarize();
    if (!summary.length) { Util.toast("暂无货品可盘点", true); return; }
    var rows = summary.map(function (s, i) {
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed var(--line-soft,#DCE6E0)">' +
        '<span style="flex:1;font-size:13.5px">' + Util.esc(s.name) + '</span>' +
        '<span class="hint" style="margin:0;flex:0 0 74px;text-align:right">当前 ' + s.stock + '</span>' +
        '<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" value="' + s.stock + '" data-i="' + i + '" class="st-in" style="width:92px;padding:8px 10px;border:1px solid var(--input-line,#C6DAD1);border-radius:10px;background:var(--input-bg,#FBFCFA)" />' +
      '</div>';
    }).join("");
    var body =
      '<div class="hint" style="margin-bottom:10px">盘点模式：把「实存数」改成实际清点数量。保存后<b>只记一条盘点差额</b>（盘盈 +N / 盘亏 -N）并入库存流水，<b>不改动库存基准，也不回溯修改已有出入库流水的「当时库存」</b>；差异同时推送钉钉群（不进金山台账）。</div>' +
      '<div style="max-height:46vh;overflow:auto">' + rows + '</div>' +
      '<div class="modal-actions" style="margin-top:14px">' +
      '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
      '<button type="button" class="btn sm" id="stSave">保存盘点</button>' +
      '</div>';
    UI.Modal.show("📊 库存盘点平账", body, { width: "580px" });
    var mBody = UI.Modal.body();
    mBody.querySelector('[data-act="cancel"]').addEventListener("click", function () { UI.Modal.hide(); });
    mBody.querySelector("#stSave").addEventListener("click", async function () {
      // 2026-09-05：防连点锁——保存/云同步期间再次点击会叠出并发 PUT（409 → “云端保存失败”）
      var stBtn = mBody.querySelector("#stSave");
      if (stBtn.dataset.busy === "1") return;
      stBtn.dataset.busy = "1";
      stBtn.disabled = true;
      try {
        var diffs = [];
        summary.forEach(function (s, i) {
          var inp = mBody.querySelector('.st-in[data-i="' + i + '"]');
          var actual = Math.round(inp ? (Number(inp.value) || 0) : s.stock);
          var diff = actual - s.stock;
          if (diff !== 0) diffs.push({ name: s.name, diff: diff, stock: s.stock });
        });
        if (!diffs.length) { Util.toast("盘点数与当前库存一致，无需调整"); UI.Modal.hide(); return; }
        var inSum = 0, outSum = 0;
        diffs.forEach(function (d) { if (d.diff > 0) inSum += d.diff; else outSum -= d.diff; });
        // 2026-09-13（主理人要求）盘点改为「事件化」：只写一条带 _ts 的盘点差额事件（data/stocktakes/），
        // 由 Stock 并入库存时间轴参与计算；不再改写 catalog.inventory 基准。
        // 原因：旧实现改基准 → 该货品全部历史流水的「当时库存」被整体平移（"一盘点全部库存都变了"）。
        // 现在：真实出入库流水的快照保持原样，盘点只在盘点那一刻加/减差额，库存随订单增删正常变化。
        var ok = await UI.confirmDialog(
          "差异汇总：实存比账面多 +" + inSum + "、少 -" + outSum + "。\n将记录一条盘点差额进库存流水（不改库存基准、不动已有流水的当时库存），同时推送钉钉群（不进金山台账）。确认执行？", "盘点确认");
        if (!ok) { UI.Modal.hide(); return; }
        // 2026-09-05：确认后立即收起盘点弹窗——云端保存在后台进行（15s 超时 + 3 次重试），
        // 弱网/移动端下用户不再看到“弹窗卡住 / 保存按钮点了没反应”，结果统一用 toast 呈现。
        UI.Modal.hide();
        // 盘点差额事件：book=盘点前的实时库存（账面）、actual=实存、diff=差额。
        // 不再取 catalog.inventory 基准，也不再写回 —— 库存基准保持不动。
        var affected = diffs.map(function (d) {
          return { name: d.name, book: d.stock, actual: d.stock + d.diff, diff: d.diff };
        });
        if (window.App.Stock) window.App.Stock.markDirty();
          Util.toast("盘点已记录：库存按实存数调整");
          var stkTime = Util.nowLocal ? Util.nowLocal() : new Date().toISOString();
          // 生成盘点差额事件 → 库存流水可见 + Stock 按 _ts 并入库存计算
          // （State.stocktakes + data/stocktakes/<id>.json，独立目录：不进金山台账、不触发登记推送）
          try {
            var stk = {
              id: Util.genId ? Util.genId() : ("stk" + Date.now()),
              _ts: Date.now(),
              time: stkTime,
              kind: "stocktake",
              warehouse: (window.App.Config && window.App.Config.Sys && window.App.Config.Sys.current().id) || "shenzhen",
              picker: "盘点校准",
              dept: "盘点校准",
              purpose: "盘点调整",
              note: "盘盈 +" + inSum + " / 盘亏 -" + outSum,
              _local: true,
              items: affected
            };
            if (State.stocktakes) {
              State.stocktakes.unshift(stk);
              try { if (window.App.Store.saveStocktakes) window.App.Store.saveStocktakes(State.stocktakes); } catch (e) {}
              if (Cloud && Cloud.pushStocktake) { Cloud.pushStocktake(stk); }
            }
          } catch (e) {}
          // 盘点差异推送钉钉：写 data/notify/stocktake-*.json 由 Actions「DingTalk Remind」消费。
          // 异步 fire-and-forget，推送失败静默，绝不影响盘点本身结果。
          try {
            if (Cloud && Cloud.pushNotifyFile) {
              Cloud.pushNotifyFile("stocktake", {
                type: "stocktake",
                time: stkTime,
                items: affected
              }).then(function () {
                Util.toast("盘点差异已推送钉钉群");
              }).catch(function () {});
            }
          } catch (e) {}
          refresh();
          try { if (window.App.Views.dashboard && window.App.Views.dashboard.refresh) window.App.Views.dashboard.refresh(); } catch (e) {}
          try { if (window.App.Views.records && window.App.Views.records.refresh) window.App.Views.records.refresh(); } catch (e) {}
      } finally {
        stBtn.dataset.busy = "0";
        stBtn.disabled = false;
      }
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
        '<input type="number" id="qaStock" min="0" step="1" value="0" inputmode="numeric" /></div>' +
      '</div>' +
      '<div class="grid2">' +
        '<div class="field"><label for="qaWarn">预警线（低于即标红）</label>' +
        '<input type="number" id="qaWarn" min="0" step="1" value="' + Config.LOW_STOCK_THRESHOLD + '" inputmode="numeric" /></div>' +
        // 修复（2026-09-05）：原价是 type="number" step="0.01" value="0"，按 spinner ▲ 一次只 +0.01，
        // 填 28 元得按 2800 次；且 min="0" 下 number input 清空会自动回弹，用户感受「按数字失灵」。
        // 改用 type="text" + inputmode="decimal"（移动端拉数字键盘；桌面用普通键盘键入，无原生 spinner 干扰）。
        '<div class="field"><label for="qaPrice">单价（元，可选）</label>' +
        '<input type="text" id="qaPrice" inputmode="decimal" pattern="[0-9.]*" maxlength="10" placeholder="0.00" autocomplete="off" /></div>' +
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
        var stock = Math.round(Number(mBody.querySelector('#qaStock').value) || 0);
        var warn = Math.round(Number(mBody.querySelector('#qaWarn').value) || Config.LOW_STOCK_THRESHOLD);
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
