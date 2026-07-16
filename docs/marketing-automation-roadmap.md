# SHEIN 营销折扣自动化路线图

> 当前状态：2026-06-28。本文只沉淀系统规则、动作边界和后续实现顺序；不写 SHEIN session、BI 登录密码、OpenAPI 密钥或 `.local` 运行态。

## 1. 核心不变量

营销活动、限时折扣、优惠券和订单成交价必须作为同一个价格栈管理。系统目标不是“看起来都报了活动”，而是每个 `店铺 + SKC + 时间窗口` 的最终成交价尽量等于本期目标价，且不得低于利润/底价红线。

- 普通营销活动：主价格层，平台会给流量扶持；符合策略且在报名窗口内必须报名，且优先级最高。报名窗口和生效窗口分开，平台最低降幅按活动页/API 动态读取（常见 `10%`，也可能 `5%` 或 `VIP档`），`VIP档` 即使压低到目标价以下也必须按平台要求报名并标风险。
- `15%` 优惠券：可选流量层，不再作为保底成交价层；只允许当前计划明确标记为“高曝光支持 / 全店高库存滞销引流 / 清货试验”的 SKC 报名。
- 限时折扣：兜底层，也必须报；可以取消、修改、重建，但不能替代普通营销活动，也不能干扰目标成交价。
- 兜底限时折扣默认活动库存固定为 `10`，活动生效窗口固定为 `7` 天；只有用户当次明确指定其他库存或时长时才覆盖默认值。执行器不得默认把商品全部可用库存带入活动库存。
- `30%/50%` 优惠券：当前只允许研究和生成测算，不允许真实上线。

任何真实提交、取消、改价、补预算动作都必须遵循：

1. `dry-run` 生成候选和价格证据；
2. 店铺身份校验通过；
3. 真实执行必须有当前规则授权；
4. 执行后 live 回读已报集合 / 活动价 / 预算 / 订单证据；
5. 不能把“页面弹窗成功”“导入成功”“商品提交成功”当最终证据。

### 1.1 2026-06-21 三层优先级

1. **普通营销活动必报，优先级最高。** 符合当前策略且报名窗口未结束的商品，必须优先进入普通营销活动；限时折扣、当前售价或优惠券都不能替代普通活动报名。
2. **限时折扣也必报，但只做兜底。** 没有普通活动时直接兜到目标价；有普通活动时默认按当前售价 `15%` 折扣，若折后低于目标价/底价/利润线，则缩浅折扣或兜到目标价。已有限时折扣不代表普通活动不漏报。
3. **优惠券只做小批量实验。** 只允许明确批准的高曝光支持、滞销高库存引流或清货试验；不能作为保底价，不能干扰普通活动和限时折扣，触券下探低于目标/安全线时要取消或排除。
4. **巡检顺序固定。** 先查普通活动漏报/待报，再查限时折扣缺口/错价，最后查优惠券实验冲突；三层分别验收，不能互相抵消。
5. **结构覆盖和价格覆盖分开验收。** 限时折扣兜住目标价不代表普通营销活动已报；普通营销活动已报也不代表限时折扣兜底已报。
6. **优惠券冲突时券让路。** 若实验券触发后会低于目标价或安全线，取消/排除券，不能为了保留券而削弱普通活动或限时折扣。
7. **新上架 7 天内优先保护。** 所有上架 `7` 天内、尚未报过普通营销活动的在售链接，巡检发现后必须按“全局曝光前五”力度自动报一周限时折扣；已有限时折扣但不是一周窗口或不是前五力度时，若旧活动只含目标 SKC，dry-run 安全后结束旧活动并重建。首次报 New Arrivals / 新品 / 超级新品类普通活动时，也按前五力度定价，并在方案里单独标注，不能伪装成真实曝光 Top5。

## 2. 价格栈判定规则

对每个 `店铺 + SKC + 时间窗口`：

```text
最低促销基准价 = min(当前售价, 普通营销活动价..., 限时折扣价...)
保底成交价 = 最低促销基准价（不假设优惠券触发）
风险下探价 = 最低促销基准价 × couponFactor（只用于“若券触发是否低于底价/目标”的风险测算）
```

判定只看价格证据，不看标签直觉：

