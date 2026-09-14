/**
 * autoClear.js — 退出时自动清理本地数据（2026-09-14）
 *
 * 为什么需要：增量同步以「云端文件 sha 是否变过」作判据，本地 tree 缓存
 * 一旦与实际状态不一致，那条记录就被永久跳过 —— 云端明明有单子，列表里看不到，
 * 刷新/重进都不会自愈。与其不断打补丁去治缓存，不如让本地缓存根本不留过夜：
 * 关页面时把「可再生的只读副本」清掉，下次打开就是干净状态 + 全量拉云端，
 * 从结构上消灭这类不一致。
 *
 * 清理分三档：
 *   SAFE  可安全清（云端有全量，随时可重建）
 *   KEEP  绝对保留（未推送数据 / 令牌 / 表单草稿，清了就是真丢东西）
 *   GUARD 清理前还有二次保护：队列非空则整轮放弃
 *
 * 纯新增文件，不改动既有模块；由 app.js 在启动时 wire()。
 */
(function () {
  "use strict";

  var Util = window.App.Util;
  var Config = window.App.Config;
  var Store = window.App.Store;

  var UX_KEY = "outbound_ux_v1";            // 与 ux.js 同一个设置键（本机显示设置）
  var CLEARED_FLAG = "outbound_autoclear_done";   // 标记：本轮已清过，避免同一次会话重复清

  /* ---------- 该清的：云端有全量、随时可重建的只读副本 ---------- */
  /* ---------- 该清的：只有「同步哈希缓存」这一类纯索引 ----------
     ⚠️ 2026-09-14 事故教训（务必别再扩大清理范围）：
     初版这里把 records/pickups/memos/stocktakes/catalog 的数据副本也清了，
     结果库存当场全乱 —— 因为 库存 = 期初基准 + 全部流水累加，期初只有几十、
     累加才是大头（单货品可达 +627/-220）。副本被清后，每次打开页面流水都从 0 算起，
     在云同步跑完之前（甚至同步失败时永久）库存显示的是「期初值」→ 用户看到"全乱"。
     同步一旦因网络/额度失败，错误状态还无法自愈（以前本地留着副本就不会乱）。
     ⇒ 结论：只清索引缓存，数据副本一律留给本地兜底。清 tree 缓存已足以
        强制下次全量拉取云端最新数据，同时本地永远有一份可用数据。
       真正的兜底是 app.js 的 checkAndHealGap()（发现云端多于本地自动补齐）。 */
  function dynamicKeys() {
    return [
      "outbound_tree_cache_v2"    // 增量同步哈希缓存（清它即触发下次全量拉取）
    ];
  }

  /* ---------- 绝对不能清的：未推送数据 / 凭据 ---------- */
  function guardKeys() {
    var p = function (n) { return Config.Sys.key(n); };
    return [
      "outbound_sync_queue", "outbound_saidis_sync_queue",     // 待补推记录 id
      "outbound_tomb_queue", "outbound_saidis_tomb_queue",     // 待推墓碑（删除标记）
      "outbound_photo_pending",                                // 待上传照片
      Config.GH_TOKEN_KEY,                                     // 云端令牌
      "outbound_ai_key", "outbound_search_key"                 // AI / 搜索密钥
    ];
  }

  function readArr(key) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  /** 有未推送数据时一律不清理（返回原因字符串；null = 可以清） */
  function blockedReason() {
    var g = guardKeys();
    for (var i = 0; i < g.length; i++) {
      var v = readArr(g[i]);
      if (v.length) {
        if (/queue/.test(g[i])) return "还有 " + v.length + " 条记录待推送云端";
        if (/photo_pending/.test(g[i])) return "还有 " + v.length + " 张照片待上传";
      }
    }
    return null;
  }

  function settingOn() {
    try {
      var s = JSON.parse(localStorage.getItem(UX_KEY) || "{}");
      // 默认开启：只有显式设为 false 才关（兼容旧数据缺该字段）
      return s.autoClear !== false;
    } catch (e) { return true; }
  }

  /** 执行清理，返回 {ok, cleared, reason} */
  function clearLocal() {
    var blocked = blockedReason();
    if (blocked) return { ok: false, cleared: 0, reason: blocked };
    var keys = dynamicKeys();
    var seen = {}, n = 0;
    keys.forEach(function (k) {
      if (!k || seen[k]) return;
      seen[k] = 1;
      try {
        if (localStorage.getItem(k) !== null) { localStorage.removeItem(k); n++; }
      } catch (e) { /* 单项失败不影响其余 */ }
    });
    return { ok: true, cleared: n, reason: "" };
  }

  /* ---------- 装配：监听页面离开 ---------- */
  var armed = false;
  function wire() {
    if (armed) return;
    armed = true;

    // 页面被丢弃 / 关闭 / 切走（pagehide 是移动端唯一可靠的「离开」信号）
    window.addEventListener("pagehide", function () {
      if (!settingOn()) return;
      clearLocal();
    });
    // 桌面端关标签页/关窗口兜底（pagehide 在部分浏览器不触发）
    window.addEventListener("beforeunload", function () {
      if (!settingOn()) return;
      clearLocal();
    });
    // 同一会话内不重复清（浏览器前进后退会再次触发 pagehide，但不影响正确性）
    try { sessionStorage.setItem(CLEARED_FLAG, "1"); } catch (e) {}
  }

  /** 手动清理入口（给设置面板按钮用；会先弹出待推送数据检查结果） */
  function clearNow() {
    var r = clearLocal();
    if (!r.ok) { Util.toast("暂不清理：" + r.reason, true); return r; }
    Util.toast("已清理本地缓存（" + r.cleared + " 项）");
    return r;
  }

  window.App = window.App || {};
  window.App.AutoClear = {
    wire: wire,
    clearNow: clearNow,
    clearLocal: clearLocal,
    settingOn: settingOn,
    blockedReason: blockedReason
  };
})();
