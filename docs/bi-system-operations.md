# SHEIN BI 系统运行说明

> 当前权威状态：2026-06-03。本地 BI 已封存，云端 BI 是正式入口；云端专用运维清单见 `docs/cloud-bi-operations.md`。本文保留业务口径、本地回滚和历史 Windows 运维参考。

## 1. 当前系统定位

- 飞书多维表格 / 原生看板写入已临时暂停；飞书日报、异常通知 watchdog 和只读问数机器人已迁到云端独立链路并验证。
- BI 系统当前以云端为正式入口，负责 PostgreSQL 数据仓库、Metabase 和 BI 经营门户。
- 当前不能直接停用或删除 Metabase：PostgreSQL 是数据底座，Metabase 是正式深度分析/自由钻取层，BI Portal 是日常经营入口；只有等自研门户完全覆盖深钻能力后，才能重新评估是否降级 Metabase。
- 不从飞书反抓数据做 BI 源头；BI 源头来自 SHEIN 后台抓取后的私有源文件 / PostgreSQL。
- 销售源文件已改为 WebAPI 直连优先生成；Chrome profile 只作为 Cookie/session 刷新、登录续期和回退来源。
- BI 后置刷新失败不应反向影响 SHEIN 抓数和飞书日报。
- 暂停开关：`state/feishu-base-sync-paused.flag`。存在该文件时，跳过飞书事实表、产品表、月表、宽表和看板写入；删除该文件后可恢复写表链路。
- 营销折扣自动化仍按“建议 / dry-run / 复核 / 授权执行 / live 回读”分层推进；长期路线图见 `docs/marketing-automation-roadmap.md`。BI 可以生成动作卡和同事分店任务，但真实提交、取消、改价、补预算必须先有价格栈证据和店铺身份校验。

## 2. 日常入口

