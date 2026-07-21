# scripts 目录脚本清单与保留边界



> 目的：避免 `scripts/` 越积越乱。本文先做分类和风险标注，不直接删除脚本；删除或归档前需要再次确认，尤其不能误伤云端 systemd 任务、本地回滚脚本和 BI 主链路。



## 云端生产定时任务直接引用，必须保留



这些脚本被云端 systemd unit 直接调用：



- `cloud_bi_refresh.sh`

- `cloud_db_backup.sh`
- `cloud_disk_maintenance.sh`

- `cloud_et_forwarder_sync.sh`

- `cloud_morning_chain.sh`

- `cloud_daily_lark_report.sh`

- `cloud_rtv_verify.sh`

- `cloud_openapi_reconciliation.sh`

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

  - `fetch_shein_business_domains.mjs`：业务域抓取器；错误分支必须保留 `node:fs` 同步依赖和既有结果保护，抓取失败不得以零行结果覆盖已有事实。

  - `backfill_bi_high_value_domains.ps1`

  - `generate_bi_portal.mjs`：当前 V2 正式 BI 门户生成器；默认超时 `900` 秒，输出 `outputs/bi-portal/index.html` 与 `outputs/bi-portal/data.json`；生成前会通过 `lib/product_display_name.mjs` 补齐 `product_display_name` 和顶层 `productDisplayNames`。

  - `generate_bi_portal_v2.mjs`：历史 V2 平行预览生成器，当前仅作迁移参考；正式入口以后以 `generate_bi_portal.mjs` / `outputs/bi-portal/index.html` 为准。

  - `serve_bi_portal.mjs`：云端 BI Portal 服务，提供静态页、健康检查和 `/api/bi/section/:section`；缓存读写、generation 校验、raw/gzip sidecar 与 stale 元数据统一由 `lib/bi_section_cache.mjs` 负责；`homeProfit` 是服务层从当前 `profit` section cache 派生的轻量首页利润摘要；`homeRankings` 会裁掉首页不用的重复商品长文本后缓存；`inventoryTrend` 也必须读取已发布利润 cache，禁止每次展开实时 `mart.profit_order_item`；服务启动和首页访问会触发 core `generatedAt` watcher 兜底预热 section，健康接口暴露 `biCoreWarmup` 状态。

  - `prewarm_bi_portal_sections.sh`：云端 Portal section 预热脚本，由 `cloud_bi_refresh.sh` 在 api data mode 下后台启动；默认先预热首页关键 section，并在 `profit` 成功后补跑 `homeProfit`。前端会拒绝 `staleSource=true` 或 `sourceGeneratedAt` 不匹配的旧利润摘要；若脚本未及时跑完，`serve_bi_portal.mjs` 的 core warmup watcher 会兜底。

  - `scripts/lib/shared_lock.sh`：云端生产 shell 任务的共享 `flock` 权限库；锁只允许位于受控目录，统一使用 `2770` 目录、`0660` 文件和 `sheinops` 组，禁止各脚本自行创建 world-writable `/tmp` 锁。

  - `serve_bi_portal.ps1`

  - `open_bi_portal.ps1`

  - `check_bi_first_run.mjs`

  - `check_bi_portal_ui.mjs`

  - `audit_bi_warehouse.mjs`

  - `generate_bi_briefing.mjs`

- ET 货代仓 / RTV：

  - `cloud_et_forwarder_sync.sh`：Linux 云端 ET 同步入口；抓取、入仓并刷新 BI Portal。依赖服务器本地 `config/et_forwarder.local.json` 或 `ET_FORWARDER_USERNAME/ET_FORWARDER_PASSWORD`，密钥不进 GitHub。

  - `cloud_et_storage_fee_sync.sh`：Linux 云端仓储费专用只读入口；支持 `daily|backfill`，与通用 ET 共用 profile 锁但使用独立状态/输出/日志，完整性校验通过后才入仓、发布利润 cache、对账并预热 `profit/homeProfit`。

  - `check_storage_fee_profit.mjs`：生产仓储费四层守恒检查；核对 canonical 总账、货号、店铺、店铺×货号、缩放日、缺明细日和利润 cache。

  - `cloud_rtv_verify.sh`：Linux 云端完整 RTV 换单复核入口；生产由 `cloud_daily_refresh.sh` 统一日更补采批次调用，默认使用 WebAPI transport，不阻塞两小时销售刷新。

  - `fetch_et_forwarder.mjs`

    - Windows 下复用本地 ET Chrome profile；Linux 下使用 headless Chrome/Chromium、`--no-sandbox`、`--disable-dev-shm-usage`，通过 ET 本地凭据和 OCR 自动登录。`--storage-fee-only` 只请求 `IncomeBill sort=2`，并可用 `--out-dir` 隔离产物。

  - `load_et_forwarder_warehouse.mjs`

    - Windows 通过 WSL/docker 入仓；Linux 云端直接调用 `docker exec -i`，必要时可用 `SHEIN_DOCKER_USE_SUDO=1`。

  - `seed_inventory_cost_opening_from_et.mjs` / `rebuild_inventory_cost_ledger.mjs` / `refresh_inventory_cost_ledger.sh` / `manage_accounting_period.mjs`：从生效日前一日 ET 结存建立期初，维护移动加权成本台账并执行期间冻结边界；重建会拒绝改写冻结期间。

  - `cloud_openapi_finance_sync.sh` / `run_shein_openapi_finance_sync.mjs` / `fetch_shein_openapi_finance_check_orders.mjs` / `load_shein_openapi_finance_warehouse.mjs`：19 店只读财务核对单同步与入仓；为已结算退货实际净成本提供事实，不直接改变销售事实源。

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

  - `marketing/build_marketing_sku_approval.mjs` / `marketing/verify_marketing_sku_approval.mjs`：按云端 BI / 成本映射生成并校验货号级确认表；确认表必须是用户可审的 Excel 人话版，而不是只给 CSV/JSON 或几百行明细。标准工作簿至少包含 `说明`、`按货号汇总`、`店铺差异明细`、`报名明细`、`剔除项/阻塞项`、`低价补救/风险项`、`15%券流量试验计划`（如适用）等 sheet；除说明页外必须有 `备注/修改意见` 列。确认表必须展示预期利润率、预期最终价、普通活动填报价、是否使用可选 15% 流量券、触券下探价、成本、仓储费/件、优惠券/限时折扣风险和带店铺前缀的全局曝光前五链接目标利润率差异，不能按每个店铺各算一组 Top5。

  - `marketing/dsy_marketing_deadline_fill.mjs`：DSY 营销活动报名半自动补填；默认只勾选商品、填活动价/降幅和复核，用户明确授权后才可传 `--submit` 真实提交。支持 `--out-dir` 隔离探测/补报证据；选择页会记录 `availableRows/outOfPlanRows/outOfPlanCount`，当活动页出现计划外可报名 SKC 时必须生成 supplement `selection-plan` / `price-overrides` 并补进 repaired 全量计划，不能把新增可报行忽略掉。本期价格覆盖表用 `--price-overrides outputs/reports/marketing-price-overrides-YYYY-MM-DD-approved.json`，缺成本例外仅用 `--min-discount-fallback SK-13034`；未命中逐行覆盖价时同样读取 `config/marketing_pricing_policy.json` 和 BI 曝光数据执行同一标准货号全局曝光前五利润率规则。

  - `marketing/verify_ordinary_activity_enrollment.mjs`：普通营销活动提交后的已报/审核中集合回读器，按 `selection-plan + price-overrides` 校验 `missingRows/priceMismatchRows/badPacketActivities/extraAvailableRows/activityListGapRows`。`extraAvailableRows` 来自执行页 `outOfPlanRows`、`totalGoods > expectedSelectedCount` 或后台活动列表 `applyGoodsNum < allowGoodsNum` 的差额，用于发现“计划内都报了但页面还有漏抓商品”的系统级漏报；补报后必须回读到 `extraAvailableRows=0` 且 `activityListGapRows=0`。只补少量店铺时优先传 `--stores` 和 `--fill-results-dir` 做最小范围复核，不要求每天全店开前端。

  - `marketing/export_marketing_stack_review.mjs`：只读导出普通活动、优惠券和限时折扣叠加审核。生产 guard 使用 `--session-http --cloud-bi-ssh local`，每批并发 3 店，直接按 `config/marketing_coupon_level_rules.json` 查询各店 15% 券 active 商品集合；不打开/关闭浏览器，也不申请租约。覆盖不足、券规则查询失败或与同轮价格扫描时间差超过门禁时 fail closed。浏览器路径只保留人工登录恢复/诊断回退，不得作为日常默认。

    - 叠加审核的 BI 标签上下文应优先读云端权威快照：可传 `--cloud-bi-ssh shein-bi-tencent --cloud-bi-root /opt/shein-bi/app`，或显式 `--bi-portal-data <data.json>`；输出 `source.biGeneratedAt / biDataPath / biDataTransport / biFallbackUsed`。云端失败只有本地快照新鲜时才 fallback；本地缺失/解析失败不得静默当空 BI。脚本只在内存读取云端 JSON，不写回本地 `outputs/bi-portal/data.json`。

  - `marketing/rebuild_marketing_stack_review_from_store_audits.mjs`：从 `tmp/mbrs/marketing-stack-review-*` 的 store audit JSON 重建叠加审核表，不打开浏览器、不调用 SHEIN。可用同样的 `--cloud-bi-ssh/--cloud-bi-root/--bi-portal-data` 刷新 BI context；必须保留 `activityScanCreatedAt/activityScanFinishedAt` 作为活动扫描新鲜度，`rebuiltAt` 只代表重建时间，不能把旧活动扫描伪装成新鲜扫描。多目录重建时要确认覆盖店铺完整，`missingStores` 非空时不能形成 no-action。

