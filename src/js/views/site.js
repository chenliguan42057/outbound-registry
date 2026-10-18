/**
 * site.js — 仪表盘「现场库存」面板（仓库/现场双区库存，2026-10-09 主理人需求）
 *
 * 只读展示 + 分区操作（转入现场 / 退回仓库 / 设定锁定数与警示线）；
 * 不改任何出库/入库逻辑 —— 现场数 = Stock.getStock − 仓库锁定（见 data/zones.js）。
 *
 * 入口：仪表盘首个 tab（dashboard.js 的 renderTab → Views.site.render）。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Zones = window.App.Zones;
  var UI = window.App.UI;
  var Config = window.App.Config;

  var container = null;
  var filter = "all";          // all | site | low

  /** 产品单位（取自 catalog，读不到留空） */
  function unitOf(name) {
    var c = window.App.Catalog && window.App.Catalog.get && window.App.Catalog.get();
    if (c && c.products) {
      for (var i = 0; i < c.products.length; i++) {
        if (c.products[i].name === name) return c.products[i].unit || "";
      }
    }
    return "";
  }

  /** 箱规（每箱多少个）：取货品目录的 product.caseSize，没设过返回 0（2026-10-18） */
  function caseSizeOf(name) {
    var c = window.App.Catalog && window.App.Catalog.get && window.App.Catalog.get();
    if (c && c.products) {
      for (var i = 0; i < c.products.length; i++) {
        if (c.products[i].name === name) return Number(c.products[i].caseSize) || 0;
      }
    }
    return 0;
  }

  /** 个数 → 箱数展示，**允许小数箱**（90 个 / 20 = 4.5 箱）；箱规为 0 时返回空串 */
  function fmtBoxes(qty, size) {
    if (!size || !(qty > 0)) return "";
    var b = Math.round((qty / size) * 100) / 100;
    return b + " 箱";
  }

  function pct(a, b) { return b > 0 ? Math.round(a / b * 100) : 0; }
  function fmtTime(t) {
    var s = String(t || "");
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    return m ? (m[2] + "/" + m[3] + " " + m[4] + ":" + m[5]) : s;
  }

  function render(el) {
    container = el;
    if (!el._siteBound) {
      el.addEventListener("click", onCardClick);
      el._siteBound = true;
    }
    draw();
  }

  function refresh() { if (container) draw(); }

  /* ================= 卡片固定顺序（2026-10-18 主理人定稿） =================
     原来按「预警优先 → 库存量 → 名称」动态排，库存一动卡片就换位置，找不到货。
     现在**完全按「选择货品」面板的分类顺序**（精华液 → 精粹水 → 精粹乳 → 精粹霜 → 面膜 →
     洁面慕斯 → 小鹿牛皮纸袋 → 员工帆布袋 → 礼盒 → 拎袋 → 其他），组内再按货品目录的规格顺序，
     目录外的货品（历史遗留、已删除但仍有记录）统一排最后。
     分组规则直接复用 UI.PICK_GROUP_ORDER / UI.pickGroupOf，和选择面板同源，不会两处跑偏。
     筛选（全部 / 仅现场有货 / 仅预警）只减少卡片，不改变相对顺序。 */
  function groupIndex(name) {
    var order = (UI.PICK_GROUP_ORDER || []);
    var g = UI.pickGroupOf ? UI.pickGroupOf(name) : String(name || "").split(" ")[0];
    var i = order.indexOf(g);
    return i < 0 ? 999 : i;
  }

  function orderIndex(name) {
    var list = Config.PRODUCTS || [];
    var i = list.indexOf(name);
    return i < 0 ? 99999 : i;
  }

  function sortRows(list) {
    return list.slice().sort(function (a, b) {
      var ga = groupIndex(a.name), gb = groupIndex(b.name);
      if (ga !== gb) return ga - gb;
      var ia = orderIndex(a.name), ib = orderIndex(b.name);
      if (ia !== ib) return ia - ib;
      return String(a.name).localeCompare(String(b.name), "zh");
    });
  }

  function draw() {
    if (!container || !Zones) return;
    var all = Zones.summary();
    var whTotal = 0, siteTotal = 0, lowN = 0;
    all.forEach(function (s) { whTotal += s.warehouse; siteTotal += s.site; if (s.low) lowN++; });

    var shown = all.filter(function (s) {
      if (filter === "low") return s.low;
      if (filter === "site") return s.site > 0;
      return true;
    });
    shown = sortRows(shown);

    var html =
      '<div class="dash-note">仓库＝锁定库存（整箱存放，只能转入现场）；现场＝日常出库扣减的可用库存——出库单一经创建即扣现场（含未提单），待取货不影响。' +
        '<b>现场出现负数</b>＝货被拿走但没做「转出现场」，补一张转出或盘点平账即可平掉。' +
        '<span class="zone-help">点产品卡的「流水」看谁拿了多少、还剩多少</span></div>' +
      '<div class="zone-ov">' +
        ovCard("现场可用合计", siteTotal, "site", lowN ? (lowN + " 项现场偏低") : "现场充足") +
        ovCard("仓库锁定合计", whTotal, "wh", "整箱待转出") +
        ovCard("库存合计", whTotal + siteTotal, "all", all.length + " 个货品") +
        '<div class="zone-ov-card' + (lowN ? " warn" : "") + '" data-act="filter" data-f="low" role="button" tabindex="0">' +
          '<b>' + lowN + '</b><span>现场预警项</span><i>' + (lowN ? "点此只看预警" : "无预警") + '</i></div>' +
      '</div>' +
      '<div class="zone-toolbar">' +
        chip("all", "全部") + chip("site", "仅现场有货") + chip("low", "仅预警") +
        '<button type="button" class="btn sm zone-set-btn" data-act="caseentry">📦 按箱录锁定</button>' +
        '<button type="button" class="btn ghost sm" data-act="casebatch">📦 批量按箱</button>' +
        '<button type="button" class="btn sm zone-set-btn" data-act="batchset">⚙ 分区设置（单个 / 批量）</button>' +
      '</div>' +
      (shown.length ? renderGroups(shown)
                    : '<div class="empty">没有符合条件的货品</div>');

    container.innerHTML = html;
  }

  function ovCard(label, val, kind, sub) {
    return '<div class="zone-ov-card k-' + kind + '"><b>' + Number(val).toLocaleString("zh-CN") +
      '</b><span>' + Util.esc(label) + '</span><i>' + Util.esc(sub) + '</i></div>';
  }

  function chip(val, label) {
    return '<button type="button" class="btn sm' + (filter === val ? "" : " ghost") +
      '" data-act="filter" data-f="' + val + '">' + Util.esc(label) + '</button>';
  }

  /** 按分类分块渲染（2026-10-18）：每组一个小标题 + 组内网格。
      list 已由 sortRows 排好序（组序 → 组内目录序），这里只做分组与块序校正，
      保证「选择货品」面板看到的分组顺序 = 仪表盘看到的分组顺序。 */
  function renderGroups(list) {
    var groups = [], map = {};
    list.forEach(function (s) {
      var g = UI.pickGroupOf ? UI.pickGroupOf(s.name) : (String(s.name || "").split(" ")[0] || "其他");
      if (!map[g]) { map[g] = { name: g, idx: groupIndex(s.name), items: [] }; groups.push(map[g]); }
      map[g].items.push(s);
    });
    groups.sort(function (a, b) { return a.idx - b.idx; });
    return groups.map(function (g) {
      var c = g.idx > 9 ? 9 : g.idx;
      return '<div class="zone-group" data-c="' + c + '">' +
          '<div class="zg-head"><i class="zg-dot" data-c="' + c + '"></i>' +
            Util.esc(g.name) + '<span class="zg-count">' + g.items.length + '</span></div>' +
          '<div class="zone-grid">' + g.items.map(card).join("") + '</div>' +
        '</div>';
    }).join("");
  }

  function card(s) {
    var u = unitOf(s.name);
    var cs = caseSizeOf(s.name);
    var barSite = Math.max(0, Math.min(100, pct(s.site, s.total)));   // 现场为负时进度条归零，不画反条
    return '<div class="zone-card' + (s.low ? " low" : "") + (s.site < 0 ? " neg" : "") + '">' +
      '<div class="zc-head">' +
        '<div class="zc-name">' + Util.esc(s.name) + (u ? ' <i class="zc-unit">' + Util.esc(u) + '</i>' : '') + '</div>' +
        (s.site < 0 ? '<span class="zc-flag neg">⚠ 现场为负</span>' : (s.low ? '<span class="zc-flag">⚠ 现场偏低</span>' : '')) +
      '</div>' +
      '<div class="zc-main">' +
        '<div class="zc-figure"><b' + (s.site < 0 ? ' class="neg"' : (s.low ? ' class="warn"' : '')) + '>' + s.site + '</b><span>' + (s.site < 0 ? '现场为负' : '现场可用') + '</span></div>' +
        '<div class="zc-meta">' +
          '<span>仓库锁定 <b>' + s.warehouse + '</b>' + (cs > 0 ? ' <i class="zc-case">' + fmtBoxes(s.warehouse, cs) + '</i>' : '') + '</span>' +
          (s.inTransit > 0 ? '<span class="zc-trans">在途 <b>' + s.inTransit + '</b></span>' : '') +
          '<span title="总可用 = 总量 − 在途（已出未提单）：仓库锁定的货也能转出来用，所以算在可用里">总可用 <b>' + (s.total - s.inTransit) + '</b></span>' +
          '<span>总量 <b>' + s.total + '</b></span>' +
          '<span>警示线 <b>' + s.warnAt + '</b></span>' +
        '</div>' +
      '</div>' +
      '<div class="zc-bar"><i style="width:' + barSite + '%"></i></div>' +
      '<div class="zc-acts">' +
        '<button type="button" class="btn sm" data-act="to_site" data-name="' + Util.esc(s.name) + '"' + (s.warehouse <= 0 ? " disabled" : "") + '>转出现场</button>' +
        '<button type="button" class="btn ghost sm" data-act="to_wh" data-name="' + Util.esc(s.name) + '"' + (s.site <= 0 ? " disabled" : "") + '>退回仓库</button>' +
        '<button type="button" class="btn ghost sm" data-act="flow" data-name="' + Util.esc(s.name) + '">流水</button>' +
        '<button type="button" class="btn ghost sm" data-act="set" data-name="' + Util.esc(s.name) + '">设置</button>' +
      '</div>' +
    '</div>';
  }

  /** 现场流水弹窗：点卡片「流水」打开独立小窗口，避免长表格把卡片撑乱 */
  function openFlow(name) {
    var s = Zones.summary().filter(function (x) { return x.name === name; })[0] || {};
    var u = unitOf(name);
    var rows = Zones.siteFlow(name, 60);
    var head =
      '<div class="zf-sum">' +
        '<span class="zf-s-item"><b>' + (s.site != null ? s.site : 0) + '</b>现场可用</span>' +
        '<span class="zf-s-item"><b>' + (s.warehouse != null ? s.warehouse : 0) + '</b>仓库锁定</span>' +
        '<span class="zf-s-item"><b>' + (s.inTransit != null ? s.inTransit : 0) + '</b>在途（已出未提单）</span>' +
        '<span class="zf-s-item"><b>' + (s.total != null ? s.total : 0) + '</b>总库存' + (u ? '·' + Util.esc(u) : '') + '</span>' +
        '<span class="zf-s-item' + (s.low ? ' warn' : '') + '"><b>' + (s.warnAt != null ? s.warnAt : 0) + '</b>警示线</span>' +
      '</div>';
    var table = rows.length
      ? '<div class="zf-wrap"><div class="zf-head"><span>时间</span><span>变动</span><span>经手 / 部门</span><span>现场剩余</span></div>' +
        rows.map(function (r) {
          var sign = (r.type === "in") ? "+" : "−";
          return '<div class="zf-row ' + r.type + '">' +
            '<span class="zf-t">' + Util.esc(fmtTime(r.time)) + '</span>' +
            '<span class="zf-q">' + sign + r.qty + '</span>' +
            '<span class="zf-who">' + Util.esc((r.picker || "—") + (r.dept ? " · " + r.dept : "")) + '</span>' +
            '<span class="zf-left">' + r.siteAfter + '</span>' +
          '</div>';
        }).join("") + '</div>'
      : '<div class="zf-empty">暂无出入库流水</div>';
    var body =
      head +
      '<div class="zf-tip">「变动」为 − 出库 / + 入库；「现场剩余」= 该笔之后现场还剩多少（已扣在途与仓库锁定）。</div>' +
      table +
      '<div class="modal-actions">' +
        '<button type="button" class="btn ghost sm" data-fz="close">关闭</button>' +
        '<button type="button" class="btn sm" data-fz="set">分区设置</button>' +
      '</div>';
    UI.Modal.show("现场流水 · " + name, body, { width: "560px" });
    var m = UI.Modal.body();
    m.querySelector('[data-fz="close"]').onclick = function () { UI.Modal.hide(); };
    m.querySelector('[data-fz="set"]').onclick = function () { UI.Modal.hide(); openSettings(name); };
  }

  /* ================= 事件（委托，只绑一次） ================= */

  function onCardClick(e) {
    var btn = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    if (act === "caseentry") return openCaseEntry();
    if (act === "casebatch") return openCaseBatch();
    if (act === "batchset") return openBatch();
    if (act === "filter") {
      filter = btn.getAttribute("data-f") || "all";
      draw();
      return;
    }
    var name = btn.getAttribute("data-name");
    if (!name) return;
    if (act === "flow") return openFlow(name);
    if (act === "to_site") return doTransfer(name, "to_site");
    if (act === "to_wh") return doTransfer(name, "to_wh");
    if (act === "set") return openSettings(name);
  }

  function doTransfer(name, dir) {
    var wh = Zones.warehouseLocked(name);
    var site = Zones.siteStock(name);
    var isOut = (dir === "to_site");
    var msg = isOut
      ? "从仓库锁定转出到现场。当前仓库锁定 " + wh + "，现场 " + site + "。"
      : "把现场退回仓库锁定。当前现场 " + site + "，仓库锁定 " + wh + "。";
    UI.promptDialog(msg + "请输入数量（整数）：", "输入数量", isOut ? "仓库 → 现场" : "现场 → 仓库", "确认")
      .then(function (res) {
        if (!res || !res.ok) return;
        var qty = Math.round(Number(res.value));
        if (!qty || qty <= 0) { Util.toast("数量需为正整数", true); return; }
        if (isOut && qty > Zones.warehouseLocked(name)) {
          Util.toast("仓库锁定只有 " + Zones.warehouseLocked(name) + "，不能转出更多", true); return;
        }
        if (!isOut && qty > Zones.siteStock(name)) {
          Util.toast("现场只有 " + Zones.siteStock(name) + "，不能退回更多", true); return;
        }
        var rec = Zones.transfer(name, dir, qty);
        if (!rec) { Util.toast("操作失败，请重试", true); return; }
        Util.toast((isOut ? "已转出 " : "已退回 ") + qty + "（" + name + "）");
        draw();
      });
  }

  /** 单产品设置弹窗：总库存（可手动设定）+ 仓库锁定数 + 现场警示线 */
  /* ================= 按箱录仓库锁定（2026-10-18） ================= */
  /** 用「箱」录仓库锁定：填「每箱多少个」（箱规）+「几箱」，自动换算成个数写入仓库锁定。
      箱规记进货品目录 product.caseSize（随 catalog.json 云端同步），卡片上反向显示"共几箱"。
      两个动作：＋累加（在现有锁定上加）/ ＝设为（直接改成这个数，适合实物盘点）。 */
  function openCaseEntry() {
    var Cat = window.App.Catalog;
    var names = (Config.PRODUCTS || []).slice();
    if (!names.length) { Util.toast("货品目录还没加载好，请稍后重试", true); return; }
    var body =
      '<div class="hint" style="margin:-2px 0 12px">按<b>箱</b>录仓库锁定：填「每箱多少个」+「几箱」，自动换算成个数。箱规会记住，下次自动带出；<b>箱数可以是小数</b>（如 1.5 箱）。</div>' +
      '<div class="field"><label>货品</label>' +
        '<select id="ceName" class="ce-in">' + names.map(function (n) {
          return '<option value="' + Util.esc(n) + '">' + Util.esc(n) + '</option>';
        }).join("") + '</select></div>' +
      '<div class="ce-row">' +
        '<div class="field"><label>每箱多少个</label><input type="number" id="ceSize" min="1" step="1" class="ce-in" placeholder="如 20" /></div>' +
        '<div class="field"><label>箱数（可填小数）</label><input type="number" id="ceBoxes" min="0.01" step="0.01" class="ce-in" value="1" /></div>' +
      '</div>' +
      '<div class="ce-calc" id="ceCalc"></div>' +
      '<div class="modal-actions" style="margin-top:14px">' +
        '<button type="button" class="btn ghost sm" data-act="cancel">取消</button>' +
        '<button type="button" class="btn ghost sm" id="ceSet">＝ 设为该数值</button>' +
        '<button type="button" class="btn sm" id="ceAdd">＋ 累加到仓库锁定</button>' +
      '</div>';
    UI.Modal.show("📦 按箱录仓库锁定", body, { width: "540px" });
    var m = UI.Modal.body();
    var selEl = m.querySelector("#ceName");
    var sizeEl = m.querySelector("#ceSize");
    var boxEl = m.querySelector("#ceBoxes");
    var calcEl = m.querySelector("#ceCalc");
    var setBtn = m.querySelector("#ceSet");
    var addBtn = m.querySelector("#ceAdd");

    function curWh(name) {
      var list = Zones.summary();
      for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i].warehouse;
      return 0;
    }
    function vals() {
      var size = Math.max(0, Math.round(Number(sizeEl.value) || 0));   // 箱规：整数个/箱
      var boxes = Math.max(0, Number(boxEl.value) || 0);              // 箱数：允许小数（0.5 / 1.5 箱）
      return { size: size, boxes: boxes, qty: Math.round(size * boxes) };   // 个数四舍五入取整
    }
    function draw() {
      var v = vals();
      var name = selEl.value;
      var cur = curWh(name);
      var csNow = caseSizeOf(name);
      var l1 = v.qty > 0
        ? (v.boxes + " 箱 × " + v.size + " 个/箱 ＝ <b>" + v.qty + "</b> 个")
        : '<span class="ce-warn">先填「每箱多少个」和「箱数」</span>';
      /* 当前锁定的箱数优先用「本次填的箱规」换算 —— 否则新货品没存过箱规时这行看不到箱数，容易误读成"180 箱" */
      var boxSize = v.size > 0 ? v.size : csNow;
      var l2 = "当前仓库锁定 <b>" + cur + "</b> 个" + (boxSize > 0 ? "（" + fmtBoxes(cur, boxSize) + "）" : "");
      /* 两个按钮两种结果，都预览出来，避免只显示"累加后"被当成唯一结果 */
      var l3 = v.qty > 0
        ? '<div class="ce-after">点「＋ 累加」→ ' + (cur + v.qty) + ' 个（' + fmtBoxes(cur + v.qty, v.size) + '）</div>' +
          '<div class="ce-after">点「＝ 设为」→ ' + v.qty + ' 个（' + fmtBoxes(v.qty, v.size) + '）</div>'
        : "";
      calcEl.innerHTML = '<div>' + l1 + '</div><div>' + l2 + '</div>' + l3;
      setBtn.disabled = !(v.qty > 0);
      addBtn.disabled = !(v.qty > 0);
    }
    function commit(mode) {
      var v = vals();
      if (!(v.qty > 0)) { Util.toast("请先填写每箱多少个和箱数", true); return; }
      var name = selEl.value;
      var cur = curWh(name);
      var target = (mode === "add") ? cur + v.qty : v.qty;
      /* 箱规变了就顺手存进目录（云端同步，下次换设备也带得出来） */
      if (Cat && Cat.setCaseSize && caseSizeOf(name) !== v.size) Cat.setCaseSize(name, v.size, function () {});
      Zones.setWarehouse(name, target);
      UI.Modal.hide();
      Util.toast((mode === "add" ? "已累加 " : "已设为 ") + name + "：仓库锁定 " + target + " 个（" + v.boxes + " 箱 × " + v.size + "）");
      refresh();
    }
    function fillSize() {
      var cs = caseSizeOf(selEl.value);
      sizeEl.value = cs > 0 ? cs : "";
      draw();
    }
    selEl.addEventListener("change", fillSize);
    sizeEl.addEventListener("input", draw);
    boxEl.addEventListener("input", draw);
    setBtn.addEventListener("click", function () { commit("set"); });
    addBtn.addEventListener("click", function () { commit("add"); });
    fillSize();
  }

  /* ================= 批量按箱录锁定（2026-10-18） ================= */
  /** 一张表给多个货品填「每箱多少个 + 箱数」，一次写进仓库锁定。
      只在「箱数」> 0 的行生效；箱规空着就用目录里记住的值。箱规有变化的行合成一次目录保存。 */
  function openCaseBatch() {
    var Cat = window.App.Catalog;
    var sum = Zones.summary();
    if (!sum.length) { Util.toast("货品目录还没加载好，请稍后重试", true); return; }
    var rowsHtml = sum.map(function (s) {
      var cs = caseSizeOf(s.name);
      return '<div class="cb-row" data-name="' + Util.esc(s.name) + '">' +
        '<span class="cb-ckw"><input type="checkbox" class="cb-ck" /></span>' +
        '<span class="cb-name" title="' + Util.esc(s.name) + '">' + Util.esc(s.name) + '</span>' +
        '<span><input type="number" min="0" step="1" class="cb-in" data-f="size" value="' + (cs > 0 ? cs : "") + '" placeholder="个/箱" /></span>' +
        '<span><input type="number" min="0" step="0.01" class="cb-in" data-f="boxes" placeholder="箱数(可小数)" /></span>' +
        '<span class="cb-qty">—</span>' +
        '<span class="cb-cur">' + s.warehouse + '</span>' +
        '<span class="cb-after">—</span>' +
      '</div>';
    }).join("");
    var body =
      '<div class="cb-tip">批量按箱：只在<b>「箱数」</b>填了数字的行才生效（每箱多少个空着 → 用目录里记住的箱规）。' +
        '换算个数 ＝ 箱数 × 每箱多少个，写进「仓库锁定」。可以先用上排批量填，再逐行微调。</div>' +
      '<div class="cb-bar">' +
        '<label class="cb-all"><input type="checkbox" id="cbAll" /> 全选</label>' +
        '<select id="cbField"><option value="size">每箱多少个</option><option value="boxes">箱数</option></select>' +
        '<input type="number" min="0" step="1" id="cbVal" placeholder="批量值" />' +
        '<button type="button" class="btn sm" data-cb="toSel">应用到勾选</button>' +
        '<button type="button" class="btn ghost sm" data-cb="toAll">应用到全部</button>' +
      '</div>' +
      '<div class="cb-table">' +
        '<div class="cb-row cb-head"><span></span><span>货品</span><span>每箱多少个</span><span>箱数</span><span>换算</span><span>当前锁定</span><span>变更后</span></div>' +
        rowsHtml +
      '</div>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn ghost sm" data-cb="cancel">取消</button>' +
        '<button type="button" class="btn ghost sm" data-cb="set">＝ 全部设为该数值</button>' +
        '<button type="button" class="btn sm" data-cb="add">＋ 全部累加到仓库锁定</button>' +
      '</div>';
    UI.Modal.show("📦 批量按箱录锁定", body, { width: "92vw" });
    var m = UI.Modal.body();

    function rows() { return Array.prototype.slice.call(m.querySelectorAll(".cb-row[data-name]")); }
    function rowVal(row, f, isInt) {
      var el = row.querySelector('[data-f="' + f + '"]');
      var v = Number(el && el.value);
      if (!isFinite(v) || v <= 0) return 0;
      return isInt ? Math.round(v) : v;   // 箱规取整；箱数允许小数（0.5 / 1.5 箱）
    }
    function recalc(row) {
      var size = rowVal(row, "size", true), boxes = rowVal(row, "boxes", false);
      var cur = Number(row.querySelector(".cb-cur").textContent) || 0;
      var qty = (size > 0 && boxes > 0) ? Math.round(size * boxes) : 0;
      row.querySelector(".cb-qty").textContent = qty > 0 ? (qty + " 个") : "—";
      row.querySelector(".cb-after").textContent = qty > 0 ? String(cur + qty) : "—";
    }
    rows().forEach(function (row) {
      Array.prototype.forEach.call(row.querySelectorAll(".cb-in"), function (inp) {
        inp.addEventListener("input", function () { recalc(row); });
      });
    });
    var all = m.querySelector("#cbAll");
    if (all) all.onchange = function () {
      Array.prototype.forEach.call(m.querySelectorAll(".cb-ck"), function (c) { c.checked = all.checked; });
    };
    function bulk(onlyChecked) {
      var f = m.querySelector("#cbField").value;
      var raw = m.querySelector("#cbVal").value;
      if (raw === "") { Util.toast("请先填写批量值", true); return; }
      var rawN = Number(raw);
      if (!isFinite(rawN)) { Util.toast("批量值必须是数字", true); return; }
      var n = (f === "boxes") ? Math.max(0, rawN) : Math.max(0, Math.round(rawN));
      var cnt = 0;
      rows().forEach(function (row) {
        var ck = row.querySelector(".cb-ck");
        if (onlyChecked && !(ck && ck.checked)) return;
        row.querySelector('[data-f="' + f + '"]').value = n;
        recalc(row); cnt++;
      });
      Util.toast("已为 " + cnt + " 行填入 " + n);
    }
    function commit(mode) {
      var list = [];
      rows().forEach(function (row) {
        var name = row.getAttribute("data-name");
        var size = rowVal(row, "size", true) || caseSizeOf(name);
        var boxes = rowVal(row, "boxes", false);
        if (!(boxes > 0) || !(size > 0)) return;
        list.push({
          name: name, size: size, boxes: boxes, qty: Math.round(size * boxes),
          cur: Number(row.querySelector(".cb-cur").textContent) || 0
        });
      });
      if (!list.length) { Util.toast("还没有「箱数」大于 0 的行", true); return; }
      var sizeMap = {};
      list.forEach(function (r) { sizeMap[r.name] = r.size; });
      if (Cat && Cat.setCaseSizes) Cat.setCaseSizes(sizeMap, function () {});
      var totalQty = 0;
      list.forEach(function (r) {
        Zones.setWarehouse(r.name, mode === "add" ? (r.cur + r.qty) : r.qty);
        totalQty += r.qty;
      });
      UI.Modal.hide();
      Util.toast((mode === "add" ? "已累加 " : "已设为 ") + list.length + " 个货品，合计 " + totalQty + " 个");
      refresh();
    }
    m.querySelector('[data-cb="toSel"]').onclick = function () { bulk(true); };
    m.querySelector('[data-cb="toAll"]').onclick = function () { bulk(false); };
    m.querySelector('[data-cb="cancel"]').onclick = function () { UI.Modal.hide(); };
    m.querySelector('[data-cb="set"]').onclick = function () { commit("set"); };
    m.querySelector('[data-cb="add"]').onclick = function () { commit("add"); };
  }

  function openSettings(name) {
    var cur = Zones.summary().filter(function (x) { return x.name === name; })[0] || {};
    var total = (cur.total != null) ? cur.total : (Zones.siteStock(name) + Zones.warehouseLocked(name));
    var wh = Zones.warehouseLocked(name);
    var wa = Zones.warnAt(name);
    var body =
      '<div class="confirm-msg"><b>' + Util.esc(name) + '</b></div>' +
      '<label class="zone-set-lbl">总库存（该产品的库存总数，可直接设定）' +
        '<input type="number" min="0" class="pw-input" id="zsTotal" value="' + total + '" /></label>' +
      (cur.manuallySet
        ? '<div class="zs-hint">当前为<b>手动设定</b> · <a href="javascript:void(0)" id="zsClear">恢复跟随系统</a>（之后出入库会自动变化）</div>'
        : '<div class="zs-hint">当前跟随系统库存，出入库会自动变化</div>') +
      '<label class="zone-set-lbl">仓库锁定数（其中整箱存放、只能转入现场的部分）' +
        '<input type="number" min="0" class="pw-input" id="zsWh" value="' + wh + '" /></label>' +
      '<label class="zone-set-lbl">现场警示线（现场低于此值即预警）' +
        '<input type="number" min="0" class="pw-input" id="zsWarn" value="' + wa + '" /></label>' +
      '<div class="pw-err" id="zsErr"></div>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn ghost sm" data-act="zc">取消</button>' +
        '<button type="button" class="btn sm" data-act="zok">保存</button>' +
      '</div>';
    UI.Modal.show("设置 · " + name, body, { width: "360px" });
    var m = UI.Modal.body();
    var err = m.querySelector("#zsErr");
    var clr = m.querySelector("#zsClear");
    if (clr) clr.onclick = function () {
      Zones.clearBase(name); UI.Modal.hide();
      Util.toast("「" + name + "」已恢复跟随系统库存"); draw();
    };
    m.querySelector('[data-act="zc"]').onclick = function () { UI.Modal.hide(); };
    m.querySelector('[data-act="zok"]').onclick = function () {
      var newTotal = Math.round(Number(m.querySelector("#zsTotal").value));
      var newWh = Math.round(Number(m.querySelector("#zsWh").value));
      var newWarn = Math.round(Number(m.querySelector("#zsWarn").value));
      if (isNaN(newTotal) || newTotal < 0) { err.textContent = "总库存需为 ≥0 的整数"; return; }
      if (isNaN(newWh) || newWh < 0) { err.textContent = "仓库锁定数需为 ≥0 的整数"; return; }
      if (isNaN(newWarn) || newWarn < 0) { err.textContent = "警示线需为 ≥0 的整数"; return; }
      if (newTotal !== total) Zones.setBase(name, newTotal);
      if (newWh !== wh) Zones.setWarehouse(name, newWh);
      if (newWarn !== wa) Zones.setWarn(name, newWarn);
      UI.Modal.hide();
      Util.toast("已保存「" + name + "」的分区设置");
      draw();
    };
  }

  /** 批量 / 逐行分区设置（总库存 + 仓库锁定 + 现场警示线） */
  function openBatch() {
    var sum = Zones.summary();
    var origMap = {};
    sum.forEach(function (s) { origMap[s.name] = s; });

    var rowsHtml = sum.map(function (s) {
      return '<div class="zb-row" data-name="' + Util.esc(s.name) + '">' +
        '<span class="zb-ckw"><input type="checkbox" class="zb-ck" /></span>' +
        '<span class="zb-name">' + Util.esc(s.name) + (s.manuallySet ? '<i class="zb-mk">手动</i>' : '') + '</span>' +
        '<span><input type="number" min="0" class="zb-in" data-f="base" value="' + s.total + '" /></span>' +
        '<span><input type="number" min="0" class="zb-in" data-f="wh" value="' + s.warehouse + '" /></span>' +
        '<span class="zb-site">' + s.site + '</span>' +
        '<span><input type="number" min="0" class="zb-in" data-f="warn" value="' + s.warnAt + '" /></span>' +
      '</div>';
    }).join("");

    var body =
      '<div class="zb-tip">「总库存」= 该产品的库存总数（可直接设定）；「仓库锁定」是其中整箱存放、只能转入现场的部分；' +
        '<b>现场 = 总库存 − 仓库锁定</b>（自动算）。逐行改，或用上排批量填，最后点「保存」。</div>' +
      '<div class="zb-bar">' +
        '<label class="zb-all"><input type="checkbox" id="zbAll" /> 全选</label>' +
        '<select id="zbField" class="zb-sel">' +
          '<option value="base">总库存</option>' +
          '<option value="wh">仓库锁定</option>' +
          '<option value="warn">现场警示线</option>' +
        '</select>' +
        '<input type="number" min="0" id="zbVal" class="zb-val" placeholder="批量值" />' +
        '<button type="button" class="btn sm" data-zb="toSel">应用到勾选</button>' +
        '<button type="button" class="btn ghost sm" data-zb="toAll">应用到全部</button>' +
      '</div>' +
      '<div class="zb-table">' +
        '<div class="zb-head"><span></span><span>产品</span><span>总库存</span><span>仓库锁定</span><span>现场</span><span>警示线</span></div>' +
        rowsHtml +
      '</div>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn ghost sm" data-zb="cancel">取消</button>' +
        '<button type="button" class="btn sm" data-zb="save">保存</button>' +
      '</div>';

    UI.Modal.show("分区设置 · 总库存 / 仓库锁定 / 现场 / 警示线", body, { width: "92vw" });
    var m = UI.Modal.body();
    function eachRow(fn) { Array.prototype.forEach.call(m.querySelectorAll(".zb-row"), fn); }

    function recalcRow(row) {
      var t = Math.max(0, Math.round(Number(row.querySelector('[data-f="base"]').value) || 0));
      var w = Math.max(0, Math.round(Number(row.querySelector('[data-f="wh"]').value) || 0));
      row.querySelector(".zb-site").textContent = Math.max(0, t - w);
    }
    eachRow(function (row) {
      Array.prototype.forEach.call(row.querySelectorAll(".zb-in"), function (inp) {
        var f = inp.getAttribute("data-f");
        if (f === "base" || f === "wh") inp.addEventListener("input", function () { recalcRow(row); });
      });
    });

    var all = m.querySelector("#zbAll");
    if (all) all.onchange = function () {
      Array.prototype.forEach.call(m.querySelectorAll(".zb-ck"), function (c) { c.checked = all.checked; });
    };

    function bulk(onlyChecked) {
      var field = m.querySelector("#zbField").value;
      var raw = m.querySelector("#zbVal").value;
      if (raw === "") { Util.toast("请先填写批量值", true); return; }
      var n = Math.max(0, Math.round(Number(raw)));
      var cnt = 0;
      eachRow(function (row) {
        var ck = row.querySelector(".zb-ck");
        if (onlyChecked && !(ck && ck.checked)) return;
        var inp = row.querySelector('[data-f="' + field + '"]');
        if (!inp) return;
        inp.value = n; cnt++; recalcRow(row);
      });
      Util.toast("已为 " + cnt + " 行填入 " + n + "，点「保存」生效");
    }
    m.querySelector('[data-zb="toSel"]').onclick = function () { bulk(true); };
    m.querySelector('[data-zb="toAll"]').onclick = function () { bulk(false); };
    m.querySelector('[data-zb="cancel"]').onclick = function () { UI.Modal.hide(); };
    m.querySelector('[data-zb="save"]').onclick = function () {
      var changed = 0;
      eachRow(function (row) {
        var name = row.getAttribute("data-name");
        var o = origMap[name] || {};
        var t = Math.round(Number(row.querySelector('[data-f="base"]').value));
        var w = Math.round(Number(row.querySelector('[data-f="wh"]').value));
        var wa = Math.round(Number(row.querySelector('[data-f="warn"]').value));
        if (isNaN(t) || isNaN(w) || isNaN(wa)) return;
        if (t !== o.total) { Zones.setBase(name, t); changed++; }
        if (w !== o.warehouse) { Zones.setWarehouse(name, w); changed++; }
        if (wa !== o.warnAt) { Zones.setWarn(name, wa); changed++; }
      });
      UI.Modal.hide();
      Util.toast(changed ? ("已保存 " + changed + " 项设置") : "没有改动");
      draw();
    };
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.site = { render: render, refresh: refresh, openBatch: openBatch };
})();
