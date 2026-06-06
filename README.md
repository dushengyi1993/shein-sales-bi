# SHEIN 销售统计与 BI 经营系统

## 2026-06-03 当前权威状态

- 飞书多维表格 / 原生看板写入已临时暂停；云端 BI 系统作为当前主要经营入口继续运行。飞书日报、异常通知 watchdog 和只读问数机器人均已迁到云端独立飞书机器人链路；日报真实发送已验证，问数机器人已升级为云端 Codex CLI 只读网关，不再绑定本机 Codex 会话。
- 本地 BI 已封存，云端 BI 是正式入口：`https://shein-bi.faceair.me/`（旧 IP 入口 `http://43.165.167.135/` 仅作兜底）。公网入口已启用 Basic Auth；账号密码只在运行环境交付，不写入仓库或文档。详见 `docs/cloud-bi-operations.md`。
- 云端 BI 已提供临时登录维护入口 `/cloud-login-maintenance`：当 SHEIN / SBN 子系统登录态失效、自动恢复失败、遇到验证码/滑块，或被协议签署 / 公告 / 通知确认等普通登录弹窗挡住时，可在云服务器短时打开该店独立 profile 的 noVNC 浏览器窗口；普通登录干扰弹窗可由运维代理关闭/确认后再点登录，完成后必须点“我已完成并关闭”，脚本会导出/探测登录态并关闭临时进程。该入口的状态文件、日志和短期 token 都是服务器私有运行态，不进 GitHub。
- 本地 `8787` 服务已停止，`SHEIN-*` Windows 计划任务已禁用；除非明确回滚，不要重新启动本地 BI 或本地抓数任务。
- 销售同步完成后会后置刷新 BI；如果单店失败但目标日期当前启用店铺销售源文件已齐，BI 仍会刷新，并通过飞书消息提醒失败店铺。
- SHEIN 销售生产入口已改为 Node WebAPI 直连优先：`config/stores.json` 的当前 19 店 `salesTransport=auto`，`run_sales_sync_job.mjs` 会先用 `state/shein_webapi_sessions/<店铺>.local.json` 的 Cookie session 直调 `/gsp/orderPlus/listOrder` 和 `/gsp/orderPlus/listOrderItem`；成功时不启动浏览器，失败时才刷新 session / 回退 Chrome。`2026-05-08` 16 店 WebAPI 抓取已与现有数据库对账一致。
- 云端当天销售刷新已改为全天每两小时一次：`00:10/02:10/.../22:10`；前一天最终版和 D-2 稳定复核仍在 `00:10`，数据库自动备份在 `02:30`。云端 SSH 直连已恢复，当前本机别名为 `ssh shein-bi-tencent`。
- 链接表现改为每日后半夜一次，当前只写私有源文件 / PostgreSQL / BI；飞书链接管理表已废弃。旧 `0340` / `0510` 链接任务不要恢复。
- 当前完整 BI 运行层仍是 PostgreSQL + Metabase + BI Portal：PostgreSQL 是核心数据仓库，Metabase 是正式深度分析/自由钻取层，BI Portal 是日常经营入口；在自研门户完全覆盖深钻前，云端迁移不能删除或跳过 Metabase。
- 服务器从 GitHub 拉取/重置代码后，要立即重跑一次云端 BI 刷新；仓库里的 `outputs/bi-portal/` 是灾备快照，不能把它误当成服务器实时数据。
- HL 已切换为主账号 profile：`profiles/persistent-shein-main-profile`；旧 `profiles/persistent-hl-profile` 已删除。
- `2026-06-05` 已按用户提供的账号真相修正 LGM 三店 profile / 账号映射：`YJ=profileKey yj/accountNo GS8146729/port 9346`、`XL=profileKey xl/accountNo GS9307061/port 9344`、`QY=profileKey qy/accountNo GS7451160/port 9345`。店铺身份真相以 `config/stores.json`、`config/store_account_truth.json`、浏览器保存账号和实际登录后的店铺名/账号一致为准；不得再沿用 `2026-05-10` 的交叉 profile 结论。
- `2026-05-09 05:30` 链接/业务域任务、`2026-05-09 07:00` BI 每日流水线和白天滚动后置 BI 刷新是本地 Windows 历史验证记录；自 `2026-05-15` 本地任务封存后，不再作为生产调度。
- `2026-05-13` 已明确 BI/RTV 调度边界：RTV 换单自动复核本来就耗时，不应被当成滚动 BI 未更新。云端滚动刷新优先做销售 WebAPI、入仓和 BI Portal 生成；完整 RTV 复核、链接/业务域日更均已新增云端独立 timer，链接/业务域仍按低频日更边界处理，不按销售高频阈值报警。
- ET 货代仓已接入数据仓库和 BI，能抓库存、RTV、出库、发货申请单、财务等；云端已启用 Linux headless Chrome + ET 本地凭据 + OCR 自动登录入口并完成真实同步验证，不能直接复用 Windows Chrome 保存密码。
- RTV 换单号自动复核已接入 BI 流水线：`scripts/verify_shein_rtv_tracking.mjs` 直接读取 SHEIN 售后详情和退货物流详情，JT/JTE 走同运单直连，iMile/EMile 识别中英文换单证据；截至 `2026-05-09` 已确认 `132` 个 ET RTV 入仓单号。
- RTV 收件后去向已进入 BI：`mart.et_rtv_destination_allocation` 追踪 09 可售、03_RTV、04 破损、06 报废和其它/未知去向；`mart.shein_return_rtv_trace` 在 `订单 / 售后` 页面展示每条 SHEIN 退货是否收到、收到后去了哪里。
- HL OpenAPI 销售试点已跑通并行链路：`outputs/shein_openapi_fetch/HL/YYYY-MM-DD.json` 写入 `fact.openapi_*` 并行事实表与 `mart.openapi_sales_reconciliation` 对账表；BI 系统状态页显示 “SHEIN OpenAPI 试点对账”。正式切换生产销售表前继续累计多日 `matched`。
- HL OpenAPI 销售试点曾在本地 Windows 任务中双跑，只写 `fact.openapi_*` 和 `mart.openapi_sales_reconciliation`，不覆盖生产销售事实表；本地 Windows 任务已封存，云端 systemd 双跑入口已部署，云服务器出口 IP `43.165.167.135` 已加入 SHEIN 开放平台白名单，云端双跑已成功。2026-06-05 本机可见 profile 复核：HL 与 ZL 开放平台应用已审核通过；DSY 其余 `DL/DX/FY/LQ/NM/JY/TS/MZ`、LGM 剩余 `YJ/XL/QY/QH/TZ/JSH/TZZ/XC` 应用已提交审核中；CX 用户确认此前已完成。审核通过、逐店授权和双跑对账完成前，不得写入 `.local` 密钥或切换生产源。
- 系统定位正在从“BI 数据分析”扩展为“自动运营驾驶舱”：先把可重复运营动作沉淀为脚本和规则，再按“建议/预填/复核/人工确认提交/审计留痕”的边界逐步开放自动化。2026-05-17 已上线“链接管理中台”基座：支持“一个会话对应一个任务工作台”，边聊边沉淀任务目标、数据依据、素材、执行步骤和进度；自然语言会话每轮都会按最新 BI JSON 动态查数，明确下架/换图/补链/报活动等动作命令会自动进入任务并在同一界面可见。2026-05-20 起，任务区已提供“开始执行 / 预检”和二次确认入口，点击后会真实调用 `/api/link-ops-execute` 写回进度与审计；默认仍只做受控预检 / dry-run，不会静默提交 SHEIN。