- `marketing/build_marketing_daily_guard_report.mjs`：每日营销价格栈 heartbeat 的只读汇总入口；只读取已有 scan/audit/dry-run/execute-readback 输出并生成 `outputs/reports/marketing-daily-guard-YYYY-MM-DD.json/md`，用于汇总 source freshness、优惠券 dry-run、限时折扣叠券、旧普通活动观察、已知旧普通活动填报价 guard、订单成交价审计、T-3 活动候选、券预算状态、偏高候选和 `newSkcCandidates` 新链接动作卡。默认可加 `--cloud-bi-ssh shein-bi-tencent --cloud-bi-root /opt/shein-bi/app` 只读读取云端权威 `outputs/bi-portal/data.json`；SSH host/root 会校验，使用参数数组、超时、大小限制和 JSON parse guard，且不把云端 JSON 写回本地 `outputs/`。它不 live 扫描、不调用 SHEIN、不写后台；关键 scan / dry-run / stack review / selection plan / `price-overrides` / `config/stores.json` 源缺失会 fail closed，但 `source stale` 只能报告“需补证据/等待窗口”，不得自动触发 19 店前端全量扫描。日常 heartbeat 的前端边界是：无明确低价止损、无用户授权、未到补券窗口时不打开浏览器；若必须补证据，只扫具体店铺/SKC，按 3-5 店分批并立即关闭。订单成交价审计必须先确认当前策略计划是否新鲜、同一 `storeKey + skc` 是否无冲突、是否带必要 `finalTargetPrice/couponFactor/combo/生效窗口` 证据，计划过期或缺窗口时只能报告“计划证据需刷新/清理”的线索，不能把已批准的 `15%` 利润率或低价清货策略按旧默认利润率重复判为异常；普通活动未到开始时间时，不把窗口外订单按未来目标价判 blocker。source freshness 同时看文件 mtime 和内部时间戳，但 `marketingStackReview` 拆分两层：T-3 活动扫描按 `activityScanCreatedAt/activityScanFinishedAt`（旧报告兼容 `createdAt`）判定新鲜度，超过 48 小时必须成为 blocker；`source.biGeneratedAt` 只作为 BI 标签上下文写入 `contextWarnings`，不能用 `rebuiltAt` 或新鲜 BI context 伪装活动扫描新鲜。报告中的“偏高”只允许表达为“限时折扣兜底价偏高候选”：若普通营销活动已形成更低且可叠券的最低基准价，限时折扣价偏高不等于最终成交价偏高；普通活动证据不完整时必须标 `priceStackEvidenceComplete=false`。`knownOrdinaryActivityGuard` 会把 `tmp/mbrs/deadline-fill-results` 中仍在活动生效窗口内的旧普通活动填报价纳入最低促销基准价；若 `旧普通活动价 × couponFactor < finalTargetPrice - 1 SAR`，或有旧普通活动标签但缺填报价证据，日报必须生成 blocker，避免 NM 7025 这类旧活动低价叠券风险被漏掉。`newSkcCandidates` 只用 `storeKey + skc` 精确判定是否已有计划；`standard_goods_sn` 相同只作同款候选提示，不能无脑继承老 SKC 价格或券策略；但若能从最新已执行全量计划、同一标准货号全局曝光 Top5、成本/仓储费/底价推导出安全目标价，就必须生成限时折扣兜底动作，不能停在“待定价”。若缺精确/同货号 `finalTargetPrice`，但 `marketing-cost-map` 有商品成本，必须按 Top5 利润率规则自动推导，不能进入待定价；当前成本兜底按 `product_cost_excluding_storage` 筛选，仓储费缺失只留痕、不把已有商品成本误报为无成本。只有商品成本/底价也缺失，或禁券、excluded、缺 `shelf_age_days/link_date`、身份/库存/平台阻断时，才进入待确认并阻止 no-action。券预算只把 `coupon-site-budget-execute` 的回读当完成证据，预算字段按 `after.usageSite`、`after.budgetInfoSite`、`before.usageSite`、`before.budgetInfoSite` 优先级读取；低于 `1000 SAR` 或缺 execute 回读证据会生成 blocker，写入失败但回读达标只写 context warning，dry-run 不能冒充补预算完成。报告中的命令只能是 dry-run 建议；限时折扣价格漂移和新链接/新上架 7 天/漏限时折扣兜底是已授权自动写入例外，仍必须 live scan / execute / rescan 闭环。

  - `marketing/build_known_ordinary_coupon_risk_plan.mjs`：从每日 guard 的 `knownOrdinaryActivityGuard` 生成旧普通活动低价叠券全量风险清单 `known-ordinary-coupon-risk-plan-YYYY-MM-DD.{json,csv,md}`。该脚本只读，不调用 SHEIN；Markdown 先给中文结论、按店铺汇总、需要做什么和优先复核样例，CSV 保留给脚本/筛选使用；输出按 `submitted/filled_price_candidate/unverified` 等证据信任级别、店铺和价差排序，给后续 live 复核、用户授权取消券或临时下架使用。

  - `marketing/build_new_listing_limited_discount_plan.mjs`：新上架 `7` 天及“历史下架/售罄后恢复在售且当前无生效营销活动”链接的 Top5 限时折扣兜底计划生成器。读取 BI linksData、最近 `60` 天 `outputs/shein_links` 状态历史、完整营销 live scan、当前最终版 `price-overrides`、`tmp/mbrs/marketing-cost-map.json` 和 `config/marketing_pricing_policy.json`。目标价取证顺序为精确店铺+SKC、同标准货号 Top5，最后用商品成本推导 Top5 价；仓储费缺失不得误报为商品成本缺失。新上架与重新上架分别标记 `treatmentType`，都按全局曝光 Top5/新链接力度生成一周限时折扣 rescue JSON。普通兜底已有合规限时折扣且现价不低于目标价时视为已覆盖，不自动降价；低于目标或人工特殊价不精确时才生成 `replace_existing_limited_discount`。脚本本身只读、不调用 SHEIN、不执行写入；输出 `outputs/reports/new-listing-7d-limited-discount-plan-YYYY-MM-DD.{json,md}` 和 `tmp/marketing-signup/limited-discount-fallback/new-listing-7d-YYYY-MM-DD/`。
  - `marketing/merge_current_marketing_price_scans.mjs`：将最新成功、非 partial 的完整营销价格快照与一个或多个受影响店铺复扫 overlay 合并。按店铺整体替换 `stores/rows`，重算 `rowCount/currentRows/futureRows` 并记录 `mergeEvidence`；基线缺店、失败、partial，overlay 店铺失败/重复、比基线旧或不在基线时 fail closed。该脚本只处理本地 JSON，不启动浏览器、不调用 SHEIN，用于少量补报后的 final guard；`smoke_merge_current_marketing_price_scans.mjs` 覆盖成功、旧 overlay、partial 和内外店铺键不一致分支。
  - `lib/marketing_relisted_link_history.mjs`：读取最近状态快照，识别“历史下架/售罄 -> 当前恢复在售”的精确店铺+SKC 证据，并保留最新活动信号；解析错误或证据不完整时 fail closed。
  - `lib/marketing_latest_raw_link_overlay.mjs`：新链接候选防时序漏检层。读取截至报告日各店最新 `outputs/shein_links/<STORE>/<DATE>.json`，把 BI `linksData` 缺失的 `store+SKC` 追加到 guard/计划器输入；只补缺失键，不覆盖已有 BI 行。输出来源文件、解析错误和新增行审计，并对19店原始快照覆盖做 fail-closed 校验。
  - `marketing/smoke_latest_raw_marketing_link_overlay.mjs`：模拟 BI sidecar 先生成、原始链接快照后刷新，验证新 SKC 会被补入、下架行被排除、已有 BI 行不被覆盖，以及缺店覆盖必须失败。
  - `marketing/smoke_relisted_link_limited_discount_plan.mjs` / `marketing/smoke_relisted_link_cost_fallback.mjs`：验证重新上架无活动兜底与商品成本 Top5 推导；`marketing/smoke_limited_discount_drift_rescue_files.mjs` 验证漂移 rescue 文件边界。

  - `marketing/build_high_coupon_research_candidates.mjs`：`30%/50%` 优惠券 research-only 候选生成器。读取本期 selection plan、`price-overrides`、最新 `marketing-stack-review` 和已知旧普通活动填报价，反推高券所需普通活动/限时折扣基准价，检查平台最低降幅、成本/仓储利润底线、旧普通活动/限时折扣打穿风险。输出 `outputs/reports/marketing-high-coupon-research-YYYY-MM-DD.{json,csv,md}`；不生成命令，不调用 SHEIN，不允许真实上线。

  - `marketing/submit_coupon_activity_goods.mjs`：优惠券 `34810` 的 15% 档执行器。默认必须传 `--target-plan`，且目标集合由共享 classifier 从 `price-overrides` 派生：只有明确标记为高曝光支持、滞销高库存引流或清货试验的 SKC 才能报名；历史 `couponFactor≈0.85` 或 combo “仅15%券”默认视为价格保障旧口径并阻断；`couponFactor=1`、`不叠券/券都禁止`、缺覆盖价或同一 `store+skc` 口径冲突都 fail closed。提交前会同时检查 active/future 限时折扣和已知旧普通活动填报价；若任一最低基准价叠券后低于 `finalTargetPrice`，目标 SKC 会被价格栈守卫排除；若最新 `marketing-stack-review` 过期/不可用、旧活动价证据目录缺失/解析失败，或目标 SKC 有旧普通/度假季标签但缺旧活动价证据，真实写路径 fail closed，不提交；遇到登录页或券集合接口 `20302` 会先用真实鼠标点击登录/继续登录并重试，恢复失败才报告登录阻塞。只有显式 `--allow-all-15pct-available` 才允许全可报报名。真实提交走 direct multi-level `partake` API，必须带 `partake_rule_id + coupon_level_id + skc_info_list`；Excel/页面的“导入成功/商品提交成功”不作为最终证据，最终看已报集合回读。

  - `marketing/cancel_coupon_extra_goods.mjs`：取消配套优惠券误报项。使用多档券真实接口 `/activity/multi-level/partake/cancel`；执行前必须二次加载共享 classifier 的 `allowed15` 保护集并重新计算价格栈。`allowed15`/历史价格保障 SKC 只有在取消侧确认它属于非必触发券保底旧口径，或触券下探会低于目标/底线时，才允许作为风险取消目标；如果取消侧只有限时折扣价证据、缺普通营销活动/当前售价证据，必须 fail closed。仅凭 `riskReason`、旧活动标签或普通活动 selection plan 不得取消。真实执行需 `--execute`。遇到 `20302` 后如已通过真实鼠标点击恢复子系统登录态，应带 `--no-launch --keep-open` 复用同一 profile 执行 dry-run / execute / 回读，避免重启浏览器丢掉刚恢复的 MBRs 态。

  - `marketing/scan_coupon_low_price_overlap_risks.mjs`：只读扫描 active 15% 券与 active/future 限时折扣的兜底层风险；限时折扣列表和商品列表必须分页完整读取。扫描器读到的 `limitedDiscountPrice × couponFactor` 只代表限时折扣作为最低价时的兜底测算：低于目标可作为 fail-closed 风险线索；高于目标只能生成“兜底层偏高/需确认普通营销活动覆盖”的候选，不得直接判定最终成交价偏高或必须调限时折扣。HL 漏报补救这类授权组合写入 `config/marketing_allowed_limited_coupon_overlaps.json` 并在 `validUntil` 前只保留明细、不进取消清单。

  - `marketing/scan_coupon_old_ordinary_overlap_risks.mjs`：只读观察 active 15% 券与旧普通营销活动重叠；旧普通活动标签本身不生成可执行取消清单，输出应保持 `riskCancel=false`。只有补齐 live 最低有效基准价并证明保底价不达标、或触券下探会低于底线后，才可进入单独的取消/调价补救流程。

  - `marketing/audit_order_prices_against_plan.mjs`：只读订单级成交价审计；只用浏览器订单商品行 `goodsRows[].currencyPrice` 对比当前有效 `price-overrides` 的 `finalTargetPrice`，不使用页面汇总、预计收入汇总或预聚合日汇总。用于低价/高价成交告警时必须传活动生效窗口 `--plan-start-time/--plan-end-time` 或读取带窗口的当前策略版本；未传窗口、计划过期、同一 `storeKey + skc` 目标冲突，或用户备注尚未落盘成覆盖文件时，结果只能作为“刷新计划/补证据”线索，不能直接判定漏报，也不能把已批准的 `15%` 利润率策略当异常。

  - `marketing/end_limited_discounts_for_coupon_plan.mjs`：按风险清单终止会挡券或造成低价叠券的旧限时折扣；真实执行必须显式 `--execute`，默认拒绝结束含非目标 SKC 的混合限时折扣活动，除非逐场确认后加 `--allow-mixed-activity-end`；执行后要用上方扫描器复扫。

  - `marketing/apply_hl_limited_discount_rescue.mjs`：限时折扣“只创建”原语。必须显式传 `--rescue <json>` 并锁定 rescue SHA256；遇到旧限时折扣冲突时只返回 `requiresTransactionalReplacement`，自身绝不终止旧活动。创建后按新活动 ID、逐 SKC 价格、`activityStock`、截止时间和唯一覆盖做最多 6 次只读回读。
  - `marketing/replace_limited_discount_transactionally.mjs`：所有限时折扣替换的唯一写入口。删除前持久化旧活动/SKC 快照和事务 journal；目标创建或回读失败时按快照自动恢复旧保护，任何仍失保 SKC 返回 critical。安全回滚不等于修复成功，后续 worker 可在同一精确 hash 下重新评估并重试。
  - `marketing/build_limited_discount_drift_rescue_plan.mjs`：从每日 guard 的 `limitedDiscountTargetPriceDrift.belowRows` 构建限时折扣漂移修复计划，按店/分组输出 JSON rescue 文件，以当前 `finalTargetPrice` 作为限时折扣价，并把策略默认 `activityStock=10` 写入 rescue 根和明细行。
  - `marketing/manage_manual_limited_discount_override.mjs`：人工特殊限时折扣持久登记 CLI，支持 `validate/list/register/update-activity/disable`；真实特殊价提交前必须先登记，live 回读后写回活动 ID。所有变更在跨进程 ticket lock 内重新读取后原子更新，防止 timer 与 CLI 并发丢失登记。
  - `marketing/build_manual_limited_discount_restore_plan.mjs` / `marketing/batch_restore_manual_limited_discounts.mjs`：从 guard 的 `manualSpecialLimitedDiscount` 审计区构建精确特殊价恢复计划，完成 dry-run、ET 门控库存处理后，把替换交给统一事务执行器；只有目标活动精确回读成功才更新登记。混合旧活动不再由批处理直接先删后建。
  - `marketing/manage_manual_limited_discount_inventory.mjs`：ET 门控的限时折扣库存守卫。默认只为有效人工特殊登记项服务；`--rescue <json>` 模式用于 2026-07-16 已授权的目标价漂移、新链接/新上架 7 天、重新上架无活动、漏限时折扣 rescue。优先查询 `mart.et_product_inventory_current`，生产只读角色无权访问时只接受新鲜且带当天 ET snapshot 的云端 BI ET 投影。写前在逐链接跨进程锁内二次回读平台库存，已被其它进程补足时不覆盖；旧 rescue 缺库存字段时读取策略默认 10。平台 `OVERWRITE` 按“要求可用库存 + 当前锁定库存”计算且不下调现有总量，实际覆盖量进入幂等键，最终以 `totalUsableInventory >= activityStock` 回读为准。ET 不足/过期/回读不一致时返回非零；不得用于普通营销活动库存或任意增库存。
  - `marketing/batch_apply_new_listing_limited_discount.mjs`：批量执行新链接/新上架/重新上架/在售老链接漏兜底。多 SKC rescue 中每个库存目标独立调用 ET 门控库存守卫；可执行子集可继续，但被排除的 SKC 会让该组保持 blocker 并在后续轮次重试，不能因部分成功把整组标成完成。替换写统一走事务执行器。
  - `marketing/smoke_authorized_fallback_inventory_top_up.mjs`：验证 ET 足够时精确补到 10、ET 不足阻断、平台库存已足够不写、确定性 idempotency key，以及普通 rescue 不能冒充人工特殊登记项。
  - `marketing/remove_skc_from_limited_discount.mjs`：从限时折扣活动中移除指定 SKC 的 CDP 执行器，带登录恢复和店铺身份校验。真实执行需明确授权；营销修复的 dry-run 已修为预演完成后立即返回，绝不得误调用本执行器。
  - `marketing/batch_fix_limited_discount_drift.mjs`：限时折扣价格漂移批量修复器。加载精确 manifest/work fingerprint，按店复用浏览器、按组 checkpoint/resume，并把每组交给事务执行器。平台阻断或安全回滚均保持未完成；输出汇总目标、旧活动快照、补偿覆盖、失保项和创建回读。
  - `marketing/guard_limited_discount_drift.mjs`：限时折扣漂移上层入口。判断 `limitedDiscountTargetPriceDrift.belowRows` 非空时调用 `batch_fix_limited_discount_drift.mjs`；无漂移时 no-op。
  - `marketing/smoke_limited_discount_drift_rescue_plan.mjs`：漂移修复计划 smoke，验证使用当前 finalTargetPrice 且保留历史证据。
  - `marketing/smoke_limited_discount_drift_activity_stock.mjs`：验证漂移 rescue 显式库存、旧 rescue 默认库存、锁定库存补偿、不得下调平台总库存，以及覆盖量变化必须生成新幂等键。
  - `marketing/smoke_limited_discount_target_price_guard.mjs`：rescue 执行路径拒绝低于目标价的限时折扣。
  - `marketing/smoke_manual_limited_discount_protection.mjs`：验证无保护时旧逻辑会排队、有效保护剔除三条、到期恢复普通规则、stale rescue 防御、普通漂移不受影响、特殊价精确恢复，以及价格/活动库存/`validTo` 三项 live 覆盖、写阶段 fail closed 和 ET 足够/不足分支。
  - `marketing/smoke_new_listing_limited_discount_plan_exact_price.mjs`：新上架限时折扣计划使用精确 storeKey+SKC 目标价证据。
  - `marketing/smoke_order_audit_linksdata_exact_target.mjs`：订单审计优先使用 linksData 精确 store/SKC 目标价和活动窗口。
  - `marketing/smoke_order_target_price_windows.mjs`：订单审计在 linksData 无直接行时使用 store/SKC 时间窗口计划目标。
  - `marketing/smoke_platform_new_label_policy.mjs`：平台"新款/新品/New Arrivals"标签在超出 7 天窗口后仍保持新品待遇，除非已有普通营销活动。
  - `marketing/smoke_split_limited_discount_target_price_guard.mjs`：拆分限时折扣计划拒绝低于目标价。
  - `marketing/smoke_split_recreate_limited_discount_target_guard.mjs`：拆分重建混合限时折扣拒绝低于目标价。

  - `marketing/scan_current_marketing_prices_for_bi.mjs`：全店当前/未来普通活动、限时折扣和 active 优惠券价格层只读扫描；生产 session HTTP 每批并发 3 店，支持 `--store-attempts 1..5`（默认最多 3 次，仅重试已分类瞬时错误）。最终快照必须有完整 store payload、聚合 rows、`rowCount`、`ok` 和 `partial`；限时折扣行保留活动 ID、活动库存、商品库存和起止时间。

  - `cleanup_shein_store_browsers.mjs`：按配置店铺 profile 精确关闭 Chrome/Chromium，清理 Chrome 临时目录；确认目标店铺进程归零后同时删除该 profile 的 `SingletonLock/Cookie/Socket`，避免进程已关但旧锁阻断下一批启动。不得删除仍有目标进程的 profile 锁，也不处理 ET forwarder 等非营销 profile。

  - `lib/browser_task_lease.mjs` / `smoke_browser_task_lease.mjs`：实际启动浏览器的任务按“任务 × 店铺”获取、心跳和释放租约；过期或 owner PID 已死亡才回收。每小时 `shein-bi-cloud-browser-cleanup.timer` 先回收过期租约，再清理未受有效租约保护的孤儿浏览器。纯 session HTTP guard 不申请租约。

  - `cloud_marketing_live_guard.sh` 与营销修复 queue/worker：完整巡检与大批写入解耦。guard 只做一次 stack review、一次价格层 scan、一次报告/建队列；不启动浏览器、不清理浏览器、不持有写授权。`2026-07-18` 生产基线为 19 店 `157s`、1516 行、Chrome `0 -> 0`。当次实时券/活动价证据完整时，旧 coupon/low-price/old-ordinary 中间扫描只作历史审计；实时证据不完整则 fail closed。worker 于 `10:50/12:50/14:50/16:50/18:50` 每轮最多 8 组，强制精确 work hash、事务补偿和最终全店 readback。

  - `marketing/split_recreate_mixed_limited_discount.mjs`：仅保留历史 dry-run/计划核对；旧“先结束整场再拆分重建”的 `--execute` 已禁用。真实替换必须改走 `replace_limited_discount_transactionally.mjs`，不能恢复旧入口。

  - `marketing/scan_hl_limited_discount_conflicts.mjs`：HL 限时折扣补救后的只读冲突扫描，确认目标 SKC 是否被新限时折扣覆盖、是否还有重复/缺口；必须显式传 `--rescue <json>` 与 `--end-cutoff "YYYY-MM-DD HH:mm:ss"`，不保留一次性批次默认路径。

  - `marketing/set_coupon_site_budget.mjs`：优惠券活动站点预算只服务于“可选 15% 流量券”试点，不再是目标成交价保底条件。新规则下不默认全店补 `1000 SAR`；应先按高曝光/滞销/清货试点规模测算预算，真实执行必须用户当轮授权，并保留 before/after 预算回读结果；若接口返回异常但回读已达目标，按“写入异常但预算达标”记录，不能继续盲目重复写入。

  - `marketing/build_coupon_import_from_skc_list.py` + `marketing/templates/coupon-import-15pct-template.xlsx`：从 SKC 清单生成 SHEIN 优惠券批量导入模板，供 `submit_coupon_activity_goods.mjs` 上传。

  - `marketing/smoke_marketing_classifiers.mjs`：营销分类器 smoke 测试，覆盖 `classifyCouponEligibilityRow`、`classifyLimitedDiscountCouponStack`、`plannedCouponFactor`、`plannedFinalTargetPrice`、`isOptionalTrafficCouponPlanRow`、`marginTargetsForExposurePolicy`、`pctConfigToRatio` 共 23 个测试用例。

  - `cloud_read_order_files.py`：从云端 `outputs/shein_fetch/<store>/<date>.json` 读取订单商品行，供 `build_marketing_daily_guard_report.mjs` 调用。2026-07-02 从 guard 脚本内联 Python 抽出为独立文件。

