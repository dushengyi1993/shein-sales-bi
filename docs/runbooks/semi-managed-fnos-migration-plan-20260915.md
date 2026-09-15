# 半托迁移飞牛 + 新云边缘：完整方案

拟定日期：2026-09-15。依据：全托 9/6 飞牛切流与 9/8 边缘迁移记录（`semi-managed-fnos-migration-reference-20260908.md`）、本任务 2026-09-15 对旧云的只读实测、以及本仓库 2026-09-14/15 的发布与晨链修复经验。

本文件是**方案**，不是执行记录。方案里所有“现状”数字都是 2026-09-15 当天实测值，实施前必须重新核一次（尤其端口占用、容量、排班）。

---

## 0. 一页结论

目标是把半托从旧云（43.165.167.135）整体搬到飞牛新 VM，并把公网入口与 OpenAPI 固定出口放到新云（43.165.185.3），复刻全托已经跑通的拓扑：

```text
访客 / SHEIN 回调
  → sa.dushengyi.cc (A → 43.165.185.3)
  → 新云 HAProxy:443 / Caddy(TLS)
  → 新云回环端口 ← 飞牛半托 VM 主动建立的 SSH 反向隧道
  → 半托 Portal(8787) / Query(8791) / Webhook(8792) → 飞牛半托数据库

半托 OpenAPI 客户端
  → VM 回环代理 127.0.0.1:<新端口>
  → SSH 本地转发 → 新云受限 CONNECT relay
  → openapi.sheincorp.com / openapi-sem.sheincorp.com
  → 平台看到固定出口 43.165.185.3
```

需要搬的东西一共五类：**服务（3 个 node + nginx 站点 + caddy 站点）**、**数据库（warehouse 8.4 GB + metabase 58 MB）**、**调度（18 个 timer / 31 个 unit）**、**数据与凭据（vdb 上约 58 GB + secrets）**、**出口与白名单（21 个 app）**。

建议分四天落地，不要一次切：D1 备好 VM 并演练恢复 → D2 新云边缘 + 出口 + 逐店白名单 → D3 数据与执行权切换 → D4 兼容期观察后退役旧组件。

---

## 0.5 一次性执行版（2026-09-15 修订，取代 §9 时间表）

用户要求一次做完，停机可停自动任务，飞牛后台已登录，21 个白名单可能已建好，profile 先搬过去再由同事集中登录。以下为按此条件重排的执行流，**不改变任何验收标准**，只改变顺序与并行度。

### 0.5.1 已现场验证的通道矩阵（2026-09-15）

| 目标 | 通道 | 状态 |
| --- | --- | --- |
| 旧云 `43.165.167.135` | `ssh shein-bi-tencent`（443 端口，key） | 可用，有 sudo |
| 新云 `43.165.185.3` | 本机 22 端口被本地代理掐断；改走 `ssh -J shein-bi-tencent ubuntu@43.165.185.3`，已安装 `shein_fm_friend_migration_20260908` 公钥 | 可用，免密 sudo |
| 飞牛宿主 `192.168.1.59` | `ssh -i fnos_shein_fm_ed25519 dushengyi@192.168.1.59` | 可登录，**但无免密 sudo**，libvirt/polkit 需要管理员认证 → 见阻塞项 |
| 全托 VM `192.168.1.79` | `ssh -i shein_fm_shadow_ed25519 sheinops@192.168.1.79` | 可用，作为隧道/relay 的参考实现 |
| 飞牛出网 | 旧云:443 ✓、新云:22 ✓、新云:443 ✓、npm registry 200 ✓ | 隧道与安装依赖都通 |

新云关键发现：

- 已用回环端口：18080/18081/18082/18083（airouter/ambmh）、18090（全托 relay）、18788/18789/18793/18794（全托 VM 的 RemoteForward）、8081（全托 edge nginx）、9101（brazil）、5433、1455、19081。半托可分配：**edge 8082、relay 18091、RemoteForward 18795/18796/18797**。
- 根分区 79 GB 已用 69 GB，**只剩 7.2 GB**，新云只做配置类载体，不放数据。
- **8443 入站被腾讯安全组挡住**（旧云 443/8443 都通，新云只有 80/443 通）→ 见决策 2。

半托已有可复用件（无需新造）：

- 登录网页已存在：Portal 自带 `/cloud-login/novnc/vnc.html`，底层是 `scripts/cloud_manual_login_session.mjs`（Xvfb + Chrome + x11vnc + websockify，全部只绑回环）。
- 会话恢复链已存在：`shein-bi-cloud-manual-login-recovery`（每小时 :47）+ `lib/cloud_manual_login_recovery.mjs`。
- 数据转移走 VM 主动拉取：飞牛侧可直接连旧云 443，用新生成的传输 key（在旧云 `authorized_keys` 里加一条，迁移后删除）。

### 0.5.2 一次做完的执行流

**A0（10 分钟，唯一硬阻塞）**：拿到飞牛管理员能力——给 `dushengyi` 的 sudo 密码，或由你在飞牛后台按我给的规格建 VM（4 vCPU / 8 GiB / 系统盘 + 200 GB 数据盘在 /vol2 / 与全托同网段固定 IP）。

