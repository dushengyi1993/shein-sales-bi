# SHEIN BI 系统运行说明

> 当前权威状态：2026-05-05。本文只保留接手和日常运维需要的信息；历史排障过程见 `.codex/plans/2026-05-01T14-11-55-shein-link-management-system.md`。

## 1. 当前系统定位

- 飞书生产链路继续保留，负责正式表格、看板和日报。
- BI 系统作为旁路双线运行，负责 PostgreSQL 数据仓库、Metabase 和本地 BI 经营门户。
- 不从飞书反抓数据做 BI 源头；BI 源头来自 SHEIN 后台抓取后的本地 JSON / PostgreSQL。
- BI 后置刷新失败不应反向影响飞书表格、看板和日报。

## 2. 日常入口

- 本机 BI 门户：[http://127.0.0.1:8787/](http://127.0.0.1:8787/)
- 局域网协作访问：[http://192.168.2.49:8787/](http://192.168.2.49:8787/)
- 本地门户文件：`outputs/bi-portal/index.html`
- 启动本机网页服务：双击 `打开SHEIN-BI网页服务.cmd`
- 启动局域网协作服务：双击 `打开SHEIN-BI局域网协作服务.cmd`
- Markdown 经营晨报：`outputs/bi-briefings/latest.md`
- Metabase：`http://172.22.172.186:3000`
- Metabase 管理员凭据只保存在 `infra/metabase/.admin.local.json`，不要写入文档或聊天。

## 3. 当前数据口径

- 当前 BI 截面日期：销售/订单 `2026-05-05`，售后/库存/财务 `2026-05-05`，链接表现 `2026-05-04`。
- 店铺范围：`CX DL DX FY HL JY LQ MZ NM QH QY TS XL YJ ZL`
- 分组：DSY = `DL DX FY LQ NM HL JY ZL TS MZ`；LGM = `CX YJ XL QY QH`。
- 汇率：`1 SAR = 1.8 RMB`。
- 首页利润已改为真实利润口径；若成本表未覆盖，页面显示“待成本表 / 成本覆盖率”，不再用 `25%` 粗估冒充真实利润。

## 4. 计划任务

所有生产任务都应通过 `wscript.exe` + `scripts/run_scheduled_hidden.vbs` 隐藏启动 PowerShell，不要直接注册前台 PowerShell 窗口。

| 时间 | 任务 | 说明 |
| --- | --- | --- |
| 00:10 | `SHEIN-Sales-15Stores-YesterdayFinal-0010` | 前一天最终版销售同步、飞书表格/看板/日报链路。 |
| 05:30 | `SHEIN-Sales-15Stores-LinkManagement-0530` | 前一完整业务日链接表现抓取，只写本地 / PostgreSQL / BI，不再写飞书链接表。旧 `0340` / `0510` 任务不要恢复。 |
| 06:40 | `SHEIN-BI-Daily-Pipeline-0640` | 刷新 PostgreSQL BI 仓库、BI 体检、本地门户和 Markdown 晨报。`2026-05-05` 早晨正式日志失败后已手动恢复，等待 `2026-05-06 06:40` 正式自动验证。 |
| 08:10-22:10 | `SHEIN-Sales-15Stores-Intraday-Daytime` | 当天滚动销售同步；同步后后置刷新 BI。 |
| 09:20 / 登录时 | Watchdog | 检查漏跑并补偿；不额外同步当日。 |

说明：

- `2026-05-02 06:40` 的 `267014` 是已修复的历史失败记录，保留作排障证据。
- `2026-05-05` 早晨 Docker / WSL 文件系统异常已手动恢复；下一次需要重点观察 `2026-05-06 05:30` 链接任务和 `2026-05-06 06:40` BI 任务。

## 5. 飞书与 BI 双线刷新规则

- 飞书同步仍是生产主链路。
- 00:10 最终版成功后，后置刷新前一日 BI。
- 白天滚动同步成功后，后置刷新当日 BI。
- 如果某个店失败，但目标日期 15 店本地销售文件已经齐，BI 仍应刷新，并通过飞书消息提醒失败店铺。
- 业务域单店失败不应阻断销售入仓和门户刷新，应在 BI 体检/提醒里标注。

## 6. 链接表现更新规则

- 链接表现每天更新一次即可，放在后半夜。
- 当前正式任务：`SHEIN-Sales-15Stores-LinkManagement-0530`，每天北京时间 `05:30`。
- 执行脚本：`scripts/scheduled_link_management_daily.ps1`。
- 执行内容：抓前一完整业务日 15 店链接数据，写本地 JSON、PostgreSQL 和 BI 门户；飞书链接管理表已废弃，不再写入。
- 如果部分店失败：尽量同步成功店铺，并发送飞书异常提醒。
- 旧 `SHEIN-Sales-15Stores-LinkManagement-0340` / `SHEIN-Sales-15Stores-LinkManagement-0510` 不应恢复。

## 7. HL 主账号与 profile 边界

- HL 已切换为主账号：`profileKey=shein-main`，端口 `9360`。
- 正式 profile：`profiles/persistent-shein-main-profile`。
- 旧 `profiles/persistent-hl-profile` 已删除。
- 飞书定时任务和写表链路都应读取 `config/stores.json`，不要硬编码旧 HL profile 或旧端口。
- LGM 组当前本身就是主账号，不需要替换。

## 8. BI 门户当前 UI 规则

- 首页是“总控驾驶舱”，主要承载总览、分组、趋势和排行榜。
- 首页看板筛选联动是当前首页核心口径，不能只改一个模块而不联动其它模块。
- 页面最上方 sticky 工具栏是全局筛选区，只放真正全局有效的条件：时间段、店铺/分组、货号/SKC/品名、全局搜索。
- 顶部全局筛选会影响首页、店铺、货号 360、SKC/链接、评价/口碑、订单/售后等需要当前时间范围的页面。
- `今日动作池` 是当前最新待办池，不按时间段回看；动作池页不显示时间选择窗口，也不把 `startDate/endDate/rangePreset` 写入当前动作池视图链接。
- `业务域`、`风险`、`处理状态`、`快速聚焦` 只属于 `今日动作池`，必须放在动作池页面顶部 sticky 工具栏里的“动作池专用筛选”区域；它们不得影响评价、订单/售后、店铺、货号或 SKC/链接页面。
- URL hash 即使残留 `domain/risk/status/focus`，非动作池页面也必须忽略这些条件，避免隐形筛选造成“数据消失”。
- 需要当前时段口径的子页面，把时间筛选嵌入顶部全局筛选区，不再另做内容区悬浮时间条。
- 首页看板内有货号/SKC/品名筛选和店铺/分组筛选；店铺筛选支持 `全部店铺`、`DSY 组`、`LGM 组` 和 15 个单店。
- 首页顶部矩阵、日销趋势、月销趋势、店铺排行、产品排行都要同时受时间段、店铺/分组、货号/SKC 筛选影响。
- 首页默认未筛选时，顶部矩阵显示 `总计 / DSY 组 / LGM 组`；筛到单店或分组时，只显示对应范围。
- 首页日销趋势默认近 30 天，月销趋势默认过去 6 个月；筛到货号 + 店铺组合时，使用 `rankings.dailyStoreProducts` 的店铺×货号日粒度数据。
- 时间选择弹窗使用大号双日历：左侧开始日期，右侧结束日期；快捷按钮放在弹窗外侧。
- 侧栏每个数据域只显示一条精确到秒的更新时间；数据口径日放在鼠标悬停提示里，避免同一数据域显示两个时间。
- 从任意子页面点击“总控驾驶舱”必须回到页面顶部，不滚到 `#overview` 中段。
- 趋势图纵轴使用整数刻度，图上关键节点显示完整数字；鼠标悬停可看完整 SAR 数值。
- 店铺视角的 7 天 / 30 天链接指标使用真正二级表头：第一行指标组，第二行周期，正文每个周期数字独立列，避免 `<br>` 拼接造成错位。
- 店铺视角的低展示库存预警来自 `fact.visible_inventory_snapshot` 最新正确展示库存快照，按本店已上架且展示库存低的 SKC 全量列出；动作池库存动作只是精选待办，不代表低库存全量。
- 首页顶部退货 / 售后矩阵显示当前时段数量和售后订单金额，金额同时展示 SAR 和按 `1 SAR = 1.8 RMB` 估算的 RMB。
- 首页销售矩阵、日/月趋势和店铺/产品排行的“成交额/销售额”统一为净成交额：退货、仅退款、派送失败等反转订单不计入成交额、订单数和销量。
- 评价 / 口碑页读取 `fact.product_comment`，用于按货号、店铺、SKC 和评价内容筛选历史评价；低星、质量投诉和差评标签优先展示。
- 评论中文翻译不要依赖浏览器插件或本地启发式翻译；正式口径是 SHEIN 评论列表接口 `translate: 1` 的平台译文，写入 `fact.product_comment.goods_comment_content_zh`，页面保留原文和中文并存。
- 成本 / 利润页读取 `mart.profit_*` 视图；首页“当前时段真实利润”和“月利润趋势”也使用同一套利润口径。

- 成本/利润页前端展示必须基于 `profit_daily_store_product` 按当前时间、店铺/分组、货号/SKC 重新聚合；不要把 `mart.profit_product_summary` 的全局历史货号汇总直接用于当前筛选表格。

## 9. 成本 / 利润运维口径

### 9.1 成本文件入口

- 成本文件统一放在 `inputs/costs/`。
- 当前正式成本文件：`inputs/costs/成本计算表.xlsx`。用户以后更新成本表时，优先替换这个文件；导入脚本会先清理同源文件旧记录再写入，避免旧批次残留。
- 模板文件：`inputs/costs/SHEIN成本表模板.xlsx`。
- 导入脚本：`scripts/import_product_costs.mjs`。
- 手动导入单个文件示例：`node .\scripts\import_product_costs.mjs --file .\inputs\costs\你的成本表.xlsx`。
- 每日 BI 流水线 `scripts/run_bi_daily_pipeline.ps1` 会自动扫描 `inputs/costs/` 并导入非模板的 `.xlsx/.xlsm/.csv` 文件。
- 成本导入是非阻断步骤：导入失败会记录 warning，但不能阻断销售/订单、业务域和 BI 门户刷新。

### 9.2 成本表字段和计算

- 一行成本批次代表同一个货号的一批货。
- 同货号单位成本 = 完整批次总成本 / 完整批次发货总数。
- 如果表里已有 `单台总成本（SAR）`，它代表这一批的单件完整成本；入库时会还原成“这一批总成本 = 单台总成本 × 数量”，最终仍按同货号所有完整批次加权平均。
- 完整批次至少要有：货号、发货数量、货款金额、头程运输费金额。
- 缺头程运输费金额的批次会写入 `fact.product_cost_batch`，但 `complete_batch=false`，不参与单位成本均摊。
- 成本默认人民币转 SAR，汇率沿用 `1 SAR = 1.8 RMB`；如成本文件本身为 SAR，脚本会按 SAR 写入。
- 如果成本表有长宽高/重量，会写入 `volume_l`、`weight_kg`，用于选品模型和体积利润率分析。
- 成本匹配同时兼容销售端标准货号和成本表型号代码，例如销售端 `SM-505A电动缝纫机` 可匹配成本表 `SM-505A`；匹配键由 `dim.product_match_key()` 提供。
- 历史测试品 `2001/CM-2001` 已按用户确认补一条手工成本：总成本 `5500 RMB`、数量 `37`，文件为 `inputs/costs/历史手工成本补充.csv`；该品已停做，只用于历史利润复核。

### 9.3 利润计算

- 商品/店铺/货号层利润：`净营收 - 商品成本 - 退货派送费`。
- 退货、仅退款、派送失败等保守处理订单：营收视为 `0`，仍扣商品成本；只有真实退货退款链路额外扣 `13.88 SAR` 退货派送费，`仅退款`、`派件失败`、`派件异常` 不重复扣退货派送费。
- 但 `sales_sar <= 0` 的 0 金额订单行（常见为“揽收前已取消”）不视为真实售出，不扣商品成本，也不加 `13.88 SAR` 退货派送费；否则会把取消单误当卖出后毁损，严重压低利润。
- 利润率：`利润 / 净营收`。净营收为 0 时利润率为空，不硬算。
- 成本缺失的订单行不参与真实利润额计算，并在页面显示成本覆盖率和缺成本销售额。
- 月仓储费表写入 `fact.monthly_storage_fee`，只用于月度总利润；DSY / LGM 按当月净成交额比例分摊。
- 仓储费不能拆到单独货号，因此单货号、单 SKC 和单店页面展示“未扣仓储费”的商品经营利润。

- 选品标尺模型：成本表缺长宽高时，先用历史头程 / `1600 RMB/方` 倒推出单件估算体积，再按未来 `2000 RMB/方` 重算新选品头程；矩阵分箱按进货价和体积，并用真实历史利润率、利润额、销量、ROI 校准。
- `TS`、`MZ` 在 `2026-03-01` 前归 `LGM`，从 `2026-03-01` 起归 `DSY`；利润视图和 BI 净成交首页数据都按这个历史分组。

### 9.4 数据库对象

- 成本批次表：`fact.product_cost_batch`
- 月仓储费表：`fact.monthly_storage_fee`
- 当前单位成本视图：`mart.product_unit_cost_current`
- 退货/派送失败影响视图：`mart.profit_after_sales_impact`
- 订单行利润视图：`mart.profit_order_item`
- 日店铺货号利润视图：`mart.profit_daily_store_product`
- 月分组利润视图：`mart.profit_month_group`
- 货号利润汇总视图：`mart.profit_product_summary`

## 10. 团队访问边界

- 当前已开放临时局域网协作访问：`http://192.168.2.49:8787/`，同一局域网内无需账号密码即可访问。
- 局域网服务监听 `0.0.0.0:8787`，Windows 防火墙规则为 `SHEIN BI Portal LAN 8787 ReadOnly`，仅放行 Private 网络 `192.168.2.0/24` 到本机 `192.168.2.49:8787`。
- 当前未开放公网，未配置端口转发。
- 同事可标记动作状态、填写负责人和备注；共享状态写入 `state/bi_action_state.json`，每次写入会记录 `updatedBy` / `updatedByUser`，当前以访问 IP 留痕；审计日志追加到 `logs/bi_portal_action_audit.jsonl`。
- 通过本机网页服务打开门户时，动作状态同样写入 `state/bi_action_state.json`。
- 直接双击 HTML 打开时，动作状态只保存在当前浏览器。
- 团队正式版上线前至少还需要：固定访问地址、多人编辑冲突控制增强、动作状态入 PostgreSQL、HTTPS 和备份。

## 11. 不要做的事

- 不要恢复旧 `SHEIN-Sales-15Stores-LinkManagement-0340` / `SHEIN-Sales-15Stores-LinkManagement-0510`。
- 不要因为 BI 开发中断飞书销售同步、链接同步、日报和正式看板刷新。
- 不要删除 `267014` 历史失败记录。
- 不要把密码、cookie、短信验证码写入文档、日志或聊天。
- 不要开放公网或端口转发；局域网协作试用之外的长期团队访问必须先补固定地址、HTTPS 和备份。
- 不要删除整个 `profiles/persistent-*-profile`；如需瘦身，只清 Chrome 可重建缓存，尤其是 `OptGuideOnDeviceModel`。
- 不要把缺头程运费的成本批次强行计入单位成本。
- 不要把月仓储费摊到单独货号或单独订单。
- 不要在成本覆盖不足时用 `25%` 预测利润填充真实利润页面。

## 12. 常用验证

- 检查 BI 门户：打开 [http://127.0.0.1:8787/#tab=system](http://127.0.0.1:8787/#tab=system)。
- 检查局域网协作服务：打开 [http://192.168.2.49:8787/#tab=system](http://192.168.2.49:8787/#tab=system)，或检查 `http://192.168.2.49:8787/api/health` 返回 `lanMode=true`、`authRequired=false`、`writableActionState=true`。
- 修改 BI 门户 UI 时，默认先后台验证：`node --check scripts/generate_bi_portal.mjs`、`node scripts/generate_bi_portal.mjs`、静态检查 `outputs/bi-portal/index.html` / `data.json`。除非用户要求或必须排查浏览器交互问题，不主动打开前端。
- 检查成本文件解析但不入库：`node .\scripts\import_product_costs.mjs --dry-run`。
- 重新创建成本模板：`node .\scripts\create_cost_template.mjs`。
- 检查 BI 自动任务：`检查SHEIN-BI自动任务.cmd`。
- 查看最新 BI 体检：`outputs/bi_audit/`。
- 查看最新 BI 流水线日志：`logs/bi-daily-pipeline-*.log`。
- 查看链接任务日志：`logs/jobs/` 和 `logs/manual/`。

### 12.1 Docker / WSL 数据盘异常恢复

- 典型现象：BI 流水线或 PostgreSQL 报 `input/output error`，Metabase / warehouse 容器不可用，或 Docker API / PostgreSQL 查询异常。
- 数据位置：Docker 数据盘为 `D:\SheinBI\docker-data\docker-data.ext4`，WSL 发行版位于 `D:\WSL\Ubuntu-24.04`。
- 恢复原则：先停止 WSL / Docker，再备份 Docker volumes，确认备份存在后对 ext4 数据盘执行 `e2fsck -fy`，最后启动容器并跑 BI audit；不要直接删除 Docker 数据。
- `2026-05-05` 已按上述流程恢复一次，并备份到 `D:\SheinBI\docker-data\recovery-backups\volumes-backup-20260505-094819.tar.gz`。
- 恢复后必须验证：`http://127.0.0.1:8787/`、`http://192.168.2.49:8787/` 返回 200，BI 流水线最新日志为 `success`，BI audit 无 warning / error。

## 13. 货号 / 评价 / 动作池当前运维口径

- 货号页 `15 店覆盖与承接` 的销售口径是“本店 + 标准货号 + 当前时间段”的全部 SKC / 链接合计销售；最佳 SKC 不承担销售汇总口径，只承担承接判断口径。
- 如果 `本货号待处理动作` 里重复弱链接没有完整同组链接表，优先用动作池证据解析出弱链接与最佳链接销量差距，不能直接写“暂无可对比”。
- `SKC 数据复核区` 是订单、财务、售后三方互证区，不作为每日必处理清单。
- 评价页必须支持顶部全局时间段筛选；日常评价抓取任务每日执行一次，并把 SHEIN 平台译文作为批处理字段写入数据库，页面不做实时浏览器翻译。
- 今日动作池可见证据必须是业务字段名，不显示原始 `key=value` 代码式证据。

## 14. 2026-05-03 本轮修正落地

- 货号页的重复弱链接对比已改为读取全量 `DATA.storeLinks`。遇到 `sv260211161429504151036` 这类动作，页面必须展示同店同款完整链接表，而不是提示“明细池未取到完整同组链接”。
- 链接对比指标顺序统一为 `曝光 / 访客 / 销量 / 支付率`，均展示 `7天 / 30天` 二级表头。
- 制冰机归并规则落地到 `config/product_aliases.json` 和历史仓库数据：`制冰机`、`03038`、`SK-03038` 等统一到 `SK-03038制冰机`。
- `fact.product_comment` 已按开店以来全量评价入库：当前 `1796` 条，`1794` 条有 SHEIN 平台译文，`translation_provider='shein-platform'`；日常新增评价由业务域同步直接写入平台译文，不再运行旧的本地翻译脚本。

## 15. 历史乱码归档

- `2026-05-03` 已将旧 `MEMORY.md` 和执行记录中的历史乱码内容原样备份到 `backups/doc-mojibake-archive-2026-05-03T14-20-00/`。
- 当前接手优先阅读本文、`README.md`、`docs/bi-portal-ui-current.md` 和根目录 `MEMORY.md`。
- 归档文件只作为历史排障追溯，不作为当前运行口径依据。

## 16. 2026-05-03 评价全量与平台翻译口径（当前权威）

- 评价/口碑底库按每店开店以来全量补抓；日常新增评价同步默认只抓最近 `14` 天作为防漏增量窗口，既覆盖小范围延迟/补跑，也避免 90 天过长窗口浪费资源。
- 评论中文翻译使用 SHEIN 评论列表接口的 `translate: 1` 平台译文，写入 `fact.product_comment.goods_comment_content_zh`，`translation_provider='shein-platform'`；旧的本地启发式翻译和 `scripts/translate_product_comments.mjs` 不再作为生产口径。
- 当前仓库核验结果：`fact.product_comment` 共 `1796` 条，覆盖 15 店，最早评价日期 `2025-10-04`、最新评价日期 `2026-05-04`；`1794` 条有 SHEIN 平台译文，剩余 2 条为原文为空，无需翻译。
- 全量补抓脚本：`scripts/backfill_shein_comments_full_history.mjs`；日常业务域同步脚本：`scripts/fetch_shein_business_domains.mjs` + `scripts/load_bi_business_domains.mjs`，抓取时同时合并平台译文。
- SHEIN 评论接口在大时间窗下可能返回 `mgs97906 数据量太多...缩小评论时间`，因此全量补抓必须按日期窗口分段，并在必要时自动拆分。