- 营销共享模块（2026-07-02 重构新增）：

  - `lib/marketing_plan_selector.mjs`：营销计划选择模块，从 `build_marketing_daily_guard_report.mjs` 抽出。优先使用 `planMetadata` 元数据选择当前基准计划，降级到文件名打分。
  - `lib/shein_browser.mjs`：共享浏览器交互层（`httpJson`/`sleep`/`isCdpOpen`/`connectStorePage`/`ensureBrowser`/`closeExistingStoreChrome`/`bringStoreWindowToFront`），新脚本 import 即可，不需要 copy-paste。
  - `lib/marketing_utils.mjs`：共享工具函数（`numberOrNull`/`round2`/`round4`/`floor2`/`normalizeStoreKey`/`compact`/`splitList`/`parseLocalDateTime`/`listFiles`/`readJsonIfExists` 等）。
  - `config/marketing_fallback_prices.json`：营销填报 fallback 固定价和利润率配置，从 `dsy_marketing_deadline_fill.mjs` 源码硬编码移出。
  - `config/cloud_marketing_busy_services.json`：云端营销巡检防撞车服务列表，从 `cloud_marketing_live_guard.sh` 硬编码移出。

- OpenAPI 试点：

  - `cloud_openapi_reconciliation.sh`：19 店 OpenAPI 销售双跑并行对账入口；默认低并发写入 `fact.openapi_*` / `mart.openapi_sales_reconciliation`，不替换正式销售事实表。

  - `check_shein_openapi_client.mjs`

  - `probe_shein_openapi_test_call.mjs`

  - `shein_openapi_authorize_hl.mjs`：历史 HL 试点授权脚本；仍可用 `--store` 指定其它店。

  - `shein_openapi_authorize_store.mjs`：19 店通用 OpenAPI 授权入口，包装上述脚本，避免后续操作继续写死 HL。

  - `probe_shein_openapi_hl.mjs`：历史 HL 试点只读探针；仍可用 `--store` 指定其它店。

  - `probe_shein_openapi_store.mjs`：单店通用只读探针入口。

  - `probe_shein_openapi_all_stores.mjs`：19 店 OpenAPI 授权/探针汇总；未授权店只输出 pending/incomplete，不打印密钥。

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

