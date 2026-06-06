# SHEIN 营销折扣自动化路线图

> 当前状态：2026-06-06。本文只沉淀系统规则、动作边界和后续实现顺序；不写 SHEIN session、BI Basic Auth、OpenAPI 密钥或 `.local` 运行态。

## 1. 核心不变量

营销活动、限时折扣、优惠券和订单成交价必须作为同一个价格栈管理。系统目标不是“看起来都报了活动”，而是每个 `店铺 + SKC + 时间窗口` 的最终成交价尽量等于本期目标价，且不得低于利润/底价红线。

- 普通营销活动：主价格层，平台会给流量扶持；符合策略且在报名窗口内必须优先报名。报名窗口和生效窗口分开，平台最低降幅按活动页/API 动态读取（常见 `10%`，也可能 `5%` 或 `VIP档`），`VIP档` 即使压低到目标价以下也必须按平台要求报名并标风险。
- `15%` 优惠券：配套层，只允许 `price-overrides` / 共享 classifier 明确 `allowed15` 的 SKC 报名。
- 限时折扣：兜底层，必须存在可解释状态；可以取消、修改、重建，但不能干扰目标成交价。
- `30%/50%` 优惠券：当前只允许研究和生成测算，不允许真实上线。

任何真实提交、取消、改价、补预算动作都必须遵循：

1. `dry-run` 生成候选和价格证据；
2. 店铺身份校验通过；
3. 真实执行必须有当前规则授权；
4. 执行后 live 回读已报集合 / 活动价 / 预算 / 订单证据；
5. 不能把“页面弹窗成功”“导入成功”“商品提交成功”当最终证据。

## 2. 价格栈判定规则

对每个 `店铺 + SKC + 时间窗口`：

```text
最低促销基准价 = min(当前售价, 普通营销活动价..., 限时折扣价...)
叠加后最终成交价 = 最低促销基准价 × couponFactor
```

判定只看价格证据，不看标签直觉：

- `叠加后最终成交价 < finalTargetPrice - 1 SAR`：低于目标价，是亏损/低价风险；先取消或调高最低且可控的活动层，必要时临时下架止损。
- `叠加后最终成交价 ≈ finalTargetPrice`：组合正确，应该保留或补回对应活动层。
- `叠加后最终成交价 > finalTargetPrice + 1 SAR`：价格偏高，不应取消券；应检查普通营销活动是否漏报，或用限时折扣兜底到目标基准价。
- 缺 `finalTargetPrice`、缺当前基准价、缺 coupon 档证据、限时折扣分页未读完、店铺身份不确定：全部 fail closed，不自动提交/取消。

## 3. 当前定时复扫

已存在 Codex heartbeat 自动任务 `shein`：

- 名称：`SHEIN 营销价格栈每日巡检`
- 计划：每日 `09:30` 左右触发；`2026-06-09` 起额外复扫预计 `2026-06-08` 结束的度假季/旧低价活动后是否可以补券。
- 边界：先运行只读 `build_marketing_daily_guard_report.mjs`；只读扫描和生成 `15%` 券补券 dry-run 清单；不真实提交；继续禁止 `30%/50%` 券真实上线。
- 口径：活动标签只做候选信号，真实决策必须先按时间窗口合并普通营销活动价、限时折扣价、当前售价等证据，计算 `最低有效基准价 × couponFactor` 与 `finalTargetPrice`；单独的 `限时折扣价 × couponFactor` 只能作为“限时折扣兜底层”候选，不能代表最终成交价。

自动任务模式的硬边界：

