# 出入库登记系统（outbound-registry）

深圳细胞（主仓）与赛迪斯（副仓）两仓共用的出入库登记 Web App。
纯静态页面，没有服务器，**用 GitHub 仓库当数据库**，手机扫码即用。

- 线上：https://chenliguan42057.github.io/outbound-registry/
- 仓库：https://github.com/chenliguan42057/outbound-registry

---

## 目录

1. [一分钟了解它在干嘛](#一分钟了解它在干嘛)
2. [技术架构（一句话版）](#技术架构一句话版)
3. [目录结构速查](#目录结构速查)
4. [双仓是怎么隔离的](#双仓是怎么隔离的)
5. [改代码前必须知道的六条铁律](#改代码前必须知道的六条铁律)
6. [提交 → 部署 → 验证](#提交--部署--验证)
7. [线上开关（出问题时的止血手段）](#线上开关出问题时的止血手段)
8. [已知问题](#已知问题)
9. [常见操作速查](#常见操作速查)

---

## 一分钟了解它在干嘛

仓库同事扫码打开网页，登记"谁领了什么、领了多少、给哪个部门/客户"，可拍照。
登记完本地立刻生效，后台慢慢同步到云端和金山台账，钉钉群自动收到通知。

主要模块：待取货 / 出库 / 入库 / 备忘录 / 库存 / AI 助手 / 报表 / 借用归还。

---

## 技术架构（一句话版）

**浏览器本地存储优先 + GitHub 仓库当云端 + GitHub Actions 当后台。**

```
用户操作 → 写 localStorage（立刻生效）
        → 后台推送 → GitHub Contents API 写 data/*.json
                   → Actions 触发 → 钉钉 / 金山台账
```

所以：断网能登记，关页面不丢，换设备能同步回来。

- 零依赖：**没有 npm、没有打包器、没有框架**，直接 `index.html` 打开就能跑
- 全站代码约 18,000 行 JS + 4,000 行 CSS（未压缩约 800KB，已全部 `defer` 加载）
- 44 个脚本按依赖顺序加载，**不要随意调整 index.html 里的顺序**

---

## 目录结构速查

```
src/
├── index.html              唯一入口，所有脚本在这里按顺序引入
├── js/
│   ├── main.js             启动入口
│   ├── core/               config（配置与实体）/ util（工具）/ store（本地存储）
│   ├── data/               cloud.js（★云端同步核心，1369 行）/ records.js / stock.js / catalog.js
│   ├── views/              out.js 出库 / in.js 入库 / records.js 列表 / stock.js 库存
│   │                       sync.js 云同步 / report.js 报表 / ai.js / app.js 外壳
│   ├── ui/                 components.js（通用组件）/ icons.js / sound.js / ux.js
│   └── ai/                 AI 助手（engine / chat / tools / llm …）
├── css/                    core.css / theme.css / patch.css / wallpaper.css
└── qrcode.js               第三方二维码库

data/                       ★ 深圳仓数据（记录、照片、备份）
data-saidis/                ★ 赛迪斯仓数据（结构完全一致）
.github/
├── workflows/              23 个自动化流程（部署、备份、钉钉推送…）
└── scripts/                16 个 Python 推送脚本
```

---

## 双仓是怎么隔离的

| | 深圳细胞（主） | 赛迪斯（副） |
|---|---|---|
| 数据目录 | `data/` | `data-saidis/` |
| 目录结构与命名 | 两边**必须完全一致** | 同左 |

改任何读写逻辑时，**写操作落在哪个目录要看清楚**，写错就是把 A 仓数据塞进 B 仓。

---

## 改代码前必须知道的六条铁律

这几条都是踩过坑换来的，违反会直接导致线上事故。

1. **deploy.yml 有 19 项防回滚守卫。** 它会 grep 关键字符串（如 `src/js/views/out.js` 必须含 `DEFAULT_ENTITY`）。
   删除或改名被守卫引用的功能/字符串，**必须同步更新守卫**，否则部署直接失败。
2. **JS 文件必须是 LF 行尾。** 只能用精确字符串编辑，**禁止用脚本整文件重写**（会变成 CRLF，git 会显示整文件假差异）。
3. **push 前先 `git pull --rebase origin main`。** Actions 会频繁产生数据提交，直接推大概率被拒。
4. **同一文件的多处修改必须串行编辑。** 并行编辑会互相写回旧内容，导致只落地一处且**不报错**。每改完一处立刻 grep 校验。
5. **所有 GitHub API 读写走 `cloud.js` 封装**（15 秒超时 + 幂等 sha + 3 次退避 + 写串行链），不要新写裸 fetch。
6. **CSS 只认 index.html 里 link 的那 4 个文件。** 新增样式挂 link 或并入现有文件，否则不生效。

---

## 提交 → 部署 → 验证

```bash
node --check <改动的文件>        # 1. 语法校验
git add . && git commit -m "..."  # 2. 中文 message，写清"改了什么、为什么"
git pull --rebase origin main     # 3. 拉取（Actions 会产生数据提交）
git push origin main              # 4. 推送触发部署
```

推送后按顺序确认：

1. 打开 Actions 看 `deploy.yml` 是否 `success`
2. `curl https://chenliguan42057.github.io/outbound-registry/version.txt` 应等于新提交短 SHA
3. `curl` 对应的 js/css 文件，grep 本次新增的标记串，确认真的上线了

**push 撞 443 超时（curl 28）时先重试 1–2 次**，多半是限速，不必立刻换通道。

---

## 线上开关（出问题时的止血手段）

在网址后加参数回车即可，30 秒内生效，不用改代码不用重新部署。

| 参数 | 作用 |
|---|---|
| `?smooth=0` | 一键关闭顺捷感三件套（乐观 UI / 删除撤销条 / 左滑手势），回到旧交互 |
| `?smooth=1` | 恢复开启 |
| `?audit=1` | 恢复"删除时必须填理由"的严格模式 |
| `?v2=0` | 关闭新版视觉（渐变背景 + SVG 图标） |

例：`https://chenliguan42057.github.io/outbound-registry/?smooth=0`

---

## 已知问题

| 级别 | 问题 |
|---|---|
| 🔴 P0 | `src/js/views/sync.js` 里硬编码了明文 GitHub 令牌，且已推上公开仓库。任何人拿到即可改删数据。**必须先删明文改回构建注入，再轮换令牌**，只轮换无效 |
| 🟠 P1 | 业务数据存在公开仓库（145 条记录 + 23 张照片） |
| 🟠 P1 | 无服务端校验，前端直写 Contents API，无审计留痕 |
| 🟠 P1 | `cloud.js` 单文件 1369 行，改动牵一发动全身 |
| 🟡 P2 | 无自动化测试，无构建流程，正确性靠语法检查 + grep 自检 + 真机验证 |
| 🟡 P2 | 提交历史里有大量 Actions 产生的 `update mtxxxx` 噪音 |

---

## 常见操作速查

| 想做的事 | 去哪改 |
|---|---|
| 加一个表单字段 | 对应 `views/out.js` 或 `in.js` 的 payload，再到 `views/records.js` 的行模板加列 |
| 改产品目录 | `data/catalog.js` |
| 改低库存阈值 / 结算法人默认值 | `js/core/config.js` |
| 改钉钉推送内容 | `.github/scripts/*.py` |
| 改视觉样式 | `css/patch.css`（业务补丁）或 `css/wallpaper.css`（V2 视觉层） |
| 手动补推没上云的记录 | 网页端「管理 → 云同步 → 一键重推」 |
| 数据误删想找回 | `data/backups/` 里找快照（保留最近 7 天，每月 1 号永久留一份） |

> 速记口诀：**先本地、后云端；先语法、后推送；先 grep、再部署。**
