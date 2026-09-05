/**
 * airscript_saidis.js — 赛迪斯版（部署到「赛迪斯：小鹿产品登记.ksheet」，与深圳逻辑逐字一致）
 * 深圳源文件：lurong-sync/airscript_append.js（8-08 版），本文件为同源副本，勿在此单独改逻辑，
 * 要改先改深圳源再同步。webhook 指向 cvuTJ0W1GSxl / V2-7Mj0bkvxlRW0lk3LE2edZJ/sync_task。
 *
 * 原名 airscript_append.js — 金山文档共享脚本（AirScript 2.0）
 *
 * 两种触发模式：
 *   [1] 日常提交（无 mode）：GitHub Action 调 webhook，单笔追加一行
 *       自动识别表头里的[发放列,库存列]对，自动算库存、入库整行标黄。
 *   [2] 批量导入（mode:"import_rows"）：代理远程触发，把 xlsx 历史数据
 *       原模原样写进对应子表（先清空再写，等于删掉测试数据+录入历史）。
 *
 * webhook 调用格式：
 *   POST <webhook>
 *   Headers: { "Content-Type": "application/json", "AirScript-Token": "<脚本令牌>" }
 *   Body: { "Context": { "argv": { ... } } }
 */

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

// 读第1行表头，建立「表头文字 -> 列号」映射
function buildHeaderMap(sh) {
  var map = {};
  for (var c = 1; c <= 100; c++) {
    var v = getCellValue(sh, c, 1);
    if (v === null || v === undefined || v === "") continue;
    map[String(v)] = c;
  }
  return map;
}

