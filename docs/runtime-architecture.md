# 运行环境架构

## 2026-05-15 当前运行环境摘要

- SHEIN 销售抓数、BI 后置刷新和数据库备份已切到云端 systemd；本地 BI 和 `SHEIN-*` Windows 计划任务已封存禁用。
- 飞书多维表格 / 原生看板写入已临时暂停；飞书日报、异常通知 watchdog 和只读问数机器人已云端化并验证。
- 销售抓取主入口已改为 Node WebAPI 直连优先；16 店 `salesTransport=auto`，成功时不启动浏览器，浏览器只保留为 Cookie/session 刷新、登录续期和回退工具。
- 暂停开关为 `state/feishu-base-sync-paused.flag`；存在该文件时跳过飞书事实表、产品表、月表、宽表和看板写入，删除后可恢复。
- 云端当前自动覆盖销售 WebAPI、销售入仓、BI Portal 生成、数据库备份、ET 货代仓同步、飞书日报、链接/业务域日更、完整 RTV 复核、异常通知和 HL OpenAPI 双跑。
- HL 正式 profile 为 `profiles/persistent-shein-main-profile`，CDP 端口 `9360`；旧 `profiles/persistent-hl-profile` 已删除。
- `2026-05-09 05:30` 链接/业务域任务、`2026-05-09 07:00` BI 每日流水线和 `SHEIN-Sales-ETForwarder-0420` 是本地历史验证记录；自 `2026-05-15` 起不再作为生产调度。
- `2026-05-11` WebAPI 全店销售抓取资源实测：16 店 `2026-05-08` 直连抓取耗时 `15.09s`，项目 Node 峰值约 `60.44MB` working set / `55.82MB` private，不额外启动店铺浏览器；证据见 `outputs/cloud-migration/webapi-allstores-resource-20260511-201715.json`。

## 结论

不全量切到 WSL，也不把业务逻辑写成 PowerShell。

推荐架构：

- 工作区：所有项目文件、脚本、配置、日志、浏览器 profile、截图证据都放在 `E:\Codex WorkSpace\Shein销售统计`。
- 脚本语言：优先 Python / Node，保持跨平台和可维护。
- PowerShell：只作为 Windows 上的薄启动器，用来启动 Chrome 或计划任务，不承载核心业务逻辑。
- WSL2：适合跑数据处理、文本处理、批量脚本；但不是 SHEIN 浏览器自动化的主执行环境。
- Windows Chrome：保留 SHEIN 登录态、Cookie/session 刷新和页面自动化回退；销售主链路已 WebAPI 直连优先。Chrome profile 仍使用工作区内的 `profiles/` 作为 `--user-data-dir`，避免占用默认 C 盘 Chrome 用户目录；只有登录、验证码、人机校验或排障时才打开可见 Chrome。
- 飞书写入：当前 `lark-cli` 在 Windows 侧可用；但飞书 Base / 看板写入受 `state/feishu-base-sync-paused.flag` 控制，暂停期间只保留飞书 IM 日报和异常提醒。

## 当前云端 systemd 调度（北京时间）

- `shein-bi-cloud-today.timer`：`00:10/02:10/.../22:10` 每两小时刷新当天销售、入仓并生成 BI Portal。
- `shein-bi-cloud-yesterday.timer`：每天 `00:10` 刷新前一天最终销售，并复核前两天稳定日。
- `shein-bi-db-backup.timer`：每天 `02:30` 备份业务库和 Metabase 元数据库到 `/srv/shein-bi/backups/auto`。
- 本地 `SHEIN-*` Windows 计划任务已全部禁用，只保留为回滚和 Linux 迁移参考。

本地回滚时的 Windows 安装/更新入口：

`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install_windows_scheduled_tasks.ps1 -IncludeWatchdog`

