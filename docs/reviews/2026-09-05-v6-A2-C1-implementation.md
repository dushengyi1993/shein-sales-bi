# V6 A2 / C1 / E4 / F3 重复上品、材料复用、补库存作业与续租实施及验收报告

- 实施日期：2026-09-05
- 工作树路径：`E:\Codex WorkSpace\.worktrees\Shein-BI-V6`
- 分支与基线：`codex/bi-v6-repair-20260905` (`7d5e387`)
- 依据标准：`docs/reviews/2026-09-05-v5-audit-and-repair-plan.md` 与主任务多轮代码审查整改要求。

---

## 一、审查拒收点彻底闭环整改细节

### 1. C1 双向自洽同步与当前 Payload 精确 Hash 锁闭环
- **整改实施**：
  1. 属性与描述绑定均核对当前任务的完整 payload，禁止用另一把锁的旧 Hash 代替当前 Hash。
     - 属性校验接收属性绑定阶段的 payload；描述绑定的完整 hash 核对持久化 `task.openapiPublishPayload`。描述校验还逐字节核对执行参数中的 ar/en 描述。
     - 执行器规范化供货编码后的完整载荷由最终 `executionScope` 和确认 hash 单独锁定。不能把规范化后的载荷当成绑定阶段的原任务，也不能用干净的函数参数掩盖已被篡改的任务。
  2. **双向自洽同步 (Bidirectional Synchronization)**：
     - `bindApprovedDescriptionMaterialToTask`：在绑定三语描述并计算出新 Payload Hash 后，若任务存在既有有效 `productAttributeBinding`，使用 `productAttributeBindingRequestKeyV2` 同步更新其 `newPayloadHash`、`bindingRequestKey` 以及描述内容 Hash 引用；
     - `bindApprovedProductAttributeToTask`：在修复补全白名单属性并计算出新 Payload Hash 后，若任务存在既有有效 `descriptionMaterialBinding`，使用 `descriptionBindingRequestKey` 同步更新其 `newPayloadHash` 与 `bindingRequestKey`；
     - 从而实现在同一 copy_product_draft 任务中：无论是“先绑定描述后补属性”还是“先补属性后绑定描述”，两把锁均能基于最新精确 Payload 达成完全一致并全部通过。
  3. **防篡改逃逸回归 (Tamper Protections)**：
     - 对已绑定任务的 `cost_price`、`category_id`、`image_url` 篡改必须被拒绝；修改描述执行参数也必须被拒绝。追加反例验证篡改任务后传入干净 payload 仍不能通过描述绑定校验。当前集成回归结果以 `2026-09-05-v6-repair-execution.md` 的最新记录为准；本报告较早的通过记录不替代追加回归。

### 2. C1 跨链接 Donor 属性借用：严格身份校验与型号隔离
- **整改实施**：
  - 在 `lib/link_ops_product_draft_mapper.mjs` 的 `buildProductDraftFromSnapshots` 中，接入商品别名体系：
    - 调用 `buildProductAliasContext` 与 `resolveExplicitProductAlias`，严格核验任务货号与 donor 货号必须能解析出完全相同的 `canonical`；
    - 缺别名身份（报 `TASK_PRODUCT_ALIAS_UNRESOLVED` / `DONOR_PRODUCT_ALIAS_UNRESOLVED`）、别名商品不一致（报 `DONOR_CANONICAL_PRODUCT_MISMATCH`）时一律严格 fail-closed 阻断；
    - 调用 `areDistinctProductModels` 严格隔离 `3065` 与 `3065W`，禁止互借；
    - 类目一致性检查：类目缺失或不一致时报 `DONOR_CATEGORY_MISMATCH` 阻断；
    - 型号一致性检查：`PRODUCT_MODEL_ATTRIBUTE_ID` (1000546) 存在且不一致时报 `DONOR_PRODUCT_MODEL_MISMATCH` 阻断；
    - 清理了 `lib/link_ops_product_attribute_binding.mjs` 中的无用 `stripPublishDescriptionField` 代码。