**A1（并行，1–2 小时）**：建 VM 并跑引导脚本。用 Ubuntu 24.04 cloud image + cloud-init 装好：Docker、同版本 Node、Chrome + Xvfb + x11vnc + websockify + noVNC、Postgres 16-alpine 镜像（离线 tar 传入）、防火墙只放 22 与业务端口。代码用 `git` 锁到 `2026.09.15.1` + `npm ci`。

**A2（与 A1 并行，20 分钟）**：在旧云生成传输 key 并授权给 VM；同时开始 **21 个 app 白名单核实**（只读，走各店 profile 的开放平台页面），把结果记成逐店清单——这一步不依赖 VM。

**A3（约 1 小时）**：数据第一次全量同步（VM 主动 rsync 拉取）：`profiles`、`state`、`outputs`、`runtime`（先跳过大体积历史版本目录，记清单留档）、`secrets`、`config/*.local.json`，以及 `pg_dump -Fc` 的 `shein_bi` + metabase 库。

**A4（profile 到位即可开始，可与 A5 并行）**：VM 起 Portal 与 manual-login 组件，同事通过登录页逐店登录；每店登录后立即用只读探针验证会话可用。

**A5（1 小时）**：VM 内恢复数据库 → 基线对账（表数/关键表行数/序列/最大时间戳）→ 起 Portal/Query/Webhook → 本机回环自检。

**A6（1 小时）**：新云加半托边缘：`/etc/caddy/shein-bi-edge.caddy`（import 进共享 Caddyfile，改前存哈希）、`/opt/shein-bi-openapi-relay`（放行 `openapi.sheincorp.com:443` + `openapi-sem.sheincorp.com:443`）、VM 侧隧道 unit（RemoteForward 18795/18796/18797，LocalForward 18091）。用 `curl --resolve sa.dushengyi.cc:443:43.165.185.3`（不带 `-k`）验证新入口，用真实客户端验证出口 = 43.165.185.3。

**A7（切换窗口，30–60 分钟）**：停旧侧 timer/服务 → 最终增量同步 + DB 追平 → VM 启用服务与排班 → 切 DNS（`sa.dushengyi.cc` → 43.165.185.3）→ 旧云 Caddy 的 sa 站点改为指向 `https://43.165.185.3`（带 `tls_server_name`）做兼容转发。

**A8（并行观察）**：真实回调、15 分钟对账、30 分钟库存/门户、07:10 晨链各自跑通一轮后，再退役旧云半托专属 unit（共享 HAProxy/Caddy/Nginx/其它项目不动），删除临时凭据与传输 key，交付证据。

### 0.5.3 相对原方案的三处优化

1. **不必全程停机**：VM 准备、数据首拷、profile 迁移、白名单核实、同事登录全部在旧云继续服务的状态下并行做；只有 A7 需要真正停写，窗口从“几小时”压到 30–60 分钟。
2. **登录不再等到最后**：profile 一搬完就开放登录页，同事登录与我的后端准备并行，这是最耗时的人工环节（21 店），提前解锁。
3. **网关留在 VM 内**：沿用现有那份 8.6 KB nginx 配置（含 query 面禁止回退、限流、WebSocket 语义）原样运行，新云只做 TLS + 单端口隧道；不把路由语义在容器里重写一遍，减少回归面。新云只放 Caddy 片段 + relay + 隧道监听。

### 0.5.4 一次做完的真实时间预算（按并行口径）

| 阶段 | 时长 | 可并行 |
| --- | --- | --- |
| A0 飞牛权限/建 VM | 10 分钟 | — |
| A1 VM 引导 + 依赖安装 | 1–2 小时 | 与 A2 并行 |
| A2 白名单核实 + 传输 key | 30–60 分钟（21 店只读） | 与 A1 并行 |
| A3 首次全量同步 | 1–2 小时（取决于带宽） | 与 A4 前半并行 |
| A4 21 店登录 | 1–2 小时（人工） | 与 A5/A6 并行 |
| A5 恢复 + 对账 + 本机自检 | 1 小时 | 与 A6 并行 |
| A6 新云边缘 + 隧道 + 出口 | 1 小时 | 与 A4/A5 并行 |
| A7 停写 + 追平 + 切 DNS | 30–60 分钟 | 串行 |
| A8 观察 + 退役 + 交付 | 2–4 小时（观察窗口） | 观察可与退役准备并行 |

关键路径是 **A1 → A3 → A7**，其余都能并行。若 A0 立刻解决，当天完成是可行的；真正的变量是 21 店登录的人工时间。

---

## 1. 现状盘点（2026-09-15 只读实测）

### 1.1 旧云主机

| 项目 | 实测值 |
| --- | --- |
| 主机 | 43.165.167.135 = `VM-0-17-ubuntu` |
| 规格 | 2 vCPU / 7685 MiB 内存（当时可用 4654 MiB） |
| 系统盘 | `/dev/vda2` 79 GB，已用 44 GB，余 33 GB |
| 数据盘 | `/dev/vdb` 98.2 GB，已用 69.5 GB，余 23.7 GB |

