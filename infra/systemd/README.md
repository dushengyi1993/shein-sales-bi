# SHEIN BI cloud systemd units

## ET forwarder persistent runtime

The ET OCR Python runtime and HTTP session live under
`/srv/shein-bi/runtime/et-forwarder`, never inside `/opt/shein-bi/app`.
During a release deployment, install the hash-locked wheel set explicitly
before installing or starting the tracked ET units:

```bash
sudo -n env SHEIN_ET_RUNTIME_ROOT=/srv/shein-bi/runtime/et-forwarder \
  bash /opt/shein-bi/app/scripts/ensure_et_forwarder_runtime.sh --install
sudo -n install -m 0644 /opt/shein-bi/app/infra/systemd/shein-bi-cloud-et-forwarder.service /etc/systemd/system/
sudo -n install -m 0644 /opt/shein-bi/app/infra/systemd/shein-bi-et-low-inventory-recheck.service /etc/systemd/system/
sudo -n systemctl daemon-reload
```

## Inventory writer compatibility guard

Inventory-capable services have an additional root-owned pre-start gate that is deliberately installed outside `/opt/shein-bi/app`. The only supported first-activation sequence is: enter fresh `maintenance=all`; install the external guard and its six drop-ins while activation is absent; root-deploy and restart the reader-first writers; harden the checkout; dry-run and execute the controlled activation; dry-run and execute the exact XL manual resolution; then restart and behavior-read every guarded entry. Do not hand-write, delete, or rename any activation, compatibility, or receipt file, and do not use `node -e` to call library functions.

```bash
sudo bash scripts/install_inventory_writer_compatibility_guard.sh \
  --apply --confirm INSTALL_INVENTORY_WRITER_COMPATIBILITY_GUARD_V1
```

The installer publishes `/usr/local/libexec/shein-bi-inventory-writer-compatibility-guard` and six `10-inventory-writer-compatibility.conf` drop-ins under `/etc/systemd/system`. Each effective `ExecStartPre` must contain that exact command once and as the final command; a later `99-*` or `zz-*` mutation is a startup blocker. Activation absence is legacy-compatible. After the exact reader-first deployment and writer restart, run the checkout hardener in audit mode, review its manifest, then apply it as root:

```bash
sudo python3 scripts/harden_inventory_writer_checkout_permissions.py --app-root /opt/shein-bi/app
sudo python3 scripts/harden_inventory_writer_checkout_permissions.py --app-root /opt/shein-bi/app \
  --apply --confirm HARDEN_INVENTORY_WRITER_CHECKOUT_V1
```

The hardener makes the app root, `.git`, tracked source, and tracked parents root-owned and non-writable by `sheinops`. It changes only the exact roots `state/tmp/outputs/profiles/node_modules` to sticky group-writable runtime roots and never recursively changes profile/session/runtime children. Keep its external receipt for the exact-hash rollback command; rollback is a reviewed recovery operation, never part of normal deployment.

With fresh `maintenance=all`, invoke the formal CLI first without `--execute` and publish an immutable preflight artifact. The artifact binds the full authority/maintenance/CAS snapshot and expires after 30 minutes. Execute consumes that exact artifact and its file SHA-256; do not repeat the binding options or hand-edit the JSON:

```bash
sudo node scripts/inventory/manage_inventory_writer_compatibility.mjs activate \
  --journal /srv/shein-bi/runtime/daily-inventory-replenishment/results/EXACT.journal.ndjson \
  --manual-receipt /srv/shein-bi/runtime/daily-inventory-replenishment/results/EXACT.manual-resolution.receipt.json \
  --scope-key EXACT_64_HEX_SCOPE_KEY \
  --out /srv/shein-bi/runtime/ops-snapshots/inventory-cutover/activate-preflight.json
sudo node scripts/inventory/manage_inventory_writer_compatibility.mjs activate \
  --execute \
  --preflight-artifact /srv/shein-bi/runtime/ops-snapshots/inventory-cutover/activate-preflight.json \
  --expected-artifact-sha256 EXACT_ARTIFACT_FILE_SHA256 \
  --expected-preflight-hash EXACT_DRY_RUN_HASH \
  --confirm ACTIVATE_INVENTORY_READER_FIRST_V1
```

Activation captures exact release/source authority and the first Portal restart generation, and atomically creates the activation registry/receipt plus generation-1 compatibility journal/receipt under `/var/lib/shein-bi-control/inventory-writer-compatibility`. The generation is first-switch evidence only: later `Restart=always` PID/start/NRestarts changes at the same compatible source identity do not self-lock. Immediately run the resolver's own default dry-run and exact-hash `--execute`; until its required XL event and receipt exist, every activated `change-inventory/v2` path remains fail-closed. From activation onward, an old app rollback, dirty checkout, hidden index entry, missing tracked file, control receipt drift, source permission drift, or post-guard `ExecStartPre` mutation prevents writes/startup as applicable.

The resolver accepts the raw R2 cache as `--live-inventory-baseline`; it independently selects the exact XL/SKC/SKU/warehouse row and binds that file's SHA-256, so no hand-built baseline JSON is part of the production sequence. Run the following once as the default dry-run, then repeat the identical command with `--execute --expected-preflight-hash EXACT_DRY_RUN_HASH`:

```bash
sudo node scripts/inventory/resolve_manual_inventory_intent.mjs \
  --journal /srv/shein-bi/runtime/daily-inventory-replenishment/results/EXACT.journal.ndjson \
  --plan /srv/shein-bi/runtime/daily-inventory-replenishment/plans/EXACT.json \
  --readback-artifact /srv/shein-bi/runtime/marketing-hotrun-20260805-1343/logs/openapi-catalog-executor/20260826043306-3001695-XL.json \
  --readback-artifact /srv/shein-bi/runtime/openapi-product-cache/XL/20260826T131840Z.json \
  --live-inventory-baseline /srv/shein-bi/runtime/openapi-product-cache/XL/20260826T131840Z.json \
  --owner-actor EXACT_CONFIRMED_OWNER \
  --owner-confirmation MANUAL_BASELINE_ADOPTED_EFFECT_UNKNOWN \
  --original-trace-id EXACT_ORIGINAL_POST_TRACE \
  --receipt /srv/shein-bi/runtime/daily-inventory-replenishment/results/EXACT.manual-resolution.receipt.json
```

