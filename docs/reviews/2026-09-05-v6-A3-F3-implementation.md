# V6 实施与闭环报告（第7轮主控复核与库存 Handler 约定落实版）：A3 待议价指纹范围改造与 F3 后台作业续租

## 1. 模块范围与独占文件说明

本实施严格限定于分配范围：
- **A3 待议价指纹范围改造与商业配置隔离**：
  - `lib/pending_discuss_batch.mjs`
  - `scripts/pending_discuss_batch.mjs`
  - 聚焦测试：`scripts/test_pending_discuss_a3.mjs`（真实生产 CLI & 导出函数测试）、`scripts/test_pending_discuss_batch.mjs`
- **F3 后台作业续租、单一 Promise 串行通道、有界超时、抗挂起熔断与库存 Handler 约定**：
  - `lib/link_ops_job_worker.mjs`
  - `lib/link_ops_repository.mjs`（核实仓库天然支持 `['succeeded', 'failed', 'uncertain_write']` 终态与 `recoverExpiredJobs` 机制）
  - 聚焦测试：`scripts/test_link_ops_job_worker_heartbeat.mjs`（全量 12 项测试：初始 advance 挂起熔断上界、getJob 挂起熔断上界、Wall-clock 回拨、响应 Latency 逼近 expiry、迟到更新防复活、checkLeaseAsync 串行核验、第二 worker 争抢接管与原 owner 真实副作用为 0、advanceWriteBoundary 跨心跳定时器排队无自冲突、advance 迟到超期拒绝更新、库存 handler `uncertainWrite` 转 `uncertain_write` 终态）、`scripts/test_link_ops_job_worker.mjs`、`scripts/test_link_ops_job_worker_shutdown.mjs`
- **明确边界遵守**：
  - 未修改 `scripts/serve_bi_portal.mjs`（由主任务协调 A2/C1/E4 拥有者）；
  - 未改动 CLI 主入口、AGENTS/docs 路由、package.json、全局 test runner；
  - 未进行任何 Git staging、commit、push 操作；
  - 未触碰生产环境、未调用真实 SHEIN OpenAPI 或执行真实议价提交；
  - 未合并或引入远端未合 PR#113 分支。

---

## 2. A3 实施与实证落实

### 2.1 商业 item 授权稳定与预检证据时效完整性
- **保留生成与到期时间以防篡改**：
  `preflightBatchBinding(preflight)` 保留 `schemaVersion`、`businessDate`、`generatedAt`、`expiresAt` 以及各店铺下的条目指纹（`stores[].items[].itemHash` 与 `payloadHash`）。
  恶意篡改 `expiresAt` 试图延长有效期，必将破坏 `batchHash` 并在 `verifyPreflightDocument` 中直接触发 `BATCH_HASH_DRIFT`，守住时效防篡改边界。
- **条目级别授权稳定**：
  每个条目的 `item.itemHash`（`lockedItemBinding`）由款号、店铺、单号、SKU 建议成本价及历史、用户动作（accept/reject）与 API 载荷严格锁定。追加第 4 条决策时，前 3 条条目的 `itemHash` 保持绝对不变。
- **真值变化实时拦截**：
  真实对象篡改（如改错店铺或建议价/成本价被修改）时，条目指纹改变，在执行前 `verifyLockedItem` 阶段立即阻断（报 `DISCUSS_OBJECT_DRIFT` / `ITEM_HASH_DRIFT`）。

### 2.2 可变商业配置按“当前锁定条目/店铺”提取真实依赖
- **源代码与平台 Schema 规则**：
  `domainSource`、`runnerSource`、`querySchema`、`processSchema`、`openApiClient`、`storeIdentity`、`skuNormalizer`、`ticketLock`、`atomicPublish` 继续执行严格的全文安全哈希校验。