// 把发放列表头统一成前端使用的核心商品名
function normalizeProductName(issueHeader) {
  if (!issueHeader) return "";
  return String(issueHeader)
    .replace(/小鹿/g, "")
    .replace(/发放/g, "")
    .replace(/放发/g, "")
    .replace(/\//g, "")
    .replace(/\s+/g, "")
    .trim();
}

// 自动扫描表头，找出所有 [发放列, 库存列] 对
function scanProductPairs(sh) {
  var pairs = {};
  for (var c = 1; c <= 100; c++) {
    var stockH = getCellValue(sh, c + 1, 1);
    if (stockH === null || stockH === undefined || stockH === "") continue;
    if (String(stockH).indexOf("库存") === -1) continue;

    var issueH = getCellValue(sh, c, 1);
    if (!issueH) continue;
    issueH = String(issueH).trim();

    // 跳过基础列（虽然基础列下一列不会是库存，保险起见）
    if (/^(日期|领取人|放发人|用途|部门|备注)$/.test(issueH)) continue;

    var name = normalizeProductName(issueH);
    if (name) pairs[name] = [c, c + 1];
  }
  return pairs;
}

// ===== 记录ID 列（删除同步的定位锚点）=====
// 为什么需要：网页端删掉一条记录时，要能在金山里精确找到「就是这一行」。
// 靠 日期+领取人+用途 组合匹配会误删（同一天同一人同一用途可能有两单），
// 所以在表格最右侧留一列「记录ID」，追加时写入订单 id，删除时按 id 精确定位。
// 这列不影响任何统计，嫌碍眼可以在金山里右键把它隐藏。
var ID_HEADER = "记录ID";

// 找「记录ID」列号；没有返回 0
function findIdCol(sh) {
  for (var c = 1; c <= 100; c++) {
    var v = getCellValue(sh, c, 1);
    if (v === null || v === undefined || v === "") continue;
    if (String(v).trim() === ID_HEADER) return c;
  }
  return 0;
}

// 找不到就在「最后一个有表头的列」右边隔一格建出来
function ensureIdCol(sh) {
  var c = findIdCol(sh);
  if (c) return c;
  var maxCol = 1;
  for (var i = 1; i <= 100; i++) {
    var v = getCellValue(sh, i, 1);
    if (v !== null && v !== undefined && v !== "") maxCol = i;
  }
  var target = maxCol + 2;   // 空一列，视觉上跟正表分开
  setCellValue(sh, target, 1, ID_HEADER);
  console.log("已新建[" + ID_HEADER + "]列: 第" + target + "列(" + colLetter(target) + ")");
  return target;
}

// 从 UsedRange 末行往上扫，找 A列(日期)/B列(领取人) 真正有内容的最后一行。
// 不能直接用 UsedRange.Rows.Count —— 整列底色会把它撑大几百行。
function findLastDataRow(sh) {
  var usedRows = sh.UsedRange.Rows.Count;
  for (var r = usedRows; r >= 1; r--) {
    var av = getCellValue(sh, 1, r);
    var bv = getCellValue(sh, 2, r);
    if ((av !== null && av !== undefined && av !== "") ||
        (bv !== null && bv !== undefined && bv !== "")) return r;
  }
  return 1;
}

// 空表兜底：写入简化版表头（只有首次建表时会用到；历史导入时会传原表头）
function ensureHeaders(sh, sheetName) {
  var a1 = getCellValue(sh, 1, 1);
  if (a1 !== null && a1 !== undefined && a1 !== "") {
    console.log("表头已存在，跳过自动写入: " + a1);
    return;
  }
  console.log("检测到空表，自动写入默认表头...");
  var defaults = {
    "2026鹿茸水乳系列": [
      "日期", "领取人", "放发人",
      "小鹿洁面放发150ml", "库存150ml",
      "小鹿洁面发放50ml", "库存50ml",
      "小鹿精粹水120ml发放", "库存120ml",
      "小鹿精粹水发放30ml", "库存30ml",
      "小鹿精粹乳发放80ml", "库存80ml",
      "小鹿精粹乳发放30ml", "库存30ml",
      "小鹿精粹乳发放1ml", "库存1ml/袋",
      "小鹿精粹霜发放50g", "库存50g",
      "小鹿精粹霜发放15g", "库存15g",
      "小鹿精粹霜发放5g", "库存5g",
      "小鹿精粹霜发放1g", "库存1g/袋",
      "用途", "部门"
    ],
    "2026时空鹿茸库存": [
      "日期", "领取人", "放发人",
      "发放20支/盒", "库存20支/盒",
      "发放5支/盒", "库存5支/盒",
      "发放1支/袋", "库存1支/袋",
      "小鹿面膜5片/盒\n发放", "库存5片/盒",
      "小鹿面膜1片\n发放", "库存1片",
      "发放小鹿精华\n30支/盒", "库存30支/盒",
      "中秋礼盒", "库存",
      "马年礼盒", "库存",
      "备注", "用途", "部门"
    ]
  };
  var headers = defaults[sheetName];
  if (!headers) throw new Error("未配置默认表头: " + sheetName);
  for (var i = 0; i < headers.length; i++) {
    setCellValue(sh, i + 1, 1, headers[i]);
  }
  console.log("已写入 " + headers.length + " 列表头");
}

// ===== 批量导入模式：把 xlsx 历史数据原样写进子表 =====
function doImport(a) {
  var sheetName = a.sheet_name;
  if (!sheetName) throw new Error("import 缺少 sheet_name");
  var sh = Application.Sheets(sheetName);
  if (!sh) throw new Error("找不到子表: " + sheetName);

  var headers = a.headers || null;
  var rows = a.rows || [];
  var reset = !!a.reset;
  var startRow = a.start_row ? Number(a.start_row) : null;

  if (reset) {
    // 清空整个子表（值+格式），再写表头
    try { sh.Range("A1:AZ2000").Clear(); } catch (e) { console.log("清空警告: " + e.message); }
    if (headers && headers.length) {
      for (var i = 0; i < headers.length; i++) {
        if (headers[i] !== null && headers[i] !== undefined)
          setCellValue(sh, i + 1, 1, headers[i]);
      }
      console.log("已写入表头(" + headers.length + "列)");
    }
    startRow = 2;
  }

  if (!(startRow > 0)) {
    startRow = sh.UsedRange.Rows.Count + 1;
    if (!(startRow > 1)) startRow = 2;
  }

  var written = 0;
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var r = startRow + ri;
    for (var ci = 0; ci < row.length; ci++) {
      var v = row[ci];
      if (v === null || v === undefined || v === "") continue;
      setCellValue(sh, ci + 1, r, v);
    }
    written++;
  }
  console.log("写入 " + written + " 行, 起始行=" + startRow);

  // ---- 写单元格颜色（背景色 + 字体色）----
  var colors = a.cell_colors || [];
  var colored = 0;
  for (var ci2 = 0; ci2 < colors.length; ci2++) {
    var cc = colors[ci2];
    var rr = cc.r;
    if (!(rr > 0)) continue;
    try {
      if (cc.bg) sh.Range(colLetter(cc.c) + rr).Interior.Color = cc.bg;
      if (cc.font) sh.Range(colLetter(cc.c) + rr).Font.Color = cc.font;
      colored++;
    } catch (e) { /* 忽略单格失败 */ }
  }
  if (colored > 0) console.log("写入 " + colored + " 个单元格颜色");
  return { ok: true, sheet: sheetName, written: written, colored: colored, startRow: startRow };
}

