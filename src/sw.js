/**
 * sw.js — Service Worker 离线可用（优化 3，2026-08-10）
 *
 * 策略：
 *  - 页面（navigation 请求）：network-first，失败回退缓存 → 断网也能打开应用
 *  - 静态资源（CSS/JS/ico/svg/manifest，带 ?v=<sha> 指纹）：cache-first →
 *    指纹 URL 天然失效，发版后自动拉新
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

/** 静态资源 → cache-first（带指纹 URL 天然失效） */
async function handleStatic(req) {
  var cache = await caches.open(CACHE);
  var hit = await cache.match(req);
  if (hit) return hit;
  var res = await fetch(req);
  if (res && res.ok) {
    try { await cache.put(req, res.clone()); } catch (e) {}
  }
  return res;
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
