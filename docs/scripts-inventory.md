# scripts 目录脚本清单与保留边界

> 目的：避免 `scripts/` 越积越乱。本文先做分类和风险标注，不直接删除脚本；删除或归档前需要再次确认，尤其不能误伤云端 systemd 任务、本地回滚脚本和 BI 主链路。

## 云端生产定时任务直接引用，必须保留

这些脚本被云端 systemd unit 直接调用：

- `cloud_bi_refresh.sh`
- `cloud_db_backup.sh`
- `cloud_et_forwarder_sync.sh`
- `cloud_daily_lark_report.sh`
- `cloud_rtv_verify.sh`
- `cloud_openapi_hl_reconciliation.sh`
- `cloud_lark_sales_qa_bot.sh`
- `cloud_shein_session_manager.sh`
- `cloud_shein_session_manager.mjs`
- `archive_local_bi.ps1`：本地封存/复核脚本，供回滚前后检查使用。

## 本地 Windows 回滚 / 历史任务引用，必须保留

这些脚本曾被 Windows 计划任务直接调用或作为隐藏启动器使用；`2026-05-15` 本地任务已封存禁用，但脚本保留作回滚和 Linux 迁移参考：

- `run_scheduled_hidden.vbs`
- `scheduled_bi_daily_pipeline.ps1`
- `scheduled_intraday_dsy.ps1`
- `scheduled_link_management_daily.ps1`
- `scheduled_et_forwarder_daily.ps1`
- `scheduled_watchdog_dsy.ps1`
- `scheduled_yesterday_final_dsy.ps1`
- `scheduled_openapi_hl_reconciliation.ps1`
- `scheduled_openapi_hl_intraday.ps1`
- `scheduled_openapi_hl_yesterday_final.ps1`

## 当前生产主链路，必须保留

- 销售/日报/看板：
  - `run_sales_sync_job.mjs`
  - `fetch_shein_sales.mjs`
    - `fetch_shein_sales.mjs` 支持 `--transport browser|webapi|auto`、`--session-dir`、`--refresh-session`，当前生产配置为 WebAPI 直连优先。
    - `run_sales_sync_job.mjs` 读取 `config/stores.json.salesTransport` / `SHEIN_SALES_TRANSPORT`；`auto` 成功时不启动浏览器，失败才刷新 session 或回退 Chrome。
    - 销售有效性必须引用 `lib/shein_sales_validity.mjs`，不要在各脚本里各写一套取消/退款判断。
  - `sync_shein_daily_to_lark.mjs`
  - `sync_product_sales_to_lark.mjs`
  - `sync_order_skc_details_to_lark.mjs`
  - `generate_monthly_sales_table.mjs`
  - `generate_compact_display_tables.mjs`
  - `setup_lark_dashboard_main_v3.mjs`
  - `setup_lark_dashboard_previous_month.mjs`
  - `update_dashboard_time_richtext_ui.mjs`
  - `send_daily_lark_report.mjs`
    - 云端日报入口由 `cloud_daily_lark_report.sh` 调用；默认 `SHEIN_SALES_TRANSPORT=webapi`、`SHEIN_REPORT_SYNC_NO_LAUNCH=1`，避免日报前置同步意外唤起浏览器。
  - `generate_daily_report_image.mjs`
  - `generate_monthly_report_image.mjs`
  - `generate_today_detailed_report_image.mjs`
- BI 仓库/门户：
  - `run_bi_daily_pipeline.ps1`：每日完整 BI 流水线入口；默认会跑 RTV 复核，支持 `-SkipRtvVerify` 用于只刷新销售/门户。门户生成统一在末尾单次执行，并默认设置 `SHEIN_BI_PORTAL_TIMEOUT_MS=900000`。
  - `run_bi_after_feishu_sync.ps1`：销售抓取后的 BI 后置刷新入口；`intraday` / `yesterday-final` 模式会向每日流水线传 `-SkipRtvVerify`，避免滚动销售看板等待 RTV 复核。
  - `run_bi_postcheck.ps1`：失败或延迟检查时补写 BI 首次体检状态；仅作为兜底，不用于成功流水线的常规二次生成。
  - `init_bi_warehouse.ps1`
  - `load_bi_warehouse.mjs`
  - `fetch_shein_business_domains.mjs`
  - `load_bi_business_domains.mjs`
  - `backfill_bi_high_value_domains.ps1`
  - `generate_bi_portal.mjs`：V1 正式 BI 门户生成器；默认超时 `900` 秒，输出 `outputs/bi-portal/index.html` 与 `outputs/bi-portal/data.json`；生成前会通过 `lib/product_display_name.mjs` 补齐 `product_display_name` 和顶层 `productDisplayNames`。
  - `generate_bi_portal_v2.mjs`（V2.1 平行预览生成器；只读复用 `outputs/bi-portal/data.json`，输出到 `outputs/bi-portal/v2/`，不替换 V1、不接生产调度）
  - `serve_bi_portal.mjs`：云端 BI Portal 服务，提供静态页、健康检查和 `/api/bi/section/:section`；`homeProfit` 是服务层从 `profit` section cache 派生的轻量首页利润摘要。
  - `prewarm_bi_portal_sections.sh`：云端 Portal section 预热脚本；默认顺序必须先 `profit` 后 `homeProfit`，否则首页利润可能继续显示旧 `profit` 缓存。
  - `serve_bi_portal.ps1`
  - `open_bi_portal.ps1`
  - `check_bi_first_run.mjs`
  - `check_bi_portal_ui.mjs`
  - `audit_bi_warehouse.mjs`
  - `generate_bi_briefing.mjs`
