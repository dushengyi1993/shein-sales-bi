# 硬盘故障应急恢复与 GitHub 备份边界

更新时间：2026-07-30

## 结论

如果本地数据真的全部丢失，**只要 GitHub 仓库还在，代码、抓取路径、计算口径、BI 门户生成逻辑和大部分配置都可以恢复**。现在仓库已经保存了：

- 抓取脚本、入仓脚本、日报脚本、BI 门户生成脚本；
- 当前店铺配置、货号目录、货号归并规则、销售有效性口径；
- PostgreSQL 数据仓库 schema；
- Metabase / BI Portal 架构与运维文档；
- BI Portal 生成逻辑及 `outputs/bi-portal/README.md`；页面、核心数据和 section cache 由数据库重建，不再把动态快照提交到 Git；
- 一份小体积非密运行状态快照：`recovery/emergency-state-snapshot-20260514/`。

但要注意：**可重建不等于 100% 原样恢复历史运行现场**。如果没有数据库 dump、原始抓取输出或浏览器登录态，恢复后需要重新登录、重新抓取、重新入仓。平台接口若对历史时间范围有限制，或者某些历史状态已经不再返回，就不能保证完全补回每一个旧快照。

## 当前已经继续补进 GitHub 的内容

本次应急补充纳入了 `recovery/emergency-state-snapshot-20260514/`，包含：

- `state/bi_action_state.json`：BI 协作动作处理状态快照；
- `logs/bi_portal_action_audit.jsonl` 的文本快照：BI 协作操作审计；
- `state/feishu-base-sync-paused.flag`：飞书 Base 写入暂停状态；
- `state/et_forwarder_sync_state.json`：ET 货代仓增量游标；
- `state/shein_sync_checkpoint.json`：SHEIN 销售同步检查点；
- `state/comment_translation_cache.json`：评论翻译缓存；
- `state/daily-report-sent-*.flag`：已发送日报标记。

这些文件体积小，未发现 Cookie、密码、API secret 等明显敏感字段，适合作为私有仓库里的应急快照。

## 不能直接放 GitHub 的内容

| 路径 | 原因 | 丢失后怎么恢复 |
| --- | --- | --- |
| `profiles/` | 浏览器登录态、Cookie、保存密码和大量缓存，体积几十 GB | 新机器重新登录；或者用加密外部备份迁移，不进 GitHub |
| `state/shein_webapi_sessions/*.local.json` | SHEIN WebAPI Cookie session，敏感 | 新机器重新登录/刷新 session；后续官方 OpenAPI 替代后减少依赖 |
| `config/shein_openapi.local.json` | SHEIN OpenAPI app secret / token 等真实密钥 | 只能通过密码管理器或加密渠道单独迁移 |
| `config/bi_users.local.json` | 本地 BI 账号密码 | 新环境重新设置 |
| `config/lark_report.json` | 飞书真实接收配置 | 由 `config/lark_report.example.json` 复制后手动填 |
| `infra/metabase/.env`、`.admin.local.json`、`.session.local.json` | 数据库、Metabase 管理员和会话信息 | 新环境重新生成或加密迁移 |
| PostgreSQL / Docker volume | 真实数据库和 Metabase 状态，体积大，不适合 GitHub | 用数据库 dump、Docker volume 备份或云盘/外部硬盘备份 |
| `/srv/shein-bi/runtime/marketing_manual_limited_discount_overrides.json` | 生产自动化持续更新的特殊折扣登记，不应污染源码 | 每日数据库备份会一并复制、校验并按保留策略归档 COS |
| `outputs/shein_links_raw/`、`outputs/shein_business_domains/`、`outputs/et-forwarder/` 等历史原始输出 | 体积大，且大部分可重跑 | 需要精确历史时单独压缩备份；否则重抓重建 |
| `logs/` 大部分运行日志 | 排障资料，体积会持续增长 | 只保留必要审计快照，其他日志可不迁移 |

## 数据能不能重建

### 可以较高把握重建的部分

- SHEIN 半托销售：代码和数据库 schema 可由 GitHub 恢复，但生产还必须恢复 DL 单一 App 的 19 店私有授权、Webhook 环境、按单 apply/最终日 promote 门禁和数据库备份。WebAPI 可按日期重抓独立核对文件，不能在切换日以后直接重建第二份正式销售事实。
- BI 门户：生成脚本在 GitHub；从数据库恢复后重新生成 shell、core 和 section cache。
- 货号归并、销售有效性、日报和 BI 计算：核心逻辑都在 `lib/`、`scripts/`、`docs/` 和 `infra/warehouse/schema.sql`。
- 评论翻译缓存和协作动作状态：已做小体积应急快照。

### 不能保证完整重建的部分

- 平台接口如果不再返回很久以前的明细，历史快照会缺口。
- ET 货代仓当前仍依赖登录态/网页接口，若登录态丢失，需要重新登录后再抓。
- Metabase 里手工创建的可视化、收藏、用户等，如果没有 Metabase 数据库备份，只能按文档和 schema 重建。
- 同事在 BI 门户里的操作备注，如果发生在本次快照之后、且没有数据库/状态文件备份，会丢失。

## 真正防硬盘挂掉的推荐备份层级

1. **GitHub：** 保存代码、文档、计算逻辑、非密配置种子和小体积非密恢复说明；不保存持续变化的 BI 页面与生产登记。
2. **数据库 dump：** 保存 PostgreSQL 业务仓库和 Metabase 配置库。这是未来最重要的恢复层，不能靠 GitHub 替代。
3. **加密密钥包：** 保存 `.env`、OpenAPI secret、Cookie session、必要账号密码；只能放密码管理器、加密 U 盘或云盘，不进普通 Git。
4. **可选原始输出归档：** `outputs/shein_*`、`outputs/et-forwarder` 如要精确保留历史，可单独压缩到外部硬盘/云盘；不建议进 GitHub。

## 从 GitHub 裸恢复的最小路径

1. 克隆仓库。
2. 安装 Node / Python / Docker / PostgreSQL / Metabase 依赖。
3. 根据 `*.example.json` 和 `.env.example` 重建本地配置。
4. 重新登录 SHEIN / ET / 飞书 / Metabase，生成本地 session 和密钥文件。
5. 运行 SHEIN 销售历史重抓与入仓。
6. 运行链接、业务域、ET 数据同步；平台不允许补历史的部分只能从当前开始。
7. 运行 BI 入仓和门户生成。
8. 如需要，把 `recovery/emergency-state-snapshot-20260514/` 里的 `state-files/` / `log-files/` 小状态复制回 `state/` / `logs/` 对应位置。

## 后续建议

下一步比继续塞 GitHub 更关键的是：做一份 PostgreSQL / Metabase 的数据库备份，并放到 GitHub 以外的位置。GitHub 负责“系统怎么跑”，数据库备份负责“历史数据还在”。
