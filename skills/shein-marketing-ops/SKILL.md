---
name: shein-marketing-ops
description: SHEIN 营销活动报名、优惠券、限时折扣和价格栈守卫专用工作流。用户提到 SHEIN 报活动、营销活动报名、普通活动、优惠券活动、15%券、30%/50%券、限时折扣、低价/高价成交、旧活动叠加、活动方案 Excel、店铺批量提交、price-stack guard、43914/43915/45488/34810 等场景时必须使用。该 skill 要求先做云端/live 证据、价格栈核算、首店确认、分批提交、回读验证和人工授权补救计划，不能凭提交成功弹窗或旧表格下结论。
---

# SHEIN Marketing Ops

## 适用范围

用这个 skill 处理 SHEIN 营销价格栈相关任务：

- 生成普通营销活动报名方案、用户审核 Excel、按货号汇总和店铺差异表。
- 执行普通营销活动报名、优惠券活动报名、限时折扣补救、旧活动叠加止损。
- 解释或排查低价/高价成交、漏报、错报、优惠券预算、活动重叠风险。
- 维护每日 guard / heartbeat / 可选流量券提醒 / T-3 活动提醒。

不要用它替代普通销售抓取、BI 页面开发、ET/RTV 同步等非营销价格栈任务；这些仍走 `shein-sales-ops` 或项目文档。

## 核心模型

营销价格栈只有一个最终目标：实际成交价不能低于或高于当前用户批准的目标价。

价格栈层级：

1. 当前售价 / 商品可售基准价。
2. 普通营销活动价，包括旧普通活动、度假季、当前要报的活动。
3. 限时折扣价。
4. 优惠券，当前只允许研究或在明确授权的“流量/高曝光/滞销/清货试验”场景使用优惠券活动 `34810` 里的 `15% OFF` 档；`34810` 是活动 ID，不是折扣率。30%/50% 只能研究，不能上线。

`2026-06-21` 后的三层优先级硬规则：

1. **普通营销活动必报，优先级最高。** 只要商品符合当前策略、活动仍在报名窗口内、平台允许报名，就必须优先报普通营销活动；限时折扣覆盖、当前售价达标或优惠券存在，都不能当作“不报普通营销活动”的理由。发现普通活动漏报时，先补普通活动或列出不可报阻断，再处理兜底层。
2. **限时折扣也必报，但只定位为兜底层。** 它不能替代普通营销活动；普通活动已报/待生效时仍要存在限时折扣兜底，默认按当前售价 `15%` 折扣，若折后低于当前有效计划 `finalTargetPrice` 或底价/利润安全线，则缩浅折扣比例或直接兜到目标价。
3. **优惠券只做小批量流量实验。** 优惠券不是保底价层，不能用来证明成交价会到目标价；若 `34810/15%` 流量券会和普通活动/限时折扣叠加打穿目标价或安全线，必须取消、排除或等待，不得让券干扰主活动与兜底层。
4. **巡检和执行顺序固定为：普通营销活动漏报/待报 → 限时折扣缺口/错价 → 优惠券实验冲突。** 已有限时折扣只能说明兜底层可能存在，不能清除普通营销活动漏报；已报普通营销活动也不能清除限时折扣缺口。
5. **结构覆盖和价格覆盖分开验收。** `店铺 + SKC + 活动窗口` 必须分别给出普通营销活动状态、限时折扣状态和优惠券状态；限时折扣价命中目标价只能证明兜底层有效，不能证明普通营销活动已报或无需报名。
6. **优惠券冲突时券让路。** 若已存在 `34810/15%` 实验券，且限时折扣/普通活动按目标价执行后触券会低于目标价或安全线，不能为了保留券而调高/取消兜底层；应取消或排除该实验券，并回读确认。

`2026-06-14` 后的新硬规则：优惠券不是每单必然触发，所以优惠券不能再作为保底成交价层。保底成交价必须由当前售价、普通营销活动价或限时折扣价直接命中当前有效计划的 `finalTargetPrice`。