Compatibility updates use the same CLI, immutable preflight artifacts, and append-only state machine. Under fresh `maintenance=all`: publish a `rotation-stage` artifact against the candidate commit/bundle/release receipt/source fingerprint and execute that exact artifact; root-deploy the staged candidate, harden it, and restart writers; then publish and execute a fresh `rotation-finalize` artifact. A staged candidate can pass the external startup guard so recovery is possible, but the in-app writer reader remains fail-closed until finalize. After finalize, generation N is permanently rejected and N+1 same-commit restarts remain valid. `status` is read-only and reports active/pending generations. An interrupted append or receipt publication is resumed by rerunning the identical artifact/hash; a different or expired artifact is rejected. Never remove activation to recover or rotate.

```bash
sudo node scripts/inventory/manage_inventory_writer_compatibility.mjs rotation-stage \
  --candidate-commit EXACT_40_HEX_COMMIT \
  --candidate-source-fingerprint EXACT_64_HEX_SOURCE_FINGERPRINT \
  --candidate-bundle-sha256 EXACT_64_HEX_BUNDLE_SHA \
  --candidate-release-receipt-kind formal \
  --candidate-release-receipt-hash EXACT_64_HEX_RECEIPT_HASH \
  --candidate-release-receipt-file /srv/shein-bi/runtime/deployed_release.json \
  --out /srv/shein-bi/runtime/ops-snapshots/inventory-cutover/rotation-stage-preflight.json
sudo node scripts/inventory/manage_inventory_writer_compatibility.mjs rotation-stage \
  --execute \
  --preflight-artifact /srv/shein-bi/runtime/ops-snapshots/inventory-cutover/rotation-stage-preflight.json \
  --expected-artifact-sha256 EXACT_STAGE_ARTIFACT_FILE_SHA256 \
  --expected-preflight-hash EXACT_STAGE_HASH \
  --confirm STAGE_INVENTORY_COMPATIBILITY_ROTATION_V1
# Only after root deployment, source hardening, writer restart and readback:
sudo node scripts/inventory/manage_inventory_writer_compatibility.mjs rotation-finalize \
  --out /srv/shein-bi/runtime/ops-snapshots/inventory-cutover/rotation-finalize-preflight.json
sudo node scripts/inventory/manage_inventory_writer_compatibility.mjs rotation-finalize \
  --execute \
  --preflight-artifact /srv/shein-bi/runtime/ops-snapshots/inventory-cutover/rotation-finalize-preflight.json \
  --expected-artifact-sha256 EXACT_FINALIZE_ARTIFACT_FILE_SHA256 \
  --expected-preflight-hash EXACT_FINALIZE_HASH \
  --confirm FINALIZE_INVENTORY_COMPATIBILITY_ROTATION_V1
sudo node scripts/inventory/manage_inventory_writer_compatibility.mjs status
```

Never replace a present external guard from an app checkout by default. A reviewed update or recovery first records the audit output's exact `installedManifestSha256`, then uses:

```bash
sudo bash scripts/install_inventory_writer_compatibility_guard.sh --replace \
  --expected-installed-manifest-sha256 <exact-current-hash> \
  --confirm REPLACE_INVENTORY_WRITER_COMPATIBILITY_GUARD_V1
```

This replacement gate is the only supported recovery path; Git checkout/rollback does not remove the external executable or its drop-ins. `shein-bi-query.service` is intentionally excluded because it disables the planner/job worker and exposes only the query surface.

`ExecStartPre` is verify-only and never accesses PyPI. A missing or mismatched
runtime fails the unit closed with an instruction to run the explicit install.
The installer retains old versioned venvs and atomically switches `current`.

Rollback to a release that still points at checkout-local `.venv-et` is not a
blind unit rollback: first stop the ET and inventory units, retain the `/srv`
runtime and session, then either keep these tracked unit files or provide
explicit compatibility paths. Resume ET only after the OCR import probe and a
read-only ET login/sync probe pass; resume inventory only after a fresh
`inventoryTrend` business-date check.

本文件只维护 unit/timer 的部署参数与安全护栏；生产排班、人工补跑和验收见 [../../docs/cloud-bi-operations.md](../../docs/cloud-bi-operations.md)。调度事实以各 `.timer` 的 `OnCalendar` 为准。

## 当前启用集与条件启用集（2026-08-17）

**当前生产应启用**：`shein-bi-portal.service`、`shein-bi-query.service`、`shein-bi-webhook.service`，以及 `shein-bi-cloud-morning-chain`、`shein-bi-cloud-yesterday`、`shein-bi-db-backup`、`shein-bi-cloud-order-closure`、`shein-bi-cloud-rtv-verify`、`shein-bi-cloud-browser-cleanup`、`shein-bi-cloud-disk-maintenance`、`shein-bi-cloud-marketing-live-guard`、`shein-bi-cloud-marketing-repair`、`shein-bi-cloud-watchdog`、`shein-bi-cloud-et-forwarder`、`shein-bi-cloud-et-storage-fee`、`shein-bi-cloud-session-manager`、`shein-bi-cloud-manual-login-recovery`、`shein-bi-cloud-openapi-stock-refresh`、`shein-bi-cloud-today-sales-reconcile`、`shein-bi-cloud-portal-section-queue` 的 timer。`shein-bi-session-secret.service` 必须安装，但不单独 enable；Portal/Query 的 `Requires/After` 会在二者启动前串行激活它。旧 `morning-link-chunk-2 / morning-link-recovery / morning-supplements / inventory-guard / inventory-guard-retry` timer 必须 disabled 并从生产 unit 目录移除；这些阶段现在属于一个 `morning-chain` run 的内部 checkpoint。人工登录 `.path` 不再启用。`daily-refresh` 只作为统一 coordinator 的内部阶段或人工恢复入口，没有独立 timer。

