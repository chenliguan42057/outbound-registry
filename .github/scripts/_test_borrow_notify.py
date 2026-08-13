#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地单元测试：验证「先借后还」相关的推送逻辑（dingtalk_notify.build_update_markdown）。

不发送任何网络请求，仅 import 纯函数并断言输出。
用法：python3 _test_borrow_notify.py
覆盖场景：
  ① 借出动作：borrowed false→true           → 应输出「新借出登记」通知
  ② 退回动作：borrowed true→false           → 应输出「已退回出库记录」通知
  ③ 归还后内部状态：仅 borrow* 元字段变化    → 应返回 None（抑制通知，避免重复打扰）
  ④ 普通字段更新（如改用途）                 → 应输出「记录已更新」
  ⑤ 照片回写：仅 photoUrls + updatedAt 变化  → 应返回 None（抑制通知）
"""
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dingtalk_notify as nt  # noqa: E402

FAIL = []


def check(name, cond, detail=""):
    if cond:
        print("  OK  " + name)
    else:
        print("  FAIL " + name + ("  -- " + detail if detail else ""))
        FAIL.append(name)


def sample(overrides=None):
    base = {
        "id": "abc123",
        "type": "out",
        "status": "submitted",
        "time": "2026-08-13 09:00",
        "picker": "陈利冠",
        "dept": "深圳细胞",
        "entity": "深圳细胞法人",
        "purpose": "实验样品",
        "items": [{"name": "精化液", "qty": 2}, {"name": "冻干精华液", "qty": 3}],
        "_ts": 1755000000000,
    }
    if overrides:
        base.update(overrides)
    return base


print("场景① 借出动作（borrowed false -> true）")
old = sample()
new = sample({"borrowed": True, "updatedAt": 1755000100000})
md = nt.build_update_markdown(new, old)
check("输出非空", bool(md), str(md))
check("标题含「新借出登记」", bool(md) and "新借出登记" in md, str(md))
check("含领取人", bool(md) and "陈利冠" in md, str(md))
check("含结算法人单位", bool(md) and "深圳细胞法人" in md, str(md))
check("含货品明细行", bool(md) and "精化液 × 2" in md, str(md))

print("场景② 退回出库（borrowed true -> false）")
old = sample({"borrowed": True, "updatedAt": 1755000100000})
new = sample({"borrowed": False, "updatedAt": 1755000200000})
md = nt.build_update_markdown(new, old)
check("输出非空", bool(md), str(md))
check("标题含「已退回出库记录」", bool(md) and "已退回出库记录" in md, str(md))

print("场景③ 归还后内部状态（仅 borrow* 元字段 + updatedAt）")
old = sample({"borrowed": True, "borrowReturned": [], "updatedAt": 1755000100000})
new = sample({
    "borrowed": True,
    "borrowReturned": [{"name": "精化液", "qty": 1}],
    "borrowDone": False,
    "updatedAt": 1755000200000,
})
md = nt.build_update_markdown(new, old)
check("返回 None（抑制通知）", md is None, str(md))

print("场景④ 普通字段更新（purpose 修改，无借出相关）")
old = sample({"purpose": "实验样品", "updatedAt": 1755000100000})
new = sample({"purpose": "实验样品（改）", "updatedAt": 1755000200000})
md = nt.build_update_markdown(new, old)
check("输出非空", bool(md), str(md))
check("标题含「记录已更新」", bool(md) and "记录已更新" in md, str(md))

print("场景⑤ 照片回写（仅 photoUrls + updatedAt）")
old = sample({"photoUrls": [], "updatedAt": 1755000100000})
new = sample({"photoUrls": ["https://x/1.png"], "updatedAt": 1755000200000})
md = nt.build_update_markdown(new, old)
check("返回 None（抑制通知）", md is None, str(md))

print()
if FAIL:
    print("失败 {} 项: {}".format(len(FAIL), ", ".join(FAIL)))
    sys.exit(1)
print("全部通过")
sys.exit(0)
