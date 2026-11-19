/**
 * airscript_ledger.js — 出库流水台账（金山文档共享脚本 · AirScript）
 *
 * 用途：把「出库登记」的记录落到一个独立台账文档的两个子表里：
 *         「深圳细胞」 ← data/records/       （warehouse=shenzhen）
 *         「赛迪斯」   ← data-saidis/records （warehouse=saidis）
 *
 * 与 airscript_shenzhen.js 的区别（别混用）：
 *   那个是「库存滚动台账」—— 每个货品一对 [发放列/库存列]，库存由脚本读上一行推算；
 *   这个是「流水台账」—— 固定 6 列，一个货品占一行，剩余库存直接取系统快照，不滚动推算。
 *
 * 表结构（第 1 行表头，7 列，G 列隐藏做锚点）：
 *   A 日期时间 | B 订单号(客户JY号) | C 部门/客户 | D 货品明细 | E 剩余库存 | F 状态 | G 记录ID(隐藏)
 *
 * 一单占 N+1 行（N=货品数，+1 是「合计 N 件」行），A/B/C/F 四列纵向合并。
 * 合并失败会自动降级为「首行写值、其余留空」，不影响数据。
 *
 * webhook 调用格式（与现有脚本一致）：
 *   POST <webhook>
 *   Headers: { "Content-Type": "application/json", "AirScript-Token": "<脚本令牌>" }
 *   Body: { "Context": { "argv": { "mode": "append_ledger", ... } } }
 *
 * 支持的 mode：
 *   init_ledger            建表头 + 列宽 + 冻结首行（一次性）
 *   append_ledger          追加一单（N+1 行 + 合并）
 *   update_ledger          整块重写一单（货品变了，行数可能变）
 *   update_ledger_status   只改状态（不碰结构）
 *   revoke_ledger          标「已撤销」+ 整行浅灰（不删行，保流水留痕）
 *   read_ledger            返回 {rid: row} 映射（Actions 兜底核对用）
 */

var LEDGER_HEADERS = ["日期时间", "订单号", "部门/客户", "货品明细", "剩余库存", "状态"];
var RID_COL = 7;          // G 列：记录ID 锚点（隐藏，勿删）
var TOTAL_SUFFIX = " 件";

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

/** 建表头（只在空表时执行）+ 列宽 + 冻结首行 + 隐藏锚点列 */
function ensureLedgerSheet(sh) {
  var a1 = getCellValue(sh, 1, 1);
  if (a1 === null || a1 === undefined || a1 === "") {
    for (var i = 0; i < LEDGER_HEADERS.length; i++) {
      setCellValue(sh, i + 1, 1, LEDGER_HEADERS[i]);
    }
    setCellValue(sh, RID_COL, 1, "记录ID");
    console.log("已写入表头");
  }
  // 列宽（失败不影响写入）
  try {
    sh.Range("A:A").ColumnWidth = 18;   // 日期时间
    sh.Range("B:B").ColumnWidth = 20;   // 订单号
    sh.Range("C:C").ColumnWidth = 22;   // 部门/客户
    sh.Range("D:D").ColumnWidth = 26;   // 货品明细
    sh.Range("E:E").ColumnWidth = 12;   // 剩余库存
    sh.Range("F:F").ColumnWidth = 10;   // 状态
    sh.Range("G:G").ColumnWidth = 16;   // 记录ID
  } catch (e) { console.log("设列宽失败（忽略）: " + e.message); }
  // 冻结首行
  try { sh.Range("A2").Application.ActiveWindow.FreezePanes = false; } catch (e1) {}
  try { sh.Rows(1).Freeze = true; } catch (e2) { /* 部分版本不支持，人工冻结一次即可 */ }
  // 隐藏锚点列
  try { sh.Columns(RID_COL).Hidden = true; } catch (e3) {
    console.log("隐藏锚点列失败（请人工隐藏 G 列，勿删除）: " + e3.message);
  }
}