本工作区用于 SHEIN 当前 19 店销售数据自动抓取、飞书多维表格统计、每日飞书日报、链接管理、营销活动报名辅助，以及正在并行建设的 PostgreSQL + Metabase + 云端 BI / 自动运营驾驶舱。

当前原则：**SHEIN 抓数、BI 刷新、ET 同步、飞书日报、异常通知和只读问数机器人在云端继续运行；飞书多维表格 / 看板写入先暂停，待用户确认再恢复。**

## 当前运行状态（2026-05-18 云端切换后）

以下为当前入口、调度和边界说明；实时数据以 `outputs/bi-portal/data.json`、云端日志和 BI 门户系统状态页为准。

- 店铺范围：19 家店，`DSY` 组 10 家，`LGM` 组 9 家。
- 当前店铺代码：`CX DL DX FY HL JSH JY LQ MZ NM QH QY TS TZ TZZ XC XL YJ ZL`（LGM 已新增 `JSH / TZZ / XC`）。
- 正式 Base：`https://zcnm3ts63aph.feishu.cn/base/SnnQbrAu6aLzMWsnEICcy0cKnJh`（标题已标注 `【多维表格同步暂停｜日报正常】`）
- 当前正式看板：
  - 当月主看板：`SHEIN经营看板 v3-主看板`（`blkFn3qHrwdsrJyX`）
  - 上月看板：`SHEIN经营看板 v3-上月`（`blkWeyZhphgRZYim`）
