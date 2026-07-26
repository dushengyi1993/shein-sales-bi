# 云端 BI 运行说明



> 当前权威状态：2026-07-26。V2 是唯一正式 BI 入口；本地 BI 已封存，V1 仅保留 GitHub archive 恢复点。半托 OpenAPI 生产数据面为 DL 单一 App + 19 店唯一 OpenKey。


## 1. 当前入口



- 云端 BI：`https://sa.dushengyi.cc/`；旧 IP 入口 `http://43.165.167.135/` 仅作兜底。

- 访问保护：BI Portal 使用应用内登录页 + `bi_session` HttpOnly Cookie；账号密码只在私下运行环境交付，不写入仓库、文档或日志。

- 云服务器：腾讯云 Lighthouse 东京，Ubuntu 24.04 x86_64，代码目录 `/opt/shein-bi/app`。

- 服务组成：HAProxy/Caddy 负责公网 443 分流与 TLS，Nginx 在服务器本机 `127.0.0.1:8080` 反代到 BI Portal `127.0.0.1:8787`；身份认证由 BI Portal 应用内登录承担，PostgreSQL + Metabase 由 Docker Compose 承载。

- 域名入口：`https://sa.dushengyi.cc/`；服务器内部仍由 Nginx `127.0.0.1:8080` 转发到 BI Portal。

- GitHub 仓库 `main` 是源码恢复基线；云端有值得保存的脚本、配置模板、门户静态产物或自动运营能力时，先同步回 GitHub，再部署到服务器。注意：截至 2026-06-24 交接核对，GitHub release `2026.06.23-bi-traffic-detail` 指向 `3f25f7c`，但云端 `/opt/shein-bi/app` 仍显示 `HEAD=5025d89` 且有 tracked 运行差异；其中流量页和刷新锁热修文件已同步到生产。GitHub 是“干净源码基线”，云端运行态是“业务真相”，两者不一致时不能直接 `pull/reset/add-all`。
- 注意：`outputs/bi-portal/index.html` / `data.json` 会作为可恢复静态快照纳入 GitHub；服务器执行 `git reset --hard origin/main` 或类似部署后，可能把实时 BI 页面覆盖成仓库快照。每次服务器拉取/重置代码后，都要立即跑一次 `scripts/cloud_bi_refresh.sh today intraday` 或对应 systemd service，确认页面生成时间和销售源时间回到当前。

- 云端 Git 同步红线：`/opt/shein-bi/app` 必须由 `sheinops:sheinops` 持有，不要用 `sudo git pull`。仓库 remote 使用 `git@github.com:dushengyi1993/shein-sales-bi.git`，`core.sshCommand` 必须指向 `/home/sheinops/.ssh/shein_bi_deploy`；不要指向 `/root/.ssh/...`，否则普通运维用户无法 fetch/pull。生产生成的 `outputs/bi-portal/data.json` / `index.html` 在服务器上用 `git update-index --skip-worktree` 标记为本地生成物，避免定时刷新后的实时页面把后续 `git pull --ff-only` 阻塞。若云端出现未提交热修复，先分类哪些应回填 GitHub、哪些是运行产物；在完成清单、备份和回滚方案前，不得 `git add -A`、`git reset --hard`、`git clean -fdx` 或强行让云端追 `origin/main`。
- 发布顺序：BI 用户可见改动先在云端页面或云端服务输出验证，用户确认后再进入 GitHub `main` / release。本地验证只能证明开发产物可运行，不能替代云端最终审核。
- 部署纪律：云端不得长期停在老 commit 上手动漂移。任何云端源码热修必须回填 GitHub；任何 GitHub release 必须写明“已部署云端”或“仅源码基线未部署”；交接前必须确认 `HEAD == origin/main`、无源码脏改、关键服务和 BI health 已验证。`.venv-*`、profile、session、日志、dump、临时上传等运行产物必须排除在 Git 之外。
- 当前 GitHub 发布边界：V2 是正式 release 线；V1 只保留 GitHub final/archive 纪念版 `2026.06.18-v1-final-archive`，线上 `/v1/` 不再提供访问，也不再纳入日常刷新或后续功能更新。


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

| 半托订单 Webhook + OpenAPI 按单同步 | 实时事件触发 | 更新当天正式销售事实并通过 SSE 通知在线 BI；旧 `shein-bi-cloud-today.timer` 已停用并删除 |
| `shein-bi-cloud-yesterday.timer` | 北京时间 `03:00` | 刷新前一天最终销售，并复核前两天稳定日 |

| `shein-bi-db-backup.timer` | 北京时间 `02:40` | 备份业务库和 Metabase 元数据库到 `/srv/shein-bi/backups/auto` |

| `shein-bi-cloud-et-forwarder.timer` | 北京时间 `01:20/04:20/07:20/10:20/13:20/17:20/20:20/23:20` | 按经营检查点抓取 ET 货代仓/出库单、入仓，只轻量刷新订单/物流/售后相关 section；需要服务器本地 ET 登录配置 |

| `shein-bi-cloud-et-storage-fee.timer` | 北京时间 `14:10` | 只读同步 ET 仓储费最终账单与 SKU 明细，重建利润 cache、对账并只预热 `profit/homeProfit` |

| `shein-bi-cloud-morning-chain.timer` | 北京时间 `08:00` | 晨间串行链路：跳过重复的当天销售抓取，直接启动前一完整日统一补采；当前 `SHEIN_BI_MORNING_SEND_LARK_REPORT=0` |

| `shein-bi-cloud-session-manager.timer` | 北京时间 `02:20` | 云端登录态管家：顺序巡检/恢复当前 19 店 WebAPI + SBN 登录态，检查 profile 体积，生成报告 |

| `shein-bi-cloud-browser-cleanup.timer` | 每天 `03:45/09:50/21:00` | 租约感知地回收过期/死亡租约和无有效租约的孤儿浏览器；避开日更与营销窗口 |
| `shein-bi-cloud-disk-maintenance.timer` | 每周日 `01:35`，随机延迟不超过 10 分钟 | 旧抓数校验归档到 COS、清理 7 天前临时文件；根盘达到 80% 且无浏览器任务时才清 profile 可再生缓存 |

| `shein-bi-cloud-watchdog.timer` | 每小时 | 检查云端服务、timer 和 BI 数据新鲜度，异常时发飞书提醒 |

