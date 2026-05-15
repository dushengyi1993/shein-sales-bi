# SHEIN 销售统计与 BI 经营系统

## 2026-05-13 当前权威状态

- 飞书多维表格 / 原生看板写入已临时暂停；飞书日报继续正常发送，BI 系统作为当前主要经营入口继续运行。
- 销售同步完成后会后置刷新 BI；如果单店失败但本地 16 店销售文件已齐，BI 仍会刷新，并通过飞书消息提醒失败店铺。
- SHEIN 销售生产入口已改为 Node WebAPI 直连优先：`config/stores.json` 的 16 店 `salesTransport=auto`，`run_sales_sync_job.mjs` 会先用 `state/shein_webapi_sessions/<店铺>.local.json` 的 Cookie session 直调 `/gsp/orderPlus/listOrder` 和 `/gsp/orderPlus/listOrderItem`；成功时不启动浏览器，失败时才刷新 session / 回退 Chrome。`2026-05-08` 16 店 WebAPI 抓取已与现有数据库对账一致。
- 链接表现改为每日后半夜一次，当前任务为 `SHEIN-Sales-15Stores-LinkManagement-0530`，每天 `05:30`，只写本地 / PostgreSQL / BI；飞书链接管理表已废弃。旧 `0340` / `0510` 链接任务不要恢复。
- 当前完整 BI 运行层仍是 PostgreSQL + Metabase + BI Portal：PostgreSQL 是核心数据仓库，Metabase 是正式深度分析/自由钻取层，BI Portal 是日常经营入口；在自研门户完全覆盖深钻前，云端迁移不能删除或跳过 Metabase。
- HL 已切换为主账号 profile：`profiles/persistent-shein-main-profile`；旧 `profiles/persistent-hl-profile` 已删除。
- `2026-05-10` 已完成 16 店 profile 显示名与登录抓数复核：未发现 profile 名和登录态混乱；`YJ=profileKey qy`、`XL=profileKey yj`、`QY=profileKey xl` 是历史遗留但当前正确的绑定，不要仅凭名称直觉改动。
- `2026-05-09 05:30` 链接/业务域任务、`2026-05-09 07:00` BI 每日流水线和白天滚动后置 BI 刷新均已跑通。飞书多维表格 / 看板写入暂停开关为 `state/feishu-base-sync-paused.flag`。
- `2026-05-13` 已明确 BI/RTV 调度边界：RTV 换单自动复核本来就耗时，不应被当成滚动 BI 未更新；`08:10-22:10` 滚动销售后置 BI 默认跳过 RTV 复核，只刷新销售切片和门户；完整 RTV 复核保留在 `07:00` 每日完整 BI 流水线或手动命令中，`--max-runtime-ms 3600000` 仅用于防止无限挂死。
- ET 货代仓已接入本地数据仓库和 BI：`04:20` 每日同步当前库存、RTV、出库、发货申请单、财务等；抓取器会用 ET 专属 profile 中已保存的密码 + 本地 OCR 自动登录。`2026-05-09` 早间同源探测问题已修复并通过计划任务入口复验。
- RTV 换单号自动复核已接入 BI 流水线：`scripts/verify_shein_rtv_tracking.mjs` 直接读取 SHEIN 售后详情和退货物流详情，JT/JTE 走同运单直连，iMile/EMile 识别中英文换单证据；截至 `2026-05-09` 已确认 `132` 个 ET RTV 入仓单号。
- RTV 收件后去向已进入 BI：`mart.et_rtv_destination_allocation` 追踪 09 可售、03_RTV、04 破损、06 报废和其它/未知去向；`mart.shein_return_rtv_trace` 在 `订单 / 售后` 页面展示每条 SHEIN 退货是否收到、收到后去了哪里。
- HL OpenAPI 销售试点已跑通并行链路：`outputs/shein_openapi_fetch/HL/YYYY-MM-DD.json` 写入 `fact.openapi_*` 并行事实表与 `mart.openapi_sales_reconciliation` 对账表；BI 系统状态页显示 “SHEIN OpenAPI 试点对账”。正式切换生产销售表前继续累计多日 `matched`。
- HL OpenAPI 销售试点已固定为 Windows 计划任务双跑：`SHEIN-Sales-OpenAPI-HL-YesterdayFinal-0025` 每天 `00:25` 对账前一天最终版，`SHEIN-Sales-OpenAPI-HL-Intraday-1225` 每天 `12:25` 对账当天日内销售；只写 `fact.openapi_*` 和 `mart.openapi_sales_reconciliation` 并刷新 BI 状态页，不覆盖生产销售事实表。`2026-05-07 13:28` 已把当前出口 IP `188.253.112.44` 加入 SHEIN 开放平台白名单，完整入口复跑成功并刷新 BI；当日 intraday 对账为 `warning`，原因是 API 已多看到 1 个新订单，而当时生产源文件仍停留在上一轮同步。
- 系统定位正在从“BI 数据分析”扩展为“自动运营驾驶舱”：先把可重复运营动作沉淀为脚本和规则，再按“建议/预填/复核/人工确认提交/审计留痕”的边界逐步开放自动化。