**条件启用**：`shein-bi-cloud-et-forwarder.timer`、`shein-bi-cloud-et-storage-fee.timer`、`shein-bi-cloud-session-manager.timer` 只有在服务器本地 ET/店铺授权和对应 profile 已验收时才启用；当前生产已验收时属于上面的启用集。`shein-bi-cloud-today.service` 只作人工灾备，不安装 timer。`shein-bi-lark-sales-qa.service` 和自动飞书日报保持 `disabled + inactive`。

凌晨 `00:45` 登录态管家、数据库备份尝试窗口 `01:45/02:05/02:25`、昨日最终核对尝试窗口 `02:45/03:05/03:20` 共享 `/opt/shein-bi/app/state/locks/shein-bi-nightly-maintenance.lock`。数据库备份仍只有一个 `shein-bi-db-backup.timer`，在同一 timer 内提供有限尝试并使用 `Persistent=true`；每次都显式以 `run-date=today`、`business-date=today` 读取/写入 `nightly-backup` marker，`--skip-if-done` 在锁内快速跳过同日已完成项，不新建第二个 dump。宿主绝对 deadline 仍为 `02:37`，Persistent catch-up 越过截止必须返回真实失败 75。昨日 timer 仍是唯一既有 timer，`nightly-backup` marker 缺失时返回 75 且不得被 systemd 当成成功；有限重试仍受 `03:27` deadline 约束，已完成的 `yesterday-final` 通过同日结构化 marker 幂等跳过。登录态管家、数据库备份和晨间链路 timer 使用 `Persistent=true`；其余 timer 使用 `Persistent=false`。登录态管家只有在当日 `nightly-session` marker 为 `done`，且同日报告满足启用店铺**精确逐店证据**（`report.date==runDate`、results 与启用 storeKey 集合一致且唯一、每行 `ok=true` 且带 `exportSession.stores[].webApiProbe.ok` 探针证明）时才幂等退出；伪造 summary 19/19+`results=[]`、缺行/重复行/缺探针证明或 store 配置缺失都不算完成，无证据 `warning` 也不算完成。正常 timer run 只使用 `01:27` clock deadline，受控 catch-up 显式提供未来 epoch 时只传 epoch。晨间链路由单一 wrapper 原子保存 active run context（含 first-start 绝对 deadline，重启复用不重置）；同日瞬时失败由 `Restart=on-failure` 恢复，终态使用 exit 76/78 配合 `RestartPreventExitStatus` 保持 systemd 可见失败而不死循环。跨日绝不执行旧 child，只保留旧失败证据后推进当天。链接与补充阶段不得越过库存前置截止，库存阶段进入后可在原绝对 deadline 内恢复；最终 marker 直接绑定19店结果、库存 marker、plan 与 result。不新增 timer/queue。半托重任务还必须按 `host → project → domain → pressure → command` 取得 `/run/lock/shein-host-heavy.lock`；半托只维护 `shein-host-heavy-bi.slice`，不得覆盖全托维护的主机 slice/tmpfiles。完整联合排班见 [../../docs/shared-host-resource-schedule.md](../../docs/shared-host-resource-schedule.md)。

Linux 生产健康只以 systemd、watchdog、Portal health 和云端数据审计为准；旧 Windows 计划任务只是历史回滚参考，不能再用作 Linux 页面或告警的健康依据。

- 当天销售不再使用 `shein-bi-cloud-today.timer` 每小时抓取。半托订单 Webhook 收到后按单查询 OpenAPI 并增量更新正式销售事实，Portal 通过 PostgreSQL `NOTIFY` + 登录态 SSE 刷新当前页面；`shein-bi-cloud-today.service` 只保留为人工灾备入口，不安装/启用对应 timer。
- `shein-bi-cloud-openapi-stock-refresh.timer`：每小时 `:18/:48` 轻量刷新19店商品列表与库存，避开每15分钟销售 reconciliation 的同刻启动；`07:18` 同轮按每店32条的上限优先补齐新商品详情并轮转旧缓存，其余高频轮只复用详情缓存。当前实测单轮约1分钟，`:18` 在 `:20` ET 前收口，`:48` 在 `:50` watchdog/RTV 前收口；拿不到共享机会窗口时允许跳过第二轮，不能挤占 `:32–:43` 全托首页车道。等待每日轮转的新详情不作为故障，真实请求失败、超过21天的详情缓存或库存缺失仍必须告警。SHEIN Webhook 不提供完整的当前虚拟库存，因此店铺×货号矩阵不能依赖日更浏览器快照；本任务只有在19店库存全部成功、无缺失后才重建独立的轻量 `inventoryStock` section，并通过 PostgreSQL `NOTIFY` + SSE 更新已打开页面，不重复生成耗时较长的完整 `linksData`。矩阵仅接受45分钟内 OpenAPI 确认已上架的库存，过期或缺失时显示未知，不回退到旧库存。
- `shein-bi-cloud-session-manager.timer`：每天仅一个 `00:45` 入口，顺序巡检/恢复当前 19 店 WebAPI + SBN 登录态并写入夜间依赖 marker。外层资源 defer(75) 在同一 service/run 内持续退避到 `01:27`；到截止时间仍未启动时写 deferred/failed marker 和 `cloud_ops_alerts/session-manager-last.json`，返回真实非成功。只有当日 `done` marker 与同日 19/19 报告同时成立才幂等跳过；无证据 `warning` 必须重做，不新增第二个 timer 或补跑队列。
- `shein-bi-cloud-manual-login-recovery.timer`：每小时 `:47` 在安全窗口消费私有恢复队列，定向补跑该店之前失败的链接/业务域数据；`.path` 必须保持禁用，避免任意分钟拉起 Chrome。service 使用独立 cgroup 和内存护栏，不把 Chrome 补采挂在 Portal cgroup 下。
- `shein-bi-cloud-yesterday.timer`：每天在同一个既有 timer 内于 `02:45/03:05/03:20` 提供有限尝试，`Persistent=false`，仅在登录态和数据库备份 marker 完整后，用官方 OpenAPI 收齐前一天19店完整日切片并复核前两天稳定日；缺 `nightly-backup` marker 返回 75 且保持失败可见，逐店 fetch/load/每日行完整性门禁全部通过后，才调用数据库函数原子晋升最终日切片。任一失败、缺店或缺少每日行都禁止晋升；`yesterday-final` 的同日结构化 marker 让重试快速幂等。
- `shein-bi-db-backup.timer`：唯一 timer 在同一 timer 内于 `01:45/02:05/02:25` 提供有限尝试，使用 `Persistent=true`，独立备份业务库、Metabase 元数据库和生产人工特殊折扣登记，宿主 deadline 为 `02:37`；不等待或要求 `nightly-session`，每次显式绑定当天 `run-date/business-date`，同日结构化 `nightly-backup` marker 与 `--skip-if-done` 负责幂等并阻止第二个 dump。生产 unit 固定 `SHEIN_BI_BACKUP_OFFSITE_ENABLED=0`：数据库备份先原子发布并校验本地 SHA-256，成功后不探测/写 COS、也不调用远端 verifier；过期目录仅在 `BACKUP_ROOT` 的直接、非隐藏子目录且自身 checksum 校验通过时，经父目录安全门禁、quarantine 和 inode/manifest 复核后删除，保留 7 天。Profile/WebAPI session 的 AES-256-GCM 归档能力保留但默认 `SHEIN_BI_BROWSER_STATE_BACKUP_ENABLED=0`，不属于数据库备份 SLA；只有另行完成密钥异机保管、容量实测和恢复演练后才可显式启用。手工或其他 unit 将 `SHEIN_BI_BACKUP_OFFSITE_ENABLED=1` 时，原有 COS 归档、独立远端校验和删除门禁保持不变。
  当本次新备份已独立远端确认、但历史本地目录因旧绝对路径 checksum 等原因不满足当前删除合同，正常备份 run 保留旧目录并发出 warning，不得反向否定本次备份；显式 `--prune-only` 仍返回非零用于清理告警。