| `shein-bi-lark-sales-qa.service` | **主动暂停** | 飞书只读问数机器人代码与 unit 保留，但生产必须保持 `disabled + inactive`；网页问数与 CLI 不依赖它 |



ET、统一日更补采和异常通知 watchdog 等 Linux systemd 入口已启用并通过手动验证；飞书只读问数服务自 2026-07-11 起保持 `disabled + inactive`。2026-07-23 起，19 店半托当天销售由订单 Webhook 触发按单 OpenAPI 查询并写正式事实表，在线 BI 通过 SSE 实时刷新；旧每小时 `today` timer 已删除。每日 `03:00` WebAPI 仍抓前一天作为独立核对证据，但切换日以后不得直接清理或写入正式销售事实；只有 19 店 OpenAPI 与 WebAPI 全部深度匹配后，才原子晋升 OpenAPI 最终日切片。晨间日更继续补齐链接/业务域、RTV、SBN 和商品流量等非订单数据。Webhook 替代的是半托当天销售轮询，不等于所有数据域都已无浏览器或无 WebAPI。



### 生产资源排班边界



### 当前排班总览（2026-07-26 核对）

| 时间 / 频率 | 任务 | 形式 | 生产事实影响 | 备注 |
|---|---|---|---|---|
| 实时事件 | 半托订单 Webhook + 按单 OpenAPI 同步 | Webhook 触发，只查发生变化的订单 | 更新当天正式销售事实、日汇总并通知在线 BI | 旧每小时 `today` timer 已删除；失败进入 Webhook 重试/dead-letter 与 watchdog。 |
| `03:00` | 昨日最终销售与前两天稳定日复核 `shein-bi-cloud-yesterday.service` | WebAPI 独立抓取 + 19 店 OpenAPI 深度对账 | WebAPI 不写正式事实；19/19 全匹配后原子晋升 OpenAPI 日切片 | 任一失败、warning、缺店或差异都禁止晋升，避免双写或用不完整日覆盖正式事实。 |
| `08:00` | 晨间串行链路 `shein-bi-cloud-morning-chain.service` | 直接启动日更补采 | 不重复抓当天销售，只触发慢变日更 | 飞书日报自动发送关闭。 |
| 晨间链路之后，每日一次 | 统一日更补采 `shein-bi-cloud-daily-refresh.service` / `cloud_daily_refresh.sh yesterday` | 混合：WebAPI/headless + OpenAPI 来源/对账层 | 写链接/业务域、SBN 营销概览线索、RTV 复核等慢变数据；其中的销售步骤不直接写正式事实 | 不再重复执行 MBRs 全店营销价格栈扫描；该实时扫描只属于独立 guard。商品四档状态、SBN 经营/流量等仍需 WebAPI/headless。 |
| 晨间日更内每日一次，跑 D-1 | 销售/退货/商品 OpenAPI reconciliation | OpenAPI | 更新 `fact.openapi_*` 和 `mart.openapi_*_reconciliation`，不直接对正式事实表做原始 DML | 销售最终日晋升只属于 `03:00` 的 19/19 深度匹配门禁；退货/商品继续按各自隔离对账和切源门禁处理。 |
| `01:20/04:20/07:20/10:20/13:20/17:20/20:20/23:20` | ET 货代仓/出库单 `shein-bi-cloud-et-forwarder.service` | ET headless/API | 写 ET 仓库、出库单，并轻量刷新订单/物流/售后 section | 不是 SHEIN OpenAPI；异常不应中断已成功店铺数据。 |
| `14:10` | ET 仓储费 `shein-bi-cloud-et-storage-fee.service` | ET headless/API，只读 `IncomeBill(sort=2)` + `ExportStoreFee` | 写仓储费事实、canonical 账单与利润 cache | 与通用 ET 共用 profile 锁但隔离输出；只预热利润，不刷新无关库存趋势。 |
| `02:20` | 登录态管家 `shein-bi-cloud-session-manager.service` | 短生命周期 headless browser + WebAPI/SBN 探针 | 不写销售事实 | 恢复 WebAPI + SBN 登录态，结束后关闭它启动的浏览器。 |
| `06:30` | 订单闭环复查 `shein-bi-cloud-order-closure.service` | WebAPI | 只更新订单生命周期状态，不重写历史销售事实 | 用于未终态订单复查；不随销售 OpenAPI 候选切换。 |
| `10:30/13:30/16:30` | 每日营销 live guard `shein-bi-cloud-marketing-live-guard.service` | session HTTP 只读直连 | 一次读取 19 店普通活动、15% 券 active 集合与当前/未来活动价，生成精确计划和 repair queue；不持有写授权 | 不启动浏览器、不申请浏览器租约、不执行清理；当天首次成功后后续窗口只作失败重试。 |
| `10:50/12:50/14:50/16:50/18:50/19:30` | 营销 repair worker | 受控浏览器写入 | 只执行负责人长期授权内的限时折扣修复 | 前五轮有界续跑，`19:30` 做最终续跑与回读；每轮总预算 8 组。 |
| `03:45/09:50/21:00` | 浏览器残留清理 `shein-bi-cloud-browser-cleanup.service` | 本机进程清理 | 不写业务数据 | 避开日更和营销窗口，只回收无有效租约保护的孤儿浏览器。 |
| 每小时 `:50` | watchdog `shein-bi-cloud-watchdog.service` | 只读巡检 | 不写业务数据 | 检查服务、timer、BI 新鲜度、销售/页面过期、浏览器残留并发提醒。 |
| `02:40` | 数据库备份 `shein-bi-db-backup.service` | PostgreSQL dump/备份 | 备份 | 默认保留 14 天。 |

- 当天销售、通用 ET 和仓储费保持独立：当天销售由半托订单 Webhook 实时触发，通用 ET 每天八个经营检查点运行，仓储费每日 `14:10` 跑；仓储费先取得共用 ET 锁，不能与通用 ET 争用 profile。
- 仓储费回灌/补跑使用 `bash scripts/cloud_et_storage_fee_sync.sh backfill YYYY-MM-DD`。完成标准不是“抓到文件”，而是 `check_storage_fee_profit.mjs` 四层守恒、`audit_bi_warehouse.mjs` 无 errors、timer/service success 和 profile Chrome 为 0。

