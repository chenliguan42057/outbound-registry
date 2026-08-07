#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""订单提醒推送：读取 data/notify/*.json（勾选订单紧凑摘要），拼装消息推送钉钉群机器人。

由 GitHub Actions「DingTalk Remind」在 data/notify/*.json 变更时触发。
消息标题/正文均含关键词「出入库登记」，满足钉钉自定义机器人安全设置（防 errcode 310000）。

支持两种载荷（按 data.type 区分）：
  remind          : 勾选订单提醒（orders 数组，紧凑摘要）
  pickup-confirm  : 待取货「确认提单」对比消息（pickup 对象，含登记时间与提单时间）

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


def goods_lines_of(order):
    """货品明细每行一项（缩进 4 空格），避免钉钉对超长单行强制换行堆在一起。"""
    items = order.get("items") or []
    if not items:
        return "    （无明细）"
    return "\n".join(
        "    - {n} × {q}".format(n=it.get("name", ""), q=it.get("qty", ""))
        for it in items
        if it.get("name")
    ) or "    （无明细）"


def status_text_of(order):
    return "未提单" if order.get("status") == "pending" else "已提单"


def photos_lines(o):
    """订单照片 markdown（最多 3 张，缩进与续行一致）；无则空串。"""
    return "".join(
        "\n   ![照片{}]({})".format(j, u)
        for j, u in enumerate((o.get("photoUrls") or [])[:3], 1)
    )


def build_order_lines(payload):
    """把提醒请求中的订单摘要转成 markdown 行列表；无效订单跳过。货品明细逐项分行。"""
    lines = []
    for i, o in enumerate(payload.get("orders") or [], 1):
        if not isinstance(o, dict) or not o.get("id"):
            continue
        goods_lines = goods_lines_of(o)
        t = str(o.get("time") or "").strip() or "-"
        kind = str(o.get("type") or "").lower()
        if kind == "in":
            lines.append(
                "- **#{} 入库**　{}\n  用途/来源：{}\n{}\n{}".format(
                    i, t, o.get("purpose", "") or "-", goods_lines, photos_lines(o)
                )
            )
            continue
        head = "- **#{} 出库**　{}　领取人：{}　部门/客户：{}".format(
            i, t, o.get("picker", "") or "-", o.get("dept", "") or "-"
        )
        body = "  用途：{}　状态：{}\n{}".format(
            o.get("purpose", "") or "-", status_text_of(o), goods_lines
        )
        entity = str(o.get("entity") or "").strip()
        if entity:
            body += "\n  结算法人单位：{}".format(entity)
        note = str(o.get("note") or "").strip()
        if note:
            body += "\n  备注：{}".format(note)
        body += ("\n" if body else "") + photos_lines(o)
        lines.append(head + "\n" + body)
    return lines


def build_pickup_confirm_markdown(payload):
    """「确认提单」对比消息：登记时间 vs 提单时间 + 间隔。返回 markdown 文本。"""
    p = payload.get("pickup") or {}
    if not p.get("id"):
        return None
    goods_lines = goods_lines_of(p)
    reg = str(p.get("time") or "").strip().replace("T", " ") or "-"
    conf = str(p.get("confirmedAt") or "").strip().replace("T", " ")[:16] or "-"
    gap = ""
    # 计算间隔（登记→提单）
    try:
        from datetime import datetime as _dt
        t0 = _dt.fromisoformat((p.get("time") or "").replace("Z", "+00:00"))
        t1 = _dt.fromisoformat((p.get("confirmedAt") or "").replace("Z", "+00:00"))
        # 统一为北京时间
        t0 = t0.astimezone()
        t1 = t1.astimezone()
        if t1 > t0:
            secs = int((t1 - t0).total_seconds())
            h, m = divmod(secs // 60, 60)
            gap = " ｜间隔：{}".format("{} 小时 {} 分钟".format(h, m) if h else "{} 分钟".format(m))
    except Exception:
        gap = ""
    lines = [
        "### ✅ 出入库登记 · 提单确认",
        "",
        "- **取货人：** {}".format(p.get("picker", "") or "-"),
        "- **登记时间：** {}".format(reg),
        "- **提单时间：** {}".format(conf + gap),
        "",
        "**货品明细**：",
        goods_lines,
    ]
    dept = str(p.get("dept") or "").strip()
    if dept:
        lines.insert(4, "- **部门/客户：** {}".format(dept))
    return "\n".join(lines)


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

    pickup_confirm = []
    for line in (FILES or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        path = parts[-1].strip() if len(parts) > 1 else ""
        if not path or not path.startswith("data/notify/") or not path.endswith(".json"):
            continue
        data = load_json(path)
        if data and data.get("type") == "pickup-confirm":
            pickup_confirm.append(data)

    if not payloads and not pickup_confirm:
        print("没有可解析的提醒请求，跳过发送（不报错）")
        return 0

    # 1) 订单提醒
    blocks = []
    total = 0
    for p in payloads:
        lines = build_order_lines(p)
        total += len(lines)
        blocks.extend(lines)
    if blocks:
        text = "### 🔔 出入库登记 · 订单提醒（共 {} 条）\n\n{}".format(total, "\n".join(blocks))
        ok, err = send(text, title="出入库登记 · 订单提醒")
        if not ok:
            print("订单提醒发送失败: {}".format(err), file=sys.stderr)
            return 1

    # 2) 提单确认对比
    for pc in pickup_confirm:
        text = build_pickup_confirm_markdown(pc)
        if not text:
            continue
        ok, err = send(text, title="出入库登记 · 提单确认")
        if ok:
            print("提单确认对比已发送")
        else:
            print("提单确认发送失败: {}".format(err), file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