- 云端 BI 门户：[https://shein-bi.faceair.me/](https://shein-bi.faceair.me/)，旧 IP 入口 [http://43.165.167.135/](http://43.165.167.135/) 仅作兜底；已启用 Basic Auth，密码不得写入仓库或文档。
- 云端登录维护中心：[https://shein-bi.faceair.me/cloud-login-maintenance](https://shein-bi.faceair.me/cloud-login-maintenance)。当 SHEIN / SBN 子系统登录态失效、遇到验证码/滑块，或被协议签署 / 公告 / 通知确认等普通登录弹窗挡住时，用它临时打开指定店铺的云端浏览器窗口；普通登录干扰弹窗可由运维代理关闭/确认后再点登录，完成后必须点“我已完成并关闭”。
- 本机 BI 门户和局域网协作入口已封存：`http://127.0.0.1:8787/`、`http://DUSHENGYI-PC2:8787/` 不再作为正式入口。
- 仓库门户灾备文件：`outputs/bi-portal/index.html`（不代表当前云端运行态）
- V1 是当前唯一正式生产门户；V2 是平行预览版，脚本 `scripts/generate_bi_portal_v2.mjs`，输出 `outputs/bi-portal/v2/index.html`。V2 数据判断和验收必须走云端运行态/线上 section API；用户确认前不得替换 V1、不得改生产调度，日常运维仍以 V1 为准。
- V1 门户由 `scripts/generate_bi_portal.mjs` 生成；`scripts/run_bi_daily_pipeline.ps1` 已合并为末尾单次生成页面，默认 `SHEIN_BI_PORTAL_TIMEOUT_MS=900000`，不要恢复成多个状态点重复生成。
- 本地回滚时才启动本机网页服务：双击 `打开SHEIN-BI网页服务.cmd`。
- 本地回滚时才启动局域网协作服务：双击 `打开SHEIN-BI局域网协作服务.cmd`。
- 本地回滚时才配置局域网防火墙：以管理员运行 `配置SHEIN-BI局域网防火墙.cmd`；规则名为 `SHEIN BI Portal LAN 8787 ReadOnly`。
- 当前封存动作可复用 `scripts/archive_local_bi.ps1`；如要同时禁用防火墙规则，需要管理员 PowerShell 加 `-DisableFirewall`。
- Markdown 经营晨报历史文件：`outputs/bi-briefings/latest.md`
- Metabase 当前在云端 Docker 内部运行，不在文档中写公网裸地址；本地旧 WSL 地址只作历史排障参考。
- Metabase 管理员凭据只保存在 `infra/metabase/.admin.local.json`，不要写入文档或聊天。

## 3. 当前数据口径

- 当前 BI 截面日期和经营数据只以云端门户系统状态页、线上 `/api/bi/section/*`、云端 PostgreSQL warehouse、云端日志和 systemd 状态为准，不在本文写死；仓库快照不用于当前数据判断，运维文档只记录口径和入口。
- 当前 BI 门户侧栏更新时间口径：销售取销售源数据抓取时间；售后/库存/财务取业务域源文件最大 `fetchTime`；链接表现取链接源文件最大 `fetchTime`；ET 货代仓取 ET 源文件/入仓批次时间。BI 入仓或页面重跑时间只作内部排障，不作为侧栏主要更新时间。
- 销售抓取入口：当前 19 店 `salesTransport=auto`，先 WebAPI 直连，失败才回退浏览器；本地 session 在 `state/shein_webapi_sessions/*.local.json`，不进 GitHub。
- 销售有效性口径：所有抓取、日报、产品统计、BI 入仓和飞书表格脚本必须共用 `lib/shein_sales_validity.mjs`。源头总销售只剔除真正取消、揽收前取消等未形成销售的商品行，例如 `pageStatus=CANCEL`、`goodsPerformanceStatus=6` 或订单/履约状态文本含取消；`用户已退款`、退货、派件失败等仍保留在总销售里，再由净销售额、售后/利润层反转。历史 summary 重算入口为 `scripts/repair_shein_sales_summaries.mjs`。
- 店铺范围：`CX DL DX FY HL JSH JY LQ MZ NM QH QY TS TZ TZZ XC XL YJ ZL`
- 分组：DSY = `DL DX FY LQ NM HL JY ZL TS MZ`；LGM = `CX YJ XL QY QH TZ JSH TZZ XC`。
- 汇率：`1 SAR = 1.8 RMB`。
- 首页利润已改为真实利润口径；若成本表未覆盖，页面显示“待成本表 / 成本覆盖率”，不再用 `25%` 粗估冒充真实利润。

## 4. 计划任务

### 4.1 当前云端生产调度

| 时间 | systemd timer | 说明 |
| --- | --- | --- |
| `00:10/02:10/.../22:10` | `shein-bi-cloud-today.timer` | 每两小时刷新当天销售、入仓并生成 BI Portal。 |
| `00:10` | `shein-bi-cloud-yesterday.timer` | 刷新前一天最终销售，并复核前两天稳定日。 |
| `02:30` | `shein-bi-db-backup.timer` | 备份业务库和 Metabase 元数据库到 `/srv/shein-bi/backups/auto`，默认保留 14 天。 |
| `03:20` | `shein-bi-cloud-rtv-verify.timer` | 完整 RTV 换单复核 WebAPI 版，不阻塞滚动销售刷新。 |
| `03:20` | `shein-bi-cloud-session-manager.timer` | 顺序巡检/恢复当前 19 店 WebAPI + SBN 登录态，并检查 profile 体积。 |
| `04:20` | `shein-bi-cloud-et-forwarder.timer` | 同步 ET 货代仓、入仓并刷新 BI。 |
| `05:30` | `shein-bi-cloud-link-business.timer` | 顺序抓取前一完整日链接/业务域，入仓、体检并刷新 BI。 |
| `06:20` | `shein-bi-cloud-openapi-hl.timer` | HL OpenAPI 并行对账。 |
| `08:35` | `shein-bi-cloud-daily-lark-report.timer` | 发送飞书日报；`10:35/12:35` 补偿重试。 |
| 每小时 | `shein-bi-cloud-watchdog.timer` | 检查云端服务、timer 和数据新鲜度，异常时提醒。 |

云端当前自动覆盖销售 WebAPI 直连、销售入仓、BI Portal 生成、数据库备份、ET 货代仓同步、飞书日报、完整 RTV 复核、链接/业务域日更、异常通知、登录态巡检、只读问数机器人和 HL OpenAPI 双跑。

### 4.2 本地历史任务 / 回滚参考

以下 Windows 任务已于 `2026-05-15` 封存禁用，不再作为生产调度；除非明确回滚，不要重新启用：

- `SHEIN-Sales-15Stores-YesterdayFinal-0010`
- `SHEIN-Sales-15Stores-Intraday-Daytime`
- `SHEIN-Sales-15Stores-LinkManagement-0530`
- `SHEIN-Sales-ETForwarder-0420`
- `SHEIN-BI-Daily-Pipeline-0700`
- `SHEIN-Sales-15Stores-Watchdog-Logon`
- `SHEIN-Sales-OpenAPI-HL-Intraday-1225`
- `SHEIN-Sales-OpenAPI-HL-YesterdayFinal-0025`

如果将来回滚本地，Windows 任务仍应通过 `wscript.exe` + `scripts/run_scheduled_hidden.vbs` 隐藏启动 PowerShell，不要直接注册前台 PowerShell 窗口。

## 4A. SHEIN 销售 WebAPI 直连运行规则

- 单店销售抓取：`node scripts/fetch_shein_sales.mjs HL --date YYYY-MM-DD --transport webapi`。
- 强制浏览器回退：`node scripts/fetch_shein_sales.mjs HL --date YYYY-MM-DD --transport browser`。
- 全店同步默认按 `config/stores.json.salesTransport=auto` 执行：`node scripts/run_sales_sync_job.mjs --date YYYY-MM-DD --group ALL --skip-lark-base --store-attempts 1`。
- WebAPI session 文件位于 `state/shein_webapi_sessions/<店铺>.local.json`，包含 Cookie header 和浏览器指纹信息；这是敏感运行态，只能本机保存或加密迁移，不能提交 GitHub、写入文档或发聊天。
- 直连成功时不会启动店铺浏览器；日志里的 `fetchTransport=webapi` 和 `browser.reason=webapi_transport_succeeded_without_browser_launch` 是成功证据。
- 若 WebAPI 返回 `20302`、session 文件缺失或 Cookie 失效，`auto` 模式会启动对应 Chrome profile 刷新 session / 自动登录后重试；确需排障时可临时设置 `SHEIN_SALES_TRANSPORT=browser`。
- `2026-05-11` 已用 `2026-05-08` 全 16 店做 WebAPI 对账，和现有数据库销售切片一致；资源实测见 `outputs/cloud-migration/webapi-allstores-resource-20260511-201715.json`。

## 5. 飞书日报与 BI 刷新规则

- 当前飞书 Base / 看板写入暂停，但飞书日报仍是推送渠道。
- 云端 `shein-bi-cloud-yesterday.timer` 刷新前一天最终版，并回核 D-2 稳定销售。
- 云端 `shein-bi-cloud-today.timer` 每两小时刷新当天销售。
- 滚动后置 BI 的验收重点是销售文件入仓和 BI Portal 更新时间；RTV 换单复核耗时不应作为“BI 没更新”的判断依据。
- BI Portal API section 会在 `outputs/bi-portal/sections/` 缓存；首页首屏优先加载轻量 `homeRankings`，完整 `rankings` 放到详情/子页需要时再拉。`homeRankings` 只包含首页需要的日店铺、日货号、日店铺×货号粒度，并由服务端裁掉重复长文本后以 gzip sidecar 返回。`inventoryTrend` 是展示库存趋势 section，来自 `fact.visible_inventory_snapshot`，用于“前台展示库存每日快照”趋势；它不同于 ET 货代仓实盘可售，也不同于成本表供给。`cloud_bi_refresh.sh` 会启动 section 预热脚本；`serve_bi_portal.mjs` 还会用 core `generatedAt` watcher 在服务启动和首页访问时兜底预热，避免新 core 后用户首开页面才生成慢 section。首页利润 `homeProfit` 仍从当前 `profit` section cache 派生；若页面首页利润异常偏低，先核对 `homeProfitSummary.sourceGeneratedAt` 与当前 `data.json.__sections.generatedAt` 是否一致，并确认 `staleSource=false`；否则页面应视为利润待预热，不能用旧利润判断业务。
- 首页库存相关口径必须分开：`展示库存趋势` = SHEIN 前台展示库存快照；`ET可售` = 货代仓实盘可售；`成本表供给` = 到仓 + 在途 - 已售。不要把 `ET可售 + 在途` 当成总供给，也不要把展示库存趋势当成 ET 实盘。
- 如果某个店失败，但目标日期当前启用店铺销售源文件已经齐，BI 仍应刷新；云端 watchdog / 异常通知负责提醒失败店铺和服务异常。
- 业务域单店失败不应阻断销售入仓和门户刷新，应在 BI 体检/提醒里标注。
- `send_daily_lark_report.mjs` 仍保留；生产日报由云端 `shein-bi-cloud-daily-lark-report.timer` 调度，不要默认本地日报任务仍在生产运行。

## 6. 链接表现更新规则

- 链接表现每天更新一次即可，适合放在后半夜。
- 本地历史任务 `SHEIN-Sales-15Stores-LinkManagement-0530` 已封存禁用；当前生产由云端 `shein-bi-cloud-link-business.timer` 每天 `05:30` 执行。
- 云端手动补链接/业务域应在服务器运行 `scripts/cloud_link_business_sync.sh yesterday` 或指定日期；该入口按店顺序启动 headless Chrome，抓完即关闭浏览器，随后入仓、体检并刷新 BI。不要用本机补抓冒充云端日更。
- BI 门户侧栏的“链接表现数据”更新时间应显示源文件抓取时间：`outputs/shein_links/<店铺>/<链接日>.json` 内 `fetchTime` 的最大值；“售后/库存/财务数据”更新时间应显示业务域源文件抓取时间：`outputs/shein_business_domains/<店铺>/<业务日>.json` 内 `fetchTime` 的最大值；BI 重跑重新入仓时产生的数据库 `updated_at` 只可作为内部排障字段，不作为主要更新时间展示。
- 如果部分店失败：尽量同步成功店铺，并发送飞书异常提醒。
- 旧 `SHEIN-Sales-15Stores-LinkManagement-0340` / `SHEIN-Sales-15Stores-LinkManagement-0510` 不应恢复。

## 6A. ET 货代仓与 RTV 换单复核

- ET 专属 profile：`profiles/persistent-et-forwarder-profile`。
- ET 本地每日同步任务 `SHEIN-Sales-ETForwarder-0420` 已封存禁用；抓取器 `scripts/fetch_et_forwarder.mjs` 和入仓器 `scripts/load_et_forwarder_warehouse.mjs` 仍保留，后续需迁成云端任务后再恢复自动同步。
- ET 登录态过期时，抓取器会调用 `scripts/et_login_helper.py`，读取 ET profile 中 Chrome 已保存的凭据并用本地 OCR 识别验证码；日志和文档不得输出密码。
- ET 货代仓也适用“非必要不打开前端窗口”：`scripts/fetch_et_forwarder.mjs` 默认 `visible=false` 并用 `WindowStyle Hidden` 启动 Chrome；自动登录优先走 `scripts/et_login_helper.py` + OCR。只有 OCR/验证码连续失败、登录态必须人工处理、用户明确要求，或必须排查浏览器交互问题时，才允许临时加 `--visible` 打开 ET 前台窗口，处理完必须关闭。
- RTV 主利润口径继续保守：反转订单营收按 0，仍扣商品成本；ET 已收件只进入“RTV 已收可二次销售测算”，不自动改主利润。
- SHEIN 售后列表中的退货物流号可能不是 ET RTV 最终入仓号；`scripts/verify_shein_rtv_tracking.mjs` 会读取 SHEIN 售后详情和退货物流详情，识别 `new waybill number [...]` 等换单证据，并写入 `ops.rtv_tracking_verification`。
- SHEIN 物流详情可能返回中文轨迹，例如 `新的运单号[6031326736754]`、`运单已...更换`；解析器必须同时识别中英文换单提示。示例：`ZL / 16FBC044CV / 6031126719507` 已匹配 ET RTV `TH26040146319 / 6031326736754`。
- `JT` / `JTE` 这类退货物流通常不换面单；复核脚本会先按 ET RTV 物流号在 SHEIN 售后退货物流号里做全店精确直连匹配，即使 ET 货号编码和 SHEIN 标准货号不一致，也以“同一退货运单号”为强证据入库，并在利润二售测算里按 SHEIN 订单货号归属。
- iMile / EMile 数字单号仍按“退货物流详情中的换单轨迹”识别，不因单号像数字就直接匹配；找不到明确换单轨迹的仍留在待复核池。
- ET SKU 上的 `DL-` 等前缀只能作为仓库编码线索，不能硬当销售店铺；RTV 换单复核必须按“标准货号 + 时间窗口”全店搜索售后单，店铺前缀只用于排序，不用于过滤。
- 本地每日 `07:00` 复核逻辑已封存；手动或云端迁移后复核仍默认覆盖 high/medium/low 候选并包含无候选售后单记录，`limit=120`、`case-limit=60`，并受 `max-runtime-ms=3600000`（60 分钟）硬保护。RTV 复核本来就比较耗时，耗时长不是异常；滚动销售 BI 刷新不应等待该步骤。
- `mart.rtv_recovery_impact` 和 `mart.rtv_manual_review_candidates` 会吸收 `ops.rtv_tracking_verification.match_status='matched'` 的结果；确认匹配后退出 BI 的“RTV 换单待复核”表。
- RTV 收到后去了哪里，使用 `mart.et_rtv_destination_allocation` 从 ET 库存流水推断：直接入 `ETRUH09散件仓`、`平台RTV` 入 `ETRUH03_RTV` 后续调拨到 09、仍在 03、调拨到 `ETRUH04Damaged`、转 `ETRUH06报废` 或其它/未知，均按同货号库存池 FIFO 分配。该口径是库存流水级证据，不是序列号级扫描；但可用于更严谨的 `rtv_09_recoverable_cost_sar` / “09 可二售”测算。
- `mart.shein_return_rtv_trace` 是面向页面和复核的明细视图：每条 SHEIN 退货单给出 `trace_status`（未匹配 ET、已收可售 09、仍在 03、破损 04、报废 06、未知/未解析）和 ET RTV 单号、物流号、仓库去向。BI `订单 / 售后` 页面展示“退货收件 / 仓库去向追踪”，用于回答“每个退货到底收到没有，收到后去了哪里”。

## 6B. BI 门户 UI 自动体检

- `scripts/check_bi_portal_ui.mjs` 是本地/回滚时的无界面 UI 体检入口；本地封存后，默认不要为“看一眼”重启本地前端，云端优先用 HTTP health、静态断言和日志验证。
- 报告写入 `outputs/bi_ui_check/latest.json` 和带时间戳的历史 JSON；失败时才保存截图，避免每天无意义占用磁盘。
- 该检查只读，不点击提交、保存、下架、报名等不可逆动作；本地历史流水线中它是非阻断步骤，云端化前优先用 HTTP health、静态断言和日志验证。

## 7. HL 主账号与 profile 边界

- HL 已切换为主账号：`profileKey=shein-main`，端口 `9360`。
- 正式 profile：`profiles/persistent-shein-main-profile`。
- 旧 `profiles/persistent-hl-profile` 已删除。
- 相关脚本和写表链路都应读取 `config/stores.json`，不要硬编码旧 HL profile 或旧端口。
- LGM 组当前本身就是主账号，不需要替换。
- 2026-06-05 已修正并覆盖旧的 YJ/XL/QY 交叉 profile 结论：当前正确绑定为 `YJ=profileKey yj/accountNo GS8146729/port 9346`、`XL=profileKey xl/accountNo GS9307061/port 9344`、`QY=profileKey qy/accountNo GS7451160/port 9345`。核验错位必须同时看 `config/stores.json`、`config/store_account_truth.json`、浏览器保存账号、实际登录后的店铺名/账号和 live 抓数归属，不能只看页面文本或旧 profile 目录名。

## 8. BI 门户当前 UI 规则

- 非必要情况下不要打开前端/可见浏览器窗口；默认用后台、headless、HTTP/CDP、日志、JSON、静态检查和 UI 冒烟脚本验证。只有首次登录、验证码/人机验证、用户明确要求看前台、或必须排查浏览器交互问题时，才打开可见窗口；完成后应关闭。

- 首页是“总控驾驶舱”，主要承载总览、分组、趋势和排行榜。
- 首页看板筛选联动是当前首页核心口径，不能只改一个模块而不联动其它模块。
- 页面最上方 sticky 工具栏是全局筛选区，只放真正全局有效的条件：时间段、店铺/分组、货号/SKC/品名、全局搜索。
- 顶部全局筛选会影响首页、店铺、货号 360、SKC/链接、评价/口碑、订单/售后等需要当前时间范围的页面。
- `今日动作池` 是当前最新待办池，不按时间段回看；动作池页不显示时间选择窗口，也不把 `startDate/endDate/rangePreset` 写入当前动作池视图链接。
- `业务域`、`风险`、`处理状态`、`快速聚焦` 只属于 `今日动作池`，必须放在动作池页面顶部 sticky 工具栏里的“动作池专用筛选”区域；它们不得影响评价、订单/售后、店铺、货号或 SKC/链接页面。
- 今日动作池同一店铺、同一 SKC、同一业务域命中的多条规则必须合并成一张动作卡，展示“合并 N 条”和各规则信号，避免同一链接重复处理；不同业务域仍分开，避免把链接、库存、售后等不同动作误合并。
- URL hash 即使残留 `domain/risk/status/focus`，非动作池页面也必须忽略这些条件，避免隐形筛选造成“数据消失”。
- 需要当前时段口径的子页面，把时间筛选嵌入顶部全局筛选区，不再另做内容区悬浮时间条。
- 首页看板内有货号/SKC/品名筛选和店铺/分组筛选；店铺筛选支持 `全部店铺`、`DSY 组`、`LGM 组` 和 16 个单店。
- 首页顶部矩阵、日销趋势、月销趋势、店铺排行、产品排行都要同时受时间段、店铺/分组、货号/SKC 筛选影响。
- 首页默认未筛选时，顶部矩阵显示 `总计 / DSY 组 / LGM 组`；筛到单店或分组时，只显示对应范围。
- 首页日销趋势默认近 30 天，月销趋势默认过去 6 个月；筛到货号 + 店铺组合时，使用 `rankings.dailyStoreProducts` 的店铺×货号日粒度数据。
- 时间选择弹窗使用大号双日历：左侧开始日期，右侧结束日期；快捷按钮放在弹窗外侧。
- 侧栏每个数据域只显示一条精确到秒的更新时间；数据口径日放在鼠标悬停提示里，避免同一数据域显示两个时间。
- 从任意子页面点击“总控驾驶舱”必须回到页面顶部，不滚到 `#overview` 中段。
- 趋势图纵轴使用整数刻度，图上关键节点显示完整数字；鼠标悬停可看完整 SAR 数值。
- 店铺视角的 7 天 / 30 天链接指标使用真正二级表头：第一行指标组，第二行周期，正文每个周期数字独立列，避免 `<br>` 拼接造成错位。
- 店铺视角的低展示库存预警来自 `fact.visible_inventory_snapshot` 最新正确展示库存快照，按本店已上架且展示库存低的 SKC 全量列出；动作池库存动作只是精选待办，不代表低库存全量。
- 首页顶部矩阵支持口径切换并联动趋势：销售额切 `净销售额/总销售额`，订单销量切 `净销量/总销量`，退货售后切 `售后申请时间/订单创建时间`，真实利润切 `退货全损保守/RTV已收入仓可二售测算`。
- 首页默认“成交额/销售额”为净成交额：买家已发起且未取消的售后申请默认计入退货/反转，包含 `待买家退货`、`待交接`、`待卖家处理`、`待买家选择方案` 等未落定状态；最终取消后再在下一次业务域同步后冲回。退货、仅退款、派送失败等反转订单不计入成交额、订单数和销量；“总销售额/总销量”仅统计正销售额订单行。`sales_sar <= 0` 或 `gross_revenue_sar <= 0` 的揽收前取消 / 0 金额行在净口径和总口径里都直接忽略，就当没有发生。
- 首页顶部退货 / 售后矩阵显示当前时段数量和售后订单金额，金额同时展示 SAR 和按 `1 SAR = 1.8 RMB` 估算的 RMB。
- 评价 / 口碑页读取 `fact.product_comment`，用于按货号、店铺、SKC 和评价内容筛选历史评价；低星、质量投诉和差评标签优先展示。
- 评论中文翻译不要依赖浏览器插件或本地启发式翻译；正式口径是 SHEIN 评论列表接口 `translate: 1` 的平台译文，写入 `fact.product_comment.goods_comment_content_zh`，页面保留原文和中文并存。
- 成本 / 利润页读取 `mart.profit_*` 视图；首页“当前时段真实利润”和“月利润趋势”也使用同一套利润口径。

- 成本/利润页前端展示必须基于 `profit_daily_store_product` 按当前时间、店铺/分组、货号/SKC 重新聚合；不要把 `mart.profit_product_summary` 的全局历史货号汇总直接用于当前筛选表格。

## 9. 成本 / 利润运维口径

### 9.1 成本文件入口

- 成本文件统一放在 `inputs/costs/`。
- 当前正式成本文件：`inputs/costs/成本.xlsx`。用户以后更新成本表时，优先替换这个文件；导入脚本会先清理同源文件旧记录再写入，避免旧批次残留。
- 模板文件：`inputs/costs/SHEIN成本表模板.xlsx`。
- 导入脚本：`scripts/import_product_costs.mjs`。
- 手动导入单个文件示例：`node .\scripts\import_product_costs.mjs --file .\inputs\costs\你的成本表.xlsx`。
- 每日 BI 流水线 `scripts/run_bi_daily_pipeline.ps1` 会自动扫描 `inputs/costs/` 并导入非模板的 `.xlsx/.xlsm/.csv` 文件。
- 成本导入是非阻断步骤：导入失败会记录 warning，但不能阻断销售/订单、业务域和 BI 门户刷新。

### 9.2 成本表字段和计算

- 一行成本批次代表同一个货号的一批货。
- 同货号单位成本 = 完整批次总成本 / 完整批次发货总数。
- 如果表里已有 `单台总成本（SAR）`，它代表这一批的单件完整成本；入库时会还原成“这一批总成本 = 单台总成本 × 数量”，最终仍按同货号所有完整批次加权平均。
- 完整批次至少要有：货号、发货数量、货款金额、头程运输费金额。
- 缺头程运输费金额的批次会写入 `fact.product_cost_batch`，但 `complete_batch=false`，不参与单位成本均摊。
- 成本默认人民币转 SAR，汇率沿用 `1 SAR = 1.8 RMB`；如成本文件本身为 SAR，脚本会按 SAR 写入。
- 如果成本表有长宽高/重量，会写入 `volume_l`、`weight_kg`，用于选品模型和体积利润率分析。
- 成本匹配同时兼容销售端标准货号和成本表型号代码，例如销售端 `SM-505A电动缝纫机` 可匹配成本表 `SM-505A`；匹配键由 `dim.product_match_key()` 提供。
- 历史测试品 `2001/CM-2001` 已按用户确认补一条手工成本：总成本 `5500 RMB`、数量 `37`，文件为 `inputs/costs/历史手工成本补充.csv`；该品已停做，只用于历史利润复核。

### 9.3 利润计算

- 商品/店铺/货号层利润：`净营收 - 商品成本 - 退货派送费`。
- 未取消售后申请、退货、仅退款、派送失败等保守处理订单：营收视为 `0`，仍扣商品成本；只有真实退货退款链路额外扣 `13.88 SAR` 退货派送费，`仅退款`、`派件失败`、`派件异常` 不重复扣退货派送费。
- 但 `sales_sar <= 0` 的 0 金额订单行（常见为“揽收前已取消”）不视为真实售出，不扣商品成本，也不加 `13.88 SAR` 退货派送费；否则会把取消单误当卖出后毁损，严重压低利润。
- 利润率：`利润 / 净营收`。净营收为 0 时利润率为空，不硬算。
- 成本/利润页高利润 / 低利润货号分界线固定为 `20%` 利润率：`>= 20%` 为高利润 / 可加码，`< 20%` 为低利润 / 需要处理。
- 成本缺失的订单行不参与真实利润额计算，并在页面显示成本覆盖率和缺成本销售额。
- 仓储费正式来源是 ET 物流仓服账单 `仓储费`：显示金额按 RMB 读取，实际扣费按显示金额 × 0.5 后折 SAR；`fact.monthly_storage_fee` 仅保留为旧手工/历史兜底表。
- 仓储费已纳入真实利润。店铺和 DSY/LGM 按净销售额分摊；货号层优先使用 ET 仓储费导出明细，若历史明细合计与总账不一致则按每日总账缩放并标记 `download_detail_scaled_to_bill`，只有完全缺明细日期才使用 ET 体积 × 库存天数估算并校准到每日实际仓储费总额，页面必须标注兜底口径。
- ET 仓储费导出码与 BI 展示货号分层处理：`storage_code` / `sku_code` 保留 ET 原始码，`match_key` 只做内部归并；BI/利润展示使用 `mart.product_display_by_match_key` 选出的销售或商品主档标准货号，不能把规范化中间短码当作新货号展示。
- 月利润复核不能只看当前订单创建月结果；还要看售后申请月对历史订单月的回冲。2026 年 3/4/5 月审计见 `docs/bi-profit-audit-2026-03-05.md`：当前主利润公式未发现少扣退货，5 月利润暂高主要来自售后反转率尚低、成本率较低和退货快递费较少；5 月仍处售后成熟期，不能当最终稳定利润。

- 选品标尺模型：成本表缺长宽高时，先用历史头程 / `1600 RMB/方` 倒推出单件估算体积，再按未来 `2000 RMB/方` 重算新选品头程；矩阵分箱按进货价和体积，并用真实历史利润率、利润额、销量、ROI 校准。
- `TS`、`MZ` 开店以来都归 `DSY`；利润视图和 BI 净成交首页数据都按当前店铺配置分组。

### 9.4 数据库对象

- 成本批次表：`fact.product_cost_batch`
- ET 仓储费总账：`fact.et_income_bill` / `mart.et_storage_fee_daily`
- ET 仓储费货号明细：`fact.et_storage_fee_product_detail` / `mart.storage_fee_product_daily`
- 旧手工月仓储费兜底表：`fact.monthly_storage_fee`
- 当前单位成本视图：`mart.product_unit_cost_current`
- 退货/派送失败影响视图：`mart.profit_after_sales_impact`
- 订单行利润视图：`mart.profit_order_item`
- 日店铺货号利润视图：`mart.profit_daily_store_product`
- 月分组利润视图：`mart.profit_month_group`
- 货号利润汇总视图：`mart.profit_product_summary`

## 10. 团队访问边界

- 当前团队入口为云端 `https://shein-bi.faceair.me/`，旧 IP `http://43.165.167.135/` 仅作兜底，通过 Basic Auth 限制访问。
- 本地局域网协作入口已封存；本地 `8787` 无监听服务，Windows 计划任务已禁用。
- 原 Windows 防火墙规则 `SHEIN BI Portal LAN 8787 ReadOnly` 若仍显示启用，不代表本地 BI 已开放；关闭规则需要管理员权限。
- 同事可标记动作状态、填写负责人和备注；共享状态写入 `state/bi_action_state.json`，每次写入会记录 `updatedBy` / `updatedByUser`，当前以访问 IP 留痕；审计日志追加到 `logs/bi_portal_action_audit.jsonl`。
- 通过本机网页服务打开门户时，动作状态同样写入 `state/bi_action_state.json`。
- 直接双击 HTML 打开时，动作状态只保存在当前浏览器。
- 团队长期正式版已具备域名与 HTTPS；后续还需要多人编辑冲突控制增强、动作状态入 PostgreSQL、异地备份和更正式的账号权限。

## 11. 不要做的事

- 不要恢复旧 `SHEIN-Sales-15Stores-LinkManagement-0340` / `SHEIN-Sales-15Stores-LinkManagement-0510`。
- 不要因为 BI 开发中断飞书销售同步、链接同步、日报和正式看板刷新。
- 不要删除 `267014` 历史失败记录。
- 不要把密码、cookie、短信验证码写入文档、日志或聊天。
- 不要把所有登录页都直接升级为“必须用户本人处理”：协议签署、公告、通知确认、`知道了` / `确认` / `同意` 这类普通登录干扰弹窗，可在可见窗口/noVNC 中由运维代理处理后再点登录；但验证码、滑块、短信、人脸、缺密码，以及新的法律/资质/付费/授权范围承诺不明内容必须停下让用户处理。
- 不要重新开放本地公网或端口转发；长期团队访问走云端，公网域名和 HTTPS 已配置，后续重点补异地备份和更正式的账号权限。
- 不要删除整个 `profiles/persistent-*-profile`；如需瘦身，只清 Chrome 可重建缓存，尤其是 `OptGuideOnDeviceModel`。
- 不要把缺头程运费的成本批次强行计入单位成本。
- 不要把货号仓储费估算当主路径；优先使用 ET `ExportStoreFee` 下载明细。历史明细金额与总账不一致时，用明细分布按总账缩放；完全缺明细日期才允许估算兜底并标注口径。
- 不要在成本覆盖不足时用 `25%` 预测利润填充真实利润页面。

## 12. 常用验证

- 检查云端 BI 门户：打开 [https://shein-bi.faceair.me/#tab=system](https://shein-bi.faceair.me/#tab=system)。
- 检查云端健康：未鉴权访问 `https://shein-bi.faceair.me/api/health` 应返回 `401`；带 Basic Auth 应返回 `200`。
- 检查首页利润缓存：带 Basic Auth 访问 `https://shein-bi.faceair.me/api/bi/section/homeProfit`，确认 `data.homeProfitSummary.staleSource=false` 且 `sourceGeneratedAt` 等于当前 `data.json.__sections.generatedAt`；服务器侧可读 `/opt/shein-bi/app/outputs/bi-portal/sections/{profit,homeProfit}.json` 做同样核对。
- 检查本地是否仍封存：`http://127.0.0.1:8787/api/health` 应无法连接；若能连上，说明本地 BI 被重新启动，需要确认是否为回滚。
- 修改 BI 门户 UI 时，默认先后台验证：`node --check scripts/generate_bi_portal.mjs`、`$env:SHEIN_BI_PORTAL_TIMEOUT_MS='900000'; node scripts/generate_bi_portal.mjs`、静态检查 `outputs/bi-portal/index.html` / `data.json`。除非用户要求或必须排查浏览器交互问题，不主动打开前端。
- 云端是最终审核面。涉及 V1 弹窗/筛选/页面交互时，发布前必须在云端页面或云端服务输出复核；时间筛选月份切换的关键证据是弹窗保持 `hidden=false`、`aria-expanded=true`，月份标题正确更新且无 console error/warn。
- 检查 HL OpenAPI 销售试点：`node scripts/fetch_shein_openapi_sales.mjs HL --start YYYY-MM-DD --end YYYY-MM-DD` 后运行 `node scripts/load_shein_openapi_sales_warehouse.mjs --store HL --start YYYY-MM-DD --end YYYY-MM-DD`，再在系统状态页查看 “SHEIN OpenAPI 试点对账”。
- 检查 WebAPI 销售直连：`node scripts/fetch_shein_sales.mjs HL --date YYYY-MM-DD --transport webapi --json`，再和 `outputs/shein_fetch/HL/YYYY-MM-DD.json` 或数据库切片对账。
- 检查取消单口径：先 dry-run `node scripts/repair_shein_sales_summaries.mjs --start YYYY-MM-DD --end YYYY-MM-DD`；确认后再加 `--write`。写回后运行 `node scripts/audit_shein_sales_logic.mjs --month YYYY-MM --date YYYY-MM-DD --offline`。
- 检查成本文件解析但不入库：`node .\scripts\import_product_costs.mjs --dry-run`。
- 重新创建成本模板：`node .\scripts\create_cost_template.mjs`。
- 检查 BI 自动任务：`检查SHEIN-BI自动任务.cmd`。
- 查看最新 BI 体检：`outputs/bi_audit/`。
- 查看最新 BI 流水线日志：`logs/bi-daily-pipeline-*.log`。
- 查看链接任务日志：`logs/jobs/` 和 `logs/manual/`。

### 12.1 Docker / WSL 数据盘异常恢复

- 典型现象：BI 流水线或 PostgreSQL 报 `input/output error`，Metabase / warehouse 容器不可用，或 Docker API / PostgreSQL 查询异常。
- 数据位置：Docker 数据盘为 `D:\SheinBI\docker-data\docker-data.ext4`，WSL 发行版位于 `D:\WSL\Ubuntu-24.04`。
- 恢复原则：先停止 WSL / Docker，再备份 Docker volumes，确认备份存在后对 ext4 数据盘执行 `e2fsck -fy`，最后启动容器并跑 BI audit；不要直接删除 Docker 数据。
- `2026-05-05` 已按上述流程恢复一次，并备份到 `D:\SheinBI\docker-data\recovery-backups\volumes-backup-20260505-094819.tar.gz`。
- 恢复后必须验证：`http://127.0.0.1:8787/`、`http://DUSHENGYI-PC2:8787/` 或当前 WLAN IPv4 入口返回 200，BI 流水线最新日志为 `success`，BI audit 无 warning / error。

## 13. 货号 / 评价 / 动作池当前运维口径

- 货号页 `全店覆盖与承接` 的销售口径是“本店 + 标准货号 + 当前时间段”的全部 SKC / 链接合计销售；最佳 SKC 不承担销售汇总口径，只承担承接判断口径。
- 如果 `本货号待处理动作` 里重复弱链接没有完整同组链接表，优先用动作池证据解析出弱链接与最佳链接销量差距，不能直接写“暂无可对比”。
- `SKC 数据复核区` 是订单、财务、售后三方互证区，不作为每日必处理清单。
- 评价页必须支持顶部全局时间段筛选；日常评价抓取任务每日执行一次，并把 SHEIN 平台译文作为批处理字段写入数据库，页面不做实时浏览器翻译。
- 今日动作池可见证据必须是业务字段名，不显示原始 `key=value` 代码式证据。
- 今日动作池同店同 SKC 同业务域动作合并后，状态、负责人、备注按合并卡统一保存；若合并前任一单条动作已有处理状态，合并卡读取并沿用既有状态，避免用户处理记录丢失。

## 14. 2026-05-03 本轮修正落地

- 货号页的重复弱链接对比已改为读取全量 `DATA.storeLinks`。遇到 `sv260211161429504151036` 这类动作，页面必须展示同店同款完整链接表，而不是提示“明细池未取到完整同组链接”。
- 链接对比指标顺序统一为 `曝光 / 访客 / 销量 / 支付率`，均展示 `7天 / 30天` 二级表头。
- 制冰机归并规则落地到 `config/product_aliases.json` 和历史仓库数据：`制冰机`、`03038`、`SK-03038` 等统一到 `SK-03038制冰机`。
- `fact.product_comment` 已按开店以来全量评价入库：当前 `1796` 条，`1794` 条有 SHEIN 平台译文，`translation_provider='shein-platform'`；日常新增评价由业务域同步直接写入平台译文，不再运行旧的本地翻译脚本。

## 15. 历史乱码归档

- `2026-05-03` 已将旧 `MEMORY.md` 和执行记录中的历史乱码内容原样备份到 `backups/doc-mojibake-archive-2026-05-03T14-20-00/`。
- 当前接手优先阅读本文、`README.md`、`docs/bi-portal-ui-current.md` 和根目录 `MEMORY.md`。
- 归档文件只作为历史排障追溯，不作为当前运行口径依据。

## 16. 2026-05-03 评价全量与平台翻译口径（当前权威）

- 评价/口碑底库按每店开店以来全量补抓；日常新增评价同步默认只抓最近 `14` 天作为防漏增量窗口，既覆盖小范围延迟/补跑，也避免 90 天过长窗口浪费资源。
- 评论中文翻译使用 SHEIN 评论列表接口的 `translate: 1` 平台译文，写入 `fact.product_comment.goods_comment_content_zh`，`translation_provider='shein-platform'`；旧的本地启发式翻译和 `scripts/translate_product_comments.mjs` 不再作为生产口径。
- 2026-05-03 原 16 店全量评价补抓基线：`fact.product_comment` 共 `1796` 条，最早评价日期 `2025-10-04`、最新评价日期 `2026-05-04`；`1794` 条有 SHEIN 平台译文，剩余 2 条为原文为空，无需翻译。新增店铺的评价随日常业务域同步进入仓库。
- 全量补抓脚本：`scripts/backfill_shein_comments_full_history.mjs`；日常业务域同步脚本：`scripts/fetch_shein_business_domains.mjs` + `scripts/load_bi_business_domains.mjs`，抓取时同时合并平台译文。
- SHEIN 评论接口在大时间窗下可能返回 `mgs97906 数据量太多...缩小评论时间`，因此全量补抓必须按日期窗口分段，并在必要时自动拆分。
