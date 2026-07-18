# SHEIN 每日营销巡检交接（长期运维入口）

> 适用工作区：`E:\Codex WorkSpace\Shein销售统计`
> 生产目录：`/opt/shein-bi/app`
> 时间口径：`Asia/Shanghai`
> 当前自动化：分钟级完整巡检与大批修复已解耦。巡检独立完成当天 live 证据；修复 worker 在 `10:50/12:50/14:50/16:50/18:50` 取队列，不得拖住巡检。

本文是日常运维入口和可复用流程；[pricing-rules](marketing-campaign-signup-pricing-rules.md) 是业务政策，`skills/shein-marketing-ops/SKILL.md` 是执行指令。运行批次记录已迁至 [2026-07-13-to-2026-07-16.md](archive/marketing-runs/2026-07-13-to-2026-07-16.md)。三者必须一起阅读，但不得互相替代。

## 1. 目标与不可破坏的优先级

每日巡检必须同时覆盖三层，顺序不可颠倒：

1. **普通营销活动**：必报且最高优先级。
2. **限时折扣**：所有在售运营链接的必备兜底层，不能替代普通活动。
3. **优惠券**：只做用户明确批准的 15% 小流量实验，不能作为保底成交价层；禁止自动上线 30%/50% 券。

订单成交价只认订单商品行 `currencyPrice`。页面商品总价、预计收入和 `summary.salesSar` 都不能作为单件成交价。

## 2. 每日证据链

### 2.1 普通活动 live 审核

在生成日报和执行任何限时折扣写入前，云端必须运行：

```bash
node scripts/marketing/export_marketing_stack_review.mjs \
  --batch-size 3 \
  --headless \
  --session-http \
  --cloud-bi-ssh local
```

`--session-http` 复用 session-manager 的登录态，不打开浏览器；19 店正常约数分钟。验收条件：

- `marketingStackReviewCoverage.coverageComplete=true`
- `completedStoreCount=19`
- `missingStores=[]`
- 活动扫描是当天新鲜证据

审核过期或覆盖不足时，必须当轮补跑并重建 guard；禁止只输出 stale/incomplete blocker 后结束当天巡检。普通活动 live 证据不完整时 fail closed，不能继续限时折扣写入。

普通活动每日必须检查：

- 未来 3 天内截止报名的活动；
- 活动列表 `allowGoodsNum/applyGoodsNum`；
- 活动商品页新增可报 SKC；
- 当前最终计划应报但未进入已报/审核中集合的行；
- 普通活动、限时折扣、优惠券叠加后的价格风险。

发现普通活动后先生成按货号/店铺的人话方案；除非用户已明确授权该活动自动报名，否则禁止自动提交。

### 2.2 价格栈 live scan

不能只依赖 BI 标签。每日必须有 SHEIN 后台 live scan/readback 覆盖全部 19 店。BI 只用于发现经营线索；是否已报、是否生效、当前限时折扣价和优惠券集合以后台 live 证据为准。

### 2.3 云端运行态与防撞车

开跑前读取实际 `systemctl cat/list-timers` 和核心 service 状态，不按旧记忆猜排班；禁止顺手修改销售刷新或用户现有 timer。

价格栈与普通活动审核默认均走 session HTTP，不启动浏览器；临时补跑仍避开奇数小时 ET `:20`、整点销售刷新、watchdog `:50` 及晨间/备份/订单闭环。browser cleanup 已降为每小时 `:15`，且只清理无有效任务租约的孤儿浏览器，不再要求巡检为了 cleanup 中断或反复重开。

guard 尚未结束时，heartbeat 每 60–90 秒轮询，最长 30 分钟；结束后只读取并汇报巡检证据。获准的大批修复另入队列，由 worker 完成，不能再与巡检同步串行。

### 3.1 2026-07-18 巡检/修复解耦

云端证据：`2026-07-17` 的全在售兜底差集产生 `74` 条；`2026-07-18` 基准切换产生 `61` 条、`32` 个活动组。旧流程把完整巡检与大批写入同步串行，曾在约一小时后被系统杀掉，不能再作为生产路径。

