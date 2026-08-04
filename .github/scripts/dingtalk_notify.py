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

WEBHOOK = os.environ.get("WEBHOOK", "").strip()
SECRET = os.environ.get("SECRET", "").strip()
FILES = os.environ.get("FILES", "").strip()
GITHUB_SHA = os.environ.get("GITHUB_SHA", "").strip()

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


def build_new_markdown(data):
    """新增记录：新登记通知。"""
    goods = goods_of(data)
    photos = photos_markdown(data)
    if str(data.get("type", "")).lower() == "in":
        base = "### 📥 出入库登记 · 新入库登记\n- **货品**：{}\n- **时间**：{}".format(
            goods, data.get("time", "")
        )
    else:
        base = "### 📦 出入库登记 · 新出库登记\n- **领取人**：{}\n- **部门/客户**：{}\n- **用途**：{}\n- **货品**：{}\n- **时间**：{}\n- **状态**：{}".format(
            data.get("picker", ""),
            data.get("dept", ""),
            data.get("purpose", ""),
            goods,
            data.get("time", ""),
            status_text_of(data),
        )
    return base + ("\n" + photos if photos else "")


def build_update_markdown(data, old):
    """修改记录：识别「提单」（status pending→submitted）等状态变化。"""
    goods = goods_of(data)
    photos = photos_markdown(data)
    new_st = data.get("status", "submitted")
    old_st = (old or {}).get("status", "submitted")
    # 提单动作：出库记录状态从非已提单变为已提单
    if new_st == "submitted" and old_st != "submitted":
        base = "### 📤 出入库登记 · 出库已提单\n- **领取人**：{}\n- **部门/客户**：{}\n- **用途**：{}\n- **货品**：{}\n- **时间**：{}\n- **状态**：✅ 已提单".format(
            data.get("picker", ""),
            data.get("dept", ""),
            data.get("purpose", ""),
            goods,
            data.get("time", ""),
        )
        return base + ("\n" + photos if photos else "")
    # 取消提单（已提单→未提单）
    if old_st == "submitted" and new_st == "pending":
        return "### ↩️ 出入库登记 · 已撤回未提单\n- **领取人**：{}\n- **货品**：{}\n- **时间**：{}".format(
            data.get("picker", ""), goods, data.get("time", "")
        )
    # 其他修改（编辑用途/货品等）
    return "### 📝 出入库登记 · 记录已更新\n- **领取人**：{}\n- **货品**：{}\n- **时间**：{}\n- **状态**：{}".format(
        data.get("picker", ""), goods, data.get("time", ""), status_text_of(data)
    )


def build_tombstone_markdown(data):
    """删除墓碑：删除通知（含删除理由）。"""
    if not data or data.get("type") == "clear-all":
        # 清空全部墓碑
        return "### 🗑 出入库登记 · 全部记录已清空\n- **清空原因**：{}\n- **时间**：{}".format(
            data.get("reason", ""),
            time.strftime("%Y-%m-%d %H:%M", time.localtime((data.get("deletedAt") or time.time()) / 1000 if data.get("deletedAt") and data.get("deletedAt") > 1e11 else (data.get("deletedAt") or time.time()))),
        )
    rec = data.get("rec") or {}
    goods = goods_of(rec)
    return "### 🗑 出入库登记 · 记录已删除\n- **删除理由**：{}\n- **领取人**：{}\n- **部门/客户**：{}\n- **货品**：{}\n- **登记时间**：{}".format(
        data.get("reason", ""),
        rec.get("picker", ""),
        rec.get("dept", ""),
        goods,
        rec.get("time", ""),
    )


def send(text, title="新登记通知"):
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
        # 删除墓碑 → 删除通知（data/deleted/ 前缀）
        if path.startswith("data/deleted/"):
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

    ok, err = send(text)
    if ok:
        print("已发送 {} 条通知".format(len(records)))
        return 0
    print("发送失败: {}".format(err), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