`2026-06-21` 后的巡检硬规则：不能只依赖 BI。BI 只负责发现经营线索（新链接、新 SKC、订单成交价、曝光、库存），不能证明营销后台是否真的报了普通活动或限时折扣。每日巡检必须有 SHEIN 后台 live 证据：优先云端可用浏览器；没有云端浏览器时使用本地店铺 profile 小批次扫描，并在跑完后关闭浏览器。

限时折扣是所有在售运营链接的必备兜底层，但它只是兜底层，不能替代普通营销活动，也不能清除普通营销活动漏报；不再是“没有普通活动才报”的补救项：

- 没有当前或即将生效的普通营销活动时，限时折扣直接兜到当前有效计划 `finalTargetPrice`。
- 有当前或即将生效的普通营销活动时，也必须有一层限时折扣，默认按当前售价 `15%` 折扣。
- 若默认 `15%` 折后价低于 `finalTargetPrice` 或底价/利润安全线，必须缩浅折扣比例，使限时折扣价不低于目标价。
- 已有生效限时折扣但价格不符合上述规则时，先判断是否为单一目标活动。只包含目标 SKC 的旧限时折扣可以在 dry-run 安全后修改、取消后重建；若同一限时折扣活动里还有计划外 SKC、价格看起来是人工特殊处理、或无法确认活动归属，必须 fail closed 生成阻断/人工确认清单，不能自动覆盖。
- 自动补限时折扣前必须做折扣比例缩放：若 `当前售价 × 0.85 >= finalTargetPrice`，可用默认 `15%`；若低于目标价，只能选择平台允许的更浅折扣或直接用目标价兜底。若平台最低折扣要求导致无法既满足折扣规则又不低于目标价，禁止自动写入，报告阻断。
- 不能因为 BI 标签看起来正常就 no-action；也不能因为 live 发现一个旧限时折扣就假定它安全。

真实止损判断分两层：

```text
保底成交价 = 最低有效基准价（不假设优惠券触发）
风险下探价 = 最低有效基准价 × couponFactor（只用于“如果券触发是否会低于目标”的风险测算）
```

- `couponFactor=0.85` 表示历史计划或候选策略里含 15% 券，但不能自动等同于“最终成交价必为券后价”。
- 最低有效基准价必须合并同一时间窗口内的当前售价、普通营销活动价、限时折扣价、已知旧普通活动填报价等证据。
- 低于目标价或缺证据时 fail closed：宁可暂缓，不硬报、不凑数量。
- 若保底成交价高于目标价，优先用普通活动或限时折扣兜底；不要靠优惠券把目标价“算下来”。
- 若风险下探价低于目标价，说明券一旦触发会低于目标，必须禁止/取消该券或提高基准价。
- 优惠券按 `店铺 + SKC` 生效，不按普通活动隔离；同一 SKC 任一活动价都会被券影响。
- 新报名方案里，只有明确标记为“可选流量券/高曝光支持/全店滞销高库存清货试验”的 SKC 才能进入 `34810/15%` 券方案；普通“`couponFactor=0.85` / `普通活动 + 仅15%券`”历史口径必须迁移为“普通活动或限时折扣直接保底，不配券”。

## 证据优先级

先查当前真实系统，再看计划文件。

1. live 后台证据和订单商品行：SHEIN 后台普通活动已报/审核中集合、限时折扣 live 查询、优惠券已报集合、订单商品行 `currencyPrice`。
2. 云端 BI 快照：只作经营线索和候选缩小，不作“已报/未报/无需限时折扣”的最终证据。
3. 本轮用户确认后的 `selection-plan` + `price-overrides`，必须是当前方案文件，不能沿用旧 `ALL-ready` 或未修复版本。
4. 本地历史报告只作线索，不能替代 live 回读。

特别注意：

