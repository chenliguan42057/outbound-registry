#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""定时推送钉钉提醒：每条备忘各自绑定提醒时间（remindAt），到点未完成推一次。

新逻辑（废弃全局 config.json 的 reminderAt/lastSentAt 机制）：
1. 读 data/memos/*.json（排除 config.json），逐条 memo 命中窗口才推送：
   - done !== true（未完成）
   - remindAt 存在、非空、格式合法（datetime.fromisoformat，naive 当作 CST 北京时间，统一转 aware）
   - reminded !== true（未推送过）
   - 窗口命中：target_dt = datetime.fromisoformat(remindAt).replace(tzinfo=CST)（aware），
     now_dt = datetime.now(CST).replace(second=0, microsecond=0)（aware，精确到分钟）；
     命中条件 target_dt <= now_dt <= target_dt + timedelta(minutes=TOLERANCE_LATE)（只容忍调度延迟，
     不提前推送；超过窗口即错过，单次不补推）。
2. 命中列表 → 组装 markdown：「### ⏰ 出入库登记 · 待办提醒」+ 逐条列出
   （- 🟡 内容（提醒时间：YYYY-MM-DD HH:MM））；全部无命中 → print 跳过 return 0。
3. 推送成功后对每条命中 memo 用 GitHub Contents API（GH_TOKEN env）PUT 更新该 memo 文件
   reminded: true（保留其它字段，GET 拿 sha）；无 GH_TOKEN 或写回失败仅 WARN，不阻塞本次推送。
4. FORCE=true（手动 workflow_dispatch）时跳过窗口与 reminded 检查，推送所有 done!==true
   且 remindAt 存在且 remindAt <= now（已到点）的 memo；推送成功同样写回 reminded: true。

读取环境变量：
  WEBHOOK : 钉钉群机器人 Webhook 地址
  SECRET  : 钉钉安全设置「加签」密钥
  GH_TOKEN: 仓库令牌（写回 memo 文件的 reminded:true）
  FORCE   : "true" 时强制推送（忽略窗口与 reminded，要求 remindAt 已到点）

全部备忘录已完成 / 无命中时不发送任何消息（避免无意义打扰）。
"""
import base64
import glob
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=8))

WEBHOOK = os.environ.get("WEBHOOK", "").strip()
SECRET = os.environ.get("SECRET", "").strip()

# 仓库与目录
GH_REPO = "chenliguan42057/outbound-registry"
GH_BRANCH = "main"
MEMOS_DIR = "data/memos"

# 容忍延迟窗口（分钟）：命中条件 target_dt <= now <= target_dt + TOLERANCE_LATE。
# cron 只能晚跑不能早跑，窗口只容忍调度延迟、不提前推送；超过窗口即错过，单次不补推。
# GitHub Actions schedule 实际最短间隔 5 分钟（官方下限，且可能延迟/跳过），
# 10 分钟窗口保证任意时刻到下一次运行（≤5 分钟）都在窗口内，配合 reminded 写回防重复。
TOLERANCE_LATE = 10


def _parse_remind_at(val):
    """解析 memo.remindAt（"YYYY-MM-DDTHH:MM"，naive 当作 CST 北京时间）。

    要求格式合法且精确到分钟（datetime-local step=60 输出不含秒/微秒）；
    缺失/损坏/非法 → 返回 None。
    返回带 tzinfo=CST 的 aware datetime，避免与 datetime.now(CST) 比较时
    抛出 "can't compare offset-naive and offset-aware datetimes"（上次 P0 教训）。
    """
    if not val:
        return None
    try:
        dt = datetime.fromisoformat(str(val).strip())
    except (TypeError, ValueError):
        return None
    if dt.second != 0 or dt.microsecond != 0:
        return None
    return dt.replace(tzinfo=CST)


def _env_bool(name):
    """环境变量是否布尔真（1/true/yes/on）。"""
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def sign_url(webhook, secret):
    """钉钉加签：timestamp + \n + secret 的 HMAC-SHA256，base64 后 URL 编码。"""
    timestamp = str(round(time.time() * 1000))
    string_to_sign = "{}\n{}".format(timestamp, secret)
    hmac_code = hmac.new(
        secret.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).digest()
    sign = urllib.parse.quote_plus(base64.b64encode(hmac_code))
    return webhook + "&timestamp=" + timestamp + "&sign=" + sign


def load_json(path):
    """读取 json 文件，失败返回 None（单条损坏跳过）。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as exc:
        print("SKIP {}: {}".format(path, exc))
        return None


def load_memos(memos_dir=MEMOS_DIR):
    """读取目录下全部备忘录 json（排除 config.json 提醒配置）；单条损坏跳过。"""
    result = []
    for path in sorted(glob.glob(os.path.join(memos_dir, "*.json"))):
        if path.endswith("config.json"):
            continue  # 提醒配置不是备忘录，跳过
        data = load_json(path)
        if data is None:
            continue
        result.append(data)
    return result


def collect_due(memos_list, now, force=False):
    """命中窗口的备忘录列表（待推送）。

    命中条件（非 force）：未完成、remindAt 合法、reminded != true、且
    target_dt <= now <= target_dt + TOLERANCE_LATE（now 精确到分钟，aware CST）。
    窗口只容忍延迟不提前；超过窗口即错过，单次不补推。
    force：忽略窗口与 reminded 检查，要求 remindAt 存在且 target_dt <= now（已到点）。
    now 为 aware CST（若测试注入 naive 自动挂 CST tzinfo）。
    """
    if now.tzinfo is None:
        now = now.replace(tzinfo=CST)
    now = now.replace(second=0, microsecond=0)
    due = []
    for m in memos_list or []:
        if m.get("done") is True:
            continue
        remind_at = str(m.get("remindAt") or "").strip()
        if not remind_at:
            continue
        target_dt = _parse_remind_at(remind_at)
        if target_dt is None:
            print("SKIP memo {} remindAt 非法（{}），跳过".format(m.get("id", "?"), remind_at))
            continue
        if force:
            if target_dt <= now:
                due.append(m)
            continue
        if m.get("reminded") is True:
            continue
        if target_dt <= now <= target_dt + timedelta(minutes=TOLERANCE_LATE):
            due.append(m)
    return due


def build_markdown(due_list):
    """命中列表 → 提醒 markdown；空列表返回 None（调用方跳过发送）。
    结构：标题 → 状态行 → 每条约单（序号 + 事项 + 提醒时间）。"""
    if not due_list:
        return None
    lines = ["### ⏰ 出入库登记 · 待办提醒"]
    lines.append("- 到点未完成事项共 **{}** 条，请尽快处理：".format(len(due_list)))
    for i, m in enumerate(due_list, 1):
        text = str(m.get("text") or "").strip() or "（无内容）"
        remind_at = str(m.get("remindAt") or "").replace("T", " ")
        lines.append("{}. **{}**　⏱ {}".format(i, text, remind_at))
    return "\n".join(lines)


def write_reminded(memo, token=None):
    """推送成功后写回云端该 memo 文件的 reminded:true（保留其它字段，GET 拿 sha）。

    先 GET 最新文件（拿 sha 与最新内容，避免覆盖用户刚改的其它字段），
    合入 reminded:true 后 PUT。返回 (ok, errmsg)；
    无 token / 云端 404 / 网络失败返回 False（不影响本次推送本身）。
    """
    token = (token if token is not None else os.environ.get("GH_TOKEN", "")).strip()
    memo_id = (memo or {}).get("id", "")
    if not memo_id:
        return False, "memo 无 id"
    if not token:
        print("WARN GH_TOKEN 为空，无法写回 reminded（不影响本次推送）")
        return False, "GH_TOKEN 为空"
    path = "data/memos/{}.json".format(memo_id)
    url = "https://api.github.com/repos/{}/contents/{}".format(GH_REPO, path)
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer {}".format(token),
        "X-GitHub-Api-Version": "2022-11-28",
    }
    # GET 最新内容
    obj = {}
    sha = None
    try:
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=15) as resp:
            remote = json.loads(resp.read().decode("utf-8"))
        obj = json.loads(base64.b64decode(remote.get("content", "")).decode("utf-8"))
        sha = remote.get("sha")
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            print("WARN 读取云端 memo {} 失败：{}".format(memo_id, exc))
            return False, str(exc)
        print("WARN 云端 memo {} 不存在，跳过写回".format(memo_id))
        return False, str(exc)
    except Exception as exc:
        print("WARN 读取云端 memo {} 失败：{}".format(memo_id, exc))
        return False, str(exc)
    if not isinstance(obj, dict):
        obj = {}
    obj["reminded"] = True
    content = base64.b64encode(
        json.dumps(obj, ensure_ascii=False).encode("utf-8")
    ).decode("utf-8")
    body = {
        "message": "mark memo {} reminded".format(memo_id),
        "content": content,
        "branch": GH_BRANCH,
    }
    if sha:
        body["sha"] = sha
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers=dict(headers, **{"Content-Type": "application/json"}),
            method="PUT",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        return True, ""
    except Exception as exc:
        print("WARN 写回 memo {} reminded 失败：{}".format(memo_id, exc))
        return False, str(exc)


def send(text, title="出入库登记提醒"):
    """发送 markdown 消息到钉钉。返回 (ok, errmsg)。"""
    if not WEBHOOK:
        return False, "WEBHOOK 环境变量为空，无法发送（请检查 secrets.DINGTALK_WEBHOOK）"
    if not SECRET:
        return False, "SECRET 环境变量为空，无法加签（请检查 secrets.DINGTALK_SECRET）"

    url = sign_url(WEBHOOK, SECRET)
    from ding_card import send_action_card, REG_URL
    return send_action_card(
        text, title, WEBHOOK, SECRET,
        btns=[
            {"title": "🌿 打开出库登记", "url": REG_URL},
            {"title": "📋 管理后台", "url": REG_URL + "#/app/out-records"}
        ],
        btn_orientation="0",
    )
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # 网络异常统一兜底
        return False, str(exc)

    if result.get("errcode") == 0:
        return True, ""
    return False, json.dumps(result, ensure_ascii=False)


def main():
    now = datetime.now(CST)
    force = _env_bool("FORCE")
    memos = load_memos()
    due = collect_due(memos, now, force=force)
    if not due:
        print("没有到点的待提醒备忘录，跳过")
        return 0
    text = build_markdown(due)
    if not text:
        print("无待提醒内容，跳过")
        return 0
    ok, err = send(text, title="出入库登记 · 待办提醒")
    if not ok:
        print("提醒发送失败: {}".format(err), file=sys.stderr)
        return 1
    print("提醒发送成功（{} 条）".format(len(due)))
    # 推送成功后对每条命中 memo 写回 reminded:true（无 GH_TOKEN 或失败仅 WARN 不阻塞）
    for m in due:
        write_reminded(m)
    return 0


if __name__ == "__main__":
    sys.exit(main())
