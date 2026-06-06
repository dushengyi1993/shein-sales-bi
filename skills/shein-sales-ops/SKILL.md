---
name: shein-sales-ops
description: SHEIN/希音销售统计自动化项目专用工作流。用户提到 SHEIN 店铺抓取、DSY/LGM、订单创建时间、SAR/RMB、货号归并、飞书 Base、经营看板、日报、历史回补、退货/成本利润、营销活动报名或本工作区时使用。优先执行脚本，Markdown 只保留长期规则和入口。
---

# SHEIN Sales Ops

## 先读
- `MEMORY.md`
- `.codex/plans/2026-04-26T16-56-52-shein-sales-automation-plan.md`
- 本文件

读取后优先用脚本获取当前状态，不要把历史流水全塞进上下文。

## 当前资产
- 工作区：`E:\Codex WorkSpace\Shein销售统计`
- Base：`https://zcnm3ts63aph.feishu.cn/base/SnnQbrAu6aLzMWsnEICcy0cKnJh`（当前标题已标注多维表格同步暂停、日报正常）
- 当月主看板：`SHEIN经营看板 v3-主看板`，ID `blkFn3qHrwdsrJyX`，数据源 `看板数据-MAIN-*`
- 上月看板：`SHEIN经营看板 v3-上月`，ID `blkWeyZhphgRZYim`，数据源 `看板数据-PREV-*`
- 店铺：DSY=`DL DX FY LQ NM HL JY ZL TS MZ`；LGM=`CX YJ XL QY QH TZ JSH TZZ XC`。
- 云端 BI 正式入口：`https://shein-bi.faceair.me/`，旧 IP `http://43.165.167.135/` 仅作兜底，Nginx Basic Auth 保护；本地 `8787` 服务和 `SHEIN-*` Windows 任务已封存禁用，除非明确回滚不要重启。
- V1 是当前正式 BI Portal；当前 V1/main 发布边界已到 `2026.06.03-home-profit-cache-hotfix`（同日 `2026.06.03-et-forwarder-hotfix` 处理 ET 刷新轻量化）。V2 仍是平行预览/开发，不进正式 release，也不纳入日常自动刷新。
- 云端生产调度：`shein-bi-cloud-today.timer` 每两小时刷新当天销售、入仓并生成 BI Portal；`shein-bi-cloud-yesterday.timer` 每天 `00:10` 刷新前一天最终版并复核稳定日；`shein-bi-db-backup.timer` 每天 `02:30` 备份数据库；`shein-bi-cloud-rtv-verify.timer` 每天 `03:20` 跑完整 RTV；`shein-bi-cloud-session-manager.timer` 每天 `03:20` 巡检/恢复 19 店登录态；`shein-bi-cloud-et-forwarder.timer` 每天 `04:20` 跑 ET；`shein-bi-cloud-link-business.timer` 每天 `05:30` 跑链接/业务域；`shein-bi-cloud-openapi-hl.timer` 每天 `06:20` 跑 HL OpenAPI 双跑；`shein-bi-cloud-daily-lark-report.timer` 负责云端飞书日报；`shein-bi-cloud-watchdog.timer` 每小时巡检；`shein-bi-lark-sales-qa.service` 常驻只读问数。
- HL OpenAPI 销售试点已建立并行链路：`outputs/shein_openapi_fetch/HL/YYYY-MM-DD.json` -> `fact.openapi_*` -> `mart.openapi_sales_reconciliation`；正式切换前继续累计多日 `matched`。CX / ZL 应用已提交审核，审核通过前不得录入 `.local` 密钥或切换生产源。
- 当前 19 店销售生产抓取已改为 WebAPI 直连优先：`config/stores.json.salesTransport=auto`，session 文件在 `state/shein_webapi_sessions/*.local.json`，直连成功不启动浏览器；浏览器只作刷新 session、登录续期和回退。
- ET 货代仓已接入仓库和 BI；云端 ET 同步已启用并验证成功。RTV 复核耗时长是正常现象，滚动销售刷新不应等待完整 RTV。
- LGM profile 映射：`CX=profile cx/GS9489101`，`YJ=profile yj/GS8146729`，`XL=profile xl/GS9307061`，`QY=profile qy/GS7451160`，`QH=profile qh/GS8715910`，`TZ=profile tz/GS5636781`，`JSH=profile jsh/GS3308359`，`TZZ=profile tzz/GS7146778`，`XC=profile xc/GS2944318`。`YJ/XL/QY` 已在 2026-06-05 纠正为店铺代码与 profileKey 对齐；错位核验必须同时比对 `config/stores.json`、`config/store_account_truth.json`、浏览器保存账号、实际登录后的店铺名/账号和 live 抓数归属。

