# 项目工作流证据契约

本契约用于减少 Codex 主任务反复读取大 JSON、重复 SSH 和重复执行同一查询。它不改变任何 SHEIN 业务判断、授权、排班或生产写入边界。

## 统一结果

新建或改造的运维入口使用 `shein-ops-run/v1`：

- `outcome=succeeded`：证据完整且检查通过，退出码 `0`。
- `outcome=failed`：程序、协议或不可恢复错误，退出码 `1`。
- `outcome=blocked|incomplete`：授权、覆盖、新鲜度或依赖尚未满足，退出码 `75`；不得解释成业务 0。
- 参数或用法错误：退出码 `64`。

结果必须同时包含 source、scope、coverage、summary、blockers、warnings 和时间信息。产物 manifest 使用 `shein-ops-run-manifest/v1`，记录每个证据文件的 bytes 与 SHA-256；`inspect_ops_run.mjs` 会重新计算并验证。

## CLI 只读查询

```powershell
node scripts/bi_ops_cli.mjs query --text "原始问题" --out outputs/query.json
node scripts/inspect_ops_run.mjs --manifest outputs/query.json.manifest.json
```

CLI 默认在同一次进程/90 秒预算内等待 `BI_QUERY_DATA_INCOMPLETE`；Query 隔离进程返回 HTTP 429 + `QUERY_SURFACE_BUSY` 时按 `Retry-After` 继续有界等待。鉴权和其它 5xx 不重试。预算耗尽后原子覆盖 `--out` 为失败证据并返回缺失 section/错误码，不沿用旧文件或把缺失写成 0。可用 `--wait-seconds 0..300` 显式覆盖总预算。

## 云端运行态

```bash
node scripts/capture_ops_runtime_snapshot.mjs \
  --out-dir /srv/shein-bi/runtime/ops-snapshots/<new-run-id> \
  --expected-commit <release-tag>
```

该入口一次完成 attestation-bound schema v3 deployment marker（`shein-bi-deployed-release/v3`）、源码一致性、canonical maintenance marker、全部受管 systemd unit/timer/path，以及 Portal/Query/Webhook 三个 health 回读。所有 systemd 状态只调用一次 `systemctl show`，unit-file inventory 另调用一次 `list-unit-files`。主任务先读 manifest 和紧凑 summary，仅对 blocker 做定向探针；旧 v1/v2 marker、Query 副作用或 unit inventory 缺口都必须是 blocker。

## 巡检与 pipeline marker

`pipeline_marker.mjs write --evidence` 现在要求证据存在且为普通文件，并记录 bytes/SHA-256。`require --require-evidence` 可执行终态哈希回读。旧 marker 在未启用该开关时保持兼容；消费者应在一次完整的新业务日 marker 生成后再分批启用强校验，避免把迁移前 marker 误判为损坏。

`cloud_ops_watchdog.mjs` 继续保留原业务判断，但 systemd 探针从逐 unit 串行调用改为一次批量快照，并在报告中记录 `runtimeProbe.systemctlCommandCount`。它每轮只读一次维护 marker；告警/recovery 写入持久 outbox，同轮业务恢复与维护结束合并成一条通知，失败沿用同一 idempotency 重试。

## 边界

- 不缓存或复用过期业务结果；manifest 只索引本次真实产物。
- 不调用 BI ask/chat、浏览器或其他模型代查业务事实。
- 不创建/修改 automation、cron、Windows 计划任务或 systemd 调度。
- 不扩大任何 SHEIN 写白名单；真实写仍遵守实时预检、hash、确认、串行执行和终态回读。
