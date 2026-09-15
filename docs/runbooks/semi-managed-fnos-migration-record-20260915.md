# 半托迁移飞牛 + 新云边缘：2026-09-15 现场记录

## 结果

半托（`E:\Codex WorkSpace\Shein销售统计`）已从旧云 `43.165.167.135` 整体迁到飞牛 VM `192.168.1.200`（`shein-bi-half`），公网入口与 OpenAPI 固定出口在 `43.165.185.3`。DNS `sa.dushengyi.cc` A 已由用户切到 `43.165.185.3`，旧云保留兼容转发。

冻结前基线（旧云 20:14:54 停写）→ 新库恢复后**逐项一致**：

| 对象 | 冻结基线 | 新库 |
| --- | --- | --- |
| 表 / 索引 | 154 / 244 | 154 / 244 |
| `raw.et_endpoint_row` | 2,100,530 | 2,100,530 |
| `fact.et_box_stock_snapshot` | 625,661 | 625,661 |
| `fact.quality_skc_snapshot` | 302,214 | 302,214 |
| `fact.visible_inventory_snapshot` | 308,899 | 308,899 |
| `fact.link_suggestion` | 161,929 | 161,929 |
| `fact.order_item` / `order_header` | 13,783 / 13,354 | 13,783 / 13,354 |
| `ops.link_ops_event` / `_idempotency` | 43,841 / 43,811 | 43,841 / 43,811 |
| `ops.shein_webhook_receipt` | 28,514 | 28,514 |

生产动作验收：

- 真实回调已落新机：`ops.shein_webhook_receipt` 28,514 → 28,518，nginx 记录希音推送 IP `8.219.56.57` 200。
- 定时任务首次实跑成功：`today-sales-reconcile` 13:00:47 success（含 OpenAPI 调用与飞书通知）、`portal-section-queue` 修复后 success（`[portal-section-worker] section=rankings`）。
- 公网：DNS 解析（8.8.8.8/1.1.1.1/旧云本地）均为 `43.165.185.3`；`/` 302、`/api/health` 401、`/cloud-login-maintenance` 200、webhook POST 401（验签拒），旧云兼容转发同样 302。
- 代码出处：`/opt/shein-bi/app` 为 git 仓库，`describe=2026.09.15.1`、`HEAD=0e0f2bd4cd534572d9e9ad13db090bdec5143296`、工作区无漂移。

## 关键搬迁事实

- 回调端口经抓包确认走**标准 443**（2026-09-15 18:04:21，`8.219.56.57` → 旧云 :443 两个 SYN 与两条 nginx 200 对应；8443 整段 0 包）。因此**无需改希音后台、无需登录 21 个店铺的开放平台**；8443 仅是受限回退。
- 传输链路：旧云→飞牛直连只有约 200 KB/s（港陆线路）；改用**本机中转**（旧云→本机 8 流 ≈10 MB/s，本机→飞牛走局域网）后全量约 6 GB 在半小时内完成，所有文件 sha256 双端一致。
- 按价值裁剪：不搬 `runs/**/plans/source-evidence/**`（3.4 GB，希音 API 原始响应缓存）、`pipeline-markers/evidence/**`（2.5 GB）、`*/source-evidence/**`（6.3 GB）、`/data/shein-bi/outputs` 中 6.5 GB 历史按日归档；搬 `bi-portal` + 近 24h 活跃产物（677 MB）、守卫对账证据（journal/results/state/versions/最近 24 份计划）、代码树 + `.git`、21 店 profile、secrets/config。

## 迁移中修掉的真实问题（均为旧云有、新机缺）

1. **`/data/shein-bi/*` 是软链**：unit 的 `BindPaths/BindReadOnlyPaths` 需要真实目录，且 `provision_bi_session_secret.mjs` 有『父目录必须是真实目录』的硬校验 → 改为真实 bind mount 并写入 fstab。
2. **缺 `/data/shein-bi/outputs`**：补 bind mount（旧云 `/data` 是独立盘，新机数据盘挂 `/srv/shein-bi`）。
3. **`/opt/shein-bi/app/config` 属主被改坏**（误执行 `chown -R root:sheinops`）：重新解包 config 包恢复 `sheinops:sheinops 0600`，否则 webhook 读 `shein_openapi.local.json` 报 EACCES。
4. **`sheinops` 没有免密 sudo**：旧云有 `/etc/sudoers.d/90-sheinops-codex`（门户用 `sudo psql` 生成 BI 分区）→ 原样补齐。
5. **`/run/lock` 协调锁缺失**：`run_host_heavy_job.sh` 要求 `/run/lock/shein-host-heavy.lock` 等已存在且可读写 → 新增 `/etc/tmpfiles.d/shein-bi-scheduler.conf`（旧云由 `shein-fm-scheduler.conf` 兼任）。
6. **pg_restore 不支持 stdin 并行**：改为 `docker cp` 进容器后 `pg_restore -j 4 <文件>`。
7. **IPv6 无出口**：VM 有全局 IPv6 地址但无路由，docker/npm/curl 会先试 IPv6 超时 → 已 `disable_ipv6=1`（`/etc/sysctl.d/99-disable-ipv6.conf`）。
8. **旧云 sshd 并发限制**（`PerSourceMaxStartups 3`）挡住并行搬运 → 临时放开，搬运后已还原（备份 `.pre-migration-20260915`）。

## 未搬 / 待办

- `/data/shein-bi/outputs` 的 6.5 GB 历史按日归档仍在旧云（未删除）。如需冷备可整体复制到飞牛 `/vol3`。
- **备份异盘改造（原待办，当晚已完成）**：见「备份异盘改造（NAS /vol3）完成 2026-09-15 21:30-21:50」——备份落在飞牛 `/vol3/shein-bi-backups`（保留 14 份、`OnSuccess` 同步、真实 dump 已双向校验）。
- 07:10 晨链是迁移后的第一次完整日常链路，仍需跑完检查一次结果。**注意：05:20 发现并修掉了一个会让 21 店全部失败的缺陷**（见文末「第三轮发布与部署」），已发版 `2026.09.16.3` 并部署（库存 generation 108），单店抓取已实跑通过。
- 旧云 `sa` 兼容转发建议保留 ≥7 天（等旧 NS 缓存消退），之后再删旧 Caddy 的 `sa` site 与相关残留。
- 本地中转缓存目录 `E:\migration-transit`（含 `pull.mjs` 工具与已下载数据）可自行删除。

## 回滚

旧云源码、数据、配置、备份均未删除；其 18 个 timer 与服务已 stop + **disable**（禁用不删除，重启也不会复活写入者）。回滚＝在旧云 `systemctl enable --now` 对应 timer/服务，并把 DNS 指回 `43.165.167.135`。

## 重启验证发现的三个持久化问题（2026-09-15 21:20-21:30，已修复并复验）

首次开机自启验证时重启了一次 VM，暴露出 3 个只在重启后才显形的问题——这类问题白天跑一轮是发现不了的：

1. **系统时区是 `Etc/UTC`**（旧云是 `Asia/Shanghai`）。所有固定时刻的定时任务会按 UTC 执行，整体错 8 小时（晨链会变成 15:10 CST）。
   修复：`timedatectl set-timezone Asia/Shanghai`；因 systemd 缓存了旧时区下算出的 next_elapse，需显式 `systemctl restart` 每个 timer（`daemon-reload` 不够）。复验：`list-timers` 全为 CST 且与旧云排班逐条一致（晨链 07:10、昨日终稿 02:45、备份 01:45、营销 11..20:45、看门狗 :50…）。