- 完整巡检保持分钟级完成，最长 `30` 分钟；它生成精确 manifest/hash、活动组和可恢复队列，但不等待大批修复。
- 修复 worker 在 `10:50/12:50/14:50/16:50/18:50` 运行，单轮按总预算最多处理 `8` 个活动组、最长 `40` 分钟；一个阶段提前完成时会用剩余预算继续下一阶段，不再空耗整个时间窗。同店复用浏览器，成功组可 resume，失败/阻断组不会被误记为完成。
- 每个替换组仍先 preflight/dry-run，再锁定旧活动完整快照和精确 hash。真实删除、目标活动创建、回读与补偿由事务执行器统一管理；目标创建失败时自动恢复旧保护。dry-run 不得进入删除或任何真实写路径。
- 修复队列全部组完成后做全店 live readback；巡检 watchdog 与修复 watchdog 分别验收，后者必须在 `20:00` 前确认修复闭环或明确剩余 blocker。
- 候选范围同时包括持续在售老链接的 `30` 天兜底，以及新品/重新上架的 `7` 天兜底；两者都以精确 `storeKey + SKC` manifest 为准。价格漂移阶段与兜底阶段必须键级互斥，发现重叠直接拒绝建队列，不能重复修同一链接。

## 3. 定价规则

- 普通活动以最近一次用户确认并真实执行的最终全量 `selection-plan + price-overrides` 继承用户备注、固定价、特殊利润率和货号归并；不能回退旧草稿、演示计划或单店 supplement。
- 每一期仍必须按最新链接曝光重新分层，不能简单继承同店同 SKC 上一期执行价。
- 曝光前五维度是：**同一标准货号、全店、全链接的 7 天曝光 Top 5**，不是每个店各算前五。
- 新链接、新上架 7 天链接及首次参加新品类普通活动的链接，按全局曝光 Top5 力度定价；这是 `newListingTopTreatment`，不能伪装成真实 Top5 排名。
- 高曝光处理通常在基础目标利润率上降低 5 个点，但不能低于底价/利润安全线；基础利润率已经很低时不能继续压低。
- 当前安全筛选采用 `product_cost_excluding_storage`。仓储费缺失必须留痕，但只要商品成本存在，不得误报为“无成本”或“待定价”。商品成本也缺失时才阻断。
- 货号脏值必须先归并再判成本。已确认：`SK=-3378杆式吸尘器` 归并为 `SK-3378杆式吸尘器`，成本 `103.3607 SAR`。
- 普通活动填报价避免整百/整数批量固定价；用户确认价允许几毛钱级小数微调，但不得越过平台上限、目标价和利润安全线。

## 4. 限时折扣自动处理

限时折扣是所有在售链接的必备兜底：

- 没有普通活动时，限时折扣直接命中 `finalTargetPrice`。
- 有普通活动时仍需限时折扣；默认当前售价 15% 折扣，若低于目标价或安全线则缩浅，不能打穿目标价。
- 新链接、新上架 7 天、重新上架且无当前生效营销活动的链接，按全局 Top5 力度自动报一周限时折扣。
- 持续在售的老链接也必须参与完整差集：每日 19 店 live scan 后，以全部当前在售 `storeKey + SKC` 减去当前/已排期待生效限时折扣集合。不得因为链接不在旧 `price-overrides`、不是新上架、也没有“售罄 -> 在售”历史而跳过。
- “即将开始/待生效”活动不等于当前生效活动，不能据此跳过当前兜底。
- 重新上架识别读取最近 60 天 `outputs/shein_links/<STORE>/YYYY-MM-DD.json`，保留 `lastInactiveDate/relistedAt/treatmentType`。
- 若最终计划缺该货号目标价但成本存在，默认以 30% 基础利润率、Top5 下调 5 个点且不低于 15% 底线自动推导。

价格漂移修复：

1. dry-run 后先锁定旧活动完整商品快照、目标 SKC 和精确 rescue hash；快照未落盘禁止删除。
2. 只移除目标 SKC，再按 `finalTargetPrice` 创建并精确回读目标活动；旧活动中的其它商品必须保留。
3. 创建、价格、库存或覆盖回读任一失败，立即按快照恢复旧保护；恢复成功仅表示“未失保”，不表示修复成功。
4. `0004/0006/101018`、身份不一致等平台阻断必须保留证据并继续排队。库存不足按 2026-07-16 新授权先执行 ET 门控补齐；ET 不足、缺当天证据或补齐回读不一致时保留阻断。

非漂移的新链接若命中混合旧活动、人工特殊价或活动归属不清，继续 fail closed，除非已有明确的安全拆分规则。

## 5. 优惠券规则