- 只能产出观察报告、dry-run 清单、阻塞原因和下一次复扫安排。
- 若调用 `scripts/marketing/submit_coupon_activity_goods.mjs`，必须带 `--dry-run` 或 `--no-submit`。
- 禁止在 heartbeat 中向任何写入型脚本传 `--execute`，包括优惠券取消、券预算补额度、结束限时折扣、创建/修改限时折扣。
- 标签仍存在时不能机械阻塞：低于目标价或缺价格证据才阻塞；命中目标可进补券 dry-run；若只有限时折扣兜底层高于目标，只能生成“先确认普通营销活动覆盖；未覆盖时再调限时折扣兜底”的建议，不能直接判定最终价偏高。
- 旧普通活动填报价也属于价格栈真相源。每日 guard 的 `knownOrdinaryActivityGuard` 会读取仍在生效窗口内的旧普通活动填报价；若 `旧普通活动价 × couponFactor < finalTargetPrice - 1 SAR`，或有旧普通活动标签但缺填报价证据，必须阻止 no-action。
- 当 `knownOrdinaryActivityGuard` 非零时，自动任务应继续运行 `scripts/marketing/build_known_ordinary_coupon_risk_plan.mjs --date YYYY-MM-DD`，生成 `known-ordinary-coupon-risk-plan-YYYY-MM-DD.{json,csv,md}` 全量清单；Markdown 必须先给中文结论、按店铺汇总和明确动作，CSV 只作为脚本筛选输入。若问题是缺实际填报价，系统下一步是自动只读查价，不是把“缺证据”交给用户；只有登录、身份或平台接口阻塞才需要用户介入。清单只用于 live 复核和用户授权后的取消券/临时下架/补回，不是可执行取消指令。
- 真实提交、取消、补预算、调限时折扣必须回到当前人工授权轮次执行，并在执行后 live 回读。

### 3.1 日报输出必须先给人看懂

每日 guard 的 Markdown 是运营日报，不是调试日志。默认给用户看的 `marketing-daily-guard-YYYY-MM-DD.md` 必须按以下顺序输出：

1. **先看结论**：一句话说明“今天要不要动作”，以及能不能自动执行。
2. **需要做什么**：只列明确动作，例如“取消某类 15% 券”“补预算”“补价格证据”；没有动作就直接写“现在不用做止损动作”。
3. **需要留意**：只放观察项，例如未到补券复扫窗口、数据源不是最新、限时折扣兜底层偏高线索。
4. **已确认安全/已处理**：说明已取消止损、无未处理低价、无待系统取证等状态。
5. **今日关键状态**：只保留少量业务数字，不展开 SKC 大表。
6. **证据文件**：指向完整 JSON、post-cancel verification、BI 数据源等。

机器字段、脚本命令、完整明细和英文/代码字段保留在 JSON，不默认铺到 Markdown 里。用户问“今天结论是什么”时，优先复述 `humanSummary.conclusion`、`humanSummary.actions` 和 `humanSummary.watches`，不要把 `belowTargetCount/sourceStatus/selectedPath` 这类字段名直接丢给用户。

未来要放开自动执行时，必须满足：

- `humanSummary.actions=[]` 且 `blockers=[]` 时，才允许进入低风险 dry-run 或候选队列。
- 真实写入动作必须是单一、确定、可回读的动作；例如“取消已确认低于目标价的 15% 券”或“把已授权券预算补到 1000 SAR”。
- 每个自动执行动作必须有明确输入清单、店铺身份校验、价格栈证据、执行后 live 回读和可审计文件。
- 任何缺目标价、缺普通活动价、缺券档证据、登录身份不确定、或数据源过期到影响判断的情况，都不能自动执行。

## 4. 自动化机制拆分

