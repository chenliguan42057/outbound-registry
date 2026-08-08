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


def btn_manage():
    return {"title": "📋 管理后台", "url": REG_URL + "?goto=app"}


def build_card_payload(text, title, btns=None, btn_orientation="0", decorate_text=True):
    if decorate_text:
        text = decorate(text)
    if not btns:
        btns = [btn_landing()]
    return {
        "msgtype": "actionCard",
        "actionCard": {
            "title": title,
            "text": text,
            "btnOrientation": btn_orientation,
            "btns": [{"title": b["title"], "actionURL": b["url"]} for b in btns],
        },
    }


def send_action_card(text, title, webhook, secret, btns=None, btn_orientation="0", decorate_text=True):
    if not webhook:
        return False, "WEBHOOK 环境变量为空"
    if not secret:
        return False, "SECRET 环境变量为空"
    payload = json.dumps(build_card_payload(text, title, btns, btn_orientation, decorate_text)).encode("utf-8")
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