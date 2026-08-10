#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GitHub Actions 提交登记后自动推送钉钉群机器人消息。

读取环境变量：
  WEBHOOK  : 钉钉群机器人 Webhook 地址
  SECRET   : 钉钉安全设置「加签」密钥
  FILES    : 换行分隔的变更列表，每行形如 "A\tpath"（新增）或 "M\tpath"（修改）
  GITHUB_SHA: 触发本次运行的提交 SHA（用于对比修改前后 status，识别提单动作）
无 FILES 时发送测试消息。
"""
import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

WEBHOOK = os.environ.get("WEBHOOK", "").strip()
SECRET = os.environ.get("SECRET", "").strip()
FILES = os.environ.get("FILES", "").strip()
GITHUB_SHA = os.environ.get("GITHUB_SHA", "").strip()

# 北京时间（UTC+8）：GitHub Actions runner 默认 UTC，钉钉消息时间必须显式用 CST
CST = timezone(timedelta(hours=8))

TEST_TEXT = "✅ 出入库登记通知测试：仓库通知已连通"


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


def git_show_old(path):
    """读取指定文件在上一提交（父提交）中的内容；文件不存在返回 None（新增）。"""
    if not GITHUB_SHA:
        return None
    try:
        out = subprocess.run(
            ["git", "show", "{}^:{}".format(GITHUB_SHA, path)],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if out.returncode != 0:
            return None
        return json.loads(out.stdout)
    except Exception:
        return None


def goods_of(data):
    items = data.get("items") or []
    return ", ".join(
        "{name}×{qty}".format(name=it.get("name", ""), qty=it.get("qty", ""))
        for it in items
        if it.get("name")
    ) or "（无明细）"


def goods_lines_of(data):
    """货品明细每行一项：\"  - 名称 × 数量\"，便于在钉钉群里对齐查看。"""
    items = data.get("items") or []
    if not items:
        return "  （无明细）"
    return "\n".join(
        "  - {n} × {q}".format(n=it.get("name", ""), q=it.get("qty", ""))
        for it in items
        if it.get("name")
    )


# 低库存阈值（与前端 Config.LOW_STOCK_THRESHOLD 一致）
LOW_STOCK_THRESHOLD = 95


def stock_snapshot_lines(data):
    """出库后库存快照：遍历 items[].stock（该笔出库后的库存），每项一行；无快照字段返回空串。"""
    items = data.get("items") or []
    lines = []
    for it in items:
        name = it.get("name", "")
        stock = it.get("stock")
        if name and isinstance(stock, (int, float)):
            lines.append("  - {} → **{}** 件".format(name, int(stock)))
    return "\n".join(lines)


def post_stock_lines(data):
    """出库后库存预警：取 items[].stock（该笔出库后的库存快照），低于阈值的货品输出红色预警行。

    数据由前端写回（out.js 出库时记录每项出库后库存），无该字段则跳过。
    返回字符串（多行，无预警时为空串）。
    """
    items = data.get("items") or []
    warns = []
    for it in items:
        name = it.get("name", "")
        stock = it.get("stock")
        if not name or not isinstance(stock, (int, float)):
            continue
        if stock < LOW_STOCK_THRESHOLD:
            warns.append("- 🔴 **{}** 出库后仅剩 **{}** 件（低于 {} 件）".format(
                name, int(stock), LOW_STOCK_THRESHOLD))
    return "\n".join(warns)


def status_text_of(data):
    status = data.get("status", "submitted")
    return "未提单" if status == "pending" else "已提单"


def photos_markdown(data):
    """记录 photoUrls → markdown 图片（最多 3 张防消息过大）；无则返回空串。"""
    urls = (data or {}).get("photoUrls") or []
    lines = []
    for i, u in enumerate(urls[:3], 1):
        lines.append("![照片{}]({})".format(i, u))
    return "\n".join(lines)


def note_line(data):
    """备注行（出库记录 note 字段，非必填）；为空时返回空串，避免输出空行。"""
    note = str((data or {}).get("note") or "").strip()
    return "\n- **备注**：{}".format(note) if note else ""


def entity_line(data):
    """结算法人单位行（出库记录 entity 字段，非必填）；为空时返回空串，避免输出空行。

    返回带行尾换行（便于直接拼接到「部门/客户」行之后）；仅 entity 非空时输出。
    """
    entity = str((data or {}).get("entity") or "").strip()
    return "- **结算法人单位**：{}\n".format(entity) if entity else ""