- `shein-bi-cloud-et-forwarder.timer`：每天 `01:12/04:20/07:20/10:20/13:20/17:20/20:20/23:20` 抓取 ET 货代仓/出库单、入仓，并轻量刷新订单/物流/售后相关 section；不开启开机补跑。需要服务器本地 `config/et_forwarder.local.json` 或 `ET_FORWARDER_USERNAME/ET_FORWARDER_PASSWORD`，密钥不进 GitHub。
- `shein-bi-cloud-et-storage-fee.timer`：每天 `14:20` 只读抓取 ET 仓储费最终账单与 SKU 明细，执行 canonical 去重、利润 cache 发布、四层对账与受队列控制的 `profit/homeProfit` 刷新；`Persistent=false`，失败必须告警，不能静默跳过。
- 每日经营刷新：每天 `07:10` 只启动一个 `shein-bi-cloud-morning-chain.service`。`run_cloud_morning_chain_job.sh` 以 flock 串行并原子保存 active run context；同日重启复用相同日期与绝对 deadline。跨日旧 child 不再执行，旧失败留痕后本次 activation 继续当天。生产 unit 的前序阶段硬截止于库存窗口前，库存拥有最后2700秒并以 `inventory-started` checkpoint 支持重启续跑；脚本直跑的保守默认仍是4500秒。只有共享语义校验器确认19店/38份原始工件、库存 marker、plan/result、policy/authorization、逐条终态回读及全部 hash 后，`daily-operating-refresh` done 才算成功；终态失败保持非零。库存 POST 前先 fsync 不可变 intent，接口只提交一次；未知结果或回读延迟只能继续回读/人工核销，禁止再次提交。
- 库存维护：不再有独立主 timer 和 retry timer；它是每日经营 run 的最后阶段，并在同 run 内先刷新当前19店 OpenAPI 库存。库存写入出现业务阻断时记录终态结果，不创建另一个用户任务。
- `shein-bi-cloud-daily-refresh.service`：统一执行前一完整日链接/业务域、SBN 营销概览、RTV 退货轨迹复核、入仓、体检与 BI 刷新；不再重复调用 MBRs 全店营销价格栈扫描，实时普通活动/券/限时折扣只由独立 guard 读取。全店日指标仍全 0 时跳过链接/业务域入仓刷新。该服务由晨间链路触发；启动前等待销售/ET 等写入任务并检查内存，忙碌或低内存时记录状态后跳过。OpenAPI runner 先单进程 schema ensure，再让 worker `--skip-ensure` 并行入仓；销售在切换日以后遵守“Webhook 当天增量 + 03:00 全店深度匹配后原子晋升”，退货/商品等其它数据域仍按各自对账与日更边界收口。
- `cloud_daily_lark_report.sh` / `shein-bi-cloud-daily-lark-report.service`：日报服务保留为手动诊断入口；正式自动发送当前停用，晨间链路默认 `SHEIN_BI_MORNING_SEND_LARK_REPORT=0`。需要服务器本地 `config/lark_report.json`、`lark-cli` 和飞书授权，密钥/授权不进 GitHub。
- `shein-bi-cloud-order-closure.timer`：每天 `06:52` 只启动一个订单闭环 coordinator，从云端订单底库找未终态订单，重查 SHEIN 当前状态并写入 `ops.order_status_recheck_state`，只更新订单生命周期状态，不重写历史销售事实。瞬时资源压力返回 75 时不再结束当天任务，而是在同一 service/run 内每 60 秒重试，最晚 `07:27` 前取得启动机会；持续无法启动才明确失败并告警。成功后把 `orders` 放入受锁队列，不直接扇出重建。
- `shein-bi-session-secret.service`：Portal/Query 共享会话签名 secret 的唯一写 owner。oneshot 只在安全的 `/data/shein-bi/state` 中用 `O_EXCL` 创建 0600 普通文件并精确回读；已有文件只校验，软链、非普通文件、权限/属主或内容异常全部失败关闭，日志只记录不可逆 fingerprint，不输出 secret。Portal/Query 均只读加载，缺失时拒绝启动。
- `shein-bi-portal.service`：BI Portal 常驻入口，必须以 `sheinops` 运行并保留 `MemoryHigh=1200M` / `MemoryMax=2200M` / `OOMPolicy=stop` / `Restart=always`，防止问数网关或 section 服务异常占满整机内存。V8 旧空间通过 `Environment=NODE_OPTIONS=--max-old-space-size=1536` 固定为 1536MiB，作为低于 cgroup 硬上限的最后一道护栏；它不能替代有界内存实现。2026-08-14 的 210,748,631 字节 core 已证明单纯提高到 1536MiB 仍会 OOM，因此 Portal 读取 core 元数据、叠加实时商品对账 warning 和返回 `/data.json` 时必须使用有界流式扫描/顶层 `audit` 替换，不得重新引入整份 `readFile + JSON.parse + JSON.stringify/gzip`。每次启动前由 `ExecStartPre` 从当前 `scripts/bi_app/client.js` / `styles.css` 原子重建正式 `outputs/bi-portal/index.html`，禁止出现源码已发布而页面仍执行旧内嵌前端的情况。Portal 仍需调用经过白名单约束的 `sudo docker` 子命令并与浏览器维护任务共享临时目录，所以不能照抄 Lark bot 的 `NoNewPrivileges` / `PrivateTmp`；其余内核、systemd、umask 护栏由 unit 固化。认证启动前必须等待 `shein-bi-session-secret.service`，运行进程不再创建或修复 secret。Portal 是 `/srv/shein-bi/partner-cli` 的唯一发布写 owner；停机信号先同步关闭 HTTP/upgrade admission 并结束 SSE，再有界排空已接收 handler；只有排空成功才依次停止 worker/bridge 和 store，超时强制断连接并以失败终态退出。
- `shein-bi-query.service`：认证只读入口，监听 `127.0.0.1:8791`。只允许 1 个重查询、最多排队 3 个，V8 old space 1024MiB，`MemoryHigh=1024M`、`MemoryMax=1400M`；无 worker、Webhook、AI、live bridge、warmup 或生成副作用。它只读 state/outputs 与 Portal 同一 `/srv/shein-bi/partner-cli` managed store，profile 两条路径均不可见，也不暴露 release deploy 写路由。Nginx 只把精确的 9 个认证只读路由转给它，故障不得回退到 Portal。Query health 会验证 Partner CLI 当前版本可读；紧急 fallback 可维持 CLI 使用，但 snapshot 必须保留 `PARTNER_CLI_RELEASE_UNMANAGED` blocker，不能冒充正式发布。其 state namespace 保持只读，secret 缺失/无效时由 loader 明确失败，不在 Query 内补写。SIGTERM/SIGINT 使用同一 5 秒有界 admission/drain/store 关闭契约，不在活跃 handler 仍运行时提前关闭 gateway。
- `shein-bi-cloud-portal-section-queue.timer`：唯一 timer 每小时 `:02/:32` 给 pending section 有界机会；`:02` 为 `HEAVY_ALLOWED=0` 的 light-only 槽，deadline `:14`、最多一个轻 section，`:32` 为 heavy 槽，deadline `:44`。unit、slot 与 worker 共同拒绝 `01:*`，并拒绝 `02:02/03:02/07:02` 特殊维护窗口；其余小时只接受 `:01–04/:31–34`。晨链 active、activating、reloading 或状态未知时，slot 仍动态让路并以 75 fail-closed。首页精简流量和成交价散点按首页优先级排队，页面强制刷新最高优先；后台项随等待时间老化提权，不能被连续订单/利润刷新永久饿死。SSH 直接调用 worker 或在安全窗口外启动必须返回 75；中断时 lease 回到 pending，旧 section 文件继续原子可读。

