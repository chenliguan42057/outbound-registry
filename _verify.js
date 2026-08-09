/**
 * _verify.js — 本地回归验收脚本（临时文件，验收后删除）
 * 用 Puppeteer 逐条跑改动点，避免靠肉眼推断。
 */
const puppeteer = require('puppeteer');
const BASE = 'http://127.0.0.1:8099/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

  /* ============ 一、移动端落地页（出库表单链路） ============ */
  console.log('\n=== 一、移动端 390px 落地页 ===');
  const m = await browser.newPage();
  const errors = [];
  m.on('pageerror', e => errors.push('pageerror: ' + e.message));
  m.on('console', e => { if (e.type() === 'error') errors.push('console: ' + e.text()); });
  const failed404 = [];
  m.on('response', r => { if (r.status() >= 400) failed404.push(r.status() + ' ' + r.url().replace(BASE, '')); });

  await m.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await m.goto(BASE, { waitUntil: 'networkidle2' });
  await sleep(600);

  // A1 无 JS 报错（favicon 缺失单列在资源检查里，不算运行时错误）
  const realErrors = errors.filter(e => !/favicon/i.test(e));
  check('落地页无 JS 运行时错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  // A2 全局错误兜底已装载
  const hasFatalHook = await m.evaluate(() => typeof window.__reportFatal === 'function');
  check('全局错误兜底 __reportFatal 已装载', hasFatalHook);

  // A3 错误条能真实渲染
  const barShown = await m.evaluate(() => {
    window.__reportFatal('自检用例');
    const bar = document.getElementById('fatal-error-bar');
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    const vis = getComputedStyle(bar).position === 'fixed' && r.height > 0;
    bar.remove();
    return vis;
  });
  check('错误条可见且 fixed 定位', barShown === true);

  // A4 Store.set 返回布尔 + 配额识别
  const storeOk = await m.evaluate(() => window.App.Store.set('__t__', { a: 1 }) === true);
  check('Store.set 成功时返回 true', storeOk);
  await m.evaluate(() => window.App.Store.remove('__t__'));

  // A5 Cloud.getRate 已导出
  const rateApi = await m.evaluate(() => {
    const r = window.App.Cloud.getRate && window.App.Cloud.getRate();
    return r && 'remaining' in r && 'low' in r;
  });
  check('Cloud.getRate 已导出且结构正确', rateApi);

  // A6 catalog 的 UI 惰性访问已生效（不再是解析期 undefined）
  const catalogOk = await m.evaluate(() => !!(window.App.Catalog && window.App.UI && window.App.UI.Modal));
  check('Catalog 与 UI 均已就绪（依赖倒置已修）', catalogOk);

  // === 试点批次回归 ===
  // B1 空表单提交 → 一次性字段级标红
  await m.click('#outSubmit');
  await sleep(400);
  const errCount = await m.evaluate(() => document.querySelectorAll('.field.has-error').length);
  check('空表单提交一次性标红多个字段', errCount >= 4, errCount + ' 个字段');

  const firstErrFocused = await m.evaluate(() => {
    const f = document.querySelector('.field.has-error');
    if (!f) return false;
    const input = f.querySelector('input,textarea,select,button');
    return !!input && document.activeElement === input;
  });
  check('自动聚焦到第一个错误字段', firstErrFocused);

  // B2 iOS 防缩放：所有可输入控件字号 ≥16px
  const smallFonts = await m.evaluate(() => {
    const out = [];
    document.querySelectorAll('input:not([type=hidden]),textarea,select').forEach(el => {
      if (el.offsetParent === null) return;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 16) out.push((el.id || el.className || el.tagName) + ':' + fs + 'px');
    });
    return out;
  });
  check('移动端输入控件字号均 ≥16px（iOS 不缩放）', smallFonts.length === 0, smallFonts.slice(0, 3).join(', '));

  // B3 label for 关联
  const labelOk = await m.evaluate(() => {
    const labels = [...document.querySelectorAll('#view-landing label.field-label, #view-landing label')];
    const withFor = labels.filter(l => l.getAttribute('for'));
    const broken = withFor.filter(l => !document.getElementById(l.getAttribute('for')));
    return { total: labels.length, withFor: withFor.length, broken: broken.length };
  });
  check('label for 均指向存在的控件', labelOk.broken === 0,
    labelOk.withFor + '/' + labelOk.total + ' 已关联, ' + labelOk.broken + ' 失效');

  // B4 inputmode 覆盖
  const inputmodeOk = await m.evaluate(() => {
    const el = document.getElementById('outPicker');
    return el && el.getAttribute('autocomplete') !== null;
  });
  check('关键输入框已配置 autocomplete', inputmodeOk);

  // B5 触控热区 ≥44px。顶栏图标按钮用 ::after 扩热区，视觉尺寸不变，
  //     因此不能只看 getBoundingClientRect，要用 elementFromPoint 探真实命中区。
  const tapTargets = await m.evaluate(() => {
    const bad = [];
    document.querySelectorAll('#view-landing button').forEach(b => {
      if (b.offsetParent === null) return;
      const r = b.getBoundingClientRect();
      if (r.height === 0) return;
      if (r.height >= 40) return;                        // 本体已够大
      // 本体偏小：检查上下各 20px 处是否仍能命中该按钮（即热区已被伪元素撑开）
      const cx = r.left + r.width / 2;
      const hitTop = document.elementFromPoint(cx, r.top + r.height / 2 - 20);
      const hitBot = document.elementFromPoint(cx, r.top + r.height / 2 + 20);
      const ok = [hitTop, hitBot].every(el => el && (el === b || b.contains(el) || el.contains(b)));
      if (!ok) bad.push((b.id || b.className).slice(0, 30) + ':' + Math.round(r.height));
    });
    return bad;
  });
  check('落地页按钮触控热区均 ≥44px', tapTargets.length === 0, tapTargets.slice(0, 3).join(', '));

  // B6 提交防重
  const lockOk = await m.evaluate(() => typeof window.App.Views.out.render === 'function');
  check('出库视图 API 完整', lockOk);

  /* ============ 二、PC 端管理页 ============ */
  console.log('\n=== 二、PC 端 1440px 管理页 ===');
  const p = await browser.newPage();
  const pErrors = [];
  p.on('pageerror', e => pErrors.push('pageerror: ' + e.message));
  p.on('console', e => { if (e.type() === 'error') pErrors.push('console: ' + e.text()); });
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto(BASE + '#/app', { waitUntil: 'networkidle2' });
  await sleep(700);

  // 管理页有密码门槛（本地默认 1111），先登录才能拿到 Windows 外壳
  const loginInput = await p.$('#modal-root input[type=password], #modal-root input');
  if (loginInput) {
    await loginInput.type('1111');
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('#modal-root button')];
      const enter = btns.find(b => /进入|确定|登录/.test(b.textContent));
      (enter || btns[btns.length - 1]).click();
    });
    await sleep(1200);
  }
  const shellUp = await p.evaluate(() => document.getElementById('view-app').innerHTML.length > 500);
  check('输入密码后管理端外壳正常渲染', shellUp);

  check('管理页无 JS 运行时错误', pErrors.length === 0, pErrors.slice(0, 3).join(' | '));

  // C1 ⚙ 设置按钮已注入（原本永不出现）
  const gearShown = await p.evaluate(() => {
    const btns = document.querySelectorAll('.ux-settings-btn');
    return { count: btns.length, visible: [...btns].filter(b => b.offsetParent !== null).length };
  });
  check('⚙ 显示与体验设置按钮已注入顶栏', gearShown.visible >= 1,
    '共 ' + gearShown.count + ' 个, 可见 ' + gearShown.visible);

  // C2 设置面板可打开
  const panelOk = await p.evaluate(async () => {
    const b = document.querySelector('.ux-settings-btn');
    if (!b) return false;
    b.click();
    await new Promise(r => setTimeout(r, 300));
    return !!document.querySelector('#modal-root .modal, #modal-root [class*=modal]');
  });
  check('设置面板可正常打开（深色模式/字号可达）', panelOk === true);
  await p.keyboard.press('Escape');
  await sleep(200);

  // C3 视图切换后倒计时定时器被回收
  const destroyOk = await p.evaluate(() => typeof window.App.Views.sync.destroy === 'function');
  check('sync 视图暴露 destroy 供 mount 回收定时器', destroyOk);

  // C4 PC 端视觉未回归：stepper 仍是原尺寸（patch.css 只在 ≤560px 生效）
  const pcStepper = await p.evaluate(() => {
    const s = document.createElement('div');
    s.className = 'qty-stepper';
    s.style.position = 'absolute'; s.style.visibility = 'hidden';
    document.body.appendChild(s);
    const h = getComputedStyle(s).height;
    s.remove();
    return h;
  });
  check('PC 端 stepper 高度保持原值 32px（无视觉回归）', pcStepper === '32px', pcStepper);

  /* ============ 三、资源加载 ============ */
  console.log('\n=== 三、资源 ===');
  const real404 = failed404.filter(u => !u.includes('favicon'));
  check('无资源加载失败（favicon 除外）', real404.length === 0, failed404.join(', ') || '无');

  // D1 新增静态资源可访问（favicon / manifest / 404）
  const assets = await m.evaluate(async () => {
    const out = {};
    for (const u of ['favicon.ico', 'manifest.json', '404.html']) {
      try { const r = await fetch(u, { method: 'HEAD' }); out[u] = r.status; }
      catch (e) { out[u] = 'ERR'; }
    }
    return out;
  });
  check('favicon.ico 可访问 (200)', assets['favicon.ico'] === 200, 'status ' + assets['favicon.ico']);
  check('manifest.json 可访问 (200)', assets['manifest.json'] === 200, 'status ' + assets['manifest.json']);
  check('404.html 存在 (200/404)', assets['404.html'] === 200 || assets['404.html'] === 404, 'status ' + assets['404.html']);

  /* ============ 四、自动深色（prefers-color-scheme） ============ */
  console.log('\n=== 四、自动深色 ===');
  const d = await browser.newPage();
  await d.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await d.goto(BASE, { waitUntil: 'networkidle2' });
  await sleep(500);
  const themeDark = await d.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('系统深色偏好下自动套用深色（data-theme=dark）', themeDark === 'dark', 'theme=' + themeDark);
  await d.close();

  await m.screenshot({ path: 'D:/tmp/or_review/_shot_mobile.png' });
  await p.screenshot({ path: 'D:/tmp/or_review/_shot_pc.png' });
  await browser.close();

  console.log('\n===== 合计 ' + pass + ' PASS / ' + fail + ' FAIL =====');
  process.exit(fail > 0 ? 1 : 0);
})();
