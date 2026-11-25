#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ledger_stock.py — 计算「当前库存」并推送到金山台账的库存 sheet。

库存口径（与前端 src/js/data/stock.js 完全一致）：
    库存 = catalog.inventory 基准
         + Σ(计入实际库存的入库 qty)
         - Σ(计入实际库存的出库 qty)
         + Σ(盘点 diff)

计入条件 counts_as_stock()：
    affectsStock === true
    且 不是（freezeStock === true 且 !(borrowed && borrowEngine !== "v2")）
    —— 即：冻结中的在途活单不扣实际库存（与前端 2026-09-28/29 定稿一致）

用法：
    直接跑本文件（自检打印）：
        python .github/scripts/ledger_stock.py
    由 ledger_sync.py / tools/ledger_local_sync.py 调用：
        stock, last = calc_stock(BASE, "data")
"""

import glob
import json
import os
import re
import sys

WARN_AT_DEFAULT = 95


def load_name_map(base):
    """从前端单一真相源 src/js/data/product-map.js 取 旧名→新名 映射。
    该文件是带注释的 JS 对象，用括号计数法抽出 nameMap 块再逐对解析。"""
    p = os.path.join(base, "src", "js", "data", "product-map.js")
    try:
        s = open(p, encoding="utf-8").read()
    except Exception:
        return {}
    i = s.find('"nameMap"')
    if i < 0:
        return {}
    i = s.find("{", i)
    depth, j = 0, i
    while j < len(s):
        if s[j] == "{":
            depth += 1
        elif s[j] == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    return dict(re.findall(r'"([^"]+)"\s*:\s*"([^"]+)"', s[i:j + 1]))


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def counts_as_stock(r):
    """与前端 stock.js countsAsStock 一致"""
    if not r or r.get("affectsStock") is not True:
        return False
    if r.get("freezeStock") is True and not (r.get("borrowed") is True and r.get("borrowEngine") != "v2"):
        return False
    return True


# 历史旧货品名 → 现行名（仅台账侧使用，不改前端 product-map.js）
# 2026-11-20：赛迪斯早期把「礼盒+拎袋」当套装录入，后来拆成礼盒/拎袋两个 SKU，
# 旧名残留在历史记录里，不归一会多出 3 行幽灵库存（看着像重复）。
EXTRA_ALIAS = {
    "大号礼盒+拎袋": "大号礼盒",
    "中号礼盒+拎袋": "中号礼盒",
    "小号礼盒+拎袋": "小号礼盒",
}


def calc_stock(base, data_root):
    """返回 (stock, last_change, warn_at)

    ★ 算法（2026-11-20 定稿）：采信「系统写进记录里的 stock 快照」，而不是自己从基准全量累加。
      原因：前端口径里还有冻结占用、入库进现场(zones)、历史借出单特例等分支，
      纯 Python 复刻会差几个数（实测差 1~6）。而 rec.items[].stock 本身就是系统在该笔
      落库时用 Stock.getStock() 算好的、且已固化 —— 直接取「每个货品最新一条快照」最准。
      盘点差额（不改记录）则按时间叠加快照之后的部分。

    stock[nm] = 最新快照值 + Σ(该快照时间之后的盘点 diff)
    没有快照的货品 = catalog.inventory 基准 + Σ(全部盘点 diff)
    """
    catalog_path = os.path.join(base, data_root, "catalog", "catalog.json")
    inv, warn_at = {}, {}
    try:
        cat = load_json(catalog_path)
        inv = {k: int(v) for k, v in (cat.get("inventory") or {}).items()}
        for p in (cat.get("products") or []):
            nm = p.get("name")
            if nm:
                warn_at[nm] = int(p.get("warnAt") or WARN_AT_DEFAULT)
    except Exception as e:
        print("⚠️ 读不到 catalog: %s" % e, file=sys.stderr)

    name_map = load_name_map(base)

    def norm(n):
        return name_map.get(n) or EXTRA_ALIAS.get(n) or n

    latest = {}   # nm -> (ts, stock, time_str)
    for f in sorted(glob.glob(os.path.join(base, data_root, "records", "*.json"))):
        try:
            rec = load_json(f)
        except Exception:
            continue
        ts = int(rec.get("_ts") or 0)
        t = str(rec.get("time") or "")
        for it in (rec.get("items") or []):
            nm = norm(str(it.get("name") or "").strip())
            if not nm:
                continue
            st = it.get("stock")
            if st is None or st == "":
                continue
            try:
                st = int(st)
            except Exception:
                continue
            cur = latest.get(nm)
            if cur is None or ts >= cur[0]:
                latest[nm] = (ts, st, t)

    adj_after = {}
    for f in sorted(glob.glob(os.path.join(base, data_root, "stocktakes", "*.json"))):
        try:
            st = load_json(f)
        except Exception:
            continue
        if st.get("kind") != "stocktake":
            continue
        ts = int(st.get("_ts") or 0)
        for it in (st.get("items") or []):
            nm = norm(str(it.get("name") or "").strip())
            try:
                d = int(it.get("diff") or 0)
            except Exception:
                d = 0
            if not nm or not d:
                continue
            base_ts = latest.get(nm, (0,))[0]
            if ts > base_ts:
                adj_after[nm] = adj_after.get(nm, 0) + d

    stock, last = {}, {}
    for nm in set(inv) | set(latest):
        snap = latest.get(nm)
        if snap:
            stock[nm] = snap[1] + adj_after.get(nm, 0)
            last[nm] = snap[2]
        else:
            stock[nm] = inv.get(nm, 0) + adj_after.get(nm, 0)

    return stock, last, warn_at


# ===== 排序规则（2026-11-20 主理人定稿）=====
# 品类顺序：精华液 → 面膜 → 洁面慕斯 → 精粹水 → 精粹乳 → 精粹霜
#          → 礼盒拎袋（同规格内礼盒在前、拎袋在后）→ 化妆包 → 抽绳袋 → 牛皮纸袋
# 同品类内规格从大到小；未提及的货品按数量从大到小排最后。
CAT_ORDER = ["精华液", "面膜", "洁面", "精粹水", "精粹乳", "精粹霜",
             "礼盒拎袋", "化妆包", "抽绳", "纸袋"]


def category_of(nm):
    """返回品类序号；99 = 未提及（按数量排序）"""
    if "精华液" in nm:
        return 0
    if "面膜" in nm:
        return 1
    if "洁面" in nm:
        return 2
    if "精粹水" in nm:
        return 3
    if "精粹乳" in nm:
        return 4
    if "精粹霜" in nm:
        return 5
    if "礼盒" in nm or "拎袋" in nm:
        return 6
    if "化妆包" in nm:
        return 7
    if "抽绳" in nm:
        return 8
    if "纸袋" in nm or "手提袋" in nm:
        return 9        # 2026-11-25：光栅手提袋等包装袋类统一归「牛皮纸袋」品类
    return 99


def spec_of(nm):
    """规格数值：30支装→30、150ml→150、50g→50、单支装→1"""
    m = re.search(r"(\d+)", nm)
    if m:
        return int(m.group(1))
    if "单支" in nm:
        return 1
    return 0


def sort_key(nm, qty):
    cat = category_of(nm)
    if cat == 99:
        return (99, -qty, 0, nm)          # 未提及：数量降序
    if cat == 6:
        # 礼盒/拎袋：先按号(大>中>小)，同号内 普通礼盒 → 普通拎袋 → 蝴蝶结礼盒 → 蝴蝶结拎袋
        size = 4 if "大号" in nm else (3 if "中号" in nm else (2 if "小号" in nm else 1))
        variant = 1 if "蝴蝶结" in nm else 0
        kind = 0 if "礼盒" in nm else 1
        return (6, -size, variant * 10 + kind, nm)
    return (cat, -spec_of(nm), 0, nm)     # 规格降序


CAT_NAMES = ["精华液", "面膜", "洁面慕斯", "精粹水", "精粹乳", "精粹霜",
             "礼盒拎袋", "化妆包", "抽绳袋", "牛皮纸袋"]
# 品类底色（低饱和淡色，一品类一块，视觉上分组）
CAT_BG = ["#EAF2FA", "#EAF7EE", "#FDF7E4", "#E6F4F4", "#F1ECFA",
          "#FBEDF0", "#FAF6EE", "#FCEBE2", "#F1F6E3", "#EDF1F5"]
BG_OTHER = "#FFFFFF"


def cat_name(nm):
    c = category_of(nm)
    return "其他" if c == 99 else CAT_NAMES[c]


def cat_bg(nm):
    c = category_of(nm)
    return BG_OTHER if c == 99 else CAT_BG[c]


def load_snapshot(base, data_root):
    """前端推来的只读库存镜像（data/stock-snapshot.json）。
    有它就用它 —— 那是系统自己 Stock.getStock() 算的数，零误差；
    没有就退回下面的算法兜底。"""
    p = os.path.join(base, data_root, "stock-snapshot.json")
    try:
        d = load_json(p)
        items = {k: int(v) for k, v in (d.get("items") or {}).items()}
        return items, int(d.get("updatedAt") or 0), str(d.get("time") or "")
    except Exception:
        return {}, 0, ""


def calc_frozen(base, data_root):
    """冻结占用（与前端 freeze.js map() 一致）：
       待取货未出库 + 在途出库单（freezeStock===true，排除入库/差额单/历史借出单）
       借出单要减去已归还量，borrowDone 归零。"""
    nm_map = load_name_map(base)
    alias = EXTRA_ALIAS

    def norm(n):
        return nm_map.get(n) or alias.get(n) or n

    frozen = {}

    # ① 待取货（未出库）
    for f in glob.glob(os.path.join(base, data_root, "pickups", "*.json")):
        try:
            pk = load_json(f)
        except Exception:
            continue
        if pk.get("shipped") is True:
            continue
        for it in (pk.get("items") or []):
            nm = norm(str(it.get("name") or "").strip())
            try:
                q = int(it.get("qty") or 0)
            except Exception:
                q = 0
            if nm and q > 0:
                frozen[nm] = frozen.get(nm, 0) + q

    # ② 在途出库单
    for f in glob.glob(os.path.join(base, data_root, "records", "*.json")):
        try:
            r = load_json(f)
        except Exception:
            continue
        if r.get("freezeStock") is not True:
            continue
        if (r.get("type") or "out") == "in":
            continue
        if r.get("affectsStock") is not True:
            continue
        if r.get("borrowed") is True and r.get("borrowEngine") != "v2":
            continue
        if r.get("borrowed") is True and r.get("borrowDone") is True:
            continue
        ret_map = {}
        for x in (r.get("borrowReturned") or []):
            k = norm(str(x.get("name") or ""))
            ret_map[k] = ret_map.get(k, 0) + int(x.get("qty") or 0)
        for it in (r.get("items") or []):
            nm = norm(str(it.get("name") or "").strip())
            try:
                q = int(it.get("qty") or 0)
            except Exception:
                q = 0
            if not nm or q <= 0:
                continue
            if r.get("borrowed") is True:
                q = max(0, q - ret_map.get(nm, 0))
            if q > 0:
                frozen[nm] = frozen.get(nm, 0) + q

    return frozen


def build_rows(base, data_root):
    """生成库存 sheet 的行：[分类, 货品, 当前库存, 最后变动]"""
    snap, snap_at, snap_time = load_snapshot(base, data_root)
    if snap:
        # 优先用前端镜像：与系统显示完全一致
        stock = snap
        _, last_map, _ = calc_stock(base, data_root)
        last = last_map
        print("[stock] 使用前端快照 %s（%d 个货品）" % (snap_time or "-", len(snap)))
    else:
        print("[stock] 无前端快照，回退后端算法")
        stock, last, warn_at = calc_stock(base, data_root)

    frozen_map = calc_frozen(base, data_root)
    rows = []
    for nm in sorted(stock.keys()):
        qty = stock[nm]
        # 2026-11-23 主理人要求：与库存页「可用库存」对齐 —— 输出 实际/冻结/可用 三列
        fz = frozen_map.get(nm, 0)
        rows.append([cat_name(nm), nm, qty, fz, qty - fz, (last.get(nm) or "").replace("T", " ")])
    # 按品类 → 规格降序 → 未提及按数量降序
    rows.sort(key=lambda r: sort_key(r[1], r[2]))
    return rows


if __name__ == "__main__":
    BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    for root, label in (("data", "深圳细胞"), ("data-saidis", "赛迪斯")):
        rows = build_rows(BASE, root)
        print("=" * 46)
        print("%s：%d 个货品" % (label, len(rows)))
        for r in rows:
            print("  %-22s %6s   %-16s %s" % (r[0], r[1], r[2], r[3]))