- `保底成交价 < finalTargetPrice - 1 SAR`：低于目标价，是亏损/低价风险；先取消或调高最低且可控的活动层，必要时临时下架止损。
- `保底成交价 ≈ finalTargetPrice`：保底层命中目标，普通活动/限时折扣本身可以保障成交价。
- `保底成交价 > finalTargetPrice + 1 SAR`：价格偏高；应检查普通营销活动是否漏报，或用限时折扣兜底到目标基准价，不能靠优惠券“假定触发”来补价。
- `风险下探价 < 底价/利润线`：即使保底价达标，也说明券一旦触发会打穿底线；该 SKC 不允许进入 15% 流量券，除非用户单独确认清货亏本试验。
- 缺 `finalTargetPrice`、缺当前基准价、缺 coupon 档证据、限时折扣分页未读完、店铺身份不确定：全部 fail closed，不自动提交/取消。

`finalTargetPrice` 必须来自当前有效策略，而不是历史默认值。若本期用户已经在审核表中确认某个货号按 `15%` 利润率、固定最终成交价或特殊券/活动组合执行，并且该确认已转换为当前 `selection-plan + price-overrides`，日报应将其视为 `expected`；不能再按旧 `30%` 默认利润率、旧 `ALL-ready` 覆盖文件或没有生效窗口的历史计划每天重复报警。若日报只能读到旧计划或同一 `storeKey + skc` 有冲突目标价，应报告“计划过期/冲突，需要刷新”，而不是直接把已批准的低利润策略判为错误。

当前计划选择必须优先使用用户确认并已真实执行或等待执行的最终全量 `selection-plan + price-overrides`。这类最终文件应带 `baselineForNextOrdinaryActivity=true` 和 `baselineForLimitedDiscountFallback=true`，即使文件名包含 `all-safe` 也不得被当作旧安全子集丢弃；没有这些标记的演示、单店、repair、supplement 或旧 `ALL-ready` 文件只能作为证据线索，不能作为日报和限时折扣兜底基准。

## 3. 当前定时复扫

已存在 Codex heartbeat 自动任务 `shein-daily`：

- 名称：`SHEIN 营销价格栈每日巡检`
- 计划：Codex heartbeat 在本会话继续报告；云端生产 timer 为 `shein-bi-cloud-marketing-live-guard.timer`，每日北京时间 `10:30` 触发。旧 `10:12` 只属于迁移前 heartbeat 口径，不再作为云端生产排班。
- 防撞车：全量 live scan 不是“看到空闲就硬跑”。开跑前必须检查核心服务 active；同时避开固定资源窗口：browser cleanup 每小时 `:10/:40`、ET forwarder 奇数小时 `:20`、销售刷新偶数整点、晨间链路/日更、登录态管家、备份、订单闭环和 watchdog。若距离下一个固定窗口不足约 `6` 分钟，跳过全量 live scan，报告等待下个空档；临时补跑只允许选择能覆盖完整扫描窗口的空档，不能让全量扫描跨进 ET `:20` 或 cleanup `:10/:40`。
- 边界：先检查云端核心任务是否正在运行，再运行 `build_marketing_daily_guard_report.mjs` 和后台 live scan/readback；生成风险报告和候选动作卡。普通活动、优惠券、补预算仍不得自动真实提交/取消；限时折扣价格漂移、新链接/新上架 7 天/漏限时折扣兜底是已授权自动写入例外，必须通过身份校验、价格栈校验、库存/平台规则、dry-run 和执行后回读；继续禁止 `30%/50%` 券真实上线。
- 限时折扣漂移自动修复：guard 报告中 `limitedDiscountTargetPriceDrift.belowRows` 非空时，自动执行 `guard_limited_discount_drift.mjs` → `batch_fix_limited_discount_drift.mjs`，逐店删除漂移 SKC 并新建限时折扣；平台阻断 SKC 自动剔除后对可执行子集新建。
- 旧 `shein` automation（目标线程 `019dfc8b-7bb1-7ff1-a66d-b10ae67053fa`）和旧 `dl` automation 已停用。
- 口径：活动标签只做候选信号，真实决策必须先按时间窗口合并普通营销活动价、限时折扣价、当前售价等证据，比较“不含券的保底成交价”与 `finalTargetPrice`；`couponFactor` 只用于触券下探风险，不再用于证明目标成交价必然达成。

自动任务模式的硬边界：

