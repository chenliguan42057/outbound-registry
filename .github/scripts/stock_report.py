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

# 规格归组（与前端 Config.CATEGORY_MAP 一致）：同一系列的货品放一起展示
CATEGORY_MAP = {
    "冻干精华液": ["冻干精华液 20支装", "冻干精华液 5支装", "冻干精华液 单支装", "冻干精华液 30支装"],
    "面膜": ["面膜 5片装", "面膜 1片装"],
    "洁面": ["洁面慕斯 150ml", "洁面慕斯 50ml"],
    "精粹水": ["舒缓精粹水 120ml", "舒缓精粹水 30ml"],
    "精粹乳": ["赋活精粹乳 80ml", "赋活精粹乳 30ml", "赋活精粹乳 1ml"],
    "精粹霜": ["舒缓精粹霜 50g", "舒缓精粹霜 15g", "舒缓精粹霜 5g", "舒缓精粹霜 1g"],
    "礼盒": ["华大鹿茸凝时系列礼盒装"],
    "手提袋": ["小鹿牛皮纸袋（全系列护肤品手提袋）大", "小鹿牛皮纸袋（精华+面膜手提袋）小"],
}


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


def week_summary_markdown(records):
    """本周（周一 00:00 起，北京时间）出入库汇总 → markdown 表格 + emoji 进度条。

    只统计 affectsStock===true 的记录（与库存口径一致）；入库 +qty，出库 -qty。
    返回 (markdown_text, has_data)；本周无数据时 has_data=False。
    """
    from datetime import datetime as _dt, timedelta as _td
    now_bj = _dt.utcnow() + _td(hours=8)
    monday0 = (now_bj - _td(days=now_bj.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)

    def parse_t(t):
        s = str(t or "")
        for fmt in ("%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"):
            try:
                return _dt.strptime(s[:16], fmt)
            except ValueError:
                continue
        return None

    agg = {}   # name -> {"in": 0, "out": 0}
    for rec in records:
        if not rec.get("affectsStock"):
            continue
        t = parse_t(rec.get("time"))
        if t is None or t < monday0:
            continue
        kind = str(rec.get("type", "")).lower()
        is_in = kind == "in"
        for it in rec.get("items") or []:
            name = it.get("name")
            qty = it.get("qty")
            if not name or not isinstance(qty, (int, float)):
                continue
            row = agg.setdefault(name, {"in": 0, "out": 0})
            if is_in:
                row["in"] += int(qty)
            else:
                row["out"] += int(qty)

    if not agg:
        return "", False

    rows = []
    for name, row in agg.items():
        net = row["in"] - row["out"]
        rows.append((name, row["in"], row["out"], net))
    rows.sort(key=lambda x: abs(x[3]), reverse=True)
    top = rows[:10]
    max_abs = max((abs(net) for _, _, _, net in top), default=1) or 1

    lines = [
        "**📊 本周出入库汇总（{} 至今日）：**".format(monday0.strftime("%m-%d")),
        "",
        "| 货品 | 入库 | 出库 | 净变化 | 趋势 |",
        "| --- | ---: | ---: | ---: | --- |",
    ]
    for name, q_in, q_out, net in top:
        bar_len = max(1, round(abs(net) / max_abs * 10)) if net else 0
        bar = "▓" * bar_len + "░" * (10 - bar_len)
        arrow = "▲" if net > 0 else ("▼" if net < 0 else "—")
        lines.append("| {} | {} | {} | {}{} | {} {} |".format(
            name, q_in, q_out, "+" if net > 0 else "", net, arrow, bar))
    if len(rows) > 10:
        lines.append("")
        lines.append("_另有 {} 种货品明细省略_".format(len(rows) - 10))
    return "\n".join(lines), True


def build_report():
    inventory = extract_inventory()
    records = load_records()
    stock = compute_stock(inventory, records)

    total_items = len(stock)
    total_qty = sum(max(0, v) for v in stock.values())
    low = [(n, v) for n, v in sorted(stock.items(), key=lambda x: x[1]) if v < LOW_STOCK_THRESHOLD]

    lines = [
        "### 📊 出入库登记 · 库存周报",
        "- **生成时间**：{}（北京时间）".format(
            time.strftime("%Y-%m-%d %H:%M", time.localtime(time.time() + 8 * 3600))
        ),
        "- **货品种类**：{} 种 ｜ **库存总量**：{} 件".format(total_items, total_qty),
    ]

    # 本周出入库汇总（周一 0 点至今；表格 + 进度条）
    week_md, has_week = week_summary_markdown(records)
    if has_week:
        lines.append("")
        lines.append(week_md)

    # 按规格分组展示（同一系列放一起；未匹配兜底「其他」）
    lines.append("")
    lines.append("**📦 库存明细（按规格分组）：**")
    grouped = False
    for cat, specs in CATEGORY_MAP.items():
        rows = [(s, stock.get(s)) for s in specs if s in stock]
        if not rows:
            continue
        grouped = True
        lines.append("")
        lines.append("**▸ {}（{} 个规格）**".format(cat, len(rows)))
        for name, v in rows:
            mark = " 🔴" if v < LOW_STOCK_THRESHOLD else ""
            lines.append("- {}{}：**{}** 件".format(name, mark, v))
    # 兜底未匹配的货品
    known = set()
    for specs in CATEGORY_MAP.values():
        known.update(specs)
    others = [(n, v) for n, v in stock.items() if n not in known]
    if others:
        grouped = True
        lines.append("")
        lines.append("**▸ 其他（{} 个）**".format(len(others)))
        for name, v in sorted(others, key=lambda x: x[1], reverse=True):
            mark = " 🔴" if v < LOW_STOCK_THRESHOLD else ""
            lines.append("- {}{}：**{}** 件".format(name, mark, v))
    if not grouped:
        lines.append("")
        lines.append("- 暂无库存数据")

    # 低库存预警汇总
    if low:
        lines.append("")
        lines.append("**⚠️ 低库存预警（< {} 件）共 {} 种：**".format(LOW_STOCK_THRESHOLD, len(low)))
        for name, v in low:
            lines.append("- 🔴 {}：**{}** 件".format(name, v))
    else:
        lines.append("")
        lines.append("✅ 暂无低库存货品（阈值 {} 件）".format(LOW_STOCK_THRESHOLD))

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
