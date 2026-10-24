/**
 * printsheet.js — 打印库存表（A4 横向，2026-10-24 新增，主理人需求）
 *
 * 两套模板（顶部切换，打印样式完全一致）：
 *   模板 A「本仓」：一张表只看当前仓 —— 货品名称 / 现场库存数量 + 实地盘点数 /
 *                  仓库封锁数量 + 实地盘点数 / 全部库存 + 实地盘点数 / 备注
 *   模板 B「双仓合并」：一张表同时看深圳细胞 + 赛迪斯 —— 现场各自一列，
 *                  仓库两仓各一列 + 合计列，末尾给盘点留空（盘点时两仓一起盘）
 *                  数字来自两仓各自算好的跨仓快照（见 data/zones.js 的 saveCrossSnapshot），
 *                  口径与各自仪表盘完全一致；本机没打开过另一仓时会在页面明确提示。
 *
 * 口径（两套模板都一样，不改任何库存逻辑）：
 *   现场库存数量 = 仪表盘「现场可用」Zones.summary().site
 *   仓库封锁数量 = 仪表盘「仓库锁定」Zones.summary().warehouse
 *   全部库存     = 库存查询实际库存 Zones.summary().total
 *   备注         = Freeze.detail() 汇总：待取货 / 未提单出库 / 先借未还 + 冻结合计 + 异常提示
 *
 * 实现要点：
 *   1) 预览与打印用同一份 HTML（写进 iframe，contentWindow.print() 直接打印），
 *      不新开窗口 → 不会被弹窗拦截；另有「新窗口打开」备用。
 *   2) 文档自带 @page A4 landscape + 10mm 边距，表头每页重复，行不跨页断开，
 *      末尾留空行供现场手写补充。
 *   3) 只读：不写任何业务数据、不改库存。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Config = window.App.Config;

  var container = null;
  /* 排序：默认 catalog = 库存查询页的排列（Config.PRODUCTS 目录原序），主理人 2026-10-24 定；
     total_desc = 全部库存从多到少（备用）。 */
  var sortMode = "catalog";
  /* 模板：single 本仓一张表（默认） | dual 双仓合并盘点表 */
  var tpl = "single";

  function Zones() { return window.App.Zones; }
  function Freeze() { return window.App.Freeze; }
  function Stock() { return window.App.Stock; }

  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }

  /** 千分位（负数保留负号） */
  function fmtNum(v) {
    var n = Math.round(num(v));
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function pad2(v) { return (v < 10 ? "0" : "") + v; }

  function stampText(ts) {
    var d = ts ? new Date(ts) : new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function sysName(id) {
    if (id === "saidis") return "赛迪斯";
    if (id === "shenzhen") return "深圳细胞";
    return "";
  }

  function curSys() {
    try { return Config.Sys.current() || { id: "shenzhen", name: "深圳细胞" }; }
    catch (e) { return { id: "shenzhen", name: "深圳细胞" }; }
  }

  function otherSysId() { return curSys().id === "saidis" ? "shenzhen" : "saidis"; }

  /** 标题（模板 A）：深圳细胞 → 「深圳细胞时空仓库存情况」；赛迪斯 → 「赛迪斯仓库存情况」 */
  function titleText() {
    var name = "深圳细胞", isSd = false;
    try {
      if (Config.Sys && Config.Sys.name) name = Config.Sys.name() || name;
      if (Config.Sys && Config.Sys.isSaidis) isSd = Config.Sys.isSaidis() === true;
    } catch (e) {}
    return name + (isSd ? "仓库存情况" : "时空仓库存情况");
  }

  /** 模板 B 标题：当前仓 + 另一仓 */
  function dualTitleText() {
    var a = sysName(curSys().id) || "本仓";
    var b = sysName(otherSysId());
    return a + " + " + b + " 双仓库存盘点表";
  }

  /** 备注：未完成记录单（待取货 / 未提单出库）+ 先借后还未还 + 冻结合计 + 异常提示 */
  function noteOf(s) {
    var F = Freeze();
    var det = (F && F.detail) ? (F.detail(s.name) || []) : [];
    var pk = 0, un = 0, bw = 0;
    det.forEach(function (d) {
      var q = num(d && d.qty);
      if (!q) return;
      if (d.src === "pickup") pk += q;            // 已提单未出库（货还在现场）
      else if (d.borrowed === true) bw += q;      // 先借后还：剩余未还量
      else un += q;                               // 已出库未提单
    });
    var frozen = pk + un + bw;

    var seg = [];
    if (pk) seg.push("待取货 " + pk + " 件");
    if (un) seg.push("未提单出库 " + un + " 件");
    if (bw) seg.push("先借未还 " + bw + " 件");

    var tail = [];
    if (frozen) tail.push("冻结 " + frozen + " 件");
    if (num(s.site) < 0) tail.push("现场为负待平账");
    else if (s.low) tail.push("低于预警线 " + num(s.warnAt));

    var text = seg.join(" · ");
    if (tail.length) text += (text ? " ｜ " : "") + tail.join(" · ");
    return text;
  }

  /** 本仓汇总数据行（只读） */
  function rows() {
    var Z = Zones();
    var list;
    if (Z && Z.summary) {
      list = Z.summary();
    } else {
      /* 兜底：分区模块没加载时，退化为「全部=现场」，保证打印页不白屏 */
      var S = Stock();
      list = (S ? S.summarize() : []).map(function (r) {
        return { name: r.name, total: r.stock, warehouse: 0, site: r.stock, low: false, warnAt: 0 };
      });
    }
    var out = list.map(function (s) {
      return {
        name: String(s.name || ""),
        site: num(s.site),
        wh: num(s.warehouse),
        total: num(s.total != null ? s.total : s.site),
        note: noteOf(s)
      };
    });
    /* catalog：保持 Zones.summary() 返回顺序 —— 它即 Config.PRODUCTS 目录顺序，
       与「库存查询」表格完全一致（主理人 2026-10-24 要求：打印顺序照库存查询来）。 */
    if (sortMode === "total_desc") {
      out.sort(function (a, b) { return (b.total - a.total) || String(a.name).localeCompare(String(b.name), "zh"); });
    }
    return out;
  }

  /** 模板 B：两仓合并数据。本仓行序照库存查询；另一仓独有的货品补在末尾。 */
  function dualData() {
    var Z = Zones();
    var mine = rows();
    var oId = otherSysId();
    var snap = (Z && Z.crossSnapshot) ? Z.crossSnapshot() : {};
    var o = snap[oId];
    var oItems = (o && o.items) || {};

    var out = [];
    var seen = {};
    mine.forEach(function (r) {
      seen[r.name] = 1;
      var x = oItems[r.name];
      out.push({
        name: r.name,
        siteA: r.site, whA: r.wh, totalA: r.total,
        siteB: x ? num(x.site) : null,
        whB: x ? num(x.wh) : null,
        totalB: x ? num(x.total) : null,
        note: r.note
      });
    });
    Object.keys(oItems).forEach(function (n) {
      if (!n || seen[n]) return;
      out.push({
        name: n, siteA: null, whA: null, totalA: null,
        siteB: num(oItems[n].site), whB: num(oItems[n].wh), totalB: num(oItems[n].total), note: ""
      });
    });

    return {
      rows: out,
      otherId: oId,
      otherName: sysName(oId),
      otherTs: o ? num(o.ts) : 0,
      hasOther: !!(o && o.items),
      myName: sysName(curSys().id)
    };
  }

  /* ================= 整份 A4 文档 ================= */

  var DOC_CSS = [
    '@page { size: A4 landscape; margin: 10mm; }',
    '* { box-sizing: border-box; }',
    'html, body { margin: 0; padding: 0; }',
    'body { background: #eef1f0; color: #111;',
    '  font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", sans-serif;',
    '  -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
    '.wrap { padding: 8mm 6mm; }',
    '.paper { width: 100%; max-width: 277mm; margin: 0 auto; background: #fff;',
    '  box-shadow: 0 2px 10px rgba(0,0,0,.12); padding: 8mm 8mm 9mm; }',
    '.ttl { margin: 0 0 3mm; text-align: center; font-size: 17pt; font-weight: 700; letter-spacing: 1px; }',
    '.meta { display: flex; justify-content: space-between; gap: 6mm; margin: 0 0 2.5mm;',
    '  font-size: 9pt; color: #333; }',
    '.meta .warn { color: #b3261e; font-weight: 700; }',
    'table.tbl { width: 100%; border-collapse: collapse; table-layout: fixed; }',
    'table.tbl thead { display: table-header-group; }',
    'table.tbl th, table.tbl td { border: 1px solid #333; padding: 1.5mm 2mm; font-size: 10pt; line-height: 1.35; }',
    'table.tbl th { background: #e7edef; font-weight: 700; text-align: center; }',
    'table.tbl th.grp { font-size: 9.5pt; }',
    'table.tbl th.sub { font-size: 9pt; font-weight: 600; background: #eef2f3; }',
    'table.tbl td.num { text-align: right; font-variant-numeric: tabular-nums; }',
    'table.tbl td.na { text-align: right; color: #999; }',
    'table.tbl td.nm { text-align: left; word-break: break-word; }',
    '/* 货品名称列左右边距收窄（主理人 2026-10-24），把宽度让给右侧盘点列 */',
    'table.tbl th:first-child, table.tbl td:first-child { padding-left: 0.8mm; padding-right: 1mm; }',
    '/* 实地盘点数 = 现场手写列，留白不填 */',
    'table.tbl td.chk { text-align: right; }',
    'table.tbl td.nt { text-align: left; font-size: 8.5pt; color: #222; }',
    'table.tbl tr { page-break-inside: avoid; }',
    'table.tbl tr.sum td { background: #f2f5f4; font-weight: 700; }',
    'table.tbl tr.blank td { height: 7.5mm; }',
    '.neg { color: #b3261e; font-weight: 700; }',
    '.sign { margin-top: 5mm; display: flex; justify-content: space-between; font-size: 9.5pt; color: #333; }',
    '.foot { margin-top: 3mm; font-size: 8.5pt; color: #666; text-align: right; }',
    '@media print {',
    '  body { background: #fff; }',
    '  .wrap { padding: 0; }',
    '  .paper { width: auto; max-width: none; margin: 0; padding: 0; box-shadow: none; }',
    '}'
  ].join('\n');

  function cell(v, cls) {
    var n = num(v);
    var body = fmtNum(n);
    if (n < 0) body = '<span class="neg">' + body + '</span>';
    return '<td class="' + cls + '">' + body + '</td>';
  }

  /** 另一仓缺该货品时打「—」，不冒充 0 */
  function cellOrDash(v) {
    return (v === null || v === undefined) ? '<td class="na">—</td>' : cell(v, 'num');
  }

  var CHK = '<td class="chk">&nbsp;</td>';

  function blanks(n, cols) {
    var s = "";
    for (var i = 0; i < n; i++) {
      s += '<tr class="blank"><td class="nm"></td>';
      for (var c = 1; c < cols; c++) s += '<td></td>';
      s += '</tr>';
    }
    return s;
  }

  function buildDoc(o) {
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>' + Util.esc(o.title) + '</title>' +
      '<style>' + DOC_CSS + '</style></head><body>' +
      '<div class="wrap"><div class="paper">' +
        '<h1 class="ttl">' + Util.esc(o.title) + '</h1>' +
        '<div class="meta">' + o.meta + '</div>' +
        '<table class="tbl">' + o.colgroup +
          '<thead>' + o.thead + '</thead>' +
          '<tbody>' + o.body + '</tbody>' +
        '</table>' +
        '<div class="sign">' +
          '<span>制表人：____________</span>' +
          '<span>核对人：____________</span>' +
          '<span>日期：______年____月____日</span>' +
        '</div>' +
        '<div class="foot">' + o.foot + '</div>' +
      '</div></div>' +
      '</body></html>';
  }

  /* ---------- 模板 A：本仓一张表（8 列，盘点列在每个数量列右侧） ---------- */

  function docSingle(rs) {
    var sumSite = 0, sumWh = 0, sumTotal = 0;
    rs.forEach(function (r) { sumSite += r.site; sumWh += r.wh; sumTotal += r.total; });

    var body = rs.map(function (r) {
      return '<tr>' +
        '<td class="nm">' + Util.esc(r.name) + '</td>' +
        cell(r.site, 'num') + CHK +
        cell(r.wh, 'num') + CHK +
        cell(r.total, 'num') + CHK +
        '<td class="nt">' + (r.note ? Util.esc(r.note) : '—') + '</td>' +
        '</tr>';
    }).join("");

    var sumRow = '<tr class="sum">' +
      '<td class="nm">合计（' + rs.length + ' 项）</td>' +
      cell(sumSite, 'num') + CHK +
      cell(sumWh, 'num') + CHK +
      cell(sumTotal, 'num') + CHK +
      '<td class="nt">现场 + 仓库 = 全部库存</td>' +
      '</tr>';

    return buildDoc({
      title: titleText(),
      meta: '<span>制表时间：' + stampText() + '</span>' +
            '<span>货品数：' + rs.length + ' 项</span>' +
            '<span>数量单位：件</span>',
      colgroup: '<colgroup><col style="width:22%"><col style="width:11%"><col style="width:8.5%">' +
                '<col style="width:11%"><col style="width:8.5%"><col style="width:10%">' +
                '<col style="width:8.5%"><col style="width:20.5%"></colgroup>',
      thead: '<tr>' +
        '<th>货品名称</th>' +
        '<th>现场库存数量</th><th>实地<br>盘点数</th>' +
        '<th>仓库封锁数量</th><th>实地<br>盘点数</th>' +
        '<th>全部库存</th><th>实地<br>盘点数</th>' +
        '<th>备注</th>' +
      '</tr>',
      body: body + sumRow + blanks(8, 8),
      foot: '现场库存＝仪表盘「现场可用」（已扣在途出库与先借未还）；仓库封锁＝仓库锁定；' +
            '全部库存＝库存查询实际库存。三个「实地盘点数」留空，供现场手写对照。末尾空行供补充。'
    });
  }

  /* ---------- 模板 B：双仓合并盘点表（11 列 + 两级表头） ---------- */

  function docDual(d) {
    var rs = d.rows;
    var sSA = 0, sSB = 0, sWA = 0, sWB = 0, sTA = 0, sTB = 0;

    var body = rs.map(function (r) {
      var whSum = (r.whA === null && r.whB === null) ? null : num(r.whA) + num(r.whB);
      var totSum = (r.totalA === null && r.totalB === null) ? null : num(r.totalA) + num(r.totalB);
      sSA += num(r.siteA); sSB += num(r.siteB);
      sWA += num(r.whA); sWB += num(r.whB);
      sTA += num(r.totalA); sTB += num(r.totalB);
      return '<tr>' +
        '<td class="nm">' + Util.esc(r.name) + '</td>' +
        cellOrDash(r.siteA) + cellOrDash(r.siteB) + CHK +
        cellOrDash(r.whA) + cellOrDash(r.whB) +
        (whSum === null ? '<td class="na">—</td>' : cell(whSum, 'num')) + CHK +
        (totSum === null ? '<td class="na">—</td>' : cell(totSum, 'num')) + CHK +
        '<td class="nt">' + (r.note ? Util.esc(r.note) : '—') + '</td>' +
        '</tr>';
    }).join("");

    var sumRow = '<tr class="sum">' +
      '<td class="nm">合计（' + rs.length + ' 项）</td>' +
      cell(sSA, 'num') + cell(sSB, 'num') + CHK +
      cell(sWA, 'num') + cell(sWB, 'num') + cell(sWA + sWB, 'num') + CHK +
      cell(sTA + sTB, 'num') + CHK +
      '<td class="nt">两仓相加</td>' +
      '</tr>';

    var A = Util.esc(d.myName || "本仓");
    var B = Util.esc(d.otherName || "另一仓");
    var meta = '<span>制表时间：' + stampText() + '</span>' +
               '<span>货品数：' + rs.length + ' 项</span>' +
               (d.hasOther
                 ? '<span>' + B + '数据更新：' + stampText(d.otherTs) + '</span>'
                 : '<span class="warn">⚠ 本机暂无' + B + '数据，请先打开一次' + B + '系统再回来打印</span>');

    return buildDoc({
      title: dualTitleText(),
      meta: meta,
      colgroup: '<colgroup><col style="width:15%">' +
                '<col style="width:8%"><col style="width:8%"><col style="width:7%">' +
                '<col style="width:8%"><col style="width:8%"><col style="width:8%"><col style="width:7%">' +
                '<col style="width:9%"><col style="width:7%"><col style="width:15%"></colgroup>',
      thead: '<tr>' +
          '<th class="grp" rowspan="2">货品名称</th>' +
          '<th class="grp" colspan="3">现场库存数量</th>' +
          '<th class="grp" colspan="4">仓库封锁数量</th>' +
          '<th class="grp" colspan="2">全部库存</th>' +
          '<th class="grp" rowspan="2">备注</th>' +
        '</tr><tr>' +
          '<th class="sub">' + A + '</th><th class="sub">' + B + '</th><th class="sub">盘点数</th>' +
          '<th class="sub">' + A + '</th><th class="sub">' + B + '</th><th class="sub">合计</th><th class="sub">盘点数</th>' +
          '<th class="sub">合计</th><th class="sub">盘点数</th>' +
        '</tr>',
      body: body + sumRow + blanks(6, 11),
      foot: '现场库存＝各仓仪表盘「现场可用」；仓库封锁＝各仓「仓库锁定」，合计＝两仓相加；' +
            '全部库存合计＝两仓实际库存之和。三个「盘点数」留空，供两仓一起盘点时手写。' +
            (d.hasOther ? '' : ' ⚠ 另一仓数字缺失，请先在该设备打开一次对应系统。')
    });
  }

  /* ================= 页面 ================= */

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="card">' +
        '<h2>打印库存表 <span class="tag">A4 横向</span></h2>' +
        '<div class="tool-row" style="margin:-4px 0 8px">' +
          '<span class="tool-row-lead">模板</span>' +
          '<button type="button" class="btn sm" id="psTplA" data-tpl="single">A · 本仓一张表</button>' +
          '<button type="button" class="btn ghost sm" id="psTplB" data-tpl="dual">B · 双仓合并盘点</button>' +
          '<select id="psSort" style="margin-left:6px;width:auto;max-width:220px;flex:0 0 auto">' +
            '<option value="catalog">按库存查询顺序（默认）</option>' +
            '<option value="total_desc">按全部库存从多到少</option>' +
          '</select>' +
          '<span class="tool-spacer"></span>' +
          '<button type="button" class="btn sm" id="psPrintBtn">🖨 立即打印</button>' +
          '<button type="button" class="btn ghost sm" id="psNewTabBtn">↗ 新窗口打开</button>' +
        '</div>' +
        '<div class="hint" style="margin:0 0 8px">纸张选 <b>A4 横向</b> · 缩放 100% · 勾选「背景图形」边框更清楚</div>' +
        '<div id="psTip" class="hint" style="margin:0 0 10px"></div>' +
        '<iframe id="psIfr" title="打印预览" style="width:100%;height:calc(100vh - 300px);min-height:560px;' +
          'border:1px solid #d7ded9;border-radius:10px;background:#eef1f0;display:block"></iframe>' +
      '</div>';

    var sort = Util.$("psSort");
    if (sort) {
      sort.value = sortMode;
      sort.addEventListener("change", function () {
        sortMode = sort.value;
        paint();
      });
    }
    Array.prototype.forEach.call(el.querySelectorAll("[data-tpl]"), function (b) {
      b.addEventListener("click", function () {
        tpl = b.getAttribute("data-tpl");
        paint();
      });
    });
    var pb = Util.$("psPrintBtn");
    if (pb) pb.addEventListener("click", doPrint);
    var nb = Util.$("psNewTabBtn");
    if (nb) nb.addEventListener("click", openNewTab);

    paint();
  }

  /** 当前模板对应的整份文档 HTML */
  function currentDoc() {
    if (tpl === "dual") return docDual(dualData());
    return docSingle(rows());
  }

  /** 把整份文档写进 iframe（预览 = 打印稿），并同步按钮态 / 顶部提示 */
  function paint() {
    if (!container) return;

    var ba = Util.$("psTplA"), bb = Util.$("psTplB");
    if (ba && bb) {
      ba.className = "btn sm" + (tpl === "single" ? "" : " ghost");
      bb.className = "btn sm" + (tpl === "dual" ? "" : " ghost");
    }

    var tip = Util.$("psTip");
    if (tip) {
      if (tpl === "dual") {
        var d = dualData();
        tip.innerHTML = d.hasOther
          ? '💡 双仓合并表：现场各自一列，仓库两仓各一列 + 合计；' + Util.esc(d.otherName) +
            '数据更新于 <b>' + stampText(d.otherTs) + '</b>（取自本机最近一次打开' + Util.esc(d.otherName) + '系统时的快照）。盘点数三列留空，两仓一起盘时手写。'
          : '⚠️ 本机还没有 <b>' + Util.esc(d.otherName) + '</b> 的库存快照：请先用这台设备打开一次' + Util.esc(d.otherName) + '系统（任意页面停留一下），再回到这里。当前表格里' + Util.esc(d.otherName) + '一列会显示「—」。';
      } else {
        tip.innerHTML = '💡 本仓表：顺序与「库存查询」一致；现场取仪表盘「现场可用」，仓库取「仓库锁定」，全部取库存查询实际库存；每个数量列右侧的「实地盘点数」留空给现场手写；备注列出待取货、未提单出库、先借未还与冻结合计。';
      }
    }

    var ifr = Util.$("psIfr");
    if (!ifr) return;
    try {
      var doc = ifr.contentDocument || (ifr.contentWindow && ifr.contentWindow.document);
      if (!doc) return;
      doc.open(); doc.write(currentDoc()); doc.close();
    } catch (e) {
      console.warn("[printsheet] 预览写入失败", e);
    }
  }

  function doPrint() {
    var ifr = Util.$("psIfr");
    if (!ifr || !ifr.contentWindow) { Util.toast("打印预览未就绪，先刷新一下", true); return; }
    try {
      ifr.contentWindow.focus();
      ifr.contentWindow.print();
    } catch (e) {
      Util.toast("当前环境不支持直接打印，请点「新窗口打开」后按 Ctrl+P", true);
    }
  }

  /** 备用通道：新标签页打开同一份文档（个别浏览器 iframe 打印会丢样式） */
  function openNewTab() {
    var html = currentDoc();
    var w = null;
    try { w = window.open("", "_blank"); } catch (e) { w = null; }
    if (!w || !w.document) { Util.toast("浏览器拦截了新窗口，请允许弹窗后重试，或直接点「立即打印」", true); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  /** 云端同步 / 库存变动后重画预览 */
  function refresh() {
    if (container && Util.$("psIfr")) paint();
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.printsheet = { render: render, refresh: refresh };
})();