| 机制 | 触发条件 | 数据源 | 默认动作 | 自动执行边界 | 验证证据 |
| --- | --- | --- | --- | --- | --- |
| 度假季/旧低价活动结束后补券 | 活动预计结束后、或标签/已报集合变化 | live 优惠券已报集合、限时折扣 live 列表、旧普通活动观察扫描、`price-overrides` | 生成可补 `15%` 券清单和 dry-run | 不真实提交；除非用户在当轮明确授权 | `allowed15 active == plan`、禁止/未知 active 为 `0`、价格栈不低于目标 |
| 新链接自动纳入价格体系 | 链接/业务域日更发现新上架 SKC | `outputs/shein_links`、BI `storeLinks`、商品成本、仓储费、曝光排名 | 生成“新链接待定价/待报限时折扣/待报券”动作卡 | 初期只提醒和 dry-run；真实报限时折扣/券需有成本、目标价、库存和用户授权 | 新链接动作卡、价格测算、live 已报/未报集合 |
| 优惠券余额补额度 | 活动预算不足、额度用完、提交前预算低于阈值 | 优惠券活动站点预算接口 + execute 回读结果 | 将本期 `shein-sa` 周预算补到 `1000 SAR` | 当前只对已授权的配套 `15%` 券活动可执行；自动任务只报告，不真实补预算 | execute 后 `after.usageSite`/`after.budgetInfoSite` 优先回读为 `1000 SAR`；写入异常但回读达标只做提醒 |
| 低价/高价成交查因 | 销售同步发现订单商品行 `currencyPrice` 偏离目标 | 订单商品行 `currencyPrice`、活动窗口、price-overrides、优惠券/限时折扣/普通活动 live 状态 | 输出根因分类和补救建议 | 不能用页面商品总价、预计收入汇总或预聚合销售额判断；未传活动窗口只作为线索 | `audit_order_prices_against_plan.mjs` 结果、订单行金额、活动来源 |
| 可报活动提前三天提醒 | 活动报名截止时间进入 `T-3` | 营销活动列表全量分页、店铺身份 | 生成待报活动清单、缺成本/缺覆盖价/缺仓储费阻塞 | 不自动报名；用户确认备注和覆盖价后再执行 | 活动 ID、报名截止、可报商品数、阻塞原因 |
| `30%/50%` 券研究 | 用户要求研究且普通活动可报 | 普通活动计划、券档、成本、目标价、平台最低折扣、旧普通活动/限时折扣价 | 运行 `build_high_coupon_research_candidates.mjs` 只输出测算：哪些 SKC 理论可用更高券 | 禁止真实上线；不得生成提交命令；必须保证平台折扣满足、最终价不低于底价且无更低旧活动打穿 | 研究表、利润红线、平台最低降幅、旧活动证据 |
| 三层价格栈日常巡检 | 每日销售/链接/业务域刷新后 | BI 数据、live 活动集合、订单审计 | 风险日报：低于目标、偏高、待系统取证、预算不足、登录阻塞 | 自动只读；缺价/待取证先自动查，真实修复走单独 dry-run/execute/rescan | 风险计数、店铺/SKC/货号、补救状态 |
| 云端运营系统协同 | BI 自动运营驾驶舱上线后 | PostgreSQL、BI Portal API、任务状态表 | 给同事分配店铺、展示动作卡、记录处理状态 | 同事只能处理被分配店铺；真实提交前需要权限和二次确认 | 操作审计、负责人、状态、执行日志 |

### 4.1 新链接动作卡落地边界

`scripts/marketing/build_marketing_daily_guard_report.mjs` 已把“新链接自动纳入价格体系”的第一阶段落到只读日报里，字段为 `newSkcCandidates`。本地 Codex 的每日 heartbeat 默认用 `--cloud-bi-ssh shein-bi-tencent --cloud-bi-root /opt/shein-bi/app` 只读读取云端权威 `outputs/bi-portal/data.json`；不写回本地 `outputs/`，只在报告里记录 `biPortalSourceSelection`。它的口径故意保守：

