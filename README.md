# SHEIN 销售统计与 BI 经营系统

SHEIN 当前 19 店销售、库存、链接、营销活动和利润经营 BI / 自动运营工作区。生产以云端 BI、PostgreSQL warehouse、Metabase、DL 单一半托 OpenAPI App 下的 19 店授权与受控执行链为准。

## 核心规则

- **BI 判断只认云端运行时**：云端 PostgreSQL、线上 BI 门户、`/api/bi/section/*`、云端日志和 systemd 状态；仓库 `outputs/bi-portal/*` 只是灾备/兼容快照。
- **本地 BI 已封存**：本地 `8787`、`SHEIN-*` Windows 计划任务和本地抓数任务只作回滚参考，除非明确回滚不得恢复。
- **飞书 Base / 原生看板写入暂停**：`state/feishu-base-sync-paused.flag` 存在时不写 Base/看板；异常提醒保留，日报只保留手动入口，问数走 BI 网页或 CLI。飞书只读问数 service 必须保持暂停。
- **SHEIN 写操作受控**：普通任务默认 dry-run，真实提交须满足账号权限、人+店+动作、确认与回读审计；云端营销 timer 是负责人长期策略授权的有限例外，不逐次索要人工确认或人工提供 hash，但系统仍必须为每轮自动计算、锁定并校验精确 payload/work hash，且只能执行策略白名单内的限时折扣动作，并强制实时证据、预校验和写后回读。
- **云端部署纪律**：GitHub release 是源码基线，不等于已部署；稳定发布完成时，本机/GitHub/云端 tracked source 必须收敛到同一 commit，云端热修必须在同一事故内回填 GitHub。Portal 生成物和可变运行态不进入 Git。
- **负责人经验单向继承**：负责人本机 Codex Desktop/CLI 与负责人 BI 会话的长期经验自动进入网页；其他账号只消费，不能反向覆盖。普通同事界面不展示无业务意义的规则包版本号。

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

- 人工灾备刷新当天销售 + BI Portal：`bash scripts/cloud_bi_refresh.sh today intraday`（日常当天销售由 Webhook 实时触发，不运行每小时全店轮询）
- 收口前一天最终版：`bash scripts/cloud_bi_refresh.sh yesterday final`（WebAPI 仅作独立核对；19/19 OpenAPI 深度匹配后才原子晋升正式日切片）
- 备份数据库：`bash scripts/cloud_db_backup.sh`
- 同步 ET 货代仓：`bash scripts/cloud_et_forwarder_sync.sh <scope>`（`<scope>` 按运维文档取值）
- 同步/回灌 ET 仓储费：`bash scripts/cloud_et_storage_fee_sync.sh daily [YYYY-MM-DD]` / `bash scripts/cloud_et_storage_fee_sync.sh backfill YYYY-MM-DD`
- 仓储费利润对账：`node scripts/check_storage_fee_profit.mjs --mode local --start YYYY-MM-DD --end YYYY-MM-DD`
- 跑云端 watchdog：`node scripts/cloud_ops_watchdog.mjs --dry-run`（systemd 状态已合并为一次批量读取）
- 生成紧凑云端运行态证据：`node scripts/capture_ops_runtime_snapshot.mjs --out-dir <全新目录> --expected-commit <release-tag>`；后续用 `node scripts/inspect_ops_run.mjs --manifest <目录>/manifest.json` 先读摘要，再按 blocker 定向展开。
- OpenAPI 商品/链接运营 CLI：`node scripts/bi_ops_cli.mjs --help`
- 团队自动运营：普通成员使用 BI 网页；Owner/合伙人的只读经营问题统一用 `node scripts/bi_ops_cli.mjs query --text "..." --out <json>`。CLI 最多等待 30 秒收口正在生成的 section，原子写完整数据和相邻 `<json>.manifest.json`；当前 Codex 先检查 manifest 的 outcome/coverage/hash，再按需读取 `data`。`chat` 只用于受控运营动作或显式测试网页会话产品，并用 `jobs` / `job` / `wait-job` 查看可恢复后台规划；旧 `ask` 只是 `query` 兼容别名。`--scope-all` 仅全局只读，不扩大写权限。
- 负责人经验同步：`npm run owner-knowledge:scan`、`npm run owner-knowledge:sync`、`npm run owner-knowledge:status`；本机采用事件驱动 + 60 分钟兜底，active 规则发布到 GitHub `owner-knowledge` 分支。合伙人 CLI 用 `node scripts/bi_ops_cli.mjs knowledge-status` 检查任务前原子缓存；运行边界见 `docs/owner-knowledge-sync.md`。
- 构建合伙人最小 CLI 包：`npm run partner-cli:package`；ZIP 与 SHA-256 写入忽略目录 `outputs/releases/`，不包含凭证和生产运行态。
- 批量复制商品到多店：`node scripts/link_ops_hl_openapi_executor.mjs --help`（支持 `supplyPriceRange`、`shuffleImages`、`inferInputCurrentOverride`；价格/图片洗牌在同一任务内确定性复现，真实写仍须预演、精确 payload hash、确认和回读）
- 批量下架候选生成与执行：候选器可直接读取受管 `query --sections linksData --out query.json` 的结构化 JSON，也兼容 enriched CSV；执行仍走 `node scripts/execute_retire_candidates_openapi.mjs --help` 的独立确认门。
- 限时折扣漂移自动修复：`node scripts/marketing/guard_limited_discount_drift.mjs --guard <guard-json>`（先判断漂移，有则自动批量修复）
- 修复已下架但货号未改：`node scripts/repair_retire_supplier_code_openapi.mjs --help`（云端专用，只调 `partialEdit`）

