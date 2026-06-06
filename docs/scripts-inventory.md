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
  - `serve_bi_portal.mjs`：云端 BI Portal 服务，提供静态页、健康检查和 `/api/bi/section/:section`；缓存命中时可直接返回 raw section JSON 或 gzip sidecar；`homeProfit` 是服务层从当前 `profit` section cache 派生的轻量首页利润摘要；`homeRankings` 会裁掉首页不用的重复商品长文本后缓存；服务启动和首页访问会触发 core `generatedAt` watcher 兜底预热 section，健康接口暴露 `biCoreWarmup` 状态。
  - `prewarm_bi_portal_sections.sh`：云端 Portal section 预热脚本，由 `cloud_bi_refresh.sh` 在 api data mode 下后台启动；默认先预热首页关键 section，并在 `profit` 成功后补跑 `homeProfit`。前端会拒绝 `staleSource=true` 或 `sourceGeneratedAt` 不匹配的旧利润摘要；若脚本未及时跑完，`serve_bi_portal.mjs` 的 core warmup watcher 会兜底。
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
  - `marketing/export_dsy_marketing_standards.mjs`：只读导出 DSY 营销活动填报标准。用户要先审核标准时，先跑 `--stores DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ --all-open`，排除优惠券活动，输出明细和“按标准货号一行”的审核表；价格规则读取 `config/marketing_pricing_policy.json`，可按 BI 曝光量识别同一标准货号在所有店铺、所有链接中的全局曝光前五链接利润率差异。
  - `marketing/build_marketing_sku_approval.mjs` / `marketing/verify_marketing_sku_approval.mjs`：按云端 BI / 成本映射生成并校验货号级确认表；确认表必须展示成本、仓储费/件、优惠券/限时折扣风险和带店铺前缀的全局曝光前五链接目标利润率差异，不能按每个店铺各算一组 Top5。
  - `marketing/dsy_marketing_deadline_fill.mjs`：DSY 营销活动报名半自动补填；只勾选商品、填活动价/降幅和复核，不点最终提交。重扫漏报时显式传 `--stores DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ --all-open`；脚本分页全量扫活动列表、选择页先切 `500 条/页`，完成后只保留需要用户提交的活动编辑页。本期价格覆盖表用 `--price-overrides outputs/reports/marketing-price-overrides-YYYY-MM-DD-approved.json`，缺成本例外仅用 `--min-discount-fallback SK-13034`；未命中逐行覆盖价时同样读取 `config/marketing_pricing_policy.json` 和 BI 曝光数据执行同一标准货号全局曝光前五利润率规则。
  - `marketing/export_marketing_stack_review.mjs`：只读导出普通活动、优惠券和限时折扣叠加审核。配套优惠券复扫必须传 `--coupon-target-plan <plan.json>`，并让脚本读取 paired `price-overrides`（可显式 `--coupon-price-overrides`）；优先看 `15%券档active是否符合允许计划`、`15%券档禁止/未知仍active数`、`15%券档active但不在允许计划数`，不要把“15% 可报未入已报集合”误判为漏报，也不能让禁止叠券 active 被旧 extra=0 口径掩盖；若优惠券详情页按钮偶发不跳转，会读取 `config/marketing_coupon_level_rules.json` 里的本店 `levelRuleId` 直达规则页继续回读。
    - 叠加审核的 BI 标签上下文应优先读云端权威快照：可传 `--cloud-bi-ssh shein-bi-tencent --cloud-bi-root /opt/shein-bi/app`，或显式 `--bi-portal-data <data.json>`；输出 `source.biGeneratedAt / biDataPath / biDataTransport / biFallbackUsed`。云端失败只有本地快照新鲜时才 fallback；本地缺失/解析失败不得静默当空 BI。脚本只在内存读取云端 JSON，不写回本地 `outputs/bi-portal/data.json`。
  - `marketing/rebuild_marketing_stack_review_from_store_audits.mjs`：从 `tmp/mbrs/marketing-stack-review-*` 的 store audit JSON 重建叠加审核表，不打开浏览器、不调用 SHEIN。可用同样的 `--cloud-bi-ssh/--cloud-bi-root/--bi-portal-data` 刷新 BI context；必须保留 `activityScanCreatedAt/activityScanFinishedAt` 作为活动扫描新鲜度，`rebuiltAt` 只代表重建时间，不能把旧活动扫描伪装成新鲜扫描。多目录重建时要确认覆盖店铺完整，`missingStores` 非空时不能形成 no-action。
  - `marketing/build_marketing_daily_guard_report.mjs`：每日营销价格栈 heartbeat 的只读汇总入口；只读取已有 scan/audit/dry-run/execute-readback 输出并生成 `outputs/reports/marketing-daily-guard-YYYY-MM-DD.json/md`，用于汇总 source freshness、优惠券 dry-run、限时折扣叠券、旧普通活动观察、已知旧普通活动填报价 guard、订单成交价审计、T-3 活动候选、券预算状态、偏高候选和 `newSkcCandidates` 新链接动作卡。默认可加 `--cloud-bi-ssh shein-bi-tencent --cloud-bi-root /opt/shein-bi/app` 只读读取云端权威 `outputs/bi-portal/data.json`；SSH host/root 会校验，使用参数数组、超时、大小限制和 JSON parse guard，且不把云端 JSON 写回本地 `outputs/`。它不 live 扫描、不调用 SHEIN、不写后台；关键 scan / dry-run / stack review / selection plan / `price-overrides` / `config/stores.json` 源缺失会 fail closed，无活动窗口的订单审计只列入 ignored、不参与 below/above 统计；source freshness 同时看文件 mtime 和内部时间戳，但 `marketingStackReview` 拆分两层：T-3 活动扫描按 `createdAt`/artifact mtime 判定新鲜度，旧 `source.biGeneratedAt` 只作为 BI 标签上下文写入 `contextWarnings`，不得单独把活动扫描判 stale。报告中的“偏高”只允许表达为“限时折扣兜底价偏高候选”：若普通营销活动已形成更低且可叠券的最低基准价，限时折扣价偏高不等于最终成交价偏高；普通活动证据不完整时必须标 `priceStackEvidenceComplete=false`。`knownOrdinaryActivityGuard` 会把 `tmp/mbrs/deadline-fill-results` 中仍在活动生效窗口内的旧普通活动填报价纳入最低促销基准价；若 `旧普通活动价 × couponFactor < finalTargetPrice - 1 SAR`，或有旧普通活动标签但缺填报价证据，日报必须生成 blocker，避免 NM 7025 这类旧活动低价叠券风险被漏掉。`newSkcCandidates` 只用 `storeKey + skc` 精确判定是否已有计划；`standard_goods_sn` 相同只提示待确认，不能自动继承价格或券策略；缺 `finalTargetPrice`、`couponFactor=1`、禁券或 excluded 的 SKC 只进待定价/待确认，不生成 15% 券 dry-run；缺 `shelf_age_days` 时只用 `link_date` 兜底，仍无法判断年龄则进 `unknown_shelf_age_needs_review` 并阻止 no-action。券预算只把 `coupon-site-budget-execute` 的回读当完成证据，预算字段按 `after.usageSite`、`after.budgetInfoSite`、`before.usageSite`、`before.budgetInfoSite` 优先级读取；低于 `1000 SAR` 或缺 execute 回读证据会生成 blocker，写入失败但回读达标只写 context warning，dry-run 不能冒充补预算完成。报告中的命令只能是 dry-run 建议，不能含 `--execute`，也不能替代真实执行前的 live scan / execute / rescan 流程。
  - `marketing/build_known_ordinary_coupon_risk_plan.mjs`：从每日 guard 的 `knownOrdinaryActivityGuard` 生成旧普通活动低价叠券全量风险清单 `known-ordinary-coupon-risk-plan-YYYY-MM-DD.{json,csv,md}`。该脚本只读，不调用 SHEIN；Markdown 先给中文结论、按店铺汇总、需要做什么和优先复核样例，CSV 保留给脚本/筛选使用；输出按 `submitted/filled_price_candidate/unverified` 等证据信任级别、店铺和价差排序，给后续 live 复核、用户授权取消券或临时下架使用。
  - `marketing/build_high_coupon_research_candidates.mjs`：`30%/50%` 优惠券 research-only 候选生成器。读取本期 selection plan、`price-overrides`、最新 `marketing-stack-review` 和已知旧普通活动填报价，反推高券所需普通活动/限时折扣基准价，检查平台最低降幅、成本/仓储利润底线、旧普通活动/限时折扣打穿风险。输出 `outputs/reports/marketing-high-coupon-research-YYYY-MM-DD.{json,csv,md}`；不生成命令，不调用 SHEIN，不允许真实上线。
  - `marketing/submit_coupon_activity_goods.mjs`：优惠券 `34810` 的 15% 档执行器。默认必须传 `--target-plan`，且目标集合由共享 classifier 从 `price-overrides` 派生：只有 `couponFactor≈0.85` 或 combo 明确“仅15%券”的 SKC 才能报名；`couponFactor=1`、`不叠券/券都禁止`、缺覆盖价或同一 `store+skc` 口径冲突都 fail closed。提交前会同时检查 active/future 限时折扣和已知旧普通活动填报价；若任一最低基准价叠券后低于 `finalTargetPrice`，目标 SKC 会被价格栈守卫排除。只有显式 `--allow-all-15pct-available` 才允许全可报报名。真实提交走 direct multi-level `partake` API，必须带 `partake_rule_id + coupon_level_id + skc_info_list`；Excel/页面的“导入成功/商品提交成功”不作为最终证据，最终看已报集合回读。
  - `marketing/cancel_coupon_extra_goods.mjs`：取消配套优惠券误报项。使用多档券真实接口 `/activity/multi-level/partake/cancel`；执行前必须二次加载共享 classifier 的 `allowed15` 保护集并重新计算价格栈。`allowed15` 计划内 SKC 只有在取消侧确认 `最低有效基准价 × couponFactor < finalTargetPrice - 1 SAR` 时，才允许作为风险取消目标；如果取消侧只有限时折扣价证据、缺普通营销活动/当前售价证据，必须 fail closed。仅凭 `riskReason`、旧活动标签或普通活动 selection plan 不得取消。真实执行需 `--execute`。遇到 `20302` 后如已通过真实鼠标点击恢复子系统登录态，应带 `--no-launch --keep-open` 复用同一 profile 执行 dry-run / execute / 回读，避免重启浏览器丢掉刚恢复的 MBRs 态。
  - `marketing/scan_coupon_low_price_overlap_risks.mjs`：只读扫描 active 15% 券与 active/future 限时折扣的兜底层风险；限时折扣列表和商品列表必须分页完整读取。扫描器读到的 `limitedDiscountPrice × couponFactor` 只代表限时折扣作为最低价时的兜底测算：低于目标可作为 fail-closed 风险线索；高于目标只能生成“兜底层偏高/需确认普通营销活动覆盖”的候选，不得直接判定最终成交价偏高或必须调限时折扣。HL 漏报补救这类授权组合写入 `config/marketing_allowed_limited_coupon_overlaps.json` 并在 `validUntil` 前只保留明细、不进取消清单。
  - `marketing/scan_coupon_old_ordinary_overlap_risks.mjs`：只读观察 active 15% 券与旧普通营销活动重叠；旧普通活动标签本身不生成可执行取消清单，输出应保持 `riskCancel=false`。只有补齐 live 最低有效基准价并证明 `最低有效基准价 × couponFactor < finalTargetPrice - 1 SAR` 后，才可进入单独的取消/调价补救流程。
  - `marketing/audit_order_prices_against_plan.mjs`：只读订单级成交价审计；只用浏览器订单商品行 `goodsRows[].currencyPrice` 对比 `price-overrides` 的 `finalTargetPrice`，不使用页面汇总、预计收入汇总或预聚合日汇总。用于低价/高价成交告警时必须传活动生效窗口 `--plan-start-time/--plan-end-time`；未传窗口的结果只能作为原始偏离线索，不能直接判定漏报。
  - `marketing/end_limited_discounts_for_coupon_plan.mjs`：按风险清单终止会挡券或造成低价叠券的旧限时折扣；真实执行必须显式 `--execute`，默认拒绝结束含非目标 SKC 的混合限时折扣活动，除非逐场确认后加 `--allow-mixed-activity-end`；执行后要用上方扫描器复扫。
  - `marketing/apply_hl_limited_discount_rescue.mjs`：HL 漏报普通营销活动后的限时折扣兜底执行器；先终止只包含目标 SKC 的冲突旧限时折扣，再按原普通活动价创建补救限时折扣。必须显式传 `--rescue <json>` 与 `--end-time "YYYY-MM-DD HH:mm:ss"`，默认 dry-run，真实写入必须显式 `--execute`，并会把平台/库存不可创建的 SKC 写入 `skippedUnreportable`。
  - `marketing/scan_hl_limited_discount_conflicts.mjs`：HL 限时折扣补救后的只读冲突扫描，确认目标 SKC 是否被新限时折扣覆盖、是否还有重复/缺口；必须显式传 `--rescue <json>` 与 `--end-cutoff "YYYY-MM-DD HH:mm:ss"`，不保留一次性批次默认路径。
  - `marketing/set_coupon_site_budget.mjs`：将优惠券活动站点预算补到目标额度；本期 `shein-sa` 默认目标为 `1000 SAR`。真实执行后必须保留 before/after 预算回读结果；若接口返回异常但回读已是 `1000 SAR`，按“写入异常但预算达标”记录，不能继续盲目重复写入。
  - `marketing/build_coupon_import_from_skc_list.py` + `marketing/templates/coupon-import-15pct-template.xlsx`：从 SKC 清单生成 SHEIN 优惠券批量导入模板，供 `submit_coupon_activity_goods.mjs` 上传。
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
- `lib/marketing_pricing_policy.mjs`：营销活动机器可读定价策略加载与曝光前五链接识别；负责把 `config/marketing_pricing_policy.json` 里的“限时折扣兜底 / 同一标准货号全局曝光前五利润率差异 / 15%底价”规则提供给审核表和填报脚本。
- `lib/marketing_ordinary_price_evidence.mjs`：读取 `tmp/mbrs/deadline-fill-results` 中仍在活动生效窗口内的普通营销活动填报价，按 `storeKey + skc` 归组，并计算 `旧普通活动价 × couponFactor` 与 `finalTargetPrice` 的差异；供优惠券提交器、每日 guard 和高券研究共用，避免旧普通活动低价叠券风险只在某一个脚本里被发现。

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
