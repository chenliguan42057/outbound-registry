/**
 * cloud.js — 云端同步：GitHub Contents API 全量（与现网逻辑一致）
 * 数据存在仓库 data/records/<id>.json，换设备打开同一网址即看到同一份记录。
 */
(function () {
  'use strict';

  var Config = window.App.Config;
  var Store = window.App.Store;
  var Util = window.App.Util;

  function ghHeaders() {
    var h = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (Config.GH.token && Config.GH.token.indexOf("__") !== 0) {
      h["Authorization"] = "Bearer " + Config.GH.token;
    }
    return h;
  }

  /** 令牌是否可用（已注入且非占位符） */
  function hasToken() {
    return !!(Config.GH.token && Config.GH.token.indexOf("__") !== 0);
  }

  async function apiJson(url, opts) {
    var res = await fetch(url, Object.assign({ headers: ghHeaders() }, opts || {}));
    if (!res.ok) {
      var t = await res.text().catch(function () { return ""; });
      throw new Error(res.status + " " + t.slice(0, 80));
    }
    return res.json();
  }

  /** 拉取云端全部记录（目录 404 视为空） */
  async function pull() {
    var url = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + Config.GH.dir + "?ref=" + Config.GH.branch;
    var arr;
    try { arr = await apiJson(url); }
    catch (e) { if (String(e.message).indexOf("404") === 0) return []; throw e; }
    if (!Array.isArray(arr)) return [];
    var files = arr.filter(function (f) { return f.name.endsWith(".json") && f.size < 5 * 1024 * 1024; });
    var recs = [];
    for (var i = 0; i < files.length; i++) {
      try {
        var j = await apiJson(files[i].url);
        recs.push(JSON.parse(Util.b64dec(j.content)));
      } catch (e) { /* 单条失败跳过，不影响其余 */ }
    }
    return recs;
  }

  /** 推送单条记录（存在则更新，不存在则新增） */
  async function push(rec) {
    var path = Config.GH.dir + "/" + rec.id + ".json";
    var content = Util.b64enc(JSON.stringify(rec));
    var getUrl = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path + "?ref=" + Config.GH.branch;
    var sha;
    try { var ej = await apiJson(getUrl); sha = ej.sha; } catch (e) {}
    var body = sha
      ? { message: "update " + rec.id, content: content, sha: sha, branch: Config.GH.branch }
      : { message: "add " + rec.id, content: content, branch: Config.GH.branch };
    await apiJson("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path, {
      method: "PUT", headers: ghHeaders(), body: JSON.stringify(body)
    });
  }

  /** 删除云端单条记录 */
  async function del(id) {
    var path = Config.GH.dir + "/" + id + ".json";
    var getUrl = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path + "?ref=" + Config.GH.branch;
    var sha;
    try { var ej = await apiJson(getUrl); sha = ej.sha; } catch (e) { return; }
    await apiJson("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path, {
      method: "DELETE", headers: ghHeaders(),
      body: JSON.stringify({ message: "del " + id, sha: sha, branch: Config.GH.branch })
    });
  }

  /* ================= 待取货云端同步（目录 data/pickups） ================= */

  /** 拉取云端全部待取货（目录 404 视为空；逻辑同 pull() 但目录不同） */
  async function pullPickups() {
    var url = "https://api.github.com/repos/" + Config.GH.repo + "/contents/data/pickups?ref=" + Config.GH.branch;
    var arr;
    try { arr = await apiJson(url); }
    catch (e) { if (String(e.message).indexOf("404") === 0) return []; throw e; }
    if (!Array.isArray(arr)) return [];
    var files = arr.filter(function (f) { return f.name.endsWith(".json") && f.size < 5 * 1024 * 1024; });
    var recs = [];
    for (var i = 0; i < files.length; i++) {
      try {
        var j = await apiJson(files[i].url);
        recs.push(JSON.parse(Util.b64dec(j.content)));
      } catch (e) { /* 单条失败跳过，不影响其余 */ }
    }
    return recs;
  }

  /** 推送单条待取货（存在则更新，不存在则新增） */
  async function pushPickup(rec) {
    var path = "data/pickups/" + rec.id + ".json";
    var content = Util.b64enc(JSON.stringify(rec));
    var getUrl = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path + "?ref=" + Config.GH.branch;
    var sha;
    try { var ej = await apiJson(getUrl); sha = ej.sha; } catch (e) {}
    var body = sha
      ? { message: "update " + rec.id, content: content, sha: sha, branch: Config.GH.branch }
      : { message: "add " + rec.id, content: content, branch: Config.GH.branch };
    await apiJson("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path, {
      method: "PUT", headers: ghHeaders(), body: JSON.stringify(body)
    });
  }

  /** 删除云端单条待取货（不带墓碑：待取货为流程性数据，不做跨设备删除同步） */
  async function delPickup(id) {
    var path = "data/pickups/" + id + ".json";
    var getUrl = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path + "?ref=" + Config.GH.branch;
    var sha;
    try { var ej = await apiJson(getUrl); sha = ej.sha; } catch (e) { return; }
    await apiJson("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path, {
      method: "DELETE", headers: ghHeaders(),
      body: JSON.stringify({ message: "del " + id, sha: sha, branch: Config.GH.branch })
    });
  }

  /** 逐条推送本地全部待取货 */
  async function pushAllPickups(list) {
    var ok = 0, fail = 0;
    var arr = list || window.App.State.pickups;
    for (var i = 0; i < arr.length; i++) {
      try { await pushPickup(arr[i]); ok++; } catch (e) { fail++; }
    }
    return { ok: ok, fail: fail };
  }

  /* ================= 备忘录云端同步（目录 data/memos） ================= */

  /** 拉取云端全部备忘录（目录 404 视为空；逻辑同 pullPickups() 但目录不同）。
      config.json 是提醒配置不是备忘录，必须排除，否则会被解析成无 id 幽灵条目。 */
  async function pullMemos() {
    var url = "https://api.github.com/repos/" + Config.GH.repo + "/contents/data/memos?ref=" + Config.GH.branch;
    var arr;
    try { arr = await apiJson(url); }
    catch (e) { if (String(e.message).indexOf("404") === 0) return []; throw e; }
    if (!Array.isArray(arr)) return [];
    var files = arr.filter(function (f) { return f.name.endsWith(".json") && f.name !== "config.json" && f.size < 5 * 1024 * 1024; });
    var recs = [];
    for (var i = 0; i < files.length; i++) {
      try {
        var j = await apiJson(files[i].url);
        recs.push(JSON.parse(Util.b64dec(j.content)));
      } catch (e) { /* 单条失败跳过，不影响其余 */ }
    }
    return recs;
  }

  /** 推送单条备忘录（存在则更新，不存在则新增） */
  async function pushMemo(rec) {
    var path = "data/memos/" + rec.id + ".json";
    var content = Util.b64enc(JSON.stringify(rec));
    var getUrl = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path + "?ref=" + Config.GH.branch;
    var sha;
    try { var ej = await apiJson(getUrl); sha = ej.sha; } catch (e) {}
    var body = sha
      ? { message: "update " + rec.id, content: content, sha: sha, branch: Config.GH.branch }
      : { message: "add " + rec.id, content: content, branch: Config.GH.branch };
    await apiJson("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path, {
      method: "PUT", headers: ghHeaders(), body: JSON.stringify(body)
    });
  }

  /** 删除云端单条备忘录（不带墓碑：备忘录为流程性数据，不做跨设备删除同步） */
  async function delMemo(id) {
    var path = "data/memos/" + id + ".json";
    var getUrl = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path + "?ref=" + Config.GH.branch;
    var sha;
    try { var ej = await apiJson(getUrl); sha = ej.sha; } catch (e) { return; }
    await apiJson("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path, {
      method: "DELETE", headers: ghHeaders(),
      body: JSON.stringify({ message: "del " + id, sha: sha, branch: Config.GH.branch })
    });
  }

  /** 逐条推送本地全部备忘录 */
  async function pushAllMemos(list) {
    var ok = 0, fail = 0;
    var arr = list || window.App.State.memos;
    for (var i = 0; i < arr.length; i++) {
      try { await pushMemo(arr[i]); ok++; } catch (e) { fail++; }
    }
    return { ok: ok, fail: fail };
  }

  /** 清空云端全部记录 */
  async function clearAll() {
    var url = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + Config.GH.dir + "?ref=" + Config.GH.branch;
    var arr;
    try { arr = await apiJson(url); } catch (e) { return; }
    if (!Array.isArray(arr)) return;
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      if (!f.name.endsWith(".json")) continue;
      try {
        var j = await apiJson(f.url);
        await apiJson("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + f.path, {
          method: "DELETE", headers: ghHeaders(),
          body: JSON.stringify({ message: "del all", sha: j.sha, branch: Config.GH.branch })
        });
      } catch (e) {}
    }
  }

  /* ================= 墓碑同步删除（解决删除不同步） ================= */

  /** 写删除墓碑：data/deleted/<id>.json（含原记录快照 + 删除理由 + 时间）。
      先写墓碑再删原文件，保证删除可追踪、其他设备可同步删除残留。 */
  async function pushTombstone(rec, reason) {
    if (!rec || !rec.id) return;
    var path = "data/deleted/" + rec.id + ".json";
    var tomb = { type: "tombstone", id: rec.id, deletedAt: Date.now(), reason: String(reason || ""), rec: rec };
    var content = Util.b64enc(JSON.stringify(tomb));
    var getUrl = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path + "?ref=" + Config.GH.branch;
    var sha;
    try { var ej = await apiJson(getUrl); sha = ej.sha; } catch (e) {}
    var body = sha
      ? { message: "tombstone " + rec.id, content: content, sha: sha, branch: Config.GH.branch }
      : { message: "tombstone " + rec.id, content: content, branch: Config.GH.branch };
    await apiJson("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path, {
      method: "PUT", headers: ghHeaders(), body: JSON.stringify(body)
    });
  }

  /** 删除并写墓碑（先墓碑后删原文件） */
  async function delWithTombstone(rec, reason) {
    await pushTombstone(rec, reason);
    await del(rec.id);
  }

  /** 清空全部并写一条汇总墓碑（data/deleted/__clear-all__.json） */
  async function clearAllWithReason(reason) {
    var path = "data/deleted/__clear-all__.json";
    var tomb = { type: "clear-all", id: "__clear-all__", deletedAt: Date.now(), reason: String(reason || "") };
    var content = Util.b64enc(JSON.stringify(tomb));
    var getUrl = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path + "?ref=" + Config.GH.branch;
    var sha;
    try { var ej = await apiJson(getUrl); sha = ej.sha; } catch (e) {}
    var body = sha
      ? { message: "clear-all tombstone", content: content, sha: sha, branch: Config.GH.branch }
      : { message: "clear-all tombstone", content: content, branch: Config.GH.branch };
    try {
      await apiJson("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path, {
        method: "PUT", headers: ghHeaders(), body: JSON.stringify(body)
      });
    } catch (e) {}
    await clearAll();
  }

  /** 拉取云端全部墓碑（目录 404 视为空） */
  async function pullTombstones() {
    var url = "https://api.github.com/repos/" + Config.GH.repo + "/contents/data/deleted?ref=" + Config.GH.branch;
    var arr;
    try { arr = await apiJson(url); }
    catch (e) { if (String(e.message).indexOf("404") === 0) return []; throw e; }
    if (!Array.isArray(arr)) return [];
    var toms = [];
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      if (!f.name.endsWith(".json") || f.size >= 5 * 1024 * 1024) continue;
      try {
        var j = await apiJson(f.url);
        toms.push(JSON.parse(Util.b64dec(j.content)));
      } catch (e) {}
    }
    return toms;
  }

  /** 照片上传云端：data/photos/<id>-<index>.jpg；返回公网 URL（jsdelivr CDN） */
  async function pushPhoto(id, index, dataUrl) {
    var m = /^data:image\/[^;]+;base64,(.+)$/.exec(String(dataUrl || ""));
    if (!m) return "";
    var path = "data/photos/" + id + "-" + index + ".jpg";
    var getUrl = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path + "?ref=" + Config.GH.branch;
    var sha;
    try { var ej = await apiJson(getUrl); sha = ej.sha; } catch (e) {}
    var body = sha
      ? { message: "photo " + id, content: m[1], sha: sha, branch: Config.GH.branch }
      : { message: "photo " + id, content: m[1], branch: Config.GH.branch };
    await apiJson("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path, {
      method: "PUT", headers: ghHeaders(), body: JSON.stringify(body)
    });
    return "https://cdn.jsdelivr.net/gh/" + Config.GH.repo + "@" + Config.GH.branch + "/" + path;
  }

  /** 批量上传记录照片，返回 photoUrls 数组（失败跳过） */
  async function pushPhotos(rec) {
    var urls = [];
    var photos = (rec && rec.photos) || [];
    for (var i = 0; i < photos.length; i++) {
      try {
        var u = await pushPhoto(rec.id, i + 1, photos[i]);
        if (u) urls.push(u);
      } catch (e) {}
    }
    return urls;
  }

  /** 逐条推送本地全部记录 */
  async function pushAllLocal(list) {
    var ok = 0, fail = 0;
    var arr = list || window.App.State.list;
    for (var i = 0; i < arr.length; i++) {
      try { await push(arr[i]); ok++; } catch (e) { fail++; }
    }
    return { ok: ok, fail: fail };
  }

  /* ================= 单条带重试推送 + 持久化重试队列 =================
     解决「页面被切走/关闭导致在途推送丢失 → 记录只留本机 → GitHub 收不到 → 钉钉不响」的问题。
     - pushWithRetry：单条 PUT，最多 3 次指数退避（800ms / 1600ms）；401/403 令牌失效立即放弃，交队列等下次。
     - pushRecord：优先立即推送；失败将 id 写入 localStorage 队列，待下次启动/操作冲刷。
     - 队列只存 id（不存整条记录，避免照片 dataURL 撑爆 localStorage）；冲刷时从 State.list 取最新内容重推，
       按 id 覆盖，幂等。 */

  var SYNC_QUEUE_KEY = "outbound_sync_queue";

  function loadQueue() {
    try { return JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveQueue(arr) {
    try { localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(arr)); } catch (e) {}
  }
  function enqueue(id) {
    var q = loadQueue();
    if (q.indexOf(id) === -1) q.push(id);
    saveQueue(q);
  }
  function dequeue(id) {
    saveQueue(loadQueue().filter(function (x) { return x !== id; }));
  }

  /** 带退避重试的单条推送；成功返回 true，失败（含令牌失效）返回 false */
  async function pushWithRetry(rec, attempts) {
    attempts = attempts || 3;
    for (var i = 0; i < attempts; i++) {
      try { await push(rec); return true; }
      catch (e) {
        var msg = String((e && e.message) || "");
        if (/^401 |^403 /.test(msg)) break;           // 令牌失效：不再重试，交队列等下次
        if (i < attempts - 1) await new Promise(function (r) { setTimeout(r, 800 * Math.pow(2, i)); });
      }
    }
    return false;
  }

  /** 优先立即推送单条记录；失败入持久化队列，待冲刷。返回 Promise<boolean> */
  async function pushRecord(rec) {
    if (!rec || !rec.id) return false;
    if (!hasToken()) { enqueue(rec.id); return false; }
    var ok = await pushWithRetry(rec, 3);
    if (ok) { dequeue(rec.id); return true; }
    enqueue(rec.id);
    return false;
  }

  /** 冲刷持久化队列：逐条重试（2 次），成功出队；记录已本地删除则直接出队。返回 {ok, remain} */
  async function flushQueue() {
    var q = loadQueue();
    if (!q.length) return { ok: 0, remain: 0 };
    if (!hasToken()) return { ok: 0, remain: q.length };
    var ok = 0, remain = 0;
    for (var i = 0; i < q.length; i++) {
      var id = q[i];
      var rec = (window.App.State.list || []).find(function (r) { return r.id === id; });
      if (!rec) { dequeue(id); continue; }            // 本地已删，出队
      if (await pushWithRetry(rec, 2)) { dequeue(id); ok++; } else { remain++; }
    }
    return { ok: ok, remain: remain };
  }

  /* ================= 订单提醒推送（data/notify） =================
     前端勾选订单 → 写 data/notify/<id>.json（仅订单紧凑摘要，不含照片）→
     GitHub Action「DingTalk Remind」读取并推送钉钉。文件名唯一，每次发送独立，幂等。 */

  /** 推送「提醒」请求；返回文件名。失败抛错（调用方自行提示/重试）。 */
  async function pushRemind(obj) {
    if (!obj || !obj.orders || !obj.orders.length) throw new Error("empty remind payload");
    var id = "r" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    var path = "data/notify/" + id + ".json";
    var content = Util.b64enc(JSON.stringify(obj));
    await apiJson("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path, {
      method: "PUT", headers: ghHeaders(),
      body: JSON.stringify({ message: "remind " + id, content: content, branch: Config.GH.branch })
    });
    return id;
  }

  /**
   * 拉取 + 合并 + 应用墓碑 + 落盘
   * 墓碑机制：云端 data/deleted/ 中的墓碑会删除本地对应 id 的残留记录（解决"删除不同步"）。
   * opts.onStatus(text, isErr) 回调用于更新顶栏/模块同步状态
   * 返回 { ok: boolean, list?: Record[], tombstones?: Tombstone[], error?: Error }
   */
  async function syncPull(opts) {
    opts = opts || {};
    var onStatus = opts.onStatus || function () {};
    onStatus("同步中…", false);
    try {
      var recs = await pull();
      // 待取货同步：拉取失败（非 404 网络异常）不影响 records 同步，单独降级为空
      var pks = [];
      try { pks = await pullPickups(); } catch (e) { pks = []; }
      // 备忘录同步：与待取货一致，失败降级为空，不影响 records
      var mms = [];
      try { mms = await pullMemos(); } catch (e) { mms = []; }
      var toms = await pullTombstones();
      var merged = window.App.Records.mergeAndSort(window.App.State.list, recs);
      // 应用墓碑：删除本地已标记删除的记录
      if (toms && toms.length) {
        merged = window.App.Records.applyTombstones(merged, toms);
      }
      window.App.State.list = merged;
      Store.saveRecords(merged);
      // 待取货合并：同 id 云端覆盖本地（流程性数据，不参与墓碑删除同步）
      window.App.State.pickups = window.App.Pickups.mergeAndSort(window.App.State.pickups, pks);
      Store.savePickups(window.App.State.pickups);
      // 备忘录合并：同 id 云端覆盖本地（流程性数据，不参与墓碑删除同步）
      window.App.State.memos = window.App.Memos.mergeAndSort(window.App.State.memos, mms);
      Store.saveMemos(window.App.State.memos);
      window.App.State.lastSync = new Date();
      onStatus("已同步 " + window.App.State.lastSync.toLocaleString(), false);
      return { ok: true, list: merged, pickups: pks, memos: mms, tombstones: toms };
    } catch (e) {
      onStatus("同步失败：" + e.message + "（显示本地缓存）", true);
      return { ok: false, error: e };
    }
  }

  window.App = window.App || {};
  window.App.Cloud = {
    hasToken: hasToken,
    pull: pull,
    push: push,
    del: del,
    clearAll: clearAll,
    pushAllLocal: pushAllLocal,
    pushRecord: pushRecord,
    pushWithRetry: pushWithRetry,
    flushQueue: flushQueue,
    pushRemind: pushRemind,
    syncPull: syncPull,
    pushTombstone: pushTombstone,
    delWithTombstone: delWithTombstone,
    clearAllWithReason: clearAllWithReason,
    pullTombstones: pullTombstones,
    pushPhoto: pushPhoto,
    pushPhotos: pushPhotos,
    pullPickups: pullPickups,
    pushPickup: pushPickup,
    delPickup: delPickup,
    pushAllPickups: pushAllPickups,
    pullMemos: pullMemos,
    pushMemo: pushMemo,
    delMemo: delMemo,
    pushAllMemos: pushAllMemos
  };
})();
