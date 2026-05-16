# 云端 BI 运行说明

> 当前权威状态：2026-05-16。本地 BI 已封存，云端 BI 是正式入口。

## 1. 当前入口

- 云端 BI：`http://43.165.167.135/`
- 访问保护：Nginx Basic Auth 已启用；账号密码只在私下运行环境交付，不写入仓库、文档或日志。
- 云服务器：腾讯云 Lighthouse 东京，Ubuntu 24.04 x86_64，代码目录 `/opt/shein-bi/app`。
- 服务组成：Nginx 对外反代，BI Portal 监听服务器本机 `127.0.0.1:8787`，PostgreSQL + Metabase 由 Docker Compose 承载。
- GitHub 仓库 `main` 是云端代码来源；云端有值得保存的脚本、配置模板、门户静态产物或自动运营能力时，先同步回 GitHub，再部署到服务器。
- 注意：`outputs/bi-portal/index.html` / `data.json` 会作为可恢复静态快照纳入 GitHub；服务器执行 `git reset --hard origin/main` 或类似部署后，可能把实时 BI 页面覆盖成仓库快照。每次服务器拉取/重置代码后，都要立即跑一次 `scripts/cloud_bi_refresh.sh today intraday` 或对应 systemd service，确认页面生成时间和销售源时间回到当前。

### SSH 运维入口

- 当前本机 SSH 直连已恢复：`ssh shein-bi-tencent`。
- 服务器侧使用非 root 用户 `sheinops` + key-only 登录；密码登录已关闭。
- 当前由于本地到服务器 `22` 端口的 SSH 握手在到达服务器前被断开，临时使用 `443` 端口承载 SSH；服务器 `22` 仍监听且放行。
- 未来启用正式 HTTPS / 域名时，`443` 应还给 HTTPS，届时先把 SSH 改到单独高位端口并同步腾讯云防火墙 / UFW。

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
| `shein-bi-cloud-et-forwarder.timer` | 北京时间 `04:20` | 抓取 ET 货代仓、入仓，并刷新 BI Portal；需要服务器本地 ET 登录配置 |
| `shein-bi-cloud-daily-lark-report.timer` | 北京时间 `08:35`，`10:35/12:35` 补偿重试 | 抓取当天销售后发送飞书日报和日报图；成功后写入当天 sent flag 防重复 |
| `shein-bi-cloud-rtv-verify.timer` | 北京时间 `03:20` | 完整 RTV 换单复核 WebAPI 版，写入 `ops.rtv_tracking_verification`，不阻塞滚动销售刷新 |
| `shein-bi-cloud-openapi-hl.timer` | 北京时间 `06:20` | HL OpenAPI 并行抓取、入仓和对账；服务器 IP 白名单已配置 |
| `shein-bi-cloud-watchdog.timer` | 每小时 | 检查云端服务、timer 和 BI 数据新鲜度，异常时发飞书提醒 |
| `shein-bi-lark-sales-qa.service` | 常驻服务 | 飞书只读问数机器人，读取 BI Portal JSON 后回复消息，不写数据 |

ET、飞书日报、完整 RTV WebAPI 复核、异常通知 watchdog 和只读问数机器人的 Linux systemd 入口已启用并通过手动验证。HL OpenAPI 云端入口已部署，并且云服务器出口 IP `43.165.167.135` 已加入 SHEIN 开放平台白名单，云端双跑已成功。链接/业务域是低频日更数据，不按销售高频刷新看待；其无浏览器 WebAPI 直连迁移仍需后续补 endpoint/session 适配。不要误以为本地 `SHEIN-*` Windows 任务仍在生产运行。

备份默认保留 `14` 天。后续正式长期运行还应补对象存储或异地下载备份，避免云盘单点故障。

## 4. 云端刷新链路

