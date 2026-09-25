/**
 * views/recognize.js — 「自动识别」功能区（#/app/ai，2026-09-26 替代原 AI 助手页）
 *
 * 做什么：把从吉客云复制出来的订单文字粘贴进来 → 本地纯规则解析 → 填入待取货 / 出库 / 入库表单。
 *          全程不调用大模型、不需要 API Key、粘贴原文只在内存里过一遍，不落库。
 *
 * 布局：目标页面（待取货 / 出库 / 入库）三选一 + ①订单信息 ②货品明细 两个粘贴框
 *       → 识别结果预览（可编辑，货品名必须从系统货品下拉里选）→ 填入表单。
 *
 * 跨页传参：识别结果经 takePending(viewName) 交给目标视图消费（目标视图 render 末尾拉取）。
 *
 * 安全铁律：ProductPicker.setSelected 不校验 Config.PRODUCTS，非法名会「静默成功」地写进记录
 *           → 库存凭空多键 + 金山台账漏写。所以这里货品名一律用下拉选择，从源头杜绝非法名。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Config = window.App.Config;

  var els = null;
  var activeTarget = "pickups";
  var result = null;        // 最近一次识别结果 {orders, items, ignored}
  var pending = null;       // 待目标视图消费的数据 {target, data}

  /* 目标页映射。注意 out 的特殊性：
     出库登记表单**没有独立的管理页模块**（"out" 不在 router.KNOWN_MODULES 白名单里，
     navigate("/app/out") 会被 fallback 成 out-records「出库记录」列表），它的真实入口是
     **落地页** —— landing.js:44 内部调用 Views.out.render() 渲染同一套表单，out* 前缀的 id
     只存在于落地页。故 module 留空表示「导航到根路径（落地页）」。 */
  var TARGETS = {
    pickups: { label: "待取货", module: "pickups" },
    out: { label: "出库", module: "" },
    in: { label: "入库", module: "in" }
  };

  /* ---------- 工具 ---------- */

  function Jk() { return window.App.Jikeyun; }
  function D() { return window.App.Dict; }

  function q(id) { return document.getElementById(id); }

  /** 系统货品名下拉选项（实时取 Config.PRODUCTS，catalog 更新后自动跟随） */
  function productOptions(selected) {
    var html = '<option value="">（请选择）</option>';
    var prods = (Config.PRODUCTS || []).slice();
    if (selected && prods.indexOf(selected) === -1) {
      html += '<option value="' + Util.esc(selected) + '" selected>' + Util.esc(selected) + '（已失效）</option>';
    }
    prods.forEach(function (p) {
      html += '<option value="' + Util.esc(p) + '"' + (p === selected ? " selected" : "") + '>' + Util.esc(p) + '</option>';
    });
    return html;
  }

  /** 状态徽章：把「到底是哪种问题」直接说清楚（主理人要求详细错误点） */
  function statusBadge(status, qty, known, sysName) {
    if (qty === 0) return '<span class="status-pill pending"><span class="dot"></span>数量为 0，请确认</span>';
    if (sysName) {
      var Jk2 = Jk();
      if (Jk2 && typeof Jk2.isInCurrentSystem === "function" && !Jk2.isInCurrentSystem(sysName)) {
        return '<span class="status-pill pending"><span class="dot"></span>本仓无此货品</span>';
      }
      return '<span class="status-pill submitted static"><span class="dot"></span>' + (known ? "已记住" : "已对上") + '</span>';
    }
    if (status === "pick") return '<span class="status-pill pending"><span class="dot"></span>多候选，请选</span>';
    return '<span class="status-pill pending"><span class="dot"></span>系统里没有</span>';
  }

  /* ---------- 渲染 ---------- */

  function render(el) {
    el.innerHTML =
      '<div class="card">' +
        '<h2>自动识别 <span class="tag">粘贴吉客云订单文字</span></h2>' +
        '<div class="hint" style="line-height:1.8;margin-bottom:10px">' +
          '在吉客云里<b>整段复制 → 回来 Ctrl + V</b>，粘到下面任一框都能自动识别。' +
          '<br>· <b>待取货 / 出库</b>：第 1 行是「客户账号 ＋ 订单编号」，其余每行是「货品名 ＋ 数量」' +
          '<br>· <b>入库</b>：第 1 行是入库号（DB 开头，会自动填进「用途」），其余每行是「货品名 ＋ 数量」' +
          '识别结果先摆给你过目，对应不上或有错的地方会直接列出来，确认无误才填进表单。' +
        '</div>' +
        '<div class="actions" style="margin-bottom:12px">' +
          '<button type="button" class="btn ghost sm" id="rcDictBtn">📖 产品对照字典 <span id="rcDictCount"></span></button>' +
        '</div>' +
        '<div class="field">' +
          '<label>目标页面<span class="req">*</span></label>' +
          '<div class="chip-group" id="rcTargetChips">' +
            '<button type="button" class="chip selected" data-t="pickups">待取货</button>' +
            '<button type="button" class="chip" data-t="out">出库</button>' +
            '<button type="button" class="chip" data-t="in">入库</button>' +
          '</div>' +
        '</div>' +
        '<div class="field">' +
          '<label for="rcOrderText">① 订单信息 / 入库号 <span class="hint">（整段文字粘这里）</span></label>' +
          '<textarea id="rcOrderText" rows="3" autocomplete="off" ' +
            'placeholder="整段复制粘这里即可。待取货 / 出库：第 1 行「客户账号 + 订单编号」；入库：第 1 行「DB 开头的入库号」"></textarea>' +
        '</div>' +
        '<div class="field">' +
          '<label for="rcItemText">② 货品明细 <span class="hint">（不分两个框也行，整段粘上面那个一样能认出来）</span></label>' +
          '<textarea id="rcItemText" rows="6" autocomplete="off" ' +
            'placeholder="每行「货品名 + 数量」，例如：韶初泌语鹿茸凝时抗皱冻干精华液-20支装&#9;2"></textarea>' +
        '</div>' +
        '<div class="actions">' +
          '<button type="button" class="btn" id="rcParse">开始识别</button>' +
          '<button type="button" class="btn ghost" id="rcClearIn">清空粘贴框</button>' +
        '</div>' +
      '</div>' +
      '<div class="card" id="rcResultCard" style="display:none">' +
        '<h2>识别结果 <span class="badge" id="rcSummary"></span></h2>' +
        '<div id="rcResultBody"></div>' +
        '<div class="actions" style="margin-top:12px">' +
          '<button type="button" class="btn" id="rcFill">填入表单</button>' +
          '<button type="button" class="btn ghost" id="rcClearOut">清空识别结果</button>' +
        '</div>' +
      '</div>';

    els = {
      targetChips: q("rcTargetChips"),
      orderText: q("rcOrderText"),
      itemText: q("rcItemText"),
      parse: q("rcParse"),
      clearIn: q("rcClearIn"),
      resultCard: q("rcResultCard"),
      resultBody: q("rcResultBody"),
      summary: q("rcSummary"),
      fill: q("rcFill"),
      clearOut: q("rcClearOut"),
      dictBtn: q("rcDictBtn"),
      dictCount: q("rcDictCount")
    };

    /* 目标页面 chip 单选 */
    els.targetChips.addEventListener("click", function (ev) {
      var btn = ev.target.closest(".chip");
      if (!btn) return;
      activeTarget = btn.getAttribute("data-t") || "pickups";
      els.targetChips.querySelectorAll(".chip").forEach(function (c) {
        c.classList.toggle("selected", c === btn);
      });
      if (els.fill) els.fill.textContent = "填入" + TARGETS[activeTarget].label + "表单";   // 文案始终跟随目标页
      if (result) renderResult();
    });

    els.parse.addEventListener("click", doParse);
    els.clearIn.addEventListener("click", function () {
      els.orderText.value = "";
      els.itemText.value = "";
      els.orderText.focus();
    });
    els.clearOut.addEventListener("click", function () {
      result = null;
      els.resultCard.style.display = "none";
      els.resultBody.innerHTML = "";
    });
    els.fill.addEventListener("click", doFill);
    els.dictBtn.addEventListener("click", function () {
      var Dd = D();
      if (!Dd) { Util.toast("字典组件未就绪，请刷新页面", true); return; }
      Dd.openManager(function () { updateDictCount(); if (result) renderResult(); });
    });

    /* 粘贴即识别：两个框都监听 paste，粘贴后自动跑一次（体验对齐「粘完就出结果」） */
    [els.orderText, els.itemText].forEach(function (ta) {
      ta.addEventListener("paste", function () {
        setTimeout(function () { doParse(true); }, 80);
      });
    });

    updateDictCount();
  }

  function updateDictCount() {
    if (!els || !els.dictCount) return;
    var Dd = D();
    var n = (Dd && typeof Dd.count === "function") ? Dd.count() : 0;
    els.dictCount.textContent = n ? "（" + n + " 条）" : "（空）";
  }

  /* ---------- 识别 ---------- */

  function doParse(silent) {
    var JK = Jk();
    if (!JK) { Util.toast("解析组件未就绪，请刷新页面", true); return; }

    var t1 = els.orderText.value || "";
    var t2 = els.itemText.value || "";
    if (!t1.trim() && !t2.trim()) {
      if (!silent) Util.toast("请先粘贴吉客云订单文字", true);
      return;
    }

    /* 两框交叉解析：用户把全部内容粘到任一框也能识别出来 */
    var h1 = JK.parseHeader(t1);
    var h2 = JK.parseHeader(t2);
    /* 头信息取第一个认出来的（先框①再框②） */
    var head = (h1.kind !== "none") ? h1 : h2;
    var orders = h1.orders.concat(h2.orders);

    /* 订单去重（按订单编号） */
    var seenOrder = {}, ordersUniq = [];
    orders.forEach(function (o) {
      if (!o.orderNo || seenOrder[o.orderNo]) return;
      seenOrder[o.orderNo] = 1;
      ordersUniq.push(o);
    });

    var i1 = JK.parseItems(t1);
    var i2 = JK.parseItems(t2);
    var rows = i1.rows.concat(i2.rows);

    /* 货品去重（同名同数量的相邻重复行，常见于两框内容重叠） */
    var seenItem = {}, itemsUniq = [];
    rows.forEach(function (r) {
      var k = JK.normName(r.name) + "|" + (r.sysName || "") + "|" + (r.qty === null ? "" : r.qty);
      if (seenItem[k]) return;
      seenItem[k] = 1;
      itemsUniq.push(r);
    });

    result = {
      kind: head.kind,                                        /* "out"=客户账号+订单编号；"in"=入库号 */
      customer: head.customer || (ordersUniq[0] && ordersUniq[0].customer) || "",
      orderNo: head.orderNo || (ordersUniq[0] && ordersUniq[0].orderNo) || "",
      inboundNo: head.inboundNo || "",
      orders: ordersUniq,
      items: itemsUniq,
      ignored: (i1.ignored || 0) + (i2.ignored || 0)
    };

    if (result.kind === "none" && !itemsUniq.length) {
      if (!silent) Util.toast("没识别出内容：第 1 行应为「客户账号 + 订单编号」或入库号，其后每行是「货品名 + 数量」", true);
      els.resultCard.style.display = "none";
      return;
    }
    renderResult();
    els.resultCard.style.display = "";
    if (!silent) Util.toast("识别完成");
  }

  function renderResult() {
    if (!result) return;
    var orders = result.orders;
    var items = result.items;
    var isIn = (activeTarget === "in");
    var cur = orders[0] || {};

    /* 粘贴内容的类型与目标页不匹配时提醒（避免错页登记） */
    var mismatchWarn = "";
    if (result.kind === "in" && !isIn) {
      mismatchWarn = "检测到粘贴的是入库号（DB 开头），但目标页选的是「" + TARGETS[activeTarget].label + "」——请确认要不要切到「入库」。";
    } else if (result.kind === "out" && isIn) {
      mismatchWarn = "检测到粘贴的是「客户账号 + 订单编号」，但目标页选的是「入库」——请确认要不要切到「待取货」或「出库」。";
    }

    /* 统计 + 问题清单（主理人 2026-09-26 要求：对应不上或出错必须直接警告，并指出详细错误点） */
    var okCount = 0, pickCount = 0, warns = [];
    items.forEach(function (r) {
      var nm = r.name;
      if (!r.sysName) {
        pickCount++;
        if (r.status === "pick") {
          warns.push("「" + nm + "」有 " + ((r.candidates || []).length) + " 个相近货品，请从下拉里选一个");
        } else {
          warns.push("「" + nm + "」系统货品目录里找不到，请从下拉里选一个（或到「产品对照字典」里补一条）");
        }
      } else {
        okCount++;
        if (!Jk().isInCurrentSystem(r.sysName)) {
          warns.push("「" + nm + "」对应到「" + r.sysName + "」，但当前仓库没有这个货品，请换一个（或先切到对应仓库）");
        }
      }
      if (r.qty === null) warns.push("「" + nm + "」没读到数量，请补填");
      else if (r.qty === 0) warns.push("「" + nm + "」数量是 0，确认后才会填入（系统不接受 0）");
    });

    els.summary.textContent = "货品 " + items.length + " 项（已对上 " + okCount + " / 待确认 " + pickCount + "）";
    updateDictCount();

    var warnHtml = "";
    if (mismatchWarn) {
      warnHtml += '<div class="hint" style="margin:0 0 10px;padding:10px 12px;border-radius:10px;' +
        'background:rgba(186,117,23,.15);line-height:1.8">⚠️ ' + Util.esc(mismatchWarn) + '</div>';
    }
    if (warns.length) {
      warnHtml += '<div class="hint" style="margin:0 0 10px;padding:10px 12px;border-radius:10px;' +
        'background:rgba(201,135,127,.13);line-height:1.85">' +
        '<b>⚠️ 有 ' + warns.length + ' 处需要你处理：</b><br>' +
        warns.slice(0, 8).map(function (w) { return "· " + Util.esc(w); }).join("<br>") +
        (warns.length > 8 ? '<br>· …另有 ' + (warns.length - 8) + ' 处' : '') +
        '</div>';
    } else if (!warnHtml) {
      warnHtml = '<div class="hint" style="margin:0 0 10px;padding:10px 12px;border-radius:10px;' +
        'background:rgba(111,160,138,.13)">✅ 全部对上，核对无误后可以直接填入</div>';
    }

    /* 头信息字段区：出库/待取货两栏，入库只有「用途」一栏 */
    var attrHtml;
    if (isIn) {
      attrHtml =
        '<div class="field">' +
          '<label for="rcAttrPurpose">用途 <span class="hint">（← 粘贴第 1 行的入库号）</span></label>' +
          '<input type="text" id="rcAttrPurpose" value="' + Util.esc(result.inboundNo) + '" autocomplete="off" />' +
        '</div>';
    } else {
      attrHtml =
        '<div class="grid2">' +
          '<div class="field">' +
            '<label for="rcAttrDept">部门 / 客户 <span class="hint">（← 客户账号）</span></label>' +
            '<input type="text" id="rcAttrDept" value="' + Util.esc(result.customer) + '" autocomplete="off" />' +
          '</div>' +
          '<div class="field">' +
            '<label for="rcAttrPicker">' + (activeTarget === "out" ? "领取人" : "取货人") +
              ' <span class="hint">（← 订单编号）</span></label>' +
            '<input type="text" id="rcAttrPicker" value="' + Util.esc(result.orderNo) + '" autocomplete="off" />' +
          '</div>' +
        '</div>' +
        '<div class="hint" style="margin:-6px 0 10px">👆 申请人/经办人这类字段按你定的口径自动处理：' +
          (activeTarget === "out" ? '出库「申请人」= 客户账号，时间 = 当前时间' : '待取货的用途会自动选「客户销售」，可改') +
        '</div>';
    }

    /* 仓库提示：订单发货仓库与当前系统不一致时提醒（不自动切，避免误操作） */
    var whWarn = "";
    try {
      var wh = (cur.warehouse || "");
      var sysName = Config.Sys.current().name();
      if (wh) {
        var isSaidisWh = /赛迪斯|花都|沙头角/.test(wh);
        var curIsSaidis = Config.Sys.isSaidis();
        if (isSaidisWh !== curIsSaidis) {
          whWarn = '<div class="hint" style="margin:8px 0;padding:8px 10px;border-radius:10px;' +
            'background:rgba(201,135,127,.12);line-height:1.7">⚠️ 这单的发货仓库是「' + Util.esc(wh) +
            '」，当前系统是「' + Util.esc(sysName) + '」。请确认要不要先在左上角切换系统。</div>';
        }
      }
    } catch (e) {}

    var orderPickHtml = "";
    if (orders.length > 1) {
      orderPickHtml =
        '<div class="field">' +
          '<label>检测到 ' + orders.length + ' 行订单，请选择要登记的那一单</label>' +
          '<select id="rcOrderPick" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--input-line,#C6DAD1)">' +
            orders.map(function (o, i) {
              return '<option value="' + i + '">' + Util.esc(o.orderNo) +
                (o.customer ? " ｜ " + Util.esc(o.customer) : "") +
                (o.warehouse ? " ｜ " + Util.esc(o.warehouse) : "") + '</option>';
            }).join("") +
          '</select>' +
        '</div>';
    }

    var itemRowsHtml = items.map(function (r, i) {
      var Jk3 = Jk();
      var inSys = !!(r.sysName && Jk3 && typeof Jk3.isInCurrentSystem === "function" && Jk3.isInCurrentSystem(r.sysName));
      var needPick = !inSys;
      var rowStyle = needPick ? ' style="background:rgba(201,135,127,.10)"' : '';
      var known = !!(D() && D().isKnown && D().isKnown(r.name));
      return '<tr' + rowStyle + '>' +
        '<td style="word-break:break-all">' + Util.esc(r.name) +
          (r.splitOf ? ' <span class="hint">（套装拆出）</span>' : '') +
          (r.unit ? ' <span class="hint">' + Util.esc(r.unit) + '</span>' : '') + '</td>' +
        '<td><select class="rc-sys" data-i="' + i + '" style="width:100%;min-width:150px;padding:8px 10px;' +
          'border:1px solid var(--input-line,#C6DAD1);border-radius:10px;background:var(--input-bg,#FBFCFA)">' +
          productOptions(r.sysName) + '</select></td>' +
        '<td><input type="number" class="rc-qty" data-i="' + i + '" min="0" step="1" value="' +
          (r.qty === null ? "" : r.qty) + '" style="width:76px;padding:8px 10px;text-align:center;' +
          'border:1px solid var(--input-line,#C6DAD1);border-radius:10px;background:var(--input-bg,#FBFCFA)" /></td>' +
        '<td>' + statusBadge(r.status, r.qty, known, r.sysName) + '</td>' +
        '<td><button type="button" class="btn-clear" data-del="' + i + '">✕</button></td>' +
      '</tr>';
    }).join("") || '<tr><td colspan="5" style="text-align:center;color:var(--muted,#8A9995);padding:16px">没识别到货品明细<br><span class="hint">请确认第二个框里粘的是货品明细（带「货品名称 / 数量」表头）</span></td></tr>';

    els.resultBody.innerHTML =
      whWarn +
      warnHtml +
      orderPickHtml +
      attrHtml +
      '<div class="table-wrap"><table class="table"><thead><tr>' +
        '<th style="width:30%">吉客云货品名</th><th style="width:34%">系统货品名</th>' +
        '<th style="width:11%">数量</th><th style="width:19%">状态</th><th style="width:6%"></th>' +
      '</tr></thead><tbody id="rcItemRows">' + itemRowsHtml + '</tbody></table></div>' +
      (result.ignored ? '<div class="hint" style="margin-top:8px">已忽略无关行 ' + result.ignored + ' 行</div>' : '');

    /* 多订单切换 */
    var pick = q("rcOrderPick");
    if (pick) {
      pick.addEventListener("change", function () {
        var o = orders[Number(pick.value)] || {};
        var pEl = q("rcAttrPicker"), dEl = q("rcAttrDept");
        if (pEl) pEl.value = o.orderNo || "";
        if (dEl) dEl.value = o.customer || "";
      });
    }

    /* 行操作：删除 / 手选货品后清掉标红 */
    var rowsBox = q("rcItemRows");
    if (rowsBox) {
      rowsBox.addEventListener("click", function (ev) {
        var del = ev.target.closest("[data-del]");
        if (!del) return;
        var i = Number(del.getAttribute("data-del"));
        result.items.splice(i, 1);
        renderResult();
      });
      rowsBox.addEventListener("change", function (ev) {
        var sel = ev.target.closest("select.rc-sys");
        if (!sel) return;
        var i = Number(sel.getAttribute("data-i"));
        if (!result.items[i]) return;
        var v = sel.value || "";
        result.items[i].sysName = v;
        result.items[i].status = v ? "ok" : (result.items[i].candidates.length ? "pick" : "none");
        var tr = sel.closest("tr");
        if (tr) tr.style.background = v ? "" : "rgba(201,135,127,.10)";
        updateSummaryOnly();
      });
    }

    els.fill.textContent = "填入" + TARGETS[activeTarget].label + "表单";
  }

  function updateSummaryOnly() {
    if (!result) return;
    var ok = 0, pick = 0;
    result.items.forEach(function (r) {
      if (r.sysName) ok++; else pick++;
    });
    els.summary.textContent = "货品 " + result.items.length + " 项（已对上 " + ok + " / 待确认 " + pick + "）";
    els.fill.textContent = "填入" + TARGETS[activeTarget].label + "表单";
  }

  /* ---------- 填入表单 ---------- */

  /** 收集并校验预览区 → 填入数据；不通过返回 null。
      按头部类型组装：出库/待取货 = {dept, picker, applicant?}；入库 = {purpose}。 */
  function collect() {
    var isIn = (activeTarget === "in");   /* 按用户选的目标页决定填什么，比按粘贴内容的类型更贴合实际操作 */
    var pickerEl = q("rcAttrPicker");
    var deptEl = q("rcAttrDept");
    var purposeEl = q("rcAttrPurpose");
    var pickerVal = String(pickerEl ? pickerEl.value : "").trim();
    var deptVal = String(deptEl ? deptEl.value : "").trim();
    var purposeVal = String(purposeEl ? purposeEl.value : "").trim();

    var rowsBox = q("rcItemRows");
    var sels = rowsBox ? rowsBox.querySelectorAll("select.rc-sys") : [];
    var qtys = rowsBox ? rowsBox.querySelectorAll("input.rc-qty") : [];
    var items = [], problems = [];

    for (var i = 0; i < sels.length; i++) {
      var idx = Number(sels[i].getAttribute("data-i"));
      var name = String(sels[i].value || "").trim();
      var qtyRaw = qtys[i] ? String(qtys[i].value || "").trim() : "";
      var qty = qtyRaw === "" ? NaN : Number(qtyRaw);
      var rawName = (result && result.items[idx] && result.items[idx].name) || ("第 " + (i + 1) + " 行");

      if (!name) {
        problems.push("「" + rawName + "」还没选系统货品名");
        sels[i].style.borderColor = "#C9877F";
        continue;
      }
      if (Config.PRODUCTS.indexOf(name) === -1) {
        problems.push("「" + rawName + "」选的「" + name + "」不在当前仓库的货品目录里，请换一个");
        sels[i].style.borderColor = "#C9877F";
        continue;
      }
      if (!isFinite(qty)) { problems.push("「" + name + "」没填数量"); if (qtys[i]) qtys[i].style.borderColor = "#C9877F"; continue; }
      if (Math.floor(qty) !== qty) { problems.push("「" + name + "」数量需为整数（支/盒/袋按整件计）"); continue; }
      if (qty === 0) { continue; }                     /* 数量 0 的行直接跳过（系统不接受 0） */
      if (qty < 0 || qty > 999999) { problems.push("「" + name + "」数量超出范围"); continue; }

      /* 同名货品合并（套装拆出后可能与单独一行撞名；ProductPicker 也会拦重复项） */
      var merged = false;
      for (var j = 0; j < items.length; j++) {
        if (items[j].name === name) { items[j].qty += qty; merged = true; break; }
      }
      if (!merged) items.push({ name: name, qty: qty });
    }

    if (problems.length) {
      Util.toast("有 " + problems.length + " 处要处理：" + problems.slice(0, 2).join("；") +
        (problems.length > 2 ? " …" : ""), true);
      return null;
    }
    if (!items.length) { Util.toast("没有可填入的货品（数量都是 0？）", true); return null; }

    var data = { items: items };
    if (isIn) {
      /* 入库：粘贴第 1 行的入库号 → 「用途」；经办人不在此处覆盖（沿用上次填的人） */
      data.purpose = purposeVal;
    } else {
      if (!deptVal) { Util.toast("请填写部门 / 客户", true); return null; }
      if (!pickerVal) { Util.toast("请填写" + (activeTarget === "out" ? "领取人" : "取货人"), true); return null; }
      data.dept = deptVal;
      data.picker = pickerVal;
      data.applicant = deptVal;      /* 出库：申请人 = 客户账号（主理人 2026-09-26 定稿） */
    }
    return data;
  }

  function doFill() {
    if (!result) return;
    var data = collect();
    if (!data) return;

    /* 把这次人工确认的对应关系记进字典（越用越准）；只记用户确实改过的/未命中的行 */
    try {
      var Dd = D();
      var rowsBox = q("rcItemRows");
      var sels = rowsBox ? rowsBox.querySelectorAll("select.rc-sys") : [];
      if (Dd && Dd.learn) {
        for (var i = 0; i < sels.length; i++) {
          var idx = Number(sels[i].getAttribute("data-i"));
          var raw = result.items[idx] && result.items[idx].name;
          var to = String(sels[i].value || "").trim();
          if (raw && to && !Dd.lookup(raw)) Dd.learn(raw, to);
        }
        if (typeof Dd.flush === "function") Dd.flush();
      }
    } catch (e) {}

    pending = { target: activeTarget, data: data };
    var mod = TARGETS[activeTarget].module;
    try {
      window.App.Router.navigate(mod ? ("/app/" + mod) : "/");
    } catch (e2) {
      Util.toast("跳转失败，请手动进入「" + TARGETS[activeTarget].label + "」页", true);
    }
  }

  /* ---------- 跨页传参 ---------- */

  /** 目标视图 render 末尾调用：取走属于它的待填数据（取一次即清空） */
  function takePending(viewName) {
    if (pending && pending.target === viewName) {
      var d = pending;
      pending = null;
      return d.data;
    }
    return null;
  }

  function refresh() { updateDictCount(); }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.recognize = {
    render: render,
    refresh: refresh,
    takePending: takePending
  };
})();
