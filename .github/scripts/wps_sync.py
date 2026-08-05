#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wps_sync.py — 把本次 push 中新增/修改的「鹿茸登记」记录，推送到金山轻维表。

触发：GitHub Actions (wps-sync.yml) 在 push 到 data/records/*.json 时运行。
输入：
  WEBHOOK  金山 AirScript 脚本令牌 webhook 地址（含 access_token），来自仓库密钥 secrets.WPS_AIRSCRIPT_WEBHOOK
  FILES    git diff-tree 输出的 name-status 列表，形如 "A\tdata/records/xxx.json"
逻辑：
  1) 逐行解析变更文件，只处理状态为 A(新增)/M(修改) 且路径在 data/records/ 下
  2) 解析 JSON；只有带 lurong 字段的记录（鹿茸登记）才同步，其余跳过
  3) 组装 {Context:{argv:{...}}} 调金山 AirScript webhook，由脚本写表
"""
import os
import json
import sys
import urllib.request

WEBHOOK = (os.environ.get("WEBHOOK") or "").strip()
TOKEN = (os.environ.get("AIRSCRIPT_TOKEN") or "").strip()   # 金山 脚本令牌(AirScript-Token 请求头)
FILES = (os.environ.get("FILES") or "").strip()


def log(msg):
    print(msg, flush=True)


if not WEBHOOK:
    log("⚠️ 未配置 secrets.WPS_AIRSCRIPT_WEBHOOK，跳过金山同步（网页提交仍会写 GitHub + 钉钉）。")
    sys.exit(0)
if not TOKEN:
    log("⚠️ 未配置 secrets.WPS_AIRSCRIPT_TOKEN（金山脚本令牌），无法调用 AirScript，跳过同步。")
    sys.exit(0)

if not FILES.strip():
    log("本次没有变更的记录文件。")
    sys.exit(0)

ok = 0
fail = 0

for line in FILES.splitlines():
    line = line.strip()
    if not line:
        continue
    parts = line.split("\t", 1)
    if len(parts) < 2:
        continue
    status, path = parts[0], parts[1]
    if status not in ("A", "M"):
        continue
    if not path.startswith("data/records/") or not path.endswith(".json"):
        continue
    try:
        with open(path, "r", encoding="utf-8") as f:
            rec = json.load(f)
    except Exception as e:
        log("读取失败 %s: %s" % (path, e))
        fail += 1
        continue

    lurong = rec.get("lurong")
    if not lurong:
        # 非鹿茸登记（如原 index 的普通出库），跳过
        continue

    items = rec.get("items") or []
    qty = items[0].get("qty", 0) if items else 0
    product = lurong.get("product") or (items[0].get("name") if items else "")

    payload = {
        "Context": {
            "argv": {
                "sheet_name": lurong.get("sheet_name", ""),
                "product": product,
                "type": rec.get("type", "out"),
                "date": rec.get("time", ""),
                "picker": rec.get("picker", ""),
                "sender": rec.get("sender", "陈利冠"),
                "qty": qty,
                "purpose": rec.get("purpose", ""),
                "dept": rec.get("dept", ""),
            }
        }
    }

    try:
        req = urllib.request.Request(
            WEBHOOK,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "AirScript-Token": TOKEN},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", "ignore")
        log("✅ 同步成功 %s | %s/%s：%s" % (path, lurong.get("sheet_name"), product, body[:200]))
        ok += 1
    except Exception as e:
        log("❌ 同步失败 %s：%s" % (path, e))
        fail += 1

log("完成：成功 %d，失败 %d" % (ok, fail))
sys.exit(0 if fail == 0 else 1)