### 1.2 这台机器上有别的项目，只能动半托专属资源

- 共享反代：HAProxy `0.0.0.0:443`（TCP 分流：SSH 载荷 → sshd；SNI `fm.dushengyi.cc` → Caddy 11443；其余 TLS → Caddy 10443）、Caddy（80 / 10443 / 11443 / 8443 / 回环 2019 admin）、Nginx。
- 共享数据库容器：`brazil-ops-db`(127.0.0.1:5432)、`gaobao-postgres`(127.0.0.1:55432)。
- 共享目录：`/srv/shein-fm/backups`（全托备份）。
- 全托兼容转发仍在旧机：`fm.dushengyi.cc` → Caddy 11443 → `https://43.165.185.3`（旧 NS 缓存未完全消退，这条在退役阶段才处理）。

### 1.3 半托专属组件

服务三件套（都只监听回环）：

| 端口 | 服务 | 说明 |
| --- | --- | --- |
| 127.0.0.1:8787 | `shein-bi-portal.service` | BI Portal + 登录 |
| 127.0.0.1:8791 | `shein-bi-query.service` | 只读查询面（含 partner-cli / owner-knowledge 分发） |
| 127.0.0.1:8792 | `shein-bi-webhook.service` | SHEIN 回调接收 + 异步 worker |

Nginx 站点 `/etc/nginx/sites-enabled/shein-bi`（唯一启用站点，监听 127.0.0.1:8080，`server_name sa.dushengyi.cc 43.165.167.135 localhost`）：

| 路由 | 上游 |
| --- | --- |
| `/api/shein/webhook/v1/events`（精确匹配） | 127.0.0.1:8792 |
| `/api/login` `/api/logout` `/api/auth/me` | upstream `shein_bi_auth` = 8791（备用 8787） |
| `/api/bi/query-data`、`/api/partner-cli/{package,manifest,bundle}`、`/api/owner-knowledge/{manifest,bundle}` | 127.0.0.1:8791（注释明确禁止回退到 8787） |
| `/` | 127.0.0.1:8787 |

Caddy 站点（`/etc/caddy/Caddyfile`，与全托/Brazil/蓉资共享）：

| 站点 | 行为 |
| --- | --- |
| `http://sa.dushengyi.cc` | 308 → https |
| `https://sa.dushengyi.cc:10443` | reverse_proxy → 127.0.0.1:8080（经 HAProxy TCP 透传，故记录真实来源 IP） |
| `https://sa.dushengyi.cc:8443` | 只接受 POST `/api/shein/webhook/v1/events`，且 `remote_ip` 命中 24 个 SHEIN 回源 IP，其余返回 404 |

数据库容器：

| 容器 | 端口 | 内容（实测） |
| --- | --- | --- |
| `shein-warehouse-db` | 127.0.0.1:54329 | `shein_bi` 8379 MB（含 `ops.*` 业务表）、`shein_bi_store_identity_test_20260727` 3409 MB（历史测试库，建议不迁）、`postgres` 7.5 MB |
| `shein-metabase-db` | 不映射（in-network） | `metabase` 58 MB |

注意：这台机器上**没有** Metabase 应用进程/容器，只有它的库。Metabase 应用实际跑在哪需要你确认（见 §8 决策 4）。

### 1.4 半托数据与凭据

挂载关系（全部在数据盘 `/dev/vdb` 上，即与数据同盘）：

| 逻辑路径 | 实体 | 实测大小 |
| --- | --- | --- |
| `/opt/shein-bi/app` | 系统盘 | 12 GB（含 node_modules） |
| `/opt/shein-bi/app/state` | vdb[/shein-bi/state] | — |
| `/opt/shein-bi/app/profiles` | vdb[/shein-bi/profiles] | — |
| `/srv/shein-bi/runtime` | vdb[/shein-bi/runtime] | 28 GB（daily-inventory-replenishment 7.5 GB、et-low-inventory-guard 7.6 GB、release-backups 3.4 GB、deploy-2026.09.14.5 1.4 GB…） |
| `/data/shein-bi/outputs` | vdb[/shein-bi/outputs] | — |
| `/srv/shein-bi/backups` | vdb[/shein-bi/backups] | 14 GB |
| `/srv/shein-bi/logs` | 系统盘 | 1.9 GB |

凭据与配置：

- `/srv/shein-bi/secrets/`：`portal-warehouse.env`、`webhook-warehouse.env`、`webhook-openapi-central.json`、`github_deploy_key`、`bi_basic_auth.htpasswd`、`openapi-legacy/`。
- `config/shein_openapi.local.json`：`environment=prod`、`cooperationMode=半托管`、`market=SA`、`stores` 21 家、`apps` 21 个（每店独立 appId/appSecretKey）、`consolidation.mode=per-store-primary`（备用中央配置在 secrets）。
- 官方上游：API `https://openapi.sheincorp.com`；授权 `openapi-sem.sheincorp.com`；测试环境另有 `openapi-test01.sheincorp.cn` / `openapi-sem-test01.dotfashion.cn`。
- 其它配置：`stores.json`(21)、`store_style_profiles.json`、`inventory_replenishment_policy.json`、`marketing_*.json`、`bi_access_roles.json`、`bi_users.local.json`、`lark_report.json`、`cos_backup_remote_target.json`。