回滚时 Windows 计划任务 Action 不直接调用 `powershell.exe -File ...`，而是调用 `wscript.exe` 执行 `scripts/run_scheduled_hidden.vbs`，再隐藏启动对应 `.ps1`。这样即使同步任务运行十几分钟，也不会在前台留下黑色命令行窗口。任务最长运行时间为 90 分钟，避免后台卡死影响下一次同步。

## SHEIN 销售 WebAPI 直连边界（2026-05-11）

- `fetch_shein_sales.mjs` 支持 `--transport browser|webapi|auto`；默认从 `config/stores.json` 的 `salesTransport` 或环境变量 `SHEIN_SALES_TRANSPORT` 读取。
- `state/shein_webapi_sessions/<店铺>.local.json` 保存导出的 Cookie header、User-Agent 和 client hints，是敏感本地运行态；该目录在 `state/` 下，不进入 GitHub。
- `run_sales_sync_job.mjs` 在 `auto` / `webapi` 模式下先直连 SHEIN 后台 WebAPI；直连成功时记录 `webapi_transport_succeeded_without_browser_launch`，不调用 `launch_store_browser.mjs`。
- WebAPI 直连失败、session 缺失或返回 `20302` 时，脚本才启动对应店铺 Chrome 刷新 session / 自动登录 / 回退浏览器抓取。
- SHEIN Cookie 通常会随活跃访问续期，因此每天跑一次 WebAPI 有助于保持 session；ET 货代仓不是这个规律，仍按 ET 专属自动登录 + OCR 处理。
- `2026-05-08` 已完成 16 店 WebAPI 与现有数据库对账，订单数、商品行数、正销量和销售额一致；全店直连资源证据见 `outputs/cloud-migration/webapi-allstores-resource-20260511-201715.json`。

## 为什么不全用 WSL

- SHEIN 登录态和 Chrome UI 自动化天然在 Windows Chrome 上更稳。
- 当前 `lark-cli` 已在 Windows 侧配置好授权，WSL 里没有直接安装。
- WSL 调 Windows GUI/Chrome 可行但链路更绕，长期定时任务出错点更多。

## BI 系统的 WSL 边界

2026-05-01 开始，新的专业 BI 系统采用“新系统 WSL 化、旧生产链路暂不动”的策略：

- Metabase、Metabase 配置库、SHEIN 数据仓库通过 Docker 跑在 WSL。
- WSL 发行版已迁移到 `D:\WSL\Ubuntu-24.04`。
- Docker 数据根已迁移到 `D:\SheinBI\docker-data\docker-data.ext4`，实际挂载到 WSL 内 `/mnt/wsl/shein-docker-data/docker`。
- 本地旧销售抓取、飞书日报和 Windows 计划任务已封存；其中销售抓取逻辑已迁到云端 WebAPI 直连优先，Chrome 仅保留为回退/登录续期工具。飞书 Base / 看板写入已通过暂停开关临时停用，直到用户确认恢复并完成云端化。
- 后续新写的 BI 数据入仓、规则引擎、Metabase 配置脚本，优先按“可迁移到 Linux 服务器”的方式设计，减少 PowerShell 业务逻辑。

也就是说：**BI 底座可以先 WSL/服务器化，但不要为了统一环境去冒险迁移已稳定的飞书生产链路。**

## 为什么不把业务逻辑写 PowerShell

- PowerShell 适合启动 Windows 程序，不适合承载复杂抓取、解析、聚合、幂等写表逻辑。
- 后续核心逻辑统一沉淀到 Python / Node，方便测试、复用和迁移。

## C 盘使用边界

允许使用：
- 已安装的 Windows Chrome 程序；当前自动探测优先 `C:\Program Files\Google\Chrome\Application\chrome.exe`，D 盘路径只作兜底。
- 已配置好的 `lark-cli.exe`。
- 系统/工具本身已有缓存。

不主动写入：
- 项目脚本。
- SHEIN 浏览器 profile。
- 抓取日志。
- 页面截图/证据。
- 统计结果。
- 项目 skill。