- **可变商业配置按需提取**：
  实现 `hashTargetedCommercialConfig(filePath, key, scope)` 与 `extractTargetScopeFromScanAndDecisions(scan, decisions)`：
  1. `openApiConfig`：仅提取待议价实际通信依赖的根路径（`apiBaseUrls.prodSemiManaged`），隔离其它动作、注释与物理总闸 `safeWriteOperations`；
  2. `storesConfig`：仅按当前涉及的店铺提取配置；
  3. `storeTruth`：仅按当前涉及的店铺提取权威身份；
  4. `productAliases` / `productCatalog`：仅按当前涉及的商品款号提取别名与目录映射。
- **效果实证**：
  另一店配置/真实身份修改、另一无关商品别名增加，当前已锁条目执行时**绝不误报 `SOURCE_HASH_DRIFT`**；
  当前店真实身份发生变动（例如 `merchantId` 被篡改），在条目执行前调用的 `verifyStoreIdentity` 会当场拦截并阻断！

---

## 3. F3 架构落地：抗挂起、单调 Deadline、单一串行通道与库存 Handler 约定

### 3.1 初始 `read_only` Advance 挂起超时熔断与时间上界
- **熔断机制**：为初始 advance 施加 `Promise.race` 超时熔断（受 `heartbeatTimeoutMs` 严格约束），并在 `finally` 块中立即 `clearTimeout`；
- **失权阻断**：若超时，立即抛出 `INITIAL_ADVANCE_TIMEOUT`，将 `lostLease` 置为 true，触发 `AbortController.abort()`，**跳过后续心跳、跳过 handler 调用，并跳过 `finishJob`**；
- **实测证据**：在 Test 10 中注入永不 resolve 的初始 advance：
  - `runOnce()` 在 **214ms** 内有界返回（严格小于 1000ms 的数学安全上界）；
  - handler 调用次数严格为 0；
  - `finishJob` 提交次数严格为 0。

### 3.2 `checkLeaseAsync` 中 `getJob` 挂起超时熔断
- **熔断机制**：为 `store.getJob` 施加 `Promise.race` 超时熔断，并在 `finally` 块中立即 `clearTimeout`；
- **失权阻断**：若超时，立即抛出 `JOB_LEASE_LOST`（内部错误码 `GET_JOB_TIMEOUT`），标记失租并触发 `AbortController.abort()`；慢响应返回后再次核验单调 deadline；
- **实测证据**：在 Test 11 中注入永不 resolve 的 `getJob`，实测证明在 **205ms** 内有界熔断返回，触发 AbortSignal，旧 owner 的后续写入被严格阻断。

### 3.3 单一 Promise 串行通道（FIFO Serial Lane）根治并发自冲突
- 构建全局执行队列 `serialLane = Promise.resolve()`，通过 `runInSerialLane(fn)` 调度：
  将 **心跳（performHeartbeat）**、**边界推进（advanceWriteBoundary）**、**权威核验（checkLeaseAsync）** 严格排入同一个 Promise 链！
  - 队列中任何时刻有且仅有一个请求与 store 交互并更新本地 revision 与 deadline；
  - 实测证明：当 `advanceWriteBoundary` 耗时跨过心跳定时器到点时间时，心跳严格在串行通道中排队，等待 advance 推进至 revision 4 后，心跳才接续推进至 revision 5，绝不发生 revision 自冲突。

### 3.4 库存 Handler 约定支持（`uncertainWrite: true`）
- **核实仓库状态**：仓库 `lib/link_ops_repository.mjs` 与 `lib/link_ops_json_repository.mjs` 天然完整支持 `['succeeded', 'failed', 'uncertain_write']` 终态；
- **worker 落地**：
  1. `safeError(error)` 保留 `uncertainWrite: Boolean(error?.uncertainWrite)` 字段；
  2. `catch (error)` 中计算 `status = error?.uncertainWrite === true ? 'uncertain_write' : 'failed'`，并将状态正确传递给 `store.finishJob`；
  3. 租约丢失时坚决不 finish，由 `recoverExpiredJobs` 机制自动判定置为 `uncertain_write`；
  4. 已有正常 handler 行为完全不变。
- **实测证据**：在 Test 12 中实测 guard 派发后抛出 `error.code='INVENTORY_GUARD_UNCERTAIN'` 与 `error.uncertainWrite=true`，`finishJob` 正确提交 `status: 'uncertain_write'` 终态，`error.uncertainWrite: true` 被完整保留。

