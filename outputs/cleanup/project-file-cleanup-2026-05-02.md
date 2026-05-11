# SHEIN 销售统计项目文件整理 / 清理清单

生成时间：2026-05-02 13:10
工作区：`E:\Codex WorkSpace\Shein销售统计`

## 处理原则

- 不直接删除生产登录态、生产数据、计划任务依赖文件、BI 数据仓库和飞书/SHEIN 可追溯证据。
- 明确低风险的临时文件直接清理。
- 有排障价值但不应继续散落在活跃目录里的文件，移动到本次清理归档区。
- 当前仍在运行或未来自动任务会继续使用的目录，只记录清理建议，不强行处理。

## 必须保留

| 路径 | 原因 |
|---|---|
| `E:\Codex WorkSpace\Shein销售统计\scripts` | 生产抓取、同步、BI 门户、计划任务入口。 |
| `E:\Codex WorkSpace\Shein销售统计\config` | 店铺、货号、别名等业务配置。 |
| `E:\Codex WorkSpace\Shein销售统计\lib` | 业务归一化逻辑。 |
| `E:\Codex WorkSpace\Shein销售统计\state` | 同步状态、发送状态、动作闭环状态等运行状态。 |
| `E:\Codex WorkSpace\Shein销售统计\docs`、`README.md`、`MEMORY.md` | 项目文档和长期记忆。 |
| `E:\Codex WorkSpace\Shein销售统计\.codex\plans` | 跨轮次执行记录。 |
| `E:\Codex WorkSpace\Shein销售统计\profiles\persistent-*` | 15 店和主账号 Chrome 登录态；当前多个 profile 正在被后台 Chrome 使用。 |
| `E:\Codex WorkSpace\Shein销售统计\profiles\persistent-feishu-profile` | 飞书网页登录态，富文本/卡片/页面操作依赖。 |
| `E:\Codex WorkSpace\Shein销售统计\profiles\daily-report-render`、`profiles\monthly-report-render` | 日报/月报渲染脚本使用，可重建但体积很小，暂保留。 |
| `E:\Codex WorkSpace\Shein销售统计\outputs\bi-portal\index.html`、`data.json` | 本地 BI 经营门户正式入口与数据。 |
| `E:\Codex WorkSpace\Shein销售统计\outputs\reports`、`outputs\shein_fetch`、`outputs\shein_links`、`outputs\shein_links_raw`、`outputs\shein_business_domains` | 生产输出、原始抓取、链接和业务域数据证据。 |
| `E:\Codex WorkSpace\Shein销售统计\infra\metabase\.admin.local.json`、`.session.local.json` | 本机 Metabase 凭据/会话文件，只保留本地，不外发内容。 |
| `D:\SheinBI\docker-data` | PostgreSQL / Metabase 运行数据盘，不属于可清理缓存。 |
| `C:\Users\dushengyi\.codex` | Codex 全局配置、skills、记忆，不属于本项目可随意移动的文件。 |

## 已归档

| 原位置 | 归档位置 | 结果 |
|---|---|---|
| `E:\Codex` | `E:\Codex WorkSpace\Shein销售统计\backups\file-cleanup-20260502T125310\E-Codex-stray-chrome-profile` | 已移动。确认无当前进程、计划任务或项目脚本引用。该目录是误生成的 Chrome profile/cache，约 `187.72 MB`、`1098` 个文件。 |
| `E:\Codex WorkSpace\Shein销售统计\outputs\lark_payloads` 中 `2026-05-01` 前的旧 payload | `E:\Codex WorkSpace\Shein销售统计\backups\file-cleanup-20260502T125310\lark_payloads-before-2026-05-01` | 已移动归档 `94763` 个文件，约 `73.49 MB`。活跃 payload 目录只保留 `2026-05-01` 和 `2026-05-02` 文件。 |

## 已清理

