# 待议价批处理 runbook（pending-discuss batch）

> 适用工作区：`E:\Codex WorkSpace\Shein销售统计`；生产目录：`/opt/shein-bi/app`；时间口径：`Asia/Shanghai`。
> 已定接口：`scripts/pending_discuss_batch.mjs` 三命令 `scan` / `preflight` / `execute`；测试文件 `scripts/test_pending_discuss_batch.mjs`。
> 业务扫描与结果交付分开核验；`daily --send` 只投递当轮报告，不授权接受或拒绝待议价。

底层 OpenAPI 契约（仓库级术语）：`query-discuss-list`（3001891）以 `discussStatus=1` 查待确认；`process-discuss`（3001892）以 `discussAuditType=1` 接受建议价、`2` 拒绝/放弃。

## 1. 三命令与授权边界

| 命令 | 允许时刻 | 前置条件 | 产出 |
| --- | --- | --- | --- |
| `daily` | 每日 heartbeat 正常入口 | 无写授权要求，只读 | scan + hash 自校验 + 人话报告 + 可选群回执 |
| `scan` | 调试或人工只读扫描 | 无写授权要求，只读 | 脱敏 manifest |
| `preflight` | 当前任务用户明确授权后 | fresh scan + decisions 文件 | 逐项 exact hashes + `batchHash`（默认约 15 分钟有效） |
| `execute` | 业务已授权且环境门打开 | preflight 产物、内部 hash 校验通过 | 逐项写 + terminal 回读 + 全店 final scan |

### scan（只读，每日唯一允许模式）

```bash
node scripts/pending_discuss_batch.mjs scan \
  --out-dir outputs/pending-discuss/<YYYY-MM-DD>/<RUN_ID>-scan
```

- 覆盖全部 enabled 店；严格身份校验：店铺身份必须与配置匹配，任一店身份不符即整体失败。
- 只取 `discussStatus=1`；完整分页，不允许截断或部分页当作完成。
- manifest 脱敏：不含凭据、会话材料、敏感回执；只含脱敏后的 item/store 摘要与覆盖统计。
- 退出码：`0` = 覆盖完整且全部校验通过；非 `0` = fail closed（任一店查询失败、身份不符、分页不完整或数据缺失都不得当作 0 条或成功）。

### daily（每日 heartbeat 快路径）

```bash
cd /opt/shein-bi/app
node scripts/pending_discuss_daily.mjs daily \
  --out-dir /srv/shein-bi/runtime/pending-discuss/<YYYY-MM-DD>/<RUN_ID>-daily \
  --send
```

- 只调用一次既有 `runPendingDiscussScan`，不做二次查询；持久化 `scan.json` 后先重算 `scanHash`，再生成 `report.txt`。
- 交付与环境识别：
  - 云端生产环境：当且仅当 Linux 系统且代码根目录（realpath）为 `/opt/shein-bi/app` 时识别为可信云端。产物可写入独立运行时路径（如 `/srv/shein-bi/runtime/pending-discuss/...`），直接通过 `deliverCloudTeamReport` 完成单次持久交付，使用原始 `scan.json` 和 `report.txt` 字节与相同 `automationId=pending-discuss-daily` 构造 bundle，不经过 SSH 自调用，不重排/改写原始报告字节。
  - 本地环境：严格受限于仓库 `outputs/` 白名单与符号链接拒绝保护，通过 SSH 隧道送交云端持久交付。启动前增加预检，若 `outDir` 位于 `outputs/` 之外或路径链包含符号链接，在启动 OpenAPI 扫描前即 fail-closed 拦截，不启动业务扫描。
  - 双发防护：`--send` 与 `--stage-delivery` / `STAGE_OPS_DELIVERY=1` 同时启用时，避免重复调用交付，标记 `shared-delivered` 保留业务与交付独立状态。
