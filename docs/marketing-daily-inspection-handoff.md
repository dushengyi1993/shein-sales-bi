# SHEIN 每日营销巡检交接（长期运维入口）

> 适用工作区：`E:\Codex WorkSpace\Shein销售统计`
> 生产目录：`/opt/shein-bi/app`
> 时间口径：`Asia/Shanghai`
> 当前自动化：分钟级完整巡检与大批修复已解耦。巡检独立完成当天 live 证据；修复 worker 在 `10:50/12:50/14:50/16:50/18:50/19:30` 取队列，不得拖住巡检。

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

价格栈与普通活动审核默认均走 session HTTP，不启动浏览器；临时补跑仍避开 ET 固定 `:20`、watchdog `:50` 及晨间/备份/订单闭环。当天销售由 Webhook 实时触发，不再假设存在整点销售 timer。browser cleanup 只在 `03:45/09:50/21:00` 运行，且只清理无有效任务租约的孤儿浏览器，不再要求巡检为了 cleanup 中断或反复重开。

guard 尚未结束时，heartbeat 每 60–90 秒轮询，最长 30 分钟；结束后只读取并汇报巡检证据。获准的大批修复另入队列，由 worker 完成，不能再与巡检同步串行。

### 3.1 2026-07-18 巡检/修复解耦

云端证据：`2026-07-17` 的全在售兜底差集产生 `74` 条；`2026-07-18` 基准切换产生 `61` 条、`32` 个活动组。旧流程把完整巡检与大批写入同步串行，曾在约一小时后被系统杀掉，不能再作为生产路径。

- 完整巡检保持分钟级完成，最长 `30` 分钟；它生成精确 manifest/hash、活动组和可恢复队列，但不等待大批修复。
- 修复 worker 在 `10:50/12:50/14:50/16:50/18:50/19:30` 运行，单轮按总预算最多处理 `8` 个活动组、最长 `40` 分钟；一个阶段提前完成时会用剩余预算继续下一阶段，不再空耗整个时间窗。同店复用浏览器，成功组可 resume，失败/阻断组不会被误记为完成。
- 每个替换组仍先 preflight/dry-run，再锁定旧活动完整快照和精确 hash。真实删除、目标活动创建、回读与补偿由事务执行器统一管理；目标创建失败时自动恢复旧保护。dry-run 不得进入删除或任何真实写路径。
- 修复队列全部组完成后，最终闭环顺序固定为：先用 session HTTP 刷新 19 店普通活动/优惠券 stack review，再做 19 店价格栈 final live readback，最后重建 guard。价格栈必须最后扫，避免刚创建的待生效活动在 stack review 期间跨过开始时间后，又被旧价格快照误判为缺失。修复耗时超过同轮证据时差时，不得沿用巡检开始时的旧 stack review，让已被 live 证据替代的优惠券中间文件重新变成 stale blocker。巡检 watchdog 与修复 watchdog 分别验收，后者必须在 `20:00` 前确认修复闭环或明确剩余 blocker。
- 飞书日报只能在最终 19 店 stack review、价格栈 readback 和 guard 重建之后发送。队列刚进入 `blocked`、某个 worker 阶段结束或 execution summary 刚落盘都只是中间态；发送器必须校验最终 guard 的时间晚于终态队列和执行结果，否则拒绝发送。群内固定只发“一段最终结论 + 一个 `marketing-daily-final-YYYY-MM-DD.md` 附件”，不得再分别发送 guard/execution 两个附件，也不得把 guard 的只读“不能自动执行”标题当成整轮执行结论。
- 候选范围同时包括持续在售老链接的 `30` 天兜底，以及新品/重新上架的 `7` 天兜底；两者都以精确 `storeKey + SKC` manifest 为准。价格漂移阶段与兜底阶段必须键级互斥，发现重叠直接拒绝建队列，不能重复修同一链接。
- 高点击低转化专属折扣优先于普通漏兜底/新品/重新上架阶段。普通兜底计划器必须读取同一 guard 的 `highClickLowConversionSpecial.rows`，把这些精确 `storeKey + SKC` 记为 `handled_by_high_click_special_stage` 并从普通 rescue 中剔除；队列构建器仍对未被上游解释的任何跨阶段重复 fail closed。2026-07-30 已修复因 `DL::sv260208174499165647929` 同时进入高点击与普通兜底而导致整条 repair queue 无法生成的问题。