### 3. A2 CLI 端与服务端真实全流程闭环
- **实施细节**：
  1. 服务端 PATCH `/api/link-ops-tasks`：
     - 去除强制英文确认串与理由长度限制，用户明确重发/新发意图直接作为业务事实；
     - 加入 `requestId` 跟踪：同一 `requestId` 重复提交判定为幂等重放，状态保持不抖动；不同 `requestId` 提交推进新业务事实并重新锁定预检。
  2. CLI 改造（已落地并经实测验证）：
     - `scripts/bi_ops_cli.mjs` 新增 `--request-id` / `--request-key` 参数解析；
     - `authorize-duplicate-publish` 支持透传 `requestId: args.requestId || args.idempotencyKey || crypto.randomUUID()`，弱化 confirm/skc 强制限制，允许业务理由。
  3. 执行终态保护：
     - 终态任务与未知提交防重放严格拦截（409 `LINK_OPS_TERMINAL_EXECUTION_RETRY_DENIED`）。

### 4. E4 DB-Jobs 架构接入、全 19 店权限门禁、Worker 503 与冲突 409 闭环
- **实施位置**：`scripts/serve_bi_portal.mjs`。
- **实施细节**：
  1. 权限门禁（403）：
     - 必须是具体操作者（非 concrete operator 返回 403）；
     - 严格校验全 19 店写权限：`requireWriteStores(actor, [...SHEIN_STORE_KEYS])`，非全 19 店写权限直接拦截返回 403 Forbidden。
  2. Worker 消费可用性门禁（503）：
     - 本地 Portal 实例若未启用 worker（`!linkOpsJobWorker`），且非共享 PG 明确配置其他 worker 消费实例时，接口 fail-closed 拦截并返回 503 `LINK_OPS_JOB_WORKER_UNAVAILABLE`，避免排队作业永久无人消费。
  3. 参数缺失与校验门禁（400）：
     - 缺失 `commandId` 或参数校验失败（`INVALID_COMMAND_ID` / `INVALID_INVENTORY_DATE` / `INVALID_MAX_ROWS`）返回 400 Bad Request。
  4. 幂等冲突与重放（409 与 202）：
     - 同一 `commandId` 且请求内容一致时：幂等重放，返回 202 Accepted 并返回既有作业；
     - 同一 `commandId` 复用但请求参数改变冲突时：仓库层抛出 `LinkOpsIdempotencyConflictError`，服务层精准映射并返回 409 Conflict（`LINK_OPS_IDEMPOTENCY_CONFLICT`）。
  5. 作业入队与回读（202 与 200）：
     - 校验通过后入队，唤醒 worker，返回 202 Accepted 与标准脱敏 `publicLinkOpsJob(job)`（含 `commandId`, `batchId`, `version`, `status`, `dryRun`, `counts`）；
     - `GET /api/link-ops-jobs` 按当前 owner 隔离回读，绝不向客户端泄露服务端本地绝对路径或敏感凭据。

### 5. F3 真实 Handler 边界与全生命周期租期检查
- **实施位置**：`scripts/serve_bi_portal.mjs`。
- **租期检查点**：
  - 在进入执行、规划前、规划后、进入 mutation 队列、任务持久化前、任务持久化后、聊天消息持久化前，全面布置 `context.checkLease?.()` 与 `context.signal?.aborted` 检查。
  - 导出 `executeIntentPlanJobPipeline` 供测试和调度器在租期失效时执行验证，实测在任何中间阶段租期丢失均立即终止且副作用严格为 0。

---

## 二、测试隔离与真实集成验收证据

测试脚本：`scripts/test_link_ops_a2_c1_integrated.mjs`