- 精确匹配只能用 `storeKey + skc`。`standard_goods_sn` 只用于展示和提示“同店同标准货号已有计划”，不能证明新 SKC 已经有价格计划，也不能自动继承老 SKC 的活动价、券策略或底价。
- BI `outputs/bi-portal/data.json` 过期时，候选只能标为 `stale_observation_only`，不得形成“无新增链接”的 no-action 结论。
- 云端 BI 读取失败时，日报必须记录 `cloud_bi_fetch_failed`；若本地也缺失或过期，继续阻止 no-action，不能把云端不可达静默解释成无新链接。
- `price-overrides`、selection plan、`config/stores.json` 缺失或解析失败时 fail closed：日报进入 blocker / unknownSources，不能说没有新链接。
- 30 天内已上架且缺精确价格计划的 SKC 才进入动作卡；老于 30 天的缺计划链接只计入 `missingExactPlanOnShelf` 背景数，避免日报被历史遗留淹没。
- 若 `shelf_age_days` 缺失，日报先用 `link_date` 按报告日期兜底推算；仍无法判断年龄的 SKC 进入 `unknown_shelf_age_needs_review`，并阻止 no-action。
- 已禁报券、`couponFactor=1`、缺 `finalTargetPrice`、已在 `excluded` 的 SKC，只能给“待定价/待确认”动作，不得生成 `15%` 券 dry-run 建议。
- unknown store / disabled store / 缺店铺或 SKC 的行只进 ignored/source warning，不能作为可执行候选。

因此每日新链接卡的动作含义是：

1. `known_excluded_needs_pricing`：计划里已明确 excluded，多数是缺目标价；先补成本/仓储/底价，不报券。
2. `same_standard_goods_sn_needs_confirmation`：同店同标准货号已有别的 SKC 计划，但当前 SKC 缺精确计划；人工确认同款、同成本和同底价后，才可复制策略。
3. `unplanned_new_on_shelf_skc_needs_pricing`：新上架 SKC 完全没有计划；先进入待定价，再决定普通活动、限时折扣兜底和 15% 券。
4. `unknown_shelf_age_needs_review`：缺上架天数和可用 `link_date`，不能判断是否新链接；先刷新链接/BI 快照，不报券。

### 4.2 营销叠加审核的新鲜度拆分

`marketingStackReview` 同时承担两类证据，必须拆开判断：

- 活动扫描证据：来自 SHEIN 营销后台只读扫描，字段为 `activityScanCreatedAt/activityScanFinishedAt`（旧报告兼容 `createdAt`）。T-3 活动提醒、普通活动候选覆盖、店铺覆盖完整性都看这一层。`rebuild_marketing_stack_review_from_store_audits.mjs` 只能重组已有 store audit，`rebuiltAt` 不能替代活动扫描时间。
- BI 标签上下文：来自 BI `storeLinks/links` 的活动标签、限时折扣标签、新链接和链接日期，字段为 `source.biGeneratedAt / biDataPath / biDataTransport / biFallbackUsed`。优先用 `--cloud-bi-ssh shein-bi-tencent --cloud-bi-root /opt/shein-bi/app` 只读读取云端权威快照；云端失败只有本地快照新鲜时才 fallback。

日报 `build_marketing_daily_guard_report.mjs` 必须同时验证：

- `marketingStackReview` 活动扫描未超过 48 小时；
- BI context 未超过日报阈值；
- `selectedStores=19` 且 `missingStores=[]`。若有店铺缺失，即使 BI context 新鲜，也不能形成完整 no-action。

### 4.3 优惠券预算守卫

每日 guard 的 `couponBudget` 只认真实 `execute` 结果里的预算回读作为“已补到位”证据；`dry-run` 只能说明曾经观察到页面预算或可生成补额度建议，不能冒充真实完成。

预算证据优先级固定为：

1. `after.usageSite.coupon_usage_upper_limit`
2. `after.budgetInfoSite.coupon_usage_upper_limit`
3. `before.usageSite.coupon_usage_upper_limit`
4. `before.budgetInfoSite.coupon_usage_upper_limit`

因此如果 `after` 低于 `1000 SAR`，不能被 `before=1000` 掩盖；如果 `after` 缺失但 `before=1000`，可以标为回读达标但证据来源必须写清楚。预算低于 `1000 SAR` 或启用店铺缺 execute 回读证据时 fail closed，日报输出 `coupon_budget_below_target` / `coupon_budget_missing_evidence` blocker。类似 CX 这种写入返回 `1017`，但 before/after 回读均为 `1000 SAR` 的样本，不阻塞报名，只进入 `coupon_budget_write_failed_but_at_target` 上下文提醒，保留异常证据供后续排查。

