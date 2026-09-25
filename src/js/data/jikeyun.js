/**
 * jikeyun.js — 吉客云订单文字解析（纯函数：零 DOM、零网络、零大模型）
 *
 * 用途：「自动识别」功能区把从吉客云复制出来的订单文字，解析成
 *       待取货 / 出库 / 入库 表单可直接使用的结构化数据。
 *
 * 三个能力：
 *   1. Jikeyun.parseOrderHeader(text)  订单头 → {orders:[{orderNo,customer,warehouse,channel,raw}], hasHeader, usedFallback}
 *   2. Jikeyun.parseItems(text)        货品明细 → {rows:[{raw,name,qty,unit,status,sysName,candidates}], ignored}
 *   3. Jikeyun.matchToSystem(rawName)  货品名 → 系统货品名（三级匹配）
 *
 * 匹配三级（顺序不可调换）：
 *   ① 对照字典命中（App.Dict.lookup）—— 最准，用户可自行维护，越用越准
 *   ② Engine.matchProducts 精确命中且唯一
 *   ③ 多候选时用「规格串收敛」（120ml / 30ml / 50g 这类），筛到唯一即定
 *   仍不唯一 → status:"pick"（待人工下拉选）；无候选 → status:"none"（未识别）
 *
 * 设计要点：优先「表头列定位」——连同表头行一起复制时，按列名找列，不靠列序猜，
 *           吉客云调整列顺序也不会解析错；找不到表头才退回正则/末列数字的宽松兜底。
 *
 * 隐私红线：粘贴原文只在本文件局部变量中解析，绝不写入本地存储 / 云端 / 日志。
 *
 * 挂载到 window.App.Jikeyun。
 */
