# 系统设计文档 v4.0 — AI 助手模块（A 本地问答 + B 对话式 AI）

> 版本：v4.0（第四轮增量，Architect 产出，Engineer 实施落盘）
> 项目：outbound-registry（GitHub Pages 静态站）
> 基线：remote main = 2e35b677（第三轮已上线）
> 关联文件：docs/ai-query-cases.md（T02 用例集）、docs/ai-acceptance.md（T05 验收清单）

---

## 0. 关键决策摘要（对应 PRD v4.0 待确认问题）

| # | 待确认问题 | 决策 |
|---|---|---|
| 1 | 默认模型与 baseUrl | DeepSeek `deepseek-chat` / `https://api.deepseek.com`（浏览器 CORS 直连） |
| 2 | API Key 存储键名 | `outbound_ai_key`（原始字符串，仅 localStorage）+ `outbound_ai_settings`（模型等），统一经 store.js 封装 |
| 3 | 快捷 chips 列表 | 查库存 / 今日出库 / 低库存 / 最近出库记录 / 帮我看看报表 |
| 4 | 有 Key 时混合策略 | 数据类问题优先本地引擎（准确+零成本），闲聊/未命中走 LLM |
| 5 | 管理后台入口形态 | 侧栏菜单项 `#/app/ai` + 落地页右下角浮动气泡（顶栏不加） |
| 6 | 会话历史持久化 | P0 内存；P1 持久化 `outbound_ai_chat`（上限 50 条，设置开关默认开） |
| 7 | 移动端面板形态 | <520px 全宽 sheet（height 92vh 顶部圆角），≥520px 右下角悬浮卡片 360×520 |
| 8 | 清空对话二次确认 | 复用 `UI.confirmDialog` |
| 9 | 「测试连接」按钮 | P1 实现（`LLM.testConnection()` 最小请求验证） |
| 10 | 低库存阈值 | 沿用 `Config.LOW_STOCK_THRESHOLD = 30` |
| 11 | 自定义服务商（baseUrl+模型输入） | P2 预留（settings.baseUrl 已支持，界面 P2 再加） |

---

## 1. 总体架构（A + B 切换）

```
用户输入
   │
   ▼
┌─────────────────────────────┐
│ chat.js 聊天面板（单例）      │  ← 落地页浮动 + 管理后台 #/app/ai 双入口复用
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐
│ engine.js 意图识别           │
│ ① normalize 归一化           │
│ ② matchProducts 产品匹配     │
│ ③ detectIntent 意图关键词    │
└──────────────┬──────────────┘
               │
        ┌──────┴──────┐
        ▼             ▼
  命中数据意图       未命中（fallback）
        │             │
        ▼             ▼
┌──────────────┐  有 Key？──────────┐
│ 本地数据查询   │  ├─ 是 → llm.js 真对话（带系统数据上下文）
│ （A 核心）    │  └─ 否 → 帮助/兜底文案
└──────┬───────┘
       │
       ▼
  返回 Answer（type/title/text/table/chips）
```

- **无 Key（默认 A 模式）**：全部走本地引擎，100% 离线可用。
- **有 Key（B 模式）**：数据类意图仍由本地引擎回答；fallback 走 LLM；LLM 失败且仍疑似数据意图 → 回退本地 fallback 并附 hint。
- 命名空间：`window.App.AI = { Engine, LLM, Chat }`；`window.App.Views.ai = { render, refresh }`。

---

## 2. engine.js — A 部分本地问答引擎（核心）

### 2.1 归一化
`Engine.normalize(q)`：`toLowerCase()` → 去全/半角标点（保留中文与数字）→ `trim()`。