- 营销 live guard 临时补跑必须避开 ET `:20`、晨间/日更、登录态管家、备份和订单闭环。`2026-07-18 21:06` 的 19 店生产实测为 `157s`、Chrome `0 -> 0`；若正常巡检再次升到十几分钟或数小时，应视为重复抓取、浏览器回退或扫描夹带写入的故障。

- 慢变补采只放在 `shein-bi-cloud-daily-refresh.service`：由 `shein-bi-cloud-morning-chain.timer` 在 08:00 直接启动；链接/业务域、商品列表/库存/流量、SBN 营销概览和 RTV 换单复核集中在这个批次内。MBRs 全店普通活动/优惠券/限时折扣价格栈只由独立 guard 实时读取，禁止在日更内再扫一遍。

- 营销价格扫描按店有界重试，CLI 为 `--store-attempts 1..5`，生产 guard 由 `SHEIN_BI_MARKETING_PRICE_STORE_ATTEMPTS=3` 固定为最多 3 次；只重试已分类的瞬时错误，业务拒绝或确定性错误不能靠无限重试掩盖。

- 通用 ET 和 watchdog 保持 `Persistent=false`，避免开机并发补跑；每日仓储费及其它每日唯一性任务（昨日定稿、晨间链路、备份、订单闭环、登录态、营销 guard/repair）使用 `Persistent=true`，但各 service 仍先检查锁、当天状态和资源窗口，防止重启后堆叠执行。事实以对应 `.timer` 文件为准。

- `daily-refresh` 启动前会等待销售/昨日销售/ET 写入任务结束，并检查 `MemAvailable`。可用内存低于阈值时写 `skipped_low_memory` 状态后跳过本轮；宁可让慢变数据晚一点，也不能拖慢销售刷新和 BI 页面。

- `daily-refresh`、ET、登录态管家、销售刷新、昨日销售、订单闭环、RTV 校验均有 `MemoryHigh` / `MemoryMax` / `OOMPolicy=stop` 护栏；如果单个任务越界，应失败并告警，不能把整台服务器拖到 OOM。
- 销售、日更、ET、营销巡检、晨间链路、日报、Portal 刷新和预热锁统一放在 `/opt/shein-bi/app/state/locks`，所有脚本在 `flock` 前调用 `scripts/lib/shared_lock.sh` 的 `prepare_shared_lock_file`。目录必须是 `2770`，锁文件必须是 `0660` 且 group 为 `sheinops`；禁止恢复 `chmod 0666`、`umask 000` 或可预测的 `/tmp/*.lock`。历史 `/tmp` 残留曾导致任务权限冲突，修复后应 `systemctl daemon-reload`、`systemctl reset-failed`，并确认 app 内 `worldWritableNonSymlinks=0`。
- 2026-06-20 已确认旧 `financeData` section 下线：线上 `/api/bi/section/financeData` 应返回 `404`；`/v1/` 应返回 `410`，`/v2/` 只跳转到根路径。不要为 V1/旧财务页面恢复预热、缓存或 timer。

- `inventoryTrend` 不是 ET 实盘库存，而是 SHEIN 前台展示库存趋势。2026-06-20 云端实测 `inventoryTrend.json` 约 `242KB`、gzip 约 `20KB`；若后续怀疑 21MB 大 section，先查线上 `outputs/bi-portal/sections/` 真实体积，不按旧印象处理。

- 旧分散 timer `shein-bi-cloud-link-business.timer`、`shein-bi-cloud-rtv-verify.timer`、`shein-bi-cloud-openapi-hl.timer` 已在生产机 `masked`，不要只看旧 unit 文件存在就重新启用。



2026-05-16 链接/业务域已完成云端闭环：`scripts/cloud_link_business_sync.sh` 会按店顺序执行 `restore_shein_store_session.mjs`、`fetch_shein_links.mjs` 和 `fetch_shein_business_domains.mjs`，失败店铺会关闭并重启该店浏览器重试，全部完成后入仓、运行 BI 体检并生成门户。验证日志 `/srv/shein-bi/logs/cloud-link-business/link-business-2026-05-15-20260516-163901.log` 显示 16 店全部 `done`；BI `dates.linkDate=2026-05-15`、`dates.businessDate=2026-05-15`，体检 `warnings=0/errors=0`。这不是本机补抓；后续不要重新启用本地 Windows 链接/业务域任务作为长期生产。



数据库备份默认保留 `14` 天。抓数原始产物本地保留 `30` 天，之后由 `cloud_disk_maintenance.sh` 打包到 `/lhcos-data/shein-bi-archive/YYYY-MM-DD/`；只有压缩包可完整读取、成员清单一致且 SHA256 已落盘时，才删除未发生变化的本地源文件。COS 不可写或校验失败时必须保留本地文件。浏览器缓存清理与 `03:45/09:50/21:00` 的孤儿进程清理分开：前者只在根盘达到 `80%`、浏览器租约为零且没有 Chrome 进程时执行，并明确排除 Cookie、Local Storage 和 IndexedDB。journald 上限为 `1GB`，同时至少给根盘保留 `5GB`。



## 4. 云端刷新链路



- 当天人工灾备入口：`scripts/cloud_bi_refresh.sh today intraday`。日常当天销售由订单 Webhook 触发按单 OpenAPI 写正式事实，不安装每小时 timer；只有实时链路故障并明确决定灾备时才手动运行。
- 前一天最终版入口：`scripts/cloud_bi_refresh.sh yesterday final`。WebAPI 生成独立核对文件但在切换日以后不写正式事实；19/19 店 OpenAPI 深度匹配后才调用 `ops.promote_openapi_sales_slice` 原子晋升。