| 路径 | 结果 | 原因 |
|---|---|---|
| `E:\Codex WorkSpace\Shein销售统计\profiles\headless-smoke-test` | 已删除 | 旧一次性浏览器冒烟测试 profile，无引用。 |
| `E:\Codex WorkSpace\Shein销售统计\profiles\headless-smoke-test2` | 已删除 | 旧一次性浏览器冒烟测试 profile，无引用。 |
| `E:\Codex WorkSpace\Shein销售统计\profiles\headless-smoke-test-node` | 已删除 | 旧一次性浏览器冒烟测试 profile，无引用。 |
| `E:\Codex WorkSpace\Shein销售统计\tmp` 内部内容 | 已清空，保留目录 | 一次性 SQL、WSL 辅助脚本、测试输出，可由脚本重建。 |
| `E:\Codex WorkSpace\Shein销售统计\outputs\tmp-hidden-window-test.txt` | 已删除 | 一次性隐藏窗口测试标记。 |
| `backups\file-cleanup-20260502T125310\lark_payloads-before-2026-05-01.zip` | 已删除 | 第一次压缩归档超时产生的损坏半成品；原始 payload 未删除，后已改用移动归档。 |

## 暂不动 / 后续可选清理

| 路径 | 暂不处理原因 | 后续建议 |
|---|---|---|
| `E:\Codex WorkSpace\Shein销售统计\profiles\persistent-*` | 当前后台 Chrome 正在使用，且包含 SHEIN 登录态。 | 如需瘦身，只能在所有抓取任务停止后，按店铺逐个备份并清理 Chrome cache；不要直接删整个 profile。 |
| `E:\Codex WorkSpace\Shein销售统计\profiles\persistent-*-profile\OptGuideOnDeviceModel` | Chrome 自动下载的重复模型缓存，不是 SHEIN 登录态；当前约 8 份、合计约 30GB+。 | 等同步任务和 Chrome 进程停止后，可只删除该目录释放空间；不要动 `Profile 1`、`Default`、`Network`、`Local Storage`、Cookies/Session 相关文件。 |
| `E:\Codex WorkSpace\Shein销售统计\outputs\bi-portal\*.png` | 多数是近期验证截图，文档和记忆中有引用。 | 等 BI 门户阶段稳定后，可只保留每个大版本的最终截图，旧预览图再集中归档。 |
| `E:\Codex WorkSpace\Shein销售统计\outputs\shein_fetch`、`outputs\shein_links_raw` | 原始抓取证据和回放排障价值高。 | 未来可以按月份压缩归档，但不建议在当前系统刚上线时删除。 |
| `E:\Codex WorkSpace\Shein销售统计\logs` | 体积很小，且用于近期排障。 | 保留最近 30 天；项目稳定后再按月归档。 |
| `E:\Codex WorkSpace\Shein销售统计\backups` | 包含看板、Base 状态、配置和本次清理归档。 | 本次归档观察几天无异常后，可删除 `E-Codex-stray-chrome-profile`；旧 payload 可继续保留或压缩。 |

## 验证结果

- `E:\Codex` 已不存在于 E 盘根目录。
- 当前无进程严格引用 `E:\Codex\`。
- 当前无计划任务严格引用 `E:\Codex\`。
- 关键入口仍存在：
  - `scripts\scheduled_bi_daily_pipeline.ps1`
  - `scripts\run_bi_daily_pipeline.ps1`
  - `scripts\generate_bi_portal.mjs`
  - `outputs\bi-portal\index.html`
  - `outputs\bi-portal\data.json`
  - `profiles\persistent-shein-main-profile`
  - `profiles\persistent-feishu-profile`
  - `打开SHEIN-BI经营门户.cmd`
  - `打开SHEIN-BI网页服务.cmd`
- `outputs\lark_payloads` 当前无 `2026-05-01` 前的旧文件；保留约 `20678` 个近两天文件，约 `59.02 MB`。
