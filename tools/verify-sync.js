/**
 * verify-sync.js — 数据安全相关逻辑的回归验证
 *
 * 覆盖本轮「数据不丢」三项改动：
 *   1) applyTombstones：clear-all 只清时间窗之前的记录（原来是无条件清空，
 *      导致清空操作变成永久地雷——之后新建的记录也会被同步抹掉）
 *   2) mergeAndSort：同 id 冲突取较新版本，不再让云端静默覆盖本地未推送的修改
 *   3) restore：回收站还原保留原 id/_ts，且重复还原幂等
 *
 * 用法：node tools/verify-sync.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const store = {};
const sandbox = {
  console,
  window: { App: {} },
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  },
  document: { querySelector: () => null, addEventListener: () => {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }), body: { appendChild() {} } },
  navigator: { userAgent: "node" },
  location: { hash: "", search: "", href: "http://localhost/" },
  setTimeout, clearTimeout, btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary")
};
Object.assign(sandbox.window, {
  localStorage: sandbox.localStorage, document: sandbox.document,
  navigator: sandbox.navigator, location: sandbox.location,
  setTimeout, clearTimeout, addEventListener: () => {}
});
vm.createContext(sandbox);
const load = (rel) => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });

load("src/js/core/config.js");
load("src/js/core/util.js");
load("src/js/core/store.js");
load("src/js/data/stock.js");
load("src/js/data/records.js");

const App = sandbox.window.App;
const Records = App.Records;
const State = App.State;

let fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? " → " + extra : "")); }
}

/* ---------- 1. clear-all 时间窗 ---------- */
console.log("1) applyTombstones：clear-all 时间窗");
{
  const CUT = 1700000000000;
  const before = { id: "old1", _ts: CUT - 10000, items: [] };   // 清空前的记录，应被清掉
  const after = { id: "new1", _ts: CUT + 10000, items: [] };    // 清空后新建，必须留下
  const out = Records.applyTombstones([before, after], [{ type: "clear-all", deletedAt: CUT }]);
  const ids = out.map((r) => r.id);
  check("清空点之前的记录被清除", !ids.includes("old1"), "剩余=" + ids.join(","));
  check("清空点之后新建的记录被保留", ids.includes("new1"), "剩余=" + ids.join(","));

  // 单条墓碑照常生效
  const out2 = Records.applyTombstones([{ id: "a", _ts: 1 }, { id: "b", _ts: 2 }], [{ id: "a" }]);
  check("单条墓碑仍能删除指定记录", out2.length === 1 && out2[0].id === "b");
}

/* ---------- 2. 合并冲突取较新 ---------- */
console.log("2) mergeAndSort：冲突取较新版本");
{
  const localNewer = { id: "x", time: "2026-01-01 10:00", _ts: 1000, updatedAt: 5000, purpose: "本地改过" };
  const remoteOlder = { id: "x", time: "2026-01-01 10:00", _ts: 1000, updatedAt: 3000, purpose: "云端旧版" };
  const merged = Records.mergeAndSort([localNewer], [remoteOlder]);
  check("本地较新时不被云端覆盖", merged[0].purpose === "本地改过", "实际=" + merged[0].purpose);

  const localOlder = { id: "y", time: "2026-01-01 10:00", _ts: 1000, updatedAt: 1000, purpose: "本地旧版" };
  const remoteNewer = { id: "y", time: "2026-01-01 10:00", _ts: 1000, updatedAt: 9000, purpose: "云端改过" };
  const merged2 = Records.mergeAndSort([localOlder], [remoteNewer]);
  check("云端较新时正常覆盖本地", merged2[0].purpose === "云端改过", "实际=" + merged2[0].purpose);

  // 云端瘦身（剥离 base64）后不应反向抹掉本地照片原图
  const localPhoto = { id: "z", time: "2026-01-01", _ts: 1, photos: ["data:image/jpeg;base64,AAA"] };
  const remoteSlim = { id: "z", time: "2026-01-01", _ts: 1, photos: [], photoUrls: ["https://cdn/1.jpg"] };
  const merged3 = Records.mergeAndSort([localPhoto], [remoteSlim]);
  check("云端瘦身不抹掉本地照片原图", merged3[0].photos.length === 1);
}

/* ---------- 3. 回收站还原 ---------- */
console.log("3) restore：回收站还原");
{
  State.list = [{ id: "keep", time: "2026-01-02 09:00", _ts: 2000, items: [], affectsStock: true }];
  const dead = { id: "gone", time: "2026-01-01 09:00", _ts: 1000, items: [{ name: "测试品", qty: 2 }], affectsStock: true };
  Records.restore(dead);
  check("还原后记录回到列表", State.list.some((r) => r.id === "gone"));
  const restored = State.list.find((r) => r.id === "gone");
  check("还原保留原始 id 与 _ts", restored._ts === 1000 && restored.id === "gone",
    "_ts=" + restored._ts);
  const n = State.list.length;
  Records.restore(dead);
  check("重复还原幂等（不产生副本）", State.list.length === n, "长度=" + State.list.length);
}

console.log(fail ? `\n失败 ${fail} 项` : "\n全部通过");
process.exit(fail ? 1 : 0);