## 业务口径
- 统计日：北京时间自然日。
- 销售额：按 SHEIN 订单创建时间，汇总商品明细中的“有效销售行”。
- 有效销售行统一使用 `lib/shein_sales_validity.mjs` 判断；源头总销售只剔除真正取消、揽收前取消等“未形成销售”的行，例如 `pageStatus=CANCEL`、`goodsPerformanceStatus=6` 或订单/履约状态文本含取消。`用户已退款`、退货、派件失败等不能在源头抹掉，应保留为总销售，再由净销售额、售后/利润层反转。`currency_price` / `currencyPrice` 保留后台原始金额用于追溯。
- `fetch_shein_sales.mjs` 会给商品行补 `isValidSale` 和 `salesExclusionReason`；历史文件或修复窗口重算用 `scripts/repair_shein_sales_summaries.mjs`。`2026-05-13` 已写回 `2026-05-11` 至 `2026-05-13`，其中 LQ `2026-05-12` 无货取消 `SK-5118电磁炉` 从业绩中剔除；修正后的全历史 dry-run 只影响 `68 SAR`，此前 `43,472.16 SAR` 是误把退款/退货/派件失败当成源头取消的错误预览，已作废。
- 汇率：`1 SAR = 1.8 RMB`；BI 首页和成本/利润页使用真实利润口径，不再用 `25%` 预测利润冒充真实利润。
- 仓储费利润口径：ET 物流仓服账单 `仓储费` 是正式来源；显示金额按 RMB，实际扣费按显示金额减半后折 SAR。DSY/LGM/店铺按净销售额分摊，货号层优先 ET `ExportStoreFee` 导出明细；历史明细合计与总账不一致时按总账缩放并标记 `download_detail_scaled_to_bill`，完全缺明细日期才按 ET 体积库存天数估算并在 BI/营销中标注兜底口径。
- 仓储费货号展示边界：ET 原始 `storage_code` / `sku_code` 不改写，`match_key` 只做内部归并；对用户展示和利润商品维度时必须回到销售或商品主档的既有标准货号，不要把 ET 解析出的中间短码暴露成新商品。
- BI 净成交额：退货、仅退款、派送失败等反转订单不计入成交额、订单数和销量；仍扣商品成本，只有真实退货退款额外扣 `13.88 SAR`。
- 月利润判断要同时看订单创建月利润和售后申请月回冲影响；2026-05-29 云端 SQL 重审确认主利润公式未发现少扣退货，5 月暂高主要因售后反转率仍低、成本率较低和退货快递费较少。未经历完整售后成熟期的月份不能当最终稳定利润，详见 `docs/bi-profit-audit-2026-03-05.md`。
- 成本/利润页高利润 / 低利润货号按 `20%` 利润率切分：`>= 20%` 可加码，`< 20%` 需要处理。
- 今日动作池同一店铺、同一 SKC、同一业务域多条规则合并为一张动作卡；不同业务域仍分开。
- 产品销量：按标准货号归并；一单同产品 2 件计 2。
- 今日动销产品数：按分组、按当天统计标准货号去重数；某标准货号当天在该组任一店铺销量 `>0` 即计 1。
- 不做猜测性单店时区偏移；HL 的错误 `accountUtcOffsetHours=3` 已删除并回补。

