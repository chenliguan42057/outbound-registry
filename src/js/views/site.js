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

  function sortRows(list) {
    return list.slice().sort(function (a, b) {
      if (a.low !== b.low) return a.low ? -1 : 1;
      if ((a.total > 0) !== (b.total > 0)) return a.total > 0 ? -1 : 1;
      if (a.site !== b.site) return a.site - b.site;
      return a.name.localeCompare(b.name, "zh");
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
        '<button type="button" class="btn sm zone-set-btn" data-act="batchset">⚙ 分区设置（单个 / 批量）</button>' +
      '</div>' +
      (shown.length ? '<div class="zone-grid">' + shown.map(card).join("") + '</div>'
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

  function card(s) {
    var u = unitOf(s.name);
    var barSite = pct(s.site, s.total);
    return '<div class="zone-card' + (s.low ? " low" : "") + '">' +
      '<div class="zc-head">' +
        '<div class="zc-name">' + Util.esc(s.name) + (u ? ' <i class="zc-unit">' + Util.esc(u) + '</i>' : '') + '</div>' +
        (s.low ? '<span class="zc-flag">⚠ 现场偏低</span>' : '') +
      '</div>' +
      '<div class="zc-main">' +
        '<div class="zc-figure"><b' + (s.low ? ' class="warn"' : '') + '>' + s.site + '</b><span>现场可用</span></div>' +
        '<div class="zc-meta">' +
          '<span>仓库锁定 <b>' + s.warehouse + '</b></span>' +
          (s.inTransit > 0 ? '<span class="zc-trans">在途 <b>' + s.inTransit + '</b></span>' : '') +
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