- 当前 BI 入口：
  - 云端 BI：`https://shein-bi.faceair.me/`，Basic Auth 保护；旧 IP 入口 `http://43.165.167.135/` 仅作兜底。
  - 云端登录维护中心：`https://shein-bi.faceair.me/cloud-login-maintenance`，用于临时打开指定店铺云端浏览器登录窗口。
  - 云端代码目录：`/opt/shein-bi/app`
  - 本地 BI 门户文件快照：`outputs/bi-portal/index.html` / `outputs/bi-portal/data.json`
  - V1 是当前正式 BI Portal；用户确认后的 V1/main 才发布 GitHub release。当前 V1/main 已发布到 `2026.06.04-core-section-warmup-hotfix`，后续首页性能补丁保持同一 V1/main 边界；V2 仍不属于正式发布。
  - V2.1 独立设计预览仍是平行项目，由 `scripts/generate_bi_portal_v2.mjs` 生成；用户确认前不得替换 V1 或改生产调度。
  - 本机 `http://127.0.0.1:8787/` 和局域网 `http://DUSHENGYI-PC2:8787/` 已封存，不再作为正式入口。
  - Metabase 当前部署在云端 Docker 内部，由云端 Nginx/服务配置受控访问，不在 README 写公开裸地址。
- 当前 BI 数据截面不再手工写死在 README；实时以 BI 门户系统状态页、`outputs/bi-portal/data.json`、云端 systemd 日志和数据库入仓时间为准。仓库中的 `outputs/bi-portal/` 只是灾备快照，服务器拉取/重置代码后必须重新跑云端 BI 刷新。
- BI Portal API section cache 位于 `outputs/bi-portal/sections/`；首页首屏使用轻量 `homeRankings`（只含首页需要的日店铺、日货号、日店铺×货号粒度），完整 `rankings` 后置到详情/子页需要时再拉。服务端会为 section cache 生成 `.json.gz` sidecar，公网浏览器优先走 gzip。`cloud_bi_refresh.sh` 刷新 core 后会启动 `prewarm_bi_portal_sections.sh`；`serve_bi_portal.mjs` 还会在服务启动和首页访问时检测 `data.json.generatedAt`，后台兜底预热 section，避免等用户打开页面才现场生成。首页利润 `homeProfit` 必须从当前 `profit` section cache 派生；若首页利润明显低于当前销售额，先核对 `profit.json.generatedAt`、`homeProfit.json.data.homeProfitSummary.sourceGeneratedAt` 和 `staleSource`，`staleSource=true` 或 `sourceGeneratedAt` 不等于当前 core 时不能按旧利润判断业务真实利润。
- 定时任务：
  - 云端 `shein-bi-cloud-today.timer`：`00:10/02:10/.../22:10` 每两小时刷新当天销售、入仓并生成 BI Portal。
  - 云端 `shein-bi-cloud-yesterday.timer`：每天 `00:10` 刷新前一天最终销售，并复核前两天稳定日。
  - 云端 `shein-bi-db-backup.timer`：每天 `02:30` 备份业务库和 Metabase 元数据库，默认保留 `14` 天。
  - 云端 `shein-bi-cloud-et-forwarder.timer`：每天 `04:20` 同步 ET；需服务器本地 ET 凭据和手动验证后启用。
  - 云端 `shein-bi-cloud-daily-lark-report.timer`：每天 `08:35` 发送日报，`10:35/12:35` 补偿重试；需服务器本地飞书配置和授权后启用。
  - 云端 `shein-bi-cloud-rtv-verify.timer`：每天 `03:20` 跑完整 RTV 换单复核 WebAPI 版，不阻塞滚动销售刷新。
