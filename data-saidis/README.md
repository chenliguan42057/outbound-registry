# data-saidis/ — 赛迪斯仓库数据目录（与 data/ 物理隔离）

本目录存放「赛迪斯」出货仓库单位的全部业务数据，由前端 web app 在切换器选中「赛迪斯」后读写。
**深圳细胞（默认系统）数据在 `data/`，两套数据互不混淆。**

目录由 GitHub Contents API 在首次写入时自动创建（无需手工建空目录）：

| 子目录 | 内容 |
|---|---|
| `catalog/catalog.json` | 赛迪斯产品目录 + 库存快照（首次为空，保存后自动生成） |
| `catalog/notifications/` | 产品目录变更提醒 |
| `records/` | 出入库记录（`<id>.json`） |
| `pickups/` | 待取货记录 |
| `memos/` | 备忘录 |
| `deleted/` | 删除墓碑（回收站/多端同步） |
| `stocktakes/` | 盘点记录 |
| `photos/` | 照片 |
| `notify/` | 通知/推送标记 |
| `audit/` | 审计（如启用） |

> 本 README 仅作目录占位与说明，不会被前端当作数据解析。
> `data-saidis/**` 已在 deploy.yml paths-ignore 中排除——赛迪斯数据提交不会触发全站重新部署。
