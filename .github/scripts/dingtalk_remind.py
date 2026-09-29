#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""订单提醒推送：读取 data/notify/*.json（勾选订单紧凑摘要），拼装消息推送钉钉群机器人。

由 GitHub Actions「DingTalk Remind」在 data/notify/*.json 变更时触发。
消息标题/正文均含关键词「出入库登记」，满足钉钉自定义机器人安全设置（防 errcode 310000）。

支持四种载荷（按 data.type 区分）：
  remind          : 勾选订单提醒（orders 数组，紧凑摘要）
  pickup-confirm  : 待取货「确认提单」对比消息（pickup 对象，含登记时间与提单时间）
  pickup-new      : 自动识别回填待取货的登记通知（pickup 对象，标题「新待取货登记」）
  stocktake       : 库存盘点校准结果（items 数组：name 货品 / book 账面 / actual 实存 / diff 差异）
  out-copy        : 出库领取信息（落地页「复制并通知」，按 AT_MOBILES @ 人）
  recognize-confirm:自动识别结果「正式提交」后的确认（2026-09-29 方案 A；kind=out/in/pickup + order 对象）

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
DATA_ROOT = (os.environ.get("DATA_PREFIX") or "data").strip()  # 双仓库数据前缀：默认 data（深圳）；赛迪斯 workflow 注入 data-saidis

WEBHOOK = os.environ.get("WEBHOOK", "").strip()
SECRET = os.environ.get("SECRET", "").strip()
FILES = os.environ.get("FILES", "").strip()
# 2026-09-26 新增：出库领取信息推送时要 @ 的人（手机号，逗号分隔，来自 repo secret AT_MOBILES）。
# 未配置时只发消息不 @ 人，功能照常可用。
AT_MOBILES = [m.strip() for m in (os.environ.get("AT_MOBILES") or "").split(",") if m.strip()]


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


def send(text, title="出入库登记通知", at_mobiles=None):
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
        at_mobiles=at_mobiles,
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


def goods_of(order):
    items = order.get("items") or []
    return ", ".join(
        "{n}×{q}".format(n=it.get("name", ""), q=it.get("qty", ""))
        for it in items
        if it.get("name")
    ) or "（无明细）"


def goods_lines_of(order):
    """货品明细：统一走 ding_card.goods_block_of（2026-09-28 主理人定稿）。
    旧实现用 "    - 名称 × 数量"（缩进 4 空格）→ 钉钉 actionCard 把缩进当续行、吞掉换行，
    所有货品挤成一坨（主理人截图反馈的典型坏例）。现统一为「N 项 + 数字序号 + 合计」样式。"""
    from ding_card import goods_block_of
    return goods_block_of(order.get("items") or [])


def status_text_of(order):
    return "未提单" if order.get("status") == "pending" else "已提单"


def photos_lines(o):
    """订单照片 markdown（最多 3 张，缩进与续行一致）；无则空串。"""
    return "".join(
        "\n   ![照片{}]({})".format(j, u)
        for j, u in enumerate((o.get("photoUrls") or [])[:3], 1)
    )


def borrow_items_of(o):
    """[已弃用 2026-09-28] 旧版借出单货品渲染（带 4 空格缩进 → 钉钉吞换行挤成一坨）。
    现统一由 borrow_goods_block() 走 ding_card.goods_block_of 渲染。
    保留此函数仅为兼容可能的旧调用方；新代码请勿使用。
    """
    from ding_card import goods_block_of
    ret = o.get("returned") or {}

    def fmt(it):
        n = it.get("name", "")
        try:
            q = float(it.get("qty") or 0)
        except Exception:
            q = 0
        bk = 0
        rv = ret.get(n)
        if rv is not None:
            try:
                bk = float(rv)
            except Exception:
                bk = 0
        return "{}：借出{:g}｜已还{:g}｜剩余{:g}".format(n, q, bk, max(0, q - bk))

    return goods_block_of(o.get("items") or [], heading="借出货品", line_fmt=fmt)


def build_order_blocks(payload):
    """把提醒请求中的订单摘要转成 markdown 块；无效订单跳过。

    2026-09-28 主理人定稿：**全面改为「每单独立成块 + 顶格字段 + 图1样式货品明细」**。
    旧结构把订单做成 "- **#1 出库** ..." 的单个列表项、货品靠缩进排续行，
    钉钉 actionCard 会把缩进的续行吞掉换行 → 所有货品挤成一坨（主理人截图的坏例）。
    新结构不再用列表项嵌套，全部顶格写，钉钉逐行正常渲染。

    每单格式：
        **#1 出库**　2026-09-28 10:57
        - 领取人：xxx
        - 部门/客户：xxx
        - 用途：xxx
        - 状态：已提单

        **货品明细（3 项）**
        1. 精华液 单支装 × 2
        ...
        **合计 6 件**

    特殊订单（借出单 / 调拨）同样按此结构，只在标题与字段上区分。
    """
    blocks = []
    for i, o in enumerate(payload.get("orders") or [], 1):
        if not isinstance(o, dict) or not o.get("id"):
            continue
        t = str(o.get("time") or "").strip() or "-"
        kind = str(o.get("type") or "").lower()
        tf = str(o.get("transferNo") or "").strip()
        borrowed = o.get("borrowed") is True
        entity = str(o.get("entity") or "").strip()
        note = str(o.get("note") or "").strip()

        fields = []          # [(k, v), ...] 顶格列表行
        items_all = o.get("items") or []

        if borrowed:
            # 2026-09-29 主理人方案 A：借用/归还自动推送，用 borrowStage 区分阶段
            bstage = str(o.get("borrowStage") or "").strip()
            if bstage == "returned":
                head = "**#{} 借出单 · 部分归还**　{}".format(i, t)
            elif bstage == "closed":
                head = "**#{} 借出单 · 已还清**　{}".format(i, t)
            elif bstage == "unborrowed":
                head = "**#{} 借出单 · 已退回出库**　{}".format(i, t)
            else:
                head = "**#{} 借出单**　{}".format(i, t)
            fields += [
                ("领取人", o.get("picker") or "-"),
                ("部门/客户", o.get("dept") or "-"),
            ]
            if entity:
                fields.append(("结算法人单位", entity))
            fields += [
                ("用途", o.get("purpose") or "-"),
                ("状态", status_text_of(o)),
            ]
            if note:
                fields.append(("备注", note))
            goods = borrow_goods_block(o)
        elif tf:
            if kind == "in":
                head = "**#{} ⇄ 调拨入库**　{}".format(i, t)
                fields.append(("调入自", o.get("picker") or o.get("dept") or "-"))
            else:
                head = "**#{} ⇄ 调拨出库**　{}".format(i, t)
                fields.append(("调出至", o.get("dept") or "-"))
                if o.get("picker"):
                    fields.append(("领取人", o.get("picker")))
            fields.append(("调拨单号", tf))
            if entity:
                fields.append(("结算法人单位", entity))
            if kind == "in":
                fields.append(("用途/来源", o.get("purpose") or "-"))
            elif o.get("purpose"):
                fields.append(("用途", o.get("purpose")))
            if kind != "in":
                fields.append(("状态", status_text_of(o)))
            if note:
                fields.append(("备注", note))
            goods = goods_lines_of(o)
        elif kind == "in":
            head = "**#{} 入库**　{}".format(i, t)
            fields.append(("用途/来源", o.get("purpose") or "-"))
            if note:
                fields.append(("备注", note))
            goods = goods_lines_of(o)
        else:
            head = "**#{} 出库**　{}".format(i, t)
            fields += [
                ("申请人", o.get("applicant") or "-"),
                ("领取人", o.get("picker") or "-"),
                ("部门/客户", o.get("dept") or "-"),
            ]
            if entity:
                fields.append(("结算法人单位", entity))
            fields.append(("用途", o.get("purpose") or "-"))
            fields.append(("状态", status_text_of(o)))
            if note:
                fields.append(("备注", note))
            goods = goods_lines_of(o)

        block = head
        if fields:
            block += "\n" + "\n".join("- **{}**：{}".format(k, v) for k, v in fields)
        block += "\n\n" + goods
        block += photos_lines(o)
        blocks.append(block)
    return blocks


def borrow_goods_block(o):
    """借出单货品明细：复用统一渲染器，每行显示「名称：借出 x｜已还 y｜剩余 z」（顶格，无缩进）。"""
    from ding_card import goods_block_of
    ret = o.get("returned") or {}

    def fmt(it):
        n = it.get("name", "")
        try:
            q = float(it.get("qty") or 0)
        except Exception:
            q = 0
        bk = 0
        rv = ret.get(n)
        if rv is not None:
            try:
                bk = float(rv)
            except Exception:
                bk = 0
        return "{}：借出{:g}｜已还{:g}｜剩余{:g}".format(n, q, bk, max(0, q - bk))

    return goods_block_of(o.get("items") or [], heading="借出货品", line_fmt=fmt)


def build_pickup_new_markdown(payload):
    """「自动识别」回填待取货时的登记通知（2026-09-28 新增）。
    与 dingtalk_notify.build_pickup_new_markdown 的输出格式保持一致（标题/字段/货品明细同款），
    区别只在数据来源：那个由 data/pickups/*.json 触发，这个由识别页写 data/notify/ 触发，
    避免往真实待取货数据目录写脏数据。"""
    p = payload.get("pickup") or {}
    items = p.get("items") or []
    if not items:
        return None
    fields = [
        ("取货人", p.get("picker", "") or "-"),
        ("部门/客户", p.get("dept", "") or "-"),
        ("用途", p.get("purpose", "") or "-"),
        ("预计取货时间", p.get("time", "") or "-"),
    ]
    md = "### 📦 出入库登记 · 新待取货登记"
    md += "\n" + "\n".join("- **{}**：{}".format(k, v) for k, v in fields)
    md += "\n\n" + goods_lines_of(p)
    note = str((p.get("note") or "")).strip()
    if note:
        md += "\n\n- **备注**：{}".format(note)
    return md


def build_in_new_markdown(payload):
    """手工登记入库的通知（2026-09-29 主理人方案 A）。

    历史缺口：入库页手工登记/修改一直不推钉钉，只有从「自动识别」页带入的单才会推，
    主理人反馈「明明登记了修改了，群里一条都没有」，故补此通知。
    格式与 build_pickup_new_markdown 看齐（标题/字段/货品明细同款），群里观感统一。"""
    o = payload.get("order") or {}
    if not (o.get("items") or []):
        return None
    fields = [
        ("经办人", o.get("picker", "") or "-"),
        ("部门/客户", o.get("dept", "") or "-"),
        ("来源/用途", o.get("purpose", "") or "-"),
        ("入库时间", o.get("time", "") or "-"),
    ]
    ent = str(o.get("entity") or "").strip()
    if ent:
        fields.append(("结算法人单位", ent))
    md = "### 📥 出入库登记 · 新入库登记"
    md += "\n" + "\n".join("- **{}**：{}".format(k, v) for k, v in fields)
    md += "\n\n" + goods_lines_of(o)
    note = str((o.get("note") or "")).strip()
    if note:
        md += "\n\n- **备注**：{}".format(note)
    return md


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
        from datetime import datetime as _dt, timedelta as _td, timezone as _tz
        # Actions runner 时区为 UTC，astimezone() 无参会转成 UTC 而非北京时间；
        # 且前端写入的 time/confirmedAt 多为 naive「YYYY-MM-DDTHH:MM」（本就是北京时间）。
        # 故：naive → 直接挂 CST；aware → 显式转 CST。两端同一时区，间隔计算才准确。
        _CST = _tz(_td(hours=8))

        def _to_cst(dt):
            return dt.replace(tzinfo=_CST) if dt.tzinfo is None else dt.astimezone(_CST)

        t0 = _to_cst(_dt.fromisoformat((p.get("time") or "").replace("Z", "+00:00")))
        t1 = _to_cst(_dt.fromisoformat((p.get("confirmedAt") or "").replace("Z", "+00:00")))
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
        goods_lines,
    ]
    dept = str(p.get("dept") or "").strip()
    if dept:
        lines.insert(4, "- **部门/客户：** {}".format(dept))
    return "\n".join(lines)


def build_stocktake_markdown(payload):
    """库存盘点校准结果：各货品 账面→实存 + 差异汇总。返回 markdown 文本；无明细返回 None。"""
    items = payload.get("items") or []
    if not items:
        return None
    t = str(payload.get("time") or "").strip().replace("T", " ")[:16] or "-"
    total_in = sum(x.get("diff", 0) for x in items if x.get("diff", 0) > 0)
    total_out = -sum(x.get("diff", 0) for x in items if x.get("diff", 0) < 0)
    rows = []
    for x in items:
        diff = x.get("diff", 0)
        rows.append("- **{}**：账面 {} → 实存 {}（{}{}）".format(
            x.get("name", "?"), x.get("book", "-"), x.get("actual", "-"),
            "+" if diff > 0 else "", diff))
    return "\n".join([
        "### 📋 出入库登记 · 库存盘点",
        "",
        "盘点时间：{}".format(t),
        "差异 {} 项：盘盈 +{} / 盘亏 -{}".format(len(items), total_in, total_out),
        "",
        "（校准库存基准到实存数，未生成出入库记录、未入金山台账）",
        "",
        "\n".join(rows),
    ])


def build_out_copy_markdown(payload):
    """出库领取信息（在落地页点「复制并通知」后推送）。

    载荷：{type:"out-copy", order:{applicant, picker, time, dept, purpose, entity, orderNo,
                                    items:[{name, qty}]}}
    群里 @ 的人由环境变量 AT_MOBILES 决定 —— 钉钉要求在正文里出现「@手机号」才会真正 @ 到人。
    """
    o = payload.get("order") or {}
    items = o.get("items") or []
    head = ""
    if AT_MOBILES:
        head = " ".join("@" + m for m in AT_MOBILES) + "\n\n"

    lines = [
        head + "### 📤 出库领取信息",
        "",
        "**领取人已通过钉钉向您发送领取信息，请查收。**",
        "",
        "---",
        "",
    ]
    rows = [
        ("申请人", o.get("applicant")),
        ("领取人", o.get("picker")),
        ("领取时间", (o.get("time") or "").replace("T", " ")),
        ("部门 / 客户", o.get("dept")),
    ]
    for k, v in rows:
        if v:
            lines.append("- **{}**：{}".format(k, v))

    # 货品明细：统一走共用渲染器（2026-09-28），标题沿用「领取货品」，样式与全群一致
    from ding_card import goods_block_of
    lines += ["", goods_block_of(o.get("items") or [], heading="领取货品")]
    return "\n".join(lines)


def build_recognize_confirm_markdown(payload):
    """「自动识别」结果正式提交后的确认消息（2026-09-29 主理人方案 A）。

    与识别页「填入表单即推」那条的区别：那条是预通知（数据还没定、也可能最终没提交），
    这条是提交/登记成功后、用最终实际数据补的确认，标题带 🤖 一眼能看出来源。
    载荷：{type:"recognize-confirm", kind:"out"|"in"|"pickup",
          order:{id, picker, applicant, dept, purpose, entity, time, items:[{name,qty}], note}}
    """
    o = payload.get("order") or {}
    items = o.get("items") or []
    if not items:
        return None
    kind = str(payload.get("kind") or o.get("type") or "").strip()
    kind_txt = {"out": "出库", "in": "入库", "pickup": "待取货"}.get(kind, "出入库")
    rows = [
        ("登记类型", kind_txt),
        ("取货人" if kind == "pickup" else "领取人", o.get("picker")),
        ("部门 / 客户", o.get("dept")),
    ]
    if str(o.get("applicant") or "").strip():
        rows.append(("申请人", o.get("applicant")))
    if str(o.get("purpose") or "").strip():
        rows.append(("用途 / 项目", o.get("purpose")))
    if str(o.get("entity") or "").strip():
        rows.append(("结算法人单位", o.get("entity")))
    reg_time = (o.get("time") or "").replace("T", " ")
    rows.append(("提交时间", reg_time))

    # 两阶段：submitted=识别提交后 / confirmed=提单确认完成后（2026-09-29 主理人要求闭环）
    stage = str(payload.get("stage") or "submitted").strip()
    title = "### 🤖 出入库登记 · 自动识别已提交"
    if stage == "confirmed":
        title = "### ✅ 出入库登记 · 自动识别提单确认完成"
        conf_raw = str(o.get("confirmedAt") or payload.get("confirmedAt") or "").strip()
        if conf_raw:
            gap = ""
            try:
                from datetime import datetime as _dt, timedelta as _td, timezone as _tz
                _CST = _tz(_td(hours=8))

                def _to_cst(dt):
                    return dt.replace(tzinfo=_CST) if dt.tzinfo is None else dt.astimezone(_CST)

                t0 = _to_cst(_dt.fromisoformat(reg_time.replace("Z", "+00:00").replace(" ", "T")))
                t1 = _to_cst(_dt.fromisoformat(conf_raw.replace("Z", "+00:00").replace(" ", "T")))
                if t1 > t0:
                    secs = int((t1 - t0).total_seconds())
                    h, m = divmod(secs // 60, 60)
                    gap = " ｜间隔：{}".format("{} 小时 {} 分钟".format(h, m) if h else "{} 分钟".format(m))
            except Exception:
                gap = ""
            rows.append(("确认时间", conf_raw.replace("T", " ")[:16] + gap))

    lines = [title, ""]
    lines += ["- **{}**：{}".format(k, v) for k, v in rows if str(v or "").strip()]
    from ding_card import goods_block_of
    lines += ["", goods_block_of(items, heading="登记货品")]
    note = str(o.get("note") or "").strip()
    if note:
        lines += ["", "- **备注**：{}".format(note)]
    if str(o.get("id") or "").strip():
        lines += ["", "- **记录号**：{}".format(o.get("id"))]
    if stage == "confirmed":
        lines += ["", "（来源：自动识别登记，已完成提单确认）"]
    else:
        lines += ["", "（来源：自动识别填入表单后正式提交）"]
    return "\n".join(lines)


def main():
    payloads = []
    for line in (FILES or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        path = parts[-1].strip() if len(parts) > 1 else ""
        if not path or not path.startswith(DATA_ROOT + "/notify/") or not path.endswith(".json"):
            continue
        data = load_json(path)
        if data and data.get("type") == "remind" and data.get("orders"):
            payloads.append(data)

    pickup_confirm = []
    pickup_news = []
    in_news = []
    stocktakes = []
    out_copies = []
    recognize_confirms = []
    for line in (FILES or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        path = parts[-1].strip() if len(parts) > 1 else ""
        if not path or not path.startswith(DATA_ROOT + "/notify/") or not path.endswith(".json"):
            continue
        data = load_json(path)
        if not data:
            continue
        if data.get("type") == "pickup-confirm":
            pickup_confirm.append(data)
        elif data.get("type") == "pickup-new":
            pickup_news.append(data)
        elif data.get("type") == "in-new":
            in_news.append(data)
        elif data.get("type") == "stocktake":
            stocktakes.append(data)
        elif data.get("type") == "out-copy":
            out_copies.append(data)
        elif data.get("type") == "recognize-confirm":
            recognize_confirms.append(data)

    if not payloads and not pickup_confirm and not pickup_news and not in_news and not stocktakes \
            and not out_copies and not recognize_confirms:
        print("没有可解析的提醒请求，跳过发送（不报错）")
        return 0

    # 1) 订单提醒（每单独立成块，块之间用分隔线隔开，避免多单连读混淆）
    blocks = []
    count = 0
    for p in payloads:
        blks = build_order_blocks(p)
        count += len(blks)
        blocks.extend(blks)
    if blocks:
        body = "\n\n---\n\n".join(blocks)
        # 2026-09-29 主理人方案 A：借用/归还的自动推送复用本 remind 链路，
        # 若本批全是借出单则换专属标题，群里不必点开就知道是借还动态而非普通订单提醒。
        all_borrow = bool(payloads) and all(p.get("kind") == "borrow" for p in payloads)
        if all_borrow:
            text = "### 🔔 出入库登记 · 借出归还动态（共 {} 条）\n\n---\n\n{}".format(count, body)
            title = "出入库登记 · 借出归还"
        else:
            text = "### 🔔 出入库登记 · 订单提醒（共 {} 条）\n\n---\n\n{}".format(count, body)
            title = "出入库登记 · 订单提醒"
        ok, err = send(text, title=title)
        if not ok:
            print("订单提醒发送失败: {}".format(err), file=sys.stderr)
            return 1

    # 2) 新待取货登记（自动识别回填，2026-09-28）
    for pn in pickup_news:
        text = build_pickup_new_markdown(pn)
        if not text:
            print("SKIP pickup-new：无货品明细")
            continue
        ok, err = send(text, title="出入库登记 · 新待取货登记")
        if ok:
            print("新待取货登记已发送")
        else:
            print("新待取货登记发送失败: {}".format(err), file=sys.stderr)
            return 1

    # 2b) 新入库登记（2026-09-29 主理人方案 A：手工登记入库也要进群）
    for initem in in_news:
        text = build_in_new_markdown(initem)
        if not text:
            print("SKIP in-new：无货品明细")
            continue
        ok, err = send(text, title="出入库登记 · 新入库登记")
        if ok:
            print("新入库登记已发送")
        else:
            print("新入库登记发送失败: {}".format(err), file=sys.stderr)
            return 1

    # 3) 提单确认对比
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

    # 3) 库存盘点差异（2026-09-23 补：此前 stocktakes 只被收集、main() 里没有发送分支，
    #    导致前端 toast「盘点差异已推送钉钉群」但群里根本收不到 —— 属静默丢失。）
    for st in stocktakes:
        text = build_stocktake_markdown(st)
        if not text:
            continue
        ok, err = send(text, title="出入库登记 · 库存盘点")
        if ok:
            print("库存盘点差异已发送")
        else:
            print("库存盘点差异发送失败: {}".format(err), file=sys.stderr)
            return 1

    # 4) 出库领取信息（2026-09-26 新增：落地页点「复制并通知」触发；按 AT_MOBILES @ 群里指定人）
    for oc in out_copies:
        text = build_out_copy_markdown(oc)
        if not text:
            continue
        ok, err = send(text, title="出库领取信息", at_mobiles=AT_MOBILES)
        if ok:
            print("出库领取信息已发送（@ {}）".format(", ".join(AT_MOBILES) if AT_MOBILES else "未配置"))
        else:
            print("出库领取信息发送失败: {}".format(err), file=sys.stderr)
            return 1

    # 5) 自动识别提交确认（2026-09-29 新增：识别结果正式提交后补推，带最终实际数据）
    for rc in recognize_confirms:
        text = build_recognize_confirm_markdown(rc)
        if not text:
            print("SKIP recognize-confirm：无货品明细")
            continue
        _title = ("出入库登记 · 自动识别提单确认完成" if rc.get("stage") == "confirmed"
                  else "出入库登记 · 自动识别已提交")
        ok, err = send(text, title=_title)
        if ok:
            print("自动识别提交确认已发送")
        else:
            print("自动识别提交确认发送失败: {}".format(err), file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
