/**
 * maintain.js — 数据维护 / 运行状况面板（2026-09-26 精修 P3，动画版）
 * ------------------------------------------------------------------
 * 主理人诉求（本版）：
 *   ① 网络延迟检测 —— 用动画呈现（雷达环 + 滚动波形 + 信号格），少写字、多画图
 *   ② 数据概览四卡 —— 数字滚动 + 迷你条动画
 *   ③ 选一天看差异 —— 动画条形图为主，文字只留必要说明
 *   ④ 去掉「快照一键下载」整块
 * 红线：本页**只读**——不写 localStorage、不改记录、不推云端（只做只读 GET 探活）。
 *
 * 数据来源：当前数据 = 内存 State；历史快照 = 仓库 <dataDir>/backups/YYYY-MM-DD.json（只读拉取）
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Config = window.App.Config;
  var State = window.App.State;
  var Cloud = window.App.Cloud;
  var Stock = window.App.Stock;

  var host = null;
  var snapDates = [];
  var treeTried = false;

  /* 动画/探测的手柄：切页时必须全部停掉，避免后台空转 */
  var rafId = null;
  var probeTimer = null;
  var probing = false;
  var samples = [];        // 最近若干次探测延迟（ms），null 表示超时/失败
  var lastPing = null;

  function esc(s) { return Util.esc(String(s == null ? "" : s)); }
  function sysDir() { return Config.Sys.current().dataDir; }
  function num(n) { return (Number(n) || 0).toLocaleString("zh-CN"); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function stopAll() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
    probing = false;
  }

  /* ================= 网络延迟检测 ================= */

  /** 单次探活：GET api.github.com/zen（支持 CORS，无鉴权、纯只读），返回往返毫秒；失败返回 null */
  async function probeOnce() {
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 8000);
    try {
      await fetch("https://api.github.com/zen?_t=" + Date.now(), {
        cache: "no-store",
        mode: "cors",
        signal: ctrl ? ctrl.signal : undefined
      });
      clearTimeout(to);
      var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
      return Math.round(t1 - t0);
    } catch (e) {
      clearTimeout(to);
      return null;
    }
  }

  /** 延迟 → 档位：0 优秀 / 1 良好 / 2 偏慢 / 3 断开 */
  function grade(ms) {
    if (ms == null) return 3;
    if (ms < 300) return 0;
    if (ms < 800) return 1;
    if (ms < 2000) return 2;
    return 3;
  }
  var GRADE_TEXT = ["流畅", "良好", "偏慢", "连不上"];
  var GRADE_CLS = ["g0", "g1", "g2", "g3"];

  /** 最近 N 次的统计：均值 / 抖动(极差) / 丢包率 */
  function stat() {
    var arr = samples.slice(-20);
    var okArr = arr.filter(function (v) { return v != null; });
    if (!arr.length) return { avg: null, jit: null, loss: 0 };
    var avg = okArr.length ? Math.round(okArr.reduce(function (a, b) { return a + b; }, 0) / okArr.length) : null;
    var jit = okArr.length > 1 ? Math.round(Math.max.apply(null, okArr) - Math.min.apply(null, okArr)) : 0;
    var loss = Math.round((arr.length - okArr.length) / arr.length * 100);
    return { avg: avg, jit: jit, loss: loss };
  }

  /** 启动探活 + 波形动画（页面卸载/切页即停） */
  function startNet() {
    var wave = Util.$("mtWave");
    var big = Util.$("mtPingBig");
    var gradeEl = Util.$("mtPingGrade");
    var barsEl = Util.$("mtBars");
    var mAvg = Util.$("mtMAvg"), mJit = Util.$("mtMJit"), mLoss = Util.$("mtMLoss");
    var ring = Util.$("mtRingSpin");
    if (!wave) return;

    var W = 560, H = 96, N = 56;          // 波形画布与采样点数量
    var upper = 2000;                     // 纵轴上界（ms），超出贴顶
    var shown = 0;                        // 大数字平滑跟随的显示值

    function y(ms) {
      if (ms == null) return H - 2;
      return H - 2 - clamp(ms / upper, 0, 1) * (H - 8);
    }

    function paint() {
      if (!document.body.contains(wave)) { stopAll(); return; }   // 已切页 → 自动停
      var buf = samples.slice(-N);
      while (buf.length < N) buf.unshift(null);
      var pts = buf.map(function (v, i) { return (i / (N - 1) * W).toFixed(1) + "," + y(v).toFixed(1); }).join(" ");
      var lineEl = Util.$("mtWaveLine");
      var areaEl = Util.$("mtWaveArea");
      if (lineEl) lineEl.setAttribute("points", pts);
      if (areaEl) areaEl.setAttribute("points", "0," + H + " " + pts + " " + W + "," + H);

      var s = stat();
      var g = grade(lastPing);
      var target = s.avg == null ? 0 : s.avg;
      shown += (target - shown) * 0.12;
      if (big) big.textContent = lastPing == null ? "—" : Math.round(shown);
      if (gradeEl) {
        gradeEl.textContent = GRADE_TEXT[g];
        gradeEl.className = "mt-grade " + GRADE_CLS[g];
      }
      if (ring) ring.setAttribute("class", "mt-ring-spin " + GRADE_CLS[g]);
      if (barsEl) {
        var lit = lastPing == null ? 0 : (g === 0 ? 5 : (g === 1 ? 4 : (g === 2 ? 2 : 1)));
        for (var i = 0; i < 5; i++) {
          var b = barsEl.children[i];
          if (b) b.className = "mt-sbar" + (i < lit ? " on " + GRADE_CLS[g] : "");
        }
      }
      if (mAvg) mAvg.textContent = s.avg == null ? "—" : s.avg + " ms";
      if (mJit) mJit.textContent = s.jit == null ? "—" : s.jit + " ms";
      if (mLoss) mLoss.textContent = s.loss + "%";
      rafId = requestAnimationFrame(paint);
    }
    paint();

    async function tick() {
      if (probing) return;
      probing = true;
      var ms = await probeOnce();
      probing = false;
      if (!document.body.contains(wave)) { stopAll(); return; }
      samples.push(ms);
      if (samples.length > 120) samples.shift();
      lastPing = ms;
    }
    tick();
    probeTimer = setInterval(tick, 2000);
  }

  /* ================= 差异对比（只读） ================= */

  function sig(r) {
    if (!r) return "";
    return [
      r.type || "out", r.time || "", r.picker || "", r.dept || "",
      r.purpose || "", r.entity || "", r.note || "",
      (r.items || []).map(function (i) { return (i.name || "") + "×" + (Number(i.qty) || 0); }).join("|")
    ].join("");
  }

  function itemsText(r) {
    return (r.items || []).map(function (i) { return (i.name || "") + "×" + (Number(i.qty) || 0); }).join("、") || "—";
  }

  function diffRecords(cur, snap) {
    var curMap = {}, snapMap = {};
    (cur || []).forEach(function (r) { if (r && r.id) curMap[r.id] = r; });
    (snap || []).forEach(function (r) { if (r && r.id) snapMap[r.id] = r; });
    var added = [], removed = [], changed = [];
    Object.keys(curMap).forEach(function (id) {
      if (!snapMap[id]) added.push(curMap[id]);
      else if (sig(curMap[id]) !== sig(snapMap[id])) changed.push({ now: curMap[id], was: snapMap[id] });
    });
    Object.keys(snapMap).forEach(function (id) { if (!curMap[id]) removed.push(snapMap[id]); });
    var byTime = function (a, b) { return String(b.time || "").localeCompare(String(a.time || "")); };
    added.sort(byTime); removed.sort(byTime); changed.sort(function (a, b) { return byTime(a.now, b.now); });
    return { added: added, removed: removed, changed: changed };
  }

  function diffStock(snap) {
    var out = [];
    (Config.PRODUCTS || []).forEach(function (name) {
      var now = Stock.getStock(name);
      var was = Stock.getStock(name, snap.records || []);
      var d = now - was;
      if (d !== 0) out.push({ name: name, now: now, was: was, diff: d });
    });
    out.sort(function (a, b) { return Math.abs(b.diff) - Math.abs(a.diff); });
    return out;
  }

  async function loadSnapDates() {
    if (treeTried) return snapDates;
    treeTried = true;
    var prefix = sysDir() + "/backups/";
    var found = [];
    try {
      var tree = await Cloud.fetchTree();
      Object.keys(tree || {}).forEach(function (p) {
        var m = p.indexOf(prefix) === 0 ? p.slice(prefix.length) : "";
        if (/^\d{4}-\d{2}-\d{2}\.json$/.test(m)) found.push(m.slice(0, 10));
      });
    } catch (e) { found = []; }
    if (!found.length) {
      var d = new Date();
      for (var i = 0; i < 14; i++) found.push(new Date(d.getTime() - i * 86400000).toISOString().slice(0, 10));
    }
    snapDates = found.sort().reverse();
    return snapDates;
  }

  async function fetchSnap(date) {
    var j = await Cloud.fetchJsonFile({ dataDir: sysDir(), subdir: "backups", id: date });
    if (!j || !Array.isArray(j.records)) return null;
    return j;
  }

  /* ================= 动画小工具 ================= */

  /** 数字滚动：0 → 目标 */
  function countUp(el, target, dur) {
    if (!el) return;
    dur = dur || 900;
    var t0 = performance.now();
    function step(now) {
      if (!document.body.contains(el)) return;
      var p = clamp((now - t0) / dur, 0, 1);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = num(Math.round(target * e));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ================= 渲染 ================= */

  function render(container, mode) {
    mode = mode || "full";
    stopAll();
    host = container;
    container.innerHTML =
      '<div class="mt-wrap">' +

        '<div class="mt-net" id="mtNet">' +
          '<div class="mt-net-head">' +
            '<div class="mt-gauge">' +
              '<svg class="mt-ring" viewBox="0 0 120 120" aria-hidden="true">' +
                '<circle class="mt-ring-bg" cx="60" cy="60" r="50"/>' +
                '<circle class="mt-ring-track" cx="60" cy="60" r="50"/>' +
                '<g id="mtRingSpin" class="mt-ring-spin g0">' +
                  '<circle class="mt-ring-arc" cx="60" cy="60" r="50"/>' +
                '</g>' +
              '</svg>' +
              '<div class="mt-gauge-mid">' +
                '<div class="mt-ping-big" id="mtPingBig">—</div>' +
                '<div class="mt-ping-unit">ms</div>' +
                '<div class="mt-grade g0" id="mtPingGrade">检测中</div>' +
              '</div>' +
            '</div>' +
            '<div class="mt-net-meta">' +
              '<div class="mt-bars" id="mtBars">' +
                '<i class="mt-sbar"></i><i class="mt-sbar"></i><i class="mt-sbar"></i><i class="mt-sbar"></i><i class="mt-sbar"></i>' +
              '</div>' +
              '<div class="mt-metrics">' +
                '<div><span>平均</span><b id="mtMAvg">—</b></div>' +
                '<div><span>抖动</span><b id="mtMJit">—</b></div>' +
                '<div><span>丢包</span><b id="mtMLoss">0%</b></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<svg class="mt-wave" id="mtWave" viewBox="0 0 560 96" preserveAspectRatio="none" aria-hidden="true">' +
            '<polygon class="mt-wave-area" id="mtWaveArea" points=""/>' +
            '<polyline class="mt-wave-line" id="mtWaveLine" points=""/>' +
          '</svg>' +
          '<div class="mt-net-foot">每 2 秒探一次云端连通性 · 只读检测，不改任何数据</div>' +
        '</div>' +

        '<div class="mt-cards" id="mtCards"></div>' +

        '<div class="mt-sec">' +
          '<div class="mt-sec-head"><span class="mt-sec-t">选一天，看数据变了多少</span></div>' +
          '<div class="mt-datebar">' +
            '<input type="date" id="mtDate" />' +
            '<button type="button" class="btn" id="mtDiffBtn">对比</button>' +
            '<span class="mt-chips" id="mtChips"></span>' +
          '</div>' +
          '<div id="mtDiff"></div>' +
        '</div>' +
      '</div>';

    if (mode === "net") { var _s = container.querySelector(".mt-sec"); if (_s) _s.style.display = "none"; }
    if (mode === "diff") {
      var _n = container.querySelector(".mt-net"); if (_n) _n.style.display = "none";
      var _c = container.querySelector(".mt-cards"); if (_c) _c.style.display = "none";
    }

    renderCards();
    Util.$("mtDiffBtn").addEventListener("click", runDiff);
    startNet();
    loadSnapDates().then(renderChips).catch(function () { renderChips(); });
  }

  /** 概览四卡：数字滚动 + 迷你条生长 */
  function renderCards() {
    var box = Util.$("mtCards");
    if (!box) return;
    var pending = (State.pickups || []).filter(function (p) { return !p.shipped; }).length;
    var cards = [
      { t: "业务记录", v: (State.list || []).length },
      { t: "待取货", v: pending },
      { t: "备忘录", v: (State.memos || []).length },
      { t: "同步状态", v: State.lastSync ? 1 : 0, s: State.lastSync ? "已同步" : "未同步" }
    ];
    var maxV = Math.max.apply(null, cards.map(function (c) { return c.v; }).concat([1]));
    box.innerHTML = cards.map(function (c, i) {
      return '<div class="mt-card mt-anim" style="animation-delay:' + (i * 90) + 'ms">' +
        '<div class="mt-card-t">' + esc(c.t) + '</div>' +
        '<div class="mt-card-v" data-v="' + c.v + '">0</div>' +
        '<div class="mt-bar-mini"><i style="width:0%"></i></div>' +
        (c.s ? '<div class="mt-card-s">' + esc(c.s) + '</div>' : "") +
        '</div>';
    }).join("");
    Array.prototype.forEach.call(box.querySelectorAll(".mt-card"), function (card, i) {
      var vEl = card.querySelector(".mt-card-v");
      var bar = card.querySelector(".mt-bar-mini i");
      countUp(vEl, cards[i].v, 1000);
      setTimeout(function () {
        if (bar) bar.style.width = Math.max(6, Math.round(cards[i].v / maxV * 100)) + "%";
      }, 120 + i * 90);
    });
  }

  function renderChips() {
    var box = Util.$("mtChips");
    if (!box) return;
    if (!snapDates.length) { box.innerHTML = '<i>快照列表未取到，可手动选日期</i>'; return; }
    var d = Util.$("mtDate");
    if (d && !d.value) d.value = snapDates[0];
    box.innerHTML = snapDates.slice(0, 8).map(function (x) {
      return '<button type="button" class="mt-chip" data-d="' + esc(x) + '">' + esc(x.slice(5)) + '</button>';
    }).join("");
    box.addEventListener("click", function (e) {
      var c = e.target.closest(".mt-chip");
      if (!c) return;
      var d2 = Util.$("mtDate");
      if (d2) d2.value = c.getAttribute("data-d");
      runDiff();
    });
  }

  async function runDiff() {
    var out = Util.$("mtDiff");
    var dEl = Util.$("mtDate");
    var date = dEl && dEl.value;
    if (!date) { Util.toast("先选一个日期", true); return; }
    if (!out) return;
    out.innerHTML = '<div class="mt-empty mt-pulse">正在读取 ' + esc(date) + ' 的云端快照…</div>';
    var snap = await fetchSnap(date);
    if (!snap) {
      out.innerHTML = '<div class="mt-empty">没有读到 <b>' + esc(date) + '</b> 的快照，换个日期试试。</div>';
      return;
    }
    var d = diffRecords(State.list, snap.records);
    var sd = diffStock(snap);
    out.innerHTML = renderDiffHtml(date, snap, d, sd);
    animateDiff(out, d);
  }

  function renderDiffHtml(date, snap, d, sd) {
    var h = "";
    h += '<div class="mt-dsum">' +
      '<div class="mt-dk add mt-anim"><b data-v="' + d.added.length + '">0</b><span>新增</span><i class="mt-dk-bar"><u></u></i></div>' +
      '<div class="mt-dk del mt-anim" style="animation-delay:80ms"><b data-v="' + d.removed.length + '">0</b><span>移除</span><i class="mt-dk-bar"><u></u></i></div>' +
      '<div class="mt-dk chg mt-anim" style="animation-delay:160ms"><b data-v="' + d.changed.length + '">0</b><span>改动</span><i class="mt-dk-bar"><u></u></i></div>' +
      '<div class="mt-dk mt-anim" style="animation-delay:240ms"><b data-v="' + sd.length + '">0</b><span>货品有差额</span><i class="mt-dk-bar"><u></u></i></div>' +
      '</div>';

    if (!d.added.length && !d.removed.length && !d.changed.length && !sd.length) {
      h += '<div class="mt-empty">从 ' + esc(date) + ' 到现在，数据完全一致。</div>';
      return h;
    }

    if (sd.length) {
      var maxAbs = Math.max.apply(null, sd.map(function (x) { return Math.abs(x.diff); }).concat([1]));
      h += '<div class="mt-sub">库存差额 · 条越长变动越大</div><div class="mt-bars-wrap">';
      sd.slice(0, 14).forEach(function (x, i) {
        var pct = Math.max(3, Math.round(Math.abs(x.diff) / maxAbs * 50));
        h += '<div class="mt-bar-row mt-anim" style="animation-delay:' + (i * 45) + 'ms">' +
          '<span class="mt-bar-name" title="' + esc(x.name) + '">' + esc(x.name) + '</span>' +
          '<div class="mt-bar-track"><i data-pct="' + pct + '" data-neg="' + (x.diff < 0 ? 1 : 0) + '"></i></div>' +
          '<span class="mt-bar-val ' + (x.diff > 0 ? "up" : "down") + '">' + (x.diff > 0 ? "+" : "") + num(x.diff) + '</span>' +
          '</div>';
      });
      h += '</div>';
      if (sd.length > 14) h += '<div class="mt-more">只画了变动最大的 14 项（共 ' + sd.length + ' 项）</div>';
    }

    function block(title, arr, kind) {
      if (!arr.length) return "";
      var s = '<details class="mt-fold"><summary>' + esc(title) + '<b>' + arr.length + '</b></summary>' +
        '<div class="mt-tw"><table class="table mt-table"><thead><tr>' +
        '<th>时间</th><th>类型</th><th>领取人</th><th>货品</th><th>说明</th></tr></thead><tbody>';
      arr.slice(0, 30).forEach(function (r) {
        var rec = kind === "chg" ? r.now : r;
        var note = kind === "chg" ? ('原 ' + itemsText(r.was) + ' → 现 ' + itemsText(r.now)) : (rec.purpose || rec.note || "—");
        s += '<tr><td>' + esc(String(rec.time || "").replace("T", " ")) + '</td>' +
          '<td>' + esc(rec.type === "in" ? "入库" : "出库") + '</td>' +
          '<td>' + esc(rec.picker || "—") + '</td>' +
          '<td class="mt-items">' + esc(itemsText(rec)) + '</td>' +
          '<td class="mt-note2">' + esc(note) + '</td></tr>';
      });
      s += '</tbody></table></div></details>';
      if (arr.length > 30) s += '<div class="mt-more">明细只列最近 30 条（共 ' + arr.length + ' 条）</div>';
      return s;
    }

    h += block("新增的记录", d.added, "add");
    h += block("快照里有、现在没了", d.removed, "del");
    h += block("内容有改动", d.changed, "chg");
    return h;
  }

  /** 差异区动画：数字滚动 + 条形从零点向两侧生长 */
  function animateDiff(root, d) {
    var total = Math.max(1, d.added.length + d.removed.length + d.changed.length);
    Array.prototype.forEach.call(root.querySelectorAll(".mt-dk"), function (el) {
      var b = el.querySelector("b");
      if (!b) return;
      countUp(b, Number(b.getAttribute("data-v")) || 0, 900);
      var u = el.querySelector(".mt-dk-bar u");
      setTimeout(function () {
        if (u) u.style.width = Math.max(8, Math.round((Number(b.getAttribute("data-v")) || 0) / total * 100)) + "%";
      }, 200);
    });
    Array.prototype.forEach.call(root.querySelectorAll(".mt-bar-track i"), function (el, i) {
      setTimeout(function () {
        var neg = el.getAttribute("data-neg") === "1";
        el.classList.add(neg ? "neg" : "pos");
        el.style.width = el.getAttribute("data-pct") + "%";
      }, 150 + i * 45);
    });
  }

  function refresh() { if (host) render(host); }

  window.App = window.App || {};
  window.App.Views = window.App.Views || {};
  window.App.Views.maintain = { render: render, refresh: refresh, stop: stopAll };
})();
