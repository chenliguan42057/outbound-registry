/**
 * main.js — 启动器：初始化 State → 兼容旧 #/verify → 启动 Router
 * 必须在所有模块之后加载（index.html 中脚本顺序固定）。
 */
(function () {
  'use strict';

  function init() {
    try {
      window.App.State.init();
      // 启动一致性修复（幂等，可安全重复执行）：
      //   1) 已提单的先借后还差额出库单 → 原借出单自动完成
      //   2) 历史 bug 兜底：差额单 affectsStock 曾被 Records.update 误置为 true
      //      （旧版 update 恒写 affectsStock:true，用户点「已提单」就会让这笔差额再扣一次库存）
      //      → 差额单必须不参与库存计算，这里一律纠正回 false 并补推云端。
      try {
        var closed = 0, fixedAffects = 0;
        (window.App.State.list || []).slice().forEach(function (r) {
          if (!r) return;
          if (r.fromBorrowId && window.App.Records.getStatus(r) === "submitted") {
            if (window.App.Records.tryCloseBorrowFromDiff(r)) closed++;
          }
          if (r.fromBorrowId && (r.type || "out") !== "in" && r.affectsStock === true) {
            var fx = window.App.Records.update(r.id, { affectsStock: false });
            if (fx) {
              fixedAffects++;
              try {
                if (window.App.Cloud && window.App.Cloud.hasToken()) window.App.Cloud.pushRecord(fx);
              } catch (e) {}
            }
          }
        });
        if (closed) console.log("[main] 启动修复：已自动结清 " + closed + " 笔先借后还差额单");
        if (fixedAffects) console.log("[main] 启动修复：已纠正 " + fixedAffects + " 笔差额单的库存参与标志（消除重复扣减）");
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
