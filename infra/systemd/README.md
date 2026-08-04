# SHEIN BI cloud systemd units

本文件只维护 unit/timer 的部署参数与安全护栏；生产排班、人工补跑和验收见 [../../docs/cloud-bi-operations.md](../../docs/cloud-bi-operations.md)。调度事实以各 `.timer` 的 `OnCalendar` 为准。

## 当前启用集与条件启用集（2026-07-30）

**当前生产应启用**：`shein-bi-portal.service`、`shein-bi-webhook.service`，以及 `shein-bi-cloud-morning-chain`、`shein-bi-cloud-yesterday`、`shein-bi-db-backup`、`shein-bi-cloud-order-closure`、`shein-bi-cloud-browser-cleanup`、`shein-bi-cloud-disk-maintenance`、`shein-bi-cloud-marketing-live-guard`、`shein-bi-cloud-marketing-repair`、`shein-bi-cloud-watchdog`、`shein-bi-cloud-et-forwarder`、`shein-bi-cloud-et-storage-fee`、`shein-bi-cloud-session-manager`、`shein-bi-cloud-manual-login-recovery`、`shein-bi-cloud-openapi-stock-refresh` 的 timer；人工登录恢复同时启用同名 `.path` 以便队列落盘后立即启动。`daily-refresh` 由晨间链路触发，没有独立 timer。

**条件启用**：`shein-bi-cloud-et-forwarder.timer`、`shein-bi-cloud-et-storage-fee.timer`、`shein-bi-cloud-session-manager.timer` 只有在服务器本地 ET/店铺授权和对应 profile 已验收时才启用；当前生产已验收时属于上面的启用集。`shein-bi-cloud-today.service` 只作人工灾备，不安装 timer。`shein-bi-lark-sales-qa.service` 和自动飞书日报保持 `disabled + inactive`。

凌晨 `02:20` 登录态管家、`02:40` 数据库备份、`03:00` 昨日最终核对共享 `/opt/shein-bi/app/state/locks/shein-bi-nightly-maintenance.lock`：运行期用 `flock` 防并发；三个 timer 因宕机而同时补跑时，再由不触发额外任务的软 `Before/After` 顺序保证 `session-manager → db-backup → yesterday`。登录态管家每日验证各店 GSP/SBN 后，同时刷新 browser session 和 WebAPI Cookie session；WebAPI 导出必须是本轮新文件且只读探针通过，不能只检查旧文件存在。备份超时预算必须覆盖最长锁等待、备份 P99 时长和余量。登录态/销售 refresh unit 使用 `UMask=0077`，浏览器和凭据新落盘默认仅 owner 可读；备份使用 `UMask=0027`，备份目录可由运维组受控读取。共享锁文件由 unit 显式创建为 `sheinops:sheinops 0660`，不能改成 `/tmp` 锁。

Linux 生产健康只以 systemd、watchdog、Portal health 和云端数据审计为准；旧 Windows 计划任务只是历史回滚参考，不能再用作 Linux 页面或告警的健康依据。