- Portal section 预热有两层：`cloud_bi_refresh.sh` 生成 core 后会后台启动 `scripts/prewarm_bi_portal_sections.sh`；`serve_bi_portal.mjs` 还会在服务启动和首页访问时检测 `data.json.generatedAt`，通过 core warmup watcher 兜底预热 section，防止用户打开页面时才现场生成。`homeRankings` 是首页销售/排行轻量 section，服务端会裁掉首页不用的重复 `goods_title` / `skc_list` 文本并写 `.json.gz` sidecar；完整 `rankings` 仍保留给详情/子页。`homeProfit` 只从当前 `profit` section cache 派生；如果当前 `profit` 缺失或过旧，前端会把 `staleSource=true` / `sourceGeneratedAt` 不匹配的摘要视为不可用，不能拿旧利润当业务真相。
- `productTrafficDaily` section 当前是日期 × 店铺 × 标准货号 × SKC 粒度，并从最新链接主快照带出 `shelf_status_name`、`is_on_shelf`、`is_sold_out`、`is_out_shelf` 等字段。流量页前端按顶部时间范围聚合成店铺 × 标准货号 × SKC 明细，默认只看已上架链接；若要追溯历史某日当时的上架状态，需要另做日期对齐的历史状态层，不能把当前快照解释成历史状态事实。
- 数据库备份入口：`scripts/cloud_db_backup.sh`

- ET 云端入口：`scripts/cloud_et_forwarder_sync.sh today`

- 飞书日报云端入口：`scripts/cloud_daily_lark_report.sh today` 仅保留为手动临时发送；正式自动发送当前关闭，`scripts/cloud_morning_chain.sh` 默认跳过日报后直接启动慢变日更。

- 统一日更补采云端入口：`scripts/cloud_daily_refresh.sh yesterday`；生产由晨间链路启动 `shein-bi-cloud-daily-refresh.service`。它内部调用 `scripts/cloud_link_business_sync.sh` 做链接/业务域、SBN 营销概览等慢变域日更，并串行执行 `scripts/cloud_rtv_verify.sh`；不再重复 MBRs 全店价格栈扫描，该 live 证据只由独立 marketing guard 读取。旧 `scripts/cloud_openapi_hl_reconciliation.sh` 仅保留为显式手动诊断入口。链接/业务域带全店日指标全 0 不入仓守卫。该入口不应在白天手动全量补跑 19 店；若必须补跑，先确认当前没有 ET/门户生成/营销写入任务，并检查可用内存。

- 云端异常通知入口：`scripts/cloud_ops_watchdog.mjs`。对于内容精确等于 `marketing price scan failed` 的单一日更 warning，watchdog 只有在后续 guard 状态引用一份比 warning 更新、24 小时内、`ok=true` / `partial=false`、与当前 enabled store 集合完全一致且行数自洽的扫描时，才在 `recoveries` 中记录恢复并停止重复告警。原 `daily-refresh-last.json` 和历史日志必须保留；混合 warning、过期/未来时间、路径越界、缺店、重复店、失败店或残缺 payload 一律不能自动变绿。

- 云端覆盖审计入口：`scripts/audit_cloud_data_coverage.mjs`。最新日防漏用 `--expected-start range-start`，历史断档排查用 `--expected-start first-seen`；后者按每个店自己的首个有效日期之后查中间断档，避免把店铺尚未开通/尚未接入前的日期误判为缺抓。

- 飞书只读问数机器人（云端 Codex CLI 网关）保留入口：`scripts/cloud_lark_sales_qa_bot.sh` / `scripts/lark_sales_qa_bot.mjs`；当前只用于离线诊断或未来经明确授权恢复，生产 service 不运行。

- 半托销售生产链路已按日期切换：当天由 Webhook + 按单 OpenAPI 增量写正式事实；最终日由 19 店 OpenAPI 全量与 WebAPI 独立文件深度匹配后原子晋升。`fact.openapi_*` 和 `mart.openapi_sales_reconciliation` 仍保留为可追溯来源与门禁证据，不得绕过全店匹配直接覆盖正式日切片。

- WebAPI/headless 没有被全局删除：商品四档状态、SBN 经营/流量、营销活动、部分编辑级商品资料、订单生命周期复查等仍按各自边界使用。退货退款、商品/链接基础资料是否进入正式事实必须按对应域单独验收，不能借销售切源一刀切。

- ET 已改为 Linux headless Chrome + 账号密码/OCR 自动登录模式；Windows Chrome 保存密码不能直接迁到 Linux，服务器必须单独保存 `config/et_forwarder.local.json` 或等价环境变量。

- 飞书日报依赖服务器本地 `config/lark_report.json`、`lark-cli` 和独立飞书机器人授权；旧应用 `open_id` 不能直接复用到新应用，必要时用 `union_id` 映射。飞书 Base / 看板写入仍受暂停开关控制，日报发送与 Base 写入分开处理。

- 飞书日报图在 Linux headless Chrome 下依赖中文字体；服务器必须安装 `fonts-noto-cjk` / `fontconfig` 并能通过 `fc-match 'Noto Sans CJK SC'` 匹配到 Noto CJK，否则中文会渲染成方框。

- 链接/业务域按日更低频看待，watchdog 阈值为 48 小时；页面底稿与销售最终日底稿阈值均为 30 小时，避免“店铺半天没有新订单”被误报成断流。页面展示使用“静态底稿销售时间”和 Portal 从 Webhook receipt 恢复的最后订单时间二者较新值；watchdog 另外强制检查 Portal/Webhook 两个常驻服务及 SSE/LISTEN 连接。商品/流量等仍依赖云端日更与必要的 headless/WebAPI，不因订单 Webhook 上线而误判为全数据域实时。

- 云端登录态管家入口：`scripts/cloud_shein_session_manager.sh` / `scripts/cloud_shein_session_manager.mjs`。它按店顺序启动临时 headless Chrome，自动检查/恢复 GSP 订单 WebAPI 与 SBN 商品分析子系统登录态，完成后关闭由它启动的店铺浏览器；默认不清理缓存，只报告 profile 体积。需要手动安全清缓存时才加 `--cleanup-cache`。

- `audit_bi_warehouse.mjs` 与 `load_bi_business_domains.mjs` 均应支持 Linux 下自动使用 `sudo docker exec`；如果服务器手动运行时报 Docker socket 或写文件权限错误，先检查脚本是否为最新，以及 `/srv/shein-bi/logs`、`state/cloud_ops_watchdog`、`outputs/bi-portal`、`outputs/bi_audit` 是否被 root 运行残留成普通用户不可写。



### 链接/业务域 WebAPI / headless 现状



- 已验证可直接复用现有 WebAPI session 的域：`gsp` 售后列表/统计、发货面单计数等。

