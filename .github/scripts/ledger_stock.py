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
        return name_map.get(n, n)

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


def build_rows(base, data_root):
    """生成库存 sheet 的行：[货品, 当前库存, 最后变动, 标记]"""
    stock, last, warn_at = calc_stock(base, data_root)
    rows = []
    for nm in sorted(stock.keys()):
        qty = stock[nm]
        warn = warn_at.get(nm, WARN_AT_DEFAULT)
        if qty < 0:
            flag = "负库存·需核对"
        elif qty == 0:
            flag = "已用完"
        elif qty < warn:
            flag = "低库存"
        else:
            flag = ""
        rows.append([nm, qty, (last.get(nm) or "").replace("T", " "), flag])
    # 负数/低库存优先，其余按货品名
    rows.sort(key=lambda r: (0 if r[1] < 0 else (1 if r[1] < warn_at.get(r[0], WARN_AT_DEFAULT) else 2), r[0]))
    return rows


if __name__ == "__main__":
    BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    for root, label in (("data", "深圳细胞"), ("data-saidis", "赛迪斯")):
        rows = build_rows(BASE, root)
        print("=" * 46)
        print("%s：%d 个货品" % (label, len(rows)))
        for r in rows:
            print("  %-22s %6s   %-16s %s" % (r[0], r[1], r[2], r[3]))
