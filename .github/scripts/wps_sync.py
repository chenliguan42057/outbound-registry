#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wps_sync.py — 把「鹿茸登记」记录推送到金山轻维表（照台账格式追加一行）。

触发：GitHub Actions (wps-sync.yml)
  - push 到 data/records/*.json 时，只处理本次变更的文件（天然幂等）
  - workflow_dispatch 且 backfill=true 时，处理 data/records/ 下全部历史文件（一次性回填）
  - 本地回填：设 BACKFILL=1 + GH_PAT，直接读工作区文件并调用金山 webhook

识别规则（不再硬性要求 lurong 字段）：
  1) 优先看 rec.lurong（旧 lurong.html 路径）：取 sheet_name + product
  2) 否则看 rec.items[].name，用 PRODUCT_MAP 映射到「子表 + 金山列名」
     ——主程序 out/in 页提交的记录没有 lurong 字段，靠这里识别
出库/入库：rec.type=="in" 视为入库，其余（含 out.js 不设 type）视为出库

幂等：已处理过的记录 ID 写入 .wps_synced.json 标记，下次跳过，避免重复写行与死循环。
"""

import os
import json
import sys
import base64
import urllib.request

WEBHOOK = (os.environ.get("WEBHOOK") or "").strip()
TOKEN = (os.environ.get("AIRSCRIPT_TOKEN") or "").strip()   # 金山 脚本令牌(AirScript-Token 请求头)
FILES = (os.environ.get("FILES") or "").strip()
BACKFILL = (os.environ.get("BACKFILL") or "").strip().lower() in ("1", "true", "yes")
GH_PAT = (os.environ.get("GH_PAT") or "").strip()  # 本地回填时用来回写标记文件
REPO = "chenliguan42057/outbound-registry"
MARKER = ".wps_synced.json"

# 主程序商品名 -> (金山子表, 金山列归一化名)
# 归一化名须与 airscript_append.js 的 normalizeProductName() 输出一致
PRODUCT_MAP = {
    # ===== 2026鹿茸水乳系列 =====
    "洁面慕斯 150ml": ("2026鹿茸水乳系列", "洁面150ml"),
    "洁面慕斯 50ml": ("2026鹿茸水乳系列", "洁面50ml"),
    "舒缓精粹水 120ml": ("2026鹿茸水乳系列", "精粹水120ml"),
    "舒缓精粹水 30ml": ("2026鹿茸水乳系列", "精粹水30ml"),
    "赋活精粹乳 80ml": ("2026鹿茸水乳系列", "精粹乳80ml"),
    "赋活精粹乳 30ml": ("2026鹿茸水乳系列", "精粹乳30ml"),
    "赋活精粹乳 1ml": ("2026鹿茸水乳系列", "精粹乳1ml"),
    "舒缓精粹霜 50g": ("2026鹿茸水乳系列", "精粹霜50g"),
    "舒缓精粹霜 15g": ("2026鹿茸水乳系列", "精粹霜15g"),
    "舒缓精粹霜 5g": ("2026鹿茸水乳系列", "精粹霜5g"),
    "舒缓精粹霜 1g": ("2026鹿茸水乳系列", "精粹霜1g"),
    # ===== 2026时空鹿茸库存 =====
    "冻干精华液 20支装": ("2026时空鹿茸库存", "20支盒"),
    "冻干精华液 5支装": ("2026时空鹿茸库存", "5支盒"),
    "冻干精华液 单支装": ("2026时空鹿茸库存", "1支袋"),
    "面膜 5片装": ("2026时空鹿茸库存", "面膜5片盒"),
    "面膜 1片装": ("2026时空鹿茸库存", "面膜1片"),
    "冻干精华液 30支装": ("2026时空鹿茸库存", "精华30支盒"),
    "华大鹿茸凝时系列礼盒装": ("2026时空鹿茸库存", "中秋礼盒"),
}


def log(msg):
    print(msg, flush=True)


def fmt_date(time_str):
    """'2026-08-06T17:23' -> '2026/8/6'（照 xlsx 台账习惯，无前导零）"""
    if not time_str:
        return ""
    d = time_str.split("T")[0] if "T" in time_str else time_str
    parts = d.split("-")
    if len(parts) != 3:
        return time_str
    try:
        return parts[0] + "/" + str(int(parts[1])) + "/" + str(int(parts[2]))
    except Exception:
        return time_str


def map_product(name):
    return PRODUCT_MAP.get((name or "").strip())


def load_synced():
    try:
        if os.path.exists(MARKER):
            with open(MARKER, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def save_synced(synced):
    with open(MARKER, "w", encoding="utf-8") as f:
        json.dump(synced, f, ensure_ascii=False, indent=2)
    # 本地回填：通过 GitHub API 回写标记（触发的是 marker 提交，路径非 data/records，不会再次触发本 workflow）
    if GH_PAT:
        try:
            commit_marker_api(GH_PAT)
        except Exception as e:
            log("⚠️ 标记回写失败（不影响本次同步）: %s" % e)


def commit_marker_api(pat, path=MARKER):
    api = "https://api.github.com/repos/%s/contents/%s" % (REPO, path)
    with open(path, "rb") as f:
        content = base64.b64encode(f.read()).decode("ascii")
    sha = None
    try:
        req = urllib.request.Request(api, headers={
            "Authorization": "token %s" % pat,
            "Accept": "application/vnd.github+json",
        })
        with urllib.request.urlopen(req, timeout=30) as r:
            sha = json.load(r).get("sha")
    except Exception:
        sha = None
    body = {"message": "chore: update wps sync marker [backfill]", "content": content, "branch": "main"}
    if sha:
        body["sha"] = sha
    req = urllib.request.Request(api, data=json.dumps(body).encode("utf-8"), headers={
        "Authorization": "token %s" % pat,
        "Content-Type": "application/json",
        "Accept": "application/vnd.github+json",
    }, method="PUT")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "ignore")


def post_to_wps(payload):
    req = urllib.request.Request(
        WEBHOOK,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "AirScript-Token": TOKEN},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "ignore")


def collect_jobs(rec):
    """返回 [(sheet_name, product, type, qty), ...] 待写金山的任务列表"""
    jobs = []
    lurong = rec.get("lurong")
    rtype = "in" if rec.get("type") == "in" else "out"
    items = rec.get("items") or []

    if lurong:
        # 旧 lurong.html 路径
        sheet = lurong.get("sheet_name", "")
        product = lurong.get("product", "")
        qty = rec.get("qty") or (items[0].get("qty", 0) if items else 0)
        jobs.append((sheet, product, rtype, qty))
        return jobs

    for it in items:
        name = it.get("name", "")
        mp = map_product(name)
        if not mp:
            continue  # 非鹿茸商品（如手提袋）跳过
        sheet, product = mp
        qty = it.get("qty", 0)
        jobs.append((sheet, product, rtype, qty))
    return jobs


def process_record(rec, synced):
    rid = rec.get("id")
    if not rid:
        return 0, 0
    if rid in synced:
        return 0, 0

    jobs = collect_jobs(rec)
    if not jobs:
        # 没有可同步的鹿茸商品，也标记已处理，避免每次重新扫描
        synced[rid] = True
        return 0, 0

    rtype = "in" if rec.get("type") == "in" else "out"
    date = fmt_date(rec.get("time", ""))
    picker = rec.get("picker", "")
    purpose = rec.get("purpose", "") or ""
    dept = rec.get("dept", "") or ""
    entity = rec.get("entity", "") or ""
    if entity and "赛迪斯" in entity and purpose:
        purpose = "赛迪斯·" + purpose

    ok = 0
    fail = 0
    for (sheet, product, jtype, qty) in jobs:
        if not sheet or not product or not qty or qty <= 0:
            continue
        payload = {
            "Context": {
                "argv": {
                    "sheet_name": sheet,
                    "product": product,
                    "type": jtype,
                    "date": date,
                    "picker": picker,
                    "sender": "陈利冠",
                    "qty": qty,
                    "purpose": purpose,
                    "dept": dept,
                }
            }
        }
        try:
            body = post_to_wps(payload)
            log("✅ 同步成功 %s/%s/%s ×%s：%s" % (sheet, product, jtype, qty, body[:120]))
            ok += 1
        except Exception as e:
            log("❌ 同步失败 %s/%s/%s ×%s：%s" % (sheet, product, jtype, qty, e))
            fail += 1

    if ok > 0:
        synced[rid] = True
    # 若全部失败则不标记，下次可重试
    return ok, fail


def list_changed_paths():
    """从 FILES 环境变量解析本次变更的记录文件路径"""
    paths = []
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
        paths.append(path)
    return paths


def main():
    if not WEBHOOK:
        log("⚠️ 未配置 WEBHOOK(secrets.WPS_AIRSCRIPT_WEBHOOK)，跳过金山同步。")
        sys.exit(0)
    if not TOKEN:
        log("⚠️ 未配置 AIRSCRIPT_TOKEN(secrets.WPS_AIRSCRIPT_TOKEN)，跳过金山同步。")
        sys.exit(0)

    synced = load_synced()

    if BACKFILL:
        log(">>> 全量回填模式：扫描 data/records/ 全部文件")
        paths = sorted(
            os.path.join("data", "records", f)
            for f in os.listdir("data/records")
            if f.endswith(".json")
        )
    else:
        paths = list_changed_paths()
        if not paths:
            log("本次没有变更的记录文件。")
            # 仍回写标记（若本地有更新），但无需处理
            save_synced(synced)
            sys.exit(0)

    log("待处理文件数：%d" % len(paths))
    ok_total = 0
    fail_total = 0
    for path in paths:
        try:
            with open(path, "r", encoding="utf-8") as f:
                rec = json.load(f)
        except Exception as e:
            log("读取失败 %s: %s" % (path, e))
            fail_total += 1
            continue
        ok, fail = process_record(rec, synced)
        ok_total += ok
        fail_total += fail

    save_synced(synced)
    log("完成：成功 %d，失败 %d，已标记 %d 条" % (ok_total, fail_total, len(synced)))
    sys.exit(0 if fail_total == 0 else 1)


if __name__ == "__main__":
    main()
