# css-archive / 已归档样式（勿改、勿挂载）

这些文件的内容在历史演进中已被合并进 `css/core.css`（基础层）与 `css/theme.css`（主题快照），
**当前页面只加载 `core.css` + `theme.css` + `patch.css` 三个文件，本目录文件一律未被引用、改动无效。**

归档原因（2026-09-05 复盘）：曾因 `patch.css` 未被页面引用导致多轮样式修改不生效的严重事故，
为避免同类问题再次发生，把所有"看起来在、实际不生效"的样式文件移出 `css/`，集中放在本目录备查。

- `base.css` — 设计令牌/reset/按钮表单基础（早期被并入 core.css / theme.css）
- `layout.css` — 应用壳布局（侧栏/顶栏/内容区）
- `views.css` — 落地页与业务页面样式（POS 遗留类曾标注可清理，见 docs/PRD_v3.0.md）
- `ux.css` — 主题切换 data-theme 逻辑样式
- `ai.css` — AI 助手面板/气泡样式
- `wallpaper.css` — 植物壁纸样式
- `fresh-mint-theme.css` — 青屿主题的"源文件"（当前生效版本在 theme.css 内）

## 想给系统改样式怎么办？

1. 改 `src/css/patch.css`（修补层，最后加载，可覆盖 theme.css 规则）—— 高频小改动首选；
2. 改 `src/css/theme.css`（主题快照）—— 需要动主题变量/大块布局时；
3. 改 `src/css/core.css` —— 基础/重置层。
4. 新增独立 css：必须同时在 `src/index.html` 里加 `<link>`，否则不会生效。

需要找回某份归档样式：`git log` / `git checkout` 本目录文件即可，内容一直保存在版本历史中。
