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
import time
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


def wps_result(body):
    """金山 webhook 返回体 -> 脚本 return 的那个对象。

    实际结构是 {"data": {"result": {...}}}；解析不出来就返回 {}，
    调用方只把它当「锦上添花的回执信息」，拿不到不影响主流程。
    """
    try:
        j = json.loads(body)
    except Exception:
        return {}
    d = j.get("data") if isinstance(j, dict) else None
    if isinstance(d, dict) and isinstance(d.get("result"), dict):
        return d["result"]
    return d if isinstance(d, dict) else {}


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def collect_jobs(rec):
    """返回 {sheet_name: [(product, qty), ...]} —— 同一订单按子表分组。

    目的：把「一个订单的多商品」聚到对应子表，便于在金山里「一个订单一行」
    （同一子表内的多个商品填在同一行的不同列）。
    """
    by_sheet = {}
    lurong = rec.get("lurong")
    items = rec.get("items") or []

    if lurong:
        # 旧 lurong.html 路径：单商品
        sheet = lurong.get("sheet_name", "")
        product = lurong.get("product", "")
        qty = rec.get("qty") or (items[0].get("qty", 0) if items else 0)
        if sheet and product:
            by_sheet.setdefault(sheet, []).append((product, qty))
        return by_sheet

    for it in items:
        name = it.get("name", "")
        mp = map_product(name)
        if not mp:
            continue  # 非鹿茸商品（如手提袋）跳过
        sheet, product = mp
        qty = it.get("qty", 0)
        by_sheet.setdefault(sheet, []).append((product, qty))
    return by_sheet


def process_record(rec, synced):
    rid = rec.get("id")
    if not rid:
        return 0, 0
    if rid in synced:
        return 0, 0

    by_sheet = collect_jobs(rec)
    if not by_sheet:
        # 没有可同步的鹿茸商品（例如只领了手提袋），也要标记，
        # 一来避免每小时兜底扫描反复重算，二来前端据此显示「本单不入台账」而不是一直转圈。
        synced[rid] = {"skip": 1, "at": now_iso()}
        return 0, 0

    rtype = "in" if rec.get("type") == "in" else "out"
    date = fmt_date(rec.get("time", ""))
    picker = rec.get("picker", "")
    purpose = rec.get("purpose", "") or ""
    dept = rec.get("dept", "") or ""
    entity = rec.get("entity", "") or ""
    if entity and "赛迪斯" in entity and purpose and not purpose.startswith("赛迪斯·"):
        # 用途本身已含「赛迪斯」开头时先归一化，避免变成「赛迪斯·赛迪斯项目」重复前缀
        p = purpose
        if p.startswith("赛迪斯"):
            p = p[len("赛迪斯"):]
        p = p.lstrip("·").strip()
        purpose = ("赛迪斯·" + p) if p else purpose

    ok = 0
    fail = 0
    rows = {}       # 回执：{子表名: 落在第几行} —— 前端拿它显示「✅已入金山台账（xx表 第60行）」
    errs = []
    # 每个子表 = 一次 webhook 调用（带该子表的全部商品）；订单碰到的每个子表各写「一行」
    for sheet, itemlist in by_sheet.items():
        # 过滤无效项（无名称 / 数量<=0）
        valid = [(p, q) for (p, q) in itemlist if p and q and q > 0]
        if not valid:
            continue
        payload = {
            "Context": {
                "argv": {
                    "mode": "append_order",   # 金山脚本：多商品合并追加一行
                    "sheet_name": sheet,
                    "type": rtype,
                    "date": date,
                    "picker": picker,
                    "sender": "陈利冠",
                    "purpose": purpose,
                    "dept": dept,
                    "rid": rid,               # 写进金山「记录ID」列，供将来删除时精确定位
                    "items": [{"product": p, "qty": q} for (p, q) in valid],
                }
            }
        }
        try:
            body = post_to_wps(payload)
            res = wps_result(body)
            if res.get("ok") is False:
                # webhook 通了但脚本内部报错（例如找不到商品列）——必须算失败，否则会漏行
                raise RuntimeError(res.get("error") or "金山脚本返回 ok:false")
            if res.get("row"):
                rows[sheet] = res["row"]
            log("✅ 同步成功 %s/订单一行 ×%d 商品 -> 第%s行：%s"
                % (sheet, len(valid), res.get("row", "?"), body[:120]))
            ok += 1
        except Exception as e:
            log("❌ 同步失败 %s/订单(共%d商品)：%s" % (sheet, len(valid), e))
            errs.append("%s: %s" % (sheet, e))
            fail += 1

    # 标记整个订单为已同步（保证幂等、不重复写）。
    # 说明：单子表订单=一次调用全有或全无，完全准确；
    # 跨子表订单若某子表调用失败，已成功的子表行不补写（与旧逻辑一致，优先避免重复行）。
    fails = synced.setdefault("__fail__", {})
    if ok > 0:
        st = {"ok": ok, "fail": fail, "at": now_iso()}
        if rows:
            st["rows"] = rows
        if errs:
            st["err"] = errs[:3]
        synced[rid] = st
        fails.pop(rid, None)      # 之前失败过、这次成功了，清掉失败回执
    elif fail > 0:
        # 全军覆没：不写正式标记（否则每小时兜底就不再重试了），
        # 只在 __fail__ 里留个失败回执，让前端能立刻显示「⚠️金山写入失败」而不是干等超时。
        fails[rid] = {"fail": fail, "at": now_iso(), "err": errs[:3]}
    return ok, fail


