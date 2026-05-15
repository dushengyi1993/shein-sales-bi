# SHEIN BI cloud systemd units

这些 unit 用于 Linux 云端迁移阶段：

- `shein-bi-cloud-today.timer`：全天每两小时（`00:10/02:10/.../22:10`）刷新当天销售、入仓并生成 BI 门户。
- `shein-bi-cloud-yesterday.timer`：每天 `00:10` 刷新前一天最终销售，并复核前两天稳定日。
- `shein-bi-db-backup.timer`：每天 `02:30` 备份业务库和 Metabase 元数据库到 `/srv/shein-bi/backups/auto`，默认保留 14 天。

部署到服务器后执行：

```bash
cp infra/systemd/*.service infra/systemd/*.timer /etc/systemd/system/
chmod +x scripts/cloud_bi_refresh.sh scripts/cloud_db_backup.sh
systemctl daemon-reload
systemctl enable --now shein-bi-cloud-today.timer shein-bi-cloud-yesterday.timer shein-bi-db-backup.timer
```