### 2.2 产品匹配
`Engine.matchProducts(input)` → `{ exact: [], fuzzy: [] }`：
- 精确包含：`input.includes(p.toLowerCase())`
- 模糊匹配：对产品名按 `[\s（()）]+` 切分 token（长度≥2），任一 token 满足 `input.includes(token)` 或 `token.includes(input)`（input 长度≥2）
- 覆盖样例：「冻干」→ 4 个冻干规格；「面膜」→ 2 规格；「牛皮纸袋」→ 2 规格；「150ml」→ 2 规格
- 命中产品后：输入含记录关键词（领过/领了/记录/领用）→ records 意图（按货品过滤）；否则 stock 意图

### 2.3 意图识别（无产品命中才进入，优先级从高到低）
1. help：帮助/你能做什么/怎么用/会什么
2. low_stock：低库存/快没货/不足/缺货/补货/不够 → Stock.summarize() 过滤 < 30
3. rank：排行/最多/最少/top/前N/榜首/第一 → Stock.summarize() 排序（最多=desc、最少=asc，前N 默认 5；`/前\s*(\d+)/` 提取 TOP N）
4. trend：趋势/走势/变化/报表 → Stock.trend(list, 7/30)
5. in_out_today：今天/昨日/今日/昨天 + 出/入/领/发 → State.list 按 time.slice(0,10) 过滤统计
6. in_out_days：最近N天/近N天/本周/上周/上月 → Stock.trend + 按货品聚合（`/(最近|近)\s*(\d+)\s*天/` 提取天数默认 7；本月/本周→7，上月→30）
7. records：记录/领过/领了/领取人/部门/用途/出库记录/入库记录 → State.list 过滤（默认最近 10 条；按领取人/部门/用途过滤）
8. stock：库存/还有多少/剩多少/有多少 → Stock.getStock/summarize
9. fallback：兜底帮助文案

### 2.4 Answer 结构
`Engine.answer(question)` → `{ type, title, text?, table?, chips?, hint? }`
- `type ∈ {stock, low_stock, rank, trend, stats, records, help, fallback}`
- 数据一致性：所有数值只取 `Stock.getStock/summarize/trend` + `State.list`，不另算。

---

## 3. llm.js — B 部分 DeepSeek 对接

- 配置：`Store.loadAiKey()/loadAiSettings()`；baseUrl 默认 `https://api.deepseek.com`
- 请求：`POST {base}/chat/completions`；Headers `Content-Type` + `Authorization: Bearer <key>`；Body `{model, messages:[system,user], stream:false, temperature:0.7}`
- 超时：`AbortController` 30s（`Config.AI_TIMEOUT_MS`）
- 响应：`json.choices[0].message.content`；失败 `json.error.message`
- 错误归一化 `Promise<{ok, text?, err?}>`：401/403→invalid-key；429→rate-limit；≥500→server；AbortError→timeout；fetch reject→network
- `buildSystemContext()`：库存 TOP15（summarize 按 stock 降序）、低库存货品数、今日出库件数、最近 10 条记录摘要（时间/领取人/货品×数量/状态）、本地记录总数
- `testConnection()`（P1）：最小请求验证 Key

---

## 4. chat.js — 单例聊天面板

- `window.App.AI.Chat`，懒创建面板 DOM（append body），复用不重建
- `openFloat()`：position:fixed 右下角卡片（360×520），头部 ✕ 关闭、🗑 清空（UI.confirmDialog）、⚙ 设置（UI.Modal）
- `renderEmbedded(el)`：position:static 填满容器（管理后台 #/app/ai），无关闭按钮，类 `.ai-panel.embedded`
- 移动端：<520px 全宽 sheet（width:100%、height:92vh、顶部圆角16px）；输入框 font-size:16px；chips 横向滚动
- 消息流：send(q) → 用户气泡 → 「正在思考…」+ 禁用输入 + busy 防抖 → Engine.answer(q)：
  - type !== "fallback" → 直接渲染本地结果（有 Key 也不走 LLM）
  - type === "fallback" → 无 Key：渲染帮助文案；有 Key：LLM.chat([systemContext, user])，成功渲染 LLM 文本，失败按 err 映射文案 → 仍疑似数据意图则回退本地 fallback 并附 hint「已退回本地问答」