- 优惠券不保证每单触发，不能用于证明目标成交价。
- 真实保底必须由当前售价、普通活动价或限时折扣价直接命中目标。
- 只允许用户明确批准的 `34810/15%` 流量实验；上线前必须证明不触券时已有保底，触券后也不低于底价/利润线。
- 优惠券与普通活动/限时折扣叠加后若低于目标价，券必须取消、排除或等待，主活动和兜底层优先。
- 禁止自动提交优惠券、补预算及 30%/50% 券。

## 6. 写入边界与验收

每日可自动写入仅限：

- 限时折扣价格漂移修复；
- 新链接/新上架 7 天/重新上架无活动/漏限时折扣兜底。

这些动作使用 `config/marketing_pricing_policy.json` 中 `owner-standing-cloud-marketing-v1` 的负责人长期授权，worker 不逐次索要人工确认，但必须自动计算、锁定并校验本轮精确 payload/work hash。每个写入仍必须满足授权上下文/动作范围、身份校验、价格栈校验、库存/平台规则、dry-run、execute、审计和 readback。普通活动、优惠券和预算不在长期授权内，只生成方案，得到对应业务授权后才提交。

guard 只生成并锁定队列，不执行任何写入。独立 repair worker 按“人工特殊折扣恢复 -> 目标价漂移修复 -> 全部在售链接限时折扣差集兜底（含新链接、重新上架和持续在售老链接）”串行消费队列；`scripts/cloud_marketing_live_guard.sh` 在完整 live scan 后无条件生成该差集计划，不能再由“新链接候选数”决定是否调用计划器。任一阶段失败后，后续写阶段跳过，避免基于旧证据继续写；队列完成后由 worker 做一次最终全店 live readback，完整记录部分成功、失败和跳过项。

2026-07-16 起，以上已授权限时折扣链路若平台可报库存低于计划 `activityStock`，允许先查询 ET 当日实盘：ET 可售库存足够时，只把平台虚拟库存精确补到本次 `activityStock`（默认 10），回读一致后重新 dry-run 并完成兜底；ET 不足、证据非当天或回读不一致时必须阻断。该授权覆盖目标价漂移、新链接/新上架 7 天、重新上架无活动和漏限时折扣，不扩展到普通营销活动报名库存、优惠券或任意扩大平台库存。

ET 门控必须逐 SKC 处理：同店多 SKC rescue 中，每个低库存目标独立查 ET、补平台库存并回读；仍不足的目标单独进 blocker，其余安全目标继续 dry-run -> execute -> readback，不得因一条库存异常阻断整店批次。平台库存写入若首次返回成功但 live readback 未变，只允许一次使用新幂等键的有界重试；两次仍不一致就阻断。

`activityStock=10` 指营销后台可报/可用库存不少于 10，不是平台总库存字段机械写成 10。平台存在锁定库存时，虚拟库存覆盖量必须按“活动要求可用库存 + 当前锁定库存”计算，并把实际覆盖量纳入幂等键；每次仍以写后 `totalUsableInventory >= activityStock` 作为成功条件。旧 rescue 缺 `activityStock` 时读取 `marketing_pricing_policy.json` 的默认值 10，不能再因 `NaN` 跳过 ET 门控。

普通兜底的 live 覆盖判定与价格漂移守卫一致：已有合规限时折扣价不低于当前目标价时视为已覆盖，不为追新基准自动降价或每日延长活动；低于目标价时仍必须进入修复。人工特殊限时折扣不适用该宽松判定，仍必须精确匹配登记价、库存和截止时间。

人工特殊折扣的“已覆盖”不是只看价格：live 证据必须同时证明精确价格、活动库存不少于登记 `activityStock`、活动截止时间不早于登记 `validTo`。新建/恢复后必须按活动 ID、价格、库存和截止时间逐项精确回读；缺字段也视为证据不足并进入恢复/阻断，不得报绿。

guard 本身不应产生浏览器。repair worker 若因平台写入启动浏览器，必须在每个店铺批次完成、失败或阻断后通过父任务拥有的租约立即关闭；最终确认远程调试端口和临时 Chrome 目录为 0。

云端 Chrome 进程归零后，清理器还必须删除已关闭店铺 profile 下的 `SingletonLock`、`SingletonCookie`、`SingletonSocket`；只能对确认无该店 Chrome 进程的精确 profile 执行。日报收口同时核对进程、调试端口、Chrome 临时目录和这些 profile 锁，避免“进程为 0 但下批浏览器仍因旧锁无法启动”。