本工作区用于 SHEIN 16 店销售数据自动抓取、飞书多维表格统计、每日飞书日报、链接管理、营销活动报名辅助，以及正在并行建设的 PostgreSQL + Metabase + 本地 BI / 自动运营驾驶舱。

当前原则：**SHEIN 抓数、BI 刷新和飞书日报继续运行；飞书多维表格 / 看板写入先暂停，待用户确认再恢复。**

## 当前运行状态（2026-05-09 已验证快照，2026-05-11 补充 WebAPI 入口）

以下数据截面是最近一次写入文档的已验证快照；实时页面以 `outputs/bi-portal/data.json` 和 BI 门户系统状态页为准。

- 店铺范围：16 家店，`DSY` 组 10 家，`LGM` 组 6 家。
- 当前店铺代码：`CX DL DX FY HL JY LQ MZ NM QH QY TS TZ XL YJ ZL`（新增 `TZ / GS5636781`）。
- 正式 Base：`https://zcnm3ts63aph.feishu.cn/base/SnnQbrAu6aLzMWsnEICcy0cKnJh`（标题已标注 `【多维表格同步暂停｜日报正常】`）
- 当前正式看板：
  - 当月主看板：`SHEIN经营看板 v3-主看板`（`blkFn3qHrwdsrJyX`）
  - 上月看板：`SHEIN经营看板 v3-上月`（`blkWeyZhphgRZYim`）
- 当前 BI 入口：
  - 本地 BI 门户文件：`outputs/bi-portal/index.html`
  - V2.1 独立设计预览：`http://127.0.0.1:8787/v2/`，由 `scripts/generate_bi_portal_v2.mjs` 生成；自 `2026-05-14` 起 V2 首页已按 V1 首页功能和操作逻辑重做，仍只读 `outputs/bi-portal/data.json`，用户确认前不得替换 V1 或改生产调度。V2 暂时不跟随日常同步自动刷新，只作为慢慢开发和优化的平行项目；没有用户明确任务时不要主动生成或维护 V2。
  - 本机网页服务：`http://127.0.0.1:8787/`
  - 局域网协作访问：优先用电脑名 `http://DUSHENGYI-PC2:8787/`；若同事电脑无法解析电脑名，则用当前 WLAN IPv4，例如 `http://192.168.2.142:8787/`。电脑重启后 IP 可能变化，不要把旧 IP 当成固定入口。
  - Metabase：`http://172.22.172.186:3000`
- 当前 BI 数据截面：
  - 销售 / 订单：`2026-05-09`
  - 售后 / 库存 / 财务：业务日 `2026-05-08`，源抓取时间 `2026-05-09 05:45:46`
  - 链接表现：链接日 `2026-05-08`，源抓取时间 `2026-05-09 05:36:32`
  - ET 货代仓：最新写入文档批次 `et-daily-2026-05-09-2026-05-09T03-31-50-575Z`；实时以 BI 门户系统状态页和 ET 入仓日志为准。
- 定时任务：
  - `00:10`：前一天完整销售额最终版；飞书 Base 暂停期间只抓本地数据并刷新 BI。自 `2026-05-11` 起还会自动回核 D-2 稳定销售，修正次日未发货前取消单造成的初版偏差。
  - `04:20`：ET 货代仓每日同步，任务名 `SHEIN-Sales-ETForwarder-0420`，按增量游标 + 重叠校验抓 ET 库存、RTV、出库、发货申请单、财务等。
  - `05:30`：链接管理 16 店每日同步，任务名 `SHEIN-Sales-15Stores-LinkManagement-0530`，不再写飞书链接管理表。
  - `07:00`：BI 每日流水线，任务名 `SHEIN-BI-Daily-Pipeline-0700`，包含 ET/SHEIN 入仓、RTV 换单自动复核、BI 体检、本地门户和晨报刷新；RTV 复核允许长时间运行，默认 60 分钟硬保护。BI 门户生成已合并为流水线末尾单次执行，默认超时 `900` 秒。
  - `08:10 / 10:10 / 12:10 / 14:10 / 16:10 / 18:10 / 20:10 / 22:10`：当天滚动抓取；飞书 Base 暂停期间只抓本地数据并刷新 BI；后置 BI 会传 `-SkipRtvVerify`，避免 RTV 复核耗时挡住滚动销售看板更新。
  - 日报不再使用固定 09:00 任务；每天早上 08:10 同步成功完成后自动发送飞书文字日报 + 可视化日报图，上午后续成功同步可补发一次。
  - `09:20` 和 Windows 登录时：watchdog 漏跑补偿，不额外同步当日。