// ===== 整列上色模式：把每个有颜色的列，整列刷上「首行(header)的颜色」(含空格) =====
// 入参：a.header_colors = { 列号: BGR颜色值 }, a.max_col = 总列数
// 效果：列号对应的列从首行一直填到底部缓冲行；入库行(领取人=入库)整行标黄。
function styleColumns(a) {
  var sheetName = a.sheet_name;
  if (!sheetName) throw new Error("style 缺少 sheet_name");
  var sh = Application.Sheets(sheetName);
  if (!sh) throw new Error("找不到子表: " + sheetName);

  var headerColors = a.header_colors || {};
  var maxCol = a.max_col ? Number(a.max_col) : 0;

  var lastRow = sh.UsedRange.Rows.Count;
  if (!(lastRow > 1)) lastRow = 2;
  var FILL_TO = lastRow + 500;   // 向下多填 500 行缓冲，未提交的空行也带底色

  console.log("整列上色: 数据末行=" + lastRow + ", 填充至=" + FILL_TO + ", 列数=" + maxCol);

  var coloredCols = 0;
  for (var key in headerColors) {
    var c = Number(key);
    var color = headerColors[key];
    if (!(c > 0) || !(color > 0)) continue;
    try {
      sh.Range(colLetter(c) + "1:" + colLetter(c) + FILL_TO).Interior.Color = color;
      coloredCols++;
    } catch (e) {
      console.log("列" + c + "上色失败: " + e.message);
    }
  }
  console.log("已整列上色 " + coloredCols + " 列");

  // 入库行整行标黄（覆盖在列底色之上，保留「入库印记」）
  var yellowRows = 0;
  for (var r = 2; r <= lastRow; r++) {
    var picker = getCellValue(sh, 2, r);   // 领取人列
    if (picker !== null && picker !== undefined && String(picker).trim() === "入库") {
      try {
        sh.Range("A" + r + ":" + colLetter(maxCol) + r).Interior.Color = 65535;
        yellowRows++;
      } catch (e) { /* 忽略 */ }
    }
  }
  console.log("已标黄 " + yellowRows + " 个入库行");
  return { ok: true, sheet: sheetName, coloredCols: coloredCols, yellowRows: yellowRows };
}

// ===== 读取模式：回读子表内容，用于远程核对数据是否真的落地 =====
// 入参：a.sheet_name, a.start_row(默认2), a.limit(默认30), a.tail(为true时读最后 limit 行), a.max_col(默认30)
function readRows(a) {
  var sheetName = a.sheet_name;
  if (!sheetName) throw new Error("read 缺少 sheet_name");
  var sh = Application.Sheets(sheetName);
  if (!sh) throw new Error("找不到子表: " + sheetName);

  var maxCol = a.max_col ? Number(a.max_col) : 30;
  var limit = a.limit ? Number(a.limit) : 30;
  var lastRow = sh.UsedRange.Rows.Count;
  if (!(lastRow > 0)) lastRow = 1;

  var startRow;
  if (a.tail) {
    startRow = lastRow - limit + 1;
    if (startRow < 2) startRow = 2;
  } else {
    startRow = a.start_row ? Number(a.start_row) : 2;
  }
  var endRow = startRow + limit - 1;
  if (endRow > lastRow) endRow = lastRow;

  var headers = [];
  for (var hc = 1; hc <= maxCol; hc++) headers.push(getCellValue(sh, hc, 1));

  var out = [];
  for (var r = startRow; r <= endRow; r++) {
    var row = [];
    var empty = true;
    for (var c = 1; c <= maxCol; c++) {
      var v = getCellValue(sh, c, r);
      if (v !== null && v !== undefined && v !== "") empty = false;
      row.push(v);
    }
    out.push({ r: r, empty: empty, v: row });
  }
  console.log("读取 " + out.length + " 行 (第" + startRow + "~" + endRow + "行), 数据末行=" + lastRow);
  return { ok: true, sheet: sheetName, lastRow: lastRow, startRow: startRow,
           endRow: endRow, headers: headers, rows: out };
}