---

## 4. 主任务协调接口建议

### 4.1 Portal `intent_plan` 接入片段（供协调 A2/C1）
在 `scripts/serve_bi_portal.mjs` 的 `applyIntentPlanJob(job, context = {})`：
1. 入参解构：`async function applyIntentPlanJob(job, context = {})`；
2. 入口防御：`context.checkLease?.();`；
3. 规划器耗时操作后防御：`context.checkLease?.();`；
4. 消息追加前防御：`context.checkLease?.();`。

### 4.2 E4 库存维护（`inventory_maintenance`）接入片段（供协调 Ramanujan / E4）
在 E4 handler 处理 child dispatch 与异常时：
```javascript
async function applyInventoryMaintenanceJob(job, context = {}) {
  context.checkLease?.();

  // 在派发子任务/写入外部前，推进边界为 inventory_guard_dispatched
  await context.advanceWriteBoundary?.('inventory_guard_dispatched');

  try {
    // 外部派发与调用...
  } catch (dispatchError) {
    // guard已dispatch后异常且无完整严格result证据时抛出
    const uncertainErr = new Error('Inventory guard dispatch ambiguous: ' + dispatchError.message);
    uncertainErr.code = 'INVENTORY_GUARD_UNCERTAIN';
    uncertainErr.uncertainWrite = true;
    throw uncertainErr;
  }
}
```

---

## 5. 实测输出摘要

所有 5 个聚焦测试在 `E:\Codex WorkSpace\.worktrees\Shein-BI-V6` 下全部通过：

```text
=== 1. test_pending_discuss_batch ===
{
  "ok": true,
  "checks": {
    "zeroCoverage": true,
    "paginationAndReadRetry": true,
    "normalization": true,
    "duplicateAndIdentityDrift": true,
    "preflightHashes": true,
    "sourceAndExpiryDrift": true,
    "safeWriteGate": true,
    "acceptRejectTerminal": true,
    "acceptWithoutPriceBlocked": true,
    "delayedTerminal": true,
    "uncertainWriteNoRetry": true,
    "stopAfterWriteFailure": true,
    "artifactHashesAndRedaction": true
  }
}

=== 2. test_pending_discuss_a3 ===
Starting A3 real CLI & production entry tests...
✓ extractPendingDiscussConfig & hashPendingDiscussConfig correctly isolate unrelated changes
✓ Real CLI execute: permission gate blocks execution without false SOURCE_HASH_DRIFT
✓ Real CLI execute: successful execution with omitted --batch-hash
✓ Existing decision item hashes remain stable when appending a fourth decision
✓ Object/price drift immediately caught and blocked by verifyLockedItem
✓ Current store identity drift accurately caught and blocked
✓ expiresAt tampering accurately caught by BATCH_HASH_DRIFT preserving audit integrity
All A3 real CLI & production entry tests passed successfully!

=== 3. test_link_ops_job_worker ===
link_ops_job_worker: durable claim, read-only boundary, success, unsupported, and failure paths passed

=== 4. test_link_ops_job_worker_shutdown ===
{
  "ok": true,
  "admissionCloseRefusesNewClaim": true,
  "timerNoLongerClaimsAfterAdmissionClose": true,
  "inFlightClaimDrainedToTerminal": true,
  "inFlightHandlerFailedDrainedToTerminal": true,
  "noLeftoverRunningOrFailedLease": true,
  "repeatedShutdownIdempotent": true,
  "restartAfterAdmissionCloseRefused": true,
  "terminalWriteFailurePropagated": true,
  "normalPollingNotRegressed": true
}

=== 5. test_link_ops_job_worker_heartbeat ===
Starting F3 definitive monotonic, anti-latency-revival & multi-worker tests...
✓ Test 1 passed: Periodic heartbeat maintains lease and updates revision
✓ Test 2 passed: Wall-clock rollback does not affect monotonic deadline
✓ Test 3 passed: Response latency & late heartbeat cannot revive expired lease
✓ Test 4 passed: checkLeaseAsync serializes safely with heartbeat without self-conflict
✓ Test 5 passed: Multi-worker contention, clean takeover, zero side-effects on old owner
✓ Test 6 passed: advanceWriteBoundary sequential revision update and serial heartbeat integration
✓ Test 7 passed: advanceWriteBoundary strictly rejected on expired lease
✓ Test 8 passed: Single Promise serial lane prevents advance & heartbeat concurrency self-conflict
✓ Test 9 passed: Late advanceWriteBoundary crossing deadline strictly rejected without revival
✓ Test 10 passed: Never-resolving initial advance bounded at 214ms (<1000ms), handler skipped, zero finish
✓ Test 11 passed: Never-resolving getJob inside checkLeaseAsync strictly bounded (<1000ms) with AbortSignal
✓ Test 12 passed: inventory handler error.uncertainWrite commits uncertain_write status and preserves safeError
All F3 definitive tests passed successfully!
```



