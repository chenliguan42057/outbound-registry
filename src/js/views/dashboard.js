/**
 * dashboard.js — 仪表盘（2026-09-26 深度重构：宏观可视化大图）
 * 主理人要求：去掉 KPI 小卡与文字堆，融合成「一张华丽的宏观大图」：
 *   深色渐变巨卡 = 超大数字带（总库存/今日出/今日入/低库存）
 *               + 近30天出入库流量双曲线面积图（SVG 手绘，零依赖）
 *               + 库存分布环形 + 30天出库热力（下半区）
 * 纯前端计算，数据源 State.list + Stock.summarize()/Stock.trend()，与报表同源同数字。
 * ⚠️ 只读展示层：不写任何数据。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Config = window.App.Config;
  var State = window.App.State;
  var Stock = window.App.Stock;

  var container = null;
  var activeTab = "main";   // "main" 仪表盘（宏观大图） | "report" 报表统计

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="card" style="padding:14px 18px">' +
        '<div class="actions" style="margin-bottom:0;gap:8px">' +
          '<button type="button" class="btn sm active dash-tab" data-tab="main">📊 仪表盘</button>' +
          '<button type="button" class="btn ghost sm dash-tab" data-tab="report">📈 报表统计</button>' +
        '</div>' +
      '</div>' +
      '<div id="dashTabBody"></div>';
    el.querySelectorAll('.dash-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        activeTab = b.getAttribute('data-tab');
        el.querySelectorAll('.dash-tab').forEach(function (x) {
          x.classList.toggle('active', x === b);
        });
        renderTab();
      });
    });
    renderTab();
  }

  function renderTab() {
    var body = container ? container.querySelector('#dashTabBody') : null;
    if (!body) return;
    body.innerHTML = '';
    if (activeTab === 'report') {
      if (window.App.Views.report && window.App.Views.report.render) {
        window.App.Views.report.render(body);
      } else {
        body.innerHTML = '<div class="empty">报表模块未加载</div>';
      }
      return;
    }
    renderMain(body);
  }

  function refresh() {
    if (!container) return;
    if (activeTab === 'report' && window.App.Views.report && window.App.Views.report.refresh) {
      window.App.Views.report.refresh();
      return;
    }
    renderTab();
  }

  /* ================= 聚合（单遍 O(n)） ================= */

  function getWarnAt(name) {
    var w = Number((Config.WARN_AT || {})[name]);
    return (!isNaN(w) && w >= 0) ? w : Config.LOW_STOCK_THRESHOLD;
  }

  /** 类目归组：summary → {类目: 库存合计}（环形图用） */
  function catAggregate(summary, map) {
    var out = {};
    var keys = Object.keys(map || {});
    keys.forEach(function (k) { out[k] = 0; });
    out["其他"] = 0;
    summary.forEach(function (s) {
      var hit = null;
      for (var i = 0; i < keys.length; i++) {
        if (map[keys[i]].indexOf(s.name) !== -1) { hit = keys[i]; break; }
      }
      out[hit || "其他"] += s.stock;
    });
    var result = {};
    Object.keys(out).forEach(function (k) { if (out[k] > 0) result[k] = out[k]; });
    return result;
  }

  function aggregate(list) {
    list = list || State.list;
    var summary = Stock.summarize(list);
    var low = summary.filter(function (s) { return s.stock < getWarnAt(s.name); });
    var totalStock = summary.reduce(function (s, x) { return s + x.stock; }, 0);
    var todayOut = 0, todayIn = 0;
    var today = Util.todayLocal();
    list.forEach(function (r) {
      if (r.affectsStock !== true) return;
      var q = (r.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
      if (String(r.time || "").slice(0, 10) !== today) return;
      if ((r.type || "out") === "in") todayIn += q; else todayOut += q;
    });
    var trend30 = Stock.trend(list, 30);
    return {
      summary: summary, low: low, totalStock: totalStock,
      todayOut: todayOut, todayIn: todayIn,
      trend30: trend30,
      catMap: catAggregate(summary, Config.CATEGORY_MAP || {})
    };
  }

  /* ================= 宏观大图 ================= */

  function renderMain(el) {
    el.innerHTML = '<div class="dash-hero" id="dashHero">加载中…</div>';
    renderHero(aggregate(State.list));
  }

  function renderHero(agg) {
    var el = Util.$("dashHero");
    if (!el) return;
    el.innerHTML =
      '<div class="dh-kpis">' +
        '<div class="dh-kpi"><b>' + agg.totalStock + '</b><span>总库存</span></div>' +
        '<div class="dh-kpi"><b>' + agg.todayOut + '</b><span>今日出库</span></div>' +
        '<div class="dh-kpi"><b>' + agg.todayIn + '</b><span>今日入库</span></div>' +
        '<div class="dh-kpi' + (agg.low.length ? ' warn' : '') + '"><b>' + agg.low.length + '</b><span>低库存</span></div>' +
      '</div>' +
      '<div class="dh-chart-head">' +
        '<span class="dh-chart-title">近 30 天出入库流量</span>' +
        '<span class="dh-legend"><i class="dh-dot out"></i>出库<i class="dh-dot in"></i>入库</span>' +
      '</div>' +
      '<div class="dh-chart">' + flowChartSvg(agg.trend30) + '</div>' +
      '<div class="dh-bottom">' +
        '<div class="dh-donut">' + donutSvg(agg.catMap) + '</div>' +
        '<div class="dh-heat">' + heatHtml(agg.trend30) + '</div>' +
      '</div>';
  }

  /** 平滑曲线（中点法三次贝塞尔） */
  function smoothPath(pts) {
    if (!pts.length) return "";
    var d = "M" + pts[0].x.toFixed(1) + " " + pts[0].y.toFixed(1);
    for (var i = 1; i < pts.length; i++) {
      var p0 = pts[i - 1], p1 = pts[i];
      var mx = ((p0.x + p1.x) / 2).toFixed(1);
      d += " C" + mx + " " + p0.y.toFixed(1) + " " + mx + " " + p1.y.toFixed(1) + " " + p1.x.toFixed(1) + " " + p1.y.toFixed(1);
    }
    return d;
  }

  /** 近30天双系列面积图（SVG viewBox 720×250，宽度自适应容器） */
  function flowChartSvg(trend30) {
    var data = trend30 || [];
    var W = 720, H = 250, padL = 10, padR = 10, padT = 16, padB = 28;
    var iw = W - padL - padR, ih = H - padT - padB;
    var max = 1;
    data.forEach(function (d) { max = Math.max(max, d.outQty, d.inQty); });
    function pts(key) {
      return data.map(function (d, i) {
        return {
          x: padL + (data.length === 1 ? iw / 2 : i * iw / (data.length - 1)),
          y: padT + (1 - (d[key] || 0) / max) * ih
        };
      });
    }
    var pOut = pts("outQty"), pIn = pts("inQty");
    var lineOut = smoothPath(pOut), lineIn = smoothPath(pIn);
    var base = (H - padB).toFixed(1);
    var areaOut = lineOut ? lineOut + " L" + pOut[pOut.length - 1].x.toFixed(1) + " " + base + " L" + pOut[0].x.toFixed(1) + " " + base + " Z" : "";
    var areaIn = lineIn ? lineIn + " L" + pIn[pIn.length - 1].x.toFixed(1) + " " + base + " L" + pIn[0].x.toFixed(1) + " " + base + " Z" : "";
    /* 网格 3 条 */
    var grid = "";
    for (var g = 1; g <= 3; g++) {
      var gy = (padT + ih * g / 4).toFixed(1);
      grid += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '" stroke="rgba(255,255,255,.07)" stroke-width="1"/>';
    }
    /* x 轴日期：首 / 1/3 / 2/3 / 末 */
    var labels = "";
    var idxs = data.length > 3 ? [0, Math.round((data.length - 1) / 3), Math.round((data.length - 1) * 2 / 3), data.length - 1] : data.map(function (_, i) { return i; });
    idxs.forEach(function (i) {
      if (!data[i]) return;
      var x = padL + (data.length === 1 ? iw / 2 : i * iw / (data.length - 1));
      labels += '<text x="' + x.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" class="dh-x-label">' +
        Util.esc(String(data[i].date).slice(5).replace("-", "/")) + '</text>';
    });
    /* hover 捕获列 */
    var hover = "";
    var step = iw / (data.length || 1);
    data.forEach(function (d, i) {
      hover += '<rect x="' + (padL + i * step).toFixed(1) + '" y="' + padT + '" width="' + Math.max(step, 4).toFixed(1) +
        '" height="' + ih + '" fill="transparent"><title>' + Util.esc(String(d.date).slice(5).replace("-", "/")) +
        '　出 ' + d.outQty + ' ／ 入 ' + d.inQty + '</title></rect>';
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:auto;display:block">' +
      '<defs>' +
        '<linearGradient id="dhgOut" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="#B9AEDF" stop-opacity=".38"/><stop offset="1" stop-color="#B9AEDF" stop-opacity="0"/>' +
        '</linearGradient>' +
        '<linearGradient id="dhgIn" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="#7FCDB6" stop-opacity=".34"/><stop offset="1" stop-color="#7FCDB6" stop-opacity="0"/>' +
        '</linearGradient>' +
      '</defs>' +
      grid +
      (areaOut ? '<path d="' + areaOut + '" fill="url(#dhgOut)"/>' : '') +
      (areaIn ? '<path d="' + areaIn + '" fill="url(#dhgIn)"/>' : '') +
      (lineOut ? '<path d="' + lineOut + '" fill="none" stroke="#C9BFEC" stroke-width="2.2" stroke-linecap="round"/>' : '') +
      (lineIn ? '<path d="' + lineIn + '" fill="none" stroke="#8AD4BC" stroke-width="2.2" stroke-linecap="round"/>' : '') +
      labels + hover +
    '</svg>';
  }

  /** 库存分布环形（深色底版本，中心总库存，极简图例） */
  function donutSvg(catMap) {
    var keys = Object.keys(catMap || {});
    var total = keys.reduce(function (s, k) { return s + catMap[k]; }, 0);
    if (!total) return '<div class="dh-none">暂无库存数据</div>';
    var R = 52, C = 2 * Math.PI * R;
    var colors = Config.CHART_COLORS && Config.CHART_COLORS.length ? Config.CHART_COLORS : ["#7FCDB6", "#B9AEDF", "#8FBFD9", "#E3C987", "#D9A0A0"];
    var offset = 0;
    var segs = keys.map(function (k, i) {
      var frac = catMap[k] / total;
      var dash = frac * C;
      var color = colors[i % colors.length];
      var html = '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + color +
        '" stroke-width="17" stroke-dasharray="' + dash.toFixed(2) + ' ' + C.toFixed(2) +
        '" stroke-dashoffset="' + (-offset).toFixed(2) + '"><title>' + Util.esc(k) + ' ' + catMap[k] + '（' + Math.round(frac * 100) + '%）</title></circle>';
      offset += dash;
      return { key: k, val: catMap[k], frac: frac, color: color, html: html };
    });
    return '<div class="dh-donut-wrap">' +
      '<svg viewBox="0 0 140 140" style="width:150px;height:150px;display:block">' +
        '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="17"/>' +
        '<g transform="rotate(-90 70 70)">' + segs.map(function (s) { return s.html; }).join("") + '</g>' +
        '<text x="70" y="66" text-anchor="middle" class="dh-donut-num">' + total + '</text>' +
        '<text x="70" y="82" text-anchor="middle" class="dh-donut-cap">总库存</text>' +
      '</svg>' +
      '<div class="dh-donut-legend">' + segs.map(function (s) {
        return '<div class="dh-leg-row"><i class="dh-dot" style="background:' + s.color + '"></i>' +
          '<span class="dh-leg-name">' + Util.esc(s.key) + '</span><span class="dh-leg-val">' + Math.round(s.frac * 100) + '%</span></div>';
      }).join("") + '</div>' +
    '</div>';
  }

  /** 30 天出库热力（深色底薄荷色阶，极简） */
  function heatHtml(trend30) {
    var data = trend30 || [];
    if (!data.length) return '<div class="dh-none">暂无流量数据</div>';
    var max = data.reduce(function (m, d) { return Math.max(m, d.outQty); }, 0);
    function tier(q) {
      if (q <= 0 || max <= 0) return 0;
      var r = q / max;
      if (r <= 0.2) return 1;
      if (r <= 0.4) return 2;
      if (r <= 0.6) return 3;
      return 4;
    }
    var cells = data.map(function (d) {
      return '<div class="dh-hcell t' + tier(d.outQty) + '" title="' + Util.esc(String(d.date).slice(5).replace("-", "/")) +
        '　出库 ' + d.outQty + ' 件">' + (parseInt(String(d.date).slice(8), 10) || "") + '</div>';
    }).join("");
    return '<div class="dh-heat-head"><span>近 30 天出库热力</span><span class="dh-heat-scale">' +
      '<i class="dh-hcell t0"></i><i class="dh-hcell t1"></i><i class="dh-hcell t2"></i><i class="dh-hcell t3"></i><i class="dh-hcell t4"></i>' +
      '</span></div>' +
      '<div class="dh-hgrid">' + cells + '</div>' +
      '<div class="dh-heat-foot">颜色越深 = 当日出库越多 · 悬停看每天</div>';
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.dashboard = { render: render, refresh: refresh };
})();
