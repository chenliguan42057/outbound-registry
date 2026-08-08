#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ding_card.py — 青屿主题·钉钉结构化卡片（actionCard）共享工具（2026-08-08 新增）

用途：全系统钉钉推送统一为「清新护眼」风格卡片，与进销存前端主题（fresh-mint-theme.css）同源配色：
  低饱和淡紫 #7A6DA3（标题）/ 深薄荷 #57826F（关键信息）/ 浅青 #7FB3A5（次要）/ 柔陶 #C9877F（警示）/ 灰 #74837E（弱化）。

平台说明（重要）：
- 钉钉「自定义机器人」webhook 仅支持 text/link/markdown/actionCard/feedCard，
  无法自定义卡片背景色（interactiveCard 模板需企业内部应用 + 开通能力）。
- 因此采用 **actionCard**：正文为 markdown 并用 <font color>/<b> 做低饱和着色（长时间查看不疲劳），
  底部挂「打开出库登记」跳转按钮（actionURL），电脑端 / 手机端原生适配；
  btnOrientation="0"（竖排）时手机端按钮为全宽，方便手指点击。

用法（在各推送脚本内）：
    from ding_card import send_action_card, REG_URL
    send_action_card(text, title, WEBHOOK, SECRET, btns=[
        {"title": "🌿 打开出库登记", "url": REG_URL},
        {"title": "📋 管理后台", "url": REG_URL + "#/app/out-records"},
    ])
"""
import base64
import hashlib
import hmac
import json
import re
import time
import urllib.parse
import urllib.request

# 落地页（免密出库登记），供卡片跳转按钮使用
REG_URL = "https://chenliguan42057.github.io/outbound-registry/"

# 青屿主题色板（与前端 CSS 变量保持一致）
C_LAV = "#7A6DA3"    # 淡紫-标题
C_MINT = "#57826F"   # 深薄荷-关键
C_CYAN = "#7FB3A5"   # 浅青-次要
C_ERR = "#C9877F"    # 柔陶-警示
C_MUT = "#74837E"    # 灰-弱化


def sign_url(webhook, secret):
    """钉钉加签：timestamp + \\n + secret 的 HMAC-SHA256，base64 后 URL 编码。"""
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
    """把推送正文 markdown 渲染成青屿配色：
    - 标题行（#/##/###）→ 淡紫加粗
    - **加粗** → 深薄荷 <b>（替代 markdown 加粗，避免与 <font> 嵌套失效）
    - 行首「· / 📌 / ⏳ / ⚠️」等已由各脚本自带，不额外处理
    """
    if not text:
        return text
    t = re.sub(r"^(#{1,3}\s+)(.+)$", "<font color='%s'><b>\\2</b></font>" % C_LAV, text, flags=re.M)
    t = re.sub(r"\*\*(.+?)\*\*", "<font color='%s'><b>\\1</b></font>" % C_MINT, t)
    return t


def build_card_payload(text, title, btns=None, btn_orientation="0", decorate_text=True):
    """构建 actionCard payload 字典（JSON 配置示例可参见交付文档）。"""
    if decorate_text:
        text = decorate(text)
    if not btns:
        btns = [{"title": "🌿 打开出库登记", "url": REG_URL}]
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
    """发送青屿主题 actionCard 到钉钉。返回 (ok, errmsg)。
    btns: [{title, url}, ...]，最多 2 个；默认「打开出库登记」单按钮。
    """
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
    except Exception as exc:  # 网络异常统一兜底
        return False, str(exc)
    if result.get("errcode") == 0:
        return True, ""
    return False, json.dumps(result, ensure_ascii=False)