- ET 货代仓 / RTV：
  - `cloud_et_forwarder_sync.sh`：Linux 云端 ET 同步入口；抓取、入仓并刷新 BI Portal。依赖服务器本地 `config/et_forwarder.local.json` 或 `ET_FORWARDER_USERNAME/ET_FORWARDER_PASSWORD`，密钥不进 GitHub。
  - `cloud_rtv_verify.sh`：Linux 云端完整 RTV 换单复核入口；由 `shein-bi-cloud-rtv-verify.timer` 调用，默认使用 WebAPI transport，不阻塞滚动销售刷新。
  - `fetch_et_forwarder.mjs`
    - Windows 下复用本地 ET Chrome profile；Linux 下使用 headless Chrome/Chromium、`--no-sandbox`、`--disable-dev-shm-usage`，通过 ET 本地凭据和 OCR 自动登录。
  - `load_et_forwarder_warehouse.mjs`
    - Windows 通过 WSL/docker 入仓；Linux 云端直接调用 `docker exec -i`，必要时可用 `SHEIN_DOCKER_USE_SUDO=1`。
  - `scheduled_et_forwarder_daily.ps1`
  - `report_et_forwarder_assessment.mjs`
  - `verify_shein_rtv_tracking.mjs`：SHEIN 退货物流换单复核；支持 `--transport browser|webapi`。候选应按标准货号 + 时间窗口全店搜索，`DL-` 等 ET SKU 前缀只作排序线索。JT/JTE 按同运单号直连，iMile/EMile 按物流详情换单轨迹确认。该脚本耗时长是正常现象，完整复核与滚动销售刷新分离。
- 链接管理：
  - `scheduled_link_management_daily.ps1`
  - `run_link_management_job.mjs`
  - `fetch_shein_links.mjs`
  - `generate_link_ops_web_dashboard.mjs`
  - `restore_shein_store_session.mjs`：云端单店登录态恢复入口；先用私有 browser/WebAPI session bootstrap，再调用 `auto_relogin_shein_store.mjs` 验证 GSP + SBN 登录态，供 session-manager 和 link/business 日更复用。
  - `serve_bi_portal.mjs`：同时承载 BI Portal 静态页面、链接运营状态 API 和云端临时登录维护入口；`/api/link-ops-chats` 支持运营会话、动态只读问数和明确命令自动入池，`/api/link-ops-tasks` 管理任务池，`/api/link-ops-assets` 管理任务素材包，`/api/link-ops-execute` 做受控执行前检查、HL 子执行器调度、进度和审计回写，`/api/cloud-login/sessions` 管理短时 noVNC 登录窗口。
  - `upload_link_ops_assets.mjs`：从本机把图片、证书、标题/规则文件同步到云端链接运营任务素材包；只走白名单文件类型，不上传敏感登录态。
- 成本/利润：
  - `create_cost_template.mjs`
  - `import_product_costs.mjs`
- 营销活动半自动：
  - `marketing/build_marketing_cost_map.py`
  - `marketing/export_dsy_marketing_standards.mjs`：只读导出 DSY 营销活动填报标准。用户要先审核标准时，先跑 `--stores DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ --all-open`，排除优惠券活动，输出明细和“按标准货号一行”的审核表。
  - `marketing/dsy_marketing_deadline_fill.mjs`：DSY 营销活动报名半自动补填；只勾选商品、填活动价/降幅和复核，不点最终提交。重扫漏报时显式传 `--stores DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ --all-open`；脚本分页全量扫活动列表、选择页先切 `500 条/页`，完成后只保留需要用户提交的活动编辑页。本期价格覆盖表用 `--price-overrides outputs/reports/marketing-price-overrides-YYYY-MM-DD-approved.json`，缺成本例外仅用 `--min-discount-fallback SK-13034`。
