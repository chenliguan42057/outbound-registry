/**
 * tools.js — AI 助手本地办公工具（第五轮增量，纯函数，零依赖）
 * 识别顺序（先高精度后宽松）：qrcode → express → money_upper → template →
 *                              date_diff → datetime → unit_convert → calculator
 * 全部输入使用「原始问句」（不归一化），保证日期/金额/表达式中的 - / . 不被破坏。
 * 计算器：自写 tokenizer + 递归下降解析（禁用 eval / new Function），
 *         仅允许数字与 + - * / ( ) . % ^；除零/非法表达式 → 友好提示。
 * 挂载到 window.App.AI.Tools。
 */
(function () {
  'use strict';

  var Knowledge = window.App.AI && window.App.AI.Knowledge ? window.App.AI.Knowledge : null;

  /* ================= 通用 ================= */

  /** 去除问句尾部语气词/标点 */
  function cleanTail(s) {
    return String(s).replace(/[？?！!。，,~～\s]+$/, "").replace(/(?:呢|吗|吧|啊|呀|哦|哈|请问)$/, "").trim();
  }

  /** 便捷 chips */
  function chips(list) { return list || ["计算", "今天几号", "生成二维码 https://example.com"]; }

  /* ================= 1. 二维码 ================= */

  /** 复用 qrcode.js：qrcode(0,"M") → addData → make → createDataURL(5,5) */
  function makeQrDataUrl(content) {
    var qr = qrcode(0, "M");
    qr.addData(content);
    qr.make();
    return qr.createDataURL(5, 5);
  }

  function qrTool(raw) {
    var m = raw.match(/生成\s*(?:二维码|qr码|条码|qr)\s*[:：]?\s*(.+)/i);
    if (!m) {
      // 裸触发词 → 引导输入内容
      if (/^(?:生成二维码|生成qr码|生成条码|二维码|qr码|条码)$/i.test(String(raw).trim())) {
        return {
          type: "tool",
          title: "🔳 二维码生成",
          text: "请提供要生成二维码的内容，如「生成二维码 https://example.com」或「生成二维码 你好」。",
          chips: ["生成二维码 https://example.com", "生成二维码 你好", "今天几号"]
        };
      }
      return null;
    }
    var content = cleanTail(m[1]);
    if (!content) {
      return { type: "tool", title: "🔳 二维码生成", text: "二维码内容不能为空，如「生成二维码 https://example.com」。" };
    }
    if (content.length > 200) {
      return {
        type: "tool",
        title: "🔳 二维码生成",
        text: "内容过长（最多 200 字符，当前 " + content.length + " 字符），请精简后再试。",
        chips: ["生成二维码 https://example.com", "今天几号"]
      };
    }
    var dataUrl = "";
    try {
      dataUrl = makeQrDataUrl(content);
    } catch (e) {
      return { type: "tool", title: "🔳 二维码生成", text: "二维码组件未加载或生成失败，请稍后再试。" };
    }
    return {
      type: "qr",
      title: "🔳 二维码生成",
      content: content,
      dataUrl: dataUrl,
      copyText: content,
      chips: ["生成二维码 https://example.com", "生成二维码 你好", "今天几号"]
    };
  }

  /* ================= 2. 快递识别 ================= */

  function expressTool(raw) {
    var m = raw.match(/快递(?:单号|号)?\s*[:：]?\s*([A-Za-z]{2,4}\d{9,15}|\d{10,15})/) ||
            raw.match(/([A-Za-z]{2,4}\d{9,15}|\d{10,15})\s*(?:是|为)?\s*哪家/);
    if (!m) {
      if (/^(?:快递|快递查询|查快递|查一下快递)$/.test(String(raw).trim())) {
        return {
          type: "tool",
          title: "📦 快递识别",
          text: "请提供快递单号，如「查一下快递 SF1234567890123 是哪家」。",
          chips: ["查一下快递 SF1234567890123 是哪家", "查一下快递 YT1234567890123 是哪家", "今天几号"]
        };
      }
      return null;
    }
    var num = m[1];
    var letter = num.match(/^([A-Za-z]{2,4})(\d+)$/);
    var matched = null;
    if (letter) {
      var prefix = letter[1].toUpperCase();
      var digits = letter[2];
      var rows = (Knowledge && Knowledge.KB && Knowledge.KB.EXPRESS) || [];
      for (var i = 0; i < rows.length; i++) {
        var rule = rows[i];
        var preHit = rule.prefixes.indexOf(prefix) !== -1;
        var lenHit = digits.length >= rule.digits[0] && digits.length <= rule.digits[1];
        if (preHit && lenHit) { matched = rule; break; }
      }
    }
    if (!matched) {
      return {
        type: "tool",
        title: "📦 快递识别",
        text: "未识别出该单号对应的快递公司（已收录：顺丰/圆通/中通/韵达/京东/EMS）。单号：" + num,
        copyText: num,
        chips: ["查一下快递 SF1234567890123 是哪家", "生成二维码 https://example.com", "今天几号"]
      };
    }
    var desc = "";
    if (letter) {
      desc = matched.prefixes.join("/") + " 前缀 + " + letter[2].length + " 位";
    } else {
      desc = matched.name;
    }
    return {
      type: "tool",
      title: "📦 快递识别",
      text: "该单号疑似【" + matched.name + "】（" + desc + "）",
      copyText: num,
      chips: ["查一下快递 YT1234567890123 是哪家", "查一下快递 ZTO123456789012 是哪家", "生成二维码 https://example.com"]
    };
  }

  /* ================= 3. 金额大写 ================= */

  var RMB_DIGITS = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
  var RMB_UNITS = ["", "拾", "佰", "仟"];
  var RMB_BIG = ["", "万", "亿", "万亿"];

  /** 4 位一组转大写 */
  function groupToUpper(g) {
    var res = "";
    var zero = false;
    var len = g.length;
    for (var i = 0; i < len; i++) {
      var d = parseInt(g.charAt(i), 10);
      var pos = len - 1 - i;
      if (d === 0) {
        zero = true;
      } else {
        if (zero && res) res += "零";
        zero = false;
        res += RMB_DIGITS[d] + RMB_UNITS[pos];
      }
    }
    return res;
  }

  /** 整数部分转大写（不含「元」） */
  function intToUpper(num) {
    if (num === 0) return "";
    var s = String(num);
    var result = "";
    var groupIdx = 0;
    while (s.length > 0) {
      var group = s.slice(-4);
      s = s.slice(0, -4);
      var g = groupToUpper(group);
      if (g) {
        result = g + RMB_BIG[groupIdx] + result;
      } else if (result && result.charAt(0) !== "零") {
        result = "零" + result;
      }
      groupIdx++;
    }
    return result;
  }

  /** 人民币大写转换（0 → 零元整；负数 → 负…；最多两位小数） */
  function rmbUpper(n) {
    n = Number(n);
    if (!isFinite(n)) return "";
    if (n === 0) return "零元整";
    if (n < 0) return "负" + rmbUpper(-n);
    n = Math.round(n * 100) / 100;
    var integer = Math.floor(n);
    var decimal = Math.round((n - integer) * 100);
    var out = intToUpper(integer) + "元";
    var jiao = Math.floor(decimal / 10);
    var fen = decimal % 10;
    if (jiao > 0) out += RMB_DIGITS[jiao] + "角";
    if (fen > 0) {
      if (jiao === 0) out += "零";
      out += RMB_DIGITS[fen] + "分";
    }
    if (jiao === 0 && fen === 0) out += "整";
    return out;
  }

  function moneyUpperTool(raw) {
    var m = raw.match(/(\d+(?:\.\d{1,2})?)\s*(?:元)?\s*大写/) ||
            raw.match(/大写\s*[:：]?\s*(\d+(?:\.\d{1,2})?)/);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (isNaN(n)) return null;
    var text = "💰 " + rmbUpper(n);
    return {
      type: "tool",
      title: "💰 金额大写",
      text: text,
      copyText: rmbUpper(n),
      chips: ["12345.67 大写", "0 大写", "今天几号"]
    };
  }

  /* ================= 4. 文案模板 ================= */

  function templateTool(raw) {
    var m = raw.match(/(?:写|生成|来个|帮我写|给个|帮写|写个)\s*(.*?)(?:短信|模板|文案|通知|备注|祝福)/);
    var templates = (Knowledge && Knowledge.KB && Knowledge.KB.TEMPLATES) || [];
    if (!m) {
      // 未匹配到「写…模板」句式但提到了模板类词 → 列出可用模板
      if (/(?:短信|模板|文案|通知|备注|祝福)/.test(raw)) {
        return listTemplates();
      }
      return null;
    }
    var kw = String(m[1] || "").replace(/^(?:个|一条|一个|一条|条|一下|帮我|给我|一个)/, "").trim();
    for (var i = 0; i < templates.length; i++) {
      if (templates[i].key.test(kw)) {
        return {
          type: "tool",
          title: "📝 " + templates[i].name,
          text: templates[i].text,
          copyText: templates[i].text,
          chips: ["写个催货短信", "写个客户通知", "写个中秋祝福"]
        };
      }
    }
    return listTemplates();
  }

  function listTemplates() {
    var templates = (Knowledge && Knowledge.KB && Knowledge.KB.TEMPLATES) || [];
    var names = templates.map(function (t) { return t.name; }).join("、");
    return {
      type: "tool",
      title: "📝 文案模板",
      text: "可用模板：" + names + "。\n试试「写个催货短信」「写个客户通知」「写个中秋祝福」。",
      chips: ["写个催货短信", "写个客户通知", "写个中秋祝福"]
    };
  }

  /* ================= 5. 日期差 ================= */

  function parseDateStr(s) {
    var m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    return null;
  }

  function dateDiffTool(raw) {
    var m = raw.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)\s*(?:到|至|和|与|~|—|－)\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)/);
    if (!m || !/(?:差几天|几天|相隔|间隔)/.test(raw)) return null;
    var d1 = parseDateStr(m[1]);
    var d2 = parseDateStr(m[2]);
    if (!d1 || !d2 || isNaN(d1.getTime()) || isNaN(d2.getTime())) return null;
    var diff = Math.round(Math.abs((d2.getTime() - d1.getTime()) / 86400000));
    var text = "📅 日期差：" + m[1] + " → " + m[2] + " 相差 " + diff + " 天（自然日差）";
    return {
      type: "tool",
      title: "📅 日期差",
      text: text,
      copyText: text,
      chips: ["2026-08-02 到 2026-08-10 差几天", "3天后是哪天", "今天几号"]
    };
  }

  /* ================= 6. 日期时间 ================= */

  var WEEK_CN = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

  function fmtDateCN(d, withYear) {
    var y = d.getFullYear(), mo = d.getMonth() + 1, day = d.getDate();
    if (withYear) return y + "年" + mo + "月" + day + "日";
    return mo + "月" + day + "日";
  }

  function datetimeTool(raw) {
    var now = new Date();

    // ① 指定日期是星期几
    var m1 = raw.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (m1 && /(?:星期|周几|礼拜)/.test(raw)) {
      var y1 = m1[1] || m1[4], mo1 = m1[2] || m1[5], d1 = m1[3] || m1[6];
      var date1 = new Date(+y1, +mo1 - 1, +d1);
      var text1 = y1 + "年" + mo1 + "月" + d1 + "日是" + WEEK_CN[date1.getDay()];
      return {
        type: "tool",
        title: "📅 日期计算",
        text: text1,
        copyText: text1,
        chips: ["今天几号", "3天后是哪天", "2026年8月2日是星期几"]
      };
    }

    // ② 今天几号/星期几
    if (/(?:今天|今日)/.test(raw) && /(?:几号|星期|周几|日期|礼拜)/.test(raw)) {
      var text2 = "今天是 " + fmtDateCN(now, true) + "，" + WEEK_CN[now.getDay()];
      return {
        type: "tool",
        title: "📅 日期计算",
        text: text2,
        copyText: text2,
        chips: ["今天几号", "3天后是哪天", "2026年8月2日是星期几"]
      };
    }

    // ③ 现在几点
    if (/(?:现在|当前)/.test(raw) && /(?:几点|时间|什么时候)/.test(raw)) {
      var pad = function (n) { return (n < 10 ? "0" : "") + n; };
      var text3 = "现在是 " + pad(now.getHours()) + ":" + pad(now.getMinutes()) + "（" + fmtDateCN(now, true) + "）";
      return {
        type: "tool",
        title: "📅 日期计算",
        text: text3,
        copyText: text3,
        chips: ["今天几号", "3天后是哪天", "2026年8月2日是星期几"]
      };
    }

    // ④ N 天前/后
    var m4 = raw.match(/(\d+)\s*(?:天|日)\s*(后|前)/);
    if (m4) {
      var n = parseInt(m4[1], 10) || 0;
      var dir = m4[2] === "后" ? 1 : -1;
      var d4 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dir * n);
      var sameYear = d4.getFullYear() === now.getFullYear();
      var text4 = n + " 天" + (dir > 0 ? "后" : "前") + "是 " + fmtDateCN(d4, !sameYear) + "，" + WEEK_CN[d4.getDay()];
      return {
        type: "tool",
        title: "📅 日期计算",
        text: text4,
        copyText: text4,
        chips: ["今天几号", "3天后是哪天", "2026年8月2日是星期几"]
      };
    }

    // ⑤ 裸触发词 → 引导
    if (/^(?:日期|时间|几号|星期几|今天几号|现在几点)$/.test(String(raw).trim())) {
      return {
        type: "tool",
        title: "📅 日期计算",
        text: "我可以帮你算日期：今天几号、N 天后是哪天、某天是星期几、日期差。试试下面的问题。",
        chips: ["今天几号", "3天后是哪天", "2026年8月2日是星期几"]
      };
    }

    return null;
  }

  /* ================= 7. 单位换算 ================= */

  var LENGTH_UNITS = {
    "公里": 1000, "千米": 1000, "米": 1, "分米": 0.1, "厘米": 0.01, "毫米": 0.001,
    "微米": 0.000001, "里": 500, "英里": 1609.344, "英尺": 0.3048, "英寸": 0.0254, "码": 0.9144
  };
  var WEIGHT_UNITS = {
    "吨": 1000, "千克": 1, "公斤": 1, "克": 0.001, "毫克": 0.000001,
    "斤": 0.5, "两": 0.05, "磅": 0.45359237, "盎司": 0.028349523125
  };
  var VOLUME_UNITS = {
    "升": 1, "毫升": 0.001, "立方米": 1000, "立方厘米": 0.001,
    "加仑": 3.785411784, "品脱": 0.473176473
  };
  var TEMP_UNITS = ["摄氏度", "华氏度", "开尔文"];

  /** 构建货币因子表：人民币基准 1，外币 = 每单位可兑人民币 */
  function currencyUnits() {
    var map = { "人民币": 1, "元": 1, "块": 1 };
    var rows = (Knowledge && Knowledge.KB && Knowledge.KB.CURRENCY) || [];
    for (var i = 0; i < rows.length; i++) {
      map[rows[i].name] = rows[i].toCNY;
      map[rows[i].code.toLowerCase()] = rows[i].toCNY;
    }
    return map;
  }

  function unitConvertTool(raw) {
    var help = {
      type: "tool",
      title: "📐 单位换算",
      text: "支持：长度（公里/米/厘米/毫米）、重量（吨/千克/克/斤/两）、容积（升/毫升）、温度（摄氏/华氏/开尔文）、货币（美元/欧元/人民币等，仅供参考）。试试「5公里等于多少米」。",
      chips: ["5公里等于多少米", "100华氏度等于多少摄氏度", "100美元等于多少人民币"]
    };
    // 裸触发词 → 引导
    if (/^(?:单位换算|换算|换算一下)$/.test(String(raw).trim())) {
      return help;
    }
    // 数字 + 单位A + 必选连接词 + 单位B（单位A 贪心 + 回溯，正确切分「5公里等于多少米」）
    var m = raw.match(/(\d+(?:\.\d+)?)\s*([^\s\d多少]{1,6})\s*(?:等于多少|是多少|等于|换算成|相当于|换成|是|=)\s*([^\s\d多少]{1,6})/);
    if (!m) return null;
    var num = parseFloat(m[1]);
    var ua = m[2].trim();
    var ub = m[3].trim();
    if (isNaN(num) || !ua || !ub) return null;

    // 温度（专用公式）
    if (TEMP_UNITS.indexOf(ua) !== -1 || TEMP_UNITS.indexOf(ub) !== -1) {
      var celsius = null;
      if (ua === "摄氏度") celsius = num;
      else if (ua === "华氏度") celsius = (num - 32) * 5 / 9;
      else if (ua === "开尔文") celsius = num - 273.15;
      else return help;
      var out = null;
      if (ub === "摄氏度") out = celsius;
      else if (ub === "华氏度") out = celsius * 9 / 5 + 32;
      else if (ub === "开尔文") out = celsius + 273.15;
      else return help;
      var r = Math.round(out * 10) / 10;
      var text = num + " " + ua + " = " + r + " " + ub;
      return { type: "tool", title: "📐 单位换算", text: text, copyText: text, chips: ["5公里等于多少米", "100华氏度等于多少摄氏度", "2斤等于多少克"] };
    }

    // 货币
    var ccy = currencyUnits();
    if (ccy[ua] != null && ccy[ub] != null) {
      var v = num * ccy[ua] / ccy[ub];
      var rv = Math.round(v * 100) / 100;
      var textC = num + " " + ua + " = " + rv + " " + ub + "（参考汇率，仅供参考）";
      return { type: "tool", title: "📐 单位换算", text: textC, copyText: textC, chips: ["100美元等于多少人民币", "100人民币等于多少美元", "5公里等于多少米"] };
    }

    // 常规因子表（长度/重量/容积）
    var tables = [LENGTH_UNITS, WEIGHT_UNITS, VOLUME_UNITS];
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      if (t[ua] != null && t[ub] != null) {
        var val = num * t[ua] / t[ub];
        var rounded = Math.round(val * 1000000) / 1000000;
        var textU = num + " " + ua + " = " + rounded + " " + ub;
        return { type: "tool", title: "📐 单位换算", text: textU, copyText: textU, chips: ["5公里等于多少米", "2斤等于多少克", "3升等于多少毫升"] };
      }
    }

    // 未识别单位对 → 友好提示 + 支持列表
    return help;
  }

  /* ================= 8. 计算器 ================= */

  /** 中文数字 → 数字（打折用） */
  var CN_NUM = { "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };

  /** tokenizer：数字 / + - * / ( ) % ^ */
  function tokenize(expr) {
    var tokens = [];
    var i = 0;
    var len = expr.length;
    while (i < len) {
      var c = expr.charAt(i);
      if (c === " " || c === "\t") { i++; continue; }
      if ((c >= "0" && c <= "9") || c === ".") {
        var j = i;
        var dots = 0;
        while (j < len && (/[0-9.]/.test(expr.charAt(j)))) {
          if (expr.charAt(j) === ".") dots++;
          j++;
        }
        if (dots > 1) return { err: "invalid" };
        var numStr = expr.slice(i, j);
        var n = parseFloat(numStr);
        if (isNaN(n)) return { err: "invalid" };
        tokens.push({ type: "num", value: n });
        i = j;
        continue;
      }
      if ("+-*/()^%".indexOf(c) !== -1) {
        tokens.push({ type: c, value: c });
        i++;
        continue;
      }
      return { err: "invalid" };
    }
    return { tokens: tokens };
  }

  /** 递归下降求值：() > ^（右结合）> 一元负号 > * / > + -；% 为后缀 ÷100 */
  function makeParser(tokens) {
    var pos = 0;
    var err = null;
    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }
    function parseExpr() {
      var left = parseTerm();
      while (peek() && (peek().type === "+" || peek().type === "-")) {
        var op = next();
        var right = parseTerm();
        if (op.type === "+") left = { value: left.value + right.value };
        else left = { value: left.value - right.value };
      }
      return left;
    }
    function parseTerm() {
      var left = parseUnary();
      while (peek() && (peek().type === "*" || peek().type === "/")) {
        var op = next();
        var right = parseUnary();
        if (op.type === "*") left = { value: left.value * right.value };
        else {
          if (right.value === 0) { err = "div0"; return left; }
          left = { value: left.value / right.value };
        }
      }
      return left;
    }
    function parseUnary() {
      if (peek() && peek().type === "-") {
        next();
        var v = parseUnary();
        return { value: -v.value };
      }
      return parsePower();
    }
    function parsePower() {
      var base = parsePostfix();
      if (peek() && peek().type === "^") {
        next();
        var exp = parseUnary(); // 右结合
        base = { value: Math.pow(base.value, exp.value) };
      }
      return base;
    }
    function parsePostfix() {
      var atom = parseAtom();
      while (peek() && peek().type === "%") {
        next();
        atom = { value: atom.value / 100 };
      }
      return atom;
    }
    function parseAtom() {
      var t = next();
      if (!t) { err = "invalid"; return { value: 0 }; }
      if (t.type === "num") return { value: t.value };
      if (t.type === "(") {
        var inner = parseExpr();
        var close = next();
        if (!close || close.type !== ")") { err = "invalid"; }
        return { value: inner.value };
      }
      err = "invalid";
      return { value: 0 };
    }
    return {
      run: function () {
        var result = parseExpr();
        if (!err && peek()) err = "invalid";
        return err ? { err: err } : { value: result.value };
      }
    };
  }

  /** 安全求值：返回 {value} 或 {err} */
  function safeEval(expr) {
    // 前置校验：括号配对
    var depth = 0;
    for (var i = 0; i < expr.length; i++) {
      var c = expr.charAt(i);
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth < 0) return { err: "invalid" };
      }
    }
    if (depth !== 0) return { err: "invalid" };
    // 无连续运算符（允许开头负号）
    if (/([+\-*/^%]\s*[+\-*/^%])/.test(expr.replace(/^-\s*/, ""))) {
      var s = expr.replace(/^-\s*/, "");
      if (/([+\-*/^%]\s*[+\-*/^%])/.test(s)) return { err: "invalid" };
    }
    if (!/[+\-*/^%]/.test(expr)) return { err: "noop" }; // 无运算符 → 不算
    var tk = tokenize(expr);
    if (tk.err) return { err: "invalid" };
    if (!tk.tokens.length) return { err: "invalid" };
    return makeParser(tk.tokens).run();
  }

  function round6(x) {
    var r = Math.round(x * 1000000) / 1000000;
    // 去尾零（Number 转字符串自动省略，如 0.30000000000000004 → 0.3）
    return r;
  }

  function calcResultText(expr, value) {
    var display = expr.replace(/\*/g, "×").replace(/\//g, "÷").replace(/\^/g, "^");
    return display + " = " + String(round6(value));
  }

  function calculatorTool(raw) {
    var r = String(raw).trim();

    // ① 打折
    var mDisc = r.match(/(\d+(?:\.\d+)?)\s*打\s*([0-9一二三四五六七八九十])\s*折/) ||
                r.match(/打\s*([0-9一二三四五六七八九十])\s*折/);
    if (mDisc) {
      var base = mDisc[1] ? parseFloat(mDisc[1]) : null;
      var disc = CN_NUM[mDisc[2]] != null ? CN_NUM[mDisc[2]] : parseInt(mDisc[2], 10);
      if (base == null) {
        return {
          type: "tool",
          title: "🧮 计算器",
          text: "请提供原价，如「100 打八折」= 80。",
          chips: ["100 打八折", "123*45+67", "2 的 10 次方"]
        };
      }
      var v = base * disc / 10;
      var text = base + " 打" + mDisc[2] + "折 = " + round6(v) + "（" + base + "×" + (disc / 10) + "）";
      return { type: "tool", title: "🧮 计算器", text: text, copyText: text, chips: ["100 打八折", "500 的 20%", "2 的 10 次方"] };
    }

    // ② 增减百分比
    var mInc = r.match(/(\d+(?:\.\d+)?)\s*(增加|上涨|提高|减少|降低)\s*(\d+(?:\.\d+)?)%/);
    if (mInc) {
      var base2 = parseFloat(mInc[1]);
      var pct = parseFloat(mInc[3]);
      var inc = mInc[2] === "增加" || mInc[2] === "上涨" || mInc[2] === "提高";
      var v2 = inc ? base2 * (1 + pct / 100) : base2 * (1 - pct / 100);
      var text2 = base2 + (inc ? "增加" : "减少") + pct + "% = " + round6(v2);
      return { type: "tool", title: "🧮 计算器", text: text2, copyText: text2, chips: ["100 增加 20%", "100 减少 15%", "123*45+67"] };
    }

    // ③ 百分比
    var mPct = r.match(/(\d+(?:\.\d+)?)\s*(?:的)?\s*(\d+(?:\.\d+)?)%/);
    if (mPct && /%/.test(r)) {
      var base3 = parseFloat(mPct[1]);
      var pct3 = parseFloat(mPct[2]);
      var v3 = base3 * pct3 / 100;
      var text3 = base3 + " 的 " + pct3 + "% = " + round6(v3);
      return { type: "tool", title: "🧮 计算器", text: text3, copyText: text3, chips: ["500 的 20%", "100 打八折", "2 的 10 次方"] };
    }

    // ④ 幂
    var mPow = r.match(/(\d+)\s*的\s*(\d+)\s*(次方|平方|立方)/);
    if (mPow) {
      var baseP = parseInt(mPow[1], 10);
      var expP = mPow[3] === "平方" ? 2 : (mPow[3] === "立方" ? 3 : parseInt(mPow[2], 10));
      var vP = Math.pow(baseP, expP);
      var textP = baseP + " 的 " + (mPow[3] === "次方" ? expP + " 次方" : mPow[3]) + " = " + String(round6(vP));
      return { type: "tool", title: "🧮 计算器", text: textP, copyText: textP, chips: ["2 的 10 次方", "3 的平方", "123*45+67"] };
    }

    // ⑤ 通用表达式
    var expr = r
      .replace(/[？?！!，。；、~～=＝]/g, "")
      .replace(/请问|等于多少|等于|是多少|多少|帮我算|帮我计算|算一下|计算|算算|结果/g, "")
      .trim();
    if (/^[\d.+\-*/().%^]+$/.test(expr) && /[+\-*/^%]/.test(expr)) {
      var res = safeEval(expr);
      if (res.err === "div0") {
        return { type: "tool", title: "🧮 计算器", text: "除数不能为 0，请检查表达式。", chips: ["123*45+67", "100 打八折", "2 的 10 次方"] };
      }
      if (res.err === "noop") return null;
      if (res.err) {
        return { type: "tool", title: "🧮 计算器", text: "表达式不合法，请检查后重试（仅支持数字与 + - * / ( ) % ^）。", chips: ["123*45+67", "100 打八折", "2 的 10 次方"] };
      }
      if (Math.abs(res.value) > 1e15) {
        return { type: "tool", title: "🧮 计算器", text: "数字过大，超出计算范围。", chips: ["123*45+67", "100 打八折"] };
      }
      var text5 = calcResultText(expr, res.value);
      return { type: "tool", title: "🧮 计算器", text: text5, copyText: text5, chips: ["123*45+67", "500 的 20%", "2 的 10 次方"] };
    }

    // ⑥ 裸触发词 → 引导
    if (/^(?:计算|计算器|帮我算|帮我算一下|算一下|算)$/.test(r)) {
      return {
        type: "tool",
        title: "🧮 计算器",
        text: "我可以帮你计算：四则运算（123*45+67）、打折（100 打八折）、百分比（500 的 20%）、乘方（2 的 10 次方）。",
        chips: ["123*45+67", "100 打八折", "2 的 10 次方"]
      };
    }

    return null;
  }

  /* ================= 对外入口 ================= */

  /**
   * 工具识别主入口（按高精度→宽松顺序，命中即返回）。
   * @param {string} raw 原始问句（未归一化）
   * @returns {?{type:string, title:string, text?:string, content?:string, dataUrl?:string, copyText?:string, chips?:string[]}}
   */
  function answer(raw) {
    if (!raw) return null;
    var r;
    r = qrTool(raw); if (r) return r;
    r = expressTool(raw); if (r) return r;
    r = moneyUpperTool(raw); if (r) return r;
    r = templateTool(raw); if (r) return r;
    r = dateDiffTool(raw); if (r) return r;
    r = datetimeTool(raw); if (r) return r;
    r = unitConvertTool(raw); if (r) return r;
    r = calculatorTool(raw); if (r) return r;
    return null;
  }

  window.App = window.App || {};
  window.App.AI = window.App.AI || {};
  window.App.AI.Tools = {
    answer: answer,
    calc: calculatorTool,
    convertUnit: unitConvertTool,
    dateCalc: datetimeTool,
    rmbUpper: rmbUpper,
    safeEval: safeEval
  };
})();
