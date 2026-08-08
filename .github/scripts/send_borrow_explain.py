#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""send_borrow_explain.py — 推送「先借后还」功能说明到钉钉群（青屿主题 actionCard）。
标题与正文均含机器人关键词「出入库登记」。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ding_card import send_action_card, btn_landing, btn_manage  # noqa: E402

TITLE = "📦 出入库登记系统 · 先借后还 功能说明"

TEXT = """**出入库登记系统里「先借后还」是干什么的？一句话：东西先拿走用，用完再还回来，系统自动把账记平。** 特别适合借工具、借样品、借耗材这类场景。

**1️⃣ 怎么借（借出）**
- 在「先借后还」页点「**添加借出**」，从出库记录里选要借的单子
- 选中后确认，这条记录就从「出库记录」页**隐藏**，转入「借出中」列表
- 库存照常扣减，账不会乱

**2️⃣ 怎么还（归还）**
- 在「借出中」列表点「**归还**」，输入本次还多少
- 系统自动处理两种情况：
  - **还了的货** → 生成一条**入库记录**，库存加回去（推钉钉「新入库登记」）
  - **没还完的差额** → 生成一条**未提单的出库记录**，提醒你差额还没补（推钉钉「新出库登记」）
- **全部还清** → 原单自动标记完成，移到「已完成」tab，历史可查

**3️⃣ 几个贴心细节**
- 借出中每一行都显示：**借出｜已还｜剩余**，还剩多少一目了然
- 已归还的单子**不能退回**出库记录页，防止库存账目对不上
- 归还差额单不会重复扣库存（库存只扣一次）
- 所有数据手机电脑实时同步

**4️⃣ 什么时候用**
- 同事借走设备/工具，先登记借出，用完归还自动入库
- 样品试用、临时领用、跨部门周转
- 只要东西会"回来"，就走先借后还，账目最干净

想试试？点下方按钮打开出入库登记系统，左侧菜单找到「先借后还」～ 🌿"""


def main():
    webhook = os.environ.get("WEBHOOK", "") or (sys.argv[1] if len(sys.argv) > 1 else "")
    secret = os.environ.get("SECRET", "") or (sys.argv[2] if len(sys.argv) > 2 else "")
    if not webhook or not secret:
        print("缺少 WEBHOOK/SECRET")
        return 1
    ok, err = send_action_card(
        TEXT, TITLE, webhook, secret,
        btns=[btn_landing(), btn_manage()],
        btn_orientation="1",
    )
    print("send:", "OK" if ok else err)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