### 浏览器租约与可恢复 guard

`state/browser_task_leases/<task>--<store>.json` 是单任务、单店原子租约。有效租约（TTL 未到且同机 owner PID 存活）保护该店浏览器和 profile 锁；清理器只处理无有效租约的孤儿。TTL 到期、同机 owner 已死亡或格式损坏的租约会先被回收，再考虑清理该店。纯 session HTTP 的 cloud marketing guard 不持有浏览器租约；repair worker、链接/业务域抓取、登录态管家等确实启动浏览器的任务才申请租约，并把父任务的 task/runId 传给子批次做精确收尾。

guard 的 `runId` 写入不可覆盖的 `state/cloud_marketing_live_guard/reports/marketing-live-guard-<date>-<runId>.json`。当天第一次成功巡检后，`13:30/16:30` 只作为失败重试窗口，不会在 repair queue 消费期间再次全店扫描、重建 hash 或冲掉进度。写阶段的状态与 resume 证据只保存在 repair queue 和各批次结果中；只有精确回读成功的组才可跳过。

## 7. 每日人话输出

1. 普通活动 stack review 与价格栈 live scan 是否都覆盖 19/19 店。
2. 未来 3 天截止的普通活动、已报/可报数量及漏报情况。
3. 限时折扣缺口、自动补报和平台/库存阻断。
4. 价格漂移修复了几店、几个 SKC、新建哪些活动。
5. 新上架 7 天、新链接/新 SKC、重新上架无活动链接的处理结果。
6. 订单低于/高于目标价及处理结果。
7. 优惠券实验状态。
8. 需要重新登录的店铺。

凡本轮新建或恢复限时折扣，日报必须逐条给出：店铺、标准货号与中文品名、SKC、活动 ID、价格、活动库存、开始时间、截止时间、动作结果和 live readback。不得只写“某店新建活动号/价格”。

无变化时返回 `DONT_NOTIFY`；有报名截止、漏报、写入、低价订单或平台阻断时必须通知。

## 8. 用户临时营销任务的处理规则

本交接任务不仅承接自动巡检，也承接用户后续主动下达的普通营销活动、限时折扣、成交价追因和营销价格栈任务。默认由主模型自己完成，不使用子代理。

### 8.1 普通活动方案

- 先读后台 live 活动页和当前最终版基准，不凭 BI 或旧 Excel 猜活动、可报数量和已报状态。
- 当前基准读取 `tmp/marketing-signup/selection-plan-2026-07-15-v48217-48215-48925-final-executed-all-1063.json` 及同名 paired `price-overrides`；下一期方案一旦经用户确认并真实执行，应生成新的最终全量基准并替换它。
- 基准只继承用户备注、固定价、特殊利润率、货号归并和已批准例外；新一期价格仍按最新 7 天链接曝光重新分层，不能简单继承同店同 SKC 上一期执行价。
- 新活动方案必须是人话版 Excel，至少包括 `说明`、`按货号汇总`、`店铺差异明细`、`报名明细`、`剔除项/阻塞项`、`低价补救/风险项`；除说明页外保留 `备注/修改意见` 列。
- `本期曝光前五/新链接前五行数` 表示命中两种待遇规则的报名明细行数，不代表有那么多个不同链接；展示时同时给出唯一链接数，避免把行数误读成链接数。
- 对新链接、新 SKC、重新上架链接，能按同标准货号全局 Top5、当前成本和最新最终基准推导的，必须直接定价，不能写“待定价”。
- 用户已经修改方案并明确说“可以开始报名”后，按已批准方案直接分批执行、回读并汇报；不要每批再次要求人工确认。
- 新方案的目标价只在对应普通活动生效窗口内用于订单审计。活动开始前的订单不能用未来目标价判低价/高价；活动结束后也不能继续套用过期窗口。

### 8.2 成本与仓储展示

- 给用户审核的普通活动方案必须分别展示商品成本、仓储费/件、含仓储完整成本、商品成本利润率和含仓储利润率；仓储费真实存在时两套结果不能做成一样。
- 仓储费缺失时要明确标记证据缺口，不能按 0 冒充“含仓储成本”；应优先回查成本源和货号归并。
- 自动限时折扣兜底当前获准按 `product_cost_excluding_storage` 做安全红线；因此“仓储费缺失不阻断自动兜底”和“普通活动审核表必须展示真实仓储费”是两个不同边界，不能混为一谈。