- 订单成交价只认每个订单商品行的 `currencyPrice`；不要用页面商品总价、预计收入汇总金额或 `summary.salesSar` 判断成交价。
- BI 判断和验收默认只认云端运行态、线上 section API、云端日志和云端数据库；不要拿仓库 `outputs/bi-portal/data.json` 当当前经营真相。
- 店铺身份必须校验 `profileKey`、保存账号、实际登录账号/店铺名、`config/stores.json`、`config/store_account_truth.json`。身份不一致时禁止写入。
- 登录页不是停机条件。任何 SHEIN 营销 live scan、普通活动报名/回读、限时折扣、优惠券提交/取消、身份校验脚本，遇到登录页必须先走统一自动恢复：优先点击“继续登录 / 我已知晓，继续登录”，必要时刷新后再试；恢复后必须立刻做店铺身份校验。只有空账号/空密码、验证码/安全验证、或恢复后身份不一致，才算真实阻塞并报告具体店铺。
- 普通活动填价证据有生命周期：同一 `storeKey + activityId + skc` 只能用最高可信度且最新的一条证据；已撤回或已被后续正确提交覆盖的旧填价不能继续污染价格栈。

## 定价和曝光规则

使用当前项目规则和用户确认后的最新计划，不要临场发明利润率。

- 后续每次生成/填报普通营销活动方案，必须以上一次用户确认并已经真实执行或等待执行的“最终版” `selection-plan + price-overrides` 为基准，继承其中的用户备注、固定价、特殊利润率、允许低于默认红线的例外、货号归并和小数微调；不能回到旧草稿、默认利润率或重新扫描后的默认策略从头重算。新一轮云端/后台数据只用于发现新增链接、活动页新增可报行、曝光 Top5 变化、平台最低降幅、成本/库存变化和旧证据失效，并且必须在 source summary / 执行方案里写明 baseline 文件路径。找不到可靠上期最终版时，先报告 blocker，不能直接出可执行方案。
- 普通活动填报价不要批量使用整百/整数固定价。用户已确认：固定价或用户备注价可以在不越过平台价格上限、目标价底线和利润/成本安全线的前提下做几毛钱级别的小数微调，例如 `160` 可填成 `159.57` 或 `160.28`。执行前必须检查 `price-overrides` 中目标行不存在整数价；若仍有整数价，先生成 `jitter` 修正版并用修正版预填/提交，不能沿用未微调旧文件。
- 曝光前五：维度是“同一个标准货号在所有店铺、所有链接中的 7 天曝光 Top 5”，不是每店前五。
- 新链接/新 SKC 不能简单报“待定价”：若可由最新最终版基准、同一标准货号全局曝光 Top 5、成本/仓储费/底价推导出安全目标价，就生成 supplement/rescue 并自动做限时折扣兜底；只有缺成本、缺仓储费/底价、缺目标价、身份异常、库存或平台规则阻断时才 fail closed。
- 高曝光力度：如果原本目标利润率较高，可以让全局曝光 Top 5 的链接利润率降低 5 个点，但不能低于底价/利润底线；如果原本目标利润率已经低，例如 15%，不要继续压低 Top 5，而是把其他链接利润率提高 5 个点。
- 剔除项若用户明确批准可报，按用户批准的利润/成本口径进入方案；未批准前必须单列，不得暗中并入。
- 缺成本、缺目标价、缺仓储费或货号归并不可靠时先补证据；补不到就 fail closed。
- 平台最低降幅会把普通活动价压低时，普通活动价本身就是保底成交价候选；若普通活动价低于 `finalTargetPrice - 1 SAR`，禁止提交该组合；若仅 `普通活动价 × 0.85` 低于目标，禁止配券但普通活动可按“不配券”方案单独评估。

## 用户审核方案格式

给用户看的方案必须是人话版 Excel，不要只给 800 行代码字段 CSV。

默认输出 `.xlsx`，至少包含：

- `说明`：本轮活动、报名窗口、生效窗口、核心策略、禁区、证据来源。
- `按货号汇总`：标准货号、产品名、可报行数、店铺覆盖、预期利润率、预期最终价、普通活动填报价、是否使用可选 15% 流量券、触券下探价、全局曝光 Top 5 说明、剔除/阻塞原因。
- `店铺差异明细`：同一货号不同店若方案不同，必须说明差异来自售价、成本、曝光、平台最低降幅、旧活动、库存或用户备注。
- `报名明细`：店铺、活动 ID、SKC、标准货号、当前价、普通活动填报价、finalTargetPrice、couponFactor、触券下探价、利润率、来源、备注。
- `剔除项/阻塞项`：缺证据、禁券、旧活动叠加、平台最低降幅等。
- `低价补救/风险项`：已成交低价、需要取消/等待/下架/观察的项。
- `15%券流量试验计划`：只列明确允许把券作为流量工具的店铺+SKC，必须说明“即使券不触发，保底成交价也符合当前策略；若券触发，不低于底价/利润线”。不要再写成“券后目标成交价保障”。

