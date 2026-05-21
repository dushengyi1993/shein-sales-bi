# 云端 BI 运行说明

> 当前权威状态：2026-05-18。本地 BI 已封存，云端 BI 是正式入口。

## 1. 当前入口

- 云端 BI：`https://shein-bi.faceair.me/`；旧 IP 入口 `http://43.165.167.135/` 仅作兜底。
- 访问保护：Nginx Basic Auth 已启用；账号密码只在私下运行环境交付，不写入仓库、文档或日志。
- 云服务器：腾讯云 Lighthouse 东京，Ubuntu 24.04 x86_64，代码目录 `/opt/shein-bi/app`。
- 服务组成：HAProxy/Caddy 负责公网 443 分流与 TLS，Nginx 在服务器本机 `127.0.0.1:8080` 保留 Basic Auth 并反代到 BI Portal `127.0.0.1:8787`；PostgreSQL + Metabase 由 Docker Compose 承载。
- 域名入口：`https://shein-bi.faceair.me/`；服务器内部仍由 Nginx `127.0.0.1:8080` 转发到 BI Portal。
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
| `shein-bi-cloud-link-business.timer` | 北京时间 `05:30` | 顺序启动云端 headless Chrome 抓取前一完整日链接/业务域，入仓、体检并刷新 BI |
| `shein-bi-cloud-session-manager.timer` | 北京时间 `03:20` | 云端登录态管家：顺序巡检/恢复 16 店 WebAPI + SBN 登录态，检查 profile 体积，生成报告 |
| `shein-bi-cloud-openapi-hl.timer` | 北京时间 `06:20` | HL OpenAPI 并行抓取、入仓和对账；服务器 IP 白名单已配置 |
| `shein-bi-cloud-watchdog.timer` | 每小时 | 检查云端服务、timer 和 BI 数据新鲜度，异常时发飞书提醒 |
| `shein-bi-lark-sales-qa.service` | 常驻服务 | 飞书只读问数机器人（云端 Codex CLI 网关），读取 BI Portal JSON 后回复消息，不写数据 |

ET、飞书日报、完整 RTV WebAPI 复核、链接/业务域日更、异常通知 watchdog、只读问数机器人（云端 Codex CLI 网关）和 HL OpenAPI 双跑的 Linux systemd 入口已启用并通过手动验证。链接/业务域是低频日更数据，不按销售高频刷新看待；当前生产路径是云端顺序 headless Chrome + 私有会话状态，纯 Node 零浏览器直连仍是后续优化。不要误以为本地 `SHEIN-*` Windows 任务仍在生产运行。

2026-05-16 链接/业务域已完成云端闭环：`scripts/cloud_link_business_sync.sh` 会按店顺序执行 `restore_shein_store_session.mjs`、`fetch_shein_links.mjs` 和 `fetch_shein_business_domains.mjs`，失败店铺会关闭并重启该店浏览器重试，全部完成后入仓、运行 BI 体检并生成门户。验证日志 `/srv/shein-bi/logs/cloud-link-business/link-business-2026-05-15-20260516-163901.log` 显示 16 店全部 `done`；BI `dates.linkDate=2026-05-15`、`dates.businessDate=2026-05-15`，体检 `warnings=0/errors=0`。这不是本机补抓；后续不要重新启用本地 Windows 链接/业务域任务作为长期生产。

备份默认保留 `14` 天。后续正式长期运行还应补对象存储或异地下载备份，避免云盘单点故障。

## 4. 云端刷新链路

