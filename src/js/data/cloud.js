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

  /** 逐条推送本地全部记录 */
  async function pushAllLocal(list) {
    var ok = 0, fail = 0;
    var arr = list || window.App.State.list;
    for (var i = 0; i < arr.length; i++) {
      try { await push(arr[i]); ok++; } catch (e) { fail++; }
    }
    return { ok: ok, fail: fail };
  }

  /**
   * 拉取 + 合并 + 落盘
   * opts.onStatus(text, isErr) 回调用于更新顶栏/模块同步状态
   * 返回 { ok: boolean, list?: Record[], error?: Error }
   */
  async function syncPull(opts) {
    opts = opts || {};
    var onStatus = opts.onStatus || function () {};
    onStatus("同步中…", false);
    try {
      var recs = await pull();
      var merged = window.App.Records.mergeAndSort(window.App.State.list, recs);
      window.App.State.list = merged;
      Store.saveRecords(merged);
      window.App.State.lastSync = new Date();
      onStatus("已同步 " + window.App.State.lastSync.toLocaleString(), false);
      return { ok: true, list: merged };
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
    syncPull: syncPull
  };
})();
