# SHEIN BI cloud systemd units

这些 unit 用于 Linux 云端迁移阶段：

- `shein-bi-cloud-today.timer`：当天销售高频刷新为每小时整点一跑，但 `03:00` 由昨日定稿接管、`08:00` 由晨间链路接管（`00:00/01:00/02:00/04:00/05:00/06:00/07:00/09:00/.../23:00`），默认 `SHEIN_SALES_TRANSPORT=webapi`，继续用 WebAPI 入正式销售事实表并生成 BI 门户；OpenAPI 只写并行对账层。不开启 systemd 开机补跑，避免服务器重启后和日更/ET 叠加。
- `shein-bi-cloud-session-manager.timer`：每天 `02:20`，在 `02:00` 销售刷新结束后顺序巡检/恢复当前 19 店 WebAPI + SBN 登录态，并检查 profile 体积。
- `shein-bi-cloud-yesterday.timer`：每天 `03:00` 用 WebAPI 刷新前一天最终销售，并复核前两天稳定日；OpenAPI 最终日结果在并行对账层核对。不开启开机补跑，漏跑由 watchdog stale 检测暴露后人工补跑。
- `shein-bi-db-backup.timer`：每天 `02:40` 备份业务库和 Metabase 元数据库到 `/srv/shein-bi/backups/auto`，默认保留 14 天。
- `shein-bi-cloud-et-forwarder.timer`：每两小时 `01:20/03:20/.../23:20` 抓取 ET 货代仓/出库单、入仓，并轻量刷新订单/物流/售后相关 section；不开启开机补跑。需要服务器本地 `config/et_forwarder.local.json` 或 `ET_FORWARDER_USERNAME/ET_FORWARDER_PASSWORD`，密钥不进 GitHub。
- `shein-bi-cloud-morning-chain.timer`：每天 `08:00` 启动晨间串行链路：先用 WebAPI 刷新当天销售；当前自动飞书日报已关闭（`SHEIN_BI_MORNING_SEND_LARK_REPORT=0`），销售刷新成功后直接启动 `shein-bi-cloud-daily-refresh.service` 做统一日更补采。这样日更不再依赖固定 `08:50/09:10` 窗口，而是跟随销售刷新完成时间。
- `shein-bi-cloud-daily-refresh.service`：统一执行“日更补采”批次，顺序抓取前一完整日链接/业务域、补采营销活动/限时折扣/优惠券价格线索、RTV 退货轨迹复核，统一入仓、体检并刷新 BI 门户；全店日指标仍全 0 时跳过链接/业务域入仓刷新。该服务由晨间链路触发；启动前如果销售/ET/日报等写入任务仍在跑，会等待一段时间，超时或可用内存不足时写 `skipped_busy` / `skipped_low_memory` 状态并跳过本轮，避免重启后堆叠压垮服务器。需要服务器私有 SHEIN session / browser session，敏感运行态不进 GitHub。旧 HL-only OpenAPI 销售对账已退出生产日更；19 店 OpenAPI 销售对账仍保留为一周双跑质量监控，退货退款、商品/链接双跑对账由 `SHEIN_BI_DAILY_OPENAPI_*` 开关开启并只写隔离层。
- `cloud_daily_lark_report.sh` / `shein-bi-cloud-daily-lark-report.service`：日报服务保留为手动诊断入口；正式自动发送当前停用，晨间链路默认 `SHEIN_BI_MORNING_SEND_LARK_REPORT=0`。需要服务器本地 `config/lark_report.json`、`lark-cli` 和飞书授权，密钥/授权不进 GitHub。
- `shein-bi-cloud-order-closure.timer`：每天 `06:30`（带 `RandomizedDelaySec=5m`）从云端订单底库找未终态订单，重查 SHEIN 当前状态并写入 `ops.order_status_recheck_state`，只更新订单生命周期状态，不重写历史销售事实；成功后刷新 orders section。这个任务排在凌晨销售、登录态、昨日定稿之后；日更补采已移到 `08:50`，避免在 SHEIN 前一日链接/流量指标尚未产出时误抓全 0。
- `shein-bi-portal.service`：BI Portal 常驻入口，必须以 `sheinops` 运行并保留 `MemoryHigh=1200M` / `MemoryMax=2200M` / `OOMPolicy=stop` / `Restart=always`，防止问数网关或 section 服务异常占满整机内存。Portal 仍需调用经过白名单约束的 `sudo docker` 子命令并与浏览器维护任务共享临时目录，所以不能照抄 Lark bot 的 `NoNewPrivileges` / `PrivateTmp`；其余内核、systemd、umask 护栏由 unit 固化。
- `shein-bi-lark-sales-qa.service`：飞书只读问数机器人必须以 `sheinops` 运行，`HOME=/home/sheinops`，并保留 `NoNewPrivileges`、`PrivateTmp`、systemd 内核保护及 `MemoryHigh=512M` / `MemoryMax=900M` / `OOMPolicy=stop` / `Restart=always`。它不依赖 Docker；Lark keychain 只允许迁移到 `/home/sheinops/.lark-cli` 与 `/home/sheinops/.local/share/lark-cli`，目录 `700`、文件 `600`，不得把配置或密钥复制进仓库/日志。
- `shein-bi-cloud-browser-cleanup.timer`：每小时 `:10` / `:40` 清理本项目 `profiles/persistent-*-profile` 下的 headless Chrome 残留，并清理无活动 Chrome 时的 Chrome 临时目录。它只针对本项目 profile + headless 进程，不用于强杀可见人工登录窗口。