2. **cloud-init 重置 `/etc/hosts`**（`manage_etc_hosts: True`），把 `openapi.sheincorp.com → 127.0.0.1` 这条隧道入口删掉了。后果：应用的希音调用绕过隧道、从办公室 IP 直连 → 平台报 `IP is not in the whitelist: 14.145.63.180`，商品对账整批失败。
   修复（双重保险）：把两条映射写进 `/etc/cloud/templates/hosts.debian.tmpl`，并新增 `/etc/cloud/cloud.cfg.d/99-shein-bi-hosts.cfg` 的 `bootcmd` 每次开机幂等重写。复验：重启后映射仍在，`curl` 出口为 `127.0.0.1`，商品对账服务 exit=0。
3. **`state/pipeline-markers` 目录属主被 tar 隐式创建成 `root:root 755`**（打包清单只列了日期子目录，没列这一层）。应用要求 `2770`，而 unit 启用了 `RestrictSUIDSGID`，无法自行补 setgid 位 → `PIPELINE_MARKER_DIRECTORY_MODE_FIX_FAILED cause=EPERM`。
   修复：`chown sheinops:sheinops` + `chmod 2770`（与旧云一致），同时把 `state/locks`、`state/cloud_morning_chain` 一并校正为 2770。对照确认：`state/cloud_ops_watchdog`、`state/order_status_recheck_last.json` 的 root 属主旧云本来如此，不是迁移引入。

第二轮重启复验（uptime 2 分钟时检查）：时区 CST、hosts 映射在、sysctl 443 在、marker 目录 2770、6 个 bind 挂载、数据库容器 healthy、四个服务 active、出口 `127.0.0.1`、定时任务 CST 排程、真实回调持续入库（28,514 → 28,524）。

## 开机自启

飞牛 VM `shein-bi-half` 的「开机自动开启」原为**否**，已按用户要求改为**是**（VM 需先关机才能编辑；已在关机状态下修改并确认，随后开机）。

VM 内部的开机自恢复也已逐项验证：fstab 六个 bind 挂载、`/etc/tmpfiles.d/shein-bi-scheduler.conf` 重建 `/run/lock` 协调锁、Docker 容器 `unless-stopped`、门户/查询/webhook/隧道四个 unit `enabled`、18 个 timer `enabled`（另 2 个按旧云保持 masked）。

## 备份异盘改造（NAS /vol3）完成 2026-09-15 21:30-21:50

背景：迁移后备份仍写 `/srv/shein-bi/backups`（与数据同盘，不满足全托定下的最低要求）。按全托 2026-09-05 已跑通的模式实现半托版本。

**组成**

| 部件 | 位置 |
| --- | --- |
| NAS 接收器（forced-command，Python 标准库） | `/home/dushengyi/.local/libexec/shein-bi-backup-receiver.py`，sha256 `4feb7340531d23692bce0953c3a89ee177e780b05c1a65beedc50f479783aa05` |
| NAS 目标目录 | `/vol3/shein-bi-backups`（0700，dushengyi，独立盘，可用 306 G） |
| VM 专用身份 | `/srv/shein-bi/secrets/backup-nas-sync/{id_ed25519,known_hosts}`（私钥只在 VM 内生成，0600） |
| NAS 授权行 | `from="192.168.1.200",restrict,command="…/shein-bi-backup-receiver.py"`（不改动其他行，改前已备份） |
| VM 发送器 | `/opt/shein-bi/maintenance/backup-nas-sync-20260915/sync_shein_bi_backup_nas.mjs`（release 树之外，同全托） |
| 同步服务 | `/etc/systemd/system/shein-bi-backup-sync-nas.service` |
| 触发接线 | `shein-bi-db-backup.service.d/60-nas-sync.conf` → `OnSuccess=shein-bi-backup-sync-nas.service`（已读回） |
| 仓库模板 | `scripts/receive_shein_bi_backup_nas.py`、`scripts/sync_shein_bi_backup_nas.mjs`、`infra/systemd/shein-bi-backup-sync-nas.service`、`infra/systemd/shein-bi-db-backup-nas-sync.conf` |

**协议与安全边界**：发送端以只读 fd 固定源文件（dev/inode/size/mtime/ctime 二次核验）、校验 PGDMP 魔数，并用容器内 `pg_restore --list` 验证归档；接收端只接受一行 JSON 头（version/name/bytes/sha256），无目标路径参数、无 shell；写 0600 临时文件 → fsync → 哈希校验 → 硬链接发布（同名不同哈希一律拒绝）→ 清理临时文件。SSH 侧 `-F /dev/null`、BatchMode、IdentitiesOnly、独立 known_hosts 严格校验。

**保留与容量**：接收端内置有界保留 `KEEP_COPIES=14`（只匹配自己命名空间 `shein-bi-YYYYMMDD-HHMMSS.dump` 的普通文件，绝不触碰锁文件、临时文件、符号链接或其他命名；本次刚收到的那份永不删除）。加上本地 7 天保留，NAS 稳态约 15 份 × 1.1 G ≈ 16 G，远低于 306 G 可用。单文件上限 100 GiB。

**已验证证据（2026-09-15）**

1. 合成数据自测：首发 copied、重发 already_present、坏哈希 HASH_MISMATCH 拒绝、落盘 0600、无残留。
2. 真实归档 #1：`20260915-213622/shein_bi.dump`（1,105,243,651 B）→ NAS `shein-bi-20260915-213622.dump`，NAS 独立回读大小与 sha256 一致、mode 0600；重跑返回 already_present、不覆盖。
3. 真实归档 #2 走 systemd 服务（含沙箱）：state=copied、name=shein-bi-20260915-214023.dump、archiveVerified=true，28 秒完成，Deactivated successfully。
4. 保留策略测试：连送 15 份合成旧归档 → 只保留最新 14 份（本轮新收的那份不受影响），两份真实备份未被触碰，随后合成文件全部清理。

**尚未自动验收的一环**：OnSuccess 由「备份服务成功」触发，而手动跑备份会被 `--deadline-at 02:37` 判为已过截止线而暂缓（exit 75，属设计内行为）。因此「真实备份成功 → 自动触发同步 → NAS 回执」这条完整链路要等今晚 01:45/02:05/02:25 的备份定时器实际跑一次才会经过。届时检查：

```bash
sudo systemctl status shein-bi-backup-sync-nas.service --no-pager | tail -5
sudo cat /srv/shein-bi/runtime/backup-nas-sync/latest.json
ls -l /vol3/shein-bi-backups/
```

**待办（建议走发版流程）**：最近成功时间检查与失败告警目前只有 systemd 失败状态与 `runtime/backup-nas-sync/latest.json`，watchdog 尚未纳入（`cloud_ops_watchdog.mjs` 现在没有任何备份检查）。建议在已有 watchdog 排班里增加 NAS 同步新鲜度检查，复用既有告警通道，不新增 timer。

## 店铺自动化路径验证与又一个缺项（2026-09-15 21:50-22:00）

用迁移过去的浏览器 profile 做了一次真实无头探针（`node scripts/launch_store_browser.mjs DL --headless`）：

- 结果：`debugPort.ok=true`（pageCount 5）、`profileDir=/opt/shein-bi/app/profiles/persistent-dl-profile`（数据盘 bind ✓）、店铺身份 `DL - 地利 - GS5337922`、`onDeviceAiDisabled=true`（项目要求的禁用本机大模型标记生效 ✓）、目标 URL 为店铺订单管理页。
- 探针结束按项目规矩关闭任务自有浏览器：`cleanup_shein_store_browsers.mjs` → `profileSingletons removed=3 errors=0`，Chrome 进程归零。