- `--send` 只接受 `config/lark_report.json` 的团队 `recipientChatId` 和生产 bot，不回退个人；幂等键包含业务日期且不超过 50 字符。
- 正文和附件都必须取得有效消息回执，`delivery.json` 才为 `status=ok`；部分成功、未知结果或缺少消息 ID 均不能记成功。原始持久交付状态保留在受管交付目录，公开产物和终端输出不保留群或消息 ID。
- 本机手工交付与云端日报保持相同的 `automationId=pending-discuss-daily` 和原附件字节指纹；不得通过改身份或移动旧产物绕过去重。修复上线不构成历史补发授权。
- 扫描成功、交付失败时分别报告两者状态，不重跑扫描，不修改该轮原件或 manifest，不自行补发；非空输出目录必须拒绝复用，拒绝时不得写入错误产物覆盖旧记录。
- scan 失败、覆盖不足、分页/身份/hash 异常时不生成 0 条报告，也不发送。正常 0 条无需再启动额外字段探索或批量归并流程。

### preflight（仅当前任务用户明确授权后）

```bash
node scripts/pending_discuss_batch.mjs preflight \
  --decisions <decisions.json> \
  --out-dir outputs/pending-discuss/<YYYY-MM-DD>/<RUN_ID>-preflight
```

- 必须先做 fresh scan；不允许复用旧 scan 结果。
- decisions 文件是用户批准的 item/store/动作集合（示例见第 2 节），expand 成 exact item/store hashes 并生成 `batchHash`。
- 默认约 15 分钟有效；过期后必须重新 fresh scan 并重建 preflight。
- 漂移检测：decisions 中的 item/store/价格与 fresh scan 不一致时整批停止并重建，禁止静默修正。

### execute（受控写）

```bash
SHEIN_PENDING_DISCUSS_WRITE_ENABLED=1 node scripts/pending_discuss_batch.mjs execute \
  --preflight outputs/pending-discuss/<YYYY-MM-DD>/<RUN_ID>-preflight/preflight.json \
  --confirm SHEIN_PENDING_DISCUSS_BATCH_EXECUTE \
  --out-dir outputs/pending-discuss/<YYYY-MM-DD>/<RUN_ID>-execute
```

- 必须同时满足：环境门 `SHEIN_PENDING_DISCUSS_WRITE_ENABLED=1`、`safeWriteOperations.enabled=true`、`requireDryRun=true`、动作 `process_pending_discuss` 与全部目标店显式 allowlist、`confirm=SHEIN_PENDING_DISCUSS_BATCH_EXECUTE`；`batchHash` 可自动从 preflight 读取，若显式传入则必须一致。用户清晰业务决策即授权，无需让用户手动搬运 hash 或设立临时确认窗。
- 真实 SHEIN execute 只允许 Linux `/opt/shein-bi/app`，并固定使用 `/run/lock/shein-pending-discuss-write.lock`；`--lock-path` 仅供 localhost fake 测试，不能改变真实执行锁域。
- 逐项 live 校验：每项写前重新校验该 item/store 仍处于可处理状态，任何漂移即停止该项并整批停下。
- 单次写：每项只发一次 `process-discuss` 写（3001892），不允许重复提交或覆盖重试。
- terminal 回读：每项写后必须回读终态（status 3/4）才计该项成功。
- 全店 final scan：批完成后必须重跑全 enabled 店 scan 确认终局。

## 2. artifacts

- `<RUN_ID>-scan/scan.json`：scan 脱敏证据（覆盖统计 + 脱敏条目）；同目录 `manifest.json` 记录其 SHA-256。
- `<decisions.json>`：用户批准输入，占位模板如下（不填真实 ID/凭据）：

```json
{
  "schemaVersion": 1,
  "businessDate": "<YYYY-MM-DD>",
  "decisions": [
    {"canonicalGoodsSn": "<STANDARD_GOODS_SN_A>", "action": "accept"},
    {"canonicalGoodsSn": "<STANDARD_GOODS_SN_B>", "action": "reject"}
  ]
}
```

旧格式的全局规则仍然有效：每条 `{canonicalGoodsSn, action}` 覆盖 fresh scan 中该标准货号、所有店铺的全部当前待确认行。也可以按店铺指定规则，例如：

