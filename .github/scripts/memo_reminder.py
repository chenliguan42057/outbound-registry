#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""定时推送钉钉提醒：在用户配置的「特定日期 + 时间」推一次未完成备忘录提醒（单次，推送后失效）。

提醒配置读取 data/memos/config.json 的 reminderAt（"YYYY-MM-DDTHH:MM"，北京时间本地表示，
datetime-local 原生格式，naive 当作 CST 北京时间）。不存在/为空 → 跳过（未设置，需用户重新设置）。
reminderAt 解析失败 → WARN 日志 + 跳过（不报错也不推，让用户重新设置）。

workflow 每分钟跑一次，按「容忍延迟窗口」匹配：当前北京时间 now（去秒/微秒精确到分钟）满足
target_dt <= now <= target_dt + 3 分钟 → 命中。窗口只容忍最多 3 分钟调度延迟、不提前推送；
一旦超过 3 分钟窗口，本次单次提醒即视为错过，不会在之后补推（单次语义，不循环）。

单次去重：config.json 的 lastSentAt == reminderAt（字符串相等）→ 已推送过，跳过。
推送成功后用 GitHub Contents API 写回 lastSentAt=reminderAt（保留 reminderAt 不动）；
无 GH_TOKEN 或写回失败仅 WARN 不阻塞本次推送。

FORCE=true（手动 workflow_dispatch）时跳过时间匹配与去重检查，直接推送（供手动测试/补推），
推送成功同样写回 lastSentAt=reminderAt。

旧字段 reminderTime（每日重复模式）已废弃：忽略，仅看 reminderAt；旧 config 仅含
reminderTime + lastSentAt 而无 reminderAt 时视为新 schema 缺失 reminderAt，跳过等待重新设置。

读取环境变量：
  WEBHOOK : 钉钉群机器人 Webhook 地址
  SECRET  : 钉钉安全设置「加签」密钥
  GH_TOKEN: 仓库令牌（写回 config.json 的 lastSentAt）
  FORCE   : "true" 时强制推送

全部备忘录已完成 / 无备忘录时不发送任何消息（避免无意义打扰）。
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

# 提醒配置固定路径
GH_REPO = "chenliguan42057/outbound-registry"
GH_BRANCH = "main"
MEMO_CONFIG_PATH = "data/memos/config.json"

# 容忍延迟窗口（分钟）：命中条件 target_dt <= now <= target_dt + TOLERANCE_LATE。
# cron 只能晚跑不能早跑，窗口只容忍调度延迟、不提前推送；超过窗口即错过，单次不补推。
TOLERANCE_LATE = 3

# 星期中文（Python datetime.weekday(): 0=周一 … 6=周日）
WEEKDAY_CN = ["一", "二", "三", "四", "五", "六", "日"]


