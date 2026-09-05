# V6 A1/B2 营销明确价格与会话生命周期实施及验收报告

- 实施分支：`codex/bi-v6-repair-20260905`
- 工作树路径：`E:\Codex WorkSpace\.worktrees\Shein-BI-V6`
- 基线 commit：`7d5e38756e519e9daa76854925e7b2ee0b321b50`
- 实施模块范围：A1 明确价格贯穿与严格店铺作用域防污染，B2 营销会话生命周期管理与多步保持，Profile lease 校验，以及受权文档增量同步。

---

## 一、A1：明确指定商品店铺价格贯穿与严格隔离验证

### 1. 根因与反例修复分析
- **单价格式与店铺维度丢失**：原 `scripts/marketing/build_marketing_sku_approval.mjs` 中，`parseRemarkRule` 无法识别单价格式（如 `FY 37 SAR`），且丢失店铺维度（`storeKey`）约束。
- **平台 Cap 强制截断**：`initialTargetPrice` 强制执行 `Math.min(uncappedActivityPrice, cap)`，导致当用户明确指定价格（如 37 SAR）高于平台最低降幅上限（如 30 SAR）时，价格被静默削减为 30 SAR，篡改了用户定价。
- **Jitter 整数微调破坏**：`jitterIntegerTargetPrice` 会对整数报价进行小数偏移（如 37 变成 36.83 或 37.13 SAR），破坏了明确指定价事实。
- **反例与全局豁免污染缺陷修复**：原代码在 `inferBaselineRule` 中由于 `isUserExplicitPrice` 直接把全货号判定为 `allowBelowFloor: true`，导致当用户仅对 FY 显式定价 37 SAR 时，同货号的 DL 店铺（即使已知成本且利润率低于红线）也因被误判为全局允许红线以下而获得豁免。本次修复严格将显式价豁免 scope 到该店/链接：
  - `allowBelowFloor` 仅在用户显式全货号批准或无店名备注时才设为 true；当有具体 `explicitStoreKey` 时，全局 `allowBelowFloor` 保持 false；
  - 只有显式指定的店铺链接放入 `allowBelowFloorLinkKeys`；
  - `jitterIntegerTargetPrice` 中的 `minMargin` 同样支持检查特定链接豁免，避免误用全局标志；
  - 行级判断 `baselineAllowsBelowFloor` 仅认可当前行显式定价或本链接 linkKey 豁免；
  - 成本已知且低利润的非指定店铺（如 DL，已知成本 60，目标价 65，利润率 7.7% < 15% 红线）严格被 `row_full_cost_including_storage_margin_below_floor` 阻断剔除，彻底杜绝 FY 显式价对其他店铺的豁免污染；
  - 下游执行（模拟下游限时折扣/普通营销 policy dryrun）读取生成的 `price-overrides`，FY 的 `finalTargetPrice`/`targetPrice` 始终精确为 37 SAR。

### 2. 代码实际修改（`scripts/marketing/build_marketing_sku_approval.mjs`）
- **精确店铺范围解析**：扩展 `parseRemarkRule`，识别标准店铺标识（`storeKey`，如 `FY`），规则绑定到精确店铺 `storePrices: { FY: 37 }`，未指定店铺保留原规则。
- **杜绝静默改价与 Jitter**：在 `rowStrategyFor` 中识别当前行的 `isExplicitPriceForRow`。当用户明确指定该店价格时，`initialTargetPrice` 直接保留明确价格，不因低于/高于平台 cap 而被强制改写；跳过微调，保持原始整数价（如 37 SAR）。平台 cap 冲突仅标记 `platformConstrained`，不修改价格事实。
- **店铺级严格豁免隔离**：`allowBelowFloorLinkKeys` 仅向显式指定店铺注入。其它店铺若成本已知且低于红线，严格按常规利润线剔除。
- **成本未知防御与如实呈现**：修复 `normalizeReviewRow` 在全量成本未知时的空指针防御；审批表展示为“利润暂算不出”；当行具备显式定价时，不作为 `missing_cloud_product_cost` 剔除，`selected: true` 并进入执行计划。

---

## 二、B2：真实营销会话生命周期与登录恢复及 Profile Lease 校验

### 1. 根因与原代码缺陷分析
- `scripts/auto_relogin_shein_store.mjs` 在 GSP 订单管理页成功后，若 `marketingProbe` 失败仍退回 `sbnProbe`，并在 SBN 成功后直接返回 `ok: true`。导致营销子系统实际未就绪时被误判为恢复成功，后续接口直接遭遇 20302 重定向。
- `scripts/marketing/batch_restore_manual_limited_discounts.mjs` 在单个任务 `processOne` 的 `finally` 中无条件执行 `closeStore(storeKey)`，导致每处理一个 item 就强制关窗，使得同一店铺的后续执行或下一阶段重新开窗冷启动，再次引发掉线。

