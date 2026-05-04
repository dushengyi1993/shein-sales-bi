# SHEIN 销售统计与 BI 经营系统

## 2026-05-03 当前权威状态

- 飞书生产链路继续保留，BI 系统作为旁路双线运行。
- 销售同步完成后会后置刷新 BI；如果单店失败但本地 15 店销售文件已齐，BI 仍会刷新，并通过飞书消息提醒失败店铺。
- 链接表现改为每日后半夜一次，当前任务为 `SHEIN-Sales-15Stores-LinkManagement-0530`，每天 `05:30`。旧 `0340` / `0510` 链接任务不要恢复。
- HL 已切换为主账号 profile：`profiles/persistent-shein-main-profile`；旧 `profiles/persistent-hl-profile` 已删除。

本工作区用于 SHEIN 15 店销售数据自动抓取、飞书多维表格统计、每日飞书日报、链接管理，以及正在并行建设的 PostgreSQL + Metabase + 本地 BI 经营门户。

当前原则：**飞书生产链路继续稳定运行，BI 系统作为旁路逐步替代看板与人工分析。**

## 当前状态（2026-05-03）

- 店铺范围：15 家店，`DSY` 组 10 家，`LGM` 组 5 家。
- 当前店铺代码：`CX DL DX FY HL JY LQ MZ NM QH QY TS XL YJ ZL`。
- 正式 Base：`https://zcnm3ts63aph.feishu.cn/base/SnnQbrAu6aLzMWsnEICcy0cKnJh`
- 当前正式看板：
  - 当月主看板：`SHEIN经营看板 v3-主看板`（`blkFn3qHrwdsrJyX`）
  - 上月看板：`SHEIN经营看板 v3-上月`（`blkWeyZhphgRZYim`）
- 当前 BI 入口：
  - 本地 BI 门户文件：`outputs/bi-portal/index.html`
  - 本机网页服务：`http://127.0.0.1:8787/`
  - 局域网协作访问：`http://192.168.2.49:8787/`
  - Metabase：`http://172.22.172.186:3000`
- 定时任务：
  - `00:10`：前一天完整销售额最终版。
  - `05:30`：链接管理 15 店每日同步，任务名 `SHEIN-Sales-15Stores-LinkManagement-0530`。
  - `06:40`：BI 每日流水线，任务名 `SHEIN-BI-Daily-Pipeline-0640`。
  - `08:10 / 10:10 / 12:10 / 14:10 / 16:10 / 18:10 / 20:10 / 22:10`：当天滚动同步。
  - 日报不再使用固定 09:00 任务；每天早上 08:10 同步成功完成后自动发送飞书文字日报 + 可视化日报图，上午后续成功同步可补发一次。
  - `09:20` 和 Windows 登录时：watchdog 漏跑补偿，不额外同步当日。
- 当前正式同步规则：`DSY` 和 `LGM` 两组都成功后，才统一刷新月表、年度/周月宽表、当月主看板和上月看板，避免半新半旧数据。
- 当前 BI 自动任务状态：
  - `SHEIN-BI-Daily-Pipeline-0640` 每天 `06:40` 运行；`2026-05-03 06:40` 正式运行已成功，Windows Last Result 为 `0`。
  - `2026-05-02 06:40` 的 `267014` 是已修复的历史失败记录，保留作排障证据。
  - 链接表现任务 `SHEIN-Sales-15Stores-LinkManagement-0530` 每天 `05:30`；下一次/首次正式自动验证为 `2026-05-04 05:30`。
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
- 预测利润率：`25%`。
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

## 工具说明

- SHEIN 生产抓取链路使用自写 Node 脚本连接 Chrome DevTools Protocol，不依赖手工页面操作。
- Chrome 程序路径由 `scripts/launch_store_browser.mjs` 自动探测，当前优先使用 C 盘正式安装路径，D 盘只作兜底候选；店铺登录态仍在工作区 `profiles/`。
- 店铺浏览器默认 headless；若重启后某 profile headless 起不来，`run_sales_sync_job.mjs` 会自动兜底到后台窗口模式。启动器保持 `detached=false` + `unref()`，避免 Windows/Node 下 detached Chrome 偶发崩溃。
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
- 数据模型：`docs/data-model.md`
- 实施路线：`docs/implementation-roadmap.md`
- 3 月参考表结构：`docs/reference-month-table-structure.md`

# 2026-05-02 当前补充：双线运行调度

- 飞书生产同步仍是当前主链路；BI/本地经营门户改为飞书同步成功后的后置刷新。
- 00:10 前一日最终版成功后，会刷新前一日 BI 数据切片。
- 白天滚动同步成功后，会刷新当日 BI 数据；如果单店失败但本地销售文件齐，也会照常刷新 BI，并通过飞书消息提醒问题店铺。
- 旧独立链接管理任务 `SHEIN-Sales-15Stores-LinkManagement-0340` / `SHEIN-Sales-15Stores-LinkManagement-0510` 已删除；当前链接每日任务是 `SHEIN-Sales-15Stores-LinkManagement-0530`。
- HL 只保留主账号 profile：`profiles/persistent-shein-main-profile`；旧 `profiles/persistent-hl-profile` 已删除，飞书定时任务和写表链路都会读取 `config/stores.json` 中的 `profileKey=shein-main` / `port=9360`。
- BI 后置刷新失败只记录日志，不反向影响飞书表格、看板和日报。