注意：`shein-bi-cloud-daily-refresh.service` 和它内部调用的 `cloud_link_business_sync.sh` 必须以 `sheinops` 运行，不能用 root 跑 SHEIN Chrome profile；否则会留下 root-owned profile 文件，导致 `shein-bi-cloud-session-manager.service` 第二天读 profile 报 `EACCES`。这个统一日更批次只收口慢变/日更补采数据，不合并每小时销售刷新、两小时 ET 出库单刷新、数据库备份、订单闭环复查和登录态管家。`cloud_openapi_hl_reconciliation.sh` 仅保留为手动诊断入口；`cloud_rtv_verify.sh` 仍由生产日更调用。迁移时要 mask 旧的 `link-business` / `openapi-hl` / `rtv-verify` timer，避免同一天重复跑。所有重任务 timer 默认 `Persistent=false`，不做开机补跑；如果服务器关机错过窗口，由 watchdog 的数据过期/日更状态告警暴露，再人工按需补跑。ET forwarder 保持 root 执行，因为入仓依赖 Docker/root 环境，且 ET 使用独立 profile，不写 SHEIN 店铺 profile。

资源护栏：高频销售和 ET 是轻量高优先任务；`daily-refresh` 是低优先慢任务，由晨间链路在销售刷新完成后启动。生产 oneshot 任务必须保留 `MemoryHigh` / `MemoryMax` / `OOMPolicy=stop`，常驻服务必须保留自己的 `MemoryHigh` / `MemoryMax` / `OOMPolicy=stop` / `Restart=always`；`daily-refresh` 必须保留启动前的忙碌写入任务等待和可用内存检查。宁可让慢变补采晚一次，也不要为了补齐链接/营销/RTV 数据把 BI Portal、Metabase 或销售刷新拖死。

权限护栏：部署前后先运行 `sudo bash scripts/harden_cloud_runtime_permissions.sh` 审计；确认清单后再运行 `sudo bash scripts/harden_cloud_runtime_permissions.sh --apply`。脚本只把 app 根目录收紧为 `sheinops:sheinops 0750`，并移除同一文件系统内普通文件/目录的 world-write，不递归改属主、不改组写位、不跟随 symlink，因此 root 与 `sheinops` 混合调度仍可工作。应用后必须确认 `worldWritableNonSymlinks=0`。

部署到服务器后执行：

```bash
cp infra/systemd/*.service infra/systemd/*.timer /etc/systemd/system/
chmod +x scripts/cloud_bi_refresh.sh scripts/cloud_db_backup.sh scripts/cloud_et_forwarder_sync.sh scripts/cloud_link_business_sync.sh scripts/cloud_daily_refresh.sh scripts/cloud_daily_lark_report.sh
systemd-analyze verify /etc/systemd/system/shein-bi-portal.service /etc/systemd/system/shein-bi-lark-sales-qa.service
systemctl daemon-reload
# 启用 timer 时不要对一组重任务使用 `enable --now` 批量拉起。
# 在某些 systemd 状态下这会立即触发 timer 关联服务，造成部署时销售、
# ET、日更、登录态管家等任务并发。推荐先 enable，再逐个 start timer；
# start timer 只启动计时器，不应手动 start 对应 service。
systemctl enable shein-bi-portal.service shein-bi-cloud-today.timer shein-bi-cloud-morning-chain.timer shein-bi-cloud-yesterday.timer shein-bi-db-backup.timer shein-bi-cloud-order-closure.timer shein-bi-cloud-browser-cleanup.timer
systemctl start shein-bi-portal.service shein-bi-cloud-today.timer shein-bi-cloud-morning-chain.timer shein-bi-cloud-yesterday.timer shein-bi-db-backup.timer shein-bi-cloud-order-closure.timer shein-bi-cloud-browser-cleanup.timer
# ET / 登录态在服务器本地 secret 与授权配置完成后再启用；日报/日更由 morning-chain 接管，不再启用独立 timer：
# systemctl enable shein-bi-cloud-et-forwarder.timer shein-bi-cloud-session-manager.timer
# systemctl start shein-bi-cloud-et-forwarder.timer shein-bi-cloud-session-manager.timer
# 旧的 link-business / openapi-hl / rtv-verify 分散 timer 已由 daily-refresh 接管；若服务器曾启用过，迁移时执行：
# systemctl disable --now shein-bi-cloud-link-business.timer shein-bi-cloud-openapi-hl.timer shein-bi-cloud-rtv-verify.timer
# systemctl mask --force shein-bi-cloud-link-business.timer shein-bi-cloud-openapi-hl.timer shein-bi-cloud-rtv-verify.timer
```