除 `说明` 页外，所有 sheet 都要有 `备注` 或 `修改意见` 列，方便用户标注。

## 执行流程

### 0. 执行页新增可报 SKC 的补漏规则

方案生成依赖云端 BI / 链接抓取 / 活动扫描，但这些源可能在报名前未覆盖所有可报名 SKC。执行页或回读页才出现的新 SKC，不是“可以忽略的差异”，必须立刻补进系统：

- 只要活动页 `totalGoods > allowlist expectedSelectedCount`、`selection.outOfPlanRows` 非空，或活动列表显示 `已报数量 < 可报总数`（`applyGoodsNum < allowGoodsNum`）且差额不在当前最终计划里，就视为漏报候选；不能只看计划内 `missingRows=0` 就宣布没漏。
- 先读取新增 SKC、供方货号、当前价和平台最低降幅；能归并到同店同 SKC 已批准活动的，优先克隆同店同 SKC 的 `targetPrice/finalTargetPrice/couponFactor/combo`，避免同一链接在不同普通活动里价格栈漂移。
- 若没有同店同 SKC 既有批准价，再按当前定价/曝光规则即时算价；算不清或缺成本时 fail closed，不硬报。
- 补报必须生成新的 supplement `selection-plan` / `price-overrides`，并合并出新的全量 repaired plan；后续 guard、可选流量券和订单审计必须改用最新全量 plan。
- 补报后必须回读已报/审核中集合，并要求 `missingRows=0`、`priceMismatchRows=0`、`extraAvailableRows=0`、`activityListGapRows=0`。

### 1. 准备和刷新

- 读取当前执行记录，例如 `.codex/plans/2026-06-05T12-14-21-marketing-automation-system.md`。
- 刷新只读 guard，优先使用云端 BI：

```powershell
node scripts/marketing/build_marketing_daily_guard_report.mjs --date <Asia/Shanghai YYYY-MM-DD> --max-age-hours 96 --cloud-bi-ssh shein-bi-tencent --cloud-bi-root /opt/shein-bi/app
```

- 检查 `blockers`、`sourceWarnings`、`unknownSources`、`orderPriceAudit`、`knownOrdinaryActivityGuard`、`lowPriceOverlap`、`oldOrdinaryOverlap`、`couponBudget`、`t3MarketingCandidates`。
- 需要真实写入前，校验店铺身份：

```powershell
node scripts/marketing/check_store_profile_identity.mjs --stores <stores> --no-close
```

### 2. 生成并验证方案

- 用最新云端数据和用户规则生成本轮 `selection-plan` / `price-overrides`。
- 方案文件名必须体现范围和关键修复，例如 `include-excluded-approved`、`qh7025-pure75-repaired`；不要覆盖旧文件导致误用。
- 静态验证：

```powershell
node --check scripts/marketing/dsy_marketing_deadline_fill.mjs
node --check scripts/marketing/submit_coupon_activity_goods.mjs
node scripts/marketing/verify_marketing_sku_approval.mjs --workbook <xlsx>
```

- 确认 `selection-plan` 与 `price-overrides` key 对齐，无空价、无 0 价、无重复冲突。

### 3. 首店确认

首店必须先预填普通活动但不提交，让用户看页面。

```powershell
node scripts/marketing/dsy_marketing_deadline_fill.mjs --stores <pilotStore> --activity <ids> --selection-plan <pilot-selection.json> --price-overrides <pilot-price.json> --no-close
```

只有用户确认后，才能提交首店：