### Pipeline marker 跨服务目录一次性修复

`scripts/pipeline_marker.mjs` 只在 marker root 和具体日期目录上强制 `02770`（setgid + group-write），不递归修改任意路径；marker 文件内容、大小和 SHA-256 契约不变。canonical marker root 是 `/data/shein-bi/state/pipeline-markers`，属主保持 `sheinops:sheinops`；`/opt/shein-bi/app/state` 是只读 bind/兼容路径，禁止从那里写入。`run_pipeline_stage.sh --require-run-date STAGE` 只要求依赖 marker 与当前 stage 同一 run-date 且状态完成，不要求 business-date 相同；部署这次修复时，仅在 canonical root 模式不是 `2770` 时精确执行一次：

```bash
sudo -n chmod 2770 /data/shein-bi/state/pipeline-markers
```

当前 `2026-08-23` 日期目录已经是 `sheinops:sheinops 2770`，无需改动；不要使用 `chmod -R`、不要执行任何 `chown`、也不要对整个 state 目录盲目修权限。现有 `nightly-backup` 等文件保持原有内容/哈希和文件权限。此后代码会在 root/date 两级写入前显式校验并修复目录模式，权限无法修复会失败关闭。
- `shein-bi-webhook.service`：SHEIN OpenAPI Webhook 独立常驻入口与数据库队列 worker，只监听 `127.0.0.1:8792`；正式公网回调走标准 443 的 Cloudflare -> HAProxy SNI/来源门禁 -> Caddy 10443 -> Nginx SHEIN 官方推送 IP allowlist，`8443` 只保留受限回退。入口预算 1.2 秒、receipt SQL 预算 0.8 秒，只在 AES 密文可靠落库后回 200。worker 使用专属 `shein_webhook_ops` 与 `/srv/shein-bi/secrets/webhook-warehouse.env`，不得复用 Portal 的 `shein_link_ops`/secret；它没有运营任务表或事实表原始 DML，只能只读回读并调用按单 apply 函数，也没有日汇总/reconciliation 权限；风险事件先封闸后发送 P0 飞书摘要。开放平台订阅/调试使用的 App 级技术投递必须强制为 `appScopedOnly + P3`，只留审计 receipt，不得封闸、同步订单/退货、改运营任务或发飞书；BI 默认不展示此类技术记录。服务不调用 sudo/Docker，也绝不直接写 SHEIN；飞书问数服务继续保持暂停。
- `shein-bi-portal.service` 的负责人规则分发使用独立 `/srv/shein-bi/owner-knowledge-repo` 工作树、`owner-knowledge` 分支和 `/srv/shein-bi/runtime/owner-knowledge-git-publish.lock`。独立 deploy key 只放 `~sheinops/.ssh` 且权限 `600`；Portal 主工作树即使有生产运行态改动也不能被规则 publisher 暂存。远端 commit 先登记 pending，GitHub Actions 校验并调用专用激活端点后才切 current；分发失败由一小时 reconciliation 重试，所有入口的 `execute` 在 distribution 未追平时失败关闭。激活 token 只放 GitHub secret 与 `/srv/shein-bi/secrets/portal-warehouse.env`。
- `shein-bi-lark-sales-qa.service`：飞书只读问数机器人代码和 unit 保留，但 2026-07-11 起生产主动暂停，必须保持 `disabled + inactive`，部署时不得 `enable`、`start` 或 `enable --now`。若未来经明确授权恢复，仍必须以 `sheinops` 运行，保留 `HOME=/home/sheinops`、`NoNewPrivileges`、`PrivateTmp` 和内存护栏；Lark keychain 不得进入仓库/日志。
- `shein-bi-cloud-browser-cleanup.timer`：每天仅在 `03:20/09:25/21:20` 三个非核心窗口回收过期或死亡 owner 租约，再清理无有效任务租约保护的 headless Chrome 和临时目录。它不强杀可见人工登录窗口，也不打断仍持有有效租约的抓取/营销任务。
- `shein-bi-cloud-disk-maintenance.timer`：每天 `00:10` 执行低优先级磁盘维护，并必须在 `00:27` 前释放主机重任务锁。生产 unit 固定 `SHEIN_BI_BACKUP_OFFSITE_ENABLED=0`，local-only 下明确 skip 旧 outputs 的归档和删除；仍继续受控清理保留 7 天的 tmp，以及在根盘达到 75%、无有效浏览器租约和无 Chrome 进程时清理可再生 profile cache。由于 ET 与抓数产物存在经过审计的 root/sheinops 混合属主，该 service 以 root 读取和删除明确白名单路径，但不启动浏览器、不加载登录页，也不写业务数据；永不删除 Cookie、Local Storage、IndexedDB 等登录/持久状态。journald 由 `90-shein-bi-journald-disk-cap.conf` 限制为最多 1GB，并至少给根盘保留 5GB。
- `shein-bi-cloud-marketing-live-guard.service`：每天 `11:00` 只启动一个巡检 coordinator；普通活动、价格栈和 guard 报告的瞬时失败在同一 run 内仅重试失败阶段，不再依赖 13:00/16:00 重跑整套巡检。该服务以 session HTTP 一次读取 19 店普通活动、15% 券 active 集合与当前/未来活动价，生成精确 manifest/hash 与 repair queue；有待修复项时不提前发中间群报，必须等本地 repair/write 与最终回读终态后只发一次最终报告。
- `shein-bi-cloud-marketing-repair.timer`：仅作本机离线后的晚间应急兜底，仍只由现有 `20:45/21:15` 两个时点触发，不新增 timer 或队列。每次先用 19 店 browserless live readback 重建精确剩余队列；存在 backlog 时在同一云端执行器内保持单浏览器、逐组串行，单轮最多 32 组。每组启动前重新检查预算，`22:55` 为 graceful cutoff，且不足 900 秒时不再开新组；外层 hard deadline 固定为 `23:10`，确保在 `23:20` ET 任务前释放资源。未完成组按 exact key 保留为 deferred，第二次 timer 只做幂等 catch-up，不重放已成功组。
- Codex 自动巡检不另设固定晚间汇总。每日待议价、营销、淘汰链接巡检分别按现有 Codex 自动任务的实际时间执行，并在各自任务完成后把同一份人话结论和产出文件发到团队运营群，避免重复消息或提前汇总未完成结果。
- guard 与 repair 都通过 `SHEIN_BI_MANUAL_LIMITED_DISCOUNT_REGISTRY=/srv/shein-bi/runtime/marketing_manual_limited_discount_overrides.json` 读取生产可变登记；不得再让 timer 改写仓库 `config/` 下的种子文件。
- `shein-bi-cloud-watchdog.timer`：每小时只读巡检。它读取一次 canonical maintenance marker，只有 23 个 guard 文件与有效 `ExecCondition` 均匹配时才按 service class 抑制预期停机；始终检查 always 服务、源码、28-service runtime namespace，以及 marker 对应的本地 attestation/checksum 与 annotated tag。维护结束与普通恢复同轮出现时合并一次通知；失败保留同一 outbox/idempotency 重试。它可以用后续完整 19 店扫描证据收口孤立历史 warning，但必须保留原状态和 recovery。