- 云端 `shein-bi-cloud-link-business.timer`：每天 `05:30` 顺序启动云端 headless Chrome 抓取前一完整日链接/业务域，入仓、体检并刷新 BI；单店失败会重启浏览器重试。
- 云端 `shein-bi-cloud-session-manager.timer`：每天 `03:20` 顺序巡检/恢复当前 19 店 WebAPI + SBN 登录态，并检查 profile 体积。
- 2026-05-21 运维加固：链接/业务域服务统一以 `sheinops` 运行，避免 root 写 Chrome profile 后导致登录态管家 `EACCES`；登录态恢复改为先回灌 browser session、再验证 GSP + SBN；ET 验证码下载瞬时失败会进入重试，不再一次 `fetch failed` 就中断。
  - 云端 `shein-bi-cloud-openapi-hl.timer`：每天 `06:20` 跑 HL OpenAPI 并行对账；已可在云端成功抓取、入仓和生成 OpenAPI 对账。
  - 云端 `shein-bi-cloud-watchdog.timer`：每小时检查云端服务、timer 和 BI 数据新鲜度；销售/页面按 4.5 小时阈值，链接/业务域按 48 小时日更阈值。
  - 云端 `shein-bi-lark-sales-qa.service`：常驻只读飞书问数机器人，通过 `/home/sheinops/.codex` 的 Codex CLI 配置执行受控只读问答，只读取 BI Portal 压缩上下文，不写数据库、飞书 Base 或 SHEIN 后台。
  - 本地 `SHEIN-*` Windows 计划任务已禁用，保留为回滚参考，不再作为生产调度。
  - 链接/业务域本地 Windows 日更任务已封存；当前生产改由云端 `shein-bi-cloud-link-business.timer` 顺序抓取，不再依赖本机补数。纯 Node 零浏览器直连仍是后续优化，不影响当前云端日更。
- 当前飞书 Base 暂停规则：存在 `state/feishu-base-sync-paused.flag` 时，跳过飞书事实表、产品表、月表、年度/周月宽表、当月主看板和上月看板写入。云端飞书日报、异常通知和只读问数机器人只走消息/图片回复，不写 Base。
- 当前自动任务状态：
  - 云端 `shein-bi-cloud-today.timer` / `shein-bi-cloud-yesterday.timer` / `shein-bi-db-backup.timer` / `shein-bi-cloud-link-business.timer` 是当前生产调度。
  - `SHEIN-Sales-ETForwarder-0420`、`SHEIN-Sales-15Stores-LinkManagement-0530`、`SHEIN-BI-Daily-Pipeline-0700` 等是本地历史任务，已禁用，保留为回滚/迁移参考。
  - `2026-05-02 07:00` 的 `267014` 是已修复的历史失败记录，保留作排障证据。
- 团队访问边界：
  - 当前团队访问转为云端入口 `https://shein-bi.faceair.me/`，旧 IP `http://43.165.167.135/` 仅作兜底，受 Basic Auth 保护。
  - 本地局域网协作入口已封存；`8787` 服务停止，本地计划任务禁用。
  - 原 Windows 防火墙规则需要管理员权限才能禁用；只要本地没有服务监听 `8787`，局域网不会再打开本地 BI。
  - 同事可标记动作状态、填写负责人和备注；短期仍沿用云端服务侧状态文件，长期应迁入 PostgreSQL，避免文件状态成为单点。
  - 团队正式版已具备域名和 HTTPS；后续还需要动作状态入 PostgreSQL、异地备份和更正式的账号权限。
- 后续维护原则：优先把可重复动作脚本化；Markdown 只保留长期规则、入口和关键坑，不再追加流水账，避免小任务频繁触发上下文压缩。

## 核心口径

