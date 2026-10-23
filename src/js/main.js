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
      // 启动一致性修复（幂等，可安全重复执行）：
      //   已提单的先借后还差额出库单 → 原借出单自动完成
      //   ★ 2026-10-24 移除旧口径「差额单 affectsStock 一律纠正回 false」修复：
      //     该逻辑是 2026-09-29「口径乙」之前的遗留（当年旧版 update 恒写 affectsStock:true 会重复扣库）。
      //     口径乙之后差额单正确形态 = affectsStock:true + freezeStock:true（未提单只冻结不扣库，
      //     提单时 toggleStatus 释放冻结转实扣）。本段每次启动都把新口径差额单打回 affectsStock:false
      //     → 既不扣库存也不占冻结，货凭空消失（实测面膜5片装×12/精华液×8/洁面慕斯×4），
      //     且与云端数据修复无限拉锯（设备端每次开页写回 false）。已提单实扣过的差额单同样被误伤
      //     → 已扣库存被凭空撤销。彻底删除，新差额单创建口径已由 borrow.js L466 保证正确。
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