- 当天刷新入口：`scripts/cloud_bi_refresh.sh today`
- 前一天最终版入口：`scripts/cloud_bi_refresh.sh yesterday`
- 数据库备份入口：`scripts/cloud_db_backup.sh`
- ET 云端入口：`scripts/cloud_et_forwarder_sync.sh today`
- 飞书日报云端入口：`scripts/cloud_daily_lark_report.sh today`
- 完整 RTV 复核云端入口：`scripts/cloud_rtv_verify.sh`
- HL OpenAPI 云端入口：`scripts/cloud_openapi_hl_reconciliation.sh`
- 云端异常通知入口：`scripts/cloud_ops_watchdog.mjs`
- 飞书只读问数机器人入口：`scripts/cloud_lark_sales_qa_bot.sh` / `scripts/lark_sales_qa_bot.mjs`
- 销售抓取仍优先使用 SHEIN 后台 WebAPI session；直连成功时不会启动浏览器。
- 官方 OpenAPI 已有权限的数据域后续可逐步替换为 OpenAPI；WebAPI 仍作为当前生产销售抓取主链路。HL OpenAPI 云端双跑当前只写并行表，不覆盖生产销售事实表。
- ET 已改为 Linux headless Chrome + 账号密码/OCR 自动登录模式；Windows Chrome 保存密码不能直接迁到 Linux，服务器必须单独保存 `config/et_forwarder.local.json` 或等价环境变量。
- 飞书日报依赖服务器本地 `config/lark_report.json`、`lark-cli` 和独立飞书机器人授权；旧应用 `open_id` 不能直接复用到新应用，必要时用 `union_id` 映射。飞书 Base / 看板写入仍受暂停开关控制，日报发送与 Base 写入分开处理。
- 飞书日报图在 Linux headless Chrome 下依赖中文字体；服务器必须安装 `fonts-noto-cjk` / `fontconfig` 并能通过 `fc-match 'Noto Sans CJK SC'` 匹配到 Noto CJK，否则中文会渲染成方框。
- 链接/业务域目前按日更低频看待；watchdog 的阈值是 48 小时，不是销售高频的 4.5 小时。链接管理、商品图上传、取标题、商家维护链接等自动运营功能后续应优先按 Linux/云端服务方式扩展，避免重新绑定本地 Windows。

## 5. 运行数据与敏感信息边界

以下内容不得提交 GitHub：

- `state/shein_webapi_sessions/*.local.json`
- `config/*.local.json`
- `config/lark_report.json`
- `config/et_forwarder.local.json`
- Metabase 管理员密码、数据库真实密码、Basic Auth 密码
- 浏览器 profile、Cookie、OpenAPI secret、ET 密码、飞书 token、临时上传 token
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
- ET 已验证可手动跑 `scripts/cloud_et_forwarder_sync.sh today`，能登录、抓取、入仓并刷新门户；失败时保留上一版 ET 数据，不应阻断销售 BI。
- 飞书日报已验证可手动跑 `scripts/cloud_daily_lark_report.sh today`，文字和日报图能发送；成功后会写入当天 sent flag，避免同日 timer 重复发送。
- 若 BI 侧栏显示的“页面生成 / 销售源”时间明显旧于当前调度，先检查是否刚部署覆盖了仓库静态快照；在服务器重跑 `shein-bi-cloud-today.service` 后，`outputs/bi-portal/data.json` 的 `generatedAt` 和 `salesUpdatedAt` 应更新到当天。
- 若飞书日报图中文显示方框，先在服务器检查 `fc-match 'Noto Sans CJK SC'`；修复字体后只需重新生成/下次发送日报图，不需要重发已发送的旧图，除非用户明确要求。
- `ssh shein-bi-tencent` 应能直接登录服务器并具有免密 `sudo` 运维能力；如果后续 HTTPS 占用 443，先迁移 SSH 端口。
- `shein-bi-cloud-rtv-verify.timer` 应保持 active；烟测可用 `node scripts/verify_shein_rtv_tracking.mjs --transport webapi --limit 3 --case-limit 3 --json`。
- `shein-bi-cloud-openapi-hl.timer` 应保持 active；若后续再失败，先看 service 日志；此前 `openapi00002` 白名单问题已于 2026-05-16 修复。
- `shein-bi-cloud-watchdog.timer` 应保持 active；销售/页面过期按 4.5 小时提醒，链接/业务域过期按 48 小时提醒。
- `shein-bi-lark-sales-qa.service` 应保持 active；可用 `node scripts/lark_sales_qa_bot.mjs --answer "今天销售多少"` 本地只读测试答案。群聊中若无回复，优先检查机器人是否已入群、应用可见范围和 `im.message.receive_v1`/发消息权限。
- GitHub `main` 应包含最新可复用代码和文档；敏感运行态只保留在本地/云端私有目录。
