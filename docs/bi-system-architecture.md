# SHEIN BI 系统架构初版

更新时间：2026-05-15

## 结论

后续方向不是继续堆飞书看板，也不是把本地网页做成越来越复杂的静态页面，而是建设一个可迁移、可扩展的 BI 系统：

```mermaid
flowchart LR
  A["SHEIN 后台 WebAPI / 官方 OpenAPI"] --> B["抓取与标准化脚本"]
  B --> C["PostgreSQL 数据仓库"]
  C --> D["Metabase BI"]
  C --> E["自定义实操台"]
  B --> F["飞书 Base 过渡层"]
  F --> G["现有日报/协同表"]
```

## 设计原则

1. **飞书先保留，不再作为新 BI 的源头**
   - 飞书日报继续作为推送渠道；飞书多维表格 / 看板写入当前已临时暂停。
   - 新 BI 不从飞书反抓数据，而是从 SHEIN 抓取后直接入仓。

2. **数据仓库才是真正底座**
   - 原始响应、标准化事实、派生指标、规则建议分层保存。
   - 所有 BI 和网页操作台都从数据仓库读取。

3. **Metabase 做分析，实操台做流程**
   - Metabase 负责筛选、钻取、趋势、店铺/货号/SKC 多维分析，当前仍是正式深度分析层，不能在没有替代前删除。
   - 自定义网页负责“今天该处理什么、复制 SKC、标记已处理、分配同事、备注”。

4. **云端为正式入口，本地只作回滚**
   - 自 `2026-05-15` 起，云端 BI 是正式入口，本地 `8787` 服务和 `SHEIN-*` Windows 任务已封存。
   - 本机 WSL + Docker + D 盘数据盘只保留为开发、排障和短期回滚参考。

5. **生产链路逐步 API 化，不冒险硬迁移**
   - 云端首阶段生产调度只覆盖销售 WebAPI、入仓、BI Portal 生成和数据库备份；链接/业务域、ET、完整 RTV、飞书日报和 HL OpenAPI 双跑需要逐项云端化。
   - SHEIN 销售抓取已改为 WebAPI 直连优先，Chrome 登录态保留为 Cookie/session 刷新和失败回退；官方 OpenAPI 继续并行试点，不直接覆盖生产事实表。

## 当前服务

云端正式运行：

- `shein-metabase`：Metabase BI 页面；
- `shein-metabase-db`：Metabase 自身配置库；
- `shein-warehouse-db`：SHEIN 数据仓库 PostgreSQL。

已初始化数据仓库 schema：

- 初始化脚本：`scripts/init_bi_warehouse.ps1`
- Schema 文件：`infra/warehouse/schema.sql`
- 入仓脚本：`scripts/load_bi_warehouse.mjs`

云端存放位置：

- 代码目录：`/opt/shein-bi/app`
- 数据库备份目录：`/srv/shein-bi/backups/auto`
- Compose 配置：`infra/metabase/docker-compose.yml`

访问：

- 云端 BI Portal：`http://43.165.167.135/`，Nginx Basic Auth 保护。
- Metabase 运行在云端 Docker 内部，不在文档中写公网裸地址；本地旧 WSL 地址只作历史排障参考。
- Metabase dashboard 编号仍可作为内部迁移参考，但不要使用旧本地 WSL IP 作为正式入口。

## 当前运行态（2026-05-15）

BI 系统当前分为三层入口：

1. **飞书生产链路**
   - Base 表格 / Dashboard 写入由 `state/feishu-base-sync-paused.flag` 暂停。
   - 飞书日报和异常提醒的本地历史任务已封存，后续需要云端化后再恢复自动推送。
   - SHEIN 抓数和 BI 刷新不得因飞书 Base 暂停而中断。
   - 销售源文件当前由 WebAPI 直连优先生成；直连失败时才回退 Chrome。

2. **Metabase 分析层**
   - 连接 PostgreSQL 数据仓库。
   - 负责深度筛选、钻取、跨表分析和后续趋势分析；当前云端必须一起部署，除非后续自研门户已经完整替代这些能力。
   - 管理员凭据只保存在 `infra/metabase/.admin.local.json`，不要写入文档或聊天。

3. **云端 BI 经营门户**
   - 文件入口：`outputs/bi-portal/index.html`
   - 云端入口：`http://43.165.167.135/`
   - 负责“每天先看什么、先处理什么、如何复制指令、如何标记处理状态”。
   - 本地 `127.0.0.1:8787` 和局域网入口已封存，不再作为正式入口。
   - 短期动作状态仍为服务端状态文件，长期应入 PostgreSQL，避免文件状态成为单点。
   - 系统状态页已接入 `mart.openapi_sales_reconciliation`，展示 HL 官方 OpenAPI 销售试点与当前生产销售源的对账状态；该试点暂不覆盖正式销售事实表。