// ===== 查找模式：按关键词定位行，用于精确找出污染行 =====
// 入参：a.sheet_name, a.keyword(必填), a.max_col(默认30)
function findRows(a) {
  var sheetName = a.sheet_name;
  if (!sheetName) throw new Error("find 缺少 sheet_name");
  var kw = a.keyword;
  if (!kw) throw new Error("find 缺少 keyword");
  var sh = Application.Sheets(sheetName);
  if (!sh) throw new Error("找不到子表: " + sheetName);

  var maxCol = a.max_col ? Number(a.max_col) : 30;
  var lastRow = sh.UsedRange.Rows.Count;
  var hits = [];
  for (var r = 2; r <= lastRow; r++) {
    for (var c = 1; c <= maxCol; c++) {
      var v = getCellValue(sh, c, r);
      if (v === null || v === undefined || v === "") continue;
      if (String(v).indexOf(kw) !== -1) {
        var row = [];
        for (var c2 = 1; c2 <= maxCol; c2++) row.push(getCellValue(sh, c2, r));
        hits.push({ r: r, hitCol: c, v: row });
        break;
      }
    }
  }
  console.log("关键词[" + kw + "] 命中 " + hits.length + " 行");
  return { ok: true, sheet: sheetName, keyword: kw, lastRow: lastRow, hits: hits };
}

// ===== 删除模式：按行号删除（清污专用，必须带 confirm:true 双重确认）=====
// 入参：a.sheet_name, a.rows(行号数组), a.confirm(必须为 true)
// 安全设计：① 不带 confirm 只做预演(dry-run) ② 一次最多删 20 行 ③ 从大到小删避免错位
function deleteRows(a) {
  var sheetName = a.sheet_name;
  if (!sheetName) throw new Error("delete 缺少 sheet_name");
  var sh = Application.Sheets(sheetName);
  if (!sh) throw new Error("找不到子表: " + sheetName);

  var rows = a.rows || [];
  if (!rows.length) throw new Error("delete 缺少 rows 行号数组");
  if (rows.length > 20) throw new Error("一次最多删除 20 行，收到 " + rows.length + " 行，已拒绝");

  // 去重 + 过滤表头行 + 从大到小排序
  var uniq = {};
  var list = [];
  for (var i = 0; i < rows.length; i++) {
    var r = Number(rows[i]);
    if (!(r >= 2)) continue;          // 绝不删第1行表头
    if (uniq[r]) continue;
    uniq[r] = 1;
    list.push(r);
  }
  list.sort(function (x, y) { return y - x; });

  // 预览待删内容
  var preview = [];
  var maxCol = a.max_col ? Number(a.max_col) : 30;
  for (var p = 0; p < list.length; p++) {
    var pr = list[p];
    var cells = [];
    for (var pc = 1; pc <= maxCol; pc++) {
      var pv = getCellValue(sh, pc, pr);
      if (pv !== null && pv !== undefined && pv !== "") cells.push(pc + ":" + pv);
    }
    preview.push({ r: pr, cells: cells.join(" | ") });
  }

  if (a.confirm !== true) {
    console.log("【预演模式】未删除任何数据。待删行: " + JSON.stringify(preview));
    return { ok: true, dryRun: true, sheet: sheetName, willDelete: list, preview: preview };
  }

  var deleted = 0;
  for (var d = 0; d < list.length; d++) {
    try {
      sh.Rows(list[d]).Delete();
      deleted++;
      console.log("已删除第 " + list[d] + " 行");
    } catch (e) {
      console.log("删除第 " + list[d] + " 行失败: " + e.message);
    }
  }
  console.log("共删除 " + deleted + " 行");
  return { ok: true, dryRun: false, sheet: sheetName, deleted: deleted, rows: list, preview: preview };
}