- 暂不能直接复用现有销售 session 的域：`mgs` 履约/评价、`pqmp` 质量、`spmp` 商品列表、`idms` 备货、`sbn` 经营/营销、`gsfs` 财务；这些在云端探针中返回 `20302 子系统登录重定向`。

- 后续改造顺序：先解决子系统登录态/初始化，再解决 SBN 商品分析的 `x-gw-auth` 等动态头，最后处理财务二次密码或敏感权限边界。

- 当前生产使用云端 headless 顺序兜底，`cloud_link_business_sync.sh` 默认一次只跑 1 店，单店完成后关闭浏览器；不能改成全店同时开浏览器。若后续提并发，建议最多 `2` 并先看内存。



### 云端临时人工登录入口



- BI 页面“系统 / 登录维护中心”入口：`/cloud-login-maintenance`。

- 用途：当某店 SHEIN / SBN / 子系统登录态失效、自动恢复失败、验证码/滑块必须人工处理，或被协议签署 / 公告 / 通知确认等普通登录弹窗挡住时，在云服务器上临时启动该店独立 profile 的可见 Chrome，并通过 noVNC 嵌入到 BI 页面。

- 入口实现：`scripts/cloud_manual_login_session.mjs` 负责创建、列出、完成和关闭临时会话；BI Portal 通过 `/api/cloud-login/sessions` 和 `/cloud-login/session/:id` 提供受保护页面。

- 服务器依赖：`xvfb`、`x11vnc`、`websockify`、`novnc`，均绑定本机端口；外网只经过现有 BI/Nginx/Caddy 入口和 BI 应用内登录链路访问。

- 临时会话只保存 session id、短期访问 token、过期时间、端口、PID、日志文件和完成状态；不把密码、cookie、localStorage、请求头或 SHEIN token 写入仓库、文档或聊天。

- 操作流程：打开维护中心 -> 选店铺和页面 -> 打开云端登录窗口 -> 处理普通登录弹窗或人工完成登录/验证码 -> 回维护中心点“我已完成并关闭”。完成动作会触发 `export_shein_browser_session.mjs --no-launch` 和 `bootstrap_shein_browser_session.mjs --no-launch` 验证，然后关闭 Chrome / x11vnc / websockify / Xvfb。

- 普通登录弹窗边界：协议签署、公告、通知确认、`知道了` / `确认` / `同意` 等不涉及店铺经营承诺、资质、付费、活动报名或授权范围变更的弹窗，可由运维代理在维护窗口中关闭/确认后再点登录；它们不等同于验证码阻塞。若弹窗内容是新的法律承诺、资质承诺、付费/结算、活动报名、授权范围变化，或出现验证码、滑块、短信、人脸、缺账号密码，则停下让用户处理。

- Nginx 配置必须支持 WebSocket upgrade；仓库模板为 `infra/nginx/shein-bi.conf`，包含 `proxy_set_header Upgrade` 和 `proxy_set_header Connection "upgrade"`。Caddy 在公网 TLS 层传入的 `X-Forwarded-Proto: https` 必须由 Nginx 继续传给 Portal，不得用内部 HTTP hop 的 `$scheme` 覆盖；否则真实同源 POST 会被误判为跨域。修改后要用携带 `Host: sa.dushengyi.cc` / `Origin: https://sa.dushengyi.cc` / `X-Forwarded-Proto: https` 的 Nginx 内网探针验证：未登录请求应返回 `401`，不应返回同源拒绝 `403`。

- 日志与状态：状态文件 `/srv/shein-bi/runtime/cloud_manual_login_sessions.json`；日志目录 `/srv/shein-bi/logs/cloud-manual-login`。这些都是服务器私有运行态，不进 GitHub。

- 若开启时提示某店 `CDP port ... is already open`：先确认是否有生产同步 service 正在运行。`cloud_manual_login_session.mjs` 会在确认没有生产同步 service 活跃时自动清理已完成/已关闭临时窗口留下的孤儿 Chrome/VNC 进程；若生产同步正在运行，应等待同步结束，不要强杀。

- 当前限制：一次只允许一个临时登录窗口；过期或完成后不能再进入窗口，需重新开启。登录维护入口依赖 BI 应用内登录和账号权限。



## 5. 运行数据与敏感信息边界



以下内容不得提交 GitHub：



- `state/shein_webapi_sessions/*.local.json`

- `config/*.local.json`

- `config/lark_report.json`

- `config/et_forwarder.local.json`

- Metabase 管理员密码、数据库真实密码、BI 登录密码

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

- 服务器本机访问 `/api/health` 或带有效 BI 登录会话访问应返回 `200` 且 `ok=true`；未登录公网访问应返回 `401` 或跳转登录。

- `shein-bi-cloud-today.timer` 应为 `not-found/disabled/inactive`；`shein-bi-cloud-today.service` 只作人工灾备，不在 watchdog 必需 unit 清单中。
- 所有 `state/locks/*.lock` 应为 `0660 root|sheinops:sheinops`，同时可被 root / sheinops 写入但不能 world-write。
- `shein-bi-db-backup.timer` 应每日生成 `shein_bi.dump` 与 `metabase.dump`。

- ET 已验证可手动跑 `scripts/cloud_et_forwarder_sync.sh today`，能登录、抓取、入仓并刷新门户；失败时保留上一版 ET 数据，不应阻断销售 BI。

- 飞书日报已验证可手动跑 `scripts/cloud_daily_lark_report.sh today`，文字和日报图能发送；成功后会写入当天 sent flag，避免同日 timer 重复发送。

- 若 BI 侧栏显示的“页面生成 / 销售源”时间明显旧于当前事件，先检查 `shein-bi-webhook.service`、receipt 队列、`fact.openapi_order_* -> fact.order_*` 触发器和 Portal 的 `/api/bi/live-events`；不要先恢复每小时全量抓数掩盖根因。人工灾备才运行 `shein-bi-cloud-today.service`。

- 若首页长期“加载中”或利润明显异常偏低，先用服务器本机或有效 BI 登录会话访问 `/api/health` 确认 `biCoreWarmup.status`，再访问 `/api/bi/section/homeProfit` 或在服务器读 `outputs/bi-portal/sections/homeProfit.json`，确认 `homeProfitSummary.sourceGeneratedAt` 等于当前 `data.json.__sections.generatedAt` 且 `staleSource=false`。若任一 section 旧于 core，可请求对应 `/api/bi/section/<section>?refresh=1` 或等待 portal 服务 warmup；不要用旧 section 数字判断业务。