**探针暴露的缺项**：`/opt/shein-bi/app/logs` 不存在 → 启动器 `mkdir` 报 EACCES，店铺浏览器任务会直接失败。已按旧云补齐 `sheinops:sheinops 775`（旧云该目录同样是 0775 且含 link-ops 等子目录）。

随后做了 `/opt/shein-bi/app` 顶层目录逐项对比：新机 30 项 vs 旧云 33 项，差异只有 ①一个名为 `"` 的垃圾文件、②`tmpcloud-marketing-local-runtime-20260816-…`（8 月陈旧临时目录，按项目卫生规则本就该清）、③`backups/`（内含历史 release 备份）。三者都无功能影响，无遗漏的运行目录。

顺带确认：`manual-login-recovery` 21:47 成功（队列为空，未起浏览器）、`openapi-stock-refresh` 21:49 exit=0（21 店商品对账经隧道走新云出口）、`browser-cleanup` 21:20 因刚重启后 `BOOT_SETTLING`+`IO_STALL_PRESSURE` 正常延迟到 03:20。

## 服务用户家目录遗漏项（2026-09-15 21:52-21:56，已补齐并验证）

打包清单覆盖了 `/srv/shein-bi/*`、`/opt/shein-bi/app` 与 `/data/shein-bi/*`，但**没有覆盖 `sheinops` 的家目录**，因此这些运行依赖当时并未随迁移过去：

| 遗漏项 | 后果 | 处理 |
| --- | --- | --- |
| `/opt/shein-bi/app/logs`（gitignore 目录） | 店铺浏览器启动器 `mkdir` 报 EACCES，浏览器类任务直接失败 | 按旧云补 `sheinops:sheinops 775` |
| `/home/sheinops/.ssh/shein_bi_deploy`（**实际在用**的 GitHub 部署密钥，指纹 `SHA256:Wjwphs7nms7kbuyIxXzlgv9jIEf8GV8a1g3p0e8kk5Q`） | 新主机无法 fetch/push；`secrets/github_deploy_key` 是另一把（`SHA256:x6wKr+p4…`），GitHub 不认 | 从旧云复制该私钥与 known_hosts，0600 sheinops |
| `/home/sheinops/.gitconfig`（含 `safe.directory=/opt/shein-bi/app`、`core.hookspath`） | git 对 root 属主的仓库报 `dubious ownership`，任何 git 操作失败 | 复制 .gitconfig 与 `.codex/git-hooks` |
| `/home/sheinops/.lark-cli`、`.local`、`.config` | 飞书相关任务缺少 CLI 状态 | 一并复制（合计约 6 MB；`.cache` 831 MB 未搬） |

验证：`git ls-remote --heads origin` 返回分支列表（与旧云一致）、`git fetch --dry-run origin main` 成功、标签可达 → **新主机具备发布/拉取能力**（push 仍按项目规矩走开发机 + PR）。

教训：迁移清单应显式包含「服务用户家目录 + gitignore 运行目录」两类，本次是逐个探针（浏览器启动、git、备份）才暴露的。

## 发布来源审计（fail-closed）红转绿：数据盘绑定目录必须带仓库跟踪文件（2026-09-15 22:00-22:05）

watchdog 21:50 报 `云端源码不一致：commitMatch=true dirty=246 missing=246`。排查链：

1. 宿主机上 `git status --porcelain` 是**干净的**（0 项），说明不是普通工作区漂移。
2. 差异来自 **unit 沙箱**：watchdog/backup 等 unit 都有 `BindPaths=/data/shein-bi/outputs:/opt/shein-bi/app/outputs`，即在服务命名空间里 `outputs` 被替换成**数据盘那份**。旧云的 `/data/shein-bi/outputs` 里除了活跃产物，还包含 **247 个被仓库跟踪的历史文件**（`outputs/cleanup/…`、`outputs/cloud-migration/…`、`outputs/product-image-suite/…` 等）。迁移时我按「历史归档无价值」把数据盘 outputs 裁成近 24 小时活跃子集，**把这 247 个仓库跟踪文件一起裁掉了** → 沙箱里看就是 246 个已跟踪文件被删除，触发 `check_release_source_state.mjs` 的 fail-closed 判定。

**修复**：`git archive HEAD -- outputs | tar x -C /srv/shein-bi`（用发布 tag 的内容补齐，权威一致），随后 `chown -R sheinops:sheinops`。

**验证**：在与 unit 等价的 systemd 沙箱（同样三条 BindPaths）里运行真正的检查脚本，结果 `ok: true`、`dirtyEntries: []`、`hiddenIndexEntries: []`、`missingTrackedFiles: []`、`trackedFileCount: 1447`。

**教训（写入迁移清单）**：凡是 unit 用 `BindPaths` 把数据盘目录绑到应用路径的（`outputs`、`state`、`profiles`），迁移后该数据盘目录**必须包含仓库跟踪的全部文件**（`git ls-files <dir>`），否则沙箱内的工作区看起来缺文件，会触发 fail-closed 的源码审计。`state`/`profiles` 经查跟踪文件数为 0，无此问题。

另：watchdog 当时还报了两条与我手动操作/切换窗口直接相关的项——`shein-bi-db-backup.service failed exit=75`（我按 unit 同一环境手动跑备份，21:36 已过 `--deadline-at 02:37`，属设计内暂缓；已 `systemctl reset-failed` 清除）与 `营销修复队列未闭环 rows=354`（切换冻结使 20:45 那次 marketing-repair 未执行，队列会等到次日 11:45 窗口处理；旧云 19:50 的 watchdog 无此告警，故非迁移缺陷而是切换窗口的直接后果）。`订单闭环待复查` 是旧云同样存在的既有业务项。

## 日更前提排查：按店按日证据文件的 24 小时窗口代价（2026-09-15 22:00-22:15）

晨链会读按店按日的续跑证据 `outputs/<domain>/<store>/<businessDate>.json`（`lib/morning_resume_evidence.mjs`，DOMAINS = shein_links / shein_business_domains），并校验 `payload.ok===true`、`date`、`store` 三者一致，不一致即 fail-closed。

**发现**：我按「近 24 小时」裁 outputs 时，`shein_business_domains` 的 **LG、HY 两家 09-14 文件是 09-14 16:58 写的**（早于窗口）被裁掉 → 该日 business_domains 只有 19/21 ✗。

先确认这**不是**「今天的数据没产出」：旧云的 `2026-09-15.json` 同样为 0 个（晨链的 businessDate 就是 09-14，09-15 的文件明天才会写），故只是窗口裁剪问题。

**修复**：直取 LG、HY 的 09-14 两个文件（286 KB / 320 KB）补入 `/srv/shein-bi/outputs/shein_business_domains/`（曾试打包近 7 天 723 MB 走中转，但当时链路只有约 100 KB/s，遂改为按需取 2 个文件）。

**验证**：① 计数 21/21（两个域）；② 用应用自己的构建器在等价沙箱里跑 `buildMorningResumeEvidence({root:'/opt/shein-bi/app', date:'2026-09-14'})` → `ok: true`、`storeCount: 21`。

同批排查的其它前提：`outputs/et-forwarder/latest-manifest.json` ✓、当日 `outputs/reports/marketing-daily-guard-*.{json,md}` ✓、`state/openapi-probes/*.latest.json` ✓、`outputs/order_status_recheck/` ✓、`state/order_status_recheck_last.json` ✓、`runtime/{host-scheduler,et-low-inventory-guard,daily-inventory-replenishment,openapi-product-cache,cloud_manual_login_recovery,bi_link_ops_assets}` ✓、营销折扣人工覆盖注册表 ✓。

