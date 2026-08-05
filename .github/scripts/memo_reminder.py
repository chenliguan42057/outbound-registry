#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""定时推送钉钉提醒：在用户配置的提醒时间列出所有未完成的备忘录（不限当日）。

提醒时间可配置：优先读取 data/memos/config.json 的 reminderTime（"HH:MM"），
缺失/损坏时兜底 MEMO_DEFAULT_REMINDER_TIME（与前端 Config.MEMO_DEFAULT_REMINDER_TIME 对齐）。
workflow 每 5 分钟跑一次，仅当当前北京时间 HH:MM 与配置时间一致才推送，其余时段直接跳过。

读取环境变量：
  WEBHOOK : 钉钉群机器人 Webhook 地址
  SECRET  : 钉钉安全设置「加签」密钥

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
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=8))

WEBHOOK = os.environ.get("WEBHOOK", "").strip()
SECRET = os.environ.get("SECRET", "").strip()

# 提醒配置固定路径与默认提醒时间（默认与前端 Config.MEMO_DEFAULT_REMINDER_TIME 对齐）
MEMO_CONFIG_PATH = "data/memos/config.json"
MEMO_DEFAULT_REMINDER_TIME = "17:00"

_TIME_RE = re.compile(r"^\d{2}:\d{2}$")


def _valid_time(val):
    """是否合法的 HH:MM（00:00-23:59）。"""
    if not _TIME_RE.fullmatch(val):
        return False
    hh, mm = val.split(":")
    return 0 <= int(hh) <= 23 and 0 <= int(mm) <= 59


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


def is_reminder_time(now=None, reminder_time=None):
    """当前北京时间 HH:MM 是否等于配置的提醒时间。now 用于测试注入固定时间。"""
    now = now or datetime.now(CST)
    reminder_time = reminder_time or load_reminder_time()
    return now.strftime("%H:%M") == reminder_time


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


def run_check(now=None, memos_dir="data/memos", config_path=MEMO_CONFIG_PATH):
    """判断当前是否应发送提醒并组装消息。

    返回 (should_send, text)：
      should_send=False → 非配置提醒时间（含时间不匹配），text=None；
      should_send=True  → 是提醒时间，text 为 markdown（无未完成备忘录时 text=None，由调用方跳过）。
    now 用于测试注入固定北京时间；线上默认取当前北京时间。
    """
    now = now or datetime.now(CST)
    reminder_time = load_reminder_time(config_path)
    hhmm = now.strftime("%H:%M")
    if hhmm != reminder_time:
        print("当前 {} 非提醒时间 {}，跳过".format(hhmm, reminder_time))
        return False, None
    text = build_memo_reminder_markdown(memos_dir, now, reminder_time)
    return True, text


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
    should_send, text = run_check()
    if not should_send:
        return 0
    if not text:
        print("无未完成备忘录，跳过")
        return 0
    ok, err = send(text, title="出入库登记 · 待办备忘录")
    if ok:
        print("提醒发送成功")
        return 0
    print("提醒发送失败: {}".format(err), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