## 3. 定价规则

- 普通活动以最近一次用户确认并真实执行的最终全量 `selection-plan + price-overrides` 继承用户备注、固定价、特殊利润率和货号归并；不能回退旧草稿、演示计划或单店 supplement。
- 每一期仍必须按最新链接曝光重新分层，不能简单继承同店同 SKC 上一期执行价。
- 曝光前五维度是：**同一标准货号、全店、全链接的 7 天曝光 Top 5**，不是每个店各算前五。
- 新链接、新上架 7 天链接及首次参加新品类普通活动的链接，按全局曝光 Top5 力度定价；这是 `newListingTopTreatment`，不能伪装成真实 Top5 排名。
- 高曝光处理通常在基础目标利润率上降低 5 个点，但不能低于底价/利润安全线；基础利润率已经很低时不能继续压低。
- 当前安全筛选采用 `product_cost_excluding_storage`。仓储费缺失必须留痕，但只要商品成本存在，不得误报为“无成本”或“待定价”。商品成本也缺失时才阻断。
- 货号脏值必须先归并再判成本。已确认：`SK=-3378杆式吸尘器` 归并为 `SK-3378杆式吸尘器`，成本 `103.3607 SAR`。
- 普通活动填报价避免整百/整数批量固定价；用户确认价允许几毛钱级小数微调，但不得越过平台上限、目标价和利润安全线。
- 新报名、补报或重建普通活动/限时折扣时，若 ET 当天已匹配运营可售库存 `<= 10`，且同一标准货号跨 19 店近 30 天有效销量合计 `> 30`，先执行“价格档位上移一级”：全局最新 7 天曝光 Top5 恢复为该货号普通链接最新已批准价，普通链接按普通目标利润率再加 5 个百分点重算。不得机械把页面折扣率减 5%，不得追溯改写正常运行的旧活动，也不得污染最新已批准基准。
- ET 低库存畅销品收回价格的优先级高于自动高点击专属折扣、新链接/新品 Top5 待遇和普通活动基准；平台最低折扣/最高允许报名价优先，能收回多少收回多少，成本/底价/利润安全线仍是硬门禁。ET 恢复到 `> 10` 后，后续新活动恢复原批准档位。已登记人工特殊折扣不自动覆盖，单独列用户审核。

## 4. 限时折扣自动处理

限时折扣是所有在售链接的必备兜底：

- 没有普通活动时，限时折扣直接命中 `finalTargetPrice`。
- 有普通活动时仍需限时折扣；默认当前售价 15% 折扣，若低于目标价或安全线则缩浅，不能打穿目标价。
- 新链接、新上架 7 天、重新上架且无当前生效营销活动的链接，按全局 Top5 力度自动报一周限时折扣。
- 新链接候选合并最新 `outputs/shein_links` 原始快照时，新增 `store+SKC` 继续补入；同键若由“待上架/售罄/下架”变为“已上架”，只用更新更晚的原始快照刷新上架状态和首次/恢复上架时间，禁止覆盖 BI 已有曝光、活动、价格和库存字段。每日检查 `latestRawLinkOverlay.updatedRowCount/updatedRows`，这类同键状态变化也必须进入活动差集，不能只盯 `addedRowCount`。
- 高点击低转化链接专属折扣有两个并行入口，且均要求当前在售、`c7_sale_cnt = 0`：A. `c7_eps_uv > 3000` 且 `c7_goods_uv / c7_eps_uv > 4%`；B. `c7_eps_uv >= 3000` 且近 7 天加车访客 `c7_cart_uv >= 20`。销量字段缺失不得当成 0，入口所需指标缺失不得猜测。价格按最新已批准普通活动中同标准货号全局曝光 Top5 的商品成本利润率再降低 2 个百分点，且不得低于 15% 利润率底线；默认活动库存 10、周期 7 天。加车访客入口首批已于 2026-07-29 经用户确认，后续纳入长期自动 repair queue；平台活动库存下限高于计划量时走报名事务式临时补量，不能永久抬高库存。
- 高点击专属折扣真实提交前必须先写入人工特殊限时折扣保护登记。有效窗口内漂移、新链接、重新上架和普通漏兜底均不得覆盖；当日修复 worker 写入前再次读取最新 7 日指标，已经出单或跌出阈值时跳过旧计划。
- SHEIN 刚创建的人工特殊活动若尚在平台生效延迟中，只有活动 ID 与登记的 `currentActivityId` 一致、价格/库存/截止精确命中且两小时内开始，才记为“已排期精确覆盖”；不得在这段时间重复救援。其他未来、过期或活动 ID 不一致的行仍按缺失/错价处理。
- 持续在售的老链接也必须参与完整差集：每日 19 店 live scan 后，以全部当前在售 `storeKey + SKC` 减去当前/已排期待生效限时折扣集合。不得因为链接不在旧 `price-overrides`、不是新上架、也没有“售罄 -> 在售”历史而跳过。
- “即将开始/待生效”活动不等于当前生效活动，不能据此跳过当前兜底。
- 重新上架识别读取最近 60 天 `outputs/shein_links/<STORE>/YYYY-MM-DD.json`，保留 `lastInactiveDate/relistedAt/treatmentType`。
- 若最终计划缺该货号目标价但成本存在，默认以 30% 基础利润率、Top5 下调 5 个点且不低于 15% 底线自动推导。