def _layout_record(title, fields, data, status_label=None):
    """统一布局：标题 → 照片（顶部）→ 字段（每行一项）→ 货品明细（每行一项）→ 出库后库存 → 预警 → 备注。

    fields: [(k, v), ...] 顺序即展示顺序。
    status_label: 标题里附加的状态角标（"未提单"/"已提单" 等），可空。
    """
    photos = photos_markdown(data)
    md = title
    if status_label:
        md += "（{}）".format(status_label)
    if photos:
        md += "\n" + photos
    if fields:
        md += "\n" + "\n".join("- **{k}**：{v}".format(k=k, v=v) for k, v in fields)
    md += "\n\n**货品明细**：\n" + goods_lines_of(data)
    note = str((data or {}).get("note") or "").strip()
    if note:
        md += "\n- **备注**：{}".format(note)
    return md


def build_new_markdown(data):
    """新增记录：新登记通知。结构：标题 → 照片 → 字段 → 货品明细（每行）→ 备注。"""
    kind = str(data.get("type", "")).lower()
    if kind == "in":
        title = "### 📥 出入库登记 · 新入库登记"
        fields = [
            ("时间", data.get("time", "") or "-"),
            ("用途/来源", data.get("purpose", "") or "-")
        ]
        return _layout_record(title, fields, data)
    # 出库
    title = "### 📦 出入库登记 · 新出库登记"
    fields = [
        ("领取人", data.get("picker", "") or "-"),
        ("部门/客户", data.get("dept", "") or "-")
    ]
    entity = str(data.get("entity") or "").strip()
    if entity:
        fields.append(("结算法人单位", entity))
    fields.append(("用途", data.get("purpose", "") or "-"))
    fields.append(("状态", "未提单" if data.get("status") == "pending" else "已提单"))
    return _layout_record(title, fields, data)


def build_update_markdown(data, old):
    """修改记录：识别「提单」（status pending→submitted）等状态变化。"""
    # 元字段写回抑制：仅涉及先借后还账目/照片缓存的系统内部变更不发通知
    # （转入 borrowed、归还账目 borrowReturned/borrowDone、追溯 fromBorrowId、photoUrls 缓存回写）
    old = old or {}
    BORROW_META = {"borrowed", "borrowReturned", "borrowDone", "fromBorrowId", "photoUrls"}
    changed = {k for k in set(data) | set(old) if k != "_ts" and data.get(k) != old.get(k)}
    if changed and changed.issubset(BORROW_META):
        return None
    new_st = data.get("status", "submitted")
    old_st = (old or {}).get("status", "submitted")
    # 提单动作：出库记录状态从非已提单变为已提单
    if new_st == "submitted" and old_st != "submitted":
        fields = [
            ("领取人", data.get("picker", "") or "-"),
            ("部门/客户", data.get("dept", "") or "-")
        ]
        entity = str(data.get("entity") or "").strip()
        if entity:
            fields.append(("结算法人单位", entity))
        fields += [
            ("用途", data.get("purpose", "") or "-"),
            ("时间", data.get("time", "") or "-"),
            ("状态", "✅ 已提单")
        ]
        return _layout_record("### 📤 出入库登记 · 出库已提单", fields, data)
    # 取消提单（已提单→未提单）
    if old_st == "submitted" and new_st == "pending":
        fields = [("领取人", data.get("picker", "") or "-")]
        entity = str(data.get("entity") or "").strip()
        if entity:
            fields.append(("结算法人单位", entity))
        fields += [("时间", data.get("time", "") or "-")]
        return _layout_record("### ↩️ 出入库登记 · 已撤回未提单", fields, data)
    # 其他修改（编辑用途/货品等）
    fields = [("领取人", data.get("picker", "") or "-")]
    entity = str(data.get("entity") or "").strip()
    if entity:
        fields.append(("结算法人单位", entity))
    fields += [
        ("时间", data.get("time", "") or "-"),
        ("状态", "未提单" if new_st == "pending" else "已提单")
    ]
    return _layout_record("### 📝 出入库登记 · 记录已更新", fields, data)