### 1.5 调度（18 个 timer，实测 OnCalendar）

| unit | 排班 |
| --- | --- |
| `shein-bi-cloud-today-sales-reconcile` | 每 15 分钟（:00/:15/:30/:45） |
| `shein-bi-cloud-openapi-stock-refresh` | 每 30 分钟（:18/:48） |
| `shein-bi-cloud-portal-section-queue` | 每 30 分钟（:02/:32） |
| `shein-bi-cloud-manual-login-recovery` | 每小时 :47 |
| `shein-bi-cloud-watchdog` | 00–07、09–23 的 :50 |
| `shein-bi-cloud-browser-cleanup` | 21:20 |
| `shein-bi-cloud-disk-maintenance` | 00:10 |
| `shein-bi-cloud-session-manager` | 00:45 |
| `shein-bi-cloud-et-forwarder` | 04/07/10/13/17/20/23 的 :20 |
| `shein-bi-cloud-et-low-inventory-recheck` | 00/02/05/06/08/09/11/12/15/16/18/19/22 的 :20 |
| `shein-bi-db-backup` | 02:25 |
| `shein-bi-cloud-yesterday` | 03:20 |
| `shein-bi-cloud-rtv-verify` | 04:50 |
| `shein-bi-cloud-order-closure` | 06:52 |
| `shein-bi-cloud-morning-chain` | 07:10（run 预算 10200 s，库存预留 2700 s） |
| `shein-bi-cloud-marketing-live-guard` | 11:00 |
| `shein-bi-cloud-et-storage-fee` | 14:20 |
| `shein-bi-cloud-marketing-repair` | 21:15 |

### 1.6 备份现状（不满足全托定下的最低要求）

- 每日 01:45 本地 dump 到 `/srv/shein-bi/backups/auto/2026MMDD-HHMMSS/`（最近一次 2026-09-15 01:45）。
- COS 远端目标已配置：`lhcos-fcfe0-1303578641`，region `ap-tokyo`，prefix `lhcos-data/shein-bi-db-backups`。
- **问题**：`/srv/shein-bi/backups` 是 `/dev/vdb` 上的目录，和业务数据同一个物理盘。全托参考文档明确要求“备份至少落到不同物理盘”。飞牛 `/vol3`（独立 500 GB）应作为半托备份目录候选。
- 另外不清楚是否做过**隔离恢复演练**，迁移前必须补一次。

### 1.7 目标侧现状

| 项目 | 实测值 |
| --- | --- |
| 飞牛宿主 | `192.168.1.59`（HTTP 80/5666 页面标题 “飞牛 fnOS”），Ryzen 5 5600G 6C12T，可见内存约 27.3 GiB，ZFS ARC 约 6.2 GiB |
| 全托 VM | `192.168.1.79`，4 vCPU / 8 GiB（2026-09-08 由 12 GiB 降配），LAN Portal 正常返回 “SHEIN 全托运营驾驶舱” |
| 存储候选 | `/vol2`（1 TB 机械盘，全托虚拟盘所在地）、`/vol3`（500 GB 独立盘，备份候选） |
| 新云 | `43.165.185.3` = `VM-0-15-ubuntu`，已承载全托入口（`/opt/shein-fm-edge`、`/etc/caddy/shein-fm-edge.caddy`）与出口 relay（`/opt/shein-fm-openapi-relay`，回环 18090，只放行 `openapi.sheincorp.com:443`） |
| DNS | `sa.dushengyi.cc` A = 43.165.167.135（旧云，非 Cloudflare 代理）；`fm.dushengyi.cc` A = 43.165.185.3 已切 |

### 1.8 半托与全托的关键差异（不能照抄）

| 维度 | 全托 | 半托 |
| --- | --- | --- |
| 授权主体 | 17 主体 / 25 店 | **21 店 = 21 个独立 app** |
| 出口 relay 放行 | 仅 `openapi.sheincorp.com:443` | 需同时放行 `openapi.sheincorp.com:443` 与 `openapi-sem.sheincorp.com:443`（授权域名不同） |
| Webhook | 走新云入口 | **实测走标准 443**（2026-09-15 18:04:21 抓包：回调动作为 `8.219.56.57` → 旧云 `:443` 的两个 SYN，与同秒两条 nginx 200 一一对应；8443 在整段抓包里 0 包）。域名回调 + SNI 才能匹配 Caddy 的 `sa.dushengyi.cc` 站点，故平台配置的是域名回调而非 IP 回调。8443 只是带源 IP 白名单的受限回退，**不是平台生产配置，迁移时无需搬迁、也无需改希音后台**。 |
| 调度密度 | 较低 | 每 15 分钟 reconcile、每 30 分钟 stock/section、每小时 login-recovery |
| 浏览器 profile | 在 VM 上 | **在云端**（要随数据搬，登录态有失效风险） |
| 备份 | 有异盘要求 | 目前与数据同盘，需改造 |
| 同机邻居 | — | Brazil、gaobao 两个项目 + 全托兼容转发，退役时不得误伤 |

