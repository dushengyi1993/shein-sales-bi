# SHEIN BI cloud systemd units

这些 unit 用于 Linux 云端迁移阶段：

- `shein-bi-cloud-today.timer`：当天销售高频刷新改为整点两小时一跑，但跳过 `04:00`（`00:00/02:00/06:00/08:00/.../22:00`），入仓并生成 BI 门户；不开启 systemd 开机补跑，避免服务器重启后和日更/ET 叠加。凌晨 `04:00` 留给慢变日更窗口，避免销售刷新、SHEIN profile、ET 出库单和页面预热同一时刻抢资源。
- `shein-bi-cloud-session-manager.timer`：每天 `02:20`，在 `02:00` 销售刷新结束后顺序巡检/恢复当前 19 店 WebAPI + SBN 登录态，并检查 profile 体积。
- `shein-bi-cloud-yesterday.timer`：每天 `03:00` 刷新前一天最终销售，并复核前两天稳定日；不开启开机补跑，漏跑由 watchdog stale 检测暴露后人工补跑。
- `shein-bi-db-backup.timer`：每天 `02:30` 备份业务库和 Metabase 元数据库到 `/srv/shein-bi/backups/auto`，默认保留 14 天。
- `shein-bi-cloud-et-forwarder.timer`：每两小时 `01:20/03:20/.../23:20` 抓取 ET 货代仓/出库单、入仓，并轻量刷新订单/物流/售后相关 section；不开启开机补跑。需要服务器本地 `config/et_forwarder.local.json` 或 `ET_FORWARDER_USERNAME/ET_FORWARDER_PASSWORD`，密钥不进 GitHub。
- `shein-bi-cloud-daily-refresh.timer`：每天 `03:40` 统一执行“日更补采”批次：顺序抓取前一完整日链接/业务域、补采营销活动/限时折扣/优惠券价格线索、RTV 退货轨迹复核，统一入仓、体检并刷新 BI 门户；全店日指标仍全 0 时跳过链接/业务域入仓刷新。该批次不开启开机补跑；启动前如果销售/ET 等写入任务仍在跑，会等待一段时间，超时或可用内存不足时写 `skipped_busy` / `skipped_low_memory` 状态并跳过本轮，避免重启后堆叠压垮服务器。需要服务器私有 SHEIN session / browser session，敏感运行态不进 GitHub。HL OpenAPI 销售对账已退出生产日更。
- `shein-bi-cloud-daily-lark-report.timer`：每天 `09:35` 发送飞书日报，`11:35/13:35` 做补偿重试；成功后写 `state/cloud_daily_report_sent/YYYY-MM-DD.sent` 防重复。需要服务器本地 `config/lark_report.json`、`lark-cli` 和飞书授权，密钥/授权不进 GitHub。
- `shein-bi-cloud-order-closure.timer`：每天 `05:50`（带 `RandomizedDelaySec=5m`）从云端订单底库找未终态订单，重查 SHEIN 当前状态并写入 `ops.order_status_recheck_state`，只更新订单生命周期状态，不重写历史销售事实；成功后刷新 orders section。这个任务排在日更慢任务后段，避免和 `02:00` 销售、`02:20` 登录态、`03:00` 昨日定稿、`03:40` 日更补采抢同一波资源。

注意：`shein-bi-cloud-daily-refresh.service` 和它内部调用的 `cloud_link_business_sync.sh` 必须以 `sheinops` 运行，不能用 root 跑 SHEIN Chrome profile；否则会留下 root-owned profile 文件，导致 `shein-bi-cloud-session-manager.service` 第二天读 profile 报 `EACCES`。这个统一日更批次只收口慢变/日更补采数据，不合并两小时销售刷新、两小时 ET 出库单刷新、数据库备份、订单闭环复查和登录态管家。`cloud_openapi_hl_reconciliation.sh` 仅保留为手动诊断入口；`cloud_rtv_verify.sh` 仍由生产日更调用。迁移时要 mask 旧的 `link-business` / `openapi-hl` / `rtv-verify` timer，避免同一天重复跑。所有重任务 timer 默认 `Persistent=false`，不做开机补跑；如果服务器关机错过窗口，由 watchdog 的数据过期/日更状态告警暴露，再人工按需补跑。ET forwarder 保持 root 执行，因为入仓依赖 Docker/root 环境，且 ET 使用独立 profile，不写 SHEIN 店铺 profile。

资源护栏：高频销售和 ET 是轻量高优先任务；`daily-refresh` 是低优先慢任务。生产 unit 必须保留 `MemoryHigh` / `MemoryMax` / `OOMPolicy=stop`，`daily-refresh` 必须保留启动前的忙碌写入任务等待和可用内存检查。宁可让慢变补采晚一次，也不要为了补齐链接/营销/RTV 数据把 BI Portal、Metabase 或销售刷新拖死。

部署到服务器后执行：

```bash
cp infra/systemd/*.service infra/systemd/*.timer /etc/systemd/system/
chmod +x scripts/cloud_bi_refresh.sh scripts/cloud_db_backup.sh scripts/cloud_et_forwarder_sync.sh scripts/cloud_link_business_sync.sh scripts/cloud_daily_refresh.sh scripts/cloud_daily_lark_report.sh
systemctl daemon-reload
# 启用 timer 时不要对一组重任务使用 `enable --now` 批量拉起。
# 在某些 systemd 状态下这会立即触发 timer 关联服务，造成部署时销售、
# ET、日更、登录态管家等任务并发。推荐先 enable，再逐个 start timer；
# start timer 只启动计时器，不应手动 start 对应 service。
systemctl enable shein-bi-cloud-today.timer shein-bi-cloud-yesterday.timer shein-bi-db-backup.timer shein-bi-cloud-order-closure.timer
systemctl start shein-bi-cloud-today.timer shein-bi-cloud-yesterday.timer shein-bi-db-backup.timer shein-bi-cloud-order-closure.timer
# ET / 日更补采 / 飞书日报在服务器本地 secret 与授权配置完成后再启用：
# systemctl enable shein-bi-cloud-et-forwarder.timer shein-bi-cloud-daily-refresh.timer shein-bi-cloud-daily-lark-report.timer shein-bi-cloud-session-manager.timer
# systemctl start shein-bi-cloud-et-forwarder.timer shein-bi-cloud-daily-refresh.timer shein-bi-cloud-daily-lark-report.timer shein-bi-cloud-session-manager.timer
# 旧的 link-business / openapi-hl / rtv-verify 分散 timer 已由 daily-refresh 接管；若服务器曾启用过，迁移时执行：
# systemctl disable --now shein-bi-cloud-link-business.timer shein-bi-cloud-openapi-hl.timer shein-bi-cloud-rtv-verify.timer
# systemctl mask --force shein-bi-cloud-link-business.timer shein-bi-cloud-openapi-hl.timer shein-bi-cloud-rtv-verify.timer
```
