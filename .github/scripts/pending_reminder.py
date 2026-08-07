#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每日定时推送钉钉提醒：列出当日登记但尚未手动确认的单据。

覆盖三类（当日登记 = 北京时间今天 0 点后登记）：
  1. 出库记录未提单   data/records/  下 type 非 "in" 且 status === "pending"
  2. 待取货未确认提单 data/pickups/  下 confirmed !== true
  3. 待取货未出库     data/pickups/  下 shipped !== true

读取环境变量：
  WEBHOOK : 钉钉群机器人 Webhook 地址
  SECRET  : 钉钉安全设置「加签」密钥

三类均无待处理项时不发送任何消息（避免每日无意义打扰）。

备注：消息标题不再写死「17:00」，改为显示脚本实际运行时刻（北京时间），
避免「标题时间与真实送达时间不一致」造成误解。实际发送时间受 GitHub
Actions schedule 队列影响，可能晚于 cron 设定时间（8/7 曾延迟约 2.5h）。
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
    """扫描当日未处理单据，组装提醒 markdown；三类均空时返回 None。

    now 仅用于测试注入固定北京时间；线上默认取当前北京时间。
    """
    now = now or datetime.now(CST)
    start_ms = int(datetime(now.year, now.month, now.day, tzinfo=CST).timestamp() * 1000)
    end_ms = start_ms + 86400000
    today_str = now.strftime("%Y-%m-%d")

    def is_today(rec):
        """当日判定：优先 _ts（毫秒时间戳）；无 _ts 的旧记录按 time 日期兜底。"""
        ts = rec.get("_ts")
        if isinstance(ts, (int, float)) and ts > 0:
            return start_ms <= ts < end_ms
        t = str(rec.get("time", ""))[:10]
        return t == today_str

    pending_out = []
    for rec in load_dir(os.path.join(records_dir, "*.json")):
        if not is_today(rec):
            continue
        if str(rec.get("type", "")).lower() != "in" and rec.get("status", "submitted") == "pending" \
                and rec.get("borrowed") is not True:  # 已转入先借后还的借出单不参与未提单提醒
            pending_out.append(rec)

    unconfirmed = []
    unshipped = []
    for p in load_dir(os.path.join(pickups_dir, "*.json")):
        if not is_today(p):
            continue
        if p.get("confirmed") is not True:
            unconfirmed.append(p)
        if p.get("shipped") is not True:
            unshipped.append(p)

    def fmt_time(rec):
        return str(rec.get("time", "")).replace("T", " ")

    parts = []
    if pending_out:
        lines = ["#### ⏳ 出库记录未提单（{} 条）".format(len(pending_out))]
        for r in pending_out:
            lines.append("- 领取人：{}｜货品：{}｜登记时间：{}".format(
                r.get("picker", ""), goods_text(r), fmt_time(r)))
        parts.append("\n".join(lines))
    if unconfirmed:
        lines = ["#### 🧾 待取货未确认提单（{} 条）".format(len(unconfirmed))]
        for p in unconfirmed:
            lines.append("- 取货人：{}｜货品：{}｜登记时间：{}".format(
                p.get("picker", ""), goods_text(p), fmt_time(p)))
        parts.append("\n".join(lines))
    if unshipped:
        lines = ["#### 📦 待取货未出库（{} 条）".format(len(unshipped))]
        for p in unshipped:
            lines.append("- 取货人：{}｜货品：{}｜登记时间：{}".format(
                p.get("picker", ""), goods_text(p), fmt_time(p)))
        parts.append("\n".join(lines))

    if not parts:
        return None
    now_str = now.strftime("%Y-%m-%d %H:%M")
    header = "### 📌 出入库登记 · 今日待处理提醒（实际推送 {} 北京）".format(now_str)
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