def process_tombstone(tomb, synced):
    """处理一条删除墓碑 data/deleted/<id>.json —— 把金山里对应那一行也删掉。

    幂等：删过的 id 记在 __del__ 里，每小时兜底扫描不会重复删。
    安全：
      - 只删「确实同步进过金山」的记录（synced 里有正式标记的），没进过的直接标删完；
      - __clear-all__ 这种「清空全部」的汇总墓碑一律跳过，绝不批量删台账；
      - 金山侧按「记录ID」列精确定位，找不到就返回 notFound（视为已删，不算失败）。
    """
    rid = tomb.get("id")
    if not rid or rid.startswith("__"):
        return 0, 0, 1                       # __clear-all__ 等汇总墓碑：跳过
    dels = synced.setdefault("__del__", {})
    if rid in dels:
        return 0, 0, 0

    st = synced.get(rid)
    if not st or (isinstance(st, dict) and st.get("skip")):
        # 压根没写进金山（未同步 / 无鹿茸商品）→ 无行可删，直接记账收工
        dels[rid] = {"ok": 0, "note": "never_in_wps", "at": now_iso()}
        log("⏭️ %s 未进过金山台账，无需删行" % rid)
        return 0, 0, 1

    rec = tomb.get("rec") or {}
    sheets = list((collect_jobs(rec) or {}).keys())
    if not sheets:
        # 墓碑里没带记录快照（老墓碑）→ 兜底：两张子表都试一遍，靠 rid 精确定位，不会误伤
        sheets = ["2026鹿茸水乳系列", "2026时空鹿茸库存"]
        log("⚠️ %s 墓碑无记录快照，改为两张子表各试一次（按记录ID精确定位，安全）" % rid)

    ok = 0
    fail = 0
    detail = {}
    for sheet in sheets:
        payload = {"Context": {"argv": {
            "mode": "delete_order", "sheet_name": sheet, "rid": rid}}}
        try:
            body = post_to_wps(payload)
            res = wps_result(body)
            if res.get("ok") is False:
                raise RuntimeError(res.get("error") or "金山脚本返回 ok:false")
            if res.get("notFound"):
                log("· %s 未找到 rid=%s 的行（可能已删）" % (sheet, rid))
                detail[sheet] = "notFound"
            else:
                log("🗑️ 已删 %s 第%s行 (rid=%s)，重算下游库存 %s 格"
                    % (sheet, res.get("deletedRows"), rid, res.get("recalced", 0)))
                detail[sheet] = {"rows": res.get("deletedRows"), "recalced": res.get("recalced", 0)}
            ok += 1
        except Exception as e:
            log("❌ 删除失败 %s rid=%s：%s" % (sheet, rid, e))
            detail[sheet] = "error: %s" % e
            fail += 1

    if fail == 0:
        dels[rid] = {"ok": ok, "at": now_iso(), "detail": detail}
    return ok, fail, 0