- `cloud_ops_watchdog.mjs`：云端 systemd/watchdog 新鲜度检查；销售/BI 页面按高频阈值，链接/业务域按日更低频阈值，并按 80% / 88% / 93% 三档监测根盘容量，异常时调用 `notify_sync_issue.mjs` 发飞书提醒。对孤立的历史营销扫描 warning，仅在 `lib/cloud_watchdog_recovery.mjs` 验证后续扫描更新、新鲜、19 店完整且 payload/行数自洽时记录 recovery；不删除历史 warning，也不吞掉其它异常。
- `cloud_disk_maintenance.sh`：每周低优先级磁盘维护；抓数产物本地保留 30 天，COS 归档必须通过 gzip、成员清单和 SHA256 校验后才删除未变化的本地文件。profile 缓存仅在根盘达到 80%、没有有效浏览器租约且没有 Chrome 进程时清理，Cookie 与持久登录状态不在目标清单中。

- `lark_sales_qa_bot.mjs`：云端只读问数核心，供网页和 Owner CLI 复用（独立飞书监听 service 仍暂停）；每轮从 BI Portal JSON 动态压缩销售、店铺、货号、链接/覆盖上下文并回复，不写数据库、飞书 Base 或 SHEIN 后台。近 7 天曝光/点击率/销量组合筛选直接读取 `storeLinks`，点击率按近 7 天商详访客除以曝光重算，不交给模型猜路由；安全约束中的否定式凭据词不算索取。产品文本和图表 label 优先使用 `product_display_name` / `productDisplayNames`。