```powershell
node scripts/marketing/dsy_marketing_deadline_fill.mjs --stores <pilotStore> --activity <ids> --selection-plan <pilot-selection.json> --price-overrides <pilot-price.json> --submit --no-close
```

提交后必须回读普通活动已报/审核中集合：

```powershell
node scripts/marketing/verify_ordinary_activity_enrollment.mjs --stores <pilotStore> --activity <ids> --selection-plan <pilot-selection.json> --price-overrides <pilot-price.json> --no-close --wait-ms 120000
```

要求：`ok=true`、`missingRows=0`、`priceMismatchRows=0`、`badPacketActivities=0`。

### 4. 首店优惠券流量试验（默认不做）

普通活动回读 OK 后，默认不再补 15% 券。只有用户明确批准“高曝光支持/滞销高库存引流/清货试验”的 SKC，才先 dry-run 15% 券：

```powershell
node scripts/marketing/submit_coupon_activity_goods.mjs --stores <pilotStore> --activity-id 34810 --discount-max 15 --target-plan <pilot-selection.json> --price-overrides <pilot-price.json> --dry-run --no-close
```

只提交 dry-run 中通过价格栈守卫且被标记为可选流量券的目标；若旧普通活动、普通活动价、限时折扣或当前售价导致触券后低于目标/底价，暂缓，不硬报。

真实提交仍用同一命令去掉 `--dry-run`，并要求 `afterEnrolled` 增加、`wait.remaining=[]`。

### 5. 分批自动执行

首店普通活动确认无误后，其他店可以分批自动完成；可选流量券只有在用户明确批准对应清单后才进入同批 dry-run/提交流程。