价格漂移修复：

1. dry-run 后先锁定旧活动完整商品快照、目标 SKC 和精确 rescue hash；快照未落盘禁止删除。
2. 只移除目标 SKC，再按 `finalTargetPrice` 创建并精确回读目标活动；旧活动中的其它商品必须保留。
3. 创建、价格、库存或覆盖回读任一失败，立即按快照恢复旧保护；恢复成功仅表示“未失保”，不表示修复成功。
4. `0004/0006/101018`、身份不一致等平台阻断必须保留证据并继续排队。库存不足只按活动 live 页面、`query_goods` 或 dry-run 的真实最低值进入事务式临时补量；补量、提交、恢复或恢复后回读任一步失败都保留精确阻断。

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
- 高点击低转化专属限时折扣的保护登记、精确创建/替换。
- 已获报名授权的普通活动或限时折扣，在同一 `store + SKC/SKU` 锁内执行平台最低库存的事务式临时补量与恢复。

这些动作使用 `config/marketing_pricing_policy.json` 中 `owner-standing-cloud-marketing-v1` 的负责人长期授权，worker 不逐次索要人工确认，但必须自动计算、锁定并校验本轮精确 payload/work hash。每个写入仍必须满足授权上下文/动作范围、身份校验、价格栈校验、库存/平台规则、dry-run、execute、审计和 readback。未批准的新普通活动、优惠券和预算不在长期授权内，只生成方案；普通活动一旦已获本批报名授权，其报名事务可自动使用临时补量，不需要再单独确认库存动作。

guard 只生成并锁定队列，不执行任何写入。价格决策先按“ET 低库存畅销品收回 > 自动高点击专属折扣 > 新链接/新品 Top5 > 普通基准”预处理；已登记人工特殊折扣不自动覆盖，转用户审核。独立 repair worker 再按“高点击低转化专属折扣先登记保护并精确创建 -> 既有人工特殊折扣恢复 -> 目标价漂移修复 -> 全部在售链接限时折扣差集兜底（含新链接、重新上架和持续在售老链接）”串行消费互斥队列；`scripts/cloud_marketing_live_guard.sh` 在完整 live scan 后无条件生成该差集计划，不能再由“新链接候选数”决定是否调用计划器。任一阶段失败后，后续写阶段跳过，避免基于旧证据继续写；队列完成后由 worker 做一次最终全店 live readback，完整记录部分成功、失败和跳过项。

2026-08-02 起，普通营销活动和限时折扣报名的最低库存统一走事务式临时补量。平台最低值只认活动 live 页面、`query_goods` 或 dry-run，BI `platform_saleable_stock` 仅作线索。补量前在同一 `store + SKC/SKU` 库存锁内记录实时 `totalUsableInventory / totalInventoryQuantity / totalLockedQuantity`；不足时只临时补到平台要求的精确最低可用库存。提交及 live readback 后，无论成功失败都必须在 `finally` 立即恢复报名之前的原可用库存，并以恢复时实时锁定/不可用量计算覆盖量。