- 当天销售不再使用 `shein-bi-cloud-today.timer` 每小时抓取。半托订单 Webhook 收到后按单查询 OpenAPI 并增量更新正式销售事实，Portal 通过 PostgreSQL `NOTIFY` + 登录态 SSE 刷新当前页面；`shein-bi-cloud-today.service` 只保留为人工灾备入口，不安装/启用对应 timer。
- `shein-bi-cloud-openapi-stock-refresh.timer`：每小时 `:12/:42` 轻量刷新19店商品列表与库存，复用最近成功的商品详情，不启动浏览器。SHEIN Webhook 不提供完整的当前虚拟库存，因此店铺×货号矩阵不能依赖日更浏览器快照；本任务只有在19店库存全部成功、无缺失后才重建独立的轻量 `inventoryStock` section，并通过 PostgreSQL `NOTIFY` + SSE 更新已打开页面，不重复生成耗时较长的完整 `linksData`。矩阵仅接受45分钟内 OpenAPI 确认已上架的库存，过期或缺失时显示未知，不回退到旧库存。
- `shein-bi-cloud-session-manager.timer`：每天 `02:20`，在 `03:00` 最终日核对前顺序巡检/恢复当前 19 店 WebAPI + SBN 登录态，并检查 profile 体积。
- `shein-bi-cloud-manual-login-recovery.path` / `.timer`：人工登录完成且双重探测通过后，立即消费私有恢复队列，定向补跑该店之前失败的链接/业务域数据；path 负责即时唤醒，2 分钟 timer 只作漏触发兜底。service 使用独立 cgroup 和内存护栏，不把 Chrome 补采挂在 Portal cgroup 下。
- `shein-bi-cloud-yesterday.timer`：每天 `03:00` 用官方 OpenAPI 收齐前一天19店完整日切片并复核前两天稳定日；逐店 fetch/load/每日行完整性门禁全部通过后，才调用数据库函数原子晋升最终日切片。该链路不再依赖易过期的 Seller Center Cookie 或浏览器 profile；任一失败、缺店或缺少每日行都禁止晋升。该每日唯一性任务使用 `Persistent=true`，service 自身仍通过锁和日期状态防重复。
- `shein-bi-db-backup.timer`：每天 `02:40` 备份业务库、Metabase 元数据库和生产人工特殊折扣登记到 `/srv/shein-bi/backups/auto`。本地保留 7 天；过期备份必须先归档到 `/lhcos-data/shein-bi-db-backups` 并通过源文件 SHA256、压缩包完整性和 COS 回读 SHA256 校验，之后才删除本地副本。COS 不可用或校验失败时保留本地文件。
- `shein-bi-cloud-et-forwarder.timer`：每天 `01:20/04:20/07:20/10:20/13:20/17:20/20:20/23:20` 抓取 ET 货代仓/出库单、入仓，并轻量刷新订单/物流/售后相关 section；不开启开机补跑。需要服务器本地 `config/et_forwarder.local.json` 或 `ET_FORWARDER_USERNAME/ET_FORWARDER_PASSWORD`，密钥不进 GitHub。
- `shein-bi-cloud-et-storage-fee.timer`：每天 `14:10` 只读抓取 ET 仓储费最终账单与 SKU 明细，执行 canonical 去重、利润 cache 发布、四层对账与 `profit/homeProfit` 预热。它与通用 ET 共用 profile/锁，但使用独立状态、输出和日志；`Persistent=true`，失败必须告警，不能静默跳过。
- `shein-bi-cloud-morning-chain.timer`：每天 `08:00` 启动晨间串行链路；默认 `SHEIN_BI_MORNING_SALES_REFRESH=0`，不再重复抓当天销售，直接启动 `shein-bi-cloud-daily-refresh.service` 做前一完整日的统一日更补采。自动飞书日报继续关闭（`SHEIN_BI_MORNING_SEND_LARK_REPORT=0`）。
- `shein-bi-cloud-daily-refresh.service`：统一执行前一完整日链接/业务域、SBN 营销概览、RTV 退货轨迹复核、入仓、体检与 BI 刷新；不再重复调用 MBRs 全店营销价格栈扫描，实时普通活动/券/限时折扣只由独立 guard 读取。全店日指标仍全 0 时跳过链接/业务域入仓刷新。该服务由晨间链路触发；启动前等待销售/ET 等写入任务并检查内存，忙碌或低内存时记录状态后跳过。OpenAPI runner 先单进程 schema ensure，再让 worker `--skip-ensure` 并行入仓；销售在切换日以后遵守“Webhook 当天增量 + 03:00 全店深度匹配后原子晋升”，退货/商品等其它数据域仍按各自对账与日更边界收口。
- `cloud_daily_lark_report.sh` / `shein-bi-cloud-daily-lark-report.service`：日报服务保留为手动诊断入口；正式自动发送当前停用，晨间链路默认 `SHEIN_BI_MORNING_SEND_LARK_REPORT=0`。需要服务器本地 `config/lark_report.json`、`lark-cli` 和飞书授权，密钥/授权不进 GitHub。
- `shein-bi-cloud-order-closure.timer`：每天 `06:30`（带 `RandomizedDelaySec=5m`）从云端订单底库找未终态订单，重查 SHEIN 当前状态并写入 `ops.order_status_recheck_state`，只更新订单生命周期状态，不重写历史销售事实；成功后刷新 orders section。日更补采由 `08:00` 晨间销售完成后触发，避免过早抓取前一日仍未产出的链接/流量指标。
- `shein-bi-portal.service`：BI Portal 常驻入口，必须以 `sheinops` 运行并保留 `MemoryHigh=1200M` / `MemoryMax=2200M` / `OOMPolicy=stop` / `Restart=always`，防止问数网关或 section 服务异常占满整机内存。每次启动前由 `ExecStartPre` 从当前 `scripts/bi_app/client.js` / `styles.css` 原子重建正式 `outputs/bi-portal/index.html`，禁止出现源码已发布而页面仍执行旧内嵌前端的情况。Portal 仍需调用经过白名单约束的 `sudo docker` 子命令并与浏览器维护任务共享临时目录，所以不能照抄 Lark bot 的 `NoNewPrivileges` / `PrivateTmp`；其余内核、systemd、umask 护栏由 unit 固化。
- `shein-bi-webhook.service`：SHEIN OpenAPI Webhook 独立常驻入口与数据库队列 worker，只监听 `127.0.0.1:8792`；正式公网回调走标准 443 的 Cloudflare -> HAProxy SNI/来源门禁 -> Caddy 10443 -> Nginx SHEIN 官方推送 IP allowlist，`8443` 只保留受限回退。入口预算 1.2 秒、receipt SQL 预算 0.8 秒，只在 AES 密文可靠落库后回 200。worker 使用专属 `shein_webhook_ops` 与 `/srv/shein-bi/secrets/webhook-warehouse.env`，不得复用 Portal 的 `shein_link_ops`/secret；它没有运营任务表或事实表原始 DML，只能只读回读并调用按单 apply 函数，也没有日汇总/reconciliation 权限；风险事件先封闸后发送 P0 飞书摘要。开放平台订阅/调试使用的 App 级技术投递必须强制为 `appScopedOnly + P3`，只留审计 receipt，不得封闸、同步订单/退货、改运营任务或发飞书；BI 默认不展示此类技术记录。服务不调用 sudo/Docker，也绝不直接写 SHEIN；飞书问数服务继续保持暂停。
- `shein-bi-portal.service` 的负责人规则分发使用独立 `/srv/shein-bi/owner-knowledge-repo` 工作树、`owner-knowledge` 分支和 `/srv/shein-bi/runtime/owner-knowledge-git-publish.lock`。独立 deploy key 只放 `~sheinops/.ssh` 且权限 `600`；Portal 主工作树即使有生产运行态改动也不能被规则 publisher 暂存。远端 commit 先登记 pending，GitHub Actions 校验并调用专用激活端点后才切 current；分发失败由一小时 reconciliation 重试，所有入口的 `execute` 在 distribution 未追平时失败关闭。激活 token 只放 GitHub secret 与 `/srv/shein-bi/secrets/portal-warehouse.env`。
- `shein-bi-lark-sales-qa.service`：飞书只读问数机器人代码和 unit 保留，但 2026-07-11 起生产主动暂停，必须保持 `disabled + inactive`，部署时不得 `enable`、`start` 或 `enable --now`。若未来经明确授权恢复，仍必须以 `sheinops` 运行，保留 `HOME=/home/sheinops`、`NoNewPrivileges`、`PrivateTmp` 和内存护栏；Lark keychain 不得进入仓库/日志。
- `shein-bi-cloud-browser-cleanup.timer`：每天仅在 `03:45/09:50/21:00` 三个非营销/日更窗口回收过期或死亡 owner 租约，再清理无有效任务租约保护的 headless Chrome 和临时目录。它不强杀可见人工登录窗口，也不打断仍持有有效租约的抓取/营销任务。
- `shein-bi-cloud-disk-maintenance.timer`：每天 `04:30`（随机延迟最多 10 分钟）执行低优先级磁盘维护。抓数原始产物本地保留 30 天，旧文件只有在 COS 归档、成员清单和 SHA256 校验完成后才删除；临时文件保留 7 天。由于 ET 与抓数产物存在经过审计的 root/sheinops 混合属主，该 service 以 root 读取和删除明确白名单路径，但不启动浏览器、不加载登录页，也不写业务数据。浏览器 profile 只有根盘达到 75% 且没有有效浏览器租约或 Chrome 进程时才清可再生缓存，永不删除 Cookie、Local Storage、IndexedDB 等登录/持久状态。journald 由 `90-shein-bi-journald-disk-cap.conf` 限制为最多 1GB，并至少给根盘保留 5GB。
- `shein-bi-cloud-marketing-live-guard.service`：`10:30/13:30/16:30` 提供每日巡检及失败重试窗口；当天首次成功后后续窗口退出。该服务以 session HTTP 一次读取 19 店普通活动、15% 券 active 集合与当前/未来活动价，生成精确 manifest/hash 与 repair queue；不启动浏览器、不申请浏览器租约、不执行清理、不持有写授权。`2026-07-18` 生产实测 `157s`、19/19 店、1516 行、Chrome `0 -> 0`。
- `shein-bi-cloud-marketing-repair.timer`：`10:50/12:50/14:50/16:50/18:50` 消费 guard 的精确队列，`19:30` 做当天最后一次续跑与回读；每轮总预算最多 8 个活动组。父 worker 取得浏览器租约后把 task/runId 传给子批次，只关闭本任务拥有的店铺；每组 preflight、精确 work hash、旧活动快照、事务 journal、失败补偿和最终全店 readback 缺一不可。
- Codex 自动巡检不另设固定晚间汇总。每日待议价、营销、淘汰链接巡检分别按现有 Codex 自动任务的实际时间执行，并在各自任务完成后把同一份人话结论和产出文件发到团队运营群，避免重复消息或提前汇总未完成结果。
- guard 与 repair 都通过 `SHEIN_BI_MANUAL_LIMITED_DISCOUNT_REGISTRY=/srv/shein-bi/runtime/marketing_manual_limited_discount_overrides.json` 读取生产可变登记；不得再让 timer 改写仓库 `config/` 下的种子文件。
- `shein-bi-cloud-watchdog.timer`：每小时只读巡检。它可以用后续完整 19 店扫描证据收口孤立的历史扫描 warning，但必须保留原日更状态并在报告写出 recovery；其它 warning 或不完整证据仍告警。