def _parse_reminder_at(val):
    """解析 reminderAt（"YYYY-MM-DDTHH:MM"，naive 当作 CST 北京时间）。

    要求格式合法且精确到分钟（datetime-local step=60 输出不含秒/微秒）；
    缺失/损坏/非法 → 返回 None。
    返回带 tzinfo=CST 的 aware datetime，避免与 datetime.now(CST) 比较时
    抛出 "can't compare offset-naive and offset-aware datetimes"。
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


def load_reminder_at(config_path=MEMO_CONFIG_PATH):
    """读取 data/memos/config.json 的 reminderAt（"YYYY-MM-DDTHH:MM"）。

    不存在/为空 → 返回 None（未设置，跳过）；格式非法 → WARN 日志 + 返回 None（跳过）。
    """
    data = load_json(config_path)
    if not isinstance(data, dict):
        return None
    val = str(data.get("reminderAt") or "").strip()
    if not val:
        print("WARN config {} 未设置 reminderAt，跳过（单次提醒需重新设置）".format(config_path))
        return None
    if _parse_reminder_at(val) is None:
        print("WARN config {} reminderAt 非法（{}），跳过（单次提醒需重新设置）".format(config_path, val))
        return None
    return val


def is_already_sent(config_path=MEMO_CONFIG_PATH, reminder_at=None):
    """单次去重：config.json 的 lastSentAt == reminderAt → 已推送过。"""
    data = load_json(config_path)
    if not isinstance(data, dict):
        return False
    return data.get("lastSentAt") == reminder_at


def in_reminder_window(now, reminder_at):
    """容忍延迟窗口匹配：target_dt <= now <= target_dt + TOLERANCE_LATE（分钟级）。

    now 为当前北京时间（调用方已去秒/微秒精确到分钟）。超过窗口即错过，单次不补推；
    target 在未来（now < target_dt）也不会提前推送。解析失败返回 False。
    now 若为 naive（测试注入场景）自动挂上 CST tzinfo，与 aware 的 target_dt 保持一致比较。
    """
    if now.tzinfo is None:
        now = now.replace(tzinfo=CST)
    target_dt = _parse_reminder_at(reminder_at)
    if target_dt is None:
        return False
    return target_dt <= now <= target_dt + timedelta(minutes=TOLERANCE_LATE)


def build_memo_reminder_markdown(memos_dir="data/memos", now=None, reminder_at=None):
    """扫描全部未完成备忘录（不限当日），组装提醒 markdown；全部已完成/无备忘录返回 None。

    now / reminder_at 仅用于测试注入；未完成判定只依赖 done 字段。
    """
    now = now or datetime.now(CST)
    if reminder_at is None:
        reminder_at = load_reminder_at()
    target_dt = _parse_reminder_at(reminder_at)
    if target_dt is None:
        return None
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
    # 标题/日志中显示「提醒时间：YYYY-MM-DD HH:mm (周X)」便于排查
    label = "{} (周{})".format(target_dt.strftime("%Y-%m-%d %H:%M"), WEEKDAY_CN[target_dt.weekday()])
    lines = ["### ⏰ 出入库登记 · 待办备忘录提醒（提醒时间：{}）".format(label)]
    for m in pending:
        text = str(m.get("text") or "").strip() or "（无内容）"
        t = str(m.get("time", "")).replace("T", " ")
        lines.append("- 🟡 {}（添加时间：{}）".format(text, t))
    return "\n".join(lines)


def decide(now=None, memos_dir="data/memos", config_path=MEMO_CONFIG_PATH, force=False):
    """决策：当前是否应发送提醒并组装消息。

    返回 (should_send, text, skip_reason)：
      should_send=False → skip_reason 为 "unset"（未设置/非法）、"time"（非容忍窗口）或
                          "dedup"（本次已推送）；
      should_send=True  → text 为 markdown（无未完成备忘录时 text=None，由调用方跳过）。
    force=True 跳过时间匹配与单次去重检查。now 用于测试注入固定北京时间。
    """
    now = now or datetime.now(CST)
    now = now.replace(second=0, microsecond=0)  # 精确到分钟，与 target 分钟级比较
    reminder_at = load_reminder_at(config_path)
    if reminder_at is None:
        return False, None, "unset"
    if not force:
        if not in_reminder_window(now, reminder_at):
            target_dt = _parse_reminder_at(reminder_at)
            print("当前 {} 非提醒时间 {}（窗口 {}~{}，单次仅一次），跳过".format(
                now.strftime("%Y-%m-%d %H:%M"),
                target_dt.strftime("%Y-%m-%d %H:%M"),
                target_dt.strftime("%Y-%m-%d %H:%M"),
                (target_dt + timedelta(minutes=TOLERANCE_LATE)).strftime("%Y-%m-%d %H:%M"),
            ))
            return False, None, "time"
        if is_already_sent(config_path, reminder_at):
            print("本次提醒已推送过（lastSentAt == reminderAt），跳过")
            return False, None, "dedup"
    text = build_memo_reminder_markdown(memos_dir, now, reminder_at)
    return True, text, None


def run_check(now=None, memos_dir="data/memos", config_path=MEMO_CONFIG_PATH):
    """兼容旧签名：(should_send, text)。now 用于测试注入固定北京时间。"""
    should_send, text, _ = decide(now=now, memos_dir=memos_dir, config_path=config_path)
    return should_send, text


def push_config_last_sent_at(last_sent_at, config_path=MEMO_CONFIG_PATH, token=None):
    """推送成功后写回云端 config.json 的 lastSentAt（GitHub Contents API PUT）。

    先 GET 最新文件（拿 sha 与最新 reminderAt，避免覆盖用户刚改的时间），
    合入 lastSentAt 后 PUT（保留 reminderAt 不动；message "update memo config lastSentAt"）。
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
    # 单次提醒：推送成功后写回 lastSentAt=reminderAt（保留 reminderAt 不动，防重复推送）
    reminder_at = load_reminder_at()
    if reminder_at:
        push_config_last_sent_at(reminder_at)
    return 0


if __name__ == "__main__":
    sys.exit(main())