- BI Portal 生成后，`outputs/bi-portal/data.json` 应包含顶层 `productDisplayNames`，且主要含 `standard_goods_sn` 的对象应有 `product_display_name`。如果页面或飞书问数机器人又裸显示 `SM-505A`、`SK-10075` 这类短码，先在服务器跑 `node scripts/test_product_display_name.mjs`，再重跑 `node scripts/generate_bi_portal.mjs` 或对应云端刷新 service。

- 若飞书日报图中文显示方框，先在服务器检查 `fc-match 'Noto Sans CJK SC'`；修复字体后只需重新生成/下次发送日报图，不需要重发已发送的旧图，除非用户明确要求。

- `cloud_bi_refresh.sh` 应在生成 BI Portal 前运行 `audit_bi_warehouse.mjs`，否则页面顶部会显示“数据体检：未找到体检文件”。体检有 warning 时仍生成页面，让 BI 直接展示 warning 内容。

- `ssh shein-bi-tencent` 应能直接登录服务器并具有免密 `sudo` 运维能力；如果后续 HTTPS 占用 443，先迁移 SSH 端口。

- `shein-bi-cloud-watchdog.timer` 应保持 active；销售数据过期按 12 小时、页面底稿按 30 小时、链接/业务域按 48 小时提醒，并检查 Portal 的 SSE/LISTEN 连接。若报告通过恢复证据收口历史营销扫描 warning，必须同时看到 `issues=[]`、`recoveries[].type=daily_marketing_price_scan_recovery` 和原始 `dailyRefresh.status=warning`，不能只看进程退出码。

- `shein-bi-cloud-morning-chain.timer` 应保持 active；慢变日更由它启动 `shein-bi-cloud-daily-refresh.service`。手动复跑用 `scripts/cloud_daily_refresh.sh yesterday`。若单店卡在 SBN `x-gw-auth`，优先看该店 attempt 重试日志；若 RTV 子步骤失败，先看底层脚本日志。当天销售由半托订单 Webhook 触发按单 OpenAPI 写正式事实，`03:00` 全店 OpenAPI 只在与 WebAPI 独立核对结果 19/19 深度匹配后原子晋升最终日切片；退货退款、商品/链接等其它数据域仍按各自 OpenAPI、WebAPI/headless 与日更边界处理。不要回退到本机补抓冒充云端日更。旧的 `shein-bi-cloud-link-business.timer`、`shein-bi-cloud-openapi-hl.timer`、`shein-bi-cloud-rtv-verify.timer` 应保持 masked，避免日更补采重复跑。

- `shein-bi-cloud-session-manager.timer` 应保持 active；手动复跑用 `scripts/cloud_shein_session_manager.sh`。报告文件在 `outputs/reports/cloud-session-manager-latest.json` / `.md`，若失败会被 watchdog 按 service failed 逻辑提醒。

- `shein-bi-cloud-daily-refresh.service` 必须以 `User=sheinops` / `Group=sheinops` 运行，因为它会启动当前 19 店 SHEIN Chrome profile；不要改回 root，否则会生成 root-owned profile 文件并让 `shein-bi-cloud-session-manager.service` 第二天因 `EACCES` 失败。ET forwarder 仍保留 root 执行，因为入仓依赖 Docker/root 环境，且它不写 SHEIN 店铺 profile。

- 历史 V1 时间筛选弹窗回归检查已随 V1 线上下线而停止；如需排查旧版，只能从 GitHub release tag `2026.06.18-v1-final-archive` 临时恢复到隔离环境。

- 登录态恢复统一走 `restore_shein_store_session.mjs`：先用服务器私有 `state/shein_browser_sessions/*.local.json` / `state/shein_webapi_sessions/*.local.json` bootstrap，再运行 `auto_relogin_shein_store.mjs` 验证 GSP order WebAPI 和 SBN 商品分析页；验证成功后必须立即调用 `export_shein_browser_session.mjs --no-launch` 刷新该店 browser session 导出，避免第二天继续回灌过期 SBN 状态。云端没有保存密码的店铺不能只靠 Chrome autofill 自愈，若 SBN 已过期且无保存密码，需要走 `/cloud-login-maintenance` 处理一次；若只是协议/通知弹窗阻塞，运维代理可先点掉弹窗并重试登录，不必直接判定为用户验证码阻塞。

- 云端人工登录入口验证：`/cloud-login-maintenance` 返回 `200`；`/cloud-login/novnc/vnc.html` 返回 `200`；创建会话后 `/cloud-login/session/:id` 返回 `200` 且 WebSocket 升级返回 `101 Switching Protocols`；点“我已完成并关闭”后 export/probe 成功且不残留 Chrome/Xvfb/x11vnc/websockify 进程。

- `shein-bi-lark-sales-qa.service` 应保持 `disabled + inactive`；部署前后执行 `systemctl is-enabled` / `systemctl is-active` 核验，不得为了“全绿”启动它。unit 仍保留 `User/Group=sheinops`、`HOME=/home/sheinops`、`NoNewPrivileges=yes`、`PrivateTmp=yes` 等安全契约，未来恢复需单独授权和发布验证。

- GitHub `main` 应包含最新可复用代码和文档；敏感运行态只保留在本地/云端私有目录。





## 飞书问数 / 云端 Codex CLI 网关（当前暂停）



- 历史链路为：飞书消息事件 -> 云端 `lark-cli` / `shein-bi-lark-sales-qa.service` -> `scripts/lark_sales_qa_bot.mjs` -> Codex CLI 只读执行 -> 回复飞书。2026-07-11 起该 service 主动暂停；当前团队入口是网页 BI 自动运营，Owner/合伙人使用 `scripts/bi_ops_cli.mjs`。

- Codex CLI 安装在服务器系统路径，私有配置目录为 `/home/sheinops/.codex`；`auth.json`、`config.toml`、第三方 API 配置和 token 都不进入 GitHub、文档或日志。

- 若未来经授权恢复飞书服务，默认问数使用 `gpt-5.6-terra` + `low` + 45 秒，图表意图使用 `gpt-5.6-luna` + `low` + 20 秒；不得恢复旧的全局 `gpt-5.5 + xhigh + 600 秒` 配置。