## 5. 低价/高价成交查因模型

订单收入真相源只认订单商品行：

- `goodsRows[].currencyPrice`
- `groupList[].goodsList[].currencyPrice`

不得用：

- 页面 `商品总价`
- 页面 `预计收入汇总金额`
- `summary.salesSar`
- 日汇总 / 月汇总预聚合金额

低价成交告警必须先判断订单时间是否落在本期活动窗口内。若订单早于活动开始或晚于活动结束，只能标为“窗口外偏离线索”，不能直接判定本次活动漏报。

根因分类建议：

1. 旧限时折扣形成最低促销基准价；
2. 旧普通营销活动形成最低促销基准价；
3. 优惠券 active 但不在 `allowed15` 计划；
4. 本应有普通营销活动/限时折扣/优惠券但漏报，导致成交价高于目标；
5. 店铺身份/profile/session 错配导致数据归属错误；
6. 成本、仓储费或目标价缺失，无法判断。

## 6. `30%/50%` 券研究前置条件

研究更高券档时，必须同时满足：

- 普通营销活动已经可报或已报，且满足平台最低折扣标准；
- `finalTargetPrice` 明确，且按 `couponFactor=0.70/0.50` 反推出的普通活动基准价不违反平台规则；
- 最终价不低于 `15%` 含仓储费利润底线；普通新品/正常品原则上仍不低于 `20%`；
- 没有更低旧普通活动或限时折扣会成为最低价；
- 券预算、券档 ID、店铺身份和已报集合可 live 回读；
- 用户明确确认允许研究，不等于允许真实上线。

当前落地入口是 `scripts/marketing/build_high_coupon_research_candidates.mjs --date YYYY-MM-DD`。该脚本只输出 `outputs/reports/marketing-high-coupon-research-YYYY-MM-DD.{json,csv,md}`，不进入 `suggestedDryRunCommands`，也不允许 `submit_coupon_activity_goods.mjs --discount-max 30/50` 自动执行。

## 7. BI 自动运营系统规划

云端 BI 可以逐步从“看数据”升级为“运营动作系统”，但执行边界要分层：

1. **建议层**：BI 只读生成动作卡，例如“新链接待定价”“券预算不足”“某订单低于目标价”。
2. **预填层**：Codex / 后台执行器根据动作卡生成 dry-run、Excel 模板或后台预填，不提交。
3. **确认层**：用户或被授权同事在 BI 页面确认动作、负责人、备注和生效窗口。
4. **执行层**：受控执行器检查店铺权限、价格栈证据、预算和登录态后执行。
5. **审计层**：执行日志、输入计划、live 回读证据、异常和回滚动作写入 PostgreSQL。

本地 Codex 的角色应定位为高权限执行和研发代理：负责修脚本、处理复杂异常、发布 release 和做跨系统分析。云端 BI 则负责日常任务分发、权限控制、同事操作入口和审计留痕。后续给同事分店管理时，应按店铺维度限制可见动作和执行权限；未授权店铺只能看汇总，不允许提交/取消/改价。

## 8. 下一步实现优先级

1. 将现有只读扫描结果统一成“价格栈风险日报”：低于目标、偏高、待系统取证、预算不足、登录阻塞分开计数；“待系统取证”必须自动继续查，不能作为交给用户的最终结论。
2. 把 `audit_order_prices_against_plan.mjs` 接到销售同步后置只读告警，先只报告不自动修。
3. 把优惠券预算补 `1000 SAR` 的真实 execute 操作接入人工授权动作池；当前日报已能结构化识别预算低于目标、缺回读证据、写入异常但回读达标。
4. 把营销活动 `T-3` 提醒接入活动列表扫描和 BI 动作池。
5. 新链接先进入“待定价/待报兜底限时折扣”队列，真实自动报名等价格栈稳定后再逐步放开。
6. `30%/50%` 券只做研究表，不进入执行器默认路径。
