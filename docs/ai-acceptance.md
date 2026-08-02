# AI 助手验收清单（v4.0）

> 版本：v4.0（T05 产出，Engineer）｜关联：docs/system_design_v4_ai.md、docs/ai-query-cases.md
> 说明：自动化冒烟结果见下方「冒烟测试结果」；手工回归项需在线上验证。

## 一、自动化验收（Node 冒烟，全部通过）

| # | 验收项 | 判定 |
|---|--------|------|
| 1 | 8 类 ≥27 句用例逐条命中（docs/ai-query-cases.md） | ✅ |
| 2 | 产品匹配规格数：冻干→4、面膜→2、牛皮纸袋→2、150ml→2 | ✅ |
| 3 | normalize 去标点/小写/trim | ✅ |
| 4 | LLM.buildSystemContext 结构完整（TOP15/低库存数/今日出库/最近10条/总数） | ✅ |
| 5 | LLM 错误归一化：401/403→invalid-key、429→rate-limit、5xx→server、Abort→timeout、reject→network | ✅ |
| 6 | Store AI 存取：saveAiKey/loadAiKey/clearAiKey、settings、chat 截断 50 | ✅ |
| 7 | 全量 JS node --check 语法通过（含新增 4 文件与现有全部） | ✅ |

## 二、代码级验收（全局一致性审查）

| # | 验收项 | 判定 |
|---|--------|------|
| 1 | window.App.AI.{Engine,LLM,Chat} 与 window.App.Views.ai 注册/引用一致 | ✅ |
| 2 | index.html 脚本顺序：engine→llm→chat→views/ai，位于 sync.js 后、main.js 前 | ✅ |
| 3 | router KNOWN_MODULES / app VIEW_MAP / MODULE_TITLES / NAV_ITEMS 四处映射一致（ai） | ✅ |
| 4 | AI Key 不出现明文：outbound_ai_key 仅 store.js/config.js；无真实 key 字符串 | ✅ |
| 5 | localStorage 冻结键未改名；__GH_TOKEN_PLACEHOLDER__ 内联未动 | ✅ |
| 6 | CSS 使用现有设计令牌（--primary/--grad-main/--border/--shadow 等） | ✅ |
| 7 | 零新增第三方依赖（仅原生 fetch）；本轮零删除（只增量） | ✅ |

## 三、手工回归（线上验证项）

- [ ] 落地页 FAB 右下角出现，点击打开浮动聊天面板（免登录）
- [ ] 管理后台侧栏出现「AI 助手」，#/app/ai 内嵌面板渲染正常
- [ ] 快捷 chips 可点击发送；输入 Enter/按钮发送
- [ ] 本地 8 类查询在断网/无 Key 下全部可答
- [ ] 清空对话二次确认；设置弹窗保存/清除 Key/测试连接
- [ ] 移动端（375px）面板为全宽 sheet，输入不遮挡，chips 可横向滚动
- [ ] 出库登记/库存/记录/报表/云端同步/二维码落地页回归不受影响
- [ ] 部署后云端写入正常（__GH_TOKEN_PLACEHOLDER__ 注入链路未破坏）

## 四、冒烟测试结果（2026-08-02 执行）

- `qa_v4/smoke_test.js`：**87/87 PASS，退出码 0**（27 句 8 类逐条命中 + 产品匹配规格数 + LLM 结构/错误归一化 + Store 存取截断 50）
- `qa_v4/load_all_test.js`：全量 23 文件按 index.html 顺序加载 OK，main.js 启动不抛异常，AI 命名空间全部就位
- 全量 JS `node --check`：24 个文件语法全部通过
- 全局一致性审查：**IS_PASS: YES**（详见第二节）