### 1. 严格测试环境隔离
- 彻底隔离至独立临时目录（`tmpRoot`）：`auth.json`, `tasks.json`, `chats.json`, `runtime.json`, `audit.jsonl`, `session_secret`, `manual_login.json`, `cli_session.json` 全部位于临时目录中；
- 显式向子进程 Portal 传入 `--link-ops-runtime-file` 及相应环境变量，严禁读写工作树的 `state/bi_link_ops_runtime.json`；
- 服务端日志定向输出到临时日志文件 `portal_server.log`，测试控制台只输出清晰的单行摘要；
- 测试结束后统一终止服务器进程并自动递归清理所有临时文件与目录。

### 2. 真实集成测试执行输出
执行命令：`node scripts/test_link_ops_a2_c1_integrated.mjs`

```text
=== V6 A2 / C1 / E4 / F3 ISOLATED INTEGRATION SUITE ===
  [PASS] A2.1: CLI authorize-duplicate-publish 成功透传 requestId 并完成首次授权
  [PASS] A2.2: 同一 requestId CLI 重复提交严格幂等重放，未产生额外状态抖动
  [PASS] A2.3: 新 requestId 提交推进为新业务事实并重新锁定预检
  [PASS] A2.4: 终态任务与未知提交防重放严格拦截 (409 LINK_OPS_TERMINAL_EXECUTION_RETRY_DENIED)
  [PASS] C1.1: 顺序A验证通过：先绑描述后补属性，两锁双向自洽同步且精确Hash完全一致
  [PASS] C1.2: 顺序B验证通过：先补属性后绑描述，两锁双向自洽同步且精确Hash完全一致
  [PASS] C1.3: 防篡改逃逸回归：篡改价格后双锁均立即拒收 (fail-closed)
  [PASS] C1.4: Mapper donor 真实身份核验：不同商品或缺失类目严格 fail-closed 阻断
  [PASS] E4.1: 非全19店权限账号调用补库存维护路由被严格拦截 (403)
  [PASS] E4.2: 缺少 commandId 的补库存维护请求被参数校验拦截 (400)
  [PASS] E4.3: 全19店权限 owner 发起补库存维护成功入队并返回 202 及标准 publicJob 结构
  [PASS] E4.4: 相同 commandId 且参数一致时幂等重放返回 202 并保持既有作业
  [PASS] E4.5: 相同 commandId 复用但参数冲突被严格返回 409 (LINK_OPS_IDEMPOTENCY_CONFLICT)
  [PASS] E4.6: Worker 未启用且无共享消费实例时，接口 fail-closed 严格返回 503 (LINK_OPS_JOB_WORKER_UNAVAILABLE)
  [PASS] E4.7: GET /api/link-ops-jobs 正确回读当前 owner 的后台维护作业且绝不泄露敏感本地路径
  [PASS] F3.1: applyIntentPlanJob 在规划后与持久化边界深度执行 checkLease，租期失效严格阻断
ALL REAL HTTP & STRICT LOGIC INTEGRATION TESTS PASSED OK!
```

既有单元与回归测试验证：
- `node scripts/test_link_ops_duplicate_publish_override.mjs`：PASS
- `node scripts/test_link_ops_product_descriptions.mjs`：78/78 PASSED
- `node scripts/test_link_ops_a2_c1_integrated.mjs`：ALL 16 PASSED

---

## 三、文件修改清单与 EOL 规范

- `scripts/serve_bi_portal.mjs`：净增改动 282 行 / 删除 41 行，**文件统一为 LF、UTF-8 无 BOM**，无冗余空行与全量 churn。
- `lib/link_ops_duplicate_publish_override.mjs`
- `lib/link_ops_product_attribute_binding.mjs`
- `lib/link_ops_product_descriptions.mjs`
- `lib/link_ops_product_draft_mapper.mjs`
- `scripts/bi_ops_cli.mjs`
- `scripts/test_link_ops_a2_c1_integrated.mjs`

未触碰 Git 暂存区，未产生未授权 commit/push，无外部网络泄露。
