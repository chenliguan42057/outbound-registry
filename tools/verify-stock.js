/**
 * verify-stock.js — 用真实 data/records 数据回归验证库存算法
 *
 * 背景：getRecordStock 从「每行每 item 各做一次全表扫描」(O(N²)) 改成了预计算前缀和索引。
 * 性能改写最怕算错，这个脚本把新算法的输出和改写前的老算法逐条比对，
 * 只要有一条对不上就直接报错退出。
 *
 * 用法：node tools/verify-stock.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");

// --- 构造浏览器环境 stub，直接复用线上真实的 config.js / stock.js 源码 ---
const sandbox = {
  window: { App: {} },
  console,
  // config.js 会读 localStorage 解析云端 token；Node 里没有，给个最小空实现即可
  localStorage: { getItem: () => "", setItem: () => {}, removeItem: () => {} },
  document: { querySelector: () => null, addEventListener: () => {} },
  navigator: { userAgent: "node" },
  location: { hash: "", search: "", href: "http://localhost/" }
};
sandbox.self = sandbox.window;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.document = sandbox.document;
sandbox.window.navigator = sandbox.navigator;
sandbox.window.location = sandbox.location;
vm.createContext(sandbox);

function loadScript(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
  vm.runInContext(code, sandbox, { filename: rel });
}

loadScript("src/js/core/config.js");
const Config = sandbox.window.App.Config;

// --- 载入真实记录 ---
const dir = path.join(ROOT, "data", "records");
const list = fs.readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
  .sort((a, b) => (b.time || "").localeCompare(a.time || "") || (b._ts || 0) - (a._ts || 0));

sandbox.window.App.State = { list };
loadScript("src/js/data/stock.js");
const Stock = sandbox.window.App.Stock;

// --- 改写前的老算法（原样复刻，作为对照组） ---
function norm(name) {
  const m = Config.NAME_MAP || {};
  return m[name] || name;
}
function oldGetStock(name) {
  name = norm(name);
  let init = Config.INVENTORY[name] || 0, inQty = 0, outQty = 0;
  list.forEach((r) => {
    if (r.affectsStock !== true) return;
    (r.items || []).forEach((it) => {
      if (norm(it.name) !== name) return;
      const q = Number(it.qty) || 0;
      if (r.type === "in") inQty += q; else outQty += q;
    });
  });
  return init + inQty - outQty;
}
function oldGetRecordStock(name, rec) {
  name = norm(name);
  const t = rec && rec._ts;
  if (!t) return oldGetStock(name);
  let netAfter = 0;
  list.forEach((r) => {
    if (!r || r.id === rec.id) return;
    if (r.affectsStock !== true) return;
    if ((r._ts || 0) <= t) return;
    (r.items || []).forEach((it) => {
      if (norm(it.name) !== name) return;
      const q = Number(it.qty) || 0;
      netAfter += (r.type === "in" ? q : -q);
    });
  });
  return oldGetStock(name) - netAfter;
}

// --- 比对 ---
let checked = 0, bad = 0;
const products = new Set();
list.forEach((r) => (r.items || []).forEach((it) => it && it.name && products.add(it.name)));

// 1) 当前库存
products.forEach((name) => {
  const a = Stock.getStock(name), b = oldGetStock(name);
  checked++;
  if (a !== b) { bad++; console.error(`[当前库存不一致] ${name}: 新=${a} 旧=${b}`); }
});

// 2) 每条记录每个 item 的「当时库存」
list.forEach((r) => {
  (r.items || []).forEach((it) => {
    if (!it || !it.name) return;
    const a = Stock.getRecordStock(it.name, r, it);
    const b = oldGetRecordStock(it.name, r);
    checked++;
    if (a !== b) {
      bad++;
      console.error(`[当时库存不一致] ${r.id} ${r.time} ${it.name}: 新=${a} 旧=${b}`);
    }
  });
});

// 3) 性能对照
const t0 = Date.now();
list.forEach((r) => (r.items || []).forEach((it) => it && it.name && Stock.getRecordStock(it.name, r, it)));
const tNew = Date.now() - t0;
const t1 = Date.now();
list.forEach((r) => (r.items || []).forEach((it) => it && it.name && oldGetRecordStock(it.name, r)));
const tOld = Date.now() - t1;

console.log(`记录 ${list.length} 条，比对 ${checked} 项，不一致 ${bad} 项`);
console.log(`全表渲染一次耗时：新算法 ${tNew}ms / 旧算法 ${tOld}ms`);

// --- 规模化压测：真实库只有几十条，看不出 O(N²) 的痛；合成 2000 条模拟一两年后的量 ---
const N = 2000;
const names = Array.from(products);
if (names.length) {
  const big = [];
  for (let i = 0; i < N; i++) {
    big.push({
      id: "bench" + i,
      _ts: 1700000000000 + i * 60000,
      time: "2026-01-01 00:00",
      type: i % 3 === 0 ? "in" : "out",
      affectsStock: true,
      items: [{ name: names[i % names.length], qty: (i % 5) + 1 }]
    });
  }
  sandbox.window.App.State.list = big;
  list.length = 0;
  big.forEach((r) => list.push(r));   // 老算法闭包引用的是 list，保持同一份数据
  Stock.markDirty();

  const b0 = Date.now();
  big.forEach((r) => r.items.forEach((it) => Stock.getRecordStock(it.name, r, it)));
  const bNew = Date.now() - b0;
  const b1 = Date.now();
  big.forEach((r) => r.items.forEach((it) => oldGetRecordStock(it.name, r)));
  const bOld = Date.now() - b1;

  // 大数据下也要逐条一致，性能提升不能以算错为代价
  let benchBad = 0;
  for (let i = 0; i < big.length; i += 37) {   // 抽样比对，全量比对本身就是 O(N²) 会很慢
    const r = big[i];
    r.items.forEach((it) => {
      if (Stock.getRecordStock(it.name, r, it) !== oldGetRecordStock(it.name, r)) benchBad++;
    });
  }
  bad += benchBad;
  console.log(`压测 ${N} 条：新算法 ${bNew}ms / 旧算法 ${bOld}ms（提速约 ${bOld && bNew ? Math.round(bOld / bNew) : ">100"}×），抽样不一致 ${benchBad} 项`);
}

process.exit(bad ? 1 : 0);
