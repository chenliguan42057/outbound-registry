/**
 * batch.js — 批次管理页（2026-11-27）
 *
 * 定位：库存的「第二层视图」。总库存（stock.js）是权威口径，这里只回答三件事：
 *   ① 每个启用了批次管理的货品，现在还有哪几批、各批余量多少、先进先出该扣谁；
 *   ② 「未归批」有多少（历史期初 + 调拨调入 + 没有批号的老流水），提醒还有多少货没批号归属；
 *   ③ 哪些货品要启用 / 停用批次管理（写货品目录 product.batch，随 catalog.json 云端同步）。
 *
 * ★ 不新增任何云端数据文件 —— 批次全部从 data/records 的 item.batch / item.batches 反推。
 * ★ 只读页面：除「启用开关」外不动任何记录；数据修正走盘点或重新入库。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Config = window.App.Config;

  function B() { return window.App.Batches; }

  function dayOf(ts) {
    if (!ts || ts === Infinity) return "—";
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return "—";
    return d.getFullYear() + "-" + Util.pad2(d.getMonth() + 1) + "-" + Util.pad2(d.getDate());
  }

  function num(n) { return Util.numFmt ? Util.numFmt(n) : String(n); }

  function statCard(label, value, sub, tone) {
    return '<div class="stat-card' + (tone ? ' warn' : '') + '">' +
        '<span class="stat-num">' + value + '</span>' +
        '<span class="stat-label">' + label + '</span>' +
        '<span class="stat-hint">' + sub + '</span>' +
      '</div>';
  }

  function render(container) {
    var rows = (B() && B().summary) ? B().summary() : [];
    var managed = rows.filter(function (r) { return r.managed; });
    var lotCount = managed.reduce(function (s, r) { return s + r.lotCount; }, 0);
    var unbatched = managed.reduce(function (s, r) { return s + Math.max(0, r.unbatched); }, 0);
    var negList = managed.filter(function (r) { return r.unbatched < 0; });

    // 启用的排前面（未启用的也要列出来，用户才知道还有哪些能开）
    rows.sort(function (a, b) {
      if (a.managed !== b.managed) return a.managed ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), "zh-Hans-CN");
    });

    container.innerHTML =
      '<div class="card">' +
        '<h2>批次管理 <span class="tag">先进先出</span></h2>' +
        '<div class="hint" style="margin:-2px 0 12px">总库存口径不变（与库存查询页一致）。这里按批号看每批还剩多少：入库填批号 → 出库默认扣最早那批，也可以手选批次。没有批号的货品不用启用。</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">' +
          statCard("启用批次货品", managed.length + " 个", "共 " + rows.length + " 个货品") +
          statCard("在库批次数", lotCount + " 批", "有批号归属的批次") +
          statCard("未归批合计", num(unbatched), "历史期初与无批号流水") +
          statCard("批次账异常", negList.length + " 个", negList.length ? "批次数超出总库存" : "无异常", negList.length) +
        '</div>' +
        '<div class="actions" style="margin-top:14px">' +
          '<button type="button" class="btn" id="btManage">⚙ 管理启用批次的产品</button>' +
          '<button type="button" class="btn ghost" id="btExport">⬇ 导出批次 CSV</button>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<h2>货品批次总览</h2>' +
        '<div class="field" style="margin:0 0 10px">' +
          '<input type="search" class="search" id="btSearch" placeholder="搜索货品名称…" autocomplete="off" />' +
        '</div>' +
        '<div class="table-wrap">' +
          '<table class="table">' +
            '<thead><tr>' +
              '<th>货品名称</th><th>批次</th><th style="text-align:right">总库存</th>' +
              '<th style="text-align:right">批次合计</th><th style="text-align:right">未归批</th><th style="text-align:right">批次数</th><th>明细</th>' +
            '</tr></thead>' +
            '<tbody id="btRows"></tbody>' +
          '</table>' +
        '</div>' +
        '<div class="hint" style="margin:10px 0 0">未归批 = 总库存 − 各批次剩余合计。历史期初库存、调拨调入、以及没填批号的出入库都会落在这里；负数表示批次账超出总库存（一般是老出库没批号，属于提示不是错）。</div>' +
      '</div>';

    var rowsEl = container.querySelector("#btRows");
    var searchEl = container.querySelector("#btSearch");

    function draw() {
      var kw = String(searchEl.value || "").trim().toLowerCase();
      var list = rows.filter(function (r) {
        if (!kw) return true;
        return String(r.name).toLowerCase().indexOf(kw) !== -1;
      });
      if (!list.length) {
        rowsEl.innerHTML = '<tr><td colspan="7" class="hint" style="padding:16px">没有匹配的货品</td></tr>';
        return;
      }
      rowsEl.innerHTML = list.map(function (r) {
        var neg = r.unbatched < 0;
        return '<tr data-name="' + Util.esc(r.name) + '">' +
            '<td>' + Util.esc(r.name) + (r.managed ? ' <span class="tag">批次</span>' : '') + '</td>' +
            '<td>' + (r.managed ? '<span class="c-ok">已启用</span>' : '<span class="hint">未启用</span>') + '</td>' +
            '<td style="text-align:right">' + num(r.total) + '</td>' +
            '<td style="text-align:right">' + (r.managed ? num(r.batchTotal) : '—') + '</td>' +
            '<td style="text-align:right"' + (neg ? ';color:#C0563F;font-weight:700' : '') + '>' + (r.managed ? num(r.unbatched) : '—') + '</td>' +
            '<td style="text-align:right">' + (r.managed ? r.lotCount : '—') + '</td>' +
            '<td>' + (r.managed ? '<button type="button" class="btn ghost sm bt-detail" data-name="' + Util.esc(r.name) + '">📋 查看</button>' : '') + '</td>' +
          '</tr>';
      }).join("");
    }

    rowsEl.addEventListener("click", function (e) {
      var btn = e.target.closest(".bt-detail");
      if (!btn) return;
      openDetail(btn.getAttribute("data-name"));
    });
    searchEl.addEventListener("input", draw);
    container.querySelector("#btManage").addEventListener("click", function () { openManager(container); });
    container.querySelector("#btExport").addEventListener("click", function () { exportCsv(rows); });
    draw();
  }

  /* ================= 某货品的批次明细 ================= */
  function openDetail(name) {
    var lots = (B() && B().lotsOf) ? B().lotsOf(name) : [];
    var total = 0, batchTotal = 0, reserved = 0;
    var all = (B() && B().summary) ? B().summary() : [];
    all.forEach(function (r) {
      if (r.name !== name) return;
      total = r.total; batchTotal = r.batchTotal; reserved = r.reserved;
    });
    var unbatched = total - batchTotal;

    var head = '<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0 0 12px">' +
        '<div><div class="hint" style="margin:0">总库存</div><b>' + num(total) + '</b></div>' +
        '<div><div class="hint" style="margin:0">批次合计</div><b>' + num(batchTotal) + '</b></div>' +
        '<div><div class="hint" style="margin:0">未归批</div><b' + (unbatched < 0 ? ' style="color:#C0563F"' : '') + '>' + num(unbatched) + '</b></div>' +
        '<div><div class="hint" style="margin:0">冻结占用</div><b>' + num(reserved) + '</b></div>' +
      '</div>';

    var body = lots.length
      ? lots.map(function (l) {
          var st = l.remain <= 0 ? '<span class="hint">已用完</span>'
            : (l.avail <= 0 ? '<span style="color:#C08A3F">全部占用</span>' : '<span class="c-ok">有货</span>');
          return '<div class="bt-lot" style="padding:10px 0;border-bottom:1px dashed var(--line-soft,#DCE6E0)">' +
              '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px">' +
                '<b style="font-size:14px">' + Util.esc(l.no) + '</b>' +
                '<span class="hint" style="margin:0;font-size:12px">首次入库 ' + dayOf(l.firstTs) + ' · 最近 ' + dayOf(l.lastTs) + '</span>' +
              '</div>' +
              '<div style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin-top:6px;font-size:12px">' +
                '<div><div class="hint" style="margin:0">入库</div><b>' + num(l.inQty) + '</b></div>' +
                '<div><div class="hint" style="margin:0">已出</div><b>' + num(l.outQty) + '</b></div>' +
                '<div><div class="hint" style="margin:0">剩余</div><b>' + num(l.remain) + '</b></div>' +
                '<div><div class="hint" style="margin:0">冻结</div><b>' + num(l.reserved) + '</b></div>' +
                '<div><div class="hint" style="margin:0">可用</div><b>' + num(l.avail) + '</b></div>' +
              '</div>' +
              '<div style="margin-top:6px;display:flex;justify-content:space-between;align-items:center;gap:8px">' +
                '<span class="hint" style="margin:0;font-size:12px">' + st + '</span>' +
                '<button type="button" class="btn ghost sm bt-lot-flow" data-no="' + Util.esc(l.no) + '">流水（' + (l.events || []).length + '）</button>' +
              '</div>' +
              '<div class="bt-lot-flowbox" style="display:none;margin-top:8px"></div>' +
            '</div>';
        }).join("")
      : '<div class="hint" style="padding:16px 0">该货品还没有带批号的入库记录。启用批次后，入库时填上批号就会出现在这里。</div>';

    UI.Modal.show("批次明细 · " + name, head + body, { width: "640px" });
    var mb = UI.Modal.body();
    /* Modal 是单例：批次流水只能行内展开，不能再弹一层 */
    mb.addEventListener("click", function (e) {
      var btn = e.target.closest(".bt-lot-flow");
      if (!btn) return;
      var box = btn.closest(".bt-lot").querySelector(".bt-lot-flowbox");
      if (!box) return;
      if (box.style.display !== "none") { box.style.display = "none"; return; }
      var no = btn.getAttribute("data-no");
      var lot = null;
      lots.forEach(function (l) { if (l.no === no) lot = l; });
      var evs = (lot && lot.events ? lot.events.slice() : []).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      box.innerHTML = evs.length
        ? '<div style="max-height:200px;overflow:auto">' + evs.map(function (ev) {
            var isIn = ev.type === "in";
            return '<div style="display:grid;grid-template-columns:130px 44px minmax(0,1fr);gap:8px;padding:4px 0;font-size:12px">' +
                '<span class="hint" style="margin:0">' + Util.esc(String(ev.time || "").replace("T", " ")) + '</span>' +
                '<span style="color:' + (isIn ? "#3D7A5A" : "#C0563F") + ';font-weight:600">' + (isIn ? "入库" : "出库") + '</span>' +
                '<span>' + (isIn ? "+" : "") + num(ev.qty) + '</span>' +
              '</div>';
          }).join("") + '</div>'
        : '<div class="hint">暂无流水</div>';
      box.style.display = "";
    });
  }

  /* ================= 启用批次的产品管理 ================= */
  function openManager(container) {
    var Cat = window.App.Catalog;
    if (!Cat || !Cat.get || !Cat.setBatchManaged || !Cat.get() || !Array.isArray(Cat.get().products)) {
      Util.toast("货品目录还没加载好，请等两秒再打开", true);
      return;
    }
    var body =
      '<div class="hint" style="margin:-2px 0 10px">📦 启用后：该货品<b>入库必须填批号</b>、<b>出库默认先进先出</b>（可选批次）。历史库存不会被改写，一律记为「未归批」。点一下即时切换，自动保存到云端。</div>' +
      '<div class="field" style="margin:0 0 10px">' +
        '<input type="text" class="search bp2-search" placeholder="搜索货品名称…" autocomplete="off" />' +
      '</div>' +
      '<div class="table-wrap" style="max-height:50vh;overflow:auto">' +
        '<table class="table" style="width:100%;min-width:0">' +
          '<thead><tr><th>货品名称</th><th style="width:130px;text-align:right">批次管理</th></tr></thead>' +
          '<tbody class="bp2-rows"></tbody>' +
        '</table>' +
      '</div>' +
      '<div class="modal-actions" style="margin-top:12px">' +
        '<button type="button" class="btn ghost sm" data-act="cancel">关闭</button>' +
      '</div>';
    UI.Modal.show("⚙ 启用批次的产品", body, { width: "620px" });
    var mb = UI.Modal.body();
    var rowsEl = mb.querySelector(".bp2-rows");
    var searchEl = mb.querySelector(".bp2-search");

    function draw() {
      var c = Cat.get();
      var list = (c && c.products) || [];
      var kw = String(searchEl.value || "").trim().toLowerCase();
      var rows = list.filter(function (p) {
        return !kw || String(p.name).toLowerCase().indexOf(kw) !== -1;
      });
      rows.sort(function (a, b) {
        return (Config.isBatchManaged(a.name) ? 0 : 1) - (Config.isBatchManaged(b.name) ? 0 : 1);
      });
      if (!rows.length) {
        rowsEl.innerHTML = '<tr><td colspan="2" class="hint" style="padding:14px">没有匹配的货品</td></tr>';
        return;
      }
      rowsEl.innerHTML = rows.map(function (p) {
        var on = Config.isBatchManaged(p.name);
        return '<tr>' +
            '<td>' + Util.esc(p.name) + (on ? ' <span class="tag">批次</span>' : '') + '</td>' +
            '<td style="text-align:right">' +
              '<button type="button" class="btn ' + (on ? "sm" : "ghost sm") + '" data-bt="' + Util.esc(p.name) + '" data-to="' + (on ? "0" : "1") + '">' +
                (on ? '📦 已启用' : '启用') +
              '</button>' +
            '</td>' +
          '</tr>';
      }).join("");
    }

    rowsEl.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-bt]");
      if (!btn || btn.getAttribute("data-busy") === "1") return;
      var name = btn.getAttribute("data-bt");
      var on = btn.getAttribute("data-to") === "1";
      btn.setAttribute("data-busy", "1");
      btn.disabled = true;
      btn.textContent = "保存中…";
      Cat.setBatchManaged(name, on, function (ok, msg) {
        if (ok) Util.toast(on ? ("已启用批次管理：" + name) : ("已停用批次管理：" + name));
        else Util.toast(msg || "保存失败，请重试", true);
        draw();
        if (container && container.querySelector("#btRows")) render(container);   // 主表同步刷新
      });
    });
    searchEl.addEventListener("input", draw);
    draw();
  }

  /* ================= 导出批次 CSV ================= */
  function exportCsv(rows) {
    var lines = ["货品名称,批号,首次入库,最近入库,入库合计,已出库,剩余,冻结占用,可用,状态"];
    (rows || []).forEach(function (r) {
      if (!r.managed) return;
      if (!r.lots.length) {
        lines.push([r.name, "（无批次）", "", "", 0, 0, 0, 0, 0, "未启用批次流水"].join(","));
        return;
      }
      r.lots.forEach(function (l) {
        lines.push([
          r.name, l.no, dayOf(l.firstTs), dayOf(l.lastTs),
          l.inQty, l.outQty, l.remain, l.reserved, l.avail,
          l.remain <= 0 ? "已用完" : (l.avail <= 0 ? "全部占用" : "有货")
        ].map(function (v) {
          var s = String(v == null ? "" : v);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(","));
      });
    });
    var csv = "\ufeff" + lines.join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "批次明细_" + (Util.todayLocal ? Util.todayLocal() : Date.now()) + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    Util.toast("已导出批次明细 CSV");
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.batch = {
    render: render,
    refresh: function () {
      var host = document.querySelector("#winContent") || document.querySelector(".win-content");
      if (host) render(host);
    }
  };
})();
