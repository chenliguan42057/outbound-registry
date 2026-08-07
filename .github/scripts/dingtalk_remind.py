#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""订单提醒推送：读取 data/notify/*.json（勾选订单紧凑摘要），拼装消息推送钉钉群机器人。

由 GitHub Actions「DingTalk Remind」在 data/notify/*.json 变更时触发。
消息标题/正文均含关键词「出入库登记」，满足钉钉自定义机器人安全设置（防 errcode 310000）。

读取环境变量：
  WEBHOOK  : 钉钉群机器人 Webhook 地址
  SECRET   : 钉钉安全设置「加签」密钥
  FILES    : 换行分隔的变更列表，每行形如 "A\tpath"（新增）/ "M\tpath"（修改）
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
    """读取 json 文件，失败返回 None。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as exc:
        print("SKIP {}: {}".format(path, exc))
        return None


def send(text, title="出入库登记通知"):
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


def goods_of(order):
    items = order.get("items") or []
    return ", ".join(
        "{n}×{q}".format(n=it.get("name", ""), q=it.get("qty", ""))
        for it in items
        if it.get("name")
    ) or "（无明细）"


def status_text_of(order):
    return "未提单" if order.get("status") == "pending" else "已提单"


def build_order_lines(payload):
    """把提醒请求中的订单摘要转成 markdown 行列表；无效订单跳过。"""
    lines = []
    for i, o in enumerate(payload.get("orders") or [], 1):
        if not isinstance(o, dict) or not o.get("id"):
            continue
        goods = goods_of(o)
        t = str(o.get("time") or "").strip() or "-"
        kind = str(o.get("type") or "").lower()
        if kind == "in":
            lines.append(
                "- **#{} 入库**　{}\n  用途/来源：{}　货品：{}".format(
                    i, t, o.get("purpose", "") or "-", goods
                )
            )
            continue
        head = "- **#{} 出库**　{}　领取人：{}　部门/客户：{}".format(
            i, t, o.get("picker", "") or "-", o.get("dept", "") or "-"
        )
        body = "  用途：{}　货品：{}　状态：{}".format(
            o.get("purpose", "") or "-", goods, status_text_of(o)
        )
        entity = str(o.get("entity") or "").strip()
        if entity:
            body += "　结算法人单位：{}".format(entity)
        note = str(o.get("note") or "").strip()
        if note:
            body += "　备注：{}".format(note)
        lines.append(head + "\n" + body)
    return lines


def main():
    payloads = []
    for line in (FILES or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        path = parts[-1].strip() if len(parts) > 1 else ""
        if not path or not path.startswith("data/notify/") or not path.endswith(".json"):
            continue
        data = load_json(path)
        if data and data.get("type") == "remind" and data.get("orders"):
            payloads.append(data)

    if not payloads:
        print("没有可解析的提醒请求，跳过发送（不报错）")
        return 0

    blocks = []
    total = 0
    for p in payloads:
        lines = build_order_lines(p)
        total += len(lines)
        blocks.extend(lines)

    if not blocks:
        print("提醒请求中没有有效订单，跳过发送")
        return 0

    text = "### 🔔 出入库登记 · 订单提醒（共 {} 条）\n\n{}".format(total, "\n".join(blocks))
    ok, err = send(text, title="出入库登记 · 订单提醒")
    if ok:
        print("提醒已发送 {} 条订单".format(total))
        return 0
    print("发送失败: {}".format(err), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