- 本地 Codex heartbeat 只负责汇报、观察报告、dry-run 清单和阻塞原因；云端 10:30 timer 负责完整 live scan，并可执行负责人长期策略授权内的限时折扣动作。
- 复核频率按风险分层。云端 timer 每日做一次 19 店完整基线；动作后只复扫受影响店并与成功基线合并（shell 尚未接入定点合并前，保留最终全量复扫）。本地临时补扫按候选店铺最小集合和 3–5 店小批次执行，跑完关闭。
- `source stale` 只表示证据需要刷新，不等于可以自动全店 live scan；如果没有低价止损、补券窗口或用户授权，日报只能报告“需补证据/等待窗口”，不得用全量前端扫描替代判断。
- 若调用 `scripts/marketing/submit_coupon_activity_goods.mjs`，必须带 `--dry-run` 或 `--no-submit`。
- 默认禁止本地 heartbeat 向写入型脚本传 `--execute`。云端 timer 的长期授权例外包括限时折扣价格漂移修复、登记中的人工特殊折扣恢复，以及新链接/新上架 7 天/重新上架无活动/漏限时折扣兜底；它们不逐次索要 payload hash，但必须匹配授权 ID/上下文、身份、价格栈、库存/平台校验、dry-run 和执行后 live 回读。优惠券取消、补预算、普通活动报名和无证据写入仍不得自动执行。
- 真实提交、回读、限时折扣补报或用户手动接管后，都必须把本批店铺浏览器关掉；全店批量任务结束后做一次全店 close 和 debug port 检查，确认没有店铺 profile 残留，不能把浏览器清理完全寄托给定时 cleanup。
- 标签仍存在时不能机械阻塞：不含券保底价低于目标价或缺价格证据才阻塞；保底价命中目标才算价格保障正确。优惠券只能作为流量试验候选，不能用于把偏高保底价“算成达标”。
- 日报必须先校验目标计划是否是当前批次：计划文件过期、缺活动生效窗口、缺 `couponFactor/combo`、同一 `storeKey + skc` 目标冲突时，只能报告“计划证据需要刷新/清理”。已经在当前计划里批准的 `15%` 利润率或低价清货策略不是 blocker；实际成交价低于这版计划目标才是 blocker。
- 旧普通活动填报价也属于价格栈真相源。每日 guard 的 `knownOrdinaryActivityGuard` 会读取仍在生效窗口内的旧普通活动填报价；若旧普通活动价本身低于 `finalTargetPrice - 1 SAR`，或触券下探会低于底价/利润线，或有旧普通活动标签但缺填报价证据，必须阻止 no-action。真实 `submit_coupon_activity_goods.mjs` 写路径也必须使用同一守卫：活动扫描过期/不可用、旧活动价证据目录缺失/解析失败，或目标 SKC 有旧普通/度假季标签但缺旧活动价，直接停止提交。
- 当 `knownOrdinaryActivityGuard` 非零时，自动任务应继续运行 `scripts/marketing/build_known_ordinary_coupon_risk_plan.mjs --date YYYY-MM-DD`，生成 `known-ordinary-coupon-risk-plan-YYYY-MM-DD.{json,csv,md}` 全量清单；Markdown 必须先给中文结论、按店铺汇总和明确动作，CSV 只作为脚本筛选输入。若问题是缺实际填报价，系统下一步是自动只读查价，不是把“缺证据”交给用户；只有登录、身份或平台接口阻塞才需要用户介入。清单只用于 live 复核和用户授权后的取消券/临时下架/补回，不是可执行取消指令。
- 普通活动、优惠券、补预算及超出长期策略的写入必须回到当前人工授权轮次执行；长期授权内的限时折扣动作由 timer 自动执行，两类路径都必须在执行后 live 回读。

### 3.1 日报输出必须先给人看懂

每日 guard 的 Markdown 是运营日报，不是调试日志。默认给用户看的 `marketing-daily-guard-YYYY-MM-DD.md` 必须按以下顺序输出：

1. **先看结论**：一句话说明“今天要不要动作”，以及能不能自动执行。
2. **需要做什么**：只列明确动作，例如“取消某类 15% 券”“补预算”“补价格证据”；没有动作就直接写“现在不用做止损动作”。
3. **需要留意**：只放观察项，例如未到补券复扫窗口、数据源不是最新、限时折扣兜底层偏高线索。
4. **已确认安全/已处理**：说明已取消止损、无未处理低价、无待系统取证等状态。
5. **今日关键状态**：只保留少量业务数字，不展开 SKC 大表。
6. **证据文件**：指向完整 JSON、post-cancel verification、BI 数据源等。

机器字段、脚本命令、完整明细和英文/代码字段保留在 JSON，不默认铺到 Markdown 里。用户问“今天结论是什么”时，优先复述 `humanSummary.conclusion`、`humanSummary.actions` 和 `humanSummary.watches`，不要把 `belowTargetCount/sourceStatus/selectedPath` 这类字段名直接丢给用户。

当前已放开的 timer 自动执行必须满足：

