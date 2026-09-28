#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ding_card.py — 钉钉卡片双端格式统一（2026-08-08）

修复：钉钉手机客户端对 actionCard markdown 中的 <font color='...'> 标签渲染失败（可能原样显示尖括号），
导致手机端与电脑端显示不一致。改为移除 <font color> 标签，仅依赖标准 markdown（加粗、列表、emoji、空行）保证两端一致。
"""
import base64
import hashlib
import hmac
import json
import os
import re
import time
import urllib.parse
import urllib.request

REG_URL = "https://chenliguan42057.github.io/outbound-registry/"

# 注：主题色板常量保留，decorate() 不再注入 <font color> 标签（避免钉钉手机端乱码）
C_LAV = "#7A6DA3"
C_MINT = "#57826F"
C_CYAN = "#7FB3A5"
C_ERR = "#C9877F"
C_MUT = "#74837E"


def sign_url(webhook, secret):
    timestamp = str(round(time.time() * 1000))
    string_to_sign = "{}\n{}".format(timestamp, secret)
    hmac_code = hmac.new(
        secret.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).digest()
    sign = urllib.parse.quote_plus(base64.b64encode(hmac_code))
    return webhook + "&timestamp=" + timestamp + "&sign=" + sign


def decorate(text):
    """2026-08-08 修复：移除 <font color> 标签（钉钉手机端不渲染该私有标签会原样显示尖括号）。
    视觉层级改为依赖：标准 markdown（**加粗**、- 列表、空行）+ emoji + 【】包裹关键数字。
    这样手机端/电脑端显示一致、清晰直观。"""
    if not text:
        return text
    # 移除所有 <font color='...'> 与 </font> 标签
    text = re.sub(r"<font color=['\"]#[0-9A-Fa-f]+['\"]>", "", text)
    text = re.sub(r"</font>", "", text)
    return text


def btn_landing():
    return {"title": "🌿 打开出库登记", "url": REG_URL}


def goods_block_of(items, heading="货品明细", total_unit="件", line_fmt=None):
    """全群统一的货品明细渲染（2026-09-28 主理人定稿：「清清楚楚，不要杂乱在一起」）。

    格式（对齐「出库领取信息」那条标杆卡片）：
        **货品明细（3 项）**
        1. 精华液 单支装 × 2
        2. 洁面慕斯 150ml × 2
        3. 精粹水 120ml × 2

        **合计 6 件**

    ⚠️ 铁律：条目行**绝不能带缩进**（旧版用 "    - x"）。
    钉钉 actionCard 的 markdown 解析器把「缩进 4 空格」当代码块续行处理，
    会吞掉换行 → 所有货品挤成一坨（本次主理人截图反馈的典型坏例）。
    必须用「数字. xxx」顶格写，钉钉才会逐行渲染。

    items      : [{name, qty}, ...]
    heading    : 明细区标题（如「货品明细」「领取货品」「借出货品」）
    total_unit : 合计单位（默认「件」）
    line_fmt   : 可选，自定义每行文案 fn(it) -> str（不含序号与缩进）；
                 借出单要显示「借出｜已还｜剩余」时传入。
    空明细返回「**heading**：\\n（无明细）」。
    """
    items = [it for it in (items or []) if it.get("name")]
    if not items:
        return "**{}**：\n（无明细）".format(heading)
    rows = []
    total = 0
    for i, it in enumerate(items, 1):
        if line_fmt:
            rows.append("{}. {}".format(i, line_fmt(it)))
            continue
        qty = it.get("qty")
        try:
            total += int(qty or 0)
        except (TypeError, ValueError):
            pass
        rows.append("{}. {} × {}".format(i, it.get("name") or "", "" if qty is None else qty))
    body = "**{}（{} 项）**\n{}".format(heading, len(items), "\n".join(rows))
    if not line_fmt:
        body += "\n\n**合计 {} {}**".format(total, total_unit)
    return body


def btn_manage():
    return {"title": "📋 管理后台", "url": REG_URL + "?goto=app"}


def build_card_payload(text, title, btns=None, btn_orientation="0", decorate_text=True, at_mobiles=None):
    if decorate_text:
        text = decorate(text)
    if not btns:
        btns = [btn_landing()]
    payload = {
        "msgtype": "actionCard",
        "actionCard": {
            "title": title,
            "text": text,
            "btnOrientation": btn_orientation,
            "btns": [{"title": b["title"], "actionURL": b["url"]} for b in btns],
        },
    }
    # 2026-09-26 新增：支持在群里 @ 指定人（出库领取信息要 @ 对接人）。
    # 钉钉规则：at.atMobiles 列出手机号，且正文里要出现「@手机号」才会真正 @ 到人
    # （正文由调用方在 text 里拼好，这里只负责把 at 字段放进 payload）。
    if at_mobiles:
        payload["at"] = {"atMobiles": list(at_mobiles), "isAtAll": False}
    return payload


def send_action_card(text, title, webhook, secret, btns=None, btn_orientation="0", decorate_text=True, at_mobiles=None):
    # 2026-09-06 统一加系统名标记：深圳=深圳细胞 / 赛迪斯=赛迪斯（由 workflow 注入 SYS_NAME）。
    # 样式：# 一级标题（钉钉手机/电脑端都渲染成蓝色背景大号粗体块）+ 加粗 + 🏢 + --- 分隔线。
    # 放在 send_action_card 统一处理，notify/remind/memo/pending/stock/sync_health/summary/pushmenu 全一致。
    sys_name = (os.environ.get("SYS_NAME") or "").strip()
    if sys_name:
        # 系统名前导 emoji：深圳细胞=🏢，赛迪斯=🏬（按仓区分，可调整）
        sys_emoji = {"赛迪斯": "🏬", "深圳细胞": "🏢"}.get(sys_name, "🏢")
        # text 顶部加 # 一级标题大块标记（视觉显眼，手机/电脑端一致）
        text = "# {} **【 {} 】**\n\n---\n\n".format(sys_emoji, sys_name) + text
        # 钉钉 actionCard 关键词校验只看 title 字段（实测），title 补系统名前缀确保过校验
        if sys_name not in title:
            title = "{} · {}".format(sys_name, title)
    if not webhook:
        return False, "WEBHOOK 环境变量为空"
    if not secret:
        return False, "SECRET 环境变量为空"
    payload = json.dumps(build_card_payload(text, title, btns, btn_orientation, decorate_text, at_mobiles)).encode("utf-8")
    url = sign_url(webhook, secret)
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        return False, str(exc)
    if result.get("errcode") == 0:
        return True, ""
    return False, json.dumps(result, ensure_ascii=False)