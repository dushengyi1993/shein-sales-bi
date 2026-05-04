# MEMORY

## 评价全量与平台翻译（当前权威）
- 评价/口碑底库必须按每个店开店以来全量补抓；日常评价同步默认只抓最近 `14` 天作为增量防漏窗口，不要再用 90 天这种过长窗口浪费后台资源。
- 评论翻译使用 SHEIN 后台评论列表接口的 `translate: 1` 平台翻译，写入 `fact.product_comment.goods_comment_content_zh`，`translation_provider='shein-platform'`；不再使用本地启发式翻译、浏览器插件或第三方插件作为正式结果。
- 当前全量结果：`fact.product_comment` 共 `1776` 条，`1774` 条有 SHEIN 平台译文；剩余 2 条为原文为空的评价，无需翻译。全量补抓脚本为 `scripts/backfill_shein_comments_full_history.mjs`，日常业务域抓取为 `scripts/fetch_shein_business_domains.mjs`。
- SHEIN 评论接口宽窗口会报 `mgs97906 数据量太多...缩小评论时间`；全量补抓必须按日期窗口分段，并在必要时自动拆分。

## 2026-05-03 BI 链接对比 / 制冰机归并 / 评价翻译
- 货号页和动作池遇到重复弱链接时，必须从全量 `DATA.storeLinks` / 链接仓库取同店同标准货号链接，不能显示“页面明细池未取到完整同组链接”这类退缩兜底。
- 链接对比指标统一按 `曝光 -> 访客 -> 销量 -> 支付率` 展示，并在每个指标下显示 `7天 / 30天`。
- `制冰机`、`03038`、`SK-03038`、`SK-03038???` 等统一归并到 `SK-03038制冰机`。
- 评价中文翻译写入 `fact.product_comment.goods_comment_content_zh`，提供者记录为 `shein-platform`；日常 BI 流水线由业务域抓取/入仓链路直接写入 SHEIN 平台译文，不再运行本地启发式翻译脚本。

## 2026-05-03 BI 货号 / 评价 / 动作池口径补充
- 货号 360 的 `本店货号合计销售` 是当前时间段内“店铺 + 标准货号”的全部 SKC / 链接合计销售，不是最佳 SKC 单独销售；最佳 SKC 只用于承接、替代和弱链接对比。
- `本货号待处理动作` 遇到重复弱链接时，必须展示同店同款对比；若页面明细池没有完整同组链接，也要解析动作池证据，展示当前 SKC、最佳链接线索、弱链接与最佳链接 7/30 天销量差距，不能直接写“暂无可比对”。
- `SKC 数据复核区：订单 / 财务 / 售后互证` 只是复核区，用来确认订单、财务、售后是否能互相印证，不是新的每日动作清单。
- 评价 / 口碑页必须受顶部时间段筛选；评价中文翻译应在每日评价抓取时批量写入数据库字段，页面保留原文和中文并存，不依赖浏览器插件实时翻译。
- 今日动作池不得把 `weakC30=...`、`bestC30=...`、`cases=...`、`amount=...`、`status=...` 这类代码式证据直接显示给用户，必须转成“弱链接30天销量 / 最佳30天销量 / 售后单数 / 售后金额 / 状态”等可读业务字段。
- 评价/订单售后/动作池若当前筛选为空但底库有数据，页面必须明确提示是时间段或筛选条件筛空，不允许只显示空表让用户以为数据丢失。

## 项目边界
- 工作区固定为 `E:\Codex WorkSpace\Shein销售统计`；SHEIN 脚本、配置、日志、输出、浏览器 profile、BI 门户和项目文档都优先放在这里或 D 盘，避免占用 C 盘。
- Windows PowerShell 5.1 的 `$OutputEncoding` 默认是 `us-ascii`，会把中文管道到 `node/python/lark-cli` 时变成 `?`；本机已设置用户级 PowerShell profile 为 UTF-8，并把 CurrentUser 执行策略设为 `RemoteSigned` 以允许 profile 生效。
- 项目 `.ps1` 必须 dot-source `scripts/use_utf8.ps1`，且文件保存为 UTF-8 with BOM，覆盖 `-NoProfile` 计划任务和 PS5.1 对无 BOM UTF-8 的误判；不要再用 PowerShell here-string 直接向 Node/Python 传中文生成代码，必要时用文件 UTF-8 BOM、`apply_patch` 或 Unicode escape。
- 飞书生产链路继续保留，负责正式 Base 表格、原生看板和飞书日报；BI 系统作为旁路双线运行，稳定后再逐步替换飞书展示层。
- BI 不从飞书反抓数据作为源头；源头是 SHEIN 后台抓取后的本地 JSON 与 PostgreSQL 数据仓库。
- 新建飞书 Base 数据表后，提醒用户手动扩容到 `20000` 行；默认 `2000` 行容易写满。
- 正常抓取、同步、日报、watchdog 和 BI 任务必须后台/隐藏运行；只有登录、验证码、人机校验或排障时才打开可见窗口。
- Chrome 程序路径优先使用 `C:\Program Files\Google\Chrome\Application\chrome.exe`；D 盘路径只作兜底候选。店铺登录态仍在工作区 `profiles/`，不要因为程序在 C 盘就把 profile 移回 C 盘。