- `cloud_shein_session_manager.mjs` / `cloud_shein_session_manager.sh`：云端登录态管家；顺序巡检/恢复当前 19 店 WebAPI + SBN 登录态，并输出 profile 体积报告。

- `cloud_manual_login_session.mjs`：云端临时人工登录窗口管理器；按店启动 Xvfb + Chrome + x11vnc + websockify/noVNC，完成后导出/探测登录态并关闭临时进程。状态、短期 token 和日志都属于服务器私有运行态，不提交 GitHub。

- `cloud_morning_chain.sh`：云端晨间串行链路入口；08:00 先跑当天销售刷新，再启动统一日更。当前 `SHEIN_BI_MORNING_SEND_LARK_REPORT=0`，默认不发送日报。

- `cloud_daily_refresh.sh`：云端统一日更补采入口；集中执行每天一次的链接/业务域、SBN 营销概览、RTV 换单复核、体检和 BI 刷新。它不再调用全店 `scan_current_marketing_prices_for_bi.mjs`，避免与独立 guard 重复抓同一 MBRs 价格栈。OpenAPI 销售、退货退款、商品/链接双跑只写隔离对账层，不切生产事实源。

- `cloud_link_business_sync.sh`：云端链接/业务域低层入口；按店顺序 bootstrap 浏览器会话、抓链接和业务域、入仓。生产调度由 `cloud_daily_refresh.sh` 调用它，避免日更任务分散。