- 对应动作集合必须非空且 `blockers=[]`，才允许从 dry-run 进入执行；无动作时只生成报告。
- 真实写入动作必须是单一、确定、可回读且属于长期授权白名单的限时折扣动作；优惠券取消、补预算和普通活动报名不在此列。
- 每个自动执行动作必须有明确输入清单、店铺身份校验、价格栈证据、执行后 live 回读和可审计文件。
- 任何缺目标价、缺普通活动价、缺券档证据、登录身份不确定、或数据源过期到影响判断的情况，都不能自动执行。

## 4. 自动化机制拆分

| 机制 | 触发条件 | 数据源 | 默认动作 | 自动执行边界 | 验证证据 |
| --- | --- | --- | --- | --- | --- |
| 历史价格保障券迁移 | 发现 `couponFactor=0.85` 只是为了到目标价 | live 优惠券已报集合、普通活动价、限时折扣 live 列表、`price-overrides` | 取消价格保障券，改用普通活动价/限时折扣保底 | 真实取消/改限时折扣必须用户当轮授权并执行后回读 | active 价格保障券为 `0`；不含券保底价命中目标或有明确阻断 |
| 新链接自动纳入价格体系 | 链接/业务域日更发现新上架 SKC | `outputs/shein_links`、BI `storeLinks`、商品成本、仓储费、曝光排名 | 生成动作卡；安全限时折扣自动兜底 | 限时折扣在长期授权范围内自动 dry-run/execute/readback；普通活动和券仍需单独业务授权 | 新链接动作卡、价格测算、live 已报/未报集合 |
| 可选流量券预算 | 高曝光支持/全店高库存滞销引流方案确认后 | 优惠券活动站点预算接口、候选规模、历史券消耗 | 先给预算测算，不默认每店 `1000 SAR` | 用户确认预算后才可真实补额；自动任务只报告，不真实补预算 | execute 后预算回读达标；未授权前只保留 read-only 证据 |
| 低价/高价成交查因 | 销售同步发现订单商品行 `currencyPrice` 偏离当前有效策略目标 | 订单商品行 `currencyPrice`、活动窗口、当前批次 price-overrides、用户确认备注落盘结果、优惠券/限时折扣/普通活动 live 状态 | 输出根因分类和补救建议 | 不能用页面商品总价、预计收入汇总或预聚合销售额判断；未传活动窗口或计划过期/冲突时只作为线索，不把已批准低利润策略当异常 | `audit_order_prices_against_plan.mjs` 结果、订单行金额、活动来源、当前策略版本 |
| 可报活动提前三天提醒 | 活动报名截止时间进入 `T-3` | 营销活动列表全量分页、店铺身份 | 生成待报活动清单、缺成本/缺覆盖价/缺仓储费阻塞 | 不自动报名；用户确认备注和覆盖价后再执行 | 活动 ID、报名截止、可报商品数、阻塞原因 |
| `30%/50%` 券研究 | 用户要求研究且普通活动可报 | 普通活动计划、券档、成本、目标价、平台最低折扣、旧普通活动/限时折扣价 | 运行 `build_high_coupon_research_candidates.mjs` 只输出测算：哪些 SKC 理论可用更高券 | 禁止真实上线；不得生成提交命令；必须保证平台折扣满足、最终价不低于底价且无更低旧活动打穿 | 研究表、利润红线、平台最低降幅、旧活动证据 |
| 三层价格栈日常巡检 | 每日销售/链接/业务域刷新后 | BI 数据、live 活动集合、订单审计 | 风险日报：低于目标、偏高、待系统取证、预算不足、登录阻塞 | 默认只读；长期授权内的限时折扣修复可自动 dry-run/execute/rescan，其余写入单独授权 | 风险计数、店铺/SKC/货号、补救状态 |
| 云端运营系统协同 | BI 自动运营驾驶舱上线后 | PostgreSQL、BI Portal API、任务状态表 | 给同事分配店铺、展示动作卡、记录处理状态 | 同事只能处理被分配店铺；真实提交前需要权限和二次确认 | 操作审计、负责人、状态、执行日志 |

### 4.1 巡检频率和前端资源边界

日常巡检的目标是发现必须处理的风险，不是每天把所有前端 profile 重跑一遍。标准分层如下：

