# SHEIN 销售统计与 BI 经营系统

## 2026-05-06 当前权威状态

- 飞书多维表格 / 原生看板写入已临时暂停；飞书日报继续正常发送，BI 系统作为当前主要经营入口继续运行。
- 销售同步完成后会后置刷新 BI；如果单店失败但本地 15 店销售文件已齐，BI 仍会刷新，并通过飞书消息提醒失败店铺。
- 链接表现改为每日后半夜一次，当前任务为 `SHEIN-Sales-15Stores-LinkManagement-0530`，每天 `05:30`，只写本地 / PostgreSQL / BI；飞书链接管理表已废弃。旧 `0340` / `0510` 链接任务不要恢复。
- HL 已切换为主账号 profile：`profiles/persistent-shein-main-profile`；旧 `profiles/persistent-hl-profile` 已删除。
- `2026-05-05` Docker / WSL 数据盘异常已手动恢复；`2026-05-06 05:30` 链接/业务域任务和 `2026-05-06 07:00` BI 每日流水线已自动跑通。飞书多维表格 / 看板写入暂停开关为 `state/feishu-base-sync-paused.flag`。

本工作区用于 SHEIN 15 店销售数据自动抓取、飞书多维表格统计、每日飞书日报、链接管理，以及正在并行建设的 PostgreSQL + Metabase + 本地 BI 经营门户。

当前原则：**SHEIN 抓数、BI 刷新和飞书日报继续运行；飞书多维表格 / 看板写入先暂停，待用户确认再恢复。**

## 当前状态（2026-05-06）

- 店铺范围：15 家店，`DSY` 组 10 家，`LGM` 组 5 家。
- 当前店铺代码：`CX DL DX FY HL JY LQ MZ NM QH QY TS XL YJ ZL`。
- 正式 Base：`https://zcnm3ts63aph.feishu.cn/base/SnnQbrAu6aLzMWsnEICcy0cKnJh`（标题已标注 `【多维表格同步暂停｜日报正常】`）
- 当前正式看板：
  - 当月主看板：`SHEIN经营看板 v3-主看板`（`blkFn3qHrwdsrJyX`）
  - 上月看板：`SHEIN经营看板 v3-上月`（`blkWeyZhphgRZYim`）
- 当前 BI 入口：
  - 本地 BI 门户文件：`outputs/bi-portal/index.html`
  - 本机网页服务：`http://127.0.0.1:8787/`
  - 局域网协作访问：`http://192.168.2.49:8787/`
  - Metabase：`http://172.22.172.186:3000`
- 当前 BI 数据截面：
  - 销售 / 订单：`2026-05-06`，最近抓取时间 `2026-05-06T10:10:13.337+08:00`
  - 售后 / 库存 / 财务：业务日 `2026-05-05`，最近源文件抓取时间 `2026-05-06 05:46:42`
  - 链接表现：链接日 `2026-05-05`，最近源文件抓取时间 `2026-05-06 05:37:48`
- 定时任务：
  - `00:10`：前一天完整销售额最终版；飞书 Base 暂停期间只抓本地数据并刷新 BI。
  - `05:30`：链接管理 15 店每日同步，任务名 `SHEIN-Sales-15Stores-LinkManagement-0530`，不再写飞书链接管理表。
  - `07:00`：BI 每日流水线，任务名 `SHEIN-BI-Daily-Pipeline-0700`。
  - `08:10 / 10:10 / 12:10 / 14:10 / 16:10 / 18:10 / 20:10 / 22:10`：当天滚动抓取；飞书 Base 暂停期间只抓本地数据并刷新 BI。
  - 日报不再使用固定 09:00 任务；每天早上 08:10 同步成功完成后自动发送飞书文字日报 + 可视化日报图，上午后续成功同步可补发一次。
  - `09:20` 和 Windows 登录时：watchdog 漏跑补偿，不额外同步当日。
- 当前飞书 Base 暂停规则：存在 `state/feishu-base-sync-paused.flag` 时，`DSY` 和 `LGM` 仍正常抓 SHEIN 本地数据、刷新 BI、发送日报，但跳过飞书事实表、产品表、月表、年度/周月宽表、当月主看板和上月看板写入。
- 当前 BI 自动任务状态：
  - `SHEIN-Sales-15Stores-LinkManagement-0530` 已于 `2026-05-06 05:30:01` 自动运行成功；下一次运行 `2026-05-07 05:30:00`。
  - `SHEIN-BI-Daily-Pipeline-0700` 已于 `2026-05-06 07:00:01` 自动运行成功；下一次运行 `2026-05-07 07:00:00`。`2026-05-06` 后续 `08:10` / `10:10` 销售滚动后置 BI 也已成功刷新。
  - `2026-05-02 07:00` 的 `267014` 是已修复的历史失败记录，保留作排障证据。
