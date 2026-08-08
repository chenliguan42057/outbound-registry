#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""send_summary.py — 推送「优化收尾总结」到钉钉群（青屿主题 actionCard）。
用法：workflow_dispatch 触发 summary-notify.yml，或本地调用：
    python3 send_summary.py <WEBHOOK> <SECRET>
"""
import os
import sys

# 复用同目录 ding_card.py
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ding_card import send_action_card, btn_landing, btn_manage  # noqa: E402

TITLE = "🌿 进销存系统优化总结（8/7 — 8/8）"

TEXT = """**这一轮我们把出库登记系统从头到脚打磨了一遍，全部已上线，打开就能用。** 手机电脑都能用，眼睛看着也更舒服了。

**1️⃣ 看着更舒服（清新护眼主题）**
- 整套界面换成**薄荷绿 + 奶白 + 浅青 + 淡紫**的低饱和配色，长时间看不累眼
- 背景是淡淡的植物叶子、蒲公英和柔光，只做氛围、不挡文字
- 新增**深色夜间模式**，晚上用不刺眼（设置里一键切换）
- 大字/小字可调、高对比模式，老人家也能看清

**2️⃣ 登记更快（效率提升）**
- **出库单自动编号**：每单自动生成 ORD-20260808-001 这样的单号，对账方便
- **全局快捷键**：Ctrl+Enter 直接提交、g+s / g+o 一键跳到库存/出库页
- 数量可以**±按钮加减**，手机上也很好点
- 提交成功弹出**全屏暖心页**，随机送上一句暖心话

**3️⃣ 库存更清楚（数据管理）**
- **货品目录可配置**：商品、单价、条码、预警线都能自己增删改
- **盘点平账**：数完实存数，系统自动补出入库记录，账实一致
- **库存流水追溯**：点库存数字，就能看到这个货品全部进出记录
- **库存不够会拦截**，不会再出现负数库存
- 仪表盘加了**业绩榜 + 高频货品**，谁领得多一目了然
- 操作都有**审计日志**，谁什么时候做了什么，查得到

**4️⃣ 数据更安全（备份与恢复）**
- **一键备份 / 恢复**：全部数据打包下载，随时能还原
- **同步冲突可视化**：多设备同时改数据时，弹窗让你选保留哪个版本
- 对账 CSV 导出、打印单据带单号

**5️⃣ 待取货不再忘**
- 超过预计取货时间还没取的，**自动置顶标红 + 钉钉提醒**

**6️⃣ 钉钉推送全面升级**
- 群里的推送从纯文字变成**清新卡片**：淡紫薄荷配色、重点加粗、手机电脑显示一致
- 卡片带按钮：**「打开出库登记」「管理后台」**，点一下直达，不用再翻聊天记录

**7️⃣ 按你的反馈做的调整**
- 去掉「一句话登记」和多余麦克风（留了更简洁的表单）
- 去掉全局搜索框和记录页通用搜索框，界面更干净
- 出入库记录行尾保留「编辑 / 删除」按钮，滑动表格就能看到

有问题随时说，随时继续优化～ 🌿"""


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
