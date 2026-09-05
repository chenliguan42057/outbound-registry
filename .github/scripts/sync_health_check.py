#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""云端同步健康检查（P2 兜底）：定时检测"登记→推送"链路是否健康，异常时主动在报备群预警。

核心思想：GitHub Actions 侧无法看到浏览器里的待同步队列，但能检测两类云端侧异常——
  1. 当日有新的出库登记 commit，但最近的「DingTalk Notify」workflow 运行失败/未触发
     → 说明"仓库收到了、钉钉没收到"，必须立刻人工核对（正是 2026-08-13 事故的镜像场景）。
  2. 当日 records 新增数为 0 且为工作日 → 温和提醒"今日尚无登记同步"，防漏（可被手动触发覆盖）。

读取环境变量：
  WEBHOOK   : 钉钉群机器人 Webhook 地址
  SECRET    : 钉钉安全设置「加签」密钥
  GH_TOKEN  : GitHub token（Actions 内置 GITHUB_TOKEN 即可，读 API 够用）
  GITHUB_REPOSITORY : "owner/repo"（Actions 内置，用于查询 workflow runs）
  GITHUB_SHA: 触发本次运行的 SHA（Actions 内置）

可选环境变量（用于调参，不设取默认）：
  NO_ZERO_WARN : 设 1 时关闭"当日零新增"提醒（防周末/节假日误报噪音）
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
DATA_ROOT = (os.environ.get("DATA_PREFIX") or "data").strip()
WF_NAME = (os.environ.get("WF_NAME") or "dingtalk-notify.yml").strip()  # 健康检查目标 workflow 文件名（赛迪斯副本注入 dingtalk-notify-saidis.yml）

CST = timezone(timedelta(hours=8))
WEBHOOK = os.environ.get("WEBHOOK", "").strip()
SECRET = os.environ.get("SECRET", "").strip()
GH_TOKEN = os.environ.get("GH_TOKEN", "").strip()
REPO = os.environ.get("GITHUB_REPOSITORY", "").strip() or "chenliguan42057/outbound-registry"
NO_ZERO_WARN = os.environ.get("NO_ZERO_WARN", "0").strip() == "1"

# 北京时间 08:30 前视为"凌晨/深夜"，不催"零新增"，避免打扰休息时间
ZERO_WARN_AFTER_HOUR = 8


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


def send_card(text, title="出入库同步健康检查"):
    """发送 actionCard 到钉钉；失败返回 (ok=False, errmsg)。"""
    if not WEBHOOK:
        return False, "WEBHOOK 为空"
    if not SECRET:
        return False, "SECRET 为空"
    from ding_card import send_action_card, btn_landing, btn_manage
    return send_action_card(
        text, title, WEBHOOK, SECRET,
        btns=[btn_landing(), btn_manage()],
        btn_orientation="1",
    )


def today_utc_boundary():
    """返回北京时间今天的起始时刻（转成 UTC naive datetime，用于 git log --since）。"""
    now_cst = datetime.now(CST)
    start_cst = datetime(now_cst.year, now_cst.month, now_cst.day, tzinfo=CST)
    return start_cst.astimezone(timezone.utc)


def count_records_commits_today():
    """统计北京时间今天 data/records 目录的新增 commit 数（git log --since）。"""
    since = today_utc_boundary()
    # --since 传 UTC 时间（GitHub runner 默认 UTC），避免时区把"今天"算错
    since_str = since.strftime("%Y-%m-%d %H:%M:%S")
    try:
        out = subprocess.run(
            ["git", "log", "--since={}".format(since_str), "--pretty=%H", "--", DATA_ROOT + "/records"],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode != 0:
            return 0, "git log 失败: {}".format(out.stderr.strip()[:200])
        commits = [ln for ln in out.stdout.splitlines() if ln.strip()]
        return len(commits), ""
    except Exception as exc:
        return 0, str(exc)


def last_notify_run_state():
    """查询最近一次「DingTalk Notify」workflow run 的状态。
    返回 (conclusion, run_created_at, errmsg)；conclusion 为 success/failure/null。
    GH_TOKEN 为空时返回 (None, None, "无 GH_TOKEN")，调用方按"未知"处理（不误报推送失败）。
    """
    if not GH_TOKEN:
        return None, None, "GH_TOKEN 为空（无法查询，跳过推送失败检查）"
    url = ("https://api.github.com/repos/{repo}/actions/workflows/" + WF_NAME + "/runs"
           "?per_page=3").format(repo=REPO)
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + GH_TOKEN,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        runs = data.get("workflow_runs") or []
        if not runs:
            return None, None, "无运行记录"
        first = runs[0]
        return first.get("conclusion"), first.get("created_at"), ""
    except Exception as exc:
        return None, None, "查询失败: {}".format(exc)


def is_workday(now):
    """周一到周五为工作日（周末不催"零新增"，避免误报噪音）。"""
    return now.weekday() < 5


def main():
    now = datetime.now(CST)
    today_str = now.strftime("%Y-%m-%d")

    # 1) 当日 records 新增 commit 数
    new_count, err1 = count_records_commits_today()

    # 2) 最近 DingTalk Notify 状态
    conclusion, created_at, err2 = last_notify_run_state()

    alerts = []
    info_lines = ["⏱ 检查时间：{}（北京时间）".format(now.strftime("%Y-%m-%d %H:%M")),
                  "📄 今日新增出库登记：{} 条".format(new_count)]

    # 场景 1：今日有登记，但最近的钉钉推送失败 → 强预警（对应"仓库收到了、钉钉没响"）
    if new_count > 0 and conclusion == "failure":
        alerts.append(
            "🚨 **检测到异常：今日有 {} 条登记，但最近的钉钉推送任务执行失败**\n"
            "请立即人工核对今日登记是否都已推送到群；同时检查仓库 Secrets（DINGTALK_WEBHOOK / DINGTALK_SECRET）是否失效。".format(new_count)
        )
    elif new_count > 0 and conclusion is None and err2 and "跳过" not in err2:
        # 有登记但查不到 notify 状态（网络/权限异常）→ 保守预警，宁可信其有
        alerts.append(
            "⚠️ 今日有 {} 条登记，但无法确认钉钉推送是否成功（{}）。\n"
            "建议打开仓库 Actions 页核对「DingTalk Notify」最近运行结果。".format(new_count, err2[:120])
        )

    # 场景 2：工作日 + 当日零新增 + 过了上午 → 温和提醒（防漏，可用 NO_ZERO_WARN 关闭）
    if not NO_ZERO_WARN and new_count == 0 and is_workday(now) and now.hour >= ZERO_WARN_AFTER_HOUR:
        alerts.append(
            "ℹ️ **今日暂无新的出库登记同步到云端。**\n"
            "如果今天有提交但没收到推送，可能登记停留在了浏览器本地（待同步队列）。\n"
            "处理方式：打开「管理 → 云同步 → 待推送队列 → 一键重推」，即可补推并触发钉钉通知。"
        )

    if not alerts:
        print("健康检查通过：今日新增 {} 条，最近推送状态={}；无需预警".format(new_count, conclusion or "未知"))
        return 0

    text = "### 📡 出入库登记 · 同步健康检查\n" + "\n".join(info_lines) + "\n\n" + "\n\n".join(alerts)
    print(text)
    ok, err = send_card(text)
    if ok:
        print("健康检查预警已发送")
        return 0
    print("预警发送失败: {}".format(err), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