## 店铺、账号与统计口径
- 当前 15 店：DSY 组 `DL DX FY LQ NM HL JY ZL TS MZ`；LGM 组 `CX YJ XL QY QH`。
- 15 店登录态保存在 `profiles/persistent-*-profile`；不要删除整个 profile。若要瘦身，只清理 Chrome 可重建缓存，例如 `OptGuideOnDeviceModel`。
- HL 已切换为主账号：`profileKey=shein-main`，CDP 端口 `9360`，正式 profile 为 `profiles/persistent-shein-main-profile`；旧 `profiles/persistent-hl-profile` 已删除。
- LGM 组当前本身就是主账号，不需要替换。
- 统计日按北京时间自然日；订单销售以 SHEIN 订单创建时间为准。除非用户明确确认，不给单店保留猜测性时区偏移。
- 固定汇率：`1 SAR = 1.8 RMB`；预测利润率默认按 `25%` 粗估，等成本和完整财务接入后替换。
- 遇到 SHEIN 接口 `20302 子系统登录重定向`，先自动恢复登录并重抓；恢复失败时明确提示人工登录，不能用旧数据冒充最新数据。

## 飞书资产与生产链路
- 正式 Base：`https://zcnm3ts63aph.feishu.cn/base/SnnQbrAu6aLzMWsnEICcy0cKnJh`。
- 当前月主看板：`SHEIN经营看板 v3-主看板`，Dashboard ID `blkFn3qHrwdsrJyX`，读取 `看板数据-MAIN-*`。
- 上月看板：`SHEIN经营看板 v3-上月`，Dashboard ID `blkWeyZhphgRZYim`，读取 `看板数据-PREV-*`。
- 旧 `看板数据-DSY-*`、`看板数据-LGM-*`、`看板数据-ALL-*` 和旧 Dashboard 已清理，不要恢复为正式链路。
- 程序化读取飞书 Base 记录时必须显式使用 `--format json`，避免解析旧格式导致误判。

## 计划任务
- `00:10`：前一天最终版销售同步、飞书表格/看板/日报链路。
- `05:30`：链接管理 15 店每日同步，任务名 `SHEIN-Sales-15Stores-LinkManagement-0530`，脚本 `scripts/scheduled_link_management_daily.ps1`；旧 `0340` / `0510` 链接任务不要恢复。
- `06:40`：BI 每日流水线，任务名 `SHEIN-BI-Daily-Pipeline-0640`；`2026-05-03 06:40` 已正式成功，Windows Last Result 为 `0`。`2026-05-02 06:40` 的 `267014` 仅保留作历史排障证据。
- `08:10 / 10:10 / 12:10 / 14:10 / 16:10 / 18:10 / 20:10 / 22:10`：当天滚动销售同步；同步后后置刷新 BI，但不得重复触发链接管理抓取或飞书链接表写入，链接只走 `05:30` 专用任务。
- 日报不再使用固定 `09:00` 任务；每天早上 `08:10` 同步成功完成后自动发送飞书文字日报和可视化日报图，上午后续成功同步可补发一次，并使用 flag 防重。
- 计划任务应通过 `wscript.exe` + `scripts/run_scheduled_hidden.vbs` 隐藏启动 PowerShell，最长运行时间 90 分钟，不要直接注册前台 PowerShell 窗口。
- 如果某个店失败，已成功店铺继续同步；只要目标日本地 15 店销售文件已齐，BI 仍应刷新，并发飞书消息提醒失败店铺。
- BI 体检里 `link_date = sales_date - 1` 是正常口径，因为链接表现每天 `05:30` 抓前一天完整日；只有链接数据落后超过 1 天才应提醒。

