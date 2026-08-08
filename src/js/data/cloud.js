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

  /** 批量上传记录照片，返回 photoUrls 数组（失败跳过）；limit 可选：只传前 limit 张（文件名索引与原位置一致，幂等覆盖） */
  async function pushPhotos(rec, limit) {
    var urls = [];
    var photos = (rec && rec.photos) || [];
    var slice = limit ? photos.slice(0, limit) : photos;
    for (var i = 0; i < slice.length; i++) {
      try {
        var u = await pushPhoto(rec.id, i + 1, slice[i]);
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

  /** 推送任意 notify 载荷到 data/notify/<prefix>-<id>.json，供 Actions 脚本消费；返回文件名。失败抛错。 */
  async function pushNotifyFile(prefix, payload) {
    if (!payload) throw new Error("empty notify payload");
    var id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    var path = "data/notify/" + prefix + "-" + id + ".json";
    var content = Util.b64enc(JSON.stringify(payload));
    await apiJson("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path, {
      method: "PUT", headers: ghHeaders(),
      body: JSON.stringify({ message: prefix + " " + id, content: content, branch: Config.GH.branch })
    });
    return id;
  }

  /* ================= 金山台账回执（提交后告诉用户「真的进台账了」） =================
     链路：前端 PUT 记录 → GitHub Action(wps-sync) 调金山写行 → 回写 .wps_synced.json →
           前端轮询这个标记文件 → 看到自己这条 id 就显示「✅已入金山台账（表名 第N行）」。
     没有这一步，用户只知道"上云了"，不知道台账到底写没写成，出问题也无感。 */

  var WPS_MARKER_PATH = ".wps_synced.json";

  /** 读取金山同步标记文件；读不到返回 null（不抛错，轮询会继续重试） */
  async function fetchWpsMarker() {
    var url = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + WPS_MARKER_PATH +
              "?ref=" + Config.GH.branch + "&_=" + Date.now();   // 时间戳绕开 CDN/浏览器缓存
    try {
      var j = await apiJson(url, { cache: "no-store" });
      return JSON.parse(Util.b64dec(j.content));
    } catch (e) { return null; }
  }

  /** 从标记文件里读某条记录的台账状态。
      返回 null=还没结果（继续等）；否则 {phase, rows, detail}
      phase: done=已写入 / skip=本单无鹿茸商品不入台账 / fail=金山写入失败 */
  function readWpsState(marker, id) {
    if (!marker) return null;
    var fails = marker.__fail__ || {};
    var st = marker[id];
    if (st === undefined || st === null) {
      // 正式标记还没有，但失败回执先到了 → 立刻告诉用户失败，别让他干等
      if (fails[id]) return { phase: "fail", detail: fails[id] };
      return null;
    }
    if (st === true) return { phase: "done", rows: {} };          // 老格式：只知道成功
    if (st.skip) return { phase: "skip", detail: st };
    if (st.ok > 0) return { phase: "done", rows: st.rows || {}, detail: st };
    return { phase: "fail", detail: st };
  }

  /** 轮询等待金山台账回执。
      onUpdate(state) 会被调用多次：先 {phase:'waiting'}，最终 done/skip/fail/timeout 之一。
      Action 排队 + 金山写入通常 30~90 秒，所以默认等到 3 分钟。 */
  async function waitWpsReceipt(id, onUpdate, opts) {
    opts = opts || {};
    var every = opts.intervalMs || 7000;
    var maxTries = opts.maxTries || 26;        // 7s × 26 ≈ 3 分钟
    var cb = onUpdate || function () {};
    if (!id || !hasToken()) return { phase: "unknown" };
    cb({ phase: "waiting", tries: 0 });
    for (var i = 1; i <= maxTries; i++) {
      await new Promise(function (r) { setTimeout(r, every); });
      var st = readWpsState(await fetchWpsMarker(), id);
      if (st) { cb(st); return st; }
      cb({ phase: "waiting", tries: i });
    }
    var t = { phase: "timeout" };
    cb(t);
    return t;
  }

  /** 把回执状态翻成人话（顶栏状态文案）。返回 {text, isErr, toast} */
  function describeWpsReceipt(st) {
    if (!st) return null;
    if (st.phase === "done") {
      var parts = [];
      var rows = st.rows || {};
      for (var k in rows) parts.push(k + " 第" + rows[k] + "行");
      return { text: "✅ 已写入金山台账" + (parts.length ? "（" + parts.join("、") + "）" : ""),
               isErr: false, toast: "✅ 已写入金山台账" };
    }
    if (st.phase === "skip") {
      return { text: "✅ 已同步云端（本单无鹿茸商品，不进台账）", isErr: false, toast: "" };
    }
    if (st.phase === "fail") {
      return { text: "⚠️ 金山台账写入失败，请联系管理员核对", isErr: true, toast: "⚠️ 金山台账写入失败" };
    }
    if (st.phase === "timeout") {
      return { text: "已上云；金山台账写入较慢，稍后会自动完成", isErr: true, toast: "" };
    }
    return null;
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
    pushNotifyFile: pushNotifyFile,
    fetchWpsMarker: fetchWpsMarker,
    readWpsState: readWpsState,
    waitWpsReceipt: waitWpsReceipt,
    describeWpsReceipt: describeWpsReceipt,
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