## 半托数据盘

生产半托的大体积运行数据放在独立云硬盘 `/data`，应用仍使用原绝对路径：

- `/data/shein-bi/profiles` bind mount 到 `/opt/shein-bi/app/profiles`
- `/data/shein-bi/outputs` bind mount 到 `/opt/shein-bi/app/outputs`
- `/data/shein-bi/runtime` bind mount 到 `/srv/shein-bi/runtime`
- `/data/shein-bi/backups` bind mount 到 `/srv/shein-bi/backups`

`/etc/fstab` 中的数据盘和四个 bind mount 必须使用 UUID/固定路径，不使用易漂移的 `/dev/vdX` 名称。每个 `shein-bi-*.service` 都应把 `shein-bi-data-disk-requires-mounts.conf` 安装为 systemd drop-in；任一挂载缺失时服务必须失败关闭，禁止写入系统盘上被 bind mount 遮蔽的空目录。迁移或恢复后至少验证：

```bash
findmnt --verify
findmnt /data /opt/shein-bi/app/profiles /opt/shein-bi/app/outputs /srv/shein-bi/runtime /srv/shein-bi/backups
systemctl show shein-bi-portal.service -p RequiresMountsFor
```

全托目录不属于这组 bind mount，不得混入半托数据盘迁移脚本或 drop-in。

