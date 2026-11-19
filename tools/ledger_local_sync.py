#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ledger_local_sync.py — 本地版「流水台账」同步（用金山 CLI 直写，不依赖 AirScript webhook）

为什么需要它：
  AirScript webhook 需要把 airscript_ledger.js 粘进金山脚本编辑器并保存；
  在那边没弄好之前，用本脚本在本机直接写表，效果一样（表格结构/合并/配色全一致）。

用法：
  双击 tools/ledger_sync.bat，或命令行：
      python tools/ledger_local_sync.py
  建议配 Windows 计划任务每小时跑一次（等同 GitHub Actions 的频率）。

逻辑：
  1) 读 data/records（深圳）+ data-saidis/records（赛迪斯）
  2) 只取 time >= SINCE（默认 2026-11-18）的记录
  3) 按时间正序，逐单写进对应子表：一货品一行 + A/B/C/D/G 合并 + 配色
  4) 全量重建（先删数据行再写），避免与旧合并区域冲突

前置：本机已装 kdocs-cli 并完成 OAuth（C:/Users/clg13/AppData/Local/kdocs-cli）。
"""

import glob
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(BASE, ".github", "scripts"))
import ledger_sync as L  # noqa: E402

CLI = os.environ.get("KDOCS_CLI") or r"C:/Users/clg13/AppData/Local/kdocs-cli/kdocs-cli.exe"
FILE_ID = os.environ.get("LEDGER_FILE_ID") or "cppXUAzEuptc"
SINCE = os.environ.get("LEDGER_SINCE") or "2026-11-18"
FONT = "微软雅黑"
HEAD = ["日期时间", "订单号", "类型", "部门/客户", "货品明细", "剩余库存", "状态", "记录ID"]
CYCLE = ["#E3F0FB", "#E4F7E9", "#FDF6DC", "#FBE8EC", "#F0EAF9"]
BG_IN, BG_GRAY, BG_BORROW, BG_HEAD = "#FFE0E0", "#EAEAEA", "#F0EAF9", "#8FBFA8"
TARGETS = [("data/records", 3, "深圳细胞"), ("data-saidis/records", 4, "赛迪斯")]


def argb(h):
    return int("FF" + h.lstrip("#"), 16)


def call(action, params, pause=0.3):
    out = subprocess.run([CLI, "sheet", action, json.dumps(params, ensure_ascii=False)],
                         capture_output=True, text=True, encoding="utf-8", errors="ignore").stdout
    time.sleep(pause)
    try:
        obj, _ = json.JSONDecoder().raw_decode(out.lstrip())
        return obj
    except Exception:
        return {"raw": out[:200]}


def fmt(r1, r2, c1, c2, bg, bold=False, size=220, fg="#3C4845"):
    return {"opType": "format", "rowFrom": r1, "rowTo": r2, "colFrom": c1, "colTo": c2,
            "xf": {"font": {"name": FONT, "dyHeight": size, "bls": bold,
                            "color": {"type": 2, "value": argb(fg)}},
                   "alcH": 2, "alcV": 1, "wrap": True,
                   "fill": {"type": 1, "back": {"type": 2, "value": argb(bg)},
                            "fore": {"type": 255, "value": 0, "tint": 0}}}}


def collect(root):
    recs = []
    for f in sorted(glob.glob(os.path.join(BASE, root, "*.json"))):
        try:
            rec = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        if str(rec.get("time") or "")[:10] < SINCE:
            continue
        argv = L.build_argv(rec)
        if argv:
            recs.append((str(rec.get("time") or ""), argv))
    recs.sort(key=lambda x: x[0])
    return recs


def rebuild(sid, sheet, recs):
    # 删数据行（连合并一起清，表头保留）
    call("delete-range-data", {"file_id": FILE_ID, "worksheet_id": sid,
                              "range_data": [{"row_from": 1, "row_to": 60, "col_from": 0, "col_to": 7}],
                              "shift_type": "shift_up"})
    # 表头
    call("update-range-data", {"file_id": FILE_ID, "sheetId": sid, "rangeData": [
        {"opType": "formula", "rowFrom": 0, "rowTo": 0, "colFrom": i, "colTo": i, "formula": h}
        for i, h in enumerate(HEAD)]})

    row = 1
    cycle_i = 0
    for _, argv in recs:
        items = argv["items"]
        n = len(items)
        h = argv["header"]
        cells = [(row, 0, h["datetime"]), (row, 1, h["orderNo"]), (row, 2, h["typeText"]),
                 (row, 3, h["dept"]), (row, 6, h["status"])]
        for k, it in enumerate(items):
            cells += [(row + k, 4, "%s × %d" % (it["name"], it["qty"])),
                      (row + k, 5, "" if it["stock"] is None else it["stock"]),
                      (row + k, 7, argv["rid"])]
        call("update-range-data", {"file_id": FILE_ID, "sheetId": sid, "rangeData": [
            {"opType": "formula", "rowFrom": r, "rowTo": r, "colFrom": c, "colTo": c, "formula": str(v)}
            for r, c, v in cells]})

        if n > 1:
            call("update-range-data", {"file_id": FILE_ID, "sheetId": sid, "rangeData": [
                {"opType": "merge", "rowFrom": row, "rowTo": row + n - 1,
                 "colFrom": col, "colTo": col, "type": "MergeCenter"} for col in (0, 1, 2, 3, 6)]})

        ck = argv.get("colorKey")
        if ck == "in":
            bg = BG_IN
        elif ck == "gray":
            bg = BG_GRAY
        elif ck == "borrow":
            bg = BG_BORROW
        else:
            bg = CYCLE[cycle_i % len(CYCLE)]
            cycle_i += 1

        styles = [fmt(row, row + n - 1, 0, 6, bg)]
        if ck == "in":
            styles.append(fmt(row, row + n - 1, 2, 2, bg, bold=True, size=240, fg="#C0392B"))
        call("update-range-data", {"file_id": FILE_ID, "sheetId": sid, "rangeData": styles})
        row += n

    call("update-range-data", {"file_id": FILE_ID, "sheetId": sid,
                               "rangeData": [fmt(0, 0, 0, 7, BG_HEAD, bold=True, size=240, fg="#FFFFFF")]})
    return row - 1


def main():
    print("=== 本地流水台账同步 === 起始日 %s" % SINCE)
    if not os.path.exists(CLI):
        print("❌ 找不到 kdocs-cli: %s" % CLI)
        return 1
    total = 0
    for root, sid, sheet in TARGETS:
        recs = collect(root)
        n = rebuild(sid, sheet, recs)
        total += n
        print("  %s：%d 单 / %d 行" % (sheet, len(recs), n))
    print("=== 完成，共 %d 行 ===" % total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
