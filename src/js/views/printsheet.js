/**
 * printsheet.js — 打印库存表（A4 横向，2026-10-24 新增，主理人需求）
 *
 * 需求原话提炼：
 *   在「库存查询」旁边加一个打印页面，点一下就出可打印的 A4 表格，字要看得清。
 *   表格 5 列：货品名称 / 现场库存数量 / 仓库封锁数量 / 全部库存 / 备注。
 *   现场 = 仪表盘「现场可用」（Zones.summary().site）
 *   仓库封锁 = 仪表盘「仓库锁定」（Zones.summary().warehouse）
 *   全部 = 库存查询里的实际库存（Zones.summary().total，与 Stock.getStock 同口径）
 *   备注 = 未完成的记录单（待取货 / 未提单出库）+ 先借后还未还 + 冻结合计
 *
 * 实现要点（为什么这么写）：
 *   1) 预览与打印用同一份 HTML：把整份 A4 文档写进 iframe，预览所见即打印所得，
 *      不会出现「屏幕上好看、打出来跑版」的两套样式。打印直接调 iframe.contentWindow.print()，
 *      不新开窗口 → 不会被浏览器弹窗拦截。
 *   2) 文档自带 @page A4 landscape + 10mm 页边距，表头每页重复（table-header-group），
 *      行不跨页断开（page-break-inside: avoid），激光黑白打印也清楚（边框 1px 实线）。
 *   3) 只读：不写任何数据、不改库存，纯汇总展示。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Config = window.App.Config;

  var container = null;
  var sortMode = "total_desc";     // total_desc 全部库存降序 | catalog 目录顺序
  var BLANK_ROWS = 8;              // 末尾留白行，供现场手写补充

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

  /** 2026-10-24 14:30 */
  function stampText() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  /** 标题跟随当前仓：深圳细胞 → 「深圳细胞时空仓库存情况」；赛迪斯 → 「赛迪斯仓库存情况」 */
  function titleText() {
    var name = "深圳细胞", isSd = false;
    try {
      if (Config.Sys && Config.Sys.name) name = Config.Sys.name() || name;
      if (Config.Sys && Config.Sys.isSaidis) isSd = Config.Sys.isSaidis() === true;
    } catch (e) {}
    return name + (isSd ? "仓库存情况" : "时空仓库存情况");
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

  /** 汇总数据行（只读） */
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
    if (sortMode === "catalog") {
      out.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), "zh"); });
    } else {
      out.sort(function (a, b) { return (b.total - a.total) || String(a.name).localeCompare(String(b.name), "zh"); });
    }
    return out;
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
    'table.tbl { width: 100%; border-collapse: collapse; table-layout: fixed; }',
    'table.tbl thead { display: table-header-group; }',
    'table.tbl th, table.tbl td { border: 1px solid #333; padding: 1.5mm 2mm; font-size: 10pt; line-height: 1.35; }',
    'table.tbl th { background: #e7edef; font-weight: 700; text-align: center; }',
    'table.tbl td.num { text-align: right; font-variant-numeric: tabular-nums; }',
    'table.tbl td.nm { text-align: left; word-break: break-word; }',
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

  function docHtml(rs) {
    var sumSite = 0, sumWh = 0, sumTotal = 0;
    rs.forEach(function (r) { sumSite += r.site; sumWh += r.wh; sumTotal += r.total; });

    var body = rs.map(function (r) {
      return '<tr>' +
        '<td class="nm">' + Util.esc(r.name) + '</td>' +
        cell(r.site, 'num') +
        cell(r.wh, 'num') +
        cell(r.total, 'num') +
        '<td class="nt">' + (r.note ? Util.esc(r.note) : '—') + '</td>' +
        '</tr>';
    }).join("");

    var blanks = "";
    for (var i = 0; i < BLANK_ROWS; i++) {
      blanks += '<tr class="blank"><td class="nm"></td><td></td><td></td><td></td><td></td></tr>';
    }

    var sumRow = '<tr class="sum">' +
      '<td class="nm">合计（' + rs.length + ' 项）</td>' +
      cell(sumSite, 'num') + cell(sumWh, 'num') + cell(sumTotal, 'num') +
      '<td class="nt">现场 + 仓库 = 全部库存</td>' +
      '</tr>';

    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>' + Util.esc(titleText()) + '</title>' +
      '<style>' + DOC_CSS + '</style></head><body>' +
      '<div class="wrap"><div class="paper">' +
        '<h1 class="ttl">' + Util.esc(titleText()) + '</h1>' +
        '<div class="meta">' +
          '<span>制表时间：' + stampText() + '</span>' +
          '<span>货品数：' + rs.length + ' 项</span>' +
          '<span>数量单位：件</span>' +
        '</div>' +
        '<table class="tbl">' +
          '<colgroup><col style="width:29%"><col style="width:14%"><col style="width:15%">' +
          '<col style="width:14%"><col style="width:28%"></colgroup>' +
          '<thead><tr>' +
            '<th>货品名称</th><th>现场库存数量</th><th>仓库封锁数量</th><th>全部库存</th><th>备注</th>' +
          '</tr></thead>' +
          '<tbody>' + body + sumRow + blanks + '</tbody>' +
        '</table>' +
        '<div class="sign">' +
          '<span>制表人：____________</span>' +
          '<span>核对人：____________</span>' +
          '<span>日期：______年____月____日</span>' +
        '</div>' +
        '<div class="foot">现场库存＝仪表盘「现场可用」（已扣在途出库与先借未还）；仓库封锁＝仓库锁定；全部库存＝库存查询实际库存。末尾空行供现场手写补充。</div>' +
      '</div></div>' +
      '</body></html>';
  }

  /* ================= 页面 ================= */

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="card">' +
        '<h2>打印库存表 <span class="tag">A4 横向</span></h2>' +
        '<div class="tool-row" style="margin:-4px 0 12px">' +
          '<span class="tool-row-lead">打印</span>' +
          '<button type="button" class="btn sm" id="psPrintBtn">🖨 立即打印</button>' +
          '<button type="button" class="btn ghost sm" id="psNewTabBtn">↗ 新窗口打开</button>' +
          '<select id="psSort" style="margin-left:6px;width:auto;max-width:220px;flex:0 0 auto">' +
            '<option value="total_desc">按全部库存从多到少</option>' +
            '<option value="catalog">按货品名称顺序</option>' +
          '</select>' +
          '<span class="tool-spacer"></span>' +
          '<span class="hint">纸张选 <b>A4 横向</b> · 缩放 100% · 勾选「背景图形」边框更清楚</span>' +
        '</div>' +
        '<div class="hint" style="margin:0 0 10px">💡 下面是打印预览（所见即打印所得）：现场库存数量取仪表盘「现场可用」，仓库封锁数量取「仓库锁定」，全部库存取库存查询的实际库存；备注列出待取货、未提单出库、先借未还与冻结合计。</div>' +
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
    var pb = Util.$("psPrintBtn");
    if (pb) pb.addEventListener("click", doPrint);
    var nb = Util.$("psNewTabBtn");
    if (nb) nb.addEventListener("click", openNewTab);

    paint();
  }

  /** 把整份文档写进 iframe（预览 = 打印稿） */
  function paint() {
    if (!container) return;
    var ifr = Util.$("psIfr");
    if (!ifr) return;
    var html = docHtml(rows());
    try {
      var d = ifr.contentDocument || (ifr.contentWindow && ifr.contentWindow.document);
      if (!d) return;
      d.open(); d.write(html); d.close();
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
    var html = docHtml(rows());
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