---

## 2. 源 → 目标资源映射

| 类别 | 旧（43.165.167.135） | 新（飞牛 VM / 43.165.185.3） |
| --- | --- | --- |
| 主机 | VM-0-17-ubuntu 2 vCPU / 7.5 GiB | 飞牛新 VM：4 vCPU / 8 GiB / 数据盘 200 GB（/vol2） |
| Portal | `shein-bi-portal.service` 127.0.0.1:8787 | 同名 unit，VM 回环 8787 |
| Query | `shein-bi-query.service` 127.0.0.1:8791 | 同名 unit，VM 回环 8791 |
| Webhook | `shein-bi-webhook.service` 127.0.0.1:8792 | 同名 unit，VM 回环 8792 |
| 内网网关 | Nginx 站点 `shein-bi` @127.0.0.1:8080 | 新云隔离 Nginx（容器的独立站点，回环端口另分配）或 VM 内 nginx，二选一在阶段 3 定 |
| 公网入口 | 旧云 HAProxy:443 → Caddy:10443 | 新云 Caddy（追加半托独立 import），HAProxy 复用 |
| Webhook 公网端口 | 标准 443：HAProxy → Caddy 10443 → Nginx → 8792（8443 仅为受限回退） | 新云同结构：Caddy edge `https://sa.dushengyi.cc` → 18795 → VM Nginx 8080；**平台回调 URL 不需要任何修改**，切 DNS + 旧云兼容转发即可（与全托 9/8 一致） |
| 反向隧道 | 无（服务在云上） | 新增 `shein-bi-fnos-tunnel.service`：RemoteForward 18795→8787、18796→8791、18797→8792（端口待定，避开全托 18788/18793/18794/18789） |
| OpenAPI 出口 | 旧云公网 IP 直出 | VM 回环 18091（待定）→ SSH LocalForward → 新云 CONNECT relay（新增半托实例）→ 43.165.185.3 |
| 数据库 | `shein-warehouse-db`(54329)、`shein-metabase-db` | VM 内同名容器，端口保持回环 |
| 数据目录 | vdb 上 state/profiles/runtime/outputs/backups | VM 数据盘（200 GB）同结构；备份目录改到 `/vol3` 独立盘 |
| 配置/凭据 | `/srv/shein-bi/secrets`、`config/*.local.json` | VM 同路径 + 权限保持 root:sheinops 0640/0600 |
| 调度 | 18 个 timer | 逐条搬 OnCalendar，**不新建**重复 timer |
| DNS | `sa.dushengyi.cc` A=旧云 | 切到 43.165.185.3；旧云保留兼容转发一段时间 |

---

## 3. 分阶段实施与验收

### 阶段 0：冻结决策与开权限（0.5 天）

产出：确认 §8 的 6 项决策；拿到新云临时凭据；拿到飞牛建 VM 的授权。

验收：能 SSH 到新云、能在飞牛创建 VM，凭据带明确到期时间且**只做迁移用途**。

### 阶段 1：只读盘点与回滚边界（0.5 天）

- 重新核一遍 §1 的端口、容量、排班、版本（旧云当前发布 = `2026.09.15.1` / `0e0f2bd`）。
- 画出写入者清单：哪些进程写 `shein_bi`、哪些发平台请求、哪些消费队列（webhook worker、portal-section-queue、marketing-repair、inventory guard、morning chain）。
- 记录基线：数据库行数/序列/关键表哈希、outputs/state 文件清单哈希、profiles 清单、secrets 清单（只记名称与哈希）。
- 写清可接受中断窗口与数据损失窗口（建议 ≤ 15 分钟）。

验收：一份资源映射 + 写入者清单 + 可执行回滚计划，而不只是“能 SSH”。

### 阶段 2：飞牛建 VM、部署候选环境、恢复演练（1 天）

- 在飞牛创建半托独立 VM：4 vCPU / 8 GiB / 系统盘 + 200 GB 数据盘（/vol2），固定 IP（或路由器保留），不要复用全托的 192.168.1.79。
- 装运行时（Node 同版本、Postgres 16-alpine 同镜像、Chrome/Playwright 依赖），业务代码用 `git` 锁定到与旧云相同的 tag（`2026.09.15.1`）。
- 恢复演练：把旧云最近一次 dump 恢复到 VM 隔离库，逐项校验表数、关键表行数、序列值、约束/触发器、应用能读。
- 备份改造：把备份目录落到 `/vol3`，配保留周期、容量上限、失败提示、最近成功时间检查；做完一次**隔离恢复**验证。
- 候选 timer/worker 全部先 disable：`enabled ≠ active`，确认不会消费真实任务、不会写生产。