```json
{
  "schemaVersion": 1,
  "businessDate": "<YYYY-MM-DD>",
  "decisions": [
    {"canonicalGoodsSn": "SK-13014杆式吸尘器", "storeKey": "DX", "action": "accept"},
    {"canonicalGoodsSn": "SK-13014杆式吸尘器", "storeKey": "LQ", "action": "reject"}
  ]
}
```

- `storeKey` 会 trim 后规范化为大写标准店码，并且必须命中本次 fresh scan 的 enabled 店铺集合；显式空值、未知店码或无该店当前待议价行都会 fail closed。
- 同一标准货号禁止全局规则与分店规则混用；同一标准货号同一店铺禁止重复或冲突规则；同一标准货号可以在不同店铺使用不同动作。每条规则都必须精确命中当前 `discussStatus=1` 行，未命中会阻断 preflight。
- 未列入 decisions 的其它待议价只报告、不执行；`unmatchedPendingCount` 是 fresh scan 中未被任一精确规则覆盖的当前待议价行数。
- canonical decisions 按标准货号、作用域（全局优先）、店码确定性排序；规范化后的店码进入 `decisionsHash`。items 按店码和 `discussSn` 排序并绑定店码，店 payload hash 与 `batchHash` 同样绑定店码。旧全局规则生成的 decision 结构仍不增加 `storeKey` 字段。
- `<RUN_ID>-preflight/preflight.json`：逐项 `itemHash`、逐店 `payloadHash`、整批 `batchHash` 与过期时间；同目录保留 fresh `scan.json` 和 manifest。
- `<RUN_ID>-execute/execution.json`：逐项执行/失败/不确定/未尝试结果；`final-scan.json` 是最终全店待确认复扫；manifest 记录两者 SHA-256。
- 测试：`scripts/test_pending_discuss_batch.mjs`（本地确定性测试，无网络、无真实写）。

## 3. 退出/失败边界

- `scan` / `preflight` / `execute` 任一失败都以非 0 退出并打印精确原因；禁止把 PARTIAL 当成功、缺失当 0 条。
- `execute` 拒绝启动条件：preflight 过期、业务日变化、源码/schema/配置/身份与归一化依赖 hash 漂移、显式传入的 `batchHash` 与 preflight 不匹配、环境门未开、`safeWriteOperations` 未显式放行目标动作/店铺、真实执行主机/锁路径不符、`confirm` 缺失或错误。
- 写前校验漂移：跳过该项并整批停止；不得绕过校验重试。
- 写前确定失败记入 `failed`；写请求已发出但回读失败或未达终态记入 `uncertain/submitted_readback_pending`。两者都会立即停批，均不自动补写。
- final scan 未完成或覆盖不足：批次不算完成，报告 blocker，不声称成功。

## 4. rollback 边界

- 只回滚代码：发布后发现问题时回滚代码/版本（git revert 或 release 回退），绝不撤销业务写。
- 业务写不可逆：`process-discuss` 的接受/拒绝是平台侧终态操作，代码回滚不会、也不能撤销已提交的业务写。
- 需要纠正业务结果时，必须走新的执行闭环：fresh scan → 新 decisions → 新 preflight → 业务授权内衔接 execute。
- 本 runbook 不是授权本身；授权必须来自当前任务的用户明确指示。

## 5. 测试与 release gate 接线

- `scripts/test_pending_discuss_batch.mjs` 已加入 `scripts/run_deterministic_tests.mjs`（一次）。
- `scripts/test_bi_ops_release_gate.mjs`：`CHECK_FILES` / `DIFF_CHECK_FILES` 覆盖 `scripts/pending_discuss_batch.mjs` 与 `scripts/test_pending_discuss_batch.mjs`；`docs/pending-discuss-batch.md` 只进 `DIFF_CHECK_FILES`；另含一次独立 pending discuss smoke。
- 测试不触网、不写真实 SHEIN、不打印真实凭据。
