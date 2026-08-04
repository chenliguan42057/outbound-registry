#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每日 9:00 定时推送钉钉提醒：列出所有未完成的备忘录（不限当日）。

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
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=8))

WEBHOOK = os.environ.get("WEBHOOK", "").strip()
SECRET = os.environ.get("SECRET", "").strip()


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


def build_memo_reminder_markdown(memos_dir="data/memos", now=None):
    """扫描全部未完成备忘录（不限当日），组装提醒 markdown；全部已完成/无备忘录返回 None。

    now 仅用于测试注入固定时间（展示用途）；未完成判定只依赖 done 字段，不依赖 now。
    """
    now = now or datetime.now(CST)
    pending = []
    for path in sorted(glob.glob(os.path.join(memos_dir, "*.json"))):
        data = load_json(path)
        if data is None:
            continue
        if data.get("done") is not True:
            pending.append(data)
    if not pending:
        return None
    lines = ["### ⏰ 出入库登记 · 待办备忘录提醒（9:00）"]
    for m in pending:
        text = str(m.get("text") or "").strip() or "（无内容）"
        t = str(m.get("time", "")).replace("T", " ")
        lines.append("- 🟡 {}（添加时间：{}）".format(text, t))
    return "\n".join(lines)


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
    text = build_memo_reminder_markdown()
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
