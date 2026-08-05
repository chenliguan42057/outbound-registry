#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""定时推送钉钉提醒：在用户配置的提醒时间列出所有未完成的备忘录（不限当日）。

提醒时间可配置：优先读取 data/memos/config.json 的 reminderTime（"HH:MM"），
缺失/损坏时兜底 MEMO_DEFAULT_REMINDER_TIME（与前端 Config.MEMO_DEFAULT_REMINDER_TIME 对齐）。
workflow 每分钟跑一次，按「容忍延迟窗口」匹配：当前北京时间当日分钟数 now_min 与目标
target（h*60+m）满足 target <= now_min <= target + 3（cron 只能晚跑不能早跑，窗口只
容忍最多 3 分钟调度延迟、不提前推送；00:00 目标时前一晚 23:5x 为当日分钟 143x，天然
排除跨天误推）。

当日去重：config.json 的 lastSentAt（YYYY-MM-DD）== 今天则跳过；推送成功后用 GitHub
Contents API 写回 lastSentAt=今天，防止同一天重复推送。推送失败不写 lastSentAt，窗口内可重试。

FORCE=true（手动 workflow_dispatch）时跳过时间匹配与当日去重检查，直接推送（供手动测试/补推）。

读取环境变量：
  WEBHOOK : 钉钉群机器人 Webhook 地址
  SECRET  : 钉钉安全设置「加签」密钥
  GH_TOKEN: 仓库令牌（写回 config.json 的 lastSentAt）
  FORCE   : "true" 时强制推送

