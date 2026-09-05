/**
 * sw.js — Service Worker 离线可用（优化 3，2026-08-10）
 *
 * 策略：
 *  - 页面（navigation 请求）：network-first，失败回退缓存 → 断网也能打开应用
 *  - 静态资源（CSS/JS/ico/svg/manifest）：network-first（2026-09-05 起由
 *    cache-first 改为 network-first，杜绝发版后用户仍拿到旧版样式的缓存残留；
 *    在线永远最新，离线回退缓存）
 *  - GitHub API（api.github.com）与 jsdelivr CDN（cdn.jsdelivr.net）：
 *    一律透传不缓存（数据走 localStorage，绝不缓存 API 响应）
 *
 * 版本：缓存名带 __CACHE_BUST__（部署时替换为短 SHA），新版本 activate 时
 * 清理旧缓存，避免磁盘堆积与旧资源残留。
 */
'use strict';

var CACHE = "outbound-v__CACHE_BUST__";
var VERSION = "__CACHE_BUST__";

/** 页面导航请求 → network-first */
async function handleNavigation(req) {
  var cache = await caches.open(CACHE);
  try {
    var fresh = await fetch(req);
    // 仅缓存成功响应（离线时回退用）
    if (fresh && fresh.ok) {
      try { await cache.put(req, fresh.clone()); } catch (e) {}
    }
    return fresh;
  } catch (e) {
    // 离线：回退缓存的页面
    var cached = await cache.match(req) || await cache.match("./");
    if (cached) return cached;
    // 完全无缓存：返回一个极简离线提示页（避免白屏）
    return new Response(
      '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">' +
      '<title>离线</title><style>body{font-family:sans-serif;display:flex;' +
      'align-items:center;justify-content:center;height:100vh;margin:0;' +
      'background:#f1f8f4;color:#2b5c47}h1{font-size:22px;text-align:center;' +
      'padding:0 20px}</style></head><body><h1>📴 当前处于离线状态<br>' +
      '<small style="font-weight:normal;color:#6fa08a;font-size:14px">请联网后刷新重试</small></h1>' +
      '</body></html>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

/** 静态资源 → network-first（在线永远最新，离线回退缓存）
 *  fetch 加 cache: "reload" 强制绕过浏览器 HTTP 磁盘缓存，避免旧文件残留
 *  （2026-09-05：补强 — 不加 cache:reload 时 disk cache 仍会拦截旧 CSS） */
async function handleStatic(req) {
  var cache = await caches.open(CACHE);
  try {
    var fresh = await fetch(req, { cache: "reload" });
    if (fresh && fresh.ok) {
      try { await cache.put(req, fresh.clone()); } catch (e) {}
    }
    return fresh;
  } catch (e) {
    var cached = await cache.match(req);
    if (cached) return cached;
    return new Response("", { status: 504, statusText: "Offline" });
  }
}

self.addEventListener("install", function (event) {
  // 预缓存核心入口（其余资源首次访问时按需缓存）
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(["./", "./manifest.json", "./favicon.svg", "./favicon.ico"])
        .catch(function () { /* 单资源失败不阻塞激活 */ });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k.indexOf("outbound-v") === 0 && k !== CACHE; })
          .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  // 同源才接管；API 与 CDN 一律透传
  if (url.origin !== location.origin) return;
  if (url.hostname.indexOf("api.github.com") !== -1) return;
  if (url.hostname.indexOf("cdn.jsdelivr.net") !== -1) return;
  // 非 GET 一律透传（PUT/DELETE 走云端）
  if (event.request.method !== "GET") return;

  if (event.request.mode === "navigate") {
    event.respondWith(handleNavigation(event.request));
  } else {
    event.respondWith(handleStatic(event.request));
  }
});