两个看似缺失但**良性**的项：`runtime/et-low-inventory-guard.json`（旧云也没有、代码不引用）、`outputs/et-storage-fee/`（`cloud_et_storage_fee_sync.sh` 自己 `mkdir -p` 后读自己刚写的 manifest，不对历史数据有依赖）。

结论：按店按日的证据类文件才受 24 小时窗口影响，而运行只读**业务日期当天**，补齐当天即可；其余「最近一次」指针类输入都是近期写入，未受窗口影响。

## 打包目录之外的缺口：控制面 / 运行时权威证据 / ET 运行时（2026-09-15 22:15-22:40）

做了一次系统性的「源与目标对照 + 逐任务前提核查」，又发现 5 处真实缺口，全部修复并验证：

1. **systemd 控制面零漂移（对照确认，非缺陷）**：把旧云与新机 `/etc/systemd/system` 下 151 个 shein-bi unit/drop-in 逐文件哈希对比 → **VM 缺失 0 个、共有文件内容差异 0 个**，新机多出的恰好是 `shein-bi-backup-sync-nas.service`、`shein-bi-db-backup.service.d/60-nas-sync.conf`（本次新增）与 `shein-bi-edge-tunnel.service`（迁移引入）。
2. **`/etc/shein-bi/partner-cli-release.env` 缺失**（105 B，root:root 0600）：portal 的 `75-partner-cli-release.conf` 以可选方式引用它，内含 partner CLI 发布用的 GitHub token。已按旧云字节一致补入。**注意**：排查时我把该文件内容打印到了会话输出里（我的失误），如需可将该 token 视作已暴露处理；后续同类凭据一律只比对哈希、不打印内容。
3. **`/var/lib/shein-bi-control/` 整个缺失** ✗ —— 这是控制面，不只是维护模式标记：`cloud-maintenance.json`（活标记，generation 363）与 **`inventory-writer-compatibility/`（库存写入兼容守卫的激活/兼容记录）**。缺它的后果是库存写入 fail-closed。已补 `cloud-maintenance.json` + `inventory-writer-compatibility/`（`root:sheinops 2750`，26 项，15 MB）；其余 38 个条目里的 `deployments/`(205 M) 与 `v7-*`(各 35 M) 经查代码零引用，属归档不搬。验证：`manage_cloud_maintenance_mode.mjs status` → `ok:true, active:false, generation:363`。
4. **发布权威证据链缺失** ✗：`/srv/shein-bi/runtime/deployed_release.json`（formal 部署凭据 v3）与 `release-attestations/2026.09.15.1/release-attestation.json`（CI provenance）都没随迁移过去（前者因 runtime2 包的通配在错误 cwd 展开、错误又被 `2>/dev/null` 吞掉）。补齐后守卫断言从 `INVENTORY_WRITER_RELEASE_RECEIPT_INVALID` → `INVENTORY_WRITER_AUTHORITY_INVALID` → **`[OK] 与 inventory compatibility authority 已对齐（generation 105, commit 0e0f2bd4…）`** ✓。
5. **ET 运行时未安装（真实生产故障）** ✗✗：22:20 的 `et-low-inventory-recheck` 实际失败并报 `ET runtime is not installed; run ensure_et_forwarder_runtime.sh --install during deployment`。旧云装有 `python3-pip`/`python3-venv`，新机没有，且 `runtime/et-forwarder/` 下只有空脚手架。处理：装 pip/venv → 跑项目自己的 `ensure_et_forwarder_runtime.sh --install`（按 `requirements-et-forwarder.lock` 下载哈希锁定的 wheel）→ `current` 指向 `venvs/60da40cbccfa9b04a4a6e429decf819ce19503a00c42a9876247777ec63f7337`，**与该锁的 sha256 完全一致、与旧云同名**，`--verify` 通过，`import ddddocr` 成功。ET HTTP 登录态（`et-forwarder/session/…local.json`，582 B，root:sheinops 600）同时补入。

同批补入的小件：portal 状态文件 `bi_action_state.json` / `bi_link_ops_tasks.json`(3.3 M) / `bi_link_ops_chats.json`，以及 `/srv/shein-bi/{marketing-repair-immediate,audit,uploads,data}`（营销即时授权的邮箱目录，README 要求 root 预建、服务不自建）。

**未搬（已判定为归档，非必需）**：`runtime/source-release-bundles`(244 M)、`source-release-candidates`(236 M)（源码包，仅重跑激活流程才需要）、`runtime/automation-delivery`(63 M，通知投递去重状态；本次链路太差未取，待补)、`release-attestations` 中历史 tag。

## 时钟跳变的第二个后果：当晚数据库备份会被整夜跳过（2026-09-15 23:20 修复）

开机瞬间 `rtc_cmos` 被当 UTC 读，内核先把系统时间设成 `2026-09-16T07:09`，systemd 的 `Persistent=true` 计时器据此把「上次触发」记成了 9/16 07:09。

后果不只是那两个 `deadline_elapsed` 失败：`shein-bi-db-backup.timer` 的三次机会是 `01:45 / 02:05 / 02:25`，而 `LastTriggerUSec=2026-09-16 07:09:10` 已经晚于这三个点，`NextElapseUSecRealtime` 被推到 **9/17 01:45** —— 等于 9/16 整晚不备份，NAS 的 `OnSuccess` 同步也一并不会触发。其它 timer 要么频率更密，要么下一次合法时点仍在当天，所以没被跳掉。

取证与修复：

- `systemctl show shein-bi-db-backup.timer -p LastTriggerUSec -p NextElapseUSecRealtime` → `2026-09-16 07:09:10` / `2026-09-17 01:45:00`；
- `ls -l /var/lib/systemd/timers/stamp-shein-bi-db-backup.timer` → mtime `2026-09-16 07:09:10`，stamp 就是错误「上次触发」的来源；
- 修复：把 stamp 的 mtime 改回最后一次真实备份时间（9/15 21:43，即 `backups/auto/20260915-214023/` 的落盘时间），再 `systemctl restart shein-bi-db-backup.timer`；
- 读回：`LastTriggerUSec=2026-09-15 21:43:00`、`NextElapseUSecRealtime=2026-09-16 01:45:00` ✓，并且重启 timer 没有触发追赶运行。

教训：这台机器上 `set-local-rtc 1` 是必须的，但时钟纠正完成后要单独检查 `Persistent=true` 计时器的 `LastTriggerUSec`，它可能停在「错误的未来」，从而静默吃掉当天剩下的全部时点。

## 迁移后第 2 批发现：库存写入守卫被两处缺口挡住（2026-09-16 凌晨，已修）

`systemctl --failed` 在 00:20 冒出 `shein-bi-et-low-inventory-recheck.service failed`，顺着查出一条真链路：**三个库存写入服务的 `ExecStartPre` 全部 `203/EXEC`，库存写入等于被 fail-closed 挡住**。两个缺口：