1. **每日 live 观察层**：先运行 `build_marketing_daily_guard_report.mjs --cloud-bi-ssh shein-bi-tencent --cloud-bi-root /opt/shein-bi/app` 读取经营线索，但不能以 BI 作为已报/未报最终证据；每日必须有当天或足够新鲜的 SHEIN 后台 live scan/readback，直接读取普通活动、限时折扣、优惠券集合。优先用云端可用浏览器；没有云端浏览器时，用本地店铺 profile 小批次扫描并立即关闭。
2. **定点补证层**：guard 或 live scan 出现具体店铺/SKC 的低价止损、普通活动漏报、身份异常、限时折扣兜底缺口或可选流量券候选时，只扫这些店铺/活动，不扫无关店铺。
3. **一次性验收层**：大批量真实提交完成后允许做一次全量回读，作为该批次最终验收；之后同一批次不重复全量，除非有新异常或用户要求。
4. **人工窗口处理层**：到约定处理窗口后，先用 guard / 风险计划缩小候选范围，再分批 dry-run 和执行取消券、限时折扣或普通活动补报；补完后只对影响店铺做必要回读，不把“全量前端复核”做成日常动作。

这条边界优先于“source freshness”噪音：文件过期可以阻止 no-action，但不能自动触发无差别全店开浏览器。若 live 证据缺失，系统必须小批次补扫或明确报告登录/浏览器/身份阻塞；不能只靠 BI 输出“无风险”。

### 4.1.1 新上架 7 天强制兜底规则

`2026-06-28` 起，新上架链接有独立的高优先级规则，防止“活动页还没抓到 / 普通活动来不及报 / 旧限时折扣力度不够”导致前几天裸卖：

- 判定范围：上架 `7` 天内、当前在售、尚未有普通营销活动证据的 `店铺 + SKC`。上架天数优先取 BI linksData / live 链接域的 `shelf_age_days`，缺失时可用 `link_date` 按北京时间兜底推算；无法判断年龄则 fail closed。
- 定价力度：临时按“同一标准货号全店全链接 7 天曝光 Top5”力度生成目标价；这只是新上架保护待遇，不等于它真实进入曝光 Top5，报告和 Excel 必须分开标注。
- 执行动作：没有限时折扣时，生成一周限时折扣；已有旧限时折扣但窗口/价格不符合新规则时，若旧活动只包含目标 SKC，可在 dry-run 安全后结束旧活动并重建；旧活动混有计划外 SKC、疑似人工价或归属不清时阻断。
- 普通活动衔接：这类链接首次报 New Arrivals / 新品 / 超级新品类普通营销活动时，同样按前五力度定价；后续普通活动仍然必报，限时折扣只负责兜底。
- 当前只允许通过 `scripts/marketing/build_new_listing_limited_discount_plan.mjs` 生成计划，再由限时折扣执行器 dry-run / execute / readback；不得用 BI 标签直接断言已覆盖。
- 目标价证据：先查精确 `storeKey + SKC`，再回退到同标准货号最低批准价。
- live scan 已覆盖的新上架/高曝光限时折扣不重复报名；目标价证据缺失但 live scan 按名称已覆盖的也不重复报名，但仍标记为证据缺口。

### 4.1.2 重新上架且无生效营销活动的 Top5 兜底规则

2026-07-12 补充防漏约束：生产 `linksData` 必须同时兼容 `data.links` 和 `data.storeLinks`，按 `storeKey + SKC` 去重；标准化后为 0 条时必须失败，不得输出“无待办”。BI 中的历史/计划 `marketing_coupon_factor` 不得当成当前活动证据；已明确标记 `marketing_limited_discount_is_current=false` 的历史限时折扣价不得触发“替换旧活动”。未来普通活动不能替代当前兜底，但系统自己刚创建、活动名命中新上架/重新上架兜底规则的 `future_limited_discount_live_scan` 必须视为已覆盖，防止生效延迟窗口重复创建。任一店铺出现平台/库存/混合旧活动阻断时，批处理必须返回非零并让定时任务告警，不得仅因“无异常抛错”而输出 `ok=true`。

`2026-07-11` 起，旧链接不能再因为原始上架年龄超过 7 天而漏掉限时折扣。系统读取最近 `60` 天 `outputs/shein_links/<STORE>/YYYY-MM-DD.json` 的链接状态历史，并按以下三层证据同时判断：

- 历史状态：同一 `storeKey + SKC` 曾明确为 `SOLD_OUT / 已售罄` 或 `OUT_SHELF / 已下架`，后续快照恢复为 `ON_SHELF / 已上架`。
- 当前商品源与 BI：最新链接快照 `hasActivity=false`，当前 linksData 没有“营销中/活动中/生效中”信号。单独的“即将开始/待生效”不是当前生效证据。
- 后台 live：当天完整营销 live scan 没有该 `storeKey + SKC` 的当前生效营销价格行。未来普通活动、优惠券或无法识别归属的 `future_*` 证据不能替代当前兜底；但系统刚创建且名称命中新上架/重新上架兜底规则、价格不低于当前目标、窗口有效的 `future_limited_discount_live_scan` 视为已排期待生效覆盖，防止平台生效延迟期间重复创建。live scan 缺失/partial 时不得自动写。

