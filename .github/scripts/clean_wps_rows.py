#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按清单清理金山轻维表里的指定行（按「记录ID」列精确定位删除）。

用途：纠正台账脏数据。例如先借后还差额单被误写入金山（应不进台账），
通过 data/cleanup_diff_rids.json 列出要删的 rid，逐个调用金山的 delete_order。

清单格式（data/cleanup_diff_rids.json）：
[
  {"rid": "mt2odfq38fyrp", "sheets": ["2026时空鹿茸库存"]},
  ...
]

运行方式：GitHub Actions（clean-wps-rows.yml，workflow_dispatch 手动触发），
或本地设 WEBHOOK/AIRSCRIPT_TOKEN 环境变量直接跑。
幂等：删过的 rid 记入 .wps_synced.json 的 __del__，不会重复删。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wps_sync import post_to_wps, wps_result, log, now_iso, load_synced, save_synced  # noqa: E402
DATA_ROOT = (os.environ.get("DATA_PREFIX") or "data").strip()  # 双仓库数据前缀：默认 data（深圳）；赛迪斯 workflow 注入 data-saidis

CLEANUP_FILE = DATA_ROOT + "/cleanup_diff_rids.json"


def main():
    if not os.path.exists(CLEANUP_FILE):
        log("❌ 找不到清单 %s" % CLEANUP_FILE)
        return 1
    with open(CLEANUP_FILE, "r", encoding="utf-8") as f:
        jobs = json.load(f)
    if not jobs:
        log("清单为空，无事可做")
        return 0

    synced = load_synced()
    dels = synced.setdefault("__del__", {})
    total_ok = 0
    total_fail = 0
    for job in jobs:
        rid = (job or {}).get("rid")
        if not rid:
            continue
        if rid in dels:
            log("⏭ %s 已清理过，跳过" % rid)
            continue
        sheets = job.get("sheets") or ["2026时空鹿茸库存", "2026鹿茸水乳系列"]
        ok = 0
        fail = 0
        errs = []
        for sheet in sheets:
            payload = {"Context": {"argv": {
                "mode": "delete_order", "sheet_name": sheet, "rid": rid}}}
            try:
                body = post_to_wps(payload)
                res = wps_result(body)
                if res.get("ok") is False:
                    raise RuntimeError(res.get("error") or "金山返回 ok:false")
                ok += 1
                log("✅ %s / %s 删除成功%s" % (rid, sheet,
                    ("（第%s行）" % res["row"]) if res.get("row") else ""))
            except Exception as e:
                fail += 1
                errs.append("%s: %s" % (sheet, e))
                log("❌ %s / %s 删除失败：%s" % (rid, sheet, e))
        dels[rid] = {
            "ok": ok, "fail": fail, "at": now_iso(),
            "reason": job.get("reason", "manual_cleanup"),
            "err": errs[:3],
        }
        total_ok += ok
        total_fail += fail

    save_synced(synced)
    log("清理完成：成功 %d 次，失败 %d 次" % (total_ok, total_fail))
    return 0 if total_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