## 数据与货号归并
- 销售 / 订单历史已全量入 BI 仓库；链接、售后、履约、财务按价值和接口能力逐步补历史，库存只保留最新与滚动快照，不补开店以来全量。
- 标准货号清单：`config/product_catalog.json`；别名归并：`config/product_aliases.json`；归一化逻辑：`lib/product_sku_normalizer.mjs`。
- 货号开头括号备注不参与归并，例如 `（待定）SK-123`、`（废）SK-123`、`(废)SK-123` 都按 `SK-123` 处理。
- 发现无法归并、疑似新货号或只凭短号/标题拿不准的货号时，必须汇总给用户确认，不得擅自合并。

## 链接管理规则
- 飞书链接管理功能已废弃：不再写入飞书链接管理表，不再维护飞书链接看板；日常链接管理只走本地 JSON / PostgreSQL / BI 门户。
- 历史飞书链接表仅保留查档且已加前缀：`（暂废弃）链接管理-链接主数据`、`（暂废弃）链接管理-表现日事实`、`（暂废弃）链接管理-展示库存日事实`、`（暂废弃）链接管理-货号店铺覆盖`、`（暂废弃）链接管理-建议`、`（暂废弃）链接管理-今日实操清单`。
- `scripts/run_link_management_job.mjs` 默认 `BI/local-only`，不会写飞书；`scripts/sync_shein_links_to_lark.mjs` 默认拒绝执行，只有显式设置 `SHEIN_ENABLE_DEPRECATED_LARK_LINK_SYNC=1` 才允许一次性历史迁移。
- 已标 `废` 且已下架的链接只作为历史状态忽略，不进入建议或今日实操，也不提醒归档。
- 如果某货号 15 店都没有上架链接，按暂不上或库存未到处理，不进缺链接提醒；只有部分店已上架、部分店缺上架时才提醒补链。
- 待上架链接若后台返回缺证书、缺资质、缺资料、审核驳回等原因，应进入建议和实操清单。
- 备货信息里的库存口径不可信，不用于库存低提醒；正确展示库存优先来自商品列表库存接口，后续真实库存等外部系统接入。
- 今日实操清单必须保持可操作数量，不恢复到千级全量模板建议。

## SHEIN BI 系统
- 架构原则：`SHEIN 后台抓取 -> 本地 JSON / PostgreSQL 数据仓库 -> Metabase BI / 本地 BI 门户`。
- 本地 BI 门户入口：`http://127.0.0.1:8787/`；文件为 `outputs/bi-portal/index.html`；生成脚本为 `scripts/generate_bi_portal.mjs`；数据文件为 `outputs/bi-portal/data.json`。
- Metabase 运行在 WSL + Docker，Docker 数据位于 `D:\SheinBI\docker-data\docker-data.ext4`，WSL 发行版位于 `D:\WSL\Ubuntu-24.04`。
- Metabase 管理员凭据只保存在 `infra/metabase/.admin.local.json`，不要写入聊天、文档或日志。
- 当前团队访问已开放临时局域网协作：`http://192.168.2.49:8787/`，仅限 `192.168.2.0/24` 私有网络，局域网内无需账号密码，未开放公网或端口转发；共享动作状态写入 `state/bi_action_state.json`，操作审计写入 `logs/bi_portal_action_audit.jsonl`，留痕以访问 IP 为准。团队正式版上线前还需固定地址、动作状态入库、HTTPS 和备份。

