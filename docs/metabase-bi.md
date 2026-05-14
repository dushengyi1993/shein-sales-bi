# SHEIN BI / Metabase 部署说明

## 本机访问

- 当前地址：通过 WSL IP 访问，例如 `http://172.22.172.186:3000`
- 当前原型仪表盘：`http://172.22.172.186:3000/dashboard/5`
- `localhost:3000` 当前未强制打通，因为 Windows `portproxy` 需要管理员权限；不影响 Metabase 使用。
- 如果后续希望固定为 `http://localhost:3000`，再用管理员 PowerShell 配一次端口转发即可。
- 启动脚本：`scripts/start_metabase_wsl.ps1`
- Metabase 初始化脚本：`scripts/setup_metabase_instance.mjs`
- BI 原型生成脚本：`scripts/setup_metabase_bi.mjs`
- BI 专题页生成脚本：`scripts/setup_metabase_bi_perspectives.mjs`
- Compose 目录：`infra/metabase`
- 本机 Docker 数据盘：`D:\SheinBI\docker-data\docker-data.ext4`
- WSL 发行版位置：`D:\WSL\Ubuntu-24.04`

## 当前初始化状态

- Metabase 已完成首次初始化。
- 已连接数据库：`SHEIN BI Warehouse`。
- 已创建集合：`SHEIN BI 原型`。
- 已创建仪表盘：`SHEIN 经营驾驶舱 · 原型`，Dashboard ID `5`。
- 已创建 3 个专题仪表盘：
  - `SHEIN BI · 店铺视角`，Dashboard ID `6`，地址 `http://172.22.172.186:3000/dashboard/6`
  - `SHEIN BI · 货号视角`，Dashboard ID `7`，地址 `http://172.22.172.186:3000/dashboard/7`
  - `SHEIN BI · 链接/SKC视角`，Dashboard ID `8`，地址 `http://172.22.172.186:3000/dashboard/8`
- 已创建 10 张原型分析卡片：
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

专题页对应的 BI 友好视图已经写入 `infra/warehouse/schema.sql`：

- `mart.bi_store_overview_current`
- `mart.bi_store_product_matrix_current`
- `mart.bi_product_overview_current`
- `mart.bi_link_health_current`
- `mart.bi_action_queue_current`

管理员登录信息只保存在本机忽略提交的文件中：

- `infra/metabase/.admin.local.json`
- `infra/metabase/.session.local.json`

不要把这些文件提交或发到聊天里。

## 目录职责

- `infra/metabase/docker-compose.yml`：Metabase、Metabase 自身数据库、SHEIN 数据仓库数据库。
- `infra/metabase/.env`：本机运行配置，包含本机数据库密码，不提交到 Git。
- Docker 卷 `shein-bi_metabase-postgres`：Metabase 自己的配置库数据，实际位于 D 盘 Docker 数据盘。
- Docker 卷 `shein-bi_warehouse-postgres`：SHEIN BI 数据仓库数据，实际位于 D 盘 Docker 数据盘。
- Docker 卷 `shein-bi_metabase-plugins`：Metabase 插件目录，实际位于 D 盘 Docker 数据盘。

## 服务说明

- `metabase`：BI 系统网页。
- `metabase-db`：Metabase 自己的配置库，保存账号、问题、仪表盘等。
- `warehouse-db`：给 SHEIN 销售、链接、库存、建议规则准备的数据仓库。

## 未来迁移到服务器

1. 把 `infra/metabase/docker-compose.yml` 和 `.env` 放到服务器。
2. 通过 Docker 卷备份恢复 Metabase 配置库；SHEIN 数据仓库也可从 SHEIN 抓取脚本重新导入。
3. 在服务器安装 Docker / Docker Compose。
4. 在 `infra/metabase` 下执行 `docker compose up -d`。
5. 如果需要给同事访问，建议先加内网访问或反向代理，再加账号权限，不直接裸露到公网。

## 当前设计原则

- Metabase 负责 BI 分析、筛选、钻取；当前仍是正式 BI 深度分析层，不能因为 Java/JVM 内存占用就直接删除或跳过。
- SHEIN 抓取、库存菜单接口、链接建议规则仍由本项目脚本负责。
- 飞书 Base 继续作为协作底表，但不再依赖飞书 Dashboard 做复杂 BI。
- 新 BI 系统优先跑在 WSL + Docker + D 盘数据盘上，方便未来迁移到服务器；云端迁移时应按 PostgreSQL + Metabase + BI Portal 一起部署和验证。
- 现有飞书同步、销售日报、Windows 计划任务和已稳定的 SHEIN Windows Chrome 登录态暂不迁移，直到 BI 系统验证可替代。

## Windows / WSL 边界

当前不是“全部切到 WSL”，而是分阶段迁移：

1. **现有生产链路继续在 Windows 跑**
   - 销售抓取、飞书 Base 同步、日报、计划任务继续按原时间执行。
   - 这些任务依赖现有 Windows Chrome profile、`lark-cli` 授权和 Windows 计划任务，贸然搬迁风险较高。

2. **新 BI 底座放到 WSL/D 盘**
   - Metabase、Metabase 配置库、SHEIN 数据仓库都通过 Docker 跑在 WSL。
   - Docker 数据根位于 `D:\SheinBI\docker-data\docker-data.ext4`，不是 C 盘。
   - WSL 发行版本身位于 `D:\WSL\Ubuntu-24.04`，不是 C 盘。

3. **后续逐步替换**
   - SHEIN 抓取结果先继续同步飞书，同时写入本地数据仓库。
   - BI 系统跑稳后，再决定哪些飞书表/看板/日报可以下线。
   - 未来迁移到朋友服务器时，优先迁移 Docker Compose、数据库和 BI 层，抓取层再根据登录态和权限方案调整。

