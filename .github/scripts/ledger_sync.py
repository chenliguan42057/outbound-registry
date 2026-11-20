#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ledger_sync.py — 把「出入库登记」记录推送到金山「流水台账」（双仓各一个子表）。

覆盖的业务操作（与前端一一对应）：
  出库登记            → 追加一行块，类型「出库」，状态 未审核/已审核，5 色轮转
  自动识别出库        → 同上，类型标「出库(识别)」
  待取货转出库        → 同上，类型标「待取货」
  入库登记            → 类型「⬇ 入库」，整行淡红（醒目）
  调拨出 / 调拨入     → 类型「调拨出」「⬇ 调拨入」，灰底 / 淡红
  先借后还·借出       → 类型「借出」，淡紫，状态 借出中/已结清
  先借后还·差额单     → 类型「差额」，灰底
  审核 / 撤销审核     → 只改状态列，不新增行
  编辑已完成的单      → 整块重写（行数变了也能处理）
  删除（墓碑）        → 状态「已撤销」+ 整行灰，不删行

幂等：.ledger_synced.json / .ledger_synced_saidis.json 按 rec.id 存内容指纹；
      指纹一致跳过；只有状态变 → update_ledger_status；其它 → update_ledger。
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

DATA_ROOT = (os.environ.get("DATA_PREFIX") or "data").strip()
SHEET = (os.environ.get("LEDGER_SHEET") or "深圳细胞").strip()
MARKER = (os.environ.get("MARKER_FILE") or ".ledger_synced.json").strip()
# 台账起始日：早于此日的记录不进台账（主理人 2026-11-19 定：只导 2026-11-18 起）
SINCE = (os.environ.get("LEDGER_SINCE") or "2026-11-18").strip()


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
    """'2026-11-19T15:37' -> '2026/11/19 15:37'"""
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


def status_text(rec):
    """状态列文案：pending→未审核，其余→已审核"""
    if (rec.get("status") or "submitted") == "pending":
        return "未审核"
    return "已审核"


def kind_of(rec):
    """返回 (typeText, colorKey, statusText)
    colorKey: in=淡红 / borrow=淡紫 / gray=淡灰 / cycle=5色轮转
    优先级：调拨 > 入库 > 差额 > 借出 > 识别 > 待取货 > 普通
    """
    is_in = (rec.get("type") or "out") == "in"
    role = rec.get("transferRole") or ""
    source = rec.get("source") or ""

    if role == "in" or source == "调拨入库":
        return ("⬇ 调拨入", "in", "已调拨")
    if role == "out" or source == "调拨出库":
        return ("调拨出", "gray", "已调拨")

    if is_in:
        return ("⬇ 入库", "in", "入库")

    if rec.get("fromBorrowId"):
        return ("差额", "gray", status_text(rec))

    if rec.get("borrowed"):
        return ("借出", "borrow", "已结清" if rec.get("borrowDone") else "借出中")

    if rec.get("fromRecognize"):
        return ("出库(识别)", "cycle", status_text(rec))

    if rec.get("pickupId"):
        return ("待取货", "cycle", status_text(rec))

    return ("出库", "cycle", status_text(rec))


def order_no_of(rec):
    """B 列：优先客户 JY 号（picker）；没有则回退 调拨单号 / 记录ID前缀"""
    p = str(rec.get("picker") or "").strip()
    if p:
        return p
    t = str(rec.get("transferNo") or "").strip()
    if t:
        return t
    return str(rec.get("id") or "")[:8]


def build_argv(rec):
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

    type_text, color_key, status_txt = kind_of(rec)
    return {
        "sheet_name": SHEET,
        "rid": str(rec.get("id") or ""),
        "colorKey": color_key,
        "header": {
            "datetime": fmt_dt(rec.get("time")),
            "orderNo": order_no_of(rec),
            "typeText": type_text,
            "dept": str(rec.get("dept") or "").strip(),
            "status": status_txt,
        },
        "items": items,
        "block_rows": len(items),   # 一货品一行，不再有合计行
    }