恢复后必须再次回读库存和活动报名状态。恢复失败、恢复后活动失效/被平台撤销，或锁定/不可用量变化导致不能精确恢复原可用库存时，均 fail closed，不能写成功。同店多 SKC 逐键独立处理，一条失败不阻断其他安全目标。平台库存写入首次成功但 live readback 未变时，只允许一次使用新幂等键的有界重试；两次仍不一致就阻断。

即使 ET 当日已匹配运营可售库存 `<= 10`，也允许只在报名事务短窗口内临时补到平台最低值，随后恢复库存巡检给出的实盘分配。这个短窗口存在订单/超卖风险，必须写审计时间戳。该授权取代旧的“普通活动库存虚增不授权”和“平台活动库存下限高于用户指定数量一律阻断”，但不授权永久增库存、优惠券补库存或脱离报名事务的库存修改。`activityStock` 是活动报名量；临时覆盖总量要保留实时锁定/不可用库存，不能把总库存机械写成活动量。

执行器若尚不能输出补量前三字段快照、平台最低值来源、库存锁、`finally` 恢复尝试、恢复后库存和恢复后报名状态，必须 fail closed 为“报名库存事务能力未就绪”；禁止继续调用旧 ET 门控持久补量并把它记成成功。

普通兜底的 live 覆盖判定与价格漂移守卫一致：已有合规限时折扣价不低于当前目标价时视为已覆盖，不为追新基准自动降价或每日延长活动；低于目标价时仍必须进入修复。人工特殊限时折扣不适用该宽松判定，仍必须精确匹配登记价、库存和截止时间。

人工特殊折扣的“已覆盖”不是只看价格：live 证据必须同时证明精确价格、活动库存不少于登记 `activityStock`、活动截止时间不早于登记 `validTo`。新建/恢复后必须按活动 ID、价格、库存和截止时间逐项精确回读；缺字段也视为证据不足并进入恢复/阻断，不得报绿。

guard 本身不应产生浏览器。repair worker 若因平台写入启动浏览器，必须在每个店铺批次完成、失败或阻断后通过父任务拥有的租约立即关闭；最终确认远程调试端口和临时 Chrome 目录为 0。

云端 Chrome 进程归零后，清理器还必须删除已关闭店铺 profile 下的 `SingletonLock`、`SingletonCookie`、`SingletonSocket`；只能对确认无该店 Chrome 进程的精确 profile 执行。日报收口同时核对进程、调试端口、Chrome 临时目录和这些 profile 锁，避免“进程为 0 但下批浏览器仍因旧锁无法启动”。

营销中心偶发 `application '/mbrs' died in status LOADING_SOURCE_CODE`、`Failed to load script` 或“渲染异常”时，根因是 `/mbrs` 微前端静态脚本首拉失败，不等同于店铺登录失效。`launch_store_browser.mjs` 对 `/#/mbrs/` 页面启动后必须先执行一次绕缓存强制刷新；错误文案仍存在时最多重试 3 次，成功后再做身份和业务检查，3 次仍失败才记录该店 blocker。提交脚本保留活动页未就绪时的二次防御性强刷。

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
9. 高点击低转化专属折扣：点击率入口和加车访客入口的符合条件、首批待确认、已保护、新增执行、阻断数量；并逐条反馈报名时基线与当前滚动 7 日曝光、加车访客、点击率、销量，标明“已出单/活动中仍 0 单/到期仍 0 单/缺指标”。效果仅作方向性对比，不把同期变化直接归因为折扣。
10. 报名库存事务：逐条给出平台最低值来源、补量前快照、临时覆盖量、恢复后快照、报名状态与是否精确恢复；任何 fail-closed 条件单列。
11. ET 低库存畅销品价格收回：标准货号、ET 当日库存、跨 19 店 30 天销量、Top5/普通链接档位、平台允许收回幅度、动作或人工特殊价审核项。

凡本轮新建或恢复限时折扣，日报必须逐条给出：店铺、标准货号与中文品名、SKC、活动 ID、价格、活动库存、开始时间、截止时间、动作结果和 live readback。不得只写“某店新建活动号/价格”。