- 每批先提交普通活动。
- 每批立刻回读普通活动。
- 每批不再默认配套 15% 券；如本期有用户批准的可选流量券清单，只对该清单 dry-run。
- 只对安全店铺/安全 SKC、且明确是流量用途的目标提交券。
- 每批结束关闭浏览器，降低卡顿和串号风险：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/close_store_browsers.ps1 -Stores <stores>
```

推荐批次控制在 3-4 店，遇到登录失败、身份不一致、价格 mismatch、接口异常、guard fail 立即停机。

### 6. 全局复核

全部普通活动提交后需要回读，但不能无脑频繁全量打开 19 个前端 profile。复核范围按风险分级：

- 大批量真实提交刚完成时，可以做一次全量回读，作为最终验收。
- 用户指出漏报、脚本发现 `extraAvailableRows`、或只补少量店铺时，默认只回读受影响店铺/活动；其余店铺沿用最新成功的全量回读证据。
- 限时折扣少量补报后，用 `scripts/marketing/merge_current_marketing_price_scans.mjs` 把受影响店复扫覆盖进最新成功的完整 19 店价格快照，再生成 final guard。系统刚创建、名称和价格命中规则但尚在平台生效延迟中的未来限时折扣算“已排期待生效”，不能重复创建；未来普通活动仍不能替代当前兜底或提前用于订单审计。
- 日常 heartbeat 不能只读云端 BI 就输出 no-action。必须先有当天或足够新鲜的 SHEIN 后台 live scan/readback，直接覆盖普通活动、限时折扣、优惠券集合；没有 live 证据时，必须补扫或报告具体登录/浏览器/身份阻塞。
- live 巡检优先用云端可用浏览器；没有云端浏览器时才用本地 profile。使用本地时按 3-5 店小批次执行，跑完立即关闭浏览器，避免影响用户正常使用电脑。

普通活动回读命令：

```powershell
node scripts/marketing/verify_ordinary_activity_enrollment.mjs --stores <allStores> --activity <ids> --selection-plan <selection.json> --price-overrides <price.json> --wait-ms 120000
```

如本期有用户批准的可选流量券清单，处理后必须跑全局 dry-run；如果没有明确流量券清单，不要生成补券 dry-run：

```powershell
node scripts/marketing/submit_coupon_activity_goods.mjs --stores <allStores> --activity-id 34810 --discount-max 15 --target-plan <selection.json> --price-overrides <price.json> --dry-run
```

验收口径：

- 普通活动：计划行全部在已报/审核中集合，缺失 0，硬性价格不一致 0，页面计划外可报名 `extraAvailableRows=0`，后台已报/可报差额 `activityListGapRows=0`。
- 验收必须显式使用当前最终版 `selection-plan + price-overrides`；若单店结果文件被演示预填/不提交覆盖，不能据此判定未提交，应以 live 回读或可继承的成功回读证据闭合。
- 已报接口不回传活动价时，可以用同一 `store + activity + skc` 的提交前填价复核文件作为价格证据；但必须标出 `priceUnavailableButFillVerified`。平台最低降幅造成的小幅压价（例如差额低于 `1 SAR`）不算硬性错价，仍要记录来源。
- 优惠券：价格保障券应为 `0`；可选流量券当前可立即安全新增 `toSubmit=0`；剩余未报必须有明确阻断层和结束时间。
- 产物要有人话版汇总，例如 `outputs/reports/marketing-signup-<activities>-final-status-YYYY-MM-DD.md/json` 或 `outputs/reports/marketing-m12-coupon-final-status-YYYY-MM-DD.md/json/csv`。

### 7. 活动生效后验收

报名完成不是最终完成。活动正式生效后，还要用订单商品行和当前计划窗口做验收。

- 每日 guard 必须使用当前用户批准并已执行的 `selection-plan + price-overrides`，不能回退旧计划、默认利润率或无窗口历史计划。
- 每日 guard / 新链接动作卡必须优先选择当前最新已执行全量计划；`2026-06-14` 后应优先使用不依赖优惠券保底的批次。若误用旧 `all-934`、旧 `ALL-ready` 或历史批次计划导致“新链接 / 新 SKC 缺兜底”候选，先修正计划选择并重跑 guard；但修正计划选择后仍必须用 live scan 判断普通活动和限时折扣是否真的覆盖，不能用 BI/计划文件替代后台结果。
- 每日巡检发现新链接、新 SKC、活动页新增可报 SKC 或 live 已报数量少于可报/应报数量时，必须进入动作卡：普通活动未授权时提醒用户；限时折扣缺失且价格/库存/平台校验可通过时，允许自动兜底并回读。活动开始前按已报/待生效和兜底层验收；订单成交价低/高于本期普通活动目标的 blocker 从活动实际开始时间后计算。
- 新链接候选必须把 BI `linksData` 与截至报告日各店最新原始 `outputs/shein_links` 快照按 `store+SKC` 合并；原始快照只追加 BI 缺失键，不覆盖 BI 已有字段。live 活动扫描只枚举活动商品，不能单独证明“所有在售链接均有活动”，所以不得在原始链接源比 BI sidecar 更新时输出无缺口。原始快照覆盖少于当前启用店铺数或有解析错误时，guard 和计划器都必须 fail closed，不得生成“无缺口”结论。
- 2026-07-16 用户已授权自动限时折扣兜底库存补齐：目标价漂移、新链接/新上架 7 天、重新上架无活动、漏限时折扣若仅因平台可报库存低于计划 `activityStock` 阻断，先查 ET 当日实盘；ET 足够时精确补平台虚拟库存到计划数量并回读，再重跑 dry-run/execute。ET 不足、证据过期或回读不一致时阻断。不得扩展到普通营销活动库存、优惠券或任意增库存。
- 新建或恢复限时折扣后的用户报告必须逐条写明店铺、标准货号与中文品名、SKC、活动 ID、价格、活动库存、开始/截止时间和 live readback 结果；不能只报活动号和价格。
- 订单审计必须按活动生效窗口判断；窗口外订单只能作为历史线索，不能当成当前活动低价/高价 blocker。
- 订单成交价只认商品行 `currencyPrice`。如果 `currencyPrice` 低于或高于当前活动窗口目标价，必须按 `店铺 + SKC + 标准货号` 归因到普通活动、限时折扣、优惠券、旧活动、平台最低降幅或缺证据。
- 如果用户本期批准了低利润率、清货价或剔除项可报，这些目标就是新预期价；巡检不能再按旧默认利润率重复报警。
- 生效后如果没有低价/高价偏离、旧活动/限时折扣/优惠券风险均已按新价格栈处理或明确阻断，且身份/证据均 OK，才可以把本轮活动状态从“等待生效观察”降级为日常巡检。

## 自动补券和每日 guard

旧规则“旧活动结束后自动补券”已废止为默认动作。因为优惠券不必然触发，自动任务不能为了达成目标价自动补回价格保障券。

- 设置或更新 heartbeat，不要创建重复任务。
- 自动任务默认先做 live 观察，不再是“只读 BI”。source stale 不能直接触发无差别全店开前端，但如果没有当天/新鲜 live 后台证据，必须小批次补扫或报告具体阻塞，不能 no-action。
- 自动任务不得生成“价格保障补券”建议；只有当前计划明确存在 `allowed15_traffic` / 可选流量券目标，才允许生成 dry-run 命令，仍不得真实提交。
- 真实提交 15% 券必须由用户当前线程明确授权，并且执行后回读 `afterEnrolled` / `wait.remaining=[]`。
- 自动任务也不得上线 30%/50% 券，不得真实取消优惠券、补预算或无证据取消普通活动。新链接/漏限时折扣的兜底限时折扣是唯一默认可自动处理的写入类动作，但必须满足身份校验、价格栈校验、库存/平台校验、dry-run 和执行后回读。

## 优惠券预算守卫

预算只影响“可选流量券”能否使用，不再是目标成交价能否达成的保底条件；自动任务不能为了清 blocker 擅自补预算。

- 旧默认目标是活动 `34810`、站点 `shein-sa`、币种 `SAR` 每店周预算至少 `1000 SAR`；新流量券策略下必须先按高曝光/滞销候选规模重新测算，不能默认全店 `1000 SAR`。
- `couponBudget` 只能接受两类完成证据：
  - fresh `execute` 结果，并且 scope 是 `34810 / shein-sa / SAR / >=1000`；
  - fresh `readback_current` 只读回读，并且 artifact 必须是 `mode=readback`、`readOnly=true`、`execute=false`、`writeAttempted=false`、`writeEndpointCalls=0`，每个店铺行也必须没有写入痕迹。
- `dry-run` 或页面观察只能作为线索，不能清除预算 blocker。
- 如果 guard 提示缺预算证据，优先运行只读回读：

```powershell
node scripts/marketing/set_coupon_site_budget.mjs --stores <stores> --activity-id 34810 --budget 1000 --read-only
```

- 只有用户在当前任务中明确授权“补预算/execute”，才允许把预算写到 `1000 SAR`；写完还必须回读，不能只看接口返回。
- 如果回读 artifact 的活动 ID、站点、币种、预算、店铺覆盖或 `writeEndpointCalls` 不符合上述条件，guard 必须 fail closed。

## 停机条件

出现任何一项，停止写入并报告：

- 店铺身份不一致或登录态异常不能恢复。
- 直接把登录页当失败退出，而未先自动点击“继续登录/登录”并刷新重试，是流程错误；必须改成自动恢复后再判断。
- 普通活动填价 mismatch、缺成本、缺目标价、缺仓储/成本证据。
- 页面“成功”但 live 已报集合缺失。
- 优惠券被当成价格保障层，或 dry-run 出现旧普通活动、普通活动价、限时折扣、平台最低降幅导致触券后低于目标/底价。
- 30%/50% 或高于 15% 券进入执行建议。
- 同一店铺+SKC 有多个活动层冲突，无法确定最低有效基准价。
- 用户要求先给方案，但脚本准备真实提交。

## 报告给用户的方式

用户不想看机器字段大表。最终报告用中文短结论：

- 已完成：哪些店、哪些活动、多少行，回读结果。
- 优惠券：已取消多少价格保障券；是否有明确批准的可选流量券；预算是否需要按新方案调整。
- 修复：本轮发现并修了哪些系统级问题。
- 剩余风险：是否只是等待活动生效/旧活动结束，还是需要人工登录/补证据。
- 证据入口：列关键 `.json/.md/.xlsx` 路径。

不要把“提交成功/导入成功”当完成；完成必须有 live 回读或后续 dry-run 证据。
