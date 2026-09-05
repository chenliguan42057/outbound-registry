#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""推送信息中心（pushmenu）：把页面「推送信息」模块产出的待发消息推到钉钉群。

读取 data[/-saidis]/notify/pushmenu/*.json（前端 push.js 一键推送/自定义发送写入），
每个文件一独立 payload：{type:"pushmenu", time, title, text}，text 为完整 markdown 正文。

只处理「本次 push 变更的文件」列表（FILES），老文件不会被重发；
GitHub Actions「DingTalk Pushmenu」/「DingTalk Pushmenu (赛迪斯)」在子目录新增 json 时触发。

读取环境变量：
  DATA_PREFIX : 数据目录前缀，默认 data（深圳）；赛迪斯 workflow 注入 data-saidis
  SYS_NAME    : 系统名（仅用于兜底补关键词时的提示文案）
  WEBHOOK     : 钉钉群机器人 Webhook 地址
  SECRET      : 钉钉安全设置「加签」密钥
  KEYWORD     : 该群机器人要求正文包含的关键词（深圳=出入库登记；赛迪斯=赛迪斯）
  FILES       : 换行分隔的变更列表，每行形如 "A\tpath"（新增）/ "M\tpath"（修改）
"""
import json
import os
import sys

DATA_ROOT = (os.environ.get("DATA_PREFIX") or "data").strip()
SYS_NAME = (os.environ.get("SYS_NAME") or "深圳细胞").strip()
WEBHOOK = os.environ.get("WEBHOOK", "").strip()
SECRET = os.environ.get("SECRET", "").strip()
KEYWORD = os.environ.get("KEYWORD", "").strip()
FILES = os.environ.get("FILES", "").strip()

SUBDIR = DATA_ROOT + "/notify/pushmenu/"


def load_json(path):
    """读取 json 文件，失败返回 None。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as exc:
        print("SKIP {}: {}".format(path, exc))
        return None


def guard_keyword(text, title):
    """群机器人安全设置要求正文含指定关键词；缺失则消息会被钉钉拦截（errcode 310000）。
    前端 push.js 已统一在正文首行带「【仓名】出入库登记 · 标题」，这里兜底再查一遍。"""
    if not KEYWORD:
        return text
    if KEYWORD in text:
        return text
    return "【{}】出入库登记 · {}\n\n{}".format(SYS_NAME, title or "推送", text)


def main():
    targets = []  # (path, data) 待发送
    for line in (FILES or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        path = parts[-1].strip() if len(parts) > 1 else ""
        if not path.startswith(SUBDIR) or not path.endswith(".json"):
            continue
        data = load_json(path)
        if not data:
            continue
        if data.get("type") != "pushmenu":
            print("SKIP {}: type={!r} 非 pushmenu".format(path, data.get("type")))
            continue
        text = str(data.get("text") or "").strip()
        if not text:
            print("SKIP {}: 无 text 内容".format(path))
            continue
        targets.append((path, data, text))

    if not targets:
        print("没有可发送的推送信息请求，跳过发送（不报错）")
        return 0

    if not WEBHOOK or not SECRET:
        print("WEBHOOK/SECRET 环境变量为空，无法发送（请检查仓库 secrets）", file=sys.stderr)
        return 1

    from ding_card import send_action_card, btn_landing, btn_manage

    sent = 0
    for path, data, text in targets:
        title = str(data.get("title") or "").strip() or "推送"
        text = guard_keyword(text, title)
        ok, err = send_action_card(
            text,
            "【{}】出入库登记 · {}".format(SYS_NAME, title),
            WEBHOOK,
            SECRET,
            btns=[btn_landing(), btn_manage()],
            btn_orientation="0",
        )
        if ok:
            sent += 1
            print("已发送 {}（{}）".format(path, title))
        else:
            print("发送失败 {}: {}".format(path, err), file=sys.stderr)
            return 1

    print("推送完成：共发送 {} 条".format(sent))
    return 0


if __name__ == "__main__":
    sys.exit(main())
