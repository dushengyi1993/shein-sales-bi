# SHEIN BI Agent 交接说明（云端优先）

> 更新时间：2026-06-24
> 交接定位：这是给后续 agent 的项目入口说明。当前 GitHub release 是“交接源码基线”，**不等同于云端已经部署到该 commit**。生产验收必须以云端运行态为准。

## 1. 当前系统定位

本项目是 SHEIN 销售统计与自动运营驾驶舱，已经不只是 BI 页面：

- SHEIN 19 店销售 / 链接 / 商品 / 库存 / 售后 / RTV / ET 货代仓数据同步。
- PostgreSQL 数据仓库 + Metabase 深钻 + 自研 BI Portal。
- 云端飞书问数 / 图表能力、异常提醒、营销活动 / 限时折扣 / 优惠券价格线索与自动化辅助。
- 链接管理中台、商品资料母库、后续自动运营执行器基座。

最重要原则：**当前生产系统跑在云服务器，本地工作区不是生产权威。**

## 2. 当前生产入口

- 正式 BI 域名：`https://shein-bi.dushengyi.xyz/`
- 旧 IP 兜底：`http://43.165.167.135/`
- 云端登录维护入口：`https://shein-bi.dushengyi.xyz/cloud-login-maintenance`
- 云端代码目录：`/opt/shein-bi/app`
- 云端运行用户：`sheinops`
- 本机 SSH 别名：`ssh shein-bi-tencent`

公网访问有 Basic Auth。账号密码只由用户私下交付，不得写入 GitHub、文档、日志或聊天。

## 3. 服务器上已有系统

这台服务器不是空机器。除 SHEIN BI 外，还有 Gaobao 系统。新增项目必须独立部署，不能占用现有目录、端口或服务。

### SHEIN BI

- 目录：`/opt/shein-bi/app`
- 内部端口：`127.0.0.1:8787`
- 域名：`https://shein-bi.dushengyi.xyz/`
- 典型服务：
  - `shein-bi-portal.service`
  - `shein-bi-cloud-today.timer`
  - `shein-bi-cloud-daily-refresh.service`
  - `shein-bi-cloud-et-forwarder.timer`

### Gaobao

- 服务：`gaobao-major-db.service`
- 目录：`/srv/gaobao-major-db`
- 内部端口：`127.0.0.1:8790`
- 环境文件：`/srv/gaobao-postgres/gaobao.env`
- 备份服务：`gaobao-postgres-backup.service`

不要占用 `8787` / `8790`；不要修改 `/opt/shein-bi/app`、`/srv/gaobao-major-db`、`/srv/gaobao-postgres`，除非用户明确授权。

## 4. 云端是验收权威，不是干净发布源

截至 2026-06-24 交接前核对：

- GitHub `main` / release `2026.06.23-bi-traffic-detail` 指向 `3f25f7c2d87b822e8d564c8ff094c3f5252036e0`，包含流量页 SKC 明细优化和云端销售刷新锁修复。
- 云端 `/opt/shein-bi/app` 是生产运行权威，但当前仍不是 GitHub 最新 commit：2026-06-24 只读审计显示云端 `HEAD=5025d89`，且 `scripts/bi_app/client.js`、`scripts/bi_app/styles.css`、`scripts/cloud_bi_refresh.sh`、`scripts/generate_bi_portal.mjs`、`scripts/generate_bi_portal_shell.mjs` 等 tracked 文件有生产热修差异。
- 云端运行态已验证：正式域名未鉴权返回 `401`，`shein-bi-cloud-today.service` 锁修复后 `Result=success`，`cloud_ops_watchdog.mjs --dry-run` 返回 `ok=true / issues=[]`，`productTrafficDaily` section 返回 `200` 且包含 SKC 和链接状态字段。
- 这说明 GitHub 目前是“最干净、可恢复、可交接的源码基线”，但不能声称它完全覆盖云端生产目录，也不能反过来说云端差异都应上传。当前已知可回填的 2026-06-23 热修已经进入 GitHub；剩余云端差异仍需按运行产物 / 生产热修 / 过期文件分层审计。

因此：

- **禁止在云端直接 `git add -A`。**
- **禁止在未备份、未审计前对云端执行 `git reset --hard`、`git clean -fdx` 或强制 pull。**
- **禁止把 GitHub release 直接部署到云端来“清干净”，除非已经完成差异分类、备份和回滚方案。**
- **GitHub release 是源码交接基线，不自动代表云端已部署；云端当前代码也不自动代表可提交源码。**
- 下一 agent 第一件事不是部署，而是审计云端运行态并制定 reconcile 方案。

## 4.1 部署纪律：不能再让云端和 GitHub 分叉