1. **外部 guard 二进制没搬**：`/usr/local/libexec/shein-bi-inventory-writer-compatibility-guard` 在 VM 上不存在（迁移只搬了 `10-inventory-writer-compatibility.conf` drop-in）。用仓库安装器修复：先 audit 得 `manifest=7c02752d…`，再 `--replace --expected-installed-manifest-sha256 7c02752d… --confirm REPLACE_INVENTORY_WRITER_COMPATIBILITY_GUARD_V1` → 返回 `{"ok":true,"mode":"replace","serviceCount":3}`；装出的二进制 sha256 `1a977a8a9fe8f5c0a2fb5b0f9623c42a440d33e3d3b3dd390a58b28856099306` 与旧云字节一致。
2. **权限漂移**：`/opt/shein-bi/app` 是 `dushengyi:dushengyi 0755`（旧云 `root:sheinops 0750`），tracked 树 **1220 个**路径 group-writable（迁移解包 umask 002）。按旧云逐项对齐后：app 根 `root:sheinops 0750`；`app/tmp`、`app/node_modules`、`app/outputs` → `root:sheinops 1770`（sticky）；tracked 清单逐条 `chown root:sheinops` + `chmod g-w,o-w`，父目录同样处理；数据侧 `/srv/shein-bi/outputs` 保持 `sheinops:sheinops 0775`（与旧云数据侧一致）。

读回：三个服务单独跑 guard 全部 `rc=0`（返回 `{"ok":true,"activated":true,"state":"activated_exact","activeGeneration":105}`）；`systemctl --failed` 只剩 watchdog（它 exit 1 是因为有两条真实业务告警：营销修复队列 rows=354、订单闭环待复查，都是既有或切换窗口产物，不是技术故障）。

同批还发现：**加固器 `harden_inventory_writer_checkout_permissions.py` 在新机拒绝启动**（`completed generation runtime mount identity drift`：新机的 runtime bind mount 与 8/27 那代 completion 记录不一致）。这不影响 guard 通过（guard 只看权限），但**下次正式部署走到权限交接那一步时会遇到**，需要按新代际重新生成 plan/receipt/completion。

### 已发布的版本与部署状态

- PR #169 已合并（`b19ddc1`），main-push CI 全绿；源码版本 **`2026.09.16.1`** 已通过 `source-release.yml` 发布：annotated tag `2026.09.16.1` → `b19ddc1`，Release 非 draft 且 `immutable=true`，两份资产（`release-attestation.json` + `.sha256`）下载后校验一致，attestation 绑定 `commit=b19ddc1…`、CI run `34994917632`（main push）、trust policy `590280…`。
- **云端部署**：2026-09-16 01:12 CST 在维护窗口内完成（库存 generation 106，详见下节），窗口占用约 9 分钟；01:45 那次备份机会未受影响。

### 部署已完成（2026-09-16 01:12 CST，库存 generation 106）

- 维护窗口：`pause --mode all`（generation 364）→ 01:11:40 `resume`（generation 365），全程约 9 分钟；01:45 那次备份机会未受影响。
- 交接与检出：按 `source-permissions-fnos20260916.plan.json` 的 2511 条 managedSource 路径临时 chown 给 sheinops（不递归整个 app），`git fetch --tags` 拿到 `2026.09.16.1`，然后 `git reset --hard b19ddc1…`（clean，1464 个 tracked 文件）。
- bundle：`/srv/shein-bi/runtime/source-release-bundles/2026.09.16.1.bundle`，sha256 `b9e69dd4bdac6343601ec4d8e5f41c03e30863ffec97f90637fcc142698bb8b5`。
- 新代际加固：audit → apply（generation `deploy2-2026.09.16.1`），`issues: []`；app 根 `root:sheinops 0750`、managed 运行态根 `1770` sticky、tracked 清单非组可写。
- 部署标记：`check_release_source_state.mjs --expected-commit 2026.09.16.1 --record-deployment 2026.09.16.1 --source-bundle … --expected-source-bundle-sha256 …` → `deploymentMarker{schemaVersion: v3, commit: b19ddc1…, tagObject: 54cfb7a1…, releaseId: 389308354, ciRunId: 34994917632, runAttempt: 1, warnings: 0}`。
- 库存轮转：stage（预检 `050b1691…`、工件 sha `61f709d9…`）→ finalize（预检 `8c031a63…`、工件 sha `6798819d…`）→ generation **106**；`assert_inventory_writer_release_aligned.mjs` 返回 `aligned: true`，三个库存守卫 `rc=0`。
- 主机侧：维护守卫重装（30 服务，installed 1 / unchanged 29）、运行时路径策略（30，installed 2 / unchanged 28）、tmpfiles 升到 4 条 lane、morning-chain drop-in 设 `SHEIN_BROWSER_READ_SLOTS=4` + `SHEIN_LINK_BUSINESS_BROWSER_CONCURRENCY=4`（已读回）。
- 验收：`check_release_source_state.mjs --expected-commit 2026.09.16.1` → ok（head `b19ddc1`、clean、fingerprint `520c3c1c…`）；重启 Portal 后 loopback 200、局域网 302（登录跳转）、Query PID 未变（932→932）；`systemctl --failed` 只剩 watchdog 的业务告警。

**新增运维前提：部署需要 GitHub token。** `--record-deployment` 必须在线校验 GitHub release，而 VM 上两个现成 token（`/etc/shein-bi/partner-cli-release.env`、`/srv/shein-bi/secrets/portal-warehouse.env`）实测都是 **401**。本次用本机已认证的 `gh auth token` 通过 stdin 管道传入（不落盘、不打印内容）。建议后续在 VM 上落一个只读（`contents:read` + `actions:read`）的专用 token，例如 `/srv/shein-bi/secrets/release-verify.env`（0600 root），否则每次部署都会卡在这一步。

### 剩余语义约束复核（2026-09-16）

按「能放开就放开」逐条核了一遍，结论是纯容量类已经在这次放开，剩下的是刻意窗口、没有值得动的：

- 库存刷新第二轮的「让位全托首页车道」**只写在 README，代码里没有实现**（`git grep` 只命中文档），所以无需放开；实测 `:18` 与 `:48` 两轮都在跑。
- `et-low-inventory-recheck.timer` 的 `00,02,05,06,08,09,11,12,15,16,18,19,22:20` 是显式避让夜间备份、昨日定稿、晨链和营销窗口的清单，属语义排班。
- 夜间 `00:45 / 01:45–02:37 / 02:45–03:27` 三段共享 `nightly-maintenance.lock`：备份与昨日定稿都要压库，重叠没有收益（那段本来就是空闲时段）。
- `SHEIN_ET_WAIT_SERVICES`（ET 等 today/yesterday/session-manager/db-backup）与 portal-section-queue 拒绝 `01:*`：同一不可逆资源或必须先后读。
- 死配置：`config/cloud_marketing_busy_services.json` 没有任何代码引用（测试还断言守卫里不许出现 busy 逻辑），建议下个版本删掉或标注为历史文档。
- 待测：07:10 晨链在 4 lane + 放宽阈值 + OpenAPI/营销并发 6 下的实际耗时，用它的数据再决定要不要继续放开并发。

### 迁移后第 3 批：告警投递链路缺失（2026-09-16 约 02:00，已修）

`systemctl --failed` 里 watchdog 长期 failed，拆开看它的 `notified: false / notifyCode: 1` —— 这不是业务告警本身，而是**告警投递失败**：VM 上没有 `lark-cli`。