### 2. 代码实际修改
- **`lib/shein_browser.mjs`（授权小段独占写）**：
  - 在 `ensureBrowser` 入口首行调用 `assertChromeProfileLeaseOwner({root: ROOT, storeKey: store?.storeKey})`；
  - 保证在 `isCdpOpen` 早退前先校验当前 task/runId 与物理 Profile 租约一致性，同 store 其他 active task/runId 立即抛出 `PROFILE_LEASE_ACTIVE` 拒绝，防止跨任务并发冲突。
- **`scripts/auto_relogin_shein_store.mjs`**：
  - 支持 `--require-marketing` 显式参数；
  - 在要求营销就绪时，强制以 `marketingProbe.ok` 为准，不再回退到 SBN 探针；通过时显式标记 `marketingEndpointVerified: true`，不通过时拒绝返回 `ok: true`。
- **`scripts/marketing/batch_restore_manual_limited_discounts.mjs`**：
  - `recoverMarketingLogin` 向自动重新登录脚本显式传递 `--require-marketing`；
  - `processOne` 支持 `{ keepOpen: true }` 选项，在连续执行同店铺任务时跳过 `closeStore`，由外部控制生命周期；
  - 批量执行循环中，按店铺连续调度，同店铺间保持浏览器窗口开启；仅当切换到下一不同店铺或本批结束时才关闭浏览器，彻底解决单步成功即关窗导致的后续掉线问题。
- **`lib/marketing_unified_login_recovery_contract.mjs`**：
  - 沉淀 `validateMarketingSessionReadiness`、`classifySessionFailure` 契约，支持 `leaseTask`/`leaseRunId`、`assertProfileOwner`、`assertStoreIsolation`，供各模块统一复用。

---

## 三、业务文档增量吸收说明

根据主任务授权，只吸收 `E:\Codex WorkSpace\.recovery\Shein-V6-pre-integration-20260905\files\docs` 中有用新增段，未整文件覆盖正式版，并拒绝合入与本次 A1 明确价优先冲突的“业务定价唯一基准是目标利润率”。

### 1. `docs/marketing-campaign-signup-pricing-rules.md` 增量
- **受管可见 Profile 与强刷规则**：明确在用户明确要求可见前端时，每次新开活动标签后必须先 `Page.reload(ignoreCache=true)` 强刷一次，再等待页面就绪、恢复登录和校验身份，首次空白页面不得直接操作。
- **B2 会话生命周期契约写入**：同步跨步骤窗口复用、店铺隔离互不关窗、营销接口探测作为恢复必备标准。
- **人话版展示强化**：`按货号汇总` 固定追加当前 ET 可售库存、在途库存和近 7 天销量；同一标准货号只展示一份 canonical 仓储证据，不得用“另 N 行缺失”描述链接级字段空值；每次确认后吸收当期基准，下一版不再保留“上次确认备注”列。
- **货号归并前置前移**：用户在确认表备注点名归并的货号必须先更新全局 alias 并重新归并各维度数据，再出价和提交。
- **A1 明确价格优先级确立**：明确指定固定价优先于默认利润率，利润线仅提示风险，整数价免除微调篡改，未知成本不伪造利润，限时折扣按同一份确认基准派生。

### 2. `docs/marketing-daily-inspection-handoff.md` 增量
- **Section 8.1 方案标准**：同步人话版追加 ET 可售/在途/7日销量、单备注列保留、点名归并前置、明确指定价格优先贯穿（A1 规则）。
- **Section 8.2 仓储与成本**：禁止在人话版写“另 N 行缺失”，统一以 canonical 共享仓储为事实展示。
- **Section 8.4 执行与生命周期**：写入同 Profile 跨步骤连续复用与闲置关闭策略，写入店铺隔离防护及营销接口探测验收标准（B2 契约）。

---

## 四、聚焦测试与验收执行

### 1. 测试套件与实测结果
1. `node scripts/test_marketing_a1_explicit_pricing.mjs`
   - 启动真实 `build_marketing_sku_approval.mjs` 脚本，基于真实临时输入文件执行完整计算；
   - 验证生成物 `price-overrides-2026-09-05-v7-all-safe.json` 与 `selection-plan-2026-09-05-v7-all-safe.json`；
   - 验证 FY 明确价格 37 SAR 保持不变，未被 cap 30 SAR 截断，未被 Jitter 偏移，成本未知仍安全入选；
   - **反例与防污染严格验证**：对照店 DL 有已知成本（60 SAR）且目标利润率（7.7%）低于 15% 红线，验证 DL 严格被 `row_full_cost_including_storage_margin_below_floor` 剔除，未被 FY 显式价错误豁免；
   - **下游 Policy 模拟验证**：验证从生成物 `price-overrides` 中提取出的 FY 最终执行目标价严格为 37 SAR；
   - **实测结果**：`PASS` (`{ "ok": true, "tests": "A1 end-to-end payload execution verified with real builder and anti-contamination assertion" }`)

