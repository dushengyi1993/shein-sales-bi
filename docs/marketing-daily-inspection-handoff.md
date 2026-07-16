# SHEIN 每日营销巡检交接（长期运维入口）

> 适用工作区：`E:\Codex WorkSpace\Shein销售统计`
> 生产目录：`/opt/shein-bi/app`
> 时间口径：`Asia/Shanghai`
> 当前自动化：Codex heartbeat `shein-daily`，每天 10:55 在专用任务中汇报 10:30 云端 guard 的最终结果。

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

价格栈浏览器扫描避开 browser cleanup `:10/:40`、奇数小时 ET `:20`、整点销售刷新、watchdog `:50` 及晨间/备份/订单闭环。普通活动 session HTTP 审核不打开浏览器，不得因为临近 cleanup 而跳过。

guard 尚未结束时，heartbeat 每 60–90 秒轮询，最长 30 分钟；结束后在同一次任务内读取报告、完成获准修复和汇报，不能只说“等待下个空档”。

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
- “即将开始/待生效”活动不等于当前生效活动，不能据此跳过当前兜底。
- 重新上架识别读取最近 60 天 `outputs/shein_links/<STORE>/YYYY-MM-DD.json`，保留 `lastInactiveDate/relistedAt/treatmentType`。
- 若最终计划缺该货号目标价但成本存在，默认以 30% 基础利润率、Top5 下调 5 个点且不低于 15% 底线自动推导。

价格漂移修复：

1. 从旧限时折扣活动删除漂移 SKC；旧活动混有其他非漂移 SKC 时，只删除目标 SKC，不结束其他商品。
2. 为目标 SKC 按 `finalTargetPrice` 新建限时折扣。
3. dry-run、execute、readback 后关闭浏览器。
4. `0004/0006/101018`、身份不一致等平台阻断必须保留证据，不硬写。库存不足按 2026-07-16 新授权先执行 ET 门控补齐；ET 不足、缺当天证据或补齐回读不一致时才保留阻断。

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

这些动作使用 `config/marketing_pricing_policy.json` 中 `owner-standing-cloud-marketing-v1` 的负责人长期授权，timer 不逐次索要 payload hash。每个写入仍必须满足授权上下文/动作范围、身份校验、价格栈校验、库存/平台规则、dry-run、execute、审计和 readback。普通活动、优惠券和预算不在长期授权内，只生成方案，得到对应业务授权后才提交。

timer 的写阶段严格串行：人工特殊折扣恢复 -> 目标价漂移修复 -> 新链接/重新上架兜底。任一阶段失败后，后续写阶段必须跳过，避免基于旧 guard 继续写；随后仍运行最终 live scan/guard，完整记录部分成功、失败和跳过项。

2026-07-16 起，以上已授权限时折扣链路若平台可报库存低于计划 `activityStock`，允许先查询 ET 当日实盘：ET 可售库存足够时，只把平台虚拟库存精确补到本次 `activityStock`（默认 10），回读一致后重新 dry-run 并完成兜底；ET 不足、证据非当天或回读不一致时必须阻断。该授权覆盖目标价漂移、新链接/新上架 7 天、重新上架无活动和漏限时折扣，不扩展到普通营销活动报名库存、优惠券或任意扩大平台库存。

人工特殊折扣的“已覆盖”不是只看价格：live 证据必须同时证明精确价格、活动库存不少于登记 `activityStock`、活动截止时间不早于登记 `validTo`。新建/恢复后必须按活动 ID、价格、库存和截止时间逐项精确回读；缺字段也视为证据不足并进入恢复/阻断，不得报绿。

浏览器必须在每批完成、失败或阻断后立即关闭；最终确认远程调试端口和临时 Chrome 目录为 0。

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
- 少量补报只回读受影响店铺/活动，并与最新成功的完整全店证据合并；不要每次都重复扫 19 店。
- 无论成功、失败或阻断，本批浏览器立即关闭；最终确认调试端口和 Chrome 临时目录为 0。

## 9. 已知运行效率问题

- `scripts/marketing/merge_current_marketing_price_scans.mjs` 已支持把少量受影响店铺的复扫结果覆盖合并进最新成功的完整 19 店快照；输入的完整基线和每个 overlay 都必须成功、店铺键唯一，失败店铺或基线 partial 时拒绝合并。
- `scripts/cloud_marketing_live_guard.sh` 尚未自动接入该合并器，发生自动动作后仍会再次全量扫描 19 店，导致有动作的巡检常需 15–25 分钟。后续只需把“收集受影响店铺 -> 定点复扫 -> 合并 -> final guard”接入 shell，不再重复实现合并逻辑。
- 普通活动审核已经改用 `--session-http`，19 店约 3 分钟且不打开浏览器；禁止回退到逐店前端扫描作为日常默认。
- 自动动作部分阻断时 service 当前会以 warning/exit 1 结束，watchdog 可能显示 failed；汇报必须区分“完整扫描成功但部分商品平台阻断”和“扫描本身失败”，不能把两者都说成巡检卡死。

## 10. 最近批次归档

`2026-07-13`、`2026-07-15` 和 `2026-07-16` 的运行日志、活动 ID、回读和 warning 已移至 [2026-07-13-to-2026-07-16.md](archive/marketing-runs/2026-07-13-to-2026-07-16.md)。日常操作从本 runbook 的证据链和写入边界开始，历史结果不能替代当天 live evidence。

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