def build_tombstone_markdown(data):
    """删除墓碑：删除通知（含删除理由）。"""
    if not data or data.get("type") == "clear-all":
        # 清空全部墓碑（deletedAt 与当前时间均显式用 CST，避免 Actions/UTC 早 8 小时）
        return "### 🗑 出入库登记 · 全部记录已清空\n- **清空原因**：{}\n- **时间**：{}".format(
            data.get("reason", ""),
            fmt_ts(data.get("deletedAt")) or datetime.now(CST).strftime("%Y-%m-%d %H:%M"),
        )
    rec = data.get("rec") or {}
    goods_lines = goods_lines_of(rec)
    md = "### 🗑 出入库登记 · 记录已删除\n- **删除理由**：{}\n- **领取人**：{}\n- **部门/客户**：{}\n".format(
        data.get("reason", "") or "-",
        rec.get("picker", "") or "-",
        rec.get("dept", "") or "-",
    )
    if str(rec.get("type", "")).lower() != "in":
        md += entity_line(rec)
    md += "- **登记时间**：{}\n\n**货品明细**：\n{}".format(rec.get("time", "") or "-", goods_lines)
    return md


def build_pickup_new_markdown(data):
    """新增待取货登记通知（标题 → 字段 → 货品明细）。"""
    fields = [
        ("取货人", data.get("picker", "") or "-"),
        ("部门/客户", data.get("dept", "") or "-"),
        ("用途", data.get("purpose", "") or "-"),
        ("预计取货时间", data.get("time", "") or "-"),
    ]
    md = "### 📦 出入库登记 · 新待取货登记"
    md += "\n" + "\n".join("- **{k}**：{v}".format(k=k, v=v) for k, v in fields)
    md += "\n\n**货品明细**：\n" + goods_lines_of(data)
    note = str((data.get("note") or "")).strip()
    if note:
        md += "\n- **备注**：{}".format(note)
    return md


def build_pickup_update_markdown(data, old):
    """修改待取货：识别「确认出库」「确认提单」等状态变化。统一：标题→字段→货品明细。

    双链去重（P1-6）：「已出库」「已确认提单」两个动作由其它链路发消息，本函数返回 None 抑制：
      - 已出库（shipped）→ 生成出库记录走 notify 链路「新出库登记」，本处不发；
      - 已确认提单（confirmed）→ 前端写 pickup-confirm 走 remind 链路「提单确认」，本处不发。
    仅「其他修改」（编辑待取货信息）仍由本函数发「信息已更新」。
    """
    goods_lines = goods_lines_of(data)
    old = old or {}
    # 出库动作：出库状态从非已出库变为已出库（由「新出库登记」通知覆盖，抑制避免重复）
    if old.get("shipped") is not True and data.get("shipped") is True:
        return None
    # 确认提单动作：提单状态从非已确认变为已确认（由 remind 链路「提单确认」覆盖，抑制避免重复）
    if old.get("confirmed") is not True and data.get("confirmed") is True:
        return None
    # 其他修改
    return "### 📝 出入库登记 · 待取货信息已更新\n- **取货人**：{}\n- **时间**：{}\n\n**货品明细**：\n{}".format(
        data.get("picker", "") or "-", data.get("time", "") or "-", goods_lines
    )


def fmt_ts(ts):
    """时间戳 → "YYYY-MM-DD HH:mm"（北京时间 CST）；无效/缺失返回 None。
    兼容毫秒（>1e11，如 Date.now()）与秒（如 time.time()）。
    必须显式用 CST：Actions runner 默认 UTC，time.localtime 会早 8 小时。"""
    if not isinstance(ts, (int, float)) or not ts:
        return None
    if ts > 1e11:
        ts = ts / 1000.0
    try:
        return datetime.fromtimestamp(ts, CST).strftime("%Y-%m-%d %H:%M")
    except (OSError, ValueError, OverflowError):
        return None


def build_memo_new_markdown(data):
    """新增备忘录通知（标题 → 照片 → 字段：事项内容/添加时间/状态）。"""
    title = "### 📝 出入库登记 · 新备忘录"
    photos = photos_markdown(data)
    fields = [
        ("事项内容", data.get("text", "")),
        ("添加时间", data.get("time", "")),
        ("状态", "⏳ 未完成"),
    ]
    md = title
    if photos:
        md += "\n" + photos
    md += "\n" + "\n".join("- **{k}**：{v}".format(k=k, v=v) for k, v in fields)
    return md


