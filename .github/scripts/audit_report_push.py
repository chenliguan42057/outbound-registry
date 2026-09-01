#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""推送系统排查报告到钉钉群。读取 data/reports/system_audit_*.md 推送。"""
import hashlib
import hmac
import os
import sys
import time
import urllib.parse
import urllib.request

WEBHOOK = os.environ.get("WEBHOOK", "").strip()
SECRET = os.environ.get("SECRET", "").strip()
REPORT = "data/reports/system_audit_2026-09-01.md"


def sign_url(webhook, secret):
    timestamp = str(round(time.time() * 1000))
    string_to_sign = "{}\n{}".format(timestamp, secret)
    hmac_code = hmac.new(secret.encode("utf-8"), string_to_sign.encode("utf-8"),
                         digestmod=hashlib.sha256).digest()
    sign = urllib.parse.quote_plus(__import__("base64").b64encode(hmac_code))
    return webhook + "&timestamp=" + timestamp + "&sign=" + sign


def main():
    if not WEBHOOK or not SECRET:
        print("WEBHOOK/SECRET 未配置", file=sys.stderr)
        return 1
    try:
        with open(REPORT, encoding="utf-8") as f:
            text = f.read().strip()
    except OSError as e:
        print("读取报告失败: {}".format(e), file=sys.stderr)
        return 1
    url = sign_url(WEBHOOK, SECRET)
    payload = {"msgtype": "markdown",
               "markdown": {"title": "系统排查报告", "text": text}}
    req = urllib.request.Request(url, data=__import__("json").dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = __import__("json").loads(resp.read().decode("utf-8"))
        if result.get("errcode") == 0:
            print("报告推送成功")
            return 0
        print("钉钉返回: {}".format(result), file=sys.stderr)
        return 1
    except Exception as e:
        print("发送异常: {}".format(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