这些都写入当前工作区。

## 浏览器 profile 与磁盘瘦身边界（2026-05-02）

16 店 SHEIN 登录态保存在工作区内的独立 Chrome profile。不要删除整个 `persistent-*` 目录；登录态通常在 `Profile 1`、`Default`、`Network`、`Local Storage`、Cookies/Session 相关文件中。

2026-05-10 已复核 16 店 profile 显示名与登录抓数：`PROFILE_NAME.txt`、Chrome `Preferences`、Chrome `Local State` 均与 `config/stores.json` 一致；用稳定日期后台重抓对账数据库，未发现登录错位。`YJ / XL / QY` 的 `profileKey` 名称与店铺代码不一致是历史遗留，不是错误。

当前店铺映射：

| 店铺 | profile 目录 | CDP 端口 |
|---|---|---:|
| DL | `profiles/persistent-dl-profile` | 9333 |
| DX | `profiles/persistent-dx-profile` | 9334 |
| FY | `profiles/persistent-fy-profile` | 9335 |
| LQ | `profiles/persistent-lq-profile` | 9336 |
| NM | `profiles/persistent-nm-profile` | 9337 |
| HL | `profiles/persistent-shein-main-profile` | 9360 |
| JY | `profiles/persistent-jy-profile` | 9339 |
| ZL | `profiles/persistent-zl-profile` | 9340 |
| TS | `profiles/persistent-ts-profile` | 9341 |
| MZ | `profiles/persistent-mz-profile` | 9342 |
| CX | `profiles/persistent-cx-profile` | 9343 |
| YJ | `profiles/persistent-qy-profile` | 9346 |
| XL | `profiles/persistent-yj-profile` | 9344 |
| QY | `profiles/persistent-xl-profile` | 9345 |
| QH | `profiles/persistent-qh-profile` | 9347 |
| TZ | `profiles/persistent-tz-profile` | 9348 |

补充说明：

- 旧 `profiles/persistent-hl-profile` 已删除；当前 HL 正式使用 `profiles/persistent-shein-main-profile`。
- `YJ=profiles/persistent-qy-profile`、`XL=profiles/persistent-yj-profile`、`QY=profiles/persistent-xl-profile` 是当前正确生产绑定；不要仅按目录名直觉互换。
- `profiles/persistent-feishu-profile` 是飞书网页登录态，用于看板富文本、卡片样式和页面自动化，不属于 16 店 SHEIN 登录。
- Chrome 自动生成的 `OptGuideOnDeviceModel` 是重复模型缓存，不是登录态。等同步任务和 Chrome 进程停止后，可只删除各 profile 下的 `OptGuideOnDeviceModel` 来释放约 30GB+。
- 瘦身时不要动 `Profile 1`、`Default`、`Network`、`Local Storage`、Cookies/Session 相关文件。
- 2026-05-02 文件整理报告见 `outputs/cleanup/project-file-cleanup-2026-05-02.md`；误生成的 `E:\Codex` 已归档到 `backups/file-cleanup-20260502T125310/E-Codex-stray-chrome-profile`。

## 前台窗口策略

- 非必要情况下不要打开前端/可见浏览器窗口；默认用后台、headless、HTTP/CDP、日志、JSON、静态检查和 UI 冒烟脚本验证。只有首次登录、验证码/人机验证、用户明确要求看前台、或必须排查浏览器交互问题时，才打开可见窗口；完成后应关闭。