- 当前飞书 Base 暂停规则：存在 `state/feishu-base-sync-paused.flag` 时，`DSY` 和 `LGM` 仍正常抓 SHEIN 本地数据、刷新 BI、发送日报，但跳过飞书事实表、产品表、月表、年度/周月宽表、当月主看板和上月看板写入。
- 当前 BI 自动任务状态：
  - `SHEIN-Sales-ETForwarder-0420` 已于 `2026-05-09 11:31:49` 手动触发计划任务入口复验成功，`LastTaskResult=0`。
  - `SHEIN-Sales-15Stores-LinkManagement-0530` 已于 `2026-05-09 05:30:01` 自动运行成功。
  - `SHEIN-BI-Daily-Pipeline-0700` 已于 `2026-05-09 07:00:01` 自动运行成功；`2026-05-09` 白天滚动销售后置 BI 也已成功刷新。
  - `2026-05-02 07:00` 的 `267014` 是已修复的历史失败记录，保留作排障证据。
- 团队访问边界：
  - 当前已开放临时局域网协作访问：优先用 `http://DUSHENGYI-PC2:8787/`，或按本机当前 WLAN IPv4 访问 `http://<当前IP>:8787/`；仅限 `192.168.2.0/24` 私有网络，局域网内直接打开即可。
  - 未开放公网，未配置端口转发。
  - 局域网协作服务用 `打开SHEIN-BI局域网协作服务.cmd` 启动；防火墙规则为 `SHEIN BI Portal LAN 8787 ReadOnly`。若重启后局域网打不开，先确认新 IP，再以管理员运行 `配置SHEIN-BI局域网防火墙.cmd` 重建规则；规则应允许 `192.168.2.0/24` 访问本机 `8787`，不要绑定某个会变化的旧 IP。
  - 同事可标记动作状态、填写负责人和备注；共享状态写入 `state/bi_action_state.json`，操作审计写入 `logs/bi_portal_action_audit.jsonl`，留痕以访问 IP 为准。
  - 团队正式版还需要固定访问地址、动作状态入 PostgreSQL、HTTPS 和备份。
- 后续维护原则：优先把可重复动作脚本化；Markdown 只保留长期规则、入口和关键坑，不再追加流水账，避免小任务频繁触发上下文压缩。

## 核心口径

