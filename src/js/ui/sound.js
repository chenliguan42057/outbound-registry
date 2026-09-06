/* ============================================================
   sound.js — V2 试点：Web Audio 实时合成音效
   ------------------------------------------------------------
   为什么不用 mp3：
     · 零体积、零请求 —— 音色由振荡器现场合成，不占那 64KB 省下的带宽
     · 想改音色只改数字，不用重新压音频文件

   四种音（音色刻意做得"短、轻、闷"，避免廉价电子音）：
     tap  点击   triangle 双频 40ms   音量 6%   极轻一"嗒"
     ok   成功   sine 上行 660→990Hz          清亮不刺耳
     err  失败   triangle 下行 330→196Hz      闷、有厚度
     del  删除   比 err 更低更短               有"拿走"的实感

   触发：
     · 点击任意按钮 / 菜单项 → tap
     · 监听 #toast-root 新增提示，按文案关键词判成败 → ok / err / del
     · 对外开放 window.__pilotSound('ok') 供以后手动调用

   开关：右下角浮动小按钮可随时静音，选择存 localStorage。
        也支持 URL 参数 ?sound=0（关）/ ?sound=1（开）。
   ============================================================ */
(function () {
  'use strict';

  var root = document.documentElement;
  if (!root.classList.contains('v2')) return;

  var LS_KEY = 'pilot-sound';
  var VOL = 0.22;                       // 总音量，刻意压低：仓库现场不该打扰别人

  var q = location.search || '';
  if (q.indexOf('sound=0') !== -1) localStorage.setItem(LS_KEY, '0');
  else if (q.indexOf('sound=1') !== -1) localStorage.setItem(LS_KEY, '1');
  var enabled = localStorage.getItem(LS_KEY) !== '0';

  var ac = null;
  function ctx() {
    if (ac) return ac;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ac = new AC(); } catch (e) { return null; }
    return ac;
  }

  /* 单个音：8ms 淡入防爆音 + 指数淡出，尾巴自然不突兀 */
  function tone(f1, f2, dur, type, vol, delay) {
    var c = ctx();
    if (!c) return;
    if (c.state === 'suspended' && c.resume) c.resume();
    var t0 = c.currentTime + (delay || 0);
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(f1, t0);
    if (f2 && f2 !== f1) osc.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.004);   // 4ms 起音：慢起音是「闷」的主因之一
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  /* 音色（2026-09-06 按主理人反馈改清脆）
     闷的三个来源：① 频率偏低 ② triangle 波中低频偏厚 ③ 起音 8ms 太慢
     改法：整体上移、全换 sine、起音压到 4ms、主音上叠一层高八度泛音造「叮」感 */
  var SOUNDS = {
    tap: function () {                    // 指甲轻敲玻璃
      tone(2100, 1900, 0.022, 'sine', VOL * 0.30, 0);
      tone(1050, 980, 0.030, 'sine', VOL * 0.13, 0.003);
    },
    ok: function () {                     // 风铃：C6 → G6，尾音叠泛音
      tone(1046, 1046, 0.055, 'sine', VOL * 0.46, 0);
      tone(1568, 1568, 0.130, 'sine', VOL * 0.40, 0.055);
      tone(3136, 3136, 0.045, 'sine', VOL * 0.10, 0.055);
    },
    err: function () {                    // 下行但干净，不拖泥带水
      tone(622, 587, 0.060, 'sine', VOL * 0.44, 0);
      tone(466, 415, 0.120, 'sine', VOL * 0.34, 0.060);
    },
    del: function () {                    // 比失败更短促的「咔」
      tone(523, 494, 0.048, 'sine', VOL * 0.40, 0);
      tone(392, 349, 0.095, 'sine', VOL * 0.28, 0.048);
    }
  };

  var last = 0;
  function play(name) {
    if (!enabled) return;
    var fn = SOUNDS[name];
    if (!fn) return;
    var now = Date.now();
    if (now - last < 40) return;        // 节流：连点时不糊成一团
    last = now;
    try { fn(); } catch (e) { /* 音频不可用时静默降级 */ }
  }

  window.__pilotSound = play;

  /* ---------- 一、点击音 ---------- */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('button, .btn, .chip, .win-sidebar-item, .win-topbar-menu, .win-titlebar-btn')) play('tap');
  }, true);

  /* ---------- 二、结果音：跟着 toast 文案走 ---------- */
  function watchToast() {
    var host = document.getElementById('toast-root');
    if (!host || !window.MutationObserver) return;
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var added = list[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          var txt = String(n.textContent || '').slice(0, 80);
          if (/失败|错误|无法|超时|异常|不支持|中断/.test(txt)) play('err');
          else if (/已删除|已移除|已清除|已作废/.test(txt)) play('del');
          else if (/成功|已完成|已保存|已同步|已登记|已提交|已确认|已恢复/.test(txt)) play('ok');
        }
      }
    }).observe(host, { childList: true, subtree: true });
  }
  if (document.body) watchToast();
  else document.addEventListener('DOMContentLoaded', watchToast);

  /* ---------- 三、右下角静音开关（仅试点模式出现） ---------- */
  function mountToggle() {
    if (document.getElementById('v2-sound-btn')) return;
    var b = document.createElement('button');
    b.id = 'v2-sound-btn';
    b.type = 'button';
    b.title = enabled ? '点击静音' : '点击开启音效';
    b.setAttribute('aria-label', b.title);
    b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9998;width:38px;height:38px;' +
      'border-radius:50%;border:.5px solid rgba(60,72,69,.14);cursor:pointer;display:flex;' +
      'align-items:center;justify-content:center;padding:0;color:#57826F;' +
      'background:rgba(251,249,243,.92);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);' +
      'box-shadow:0 4px 12px rgba(60,72,69,.14), inset 0 1px 0 rgba(255,255,255,.95);' +
      'transition:transform .12s cubic-bezier(.2,0,0,1);';
    b.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M11 5 6 9H3v6h3l5 4V5Z"/>' +
      (enabled
        ? '<path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6.5a8 8 0 0 1 0 11"/>'
        : '<path d="m17 9 4 6"/><path d="m21 9-4 6"/>') +
      '</svg>';

    b.onclick = function () {
      enabled = !enabled;
      localStorage.setItem(LS_KEY, enabled ? '1' : '0');
      b.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M11 5 6 9H3v6h3l5 4V5Z"/>' +
        (enabled
          ? '<path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6.5a8 8 0 0 1 0 11"/>'
          : '<path d="m17 9 4 6"/><path d="m21 9-4 6"/>') +
        '</svg>';
      b.title = enabled ? '点击静音' : '点击开启音效';
      if (enabled) play('ok');
    };
    b.onmousedown = function () { b.style.transform = 'scale(.92)'; };
    b.onmouseup = function () { b.style.transform = ''; };
    document.body.appendChild(b);
  }
  if (document.body) mountToggle();
  else document.addEventListener('DOMContentLoaded', mountToggle);
})();
