/**
 * main.js — 启动器：初始化 State → 兼容旧 #/verify → 启动 Router
 * 必须在所有模块之后加载（index.html 中脚本顺序固定）。
 */
(function () {
  'use strict';

  function init() {
    try {
      // 2026-09-24：清除历史「上次选中仓库」的本地记忆（旧 key 已被 2026-09-28 的
      // 「浏览器绑定」机制取代）。必须在下面 URL 直达 / State.init 之前执行。
      try {
        if (window.App.Config && window.App.Config.clearLegacyActiveSystem) {
          window.App.Config.clearLegacyActiveSystem();
        }
      } catch (e) {}
      // 2026-09-28：装载「本浏览器绑定仓」。Edge 绑深圳细胞、极智绑赛迪斯后，
      // 各自打开即落在自己那个仓，关掉重开也不用再手切（要换仓手动切一次即被记住）。
      // 必须在 State.init 之前，否则会先按默认深圳细胞读一遍本地缓存。
      try {
        if (window.App.Config && window.App.Config.Sys && window.App.Config.Sys.restoreBound) {
          window.App.Config.Sys.restoreBound();
        }
      } catch (e) {}
      // URL 直达系统（2026-09-05）：https://…/?sys=saidis（或 shenzhen）在启动前即锁定当前仓库，
      // 供「两仓各自的登记二维码/分享链接」使用。**bind:false** —— 一条分享链接只对这次打开生效，
      // 绝不改写接收者浏览器的绑定默认仓。必须早于 State.init。
      try {
        var sm = (location.search || "").match(/[?&]sys=(shenzhen|saidis)/);
        if (sm && window.App.Config && window.App.Config.Sys) {
          window.App.Config.Sys.set(sm[1], { bind: false });
        }
      } catch (e) {}
      // 2026-09-28 修复「赛迪斯库存被深圳期初基准整体抬高」（主理人报：库存全是错的）：
      // catalog.js 的首次 load() 在 DOMContentLoaded 就自启，那一刻本浏览器绑定**还没装载**
      // （restoreBound 在上面才刚跑），于是它按「默认深圳」捕获系统 id 并去拉深圳目录；
      // 等目录返回时当前系统已是赛迪斯，防串仓守卫会丢弃这次加载，而 loaded 已被置 true
      // → 之后任何 load() 都直接 return → Config.INVENTORY 永久停留在硬编码的**深圳**期初基准
      // → 赛迪斯库存 = 深圳基准 + 赛迪斯流水，18/20 货品被整体抬高（精华液20支装 448→545）。
      // 修法：绑定 / URL 确定之后，按当前真实系统强制重载一次目录基准（幂等，可安全重复）。
      try {
        if (window.App.Catalog && window.App.Catalog.reload) {
          window.App.Catalog.reload().catch(function () {});
        }
      } catch (e) {}
      window.App.State.init();
      installCloudGuards();
      // 启动一致性修复（幂等）：已提单的先借后还差额出库单 → 原借出单自动完成。
      // ★ 2026-10-24 移除旧口径「差额单 affectsStock 一律纠正回 false」修复（详见 runStartupRepair 注释）。
      // ⚠️ 维护窗口内【不跑】：助理在云端修数据时，本设备任何自动写入都会把旧数据推回去，
      //    与修复无限拉锯（2026-10-23 晚 22:36 修完 → 设备开页立刻改回）。改为由 installCloudGuards()
      //    确认「非维护窗口」后再调用 runStartupRepair()。
      // 首版遗留 #/verify 链接兼容：一律回落 #/（router.parse 亦兜底）
      if (location.hash.indexOf("#/verify") === 0) {
        location.replace("#/");
      }
      window.App.Router.start();
    } catch (err) {
      // 启动链路任一环节抛错都会让页面永远停在空壳上。这里必须把失败显性化，
      // 否则用户只看到一片空白，分不清是网络问题还是应用坏了。
      console.error("[main] 启动失败", err);
      if (typeof window.__reportFatal === "function") {
        window.__reportFatal("应用启动失败：" + (err && err.message ? err.message : err));
      }
    }
  }

  /* ============ 云端写入守卫（2026-10-24 主理人定稿，两条保护措施） ============
     ① 维护窗口只读锁：data/maintenance.json 带 {on:true} 时，本设备一切云端写入被拒，
        改动留本机队列；页面顶部挂红色横幅明示，且【不跑启动自动修复】。
     ② 推送前版本比对：远端同 id 记录比本地新 → 弹窗让用户选，绝不静默覆盖。 */

  /** 时间戳 → 本地可读串（无则显示「-」） */
  function fmtTs(ts) {
    var n = Number(ts || 0);
    if (!n) return "-";
    try {
      var d = new Date(n);
      var p = function (x) { return (x < 10 ? "0" : "") + x; };
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
             " " + p(d.getHours()) + ":" + p(d.getMinutes());
    } catch (e) { return String(n); }
  }

  /** 维护横幅：告诉现场的人为什么改了没同步上去 */
  function showMaintenanceBanner(note) {
    try {
      if (document.getElementById("maintBanner")) return;
      var d = document.createElement("div");
      d.id = "maintBanner";
      d.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#A32D2D;color:#fff;" +
        "padding:7px 12px;text-align:center;font-size:13px;line-height:1.5;box-shadow:0 2px 6px rgba(0,0,0,.18);";
      d.textContent = "系统维护中：本设备暂不写入云端，你做的登记会先存在本机，维护结束后自动补推" +
        (note ? "（" + note + "）" : "");
      document.body.appendChild(d);
    } catch (e) {}
  }

  /** 冲突弹窗：返回 "remote"|"local"|"merge"|"abort"；90s 无操作按 abort（绝不无限挂起推送） */
  function askConflict(ctx) {
    return new Promise(function (resolve) {
      var l = ctx.local || {}, r = ctx.remote || {};
      var done = false;
      var finish = function (act) { if (done) return; done = true; resolve(act); };
      var timer = setTimeout(function () { finish("abort"); }, 90000);
      try {
        if (!window.App.UI || !window.App.UI.Modal) { finish("abort"); clearTimeout(timer); return; }
        var pick = (r.picker || l.picker || "-");
        var body =
          '<div class="detail-row"><span class="k">货品</span><span class="v">' +
            ((l.items || []).map(function (it) { return window.App.Util.esc(it.name) + "×" + it.qty; }).join("、") || "-") +
          '</span></div>' +
          '<div class="detail-row"><span class="k">领取人</span><span class="v">' + window.App.Util.esc(pick) + '</span></div>' +
          '<div class="detail-row"><span class="k">云端版本</span><span class="v">' + fmtTs(r.updatedAt || r._ts) + '（别处改的）</span></div>' +
          '<div class="detail-row"><span class="k">本机版本</span><span class="v">' + fmtTs(l.updatedAt || l._ts) + '（你改的）</span></div>' +
          '<div class="hint" style="margin-top:8px;">云端比本机新，推上去会盖掉别人的改动。你想怎么处理？</div>' +
          '<div class="modal-actions">' +
            '<button type="button" class="btn ghost sm" data-act="abort">稍后处理</button>' +
            (ctx.borrow ? '<button type="button" class="btn ghost sm" data-act="merge">合并归还量</button>' : '') +
            '<button type="button" class="btn ghost sm" data-act="local">保留我的</button>' +
            '<button type="button" class="btn sm" data-act="remote">用云端的</button>' +
          '</div>';
        window.App.UI.Modal.show("这条记录别人改过", body, { width: "540px" });
        var box = window.App.UI.Modal.body().querySelector(".modal-actions");
        if (!box) { finish("abort"); clearTimeout(timer); return; }
        // 绑在每次新建的 .modal-actions 上（旧节点已随 innerHTML 销毁），不存在监听叠加
        box.addEventListener("click", function (e) {
          var b = e.target.closest("[data-act]");
          if (!b) return;
          try { window.App.UI.Modal.hide(); } catch (e2) {}
          finish(b.getAttribute("data-act"));
          clearTimeout(timer);
        });
      } catch (e) {
        finish("abort"); clearTimeout(timer);
      }
    });
  }

  /** 启动自动修复：已提单的差额单 → 原借出单结清。
      ★ 2026-10-24 移除旧口径修复：原逻辑把所有 fromBorrowId 出库单的 affectsStock 强行改回 false，
        每次开页都执行 → 与云端数据修复无限拉锯，且会让已提单实扣的差额单凭空回涨库存。 */
  function runStartupRepair() {
    try {
      var closed = 0;
      (window.App.State.list || []).slice().forEach(function (r) {
        if (!r) return;
        if (r.fromBorrowId && window.App.Records.getStatus(r) === "submitted") {
          if (window.App.Records.tryCloseBorrowFromDiff(r)) closed++;
        }
      });
      if (closed) console.log("[main] 启动修复：已自动结清 " + closed + " 笔先借后还差额单");
    } catch (e) {}
  }

  /** 装载两条守卫：维护锁 + 冲突处理器；非维护窗口才跑启动修复 */
  function installCloudGuards() {
    var Cloud = (window.App && window.App.Cloud) || null;
    if (!Cloud) { runStartupRepair(); return; }
    if (Cloud.setConflictHandler) {
      Cloud.setConflictHandler(function (ctx) { return askConflict(ctx); });
    }
    if (!Cloud.loadMaintenance) { runStartupRepair(); return; }
    Cloud.loadMaintenance().then(function (info) {
      if (info && info.on) {
        showMaintenanceBanner(info.note);
        console.warn("[main] 维护窗口开启：本设备云端写入已停用");
        return;                       // ★ 维护中：不跑任何启动自动修复
      }
      runStartupRepair();
    }).catch(function () { runStartupRepair(); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