## BI 门户 UI 当前规则
- 首页是“总控驾驶舱”，主要承载总览、分组、趋势和排行榜；具体操作下沉到店铺、货号 360、SKC/链接、订单/售后、动作池、系统状态等子页面。
- 首页看板筛选联动是当前首页核心口径，底层数据键为 `DATA.rankings.dailyStoreProducts`；不能只改顶部矩阵而不联动趋势和排行。
- 首页筛选区和时间筛选必须统一放在页面最上方 sticky 工具栏，不能放到 hero、经营总览卡片或页面中段；需要当前时段口径的子页面，也把时间筛选嵌入顶部筛选区，不再另做内容区悬浮时间条。
- 顶部 sticky 工具栏只放真正全局筛选：时间、店铺/分组、货号/SKC/品名、全局搜索；`业务域`、`风险`、`处理状态`、`快速聚焦` 只属于 `今日动作池` 页面局部筛选，不能影响评价、订单/售后、店铺、货号或 SKC/链接页面。
- 今日动作池是当前最新待办池，不按时间段回看；动作池页不显示时间选择窗口，也不把 `startDate/endDate/rangePreset` 写入动作池视图链接。动作池专用筛选（业务域、风险、处理状态、快速聚焦）放在页面顶部 sticky 工具栏，只影响动作池。
- 首页看板内有货号/SKC/品名筛选和店铺/分组筛选；店铺筛选必须支持 `全部店铺`、`DSY 组`、`LGM 组` 和 15 个单店。
- BI 首页货号/SKC/品名筛选中，短数字/短编号（如 `505`）应优先匹配标准货号、店铺货号、供应商货号等货号字段；不能匹配 SKC 长编号的任意中间片段。只有输入完整或较长 SKC 片段时，才匹配 SKC 字段，避免把无关货号算进动销货号。
- 首页顶部矩阵、日销趋势、月销趋势、店铺排行、产品排行都必须同时受时间段、店铺/分组、货号/SKC 筛选影响；货号 + 店铺组合要使用店铺×货号日粒度数据，不要只看全局货号汇总。
- 首页未筛选时顶部矩阵显示 `总计 / DSY 组 / LGM 组`；筛到单店或分组时显示对应范围。
- 首页日销趋势默认近 30 天，月销趋势默认过去 6 个月；选择非单日时间段后趋势跟随起止日期变化。
- 时间选择弹窗使用大号双日历，左侧开始日期、右侧结束日期；快捷按钮放在弹窗外侧。
- 顶部统一矩阵总盘包含：当前时段销售额、当前时段订单/销量/动销、当前时段退货数量、当前时段预测利润；总计、DSY、LGM 三行固定展示，数字居中并随时间段变化。
- 日销趋势和月销趋势上下排列、各占全宽；折线包含总计、DSY、LGM 三条线，纵轴使用整数刻度，关键节点显示完整数字，悬停显示完整 SAR 值。
- 排行榜显示完整店铺和标准货号，不使用小框内部滚动；店铺标签只显示 `DL / DX / HL` 这类代号，不重复写 `DSY / LGM`。
- 侧栏每个数据域只显示一条精确到秒的更新时间；数据口径日放在鼠标悬停提示里，避免同一域出现两个时间。
- 从任意子页面点击“总控驾驶舱”必须回到页面顶部。
- 支持浅色 / 深色主题；浅色主题不得出现灰底灰字。
- 店铺视角的 7 天 / 30 天链接指标必须用真正二级表头：第一行指标组，第二行周期，正文每个周期数字独立列；不要用 `<br>` 或小卡片硬拼造成错位。
- 店铺视角的低展示库存预警来自 `fact.visible_inventory_snapshot` 最新正确展示库存快照，按本店已上架且展示库存低的 SKC 全量列出；动作池库存动作只是精选待办，不代表低库存全量。
- 修 BI 门户 UI 时默认不主动打开前端；后台完成代码检查、门户生成和静态 HTML/JSON 断言后，由用户在自己的浏览器刷新查看。只有用户要求或必须排查浏览器交互问题时才打开前端。

## 工具与避坑
- SHEIN 抓取主链路是自写 Node 脚本 + Chrome DevTools Protocol/WebSocket + 工作区 Chrome profile；飞书主要用 `lark-cli`。
- `run_sales_sync_job.mjs` 在 headless Chrome 启动失败时会兜底到后台窗口模式；`launch_store_browser.mjs` 不使用 detached Chrome，避免 Windows/Node 下偶发 libuv assertion。
- `config/lark_report.json` 是日报接收人配置，必须保持合法 UTF-8 JSON；若自动日报读取失败，先校验这个文件。
- `scripts/generate_today_detailed_report_image.mjs` 用于生成只含今日数据的详尽长图，适合临时重发今日战报。
- 飞书看板富文本和卡片样式更新使用 Playwright + 已登录飞书 profile。
- PowerShell 直接运行某些 `.ps1` wrapper 容易被执行策略拦截；优先使用 `.cmd`、`.exe`、`cmd /c` 或已验证的隐藏 VBS 启动方式。
- 不要用 PowerShell here-string 写大量中文 JS/JSON，容易造成编码污染；中文字段、货号、Dashboard 名称优先用 UTF-8 文件、Node 脚本或 `apply_patch`。
- 飞书接口偶发 `EOF`、`HTTP 500/5000`、限流、TLS/CDN 抖动时应重试，不能发布半新半旧数据。

## 2026-05-03 历史乱码归档
- 原 `MEMORY.md` 和执行记录中含大量历史乱码段落，已在本次清理中归档到 `backups/doc-mojibake-archive-2026-05-03T14-20-00/`。
- 当前 `MEMORY.md` 只保留可复用、当前有效的长期规则；历史排障细节以归档文件和 `docs/` 中的权威运维文档为准。