- OpenAPI 试点：
  - `cloud_openapi_hl_reconciliation.sh`：Linux 云端 HL OpenAPI 并行对账入口；由 `shein-bi-cloud-openapi-hl.timer` 调用，需 SHEIN 开放平台白名单包含云服务器出口 IP。
  - `check_shein_openapi_client.mjs`
  - `probe_shein_openapi_test_call.mjs`
  - `shein_openapi_authorize_hl.mjs`
  - `probe_shein_openapi_hl.mjs`
  - `fetch_shein_openapi_sales.mjs`
  - `reconcile_shein_openapi_hl_sales.mjs`
  - `load_shein_openapi_sales_warehouse.mjs`

## 运维、登录、环境辅助，保留

- `launch_store_browser.mjs`
- `launch_shein_main_browser.mjs`
- `auto_relogin_shein_store.mjs`
- `et_login_helper.py`
- `close_store_browsers.ps1`
- `enable_bi_lan_firewall.ps1`
- `fix_bi_lan_firewall.ps1`：本地回滚时管理员运行，修复局域网 BI 访问防火墙规则，避免规则绑定 DHCP 旧 IP。
- `run_fix_bi_lan_firewall_admin.ps1`：临时 UAC wrapper，只用于人工触发上述防火墙修复。
- `install_windows_scheduled_tasks.ps1`
- `start_metabase_wsl.ps1`
- `setup_metabase_instance.mjs`
- `setup_metabase_bi.mjs`
- `setup_metabase_bi_perspectives.mjs`
- `setup_metabase_bi_system.mjs`
- `use_utf8.ps1`
- `notify_sync_issue.mjs`
- `cloud_ops_watchdog.mjs`：云端 systemd/watchdog 新鲜度检查；销售/BI 页面按高频阈值，链接/业务域按日更低频阈值，异常时调用 `notify_sync_issue.mjs` 发飞书提醒。
- `lark_sales_qa_bot.mjs`：云端只读飞书问数机器人和网页链接管理会话的核心问数逻辑；每轮从 BI Portal JSON 动态压缩销售、店铺、货号、链接/覆盖上下文并回复，不写数据库、飞书 Base 或 SHEIN 后台；产品文本和图表 label 优先使用 `product_display_name` / `productDisplayNames`。
- `cloud_shein_session_manager.mjs` / `cloud_shein_session_manager.sh`：云端登录态管家；顺序巡检/恢复当前 19 店 WebAPI + SBN 登录态，并输出 profile 体积报告。
- `cloud_manual_login_session.mjs`：云端临时人工登录窗口管理器；按店启动 Xvfb + Chrome + x11vnc + websockify/noVNC，完成后导出/探测登录态并关闭临时进程。状态、短期 token 和日志都属于服务器私有运行态，不提交 GitHub。
- `cloud_link_business_sync.sh`：云端链接/业务域日更入口；按店顺序 bootstrap 浏览器会话、抓链接和业务域、入仓、体检并刷新 BI。
- `bootstrap_shein_browser_session.mjs`：把服务器私有 SHEIN WebAPI/browser session 注入云端 headless Chrome profile，并用订单接口只读探测登录态。
- `export_shein_browser_session.mjs`：从已登录 Chrome profile 导出 SHEIN 浏览器会话状态到 `state/shein_browser_sessions/*.local.json`；输出属于敏感运行态，不提交 GitHub。
- `check_workspace_skill.ps1`
- `watchdog_sales_automation.mjs`

## 审计、补历史、一次性修复，保留但不日常运行

这些脚本多用于复核、补历史或一次性修复。不要删，但默认不应被定时任务调用。

- `audit_full_sales_data_integrity.mjs`
- `audit_product_table_integrity.mjs`
- `audit_shein_sales_logic.mjs`
- `repair_shein_sales_summaries.mjs`：按 `lib/shein_sales_validity.mjs` 重算历史 `outputs/shein_fetch/<store>/<date>.json` 的 summary，并补 `isValidSale` / `salesExclusionReason`。默认 dry-run；全历史 `--write` 必须先让用户确认。
- `backfill_shein_sales.mjs`
- `backfill_shein_comments_full_history.mjs`
- `backfill_shein_comment_platform_translations.mjs`
- `ensure_order_detail_tables.mjs`
- `apply_confirmed_sku_aliases_20260428.mjs`
- `report_product_sku_candidates.mjs`
- `generate_product_sku_confirmation_report.mjs`
- `run_dsy_history_backfill_plan.mjs`
- `probe_shein_history_ranges.mjs`
- `probe_shein_business_domains.mjs`
- `probe_shein_inventory_sources.mjs`
- `probe_shein_stock_age.mjs`
- `test_product_sku_normalizer.mjs`：货号归一化测试。
- `test_product_match_key_schema.mjs`：仓库 `dim.product_match_key()` 静态规则测试，覆盖 `BL02` / `GL-BL02` -> `S1810`。
- `test_product_display_name.mjs`：产品显示名规则测试，确保有可靠中文来源时显示“标准货号+中文品名”，无来源短码不乱补。