- 主方案：定时同步通过 `run_sales_sync_job.mjs` 自动启动无界面 Chrome，不占任务栏。
- 如果某店重启后 headless Chrome 起不来，`run_sales_sync_job.mjs` 会自动尝试后台窗口模式作为兜底；这只用于恢复抓取可用性，不代表要常驻前台窗口。
- `launch_store_browser.mjs` 使用 `detached=false` + `unref()` 启动 Chrome，避免 Windows/Node 下 detached Chrome 偶发 libuv assertion，同时不让启动器阻塞终端。
- 计划任务启动器：使用 `wscript.exe` + `scripts/run_scheduled_hidden.vbs` 隐藏 PowerShell 控制台，避免同步期间前台出现长期停留的 cmd/PowerShell 黑窗。
- 可见窗口：仅用于首次登录、验证码、人机校验、保存密码选择或人工排障。
- 兜底方案：`--background-browser` / `--background` 会把窗口最小化/离屏，但仍可能在任务栏出现，不作为首选。
- 不推荐把 Windows 多桌面作为主方案：它只是把窗口移动到另一个桌面，仍依赖前台 GUI 会话，重启、调度和焦点稳定性不如 headless。
- 若前台窗口已经打开，可用 `scripts/close_store_browsers.ps1 -Group DSY` 安全关闭工作区店铺 Chrome；脚本会按工作区 profile 路径校验，避免误关用户的普通 Chrome。

## 登录态掉线与自动恢复经验（2026-04-28）

现象：页面仍可能显示“我的订单”，但接口 `/gsp/orderPlus/listOrder` 返回 `code=20302`、`msg=子系统登录重定向`。这种情况应按“接口登录态失效”处理，不能只看页面标题或页面内容。 页面文本里出现某个店铺号也不等于当前登录主体；核验 profile 是否错位时，必须用实际订单接口 + 稳定日期重抓 + 数据库样本对账。当天数据会继续变化，不适合作为最终错位判断样本。

处理流程：

1. 先查看 `logs/scheduled/` 和 `logs/jobs/`，确认失败范围。
2. 如果只有某个分组失败，例如 DSY 10 店全部 `20302`、LGM 正常，则优先恢复失败分组，不要重跑全部历史。
3. 使用 `scripts/auto_relogin_shein_store.mjs` 恢复登录态：
   - 示例：`node scripts/auto_relogin_shein_store.mjs DL,DX --date 2026-04-28 --visible`
   - 脚本只检查账号/密码输入框是否已有值，并点击登录按钮；不读取、不输出账号密码。
   - 如果出现验证码、人机校验、短信验证，脚本不能绕过，应打开可见窗口让用户处理。
4. 登录恢复后，补跑当天同步：
   - 示例：`node scripts/run_sales_sync_job.mjs --date 2026-04-28 --status 当天同步 --group DSY --no-monthly --no-compact-display --no-dashboard`
5. DSY 与 LGM 都成功后，再统一刷新派生展示层，避免半新半旧：
   - `node scripts/generate_monthly_sales_table.mjs --month YYYY-MM --include-lgm`
   - `node scripts/generate_compact_display_tables.mjs --group ALL --current-month YYYY-MM --recent-months 2`
   - `node scripts/setup_lark_dashboard_main_v3.mjs --month YYYY-MM`
   - `node scripts/setup_lark_dashboard_previous_month.mjs --month YYYY-MM`
6. 若店铺事实已写入但产品/月表/看板后续步骤遇到飞书临时 `HTTP 500` / `5000`，应从失败环节开始补跑；任何上游失败都不能继续刷新主看板。

## 16 店看板刷新

- 当前有两个正式 Dashboard：
  - 当月主看板：`SHEIN经营看板 v3-主看板`，刷新脚本 `node scripts/setup_lark_dashboard_main_v3.mjs --month YYYY-MM`。
  - 上月看板：`SHEIN经营看板 v3-上月`，刷新脚本 `node scripts/setup_lark_dashboard_previous_month.mjs --month YYYY-MM`。