当前团队访问状态：

- 已具备：云端公网入口、Basic Auth、服务端动作状态文件、深链接、动作清单复制、CSV 导出、系统巡检页。
- 未完成：域名、HTTPS、多人编辑冲突控制、动作状态入库、异地备份和权限分级。

当前自动任务状态：

- 云端 `shein-bi-cloud-today.timer`：北京时间 `00:10/02:10/.../22:10`，刷新当天销售、入仓并生成 BI Portal。
- 云端 `shein-bi-cloud-yesterday.timer`：每天 `00:10`，刷新前一天最终销售并复核前两天稳定日。
- 云端 `shein-bi-db-backup.timer`：每天 `02:30`，备份业务库和 Metabase 元数据库。
- 本地 `SHEIN-BI-Daily-Pipeline-0700`、`SHEIN-Sales-15Stores-LinkManagement-0530`、`SHEIN-Sales-ETForwarder-0420` 等 Windows 任务已封存禁用，仅保留为回滚/迁移参考。

## 数据分层

### 1. 原始层 `raw`

保存从 SHEIN 接口拿到的原始响应摘要和完整 JSON 文件索引：

- 抓取时间；
- 店铺；
- 页面/接口；
- 日期范围；
- 原始文件路径；
- 响应状态和错误。

用途：排错、字段追溯、未来补字段。

### 2. 明细事实层 `fact`

按业务实体拆成稳定事实表：

- `fact_order`
- `fact_order_item`
- `fact_product_daily_sales`
- `fact_link_master_snapshot`
- `fact_link_performance_daily`
- `fact_display_inventory_daily`
- `fact_after_sales`
- `fact_fulfillment_daily`
- `fact_marketing_campaign_daily`
   - OpenAPI 并行试点表：`fact.openapi_store_daily_sales`、`fact.openapi_order_header`、`fact.openapi_order_item`。这些表只用于官方 OpenAPI / 当前生产销售源双跑验证，正式切换前不作为首页和日报的生产销售源。

用途：Metabase 的主要数据源。

### 3. 维度层 `dim`

保存相对稳定的解释字段：

- `dim_store`
- `dim_product`
- `dim_skc`
- `dim_link`
- `dim_category`
- `dim_site`
- `dim_activity`

用途：跨主题关联和筛选。

### 4. 派生指标层 `mart`

按使用场景做聚合宽表：

- `mart_store_daily`
- `mart_product_store_coverage`
- `mart_link_action_candidates`
- `mart_link_health_score`
- `mart_product_opportunity`
- `mart_inventory_risk`
- `mart.openapi_sales_reconciliation`：官方 OpenAPI 试点与当前生产销售源的日维度对账表，记录销售额、订单数、商品行数、源文件和 `matched` / `warning` 状态。

用途：BI 看板、日常筛选、实操台。

### 5. 规则建议层 `ops`

保存系统建议和人工处理状态：

- `ops_action`
- `ops_action_history`
- `ops_assignment`
- `ops_note`

用途：后续团队协作。

## 当前入仓状态（2026-05-06 截面）

当前 BI 仓库已经按 16 店写入 `2026-05-06` 销售截面，业务域和链接表现为前一完整业务日 `2026-05-05`：

- 销售日期：`2026-05-06`
- 业务日期：`2026-05-05`
- 链接日期：`2026-05-05`
- 当前侧栏源抓取时间：销售 `2026-05-06T10:10:13.337+08:00`；业务域 `2026-05-06 05:46:42`；链接 `2026-05-06 05:37:48`。
- 店铺覆盖：`CX DL DX FY HL JY LQ MZ NM QH QY TS TZ XL YJ ZL`
- 已覆盖业务域：销售订单、订单商品、链接主数据、链接表现、货号店铺覆盖、链接建议、售后/退货、发货面单、正确展示库存、商品质量、商品评价、营销活动、首页财务摘要、gsfs 财务收入概览、gsfs 在途收入订单。

当前已知限制：

- gsfs 财务收入概览仍受接口/验证限制，完整财务结算流水需要后续继续补。
- 趋势、排行、利润和评价已按当前仓库数据驱动；仍不得用假环比或假趋势填充缺失数据。
- `2026-05-05` Docker / WSL 文件系统异常已手动恢复；`2026-05-06` 正式自动任务已跑通，系统状态页不应再把该历史恢复态标成待验证。

重要实现细节：