- 统计日：北京时间自然日。
- 时间口径：订单创建时间。
- 汇率：`1 SAR = 1.8 RMB`。
- 销售有效性统一走 `lib/shein_sales_validity.mjs`：只把真正取消、揽收前取消等“未形成销售”的商品行从总销售额、订单数和销量中剔除；用户已退款、退货、派件失败等仍保留在总销售额里，再由净销售额、售后/利润层反转。后台原始金额仍保留在明细里用于追溯。历史本地 JSON summary 可用 `scripts/repair_shein_sales_summaries.mjs` 重算。
- 利润口径：首页和成本/利润页已改为真实利润；成本未覆盖时显示“待成本表 / 成本覆盖率”，不再用 `25%` 粗估冒充真实利润。
- 成本/利润页的高利润 / 低利润货号分界线固定为 `20%` 利润率：`>= 20%` 为可加码，`< 20%` 为需要处理。
- 当前正式成本文件为 `inputs/costs/成本.xlsx`；`单台总成本（SAR）` 是单批单件完整成本输入，系统先还原为批次总成本，再按同货号所有完整批次加权平均计算单位成本。
- BI 首页默认使用“净成交额 / 净销量”：买家已发起且未取消的售后申请默认计入退货/反转，包含 `待买家退货`、`待交接`、`待卖家处理` 等未落定状态；最终取消后再自动冲回。退货、仅退款、派送失败等反转订单不计入成交额、订单数和销量；这些订单仍扣商品成本；只有真实退货退款额外扣 `13.88 SAR`，`仅退款`、`派件失败`、`派件异常` 不重复扣退货派送费。
- 首页销售额可切换“净销售额 / 总销售额”，销量可切换“净销量 / 总销量”；但 `sales_sar <= 0` 或 `gross_revenue_sar <= 0` 的揽收前取消 / 0 金额行在净口径和总口径里都直接忽略，就当没有发生，不计订单、销量、成本或退货派送费。
- 历史测试品 `2001/CM-2001` 有单独手工成本补充文件 `inputs/costs/历史手工成本补充.csv`，仅用于历史利润复核。
- 今日动作池同一店铺、同一 SKC、同一业务域命中的多条规则合并成一张动作卡，显示“合并 N 条”和各规则信号；不同业务域仍分开处理。
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
- `docs/emergency-recovery-backup.md`：硬盘故障应急恢复边界；说明哪些本地数据可重建、哪些需要数据库 dump 或加密备份。
- `infra/`：Metabase、PostgreSQL 数据仓库和 Docker 相关配置。
- `skills/shein-sales-ops/`：项目专用 skill，保存业务口径和避坑经验。
- `state/`：本地运行状态。
- `outputs/`：抓取结果、报表、图片、审计结果；默认不进 GitHub，但 `outputs/bi-portal/index.html` 和 `outputs/bi-portal/data.json` 作为当前 BI 门户产物已纳入仓库，便于迁移和复用。
- `logs/`：计划任务和运行日志。
- `profiles/`：工作区内的 Chrome 店铺 profile；16 店登录态保存在 `persistent-*-profile`，不要删除整个 profile。后续磁盘瘦身只清 `OptGuideOnDeviceModel` 等 Chrome 可重建缓存，详见 `docs/runtime-architecture.md`。  如需核验店铺是否错位，使用稳定日期后台重抓并对账数据库，不要只看页面文本。
- `state/shein_webapi_sessions/`：WebAPI 直连复用的 Cookie session，本地敏感运行态，不进 GitHub；迁移时只能通过加密渠道或在新机器重新登录/刷新。
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
- 强制 WebAPI 直连抓取单店某天：
  `node scripts/fetch_shein_sales.mjs DL --date 2026-04-29 --transport webapi`
- 强制回退浏览器抓取单店某天：
  `node scripts/fetch_shein_sales.mjs DL --date 2026-04-29 --transport browser`
- 跑 16 店当天同步：
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
- 重算历史销售 summary（先 dry-run，确认后再加 `--write`）：
  `node scripts/repair_shein_sales_summaries.mjs --start 2026-05-11 --end 2026-05-13`
- 安装/更新 Windows 计划任务：
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install_windows_scheduled_tasks.ps1 -IncludeWatchdog`
- 启动本机 BI 门户服务：
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/serve_bi_portal.ps1`
- 修复 BI 局域网防火墙（需要管理员权限）：
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fix_bi_lan_firewall.ps1`
- 运行 BI 每日流水线：
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run_bi_daily_pipeline.ps1`
- 检查 BI 自动任务入口 dry-run：
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scheduled_bi_daily_pipeline.ps1 -DryRun`
- 生成 BI 自动任务验收报告：
  `node scripts/check_bi_first_run.mjs`
- 重新生成本地 BI 门户：
  `node scripts/generate_bi_portal.mjs`
- 重新生成 V2.1 独立设计预览（当前验收范围先限定首页完整复刻 V1 首页逻辑）：
  `node scripts/generate_bi_portal_v2.mjs`
- BI 门户 UI 冒烟检查：
  `node scripts/check_bi_portal_ui.mjs --json`
- 手动运行 ET 货代仓同步：
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scheduled_et_forwarder_daily.ps1`
- 手动运行 RTV 换单复核（耗时正常，按批次跑；`--max-runtime-ms 3600000` 是 60 分钟防挂死保护）：
  `node scripts/verify_shein_rtv_tracking.mjs --priority high,medium,low --include-no-cases --limit 120 --case-limit 60 --max-runtime-ms 3600000`
- 抓取 HL OpenAPI 销售试点数据：
  `node scripts/fetch_shein_openapi_sales.mjs HL --start YYYY-MM-DD --end YYYY-MM-DD`
- 将 HL OpenAPI 销售写入并行表并生成对账：
  `node scripts/load_shein_openapi_sales_warehouse.mjs --store HL --start YYYY-MM-DD --end YYYY-MM-DD`