- 团队访问边界：
  - 当前已开放临时局域网协作访问：`http://192.168.2.49:8787/`，仅限 `192.168.2.0/24` 私有网络，局域网内直接打开即可。
  - 未开放公网，未配置端口转发。
  - 局域网协作服务用 `打开SHEIN-BI局域网协作服务.cmd` 启动；防火墙规则为 `SHEIN BI Portal LAN 8787 ReadOnly`。
  - 同事可标记动作状态、填写负责人和备注；共享状态写入 `state/bi_action_state.json`，操作审计写入 `logs/bi_portal_action_audit.jsonl`，留痕以访问 IP 为准。
  - 团队正式版还需要固定访问地址、动作状态入 PostgreSQL、HTTPS 和备份。
- 后续维护原则：优先把可重复动作脚本化；Markdown 只保留长期规则、入口和关键坑，不再追加流水账，避免小任务频繁触发上下文压缩。

## 核心口径

- 统计日：北京时间自然日。
- 时间口径：订单创建时间。
- 汇率：`1 SAR = 1.8 RMB`。
- 利润口径：首页和成本/利润页已改为真实利润；成本未覆盖时显示“待成本表 / 成本覆盖率”，不再用 `25%` 粗估冒充真实利润。
- 当前正式成本文件为 `inputs/costs/成本计算表.xlsx`；`单台总成本（SAR）` 是单批单件完整成本输入，系统先还原为批次总成本，再按同货号所有完整批次加权平均计算单位成本。
- BI 销售/成交额统一使用“净成交额”：退货、仅退款、派送失败等反转订单不计入成交额、订单数和销量；这些订单仍扣商品成本；只有真实退货退款额外扣 `13.88 SAR`，`仅退款`、`派件失败`、`派件异常` 不重复扣退货派送费。
- 利润只对正销售额订单行扣商品成本；`sales_sar <= 0` 的揽收前取消 / 0 金额行不视为已售出，不扣商品成本或退货派送费。
- 历史测试品 `2001/CM-2001` 有单独手工成本补充文件 `inputs/costs/历史手工成本补充.csv`，仅用于历史利润复核。
- 同一天同店铺重复运行必须更新同一条事实记录，不得重复累加。
- 遇到 SHEIN `20302 子系统登录重定向`：先自动恢复登录并重新抓取；恢复失败时明确报错，不得把旧数据当最新数据。
- 不给单店保留猜测性的时区偏移；除非用户明确确认某店后台日期口径不同，否则按后台日期直接查询北京时间自然日。

## 展示表和看板策略

- 独立月表只保留当月和上个月；更早月份进入年度汇总表。
- 年度汇总表必须包含全年所有已抓取月份，包括当月和上月。
- 当月主看板读取 `看板数据-MAIN-*` 轻量聚合表。
- 上月看板读取 `看板数据-PREV-*` 轻量聚合表。
- 看板不直接读取订单/SKC 大明细表，避免排序、筛选、性能和重复求和问题。
- 看板顶部 `数据时间说明` 是飞书内部 `RICH_TEXT` 组件。已存在文本块不要用公开 Dashboard 更新接口改 `data_config.text`，否则会变成带引号的普通字符串并显示字面量 `\n`。当前刷新脚本会先用公开接口刷新数据源，再通过已登录的飞书网页 profile 调用内部富文本保存链路更新时间块；该步骤已加轻量重试，失败时不影响数据源刷新，但需要补刷时间块。
- 看板和日报图使用统一颜色规范：全部/合计为绿色系，`DSY` 为蓝色系，`LGM` 为橙色系，产品榜为紫粉系；店铺排行标签只显示排名和店铺代号，不显示分组前缀。
- 用户会手动微调正式看板布局和组件大小；后续自动刷新默认不得重排、不得重建无关组件、不得改变布局。只有用户明确允许时，才可以给看板刷新脚本加 `--arrange`。

## 目录