## 定时任务
- 当前生产调度在云端 systemd：`shein-bi-cloud-today.timer`、`shein-bi-cloud-yesterday.timer`、`shein-bi-db-backup.timer`、`shein-bi-cloud-rtv-verify.timer`、`shein-bi-cloud-session-manager.timer`、`shein-bi-cloud-et-forwarder.timer`、`shein-bi-cloud-link-business.timer`、`shein-bi-cloud-openapi-hl.timer`、`shein-bi-cloud-daily-lark-report.timer`、`shein-bi-cloud-watchdog.timer`、`shein-bi-lark-sales-qa.service`。云端当前自动覆盖销售 WebAPI、销售入仓、BI Portal 生成、数据库备份、ET 货代仓同步、飞书日报、完整 RTV、链接/业务域日更、登录态巡检、异常通知、只读问数机器人和 HL OpenAPI 双跑。
- 本地 `SHEIN-*` Windows 任务已于 `2026-05-15` 封存禁用，保留为回滚/迁移参考；除非明确回滚，不要重新启用 `SHEIN-Sales-15Stores-Intraday-Daytime`、`SHEIN-BI-Daily-Pipeline-0700`、`SHEIN-Sales-15Stores-LinkManagement-0530`、`SHEIN-Sales-ETForwarder-0420` 或 HL OpenAPI 本地任务。
- 不要默认本地日报、watchdog、ET、链接/业务域或 OpenAPI Windows 任务仍在生产运行；云端飞书日报和只读问数使用独立机器人/应用，换机器人时需重新映射收件人 `open_id`。
- 历史规则仍保留：V1 门户生成放在流水线末尾单次执行，默认 `SHEIN_BI_PORTAL_TIMEOUT_MS=900000`，不要恢复多个状态点重复生成页面；RTV 复核耗时长不是滚动 BI 失败。

## 数据层
- 事实表：`店铺日报事实`、`产品日销量事实`、`订单明细事实`、`订单商品SKC明细事实`、`SKC链接映射`。
- 不合并订单明细事实和订单商品/SKC 明细事实；订单到商品/SKC 是一对多。
- 独立月表只保留当月和上月；更早月份进入年度汇总。
- 产品周/月销量只保留宽表。跨周/月必须先补齐新周期列再写入。
- 新建飞书 Base 表后提醒用户手动扩容到 `20000` 行。
- 当前飞书 Base / 看板写入受 `state/feishu-base-sync-paused.flag` 控制；存在该文件时不要手动补跑飞书表格、月表、宽表或 Dashboard 刷新脚本，除非用户明确要求恢复。
- BI 门户侧栏更新时间必须显示源文件抓取时间：销售取销售源抓取时间；链接取 `outputs/shein_links/<店铺>/<链接日>.json.fetchTime` 最大值；售后/库存/财务取 `outputs/shein_business_domains/<店铺>/<业务日>.json.fetchTime` 最大值。不要用 BI 重跑入仓 `updated_at` 冒充后台抓取时间。
- `fact.order_item.currency_price` 保留 SHEIN 原始金额；`fact.order_item.sales_sar` / `quantity` 是源头总销售口径下的有效销售额/销量。排查取消单时先看源 JSON 的 `isValidSale` / `salesExclusionReason`，再看入仓后的 `sales_sar=0` 是否一致；退款/退货/派件失败不应在这里变 0。
- RTV 换单自动复核结果写入 `ops.rtv_tracking_verification`；`mart.rtv_recovery_impact` 和 `mart.rtv_manual_review_candidates` 会吸收 `match_status='matched'` 的记录。`mart.et_rtv_destination_allocation` 和 `mart.shein_return_rtv_trace` 用 ET 库存流水追踪 09/03/04/06/未知去向。主利润仍保守，RTV 已收和 09 去向只进入“可二次销售测算”。RTV 复核是慢任务，排查滚动 BI 不更新时优先看销售入仓和门户更新时间，不把复核耗时当失败。