def list_changed_paths():
    """从 FILES 环境变量解析本次变更的文件路径。

    返回 (记录新增/修改, 删除墓碑新增)：
      - data/records/*.json  状态 A/M  → 追加行
      - data/deleted/*.json  状态 A/M  → 删除行
    """
    recs = []
    toms = []
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
        if not path.endswith(".json"):
            continue
        if path.startswith("data/records/"):
            recs.append(path)
        elif path.startswith("data/deleted/"):
            toms.append(path)
    return recs, toms


def main():
    if not WEBHOOK:
        log("⚠️ 未配置 WEBHOOK(secrets.WPS_AIRSCRIPT_WEBHOOK)，跳过金山同步。")
        sys.exit(0)
    if not TOKEN:
        log("⚠️ 未配置 AIRSCRIPT_TOKEN(secrets.WPS_AIRSCRIPT_TOKEN)，跳过金山同步。")
        sys.exit(0)

    synced = load_synced()

    def scan_dir(d):
        if not os.path.isdir(d):
            return []
        return sorted(os.path.join(d, f) for f in os.listdir(d) if f.endswith(".json"))

    if BACKFILL:
        log(">>> 全量回填模式：扫描 data/records/ 与 data/deleted/ 全部文件")
        paths = scan_dir(os.path.join("data", "records"))
        tomb_paths = scan_dir(os.path.join("data", "deleted"))
    else:
        paths, tomb_paths = list_changed_paths()
        if not paths and not tomb_paths:
            log("本次没有变更的记录/墓碑文件。")
            # 仍回写标记（若本地有更新），但无需处理
            save_synced(synced)
            sys.exit(0)

    log("待处理：记录 %d 个，删除墓碑 %d 个" % (len(paths), len(tomb_paths)))
    ok_total = 0
    fail_total = 0
    skip_total = 0
    # 隔离区：记录「解析失败」的文件路径。作用：
    #  1) 单个坏文件不再让整次同步变红（不影响其它记录照常入库金山）；
    #  2) 避免每小时 schedule 反复重试同一个坏文件、反复把 run 标成 failure。
    bad_files = synced.get("__bad__") if isinstance(synced.get("__bad__"), dict) else {}

    for path in paths:
        try:
            with open(path, "r", encoding="utf-8") as f:
                rec = json.load(f)
        except Exception as e:
            if path in bad_files:
                log("⏭️ 跳过已知无法解析的文件（已隔离，不影响其它记录）: %s" % path)
            else:
                log("⚠️ 跳过无法解析的记录（已隔离，不影响其它记录同步）: %s: %s" % (path, e))
                bad_files[path] = True
            skip_total += 1
            continue
        # 解析成功：若之前被隔离过，移出隔离区，恢复正常处理
        if path in bad_files:
            del bad_files[path]
        ok, fail = process_record(rec, synced)
        ok_total += ok
        fail_total += fail

    # ---- 第二段：处理删除墓碑（放在追加之后，保证「同一次 push 里先建后删」顺序正确）----
    del_ok = 0
    del_fail = 0
    del_skip = 0
    for tpath in tomb_paths:
        try:
            with open(tpath, "r", encoding="utf-8") as f:
                tomb = json.load(f)
        except Exception as e:
            log("⚠️ 跳过无法解析的墓碑：%s: %s" % (tpath, e))
            del_skip += 1
            continue
        o, fl, sk = process_tombstone(tomb, synced)
        del_ok += o
        del_fail += fl
        del_skip += sk
    if tomb_paths:
        log("删除同步：成功 %d，失败 %d，跳过 %d" % (del_ok, del_fail, del_skip))
    fail_total += del_fail

    synced["__bad__"] = bad_files
    save_synced(synced)
    marked = len([k for k in synced if not str(k).startswith("__")])
    log("完成：追加成功 %d，失败 %d，隔离坏文件 %d，已标记 %d 条" % (ok_total, fail_total, skip_total, marked))
    # 只有「金山 webhook 真正报错」才算失败；个别坏文件已被隔离，不再拖累整条链路
    sys.exit(0 if fail_total == 0 else 1)


if __name__ == "__main__":
    main()