- 统计日：北京时间自然日。
- 时间口径：订单创建时间。
- 汇率：`1 SAR = 1.8 RMB`。
- 销售有效性统一走 `lib/shein_sales_validity.mjs`：只把真正取消、揽收前取消等“未形成销售”的商品行从总销售额、订单数和销量中剔除；用户已退款、退货、派件失败等仍保留在总销售额里，再由净销售额、售后/利润层反转。后台原始金额仍保留在明细里用于追溯。历史本地 JSON summary 可用 `scripts/repair_shein_sales_summaries.mjs` 重算。
- 利润口径：首页和成本/利润页使用真实利润；成本未覆盖时显示“待成本表 / 成本覆盖率”，不再用 `25%` 粗估冒充真实利润。仓储费正式来源是 ET 物流仓服账单 `仓储费`：显示金额按 RMB，实际扣费按显示金额 × `0.5` 后以 `1 SAR = 1.8 RMB` 折 SAR；店铺/DSY/LGM 按净销售额分摊，货号层优先使用 ET `ExportStoreFee` 当日明细；若历史明细合计与总账不一致，则保留货号分布并按总账缩放，只有完全缺明细日期才按 ET 体积 × 库存天数估算并标注口径。
- ET 仓储费导出里的 `storage_code` / `sku_code` 必须保留原始值，例如 `DL-SK-999`；`match_key` 只作为内部归并键。面向 BI/利润展示的货号要通过 `mart.product_display_by_match_key` 回到销售或商品主档里的既有标准货号，不能把 ET 解析出的中间短码当成新商品暴露出来。
- 营销活动确认表里的 `仓储费SAR/件` 不能用累计仓储费除以历史销量，也不能把全历史仓储费一刀切压到当前库存上；必须来自 BI `profit.productStorageDaily` 的“当前仍在仓库存移动平均累计仓储成本”：每日仓储费加入库存成本余额，库存数量减少时按当前平均成本剔除已出库产品携带的历史仓储成本。短码或无法确认的货号必须标记待归并暂停，不能按 0 仓储或猜测成本继续报名。
- 配套 15% 优惠券活动不能直接跟普通营销活动计划全量走：目标必须由 paired `price-overrides` 派生的 `allowed15 ∩ MULTI_LEVEL_RULE_GOODS` 决定，仅 `couponFactor≈0.85` 或明确“仅15%券”的 SKC 可报名；`couponFactor=1`、不叠券/券都禁止、缺覆盖价或冲突口径一律 fail closed。只读复扫必须看 `15%券档active是否符合允许计划`、`15%券档禁止/未知仍active数` 与 `15%券档active但不在允许计划数`。详见 `docs/marketing-campaign-signup-pricing-rules.md`。
- 营销定价策略的机器可读入口是 `config/marketing_pricing_policy.json`：限时折扣必须作为兜底层存在但不得干扰目标成交价，默认从 `15%` 折扣起算；同一标准货号在所有店铺、所有链接中按 BI 正曝光量取全局前五 SKC，前五可比其他链接低 `5` 个百分点目标利润率但不得低于 `15%` 底价，基础目标已为 `15%` 时前五保持 `15%`、其他链接提高到 `20%`；无正曝光指标不得猜前五，不能按单店拆出多个“前五”。
- 营销自动化的长期边界见 `docs/marketing-automation-roadmap.md`：度假季后补券、新链接纳入价格体系、券预算补 `1000 SAR`、低价成交查因、可报活动提前三天提醒、`30%/50%` 券研究和 BI 同事分店管理，都必须以价格栈证据为准；默认先只读 / dry-run / 复核，真实提交、取消、改价和补预算必须执行后 live 回读。券预算日报只把 `execute` 的 before/after 回读当完成证据，`dry-run` 不能冒充补额度成功；`30%/50%` 只允许用 `scripts/marketing/build_high_coupon_research_candidates.mjs` 生成 research-only 报告，不进入真实提交路径。
- 成本/利润页的高利润 / 低利润货号分界线固定为 `20%` 利润率：`>= 20%` 为可加码，`< 20%` 为需要处理。
- 当前正式成本文件为 `inputs/costs/成本.xlsx`；`单台总成本（SAR）` 是单批单件完整成本输入，系统先还原为批次总成本，再按同货号所有完整批次加权平均计算单位成本。
- 用户可见的产品主标题统一使用 `product_display_name`：生成端由 `lib/product_display_name.mjs` 基于 `standard_goods_sn`、`config/product_catalog.json` 和可靠中文标题补齐“标准货号+中文品名”；搜索、筛选、归因和仓库 key 仍使用 `standard_goods_sn` / `dim.product_match_key()`。无可靠中文来源的异常短码不编造中文，保留原值并标记待确认。
- `BL02` / `GL-BL02` / `BL02热水壶` 已归并到 `S1810电热水壶`；成本、库存、BI 货号行和问数机器人都应按 S1810 聚合，不再把 BL02 作为独立库存产品处理。
- BI 首页默认使用“净成交额 / 净销量”：买家已发起且未取消的售后申请默认计入退货/反转，包含 `待买家退货`、`待交接`、`待卖家处理` 等未落定状态；最终取消后再自动冲回。退货、仅退款、派送失败等反转订单不计入成交额、订单数和销量；这些订单仍扣商品成本；只有真实退货退款额外扣 `13.88 SAR`，`仅退款`、`派件失败`、`派件异常` 不重复扣退货派送费。
- 月利润判断要同时看订单创建月利润和售后申请月回冲影响；当月订单未经历完整售后成熟期时，利润会偏高且会随后续退货继续下修。2026 年 3/4/5 月重审结论见 `docs/bi-profit-audit-2026-03-05.md`。
- 首页销售额可切换“净销售额 / 总销售额”，销量可切换“净销量 / 总销量”；但 `sales_sar <= 0` 或 `gross_revenue_sar <= 0` 的揽收前取消 / 0 金额行在净口径和总口径里都直接忽略，就当没有发生，不计订单、销量、成本或退货派送费。
- 历史测试品 `2001/CM-2001` 有单独手工成本补充文件 `inputs/costs/历史手工成本补充.csv`，仅用于历史利润复核。
- 今日动作池同一店铺、同一 SKC、同一业务域命中的多条规则合并成一张动作卡，显示“合并 N 条”和各规则信号；不同业务域仍分开处理。
- 同一天同店铺重复运行必须更新同一条事实记录，不得重复累加。
- 遇到 SHEIN `20302 子系统登录重定向`：先自动恢复登录并重新抓取；如果只是协议签署、公告、通知确认等普通登录弹窗遮挡，运维代理可用可见窗口/noVNC 关闭或确认后再点登录；若账号/密码已由浏览器保存值填充但脚本 DOM click 无效，可用真实鼠标点击登录按钮，恢复后必须在同一 profile 用 `--no-launch --no-close` 继续复扫/取消，不能重启 profile 后把刚恢复的子系统态打掉；若是验证码、滑块、短信、人脸、缺密码，或出现新的法律/付费/授权范围承诺不明内容，则停下让用户处理。恢复失败时明确报错，不得把旧数据当最新数据。
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
- `profiles/`：工作区内的 Chrome 店铺 profile；当前 19 店登录态保存在 `persistent-*-profile`，不要删除整个 profile。后续磁盘瘦身只清 `OptGuideOnDeviceModel` 等 Chrome 可重建缓存，详见 `docs/runtime-architecture.md`。  如需核验店铺是否错位，使用稳定日期后台重抓并对账数据库，不要只看页面文本。
- `state/shein_webapi_sessions/`：WebAPI 直连复用的 Cookie session，本地敏感运行态，不进 GitHub；迁移时只能通过加密渠道或在新机器重新登录/刷新。
- `/srv/shein-bi/runtime/cloud_manual_login_sessions.json` 与 `/srv/shein-bi/logs/cloud-manual-login/`：云端临时登录窗口运行态，只在服务器私有目录，不进 GitHub。
- `outputs/cleanup/`：项目文件整理/清理清单，例如 `project-file-cleanup-2026-05-02.md`。