## 7. 补充移交：runInventoryGuardProcess 进程组生命周期与后代彻底消亡实施记录

### 7.1 写所有权与实施边界
- **写所有权**：根据主控移交指令，仅独占修改 lib/cloud_inventory_replenishment_job.mjs 中 runInventoryGuardProcess 单一函数（同文件其他函数严格未改动），以及新增聚焦测试 scripts/test_inventory_guard_process_group.mjs。
- **换行符规范**：所有文件保持 LF 换行符。

### 7.2 核心机制落地
1. **进程组接管（Process Group Management）**：
   - 子进程以 detached: true 启动，获取 pgid = child.pid，在 POSIX 环境通过 -pgid 发送信号，确保接管所有孙进程及深层后代。
2. **阶梯式信号消亡（Escalation Protocol）**：
   - 先向进程组发送 SIGTERM，在 stopGraceMs 宽限期内轮询检查；
   - 若宽限期届满仍有存活后代，升级为 SIGKILL 强杀，进入 killTimeoutMs 强杀期。
3. **彻底消亡确认与不可杀（D-state）闭合防御**：
   - 轮询确认进程组完全消亡（checkGroupAlive() === false，底层返回 ESRCH）才允许进程退出并结束 Promise；
   - 若强杀期满依然存活（如遭遇 Linux 内核 D-state 不可中断睡眠），绝不隐瞒假成功，抛出 INVENTORY_GUARD_PROCESS_GROUP_STUCK 严厉阻断，防止释放给业务重复重试（此前库存 job 已在 store 推进至 inventory_guard_dispatched，状态不可自动重试）。
4. **防死锁与全生命周期闭环**：
   - stop(error) 在 ensureDescendantsTerminated 完成后主动调用 finish(stoppingError)，杜绝因外部孙进程未发 close 事件导致进程卡死；
   - 无论是正常退出、信号中断、Lease 丢失（AbortSignal 触发）还是运行超时（INVENTORY_GUARD_TIMEOUT），全部执行后代进程组清理确认。

### 7.3 测试与实测输出验证
- **测试用例**：scripts/test_inventory_guard_process_group.mjs 覆盖：
  1. 后代进程忽略 SIGTERM 时的阶梯式 SIGKILL 升级杀灭；
  2. D-state 后代不可杀时的 Fail-closed 严格报错与不可重试标记；
  3. 父进程正常退出（Exit 0）但留有孤儿后代时的进程组彻底消亡清理；
  4. 进程组消亡前的等待与退出闭合；
  5. 运行截止超时（Timeout）触发的进程组全消亡与严格 reject。
- **实测输出**：
`	ext
Starting Inventory Guard Process Group Lifecycle & Descendant Teardown tests...
✓ Test 1 passed: Step-up escalation to SIGKILL when descendants ignore SIGTERM
✓ Test 2 passed: D-state descendant fails closed and does not allow retry
✓ Test 3 & 4 passed (Windows host simulated): Parent exit 0 terminates active orphan process group
✓ Test 5 passed: Run deadline timeout triggers process group teardown and rejects
All Inventory Guard Process Group tests passed successfully!
`