注意：`shein-bi-cloud-daily-refresh.service` 和它内部调用的 `cloud_link_business_sync.sh` 必须以 `sheinops` 运行，不能用 root 跑 SHEIN Chrome profile；否则会留下 root-owned profile 文件，导致登录态管家读 profile 报 `EACCES`。统一日更只收口前一完整日的慢变/补采，不重复承担当天销售；当天销售由半托 Webhook + OpenAPI 按单更新。迁移时停用并删除旧 `today` timer，mask 旧 `link-business/openapi-hl/rtv-verify` 分散 timer。ET/watchdog 使用 `Persistent=false`；每日唯一性任务使用 `Persistent=true` 并依赖锁、当天成功状态、忙碌/资源门禁防重复，事实以各 `.timer` 为准。ET forwarder 保持 root 执行，因为入仓依赖 Docker/root 环境，且 ET 使用独立 profile。

资源护栏：高频销售和 ET 是轻量高优先任务；`daily-refresh` 是低优先慢任务，由晨间链路在销售刷新完成后启动。生产 oneshot 任务必须保留 `MemoryHigh` / `MemoryMax` / `OOMPolicy=stop`，常驻服务必须保留自己的 `MemoryHigh` / `MemoryMax` / `OOMPolicy=stop` / `Restart=always`；`daily-refresh` 必须保留启动前的忙碌写入任务等待和可用内存检查。宁可让慢变补采晚一次，也不要为了补齐链接/营销/RTV 数据把 BI Portal、Metabase 或销售刷新拖死。

