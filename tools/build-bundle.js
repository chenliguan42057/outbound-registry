#!/usr/bin/env node
'use strict';
/**
 * build-bundle.js —— outbound-registry 首屏提速构建脚本（2026-09-23 新增）
 *
 * 作用：
 *   1) 把 src/index.html 里「原顺序排列的外链脚本」合并压缩成 src/js/app.bundle.js
 *      —— 请求数 46 → 1。GitHub Pages 走 HTTP/1.1、同域仅 6 并发，45 个请求实测墙钟 3 秒以上，
 *         弱网/微信内置浏览器更久，扫码用户会误判成「没扫上」。
 *   2) 生成高识别率二维码（1024px PNG + SVG），网址与旧码完全一致，可与旧码并存。
 *
 * 关键安全约定（不要改）：
 *   - mangle: false —— 绝不重命名标识符。页面大量使用 innerHTML + 内联 onclick 引用全局函数，
 *     一旦改名即全站点不动。
 *   - 不删除任何源文件：src/js/** 全部原样保留，deploy.yml 的防回滚守卫 grep 的仍是这些源文件。
 *     bundle 只是「运行时的合并产物」。
 *   - index.html 里保留了供守卫 grep 的文件名字符串（注释形式），不要删。
 *
 * 依赖（不污染项目目录，走 WorkBuddy 托管 node 工作区）：
 *   export NODE_PATH="C:/Users/clg13/.workbuddy/binaries/node/workspace/node_modules"
 *   已安装：qrcode、terser
 *
 * 用法：
 *   node tools/build-bundle.js [二维码输出目录，默认 <仓库上级>/qr-out] [--no-qr]
 *
 * 脚本清单从哪来（2026-09-23 补强）：
 *   ① 若 index.html 仍是「多外链脚本」原貌 → 直接按原顺序解析；
 *   ② 若 index.html 已是合并态 → 回退读 tools/bundle-manifest.json 的有序清单。
 *   两者都拿不到才报错中止（防止把 bundle 自己再包一遍）。所以合并后无需再动 index.html 即可重复构建。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');          // 仓库根
const SRC = path.join(ROOT, 'src');
const QR_OUT = process.argv[2] || path.resolve(ROOT, '..', 'qr-out');
// 网址永不改变（硬约束）：不带 hash、不带参数，保持最短
const TARGET_URL = 'https://chenliguan42057.github.io/outbound-registry/';

(async () => {
  /* ---------------- 1) 二维码 ---------------- */
  console.log('===== 1. 二维码（网址与原码一致，可并存） =====');
  const SKIP_QR = process.argv.indexOf('--no-qr') !== -1;
  let QR;
  try { QR = require('qrcode'); } catch (e) {
    console.log('  ⚠️ 未安装 qrcode，跳过二维码生成（export NODE_PATH=... 后重试）');
  }
  if (SKIP_QR) {
    console.log('  ⏭️  已指定 --no-qr：跳过二维码生成（仅重建 bundle）');
  } else if (QR) {
    fs.mkdirSync(QR_OUT, { recursive: true });
    const variants = [
      { ecc: 'Q', note: '37x37 模块更大，推荐打印张贴' },
      { ecc: 'H', note: '41x41 容错 30%，推荐屏幕展示' }
    ];
    for (const v of variants) {
      await QR.toFile(path.join(QR_OUT, '二维码-1024-' + v.ecc + '级.png'), TARGET_URL, {
        type: 'png', errorCorrectionLevel: v.ecc, margin: 4, width: 1024,
        color: { dark: '#000000FF', light: '#FFFFFFFF' }
      });
      fs.writeFileSync(path.join(QR_OUT, '二维码-矢量-' + v.ecc + '级.svg'),
        await QR.toString(TARGET_URL, { type: 'svg', errorCorrectionLevel: v.ecc, margin: 4, width: 1024 }));
      const mods = QR.create(TARGET_URL, { errorCorrectionLevel: v.ecc }).modules.size;
      console.log('  [' + v.ecc + '] 矩阵 ' + mods + 'x' + mods +
        ' ｜ 1024px 下每模块 ' + (1024 / (mods + 8)).toFixed(1) + 'px ｜ ' + v.note);
    }
    console.log('  输出目录：' + QR_OUT);
  }

  /* ---------------- 2) 首屏 bundle ---------------- */
  console.log('\n===== 2. 首屏 bundle =====');
  const htmlPath = path.join(SRC, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  let files = [...html.matchAll(/<script[^>]*\ssrc="([^"?]+)(?:\?[^"]*)?"[^>]*>\s*<\/script>/g)].map(m => m[1]);

  if (files.length < 5) {
    /* index.html 已是「合并态」（只剩 app.bundle.js）时，回退读清单文件。
       清单是重建的唯一真相源，避免每次都要从 git 历史捞原 index.html。 */
    const mfPath = path.join(__dirname, 'bundle-manifest.json');
    if (fs.existsSync(mfPath)) {
      files = JSON.parse(fs.readFileSync(mfPath, 'utf8')).files;
      console.log('  ℹ️ index.html 已是合并态 → 改用清单 tools/bundle-manifest.json（' + files.length + ' 个模块）');
    } else {
      console.error('  ✋ 中止：index.html 只解析到 ' + files.length + ' 个外链脚本，且无 tools/bundle-manifest.json 清单。');
      console.error('     继续构建会把 bundle 自己再包一遍（会静默出错）。');
      console.error('     请先从 git 历史取回原 index.html：git checkout HEAD~1 -- src/index.html 并重跑本脚本。');
      process.exit(1);
    }
  }

  const parts = [], missing = [];
  for (const f of files) {
    const p = path.join(SRC, f);
    if (!fs.existsSync(p)) { missing.push(f); continue; }
    parts.push('/* ==== ' + f + ' ==== */\n' + fs.readFileSync(p, 'utf8'));
  }
  if (missing.length) console.log('  ⚠️ 源文件缺失（已跳过）：' + missing.join(', '));

  let terser;
  try { terser = require('terser'); } catch (e) {
    console.error('  ✋ 未安装 terser，无法压缩。export NODE_PATH 后重试。');
    process.exit(1);
  }
  const code = parts.join('\n;\n');
  const res = await terser.minify(code, {
    compress: { passes: 1, toplevel: false, unused: false, drop_console: false },
    mangle: false,                        // 关键：不重命名，见文件头说明
    format: { comments: false, max_line_len: 0 },
    ecma: 2015
  });
  if (res.error) throw res.error;
  fs.writeFileSync(path.join(SRC, 'js', 'app.bundle.js'),
    '/* 自动生成（tools/build-bundle.js 产物）：按 index.html 原顺序拼接，源文件完整保留在 src/js/ 下，勿手改 */\n' + res.code);

  const kb = n => (n / 1024).toFixed(0) + 'KB';
  console.log('  合并脚本数：' + files.length + ' ｜ 请求数 ' + (files.length + 1) + ' → 1');
  console.log('  拼接后 ' + kb(Buffer.byteLength(code)) + ' → 压缩后 ' + kb(Buffer.byteLength(res.code + '')));
  console.log('  产物：src/js/app.bundle.js');
})();
