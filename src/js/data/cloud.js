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

  var API_TIMEOUT_MS = 15000;

  /**
   * API 配额水位。GitHub 认证请求限额 5000 次/小时，且同一令牌下所有设备共用。
   * 每次响应都会刷新这里，自动同步据此决定是否暂时停表，避免把额度耗光后全站写入瘫痪。
   */
  var rate = { remaining: null, limit: null, reset: 0 };

  function readRate(res) {
    try {
      var rem = res.headers.get("x-ratelimit-remaining");
      var lim = res.headers.get("x-ratelimit-limit");
      var rst = res.headers.get("x-ratelimit-reset");
      if (rem !== null) rate.remaining = parseInt(rem, 10);
      if (lim !== null) rate.limit = parseInt(lim, 10);
      if (rst !== null) rate.reset = parseInt(rst, 10) * 1000;
    } catch (e) { /* 响应头不可读不影响主流程 */ }
  }

  /** 把 GitHub 的英文报错翻成用户能看懂的话；保留状态码前缀（调用方靠它判断 404） */
  function friendlyErr(status, body) {
    var mins = rate.reset ? Math.max(1, Math.ceil((rate.reset - Date.now()) / 60000)) : 0;
    if (status === 401) return "令牌无效或已过期，请在「云同步」页重新填写";
    if (status === 403 && rate.remaining === 0) {
      return "API 调用额度已用尽" + (mins ? "，约 " + mins + " 分钟后自动恢复" : "");
    }
    if (status === 403) return "无权限执行该操作（令牌权限不足或仓库受保护）";
    if (status === 409) return "版本冲突：这条数据刚被其他设备改过";
    if (status === 422) return "数据格式被服务端拒绝";
    if (status >= 500) return "GitHub 服务暂时不可用，请稍后重试";
    return String(body || "").slice(0, 80);
  }

  async function apiJson(url, opts) {
    // 原实现无超时：移动端弱网下 fetch 会一直挂着，同步按钮永远转圈。
    // AbortController 比 AbortSignal.timeout 兼容性更好（后者需要 Chrome 103+/Safari 16+）。
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, API_TIMEOUT_MS);
    var res;
    try {
      res = await fetch(url, Object.assign({ headers: ghHeaders() }, opts || {}, { signal: ctrl.signal }));
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === "AbortError") {
        throw new Error("timeout 请求超时（" + (API_TIMEOUT_MS / 1000) + " 秒未响应），请检查网络后重试");
      }
      throw new Error("network 网络不可用：" + ((e && e.message) || e));
    }
    clearTimeout(timer);
    readRate(res);
    if (!res.ok) {
      var t = await res.text().catch(function () { return ""; });
      // 状态码前缀必须保留：pull/pullTombstones 等处用 indexOf("404")===0 判断空目录
      throw new Error(res.status + " " + friendlyErr(res.status, t));
    }
    return res.json();
  }

  /** 供自动同步与「云同步」页读取当前配额水位 */
  function getRate() {
    return {
      remaining: rate.remaining,
      limit: rate.limit,
      reset: rate.reset,
      /** 余量告急：低于 200 时应停止自动轮询，把剩余额度留给用户的手动提交 */
      low: rate.remaining !== null && rate.remaining < 200
    };
  }

  /* ================= Git Trees 增量拉取（同步性能优化） =================
     现状：syncPull 对 records/deleted/pickups/memos 各做 1 次目录列举 + 每文件 1 次读取
     （N+1，约 49 次/轮），多设备共享 GitHub 5000/h 配额。
     优化：用 Git Trees API 一次拿全量 {path: sha}（1 次请求），与本地缓存对比，
     只拉 sha 变化/新增的文件（每轮约 1-4 次）；缓存存 localStorage。
     fetchTree 失败/无缓存 → 降级回退现有全量逻辑，绝不破坏同步。 */

  var TREE_CACHE_KEY = "outbound_tree_cache";

  function loadTreeCache() {
    try { return JSON.parse(localStorage.getItem(TREE_CACHE_KEY) || "null"); } catch (e) { return null; }
  }
  function saveTreeCache(cache) {
    try { localStorage.setItem(TREE_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
  }

  /** Git Trees API：一次拿全量 path→sha（blob）。失败抛错由调用方降级。 */
  async function fetchTree() {
    var url = "https://api.github.com/repos/" + Config.GH.repo + "/git/trees/" + Config.GH.branch + "?recursive=1";
    var j = await apiJson(url);
    if (!j || !Array.isArray(j.tree)) throw new Error("tree empty");
    var map = {};
    (j.tree || []).forEach(function (t) {
      if (t.type === "blob" && t.path) map[t.path] = t.sha;
    });
    return map;
  }

  /**
   * 增量拉取某目录下全部 .json：先 fetchTree 拿全量 path+sha，对比缓存只拉变更文件。
   * @param {string} dir 目录前缀，如 "data/records"
   * @param {Object|null} tree 外部传入的 tree（syncPull 一次拉取复用）；null 时内部获取
   * @returns {Promise<{recs: Array, fallback: boolean}>} fallback=true 表示走了全量兜底
   */
  async function pullDir(dir, tree) {
    var gotTree = tree;
    if (!gotTree) {
      try { gotTree = await fetchTree(); } catch (e) { gotTree = null; }
    }
    var cache = loadTreeCache();
    var prev = (cache && cache.tree) || {};
    var prefix = dir + "/";

    // 该目录下云端全部 .json 文件 {path: sha}
    var cloudFiles = {};
    Object.keys(gotTree || {}).forEach(function (p) {
      if (p.indexOf(prefix) === 0 && p.slice(-5) === ".json") cloudFiles[p] = gotTree[p];
    });

    // 对比缓存：找出 sha 变化/新增的文件
    var changed = [];
    Object.keys(cloudFiles).forEach(function (p) {
      if (prev[p] !== cloudFiles[p]) changed.push(p);
    });

    var recs = [];
    // 无 tree（首次/失败）→ 全量拉取该目录（回退现有逻辑）
    if (!gotTree) {
      var url = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + dir + "?ref=" + Config.GH.branch;
      var arr;
      try { arr = await apiJson(url); }
      catch (e) { if (String(e.message).indexOf("404") === 0) return { recs: [], fallback: true }; throw e; }
      if (Array.isArray(arr)) {
        var files = arr.filter(function (f) { return f.name.endsWith(".json") && f.size < 5 * 1024 * 1024; });
        for (var i = 0; i < files.length; i++) {
          try {
            var j = await apiJson(files[i].url);
            recs.push(JSON.parse(Util.b64dec(j.content)));
          } catch (e) {}
        }
      }
      // 全量后更新缓存（把拿到的文件 sha 写入，下次就能增量）
      if (gotTree) {
        var nc = { tree: Object.assign({}, prev, gotTree), ts: Date.now() };
        saveTreeCache(nc);
      }
      return { recs: recs, fallback: true };
    }

    // 增量：只拉变更文件（并发 3 个，避免触发次级限流）
    for (var i = 0; i < changed.length; i++) {
      try {
        var j = await apiJson("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + changed[i] + "?ref=" + Config.GH.branch);
        recs.push(JSON.parse(Util.b64dec(j.content)));
      } catch (e) { /* 单条失败跳过 */ }
    }
    // 更新缓存：合并新 tree
    saveTreeCache({ tree: Object.assign({}, prev, gotTree), ts: Date.now() });
    return { recs: recs, fallback: false, changedCount: changed.length };
  }

  /** 拉取云端全部记录（目录 404 视为空）——保留原函数供降级/兼容调用 */
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

  /** 推送前剥离 photos base64（只留 photoUrls CDN 链接）：
      本地仍保留 photos 供编辑回填/补传，但云端记录不携带大段 base64，
      记录文件从 100-300KB 瘦到 <20KB，同步/拉取更快。
      剥离为纯副本，不修改调用方持有的原对象。 */
  function slimRecord(rec) {
    if (!rec) return rec;
    if (!Array.isArray(rec.photos) || !rec.photos.length) return rec;
    var slim = Object.assign({}, rec, { photos: [] });
    return slim;
  }

  /** 推送单条记录（存在则更新，不存在则新增）；云端仅存 photoUrls，剥离 photos base64 */
  async function push(rec) {
    var slim = slimRecord(rec);
    var path = Config.GH.dir + "/" + slim.id + ".json";
    var content = Util.b64enc(JSON.stringify(slim));
    var getUrl = "https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path + "?ref=" + Config.GH.branch;
    var sha;
    try { var ej = await apiJson(getUrl); sha = ej.sha; } catch (e) {}
    var body = sha
      ? { message: "update " + slim.id, content: content, sha: sha, branch: Config.GH.branch }
      : { message: "add " + slim.id, content: content, branch: Config.GH.branch };
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
    var slim = slimRecord(rec);
    var path = "data/pickups/" + slim.id + ".json";
    var content = Util.b64enc(JSON.stringify(slim));
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
    var slim = slimRecord(rec);
    var path = "data/memos/" + slim.id + ".json";
    var content = Util.b64enc(JSON.stringify(slim));
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

  /** 照片上传云端（带重试）：data/photos/<id>-<index>.jpg；返回公网 URL（jsdelivr CDN）。
      与 pushWithRetry 同模式：最多 attempts 次指数退避（800ms/1600ms），
      401/403 令牌失效立即放弃（避免白等配额/权限问题）。 */
  async function pushPhotoWithRetry(id, index, dataUrl, attempts) {
    attempts = attempts || 3;
    var lastErr = null;
    for (var i = 0; i < attempts; i++) {
      try {
        return await pushPhoto(id, index, dataUrl);
      } catch (e) {
        lastErr = e;
        var msg = String((e && e.message) || "");
        if (/^401 |^403 /.test(msg)) break;           // 令牌失效/配额：不再重试
        if (i < attempts - 1) await new Promise(function (r) { setTimeout(r, 800 * Math.pow(2, i)); });
      }
    }
    throw lastErr || new Error("photo upload failed");
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

  /* ================= 照片上传失败追踪 =================
     照片是业务凭证，绝不能静默丢失。失败时把 {id, failedIndexes} 记入本机队列，
     云同步页可一键补传；dataURL 始终保留在记录 photos 字段（不丢原始数据）。 */

  var PHOTO_PENDING_KEY = "outbound_photo_pending";

  function loadPhotoPending() {
    try { return JSON.parse(localStorage.getItem(PHOTO_PENDING_KEY) || "[]"); } catch (e) { return []; }
  }
  function savePhotoPending(arr) {
    try { localStorage.setItem(PHOTO_PENDING_KEY, JSON.stringify(arr)); } catch (e) {}
  }
  /** 记录照片失败项（合并同 id 的 failedIndexes） */
  function markPhotoPending(id, failedIndexes) {
    if (!id || !failedIndexes || !failedIndexes.length) return;
    var q = loadPhotoPending();
    var hit = q.filter(function (x) { return x.id === id; })[0];
    if (!hit) { q.push({ id: id, failedIndexes: failedIndexes.slice() }); }
    else {
      hit.failedIndexes = Array.from(new Set(hit.failedIndexes.concat(failedIndexes))).sort(function (a, b) { return a - b; });
    }
    savePhotoPending(q);
  }
  /** 清除某记录的照片失败项 */
  function clearPhotoPending(id) {
    savePhotoPending(loadPhotoPending().filter(function (x) { return x.id !== id; }));
  }

  /** 批量上传记录照片（带重试，不再静默吞错）。
      返回 { urls, failedIndexes }；failedIndexes 为失败的照片下标（从 0 计），
      调用方据此 toast 提示并调用 markPhotoPending 入补传队列。
      limit 可选：只传前 limit 张（文件名索引与原位置一致，幂等覆盖）。 */
  async function pushPhotosDetailed(rec, limit) {
    var urls = [], failed = [];
    var photos = (rec && rec.photos) || [];
    var slice = limit ? photos.slice(0, limit) : photos;
    for (var i = 0; i < slice.length; i++) {
      try {
        var u = await pushPhotoWithRetry(rec.id, i + 1, slice[i]);
        if (u) urls.push(u); else failed.push(i);
      } catch (e) {
        failed.push(i);
      }
    }
    return { urls: urls, failedIndexes: failed };
  }

  /** 批量上传记录照片，返回 photoUrls 数组（兼容旧调用方；失败项自动入补传队列）。
      limit 可选：只传前 limit 张（文件名索引与原位置一致，幂等覆盖） */
  async function pushPhotos(rec, limit) {
    var r = await pushPhotosDetailed(rec, limit);
    if (r.failedIndexes.length) markPhotoPending(rec.id, r.failedIndexes);
    return r.urls;
  }

  /** 补传某条记录的全部缺失照片：对比 photos 与 photoUrls，只传未传成功的。
      返回 { ok, fail }。成功全部后清补传队列项。 */
  async function retryPhotosFor(rec) {
    if (!rec || !Array.isArray(rec.photos) || !rec.photos.length) return { ok: 0, fail: 0 };
    var have = (rec.photoUrls || []).length;      // 已成功的照片数（索引 0..have-1）
    var missing = [];
    for (var i = have; i < rec.photos.length; i++) missing.push(i);
    if (!missing.length) { clearPhotoPending(rec.id); return { ok: 0, fail: 0 }; }
    var urls = rec.photoUrls ? rec.photoUrls.slice() : [];
    var failed = [];
    for (var i = 0; i < missing.length; i++) {
      var idx = missing[i];
      try {
        var u = await pushPhotoWithRetry(rec.id, idx + 1, rec.photos[idx]);
        if (u) urls.push(u); else failed.push(idx);
      } catch (e) { failed.push(idx); }
    }
    if (!failed.length && window.App.Records) {
      var updated = window.App.Records.update(rec.id, { photoUrls: urls });
      clearPhotoPending(rec.id);
      return { ok: urls.length - have, fail: 0, updated: updated || rec };
    }
    markPhotoPending(rec.id, failed);
    return { ok: urls.length - have, fail: failed.length, updated: rec };
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
      返回 null=还没结果（继续等）；否则 {phase, rows, skipped, detail}
      phase: done=已写入 / skip=本单无鹿茸商品不入台账 /
             partial=已写入但部分商品漏映射（skipped 非空）/ nosync=鹿茸商品全缺映射 /
             fail=金山写入失败 */
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
    if (st.skipped && st.skipped.length) {
      // 鹿茸商品但缺台账映射：已写的部分算 done，缺失的单独告警（防呆）
      if (st.ok > 0) return { phase: "partial", rows: st.rows || {}, skipped: st.skipped, detail: st };
      return { phase: "nosync", skipped: st.skipped, detail: st };
    }
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
    if (st.phase === "partial") {
      // 已写入，但部分商品因缺映射被静默跳过 → 明确列出来，杜绝"列没对上"无感
      var pparts = [];
      var prows = st.rows || {};
      for (var pk in prows) pparts.push(pk + " 第" + prows[pk] + "行");
      var pnames = (st.skipped || []).join("、");
      return {
        text: "✅ 已写入金山台账" + (pparts.length ? "（" + pparts.join("、") + "）" : "") +
              "；⚠️ " + pnames + " 未同步（缺台账映射）",
        isErr: true,
        toast: "⚠️ " + pnames + " 未同步金山台账（商品未配置映射）"
      };
    }
    if (st.phase === "nosync") {
      // 鹿茸商品整单都缺映射 → 强告警，等于"漏写台账"
      var nnames = (st.skipped || []).join("、");
      return {
        text: "❌ 鹿茸商品「" + nnames + "」未配置金山台账映射，未写入！请联系管理员",
        isErr: true,
        toast: "❌ " + nnames + " 未写入金山台账（缺映射）"
      };
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
      // Git Trees 增量拉取：1 次 tree + 仅变更文件，替代 4 目录 N+1 全量
      var tree = null;
      try { tree = await fetchTree(); } catch (e) { tree = null; }
      var r1 = await pullDir("data/records", tree);
      var recs = r1.recs;
      // 待取货同步：拉取失败（非 404 网络异常）不影响 records 同步，单独降级为空
      var pks = [];
      try { pks = (await pullDir("data/pickups", tree)).recs; } catch (e) { pks = []; }
      // 备忘录同步：与待取货一致，失败降级为空，不影响 records
      var mms = [];
      try { mms = (await pullDir("data/memos", tree)).recs; } catch (e) { mms = []; }
      var toms = (await pullDir("data/deleted", tree)).recs;
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
    getRate: getRate,
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
    fetchTree: fetchTree,
    pullDir: pullDir,
    pushTombstone: pushTombstone,
    delWithTombstone: delWithTombstone,
    clearAllWithReason: clearAllWithReason,
    pullTombstones: pullTombstones,
    pushPhoto: pushPhoto,
    pushPhotoWithRetry: pushPhotoWithRetry,
    pushPhotos: pushPhotos,
    pushPhotosDetailed: pushPhotosDetailed,
    retryPhotosFor: retryPhotosFor,
    loadPhotoPending: loadPhotoPending,
    clearPhotoPending: clearPhotoPending,
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