验收：VM 内应用能起、隔离恢复通过、备份异盘且恢复验证通过、候选调度未上线。

### 阶段 3：新云边缘、受限出口、专属隧道（0.5 天）

- 新云只追加半托独立配置：`/etc/caddy/shein-bi-edge.caddy`（import 进共享 Caddyfile，改前先备份并记哈希）、`/opt/shein-bi-openapi-relay`（CONNECT relay，只允许需要的两个上游域名）。
- VM 建 `shein-bi-fnos-tunnel.service`：RemoteForward 给入站、LocalForward 给出站，`ExitOnForwardFailure=yes`、保活、`RequestTTY no`、`SessionType none`，新云侧 key 用 `permitopen`/`permitlisten` 限制并禁止执行命令。
- 先证明监听来自新隧道（避免命中遗留进程），再测：`curl --resolve sa.dushengyi.cc:443:43.165.185.3`（不带 `-k`），以及 webhook 端口 8443。
- 出口链路：VM → 127.0.0.1:18091 → SSH → 新云 relay → 平台，实测公网出口为 43.165.185.3。

验收：本地端点、新云回环端点、新 IP + 正确域名的 HTTPS 三层都通；出口实测为新 IP；证书校验通过（不得用 `-k` 掩盖）。

### 阶段 4：白名单先加后切，逐店真实认证（0.5 天，需要你在场）

- 21 个半托 app 逐个把 43.165.185.3 加入白名单，**保留旧 IP**，保存后刷新回读。
- 从 VM 用真实业务凭据、经过新回环代理逐店跑最小只读探针（`number-list` / `query-sku-sales` 之类，不落业务数据）。
- 先探候选代理，再切正式出口配置，切后再次逐店验证；记录每店结果与配置指纹，报告中不出现密钥。

验收：21/21 店经新出口认证通过；白名单回读证据齐全。（TLS 成功、根路径 401 只证明可达，不算认证通过。）

### 阶段 5：数据与执行权切换，保证单边运行（0.5 天，核心窗口）

- 按写入者清单停旧侧调度/消费者（先停 timer，再停 unit），确认无在途写入、锁已释放。
- 最终追平：最后一次增量（dump 或 WAL 追平）→ 校验行数/序列/关键表 → 记录基线哈希。
- 基线通过后：启用 VM 服务与门禁 → 切换入口路由 → 观察至少一个完整业务周期。
- 迁移原排班（逐条 OnCalendar 对齐），确认旧侧 inactive/disabled、新侧实际 active；oneshot 要看 InvocationID 与终态，不能看 `ExecMainStatus=0` 就判成功。
- 浏览器 profile：验证 21 店登录态，失效的走既有 `manual-login-recovery` 或人工重登；Chrome 启动器必须保留 `on_device_foundational_model_user_settings=false` 等既定开关。

验收：只有新侧产生新数据/新任务；页面读到的当日数据与任务结果对应；旧侧没有任何写入。

### 阶段 6：DNS 与证书（0.5 天）

- `sa.dushengyi.cc` A 记录从 43.165.167.135 改为 43.165.185.3（TTL 300 更平滑）；仅改这一条，不动其它子域。
- 多个公共解析器交叉验证（Tencent/Google/Cloudflare DoH），既测域名解析也测绑定新 IP 的 HTTPS。
- 证书由新云 Caddy 自动管理：确认实际签发成功、公网握手提供新证书、存储持久化。旧机保留兼容转发（照 fm 的做法：旧 Caddy 的 sa 站点 upstream 指向 `https://43.165.185.3` 并显式 `tls_server_name sa.dushengyi.cc`）。

验收：公网 DNS 收敛、真实浏览器登录 Portal 成功、SHEIN 回调能到新入口。

### 阶段 7：真实链路终验（0.5 天）

- Portal：真实账号登录、主要页面、数据读取、导出。
- OpenAPI：逐店只读认证 + 出口正确；深度匹配（21/21）与昨日切片晋升正常。
- Webhook：真实平台投递 → 新云日志 → 验签 → receipt → job → 业务事件逐条核对；重复投递不重复执行业务。
- 调度：早上 07:10 晨链、每 15 分钟 reconcile、每 30 分钟 stock/section、夜间备份/会话管理各自跑通一轮，终态与物化结果一致。
- 授权与会话：既有会话可用、续期正常；需要重新授权的店铺实际走完一次换票。
- 回归：旧云上 Brazil/gaobao/全托兼容入口/蓉资静态站仍然正常。

验收：一份终验清单，逐项给出证据位置；不把“健康 200”当作业务完成。

### 阶段 8：退役旧组件并交付（1 天）

- 先查依赖：改 unit 的 `Requires/After` 再停旧隧道（全托踩过：停隧道把授权服务一起带停；drop-in 空赋值删不掉依赖，必须改完整 unit + daemon-reload + 回读）。
- 只停半托专属 unit、只移除半托专属 Nginx/Caddy 站点；共享 HAProxy/Caddy/Nginx 与其它项目保留。
- DNS 收敛后再删旧机兼容转发。
- 撤销本次临时凭据并验证新连接被拒绝，保留原管理员/隧道 key。
- 交付证据：配置与哈希、备份与恢复验证、逐店验收、数据库对账、真实回调证据、服务与调度状态、残留项、回滚步骤；证据存到不随旧机销毁而丢失的位置。

