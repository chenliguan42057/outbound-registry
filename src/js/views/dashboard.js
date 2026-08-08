/**
 * dashboard.js — 仪表盘：KPI 卡（6 张）+ 4 P0 图表 + 2 P1 增强
 * 纯前端计算，零第三方依赖：
 *   P0：出入库对比柱状图（CSS flex）/ 库存分布环形图（SVG）/ 近30天出库热力（CSS grid）/ 低库存横向条形
 *   P1：近期活动时间轴 / KPI 卡扩展（今日活跃领取人数、近30天出库总量）
 * 数据源：State.list + Stock.summarize()/Stock.trend()，与报表同源同数字。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var UI = window.App.UI;
  var Config = window.App.Config;
  var State = window.App.State;
  var Stock = window.App.Stock;

  var container = null;

  function render(el) {
    container = el;
    el.innerHTML =
      '<div class="dash-page">' +
        '<div class="dash-cards" id="dashCards"></div>' +
        '<div class="chart-grid">' +
          '<div class="chart-card"><h3>📊 出入库对比</h3><div id="dashCompare"></div></div>' +
          '<div class="chart-card"><h3>🍩 库存分布</h3><div id="dashDonut"></div></div>' +
          '<div class="chart-card"><h3>🔥 近30天出库热力</h3><div class="chart-scroll" id="dashHeatmap"></div></div>' +
        '</div>' +
        '<div class="grid2">' +
          '<div class="card"><h2>低库存分布 <span class="tag">&lt;' + Config.LOW_STOCK_THRESHOLD + '</span></h2><div id="dashLowBars"></div></div>' +
          '<div class="card"><h2>近期活动时序</h2><div id="dashTimeline"></div></div>' +
        '</div>' +
        '<div class="grid2">' +
          '<div class="card"><h2>📈 业绩榜 <span class="tag">本月</span></h2><div id="dashRank"></div></div>' +
          '<div class="card"><h2>🔥 高频货品 <span class="tag">本月</span></h2><div id="dashHot"></div></div>' +
        '</div>' +
        '<div class="grid2">' +
          '<div class="card"><h2>低库存预警 <span class="tag">&lt;' + Config.LOW_STOCK_THRESHOLD + '</span></h2><div id="dashLow"></div></div>' +
          '<div class="card"><h2>最近出库</h2><div id="dashRecent"></div></div>' +
        '</div>' +
      '</div>';
    renderAll();
  }

  /** 云端同步后刷新：整体重建（聚合单遍 O(n) + 常量级 DOM 输出） */
  function refresh() {
    if (!container) return;
    renderAll();
  }

  /* ================= 聚合（单遍 O(n)） ================= */

  /** 类目归组：summary → {类目: 库存合计}；未命中兜底「其他」；全 0 类目剔除 */
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

  /**
   * 单遍聚合：KPI / 柱状图 / 环形图 / 热力 / 低条形 / 时间轴 所需全部数据一次算齐。
   * @param {Array} list State.list（新记录在前）
   */
  function aggregate(list) {
    list = list || State.list;
    var summary = Stock.summarize(list);
    var low = summary.filter(function (s) { return s.stock < Config.LOW_STOCK_THRESHOLD; })
      .sort(function (a, b) { return a.stock - b.stock; });
    var totalOut = 0, totalIn = 0, todayOut = 0, todayIn = 0;
    var todayActive = {};
    var now = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var today = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    list.forEach(function (r) {
      if (r.affectsStock !== true) return;
      var q = (r.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
      if ((r.type || "out") === "in") totalIn += q; else totalOut += q;
      if (String(r.time || "").slice(0, 10) === today) {
        if ((r.type || "out") === "in") todayIn += q;
        else { todayOut += q; if (r.picker) todayActive[r.picker] = 1; }
      }
    });
    var trend30 = Stock.trend(list, 30);
    var out30 = trend30.reduce(function (s, d) { return s + d.outQty; }, 0);
    var catMap = catAggregate(summary, Config.CATEGORY_MAP || {});
    var recent = list.slice(0, 10);
    return {
      summary: summary, low: low,
      totalOut: totalOut, totalIn: totalIn,
      todayOut: todayOut, todayIn: todayIn,
      todayActiveCount: Object.keys(todayActive).length,
      trend30: trend30, out30: out30,
      catMap: catMap, recent: recent
    };
  }

  /* ================= 渲染 ================= */

  function renderAll() {
    var agg = aggregate(State.list);
    renderCards(agg);
    renderCompare(agg);
    renderDonut(agg.catMap);
    renderHeatmap(agg.trend30);
    renderLowBars(agg.low);
    renderTimeline(agg.recent);
    renderRankBoard();
    renderHotProducts();
    renderLow();
    renderRecent();
  }

  /** KPI 卡：原 4 张 + P1 扩展 2 张（今日活跃领取人数 / 近30天出库总量） */
  function renderCards(agg) {
    var cards = [
      { label: "本地记录数", value: State.list.length, icon: "records" },
      { label: "今日出库", value: agg.todayOut, icon: "out" },
      { label: "今日入库", value: agg.todayIn, icon: "in" },
      { label: "低库存项", value: agg.low.length, icon: "stock" },
      { label: "今日活跃领取人数", value: agg.todayActiveCount, icon: "records" },
      { label: "近30天出库总量", value: agg.out30, icon: "report" }
    ];
    Util.$("dashCards").innerHTML = cards.map(function (c) {
      return '<div class="dash-card">' +
        '<div class="dash-card-icon">' + UI.icon(c.icon, 22) + '</div>' +
        '<div class="dash-card-value">' + c.value + '</div>' +
        '<div class="dash-card-label">' + Util.esc(c.label) + '</div>' +
      '</div>';
    }).join("");
  }

  /** P0-1 出入库对比柱状图：纯 CSS flex 双柱，出=紫 #6366F1 / 入=绿 #10B981，柱顶数字 + 图例 */
  function renderCompare(agg) {
    var el = Util.$("dashCompare");
    if (!el) return;
    var max = Math.max(agg.totalOut, agg.totalIn, 1);
    var outH = Math.max(2, Math.round(agg.totalOut / max * 100));
    var inH = Math.max(2, Math.round(agg.totalIn / max * 100));
    el.innerHTML =
      '<div class="compare-bar">' +
        '<div class="compare-col">' +
          '<div class="compare-num">' + agg.totalOut + '</div>' +
          '<div class="compare-fill out" style="height:' + outH + '%" title="总出库 ' + agg.totalOut + ' 件"></div>' +
          '<div class="compare-label">总出库</div>' +
        '</div>' +
        '<div class="compare-col">' +
          '<div class="compare-num">' + agg.totalIn + '</div>' +
          '<div class="compare-fill in" style="height:' + inH + '%" title="总入库 ' + agg.totalIn + ' 件"></div>' +
          '<div class="compare-label">总入库</div>' +
        '</div>' +
      '</div>' +
      '<div class="compare-legend"><span class="legend-dot out"></span>出库（紫） <span class="legend-dot in"></span>入库（绿）</div>';
  }

  /** P0-2 库存分布环形图：纯 SVG circle + stroke-dasharray 分段圆弧，中心总库存 + 图例 */
  function renderDonut(catMap) {
    var el = Util.$("dashDonut");
    if (!el) return;
    var keys = Object.keys(catMap || {});
    var total = keys.reduce(function (s, k) { return s + catMap[k]; }, 0);
    if (!total) {
      el.innerHTML = '<div class="empty">暂无库存数据</div>';
      return;
    }
    var R = 40;
    var C = 2 * Math.PI * R;
    var colors = Config.CHART_COLORS || [];
    var offset = 0;
    var segs = keys.map(function (k, i) {
      var frac = catMap[k] / total;
      var dash = frac * C;
      var color = colors[i % colors.length] || "#6366F1";
      var seg = {
        key: k, val: catMap[k], frac: frac, color: color,
        html: '<circle class="donut-seg" cx="50" cy="50" r="' + R + '" fill="none" stroke="' + color +
          '" stroke-width="18" stroke-dasharray="' + dash + ' ' + C + '" stroke-dashoffset="' + (-offset) + '" />'
      };
      offset += dash;
      return seg;
    });
    el.innerHTML =
      '<div class="donut-wrap">' +
        '<svg class="donut-svg" viewBox="0 0 100 100" width="140" height="140">' +
          '<circle cx="50" cy="50" r="' + R + '" fill="none" stroke="#EEF1F6" stroke-width="18" />' +
          '<g transform="rotate(-90 50 50)">' + segs.map(function (s) { return s.html; }).join("") + '</g>' +
          '<text x="50" y="47" text-anchor="middle" class="donut-center-num">' + total + '</text>' +
          '<text x="50" y="61" text-anchor="middle" class="donut-center-label">总库存</text>' +
        '</svg>' +
        '<div class="donut-legend">' + segs.map(function (s) {
          return '<div class="donut-legend-item">' +
            '<span class="donut-legend-dot" style="background:' + s.color + '"></span>' +
            '<span class="donut-legend-name">' + Util.esc(s.key) + '</span>' +
            '<span class="donut-legend-val">' + s.val + '（' + Math.round(s.frac * 100) + '%）</span>' +
          '</div>';
        }).join("") + '</div>' +
      '</div>';
  }

  /** P0-3 近30天出库热力：CSS grid 6列×5行=30格，格内日号，5 档色阶 t0..t4（决策 D-1，无星期表头） */
  function renderHeatmap(trend30) {
    var el = Util.$("dashHeatmap");
    if (!el) return;
    var data = trend30 || [];
    var max = data.reduce(function (m, d) { return Math.max(m, d.outQty); }, 0);
    function tier(qty) {
      if (qty <= 0 || max <= 0) return "heatmap-t0";
      var r = qty / max;
      if (r <= 0.2) return "heatmap-t1";
      if (r <= 0.4) return "heatmap-t2";
      if (r <= 0.6) return "heatmap-t3";
      return "heatmap-t4";
    }
    function md(s) { return String(s || "").slice(5).replace("-", "/"); }
    var cells = data.map(function (d) {
      var day = parseInt(String(d.date).slice(8), 10);
      var label = md(d.date);
      return '<div class="heatmap-cell ' + tier(d.outQty) + '" title="' + Util.esc(label) + '：' + d.outQty + ' 件">' +
        (isNaN(day) ? "" : day) + '</div>';
    }).join("");
    el.innerHTML =
      '<div class="heatmap-head">' + (data.length ? md(data[0].date) + " – " + md(data[data.length - 1].date) : "") + '（近 30 天，颜色深浅 = 出库件数）</div>' +
      '<div class="heatmap-grid">' + cells + '</div>' +
      '<div class="heatmap-legend">' +
        '<span class="heatmap-cell heatmap-t0"></span><span class="heatmap-cell heatmap-t1"></span>' +
        '<span class="heatmap-cell heatmap-t2"></span><span class="heatmap-cell heatmap-t3"></span>' +
        '<span class="heatmap-cell heatmap-t4"></span> 少 → 多' +
      '</div>';
  }

  /** P0-4 低库存横向条形：复用 .rank-row/.rank-bar，fill 红色渐变，Top8 */
  function renderLowBars(low) {
    var el = Util.$("dashLowBars");
    if (!el) return;
    var arr = (low || []).slice(0, 8);
    if (!arr.length) {
      el.innerHTML = '<div class="empty">暂无低库存货品</div>';
      return;
    }
    var max = arr[arr.length - 1].stock || 1;
    var html = arr.map(function (s, i) {
      var pct = Math.max(2, Math.round(s.stock / max * 100));
      return '<div class="rank-row">' +
        '<span class="rank-no">' + (i + 1) + '</span>' +
        '<span class="rank-name">' + Util.esc(s.name) + '</span>' +
        '<div class="rank-bar"><div class="rank-bar-fill low-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="rank-val danger-text">' + s.stock + '</span>' +
      '</div>';
    }).join("");
    el.innerHTML = html;
  }

  /** P1 近期活动时间轴：CSS 圆点 + 竖线，最近 10 条出入混合；首条高亮「最新」 */
  function renderTimeline(recent) {
    var el = Util.$("dashTimeline");
    if (!el) return;
    var arr = (recent || []).slice(0, 10);
    if (!arr.length) {
      el.innerHTML = '<div class="empty">暂无活动记录</div>';
      return;
    }
    var html = '<div class="timeline">' + arr.map(function (r, i) {
      var isIn = (r.type || "out") === "in";
      var items = (r.items || []).map(function (it) { return Util.esc(it.name) + "×" + it.qty; }).join("、");
      var time = Util.esc(String(r.time || "").replace("T", " "));
      var who = Util.esc(r.dept || "未知") + (r.picker ? "（" + Util.esc(r.picker) + "）" : "");
      return '<div class="timeline-item' + (i === 0 ? " first" : "") + '">' +
        '<span class="timeline-dot ' + (isIn ? "in" : "out") + '"></span>' +
        '<div class="timeline-body">' +
          '<div class="timeline-top">' +
            '<span class="timeline-time">' + time + '</span>' +
            '<span class="timeline-tag ' + (isIn ? "in" : "out") + '">' + (isIn ? "入库" : "出库") + '</span>' +
            (i === 0 ? '<span class="timeline-new">最新</span>' : "") +
          '</div>' +
          '<div class="timeline-who">' + who + '</div>' +
          '<div class="timeline-items">' + items + '</div>' +
        '</div>' +
      '</div>';
    }).join("") + '</div>';
    el.innerHTML = html;
  }

  /* ================= 保留：低库存预警列表 + 最近出库 ================= */

  function renderLow() {
    var low = Stock.summarize()
      .filter(function (s) { return s.stock < Config.LOW_STOCK_THRESHOLD; })
      .sort(function (a, b) { return a.stock - b.stock; })
      .slice(0, 8);
    var html = low.map(function (s) {
      return '<div class="rank-row">' +
        '<span class="rank-no">' + s.stock + '</span>' +
        '<span class="rank-name">' + Util.esc(s.name) + '</span>' +
        '<span class="rank-val danger-text">库存 ' + s.stock + '</span>' +
      '</div>';
    }).join("");
    Util.$("dashLow").innerHTML = html || '<div class="empty">暂无低库存货品</div>';
  }

  function renderRecent() {
    var recs = State.list.filter(function (r) { return (r.type || "out") !== "in"; }).slice(0, 8);
    var html = recs.map(function (r) {
      var items = (r.items || []).map(function (it) { return it.name + "×" + it.qty; }).join("、");
      return '<div class="recent-row">' +
        '<div class="recent-main">' +
          '<div class="recent-title">' + Util.esc(r.dept || "未知客户") +
            (r.picker ? "（" + Util.esc(r.picker) + "）" : "") + '</div>' +
          '<div class="recent-items">' + Util.esc(items) + '</div>' +
        '</div>' +
        '<div class="recent-time">' + Util.esc(String(r.time || "").replace("T", " ")) + '</div>' +
      '</div>';
    }).join("");
    Util.$("dashRecent").innerHTML = html || '<div class="empty">暂无出库记录</div>';
  }

  /* ================= B8 业绩榜 + 高频货品（本月） ================= */
  function monthPrefix() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1);
  }
  function renderRankBoard() {
    var el = Util.$("dashRank");
    if (!el) return;
    var mp = monthPrefix();
    var stat = {};
    (State.list || []).forEach(function (r) {
      if ((r.type || "out") === "in") return;
      if (!r.picker || String(r.time || "").slice(0, 7) !== mp) return;
      var q = (r.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0);
      if (!stat[r.picker]) stat[r.picker] = { count: 0, qty: 0 };
      stat[r.picker].count++;
      stat[r.picker].qty += q;
    });
    var arr = Object.keys(stat).map(function (k) { return { picker: k, count: stat[k].count, qty: stat[k].qty }; })
      .sort(function (a, b) { return b.qty - a.qty || b.count - a.count; }).slice(0, 6);
    if (!arr.length) { el.innerHTML = '<div class="empty">本月暂无出库登记</div>'; return; }
    var max = arr[0].qty || 1;
    el.innerHTML = arr.map(function (s, i) {
      var pct = Math.max(2, Math.round(s.qty / max * 100));
      return '<div class="rank-row">' +
        '<span class="rank-no">' + (i + 1) + '</span>' +
        '<span class="rank-name">' + Util.esc(s.picker) + '</span>' +
        '<div class="rank-bar"><div class="rank-bar-fill" style="width:' + pct + '%;background:linear-gradient(90deg,#7FB3A5,#A79ED0)"></div></div>' +
        '<span class="rank-val">' + s.qty + ' 件/' + s.count + ' 单</span>' +
      '</div>';
    }).join("");
  }
  function renderHotProducts() {
    var el = Util.$("dashHot");
    if (!el) return;
    var mp = monthPrefix();
    var stat = {};
    (State.list || []).forEach(function (r) {
      if (String(r.time || "").slice(0, 7) !== mp) return;
      (r.items || []).forEach(function (it) {
        var q = Number(it.qty) || 0;
        if (!stat[it.name]) stat[it.name] = 0;
        stat[it.name] += q;
      });
    });
    var arr = Object.keys(stat).map(function (k) { return { name: k, qty: stat[k] }; })
      .sort(function (a, b) { return b.qty - a.qty; }).slice(0, 6);
    if (!arr.length) { el.innerHTML = '<div class="empty">本月暂无出入记录</div>'; return; }
    var max = arr[0].qty || 1;
    el.innerHTML = arr.map(function (s, i) {
      var pct = Math.max(2, Math.round(s.qty / max * 100));
      return '<div class="rank-row">' +
        '<span class="rank-no">' + (i + 1) + '</span>' +
        '<span class="rank-name">' + Util.esc(s.name) + '</span>' +
        '<div class="rank-bar"><div class="rank-bar-fill" style="width:' + pct + '%;background:linear-gradient(90deg,#7FB08E,#6FA3A8)"></div></div>' +
        '<span class="rank-val">' + s.qty + '</span>' +
      '</div>';
    }).join("");
  }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.dashboard = { render: render, refresh: refresh };
})();