/** 真实最后数据行（A 列从下往上找，避免 UsedRange 被底色撑大） */
function findLastDataRow(sh) {
  var usedRows = 1;
  try { usedRows = sh.UsedRange.Rows.Count; } catch (e) {}
  for (var r = usedRows; r >= 2; r--) {
    var av = getCellValue(sh, 1, r);
    var dv = getCellValue(sh, 4, r);
    if ((av !== null && av !== undefined && av !== "") ||
        (dv !== null && dv !== undefined && dv !== "")) return r;
  }
  return 1;
}

/** 按记录ID在 G 列找行（找不到返回 0） */
function findRowByRid(sh, rid) {
  if (!rid) return 0;
  var last = findLastDataRow(sh);
  for (var r = 2; r <= last; r++) {
    var v = getCellValue(sh, RID_COL, r);
    if (v !== null && v !== undefined && String(v) === String(rid)) return r;
  }
  return 0;
}

/** 合并某一列的一段；单行不合并；失败降级为留空（不抛错） */
function mergeBlock(sh, colIdx, r1, r2) {
  if (r2 <= r1) return false;
  var ref = colLetter(colIdx) + r1 + ":" + colLetter(colIdx) + r2;
  try {
    sh.Range(ref).Merge();
    return true;
  } catch (e) {
    console.log("合并失败（降级为留空）: " + ref + " / " + e.message);
    return false;
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

/** 把一单写成 N+1 行，并合并 A/B/C/F */
function writeOrderBlock(sh, startRow, arg) {
  var items = arg.items || [];
  if (!items.length) throw new Error("缺少 items");

  var header = arg.header || {};   // {datetime, orderNo, dept, status}
  var total = 0;
  for (var i = 0; i < items.length; i++) total += toNum(items[i].qty);

  var blockRows = items.length + 1;   // 明细行 + 合计行
  for (var k = 0; k < blockRows; k++) {
    var row = startRow + k;
    var isTotal = (k === items.length);
    // A/B/C/F 只在首行写值（合并后其它格会被合并覆盖）
    if (k === 0) {
      setCellValue(sh, 1, row, header.datetime || "");
      setCellValue(sh, 2, row, header.orderNo || "");
      setCellValue(sh, 3, row, header.dept || "");
      setCellValue(sh, 6, row, header.status || "未审核");
    }
    if (isTotal) {
      setCellValue(sh, 4, row, "合计 " + total + TOTAL_SUFFIX);
      setCellValue(sh, 5, row, "");
    } else {
      var it = items[k];
      setCellValue(sh, 4, row, it.name + " × " + toNum(it.qty));
      setCellValue(sh, 5, row, (it.stock === null || it.stock === undefined) ? "" : toNum(it.stock));
    }
    setCellValue(sh, RID_COL, row, arg.rid || "");   // 每行都写，合并后取首格也读得到
  }

  // 合并 A/B/C/F（1/2/3/6 列）
  var cols = [1, 2, 3, 6];
  for (var c = 0; c < cols.length; c++) {
    mergeBlock(sh, cols[c], startRow, startRow + blockRows - 1);
  }
  return { row: startRow, rows: blockRows, total: total };
}

/** 整行浅灰（撤销 / 非正常出货单据用） */
function paintRow(sh, r1, r2, color) {
  try {
    sh.Range("A" + r1 + ":" + colLetter(RID_COL) + r2).Interior.Color = color;
  } catch (e) {
    console.log("上色失败（忽略）: " + e.message);
  }
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
  console.log("===== 出库流水台账脚本开始 =====");
  try {
    var a = (typeof Context !== "undefined" && Context && Context.argv) || {};
    console.log("收到参数: " + JSON.stringify(a));

    // ---- 建表（一次性）----
    if (a.mode === "init_ledger") {
      var sh0 = ledgerSheet(a);
      return { ok: true, sheet: a.sheet_name, lastRow: findLastDataRow(sh0) };
    }

    // ---- 读锚点映射（Actions 兜底核对用）----
    if (a.mode === "read_ledger") {
      var shR = ledgerSheet(a);
      var lastR = findLastDataRow(shR);
      var map = {};
      for (var r = 2; r <= lastR; r++) {
        var rid = getCellValue(shR, RID_COL, r);
        if (rid !== null && rid !== undefined && rid !== "") {
          var key = String(rid);
          if (!map[key]) map[key] = r;   // 同一单多行只记首行
        }
      }
      return { ok: true, sheet: a.sheet_name, lastRow: lastR, rows: map, count: Object.keys(map).length };
    }

    // ---- 追加一单 ----
    if (a.mode === "append_ledger") {
      var sh1 = ledgerSheet(a);
      var existRow = findRowByRid(sh1, a.rid);
      if (existRow) {
        // 幂等：已存在就按「整块重写」处理，绝不追加第二份
        unmergeBlock(sh1, existRow, existRow + toNum(a.block_rows || 1) + 5);
      }
      var startRow = findLastDataRow(sh1) + 1;
      var w1 = writeOrderBlock(sh1, startRow, a);
      if (a.gray) paintRow(sh1, w1.row, w1.row + w1.rows - 1, 15132390);
      console.log("===== 追加成功: " + JSON.stringify(w1));
      return { ok: true, sheet: a.sheet_name, row: w1.row, rows: w1.rows, total: w1.total };
    }

    // ---- 整块重写（货品/部门等变了，行数可能变）----
    if (a.mode === "update_ledger") {
      var sh2 = ledgerSheet(a);
      var r2 = findRowByRid(sh2, a.rid);
      if (!r2) throw new Error("找不到记录ID，可能已被人工删除: " + a.rid);
      // 从该行往下多拆几行（原来占几行不确定，多拆无害：只拆已合并区）
      unmergeBlock(sh2, r2, r2 + 30);
      var w2 = writeOrderBlock(sh2, r2, a);
      if (a.gray) paintRow(sh2, w2.row, w2.row + w2.rows - 1, 15132390);
      console.log("===== 重写成功: " + JSON.stringify(w2));
      return { ok: true, sheet: a.sheet_name, row: w2.row, rows: w2.rows, total: w2.total };
    }

    // ---- 只改状态（审核 / 未审核）----
    if (a.mode === "update_ledger_status") {
      var sh3 = ledgerSheet(a);
      var r3 = findRowByRid(sh3, a.rid);
      if (!r3) throw new Error("找不到记录ID: " + a.rid);
      setCellValue(sh3, 6, r3, a.status || "未审核");
      console.log("===== 状态更新成功: " + a.rid + " -> " + a.status);
      return { ok: true, sheet: a.sheet_name, row: r3, status: a.status };
    }

    // ---- 撤销（不删行，保流水留痕）----
    if (a.mode === "revoke_ledger") {
      var sh4 = ledgerSheet(a);
      var r4 = findRowByRid(sh4, a.rid);
      if (!r4) {
        console.log("未找到该记录（可能从未写入），跳过: " + a.rid);
        return { ok: true, skipped: true, reason: "not_found" };
      }
      setCellValue(sh4, 6, r4, "已撤销");
      // 找到这一单占几行：往下扫到记录ID变化的上一行
      var endRow = r4;
      var lastD = findLastDataRow(sh4);
      for (var rr = r4 + 1; rr <= lastD; rr++) {
        var vv = getCellValue(sh4, RID_COL, rr);
        if (vv !== null && vv !== undefined && String(vv) !== String(a.rid)) break;
        endRow = rr;
      }
      paintRow(sh4, r4, endRow, 15132390);   // 浅灰
      console.log("===== 撤销标记成功: " + a.rid + " 行 " + r4 + "-" + endRow);
      return { ok: true, sheet: a.sheet_name, row: r4, endRow: endRow, status: "已撤销" };
    }

    throw new Error("未知 mode: " + a.mode);
  } catch (err) {
    console.log("===== 出库流水台账脚本失败: " + (err && err.message ? err.message : err));
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}