2. `node scripts/test_marketing_b2_session_lifecycle.mjs`
   - 测试 `lib/shein_browser.mjs` 中 `ensureBrowser` 对 `assertChromeProfileLeaseOwner` 的先行调用；
   - 测试 `auto_relogin_shein_store.mjs` 的 `--require-marketing` 逻辑与 probe 验证；
   - 测试 `batch_restore_manual_limited_discounts.mjs` 的 `keepOpen` 参数与同店铺跨 item 窗口保活机制；
   - 测试验证码、凭据缺失、20302 过期、CDP 掉线的精细分类；
   - **实测结果**：`PASS` (`{ "ok": true, "tests": "B2 session lifecycle keep-alive, store isolation, and marketing probe contract fully verified" }`)

3. `node scripts/test_marketing_unified_login_recovery_contract.mjs`
   - **实测结果**：`PASS` (`{ "ok": true, "checks": 24 }`)

4. 营销库存与事务 Smoke 回归：
   - `node scripts/marketing/smoke_marketing_activity_inventory_integration.mjs` -> `PASS` (`checks: 61`)
   - `node scripts/marketing/smoke_transactional_limited_discount_deadline.mjs` -> `PASS`

### 2. 代码风格与空白检查
- `git diff --check` 在所有受管代码、测试及文档上均为 0 输出（全 LF，无 CRLF，无行尾空白，无多余 diff）。

---

## 五、确切未完成点与未验证边界说明

1. **未在真实平台发起业务写入**：未启动实际可见 Chrome 浏览器，未调用 SHEIN 生产环境发起真实活动修改。
2. **生产环境本地持久存储介质边界**：生产环境各店铺是否需依赖除 Cookie 以外的 LocalStorage/IndexedDB 介质同步，须在真实维护窗口中实机抓取验证，未在离线阶段做未实证假设。
3. **测试套件登记**：新增加的聚焦测试文件路径已列明，`scripts/run_deterministic_tests.mjs` 等统一入口保持未动，保留由主任务统一登记。
4. **写域与 B1 隔离声明**：
   - 未修改主代理独占的 `lib/browser_task_lease.mjs`、`scripts/launch_store_browser.mjs`、`scripts/launch_store_browser.py`、`scripts/launch_shein_main_browser.mjs`；
   - 未修改 Laplace 独占的 `lib/marketing_activity_inventory_transaction.mjs`、`scripts/marketing/replace_limited_discount_transactionally.mjs` 及库存补量白名单；
   - 未做任何 Git staging 或 commit，所有文件严格保持 LF 换行。


## 6. 营销持久化库存真实 Helper 必验补充 (scripts/test_marketing_inventory_durable.mjs)

在授权测试文件 `scripts/test_marketing_inventory_durable.mjs` 中补齐了全部 8 项生产持久化合同硬断言：
1. **Request 回调内实时 Journal 存在性验证**：断言在网络请求发出且完成前，真实磁盘 journal 文件中已完整写入 intent 记录，包含匹配的 `intentId`、`logicalActionKey`、`requestPayloadHash`、`storeKey`、`skuCode` 与 `request` 原文。
2. **同 Phase 幂等拦截零重复 POST**：同 key 重复调用直接被 `INVENTORY_WRITE_ALREADY_RECORDED` 拦截，POST 计数保持 1。
3. **Raise 与 Restore 阶段严格单次有效 POST**：raise 与 restore 各自只产生 1 次 POST（累计 2 次 POST）。
4. **Restore 阻断与零二次 Restore/Raise**：restore 记录后二次尝试直接被拒绝，POST 计数保持 2。
5. **网络超时异常模拟（Transport ETIMEDOUT Throw）零补偿重发**：实测通过抛出 `ETIMEDOUT: network transport hang` 超时异常模拟网络故障（非永不 settle 的挂起 hang），异常抛出前 intent 已在 request 回调内落盘持久化；后续同 phase 重试直接被 `INVENTORY_WRITE_ALREADY_RECORDED` 阻断，POST 计数严格保持 3，绝不盲目重发。
6. **普通与临时库存物理守恒与缺失拒绝**：样本中普通可用、锁定与临时锁定之和不等于总量时，`normalizeInventoryOccupancy` 直接抛出 `INVENTORY_CONSERVATION_MISMATCH`，在锁前拒绝，0 次 POST。
7. **锁内 Preflight Baseline 占用变更拒绝**：进入 cutover 锁后重新校验基线占用，若与计划预期不符直接抛出 `MARKETING_INVENTORY_OCCUPANCY_CHANGED_BEFORE_SUBMIT`，0 次 POST。
8. **全局 Journal 域损坏拒绝**：存在损坏的 ndjson 行时直接被 `readFenceBundle` 阻断，0 次 POST。
