# SHEIN 销售统计与 BI 经营系统

SHEIN 当前 19 店销售、库存、链接、营销活动和利润经营 BI / 自动运营工作区。生产以云端 BI、PostgreSQL warehouse、Metabase 与受控 OpenAPI 执行链为准。

## 核心规则

- **BI 判断只认云端运行时**：云端 PostgreSQL、线上 BI 门户、`/api/bi/section/*`、云端日志和 systemd 状态；仓库 `outputs/bi-portal/*` 只是灾备/兼容快照。
- **本地 BI 已封存**：本地 `8787`、`SHEIN-*` Windows 计划任务和本地抓数任务只作回滚参考，除非明确回滚不得恢复。
- **飞书 Base / 原生看板写入暂停**：`state/feishu-base-sync-paused.flag` 存在时不写 Base/看板；飞书日报、异常提醒和只读问数走云端消息链路。
- **SHEIN OpenAPI 写操作受控**：默认 dry-run；真实提交必须满足账号权限、白名单、人+店+动作、payloadHash/确认码、任务审核和回读审计。
- **云端部署纪律**：GitHub release 是源码基线，不等于已部署；云端热修必须回填 GitHub，服务器拉取/重置后必须重跑云端 BI 刷新。

## 关键入口

| 项 | 值 |
|---|---|
| 店铺范围 | 19 店：`CX DL DX FY HL JSH JY LQ MZ NM QH QY TS TZ TZZ XC XL YJ ZL` |
| 分组 | DSY：`DL DX FY LQ NM HL JY ZL TS MZ`；LGM：`CX YJ XL QY QH TZ JSH TZZ XC` |
| BI 入口 | `https://sa.dushengyi.cc/`（应用内登录 + `bi_session`） |
| 云端维护入口 | `https://sa.dushengyi.cc/cloud-login-maintenance` |
| 云端代码目录 | `/opt/shein-bi/app` |
| 云端 SSH | `ssh shein-bi-tencent` |
| 飞书 Base | `https://zcnm3ts63aph.feishu.cn/base/SnnQbrAu6aLzMWsnEICcy0cKnJh`（写入暂停） |

## 核心业务口径

- 统计日为北京时间自然日；销售按 SHEIN 订单创建时间。
- 固定汇率：`1 SAR = 1.8 RMB`。
- 销售有效性统一走 `lib/shein_sales_validity.mjs`：源头总销售只剔除真正取消/揽收前取消；退款、退货、派件失败等保留为总销售，再由净销售、售后和利润层反转。
- 首页和成本/利润页使用真实利润；成本未覆盖必须显示缺口，不能用 `25%` 估算冒充真实利润。
- ET 实盘库存是库存真相源；SHEIN 前台展示库存只用于店铺链接展示矩阵，不等于总库存。

## 目录

- `config/`：店铺、分组、汇率、货号归并、营销定价、飞书日报配置。
- `lib/`：共享业务口径、归一化、营销定价、OpenAPI payload 逻辑。
- `scripts/`：抓取、同步、BI 入仓、门户生成、OpenAPI/营销/链接运营脚本。
- `docs/`：架构、运维、数据模型、脚本清单、OpenAPI 和营销规则。
- `infra/`：Metabase、PostgreSQL、Docker 和云端基础设施配置。
- `skills/`：项目专用 agent skills。
- `state/`、`profiles/`、`outputs/`、`logs/`：本地/云端运行态、登录态、输出和日志；敏感运行态默认不进 GitHub。

## 常用命令

> 生产命令默认在云端 `/opt/shein-bi/app` 执行；本地命令主要用于开发、dry-run、审计或受控执行。