- 当天刷新入口：`scripts/cloud_bi_refresh.sh today`
- 前一天最终版入口：`scripts/cloud_bi_refresh.sh yesterday`
- 数据库备份入口：`scripts/cloud_db_backup.sh`
- ET 云端入口：`scripts/cloud_et_forwarder_sync.sh today`
- 飞书日报云端入口：`scripts/cloud_daily_lark_report.sh today`
- 完整 RTV 复核云端入口：`scripts/cloud_rtv_verify.sh`
- 链接/业务域日更云端入口：`scripts/cloud_link_business_sync.sh yesterday`
- HL OpenAPI 云端入口：`scripts/cloud_openapi_hl_reconciliation.sh`
- 云端异常通知入口：`scripts/cloud_ops_watchdog.mjs`
- 飞书只读问数机器人（云端 Codex CLI 网关）入口：`scripts/cloud_lark_sales_qa_bot.sh` / `scripts/lark_sales_qa_bot.mjs`
- 销售抓取仍优先使用 SHEIN 后台 WebAPI session；直连成功时不会启动浏览器。
- 官方 OpenAPI 已有权限的数据域后续可逐步替换为 OpenAPI；WebAPI 仍作为当前生产销售抓取主链路。HL OpenAPI 云端双跑当前只写并行表，不覆盖生产销售事实表。
- ET 已改为 Linux headless Chrome + 账号密码/OCR 自动登录模式；Windows Chrome 保存密码不能直接迁到 Linux，服务器必须单独保存 `config/et_forwarder.local.json` 或等价环境变量。
- 飞书日报依赖服务器本地 `config/lark_report.json`、`lark-cli` 和独立飞书机器人授权；旧应用 `open_id` 不能直接复用到新应用，必要时用 `union_id` 映射。飞书 Base / 看板写入仍受暂停开关控制，日报发送与 Base 写入分开处理。
- 飞书日报图在 Linux headless Chrome 下依赖中文字体；服务器必须安装 `fonts-noto-cjk` / `fontconfig` 并能通过 `fc-match 'Noto Sans CJK SC'` 匹配到 Noto CJK，否则中文会渲染成方框。
- 链接/业务域目前按日更低频看待；watchdog 的阈值是 48 小时，不是销售高频的 4.5 小时。当前云端生产路径是顺序 headless Chrome，依赖服务器私有 `state/shein_browser_sessions/*.local.json` / `state/shein_webapi_sessions/*.local.json`；链接管理、商品图上传、取标题、商家维护链接等自动运营功能后续应优先按 Linux/云端服务方式扩展，避免重新绑定本地 Windows。
- 云端登录态管家入口：`scripts/cloud_shein_session_manager.sh` / `scripts/cloud_shein_session_manager.mjs`。它按店顺序启动临时 headless Chrome，自动检查/恢复 GSP 订单 WebAPI 与 SBN 商品分析子系统登录态，完成后关闭由它启动的店铺浏览器；默认不清理缓存，只报告 profile 体积。需要手动安全清缓存时才加 `--cleanup-cache`。
- `audit_bi_warehouse.mjs` 与 `load_bi_business_domains.mjs` 均应支持 Linux 下自动使用 `sudo docker exec`；如果服务器手动运行时报 Docker socket 或写文件权限错误，先检查脚本是否为最新，以及 `/srv/shein-bi/logs`、`state/cloud_ops_watchdog`、`outputs/bi-portal`、`outputs/bi_audit` 是否被 root 运行残留成普通用户不可写。

### 链接/业务域 WebAPI / headless 现状

- 已验证可直接复用现有 WebAPI session 的域：`gsp` 售后列表/统计、发货面单计数等。
- 暂不能直接复用现有销售 session 的域：`mgs` 履约/评价、`pqmp` 质量、`spmp` 商品列表、`idms` 备货、`sbn` 经营/营销、`gsfs` 财务；这些在云端探针中返回 `20302 子系统登录重定向`。
- 后续改造顺序：先解决子系统登录态/初始化，再解决 SBN 商品分析的 `x-gw-auth` 等动态头，最后处理财务二次密码或敏感权限边界。
- 当前生产使用云端 headless 顺序兜底，`cloud_link_business_sync.sh` 默认一次只跑 1 店，单店完成后关闭浏览器；不能改成 16 店同时开浏览器。若后续提并发，建议最多 `2` 并先看内存。

### 云端临时人工登录入口

- BI 页面“系统 / 登录维护中心”入口：`/cloud-login-maintenance`。
- 用途：当某店 SHEIN / SBN / 子系统登录态失效、自动恢复失败、验证码/滑块必须人工处理时，在云服务器上临时启动该店独立 profile 的可见 Chrome，并通过 noVNC 嵌入到 BI 页面。
- 入口实现：`scripts/cloud_manual_login_session.mjs` 负责创建、列出、完成和关闭临时会话；BI Portal 通过 `/api/cloud-login/sessions` 和 `/cloud-login/session/:id` 提供受保护页面。
- 服务器依赖：`xvfb`、`x11vnc`、`websockify`、`novnc`，均绑定本机端口；外网只经过现有 Basic Auth 的 BI/Nginx/Caddy 链路访问。
- 临时会话只保存 session id、短期访问 token、过期时间、端口、PID、日志文件和完成状态；不把密码、cookie、localStorage、请求头或 SHEIN token 写入仓库、文档或聊天。
- 操作流程：打开维护中心 -> 选店铺和页面 -> 打开云端登录窗口 -> 人工完成登录/验证码 -> 回维护中心点“我已完成并关闭”。完成动作会触发 `export_shein_browser_session.mjs --no-launch` 和 `bootstrap_shein_browser_session.mjs --no-launch` 验证，然后关闭 Chrome / x11vnc / websockify / Xvfb。
- Nginx 配置必须支持 WebSocket upgrade；仓库模板为 `infra/nginx/shein-bi.conf`，包含 `proxy_set_header Upgrade` 和 `proxy_set_header Connection "upgrade"`。
- 日志与状态：状态文件 `/srv/shein-bi/runtime/cloud_manual_login_sessions.json`；日志目录 `/srv/shein-bi/logs/cloud-manual-login`。这些都是服务器私有运行态，不进 GitHub。
- 若开启时提示某店 `CDP port ... is already open`：先确认是否有生产同步 service 正在运行。`cloud_manual_login_session.mjs` 会在确认没有生产同步 service 活跃时自动清理已完成/已关闭临时窗口留下的孤儿 Chrome/VNC 进程；若生产同步正在运行，应等待同步结束，不要强杀。
- 当前限制：一次只允许一个临时登录窗口；过期或完成后不能再进入窗口，需重新开启。登录维护入口仍依赖 BI Basic Auth，正式账号系统后再做更细权限。