## 相关共享库

- `lib/product_sku_normalizer.mjs`：标准货号归一化、目录和别名归并。
- `lib/product_display_name.mjs`：面向 BI 前端和飞书问数机器人的展示名生成；只改显示，不改变 `standard_goods_sn`。

## 明确废弃或默认禁用

- `sync_shein_links_to_lark.mjs`
  - 状态：废弃，默认拒绝执行。
  - 原因：飞书链接管理功能已废弃，链接管理正式走本地 JSON / PostgreSQL / BI 门户。
  - 仅允许显式设置 `SHEIN_ENABLE_DEPRECATED_LARK_LINK_SYNC=1` 做一次性历史迁移。
- `setup_lark_dashboard.mjs`
  - 状态：旧看板创建脚本。
  - 当前正式看板是 `setup_lark_dashboard_main_v3.mjs` 和 `setup_lark_dashboard_previous_month.mjs`。
  - 暂保留作历史参考，不用于日常。
- `setup_lark_dashboard_native.mjs`
  - 状态：旧/实验看板脚本。
  - 暂保留作历史参考，不用于日常。
- `scheduled_daily_report_dsy.ps1`
  - 状态：固定 `09:00` 日报任务包装器，当前默认不安装。
  - 原因：日报已改为早上 `08:10` 同步成功后自动发送，上午后续成功同步可补发一次并用 flag 防重。
  - 只有用户明确要求恢复独立固定日报任务时，才通过 `install_windows_scheduled_tasks.ps1 -IncludeDailyReport` 安装。
- `generate_lark_ops_report_doc.mjs`
  - 状态：飞书文档版经营入口兜底脚本。
  - 原因：原用于飞书 Base Dashboard 不稳定时生成普通飞书文档；当前主入口已转为云端 BI 门户，飞书日报也已云端化。
  - 暂保留作历史参考，不用于日常自动任务。

## 临时探索 / 排障探针，后续可考虑归档

这些不是生产主链路。为了避免误删，目前先保留；后续可移动到 `scripts/archive/` 或 `tools/probes/`。

- 飞书看板 UI 探索：
  - `apply_dashboard_kpi_card_styles_ui.mjs`
  - `explore_dashboard_card_config.mjs`
  - `explore_dashboard_card_menu.mjs`
  - `explore_dashboard_card_ui.mjs`
  - `explore_dashboard_color_options.mjs`
  - `probe_lark_dashboard_no_filter.mjs`
- 早期 CDP / 后台接口探针：
  - `capture_order_network.mjs`
  - `cdp_eval.mjs`
  - `probe_shein_api.mjs`
  - `search_loaded_js_endpoints.mjs`
  - `survey_shein_backend.mjs`
- 旧 Python 辅助脚本：
  - `launch_store_browser.py`
  - `set_profile_names.py`
  - `sync_store_ports_to_lark.py`
  - `sync_store_profile_names_to_lark.py`
  - `bootstrap_lark_base.py`
  - `generate_ops_dashboard_visual.py`
- 清理候选报告：
  - `report_lark_base_cleanup_candidates.mjs`

## 后续整理建议

1. 先不要删除脚本；先观察 1-2 个自动同步周期。
2. 若要整理目录，优先做“移动归档 + README 标注”，不要直接删。
3. 第一批可归档对象应从“临时探索 / 排障探针”里选。
4. `sync_shein_links_to_lark.mjs` 虽废弃，但因内置拒绝执行保护，可先保留作历史迁移兜底。
5. 任意删除前必须先搜索：云端 systemd unit、Windows 回滚任务、README/docs、其他脚本 import/spawn 引用。

## 产品套图提示词生成

- `scripts/product-image-suite/generate_prompt_suite.mjs`
  - 用途：读取产品事实 JSON，按店铺/货号批量生成 13 张电商产品套图提示词。
  - 输入示例：`inputs/product-image-suite/sample-product-facts.json`
  - 输出目录：`outputs/product-image-suite/prompts/`
  - 常用命令：`node scripts/product-image-suite/generate_prompt_suite.mjs --input inputs/product-image-suite/sample-product-facts.json --out outputs/product-image-suite/prompts --format both`
  - 边界：脚本只根据 `verified_facts` 和 `visual_facts` 组织提示词；`candidate_claims` 只作为待确认项输出，不进入画面卖点。若 `reference_policy=reference_image_only_no_manual_color_or_shape`，脚本要求外观严格按参考图，但不手写产品颜色、结构、按钮、接口等细节。