- `bootstrap_shein_browser_session.mjs`：把服务器私有 SHEIN WebAPI/browser session 注入云端 headless Chrome profile，并用订单接口只读探测登录态。

- `export_shein_browser_session.mjs`：从已登录 Chrome profile 导出 SHEIN 浏览器会话状态到 `state/shein_browser_sessions/*.local.json`；输出属于敏感运行态，不提交 GitHub。

- `check_workspace_skill.ps1`

- `watchdog_sales_automation.mjs`


## 自动化运营 / OpenAPI smoke 与发版门禁

- `test_bi_ops_release_gate.mjs`：自动化运营发版前总门禁；串联语法检查、权限矩阵、CLI flow、白名单作用域、前端确认/反馈、OpenAPI 商品详情 mapper、店铺身份 fallback、维护写执行器、复制上品强/弱回读、生产安全和旧确认文本扫描。

- `test_bi_ops_frontend_confirm_feedback.mjs`：静态验证自动化运营页中文 `确认` 映射、按钮 busy/done/error 反馈、证据面板不遮挡聊天和 Markdown 渲染辅助函数。

- `test_link_ops_product_draft_openapi_detail.mjs`：用离线 OpenAPI 商品详情 fixture 验证 `copy_product_draft` payload mapper 能还原类目、属性、图片、SKU、供货价、库存和尺寸重量等关键字段。

- `test_shein_store_identity_merchant_fallback.mjs`：验证店铺身份校验的 `merchantId` fallback 只在静态真相匹配且无 GS 冲突时允许，避免 `account_mismatch` 被误放宽。

- `test_bi_ops_copy_product_all_stores_capability.mjs`：验证 `copy_product_draft` 不再局限 HL；在授权、探针、总闸门、白名单和 payload 能力齐全时，非 HL 店也能进入可确认链路。
- `test_link_retire_candidate_policy.mjs`：下架候选策略 smoke，覆盖 15 天 cutoff、候选通过、首次上架排除、新品标签排除、曝光/销量/缺字段阻断。
- `test_link_retire_candidates_from_csv.mjs`：CSV 构建器端到端 smoke，4 行 fixture 验证 1 候选/2 首次上架排除/1 新品标签排除。
- `test_retire_supplier_code_repair_payload.mjs`：修复 payload 构建器和执行器约束 smoke，验证绝不调 shelf 接口、硬排除项、failed partialEdit 不计成功、本机 Windows OpenAPI 拒绝。
- `test_retire_execute_best_effort.mjs`：执行器 best-effort 语义测试，货号修复失败不阻断下架硬目标、shelf 回读状态分类。
- `test_link_ops_executor_copy_batch_features.mjs`：复制批量功能自测，随机供货价区间、图片洗牌/全局 sort 唯一、电流推断。




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
- `lib/link_retire_candidate_policy.mjs`：低曝光零销量下架候选策略库。计算首次上架 15 天 cutoff，按上架状态、7 天曝光 <= 300、7 天销量 = 0、新品标签、首次上架日期评估候选。
- `lib/retire_supplier_code_repair_payload.mjs`：构建/校验下架后货号修复 `partialEdit` payload。规范化属性，并对 Wall Plug/Input voltage/Input current、Hazardous materials classification 等模板必填项 fail closed；任一 blocker 存在时 `body=null`，不会留下看似可执行的半成品 payload。

