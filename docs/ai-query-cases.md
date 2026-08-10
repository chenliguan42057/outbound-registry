# AI 助手查询用例集（8 类 ≥20 句验收基准）

> 版本：v4.0（T02 产出，Engineer）｜关联：docs/system_design_v4_ai.md、docs/ai-acceptance.md
> 用途：Node 冒烟测试逐条断言 Engine.normalize/matchProducts/detectIntent/answer 行为。

## 1. 用例总览

| # | 类型 | 问句 | 期望意图 | 期望命中 |
|---|------|------|----------|----------|
| 1 | stock | 精华液 20支装 还有多少？ | stock（精确 1 规格） | exact=1 |
| 2 | stock | 精华液还有多少？ | stock（模糊 4 规格） | fuzzy=4 |
| 3 | stock | 面膜还有多少？ | stock（模糊 2 规格） | fuzzy=2 |
| 4 | stock | 小鹿牛皮纸袋还有库存吗？ | stock（模糊 2 规格） | fuzzy=2 |
| 5 | stock | 洁面慕斯 150ml 剩多少？ | stock（模糊 2 规格） | fuzzy=2 |
| 6 | stock | 查库存 | stock（全量汇总） | type=stock |
| 7 | low_stock | 哪些货品低库存？ | low_stock | type=low_stock |
| 8 | low_stock | 什么快没货了？ | low_stock | type=low_stock |
| 9 | low_stock | 库存不足的有哪些？ | low_stock | type=low_stock |
| 10 | in_out_today | 今天出了多少货？ | in_out_today(today) | date=today |
| 11 | in_out_today | 昨天入了多少？ | in_out_today(yesterday) | date=yesterday |
| 12 | in_out_today | 今日出库 | in_out_today(today) | date=today |
| 13 | in_out_days | 最近 7 天出库最多的是什么？ | in_out_days(7) | days=7 |
| 14 | in_out_days | 近 30 天出了多少货？ | in_out_days(30) | days=30 |
| 15 | in_out_days | 本月出库统计 | in_out_days(7) | days=7 |
| 16 | records | 最近有哪些出库记录？ | records(出库) | type=records |
| 17 | records | 张三领过什么？ | records(领取人=张三) | filter=picker |
| 18 | records | 销售部领了什么？ | records(部门=销售部) | filter=dept |
| 19 | records | 最近出库记录 | records(出库) | type=records |
| 20 | rank | 库存最多的前 5 个货品 | rank(desc, n=5) | n=5, dir=desc |
| 21 | rank | 库存最少的是哪些？ | rank(asc, n=5) | dir=asc |
| 22 | rank | 库存排行 TOP10 | rank(desc, n=10) | n=10 |
| 23 | trend | 出库趋势怎么样？ | trend(7) | days=7 |
| 24 | trend | 近 30 天出入库趋势 | trend(30) | days=30 |
| 25 | trend | 帮我看看报表 | trend(7)+出库TOP摘要 | type=trend |
| 26 | help | 你能做什么？ | help | type=help |
| 27 | help | 帮助 | help | type=help |

## 2. 产品匹配规格数断言

| 输入 | 期望 |
|------|------|
| 冻干 | 精确 0 + 模糊 4（精华液 20支装/5支装/单支装/30支装） |
| 面膜 | 精确 0 + 模糊 2（面膜 5片装/1片装） |
| 牛皮纸袋 | 精确 0 + 模糊 2（小鹿牛皮纸袋 大/小） |
| 150ml | 精确 0 + 模糊 2（洁面慕斯 150ml / 50ml，子串包含） |

## 3. 归一化断言

| 输入 | 期望输出 |
|------|----------|
| " 精华液，还有多少？ " | "精华液 还有多少" |
| "TOP10" | "top10" |
| "150ML" | "150ml" |
| "今天出了多少货？" | "今天出了多少货" |

## 4. 数据一致性说明

- 所有数值来自 `Stock.getStock/summarize/trend` 与 `State.list`，与报表模块同源；
- 冒烟测试使用固定种子数据（INVENTORY 快照 + 若干条 affectsStock 记录），断言数字与 Stock.* 计算结果一致。
- 命中产品后回答表行数 = 精确命中 + 模糊命中去重（如「精华液 20支装 还有多少？」→ 精确 1 + 模糊 3 = 4 行，精确行在前）。