- Lark bot 不再使用 root HOME。迁移旧 keychain 时，只能在服务器上把 `/root/.lark-cli/config.json`、`/root/.local/share/lark-cli/master.key` 和对应 `appsecret_*.enc` 备份后，以 `600` 权限安装到 `sheinops` HOME；父目录保持 `700`。不得输出文件内容或把它们放进 app 目录。迁移后先以 `sudo -u sheinops -H lark-cli api GET /open-apis/bot/v3/info --as bot` 做只读凭据探针，再重启服务并检查 websocket `connected` 日志。

- `/opt/shein-bi/app` 不得 world-writable。用 `sudo bash scripts/harden_cloud_runtime_permissions.sh` 只读审计，确认后再加 `--apply`；完成标准是根目录 `sheinops:sheinops 0750`、`worldWritableNonSymlinks=0`。该脚本不跟随 Chrome 的 `Singleton*` symlink，也不递归改属主/组写位。

- 网关只把 `outputs/bi-portal/data.json` 压缩成销售、店铺、货号、链接/覆盖等只读上下文交给模型；不授予写 PostgreSQL、写飞书 Base、改 SHEIN 后台或改服务器文件的权限。

- 图表/作图请求采用“模型理解、代码控权和渲染”的两层结构：先由模型根据整段会话输出受控 `chartIntent`（图表族、维度、指标、排序、布局、`constraints`），再由代码只映射到白名单 BI 图表和只读数据；关键词规则只作为模型不可用时的兜底，不作为主理解层。

- 对上下文里出现的口径修正（例如仓库、排除项、例外货号、排序放置规则），模型必须写入 `chartIntent.constraints`，计算/渲染层必须直接消费该结构化约束；若约束当前数据无法执行，必须写入事件日志的 `chartUnappliedConstraints`，不能静默复用旧口径或旧图。

- 库存图若用户提到 09/01/03/04/06 仓口径，飞书图表必须按 `constraints.stockPolicy` 计算运营可售现货：默认只计 `ETRUH09散件仓`；`SK-03038` 制冰机例外计 `ETRUH01整箱仓`；`ETRUH03_RTV`、`ETRUH04Damaged`、`ETRUH06报废` 不计可售现货。已售罄但有在途的货号仍展示在前，已售罄且无在途的货号放最后。

- 网页端“链接管理中台”的运营会话复用同一受控问数链路：每轮按最新一句和最近会话上下文重新从当前 BI JSON 取数；如果用户明确要求下架、换图、改标题、补链、报活动或限时折扣，服务端必须创建 / 更新同一会话任务并留痕。用户点击“开始执行 / 预检”后，`/api/link-ops-execute` 会进入受控执行器、写回进度和审计；真实写 SHEIN 仍必须满足对应适配器、payload 完整和二次确认，不能静默提交。

- 失败兜底顺序：Codex CLI 只读网关失败时，退回直接 LLM 问答；再失败时退回脚本内规则回答，保证飞书机器人不会因为模型异常完全失声。

- 这个机器人已经不绑定本机 Codex App 或当前聊天窗口；只要云端服务、飞书授权和服务器网络正常，本机关机也不影响飞书问数。



验证命令（服务器 `/opt/shein-bi/app`）：



```bash

systemctl show shein-bi-lark-sales-qa.service -p Environment

systemctl show shein-bi-lark-sales-qa.service -p User -p Group -p NoNewPrivileges -p PrivateTmp -p ProtectSystem

CODEX_HOME=/home/sheinops/.codex codex --version

CODEX_HOME=/home/sheinops/.codex SHEIN_QA_CODEX_GATEWAY_ENABLED=1 node scripts/lark_sales_qa_bot.mjs --answer "DL这个店今天卖得最好的品是什么？"

```



2026-05-21 云端模型与 my-codex 口径：



- 旧的 `gpt-5.5 + xhigh + 600 秒` 只保留为历史记录，不再是当前配置。当前模型路由见下节。

### BI 自动运营 V2：入口、模型与持久化（2026-07-12）

- 普通团队成员使用网页 BI 自动运营；任务、会话和后台作业按 BI 登录账号隔离，并继续受店铺读写权限约束。
- Owner/合伙人保留 `scripts/bi_ops_cli.mjs`。`--scope-all` 只是 Owner 的全局只读 jobs 视图，不能替其他账号静默写入；`--profile` 也不改变权限、人工确认或回读要求。
- 模型按成本和风险分层：结构化意图 `Luna/low/20s`；常规问数 `Terra/low/45s`；动作规划 `Terra/medium/90s`；复杂或高风险分析 `Sol/high/300s`；Owner CLI 深度诊断 `Sol/high/600s`。`xhigh` 只允许 Owner 人工显式请求，网页禁止 `max/ultra`。
- 自动运营 runtime 使用 PostgreSQL `ops.link_ops_*` 行级表，session/message/task/record/job/event/idempotency/import batch 分开保存。revision 做乐观并发控制，idempotency 防重复，event 追加不可改，job 用租约恢复；数据库不可用时生产失败关闭，不静默回退 JSON。
- 2026-07-11 切换采用空白任务/会话：旧 31 个任务、4 个会话和 15 条消息只保留在已校验备份，不导入新网页。执行迁移脚本时必须带 `--skip-legacy-conversations`；其他 BI 业务数据、账号与店铺权限不受影响。
- 迁移顺序：JSON/数据库备份 -> `--dry-run --skip-legacy-conversations` 核对 manifest -> `--execute` -> PG hash/数量回读 -> 导出 PG rollback snapshot -> 创建受限 `shein_link_ops` 角色 -> 安装 unit -> 重启 portal -> 网页/API/CLI 验收。
- 回滚时先停写，保留 PG 证据，切回 JSON repository 并使用切换前备份或 `scripts/export_link_ops_postgres_snapshot.mjs` 的快照；不要直接删业务库或篡改 event。

### 负责人经验单向同步