- 老云：`/usr/bin/lark-cli` → `/usr/lib/node_modules/@larksuite/cli/scripts/run.js`（v1.0.80），另有 `/root/.lark-cli/config.json`（241 B、0600 root）。VM 两样都缺（dpkg 对比看不到，因为它是全局 npm 包）。
- 修复：`sudo npm install -g @larksuite/cli@1.0.80`（29 秒，装完 `/usr/bin/lark-cli` 自动就位，`lark-cli --version` = 1.0.80），并把老云的 `config.json` 通过管道搬过去（241 B 一致，全程不打印内容）。
- 验证（不真发消息）：按脚本自身的解析逻辑取投递目标 → masked `chat:oc_fb…b180`、identity `bot`、app `cli_aa8d61df6f381bc6`；执行 `lark-cli im +messages-send … --dry-run` → **rc=0**、`dry_run: true`、请求体指向 `/open-apis/im/v1/messages`。真实投递交给下一次定时 watchdog 自然验证。
- 同类清单对比结论：dpkg 上 VM 比老云少 261 个包，但几乎全是老云历史包袱（guestfs/autotools/gstreamer/旧反代 caddy+haproxy/微码等），对半托运行无影响；全局 npm 现在四处一致（`@larksuite/cli`、`@openai/codex`、`corepack`、`npm`）；`/usr/local/libexec/` 有两件（时钟自愈脚本 + 库存写入 guard）。

### 告警投递链路：三层依赖，靠「临时 HOME 探针」定位（2026-09-16 约 03:00 修好）

把 watchdog 的 `notifyCode: 1` 拆到底，发现飞书投递缺的是**三层**里的第三层，而前两层只是必要条件：

1. `@larksuite/cli` 全局包（`/usr/bin/lark-cli`）——VM 缺失，已装（顺带升到 CLI 自己提示的 1.0.95；老云仍是 1.0.80）。
2. `/root/.lark-cli/config.json`——VM 缺失，已按老云管道搬入（sha256 `d40d8612…` 字节一致）。装上这两层后**仍然失败**（`invalid_client / code 20140`）。
3. **`/root/.local/share/lark-cli/`——真正的密钥库**（`appsecret_cli_aa8d61df6f381bc6.enc` 60 B + `master.key` 32 B，0600 root）。这一层缺失才是根因，已同样搬入。

定位方法（值得复用）：老云的 CLI 用 `HOME=/root` 成功、把**整个** `~/.lark-cli` 复制到临时 HOME 却失败 → 说明生效凭据在 HOME 的 `.lark-cli` 之外；随后在 `/root/.local/share/` 下找到 `lark-cli/` 密钥库。修复后只读探针 `lark-cli api GET /open-apis/im/v1/chats` 返回 `ok:true`。

投递验收：用 `notify_sync_issue.mjs` 按 watchdog 的原参数（`--kind cloud-watchdog --mode watchdog --force --idempotency-key sync-watchdog-alert-batch-6995f04d48c413ff9bc7`）把那条卡了 5 次（22:50/23:50/00:50/01:50/02:50）的订单闭环告警真实投递出去：Feishu 返回 `message_id=om_x100b65ad171dc0a0c4a024d386003ac`（2026-09-16 02:59:41）；随后用 `lib/cloud_watchdog_alert_state.mjs` 的 `markWatchdogDispatchSent` + `markWatchdogOutboxSent` 把 dispatch/outbox 标为 `sent`，避免下一轮重复发送。`systemctl --failed` 已清空。

### 家目录隐藏状态对照（2026-09-16 约 03:20，已补齐）

用「路径集合对照」（只比路径、不比大小，过滤备份/缓存噪声）把 root 与 sheinops 的家目录过了一遍，补上运行真正需要的四项：`/root/.gitconfig`（`safe.directory`）、`/root/.npmrc`（registry）、`/home/sheinops/.agents/`（Codex 插件市场 16 K）、`/home/sheinops/.codex/{agent-packs,agents}`（2.8 M + 876 K；`enabled-agent-packs.txt` 启用了 engineering/design/testing，此前是「启用但没装」）。加上先前的 `/root/.local/share/lark-cli/` 密钥库，家目录侧的运行态缺口已闭环。其余差异（各类 agent CLI 的 skills 目录、`.bun`、`.docker/buildx`、历史 `.bak`/`.tgz`）与本项目运行无关，判定为可不搬。




- 注意：仓库里记录的代码改动（浏览器 lane 数可配置、默认仍是 2）在部署前**不改变现网行为**；主机侧的 tmpfiles、压力阈值、时钟自愈、CJK 字体、局域网监听都已经在 VM 上生效。

### 部署执行清单（供 03:30–06:50 窗口内逐条执行）

前置：窗口要避开 `00:45` 登录态维护、`01:45/02:05/02:25` 备份、`02:45/03:05/03:20` 昨日定稿；执行前 `systemctl list-jobs` 确认没有正在跑的重任务。

1. 在 VM 上下载并校验证明资产到 `/srv/shein-bi/runtime/release-attestations/2026.09.16.1/`（`gh release download --pattern 'release-attestation.json*'`），下载后 sha256 必须与 `.sha256` 一致。
2. 以 `sheinops` 取 tag 并固化 bundle：`git fetch --tags origin` → `git bundle create <file> 2026.09.16.1` → 记录 bundle 的 sha256（后续 `--record-deployment` 要成对传入）。
3. 进维护：`node scripts/manage_cloud_maintenance_mode.mjs pause --mode all --reason "deploy 2026.09.16.1" --requested-by codex --expected-generation <g> --expected-hash <h>`（`--mode all` 是轮转的硬要求）。
4. 权限交接：只把当前代 plan 里的 managedSource **目录行** 临时 chown 给 `sheinops`，不要递归 chown 整个 app。
   ⚠️ 加固器在新机必须走新代际路径：`--receipt` / `--plan-file` / `--completion-attestation` 都指向新文件名并带 `--generation-id`，才会进 `audit_new_generation` 分支；用默认路径会拿 8/27 的 completion 做 mount 校验，并因新机 bind mount 不同而拒绝（`completed generation runtime mount identity drift`）。
5. 以 `sheinops` 检出 attested commit（禁止 `sudo git`，禁止逐文件 scp 长期维持生产）。
6. 检出后**重新生成**该代际的 plan 并 `--apply`（新 generation-id），产出新的 receipt + completion。
7. `rotation-stage`：先 dry-run 出不可变预检工件，再用 `--preflight-artifact` + 文件 sha + preflightHash + `--confirm STAGE_INVENTORY_COMPATIBILITY_ROTATION_V1` 执行。
8. `node scripts/check_release_source_state.mjs --expected-commit 2026.09.16.1 --record-deployment 2026.09.16.1 --source-bundle <file> --expected-source-bundle-sha256 <sha>`。
9. `rotation-finalize`：同样 dry-run → `--confirm FINALIZE_INVENTORY_COMPATIBILITY_ROTATION_V1` 执行。
10. `node scripts/inventory/assert_inventory_writer_release_aligned.mjs --cwd /opt/shein-bi/app --expected-commit <exact commit> --json` 必须 exit 0，否则不得退出维护。
11. 安装/更新 systemd 单元与 drop-in（按 `infra/systemd/README.md` 的「fnOS VM 主机加固」一节），`daemon-reload`，重启 Portal/Query/Webhook。
12. 放开浏览器 lane：按 `infra/tmpfiles.d/shein-bi-scheduler.conf` 建出 4 个 lane 锁，并把 `SHEIN_BROWSER_READ_SLOTS=4`、`SHEIN_LINK_BUSINESS_BROWSER_CONCURRENCY=4` 写进 morning-chain 的 drop-in；随后做一次真实并发实测（4 个作业各占一条 lane，第 5 个应以 `browser_slots_exhausted` defer）。
13. 退出维护，观察下一次定时任务与 watchdog，确认没有 `Persistent` catch-up 意外拉起。

### 第二轮发布与部署（2026-09-16 04:19–04:21 CST，库存 generation 107）