- `lib/shein_openapi_client.mjs` / `test_shein_openapi_client_timeout.mjs`：共享 OpenAPI 客户端与超时回归。超时覆盖网络请求和响应正文读取全过程，避免服务端已返回 headers 但 body 卡住时无限等待。

- `scripts/serve_shein_webhook.mjs`：独立 Webhook HTTP receiver + PostgreSQL lease worker；1.2 秒入口预算内只有 AES 密文可靠落库后才返回 200，不参与 SHEIN 写。
- `lib/shein_webhook_receiver.mjs` / `lib/shein_webhook_config.mjs`：官方签名/AES、三种 body 格式、23 个事件规范化，以及 19 App 到店铺的严格私有配置映射。
- `lib/shein_webhook_repository.mjs` / `infra/warehouse/migrations/20260719_001_shein_webhook_runtime.sql` / `infra/warehouse/migrations/20260721_001_shein_webhook_product_context.sql`：只存密文的幂等 receipt/queue、安全前端投影、下架站点事件合并、受限商品/销售上下文函数、租约重试、事实表只读 + 按单 apply 函数，以及授权/额度店铺闸门。
- `scripts/provision_shein_webhook_postgres_role.sh`：root-only 创建独立 `shein_webhook_ops` 与 `0600` 专用 EnvironmentFile，不输出密码；迁移随后只授予精准表权限。
- `lib/shein_webhook_handlers.mjs` / `lib/shein_webhook_audit_context.mjs` / `lib/shein_webhook_order_return_sync.mjs`：商品生命周期安全记录与人话补全、审核失败的回调原因及只读议价信息补全、订单/退货按单号无损增量入仓、授权/额度风险处理；下架人/原因仅使用平台明示字段，审核补全失败不阻塞 P0，公网 worker 不读取运营任务表，合规事件不错误地封整店。
- `scripts/test_shein_webhook_*.mjs` / `scripts/test_bi_webhook_frontend.mjs`：协议、配置、仓库、处理器、targeted upsert、HTTP receiver 和“平台动态”前端回归；均纳入 deterministic tests。

- `lib/link_ops_image_role_planner.mjs` / `config/store_style_profiles.json`：上新图片角色与 19 店默认风格/标题组规划。明确标记 `已审可用` 的素材只允许因客观平台失败阻断；规划结果携带逐店 `defaultTitleGroup`，用户当轮指定可覆盖。



- `lib/product_sku_normalizer.mjs`：标准货号归一化、目录和别名归并。

- `lib/product_display_name.mjs`：面向 BI 前端和飞书问数机器人的展示名生成；只改显示，不改变 `standard_goods_sn`。

- `lib/marketing_pricing_policy.mjs`：营销活动机器可读定价策略加载与曝光前五链接识别；负责把 `config/marketing_pricing_policy.json` 里的“限时折扣兜底 / 同一标准货号全局曝光前五利润率差异 / 15%底价”规则提供给审核表和填报脚本。

- `lib/marketing_automation_authorization.mjs`：读取 `config/marketing_pricing_policy.json` 中的负责人长期营销授权，校验授权 ID、运行上下文、动作白名单和全启用店范围。云端 timer 不逐次要求 payload hash；普通活动、优惠券、预算和策略外动作不在授权内。

- `lib/marketing_manual_limited_discount_overrides.mjs`：人工特殊限时折扣登记、有效窗口、精确价格/活动库存/截止时间覆盖判定，以及 ET 门控库存动作的共享实现。

- `lib/marketing_ordinary_price_evidence.mjs`：读取 `tmp/mbrs/deadline-fill-results` 中仍在活动生效窗口内的普通营销活动填报价，按 `storeKey + skc` 归组，并计算不含券保底价与 `finalTargetPrice` 的差异，同时保留触券下探风险；供优惠券提交器、每日 guard 和高券研究共用，避免旧普通活动低价或触券打穿风险只在某一个脚本里被发现。



## 明确废弃或默认禁用



- `sync_shein_links_to_lark.mjs`

  - 状态：废弃，默认拒绝执行。

  - 原因：飞书链接管理功能已废弃，链接管理正式走云端私有源文件 / PostgreSQL / BI 门户。

  - 仅允许显式设置 `SHEIN_ENABLE_DEPRECATED_LARK_LINK_SYNC=1` 做一次性历史迁移。

- `setup_lark_dashboard.mjs`

  - 状态：旧看板创建脚本。

  - 当前正式看板是 `setup_lark_dashboard_main_v3.mjs` 和 `setup_lark_dashboard_previous_month.mjs`。

  - 暂保留作历史参考，不用于日常。

- `setup_lark_dashboard_native.mjs`

  - 状态：旧/实验看板脚本。

  - 暂保留作历史参考，不用于日常。

- `scheduled_daily_report_dsy.ps1`

  - 状态：旧 `09:00` 日报任务包装器，当前默认不安装。

  - 原因：飞书日报自动发送已停用；生产只保留 `scripts/cloud_daily_lark_report.sh today` / `send_daily_lark_report.mjs` 作为手动临时发送入口。

  - 只有用户明确要求恢复独立定时日报任务，并重新确认日报内容设计后，才通过 `install_windows_scheduled_tasks.ps1 -IncludeDailyReport` 安装。

- `generate_lark_ops_report_doc.mjs`

  - 状态：飞书文档版经营入口兜底脚本。

  - 原因：原用于飞书 Base Dashboard 不稳定时生成普通飞书文档；当前主入口已转为云端 BI 门户，飞书日报只保留手动入口。

  - 暂保留作历史参考，不用于日常自动任务。