(function () {
  'use strict';

  /* ================= 常量 ================= */

  /* 订单编号形态：吉客云销售单号 JY + 数字（如 JY20260924007） */
  var ORDER_NO_RE = /\b(JY[A-Za-z0-9]{6,})\b/;

  /* 入库号形态：DB + 数字（如 DB202609240001），整行只有它 */
  var INBOUND_NO_RE = /^(DB[A-Za-z0-9]{6,})$/;

  /* 表头列名关键词（宽松匹配，容忍吉客云改叫法） */
  var HEAD_ORDER_NO  = /订单编号|订单号|销售单号|单据编号/;
  var HEAD_CUSTOMER  = /客户账号|客户名称|客户|账号|收货人/;
  var HEAD_WAREHOUSE = /发货仓库|仓库/;
  var HEAD_CHANNEL   = /销售渠道|渠道/;
  var HEAD_ITEM_NAME = /货品名称|商品名称|货品|商品|品名|货物名称/;
  var HEAD_QTY       = /数量|件数/;
  var HEAD_UNIT      = /单位/;

  /* 噪声行（合计/小计等）：复制出来的合计行常带数字（如「合计6」「合计 6」），
     故合计类用「前缀匹配」；备注/操作/序号这类短标签用「整串匹配」，避免误伤真正叫这个名字的货品。 */
  var NOISE_PREFIX = /^(合计|小计|总计|共计|总数量|总金额|金额合计|合计数量|本页合计|总计金额|总计数量)/;
  var NOISE_EXACT = /^(备注|操作|序号|备注说明)$/;

  /* 数量合法范围 */
  var QTY_MIN = 1;
  var QTY_MAX = 99999;

  /* 规格串：数字 + 常见单位（用于第三级消歧） */
  var SPEC_RE = /\d+(?:\.\d+)?\s*(?:ml|ML|Ml|g|G|支|片|瓶|袋|盒|包|套|kg|KG)/g;

  /* ================= 工具 ================= */

  /** 拆行：兼容 \r\n / \n / \r */
  function toLines(text) {
    return String(text == null ? "" : text).split(/\r\n|\r|\n/);
  }

  /** 单元格切分：优先制表符；无制表符时按 2 个以上半角空格 / 全角空格切 */
  function splitCells(line) {
    var s = String(line == null ? "" : line);
    var arr = (s.indexOf("\t") !== -1) ? s.split("\t") : s.split(/[ ]{2,}|[\u3000]+/);
    return arr.map(function (c) { return String(c == null ? "" : c).trim(); });
  }

  /** 归一化：小写 → 非中文/字母/数字转空格 → 折叠空格（与 Engine.normalize 同规则） */
  function normName(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** 在单元格数组里找第一个匹配 re 的列索引；未命中返回 -1 */
  function findCol(cells, re) {
    for (var i = 0; i < cells.length; i++) {
      if (cells[i] && re.test(cells[i])) return i;
    }
    return -1;
  }

  /** 行是否可忽略（空白 / 纯符号 / 合计小计等噪声行） */
  function isNoiseRow(line) {
    var s = String(line == null ? "" : line).replace(/[\s|｜·\-—]+/g, "");
    if (!s) return true;
    return NOISE_PREFIX.test(s) || NOISE_EXACT.test(s);
  }

  /* 表头词（单元格「整串」匹配用）：用于识别「表头行」。
     场景：「自动识别」页两个粘贴框会交叉解析（用户把全部内容粘到任一框也能认出），
     于是订单列表的表头行会串进货品解析，被误当成一行货品。 */
  var HEAD_CELL = /^(标记|序号|订单编号|订单号|销售单号|单据编号|订单状态|状态|销售渠道|渠道|发货仓库|仓库|客户账号|客户名称|客户|收货人|收件人|制单人|经办人|货品名称|商品名称|货品|商品|品名|货物名称|规格|型号|数量|件数|单位|单价|金额|总价|含税单价|备注|操作)$/;

  /**
   * 行是否像「表头行」：≥2 个单元格本身就等于某个表头词。
   * 要求「整串相等」而非包含，避免把「精华液 20支装」这类真实货品名误判成表头。
   */
  function isHeaderLikeRow(line) {
    var cells = splitCells(line);
    if (cells.length < 2) return false;
    var hit = 0;
    for (var i = 0; i < cells.length; i++) {
      var c = String(cells[i] == null ? "" : cells[i]).trim();
      if (c && HEAD_CELL.test(c)) {
        hit++;
        if (hit >= 2) return true;
      }
    }
    return false;
  }

  /** 行是否像订单数据行（含 JY 单号） */
  function isOrderRow(line) {
    return ORDER_NO_RE.test(String(line == null ? "" : line));
  }

  /** 行是否「整行就是入库号」（如 DB202609240001） */
  function isInboundNoRow(line) {
    return INBOUND_NO_RE.test(String(line == null ? "" : line).trim());
  }

  /** 从文本里抽取规格串（去重、去空格、小写），如 "120ml" */
  function extractSpecs(text) {
    var m = String(text == null ? "" : text).match(SPEC_RE) || [];
    var out = [];
    m.forEach(function (s) {
      var k = s.replace(/\s+/g, "").toLowerCase();
      if (k && out.indexOf(k) === -1) out.push(k);
    });
    return out;
  }

  /** 内容是否已归一化形态（字典 from 存归一化值，便于比对） */
  function hasSpec(sysName, spec) {
    return normName(sysName).replace(/\s+/g, "").indexOf(spec) !== -1;
  }

  /* ================= 订单头解析 ================= */

  /**
   * 解析订单列表文字 → 订单头候选。
   * 优先级：① 表头列定位（推荐，连同表头一起复制）→ ② 全文正则兜底。
   * @param {string} text 用户粘贴的订单列表文字（仅内存使用）
   * @returns {{orders:Array<{orderNo:string,customer:string,warehouse:string,channel:string,raw:string}>,
   *            hasHeader:boolean, usedFallback:boolean}}
   */
  function parseOrderHeader(text) {
    var lines = toLines(text);
    var out = { kind: "none", customer: "", orderNo: "", inboundNo: "", orders: [], hasHeader: false, usedFallback: false };
    var headIdx = -1;
    var noCol = -1, custCol = -1, whCol = -1, chCol = -1;
    var i, j;

    /* ⓪ 首行「头信息」识别（主理人 2026-09-26 实测格式，优先于表头列定位）：
          · 待取货 / 出库：第 1 行是「客户账号 + 订单编号」（制表符分隔），如「华大智造 JY202609240007」
          · 入库：第 1 行整行就是入库号，如「DB202609240001」（它要填进「用途」）
       先定位第一个有效行判断属于哪种；都不是才退回下面的表头列定位。 */
    var firstIdx = -1;
    for (i = 0; i < lines.length; i++) {
      var t0 = String(lines[i] == null ? "" : lines[i]).trim();
      if (t0 && !isNoiseRow(t0)) { firstIdx = i; break; }
    }
    if (firstIdx !== -1) {
      var firstLine = String(lines[firstIdx]).trim();
      if (!isHeaderLikeRow(firstLine)) {
        /* A. 整行就是入库号 */
        if (isInboundNoRow(firstLine)) {
          out.kind = "in";
          out.inboundNo = firstLine;
          return out;
        }
        /* B. 客户账号 + 订单编号（两格及以上） */
        var headCells = splitCells(firstLine);
        if (headCells.length >= 2) {
          var oIdx = -1, ci;
          for (ci = 0; ci < headCells.length; ci++) {
            if (/^JY[A-Za-z0-9]{6,}$/i.test(headCells[ci])) { oIdx = ci; break; }
          }
          if (oIdx !== -1) {
            out.kind = "out";
            out.orderNo = headCells[oIdx];
            for (ci = 0; ci < headCells.length; ci++) {
              if (ci === oIdx) continue;
              var cval = headCells[ci];
              if (cval && !/^JY[A-Za-z0-9]+$/i.test(cval)) { out.customer = cval; break; }
            }
            return out;
          }
          /* 单号与客户账号同格、被空格分开：如「华大智造 JY202609240007」 */
          var mAny = firstLine.match(ORDER_NO_RE);
          if (mAny) {
            out.kind = "out";
            out.orderNo = mAny[1];
            out.customer = firstLine.replace(mAny[1], "").replace(/[\t\s|｜]+/g, " ").trim();
            return out;
          }
        }
        /* C. 只有单号 */
        var mOnly = firstLine.match(ORDER_NO_RE);
        if (mOnly) { out.kind = "out"; out.orderNo = mOnly[1]; return out; }
      }
    }

    /* ① 找表头行：同时给出「订单编号」与「客户账号」最佳；退而求其次含其一 */
    for (i = 0; i < lines.length; i++) {
      var hc = splitCells(lines[i]);
      if (hc.length < 2) continue;
      var iNo = findCol(hc, HEAD_ORDER_NO);
      var iCust = findCol(hc, HEAD_CUSTOMER);
      if (iNo === -1 && iCust === -1) continue;
      /* 货品明细表头（含货品名称）不算订单表头，避免误判 */
      if (findCol(hc, HEAD_ITEM_NAME) !== -1 && iNo === -1) continue;
      headIdx = i; noCol = iNo; custCol = iCust;
      whCol = findCol(hc, HEAD_WAREHOUSE);
      chCol = findCol(hc, HEAD_CHANNEL);
      break;
    }

    if (headIdx !== -1) {
      out.hasHeader = true;
      for (j = headIdx + 1; j < lines.length; j++) {
        if (isNoiseRow(lines[j])) continue;
        var cells = splitCells(lines[j]);
        if (!cells.length) continue;
        var no = (noCol !== -1) ? String(cells[noCol] || "").trim() : "";
        /* 订单号列取不到时，退回在本行里正则抓 —— 容忍列错位 */
        if (!no) {
          var mm = String(lines[j]).match(ORDER_NO_RE);
          if (mm) no = mm[1];
        }
        if (!no) continue;
        out.orders.push({
          orderNo: no,
          customer: (custCol !== -1) ? String(cells[custCol] || "").trim() : "",
          warehouse: (whCol !== -1) ? String(cells[whCol] || "").trim() : "",
          channel: (chCol !== -1) ? String(cells[chCol] || "").trim() : "",
          raw: lines[j]
        });
      }
    }

    /* ② 兜底：全文正则扫单号（无表头 / 表头列取不到时） */
    if (!out.orders.length) {
      out.usedFallback = true;
      for (i = 0; i < lines.length; i++) {
        if (isNoiseRow(lines[i])) continue;
        var m = String(lines[i]).match(ORDER_NO_RE);
        if (!m) continue;
        var seen = false;
        for (j = 0; j < out.orders.length; j++) {
          if (out.orders[j].orderNo === m[1]) { seen = true; break; }
        }
        if (seen) continue;
        out.orders.push({ orderNo: m[1], customer: "", warehouse: "", channel: "", raw: lines[i] });
      }
    }

    return out;
  }

  /* ================= 货品明细解析 ================= */

  /**
   * 解析货品明细文字 → 货品行（含系统货品名匹配结果）。
   * 优先级：① 表头列定位（货品名称 + 数量）→ ② 制表符末列数字 → ③ 常规「名 + 数量」正则。
   * 自动跳过：空白行、合计小计行、订单行（含 JY 单号，避免把订单列表误当明细）。
   * @param {string} text 用户粘贴的货品明细文字（仅内存使用）
   * @returns {{rows:Array<{raw:string,name:string,qty:number|null,unit:string,status:string,sysName:string,candidates:string[]}>, ignored:number}}
   */
  function parseItems(text) {
    var lines = toLines(text);
    var rows = [];
    var ignored = 0;
    var headIdx = -1, nameCol = -1, qtyCol = -1, unitCol = -1;
    var i;

    /* ① 找明细表头：必须同时含「货品名称」类与「数量」类 */
    for (i = 0; i < lines.length; i++) {
      var hc = splitCells(lines[i]);
      if (hc.length < 2) continue;
      var iName = findCol(hc, HEAD_ITEM_NAME);
      var iQty = findCol(hc, HEAD_QTY);
      if (iName !== -1 && iQty !== -1) {
        headIdx = i; nameCol = iName; qtyCol = iQty;
        unitCol = findCol(hc, HEAD_UNIT);
        break;
      }
    }

    for (i = 0; i < lines.length; i++) {
      if (i === headIdx) { ignored++; continue; }              /* 表头行本身不算明细 */
      var line = String(lines[i] == null ? "" : lines[i]).trim();
      if (isNoiseRow(line)) { ignored++; continue; }
      if (isHeaderLikeRow(line)) { ignored++; continue; }      /* 表头行（交叉解析时订单表头会串进来） */
      if (isInboundNoRow(line)) { ignored++; continue; }      /* 入库号不是货品 */
      if (isOrderRow(line)) { ignored++; continue; }           /* 订单行不是货品明细 */           /* 订单行不是货品明细 */

      var name = "", qty = null, unit = "";

      if (headIdx !== -1) {
        /* 表头定位模式 */
        var cells = splitCells(line);
        if (cells.length <= Math.max(nameCol, qtyCol)) { ignored++; continue; }
        name = String(cells[nameCol] || "").trim();
        var qRaw = String(cells[qtyCol] || "").trim();
        var qNum = Number(qRaw);
        if (qRaw !== "" && isFinite(qNum)) qty = qNum;
        if (unitCol !== -1) unit = String(cells[unitCol] || "").trim();
        /* 规格等附加列并进货品名，提升匹配命中率 */
        cells.forEach(function (c, idx) {
          if (idx === nameCol || idx === qtyCol || idx === unitCol) return;
          if (!c) return;
          if (/^\d+(?:\.\d+)?$/.test(c)) return;                /* 纯数字列（如序号/单价）不并入 */
          if (HEAD_QTY.test(c) || HEAD_ITEM_NAME.test(c)) return;
          if (!/[\u4e00-\u9fa5a-z]/i.test(c)) return;
          if (name.indexOf(c) === -1) name = name + " " + c;
        });
      } else if (line.indexOf("\t") !== -1) {
        /* ② 制表符模式：取最后一列纯数字为数量，其余非数字列合并为货品名 */
        var cs = splitCells(line);
        var qtyIdx = -1;
        for (var k = cs.length - 1; k >= 0; k--) {
          if (/^\d+(?:\.\d+)?$/.test(cs[k])) { qtyIdx = k; break; }
        }
        var parts = [];
        cs.forEach(function (c, idx) {
          if (idx === qtyIdx) return;
          if (c && /[\u4e00-\u9fa5a-z]/i.test(c)) parts.push(c);
        });
        name = parts.join(" ").trim();
        if (qtyIdx !== -1) qty = Number(cs[qtyIdx]);
      } else {
        /* ③ 常规行：「名称 + 分隔符 + 数量 + 可选单位」；无数字则只记名称（数量待填） */
        var re = /^(.+?)[\s:：,，、|]+(\d+(?:\.\d+)?)\s*(?:件|个|盒|支|瓶|袋|片|g|ml)?\s*$/;
        var m = line.match(re);
        if (m) {
          name = m[1].trim().replace(/[\s:：,，、|]+$/, "");
          qty = Number(m[2]);
        } else {
          name = line.replace(/[\s:：,，、|]+$/, "");
          qty = null;
        }
      }

      if (!name) { ignored++; continue; }
      /* 剥掉名字尾部残留分隔符 */
      name = name.replace(/[\s:：,，、|]+$/, "").trim();
      if (!name) { ignored++; continue; }
      if (qty !== null && (!isFinite(qty) || qty < 0 || qty > QTY_MAX)) qty = null;

      var matched = matchToSystem(name);
      /* 1:N 展开：字典把同一个吉客云货品对应到多个系统货品时（如「一人一方定制套装礼盒」
         = 大号礼盒 + 大号拎袋），展开成多行，各自可单独删除；数量沿用原数量。 */
      var _names = (matched.sysNames && matched.sysNames.length) ? matched.sysNames : [""];
      _names.forEach(function (nm) {
        rows.push({
          raw: line,
          name: name,
          qty: qty,
          unit: unit,
          status: nm ? "ok" : matched.status,
          sysName: nm || "",
          sysNames: (matched.sysNames || []).slice(),
          candidates: matched.candidates,
          splitOf: _names.length > 1 ? name : ""
        });
      });
    }

    return { rows: rows, ignored: ignored };
  }

  /* ================= 三级匹配 ================= */

  /**
   * 货品名 → 系统货品名。
   * ① 对照字典 → ② Engine.matchProducts 精确唯一 → ③ 规格串收敛消歧。
   * @param {string} rawName 吉客云原始货品名
   * @returns {{sysName:string, status:"ok"|"pick"|"none", candidates:string[]}}
   *          status: ok=已确定；pick=多个候选需人工选；none=完全没匹配上
   */
  function matchToSystem(rawName) {
    var r = _matchToSystem(rawName);
    if (!r.sysNames) r.sysNames = r.sysName ? [r.sysName] : [];
    return r;
  }

  /** 内部实现：字典(支持 1:N) → 精确唯一 → 紧凑包含 → 规格数字收敛 */
  function _matchToSystem(rawName) {
    var raw = String(rawName == null ? "" : rawName).trim();
    if (!raw) return { sysName: "", status: "none", candidates: [] };

    /* ① 字典优先 */
    try {
      var Dict = window.App && window.App.Dict;
      if (Dict && typeof Dict.lookupAll === "function") {
        var hits = Dict.lookupAll(raw);
        if (hits && hits.length) return { sysName: hits[0], sysNames: hits.slice(), status: "ok", candidates: hits.slice() };
      }
      if (Dict && typeof Dict.lookup === "function") {
        var hit = Dict.lookup(raw);
        if (hit) return { sysName: hit, status: "ok", candidates: [hit] };
      }
    } catch (e) {}

    /* ② 模糊匹配器 */
    var matched = { exact: [], fuzzy: [] };
    try {
      var Engine = window.App && window.App.AI && window.App.AI.Engine;
      if (Engine && typeof Engine.matchProducts === "function") {
        matched = Engine.matchProducts(normName(raw));
      }
    } catch (e2) {}
    var exact = matched.exact || [];
    var fuzzy = matched.fuzzy || [];

    if (exact.length === 1) return { sysName: exact[0], status: "ok", candidates: exact.slice() };
    if (exact.length > 1) return { sysName: "", status: "pick", candidates: exact.slice() };

    /* ②b 紧凑包含（去掉全部空格后再比对）：
       matchProducts 对「舒缓精粹水120ml」会把「精粹水 120ml」与「精粹乳 30ml」同时列为 fuzzy
       （共享 token「30ml」造成误命中），但去空格后「舒缓精粹水120ml」只包含「精粹水120ml」一个。
       这一步能在进人工确认之前消掉大量规格歧义，是命中率的关键补强。 */
    var compact = normName(raw).replace(/\s+/g, "");
    if (compact) {
      var prods = (window.App.Config && window.App.Config.PRODUCTS) || [];
      var compactHits = [];
      prods.forEach(function (p) {
        var pc = normName(p).replace(/\s+/g, "");
        if (pc && compact.indexOf(pc) !== -1) compactHits.push(p);
      });
      if (compactHits.length === 1) {
        return { sysName: compactHits[0], status: "ok", candidates: compactHits.slice() };
      }
      if (compactHits.length > 1) {
        var cSpecs = extractSpecs(raw);
        if (cSpecs.length) {
          var cNarrow = compactHits.filter(function (p2) {
            return cSpecs.some(function (s) { return hasSpec(p2, s); });
          });
          if (cNarrow.length === 1) return { sysName: cNarrow[0], status: "ok", candidates: cNarrow.slice() };
          if (cNarrow.length > 1) return { sysName: "", status: "pick", candidates: cNarrow.slice() };
        }
        return { sysName: "", status: "pick", candidates: compactHits.slice() };
      }
    }

    /* ③ 规格串收敛：用原文里的规格（120ml/50g…）筛候选 */
    if (fuzzy.length) {
      var specs = extractSpecs(raw);
      if (specs.length) {
        var narrowed = fuzzy.filter(function (p) {
          return specs.some(function (s) { return hasSpec(p, s); });
        });
        if (narrowed.length === 1) return { sysName: narrowed[0], status: "ok", candidates: narrowed.slice() };
        if (narrowed.length > 1) return { sysName: "", status: "pick", candidates: narrowed.slice() };
      }
      if (fuzzy.length === 1) return { sysName: fuzzy[0], status: "ok", candidates: fuzzy.slice() };
      return { sysName: "", status: "pick", candidates: fuzzy.slice() };
    }

    return { sysName: "", status: "none", candidates: [] };
  }

  /** 结果目标货品是否在当前系统的货品目录里。
      字典全店共用一份，而深圳 / 赛迪斯的货品目录并不相同（如「大号礼盒」只有赛迪斯有），
      故填入前必须用它校验 —— 撞到「别的仓才有」的货品要给出明确警告，不能静默填进去。 */
  function isInCurrentSystem(sysName) {
    if (!sysName) return false;
    var prods = (window.App.Config && window.App.Config.PRODUCTS) || [];
    return prods.indexOf(sysName) !== -1;
  }

  /** 暴露给视图：规格串抽取（预览区提示用） */
  function specsOf(text) { return extractSpecs(text); }

  window.App = window.App || {};
  window.App.Jikeyun = {
    parseHeader: parseOrderHeader,
    parseOrderHeader: parseOrderHeader,
    isInCurrentSystem: isInCurrentSystem,
    parseItems: parseItems,
    matchToSystem: matchToSystem,
    normName: normName,
    specsOf: specsOf
  };
})();