本次暴露的核心教训是：云端长期停在老 commit 上继续手动改/运行，而 GitHub 后续发版没有同步部署，最终导致“GitHub 最新”和“云端真实生产”分叉。以后必须按下面规则执行：

- **云端热修必须回填 GitHub**：只要在 `/opt/shein-bi/app` 改了源码、脚本、配置模板、systemd 模板或文档，验证通过后必须提交到 GitHub；不能把生产热修只留在服务器。
- **GitHub release 必须说明部署状态**：release 说明里必须写清楚是“已部署并验证云端”还是“仅源码/交接基线，未部署云端”。不能再让接手者猜。
- **交接前必须做一致性检查**：至少确认 `git fetch --prune --tags`、`git rev-list --left-right --count HEAD...origin/main`、`git status --short`、关键 service 状态和 BI health。若 `HEAD != origin/main` 或存在源码脏改，必须先 reconcile 或明确列为 blocker。
- **云端运行产物不进 Git**：`.venv-*`、session、profile、日志、数据库 dump、临时上传、运行态 JSON 必须留在服务器私有目录或被 `.gitignore` 排除；不要用 `git add -A` 解决状态混乱。
- **标准部署顺序**：GitHub 提交/发版 -> 云端备份当前工作区 -> 云端拉取/切换到目标 commit -> 重启/刷新必要服务 -> 验证 BI/日志/定时器 -> 记录部署结果。任何一步失败都要保留回滚点。

## 5. 下一 agent 第一任务：云端差异审计

连接服务器后先只读审计：

```bash
ssh shein-bi-tencent
cd /opt/shein-bi/app

hostname
git branch --show-current
git log -1 --oneline
git fetch --prune --tags
git rev-list --left-right --count HEAD...origin/main
git status --short
git diff --stat origin/main --
git diff --name-status origin/main -- | sed -n '1,240p'
git ls-files --others --exclude-standard | sed -n '1,240p'
```

同时核对 systemd / 端口：

```bash
systemctl status shein-bi-portal.service --no-pager -n 30
systemctl list-timers --all | grep -E 'shein-bi|gaobao' || true
systemctl list-units --type=service --all | grep -E 'shein-bi|gaobao' || true
ss -lntp | grep -E '8787|8790|910|920' || true
```

确认公网入口：

```bash
curl -I https://shein-bi.dushengyi.xyz/ || true
curl -I http://127.0.0.1:8787/ || true
```

只有完成以下分类后，才允许同步云端到 GitHub release 或让云端追 GitHub：

- 哪些是生产 hotfix，应该回填 GitHub；
- 哪些是运行产物，应保留在云端但不提交；
- 哪些是备份 / venv / 临时上传，应排除；
- 哪些是误删或过期文件，应恢复或迁移；
- 哪些 systemd 文件是仓库模板，哪些才是服务器实际启用状态。

在分类完成前，推荐只做只读巡检和小范围验证；任何“同步云端 / 部署 GitHub / 清理工作区”都必须先给出文件清单和回滚路径。

## 6. 生产架构与公网入口

公网链路：

```text
公网 443
  -> HAProxy
  -> Caddy
  -> Nginx Basic Auth
  -> BI Portal 127.0.0.1:8787
```

不要直接暴露 Node 服务，不要绕过 HAProxy / Caddy / Nginx。

多项目共用服务器时，新项目建议：

- 目录：`/opt/projects/<project-name>/`
- 内部端口：`127.0.0.1:9100-9299`
- 服务名：`project-<name>.service`
- 子域名：`<name>.dushengyi.xyz`

禁止新项目占用：

- `22`
- `80`
- `443`
- `8787`
- `8790`

## 7. 云端常用命令

手动刷新当天 BI：

```bash
cd /opt/shein-bi/app
bash scripts/cloud_bi_refresh.sh today intraday
```

手动跑前一天最终版：

```bash
bash scripts/cloud_bi_refresh.sh yesterday final
```

销售刷新锁检查：

```bash
systemctl show shein-bi-cloud-today.service -p Environment
ls -l /opt/shein-bi/app/state/locks/shein-bi-cloud-sales-refresh.lock
node scripts/cloud_ops_watchdog.mjs --dry-run
```

`SHEIN_BI_REFRESH_LOCK_FILE` 应指向 `/opt/shein-bi/app/state/locks/shein-bi-cloud-sales-refresh.lock`。如果日志出现 `/tmp/shein-bi-cloud-sales-refresh.lock: Permission denied`，不要只删 `/tmp` 文件；应确认 `scripts/cloud_bi_refresh.sh` 在 `flock` 前调用 `prepare_shared_lock_file "$LOCK_FILE"`，并重载 systemd。