## 半托数据盘

生产半托的大体积运行数据放在独立云硬盘 `/data`，canonical 路径为：

- `/data/shein-bi/profiles`
- `/data/shein-bi/state`
- `/data/shein-bi/outputs`
- `/data/shein-bi/runtime` bind mount 到 `/srv/shein-bi/runtime`
- `/data/shein-bi/backups` bind mount 到 `/srv/shein-bi/backups`

V4 layout 只在宿主层把 profiles/state 以 `bind,ro` 映射到 `/opt/shein-bi/app/{profiles,state}`；宿主 `/opt/shein-bi/app/outputs` 不再挂载。每个 service 通过 `50-runtime-paths.conf` 获得 unit-private `BindPaths` / `BindReadOnlyPaths`，权限由 `lib/cloud_runtime_path_policy.mjs` 的 28-service 完整表决定，没有 fallback。`/etc/fstab` 与 drop-in 必须使用固定路径；任一挂载缺失时 service fail closed。迁移脚本只接受 canonical 路径、`mode=all` maintenance、全部 service inactive、无 Chrome 和 source tree 外备份目录。迁移或恢复后至少验证：

**双侧只读契约（source 与 target 都不可写）**：bind（即使是只读 bind）只改变 service 在 *target* 路径看到的挂载，canonical `/data/shein-bi` 源仍可直接访问且可写，因此每个非可写策略都必须双侧保护：
- `profiles=host-ro`：`BindReadOnlyPaths=/data/shein-bi/profiles:/opt/shein-bi/app/profiles`（legacy/target 只读）**并且** `ReadOnlyPaths=/data/shein-bi/profiles`（canonical 源只读）。
- `state/outputs=ro`：同样 `BindReadOnlyPaths` + `ReadOnlyPaths=/data/shein-bi/{state,outputs}`，canonical 源必须进入 `ReadOnlyPaths`。
- `profiles=none`：`InaccessiblePaths=/data/shein-bi/profiles /opt/shein-bi/app/profiles` 同时阻断 canonical 与 legacy/target；不给任何 profile bind / `ReadOnlyPaths` 视图。
- `profiles=rw`：`BindPaths`（双侧可写），不出现该域的 `ReadOnlyPaths`。

