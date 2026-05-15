# 云端 BI 运行说明

> 当前权威状态：2026-05-15。本地 BI 已封存，云端 BI 是正式入口。

## 1. 当前入口

- 云端 BI：`http://43.165.167.135/`
- 访问保护：Nginx Basic Auth 已启用；账号密码只在私下运行环境交付，不写入仓库、文档或日志。
- 云服务器：腾讯云 Lighthouse 东京，Ubuntu 24.04 x86_64，代码目录 `/opt/shein-bi/app`。
- 服务组成：Nginx 对外反代，BI Portal 监听服务器本机 `127.0.0.1:8787`，PostgreSQL + Metabase 由 Docker Compose 承载。
- GitHub 仓库 `main` 是云端代码来源；云端有值得保存的脚本、配置模板、门户静态产物或自动运营能力时，先同步回 GitHub，再部署到服务器。

## 2. 本地 BI 封存状态

- 自 `2026-05-15` 起，本地 BI 不再作为生产入口。
- 本地 `8787` 端口服务已停止；`http://127.0.0.1:8787/` 应不可访问。
- 本地 `SHEIN-*` Windows 计划任务已禁用，避免和云端重复跑数。
- 原局域网防火墙规则 `SHEIN BI Portal LAN 8787 ReadOnly` 仍需要管理员权限才能禁用；但当前本地没有服务监听 `8787`，局域网已经无法访问本地 BI。
- 如需重新封存或复核，可运行 `scripts/archive_local_bi.ps1`；若要同时关闭防火墙规则，需用管理员 PowerShell 运行并加 `-DisableFirewall`。
- 本地只保留为开发、排障和短期回滚环境；除非用户明确要求回滚，不要重新启用本地 BI 服务或本地定时任务。

## 3. 云端定时任务

云端使用 systemd timer，定义文件在 `infra/systemd/`：

| 任务 | 时间 | 作用 |
| --- | --- | --- |
| `shein-bi-cloud-today.timer` | 北京时间 `00:10/02:10/.../22:10` | 每两小时刷新当天销售、入仓并生成 BI Portal |
| `shein-bi-cloud-yesterday.timer` | 北京时间 `00:10` | 刷新前一天最终销售，并复核前两天稳定日 |
| `shein-bi-db-backup.timer` | 北京时间 `02:30` | 备份业务库和 Metabase 元数据库到 `/srv/shein-bi/backups/auto` |

备份默认保留 `14` 天。后续正式长期运行还应补对象存储或异地下载备份，避免云盘单点故障。

## 4. 云端刷新链路

- 当天刷新入口：`scripts/cloud_bi_refresh.sh today`
- 前一天最终版入口：`scripts/cloud_bi_refresh.sh yesterday`
- 数据库备份入口：`scripts/cloud_db_backup.sh`
- 销售抓取仍优先使用 SHEIN 后台 WebAPI session；直连成功时不会启动浏览器。
- 官方 OpenAPI 已有权限的数据域后续可逐步替换为 OpenAPI；WebAPI 仍作为当前生产销售抓取主链路。
- ET、链接管理、商品图上传、取标题、商家维护链接等自动运营功能后续应优先按 Linux/云端服务方式扩展，避免重新绑定本地 Windows。

## 5. 运行数据与敏感信息边界

以下内容不得提交 GitHub：

- `state/shein_webapi_sessions/*.local.json`
- `config/*.local.json`
- `config/lark_report.json`
- Metabase 管理员密码、数据库真实密码、Basic Auth 密码
- 浏览器 profile、Cookie、OpenAPI secret、临时上传 token
- 数据库 dump、运行日志、批量抓取原始输出

GitHub 应保存：

- 代码、配置模板、表结构、归并规则、运维脚本、systemd unit
- BI Portal 当前可复用静态产物 `outputs/bi-portal/index.html` / `outputs/bi-portal/data.json`
- 电商产品套图方法论、skill、批量提示词脚本和精选样例
- 云端迁移/恢复/封存说明

## 6. 验证清单

- 云端未鉴权访问 `/api/health` 应返回 `401`。
- 带 Basic Auth 访问 `/api/health` 应返回 `200` 且 `ok=true`。
- `shein-bi-cloud-today.timer` 应按每两小时真实触发。
- `shein-bi-db-backup.timer` 应每日生成 `shein_bi.dump` 与 `metabase.dump`。
- GitHub `main` 应包含最新可复用代码和文档；敏感运行态只保留在本地/云端私有目录。
