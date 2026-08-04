#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每周五 17:55 库存情况推送（钉钉群机器人）。

计算逻辑与前端一致：
  getStock(name) = INVENTORY[name] + Σ(affectsStock===true && type==='in' ? +qty : -qty)
  即：入库 +数量，出库/其他 -数量（仅 affectsStock=true 的记录参与，避免旧记录重复扣减）。

读取环境变量：
  WEBHOOK: 钉钉群机器人 Webhook 地址
  SECRET : 钉钉安全设置「加签」密钥
"""
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

WEBHOOK = os.environ.get("WEBHOOK", "").strip()
SECRET = os.environ.get("SECRET", "").strip()

LOW_STOCK_THRESHOLD = 95  # 与前端 Config.LOW_STOCK_THRESHOLD 一致
CONFIG_PATH = "src/js/core/config.js"
RECORDS_DIR = "data/records"


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


def extract_inventory():
    """从 src/js/core/config.js 提取 INVENTORY 对象（纯字符串键 + 数字值）。"""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            src = f.read()
    except OSError as exc:
        print("无法读取 {}: {}".format(CONFIG_PATH, exc))
        return {}
    m = re.search(r"INVENTORY\s*=\s*\{(.*?)\};", src, re.S)
    if not m:
        print("未找到 INVENTORY 定义")
        return {}
    inv = {}
    for k, v in re.findall(r'"([^"]+)"\s*:\s*(\d+)', m.group(1)):
        inv[k] = int(v)
    return inv


def load_records():
    """读取 data/records/ 下全部 json 记录。"""
    recs = []
    try:
        files = os.listdir(RECORDS_DIR)
    except OSError:
        return recs
    for fn in files:
        if not fn.endswith(".json"):
            continue
        path = os.path.join(RECORDS_DIR, fn)
        try:
            with open(path, "r", encoding="utf-8") as f:
                recs.append(json.load(f))
        except (OSError, ValueError):
            continue
    return recs


def compute_stock(inventory, records):
    """按前端逻辑计算每个货品当前库存。返回 {name: stock}。"""
    stock = dict(inventory)
    for rec in records:
        if not rec.get("affectsStock"):
            continue
        sign = 1 if str(rec.get("type", "")).lower() == "in" else -1
        for it in rec.get("items") or []:
            name = it.get("name")
            qty = it.get("qty")
            if name and isinstance(qty, (int, float)):
                stock[name] = stock.get(name, 0) + sign * int(qty)
    return stock


def build_report():
    inventory = extract_inventory()
    records = load_records()
    stock = compute_stock(inventory, records)

    total_items = len(stock)
    total_qty = sum(max(0, v) for v in stock.values())
    low = [(n, v) for n, v in sorted(stock.items(), key=lambda x: x[1]) if v < LOW_STOCK_THRESHOLD]
    top = sorted(stock.items(), key=lambda x: x[1], reverse=True)[:10]

    lines = [
        "### 📊 库存周报",
        "- **生成时间**：{}（北京时间）".format(
            time.strftime("%Y-%m-%d %H:%M", time.localtime(time.time() + 8 * 3600))
        ),
        "- **货品种类**：{} 种 ｜ **库存总量**：{} 件".format(total_items, total_qty),
    ]
    if low:
        lines.append("")
        lines.append("**⚠️ 低库存预警（< {} 件）共 {} 种：**".format(LOW_STOCK_THRESHOLD, len(low)))
        for name, v in low:
            lines.append("- 🔴 {}：**{}** 件".format(name, v))
    else:
        lines.append("")
        lines.append("✅ 暂无低库存货品（阈值 {} 件）".format(LOW_STOCK_THRESHOLD))

    lines.append("")
    lines.append("**📈 库存排行 TOP10：**")
    for i, (name, v) in enumerate(top, 1):
        lines.append("{}. {}：{} 件".format(i, name, v))

    lines.append("")
    lines.append("— 每周五自动推送 · 数据实时来自云端登记")
    return "\n".join(lines)


def send(text, title="库存周报"):
    if not WEBHOOK or not SECRET:
        print("WEBHOOK/SECRET 未配置", file=sys.stderr)
        return False
    url = sign_url(WEBHOOK, SECRET)
    payload = json.dumps(
        {"msgtype": "markdown", "markdown": {"title": title, "text": text}}
    ).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        print("发送异常: {}".format(exc), file=sys.stderr)
        return False
    if result.get("errcode") == 0:
        return True
    print("钉钉返回: {}".format(json.dumps(result, ensure_ascii=False)), file=sys.stderr)
    return False


def main():
    report = build_report()
    print("--- 生成报告（前 400 字）---")
    print(report[:400])
    if send(report):
        print("库存周报发送成功")
        return 0
    print("库存周报发送失败", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