- 看板不直接读取大明细表，也不依赖 Dashboard filter；当月读取 `看板数据-MAIN-*`，上月读取 `看板数据-PREV-*` 小型聚合表，避免飞书前端出现“配置数据发生变更，请重新配置”。
- 核心指标卡读取 `KPI*` 专用字段；`看板数据-MAIN-范围汇总` 的 `全部/DSY/LGM` 三行不能直接做统计卡 `SUM`，否则会重复求和。
- 主看板和上月看板的 `数据时间说明` 是飞书内部 `RICH_TEXT` 组件。公开 Dashboard 更新接口只能安全更新普通图表配置；更新已存在 text block 的 `data_config.text` 会把 Markdown 变成带引号的普通字符串，导致字面量 `\n`、字体不生效，甚至显示“加载失败”。因此不要再用公开接口改它；当前正式刷新脚本会通过 `scripts/update_dashboard_time_richtext_ui.mjs` 使用已登录飞书网页 profile 调用内部富文本保存链路更新时间块。
- 富文本时间块更新是 best-effort：数据源先刷新成功，再更新时间块；若飞书页面偶发 `Target page, context or browser has been closed`、超时或网络抖动，`setup_lark_dashboard_main_v3.mjs` 会自动重试 3 次。多次失败时不阻断销售数据源刷新，但需要后续补刷时间块并排查飞书 profile 登录态。若时间块更新卡住，可先用 `node scripts/setup_lark_dashboard_main_v3.mjs --month YYYY-MM --no-richtext-time` 发布核心数据源，再单独处理时间块。
- 看板视觉规范：顶部 KPI 卡、趋势图和店铺榜按口径统一分色，全部/合计=绿色系，`DSY`=蓝色系，`LGM`=橙色系；产品榜使用紫粉系。店铺排行标签只显示 `01 DX` 这种排名+店铺代号，分组由颜色表达，不再在标签里显示 `DSY/` 或 `LGM/`。
- 用户会在飞书前端手动微调正式看板布局和组件大小；自动刷新脚本默认不得重排、不得重建无关组件、不得改变布局。`setup_lark_dashboard_main_v3.mjs` 默认 `arrange=false`，只有用户明确同意时才传 `--arrange`。
- 定时同步不在 DSY/LGM 单组任务内刷新看板；两组都成功后，由包装脚本统一调用当月主看板和上月看板刷新脚本。
- 恢复完成后，用 `scripts/close_store_browsers.ps1 -Group DSY` 或 `-Group LGM` 关闭为登录打开的可见窗口，后续定时任务继续用 headless。

关键避坑：SHEIN 登录 URL 的 redirect 参数必须是合法 base64。不要把 `/gsp/order-management/list` 这类带 `-` 的原始路径直接拼到 `/login/GMPSSO/` 后面，否则会触发 `Illegal base64 character 2d` 的服务端错误弹窗。

## 2026-04-28 登录失效自动恢复硬规则

- 定时同步/手动同步遇到 SHEIN 接口返回 20302 子系统登录重定向 时，不能直接把失败信息和本地旧数据当成最新结果继续发送或展示。
- scripts/run_sales_sync_job.mjs 默认启用自动恢复：先调用 scripts/auto_relogin_shein_store.mjs 使用已保存的浏览器账号密码恢复登录态，再重新抓取该店当天数据，只有重新抓取成功后才写入飞书事实表并刷新看板。
- 如果自动恢复失败，任务必须把该店标为失败/需要人工登录；日报或告警应明确提示，不得把旧文件里的销售额冒充为最新数据。
- 可选参数：--no-auto-relogin 仅用于排障禁用自动登录；--relogin-visible 默认用于验证码/保存密码场景；--relogin-headless 可用于无界面试验。
- 若保存密码看似没有命中，先确认启动时是否使用了对应店铺 profile 和 `--profile-directory=Profile 1`。2026-05-03 的 JY 告警就是因为登录态掉线且自动恢复未命中 profile，人工登录后已补跑 `2026-05-02` 最终版和 `2026-05-03` 今日数据。
- 2026-04-28 已用 LGM 组重跑验证：CX/YJ/XL/QY/QH/TZ 今日抓取与写入成功，合计 1243.06 SAR。

## 数据抓取时间展示规则