---

## 4. 数据一致性与切换窗口

1. **基线**：停旧侧写入 → 立刻 dump（`pg_dump -Fc`）→ 记录 `schema_migrations`、关键表行数、序列当前值、`ops.link_ops_task / link_ops_event / shein_webhook_receipt / shein_webhook_product_state` 计数与最大时间戳。
2. **恢复**：恢复到 VM 库 → 逐项比对基线 → 应用连库只读自检（Portal 登录 + 查询面 + webhook receipt 查询）。
3. **追平**：若停机窗口内仍有回调写入（webhook 是外部驱动，可能随时到），要么把 8443 临时指向“接收暂存”，要么接受窗口内回调重投（SHEIN 会重投，去重靠 receipt；这条要在阶段 1 明确写出接收/暂存/重试路径）。
4. **切换**：先启 VM 服务 → 再切入口 → 再启调度。
5. **窗口建议**：凌晨 02:00–04:30（避开 02:25 备份与 03:20 yesterday、07:10 晨链）。若不能忍受 4 小时内不可用，可以拆成两步：库先切（停机 15 分钟内）、调度分两晚搬。

---

## 5. 回滚

| 阶段 | 回滚动作 | 关键前提 |
| --- | --- | --- |
| 2 VM 准备 | 直接删 VM / 停候选 unit | 未接生产，无数据影响 |
| 3 边缘与隧道 | 撤半托 import、停隧道、恢复 Caddy 备份哈希 | 改前记录共享 Caddyfile 哈希，回滚前再比对一次，避免覆盖别人后续修改 |
| 4 白名单 | 白名单本来保留旧 IP，无需回滚 | 逐店回读证明旧 IP 仍在 |
| 5 数据/执行权 | 停 VM 侧、启旧侧、把旧库替换为“追平后的备份” | **只能从切换后的最新库回滚**，不能直接启动切换前的旧库当作无损恢复 |
| 6 DNS | A 记录改回旧 IP（若旧机保留兼容转发则无需改） | 旧机组件在兼容期内不删 |
| 7/8 退役 | 旧侧 unit/站点保留到兼容期结束再删 | 删前确认无其它依赖 |

---

## 6. 风险与坑

| 风险 | 现象 | 应对 |
| --- | --- | --- |
| 停旧隧道连带停掉别的服务 | 全托曾把授权服务一起带停 | 先画依赖、改完整 unit、daemon-reload、回读有效依赖，再停 |
| drop-in 删不掉依赖 | `Requires=` 空赋值无效 | 不假设可以这样重置，直接改完整 unit |
| 文件改了进程没变 | 常驻服务不自动重读 env | 受控重启 + 读实际进程环境/PID + 业务结果 |
| DNS 看着换完还在收旧流量 | 旧 NS 缓存（TTL 43200） | 旧机保留兼容转发，看真实接入日志 |
| 健康检查被过度解读 | 200/401 不代表完整业务 | 分别验认证、持久化、消费、调度、页面 |
| 共享机器误清理 | 旧机有 Brazil/gaobao/全托兼容 | 只动半托专属文件/服务，禁止整目录、整机清理 |
| 浏览器 profile 与登录态 | 换机后 WebAPI 会话可能失效 | 迁移前备份 profiles，迁移后逐店验证，失效走既有恢复流程 |
| 出口白名单遗漏 | 只加 API 域名漏掉授权域名 | relay 同时放行 `openapi.sheincorp.com` 与 `openapi-sem.sheincorp.com` |
| 备份形同虚设 | 备份与数据同盘、且可能没做过恢复演练 | 备份落 /vol3（异盘），迁移前完成一次隔离恢复 |
| 调度重复 | 新旧两侧同时跑同一任务 | 切换顺序固定：停旧 → 追平 → 启新；同一业务只有一个执行方 |
| 密集调度撞飞牛 I/O | 每 15/30 分钟任务与全托重任务同盘 | 迁移后与全托排班做跨 VM 错峰，观察 I/O 等待与任务耗时 |

---

## 7. 半托专属的技术待定项（实施时先确认）

1. 新云回环端口分配：入站 RemoteForward（建议 18795/18796/18797）与出站 LocalForward（建议 18091），需避开全托已用的 18090/18788/18789/18793/18794 与其它项目端口。
2. 内网网关放哪：新云隔离 Nginx（照全托 `shein-fm-edge-nginx`，镜像 ID 固定、非 root、只读）还是 VM 内 Nginx，二选一。半托 webhook 有源 IP 白名单 + 限流语义，搬迁必须逐条保留。
3. 浏览器/WebAPI 网络：半托浏览器 lane 目前直接出旧云公网 IP，搬到家后出口变成办公室 IP；需要确认 SHEIN WebAPI 不因换 IP 强制失效，并准备重登。
4. 历史 runtime 是否全搬：`daily-inventory-replenishment`(7.5 GB) 与 `et-low-inventory-guard`(7.6 GB) 里大部分是历史版本快照，可以只搬当前 active 版本 + 结果索引，其余留档不迁（要你确认可接受）。
5. 测试库 `shein_bi_store_identity_test_20260727`(3.4 GB) 建议不迁，确认后可在旧机保留而不是删除。
6. Metabase：应用位置未知，确认后再决定迁不迁它的库（库只有 58 MB，本身很好搬）。