- **修掉今天销售对账的间歇超时**（`curl: (28)`）：`cloud_today_sales_reconcile.sh` 里那句 `liveSalesToday?refresh=1` 从 `--max-time 60` 单次改为 **180 秒 + 失败后 15 秒重试一次**，两次都失败仍让本班失败（保留真实故障信号）。PR #174 合并（`0e0c916`），CI 全绿。
- 三层验证：契约测试 `test_cloud_primary_sales_finalize_contract` 通过（含新增两条断言）→ 目标机 `bash -n` = `BASH_SYNTAX_OK` → 隔离行为测试：坏端口时「警告 + 等 15 秒 + 第二次失败即终止」（15s、退出码 7，未走到成功分支），真实 Portal 时「一次成功、不等待」（1s、退出码 0）。
- 发版：源码 **`2026.09.16.2`**（annotated tag → `0e0c916`，Release `immutable=true`）。第一次 dispatch 在创建 draft 这步失败，但 tag 已精确推上；按工作流自带的「tag-only 恢复」用同一版本重跑即成功 —— 这条恢复路径值得记住。
- 部署：维护窗口 `pause --mode all`（generation 366）→ 冻结清单交接（2641 条）→ `git reset --hard 0e0c916` → 新代际加固（`deploy3-2026.09.16.2`，0 issues）→ 写部署标记（`releaseId 389449846`、`ciRunId 35017796515`）→ 轮转 stage+finalize → 库存 generation **107**、`assert_inventory_writer_release_aligned` = `aligned: true`、三个库存守卫 `rc=0` → `resume`（generation 367）。全程约 2.5 分钟，`--failed` 为 0。
- 部署后读回：源码态 exact/clean（`head=0e0c9166`）、线上脚本含修复、**04:30 那班 reconcile 实跑成功并写入 marker**（无 `timed out`）。

### 每 lane 内存实测与整夜总检（2026-09-16 03:55–04:55）

- **4 lane 内存实测**（并发拉起 DL/DX/FY/HL 四个真实 profile 的无头浏览器）：可用内存 6943 → 4713 MB，即 4 条 lane 实际约 **2.2 GB（≈550–600 MB/店）**；`ps` 按进程求和 6.2 GB 是共享页重复计算的虚高值。按项目受控路径逐个关闭（`profileSingletons removed=3 errors=0`），0 chrome 进程 / 0 调试端口，内存回到 7005 MB，21 个会话文件与 22 个持久 profile 完好。结论：4 lane 在 8 GiB 上余量充足，离守卫 1 GiB 下限很远。
- **整夜总检全绿**：登录态维护 00:45 ✔、数据库备份 01:45 跑 / 01:49 落盘（02:25 幂等跳过）✔、昨日定稿 03:20 ✔、ET 前向器 01:15 ✔、ET 低库存复检 02:20 ✔、当日销售对账 04:30 ✔（含新修复）、库存刷新 04:18 ✔、磁盘维护 00:10 ✔、浏览器清理 03:20 ✔、Portal 段队列 04:32 ✔、手动登录恢复 03:47（约定内的 75 = 队列为空）、watchdog 03:50 ✔（`releaseAuditReady=true`、维护守卫 `policyCount=30 / unchanged=30`）；夜间 marker 齐备，`systemctl --failed` = 0。
- RTV 全量验证 04:50 起跑正常（维护条件放行、资源闸门 READY、拿到 host-heavy 锁并以 materializer 类运行、`stage=rtv-verify businessDate=2026-09-15`，硬窗口 05:27）。

### 第三轮发布与部署：07:10 晨链会全店失败的根因（2026-09-16 05:20–05:37 CST，库存 generation 108）

**真缺陷（旧云就存在的隐藏依赖，不是迁移造成的）**。用晨链完全相同的路径跑 DL 单店抓取复现：`current_profile_probe skipped_fast_start` → `direct_relogin failed`（`EACCES: permission denied, open '/opt/shein-bi/app/outputs/reports/auto-relogin-*.json'`）→ `bootstrap_fallback ok` → `fallback_relogin failed` → 整店 `ok:false`。按这个路径，07:10 晨链会让 21 个店全部失败。

- 根因：`scripts/auto_relogin_shein_store.mjs` 把会话恢复的审计报告写到 **app 侧** `outputs/reports/`，而生产上那里是 `750 root:sheinops`（库存守卫要求 tracked 父目录不可组写），**且这次写入没有 try/catch**，异常直接让 relogin 退出 1；而每店抓取走 `--fast-start`（跳过探针、必经 relogin）。
- ACL 这条路走不通：`setfacl -m g:sheinops:rwx` 会把有效 mode 变成 770，守卫立刻报 `mutable tracked parent:outputs/reports`；已 `setfacl -b` 撤销，守卫恢复 `activated_exact`。
- 修法：报告改写到 canonical outputs 根（`SHEIN_BI_OUTPUTS_ROOT`，生产默认 `/data/shein-bi/outputs`），日志打绝对路径 → PR #176（`d96956c`）。

**发布 `2026.09.16.3`：两条失败路径都要认得**

- 第一次 dispatch 失败是 `SOURCE_RELEASE_CI_ATTEMPT_MISMATCH`：main 推送触发的 CI（run 35025090021）当时还没跑完，`run.status !== 'completed'` 判不通过，**这一路不推 tag**。等 CI 绿了再 dispatch：第二次在 draft 阶段失败但 **tag 已推上**（即 09.16.2 记录过的 tag-only 恢复路径），第三次同版本重跑即成功 → Release `SHEIN BI Ops 2026.09.16.3`、`immutable=true`、releaseId 389492826、CI run 35025090021。
- 判据提醒：`gh release view <version>` 查不到不代表没发布——远端 release 的 tag_name 是 `untagged-<hex>`，要用 `gh release list` 按名字找。

**部署（05:31:19 pause → 05:33:26 resume，约 2 分 10 秒，maintenance generation 368 → 369）**

- 交接：把 `source-permissions-deploy3-20260916.plan.json` 里 2692 条 managedSourcePaths **全部（文件+目录）** 临时 chown 给 sheinops → `git reset --hard 06da4d3`（clean，1464 tracked）→ bundle `/srv/shein-bi/runtime/source-release-bundles/2026.09.16.3.bundle` sha256 `1ab9fa8d…`。
- 加固：新代际 `deploy4-20260916`，audit（planSha256 `9005776b…`）→ apply `issues: []`，generationHash `e5256970…`。
- 部署标记：`check_release_source_state.mjs --expected-commit 2026.09.16.3 --record-deployment 2026.09.16.3 --source-bundle … --expected-source-bundle-sha256 …` → `deploymentMarker{commit 06da4d3…, tagObject 06ab6e99…, releaseId 389492826, ciRunId 35025090021, warnings 0}`，sourceFingerprint `c162ebe6…`。
- 轮转：stage 预检 `39823290…`/工件 `67a734eb…` → finalize 预检 `e8896eee…`/工件 `c645e63b…` → 库存 generation **108**；`assert_inventory_writer_release_aligned` = `aligned: true`；三个库存守卫各自单独跑 `rc=0`、`state=activated_exact`、`activeGeneration=108`；外部 guard 安装器 audit `unchanged`（manifest `a716be5d…`）。
- 收尾：`resume`（generation 369）、`systemctl --failed` = 0、portal/query/webhook 均 active、局域网 `http://192.168.1.200/` 302、`check_release_source_state` ok（head=06da4d3、clean、fingerprint 与标记一致）。
- 探活注意：Portal 的 **loopback 入口是 `127.0.0.1:8080`**；`:80` 只监听局域网 `192.168.1.200`，所以对 loopback 打 `:80` 本来就拒连（不是故障）。`:8080` 返回 302（登录跳转）。