同时满足以上条件的链接按“全局标准货号曝光 Top5 / 新链接”力度报一周限时折扣，不沿用原始 `shelf_age_days` 判断。目标价先取精确 `storeKey + SKC`，再取最新最终版中同标准货号的已批准 Top5/最低安全目标价；两者都没有时，只要 `marketing-cost-map` 存在商品成本，就按默认 `30%` 基础利润率的 Top5 待遇（下调 `5` 个点、不低于 `15%` 底线）自动推导目标价。当前该成本兜底按 `product_cost_excluding_storage` 筛选；仓储费缺失必须留痕，但不得把已有商品成本误报为无成本。只有商品成本/底价也缺失，或平台/身份/库存校验阻断时才 fail closed。该候选继续复用 `newSkcCandidates.newListingWithin7DaysLimitedDiscount` 和 `build_new_listing_limited_discount_plan.mjs` 的 dry-run / execute / readback 链路，并在行上标记 `treatmentType=relisted_without_active_marketing`、`lastInactiveDate`、`relistedAt`，避免伪装成真正的新上架 7 天链接。

### 4.1.3 限时折扣必报巡检规则

`2026-06-21` 起，限时折扣不是“没有营销活动才用”的兜底选项，而是所有在售运营链接都要有的基础价格层：

- 没有当前或即将生效普通营销活动的链接：限时折扣必须直接兜到当前有效计划 `finalTargetPrice`。
- 已有当前或即将生效普通营销活动的链接：仍必须有一层限时折扣，默认按当前售价 `15%` 折扣。
- 若默认 `15%` 折后价低于 `finalTargetPrice` 或底价/利润安全线，限时折扣比例必须缩浅，确保限时折扣价不低于目标价。
- 已有生效限时折扣但价格不符合目标时，不能无脑覆盖：若旧活动只包含目标 SKC，可在 dry-run 安全后修改或结束重建；若混有计划外 SKC、疑似人工特殊价、或活动归属不清，必须 fail closed，列人工确认清单。
- 若平台最低折扣要求导致无法既保留限时折扣又不低于目标价，日报列为平台规则阻断，不硬写。
- BI 的 `限时折扣` 标签只能作为线索，不能证明当前后台确实存在有效限时折扣；最终以 live scan 的限时折扣活动商品集合为准。
- 限时折扣目标价漂移检测：guard 将当前 live 限时折扣行与活跃目标价窗口对比，低于当前目标价的行标记为 blocker/risk。
- 限时折扣漂移自动修复链路：`guard_limited_discount_drift.mjs` 判断 `limitedDiscountTargetPriceDrift.belowRows` 非空后调用 `batch_fix_limited_discount_drift.mjs`；逐店串行执行"删除漂移 SKC → dry-run 新建 → 平台阻断子集剔除 → 可执行子集 execute → readback → 关闭浏览器"。批量结果汇总 `storesProcessed/storesOk/storesFailed/targetSkcs/removedSkcs/blockedSkcs/createdSkcs`。
- 用户批准的人工特殊限时折扣以 `config/marketing_manual_limited_discount_overrides.json` 为事实源。有效窗口内 guard 单列 `manualSpecialLimitedDiscount`，不进入普通漂移队列；漂移计划器、漂移执行器、新链接/重新上架计划器和底层 rescue 执行器都要独立重读登记表，旧 guard/旧 rescue 也不能绕过。特殊活动缺失或错价时恢复登记中的精确价格、库存和 `validTo`，到期后自动恢复普通规则。
- 已登记特殊活动删除后若平台库存低于 `activityStock`，恢复器必须先查询 ET 实盘。ET 足够才可把平台虚拟库存补到登记数量；ET 不足直接阻断。
- 2026-07-16 用户进一步授权自动限时折扣兜底库存补齐：目标价漂移、新链接/新上架 7 天、重新上架无活动、漏限时折扣的 rescue 若平台可报库存低于计划 `activityStock`，可先查 ET 当日实盘；ET 足够时只补平台虚拟库存到本次计划数量并回读，再重跑 dry-run/execute。ET 不足、当天证据缺失或回读不一致时阻断。授权不覆盖普通营销活动报名库存、优惠券或任意扩大库存。
- `platform_saleable_stock=0` 在 guard 报告中只是 BI 信号，不是最终库存判定；live/dry-run 才是最终库存证据。
- guard 建议命令在 live scan 可用时自动传 `--current-marketing-live-scan`。
- 少量自动补报完成后，使用 `merge_current_marketing_price_scans.mjs --base <完整19店快照> --overlay <受影响店复扫> --out <合并快照>`，再基于合并快照生成 final guard；不得为 1–3 店补报无条件重扫 19 店。合并器不调用 SHEIN，只接受成功且非 partial 的完整基线和成功店铺 overlay。
- 自动任务新建或恢复限时折扣后的日报必须逐条列出店铺、标准货号/中文品名、SKC、活动 ID、价格、活动库存、开始/截止时间和 live readback 结果，不得只列活动号和价格。