## 临时探索 / 排障探针，后续可考虑归档
- `marketing/probe_remove_skc_from_limited_discount.mjs`：只读 CDP/Fetch 探针，拦截限时折扣编辑页的 remove/delete 请求并 abort，不执行。
- `marketing/probe2_remove_skc.mjs`：FY 浏览器探针，拦截营销 API 调用以发现 remove-SKC 端点。
- `marketing/probe_remove_skc_v3.mjs` ~ `v7.mjs`：系列只读探针，尝试多种编辑/详情/管理 URL 和 UI 交互以发现 remove 控件，均不确认删除。非生产脚本，可归档。



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

  - `build_link_retire_candidates_from_csv.mjs`：低曝光零销量下架候选只读报告。输入已带创建时间、首次上架时间、近 7 天曝光/销量和新品标签的 CSV，输出待确认 CSV/Markdown/JSON；不会调用 SHEIN，也不会下架。固定安全规则是：已上架、近 7 天曝光 `c7EpsUv <= 300`、近 7 天销量 `0`、平台新品标签为空，且首次上架已满 15 天。首次上架 15 天内不管是否有新品标签都排除；缺 `first_shelf_time` 的行只能进待确认/不执行。

  - `execute_retire_candidates_openapi.mjs`：云端专用的已确认下架候选执行器。本机只能 dry-run；真实执行必须在 `shein-bi-tencent` 用 `SHEIN_BI_CLOUD_EXECUTION=1`、dry-run `payloadHash` 和确认文本运行。执行顺序是先 `retire_link` 下架，再 best-effort 改 `（废）标准货号`；改货号失败不阻断下架，最终汇总分为“已下架+货号已改/进入审核”“已下架+货号未改”“下架失败”。
  - `repair_retire_supplier_code_openapi.mjs`：已下架但货号未改成`（废）...`的修复专用执行器。只调 `partialEdit`，绝不调 shelf 接口；本机只能 dry-run，真实执行必须在云端。模板属性、危险品分类或其它必要事实缺失时整条失败关闭；执行中不再临时猜测/补写 supplier code normalization。
  - `build_supplier_code_normalization_plan.mjs`：通用只读货号规范化计划器；从明确输入生成待审计划和 blocker，不调用 SHEIN。2026-07-16 前的六个单批次 normalization 脚本已从活动脚本目录移除并仅保留在本机忽略的发版前备份中，避免被误当通用生产入口。



## BI 自动运营 V2 / PostgreSQL runtime（2026-07-12 release）

- `scripts/owner_knowledge_sync.mjs`：负责人本机 Codex Desktop/CLI 经验增量同步；文件事件触发、15 秒去抖、启动对账、60 分钟兜底，只上传当前项目的脱敏结构化经验。
- `scripts/owner_knowledge_admin.mjs`：云端管理员登记负责人同步设备、查看状态并用 `publish --force` 重试 GitHub distribution；返回的设备 token 只允许写入本机私有凭证文件。
- `scripts/install_owner_knowledge_sync_task.ps1`：安装/卸载负责人本人 Windows 登录后常驻事件 watcher；普通同事机器不安装。
- `lib/owner_knowledge_policy.mjs` / `lib/owner_knowledge_service.mjs` / `lib/owner_knowledge_local_collector.mjs`：唯一发布者判定、active/candidate 分层、规则相关性选择、版本/设备/distribution 存储和双层脱敏采集。
- `lib/owner_knowledge_distribution.mjs` / `scripts/validate_owner_knowledge_distribution.mjs`：生成不含来源/设备/凭证的 immutable GitHub bundle、manifest、hash 校验和专用分支 publisher；Git 调用有界超时，publisher 使用带 nonce/PID/心跳的唯一 ticket 队列。
- `lib/cross_process_ticket_lock.mjs`：缓存与 Git publisher 共用的跨进程 ticket 锁；每个 contender 使用不可复用文件名，死亡 ticket 独立清理，避免固定 recovery mutex 自身成为永久死锁。
- `lib/partner_knowledge_cache.mjs`：合伙人 CLI 的 ETag 版本检查、最低 CLI 版本门禁、bundle hash 校验，以及带心跳/进程存活校验、不可变 generation 和写前防回滚的本地原子缓存。
- `config/partner_cli_package.json` / `scripts/build_partner_bi_ops_cli_package.ps1` / `scripts/install_partner_bi_ops_cli.ps1`：定义、构建和安装不含生产凭证的最小合伙人 CLI 包；安装到用户目录的版本化路径，不在任务中途自改代码。`2026.07.16.1` 起包内包含 `config/store_style_profiles.json`；`2026.07.21.1` 起 Skill 要求经营数据只读问题优先走 `ask`，禁止在 BI 查询失败时转去浏览器抓数或要求用户开启 Chrome 远程调试。
- `scripts/serve_bi_portal.mjs`：网页自动运营主服务；生产通过 `SHEIN_LINK_OPS_STORE=postgres` 使用行级 runtime，数据库不可用时失败关闭。
- `scripts/bi_ops_cli.mjs`：Owner/合伙人 CLI；云端业务命令前自动刷新负责人规则，`knowledge-status` 可做显式诊断；`chat/jobs/job/wait-job/--profile/--scope-all` 均不扩大写权限。
- `scripts/bi_ops_intent_planner.mjs` / `lib/bi_ops_intent_planner.mjs`：严格 JSON schema 的结构化意图规划；只理解和规划，不执行 SHEIN 写。
- `lib/bi_ops_query_context.mjs`：按账号和店铺压缩/脱敏 BI 问数与任务上下文，限制长度并避免把跨账号会话或内部执行字段交给模型。
- `lib/bi_ops_model_policy.mjs`：Luna/Terra/Sol 分层和超时策略；网页禁止 max/ultra。
- `lib/bi_ops_agent_governor.mjs`：并发、每账号队列、速率和熔断护栏。
- `lib/link_ops_repository.mjs` / `lib/link_ops_store_gateway.mjs` / `lib/link_ops_json_repository.mjs`：PostgreSQL 行级仓库、旧 snapshot 兼容网关和本地 JSON 测试仓库。
- `lib/link_ops_job_worker.mjs`：带租约、write boundary 与过期恢复的后台 job worker。
- `lib/link_ops_migration_compat.mjs`：保留旧孤儿会话引用的可逆迁移标记；PG 回滚导出时可还原。
- `lib/warehouse_pg.mjs`：只从环境变量读取 PostgreSQL 连接，生产不允许静默回退 JSON。
- `scripts/migrate_link_ops_runtime_to_postgres.mjs`：JSON -> PG dry-run/execute、manifest/hash、owner quarantine；生产首次切换按确认使用 `--skip-legacy-conversations`，旧任务/会话只留备份。
- `scripts/export_link_ops_postgres_snapshot.mjs`：PG -> JSON 回滚快照与 manifest。
- `scripts/provision_link_ops_postgres_role.sh`：root-only 创建受限角色及私有 EnvironmentFile，不输出密码。
- `infra/warehouse/migrations/20260711_001_link_ops_runtime.sql`：`ops.link_ops_*` 行级 schema 与 append-only event trigger。
- 关键回归：`test_bi_ops_agent_governor.mjs`、`test_bi_ops_intent_planner.mjs`、`test_bi_ops_model_policy.mjs`、`test_bi_ops_query_context.mjs`、`test_bi_ops_intent_job_flow.mjs`、`test_bi_ops_multitenant_isolation.mjs`、`test_link_ops_*`、`test_migrate_link_ops_runtime_to_postgres.mjs`、`test_owner_knowledge_*`、`test_partner_knowledge_cache.mjs`。以上均已纳入 `scripts/run_deterministic_tests.mjs`。
- `scripts/lark_sales_qa_bot.mjs` 和对应 unit 仅保留审计/未来恢复能力；生产 service 当前必须 `disabled + inactive`。

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
