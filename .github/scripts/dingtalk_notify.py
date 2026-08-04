#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GitHub Actions 提交登记后自动推送钉钉群机器人消息。

读取环境变量：
  WEBHOOK: 钉钉群机器人 Webhook 地址
  SECRET : 钉钉安全设置「加签」密钥
  FILES  : 换行分隔的 data/records/*.json 路径；为空时发送测试消息
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.parse
import urllib.request

WEBHOOK = os.environ.get("WEBHOOK", "").strip()
SECRET = os.environ.get("SECRET", "").strip()
FILES = os.environ.get("FILES", "").strip()

TEST_TEXT = "✅ 钉钉通知测试：仓库通知已连通"


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


def build_markdown(path):
    """解析单个记录 json，返回钉钉 markdown 文本。解析失败返回 None（跳过不中断）。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as exc:
        print("SKIP {}: {}".format(path, exc))
        return None

    items = data.get("items") or []
    goods = ", ".join(
        "{name}×{qty}".format(name=it.get("name", ""), qty=it.get("qty", ""))
        for it in items
        if it.get("name")
    ) or "（无明细）"

    if str(data.get("type", "")).lower() == "in":
        lines = [
            "### 📥 新入库登记",
            "- **货品**：{}".format(goods),
            "- **时间**：{}".format(data.get("time", "")),
        ]
    else:
        status = data.get("status", "submitted")
        status_text = "未提单" if status == "pending" else "已提单"
        lines = [
            "### 📦 新出库登记",
            "- **领取人**：{}".format(data.get("picker", "")),
            "- **部门/客户**：{}".format(data.get("dept", "")),
            "- **用途**：{}".format(data.get("purpose", "")),
            "- **货品**：{}".format(goods),
            "- **时间**：{}".format(data.get("time", "")),
            "- **状态**：{}".format(status_text),
        ]
    return "\n".join(lines)


def send(text, title="新登记通知"):
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
    if not FILES:
        ok, err = send(TEST_TEXT, title="钉钉通知测试")
        if ok:
            print("测试消息发送成功")
            return 0
        print("测试消息发送失败: {}".format(err), file=sys.stderr)
        return 1

    records = []
    for path in FILES.splitlines():
        path = path.strip()
        if not path:
            continue
        md = build_markdown(path)
        if md:
            records.append(md)

    if not records:
        print("没有可解析的变更记录，跳过发送（不报错）")
        return 0

    if len(records) == 1:
        text = records[0]
    else:
        text = "### 🔔 新登记通知（共 {} 条）\n\n{}".format(
            len(records), "\n\n---\n\n".join(records)
        )

    ok, err = send(text)
    if ok:
        print("已发送 {} 条记录通知".format(len(records)))
        return 0
    print("发送失败: {}".format(err), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