def fingerprint(argv):
    h = {
        "dt": argv["header"]["datetime"],
        "no": argv["header"]["orderNo"],
        "ty": argv["header"]["typeText"],
        "dept": argv["header"]["dept"],
        "st": argv["header"]["status"],
        "ck": argv.get("colorKey"),
        "items": [[i["name"], i["qty"], i["stock"]] for i in argv["items"]],
    }
    return hashlib.sha1(json.dumps(h, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def post_to_airscript(argv):
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
    try:
        rec = load_json(path)
    except Exception as e:
        return "bad", "读不了 JSON: %s" % e

    rid = str(rec.get("id") or "").strip()
    if not rid:
        return "bad", "缺 id"

    # 起始日过滤：早于 SINCE 的历史记录不写台账
    day = str(rec.get("time") or "")[:10]
    if day and day < SINCE:
        return "skip", "早于 %s，不进台账" % SINCE

    argv = build_argv(rec)
    if not argv:
        return "skip", "没有有效货品"

    fp = fingerprint(argv)
    prev = marker.get(rid) or {}
    prev_fp = prev.get("fp")
    if prev_fp == fp:
        return "skip", "内容未变"

    mode = "append_ledger"
    if prev_fp:
        only_status = (same_items(prev.get("items") or [], argv["items"])
                       and prev.get("typeText") == argv["header"]["typeText"]
                       and prev.get("colorKey") == argv["colorKey"])
        if only_status:
            mode = "update_ledger_status"
            argv["status"] = argv["header"]["status"]
        else:
            mode = "update_ledger"
    argv["mode"] = mode

    try:
        res = post_to_airscript(argv)
    except Exception as e:
        marker.setdefault("__fail__", {})[rid] = {"at": now_iso(), "err": str(e)[:200]}
        return "fail", "推送失败: %s" % e

    if res.get("ok", True) is False:
        marker.setdefault("__fail__", {})[rid] = {"at": now_iso(), "err": str(res.get("error"))[:200]}
        return "fail", "金山返回失败: %s" % res.get("error")

    if isinstance(marker.get("__fail__"), dict):
        marker["__fail__"].pop(rid, None)

    marker[rid] = {
        "fp": fp,
        "sheet": SHEET,
        "row": res.get("row") or prev.get("row") or 0,
        "rows": res.get("rows") or prev.get("rows") or 0,
        "items": argv["items"],
        "typeText": argv["header"]["typeText"],
        "colorKey": argv["colorKey"],
        "at": now_iso(),
    }
    return "ok", "%s（行 %s）" % (mode, res.get("row"))


def process_tombstone(path, marker):
    try:
        t = load_json(path)
    except Exception as e:
        return "bad", "读不了墓碑: %s" % e
    rid = str(t.get("id") or "").strip()
    if not rid:
        return "bad", "墓碑缺 id"
    entry = marker.get(rid) or {}
    if not entry:
        return "skip", "台账里没有，忽略"
    if entry.get("revoked"):
        return "skip", "已标记撤销"

    argv = {"mode": "revoke_ledger", "sheet_name": SHEET, "rid": rid}
    try:
        res = post_to_airscript(argv)
    except Exception as e:
        return "fail", "撤销推送失败: %s" % e
    if res.get("ok", True) is False:
        return "fail", "撤销被拒: %s" % res.get("error")

    entry["revoked"] = True
    entry["at"] = now_iso()
    marker[rid] = entry
    return "ok", "已标记撤销（行 %s）" % res.get("row")


def push_stock():
    """刷新库存 sheet（深圳细胞-库存 / 赛迪斯-库存）。
    数据由 ledger_stock.build_rows 算好（采信系统 stock 快照 + 盘点差额）。"""
    try:
        from ledger_stock import build_rows
    except Exception as e:
        log("  ⚠️ 库存模块不可用，跳过库存刷新: %s" % e)
        return
    try:
        rows = build_rows(os.getcwd(), DATA_ROOT)
        res = post_to_airscript({"mode": "update_stock", "sheet_name": SHEET + "-库存", "rows": rows})
        if res.get("ok", True) is False:
            log("  ⚠️ 库存表刷新被拒: %s" % res.get("error"))
        else:
            log("  库存表 %s：%d 个货品已刷新" % (SHEET + "-库存", len(rows)))
    except Exception as e:
        log("  ⚠️ 库存表刷新失败（不影响流水）: %s" % e)


def main():
    log("=== 流水台账同步 === 仓=%s 子表=%s" % (DATA_ROOT, SHEET))
    if not WEBHOOK or not TOKEN:
        log("⚠️ 未配置 WPS_LEDGER_WEBHOOK / WPS_LEDGER_TOKEN，本次跳过（不写标记，配好后自动补）")
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
        if not path or not path.startswith(prefix):
            continue

        if path.startswith(prefix + "deleted/"):
            if action == "D":
                continue
            st, msg = process_tombstone(path, marker)
        elif path.startswith(prefix + "records/"):
            if action == "D":
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
    # 流水处理完，顺手把库存 sheet 刷到最新（新增/删除/编辑/审核都会改变库存）
    push_stock()
    if fail_n:
        sys.exit(1)


if __name__ == "__main__":
    main()