## 常用命令

- 云端手动刷新当天销售 + BI Portal（在服务器 `/opt/shein-bi/app` 执行）：
  `bash scripts/cloud_bi_refresh.sh today intraday`
- 云端手动刷新前一天最终版（在服务器 `/opt/shein-bi/app` 执行）：
  `bash scripts/cloud_bi_refresh.sh yesterday final`
- 云端手动备份数据库（在服务器 `/opt/shein-bi/app` 执行）：
  `bash scripts/cloud_db_backup.sh`
- 云端手动同步 ET 货代仓（在服务器 `/opt/shein-bi/app` 执行；需 `config/et_forwarder.local.json` 或环境变量）：
  `bash scripts/cloud_et_forwarder_sync.sh today`
- 云端手动发送飞书日报（在服务器 `/opt/shein-bi/app` 执行；需 `config/lark_report.json` 和 `lark-cli` 授权）：
  `bash scripts/cloud_daily_lark_report.sh today`
- 云端日报图若中文变方框，先确认服务器已安装中文字体并能匹配 `Noto Sans CJK SC`；代码字体栈以 Noto CJK 为 Linux 首选。
- 云端手动跑完整 RTV 换单复核 WebAPI 版（在服务器执行）：
  `bash scripts/cloud_rtv_verify.sh`
