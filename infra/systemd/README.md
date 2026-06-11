# SHEIN BI cloud systemd units

这些 unit 用于 Linux 云端迁移阶段：

- `shein-bi-cloud-today.timer`：全天每两小时（`00:10/02:10/.../22:10`）刷新当天销售、入仓并生成 BI 门户。
- `shein-bi-cloud-yesterday.timer`：每天 `00:10` 刷新前一天最终销售，并复核前两天稳定日。
- `shein-bi-db-backup.timer`：每天 `02:30` 备份业务库和 Metabase 元数据库到 `/srv/shein-bi/backups/auto`，默认保留 14 天。
- `shein-bi-cloud-et-forwarder.timer`：每天 `04:20` 抓取 ET 货代仓、入仓，并刷新 BI 门户。需要服务器本地 `config/et_forwarder.local.json` 或 `ET_FORWARDER_USERNAME/ET_FORWARDER_PASSWORD`，密钥不进 GitHub。
- `shein-bi-cloud-link-business.timer`：每天 `08:10` 顺序抓取前一完整日链接/业务域，入仓、体检并刷新 BI 门户；全店日指标仍全 0 时跳过入仓刷新。需要服务器私有 SHEIN session / browser session，敏感运行态不进 GitHub。
- `shein-bi-cloud-daily-lark-report.timer`：每天 `08:35` 发送飞书日报，`10:35/12:35` 做补偿重试；成功后写 `state/cloud_daily_report_sent/YYYY-MM-DD.sent` 防重复。需要服务器本地 `config/lark_report.json`、`lark-cli` 和飞书授权，密钥/授权不进 GitHub。
- `shein-bi-cloud-order-closure.timer`：每天 `08:50` 从云端订单底库找未终态订单，重查 SHEIN 当前状态并写入 `ops.order_status_recheck_state`，只更新订单生命周期状态，不重写历史销售事实；成功后刷新 orders section。

注意：`shein-bi-cloud-link-business.service` 必须以 `sheinops` 运行，不能用 root 跑 16 店 Chrome profile；否则会留下 root-owned profile 文件，导致 `shein-bi-cloud-session-manager.service` 第二天读 profile 报 `EACCES`。ET forwarder 保持 root 执行，因为入仓依赖 Docker/root 环境，且 ET 使用独立 profile，不写 16 店 SHEIN profile。

部署到服务器后执行：

```bash
cp infra/systemd/*.service infra/systemd/*.timer /etc/systemd/system/
chmod +x scripts/cloud_bi_refresh.sh scripts/cloud_db_backup.sh scripts/cloud_et_forwarder_sync.sh scripts/cloud_link_business_sync.sh scripts/cloud_daily_lark_report.sh
systemctl daemon-reload
systemctl enable --now shein-bi-cloud-today.timer shein-bi-cloud-yesterday.timer shein-bi-db-backup.timer shein-bi-cloud-order-closure.timer
# ET / 链接业务域 / 飞书日报在服务器本地 secret 与授权配置完成后再启用：
# systemctl enable --now shein-bi-cloud-et-forwarder.timer shein-bi-cloud-link-business.timer shein-bi-cloud-daily-lark-report.timer
```