### 4.2 新链接动作卡落地边界

`scripts/marketing/build_marketing_daily_guard_report.mjs` 已把“新链接自动纳入价格体系”的第一阶段落到只读日报里，字段为 `newSkcCandidates`。本地 Codex 的每日 heartbeat 默认用 `--cloud-bi-ssh shein-bi-tencent --cloud-bi-root /opt/shein-bi/app` 只读读取云端权威 `outputs/bi-portal/data.json`；不写回本地 `outputs/`，只在报告里记录 `biPortalSourceSelection`。它的口径故意保守：

- 精确匹配只能用 `storeKey + skc`。`standard_goods_sn` 只用于展示和提示“同店同标准货号已有计划”，不能证明新 SKC 已经有价格计划，也不能自动继承老 SKC 的活动价、券策略或底价。
- BI `outputs/bi-portal/data.json` 过期时，候选只能标为 `stale_observation_only`，不得形成“无新增链接”的 no-action 结论。
- 云端 BI 读取失败时，日报必须记录 `cloud_bi_fetch_failed`；若本地也缺失或过期，继续阻止 no-action，不能把云端不可达静默解释成无新链接。
- `price-overrides`、selection plan、`config/stores.json` 缺失或解析失败时 fail closed：日报进入 blocker / unknownSources，不能说没有新链接。
- 生成新链接候选前必须先验证 guard 选中的目标计划是当前最新已执行全量计划，尤其要优先选择 `2026-06-14` 后不依赖优惠券保底的批次。旧 `all-934`、旧 `ALL-ready` 或历史批次计划会把已在新计划覆盖的 SKC 误报为“新链接缺兜底”；这种情况下先修正计划选择并重跑 guard。若修正后仍缺兜底，且可用最新基准、同一标准货号全局曝光 Top5、成本/仓储费/底价推导安全目标价，就必须自动生成限时折扣 rescue 并回读，不能停在“待定价”。
- 30 天内已上架且缺精确价格计划的 SKC 才进入动作卡；老于 30 天的缺计划链接只计入 `missingExactPlanOnShelf` 背景数，避免日报被历史遗留淹没。
- 若 `shelf_age_days` 缺失，日报先用 `link_date` 按报告日期兜底推算；仍无法判断年龄的 SKC 进入 `unknown_shelf_age_needs_review`，并阻止 no-action。
- 新链接候选不能只依赖可能早于原始链接日更生成的 BI `linksData` sidecar。guard 和新链接计划器必须再读取截至报告日各店最新的 `outputs/shein_links/<STORE>/<DATE>.json`，仅把 BI 缺失的 `store+SKC` 追加到候选宇宙；不得用原始快照覆盖 BI 已有的曝光、库存或活动字段。报告必须输出 `latestRawLinkOverlay.addedRowCount/sourceFiles/errors`，使“原始链接已刷新但 BI sidecar 尚未重建”的时序差可审计。`sourceFileCount` 少于启用店铺数、`missingStoreKeys` 非空或 `parseErrorCount>0` 时必须 fail closed：guard 生成 `latest_raw_link_overlay_incomplete` blocker，计划器拒绝生成可执行/无动作结论。
- 已禁报券、`couponFactor=1`、缺 `finalTargetPrice`、已在 `excluded` 的 SKC，不得生成 `15%` 券 dry-run 建议；但“待定价/待确认”只能用于缺成本/仓储费/底价/目标价、身份、库存或平台规则阻断。若系统能按价格规则推导安全兜底价，必须进入限时折扣自动兜底。
- unknown store / disabled store / 缺店铺或 SKC 的行只进 ignored/source warning，不能作为可执行候选。
- 审批行导出 `platformNewLabel` 和 `targetPriceScope=store_skc_link_state_window`，明确标注"新品前五待遇"是 scoped 定价处理，不是实际曝光 Top5 证明。