- 渲染：按 Answer.type（stats=文本摘要卡片；stock/rank/low_stock=表格，低库存行红色高亮 class low；records=记录表；trend=文本列表）；全部值 Util.esc；每条 AI 回复附 2-3 个后续 chips；回复后自动滚底
- 会话历史：内存数组（P0）；P1 持久化 outbound_ai_chat（Store.saveAiChat 截断 50 条，设置弹窗开关默认开）
- 首条 AI 消息：能力介绍 + 快捷 chips

---

## 5. 入口集成

| 入口 | 位置 | 实现 |
|---|---|---|
| 落地页浮动气泡 | #view-landing 右下角 fixed | landing.js render 末尾追加 `<button class="ai-fab" id="aiFab" title="AI 助手">🤖</button>`，click → Chat.openFloat()（免登录） |
| 管理后台侧栏 | app.js NAV_ITEMS 末尾 | `{id:"ai", icon:"box", label:"AI 助手"}`；VIEW_MAP ai:"ai"；MODULE_TITLES ai:"AI 助手" |
| 路由 | router.js KNOWN_MODULES | 新增 `ai:1` |
| 顶栏 | 不加 | 已有 ☁️ 按钮，避免拥挤 |

---

## 6. 文件清单

| 类别 | 文件 | 说明 |
|---|---|---|
| M | src/index.html | 追加 css/ai.css + 4 script（engine→llm→chat→views/ai，在 sync.js 后 main.js 前） |
| M | src/js/core/config.js | AI 常量（AI_KEY_KEY/AI_SETTINGS_KEY/AI_CHAT_KEY/AI_DEFAULT_MODEL/AI_MODELS/AI_BASE_URL/AI_TIMEOUT_MS/AI_CHAT_HISTORY_LIMIT/AI_CONTEXT_TOP_N/AI_CONTEXT_RECENT/AI_QUICK_CHIPS） |
| M | src/js/core/store.js | AI 存取 8 方法（loadAiKey/saveAiKey/clearAiKey/loadAiSettings/saveAiSettings/loadAiChat/saveAiChat/clearAiChat） |
| M | src/js/views/landing.js | FAB 气泡 + click 绑定 |
| M | src/js/router/router.js | KNOWN_MODULES 增 ai |
| M | src/js/views/app.js | NAV_ITEMS/VIEW_MAP/MODULE_TITLES 增 ai |
| A | src/js/ai/engine.js | 本地问答引擎 |
| A | src/js/ai/llm.js | DeepSeek 对接 |
| A | src/js/ai/chat.js | 聊天面板 |
| A | src/js/views/ai.js | 管理后台页面挂载 |
| A | src/css/ai.css | 面板/气泡/chips/表格/FAB/移动端 sheet |
| A | docs/system_design_v4_ai.md | 设计落盘（本文） |
| A | docs/ai-query-cases.md | 8 类 ≥20 句验收用例集 |
| A | docs/ai-acceptance.md | 验收清单 |
| K | 其余全部 | deploy.yml、legacy.html、qrcode.js、data/*、现有 views、base/layout/views.css 零改动 |

---

## 7. 硬约束对照

| 约束 | 落实 |
|---|---|
| `__GH_TOKEN_PLACEHOLDER__` 内联脚本与变量名不改 | index.html 内联块原样保留 |
| 记录 schema / 冻结 localStorage 键不改 | 未触碰 records.js / 冻结键 |
| AI Key 红线 | 仅 store.js 封装读写 localStorage（outbound_ai_key）；不进入 State.list / CSV / data/records / 云端 payload / 代码明文 |
| 不用 ES Module | IIFE + window.App.* 命名空间，经典 script 顺序加载 |
| XSS 防护 | 所有用户数据渲染前 Util.esc |
| 零新增第三方依赖 | 仅原生 fetch |
| 本轮零删除 | 只增量追加，不移动/删除现有脚本与文件 |
