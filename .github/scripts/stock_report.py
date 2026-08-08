#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每周五 17:55 库存情况推送（钉钉群机器人）。

周报包含：
  1. 本周出入库汇总图（matplotlib 横向分组条形图：蓝=入库、橙=出库）—— PNG 上传到
     data/reports/stock_week_<日期>.png（每日新文件名避免 CDN 缓存），markdown 引用图 URL。
  2. 库存明细（按规格分组文字）+ 低库存预警（文字）。

计算逻辑与前端一致：
  getStock(name) = INVENTORY[name] + Σ(affectsStock===true && type==='in' ? +qty : -qty)
  即：入库 +数量，出库/其他 -数量（仅 affectsStock=true 的记录参与，避免旧记录重复扣减）。

读取环境变量：
  WEBHOOK   : 钉钉群机器人 Webhook 地址
  SECRET    : 钉钉安全设置「加签」密钥
  GH_TOKEN  : 仓库令牌（上传周报图片到 data/reports/）
"""
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

WEBHOOK = os.environ.get("WEBHOOK", "").strip()
SECRET = os.environ.get("SECRET", "").strip()
GH_TOKEN = os.environ.get("GH_TOKEN", "").strip()

LOW_STOCK_THRESHOLD = 95  # 与前端 Config.LOW_STOCK_THRESHOLD 一致
CONFIG_PATH = "src/js/core/config.js"
RECORDS_DIR = "data/records"
REPORTS_DIR = "data/reports"
GH_REPO = "chenliguan42057/outbound-registry"
GH_BRANCH = "main"

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


def week_summary(records):
    """本周（周一 00:00 起，北京时间）出入库聚合数据。

    只统计 affectsStock===true 的记录（与库存口径一致）；入库 +qty，出库 -qty。
    返回 (rows, monday_str, has_data)；rows = [(name, in_qty, out_qty, net), ...] 按净变化绝对值降序。
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
        return [], monday0.strftime("%Y-%m-%d"), False

    rows = []
    for name, row in agg.items():
        net = row["in"] - row["out"]
        rows.append((name, row["in"], row["out"], net))
    rows.sort(key=lambda x: abs(x[3]), reverse=True)
    return rows, monday0.strftime("%Y-%m-%d"), True


def _setup_cjk_font():
    """配置 matplotlib 中文字体（找不到时返回 False，中文可能显示为方块但不报错）。"""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.font_manager as fm
    import matplotlib.pyplot as plt
    candidates = ["Noto Sans CJK SC", "WenQuanYi Zen Hei", "Microsoft YaHei", "SimHei", "SimSun"]
    try:
        avail = {f.name for f in fm.fontManager.ttflist}
    except Exception:
        avail = set()
    chosen = next((f for f in candidates if f in avail), None)
    if chosen:
        plt.rcParams["font.sans-serif"] = [chosen]
        plt.rcParams["axes.unicode_minus"] = False
        return True
    return False


def generate_week_chart(rows, monday_str, out_path):
    """生成本周出入库汇总横向分组条形图（蓝=入库、橙=出库），保存到 out_path。

    rows 由 week_summary() 提供，取 Top 10。返回 True/False。
    """
    try:
        _setup_cjk_font()
        import matplotlib.pyplot as plt

        top = rows[:10]
        names = [r[0] for r in top][::-1]
        ins = [r[1] for r in top][::-1]
        outs = [r[2] for r in top][::-1]

        fig, ax = plt.subplots(figsize=(10, 7))
        y = range(len(names))
        bar_h = 0.38
        ax.barh([i + bar_h / 2 for i in y], ins, height=bar_h, color="#2f80ed", label="入库")
        ax.barh([i - bar_h / 2 for i in y], outs, height=bar_h, color="#f2994a", label="出库")

        # 数据标签
        for rect, v in zip(ax.patches[:len(names)], ins):
            if v:
                ax.text(rect.get_width() + 3, rect.get_y() + rect.get_height() / 2, str(v),
                        va="center", fontsize=9, color="#2f80ed")
        for rect, v in zip(ax.patches[len(names):], outs):
            if v:
                ax.text(rect.get_width() + 3, rect.get_y() + rect.get_height() / 2, str(v),
                        va="center", fontsize=9, color="#f2994a")

        ax.set_yticks(list(y))
        ax.set_yticklabels(names, fontsize=10)
        ax.set_xlabel("数量（件）")
        ax.set_title("本周出入库汇总（{} 起）".format(monday_str[5:]), fontsize=14, fontweight="bold")
        ax.legend(loc="lower right")
        ax.grid(axis="x", alpha=0.3)
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        plt.tight_layout()
        plt.savefig(out_path, dpi=150)
        plt.close()
        return True
    except Exception as exc:
        print("生成图表失败: {}".format(exc), file=sys.stderr)
        return False