- 只有 `config/bi_access_roles.json` 中显式 `knowledgePublisher=true` 的负责人账号和已登记设备可以写入 `owner_knowledge_*` record；普通 owner、operator、admin 和后台任务均不能发布或覆盖。
- 本机同步只读取当前项目的 Codex memory note、用户消息和最终答复，并在本机与服务端各做一次脱敏；reasoning、tool output、其他项目会话、来源路径、设备 token 和无标签高熵疑似凭证不进入 GitHub。session 新旧顺序使用事件内 timestamp，未来或非法 timestamp 只进入 candidate，不能长期占位或覆盖 active。普通同事页面不展示规则版本、fingerprint 或内部任务快照。
- 服务端使用现有 PostgreSQL Link Ops repository 保存 immutable version、current pointer、active bundle、distribution snapshot 和 device；candidate 不进入团队业务上下文。`machinePolicy` 只按服务端 `ruleKey` 白名单推导，客户端提交的同名对象不会进入存储或分发。规则变化后旧 intent job 结果和旧系统检查均 fail closed。
- 云端使用独立工作树 `/srv/shein-bi/owner-knowledge-repo` 和独立可写 deploy key，把 active bundle 推送到 GitHub `owner-knowledge` 分支。该分支只有脱敏 bundle、manifest 与校验代码；Portal 主工作树的脏状态不会被 publisher 暂存或提交。push 回读成功后只登记 pending，必须等 GitHub Actions 校验 fingerprint/hash 并调用专用激活端点后才切 current。
- systemd 必须配置 `SHEIN_OWNER_KNOWLEDGE_GIT_REPO_DIR`、`SHEIN_OWNER_KNOWLEDGE_GIT_BRANCH`、`SHEIN_OWNER_KNOWLEDGE_GIT_LOCK_FILE` 和一小时 reconciliation。禁止把 GitHub 私钥放进项目、environment file 或日志；私钥只放 `/home/sheinops/.ssh/`，权限 `600`。
- 云端检查：加载 `/srv/shein-bi/secrets/portal-warehouse.env` 后运行 `node scripts/owner_knowledge_admin.mjs status`；强制重试分发使用 `node scripts/owner_knowledge_admin.mjs publish --force`。同时检查 GitHub `Owner knowledge distribution` workflow。只有 workflow 成功且 `distribution.ready=true + current=true + source=github + sourceCommit` 非空才算 GitHub 与云端追平；激活 token 只放 GitHub Actions secret 与云端私有 environment file，不进入 unit、仓库或日志。
- Windows 常驻任务名为 `SHEIN-Owner-Knowledge-Sync`。任务应保持 `Running`，文件变化 15 秒去抖后同步，启动和每 60 分钟 reconciliation；`sync-state.json` 不再每分钟空转更新。网络失败不会推进 offset，恢复后自动幂等补传。
- 合伙人 CLI 不持有 GitHub token：每个云端业务命令前读取 Portal manifest，ETag 未变化返回 304；变化时在带心跳/进程存活校验的跨进程锁内写入不可变 `generations/<bundleSha256>/bundle.json`，写前拒绝版本回滚，校验通过后原子切换 manifest pointer。旧 generation 不自动删除。GitHub distribution 未追平或执行准备期间规则 generation 改变时，服务端会对网页、聊天和 CLI 的真实 `execute` 统一失败关闭。
- API 出现 401 时先检查/轮换设备凭证；403 表示当前账号本就没有发布权，不得给同事账号补权限；5xx 先查 `shein-bi-portal` 日志、PostgreSQL 健康和 `npm test`，不能绕过规则层直接改任务 JSON。

- `/home/sheinops/.codex` 已安装 `my-codex` agents/skills/agent-packs/AGENTS 配置；安装前已备份 `.codex` 私有配置到 `/home/sheinops/.codex-backups/`，备份文件不得进入 GitHub。

- `my-codex` 的远程 MCP OAuth 注册在非交互服务环境里不作为生产依赖；生产问数链路仍只依赖本地 Codex CLI、`CODEX_HOME` 和只读 BI JSON 上下文。



2026-05-19 云端 Codex 运行环境修复口径：



- `/home/sheinops/.codex/auth.json` 可由本机私有 `auth.json` 手动覆盖更新；更新前先备份，文件权限保持 `600`，不得提交 GitHub。

- 服务器已安装 `bubblewrap`，并修复 `/home/sheinops/.codex/sessions` 属主为 `sheinops`；`kernel.apparmor_restrict_unprivileged_userns=0` 写入 `/etc/sysctl.d/99-codex-bubblewrap.conf`，以允许 Codex Linux sandbox 使用 user namespace。

- `~/.codex/config.toml` 使用 `[features] hooks = true`，不再使用过期 `codex_hooks`。

- 冒烟命令：`cd /tmp && CODEX_HOME=/home/sheinops/.codex timeout 120 codex exec --sandbox read-only --skip-git-repo-check "只回复 OK，不要解释。" < /dev/null`。若只出现短暂 `Reconnecting...` 但最终返回 `OK`，按网络抖动处理，不视为配置失败。



2026-05-19 链接/业务域日更故障修复口径：



- 故障表现：销售 WebAPI 正常，但链接表现进入 SBN 商品分析页时被重定向到登录页，导致 `/sbn/new_goods/get_skc_diagnose_list` 抓不到 `x-gw-auth`，`shein-bi-cloud-link-business.service` 失败。

- 修复：`scripts/bootstrap_shein_browser_session.mjs` 现在会把新鲜 WebAPI cookie 与浏览器导出的子系统 `localStorage/sessionStorage` 合并使用，避免只用 WebAPI cookie 时丢掉 SBN 子系统状态。

- 兜底：`scripts/cloud_link_business_sync.sh` 支持部分店铺失败继续执行并记录 `state/cloud_ops_alerts/link-business-last-partial.json`；默认不把部分成功结果入仓刷新 BI，避免把不完整链接/业务域日期展示成全量成功。

- 恢复手段：若云端 SBN 子系统态整体失效，可在本机用 `scripts/auto_relogin_shein_store.mjs` 恢复对应店铺、再用 `scripts/export_shein_browser_session.mjs` 导出 `state/shein_browser_sessions/*.local.json` 并同步到云端私有同名目录；这些 session 文件是敏感运行态，不进 GitHub。若失败页面其实是协议签署 / 公告 / 通知确认挡住登录按钮，应先在可见/noVNC 窗口中关闭或确认普通弹窗并再次点击登录，然后导出/回灌 session；不要只看 `login_not_restored` 就认定必须用户扫码。