检查飞书问数机器人：

```bash
CODEX_HOME=/home/sheinops/.codex SHEIN_QA_CODEX_GATEWAY_ENABLED=1 \
  node scripts/lark_sales_qa_bot.mjs --answer "今天哪个店最差？原因可能是什么？"
```

检查 Codex CLI：

```bash
cd /tmp
CODEX_HOME=/home/sheinops/.codex timeout 120 codex exec --sandbox read-only --skip-git-repo-check "只回复 OK，不要解释。" < /dev/null
```

检查服务日志：

```bash
journalctl -u shein-bi-portal.service -n 200 --no-pager
journalctl -u shein-bi-cloud-daily-refresh.service -n 200 --no-pager
journalctl -u shein-bi-cloud-et-forwarder.service -n 200 --no-pager
```

## 8. GitHub / release 使用边界

- GitHub `main` / release 是源码恢复基线。
- 云端 BI 用户可见改动，应先在云端运行态或服务输出验证，用户确认后再进入 GitHub release。
- 仓库里的 `outputs/bi-portal/index.html` / `data.json` 是灾备/兼容快照，不代表当前云端数据。
- 当前数据判断必须看：
  - 云端 BI 页面；
  - 线上 `/api/bi/section/*`；
  - 云端 PostgreSQL；
  - 云端 systemd 日志；
  - 云端 section cache 生成时间。

如果服务器拉取/重置代码，必须刷新 BI 并核对页面时间：

```bash
cd /opt/shein-bi/app
bash scripts/cloud_bi_refresh.sh today intraday
```

## 9. 敏感信息红线

以下内容不得进入 GitHub、release、文档、日志或聊天：

- SSH 私钥；
- API key / token；
- Cookie / session；
- `.env.local`；
- 数据库密码；
- Basic Auth 密码；
- OpenAI / Codex / 第三方模型 token；
- SHEIN / 飞书 / ET / OpenAPI secret；
- `/home/sheinops/.codex/auth.json`；
- `/home/sheinops/.codex/config.toml`；
- `/srv/gaobao-postgres/gaobao.env`；
- `state/shein_webapi_sessions/*.local.json`；
- `state/shein_browser_sessions/*.local.json`；
- `profiles/persistent-*-profile`。

特别注意：`profiles/persistent-*-profile` 是活跃店铺登录态，不是普通缓存，不能整棵删除。

## 10. 不要恢复旧架构

- 本地 BI 已封存，不要重新启用本地 `8787` 或 Windows `SHEIN-*` 计划任务。
- 正式 BI 入口只有 `https://shein-bi.dushengyi.xyz/`。
- V2 是当前正式 BI Portal；V1 只保留 GitHub archive release 恢复点，不进入生产调度。
- 不要把仓库 `outputs/bi-portal/*` 当成当前业务数据。
- 不要把低频链接/业务域日更按销售高频阈值误报。
- 不要建议删除 PostgreSQL 或 Metabase；PostgreSQL 是核心数据仓库，Metabase 仍是深钻层。

## 11. 开发 / 优化推荐流程

1. 先在 GitHub / 本地理解源码；不要先改云端生产。
2. 如果问题涉及当前数据、新鲜度、性能、定时任务，先查云端运行态。
3. 如需改代码，先在分支或本地改，做语法/最小行为验证。
4. 推 GitHub 后，若要部署云端，先备份云端工作区：

```bash
cd /opt/shein-bi/app
git status --short
git stash push -u -m "pre-deploy-$(date +%Y%m%d-%H%M%S)"  # 仅在确认需要暂存时使用
```

5. 部署后跑：

```bash
bash scripts/cloud_bi_refresh.sh today intraday
systemctl status shein-bi-portal.service --no-pager -n 30
```

6. 用户可见页面必须以云端域名验收。

## 12. 如果要接管云端部署，先问清楚

涉及以下操作前必须先问用户或当前维护 agent：

- 修改 HAProxy / Caddy / Nginx；
- 修改 80 / 443；
- `git reset --hard` / `git clean`；
- 重启或停用生产 timer/service；
- 操作 Docker / PostgreSQL / Metabase；
- 清理磁盘大文件；
- 删除 `profiles`、`state`、`outputs`、`logs`；
- 修改 `/srv/gaobao-*`；
- 使用现有域名部署新项目；
- 处理任何密钥、Cookie、登录态。

## 13. 一句话交接原则

**GitHub release 是源码基线；云端运行态才是业务真相。**

接手后先审计云端，不要盲目 reset / pull / add-all；所有优化都必须在不破坏 SHEIN BI、Gaobao、登录态、数据库和公网入口的前提下进行。