`shein-bi-webhook.service` 保持 `profiles=none`：它只运行 `serve_shein_webhook.mjs`，无 Chrome/浏览器 profile 责任，业务不需要 19 店 profile。policy 表、installer 落盘与 effective `systemctl show` 回读都必须满足 `InaccessiblePaths=/data/shein-bi/profiles /opt/shein-bi/app/profiles`，且不含任何 profile bind。

迁移器使用 source tree 外的 v2 journal 记录每个已落盘阶段。`--apply` 失败或进程被终止时不自动回滚，也不删除现场；先无参数重跑只读审计，确认返回的 `recovery.action=resume`、phase 和 stamp，再用同一条 `--apply --confirm MIGRATE_CLOUD_RUNTIME_LAYOUT_V2` 恢复。只有审阅 journal、fstab 与备份指纹后才能显式执行 `--rollback --confirm MIGRATE_CLOUD_RUNTIME_LAYOUT_V2`；脚本拒绝无 active journal 的盲回滚。不要手工移动/删除 profile、state、outputs 或迁移备份。

迁移或恢复后至少验证：
商品详情/库存 OpenAPI 快照的统一根目录由 `SHEIN_OPENAPI_PRODUCT_CACHE_DIR` 控制。生产
systemd units 固定为 `/srv/shein-bi/runtime/openapi-product-cache`，该目录不属于
`/opt/shein-bi/app` checkout，部署替换源码时不会丢失；未设置 env 的本地运行仍默认使用
`outputs/shein_openapi_products/`。

```bash
findmnt --verify
findmnt /data /opt/shein-bi/app/profiles /opt/shein-bi/app/state /srv/shein-bi/runtime /srv/shein-bi/backups
findmnt -rn -o OPTIONS --target /opt/shein-bi/app/profiles | grep -Eq '(^|,)ro(,|$)'
findmnt -rn -o OPTIONS --target /opt/shein-bi/app/state | grep -Eq '(^|,)ro(,|$)'
! mountpoint -q /opt/shein-bi/app/outputs
systemctl show shein-bi-portal.service shein-bi-query.service shein-bi-webhook.service \
  -p RequiresMountsFor -p BindPaths -p BindReadOnlyPaths -p ReadOnlyPaths -p InaccessiblePaths
```

全托目录不属于这组 bind mount，不得混入半托数据盘迁移脚本或 drop-in。

注意：`shein-bi-cloud-daily-refresh.service` 和它内部调用的 `cloud_link_business_sync.sh` 必须以 `sheinops` 运行，不能用 root 跑 SHEIN Chrome profile；否则会留下 root-owned profile 文件，导致登录态管家读 profile 报 `EACCES`。统一日更只收口前一完整日的慢变/补采，不重复承担当天销售；当天销售由半托 Webhook + OpenAPI 按单更新。迁移时停用并删除旧 `today` timer，mask 旧 `link-business/openapi-hl` 分散 timer；`rtv-verify` 已恢复为受共享锁保护的独立每日任务，不得 mask。`shein-bi-cloud-morning-chain.timer`、`shein-bi-cloud-session-manager.timer` 与 `shein-bi-db-backup.timer` 使用 `Persistent=true`，并各自在 service 内以同日 marker 幂等防重；其余 timer 使用 `Persistent=false`，事实以各 `.timer` 为准。ET forwarder 保持 root 执行，因为入仓依赖 Docker/root 环境，且 ET 使用独立 profile。

资源护栏：高频销售和 ET 是轻量高优先任务；`daily-refresh` 是低优先慢任务，由晨间链路在销售刷新完成后启动。生产 oneshot 任务必须保留 `MemoryHigh` / `MemoryMax` / `OOMPolicy=stop`，常驻服务必须保留自己的 `MemoryHigh` / `MemoryMax` / `OOMPolicy=stop` / `Restart=always`；`daily-refresh` 必须保留启动前的忙碌写入任务等待和可用内存检查。宁可让慢变补采晚一次，也不要为了补齐链接/营销/RTV 数据把 BI Portal、Metabase 或销售刷新拖死。

权限护栏：部署前后先运行 `sudo bash scripts/harden_cloud_runtime_permissions.sh` 审计；确认清单后再运行 `sudo bash scripts/harden_cloud_runtime_permissions.sh --apply`。该通用脚本的旧 `sheinops:sheinops` app-root 结果不满足库存 writer 的 check-to-exec 威胁模型；安装库存兼容 guard 后，必须再按本节运行 `harden_inventory_writer_checkout_permissions.py`，以 root-owned tracked source 和精确运行态 allowlist 结果为最终权限合同。所有库存 cutover 操作只使用 `/srv/shein-bi/runtime/locks/inventory-v2-cutover.lock`（或显式的全局 override）；`SHEIN_BI_RUNTIME_ROOT` 与 cwd 不得改变该默认锁。其他生产 `flock` 仍通过 `scripts/lib/shared_lock.sh` 管理，且不得使用 `/tmp/*.lock` 或 `0666` 共享锁。

部署到服务器后执行：

