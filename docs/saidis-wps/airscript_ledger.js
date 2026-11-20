/**
 * airscript_ledger.js — 出入库流水台账（金山文档共享脚本 · AirScript 2.0）
 *
 * 表结构（第 1 行表头）：
 *   A 日期时间 | B 订单号 | C 类型 | D 部门/客户 | E 货品明细 | F 剩余库存 | G 状态 | H 记录ID(隐藏)
 *
 * 一单占 N 行（N=货品数），每个货品一行、各自带自己的剩余库存；
 * A/B/C/D/G 纵向合并（单行时自动跳过合并）。
 *
 * 配色（2026-11-19 主理人要求：鲜亮淡色，一眼区分订单）：
 *   出库 / 待取货 → 5 色循环：淡蓝 / 淡绿 / 淡黄 / 淡粉 / 淡紫
 *   入库 / 调拨入 → 整行淡红 + 类型列「⬇ 入库」深红加粗
 *   先借后还借出 → 淡紫固定 + 类型「借出」
 *   差额单 / 调拨出 → 淡灰 + 类型「差额」「调拨出」
 *   已撤销       → 整行灰 + 状态「已撤销」
 *
 * 支持的 mode：
 *   init_ledger            建表头 + 列宽 + 冻结首行首列 + 隐藏记录ID列（一次性）
 *   append_ledger          追加一单（N+1 行 + 合并 + 配色）
 *   update_ledger          整块重写（编辑过、行数可能变）
 *   update_ledger_status   只改状态（审核 / 结清 / 撤销审核）
 *   revoke_ledger          标「已撤销」+ 整行灰（不删行）
 *   read_ledger            返回 {rid: row} 映射
 */

var LEDGER_HEADERS = ["日期时间", "订单号", "类型", "部门/客户", "货品明细", "剩余库存", "状态"];
var RID_COL = 8;          // H 列：记录ID 锚点（隐藏，勿删）
var TOTAL_SUFFIX = " 件";

/* ===== 字体与配色 =====
   Interior.Color 采用 Excel/VBA 的 RGB 次序：r + g*256 + b*65536 */
var LEDGER_FONT = "微软雅黑";
var FONT_HEAD = 12;
var FONT_BODY = 11;

var BG_HEAD = rgb(0x6E, 0x9C, 0x87);   // 表头：深薄荷（白字醒目，与库存表统一）
var FG_HEAD = rgb(0xFF, 0xFF, 0xFF);   // 表头白字
var FG_BODY = rgb(0x3C, 0x48, 0x45);   // 正文深灰

// 鲜亮淡色循环（出库 / 待取货）
var CYCLE = [
  rgb(0xE3, 0xF0, 0xFB),   // 淡蓝
  rgb(0xE4, 0xF7, 0xE9),   // 淡绿
  rgb(0xFD, 0xF6, 0xDC),   // 淡黄
  rgb(0xFB, 0xE8, 0xEC),   // 淡粉
  rgb(0xF0, 0xEA, 0xF9)    // 淡紫
];
var BG_IN = rgb(0xFF, 0xE0, 0xE0);      // 入库：整行淡红
var FG_IN = rgb(0xC0, 0x39, 0x2B);      // 入库类型列：深红字
var BG_BORROW = rgb(0xF0, 0xEA, 0xF9);  // 借出：淡紫
var BG_GRAY = rgb(0xEA, 0xEA, 0xEA);    // 差额 / 调拨 / 已撤销：淡灰

function rgb(r, g, b) {
  return r + g * 256 + b * 65536;
}

