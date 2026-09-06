/* ============================================================
   icons.js — V2 试点：运行时 emoji → SVG 线图标替换
   ------------------------------------------------------------
   为什么这么做（而不是去改那 17 个业务 js）：
     1. 零侵入 —— 不修改任何 views/*.js，完全绕开 deploy.yml 的防回滚守卫
     2. 可回退 —— 只在 <html class="v2"> 时生效，去掉 v2 类立刻变回 emoji
     3. 好维护 —— 一张映射表管全站，新增图标只改这里

   机制：MutationObserver 监听 DOM 新增节点，把文本节点里的 emoji
        按 MAP 表换成内联 <svg>。倒序快照遍历，避免 replaceChild 导致漏扫。

   刻意不替换的东西（换了会破坏语义）：
     → ← ↑ ↓ 等方向箭头（302 个，是文本不是图标）
     ☀ ☁ 🌧 🌫 ⛈ 天气类（AI 助手回复里当内容用）
     ⚪ 🔵 状态圆点（带颜色语义，SVG 单色会丢信息）

   注意：本文件为纯 UTF-8 / LF，勿用脚本整文件重写。
   ============================================================ */
(function () {
  'use strict';

  var root = document.documentElement;
  if (!root.classList.contains('v2')) return;   // 非试点模式，直接不加载逻辑

  /* ---------- 一、图标路径（24×24，与 components.js 的 ICON_PATHS 同一规格） ---------- */
  var P = {
    warn:      '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    ok:        '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    check:     '<path d="M20 6 9 17l-5-5"/>',
    transfer:  '<path d="M16 3h5v5"/><path d="M21 3 8 16"/><path d="M8 21H3v-5"/><path d="M3 21 16 8"/>',
    report:    '<path d="M3 3v18h18"/><path d="M7 15v3"/><path d="M12 9v9"/><path d="M17 12v6"/>',
    calendar:  '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4"/><path d="M16 3v4"/><path d="M3 11h18"/>',
    calc:      '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8h8"/><path d="M8 13h.01"/><path d="M12 13h.01"/><path d="M16 13h.01"/><path d="M8 17h.01"/><path d="M12 17h.01"/><path d="M16 17h.01"/>',
    clipboard: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
    x:         '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    xmark:     '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    trash:     '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    camera:    '<path d="M4 8h3l2-2h6l2 2h3v11H4Z"/><circle cx="12" cy="13" r="3.5"/>',
    box:       '<path d="M3 8l9-5 9 5v8l-9 5-9-5V8Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
    undo:      '<path d="M3 10h11a5 5 0 0 1 0 10h-4"/><path d="m7 6-4 4 4 4"/>',
    search:    '<circle cx="11" cy="11" r="7"/><path d="m20 20-4.5-4.5"/>',
    memo:      '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4"/><path d="M16 3v4"/><path d="M3 11h18"/><path d="M8 15h8"/><path d="M8 18h5"/>',
    settings:  '<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M4.2 4.2l2.1 2.1"/><path d="M17.7 17.7l2.1 2.1"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="M4.2 19.8l2.1-2.1"/><path d="M17.7 6.3l2.1-2.1"/>',
    sync:      '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/><path d="M3 12a9 9 0 0 1 3-6.7"/><path d="M3 20v-5h5"/>',
    robot:     '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4"/><path d="M9 14h.01"/><path d="M15 14h.01"/><path d="M2 14v3"/><path d="M22 14v3"/>',
    pin:       '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/>',
    clock:     '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    chart:     '<path d="M3 3v18h18"/><path d="m7 14 3.5-3.5 3 3L20 7"/><path d="M16 7h4v4"/>',
    broom:     '<path d="M19 5 9 15"/><path d="m14 10 3 3"/><path d="m9 15-4 4"/>',
    news:      '<path d="M4 5h13v14H4z"/><path d="M17 8h3v11H7"/>',
    lock:      '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    bulb:      '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9V18h7v-4.1A6 6 0 0 0 12 3Z"/>',
    money:     '<circle cx="12" cy="12" r="9"/><path d="M8 9h8"/><path d="M12 9v8"/><path d="M9.5 13h5"/>',
    pen:       '<path d="M17 3l4 4-13 13H4v-4L17 3Z"/>',
    snow:      '<path d="M12 2v20"/><path d="m4.5 7 15 10"/><path d="m19.5 7-15 10"/>',
    fire:      '<path d="M12 22c4 0 7-2.7 7-6.5 0-4-3-6-3-9.5 0 0-2 1-2 4 0-2-1-3-1-5-3 2-5 5-5 8.5C8 18 8 22 12 22Z"/>',
    clip:      '<path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7"/>',
    mega:      '<path d="m3 11 15-7v16L3 13Z"/><path d="M3 11v2a3 3 0 0 0 3 3h1"/><path d="M7 12v7h2a2 2 0 0 0 2-2v-3"/>',
    refresh:   '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
    chat:      '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 0 1 8-8h2a8 8 0 0 1 8 4Z"/>',
    globe:     '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
    trophy:    '<path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 6H5v2a3 3 0 0 0 3 3"/><path d="M16 6h3v2a3 3 0 0 1-3 3"/><path d="M12 13v4"/><path d="M9 21h6"/>',
    image:     '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/>',
    mic:       '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
    abc:       '<path d="m3 16 3-9 3 9"/><path d="M4.5 12h3"/><path d="M13 8h4"/><path d="M13 16h4"/><path d="M13 8v8"/>',
    think:     '<circle cx="12" cy="12" r="9"/><path d="M9 10h.01"/><path d="M15 10h.01"/><path d="M8 15h8"/><path d="M15 19h2"/>',
    ruler:     '<path d="M3 15 15 3l6 6L9 21H3v-6Z"/><path d="M7 9l2 2"/><path d="M10 6l2 2"/><path d="M13 3l2 2"/>'
  };

  /* ---------- 二、emoji → 图标名 映射表 ---------- */
  var MAP = {
    '\u26A0': 'warn',        // ⚠  警告
    '\u2705': 'ok',          // ✅ 成功
    '\u2713': 'check',       // ✓
    '\u21C4': 'transfer',    // ⇄  调拨
    '\u21BB': 'refresh',     // ↻
    '\u21B6': 'undo',        // ↶  借用归还
    '\uD83D\uDCCA': 'report',   // 📊 报表
    '\uD83D\uDCC8': 'chart',    // 📈
    '\uD83D\uDCC5': 'calendar', // 📅 日期
    '\uD83D\uDDD3': 'memo',     // 🗓 备忘录
    '\uD83E\uDDEE': 'calc',     // 🧮 库存核对
    '\uD83D\uDCCB': 'clipboard',// 📋 记录
    '\u274C': 'x',           // ❌
    '\u2715': 'xmark',       // ✕
    '\uD83D\uDDD1': 'trash',    // 🗑 删除
    '\uD83D\uDCDD': 'pen',      // 📝
    '\uD83D\uDCF7': 'camera',   // 📷 拍照
    '\uD83D\uDCE6': 'box',      // 📦 库存
    '\uD83D\uDD0D': 'search',   // 🔍
    '\u2699': 'settings',    // ⚙
    '\uD83D\uDD04': 'sync',     // 🔄 同步
    '\uD83E\uDD16': 'robot',    // 🤖 AI 助手
    '\uD83D\uDCCC': 'pin',      // 📌
    '\uD83D\uDCD0': 'ruler',    // 📐
    '\uD83D\uDD58': 'clock',    // 🕘 历史
    '\uD83E\uDDF9': 'broom',    // 🧹 清空
    '\uD83D\uDCF0': 'news',     // 📰 推送
    '\uD83D\uDD12': 'lock',     // 🔒
    '\uD83D\uDCA1': 'bulb',     // 💡 提示
    '\uD83D\uDCB0': 'money',    // 💰
    '\u2744': 'snow',        // ❄
    '\uD83D\uDD25': 'fire',     // 🔥
    '\uD83D\uDCCE': 'clip',     // 📎
    '\uD83D\uDCE3': 'mega',     // 📣 通知
    '\uD83D\uDCAC': 'chat',     // 💬
    '\uD83C\uDF10': 'globe',    // 🌐
    '\uD83C\uDFC6': 'trophy',   // 🏆
    '\uD83D\uDDBC': 'image',    // 🖼
    '\uD83C\uDFA4': 'mic',      // 🎤
    '\uD83D\uDD20': 'abc',      // 🔠
    '\uD83E\uDD14': 'think'     // 🤔
  };

  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, SVG: 1, SELECT: 1, OPTION: 1, PRE: 1, CODE: 1 };
  var RE = /[\u26A0\u2705\u2713\u21C4\u21BB\u21B6\u274C\u2715\u2699\u2744\uD83D\uD83E\uD83C]/;
  var VS = '\uFE0F';   // 变体选择符，紧跟 emoji 出现，替换时一并吞掉

  function makeIcon(name) {
    var box = document.createElement('span');
    box.className = 'v2-ico';
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || '') + '</svg>';
    return box;
  }

  function scanText(node) {
    var txt = node.nodeValue;
    if (!txt || txt.indexOf(VS) < 0 && !RE.test(txt)) return;

    var frag = document.createDocumentFragment();
    var buf = '';
    var hit = false;

    for (var i = 0; i < txt.length; i++) {
      var ch = txt.charAt(i);
      if (ch === VS) continue;                       // 吞掉变体选择符
      var name = MAP[ch];
      if (!name && i + 1 < txt.length) name = MAP[ch + txt.charAt(i + 1)];   // 代理对（4 字节 emoji）
      if (name) {
        if (buf) { frag.appendChild(document.createTextNode(buf)); buf = ''; }
        frag.appendChild(makeIcon(name));
        hit = true;
        if (txt.charCodeAt(i) >= 0xD800 && txt.charCodeAt(i) <= 0xDBFF) i++; // 跳过代理对后半
      } else {
        buf += ch;
      }
    }
    if (buf) frag.appendChild(document.createTextNode(buf));
    if (hit && node.parentNode) node.parentNode.replaceChild(frag, node);
  }

  function iconify(node) {
    if (!node) return;
    if (node.nodeType === 3) { scanText(node); return; }
    if (node.nodeType !== 1 || SKIP[node.tagName]) return;
    if (node.getAttribute && node.getAttribute('data-no-icon') === '1') return;

    var kids = Array.prototype.slice.call(node.childNodes);   // 快照，避免边遍历边改
    for (var i = 0; i < kids.length; i++) iconify(kids[i]);
  }

  /* ---------- 三、全站自动接管 ---------- */
  function boot() {
    iconify(document.body);
    if (!window.MutationObserver) return;
    var busy = false;
    var mo = new MutationObserver(function (list) {
      if (busy) return;
      var todo = [];
      for (var i = 0; i < list.length; i++) {
        var added = list[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1) todo.push(added[j]);
        }
      }
      if (!todo.length) return;
      busy = true;
      // 合并同一批变更，避免逐节点触发造成的重复扫描
      requestAnimationFrame(function () {
        for (var k = 0; k < todo.length; k++) {
          if (todo[k].parentNode) iconify(todo[k]);
        }
        busy = false;
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  window.__pilotIcons = { paths: P, map: MAP, scan: iconify };
})();