def upload_chart(out_path):
    """把周报图上传到 data/reports/stock_week_<date>.png，返回公网 URL；失败返回 None。

    每日新文件名避免 CDN 缓存旧图。返回 jsdelivr CDN URL（与照片一致）。
    """
    if not GH_TOKEN:
        print("GH_TOKEN 为空，跳过周报图上传", file=sys.stderr)
        return None
    if not os.path.exists(out_path):
        return None
    fname = os.path.basename(out_path)
    path = "{}/{}".format(REPORTS_DIR, fname)
    url = "https://api.github.com/repos/{}/contents/{}".format(GH_REPO, path)
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer {}".format(GH_TOKEN),
        "X-GitHub-Api-Version": "2022-11-28",
    }
    # 读取现有 sha（存在则覆盖）
    sha = None
    try:
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=15) as resp:
            remote = json.loads(resp.read().decode("utf-8"))
        sha = remote.get("sha")
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            print("WARN 查询周报图 {} 失败：{}".format(path, exc), file=sys.stderr)
    except Exception as exc:
        print("WARN 查询周报图失败：{}".format(exc), file=sys.stderr)

    with open(out_path, "rb") as f:
        content = base64.b64encode(f.read()).decode("utf-8")
    body = {
        "message": "weekly chart {}".format(fname),
        "content": content,
        "branch": GH_BRANCH,
    }
    if sha:
        body["sha"] = sha
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers=dict(headers, **{"Content-Type": "application/json"}),
            method="PUT",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
        return "https://cdn.jsdelivr.net/gh/{}@{}/{}/{}".format(GH_REPO, GH_BRANCH, REPORTS_DIR, fname)
    except Exception as exc:
        print("WARN 上传周报图 {} 失败：{}".format(path, exc), file=sys.stderr)
        return None


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

    # 本周出入库汇总图（图 1：横向分组条形图）
    rows, monday_str, has_week = week_summary(records)
    if has_week:
        fname = "stock_week_{}.png".format(time.strftime("%Y%m%d", time.localtime(time.time() + 8 * 3600)))
        out_path = os.path.join("/tmp", fname)
        if generate_week_chart(rows, monday_str, out_path):
            chart_url = upload_chart(out_path)
            if chart_url:
                lines.append("")
                lines.append("**📊 本周出入库汇总（{} 起）：**".format(monday_str[5:]))
                lines.append("![本周出入库汇总]({})".format(chart_url))
            else:
                # 上传失败降级为文字表格
                lines.append("")
                lines.append(week_summary_fallback(rows, monday_str))

    # 按规格分组展示（同一系列放一起；未匹配兜底「其他」）—— 表格 + 状态色点
    lines.append("")
    lines.append("**📦 库存明细（{} 种）：**".format(total_items))
    grouped = False

    def status_emoji(v):
        """库存状态：< 阈值 红低库存；< 2×阈值 黄偏紧；否则 绿充足。"""
        if v < LOW_STOCK_THRESHOLD:
            return "🔴 低库存"
        if v < LOW_STOCK_THRESHOLD * 2:
            return "🟡 偏紧"
        return "🟢 充足"

    for cat, specs in CATEGORY_MAP.items():
        srows = [(s, stock.get(s)) for s in specs if s in stock]
        if not srows:
            continue
        grouped = True
        lines.append("")
        lines.append("**▸ {}（{}）**".format(cat, len(srows)))
        lines.append("| 货品 | 库存 | 状态 |")
        lines.append("| --- | ---: | --- |")
        for name, v in srows:
            lines.append("| {} | **{}** 件 | {} |".format(name, v, status_emoji(v)))
    # 兜底未匹配的货品
    known = set()
    for specs in CATEGORY_MAP.values():
        known.update(specs)
    others = [(n, v) for n, v in stock.items() if n not in known]
    if others:
        grouped = True
        lines.append("")
        lines.append("**▸ 其他（{}）**".format(len(others)))
        lines.append("| 货品 | 库存 | 状态 |")
        lines.append("| --- | ---: | --- |")
        for name, v in sorted(others, key=lambda x: x[1], reverse=True):
            lines.append("| {} | **{}** 件 | {} |".format(name, v, status_emoji(v)))
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


def week_summary_fallback(rows, monday_str):
    """上传失败时的降级文字表格（原样保留，避免丢数据）。"""
    top = rows[:10]
    lines = [
        "**📊 本周出入库汇总（{} 至今日）：**".format(monday_str[5:]),
        "| 货品 | 入库 | 出库 | 净变化 |",
        "| --- | ---: | ---: | ---: |",
    ]
    for name, q_in, q_out, net in top:
        lines.append("| {} | {} | {} | {}{} |".format(name, q_in, q_out, "+" if net > 0 else "", net))
    if len(rows) > 10:
        lines.append("")
        lines.append("_另有 {} 种货品明细省略_".format(len(rows) - 10))
    return "\n".join(lines)


def send(text, title="库存周报"):
    if not WEBHOOK or not SECRET:
        print("WEBHOOK/SECRET 未配置", file=sys.stderr)
        return False
    url = sign_url(WEBHOOK, SECRET)
    from ding_card import send_action_card, REG_URL
    return send_action_card(
        text, title, WEBHOOK, SECRET,
        btns=[{"title": "🌿 打开出库登记", "url": REG_URL}],
        btn_orientation="0",
    )
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