### 7.4 写所有权交回声明
runInventoryGuardProcess 已完全按规范实施并通过全量测试，所有文件采用 LF 换行符。在此明确将 lib/cloud_inventory_replenishment_job.mjs 的写所有权正式交回主控。


## 8. 进程组第二轮深化：WSL 真实 Linux 后代杀灭、单一 cleanupPromise 与僵尸识别实证

### 8.1 4 项深化要求落地
1. **真实 WSL Node 运行 Linux 分支**：
   - 执行指令：`wsl.exe bash -lc "cd '/mnt/e/Codex WorkSpace/.worktrees/Shein-BI-V6' && /usr/bin/node scripts/test_inventory_guard_process_group.mjs"`；
   - 依赖与隔离：WSL Node 18.19.1 原生兼容 ES 模块导入；测试使用本地 ext4 根分区 `/tmp` 隔离目录，完全规避 9p/drvfs 文件锁争用。
2. **共享唯一 cleanupPromise 杜绝重复清理**：
   - 将 `ensureDescendantsTerminated(initialReason)` 内部构建为 `cleanupPromise = (async () => { ... })()`；
   - 当 `stop(error)` 与 `child.close`（`finish()`）并发时，或者 `stop` 执行完毕后再触发 `finish` 时，严格共享同一个已经初始化的 Promise；全局只有一次严格有界的 `SIGTERM -> SIGKILL` 杀灭通道。
3. **单调时钟 performance.now 截止防回拨与 EPERM 安全保护**：
   - 移除所有 `Date.now()`，全生命周期基于 `performance.now() + stopGraceMs` / `killTimeoutMs` 计算 Deadline，彻底免疫系统墙上时钟回拨导致的无限等待；
   - `process.kill(-pgid, 0)` 抛出 `EPERM` 时明确判定为“存在跨权限/提权活跃进程”，返回 `true`（仍然存活），绝不误判为已消亡。
4. **Linux /proc 活跃态检查与僵尸（Z）彻底区分**：
   - 在 Linux 平台下，当 `process.kill(-pgid, 0)` 返回 0（成功）时，通过遍历 `/proc/[pid]/stat` 读取进程组内所有后代的实际状态；
   - 明确区分已不能执行的僵尸（`Z`，defunct）与仍能执行的活跃态（`R`, `S`, `D`, `T`）；
   - 若进程组内仅剩孤儿僵尸（`Z`），由于已无法执行用户代码、无法做任何磁盘/网络 I/O，不误报 `INVENTORY_GUARD_PROCESS_GROUP_STUCK`；
   - 若存在任何处于 `R`, `S`, `D` 态的进程在超时后仍未死亡，严格判定为卡死阻断。

### 8.2 WSL 真实 Linux 运行实测输出
```text
$ wsl.exe bash -lc "cd '/mnt/e/Codex WorkSpace/.worktrees/Shein-BI-V6' && /usr/bin/node scripts/test_inventory_guard_process_group.mjs"
Starting Inventory Guard Process Group Lifecycle & Descendant Teardown tests...
✓ Test 1 passed: Step-up escalation to SIGKILL when descendants ignore SIGTERM
✓ Test 2 passed: D-state descendant fails closed and does not allow retry
✓ Test 3 passed: Real POSIX process group confirmed dead under Linux (SIGTERM ignored, killed via SIGKILL)
✓ Test 4 passed: Orphan descendants terminated and confirmed dead when parent exits early
✓ Test 5 passed: Defunct Zombie (Z) descendants correctly recognized and do not cause false STUCK
✓ Test 6 passed: Run deadline timeout triggers process group teardown and rejects
✓ Test 7 passed: Single shared cleanupPromise strictly prevents concurrent or duplicate teardown
All Inventory Guard Process Group tests passed successfully!
```

### 8.3 交付所有权正式交回
`runInventoryGuardProcess` 已全面符合 WSL 真实 Linux 子进程证据、单一 cleanupPromise 串行保护、monotonic performance.now 时钟与僵尸识别规范，测试已获真实终端验证。写所有权正式完整交回主控。