- 云端手动跑 HL OpenAPI 并行对账（在服务器执行；服务器 IP 白名单已配置）：
  `bash scripts/cloud_openapi_hl_reconciliation.sh`
- 云端手动跑 watchdog（在服务器执行）：
  `node scripts/cloud_ops_watchdog.mjs --dry-run`
- 云端只读测试飞书问数机器人回答（在服务器 `/opt/shein-bi/app` 执行）：
  `CODEX_HOME=/home/sheinops/.codex SHEIN_QA_CODEX_GATEWAY_ENABLED=1 node scripts/lark_sales_qa_bot.mjs --answer "今天哪个店最差？原因可能是什么？"`
- 云端 Codex CLI 连通性检查（只读执行，配置不进 GitHub）：
  `cd /tmp && CODEX_HOME=/home/sheinops/.codex timeout 120 codex exec --sandbox read-only --skip-git-repo-check "只回复 OK，不要解释。" < /dev/null`

以下 Windows 命令当前只作为本地开发、排障或回滚参考；本地 BI 已封存，除非明确回滚，不要重新启用本地计划任务：

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
- 跑全店当天同步：
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
- 本地手动运行 ET 货代仓同步（历史回滚/排障参考）：
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
- 生成并验证按货号汇总的营销确认表（会读取 `config/marketing_pricing_policy.json` 和 BI 曝光数据展示曝光前五价格差异）：
  `node scripts/marketing/build_marketing_sku_approval.mjs --date YYYY-MM-DD --version vN`
  `node scripts/marketing/verify_marketing_sku_approval.mjs --date YYYY-MM-DD --version vN`
- 导出 DSY 营销活动填报标准（只读，按货号汇总给用户审核；默认排除优惠券活动）：
  `node scripts/marketing/export_dsy_marketing_standards.mjs --stores DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ --all-open`
- 辅助填报 DSY 全部未截止营销活动（只预填，不点最终提交；若本期有用户确认覆盖表，必须带 `--price-overrides`）：
  `node scripts/marketing/dsy_marketing_deadline_fill.mjs --stores DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ --all-open --price-overrides outputs/reports/marketing-price-overrides-YYYY-MM-DD-approved.json --min-discount-fallback SK-13034`
- 优惠券活动不要套普通营销活动脚本/路径；例如活动 `34810` 应从优惠券详情 `#/mbrs/marketing/coupon/detail/34810` 进入 `继续报名`，批量导入确认会直接真实提报。配套 15% 券执行必须带目标计划并让脚本读取 paired `price-overrides`（显式 `--price-overrides` 或从 selection plan 自动推断），只有 `couponFactor≈0.85` / 明确“仅15%券”的 SKC 会进入券计划；`couponFactor=1`、`不叠券/券都禁止`、缺覆盖价或口径冲突一律 fail closed；提交器还会读取最新 `marketing-stack-review` 和旧普通活动填报价，若活动扫描过期/不可用，或目标 SKC 有旧普通/度假季标签但缺旧活动价证据，会停止提交并要求系统先只读取证。例如 `node scripts/marketing/submit_coupon_activity_goods.mjs --stores DL,DX,FY --target-plan tmp/marketing-signup/coupon-submit-results/coupon-extra-vs-ordinary-plan-2026-06-03.json --price-overrides tmp/marketing-signup/price-overrides-2026-06-03-ALL-ready.json`；只读复扫用 `node scripts/marketing/export_marketing_stack_review.mjs --coupon-target-plan tmp/marketing-signup/coupon-submit-results/coupon-extra-vs-ordinary-plan-2026-06-03.json --coupon-price-overrides tmp/marketing-signup/price-overrides-2026-06-03-ALL-ready.json --cloud-bi-ssh shein-bi-tencent --cloud-bi-root /opt/shein-bi/app`。复扫/重建报告必须区分 `activityScanCreatedAt` 和 `rebuiltAt`，不得用重建时间伪装活动扫描新鲜。
- 新一期活动报名前必须先生成叠加安全审核文档，合并普通营销活动、优惠券、限时折扣、原始/当前价格、商品成本、仓储费摊销和含仓储费利润率；用户确认备注前不得报名或批量取消/重报限时折扣。
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
- 营销折扣自动化路线图：`docs/marketing-automation-roadmap.md`
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