## 5. 运行数据与敏感信息边界

以下内容不得提交 GitHub：

- `state/shein_webapi_sessions/*.local.json`
- `config/*.local.json`
- `config/lark_report.json`
- `config/et_forwarder.local.json`
- Metabase 管理员密码、数据库真实密码、Basic Auth 密码
- 浏览器 profile、Cookie、OpenAPI secret、ET 密码、飞书 token、临时上传 token
- 云端临时人工登录状态文件、短期 noVNC token 和登录维护日志
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
- `cloud_bi_refresh.sh` 应在生成 BI Portal 前运行 `audit_bi_warehouse.mjs`，否则页面顶部会显示“数据体检：未找到体检文件”。体检有 warning 时仍生成页面，让 BI 直接展示 warning 内容。
- `ssh shein-bi-tencent` 应能直接登录服务器并具有免密 `sudo` 运维能力；如果后续 HTTPS 占用 443，先迁移 SSH 端口。
- `shein-bi-cloud-rtv-verify.timer` 应保持 active；烟测可用 `node scripts/verify_shein_rtv_tracking.mjs --transport webapi --limit 3 --case-limit 3 --json`。
- `shein-bi-cloud-openapi-hl.timer` 应保持 active；若后续再失败，先看 service 日志；此前 `openapi00002` 白名单问题已于 2026-05-16 修复。
- `shein-bi-cloud-watchdog.timer` 应保持 active；销售/页面过期按 4.5 小时提醒，链接/业务域过期按 48 小时提醒。
- `shein-bi-cloud-link-business.timer` 应保持 active；手动复跑用 `scripts/cloud_link_business_sync.sh yesterday`。若单店卡在 SBN `x-gw-auth`，优先看该店 attempt 重试日志，不要回退到本机补抓冒充云端日更。
- `shein-bi-cloud-session-manager.timer` 应保持 active；手动复跑用 `scripts/cloud_shein_session_manager.sh`。报告文件在 `outputs/reports/cloud-session-manager-latest.json` / `.md`，若失败会被 watchdog 按 service failed 逻辑提醒。
- `shein-bi-cloud-link-business.service` 必须以 `User=sheinops` / `Group=sheinops` 运行，因为它会启动 16 店 SHEIN Chrome profile；不要改回 root，否则会生成 root-owned profile 文件并让 `shein-bi-cloud-session-manager.service` 第二天因 `EACCES` 失败。ET forwarder 仍保留 root 执行，因为入仓依赖 Docker/root 环境，且它不写 16 店 SHEIN profile。
- 登录态恢复统一走 `restore_shein_store_session.mjs`：先用服务器私有 `state/shein_browser_sessions/*.local.json` / `state/shein_webapi_sessions/*.local.json` bootstrap，再运行 `auto_relogin_shein_store.mjs` 验证 GSP order WebAPI 和 SBN 商品分析页。这样云端没有保存密码的店铺也不会只靠 Chrome autofill 自愈。
- 云端人工登录入口验证：`/cloud-login-maintenance` 返回 `200`；`/cloud-login/novnc/vnc.html` 返回 `200`；创建会话后 `/cloud-login/session/:id` 返回 `200` 且 WebSocket 升级返回 `101 Switching Protocols`；点“我已完成并关闭”后 export/probe 成功且不残留 Chrome/Xvfb/x11vnc/websockify 进程。
- `shein-bi-lark-sales-qa.service` 应保持 active；可用 `node scripts/lark_sales_qa_bot.mjs --answer "今天销售多少"` 本地只读测试答案。群聊中若无回复，优先检查机器人是否已入群、应用可见范围和 `im.message.receive_v1`/发消息权限。
- GitHub `main` 应包含最新可复用代码和文档；敏感运行态只保留在本地/云端私有目录。