## 货号规则
- 标准货号：`config/product_catalog.json`
- 别名归并：`config/product_aliases.json`
- 归一化：`lib/product_sku_normalizer.mjs`
- 括号前缀只当备注，例如 `（废）SK-123` 按 `SK-123`。
- `2001胶囊咖啡机` 独立；`SK-3065/3065` 并入 `SK-GT-3065蒸汽熨烫机`。
- 2026-05-01 已新增 `SK-1711手持搅拌器`。
- 发现无法归并、疑似新货号或拿不准的短号/标题时，先生成确认清单给用户，不要擅自合并。

## 关键脚本
- 云端当天刷新：`bash scripts/cloud_bi_refresh.sh today intraday`（在服务器 `/opt/shein-bi/app` 执行）
- 云端前一天最终版：`bash scripts/cloud_bi_refresh.sh yesterday final`
- 云端数据库备份：`bash scripts/cloud_db_backup.sh`
- 本地封存复核：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/archive_local_bi.ps1`
- 单店浏览器：`node scripts/launch_store_browser.mjs DL --headless|--visible|--background`
- 单店抓取：`node scripts/fetch_shein_sales.mjs DL --date YYYY-MM-DD --transport auto|webapi|browser`
- 单组同步：`node scripts/run_sales_sync_job.mjs --mode intraday --group DSY`
- 销售当天同步（本地回滚参考）：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scheduled_intraday_dsy.ps1`
- BI 每日流水线（本地回滚参考）：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run_bi_daily_pipeline.ps1`
- 生成 BI 门户：`$env:SHEIN_BI_PORTAL_TIMEOUT_MS='900000'; node scripts/generate_bi_portal.mjs`
- 生成 V2.1 独立设计预览：`node scripts/generate_bi_portal_v2.mjs`；V2.1 只读复用 `outputs/bi-portal/data.json`，用户确认前不得替换 V1、进入 `main` release 或改生产调度。自 `2026-05-14` 起，V2 当前验收范围先限定首页：必须复刻 V1 首页功能/操作逻辑；其它子页尚未完成全量复刻。V2 暂时不跟随日常同步自动刷新，只有用户明确要求开发/优化/验收 V2 时才生成或维护。
- 云端 ET 每日同步：服务器执行 `bash scripts/cloud_et_forwarder_sync.sh today`；本地回滚参考才用 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scheduled_et_forwarder_daily.ps1`
- 云端链接/业务域日更：服务器执行 `bash scripts/cloud_link_business_sync.sh yesterday`；不要回退到本机补抓冒充云端日更。
- 云端登录态管家：服务器执行 `bash scripts/cloud_shein_session_manager.sh`；会顺序巡检/恢复当前 19 店 WebAPI + SBN 登录态。
- 云端异常通知：服务器执行 `node scripts/cloud_ops_watchdog.mjs --dry-run` 先看巡检结果；销售/页面按 4.5 小时阈值，链接/业务域按 48 小时日更阈值。
- 飞书只读问数机器人：服务器 systemd 常驻 `shein-bi-lark-sales-qa.service`，入口 `bash scripts/cloud_lark_sales_qa_bot.sh` / `node scripts/lark_sales_qa_bot.mjs --answer "今天销售多少"`；只能只读回答，不写数据库、飞书 Base 或 SHEIN 后台。
- RTV 换单复核：`node scripts/verify_shein_rtv_tracking.mjs --priority high,medium,low --include-no-cases --limit 120 --case-limit 60 --max-runtime-ms 3600000`
- 营销活动报名补填：规则见 `docs/marketing-campaign-signup-pricing-rules.md`。用户要先审核标准时，先跑 `node scripts/marketing/export_dsy_marketing_standards.mjs --stores DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ --all-open` 生成按货号汇总表；填报入口为 `node scripts/marketing/dsy_marketing_deadline_fill.mjs --stores DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ --all-open --price-overrides outputs/reports/marketing-price-overrides-YYYY-MM-DD-approved.json --min-discount-fallback SK-13034`。活动列表必须分页全量扫，默认排除优惠券；选择商品页必须先切到 `500 条/页` 再全选并核对 `总计 N 个 = 已选商品 N 个`；只允许填价和复核，不得点击最终 `提交报名`；完成后只保留需要用户提交的活动编辑页。
- HL OpenAPI 销售试点：`node scripts/fetch_shein_openapi_sales.mjs HL --start YYYY-MM-DD --end YYYY-MM-DD` 后运行 `node scripts/load_shein_openapi_sales_warehouse.mjs --store HL --start YYYY-MM-DD --end YYYY-MM-DD`，只写 API 并行事实表和 `mart.openapi_sales_reconciliation`。
- 月表：`node scripts/generate_monthly_sales_table.mjs --month YYYY-MM --include-lgm`
- 年度/宽表：`node scripts/generate_compact_display_tables.mjs --group ALL --current-month YYYY-MM --recent-months 2`
- 当月看板：`node scripts/setup_lark_dashboard_main_v3.mjs --month YYYY-MM`
- 上月看板：`node scripts/setup_lark_dashboard_previous_month.mjs --month YYYY-MM`
- 日报：`node scripts/send_daily_lark_report.mjs --send --visual`
- 今日详尽日报图：`node scripts/generate_today_detailed_report_image.mjs --date YYYY-MM-DD`
- 飞书日报文字和日报图不要附飞书 Base / 多维表格 / 原生看板链接；日报图店铺排行必须按 `config/stores.json` 当前启用店铺完整展示，不能沿用旧 Top15/16 店截断。
- 重算历史销售 summary：`node scripts/repair_shein_sales_summaries.mjs --start YYYY-MM-DD --end YYYY-MM-DD --write`；无 `--write` 时只 dry-run。全历史写回前先看 `totalDeltaSar`，避免把净销售反转误当源头总销售修复。
- 货号扫描：`node scripts/report_product_sku_candidates.mjs --group ALL --start YYYY-MM-DD --end YYYY-MM-DD`
- 逻辑体检：`node scripts/audit_shein_sales_logic.mjs --month YYYY-MM --date YYYY-MM-DD`
- 安装计划任务（仅本地回滚时）：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install_windows_scheduled_tasks.ps1 -IncludeWatchdog`
- 安全关店铺 Chrome：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/close_store_browsers.ps1 -Group DSY`
- 修复 BI 局域网防火墙（仅本地回滚时）：管理员执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fix_bi_lan_firewall.ps1`，应把规则 `SHEIN BI Portal LAN 8787 ReadOnly` 改为 `LocalAddress=Any`、`RemoteAddress=192.168.2.0/24`、端口 `8787`。

## 看板规则
- 用户会手动调整正式看板布局和大小；默认不调用 `+dashboard-arrange`，不重建无关组件，不改布局和尺寸。只有用户明确允许时才传 `--arrange`。
- 顶部 KPI 卡必须读 `KPI*` 字段，避免 `全部 + DSY + LGM` 重复求和。
- 颜色规范：全部/合计=绿色系，DSY=蓝色系，LGM=橙色系，产品榜=紫粉系。
- 店铺排行标签只显示排名+店铺代号，不显示 `DSY/`、`LGM/`。
- 不同榜单必须用独立排序字段：产品销量、产品销售额、店铺销售额、店铺销量不能共用排序标签。
- 顶部 `数据时间说明` 是飞书内部 `RICH_TEXT`。不要用公开 `dashboard-block-update` 改已存在 text block；用 `scripts/update_dashboard_time_richtext_ui.mjs` 走已登录飞书网页 profile 的内部保存链路。该步骤已在主看板脚本中做 3 次重试；失败时数据源可能已刷新，只是时间块滞后。
- 顶部 statistics 卡底板/字体颜色不在公开 `data_config` 中；用 `scripts/apply_dashboard_kpi_card_styles_ui.mjs` 或同类 Playwright 脚本通过飞书内部 `chart/user_change` 保存。

## 登录与抓取硬规则
- 销售抓取先 WebAPI 直连；`fetchTransport=webapi` 且 `browser.reason=webapi_transport_succeeded_without_browser_launch` 表示没有启动店铺浏览器。
- WebAPI session 文件含 Cookie，不得提交 GitHub、写入日志、文档或聊天；迁移时只走加密渠道或在新环境重新登录导出。
- 页面显示“我的订单/首页”不代表接口可用；接口 `20302 子系统登录重定向` 才是登录态失效硬信号。
- 遇到 `20302`，`run_sales_sync_job.mjs` 必须先刷新 WebAPI session / 调用 `auto_relogin_shein_store.mjs` 恢复登录并重新抓取；失败时提示人工登录，不得用旧数据。
- 自动登录脚本不读取、不输出账号密码，只检查保存密码是否填入并点击登录。
- 若某店保存密码看似失效，先确认启动时是否正确使用对应 profile 和 `--profile-directory=Profile 1`；JY 曾因 profile 环境未命中导致自动恢复失败。
- SHEIN 登录 URL redirect 必须 base64 编码。

## 工具
- 生产销售抓取链路：自写 Node WebAPI 直连优先；Chrome DevTools Protocol/WebSocket + 工作区 Chrome profile 用于导出/刷新 Cookie session、登录续期和回退。
- Chrome 路径：`launch_store_browser.mjs` 优先 C 盘正式安装路径，D 盘只兜底；店铺 profile 仍必须留在工作区。headless 启动失败时同步脚本会 fallback 到后台窗口模式。Windows 后台启动通过 `PowerShell Start-Process`，不要改回 `cmd start`。
- 飞书 Base/IM：`lark-cli`。
- 飞书看板富文本和样式：Playwright + `profiles/persistent-feishu-profile`。
- 本机有 `opencli`，PowerShell 下应调用 `C:\Users\dushengyi\AppData\Roaming\npm\opencli.cmd`。当前稳定生产链路暂不替换；可用于后续网页探索、临时浏览器操作或封装 lark-cli。

## 避坑
- 不要用 PowerShell here-string 写大量中文 JS/JSON；中文字段、货号、Dashboard 组件名优先用 UTF-8 文件、Node 脚本或 `apply_patch`。
- PowerShell `Set-Content -Encoding UTF8` 可能带 BOM；给 `lark-cli --json @file.json` 传 payload 时优先用 Node 写无 BOM JSON。
- 飞书 `EOF`、`HTTP 500/5000`、限流、证书/CDN 抖动先重试；不要发布半新半旧数据。
- `config/lark_report.json` 必须是合法 UTF-8 JSON；如果日报发送/读取配置异常，先用 JSON parser 校验它。
- 关键改动后跑逻辑体检，目标 `0 error / 0 warning`。
- BI 用户可见改动先在云端页面或云端服务输出验证，用户确认后再发布 GitHub `main` / release；本地验证不能替代云端最终审核。
- 首页利润或首屏长期“加载中”时先查 section cache，不要直接按页面数字下结论：`homeProfit` 从当前 `profit` 派生，`homeProfitSummary.sourceGeneratedAt` 必须等于当前 `data.json.__sections.generatedAt` 且 `staleSource=false`；`serve_bi_portal.mjs` 有 core `generatedAt` watcher，会在服务启动和首页访问时兜底预热 `homeRankings/profit/homeProfit/afterSales/actions/financeData/...`。若首页销售/订单/售后慢，先确认公网首屏命中轻量 `homeRankings` gzip cache、`/api/health` 的 `biCoreWarmup.status=done`，且各 section `generatedAt` 对齐。
- V1 时间筛选弹窗关键不变量：日期输入为文本 `YYYY-MM-DD`；点击月份切换后弹窗保持打开并更新月份，`aria-expanded=true`；按钮事件绑定实际弹窗 root，不能绑旧 toolbar root。

## ET 前台窗口规则
- ET 货代仓也适用“非必要不打开前端窗口”：`scripts/fetch_et_forwarder.mjs` 默认 `visible=false` 并用 `WindowStyle Hidden` 启动 Chrome；自动登录优先走 `scripts/et_login_helper.py` + OCR。只有 OCR/验证码连续失败、登录态必须人工处理、用户明确要求，或必须排查浏览器交互问题时，才允许临时加 `--visible` 打开 ET 前台窗口，处理完必须关闭。
