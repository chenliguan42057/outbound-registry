/**
 * engine.js — AI 助手 A 部分：本地问答引擎（意图识别 + 数据查询 + 回复构建）
 * 零配置离线可用：仅读 State.list + Stock.getStock/summarize/trend + Config.PRODUCTS/INVENTORY，
 * 不调用任何外部 API；所有数值与报表模块同源，保证数字一致。
 * 挂载到 window.App.AI.Engine。
 */
(function () {
  'use strict';

  var Config = window.App.Config;
  var State = window.App.State;
  var Stock = window.App.Stock;

  /* 记录意图关键词（命中产品名后判断是查库存还是查记录） */
  var RECORD_KW = /领过|领了|记录|领用/;

  /* 意图关键词表（优先级从高到低，见 detectIntent） */
  var KW = {
    help: /帮助|你能做什么|怎么用|会什么|介绍一下|有哪些功能|能做什么/,
    low_stock: /低库存|快没货|不足|缺货|补货|不够/,
    rank: /排行|最多|最少|top|榜首|第一/,
    trend: /趋势|走势|变化|报表/,
    in_out_today: /今天|今日|昨天|昨日/,
    in_out_days: /(最近|近)\s*\d+\s*天|本周|上周|本月|上月/,
    records: /记录|领过|领了|领取人|部门|用途|领用/,
    stock: /库存|还有多少|剩多少|有多少|多少货|查库存/
  };

  /* 记录过滤时的停用词（不作为领取人/部门/用途候选） */
  var STOP_WORDS = /记录|出库|入库|最近|哪些|什么|多少|还有|那个|一些|今天|昨天|今日|昨日|给我|看看|查|一下|的|了|过|有|是|在|和|与|及|请|帮|我|你/;

  /** 补零 */
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  /** 今日日期字符串 YYYY-MM-DD */
  function todayStr(offsetDays) {
    var d = new Date();
    d.setDate(d.getDate() - (offsetDays || 0));
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  /** 去重（保持顺序） */
  function unique(arr) {
    var out = [];
    arr.forEach(function (x) {
      if (out.indexOf(x) === -1) out.push(x);
    });
    return out;
  }

  /** 全部货品汇总并按当前库存降序 */
  function summarizeSorted() {
    return Stock.summarize(State.list).slice().sort(function (a, b) {
      return b.stock - a.stock;
    });
  }

  /* ================= 归一化 ================= */

  /**
   * 输入归一化：toLowerCase → 去全/半角标点（保留中文与数字）→ trim。
   * @param {string} q
   * @returns {string}
   */
  function normalize(q) {
    return String(q == null ? "" : q)
      .toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* ================= 产品匹配 ================= */

  /**
   * 产品名匹配：先精确包含，再按 token 模糊匹配。
   * 模糊规则：token 整体出现在输入中（input.includes(token)）→ 命中；
   * 输入作为 token 子串（token.includes(input)）时，要求 token 长度差 ≤ 4，
   * 避免过宽子串（如「面膜」误命中「精华+面膜手提袋」）——「冻干」仍可命中「冻干精华液」。
   * @param {string} input 已归一化输入
   * @returns {{exact: string[], fuzzy: string[]}}
   */
  function matchProducts(input) {
    var exact = [], fuzzy = [];
    Config.PRODUCTS.forEach(function (p) {
      var lp = p.toLowerCase();
      if (input.indexOf(lp) !== -1) { exact.push(p); return; }
      var tokens = lp.split(/[\s（）()]+/).filter(function (t) { return t.length >= 2; });
      var hit = tokens.some(function (t) {
        if (input.length < 2) return false;
        if (input.indexOf(t) !== -1) return true;              // token 整体在输入中
        if (t.indexOf(input) !== -1) {                          // 输入是 token 子串
          return (t.length - input.length) <= 4;
        }
        return false;
      });
      if (hit) fuzzy.push(p);
    });
    return { exact: exact, fuzzy: fuzzy };
  }

  /* ================= 时间范围提取 ================= */

  /**
   * 提取近 N 天时间范围：/(最近|近)\s*(\d+)\s*天/ → {days}；本周/本月→7；上月→30。
   * @param {string} input
   * @returns {{days: number}|null}
   */
  function extractTimeRange(input) {
    var m = input.match(/(最近|近)\s*(\d+)\s*天/);
    if (m) {
      var n = parseInt(m[2], 10) || 7;
      return { days: Math.min(90, Math.max(1, n)) };
    }
    if (/本月|本周/.test(input)) return { days: 7 };
    if (/上月/.test(input)) return { days: 30 };
    return null;
  }

  /* ================= 意图识别 ================= */

  /**
   * 通用意图识别（无产品命中才进入；优先级从高到低）。
   * @param {string} input 已归一化输入
   * @returns {{intent: string, days?: number, n?: number, dir?: string, date?: string}}
   */
  function detectIntent(input) {
    // 1. help
    if (KW.help.test(input)) return { intent: "help" };
    // 2. low_stock
    if (KW.low_stock.test(input)) return { intent: "low_stock" };
    // 3. rank（若同时带时间范围 → 归入近 N 天聚合统计；带今天/昨天 → 当日统计）
    if (KW.rank.test(input)) {
      var tr = extractTimeRange(input);
      if (tr) return { intent: "in_out_days", days: tr.days };
      if (KW.in_out_today.test(input) && /出|入|领|发/.test(input)) {
        return { intent: "in_out_today", date: /昨天|昨日/.test(input) ? "yesterday" : "today" };
      }
      var n = parseTopN(input);
      var dir = /最少/.test(input) ? "asc" : "desc";
      return { intent: "rank", n: n, dir: dir };
    }
    // 4. trend
    if (KW.trend.test(input)) {
      var tr2 = extractTimeRange(input);
      return { intent: "trend", days: tr2 ? tr2.days : 7 };
    }
    // 5. in_out_today：今天/昨天 + 出/入/领/发
    if (KW.in_out_today.test(input) && /出|入|领|发/.test(input)) {
      return { intent: "in_out_today", date: /昨天|昨日/.test(input) ? "yesterday" : "today" };
    }
    // 6. in_out_days
    var tr3 = extractTimeRange(input);
    if (tr3) return { intent: "in_out_days", days: tr3.days };
    // 7. records
    if (KW.records.test(input)) return { intent: "records" };
    // 8. stock
    if (KW.stock.test(input)) return { intent: "stock" };
    // 9. fallback
    return { intent: "fallback" };
  }

  /** 提取 TOP N：/前\s*(\d+)/ 或 /top\s*(\d+)/，默认 5 */
  function parseTopN(input) {
    var m = input.match(/前\s*(\d+)/) || input.match(/top\s*(\d+)/);
    if (m) {
      var n = parseInt(m[1], 10) || 5;
      return Math.min(30, Math.max(1, n));
    }
    return 5;
  }

  /* ================= 回复构建 ================= */

  /** 快捷 chips（每条回复附 2-3 个后续引导） */
  function chipsFor(type) {
    var map = {
      stock: ["哪些货品低库存？", "今天出了多少货？", "帮我看看报表"],
      low_stock: ["库存最多的前 5 个货品", "最近出库记录", "帮我看看报表"],
      rank: ["哪些货品低库存？", "今天出了多少货？", "帮我看看报表"],
      trend: ["今天出了多少货？", "哪些货品低库存？", "最近出库记录"],
      stats: ["帮我看看报表", "最近出库记录", "哪些货品低库存？"],
      records: ["今天出了多少货？", "哪些货品低库存？", "帮我看看报表"],
      help: Config.AI_QUICK_CHIPS.slice(),
      fallback: Config.AI_QUICK_CHIPS.slice()
    };
    return map[type] || Config.AI_QUICK_CHIPS.slice();
  }

  /** 库存查询（命中产品名） */
  function stockAnswer(names) {
    var rows = [];
    if (names && names.length) {
      rows = names.map(function (name) {
        var stock = Stock.getStock(name);
        return { cells: [name, String(stock)], low: stock < Config.LOW_STOCK_THRESHOLD };
      });
    } else {
      rows = summarizeSorted().map(function (x) {
        return { cells: [x.name, String(x.stock)], low: x.stock < Config.LOW_STOCK_THRESHOLD };
      });
    }
    return {
      type: "stock",
      title: names && names.length ? "📦 库存查询（命中 " + names.length + " 个规格）" : "📦 当前库存总览",
      table: { head: ["货品名称", "当前库存"], rows: rows },
      chips: chipsFor("stock")
    };
  }

  /** 低库存预警 */
  function lowStockAnswer() {
    var low = summarizeSorted().filter(function (x) { return x.stock < Config.LOW_STOCK_THRESHOLD; });
    if (!low.length) {
      return {
        type: "low_stock",
        title: "⚠️ 低库存预警",
        text: "暂无低库存货品（阈值 " + Config.LOW_STOCK_THRESHOLD + " 件）。",
        chips: chipsFor("low_stock")
      };
    }
    return {
      type: "low_stock",
      title: "⚠️ 低库存货品（< " + Config.LOW_STOCK_THRESHOLD + " 件）",
      table: {
        head: ["货品名称", "当前库存"],
        rows: low.map(function (x) {
          return { cells: [x.name, String(x.stock)], low: true };
        })
      },
      chips: chipsFor("low_stock")
    };
  }

  /** 库存排行 */
  function rankAnswer(intent) {
    var arr = summarizeSorted();
    if (intent.dir === "asc") arr = arr.slice().sort(function (a, b) { return a.stock - b.stock; });
    var top = arr.slice(0, intent.n || 5);
    return {
      type: "rank",
      title: "🏆 库存排行 TOP " + top.length + (intent.dir === "asc" ? "（最少）" : "（最多）"),
      table: {
        head: ["货品名称", "当前库存"],
        rows: top.map(function (x) {
          return { cells: [x.name, String(x.stock)], low: x.stock < Config.LOW_STOCK_THRESHOLD };
        })
      },
      chips: chipsFor("rank")
    };
  }

  /** 出入库趋势（近 N 天按日聚合；含「报表」关键词附出库 TOP 摘要） */
  function trendAnswer(input, intent) {
    var days = intent.days || 7;
    var trend = Stock.trend(State.list, days);
    var lines = trend.map(function (t) {
      return t.date.slice(5) + "：出 " + t.outQty + " 件 / 入 " + t.inQty + " 件";
    });
    if (/报表/.test(input)) {
      var agg = aggregateByProduct(days);
      if (agg.topOut.length) {
        lines.push("出库 TOP：");
        agg.topOut.forEach(function (x, i) {
          lines.push((i + 1) + ". " + x.name + "（" + x.outQty + " 件）");
        });
      }
    }
    return {
      type: "trend",
      title: "📈 近 " + days + " 天出入库趋势",
      text: lines.join("\n"),
      chips: chipsFor("trend")
    };
  }

  /** 当日出入库统计 */
  function todayAnswer(intent) {
    var offset = intent.date === "yesterday" ? 1 : 0;
    var dateStr = todayStr(offset);
    var label = intent.date === "yesterday" ? "昨天" : "今天";
    var outQty = 0, inQty = 0, outCnt = 0, inCnt = 0;
    State.list.forEach(function (r) {
      if (String(r.time || "").slice(0, 10) !== dateStr) return;
      var qty = (r.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
      if ((r.type || "out") === "in") { inQty += qty; inCnt++; }
      else { outQty += qty; outCnt++; }
    });
    return {
      type: "stats",
      title: "🗓 " + label + "出入库统计（" + dateStr + "）",
      text: label + "出库 " + outQty + " 件（" + outCnt + " 条记录）；入库 " + inQty + " 件（" + inCnt + " 条记录）。",
      chips: chipsFor("stats")
    };
  }

  /** 近 N 天按货品聚合（出库量排行 TOP5 + 总量摘要） */
  function daysAnswer(intent) {
    var days = intent.days || 7;
    var agg = aggregateByProduct(days);
    var text = "近 " + days + " 天出库 " + agg.totalOut + " 件（" + agg.outCnt + " 条记录）；入库 " +
      agg.totalIn + " 件（" + agg.inCnt + " 条记录）。";
    var top = agg.topOut.slice(0, 5);
    var rows = top.map(function (x) {
      return { cells: [x.name, String(x.outQty), String(x.inQty)], low: false };
    });
    var ans = {
      type: "stats",
      title: "📊 近 " + days + " 天出入库统计",
      text: text,
      chips: chipsFor("stats")
    };
    if (rows.length) {
      ans.table = {
        head: ["货品名称", "出库件数", "入库件数"],
        rows: rows
      };
      ans.text += "\n出库 TOP" + rows.length + " 如上表。";
    }
    return ans;
  }

  /** 近 N 天按货品聚合出库量 */
  function aggregateByProduct(days) {
    var from = todayStr(days - 1);
    var map = {};
    var outCnt = 0, inCnt = 0;
    var totalOut = 0, totalIn = 0;
    State.list.forEach(function (r) {
      var t = String(r.time || "").slice(0, 10);
      if (t < from || t > todayStr(0)) return;
      var isIn = (r.type || "out") === "in";
      var qty = 0;
      (r.items || []).forEach(function (it) {
        var q = Number(it.qty) || 0;
        qty += q;
        var key = it.name || "未知货品";
        map[key] = map[key] || { name: key, outQty: 0, inQty: 0 };
        if (isIn) map[key].inQty += q; else map[key].outQty += q;
      });
      if (isIn) { inCnt++; totalIn += qty; } else { outCnt++; totalOut += qty; }
    });
    var topOut = Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.outQty - a.outQty || b.inQty - a.inQty; });
    return { topOut: topOut, totalOut: totalOut, totalIn: totalIn, outCnt: outCnt, inCnt: inCnt };
  }

  /** 记录检索：默认最近 10 条；按领取人/部门/用途/货品过滤 */
  function recordsAnswer(question, input, productNames) {
    var list = State.list;
    var typeFilter = null;
    if (/入库记录|入库的/.test(input)) typeFilter = "in";
    else if (/出库记录|出库的/.test(input)) typeFilter = "out";
    if (typeFilter) {
      list = list.filter(function (r) {
        return typeFilter === "in" ? (r.type || "out") === "in" : (r.type || "out") !== "in";
      });
    }

    var person = resolvePersonDept(input);
    if (productNames && productNames.length) {
      list = list.filter(function (r) {
        return (r.items || []).some(function (it) { return productNames.indexOf(it.name) !== -1; });
      });
    } else if (person) {
      var key = person.dept ? "dept" : "picker";
      var val = person.dept || person.picker;
      list = list.filter(function (r) { return String(r[key] || "").indexOf(val) !== -1; });
    } else {
      var known = extractKnownValue(input);
      if (known) {
        list = list.filter(function (r) {
          return String(r.picker || "").indexOf(known) !== -1 ||
            String(r.dept || "").indexOf(known) !== -1 ||
            String(r.purpose || "").indexOf(known) !== -1;
        });
      }
    }

    var top = list.slice(0, 10);
    if (!top.length) {
      return {
        type: "records",
        title: "📋 出库记录",
        text: "没有找到匹配的记录。",
        chips: chipsFor("records")
      };
    }
    var rows = top.map(function (r) {
      var items = (r.items || []).map(function (it) { return it.name + "×" + it.qty; }).join("；");
      var st = window.App.Records.getStatus(r);
      var stLabel = st === "pending" ? "未提单" : (st === "submitted" ? "已提单" : "入库");
      return {
        cells: [r.time || "", r.picker || "-", r.dept || "-", r.purpose || "-", items || "-", stLabel],
        low: false
      };
    });
    var filterDesc = person ? ("（" + (person.dept || person.picker) + "）") :
      (productNames && productNames.length ? "（货品：" + productNames.join("、") + "）" : "");
    return {
      type: "records",
      title: "📋 记录检索" + filterDesc + "（最近 " + top.length + " 条）",
      table: {
        head: ["时间", "领取人", "部门", "用途", "货品×数量", "状态"],
        rows: rows
      },
      chips: chipsFor("records")
    };
  }

  /** 解析「张三领过什么」→ picker=张三；若该值更匹配部门则视为 dept */
  function resolvePersonDept(input) {
    var m = input.match(/([\u4e00-\u9fa5]{1,8})(领过|领了|领取|领用)/);
    if (!m) return null;
    var cand = m[1];
    if (!cand || STOP_WORDS.test(cand)) return null;
    var asDept = State.list.some(function (r) { return String(r.dept || "") === cand; });
    var asPicker = State.list.some(function (r) { return String(r.picker || "") === cand; });
    if (asDept && !asPicker) return { dept: cand };
    return { picker: cand };
  }

  /** 从输入中扫描领取人/部门/用途候选（无「领过」句式时兜底） */
  function extractKnownValue(input) {
    var seen = [];
    State.list.forEach(function (r) {
      ["picker", "dept", "purpose"].forEach(function (f) {
        var v = String(r[f] || "").trim();
        if (v.length < 2 || v.length > 12) return;
        if (seen.indexOf(v) !== -1) return;
        if (STOP_WORDS.test(v)) return;
        if (input.indexOf(v) !== -1) seen.push(v);
      });
    });
    return seen.length ? seen[0] : null;
  }

  /** 帮助文案 */
  function helpAnswer() {
    return {
      type: "help",
      title: "🤖 我能帮你做什么？",
      text:
        "我是进销存助手，支持以下查询（全部免费、离线可用）：\n" +
        "1. 库存查询：如「冻干精华液还有多少？」\n" +
        "2. 低库存预警：如「哪些货品低库存？」\n" +
        "3. 今日出入库：如「今天出了多少货？」\n" +
        "4. 近 N 天统计：如「最近 7 天出库最多的是什么？」\n" +
        "5. 记录检索：如「张三领过什么？」\n" +
        "6. 库存排行：如「库存最多的前 5 个货品」\n" +
        "7. 出入库趋势：如「出库趋势怎么样？」\n" +
        "试试下方的快捷问题，或直接输入你的问题。",
      chips: Config.AI_QUICK_CHIPS.slice()
    };
  }

  /** 兜底文案（chat.js 会据此决定是否走 LLM） */
  function fallbackAnswer(question) {
    return {
      type: "fallback",
      title: "🤔 没太明白",
      text:
        "这个问题我暂时答不上来。你可以试试问：\n" +
        "· 冻干精华液还有多少？\n" +
        "· 哪些货品低库存？\n" +
        "· 今天出了多少货？\n" +
        "· 最近有哪些出库记录？\n" +
        "· 库存最多的前 5 个货品",
      chips: Config.AI_QUICK_CHIPS.slice()
    };
  }

  /* ================= 对外入口 ================= */

  /**
   * 主入口：回答问题。
   * @param {string} question 原始用户输入
   * @returns {{type: string, title: string, text?: string, table?: {head: string[], rows: Array}, chips: string[]}}
   */
  function answer(question) {
    var input = normalize(question);
    if (!input) return fallbackAnswer(question);
    var prods = matchProducts(input);
    if (prods.exact.length || prods.fuzzy.length) {
      var names = unique(prods.exact.concat(prods.fuzzy));
      if (RECORD_KW.test(input)) return recordsAnswer(question, input, names);
      return stockAnswer(names);
    }
    var intent = detectIntent(input);
    switch (intent.intent) {
      case "help": return helpAnswer();
      case "low_stock": return lowStockAnswer();
      case "rank": return rankAnswer(intent);
      case "trend": return trendAnswer(input, intent);
      case "in_out_today": return todayAnswer(intent);
      case "in_out_days": return daysAnswer(intent);
      case "records": return recordsAnswer(question, input, null);
      case "stock": return stockAnswer(null);
      default: return fallbackAnswer(question);
    }
  }

  window.App = window.App || {};
  window.App.AI = window.App.AI || {};
  window.App.AI.Engine = {
    normalize: normalize,
    matchProducts: matchProducts,
    detectIntent: detectIntent,
    answer: answer
  };
})();