更多脚本、废弃边界和示例见 `docs/scripts-inventory.md`。

## BI 自动运营 V2（2026-07-12）

- 任务、会话、消息、作业和事件迁入 PostgreSQL 行级 `ops.link_ops_*` 表；revision、idempotency、追加事件和租约作业共同防并发覆盖、重复执行和进程中断。
- 生产切换按用户确认从空白任务/会话开始；原 31 个任务、4 个会话、15 条消息只留在云端校验备份，不进入新网页。
- 模型路由默认使用 Luna low 做结构化意图、Terra low/medium 做常规问数和动作规划、Sol high 做复杂/高风险或 Owner 深度诊断；网页禁用 max/ultra，xhigh 只限 Owner 人工显式调用。
- 跨店复制商品已补齐预演源链接/日期锁、目标店同货号去重、官方属性模板必填校验和强回读；真实写仍必须由当前账号明确确认，不能静默提交。
- 负责人本机 Codex/CLI 与本人 BI 会话可单向沉淀长期经验；同事只在业务流程中使用相关规则，不能反向写入或覆盖。
- 飞书问数 service 已主动暂停，生产必须保持 `shein-bi-lark-sales-qa.service` 为 `disabled + inactive`；网页问数和 CLI 继续可用。
- 发布、迁移、回滚与验收清单见 `docs/bi-ops-v2-release-2026-07-12.md`。

## 工具说明

- 默认用后台、headless、HTTP/CDP、日志、JSON、静态检查和 UI 冒烟脚本验证；只有登录、人机校验、用户明确要求或必须排查交互问题时才打开可见窗口，完成后关闭。
- 2026-07-23 起，半托当天销售由订单 Webhook 触发按单 OpenAPI 查询并写正式事实；在线 BI 通过 PostgreSQL `NOTIFY` + SSE 增量刷新。每日 `03:00` WebAPI 只保留独立核对文件，19/19 店深度匹配后才由 OpenAPI 原子晋升前一日正式切片。商品流量、四档状态、营销和部分编辑级详情仍按各自日更或 WebAPI/headless 边界运行，不能把“销售已切 OpenAPI”误写成“所有数据域都不再使用浏览器/WebAPI”。
- 飞书消息/Base 使用 `lark-cli`；`config/lark_report.json` 必须保持合法 UTF-8 JSON。
- ET 货代仓默认 headless；OCR/验证码连续失败、登录态人工维护或用户明确要求时才临时打开可见窗口。
- 云端上传的临时文件、OpenAPI 素材、登录维护文件用完必须清理；状态、token、session、密钥和数据库 dump 不写入仓库、文档或聊天。

## 关键文档