**验收：真跑一次单店抓取（与晨链同一条路）**

- 用 `systemd-run` 起一次性单元 `dl-acceptance-verify`，属性与 `shein-bi-cloud-morning-chain.service` 对齐（同用户/工作目录/三处绑定挂载，加 `SHEIN_LINK_BUSINESS_STORES=DL`、businessDate `2026-09-15`）。
- 结果：relogin 报告落到 **`/data/shein-bi/outputs/reports/auto-relogin-1789508137032.json`**（不再是 app 侧）；`[DL] ok`（`linkRows 212 / inventoryRows 300 / performanceRows 151`）；两个日档都写出：`shein_links/DL/2026-09-15.json`（3.97 MB，05:35）与 `shein_business_domains/DL/2026-09-15.json`（4.14 MB，05:36）；chunk 结果 `{"ok":true,"status":"done","successfulStores":["DL"],"failedStores":[]}`；跑完 0 chrome 残留。
- 顺手清掉了 05:06 那次探针留下的 13 个孤儿 chrome（`cleanup_shein_store_browsers.mjs --stores DL --kill-after-sec 10`，13 → 0，SingletonLock/Cookie/Socket 一并清掉）。

### 部署交接的三个坑（这次踩到的）

1. **只 chown 目录行不够**：`git fetch` 要写已存在的 `.git/FETCH_HEAD`（root 属主），目录可写也没用 → `Permission denied`。必须把 managedSourcePaths 的**文件**也一起临时 chown。
2. **不要给 git 传 `GIT_SSH_COMMAND`**：仓库 `.git/config` 里的 `core.sshCommand = ssh -i /home/sheinops/.ssh/shein_bi_deploy -o IdentitiesOnly=yes` 才是部署密钥的生效路径；环境变量会把它整体顶掉 → `git@github.com: Permission denied (publickey)`。
3. **轮转预检工件是 no-replace**：同一路径重复 dry-run 报 `EEXIST`；重跑换文件名，不要删旧工件（激活/兼容/回执文件更是禁止手删）。

### 主机特权：飞牛账号密码不是 Linux 密码（2026-09-16 05:25 核实）

用户给的主机账号/密码（`dushengyi`）在**主机 Linux 侧不成立**，所以「不走浏览器直接改宿主机」这条暂时走不通：

- `ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no dushengyi@192.168.1.59` → `Permission denied (publickey,password)`；`root` 同样被拒（登录仍只能用 `fnos_shein_fm_ed25519` 密钥）。
- `sudo` 走 `/etc/pam.d/sudo` → `common-auth` = `pam_unix.so nullok` + `pam_winbind.so … try_first_pass`；实测 `sudo: no password was provided` / `1 incorrect password attempt`，即该口令在 Linux/PAM 侧不可用（飞牛网页后台用自己的账号库）。
- 现状：`/etc/sudoers.d/` 只有 README，`dushengyi` 组为 `Users + Administrators`，但没有可用认证凭据。要免浏览器操作宿主机，需要二选一：① 在飞牛网页后台给该账号设一个 Linux 密码；② 加一条免密 sudoers（都需要用户在网页后台先拿到一次 root）。

### 迁移后第 4 批：Portal cgroup 的软上限把整机内存压力信号打到 90，所有闸门任务集体让位（2026-09-16 06:00–06:15，已修）

**现象**：晨链前的 4 lane 实测里 DX/FY/TS/TZ 四个店**全部** deferred（`reason=MEMORY_STALL_PRESSURE`、`status=75`），chunk 结果 `successfulStores: []`。判据是 `check_host_resource_pressure.mjs` 读 `/proc/pressure/memory` 的 `full avg10`（browser/browser-secondary 阈值 4，默认档 1），而实测该值常年 **85–98**。

**定位链**（每一步都有实测）：

- `MemAvailable` 5.7 GiB、`SwapTotal=0`、CPU idle 90%、`vmstat` 无 `si/so`——不是真的缺内存。
- `/proc/pressure/memory` 在**叶子 cgroup 里读与在 root 读完全同值**（97.98 / 97.56）→ 闸门拿到的是全局量，任何一个 cgroup 自造的 stall 都能让所有任务让位。
- 唯一超出软上限的 cgroup 是 Portal：`memory.current 1.36 GiB` > `MemoryHigh 1200M`，`memory.events.high` 已 66 万次（持续回收），其自身 `memory.pressure` full avg10 95.55 ≈ 全局值。
- 追到进程：`generate_bi_portal.mjs --section profit --direct-cache-publish`（pid 248687，Portal cgroup 内的子进程）RSS **1.28 GiB**、已运行 **13:49**，8 秒内 CPU ticks 不涨（1355→1355）——**被回收卡死**，既不出结果也不退出。

**根因**：Portal 的 cgroup 不只装 Portal（152 MiB），还装 `generate_bi_portal.mjs` 的 section 生成子进程（`KillMode=control-group`）。子进程只受 `NODE_OPTIONS=--max-old-space-size=1536` 约束，RSS 可到约 1.8 GiB；而 `MemoryHigh=1200M` 是按「Portal 自己」定的，低于子进程工作集 → 该 cgroup 被内核持续回收 → 全局 PSI 被打高 → 所有走闸门的浏览器/重任务让位。这条链路在旧云同样成立，只是没赶上「生成子进程 + 闸门任务」同时活跃。

**修复与验证**：

- Portal 软上限抬到 `MemoryHigh=1900M`（`systemctl set-property` 即时生效 + 写回 `/etc/systemd/system/shein-bi-portal.service.d/60-resource-guard.conf`），硬上限同步抬到 `MemoryMax=2600M`，保留 `OOMPolicy=stop` / `Restart=always`（改前已备份 `.bak-20260916`）。
- 效果：**12 秒内**卡死的生成进程退出，cgroup 1380 MiB → 227 MiB，PSI full avg10 94 → **0.20**；业务侧 `sections/profit.query.json`、`sections/homeProfit.json` 于 06:06 正常发布（此前一直因 stall 出不来，日志里还有 `bi-live-accounting ... profit mart freshness check failed: timedOut=true`）。
- 复跑 4 lane：DX/FY/TS/TZ **4/4 成功**（`failedStores: []`），峰值 48 个 chrome（四店真并发），跑完 0 残留，全程 PSI ≤ 0.86，耗时约 50 秒。
- 代码侧同步：`infra/systemd/shein-bi-portal.service`、`infra/systemd/README.md` 不变式，以及 `scripts/test_systemd_security_contract.mjs` 新增两条断言（`MemoryHigh` 必须高于 V8 堆上限；`MemoryMax` 必须高于 `MemoryHigh`），可直接拦住这次回归。

**顺带核实（避免误判）**：journal 里 `2026-09-16T07:09:xx` 的 kernel/dockerd/Portal 记录是**迁移期错误时钟留下的未来时间戳**（旧 boot 残留），不是现在的时间跳变——`timedatectl` 显示 clock synchronized / Asia/Shanghai / RTC 非本地，`uptime -s` = 23:35:30，与本地时间一致；warehouse Postgres 正常（`select now(), count(*) from fact.order_item` → `2026-09-16 06:10:46+08 | 13810`）。

**留给后续的设计问题（本轮不改）**：闸门用全局 PSI 做容量判据，会被任意一个 cgroup 的软上限节流污染。要么让闸门读「本任务自己 cgroup 子树」的压力，要么在判定时排除「仅由某服务自身 MemoryHigh 节流贡献」的 stall。