因此每日新链接卡的动作含义是：

1. `known_excluded_needs_pricing`：计划里已明确 excluded，多数是缺目标价；先补成本/仓储/底价，不报券。
2. `same_standard_goods_sn_needs_confirmation`：同店同标准货号已有别的 SKC 计划，但当前 SKC 缺精确计划；人工确认同款、同成本和同底价后，才可复制策略。
3. `unplanned_new_on_shelf_skc_needs_pricing`：新上架 SKC 完全没有计划；先进入待定价，再决定普通活动、限时折扣兜底和 15% 券。
4. `unknown_shelf_age_needs_review`：缺上架天数和可用 `link_date`，不能判断是否新链接；先刷新链接/BI 快照，不报券。

### 4.3 营销叠加审核的新鲜度拆分

`marketingStackReview` 同时承担两类证据，必须拆开判断：

- 活动扫描证据：来自 SHEIN 营销后台只读扫描，字段为 `activityScanCreatedAt/activityScanFinishedAt`（旧报告兼容 `createdAt`）。T-3 活动提醒、普通活动候选覆盖、店铺覆盖完整性都看这一层。`rebuild_marketing_stack_review_from_store_audits.mjs` 只能重组已有 store audit，`rebuiltAt` 不能替代活动扫描时间。
- BI 标签上下文：来自 BI `storeLinks/links` 的活动标签、限时折扣标签、新链接和链接日期，字段为 `source.biGeneratedAt / biDataPath / biDataTransport / biFallbackUsed`。优先用 `--cloud-bi-ssh shein-bi-tencent --cloud-bi-root /opt/shein-bi/app` 只读读取云端权威快照；云端失败只有本地快照新鲜时才 fallback。

日报 `build_marketing_daily_guard_report.mjs` 必须同时验证：

- 云端每日 guard 在生成日报前必须先运行 `export_marketing_stack_review.mjs --session-http --cloud-bi-ssh local`，刷新全部启用店的普通活动 live 审核。session HTTP 复用 session-manager 导出的登录态，不打开浏览器；正常 19 店约数分钟。不能只沿用旧审核并输出 stale blocker 后结束当天巡检；刷新失败或覆盖不足时必须 fail closed，且不得继续限时折扣自动写入；
- `marketingStackReview` 活动扫描未超过 48 小时；超过 48 小时必须成为 blocker，系统先运行只读 `export_marketing_stack_review.mjs` 或用分批 store audit `rebuild_marketing_stack_review_from_store_audits.mjs` 重建，不能只给 warning 或 no-action；
- BI context 未超过日报阈值；
- `selectedStores=19` 且 `missingStores=[]`。若有店铺缺失，即使 BI context 新鲜，也不能形成完整 no-action。

### 4.4 优惠券预算守卫

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

低价成交告警必须先判断订单时间是否落在本期活动窗口内。若订单早于活动开始或晚于活动结束，只能标为“窗口外偏离线索”，不能直接判定本次活动漏报；普通活动报名完成但尚未生效时，日报只验收后台已报/待生效、限时折扣兜底和旧活动叠加，不提前按未来活动目标追责成交价。

若 `storeKey + skc` 在订单时间命中有效人工特殊限时折扣登记，订单商品行 `currencyPrice` 的预期价改用登记中的 `specialPrice`；该覆盖只影响订单审计和限时折扣保护，不改写普通活动方案本身的 `finalTargetPrice`。订单落在保护窗口外时仍回到普通活动窗口和普通目标价口径。

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
2. `audit_order_prices_against_plan.mjs` 已支持 linksData 精确目标价 overlay 和按订单时间/活动窗口选择计划行；剩余工作是接入销售同步后置调度和报告消费，脚本能力本身已就绪。
3. 把可选流量券预算从“默认每店 1000 SAR”改为按候选规模测算；真实 execute 仍接入人工授权动作池，日报只结构化识别预算低于目标、缺回读证据、写入异常但回读达标。
4. 把营销活动 `T-3` 提醒接入活动列表扫描和 BI 动作池。
5. 新链接动作卡拆成两类：能按最新基准和全局曝光 Top5 推导安全目标价的，直接进入限时折扣自动兜底；只有缺成本/仓储费/底价/目标价或身份、库存、平台阻断的，才进入待定价队列。
6. `30%/50%` 券只做研究表，不进入执行器默认路径。