def build_memo_update_markdown(data, old):
    """修改备忘录：识别「已完成」「改回未完成」等状态变化。
    每个分支都带上照片（若有 photoUrls）。结构：标题 → 照片 → 字段。
    """
    old = old or {}
    # 系统内部标记：reminded false→true 是提醒推送后的写回动作（write_reminded），
    # 非用户真实修改，不发通知（main() 中 md 为空自然跳过）。
    if old.get("reminded") is not True and data.get("reminded") is True:
        return None
    photos = photos_markdown(data)
    photo_block = ("\n" + photos) if photos else ""

    def join_fields(items):
        return "\n".join("- **{k}**：{v}".format(k=k, v=v) for k, v in items)

    # 完成动作：done 从非 true 变为 true（前端 update 仅此动作刷新 _ts，_ts 即完成时刻）
    if old.get("done") is not True and data.get("done") is True:
        fields = [
            ("事项内容", data.get("text", "")),
            ("完成时间", fmt_ts(data.get("_ts")) or data.get("time", "") or datetime.now(CST).strftime("%Y-%m-%d %H:%M")),
            ("添加时间", data.get("time", "")),
        ]
        return "### ✅ 出入库登记 · 备忘录已完成" + photo_block + "\n" + join_fields(fields)
    # 改回未完成：done 从 true 变为非 true
    if old.get("done") is True and data.get("done") is not True:
        fields = [("事项内容", data.get("text", ""))]
        return "### ↩️ 出入库登记 · 备忘录改回未完成" + photo_block + "\n" + join_fields(fields)
    # 其他修改
    fields = [
        ("事项内容", data.get("text", "")),
        ("时间", data.get("time", "")),
    ]
    return "### 📝 出入库登记 · 备忘录已更新" + photo_block + "\n" + join_fields(fields)


def send(text, title="新登记通知"):
    """发送 markdown 消息到钉钉。返回 (ok, errmsg)。"""
    if not WEBHOOK:
        return False, "WEBHOOK 环境变量为空，无法发送（请检查 secrets.DINGTALK_WEBHOOK）"
    if not SECRET:
        return False, "SECRET 环境变量为空，无法加签（请检查 secrets.DINGTALK_SECRET）"

    url = sign_url(WEBHOOK, SECRET)
    from ding_card import send_action_card, REG_URL
    return send_action_card(
        text, title, WEBHOOK, SECRET,
        btns=[
            {"title": "🌿 打开出库登记", "url": REG_URL},
            {"title": "📋 管理后台", "url": REG_URL + "?goto=app"}
        ],
        btn_orientation="0",
    )
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
    for line in FILES.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        action = parts[0].strip().upper() if parts else ""
        path = parts[-1].strip() if len(parts) > 1 else ""
        if not path:
            continue
        data = load_json(path)
        if data is None:
            continue
        # 配置类文件（如 data/memos/config.json 提醒配置）不是业务记录，不发通知
        if path.endswith("config.json"):
            continue
        # 待取货变更 → 待取货通知（data/pickups/ 前缀；删除为 D 时文件已不存在，load_json 返回 None 自然跳过）
        if path.startswith("data/pickups/"):
            if action == "M":
                md = build_pickup_update_markdown(data, git_show_old(path))
            else:  # A 新增
                md = build_pickup_new_markdown(data)
        # 备忘录变更 → 备忘录通知（data/memos/ 前缀；同上，删除自然跳过）
        elif path.startswith("data/memos/"):
            if action == "M":
                md = build_memo_update_markdown(data, git_show_old(path))
            else:  # A 新增
                md = build_memo_new_markdown(data)
        elif path.startswith("data/deleted/"):
            md = build_tombstone_markdown(data)
        elif action == "M":
            old = git_show_old(path)
            md = build_update_markdown(data, old)
        else:  # A 新增（或未知状态按新增处理）
            md = build_new_markdown(data)
        if md:
            records.append(md)

    if not records:
        print("没有可解析的变更记录，跳过发送（不报错）")
        return 0

    if len(records) == 1:
        text = records[0]
    else:
        text = "### 🔔 通知（共 {} 条）\n\n{}".format(
            len(records), "\n\n---\n\n".join(records)
        )

    ok, err = send(text, title="出入库登记通知")
    if ok:
        print("已发送 {} 条通知".format(len(records)))
        return 0
    print("发送失败: {}".format(err), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