无变化时返回 `DONT_NOTIFY`；有报名截止、漏报、写入、低价订单或平台阻断时必须通知。

## 8. 用户临时营销任务的处理规则

本交接任务不仅承接自动巡检，也承接用户后续主动下达的普通营销活动、限时折扣、成交价追因和营销价格栈任务。默认由主模型自己完成，不使用子代理。

### 8.1 普通活动方案

- 先读后台 live 活动页和当前最终版基准，不凭 BI 或旧 Excel 猜活动、可报数量和已报状态。
- 当前活动窗口继续读取 `tmp/marketing-signup/selection-plan-2026-07-15-v48217-48215-48925-final-executed-all-1063.json` 及同名 paired `price-overrides`。`2026-07-21` 已执行的 `v48732-48733-49565-final-executed-all-991` 及 paired `price-overrides` 是下一活动窗口基准；选择器只能在对应活动窗口启用它，不能因文件更新就提前覆盖仍生效的上一期目标。
- 基准只继承用户备注、固定价、特殊利润率、货号归并和已批准例外；新一期价格仍按最新 7 天链接曝光重新分层，不能简单继承同店同 SKC 上一期执行价。
- 新活动方案必须是人话版 Excel，至少包括 `说明`、`按货号汇总`、`店铺差异明细`、`报名明细`、`剔除项/阻塞项`、`低价补救/风险项`；除说明页外保留 `备注/修改意见` 列。
- `本期曝光前五/新链接前五行数` 表示命中两种待遇规则的报名明细行数，不代表有那么多个不同链接；展示时同时给出唯一链接数，避免把行数误读成链接数。
- 对新链接、新 SKC、重新上架链接，能按同标准货号全局 Top5、当前成本和最新最终基准推导的，必须直接定价，不能写“待定价”。
- 用户已经修改方案并明确说“可以开始报名”后，按已批准方案直接分批执行、回读并汇报；不要每批再次要求人工确认。
- `2026-07-29` 起，用户长期授权巡检自动补报“已经批准并执行中的普通活动，在报名截止前新出现的可报差额”。只要活动 ID 属于当前已批准批次，live 活动页仍在报名窗口内，且 `extraAvailableRows`、`outOfPlanRows` 或 `applyGoodsNum < allowGoodsNum` 证明存在新增行，就必须当轮生成 supplement、锁定批准来源、dry-run、提交并定点回读，不再逐次确认。补报优先克隆同店同 SKC 已批准价；没有同店批准行时按当前最终基准和既定 Top5/新品/备注规则算价。平台最低档低于批准价时按最低档提交并审计差额。算不清价格、身份不一致、活动已截止或平台硬拒绝时才保留 blocker。该授权不扩展到未批准的新活动方案、永久库存增加或优惠券；已获报名授权的活动可按本节事务式临时补量规则完成平台最低库存门槛。
- 批量执行前必须用 `lock_ordinary_campaign_execution_plan.mjs` 把用户批准原话、消息/任务来源、selection/price payload hash、文件 SHA-256 和 work fingerprint 写入不可变 approval manifest。store/chunk/singleton runner 必须读取同一 manifest；授权后文件变化、目标超出批准范围或 resume 证据 fingerprint 不同都要失败关闭。用户已批准整批后无需每个小批次再次确认，但不能省掉这份机器可验证的授权锁。
- 新方案的目标价只在对应普通活动生效窗口内用于订单审计。活动开始前的订单不能用未来目标价判低价/高价；活动结束后也不能继续套用过期窗口。

### 8.2 成本与仓储展示

- 给用户审核的普通活动方案必须分别展示商品成本、仓储费/件、含仓储完整成本、商品成本利润率和含仓储利润率；仓储费真实存在时两套结果不能做成一样。
- 商品成本和仓储费都按标准货号共享货盘取值，同一标准货号不得因店铺或 SKC 活动行缺字段而出现不同成本。链接级 live 响应缺仓储字段时，先回填 canonical 共享成本；不能把链接缺字段误报成仓库无记录。
- 已入仓但尚未开单的货号可能不出现在销售利润商品行；此时必须回查 `inventoryDepletion` 与 `mart.storage_fee_product_daily_cache`。库存为零销量时，按累计仓储费余额 / 当前物理库存计算共享仓储费/件。
- 仓储费缺失时要明确标记证据缺口，不能按 0 冒充“含仓储成本”；应优先回查成本源和货号归并。
- 自动限时折扣兜底当前获准按 `product_cost_excluding_storage` 做安全红线；因此“仓储费缺失不阻断自动兜底”和“普通活动审核表必须展示真实仓储费”是两个不同边界，不能混为一谈。