## 飞书问数 / 云端 Codex CLI 网关

- 当前生产链路为：飞书消息事件 -> 云端 `lark-cli` / `shein-bi-lark-sales-qa.service` -> `scripts/lark_sales_qa_bot.mjs` -> Codex CLI 只读执行 -> 回复飞书。
- Codex CLI 安装在服务器系统路径，私有配置目录为 `/home/sheinops/.codex`；`auth.json`、`config.toml`、第三方 API 配置和 token 都不进入 GitHub、文档或日志。
- 服务环境必须显式包含：`CODEX_HOME=/home/sheinops/.codex`、`SHEIN_QA_CODEX_GATEWAY_ENABLED=1`、`SHEIN_QA_CODEX_GATEWAY_TIMEOUT_MS=180000`。
- 网关只把 `outputs/bi-portal/data.json` 压缩成销售、店铺、货号、链接/覆盖等只读上下文交给模型；不授予写 PostgreSQL、写飞书 Base、改 SHEIN 后台或改服务器文件的权限。
- 网页端“链接管理中台”的运营会话复用同一受控问数链路：每轮按最新一句和最近会话上下文重新从当前 BI JSON 取数；如果用户明确要求下架、换图、改标题、补链、报活动或限时折扣，服务端必须创建 / 更新同一会话任务并留痕。用户点击“开始执行 / 预检”后，`/api/link-ops-execute` 会进入受控执行器、写回进度和审计；真实写 SHEIN 仍必须满足对应适配器、payload 完整和二次确认，不能静默提交。
- 失败兜底顺序：Codex CLI 只读网关失败时，退回直接 LLM 问答；再失败时退回脚本内规则回答，保证飞书机器人不会因为模型异常完全失声。
- 这个机器人已经不绑定本机 Codex App 或当前聊天窗口；只要云端服务、飞书授权和服务器网络正常，本机关机也不影响飞书问数。

验证命令（服务器 `/opt/shein-bi/app`）：

```bash
systemctl show shein-bi-lark-sales-qa.service -p Environment
CODEX_HOME=/home/sheinops/.codex codex --version
CODEX_HOME=/home/sheinops/.codex SHEIN_QA_CODEX_GATEWAY_ENABLED=1 node scripts/lark_sales_qa_bot.mjs --answer "DL这个店今天卖得最好的品是什么？"
```

2026-05-19 云端 Codex 运行环境修复口径：

- `/home/sheinops/.codex/auth.json` 可由本机私有 `auth.json` 手动覆盖更新；更新前先备份，文件权限保持 `600`，不得提交 GitHub。
- 服务器已安装 `bubblewrap`，并修复 `/home/sheinops/.codex/sessions` 属主为 `sheinops`；`kernel.apparmor_restrict_unprivileged_userns=0` 写入 `/etc/sysctl.d/99-codex-bubblewrap.conf`，以允许 Codex Linux sandbox 使用 user namespace。
- `~/.codex/config.toml` 使用 `[features] hooks = true`，不再使用过期 `codex_hooks`。
- 冒烟命令：`cd /tmp && CODEX_HOME=/home/sheinops/.codex timeout 120 codex exec --sandbox read-only --skip-git-repo-check "只回复 OK，不要解释。" < /dev/null`。若只出现短暂 `Reconnecting...` 但最终返回 `OK`，按网络抖动处理，不视为配置失败。

2026-05-19 链接/业务域日更故障修复口径：

- 故障表现：销售 WebAPI 正常，但链接表现进入 SBN 商品分析页时被重定向到登录页，导致 `/sbn/new_goods/get_skc_diagnose_list` 抓不到 `x-gw-auth`，`shein-bi-cloud-link-business.service` 失败。
- 修复：`scripts/bootstrap_shein_browser_session.mjs` 现在会把新鲜 WebAPI cookie 与浏览器导出的子系统 `localStorage/sessionStorage` 合并使用，避免只用 WebAPI cookie 时丢掉 SBN 子系统状态。
- 兜底：`scripts/cloud_link_business_sync.sh` 支持部分店铺失败继续执行并记录 `state/cloud_ops_alerts/link-business-last-partial.json`；默认不把部分成功结果入仓刷新 BI，避免把不完整链接/业务域日期展示成全量成功。
- 恢复手段：若云端 SBN 子系统态整体失效，可在本机用 `scripts/auto_relogin_shein_store.mjs` 恢复对应店铺、再用 `scripts/export_shein_browser_session.mjs` 导出 `state/shein_browser_sessions/*.local.json` 并同步到云端私有同名目录；这些 session 文件是敏感运行态，不进 GitHub。