全部备忘录已完成 / 无备忘录时不发送任何消息（避免每日无意义打扰）。
"""
import base64
import glob
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=8))

WEBHOOK = os.environ.get("WEBHOOK", "").strip()
SECRET = os.environ.get("SECRET", "").strip()

# 提醒配置固定路径与默认提醒时间（默认与前端 Config.MEMO_DEFAULT_REMINDER_TIME 对齐）
GH_REPO = "chenliguan42057/outbound-registry"
GH_BRANCH = "main"
MEMO_CONFIG_PATH = "data/memos/config.json"
MEMO_DEFAULT_REMINDER_TIME = "17:00"

# 容忍延迟窗口（分钟）：命中条件 target <= now_min <= target + TOLERANCE_LATE。
# cron 只能晚跑不能早跑，窗口只容忍调度延迟、不提前推送；覆盖最多 3 分钟队列延迟。
# target=0（00:00）时前一晚 23:5x 为当日分钟 143x，远超 target+3=3，天然排除跨天误推。
TOLERANCE_LATE = 3

_TIME_RE = re.compile(r"^\d{2}:\d{2}$")


def _valid_time(val):
    """是否合法的 HH:MM（00:00-23:59）。"""
    if not _TIME_RE.fullmatch(val):
        return False
    hh, mm = val.split(":")
    return 0 <= int(hh) <= 23 and 0 <= int(mm) <= 59


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


def load_reminder_time(config_path=MEMO_CONFIG_PATH):
    """读取 data/memos/config.json 的 reminderTime（"HH:MM"）；缺失/损坏/非法返回默认值。"""
    data = load_json(config_path)
    if not isinstance(data, dict):
        return MEMO_DEFAULT_REMINDER_TIME
    val = str(data.get("reminderTime") or "").strip()
    if not _valid_time(val):
        print("WARN config {} reminderTime 非法（{}），使用默认 {}".format(
            config_path, val or "空", MEMO_DEFAULT_REMINDER_TIME))
        return MEMO_DEFAULT_REMINDER_TIME
    return val


def is_sent_today(config_path=MEMO_CONFIG_PATH, now=None):
    """当日去重：config.json 的 lastSentAt == 今天（YYYY-MM-DD）→ 已推送过。"""
    data = load_json(config_path)
    if not isinstance(data, dict):
        return False
    now = now or datetime.now(CST)
    return data.get("lastSentAt") == now.strftime("%Y-%m-%d")


def in_time_window(now=None, reminder_time=None):
    """容忍延迟窗口匹配：target <= now_min <= target + TOLERANCE_LATE。

    cron 只能晚跑不能早跑，窗口只容忍调度延迟、不提前推送（覆盖最多 3 分钟队列延迟）；
    target=0（00:00）时前一晚 23:5x 为当日分钟 143x，远超 target+3=3，天然排除跨天误推。
    now / reminder_time 用于测试注入。
    """
    now = now or datetime.now(CST)
    reminder_time = reminder_time or load_reminder_time()
    hh, mm = reminder_time.split(":")
    target = int(hh) * 60 + int(mm)
    now_min = now.hour * 60 + now.minute
    return target <= now_min <= target + TOLERANCE_LATE


def build_memo_reminder_markdown(memos_dir="data/memos", now=None, reminder_time=None):
    """扫描全部未完成备忘录（不限当日），组装提醒 markdown；全部已完成/无备忘录返回 None。

    now / reminder_time 仅用于测试注入；未完成判定只依赖 done 字段。
    """
    now = now or datetime.now(CST)
    reminder_time = reminder_time or load_reminder_time()
    pending = []
    for path in sorted(glob.glob(os.path.join(memos_dir, "*.json"))):
        if path.endswith("config.json"):
            continue  # 提醒配置不是备忘录，跳过
        data = load_json(path)
        if data is None:
            continue
        if data.get("done") is not True:
            pending.append(data)
    if not pending:
        return None
    lines = ["### ⏰ 出入库登记 · 待办备忘录提醒（{}）".format(reminder_time)]
    for m in pending:
        text = str(m.get("text") or "").strip() or "（无内容）"
        t = str(m.get("time", "")).replace("T", " ")
        lines.append("- 🟡 {}（添加时间：{}）".format(text, t))
    return "\n".join(lines)


def decide(now=None, memos_dir="data/memos", config_path=MEMO_CONFIG_PATH, force=False):
    """决策：当前是否应发送提醒并组装消息。

    返回 (should_send, text, skip_reason)：
      should_send=False → skip_reason 为 "time"（非容忍窗口）或 "dedup"（今日已推送）；
      should_send=True  → text 为 markdown（无未完成备忘录时 text=None，由调用方跳过）。
    force=True 跳过时间匹配与当日去重检查。now 用于测试注入固定北京时间。
    """
    now = now or datetime.now(CST)
    reminder_time = load_reminder_time(config_path)
    if not force:
        if not in_time_window(now, reminder_time):
            print("当前 {} 非提醒时间 {}（容忍窗口内），跳过".format(now.strftime("%H:%M"), reminder_time))
            return False, None, "time"
        if is_sent_today(config_path, now):
            print("今日已推送，跳过")
            return False, None, "dedup"
    text = build_memo_reminder_markdown(memos_dir, now, reminder_time)
    return True, text, None


def run_check(now=None, memos_dir="data/memos", config_path=MEMO_CONFIG_PATH):
    """兼容旧签名：(should_send, text)。now 用于测试注入固定北京时间。"""
    should_send, text, _ = decide(now=now, memos_dir=memos_dir, config_path=config_path)
    return should_send, text


def push_config_last_sent_at(last_sent_at, config_path=MEMO_CONFIG_PATH, token=None):
    """推送成功后写回云端 config.json 的 lastSentAt（GitHub Contents API PUT）。

    先 GET 最新文件（拿 sha 与最新 reminderTime，避免覆盖用户刚改的时间），
    合入 lastSentAt 后 PUT（message "update memo config lastSentAt"）。
    返回 (ok, errmsg)；无 token 或网络失败返回 False（不影响本次推送本身）。
    """
    token = (token if token is not None else os.environ.get("GH_TOKEN", "")).strip()
    if not token:
        print("WARN GH_TOKEN 为空，无法写回 lastSentAt（不影响本次推送）")
        return False, "GH_TOKEN 为空"
    url = "https://api.github.com/repos/{}/contents/{}".format(GH_REPO, config_path)
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
            print("WARN 读取云端 config 失败：{}".format(exc))
            return False, str(exc)
    except Exception as exc:
        print("WARN 读取云端 config 失败：{}".format(exc))
        return False, str(exc)
    if not isinstance(obj, dict):
        obj = {}
    obj["lastSentAt"] = last_sent_at
    content = base64.b64encode(
        json.dumps(obj, ensure_ascii=False).encode("utf-8")
    ).decode("utf-8")
    body = {"message": "update memo config lastSentAt", "content": content, "branch": GH_BRANCH}
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
        print("WARN 写回 lastSentAt 失败：{}".format(exc))
        return False, str(exc)


def send(text, title="出入库登记提醒"):
    """发送 markdown 消息到钉钉。返回 (ok, errmsg)。"""
    if not WEBHOOK:
        return False, "WEBHOOK 环境变量为空，无法发送（请检查 secrets.DINGTALK_WEBHOOK）"
    if not SECRET:
        return False, "SECRET 环境变量为空，无法加签（请检查 secrets.DINGTALK_SECRET）"

    url = sign_url(WEBHOOK, SECRET)
    payload = json.dumps(
        {"msgtype": "markdown", "markdown": {"title": title, "text": text}}
    ).encode("utf-8")
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
    should_send, text, _ = decide(now=now, force=force)
    if not should_send:
        return 0
    if not text:
        print("无未完成备忘录，跳过")
        return 0
    ok, err = send(text, title="出入库登记 · 待办备忘录")
    if not ok:
        print("提醒发送失败: {}".format(err), file=sys.stderr)
        return 1
    print("提醒发送成功")
    # 推送成功后写回当日 lastSentAt，防止同一天重复推送（force 补推同样写回）
    push_config_last_sent_at(now.strftime("%Y-%m-%d"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