### 8.3 阻塞项分类

- 不能把历史 `excluded/blocked` 整包排除。用户已批准可报的历史剔除项，按批准利润率、固定价或成本口径进入方案。
- 只有缺商品成本/底价、身份异常、后台库存或平台规则阻断、货号无法可靠归并、混合人工特殊活动无法安全拆分时才 fail closed。
- `platform_saleable_stock=0` 只是 BI 线索；库存阻断必须由后台 `query_goods`、dry-run 或执行回读证明。

### 8.4 执行与收尾

- 写入前核对活动 ID、店铺身份、SKC、价格覆盖、平台最低降幅和活动窗口。
- 用户批准后的 `targetPrice/finalTargetPrice` 是审计基准。若报名页普通档/VIP 档的最低降幅会把价格继续压低，不再阻断或重复确认，直接按平台最低档报名；执行结果必须记录批准价、平台实际价、差额和 `below_target_due_to_platform_forced_discount`。2026-07-27 用户以 DL `48802 / sv260103161242703915999` 的 `60.32 -> 58.31 SAR` 实例明确长期授权。该授权仅限普通营销活动的平台强制档位，不覆盖人工特殊限时折扣和限时折扣利润/底价门禁。
- 订单审计必须同步使用平台强制最低档：优先读取已提交 `deadline-fill` 中的 `platformAdjustmentStatus/platformTierPrice`，历史缺失证据由 `config/marketing_ordinary_platform_tier_overrides.json` 补充。有效活动窗口内以平台档位价作为订单预期价，同时保留普通计划批准价作审计字段；不得再把精确命中平台档位的订单报成低价。
- 用户已批准方案后，先小批执行并在同一任务内继续完成其余安全店铺；遇到单店登录/接口异常时记录并继续其他店，不让一个店拖死整批。
- 候选 subset 只是待批准方案，不能自行标记 `submit=true`。只有显式 lock 后生成的 `*-user-approved.json + approval-manifest-*.json` 才能交给批量提交器；批量结果必须携带同一 work fingerprint。
- 每个写入组只回读受影响店铺/活动；整条 repair queue 结束后再做一次全店 live readback。不得在每个组后都重复全扫 19 店，也不得省掉最终全店闭环。
- 限时折扣组部分成功时，以 `createdActivityId + desiredCoveredSkcs` 作为精确续跑证据；已创建成功的 SKC 不得整组重放，只把未覆盖或明确阻断的 `storeKey + SKC` 留给下一批。`blockedTargetCount` 按唯一阻断键计数，progress 只能在本批所有选中组结束后写 `complete=true`。
- 无论成功、失败或阻断，本批浏览器立即关闭；最终确认调试端口和 Chrome 临时目录为 0。

## 9. 当前效率基线与防回退

- guard 只执行一次普通活动 stack review、一次当前营销价格 scan、一次报告/建队列；日更批次不再重复调用全店 `scan_current_marketing_prices_for_bi.mjs`。旧优惠券低价和旧普通活动五份中间扫描只留历史审计，实时 19 店证据完整时不再成为前置层。
- `2026-07-18 21:06` 生产基线：19 店普通活动与 15% 券规则直读、当前/未来普通活动和限时折扣价扫描、报告及队列合计 `157s`；`1516` 行、19/19 店成功，Chrome `0 -> 0`。该量级若再次明显升到十几分钟或数小时，必须按重复抓取、浏览器回退、清理碰撞或扫描夹带写入排障，不能把它解释为正常工作量。
- `scripts/marketing/merge_current_marketing_price_scans.mjs` 仍可把少量受影响店铺复扫覆盖进完整 19 店基线；失败店铺、重复店铺或 partial 基线时拒绝合并。生产 worker 当前选择“组级定点回读 + 队列结束后一次全店 readback”，不在每组后反复全扫。
- 普通活动和价格栈默认都使用 `--session-http`，禁止回退到逐店前端扫描作为日常默认。自动动作阻断与扫描失败分开记录：前者保留 queue blocker，后者才是巡检本身失败。