| 主题 | 文档 |
|---|---|
| 2026.07.30.6 当前正式发布 | `docs/bi-ops-release-2026-07-30-6.md` |
| 2026.07.30.5 上一正式发布 | `docs/bi-ops-release-2026-07-30-5.md` |
| 2026.07.30 半托19店独立应用切回 | `docs/openapi-per-store-production-cutback-2026-07-30.md` |
| 2026.07.30.4 上一正式发布 | `docs/bi-ops-release-2026-07-30-4.md` |
| 2026.07.30.3 共享商品详情额度与持续门禁 | `docs/bi-ops-release-2026-07-30-3.md` |
| 2026.07.30.2 源码一致性门禁 | `docs/bi-ops-release-2026-07-30-2.md` |
| 2026.07.30.1 利润、营销与运行态隔离 | `docs/bi-ops-release-2026-07-30.md` |
| 运行环境架构 | `docs/runtime-architecture.md` |
| 其他 agent 云端优先交接 | `docs/agent-handoff-cloud-first.md` |
| 应急恢复备份边界 | `docs/emergency-recovery-backup.md` |
| BI 系统架构 | `docs/bi-system-architecture.md` |
| BI 运维说明 | `docs/bi-system-operations.md` |
| BI 门户 UI 口径 / priceScatter | `docs/bi-portal-ui-current.md` |
| 2026-07-10 全面审查与优化闭环 | `docs/optimization-review-2026-07-10.md` |
| 2026.07.12 自动运营 V2 发布说明 | `docs/bi-ops-v2-release-2026-07-12.md` |
| 2026.07.16.1 自动运营与 Partner CLI 发布说明 | `docs/bi-ops-release-2026-07-16.md` |
| 2026.07.18.1 业务逻辑与营销巡检加固发布说明 | `docs/bi-ops-release-2026-07-18.md` |
| 2026.07.19.1 ET 仓储费历史重述与自动同步发布说明 | `docs/bi-ops-release-2026-07-19.md` |
| 2026.07.19.2 Webhook 与平台动态发布说明 | `docs/bi-webhook-release-2026-07-19.md` |
| 2026.07.23 半托 Webhook 实时销售切换与新排班 | `docs/bi-webhook-live-cutover-2026-07-23.md` |
| 2026.07.24 半托 13 类 Webhook 业务闭环 | `docs/bi-webhook-live-cutover-2026-07-23.md`、`docs/shein-webhook-receiver-design.md` |
| 2026.07.26 半托 OpenAPI 单应用生产切换（历史） | `docs/openapi-single-app-production-cutover-2026-07-26.md` |
| 2026.07.26.1 当前源码发布说明 | `docs/bi-ops-release-2026-07-26.md` |
| 2026-07-19 仓储费历史重述口径与验收 | `docs/storage-fee-history-restatement-2026-07-19.md` |
| 2026-07-18 BI 业务逻辑加固口径 | `docs/bi-business-logic-hardening-2026-07-18.md` |
| BI 仓库模型 | `docs/bi-warehouse-model.md` |
| SHEIN 后台数据地图 | `docs/shein-backend-survey.md` |
| SHEIN 官方 OpenAPI 接入 | `docs/shein-openapi-integration.md` |
| OpenAPI/CLI 能力交接索引 | `docs/shein-openapi-dev-handoff-index.md` |
| OpenAPI 官方能力台账 | `docs/shein-openapi-official-capability-inventory.md` |
| OpenAPI API schema 索引 | `docs/shein-openapi-api-schema-index.md` |
| SHEIN Webhook 接收、平台动态与运行说明 | `docs/shein-webhook-receiver-design.md` |
| 营销活动报名价格规则 | `docs/marketing-campaign-signup-pricing-rules.md` |
| 营销折扣自动化路线图 | `docs/marketing-automation-roadmap.md` |
| 每日营销巡检交接与执行规则 | `docs/marketing-daily-inspection-handoff.md` |
| 待议价每日快路径与审核批处理 | `docs/pending-discuss-batch.md` |
| 源码、发布与云端版本治理 | `docs/release-and-deployment-version-policy.md` |
| scripts 脚本清单与废弃边界 | `docs/scripts-inventory.md` |
| 负责人经验单向同步 | `docs/owner-knowledge-sync.md` |
| 数据模型 | `docs/data-model.md` |
| 实施路线 | `docs/implementation-roadmap.md` |
| 3 月参考表结构 | `docs/reference-month-table-structure.md` |
| 产品套图方法论 | `docs/product-image-suite-methodology.md` |
| 产品套图调研依据 | `docs/product-image-suite-research.md` |

## 维护原则

- README 只保留入口、红线、核心口径和文档索引；历史复盘、调度细节、UI 细则、产品套图方法论和脚本全集放入 `docs/`。
- 需要判断生产状态时，先查云端运行态；需要改写操作时，先 dry-run、审计、确认、回读。