```bash
cp infra/systemd/*.service infra/systemd/*.timer infra/systemd/*.path infra/systemd/shein-host-heavy-bi.slice /etc/systemd/system/
rm -f /etc/systemd/system/shein-bi-cloud-morning-link-chunk-2.{service,timer} \
  /etc/systemd/system/shein-bi-cloud-morning-link-recovery.{service,timer} \
  /etc/systemd/system/shein-bi-cloud-morning-supplements.{service,timer} \
  /etc/systemd/system/shein-bi-daily-inventory-replenishment-guard.timer \
  /etc/systemd/system/shein-bi-daily-inventory-replenishment-guard-retry.{service,timer}
cp infra/systemd/90-shein-bi-journald-disk-cap.conf /etc/systemd/journald.conf.d/
chmod +x scripts/cloud_bi_refresh.sh scripts/cloud_db_backup.sh scripts/cloud_disk_maintenance.sh scripts/cloud_et_forwarder_sync.sh scripts/cloud_et_storage_fee_sync.sh scripts/cloud_link_business_sync.sh scripts/cloud_link_business_store_fetch.sh scripts/cloud_daily_refresh.sh scripts/cloud_daily_lark_report.sh scripts/cloud_marketing_live_guard.sh scripts/cloud_marketing_repair_worker.sh scripts/cloud_openapi_stock_refresh.sh scripts/cloud_morning_chain.sh scripts/run_cloud_morning_chain_job.sh scripts/run_cloud_session_manager_job.sh scripts/cloud_order_closure.sh scripts/cloud_portal_section_queue_worker.sh scripts/cloud_today_sales_reconcile.sh scripts/enqueue_bi_portal_sections.sh scripts/run_host_browser_read_job.sh scripts/run_host_heavy_job.sh scripts/run_pipeline_stage.sh scripts/verify_cos_backup_remote.sh
systemd-analyze verify /etc/systemd/system/shein-bi-session-secret.service /etc/systemd/system/shein-bi-portal.service /etc/systemd/system/shein-bi-query.service /etc/systemd/system/shein-bi-webhook.service /etc/systemd/system/shein-bi-lark-sales-qa.service /etc/systemd/system/shein-bi-cloud-morning-chain.service /etc/systemd/system/shein-bi-cloud-morning-chain.timer /etc/systemd/system/shein-bi-cloud-session-manager.service /etc/systemd/system/shein-bi-cloud-session-manager.timer /etc/systemd/system/shein-bi-db-backup.service /etc/systemd/system/shein-bi-cloud-disk-maintenance.service
bash scripts/install_cloud_maintenance_guards.sh --systemd-root /etc/systemd/system --apply --confirm APPLY_CLOUD_MAINTENANCE_GUARDS_V1
bash scripts/install_cloud_runtime_path_namespaces.sh --root /opt/shein-bi/app --systemd-dir /etc/systemd/system --apply --confirm INSTALL_CLOUD_RUNTIME_PATH_NAMESPACES
# 首次 V4 layout 切换仅在 mode=all、全部 shein-bi service inactive 且无 Chrome 时执行一次：
sudo bash scripts/migrate_cloud_runtime_mount_layout.sh
sudo bash scripts/migrate_cloud_runtime_mount_layout.sh --apply --confirm MIGRATE_CLOUD_RUNTIME_LAYOUT_V2
# 若 apply 中断：先只读审计 recovery.action/phase/stamp，再以同一 apply 命令恢复。
# 只有人工审阅 active journal 和备份指纹后才允许显式回滚：
# sudo bash scripts/migrate_cloud_runtime_mount_layout.sh --rollback --confirm MIGRATE_CLOUD_RUNTIME_LAYOUT_V2
systemctl daemon-reload
# 启用 timer 时不要对一组重任务使用 `enable --now` 批量拉起。
# 在某些 systemd 状态下这会立即触发 timer 关联服务，造成部署时销售、
# ET、日更、登录态管家等任务并发。推荐先 enable，再逐个 start timer；
# start timer 只启动计时器，不应手动 start 对应 service。
systemctl disable --now shein-bi-cloud-manual-login-recovery.path
systemctl disable --now shein-bi-cloud-morning-link-chunk-2.timer shein-bi-cloud-morning-link-recovery.timer shein-bi-cloud-morning-supplements.timer shein-bi-daily-inventory-replenishment-guard.timer shein-bi-daily-inventory-replenishment-guard-retry.timer || true
systemctl enable shein-bi-portal.service shein-bi-query.service shein-bi-webhook.service shein-bi-cloud-morning-chain.timer shein-bi-cloud-yesterday.timer shein-bi-db-backup.timer shein-bi-cloud-order-closure.timer shein-bi-cloud-rtv-verify.timer shein-bi-cloud-browser-cleanup.timer shein-bi-cloud-disk-maintenance.timer shein-bi-cloud-marketing-live-guard.timer shein-bi-cloud-marketing-repair.timer shein-bi-cloud-openapi-stock-refresh.timer shein-bi-cloud-today-sales-reconcile.timer shein-bi-cloud-portal-section-queue.timer shein-bi-cloud-manual-login-recovery.timer shein-bi-cloud-watchdog.timer
systemctl start shein-bi-portal.service shein-bi-query.service shein-bi-webhook.service shein-bi-cloud-morning-chain.timer shein-bi-cloud-yesterday.timer shein-bi-db-backup.timer shein-bi-cloud-order-closure.timer shein-bi-cloud-rtv-verify.timer shein-bi-cloud-browser-cleanup.timer shein-bi-cloud-disk-maintenance.timer shein-bi-cloud-marketing-live-guard.timer shein-bi-cloud-marketing-repair.timer shein-bi-cloud-openapi-stock-refresh.timer shein-bi-cloud-today-sales-reconcile.timer shein-bi-cloud-portal-section-queue.timer shein-bi-cloud-manual-login-recovery.timer shein-bi-cloud-watchdog.timer
# 飞书问数保持暂停；以下两条必须分别返回 disabled / inactive：
systemctl is-enabled shein-bi-lark-sales-qa.service || true
systemctl is-active shein-bi-lark-sales-qa.service || true
# ET / 登录态在服务器本地 secret 与授权配置完成后再启用；当前生产已验收：
# systemctl enable shein-bi-cloud-et-forwarder.timer shein-bi-cloud-et-storage-fee.timer shein-bi-cloud-session-manager.timer
# systemctl start shein-bi-cloud-et-forwarder.timer shein-bi-cloud-et-storage-fee.timer shein-bi-cloud-session-manager.timer
# 旧的 link-business / openapi-hl 分散 timer 已由晨间链路接管；RTV 不在此列：
# systemctl disable --now shein-bi-cloud-link-business.timer shein-bi-cloud-openapi-hl.timer
# systemctl mask --force shein-bi-cloud-link-business.timer shein-bi-cloud-openapi-hl.timer
# 旧的每小时当天销售 timer 已由 Webhook 替代：
# systemctl disable --now shein-bi-cloud-today.timer
# rm -f /etc/systemd/system/shein-bi-cloud-today.timer
```