// ===== 整段清理模式：删除从 start_row 到真实末行的所有行（整理专用，需 confirm:true）=====
// 用于一次性清除「追加错位 / 重复同步」产生的尾部垃圾，让后续记录能接回正确位置。
// 安全设计：① 不带 confirm 只做预演(dry-run) ② 用整块范围删除，单次调用搞定
function clearBelow(a) {
  var sheetName = a.sheet_name;
  if (!sheetName) throw new Error("clear_below 缺少 sheet_name");
  var sh = Application.Sheets(sheetName);
  if (!sh) throw new Error("找不到子表: " + sheetName);

  var startRow = a.start_row ? Number(a.start_row) : 2;
  if (!(startRow >= 2)) startRow = 2;

  // 从 UsedRange 末行往上扫，找真实最后数据行（A列或B列非空）
  var scanEnd = sh.UsedRange.Rows.Count;
  var lastData = startRow - 1;
  for (var rr = scanEnd; rr >= startRow; rr--) {
    var av = getCellValue(sh, 1, rr);
    var bv = getCellValue(sh, 2, rr);
    if ((av !== null && av !== undefined && av !== "") ||
        (bv !== null && bv !== undefined && bv !== "")) {
      lastData = rr;
      break;
    }
  }

  var count = lastData - startRow + 1;

  if (a.confirm !== true) {
    console.log("【预演】将删除第 " + startRow + "~" + lastData + " 行，共 " + count + " 行");
    return { ok: true, dryRun: true, sheet: sheetName, from: startRow, to: lastData, count: count };
  }

  // 整块范围删除（一次调用删完，避免逐行 API 调用超时）
  sh.Range("A" + startRow + ":AZ" + lastData).Delete();
  console.log("已删除第 " + startRow + "~" + lastData + " 行，共 " + count + " 行");
  return { ok: true, dryRun: false, sheet: sheetName, deleted: count, from: startRow, to: lastData };
}

// ===== 订单删除模式：网页端删了一条记录 → 金山对应那一行也删掉 =====
// 入参：a.sheet_name, a.rid(记录ID，必填), a.dry_run(true 只预演不删)
//
// 三步走：
//   1) 在「记录ID」列里按 rid 找到那一行（找不到就当已经删过，返回 notFound，不算失败）
//   2) 删掉这一行
//   3) 【关键】重算下游库存链 —— 被删这单的加减，仍然残留在下面每一行的库存快照里，
//      不重算的话当前库存会永久性偏差。所以从删除位置往下，按
//      「本行库存 = 上一行库存 ± 本行发放数」逐行刷新。
//      入库行的发放格是 "➕N" 字符串，出库行是数字 N，靠这个区分加还是减。
function deleteOrder(a) {
  var sheetName = a.sheet_name;
  var rid = a.rid;
  if (!sheetName) throw new Error("delete_order 缺少 sheet_name");
  if (!rid) throw new Error("delete_order 缺少 rid");
  var sh = Application.Sheets(sheetName);
  if (!sh) throw new Error("找不到子表: " + sheetName);

  var idCol = findIdCol(sh);
  if (!idCol) {
    console.log("该子表还没有[" + ID_HEADER + "]列，说明没有可按 id 删除的行");
    return { ok: true, notFound: true, sheet: sheetName, rid: rid, reason: "no_id_col" };
  }

  var lastRow = findLastDataRow(sh);
  var targets = [];
  for (var r = 2; r <= lastRow; r++) {
    var v = getCellValue(sh, idCol, r);
    if (v === null || v === undefined || v === "") continue;
    if (String(v).trim() === String(rid)) targets.push(r);
  }
  if (!targets.length) {
    console.log("未找到 rid=" + rid + " 的行（可能是历史行或已删过）");
    return { ok: true, notFound: true, sheet: sheetName, rid: rid, lastRow: lastRow };
  }
  if (targets.length > 5) throw new Error("同一 rid 命中 " + targets.length + " 行，异常，已拒绝删除");

  // 先记下这一行动过哪些商品的库存列（后面要重算这些列）
  var pairs = scanProductPairs(sh);
  var affected = {};              // 库存列号 -> 发放列号
  var preview = [];
  for (var t = 0; t < targets.length; t++) {
    var tr = targets[t];
    var cells = [];
    for (var pc = 1; pc <= 60; pc++) {
      var pv = getCellValue(sh, pc, tr);
      if (pv !== null && pv !== undefined && pv !== "") cells.push(colLetter(pc) + ":" + pv);
    }
    preview.push({ r: tr, cells: cells.join(" | ") });
    for (var nm in pairs) {
      var ic = pairs[nm][0], sc = pairs[nm][1];
      var iv = getCellValue(sh, ic, tr);
      if (iv !== null && iv !== undefined && iv !== "") affected[sc] = ic;
    }
  }

  if (a.dry_run === true) {
    console.log("【预演】将删除: " + JSON.stringify(preview));
    return { ok: true, dryRun: true, sheet: sheetName, rid: rid,
             rows: targets, preview: preview, affectedCols: Object.keys(affected) };
  }

  // 从大到小删，避免行号错位
  var sorted = targets.slice().sort(function (x, y) { return y - x; });
  var minRow = targets[0];
  for (var d = 0; d < sorted.length; d++) {
    if (sorted[d] < minRow) minRow = sorted[d];
    sh.Rows(sorted[d]).Delete();
    console.log("已删除第 " + sorted[d] + " 行 (rid=" + rid + ")");
  }
  var newLastRow = lastRow - sorted.length;

  // 重算下游库存链
  var recalced = 0;
  var detail = [];
  for (var scKey in affected) {
    var stockCol = Number(scKey);
    var issueCol = Number(affected[scKey]);
    // 起点：删除位置之上，最近一个有库存数的行
    var prev = 0;
    for (var up = minRow - 1; up >= 2; up--) {
      var uv = getCellValue(sh, stockCol, up);
      if (uv !== null && uv !== undefined && uv !== "") { prev = toNum(uv); break; }
    }
    var before = null, after = null, n = 0;
    for (var rr = minRow; rr <= newLastRow; rr++) {
      var ivv = getCellValue(sh, issueCol, rr);
      if (ivv === null || ivv === undefined || ivv === "") continue;
      var s = String(ivv);
      var isIn = s.indexOf("\u2795") === 0;                    // "➕" 开头 = 入库
      var q = toNum(isIn ? s.replace("\u2795", "") : s);
      if (before === null) before = getCellValue(sh, stockCol, rr);
      prev = isIn ? (prev + q) : (prev - q);
      setCellValue(sh, stockCol, rr, prev);
      after = prev; n++; recalced++;
    }
    detail.push({ stockCol: stockCol, rows: n, firstOld: before, lastNew: after });
  }
  console.log("已重算下游库存 " + recalced + " 格: " + JSON.stringify(detail));

  return { ok: true, dryRun: false, sheet: sheetName, rid: rid,
           deletedRows: sorted, preview: preview, recalced: recalced, detail: detail };
}