---

## 8. 需要你现在拍板的事

### 8.1 已解决

- ~~新云访问方式~~：已用你给的账密走旧云跳板登录新云并装好公钥（`shein_fm_friend_migration_20260908`），免密 sudo 可用。迁移结束我会撤销这一条临时授权。
- ~~停机窗口~~：你已明确可以停自动任务；据此改成“只停切换窗口 30–60 分钟”，其余阶段并行（见 §0.5）。
- ~~登录网页~~：不用新造，Portal 已有 `/cloud-login/novnc/`；profile 先搬、同事后登录。
- ~~飞牛 VM 规格~~：与全托一致，即 4 vCPU / 8 GiB，数据盘放 /vol2；系统盘另计。

### 8.2 仍需你回答

1. **飞牛管理员能力（唯一硬阻塞）**：`dushengyi` 登录得上但没有免密 sudo，libvirt 走 polkit 要管理员认证，所以我现在无法自己建 VM。二选一：
   - 给我该账号的 sudo/管理员密码（我用 `virsh`/`virt-install` 按规格建 VM 并装系统）；
   - 或者你在飞牛后台点“新建虚拟机”，规格我下面给全，建完把 IP 给我。

   规格：Ubuntu 24.04（cloud image 或 ISO 均可）、4 vCPU、8 GiB、系统盘 60 GB、数据盘 200 GB 放 `/vol2`（与全托同一块盘）、网卡与全托 VM 同网段并**固定 IP**（不要 DHCP，全托 VM 至今还是 DHCP，这是它文档里记下的遗留风险）。

2. ~~**Webhook 端口**~~ **已于 2026-09-15 现场判定，无需决策**：抓包证明平台回调走标准 443（详见 §1.8 与 §2），所以
   - 不需要在腾讯云安全组放行 8443，也不需要在 SHEIN 开放平台改回调 URL，更不需要为此登录 21 个店铺的开放平台后台；
   - 迁移对回调的唯一要求是：切完 DNS 后新云 443 能到达 VM 的 `/api/shein/webhook/v1/events`（复用 Caddy edge + 反向隧道），旧云保留一段兼容转发接住旧 NS 缓存。

3. **21 店登录的执行人**：确认你同事在 A4 阶段能到场登录（profile 一到位我就把登录页给他）。

4. ~~**Metabase**~~ **已核实无需迁移**：旧云没有任何 Metabase 实例在监听（3000/8081 均无进程、无对应 unit、app env 无配置），`shein-metabase-db` 容器只是历史遗留；Portal 侧唯一相关的是 `infra/metabase/.admin.local.json` 登录兜底文件，而该文件在旧云**并不存在**（用户在 `config/bi_users.local.json`）。

5. **兼容期**：旧云 `sa` 兼容转发保留多久（建议至少 7 天，等旧 NS 缓存彻底消退后再删）。

6. **白名单现状确认**：你说“印象中已经建好”。我会在 A2 逐店只读核实；若发现缺失，需要你在场或授权我用各店 profile 添加 `43.165.185.3`（保留旧 IP）。

---

## 9. 建议时间表（已被 §0.5 的一次性执行版取代，保留作对照）

| 日期 | 内容 | 当天结束时应该能回答 |
| --- | --- | --- |
| D0 | 决策 + 开权限（阶段 0） | 决策 1–6 全部有答案；能登录新云与飞牛 |
| D1 | 盘点复核 + 建 VM + 隔离恢复 + 备份异盘（阶段 1–2） | VM 能跑起半托应用，恢复演练通过 |
| D2 | 新云边缘 + 出口 relay + 隧道 + 逐店白名单（阶段 3–4） | 21/21 经新出口认证通过，新入口 HTTPS 通 |
| D3 | 数据追平 + 切换 + 终验（阶段 5–7） | 半托只在飞牛跑，回调/调度/页面都真实跑通 |
| D4 | 观察 + 退役 + 交付（阶段 8） | 旧机只剩共享组件与兼容转发，证据交付 |

---

## 10. 交付物清单

1. 资源映射与写入者清单（阶段 1）。
2. 数据库基线与对账结果（阶段 2、5）。
3. 备份配置 + 一次隔离恢复记录（阶段 2）。
4. 逐店白名单回读 + 出口认证结果（阶段 4）。
5. 真实回调、调度、页面终验证据（阶段 7）。
6. 服务/调度状态回读、残留项清单、回滚步骤与哈希（阶段 8）。
7. 本方案的执行偏差记录（实际做了什么、哪些没做、为什么）。