## 10. 最近批次归档

`2026-07-13`、`2026-07-15` 和 `2026-07-16` 的运行日志、活动 ID、回读和 warning 已移至 [2026-07-13-to-2026-07-16.md](archive/marketing-runs/2026-07-13-to-2026-07-16.md)。日常操作从本 runbook 的证据链和写入边界开始，历史结果不能替代当天 live evidence。

2026-07-17 对“67 条在售老链接漏兜底”做了完整收口：当天最新链接状态扩展后实际需处理 74 条，通过分批补报、逐 SKC ET 门控库存补齐和 TZZ 超时后独立 live 回读/重试，最终 19 店快照重建计划为 `actionable=0 / blocked=0`。根因修复集中在 `batch_apply_new_listing_limited_discount.mjs`、`manage_manual_limited_discount_inventory.mjs` 和 `build_new_listing_limited_discount_plan.mjs`；该日结果不得代替后续每日 live 差集。

2026-07-22 完整 live 差集最初生成 `401` 条动作；精确续跑后共为 `391` 条链接新建限时折扣，最终只剩 `6` 条因 ET 当日实盘不足 10 阻断，平台 `0004` 阻断已归零。普通活动 session HTTP 与价格栈最终回读均为 19/19，漂移 `belowTarget=0`，guard blocker 归零；逐条活动证据见 `outputs/reports/limited-discount-created-detail-2026-07-22.{json,csv,md}`。同日已把 `2026-07-21 v48732-48733-49565-final-executed-all-991` 最终基准同步到云端，并验证选择器仍按活动窗口使用上一期有效基准。

2026-07-28 普通活动 `49283/49286/50003` 首轮最终报名 `743` 行。首批安全清单 `720` 行完成后，用户明确批准原先仅因“含仓储成本利润率低于 15%”剔除的 `23` 行全部报名；补充行只豁免该筛选线，不配优惠券，活动价为 `52.95/57.39/224.69 SAR`。

2026-07-29 截止前 live review 又发现 `7` 行新增可报差额：`49283` 的 DX/HL/QY 各 `1` 行，`49286` 的 LQ `4` 行。已按用户长期授权完成 supplement、dry-run、真实提交和受影响店回读，并与上一轮基线合并为 `750` 行：`49283=595`、`49286=112`、`50003=43`。最终 19 店合并 live readback：`missingRows=0`、`priceMismatchRows=0`、`extraAvailableRows=0`、`activityListGapRows=0`、`badPacketActivities=0`。当前基准为 `tmp/marketing-signup/ordinary-gapfill-2026-07-29/merged/*final-merged-750.json`，由三个 approval manifest 的精确并集提升，禁止后续选择器回退到 720/743 行子集。

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
- `scripts/marketing/build_ordinary_excluded_rows_supplement.mjs`
- `scripts/marketing/merge_ordinary_campaign_plans.mjs`
- `scripts/marketing/merge_ordinary_activity_enrollment_reports.mjs`
- `scripts/marketing/promote_composite_ordinary_campaign_baseline.mjs`
- `scripts/marketing/apply_ordinary_campaign_canonical_price_rule.mjs`
- `lib/marketing_ordinary_platform_price_policy.mjs`
- `lib/marketing_ordinary_platform_tier_evidence.mjs`
- `lib/marketing_order_mitigation_history.mjs`
- `lib/marketing_limited_repair_status.mjs`
- `config/marketing_ordinary_platform_tier_overrides.json`
- `/srv/shein-bi/runtime/marketing_manual_limited_discount_overrides.json`（生产事实源；仓库 `config` 同名文件仅作本地/首次迁移种子）
- `lib/marketing_manual_limited_discount_overrides.mjs`
- `scripts/marketing/manage_manual_limited_discount_override.mjs`
- `scripts/marketing/batch_restore_manual_limited_discounts.mjs`
- `lib/marketing_high_click_special_policy.mjs`
- `scripts/marketing/build_high_click_special_discount_plan.mjs`
- `scripts/marketing/batch_apply_high_click_special_discounts.mjs`