function colLetter(n) {
  var s = "";
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function toNum(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

function getCellValue(sh, col, row) {
  try {
    return sh.Range(colLetter(col) + row).Value2;
  } catch (e) {
    return null;
  }
}

function setCellValue(sh, col, row, val) {
  sh.Range(colLetter(col) + row).Value2 = val;
}

/** 整块样式：字体、字号、加粗、字色、底色、居中、换行 */
function styleBlock(sh, r1, r2, isHead, bg) {
  var ref = "A" + r1 + ":" + colLetter(RID_COL) + r2;
  try {
    var rg = sh.Range(ref);
    rg.Font.Name = LEDGER_FONT;
    rg.Font.Size = isHead ? FONT_HEAD : FONT_BODY;
    rg.Font.Bold = !!isHead;
    rg.Font.Color = isHead ? FG_HEAD : FG_BODY;
    rg.Interior.Color = bg;
    rg.HorizontalAlignment = -4108;   // xlCenter
    rg.VerticalAlignment = -4108;
    rg.WrapText = true;
  } catch (e) {
    console.log("样式设置失败（不影响数据）: " + e.message);
  }
  // 货品明细列左对齐
  try {
    sh.Range("E" + r1 + ":E" + r2).HorizontalAlignment = -4131;   // xlLeft
  } catch (e2) {}
}

/** 建表头 + 列宽 + 冻结首行首列 + 隐藏记录ID列 */
function ensureLedgerSheet(sh) {
  var a1 = getCellValue(sh, 1, 1);
  if (a1 === null || a1 === undefined || a1 === "") {
    for (var i = 0; i < LEDGER_HEADERS.length; i++) {
      setCellValue(sh, i + 1, 1, LEDGER_HEADERS[i]);
    }
    setCellValue(sh, RID_COL, 1, "记录ID");
    console.log("已写入表头");
  }
  // 列宽
  try {
    sh.Range("A:A").ColumnWidth = 18;   // 日期时间
    sh.Range("B:B").ColumnWidth = 20;   // 订单号
    sh.Range("C:C").ColumnWidth = 9;    // 类型
    sh.Range("D:D").ColumnWidth = 22;   // 部门/客户
    sh.Range("E:E").ColumnWidth = 28;   // 货品明细
    sh.Range("F:F").ColumnWidth = 11;   // 剩余库存
    sh.Range("G:G").ColumnWidth = 10;   // 状态
    sh.Range("H:H").ColumnWidth = 16;   // 记录ID
  } catch (e) { console.log("设列宽失败（忽略）: " + e.message); }

  // 冻结：首行 + 首列（多种写法兜底，哪个能成就行）
  try {
    var app = (typeof Application !== "undefined") ? Application : null;
    if (app && app.ActiveWindow) {
      app.ActiveWindow.FreezePanes = false;
      app.ActiveWindow.SplitRow = 1;
      app.ActiveWindow.SplitColumn = 1;
      app.ActiveWindow.FreezePanes = true;
    }
  } catch (e1) {
    try {
      sh.Range("B2").Select();
      sh.Application.ActiveWindow.FreezePanes = true;
    } catch (e1b) { console.log("冻结失败（请人工点「视图-冻结窗格」）: " + e1.message); }
  }

  // 隐藏记录ID列
  try {
    sh.Columns(RID_COL).Hidden = true;
  } catch (e3) {
    try {
      sh.Range("H:H").EntireColumn.Hidden = true;
    } catch (e3b) {
      console.log("隐藏记录ID列失败（请人工隐藏 H 列，勿删）: " + e3.message);
    }
  }

  // 表头样式（加粗 + 白字 + 薄荷底）
  styleBlock(sh, 1, 1, true, BG_HEAD);
}

function findLastDataRow(sh) {
  var usedRows = 1;
  try { usedRows = sh.UsedRange.Rows.Count; } catch (e) {}
  for (var r = usedRows; r >= 2; r--) {
    var av = getCellValue(sh, 1, r);
    var ev = getCellValue(sh, 5, r);
    if ((av !== null && av !== undefined && av !== "") ||
        (ev !== null && ev !== undefined && ev !== "")) return r;
  }
  return 1;
}

function findRowByRid(sh, rid) {
  if (!rid) return 0;
  var last = findLastDataRow(sh);
  for (var r = 2; r <= last; r++) {
    var v = getCellValue(sh, RID_COL, r);
    if (v !== null && v !== undefined && String(v) === String(rid)) return r;
  }
  return 0;
}

/** 已写入多少单（按记录ID去重）—— 用于 5 色循环 */
function countOrders(sh) {
  var last = findLastDataRow(sh);
  var seen = {};
  var n = 0;
  for (var r = 2; r <= last; r++) {
    var v = getCellValue(sh, RID_COL, r);
    if (v !== null && v !== undefined && v !== "") {
      var k = String(v);
      if (!seen[k]) { seen[k] = 1; n++; }
    }
  }
  return n;
}

/** 按 colorKey 决定底色 */
function pickBg(sh, colorKey) {
  if (colorKey === "in") return BG_IN;
  if (colorKey === "borrow") return BG_BORROW;
  if (colorKey === "gray") return BG_GRAY;
  return CYCLE[countOrders(sh) % CYCLE.length];   // cycle：5 色轮转
}

function mergeBlock(sh, colIdx, r1, r2) {
  if (r2 <= r1) return;
  try {
    sh.Range(colLetter(colIdx) + r1 + ":" + colLetter(colIdx) + r2).Merge();
  } catch (e) {
    console.log("合并失败（降级为留空）: " + colLetter(colIdx) + r1 + ":" + r2 + " / " + e.message);
  }
}

function unmergeBlock(sh, r1, r2) {
  if (r2 < r1) return;
  try {
    sh.Range("A" + r1 + ":" + colLetter(RID_COL) + r2).UnMerge();
  } catch (e) {
    console.log("拆合并失败（忽略）: " + e.message);
  }
}

/** 写一单（N+1 行）+ 合并 + 配色 */
function writeOrderBlock(sh, startRow, arg) {
  var items = arg.items || [];
  if (!items.length) throw new Error("缺少 items");

  var h = arg.header || {};
  var total = 0;
  for (var i = 0; i < items.length; i++) total += toNum(items[i].qty);
  var blockRows = items.length;   // 2026-11-19：不再写「合计」行，几个货品就几行

  for (var k = 0; k < blockRows; k++) {
    var row = startRow + k;
    // 单级字段只在首行写值（合并后其余格会被合并覆盖）
    if (k === 0) {
      setCellValue(sh, 1, row, h.datetime || "");
      setCellValue(sh, 2, row, h.orderNo || "");
      setCellValue(sh, 3, row, h.typeText || "出库");
      setCellValue(sh, 4, row, h.dept || "");
      setCellValue(sh, 7, row, h.status || "");
    }
    var it = items[k];
    setCellValue(sh, 5, row, it.name + " × " + toNum(it.qty));
    setCellValue(sh, 6, row, (it.stock === null || it.stock === undefined) ? "" : toNum(it.stock));
    setCellValue(sh, RID_COL, row, arg.rid || "");
  }

  // 合并 A/B/C/D/G（1/2/3/4/7）
  var cols = [1, 2, 3, 4, 7];
  for (var c = 0; c < cols.length; c++) {
    mergeBlock(sh, cols[c], startRow, startRow + blockRows - 1);
  }

  // 配色
  var bg = arg.bg || pickBg(sh, arg.colorKey);
  styleBlock(sh, startRow, startRow + blockRows - 1, false, bg);

  // 入库：类型列深红加粗，更醒目
  if (arg.colorKey === "in") {
    try {
      var tr = sh.Range("C" + startRow + ":C" + (startRow + blockRows - 1));
      tr.Font.Color = FG_IN;
      tr.Font.Bold = true;
    } catch (e5) { console.log("入库标识上色失败: " + e5.message); }
  }

  return { row: startRow, rows: blockRows, total: total };
}

// ===== 库存表品类配色（与 Python ledger_stock.CAT_BG 保持一致）=====
var STOCK_CATS = ["精华液", "面膜", "洁面慕斯", "精粹水", "精粹乳", "精粹霜",
                  "礼盒拎袋", "化妆包", "抽绳袋", "牛皮纸袋"];
var STOCK_BG = [
  rgb(0xEA, 0xF2, 0xFA),   // 精华液 淡蓝
  rgb(0xEA, 0xF7, 0xEE),   // 面膜 淡绿
  rgb(0xFD, 0xF7, 0xE4),   // 洁面慕斯 淡黄
  rgb(0xE6, 0xF4, 0xF4),   // 精粹水 淡青
  rgb(0xF1, 0xEC, 0xFA),   // 精粹乳 淡紫
  rgb(0xFB, 0xED, 0xF0),   // 精粹霜 淡粉
  rgb(0xFA, 0xF6, 0xEE),   // 礼盒拎袋 米白
  rgb(0xFC, 0xEB, 0xE2),   // 化妆包 淡蜜桃
  rgb(0xF1, 0xF6, 0xE3),   // 抽绳袋 淡黄绿
  rgb(0xED, 0xF1, 0xF5)    // 牛皮纸袋 淡冷灰蓝
];

function stockBg(cat) {
  var i = STOCK_CATS.indexOf(String(cat || ""));
  return i >= 0 ? STOCK_BG[i] : rgb(0xFF, 0xFF, 0xFF);
}

function ledgerSheet(a) {
  var name = a.sheet_name;
  if (!name) throw new Error("缺少 sheet_name");
  var sh = Application.Sheets(name);
  if (!sh) throw new Error("找不到子表: " + name);
  ensureLedgerSheet(sh);
  return sh;
}

// ===================== 主入口 =====================
function main() {
  console.log("===== 流水台账脚本开始 =====");
  try {
    var a = (typeof Context !== "undefined" && Context && Context.argv) || {};
    console.log("收到参数: " + JSON.stringify(a));

    if (a.mode === "init_ledger") {
      var sh0 = ledgerSheet(a);
      return { ok: true, sheet: a.sheet_name, lastRow: findLastDataRow(sh0), orders: countOrders(sh0) };
    }

    if (a.mode === "read_ledger") {
      var shR = ledgerSheet(a);
      var lastR = findLastDataRow(shR);
      var map = {};
      for (var r = 2; r <= lastR; r++) {
        var rid = getCellValue(shR, RID_COL, r);
        if (rid !== null && rid !== undefined && rid !== "") {
          var key = String(rid);
          if (!map[key]) map[key] = r;
        }
      }
      return { ok: true, sheet: a.sheet_name, lastRow: lastR, rows: map, count: Object.keys(map).length };
    }

    if (a.mode === "append_ledger") {
      var sh1 = ledgerSheet(a);
      var existRow = findRowByRid(sh1, a.rid);
      var startRow1;
      if (existRow) {
        unmergeBlock(sh1, existRow, existRow + 30);   // 幂等：原位重写，不追加第二份
        startRow1 = existRow;
      } else {
        startRow1 = findLastDataRow(sh1) + 1;
        a.bg = pickBg(sh1, a.colorKey);               // 新单才定循环色
      }
      var w1 = writeOrderBlock(sh1, startRow1, a);
      console.log("===== 追加成功: " + JSON.stringify(w1));
      return { ok: true, sheet: a.sheet_name, row: w1.row, rows: w1.rows, total: w1.total };
    }

    if (a.mode === "update_ledger") {
      var sh2 = ledgerSheet(a);
      var r2 = findRowByRid(sh2, a.rid);
      if (!r2) throw new Error("找不到记录ID: " + a.rid);
      unmergeBlock(sh2, r2, r2 + 30);
      var w2 = writeOrderBlock(sh2, r2, a);
      console.log("===== 重写成功: " + JSON.stringify(w2));
      return { ok: true, sheet: a.sheet_name, row: w2.row, rows: w2.rows, total: w2.total };
    }

    if (a.mode === "update_ledger_status") {
      var sh3 = ledgerSheet(a);
      var r3 = findRowByRid(sh3, a.rid);
      if (!r3) throw new Error("找不到记录ID: " + a.rid);
      setCellValue(sh3, 7, r3, a.status || "");
      console.log("===== 状态更新: " + a.rid + " -> " + a.status);
      return { ok: true, sheet: a.sheet_name, row: r3, status: a.status };
    }

    if (a.mode === "revoke_ledger") {
      var sh4 = ledgerSheet(a);
      var r4 = findRowByRid(sh4, a.rid);
      if (!r4) {
        console.log("未找到记录，跳过: " + a.rid);
        return { ok: true, skipped: true, reason: "not_found" };
      }
      setCellValue(sh4, 7, r4, "已撤销");
      var endRow = r4;
      var lastD = findLastDataRow(sh4);
      for (var rr = r4 + 1; rr <= lastD; rr++) {
        var vv = getCellValue(sh4, RID_COL, rr);
        if (vv !== null && vv !== undefined && String(vv) !== String(a.rid)) break;
        endRow = rr;
      }
      styleBlock(sh4, r4, endRow, false, BG_GRAY);
      console.log("===== 撤销标记: " + a.rid + " 行 " + r4 + "-" + endRow);
      return { ok: true, sheet: a.sheet_name, row: r4, endRow: endRow, status: "已撤销" };
    }

    if (a.mode === "update_stock") {
      /* 库存表刷新：rows = [[分类, 货品, 当前库存, 最后变动, 标记], ...]
         5 列 + 分类列纵向合并 + 品类分色块。数据由 Python 侧算好，这里只落表。 */
      var shS = Application.Sheets(a.sheet_name);
      if (!shS) throw new Error("找不到子表: " + a.sheet_name);
      var rows = a.rows || [];
      var LAST = 4;

      // 删旧行（连合并/底色一起清），表头保留
      var oldLast = findLastDataRow(shS);
      if (oldLast >= 2) {
        try { shS.Range("A2:" + colLetter(LAST) + (oldLast + 200)).Delete(); }
        catch (eD) { console.log("清空库存行失败（忽略）: " + eD.message); }
      }

      // 表头 + 数据
      var SH = ["分类", "货品", "当前库存", "最后变动"];
      for (var i = 0; i < SH.length; i++) setCellValue(shS, i + 1, 1, SH[i]);
      for (var r = 0; r < rows.length; r++) {
        for (var c = 0; c < LAST; c++) {
          var v = rows[r][c];
          setCellValue(shS, c + 1, r + 2, (v === null || v === undefined) ? "" : v);
        }
      }

      // 分类列合并（同品类跨行合一格）
      var groups = [];
      for (var g = 0; g < rows.length; g++) {
        var cat = String(rows[g][0] || "");
        if (!groups.length || groups[groups.length - 1][0] !== cat) {
          groups.push([cat, g + 2, g + 2]);
        } else {
          groups[groups.length - 1][2] = g + 2;
        }
      }
      for (var m = 0; m < groups.length; m++) {
        if (groups[m][2] > groups[m][1]) {
          try { shS.Range("A" + groups[m][1] + ":A" + groups[m][2]).Merge(); }
          catch (eM) { console.log("分类列合并失败（忽略）: " + eM.message); }
        }
      }

      // 列宽
      try {
        shS.Range("A:A").ColumnWidth = 12;
        shS.Range("B:B").ColumnWidth = 26;
        shS.Range("C:C").ColumnWidth = 12;
        shS.Range("D:D").ColumnWidth = 18;
        shS.Range("E:E").ColumnWidth = 14;
      } catch (eW) {}

      // 表头样式
      try {
        var hd = shS.Range("A1:" + colLetter(LAST) + "1");
        hd.Font.Name = LEDGER_FONT;
        hd.Font.Size = FONT_HEAD;
        hd.Font.Bold = true;
        hd.Font.Color = FG_HEAD;
        hd.Interior.Color = BG_HEAD;
        hd.HorizontalAlignment = -4108;
        hd.VerticalAlignment = -4108;
      } catch (eH) { console.log("库存表头样式失败: " + eH.message); }

      // 数据区字体 + 品类底色 + 库存右对齐
      for (var q = 0; q < groups.length; q++) {
        var gc = groups[q][0], gr1 = groups[q][1], gr2 = groups[q][2];
        var bg = stockBg(gc);
        try {
          var rg = shS.Range("A" + gr1 + ":" + colLetter(LAST) + gr2);
          rg.Font.Name = LEDGER_FONT;
          rg.Font.Size = FONT_BODY;
          rg.Font.Bold = false;
          rg.Font.Color = FG_BODY;
          rg.Interior.Color = bg;
          rg.HorizontalAlignment = -4108;
          rg.VerticalAlignment = -4108;
          rg.WrapText = true;
          shS.Range("A" + gr1 + ":A" + gr2).Font.Bold = true;
          shS.Range("A" + gr1 + ":A" + gr2).Font.Color = rgb(0x4E, 0x6B, 0x5E);
          shS.Range("C" + gr1 + ":C" + gr2).HorizontalAlignment = -4152;   // xlRight
        } catch (eQ) { console.log("库存行样式失败: " + eQ.message); }
      }

      console.log("===== 库存表刷新成功: " + a.sheet_name + " " + rows.length + " 行 / " + groups.length + " 品类");
      return { ok: true, sheet: a.sheet_name, rows: rows.length, groups: groups.length };
    }

    throw new Error("未知 mode: " + a.mode);
  } catch (err) {
    console.log("===== 流水台账脚本失败: " + (err && err.message ? err.message : err));
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

return main();
