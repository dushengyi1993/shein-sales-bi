# Emergency State Snapshot 2026-05-14

这是为了应对本机硬盘故障而纳入 GitHub 的小体积、非密运行状态快照。

## 包含内容

| 原路径 | 快照路径 | 大小 | 修改时间 |
| --- | --- | ---: | --- |
| `state/bi_action_state.json` | `recovery/emergency-state-snapshot-20260514/state-files/bi_action_state.json` | 306 | 2026-05-03T15:09:32 |
| `state/feishu-base-sync-paused.flag` | `recovery/emergency-state-snapshot-20260514/state-files/feishu-base-sync-paused.flag` | 386 | 2026-05-05T15:32:09 |
| `state/lark_ops_dashboard_doc.json` | `recovery/emergency-state-snapshot-20260514/state-files/lark_ops_dashboard_doc.json` | 663 | 2026-04-27T02:30:51 |
| `state/et_forwarder_sync_state.json` | `recovery/emergency-state-snapshot-20260514/state-files/et_forwarder_sync_state.json` | 79938 | 2026-05-13T20:22:51 |
| `state/shein_sync_checkpoint.json` | `recovery/emergency-state-snapshot-20260514/state-files/shein_sync_checkpoint.json` | 815 | 2026-05-14T12:10:14 |
| `state/comment_translation_cache.json` | `recovery/emergency-state-snapshot-20260514/state-files/comment_translation_cache.json` | 303965 | 2026-05-03T12:17:17 |
| `logs/bi_portal_action_audit.jsonl` | `recovery/emergency-state-snapshot-20260514/log-files/bi_portal_action_audit.jsonl.txt` | 2780 | 2026-05-03T15:09:32 |
| `state/daily-report-sent-20260502.flag` | `recovery/emergency-state-snapshot-20260514/state-files/daily-report-sent-20260502.flag` | 27 | 2026-05-02T01:37:08 |
| `state/daily-report-sent-20260503.flag` | `recovery/emergency-state-snapshot-20260514/state-files/daily-report-sent-20260503.flag` | 31 | 2026-05-03T01:00:08 |
| `state/daily-report-sent-20260504.flag` | `recovery/emergency-state-snapshot-20260514/state-files/daily-report-sent-20260504.flag` | 31 | 2026-05-04T00:28:00 |
| `state/daily-report-sent-20260505.flag` | `recovery/emergency-state-snapshot-20260514/state-files/daily-report-sent-20260505.flag` | 31 | 2026-05-05T03:09:07 |
| `state/daily-report-sent-20260506.flag` | `recovery/emergency-state-snapshot-20260514/state-files/daily-report-sent-20260506.flag` | 31 | 2026-05-06T00:10:31 |
| `state/daily-report-sent-20260507.flag` | `recovery/emergency-state-snapshot-20260514/state-files/daily-report-sent-20260507.flag` | 31 | 2026-05-07T00:10:32 |
| `state/daily-report-sent-20260508.flag` | `recovery/emergency-state-snapshot-20260514/state-files/daily-report-sent-20260508.flag` | 31 | 2026-05-08T00:10:44 |
| `state/daily-report-sent-20260509.flag` | `recovery/emergency-state-snapshot-20260514/state-files/daily-report-sent-20260509.flag` | 31 | 2026-05-09T00:10:28 |
| `state/daily-report-sent-20260510.flag` | `recovery/emergency-state-snapshot-20260514/state-files/daily-report-sent-20260510.flag` | 31 | 2026-05-10T00:10:48 |
| `state/daily-report-sent-20260512.flag` | `recovery/emergency-state-snapshot-20260514/state-files/daily-report-sent-20260512.flag` | 31 | 2026-05-12T00:10:19 |
| `state/daily-report-sent-20260513.flag` | `recovery/emergency-state-snapshot-20260514/state-files/daily-report-sent-20260513.flag` | 31 | 2026-05-13T00:10:18 |
| `state/daily-report-sent-20260514.flag` | `recovery/emergency-state-snapshot-20260514/state-files/daily-report-sent-20260514.flag` | 31 | 2026-05-14T00:10:17 |

## 故意不包含

- `state/shein_webapi_sessions/*.local.json`：SHEIN Cookie session，敏感。
- `profiles/`：浏览器登录态和缓存，体积巨大且含 Cookie/密码。
- `config/*.local.json`、`config/lark_report.json`、`infra/metabase/*.local.json`、`infra/metabase/.env`：本地账号、密钥或真实配置。
- `state/lark_base.json`：含 token-like 飞书资源标识，当前不放 GitHub；如需迁移，优先通过飞书重新查询或加密单独备份。
- PostgreSQL / Docker 物理数据卷：体积大，不适合 GitHub；需要数据库 dump 或外部硬盘/云盘备份。

## 恢复用法

如果硬盘损坏、只能从 GitHub 恢复：先按 `docs/emergency-recovery-backup.md` 重建环境；需要恢复这些小状态时，把本目录下 `state-files/`、`log-files/` 的对应文件复制回原始 `state/` / `logs/` 路径。复制前确认新环境没有更新的生产状态，避免覆盖新数据。