function main() {
  console.log("===== 脚本开始 =====");
  try {
    var a = (typeof Context !== "undefined" && Context && Context.argv) || {};
    console.log("收到参数: " + JSON.stringify(a));

    // ---- 回读分支（远程核对数据）----
    if (a.mode === "read_rows") {
      var rd = readRows(a);
      console.log("===== 读取成功");
      return rd;
    }

    // ---- 查找分支（定位污染行）----
    if (a.mode === "find_rows") {
      var fd = findRows(a);
      console.log("===== 查找成功");
      return fd;
    }

    // ---- 删除分支（清污，需 confirm:true）----
    if (a.mode === "delete_rows") {
      var dl = deleteRows(a);
      console.log("===== 删除处理完成: " + JSON.stringify({ dryRun: dl.dryRun, deleted: dl.deleted }));
      return dl;
    }

    // ---- 订单删除分支（网页端删记录 → 金山同步删行 + 重算下游库存）----
    if (a.mode === "delete_order") {
      var dor = deleteOrder(a);
      console.log("===== 订单删除完成: " + JSON.stringify({
        notFound: dor.notFound, deletedRows: dor.deletedRows, recalced: dor.recalced }));
      return dor;
    }

    // ---- 整段清理分支（整理尾部垃圾，需 confirm:true）----
    if (a.mode === "clear_below") {
      var cb = clearBelow(a);
      console.log("===== 整段清理: " + JSON.stringify({ dryRun: cb.dryRun, deleted: cb.deleted }));
      return cb;
    }

    // ---- 批量导入分支 ----
    if (a.mode === "import_rows") {
      var imp = doImport(a);
      console.log("===== 导入成功: " + JSON.stringify(imp));
      return imp;
    }

    // ---- 整列上色分支（首行颜色填整列 + 入库行标黄）----
    if (a.mode === "style_columns") {
      var st = styleColumns(a);
      console.log("===== 整列上色成功: " + JSON.stringify(st));
      return st;
    }

    // ---- 多商品合并追加（一个订单 → 同一子表一行，多个商品填该行不同列）----
    // 入参：sheet_name, type(in/out), date, picker, sender, purpose, dept,
    //       items:[{product, qty}, ...]
    // 行为：在子表真实末数据行之后追加「一行」，把 items 里每个商品写到它自己的
    //       [发放列,库存列]；库存按各自列上一行独立计算；入库则整行标黄。
    if (a.mode === "append_order") {
      var sheetName2 = a.sheet_name;
      var type2 = (a.type === "in") ? "in" : "out";
      var date2 = a.date || "";
      var picker2 = a.picker || "";
      var sender2 = a.sender || "陈利冠";
      var purpose2 = a.purpose || "";
      var dept2 = a.dept || "";
      var items2 = a.items || [];
      var rid2 = a.rid || "";          // 记录ID：写进锚点列，供将来删除时精确定位

      if (!sheetName2) throw new Error("缺少 sheet_name");
      if (!items2.length) throw new Error("缺少 items");

      var sh2 = Application.Sheets(sheetName2);
      if (!sh2) throw new Error("找不到子表: " + sheetName2);

      ensureHeaders(sh2, sheetName2);
      var headerMap2 = buildHeaderMap(sh2);
      var pairs2 = scanProductPairs(sh2);

      var purposeCol2 = headerMap2["用途"];
      var deptCol2 = headerMap2["部门"];
      var idCol2 = rid2 ? ensureIdCol(sh2) : 0;

      // 真实最后数据行（从 UsedRange 末行往上扫 A列/ B列非空，避免被整列底色撑大）
      var lastRow2 = findLastDataRow(sh2);

      // 先算每个商品的上一行库存（务必在写入新行之前扫描，避免同订单内互相污染）
      var rowItems2 = [];
      for (var i2 = 0; i2 < items2.length; i2++) {
        var nm2 = items2[i2].product;
        var q2 = toNum(items2[i2].qty);
        if (!nm2 || q2 <= 0) continue;
        var pr2 = pairs2[nm2];
        if (!pr2) throw new Error("找不到商品列: " + nm2 + "，当前商品: " + Object.keys(pairs2).join(","));
        var issueCol2 = pr2[0], stockCol2 = pr2[1];
        var prevStock2 = 0;
        for (var rr2 = lastRow2; rr2 >= 1; rr2--) {
          var sv2 = getCellValue(sh2, stockCol2, rr2);
          if (sv2 !== null && sv2 !== undefined && sv2 !== "") { prevStock2 = toNum(sv2); break; }
        }
        var newStock2 = (type2 === "in") ? (prevStock2 + q2) : (prevStock2 - q2);
        rowItems2.push({ product: nm2, qty: q2, issueCol: issueCol2, stockCol: stockCol2,
                         prevStock: prevStock2, newStock: newStock2 });
      }
      if (!rowItems2.length) throw new Error("没有有效的商品可写入");

      var row2 = lastRow2 + 1;
      setCellValue(sh2, 1, row2, date2);
      setCellValue(sh2, 2, row2, (type2 === "in") ? "入库" : picker2);
      setCellValue(sh2, 3, row2, sender2);
      if (purposeCol2) setCellValue(sh2, purposeCol2, row2, purpose2);
      if (deptCol2)    setCellValue(sh2, deptCol2, row2, dept2);
      if (idCol2)      setCellValue(sh2, idCol2, row2, rid2);
      for (var k2 = 0; k2 < rowItems2.length; k2++) {
        var it2 = rowItems2[k2];
        setCellValue(sh2, it2.issueCol, row2, (type2 === "in") ? ("➕" + it2.qty) : it2.qty);
        setCellValue(sh2, it2.stockCol, row2, it2.newStock);
      }
      if (type2 === "in") {
        try {
          var maxCol2 = 0;
          for (var mc2 = 1; mc2 <= 100; mc2++) {
            var hv2 = getCellValue(sh2, mc2, 1);
            if (hv2 !== null && hv2 !== undefined && hv2 !== "") maxCol2 = mc2;
          }
          // 标黄只覆盖正表范围，不把右侧的[记录ID]锚点列一起涂了
          if (idCol2 && maxCol2 >= idCol2) maxCol2 = idCol2 - 2;
          if (maxCol2 < 1) maxCol2 = 1;
          sh2.Range("A" + row2 + ":" + colLetter(maxCol2) + row2).Interior.Color = 65535;
          console.log("已标黄入库行");
        } catch (e) { console.log("标黄失败（不影响写入）: " + e.message); }
      }

      var result2 = { ok: true, row: row2, sheet: sheetName2, type: type2,
                      items: rowItems2.map(function (x) {
                        return { product: x.product, qty: x.qty, prevStock: x.prevStock, newStock: x.newStock };
                      }) };
      console.log("===== 多商品合并追加成功: " + JSON.stringify(result2));
      return result2;
    }

    // ---- 以下是单笔追加（日常链接提交，旧路径保留兼容） ----
    var sheetName = a.sheet_name;
    var product   = a.product;
    var type      = (a.type === "in") ? "in" : "out";
    var date      = a.date || "";
    var picker    = a.picker || "";
    var sender    = a.sender || "陈利冠";
    var qty       = toNum(a.qty);
    var purpose   = a.purpose || "";
    var dept      = a.dept || "";

    if (!sheetName) throw new Error("缺少 sheet_name");
    if (!product)  throw new Error("缺少 product");
    if (qty <= 0)  throw new Error("发放数量(qty)必须为正数，收到: " + a.qty);

    var sh = Application.Sheets(sheetName);
    if (!sh) throw new Error("找不到子表: " + sheetName);
    console.log("子表对象获取成功");

    ensureHeaders(sh, sheetName);

    var headerMap = buildHeaderMap(sh);
    console.log("表头映射: " + JSON.stringify(headerMap));

    var pairs = scanProductPairs(sh);
    console.log("识别商品对: " + JSON.stringify(pairs));
    if (!pairs[product]) {
      throw new Error("找不到商品列: " + product + "，当前商品: " + Object.keys(pairs).join(","));
    }

    var pair = pairs[product];
    var issueCol = pair[0];
    var stockCol = pair[1];
    console.log("商品=" + product + " 发放列=" + issueCol + " 库存列=" + stockCol);

    var purposeCol = headerMap["用途"];
    var deptCol    = headerMap["部门"];

    var usedRows = sh.UsedRange.Rows.Count;
    console.log("UsedRange.Rows.Count=" + usedRows);

    // 关键修正：UsedRange 会被「整列底色」等格式撑大（如 472 行数据却撑到 1553 行），
    // 直接用它会把新记录写到表格最底部。改从末行往上扫，找 A列(日期)或 B列(领取人)
    // 真正有内容的最后一行，新记录就接在它下面 —— 即「色彩格子按日期顺序往下」。
    var lastRow = 1;
    for (var lr = usedRows; lr >= 1; lr--) {
      var av = getCellValue(sh, 1, lr);
      var bv = getCellValue(sh, 2, lr);
      if ((av !== null && av !== undefined && av !== "") ||
          (bv !== null && bv !== undefined && bv !== "")) {
        lastRow = lr;
        break;
      }
    }
    if (lastRow < 1) lastRow = 1;
    console.log("真实最后数据行=" + lastRow);

    // 找该商品「最近一次有库存值」的行
    var prevStock = 0;
    for (var rr = lastRow; rr >= 1; rr--) {
      var sv = getCellValue(sh, stockCol, rr);
      if (sv !== null && sv !== undefined && sv !== "") { prevStock = toNum(sv); break; }
    }
    console.log("上一行库存(列" + stockCol + ")=" + prevStock);

    var newStock = (type === "in") ? (prevStock + qty) : (prevStock - qty);
    console.log("计算新库存: " + prevStock + (type === "in" ? "+" : "-") + qty + "=" + newStock);

    var row = lastRow + 1;
    console.log("写入第 " + row + " 行");

    setCellValue(sh, 1, row, date);
    setCellValue(sh, 2, row, (type === "in") ? "入库" : picker);
    setCellValue(sh, 3, row, sender);
    if (purposeCol) setCellValue(sh, purposeCol, row, purpose);
    if (deptCol)    setCellValue(sh, deptCol, row, dept);
    setCellValue(sh, issueCol, row, (type === "in") ? ("➕" + qty) : qty);
    setCellValue(sh, stockCol, row, newStock);

    if (type === "in") {
      try {
        sh.Range("A" + row + ":" + colLetter(stockCol) + row).Interior.Color = 65535;
        console.log("已标黄入库行");
      } catch (e) {
        console.log("标黄失败（不影响写入）: " + e.message);
      }
    }

    var result = {
      ok: true, row: row, sheet: sheetName, product: product,
      type: type, prevStock: prevStock, qty: qty, newStock: newStock
    };
    console.log("===== 脚本成功: " + JSON.stringify(result));
    return result;

  } catch (e) {
    console.log("===== 脚本报错: " + e.message);
    return { ok: false, error: e.message };
  }
}

return main();