- SHEIN 日报文字、日报图片和 BI 门户必须显示“数据抓取时间”；图片/门户可同时显示生成时间或刷新时间，但不能只显示生成/刷新时间。销售数据抓取时间优先取当日各店 `outputs/shein_fetch/<store>/<date>.json` 的最新 `fetchTime`。
- 飞书 Base / 看板写入暂停期间，正式看板顶部富文本时间块不会随定时任务自动刷新；恢复 Base / 看板写入后，仍使用内部保存链路更新时间块，并带 3 次轻量重试。

## 逻辑体检

- 体检脚本：`node scripts/audit_shein_sales_logic.mjs --month YYYY-MM --date YYYY-MM-DD`
- 体检脚本读取飞书云端组件时会对 `EOF`、`HTTP 500/5000`、限流、证书/CDN 抖动做轻量重试，避免临时网络波动造成假失败。
- 体检内容包括：
  - DSY/LGM 店铺分组是否重叠或漏店；
  - `ALL = DSY + LGM` 是否成立；
  - 产品明细合计是否等于店铺日销合计；
  - 看板顶部统计卡是否全部读取 `KPI*` 字段；
  - 定时任务是否先完成两组同步，再统一刷新月表/宽表/看板；
  - 日报任务是否避免在发送前执行年度汇总、周/月宽表等重刷新。



## 2026-04-29 HL 时区复核结论

- HL 后台页面时区已确认正确；系统曾统计错误，是因为本地店铺配置里保留过猜测性的 `accountUtcOffsetHours=3`，导致抓取查询区间被额外换算成 `19:00~18:59`。
- 已删除 HL 特殊偏移配置，并回补 HL `2026-02-04` 至 `2026-04-29`。后续默认规则：除非用户明确确认某店后台日期口径不同，否则所有店按后台日期直接查询北京时间自然日，不做单店额外偏移。
- 受影响后处理：重刷对应月份的店铺月表、产品日事实、年度汇总、产品周/月宽表、订单/SKC 明细和看板，再运行逻辑体检。
- 飞书接口出现 `tls/x509/certificate/not open.feishu.cn` 这类证书/CDN 抖动时应自动重试，不能发布半新半旧数据。


## 2026-04-29 月表保留与上月看板策略
- 独立月度展示表只保留当月和上个月：例如当前为 2026-04 时，只保留 `月度日销-2026-04`、`月度日销-2026-03` 以及对应 `产品日销量-YYYY-MM`；更早月份进入年度汇总表。
- `generate_compact_display_tables.mjs` 默认 `recentMonths=2`，每月过完后会自动把新的当月/上月作为保留集合，并把更早独立月表列入 `cleanupCandidates`，删除仍需用户确认。
- 当前有两个 Dashboard：`SHEIN经营看板 v3-主看板`（当月滚动）和 `SHEIN经营看板 v3-上月`（上月完整）。上月看板使用 `看板数据-PREV-*` 五张轻量数据源，避免与当月 `看板数据-MAIN-*` 互相覆盖。
- 看板继续使用轻量聚合数据源，而不是直接读取订单/SKC 大明细表；这样更稳、更快，也避免 Dashboard 直接扫事实表时筛选和排序不稳定。优化方向是减少重复数据源和字段，但不要让看板直接读大明细表。

# 2026-05-15 云端调度与本地封存