- 入仓脚本按 `日期 + 店铺` 删除旧切片后重写，避免同一天同店重跑后旧明细残留。
- 2026-05-10 已用稳定日期重抓对账验证 16 店 profile 与登录抓数未错位；profile 错位排查以接口数据和数据库样本为准，不以页面散落文本为准。
- 门户系统状态页会同时显示正式自动任务日志和最新手动验证日志，避免把手动成功误认为自动成功。

## 第一批 BI 页面建议

### 经营首页

当前已落地第一版原型，包含：

- 今日销售额；
- 今日订单数；
- 今日重点动作数；
- 潜在下架候选数；
- 店铺经营矩阵；
- 货号销售与链接覆盖；
- 今日链接实操池；
- 潜在下架候选明细；
- 链接状态分布；
- 商品分析漏斗 Top。

这一版的目标不是最终 UI，而是验证 Metabase 能否围绕店铺、货号、SKC/链接和实操动作进行多维钻取。

为降低 Metabase 卡片 SQL 复杂度，当前已在数据仓库补充 5 个 BI 友好视图：

- `mart.bi_store_overview_current`：店铺经营总览；
- `mart.bi_store_product_matrix_current`：店铺 × 货号覆盖与销售矩阵；
- `mart.bi_product_overview_current`：货号总览；
- `mart.bi_link_health_current`：链接/SKC 健康分层；
- `mart.bi_action_queue_current`：当前实操队列。

- 今日/昨日/本月销售额；
- 店铺排行；
- 货号排行；
- 销售趋势；
- 异常提醒：销售下滑、缺链接、待上架卡点、库存风险。

### 店铺视角

- 一个店铺的销售趋势；
- 店铺内热销/滞销货号；
- 店铺内缺链接货号；
- 店铺内待优化链接；
- 店铺内库存/履约/售后异常。

### 货号视角

- 一个标准货号在 16 店的上架覆盖；
- 各店销量；
- 各店链接状态；
- 同货号多链接优胜劣汰；
- 是否有店铺缺链接但其他店表现好。

### SKC / 链接视角

- 某条链接的曝光、点击、商详、加车、支付、销量趋势；
- 标签、活动、质量、评论、退货；
- 库存展示数和库龄；
- 优化/下架建议原因。

### 操作台

- 今日重点处理；
- 补链接；
- 待上架卡点；
- 优化候选；
- 下架候选；
- 库存调整；
- 复核项。

## 库存口径

库存不再从 `备货信息` 判断。

当前 BI 使用商品列表库存接口作为正确展示库存来源：

- `/spmp-api-prefix/spmp/product/query_msc_stock_for_released_page`

调用时必须传完整 SKC/SKU 结构：

- `spu_skc_list[].spu_name`
- `spu_skc_list[].skc_name_list[].skc_name`
- `spu_skc_list[].skc_name_list[].sku_code_list`

如果少传 `sku_code_list`，接口可能返回错误的 `0` 库存。

`库存 / 库龄列表` 仍作为后续可研究入口保留：

- 路由：`#/gsp/inventory-management/storage-age`
- 接口：`/gsp/storage/stockAge/list`

但第一阶段库存预警已经不依赖库龄列表。当前“库存动作”只保留：

- 低库存行本身处于 `ON_SHELF`；
- 最近 30 天有链接销量或订单销量；
- 全部待上架、全部售罄、全部下架、无销售迹象的低库存行不进入今日动作池。

## 迁移路线

### 阶段 1：本机 BI 基座（已完成，现为回滚参考）

- Metabase 跑起来；
- PostgreSQL 数据仓库跑起来；
- SHEIN 后台数据地图完成；
- 现有销售/链接数据双写入仓。

### 阶段 2：Metabase 原型

- 经营首页；
- 店铺视角；
- 货号视角；
- SKC/链接视角；
- 规则建议视角。

### 阶段 3：自定义实操台

- 读取 `ops_action`；
- 支持复制 SKC、备注、标记处理、分配同事；
- 处理状态回写数据库，必要时同步飞书。

### 阶段 4：团队访问（云端进行中）

- 云端临时公网入口 + Basic Auth 已启用；
- 本地局域网入口已封存；
- 下一步补域名、HTTPS、异地备份、动作状态入库和权限分级。

## 与飞书的关系

短期：

- 每天按时抓取、刷新 BI、发飞书日报；
- 飞书多维表格 / 看板写入暂停保留查档；
- 新 BI 系统做旁路验证。

中期：

- 飞书 Base 只保留协作和人工确认用表；
- 复杂 BI 继续由 Metabase 承接，同时把高频经营动作沉淀到 BI Portal；在自研门户完全覆盖自由钻取前，不下线 Metabase。

长期：

- 如果 BI + 操作台稳定，飞书看板可以逐步下线；
- 飞书日报可保留为推送渠道，而不是数据底座。