权限护栏：部署前后先运行 `sudo bash scripts/harden_cloud_runtime_permissions.sh` 审计；确认清单后再运行 `sudo bash scripts/harden_cloud_runtime_permissions.sh --apply`。脚本只把 app 根目录收紧为 `sheinops:sheinops 0750`，并移除同一文件系统内普通文件/目录的 world-write，不递归改属主、不改组写位、不跟随 symlink，因此 root 与 `sheinops` 混合调度仍可工作。应用后必须确认 `worldWritableNonSymlinks=0`。所有生产 `flock` 路径必须固定在 `/opt/shein-bi/app/state/locks`，并通过 `scripts/lib/shared_lock.sh` 生成 `2770` 目录与 `0660 root|sheinops:sheinops` 锁；不得使用 `/tmp/*.lock` 或 `0666` 共享锁，否则定时任务会重新引入 world-write。

部署到服务器后执行：

```bash
cp infra/systemd/*.service infra/systemd/*.timer infra/systemd/*.path /etc/systemd/system/
cp infra/systemd/90-shein-bi-journald-disk-cap.conf /etc/systemd/journald.conf.d/
chmod +x scripts/cloud_bi_refresh.sh scripts/cloud_db_backup.sh scripts/cloud_disk_maintenance.sh scripts/cloud_et_forwarder_sync.sh scripts/cloud_et_storage_fee_sync.sh scripts/cloud_link_business_sync.sh scripts/cloud_daily_refresh.sh scripts/cloud_daily_lark_report.sh scripts/cloud_marketing_live_guard.sh scripts/cloud_marketing_repair_worker.sh scripts/cloud_openapi_stock_refresh.sh
systemd-analyze verify /etc/systemd/system/shein-bi-portal.service /etc/systemd/system/shein-bi-webhook.service /etc/systemd/system/shein-bi-lark-sales-qa.service
systemctl daemon-reload
# 启用 timer 时不要对一组重任务使用 `enable --now` 批量拉起。
# 在某些 systemd 状态下这会立即触发 timer 关联服务，造成部署时销售、
# ET、日更、登录态管家等任务并发。推荐先 enable，再逐个 start timer；
# start timer 只启动计时器，不应手动 start 对应 service。
systemctl enable shein-bi-portal.service shein-bi-webhook.service shein-bi-cloud-morning-chain.timer shein-bi-cloud-yesterday.timer shein-bi-db-backup.timer shein-bi-cloud-order-closure.timer shein-bi-cloud-browser-cleanup.timer shein-bi-cloud-disk-maintenance.timer shein-bi-cloud-marketing-live-guard.timer shein-bi-cloud-marketing-repair.timer shein-bi-cloud-openapi-stock-refresh.timer shein-bi-cloud-manual-login-recovery.path shein-bi-cloud-manual-login-recovery.timer
systemctl start shein-bi-portal.service shein-bi-webhook.service shein-bi-cloud-morning-chain.timer shein-bi-cloud-yesterday.timer shein-bi-db-backup.timer shein-bi-cloud-order-closure.timer shein-bi-cloud-browser-cleanup.timer shein-bi-cloud-disk-maintenance.timer shein-bi-cloud-marketing-live-guard.timer shein-bi-cloud-marketing-repair.timer shein-bi-cloud-openapi-stock-refresh.timer shein-bi-cloud-manual-login-recovery.path shein-bi-cloud-manual-login-recovery.timer
# 飞书问数保持暂停；以下两条必须分别返回 disabled / inactive：
systemctl is-enabled shein-bi-lark-sales-qa.service || true
systemctl is-active shein-bi-lark-sales-qa.service || true
# ET / 登录态在服务器本地 secret 与授权配置完成后再启用；日报/日更由 morning-chain 接管，不再启用独立 timer：
# systemctl enable shein-bi-cloud-et-forwarder.timer shein-bi-cloud-et-storage-fee.timer shein-bi-cloud-session-manager.timer
# systemctl start shein-bi-cloud-et-forwarder.timer shein-bi-cloud-et-storage-fee.timer shein-bi-cloud-session-manager.timer
# 旧的 link-business / openapi-hl / rtv-verify 分散 timer 已由 daily-refresh 接管；若服务器曾启用过，迁移时执行：
# systemctl disable --now shein-bi-cloud-link-business.timer shein-bi-cloud-openapi-hl.timer shein-bi-cloud-rtv-verify.timer
# systemctl mask --force shein-bi-cloud-link-business.timer shein-bi-cloud-openapi-hl.timer shein-bi-cloud-rtv-verify.timer
# 旧的每小时当天销售 timer 已由 Webhook 替代：
# systemctl disable --now shein-bi-cloud-today.timer
# rm -f /etc/systemd/system/shein-bi-cloud-today.timer
```