- 生产调度已切到云端 systemd timer：`shein-bi-cloud-today.timer` 每两小时刷新当天销售、入仓并生成 BI Portal；`shein-bi-cloud-yesterday.timer` 每天 `00:10` 刷新前一天最终销售并复核前两天稳定日；`shein-bi-db-backup.timer` 每天 `02:30` 做数据库备份；`shein-bi-cloud-link-business.timer` 每天 `05:30` 顺序抓取前一完整日链接/业务域并刷新 BI。
- 本地 `SHEIN-*` Windows 计划任务已封存禁用。`scheduled_intraday_dsy.ps1`、`scheduled_yesterday_final_dsy.ps1`、`scheduled_link_management_daily.ps1`、`scheduled_et_forwarder_daily.ps1`、`scheduled_bi_daily_pipeline.ps1` 等只保留为回滚/迁移参考，不再作为生产调度。
- 云端当前自动覆盖销售 WebAPI、销售入仓、BI Portal 生成、数据库备份、ET 货代仓同步、飞书日报、链接/业务域日更、完整 RTV 复核、异常通知和 HL OpenAPI 双跑。
- 旧独立链接管理计划任务 `SHEIN-Sales-15Stores-LinkManagement-0340` / `SHEIN-Sales-15Stores-LinkManagement-0510` 已删除；`SHEIN-Sales-15Stores-LinkManagement-0530` 是本地历史任务，已封存。
- HL 旧子账号 profile `profiles/persistent-hl-profile` 已删除；正式 HL profile 为 `profiles/persistent-shein-main-profile`，CDP 端口 `9360`。
- 飞书定时任务和写表链路都通过 `config/stores.json` 获取 HL profile；当前生产脚本中没有旧 HL profile、旧端口 `9338` 或 `profileKey=hl` 引用。
- 后置 BI 刷新失败时只记录日志，不应反向影响销售源抓取。
- 判断“滚动 BI 是否更新”时，先看目标日 16 店销售源文件、云端刷新日志、入仓步骤、`outputs/bi-portal/data.json` / `index.html` 的更新时间；不要把 RTV 复核运行时间长当成 BI 未更新。



## ET 前台窗口规则
- ET 货代仓也适用“非必要不打开前端窗口”：`scripts/fetch_et_forwarder.mjs` 默认 `visible=false` 并用 `WindowStyle Hidden` 启动 Chrome；自动登录优先走 `scripts/et_login_helper.py` + OCR。只有 OCR/验证码连续失败、登录态必须人工处理、用户明确要求，或必须排查浏览器交互问题时，才允许临时加 `--visible` 打开 ET 前台窗口，处理完必须关闭。

## 2026-05-17 云端智能体运行边界

- 云端已具备生产飞书问数链路：`shein-bi-lark-sales-qa.service` 常驻消费飞书消息，调用 `scripts/lark_sales_qa_bot.mjs`，再通过 Codex CLI 只读网关回答销售、店铺、货号、链接/覆盖相关问题。
- Codex CLI 私有运行目录固定为 `/home/sheinops/.codex`；其中 `auth.json`、`config.toml` 和第三方 API 凭据仅存在服务器，不纳入 GitHub。
- 飞书或 BI 网页不得直接暴露 shell / 裸 Codex CLI；必须经过 Node 网关做边界控制、输入约束、超时、只读上下文压缩和失败兜底。
- 生产问数不再依赖本机 Codex App 或本地浏览器；本机只作为开发、排障和回滚环境。
- 后续若把 BI 页面自然语言入口接到云端 Codex，也只能先做“只读回答 + 任务草案”，写操作必须进入任务池等待人工确认。

## 2026-05-17 公网域名入口

- 正式域名入口为 `https://shein-bi.faceair.me/`，DNS 指向腾讯云服务器 `43.165.167.135`。
- 服务器 443 端口同时承担 SSH 运维入口和 HTTPS 入口：`HAProxy` 在 443 做协议分流，SSH 流量转到本机 sshd `127.0.0.1:22`，HTTPS 流量转到 Caddy `127.0.0.1:10443`。
- Caddy 负责 `shein-bi.faceair.me` 的自动 TLS 证书和 HTTP -> HTTPS 跳转；nginx 退到本机 `127.0.0.1:8080`，继续保留原 Basic Auth，并反代到 BI Portal `127.0.0.1:8787`。
- 对应配置模板：`infra/haproxy/haproxy-ssh-https.cfg`、`infra/caddy/Caddyfile.shein-bi`。不要直接让 Node 服务暴露公网。