- 手动运行 HL OpenAPI 对账入口：
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scheduled_openapi_hl_reconciliation.ps1 -Mode intraday`
- 生成营销活动成本映射：
  `python scripts/marketing/build_marketing_cost_map.py`
- 辅助填报 DSY 两天内截止的营销活动（只预填，不点最终提交；若本期有价格覆盖表，必须带 `--price-overrides`）：
  `node scripts/marketing/dsy_marketing_deadline_fill.mjs --stores DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ --hours 48 --price-overrides outputs/reports/marketing-price-overrides-YYYY-MM-DD.json --min-discount-fallback SK-13034`
- 生成成本表模板：
  `node scripts/create_cost_template.mjs`
- 检查/导入成本表：
  `node scripts/import_product_costs.mjs --dry-run`

## 工具说明

- 非必要情况下不要打开前端/可见浏览器窗口；默认用后台、headless、HTTP/CDP、日志、JSON、静态检查和 UI 冒烟脚本验证。只有首次登录、验证码/人机验证、用户明确要求看前台、或必须排查浏览器交互问题时，才打开可见窗口；完成后应关闭。

- SHEIN 销售生产抓取链路优先使用 Node WebAPI 直连；Chrome DevTools Protocol 主要用于首次导出 / 刷新 Cookie session、登录续期和 WebAPI 失败时的回退，不依赖手工页面操作。
- Chrome 程序路径由 `scripts/launch_store_browser.mjs` 自动探测，当前优先使用 C 盘正式安装路径，D 盘只作兜底候选；店铺登录态仍在工作区 `profiles/`。
- 店铺浏览器默认 headless；若重启后某 profile headless 起不来，`run_sales_sync_job.mjs` 会自动兜底到后台窗口模式。Windows 下 `launch_store_browser.mjs` / `launch_shein_main_browser.mjs` 通过 `PowerShell Start-Process` 后台启动 Chrome，避免 `cmd start` 路径空格问题和 detached Chrome 偶发崩溃。
- 飞书 Base/消息主要使用 `lark-cli`，日报接收人配置在 `config/lark_report.json`，该文件必须保持合法 UTF-8 JSON。
- 飞书看板富文本和卡片样式使用 Playwright + 已登录飞书 profile。
- 本机有 `opencli`，PowerShell 下建议调用 `C:\Users\dushengyi\AppData\Roaming\npm\opencli.cmd`。当前稳定生产链路暂不替换为 opencli；后续网页探索、临时浏览器操作或封装 lark-cli 时可以评估使用。

## 关键文档

- 运行环境架构：`docs/runtime-architecture.md`
- 应急恢复备份边界：`docs/emergency-recovery-backup.md`
- BI 系统架构：`docs/bi-system-architecture.md`
- BI 运维说明：`docs/bi-system-operations.md`
- BI 门户 UI 当前口径：`docs/bi-portal-ui-current.md`
- BI 仓库模型：`docs/bi-warehouse-model.md`
- SHEIN 后台数据地图：`docs/shein-backend-survey.md`
- SHEIN 官方 OpenAPI 接入计划：`docs/shein-openapi-integration.md`
- 营销活动报名价格规则：`docs/marketing-campaign-signup-pricing-rules.md`
- scripts 脚本清单与废弃边界：`docs/scripts-inventory.md`
- 数据模型：`docs/data-model.md`
- 实施路线：`docs/implementation-roadmap.md`
- 3 月参考表结构：`docs/reference-month-table-structure.md`

## 电商产品套图生成（2026-05-09 新增）

- 方法论：`docs/product-image-suite-methodology.md`
- 调研依据：`docs/product-image-suite-research.md`
- 本地 skill：`skills/ecommerce-product-image-suite/SKILL.md`
- 批量提示词脚本：`scripts/product-image-suite/generate_prompt_suite.mjs`
- 样例输入：`inputs/product-image-suite/sample-product-facts.json`
- 样例输出：`outputs/product-image-suite/prompts/`

该能力用于按店铺、货号和产品事实生成 13 张电商产品套图提示词。当前优先满足 SHEIN 沙特市场，兼顾欧洲市场；Amazon / noon / Temu 暂作视觉经验参考。默认先做产品事实校验，再输出封面图、参数图、轮播图、场景图、卖点图、细节图、步骤图、尺寸图和清单/信任图；竞品资料只用于学习结构和视觉表达，不得直接变成本品参数或卖点。重点图应采用 Gemini 式细化提示词，写清人物、服装材质、动作、场景、光线、构图和英阿双语文案；个护/封面类可使用更强的高级性感流量风，但不得色情低俗或让人物压过产品。

### ET 前台窗口规则
- ET 货代仓也适用“非必要不打开前端窗口”：`scripts/fetch_et_forwarder.mjs` 默认 `visible=false` 并用 `WindowStyle Hidden` 启动 Chrome；自动登录优先走 `scripts/et_login_helper.py` + OCR。只有 OCR/验证码连续失败、登录态必须人工处理、用户明确要求，或必须排查浏览器交互问题时，才允许临时加 `--visible` 打开 ET 前台窗口，处理完必须关闭。
