/**
 * audit.js — 操作审计（B5，2026-08-08 第二批）
 * 记录关键操作（创建/删除/清空）到 data/audit/<id>.json（追加式独立文件，跨设备可见）。
 * 仅在有云端令牌时写入，失败静默（不阻断业务）；本机模式不记录。
 * 纯新增文件；数据目录 data/audit/ 完全独立，不触碰既有 schema。
 */
(function () {
  'use strict';

  var Util = window.App.Util;
  var Config = window.App.Config;

  /** 写一条审计日志（fire-and-forget） */
  function log(action, payload) {
    try {
      if (!(window.App.Cloud && window.App.Cloud.hasToken())) return;   // 本机模式不审计云端
      var entry = { action: action, ts: Date.now(), by: "web" };
      if (payload) {
        if (payload.id) entry.id = payload.id;
        if (payload.summary) entry.summary = payload.summary;
      }
      var id = "a" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      var path = "data/audit/" + id + ".json";
      var content = Util.b64enc(JSON.stringify(entry));
      fetch("https://api.github.com/repos/" + Config.GH.repo + "/contents/" + path, {
        method: "PUT",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": "Bearer " + Config.GH.token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ message: "audit " + id, content: content, branch: Config.GH.branch })
      }).catch(function () {});
    } catch (e) {}
  }

  window.App = window.App || {};
  window.App.Audit = { log: log };
})();
