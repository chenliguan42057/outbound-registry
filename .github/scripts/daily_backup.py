# -*- coding: utf-8 -*-
"""
每日数据备份（3.4）

把 data/records、data/pickups、data/memos、data/deleted 四个目录下的所有 JSON
聚合成单个快照文件 data/backups/YYYY-MM-DD.json，并清理 30 天前的旧快照。

为什么放在 data/backups 而不是仓库根的 backups/：
deploy.yml 的 paths-ignore 已包含 'data/**'，放在 data/ 下不会触发整站重新部署，
避免每天白白跑一次 Pages 构建、也不会与业务提交抢 concurrency 组。

为什么聚合成单文件而不是原样复制目录：
1) 快照天然自带「那一刻的全量视图」，恢复时只需读一个文件；
2) 仓库不会因为每天复制 N 个小文件而膨胀出 N×30 个 blob 条目，
   Git Trees 增量拉取（前端同步用）的响应体也不会被撑大。

照片不备份：data/photos 下是 base64 转存的图片，体积远超文本数据，
每日快照会让仓库迅速膨胀；照片本身已在仓库里有独立历史，不需要二次冗余。
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
DATA_ROOT = (os.environ.get("DATA_PREFIX") or "data").strip()  # 双仓库数据前缀：默认 data（深圳）；赛迪斯 workflow 注入 data-saidis

# 业务时区（东八区），保证快照日期与用户认知的"今天"一致
TZ = timezone(timedelta(hours=8))
KEEP_DAYS = 30

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, "data")
BACKUP_DIR = os.path.join(DATA, "backups")

# 目录名 -> 快照里的键名
DIRS = {
    "records": "records",
    "pickups": "pickups",
    "memos": "memos",
    "deleted": "deleted",
}


def load_dir(name):
    """读取一个数据目录下的全部 JSON。单文件损坏不应中断整次备份——
    坏文件单独记录到 _corrupt，运维能一眼看出是哪个文件出了问题。"""
    path = os.path.join(DATA, name)
    items = []
    corrupt = []
    if not os.path.isdir(path):
        return items, corrupt
    for fn in sorted(os.listdir(path)):
        if not fn.endswith(".json"):
            continue
        fp = os.path.join(path, fn)
        try:
            with open(fp, "r", encoding="utf-8") as f:
                items.append(json.load(f))
        except Exception as e:
            corrupt.append({"file": name + "/" + fn, "error": str(e)})
    return items, corrupt


def main():
    now = datetime.now(TZ)
    stamp = now.strftime("%Y-%m-%d")

    snapshot = {
        "date": stamp,
        "generatedAt": now.isoformat(),
        "_corrupt": [],
    }
    total = 0
    for dirname, key in DIRS.items():
        items, corrupt = load_dir(dirname)
        snapshot[key] = items
        snapshot["_corrupt"].extend(corrupt)
        total += len(items)

    if total == 0 and not snapshot["_corrupt"]:
        print("[backup] 没有任何数据，跳过（不生成空快照，避免误导恢复者）")
        return 0

    os.makedirs(BACKUP_DIR, exist_ok=True)
    out = os.path.join(BACKUP_DIR, stamp + ".json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, separators=(",", ":"))
    print("[backup] 写入 %s（记录 %d 条，损坏 %d 个）" % (out, total, len(snapshot["_corrupt"])))

    # 清理过期快照
    cutoff = (now - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    removed = []
    for fn in sorted(os.listdir(BACKUP_DIR)):
        if not fn.endswith(".json"):
            continue
        if fn[:-5] < cutoff:
            os.remove(os.path.join(BACKUP_DIR, fn))
            removed.append(fn)
    if removed:
        print("[backup] 清理过期快照 %d 个：%s" % (len(removed), ", ".join(removed)))

    # 提交
    subprocess.run(["git", "config", "user.name", "github-actions[bot]"], cwd=ROOT, check=True)
    subprocess.run(
        ["git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
        cwd=ROOT, check=True
    )
    subprocess.run(["git", "add", DATA_ROOT + "/backups"], cwd=ROOT, check=True)
    diff = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT)
    if diff.returncode == 0:
        print("[backup] 内容无变化，无需提交")
        return 0
    subprocess.run(
        ["git", "commit", "-m", "chore(backup): 每日数据快照 " + stamp],
        cwd=ROOT, check=True
    )
    # 备份任务与业务写入可能撞车，失败时 rebase 重试一次即可
    push = subprocess.run(["git", "push"], cwd=ROOT)
    if push.returncode != 0:
        subprocess.run(["git", "pull", "--rebase"], cwd=ROOT, check=True)
        subprocess.run(["git", "push"], cwd=ROOT, check=True)
    print("[backup] 已提交并推送")
    return 0


if __name__ == "__main__":
    sys.exit(main())
