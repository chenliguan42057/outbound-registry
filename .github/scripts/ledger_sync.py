#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ledger_sync.py — 把「出库登记」记录推送到金山「出库流水台账」（双仓各一个子表）。

触发：GitHub Actions (ledger-sync.yml)
  - push 到 data/records/*.json 或 data-saidis/records/*.json → 只处理本次变更
  - schedule / workflow_dispatch(backfill=true) → 全量扫描，已同步的靠指纹跳过

与 wps_sync.py 的区别（别混）：
  wps_sync.py    = 库存滚动台账（每货品一对[发放/库存]列，库存由金山脚本推算）
  ledger_sync.py = 出库流水台账（固定 6 列，一货品一行，剩余库存取系统快照，不做推算）

幂等（内容指纹，照抄 wps_sync 口径）：
  .ledger_synced.json / .ledger_synced_saidis.json 里按 rec.id 存 fp：
    fp 一致           → 跳过
    只有状态变了       → update_ledger_status（只改 F 列，不碰结构）
    内容变了（含货品） → update_ledger（金山侧拆合并→整块重写→再合并）
  删除（deleted/）    → revoke_ledger（标「已撤销」+ 浅灰，不删行）
"""

import hashlib
import json
import os
import sys
import time
import urllib.request

WEBHOOK = (os.environ.get("WEBHOOK") or "").strip()
TOKEN = (os.environ.get("AIRSCRIPT_TOKEN") or "").strip()
FILES = (os.environ.get("FILES") or "").strip()
BACKFILL = (os.environ.get("BACKFILL") or "").strip().lower() in ("1", "true", "yes")

# 双仓：深圳默认 data/深圳细胞；赛迪斯 workflow 注入 data-saidis/赛迪斯
DATA_ROOT = (os.environ.get("DATA_PREFIX") or "data").strip()
SHEET = (os.environ.get("LEDGER_SHEET") or "深圳细胞").strip()
MARKER = (os.environ.get("MARKER_FILE") or ".ledger_synced.json").strip()


def log(msg):
    print(msg, flush=True)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_marker():
    try:
        if os.path.exists(MARKER):
            return load_json(MARKER)
    except Exception:
        pass
    return {}


def save_marker(m):
    with open(MARKER, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)


def fmt_dt(time_str):
    """'2026-11-19T15:37' -> '2026/11/19 15:37'（无前导零，照金山台账习惯）"""
    if not time_str:
        return ""
    s = str(time_str).strip()
    d, _, t = s.partition("T")
    parts = d.split("-")
    if len(parts) != 3:
        return s
    try:
        date_txt = "%s/%d/%d" % (parts[0], int(parts[1]), int(parts[2]))
    except Exception:
        return s
    t = t[:5] if t else ""
    return (date_txt + " " + t).strip()


def is_out(rec):
    """出库判定：type 缺省或 'out'（全代码口径 (r.type || 'out')）"""
    return (rec.get("type") or "out") != "in"


def status_text(rec):
    if (rec.get("status") or "submitted") == "pending":
        return "未审核"
    return "已审核"


def is_gray(rec):
    """非正常出货单据 → 台账整行浅灰：调拨、先借后还差额单"""
    if rec.get("transferRole") or (rec.get("source") == "调拨出库"):
        return True
    if rec.get("fromBorrowId"):
        return True
    return False


def order_no_of(rec):
    """台账 B 列「订单号」= 客户 JY 号（即 picker）。
       没有 picker 时依次回退：调拨单号 → 记录 id 前 8 位，保证这列永远不空。"""
    p = str(rec.get("picker") or "").strip()
    if p:
        return p
    t = str(rec.get("transferNo") or "").strip()
    if t:
        return t
    return str(rec.get("id") or "")[:8]


def build_argv(rec):
    """组装金山 argv（一单 → N+1 行）"""
    items = []
    for it in (rec.get("items") or []):
        nm = str(it.get("name") or "").strip()
        try:
            qty = int(it.get("qty"))
        except Exception:
            qty = 0
        if not nm or qty <= 0:
            continue
        stock = it.get("stock")
        try:
            stock = int(stock) if stock is not None and stock != "" else None
        except Exception:
            stock = None
        items.append({"name": nm, "qty": qty, "stock": stock})
    if not items:
        return None
    header = {
        "datetime": fmt_dt(rec.get("time")),
        "orderNo": order_no_of(rec),
        "dept": str(rec.get("dept") or "").strip(),
        "status": status_text(rec),
    }
    return {
        "sheet_name": SHEET,
        "rid": str(rec.get("id") or ""),
        "header": header,
        "items": items,
        "gray": is_gray(rec),
        "block_rows": len(items) + 1,
    }


def fingerprint(argv):
    """内容指纹：只取会落到台账的字段，sha1 前 16 位"""
    h = {
        "dt": argv["header"]["datetime"],
        "no": argv["header"]["orderNo"],
        "dept": argv["header"]["dept"],
        "st": argv["header"]["status"],
        "gray": bool(argv.get("gray")),
        "items": [[i["name"], i["qty"], i["stock"]] for i in argv["items"]],
    }
    raw = json.dumps(h, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def post_to_airscript(argv):
    """POST 到金山 AirScript webhook；返回解析后的 result（失败抛错）"""
    body = {"Context": {"argv": argv}}
    req = urllib.request.Request(
        WEBHOOK,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "AirScript-Token": TOKEN},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8", "ignore")
    try:
        j = json.loads(text)
        d = j.get("data") if isinstance(j, dict) else None
        if isinstance(d, dict) and isinstance(d.get("result"), dict):
            return d["result"]
        return d if isinstance(d, dict) else {"ok": True, "raw": text[:200]}
    except Exception:
        return {"ok": True, "raw": text[:200]}


def same_items(a, b):
    try:
        return [[i["name"], i["qty"], i["stock"]] for i in a] == \
               [[i["name"], i["qty"], i["stock"]] for i in b]
    except Exception:
        return False


def process_record(path, marker):
    """处理一条记录文件；返回 (状态, 说明)"""
    try:
        rec = load_json(path)
    except Exception as e:
        return "bad", "读不了 JSON: %s" % e

    rid = str(rec.get("id") or "").strip()
    if not rid:
        return "bad", "缺 id"
    if not is_out(rec):
        return "skip", "入库单不进出库台账"

    argv = build_argv(rec)
    if not argv:
        return "skip", "没有有效货品"

    fp = fingerprint(argv)
    prev = marker.get(rid) or {}
    prev_fp = prev.get("fp")

    if prev_fp == fp:
        return "skip", "内容未变（指纹一致）"

    # 决策：新单 → 追加；只有状态变 → 只改状态；其它 → 整块重写
    mode = "append_ledger"
    if prev_fp:
        prev_items = prev.get("items") or []
        if same_items(prev_items, argv["items"]):
            mode = "update_ledger_status"
            argv["status"] = argv["header"]["status"]
        else:
            mode = "update_ledger"
    argv["mode"] = mode

    try:
        res = post_to_airscript(argv)
    except Exception as e:
        marker.setdefault("__fail__", {})[rid] = {"at": now_iso(), "err": str(e)[:200],
                                                  "count": int((marker.get("__fail__", {}).get(rid, {}) or {}).get("count", 0)) + 1}
        return "fail", "推送失败: %s" % e

    ok = res.get("ok", True) is not False
    if not ok:
        marker.setdefault("__fail__", {})[rid] = {"at": now_iso(), "err": str(res.get("error"))[:200],
                                                  "count": int((marker.get("__fail__", {}).get(rid, {}) or {}).get("count", 0)) + 1}
        return "fail", "金山返回失败: %s" % res.get("error")

    if isinstance(marker.get("__fail__"), dict):
        marker["__fail__"].pop(rid, None)

    marker[rid] = {
        "fp": fp,
        "sheet": SHEET,
        "row": res.get("row") or prev.get("row") or 0,
        "rows": res.get("rows") or prev.get("rows") or 0,
        "items": argv["items"],
        "at": now_iso(),
    }
    return "ok", "%s 完成（行 %s）" % (mode, res.get("row"))


def process_tombstone(path, marker):
    """删除记录 → 台账标「已撤销」+ 浅灰（不删行）"""
    try:
        t = load_json(path)
    except Exception as e:
        return "bad", "读不了墓碑: %s" % e
    rid = str(t.get("id") or "").strip()
    if not rid:
        return "bad", "墓碑缺 id"
    if not (marker.get(rid)):
        return "skip", "台账里本来就没有，忽略"
    if (marker.get(rid) or {}).get("revoked"):
        return "skip", "已标记过撤销"

    argv = {"mode": "revoke_ledger", "sheet_name": SHEET, "rid": rid}
    try:
        res = post_to_airscript(argv)
    except Exception as e:
        return "fail", "撤销推送失败: %s" % e
    if res.get("ok", True) is False:
        return "fail", "撤销被拒: %s" % res.get("error")

    entry = marker.get(rid) or {}
    entry["revoked"] = True
    entry["at"] = now_iso()
    marker[rid] = entry
    return "ok", "已标记撤销（行 %s）" % res.get("row")


def main():
    log("=== 出库流水台账同步开始 === 仓=%s 子表=%s 标记=%s" % (DATA_ROOT, SHEET, MARKER))
    if not WEBHOOK or not TOKEN:
        # 未配置凭证时「安静退出」而不是报错：代码可以先上线，
        # 等主理人把 WPS_LEDGER_WEBHOOK / WPS_LEDGER_TOKEN 配好后自动生效，期间不刷红色失败。
        log("⚠️ 未配置 WPS_LEDGER_WEBHOOK / WPS_LEDGER_TOKEN，本次跳过（不写标记，配好后会自动补）")
        return
    if not FILES:
        log("没有变更文件，结束")
        return

    marker = load_marker()
    prefix = DATA_ROOT.rstrip("/") + "/"
    ok_n = fail_n = skip_n = 0

    for line in FILES.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        action = (parts[0] or "").strip().upper()
        path = (parts[-1] or "").strip()
        if not path:
            continue
        # 只处理本仓文件（深圳 data/ 不会误吃 data-saidis/）
        if not path.startswith(prefix):
            continue

        if path.startswith(prefix + "deleted/"):
            if action == "D":
                continue
            st, msg = process_tombstone(path, marker)
        elif path.startswith(prefix + "records/"):
            if action == "D":
                # records 文件被物理删除但没墓碑：按缺省处理，不动台账（墓碑才是权威）
                skip_n += 1
                log("  - %s：记录文件被删但无墓碑，跳过" % path)
                continue
            st, msg = process_record(path, marker)
        else:
            continue

        if st == "ok":
            ok_n += 1
        elif st == "fail":
            fail_n += 1
        else:
            skip_n += 1
        log("  [%s] %s → %s" % (st, os.path.basename(path), msg))

    save_marker(marker)
    log("=== 完成：成功 %d / 失败 %d / 跳过 %d ===" % (ok_n, fail_n, skip_n))
    if fail_n:
        sys.exit(1)


if __name__ == "__main__":
    main()