### 8.3 阻塞项分类

- 不能把历史 `excluded/blocked` 整包排除。用户已批准可报的历史剔除项，按批准利润率、固定价或成本口径进入方案。
- 只有缺商品成本/底价、身份异常、后台库存或平台规则阻断、货号无法可靠归并、混合人工特殊活动无法安全拆分时才 fail closed。
- `platform_saleable_stock=0` 只是 BI 线索；库存阻断必须由后台 `query_goods`、dry-run 或执行回读证明。

### 8.4 执行与收尾

- 写入前核对活动 ID、店铺身份、SKC、价格覆盖、平台最低降幅和活动窗口。
- 用户已批准方案后，先小批执行并在同一任务内继续完成其余安全店铺；遇到单店登录/接口异常时记录并继续其他店，不让一个店拖死整批。
- 每个写入组只回读受影响店铺/活动；整条 repair queue 结束后再做一次全店 live readback。不得在每个组后都重复全扫 19 店，也不得省掉最终全店闭环。
- 无论成功、失败或阻断，本批浏览器立即关闭；最终确认调试端口和 Chrome 临时目录为 0。

## 9. 当前效率基线与防回退

- guard 只执行一次普通活动 stack review、一次当前营销价格 scan、一次报告/建队列；日更批次不再重复调用全店 `scan_current_marketing_prices_for_bi.mjs`。旧优惠券低价和旧普通活动五份中间扫描只留历史审计，实时 19 店证据完整时不再成为前置层。
- `2026-07-18 21:06` 生产基线：19 店普通活动与 15% 券规则直读、当前/未来普通活动和限时折扣价扫描、报告及队列合计 `157s`；`1516` 行、19/19 店成功，Chrome `0 -> 0`。该量级若再次明显升到十几分钟或数小时，必须按重复抓取、浏览器回退、清理碰撞或扫描夹带写入排障，不能把它解释为正常工作量。
- `scripts/marketing/merge_current_marketing_price_scans.mjs` 仍可把少量受影响店铺复扫覆盖进完整 19 店基线；失败店铺、重复店铺或 partial 基线时拒绝合并。生产 worker 当前选择“组级定点回读 + 队列结束后一次全店 readback”，不在每组后反复全扫。
- 普通活动和价格栈默认都使用 `--session-http`，禁止回退到逐店前端扫描作为日常默认。自动动作阻断与扫描失败分开记录：前者保留 queue blocker，后者才是巡检本身失败。

## 10. 最近批次归档

`2026-07-13`、`2026-07-15` 和 `2026-07-16` 的运行日志、活动 ID、回读和 warning 已移至 [2026-07-13-to-2026-07-16.md](archive/marketing-runs/2026-07-13-to-2026-07-16.md)。日常操作从本 runbook 的证据链和写入边界开始，历史结果不能替代当天 live evidence。

2026-07-17 对“67 条在售老链接漏兜底”做了完整收口：当天最新链接状态扩展后实际需处理 74 条，通过分批补报、逐 SKC ET 门控库存补齐和 TZZ 超时后独立 live 回读/重试，最终 19 店快照重建计划为 `actionable=0 / blocked=0`。根因修复集中在 `batch_apply_new_listing_limited_discount.mjs`、`manage_manual_limited_discount_inventory.mjs` 和 `build_new_listing_limited_discount_plan.mjs`；该日结果不得代替后续每日 live 差集。

## 11. 关键文件

- `skills/shein-marketing-ops/SKILL.md`（执行指令）
- `.codex/plans/2026-06-14T13-20-00-coupon-non-guaranteed-price-stack.md`
- `docs/marketing-campaign-signup-pricing-rules.md`（业务政策）
- `docs/marketing-automation-roadmap.md`
- `scripts/cloud_marketing_live_guard.sh`
- `scripts/marketing/export_marketing_stack_review.mjs`
- `scripts/marketing/build_marketing_daily_guard_report.mjs`
- `scripts/marketing/batch_fix_limited_discount_drift.mjs`
- `scripts/marketing/batch_apply_new_listing_limited_discount.mjs`
- `scripts/marketing/merge_current_marketing_price_scans.mjs`
- `config/marketing_manual_limited_discount_overrides.json`
- `lib/marketing_manual_limited_discount_overrides.mjs`
- `scripts/marketing/manage_manual_limited_discount_override.mjs`
- `scripts/marketing/batch_restore_manual_limited_discounts.mjs`
