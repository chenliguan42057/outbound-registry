#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每日定时推送钉钉提醒：列出所有尚未处理完成的单据（不限登记日期）。

覆盖五类（全部历史，不限当日登记，避免跨天未处理项被漏提醒）：
  1. 出库记录未提单   data/records/  下 type 非 "in" 且 status === "pending"（不含借还差额单）
  2. 借还差额未提单   data/records/  下 type === "out" 且 status === "pending" 且带 fromBorrowId
  3. 待取货未确认提单 data/pickups/  下 confirmed !== true
  4. 待取货未出库     data/pickups/  下 shipped !== true
  5. 借出未归还       data/records/  下 borrowed === true 且 borrowDone !== true

读取环境变量：
  WEBHOOK : 钉钉群机器人 Webhook 地址
  SECRET  : 钉钉安全设置「加签」密钥

所有类目均无待处理项时不发送任何消息（避免每日无意义打扰）。

备注：
- 消息标题不再写死「17:00」，改为显示脚本实际运行时刻（北京时间），
  避免「标题时间与真实送达时间不一致」造成误解。实际发送时间受 GitHub
  Actions schedule 队列影响，可能晚于 cron 设定时间（8/7 曾延迟约 2.5h）。
- 2026-08-07 起按用户要求：所有未完成项都要提醒（不再限定"当日登记"）。
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


def goods_text(rec):
    """货品明细文本：name×qty 逗号连接；无货品时显示（无明细）。"""
    items = rec.get("items") or []
    return ", ".join(
        "{}×{}".format(it.get("name", ""), it.get("qty", ""))
        for it in items
        if it.get("name")
    ) or "（无明细）"


def load_dir(pattern):
    """读取某目录下全部 json 文件，返回记录列表（损坏文件跳过）。"""
    items = []
    for path in sorted(glob.glob(pattern)):
        data = load_json(path)
        if data is None:
            continue
        items.append(data)
    return items


def build_reminder_markdown(records_dir="data/records", pickups_dir="data/pickups", now=None):
    """扫描所有未处理完成的单据，组装提醒 markdown；五类均空时返回 None。

    now 仅用于测试注入固定北京时间；线上默认取当前北京时间。
    2026-08-07 起不再限定「当日登记」：所有未完成项（含历史跨天）都要提醒。
    """
    now = now or datetime.now(CST)

    pending_out = []          # 普通出库待提单（不含借还差额单）
    borrow_diff = []          # 借还差额未提单（fromBorrowId 且 pending）
    borrowed_open = []        # 借出未归还（borrowed 且未结清）
    unconfirmed = []
    unshipped = []

    for rec in load_dir(os.path.join(records_dir, "*.json")):
        kind = str(rec.get("type", "")).lower()
        status = str(rec.get("status", "submitted"))
        if rec.get("borrowed") is True and rec.get("borrowDone") is not True:
            borrowed_open.append(rec)                       # 5. 借出未归还
            continue
        if kind != "in" and status == "pending":
            if rec.get("fromBorrowId"):
                borrow_diff.append(rec)                     # 2. 借还差额未提单
            else:
                pending_out.append(rec)                     # 1. 普通出库未提单

    for p in load_dir(os.path.join(pickups_dir, "*.json")):
        if p.get("confirmed") is not True:
            unconfirmed.append(p)                           # 3. 待取货未确认提单
        if p.get("shipped") is not True:
            unshipped.append(p)                             # 4. 待取货未出库

    def fmt_time(rec):
        return str(rec.get("time", "")).replace("T", " ")

    # 每类最多展示条数，超出折叠提示，避免长消息刷屏
    MAX_SHOW = 15

    def lines_of(title, items, label):
        lines = ["**{}（{} 条）**".format(title, len(items))]
        for i, it in enumerate(items[:MAX_SHOW], 1):
            goods = goods_text(it)
            lines.append("{}. **{}**｜货品：{}｜📅 {}".format(
                i, it.get("picker", "") or "-", goods, fmt_time(it)))
        if len(items) > MAX_SHOW:
            lines.append("⋯ 其余 {} 条已省略".format(len(items) - MAX_SHOW))
        return lines

    parts = []
    if pending_out:
        parts.append("\n".join(lines_of("⏳ 出库记录未提单", pending_out, "领取人")))
    if borrow_diff:
        parts.append("\n".join(lines_of("🔄 借还差额未提单", borrow_diff, "领取人")))
    if unconfirmed:
        parts.append("\n".join(lines_of("🧾 待取货未确认提单", unconfirmed, "取货人")))
    if unshipped:
        parts.append("\n".join(lines_of("📦 待取货未出库", unshipped, "取货人")))
    if borrowed_open:
        parts.append("\n".join(lines_of("📤 借出未归还", borrowed_open, "借出人")))

    if not parts:
        return None
    now_str = now.strftime("%Y-%m-%d %H:%M")
    header = "### 📌 出入库登记 · 待处理提醒\n⏱ 实际推送：{}（北京时间）".format(now_str)
    return header + "\n\n" + "\n\n".join(parts)


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
    text = build_reminder_markdown()
    if not text:
        print("今日无待处理项，跳过")
        return 0
    ok, err = send(text, title="出入库登记提醒")
    if ok:
        print("提醒发送成功")
        return 0
    print("提醒发送失败: {}".format(err), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
