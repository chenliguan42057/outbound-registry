#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ding_card.py — 青屿主题·钉钉结构化卡片（actionCard）共享工具（2026-08-08 新增；2026-08-08 修复钉钉内置浏览器 hash 兼容）

修复说明：钉钉内置浏览器对带 hash（#）的 URL 处理偶尔失效（如 /#/app/out-records），导致点击「管理后台」按钮后页面空白。
  改为：管理后台按钮 URL 改用 query 形式 `?goto=app`，由前端 `dingtalk.js` 监听 query 并触发 `location.hash = '#/app/out-records'` 跳转。
  其他按钮（打开出库登记 / 落地点位跳转）保持原 URL 不变。
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

# 青屿主题色板
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
    if not text:
        return text
    t = re.sub(r"^(#{1,3}\s+)(.+)$", "<font color='%s'><b>\\2</b></font>" % C_LAV, text, flags=re.M)
    t = re.sub(r"\*\*(.+?)\*\*", "<font color='%s'><b>\\1</b></font>" % C_MINT, t)
    return t


def btn_landing():
    return {"title": "🌿 打开出库登记", "url": REG_URL}


def btn_manage():
    """管理后台按钮：用 ?goto=app 查询形式（避开钉钉内置浏览器 hash 路由兼容问题）"""
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
        return False, "WEBHOOK 环境变量为空，无法发送（请检查 secrets.DINGTALK_WEBHOOK）"
    if not secret:
        return False, "SECRET 环境变量为空，无法加签（请检查 secrets.DINGTALK_SECRET）"
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