- `config/`：店铺、分组、汇率、货号归并、飞书日报配置。
- `schemas/`：飞书 Base 结构参考。
- `scripts/`：抓取、同步、看板、日报、BI 入仓、门户生成、定时任务脚本。
- `docs/`：数据模型、运行架构、BI 架构、运维说明、参考表结构。
- `docs/migration-and-restore.md`：GitHub 托管后的迁移/复用边界；说明哪些文件不上传、换电脑或上云时如何补齐运行数据和密钥。
- `infra/`：Metabase、PostgreSQL 数据仓库和 Docker 相关配置。
- `skills/shein-sales-ops/`：项目专用 skill，保存业务口径和避坑经验。
- `state/`：本地运行状态。
- `outputs/`：抓取结果、报表、图片、审计结果。
- `logs/`：计划任务和运行日志。
- `profiles/`：工作区内的 Chrome 店铺 profile；15 店登录态保存在 `persistent-*-profile`，不要删除整个 profile。后续磁盘瘦身只清 `OptGuideOnDeviceModel` 等 Chrome 可重建缓存，详见 `docs/runtime-architecture.md`。
- `outputs/cleanup/`：项目文件整理/清理清单，例如 `project-file-cleanup-2026-05-02.md`。

## 常用命令

- 启动某店铺后台 Chrome：
  `node scripts/launch_store_browser.mjs DL --headless`
- 启动某店铺可见 Chrome：
  `node scripts/launch_store_browser.mjs DL --visible`
- 生成仅含今日的详尽日报图：
  `node scripts/generate_today_detailed_report_image.mjs --date YYYY-MM-DD`
- 抓取单店某天：
  `node scripts/fetch_shein_sales.mjs DL --date 2026-04-29`
- 跑 15 店当天同步：
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scheduled_intraday_dsy.ps1`
- 发送日报：
  `node scripts/send_daily_lark_report.mjs --send --visual`
- 刷新年度汇总和宽表：
  `node scripts/generate_compact_display_tables.mjs --group ALL --current-month 2026-05 --recent-months 2`
- 刷新当月主看板：
  `node scripts/setup_lark_dashboard_main_v3.mjs --month 2026-05`
- 刷新上月看板：
  `node scripts/setup_lark_dashboard_previous_month.mjs --month 2026-04`
- 逻辑体检：
  `node scripts/audit_shein_sales_logic.mjs --month 2026-05 --date 2026-05-01`
- 安装/更新 Windows 计划任务：
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install_windows_scheduled_tasks.ps1 -IncludeWatchdog`
- 启动本机 BI 门户服务：
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/serve_bi_portal.ps1`
- 运行 BI 每日流水线：
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run_bi_daily_pipeline.ps1`
- 检查 BI 自动任务入口 dry-run：
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scheduled_bi_daily_pipeline.ps1 -DryRun`
- 生成 BI 自动任务验收报告：
  `node scripts/check_bi_first_run.mjs`
- 重新生成本地 BI 门户：
  `node scripts/generate_bi_portal.mjs`
- 生成成本表模板：
  `node scripts/create_cost_template.mjs`
- 检查/导入成本表：
  `node scripts/import_product_costs.mjs --dry-run`

## 工具说明

- SHEIN 生产抓取链路使用自写 Node 脚本连接 Chrome DevTools Protocol，不依赖手工页面操作。
- Chrome 程序路径由 `scripts/launch_store_browser.mjs` 自动探测，当前优先使用 C 盘正式安装路径，D 盘只作兜底候选；店铺登录态仍在工作区 `profiles/`。
- 店铺浏览器默认 headless；若重启后某 profile headless 起不来，`run_sales_sync_job.mjs` 会自动兜底到后台窗口模式。Windows 下 `launch_store_browser.mjs` / `launch_shein_main_browser.mjs` 通过 `PowerShell Start-Process` 后台启动 Chrome，避免 `cmd start` 路径空格问题和 detached Chrome 偶发崩溃。
- 飞书 Base/消息主要使用 `lark-cli`，日报接收人配置在 `config/lark_report.json`，该文件必须保持合法 UTF-8 JSON。
- 飞书看板富文本和卡片样式使用 Playwright + 已登录飞书 profile。
- 本机有 `opencli`，PowerShell 下建议调用 `C:\Users\dushengyi\AppData\Roaming\npm\opencli.cmd`。当前稳定生产链路暂不替换为 opencli；后续网页探索、临时浏览器操作或封装 lark-cli 时可以评估使用。

## 关键文档

- 运行环境架构：`docs/runtime-architecture.md`
- BI 系统架构：`docs/bi-system-architecture.md`
- BI 运维说明：`docs/bi-system-operations.md`
- BI 门户 UI 当前口径：`docs/bi-portal-ui-current.md`
- BI 仓库模型：`docs/bi-warehouse-model.md`
- SHEIN 后台数据地图：`docs/shein-backend-survey.md`
- SHEIN 官方 OpenAPI 接入计划：`docs/shein-openapi-integration.md`
- scripts 脚本清单与废弃边界：`docs/scripts-inventory.md`
- 数据模型：`docs/data-model.md`
- 实施路线：`docs/implementation-roadmap.md`
- 3 月参考表结构：`docs/reference-month-table-structure.md`
