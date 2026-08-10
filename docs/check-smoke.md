# check.js 冒烟用例清单（第六轮增量）

> 用途：AI 库存核对纯函数 `Check.parseText / Check.compare / Check.answer` 的验收用例。
> 全部为纯函数用例，可用 Node 22（仓库外 qa_v6/ 目录脚本）或浏览器控制台执行。
> 数据源：`Stock.summarize()`（与报表同源）；系统库存快照以 `src/js/core/config.js` INVENTORY 为准。

## 一、parseText 解析用例

| # | 输入行 | 期望结果 |
|---|--------|----------|
| P1 | `精华液 20支装 95` | name="精华液 20支装"，qty=95，candidates=["精华液 20支装"]，ambiguous=false |
| P2 | `面膜 5片装 120` | name="面膜 5片装"，qty=120（贪婪切分，非「面膜 5」），exact 唯一 |
| P3 | `洁面慕斯 150ml: 85件` | name="洁面慕斯 150ml"，qty=85（全角冒号 + 单位后缀） |
| P4 | `  \| 洁面慕斯 150ml: 85件 ` | 去行首装饰符 `\|` 后同上（噪音容忍） |
| P5 | `精华液 5支装\t320\t` | 表格粘贴：取最后数字列 qty=320，name="精华液 5支装" |
| P6 | `精华液 单支装`（无数量） | qty=null（只核存在性） |
| P7 | `面膜 5` | candidates=["面膜 5片装","面膜 1片装"]，ambiguous=true（多候选不静默） |
| P8 | `洁面慕斯 50ml 100000` | unrecognized=true（数量超范围 1~99999） |
| P9 | `随便写一行没有数字的东西` | qty=null、candidates=[]（后续比对 → ⚪ 无法识别） |
| P10 | `----` / 空行 | 计入 ignored，不产生行 |

## 二、compare 5 类结果用例（系统库存：精华液 20支装=95 / 面膜 5片装=139 / 洁面慕斯 150ml=85 / 精粹霜 1g=127）

| # | 粘贴内容 | 期望分类 |
|---|----------|----------|
| C1 | `精华液 20支装 95` | ✅ ok（一致） |
| C2 | `面膜 5片装 120` | ⚠️ warn（系统 139 vs 截图 120，差 -19） |
| C3 | `新货品试用装 10` | ❌ nf（系统无此货品） |
| C4 | `精华液 单支装`（无数量） | ✅ ok（存在，不比较数量） |
| C5 | `面膜 5` | 2 行 warn，各标「名称不唯一」 |
| C6 | `随便写一行没有数字的东西` | ⚪ unk（行格式异常） |
| C7 | `洁面慕斯 50ml 100000` | ⚪ unk（数量超范围） |
| C8 | `精华液 20支装 95` 单独核对 | 其余 19 个货品 → 🔵 miss（截图未提及，全量列出） |

## 三、answer 结构用例

| # | 输入 | 期望 Answer |
|---|------|-------------|
| A1 | `精华液 20支装 95\n面膜 5片装 120` | type="check"；title 含「共 20 项」；summaryText 含 ✅一致 1｜⚠️1｜🔵18｜❌0｜⚪0；table.head 4 列；table.rows 每行带 cls ∈ ok/warn/miss；chips 含「重新核对」 |
| A2 | `（空串）` | 提示类 Answer：title「📋 库存核对」，text 引导文案，chips 含「重新核对」 |
| A3 | `  \| 洁面慕斯 150ml: 85件 \n随便写一行没有数字的东西` | summaryText 含 ✅一致 1 ｜ ⚪1；忽略行 0 |

## 四、engine 触发词用例（Engine.answer）

| # | 输入 | 期望 |
|---|------|------|
| E1 | `帮我盘点一下库存` | type="check_guide"，guideAct.act="openCheck" |
| E2 | `核对库存` | type="check_guide" |
| E3 | `对一下库存` / `比一下库存` | type="check_guide" |
| E4 | `库存还有多少` | type="stock"（不误吞，v5 库存意图） |
| E5 | `最近出库记录` | type="records"（不误吞） |
| E6 | `查库存` | type="stock"（v5 快捷 chip 零破坏） |
| E7 | `Engine.checkStock("精华液 20支装 95")` | type="check"，table.rows[0].cls="ok" |

## 五、隐私红线用例

| # | 检查点 | 期望 |
|---|--------|------|
| S1 | `Check.answer(text)` 返回对象不含原始整段粘贴文本（含装饰符/换行/分隔符） | 结构化结果仅含货品名/数量/分类 |
| S2 | `src/js/ai/check.js` 无 localStorage / sessionStorage / history 写入 | grep 无命中 |
| S3 | 原始粘贴文本不进入 Chat.history / outbound_ai_chat | 走 appendAnswer(ans) 常规路径，仅 Answer 持久化 |
