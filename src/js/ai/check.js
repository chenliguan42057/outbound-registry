/**
 * check.js — AI 库存核对（第六轮增量，纯函数，零依赖、无 DOM、无网络）
 *
 * 核心能力：
 *   1. Check.parseText(text)  粘贴文本 → ParsedRow[]（逐行归一化 + 核心正则 + 产品匹配）
 *   2. Check.compare(parsed, summary)  解析行 vs 系统库存 → 5 类比对结果
 *   3. Check.answer(text)     完整核对入口 → Answer{type:"check", table, summaryText, chips}
 *
 * 数据源：Stock.summarize()（与报表/库存查询同源同数字）。
 * 产品匹配：懒引用 window.App.AI.Engine.matchProducts（本文件脚本顺序在 engine.js 之前，
 *           运行时才调用，无循环依赖；冒烟测试可注入 stub）。
 *
 * 隐私红线：粘贴的原始文本仅在本文件局部变量/内存对象中解析，
 *           绝不写入本地存储 / 云端 / 聊天记录。
 *
 * 挂载到 window.App.AI.Check。
 */
(function () {
  'use strict';

  var Config = window.App.Config;
  var Stock = window.App.Stock;

  /* ================= 常量 ================= */

  /* 行首/行尾装饰符（截图复制常见噪声） */
  var LEADING_NOISE = /^[|｜·●\-—\s　]+/;
  var TRAILING_NOISE = /[|｜\s　]+$/;

  /* 核心正则：货品名 + 分隔符（全/半角冒号、逗号、顿号、空格、制表符、全角空格）+ 数量 + 可选单位后缀。
     注意：货品名用贪婪 (.+)，保证「面膜 5片装 120」正确切分为 名="面膜 5片装"、数量=120，
     而非非贪婪误切为 名="面膜 5"（非贪婪会把「片装」留给数量列导致歧义误判）。 */
  var LINE_RE = /^(.+)[\s:：,，、|　\t]+(\d+(?:\.\d+)?)\s*(?:件|个|盒|支|瓶|袋|片|g|ml|瓶装)?\s*$/;

  /* 数量合法范围（越界 → 无法识别） */
  var QTY_MIN = 1;
  var QTY_MAX = 99999;

  /* 表格粘贴：单元格纯数字判定 */
  var NUM_CELL_RE = /^\d+(?:\.\d+)?$/;

  /* 行是否包含可识别字符（纯符号行如 "----" 视为噪声忽略） */
  var HAS_CHAR_RE = /[\u4e00-\u9fa5a-zA-Z0-9]/;

  /* ================= 工具 ================= */

  /** 产品名归一化（与 engine.normalize 同规则，保证 matchProducts 输入一致） */
  function normName(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** 懒引用 Engine.matchProducts（运行时才解析，无脚本顺序循环依赖） */
  function matchEngine(input) {
    var Engine = window.App.AI && window.App.AI.Engine;
    if (Engine && typeof Engine.matchProducts === "function") {
      return Engine.matchProducts(input);
    }
    return { exact: [], fuzzy: [] };
  }

  /** 数量合法性校验 */
  function validQty(q) {
    return q >= QTY_MIN && q <= QTY_MAX;
  }

  /* ================= 解析 ================= */

  /**
   * 解析单个文本行 → ParsedRow 或 null（无法组成货品名 → 忽略行）
   * 优先级：表格粘贴（含 \t，取最后数字列）→ 常规行（LINE_RE）→ 无数量存在性行。
   * @param {string} line 已去装饰符的整行
   * @returns {?{raw:string, name:string, qty:number|null, candidates:string[],
   *             ambiguous:boolean, unmatched:boolean, unrecognized:boolean}}
   */
  function parseLine(line) {
    var qty = null;
    var name = null;
    var unrecognized = false;

    /* 表格粘贴：含 \t 的行按「最后一列数字」取数量，其余非数字列合并为货品名候选 */
    if (line.indexOf("\t") !== -1) {
      var cells = line.split("\t").map(function (c) { return String(c).trim(); });
      var qtyIdx = -1;
      for (var i = cells.length - 1; i >= 0; i--) {
        if (NUM_CELL_RE.test(cells[i])) { qtyIdx = i; break; }
      }
      var nameParts = [];
      cells.forEach(function (c, idx) {
        if (idx === qtyIdx) return;           // 数量列剔除
        if (c) nameParts.push(c);
      });
      name = nameParts.join(" ").trim();
      if (qtyIdx !== -1) qty = Number(cells[qtyIdx]);
      if (!name) return null;                 // 整行无可合并货品名 → 忽略
      if (qty !== null && !validQty(qty)) unrecognized = true;
    } else {
      var m = line.match(LINE_RE);
      if (m) {
        /* 贪婪切分后货品名可能残留尾部分隔符（如「洁面慕斯 150ml: 85」→ 名="洁面慕斯 150ml:"），
           统一剥离尾部全/半角分隔符，避免污染产品匹配与展示 */
        name = m[1].trim().replace(/[\s:：,，、|　\t]+$/g, "");
        qty = Number(m[2]);
        if (!validQty(qty)) unrecognized = true;
      } else {
        /* 无数量行（正则未命中且非表格）→ 只核存在性 */
        name = line;
        qty = null;
      }
      if (!name) return null;
    }

    /* 产品匹配：exact 唯一 → 确定；exact 多个 / fuzzy 多候选 → 全部列出（标名称不唯一），绝不静默错判 */
    var matched = matchEngine(normName(name));
    var candidates = [];
    var ambiguous = false;
    if (matched.exact.length === 1) {
      candidates = [matched.exact[0]];
    } else if (matched.exact.length > 1) {
      candidates = matched.exact.slice();
      ambiguous = true;
    } else if (matched.fuzzy.length) {
      candidates = matched.fuzzy.slice();
      ambiguous = true;
    }

    return {
      raw: line,
      name: name,
      qty: qty,
      candidates: candidates,
      ambiguous: ambiguous,
      unmatched: candidates.length === 0,
      unrecognized: unrecognized
    };
  }

  /**
   * 解析粘贴文本 → {rows: ParsedRow[], ignored: number}
   * 逐行：trim → 去行首装饰符 → 去行尾装饰符 → 空行丢弃；纯符号行忽略。
   * @param {string} text 用户粘贴的原始文本（仅内存使用）
   */
  function parseText(text) {
    var rows = [];
    var ignored = 0;
    var lines = String(text == null ? "" : text).split(/\r?\n/);
    lines.forEach(function (raw) {
      var line = String(raw == null ? "" : raw).trim();
      line = line.replace(LEADING_NOISE, "").replace(TRAILING_NOISE, "").trim();
      if (!line) { ignored++; return; }
      if (!HAS_CHAR_RE.test(line)) { ignored++; return; }
      var row = parseLine(line);
      if (!row) { ignored++; return; }
      rows.push(row);
    });
    return { rows: rows, ignored: ignored };
  }

  /* ================= 比对 ================= */

  /* 结果行分类优先级（PRD：先一致、再数量不符、再未提及、再系统无、再无法识别） */
  var CLS_PRIORITY = { ok: 0, warn: 1, miss: 2, nf: 3, unk: 4 };

  /**
   * 解析行 vs 系统库存汇总 → CompareResult
   * @param {{rows:Array, ignored:number}} parsed parseText 产物
   * @param {Array} summary Stock.summarize() 产物 [{name, stock, inQty, outQty}]
   * @returns {{rows:Array, summary:{total,ok,mismatch,missed,notFound,unrecognized}}}
   */
  function compare(parsed, summary) {
    var map = {};
    (summary || []).forEach(function (s) { map[s.name] = s.stock; });
    var referenced = {};   // 系统侧被任一候选命中的货品名集合
    var out = [];
    var cnt = { total: 0, ok: 0, mismatch: 0, missed: 0, notFound: 0, unrecognized: 0 };

    (parsed.rows || []).forEach(function (row) {
      /* 1) 数量超范围 → ⚪ 无法识别 */
      if (row.unrecognized) {
        out.push({ name: row.name, sys: null, shot: row.qty, cls: "unk", ambiguous: false, diff: null, qty: row.qty, reason: "数量超范围" });
        cnt.unrecognized++; cnt.total++;
        return;
      }
      /* 2) 无候选命中：有数量 → ❌ 系统无此货品；无数量（行格式异常）→ ⚪ 无法识别 */
      if (!row.candidates.length) {
        var isUnk = row.qty === null;
        out.push({
          name: row.name, sys: null, shot: row.qty,
          cls: isUnk ? "unk" : "nf",
          ambiguous: false, diff: null, qty: row.qty,
          reason: isUnk ? "行格式异常" : null
        });
        if (isUnk) cnt.unrecognized++; else cnt.notFound++;
        cnt.total++;
        return;
      }
      /* 3) 候选命中（歧义则多行并列，各标「名称不唯一」） */
      row.candidates.forEach(function (c) {
        referenced[c] = true;
        var sys = (map[c] !== undefined) ? map[c] : null;
        var cls;
        var diff = null;
        if (row.qty === null) {
          cls = "ok";                                  // ✅ 存在（不比较数量）
        } else if (sys !== null && Number(row.qty) === Number(sys)) {
          cls = "ok";                                  // ✅ 一致（严格无容差）
        } else {
          cls = "warn";                                // ⚠️ 数量不符
          diff = (Number(row.qty) || 0) - (Number(sys) || 0);
        }
        out.push({ name: c, sys: sys, shot: row.qty, cls: cls, ambiguous: row.ambiguous, diff: diff, qty: row.qty });
        if (cls === "ok") cnt.ok++; else cnt.mismatch++;
        cnt.total++;
      });
    });

    /* 4) 系统侧未被任何候选命中的货品 → 🔵 截图未提及（全量列出） */
    (summary || []).forEach(function (s) {
      if (!referenced[s.name]) {
        out.push({ name: s.name, sys: s.stock, shot: null, cls: "miss", ambiguous: false, diff: null, qty: null });
        cnt.missed++; cnt.total++;
      }
    });

    /* 按分类分组排序（稳定排序，歧义多行保持相邻） */
    out.sort(function (a, b) {
      var pa = (CLS_PRIORITY[a.cls] !== undefined) ? CLS_PRIORITY[a.cls] : 9;
      var pb = (CLS_PRIORITY[b.cls] !== undefined) ? CLS_PRIORITY[b.cls] : 9;
      return pa - pb;
    });

    return { rows: out, summary: cnt };
  }

  /* ================= Answer 组装 ================= */

  /** CompareRow → 表格单元格 */
  function rowCells(r) {
    var name = r.ambiguous ? r.name + "（名称不唯一）" : r.name;
    var shot = r.qty === null ? "-" : String(r.qty);
    switch (r.cls) {
      case "ok":
        return r.qty === null
          ? [name, String(r.sys), "-", "✅ 存在"]
          : [name, String(r.sys), shot, "✅ 一致"];
      case "warn":
        return [name, r.sys === null ? "-" : String(r.sys), shot, "⚠️ 数量不符（差 " + r.diff + "）"];
      case "miss":
        return [r.name, String(r.sys), "-", "🔵 截图未提及"];
      case "nf":
        return [r.name, "-", shot, "❌ 系统无此货品"];
      case "unk":
      default:
        return [r.name, "-", shot, "⚪ 无法识别（" + (r.reason || "保留原文") + "）"];
    }
  }

  /**
   * 完整核对入口：粘贴文本 → 核对结果 Answer（type:"check"）
   * 原始文本不进入 Answer 的 text 字段；仅结构化比对结果进入 table（决策1 允许历史持久化）。
   * @param {string} text 用户粘贴的库存截图文字
   * @returns {{type:string, title:string, summaryText?:string, table?:Object, chips:string[], guideAct?:Object}}
   */
  function answer(text) {
    var input = String(text == null ? "" : text);
    if (!input.trim()) {
      return {
        type: "check",
        title: "📋 库存核对",
        text: "请从库存截图复制文字后粘贴到弹窗，再点击「开始核对」。",
        chips: ["重新核对"]
      };
    }

    var parsed = parseText(input);
    var summary = Stock.summarize();
    var result = compare(parsed, summary);
    var s = result.summary;

    var title = "📋 库存核对结果（共 " + s.total + " 项）";
    var summaryText = "共比对 " + s.total + " 项：✅一致 " + s.ok +
      " ｜ ⚠️数量不符 " + s.mismatch +
      " ｜ 🔵截图未提及 " + s.missed +
      " ｜ ❌系统无 " + s.notFound +
      " ｜ ⚪无法识别 " + s.unrecognized + " 行";
    if (parsed.ignored > 0) {
      summaryText += "（已忽略无关行 " + parsed.ignored + "）";
    }

    return {
      type: "check",
      title: title,
      summaryText: summaryText,
      table: {
        head: ["货品名称", "系统库存", "截图数量", "结果"],
        rows: result.rows.map(function (r) {
          return { cells: rowCells(r), cls: r.cls };
        })
      },
      chips: ["哪些货品低库存？", "今天出了多少货？", "重新核对"]
    };
  }

  window.App = window.App || {};
  window.App.AI = window.App.AI || {};
  window.App.AI.Check = {
    parseText: parseText,
    compare: compare,
    answer: answer
  };
})();