- 刷新销售 + BI Portal：`bash scripts/cloud_bi_refresh.sh <scope> intraday`（`<scope>` 按运维文档取值）
- 刷新历史最终版：`bash scripts/cloud_bi_refresh.sh <scope> final`（`<scope>` 按运维文档取值）
- 备份数据库：`bash scripts/cloud_db_backup.sh`
- 同步 ET 货代仓：`bash scripts/cloud_et_forwarder_sync.sh <scope>`（`<scope>` 按运维文档取值）
- 跑云端 watchdog：`node scripts/cloud_ops_watchdog.mjs --dry-run`
- OpenAPI 商品/链接运营 CLI：`node scripts/bi_ops_cli.mjs --help`
- 批量复制商品到多店：`node scripts/link_ops_hl_openapi_executor.mjs --help`（支持 `supplyPriceRange`、`shuffleImages`、`inferInputCurrentOverride`、`skipPayloadHashLock`）
- 批量下架候选生成与执行：`node scripts/build_link_retire_candidates_from_csv.mjs --help`；`node scripts/execute_retire_candidates_openapi.mjs --help`
- 限时折扣漂移自动修复：`node scripts/marketing/guard_limited_discount_drift.mjs --guard <guard-json>`（先判断漂移，有则自动批量修复）
- 修复已下架但货号未改：`node scripts/repair_retire_supplier_code_openapi.mjs --help`（云端专用，只调 `partialEdit`）

更多脚本、废弃边界和示例见 `docs/scripts-inventory.md`。

## 工具说明

- 默认用后台、headless、HTTP/CDP、日志、JSON、静态检查和 UI 冒烟脚本验证；只有登录、人机校验、用户明确要求或必须排查交互问题时才打开可见窗口，完成后关闭。
- SHEIN 销售抓取优先 Node WebAPI 直连；Chrome/CDP 主要用于导出/刷新 Cookie session、登录续期和 WebAPI 失败回退。
- 飞书消息/Base 使用 `lark-cli`；`config/lark_report.json` 必须保持合法 UTF-8 JSON。
- ET 货代仓默认 headless；OCR/验证码连续失败、登录态人工维护或用户明确要求时才临时打开可见窗口。
- 云端上传的临时文件、OpenAPI 素材、登录维护文件用完必须清理；状态、token、session、密钥和数据库 dump 不写入仓库、文档或聊天。

## 关键文档

| 主题 | 文档 |
|---|---|
| 运行环境架构 | `docs/runtime-architecture.md` |
| 其他 agent 云端优先交接 | `docs/agent-handoff-cloud-first.md` |
| 应急恢复备份边界 | `docs/emergency-recovery-backup.md` |
| BI 系统架构 | `docs/bi-system-architecture.md` |
| BI 运维说明 | `docs/bi-system-operations.md` |
| BI 门户 UI 口径 / priceScatter | `docs/bi-portal-ui-current.md` |
| BI 仓库模型 | `docs/bi-warehouse-model.md` |
| SHEIN 后台数据地图 | `docs/shein-backend-survey.md` |
| SHEIN 官方 OpenAPI 接入 | `docs/shein-openapi-integration.md` |
| OpenAPI/CLI 能力交接索引 | `docs/shein-openapi-dev-handoff-index.md` |
| OpenAPI 官方能力台账 | `docs/shein-openapi-official-capability-inventory.md` |
| OpenAPI API schema 索引 | `docs/shein-openapi-api-schema-index.md` |
| SHEIN WebHook 接收器设计 | `docs/shein-webhook-receiver-design.md` |
| 营销活动报名价格规则 | `docs/marketing-campaign-signup-pricing-rules.md` |
| 营销折扣自动化路线图 | `docs/marketing-automation-roadmap.md` |
| scripts 脚本清单与废弃边界 | `docs/scripts-inventory.md` |
| 数据模型 | `docs/data-model.md` |
| 实施路线 | `docs/implementation-roadmap.md` |
| 3 月参考表结构 | `docs/reference-month-table-structure.md` |
| 产品套图方法论 | `docs/product-image-suite-methodology.md` |
| 产品套图调研依据 | `docs/product-image-suite-research.md` |

## 维护原则

- README 只保留入口、红线、核心口径和文档索引；历史复盘、调度细节、UI 细则、产品套图方法论和脚本全集放入 `docs/`。
- 需要判断生产状态时，先查云端运行态；需要改写操作时，先 dry-run、审计、确认、回读。
