# MEMORY

## 2026-05-13 产品套图提示词长期口径
- 产品套图提示词当前优先服务 SHEIN 沙特市场，兼顾欧洲市场；Amazon / noon / Temu 暂时只作为视觉经验参考，除非用户明确要求对应平台版本，否则不强制套用它们的主图规则。
- 英文和阿文同等重要；阿文翻译和校对由 Codex / reviewer / 子代理负责，不把阿文校对推给用户。
- 提示词要尽量靠近 Gemini 优秀样例的细致程度：重点图按 `Visual Subject / Model & Styling / Scene & Atmosphere / Composition & Text` 写清人物、服装材质、动作、场景、光线、构图和英阿双语文案。
- 个护、封面和场景图允许更强的明亮性感流量风：深领口、露肩、锁骨、上背线条、贴身真丝/罗纹面料、直视镜头、微张嘴唇、放松但勾人的姿态；底线是不色情、不露点、不透视裸露、不明显性行为姿势、不廉价低俗，且产品必须始终是主角。
- 交付给用户复制的提示词文档，前半部分必须是完整可复制的英文提示词本身，不要夹中文说明；中文说明或全文翻译放在英文版后面。
- 用户只要求改提示词时，不要自动更新桌面压缩包；只有用户明确说“重新打包/更新压缩包”才更新 handoff zip。


## 评价全量与平台翻译（当前权威）
- 评价/口碑底库必须按每个店开店以来全量补抓；日常评价同步默认只抓最近 `14` 天作为增量防漏窗口，不要再用 90 天这种过长窗口浪费后台资源。
- 评论翻译使用 SHEIN 后台评论列表接口的 `translate: 1` 平台翻译，写入 `fact.product_comment.goods_comment_content_zh`，`translation_provider='shein-platform'`；不再使用本地启发式翻译、浏览器插件或第三方插件作为正式结果。
- 当前全量结果：`fact.product_comment` 共 `1796` 条，`1794` 条有 SHEIN 平台译文；剩余 2 条为原文为空的评价，无需翻译。全量补抓脚本为 `scripts/backfill_shein_comments_full_history.mjs`，日常业务域抓取为 `scripts/fetch_shein_business_domains.mjs`。
- SHEIN 评论接口宽窗口会报 `mgs97906 数据量太多...缩小评论时间`；全量补抓必须按日期窗口分段，并在必要时自动拆分。

## 2026-05-03 BI 链接对比 / 制冰机归并 / 评价翻译
- 货号页和动作池遇到重复弱链接时，必须从全量 `DATA.storeLinks` / 链接仓库取同店同标准货号链接，不能显示“页面明细池未取到完整同组链接”这类退缩兜底。
- 链接对比指标统一按 `曝光 -> 访客 -> 销量 -> 支付率` 展示，并在每个指标下显示 `7天 / 30天`。
- `制冰机`、`03038`、`SK-03038` 及带异常尾缀的同类写法统一归并到 `SK-03038制冰机`。
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
- 飞书多维表格 / 原生看板写入已按用户要求临时暂停；暂停开关为 `state/feishu-base-sync-paused.flag`。暂停期间继续抓 SHEIN 本地数据、刷新 BI、发送飞书文字日报 / 可视化日报和异常提醒。
- BI 不从飞书反抓数据作为源头；源头是 SHEIN 后台抓取后的本地 JSON 与 PostgreSQL 数据仓库。
- 新建飞书 Base 数据表后，提醒用户手动扩容到 `20000` 行；默认 `2000` 行容易写满。
- 正常抓取、同步、日报、watchdog 和 BI 任务必须后台/隐藏运行；非必要不要打开前端浏览器窗口或命令行窗口。只有登录、验证码、人机校验、用户明确要求看前端，或必须排查浏览器交互问题时才打开可见窗口；临时验证必须优先用静态检查、HTTP/API、CDP 后台连通或 hidden/offscreen，并在验证后关闭。
- ET 货代仓也适用“非必要不打开前端窗口”：`scripts/fetch_et_forwarder.mjs` 默认 `visible=false` 并用 `WindowStyle Hidden` 启动 Chrome；自动登录优先走 `scripts/et_login_helper.py` + OCR。只有 OCR/验证码连续失败、登录态必须人工处理、用户明确要求，或必须排查浏览器交互问题时，才允许临时加 `--visible` 打开 ET 前台窗口，处理完必须关闭。
- Chrome 程序路径优先使用 `C:\Program Files\Google\Chrome\Application\chrome.exe`；D 盘路径只作兜底候选。店铺登录态仍在工作区 `profiles/`，不要因为程序在 C 盘就把 profile 移回 C 盘。

## 店铺、账号与统计口径
- 当前 16 店：DSY 组 `DL DX FY LQ NM HL JY ZL TS MZ`；LGM 组 `CX YJ XL QY QH TZ`。TZ 已接入 LGM，店铺名 `GS5636781`，`profileKey=tz`，CDP 端口 `9348`，profile 为 `profiles/persistent-tz-profile`；TZ 后台时区已改为 `中国 北京 UTC+8`，`config/stores.json` 固定 `accountUtcOffsetHours=8`。
- 16 店登录态保存在 `profiles/persistent-*-profile`；不要删除整个 profile。若要瘦身，只清理 Chrome 可重建缓存，例如 `OptGuideOnDeviceModel`。
- 2026-05-10 已复核 16 店 profile 显示名与登录抓数：`PROFILE_NAME.txt` / Chrome `Preferences` / `Local State` 均与配置一致；用稳定日期后台重抓对账未发现登录错位。`YJ=profileKey qy/port 9346`、`XL=profileKey yj/port 9344`、`QY=profileKey xl/port 9345` 是当前正确绑定，profileKey 名称是历史遗留，不要为了“看起来一致”改成 YJ/YJ、XL/XL、QY/QY。验证证据：`outputs/profile-audit/all-store-stable-refetch-verify-20260510/final-profile-login-verify-reviewed.json`。
- 2026-05-08 已删除 8 个 `profiles/*/OptGuideOnDeviceModel` Chrome 可重建模型缓存，释放约 `31.81GB`；清理日志为 `outputs/cleanup/chrome-optguide-cache-delete-20260508-143959.json`。删除后 16 店 profile、飞书 profile、ET profile 和 BI 入口均已验证仍存在。
- HL 已切换为主账号：`profileKey=shein-main`，CDP 端口 `9360`，正式 profile 为 `profiles/persistent-shein-main-profile`；旧 `profiles/persistent-hl-profile` 已删除。
- LGM 组当前本身就是主账号，不需要替换。
- 统计日按北京时间自然日；订单销售以 SHEIN 订单创建时间为准。除非用户明确确认，不给单店保留猜测性时区偏移。
- 销售有效性必须统一走 `lib/shein_sales_validity.mjs`：源头总销售只剔除真正取消、揽收前取消等“未形成销售”的商品行，例如 `pageStatus=CANCEL`、`goodsPerformanceStatus=6`、订单/履约状态文本含取消；用户已退款、退货、派件失败等不能在源头抹掉，应保留为总销售，再由净销售额、售后/利润层反转。后台原始金额仍保留在明细中用于追溯。
- `2026-05-13` 已按取消单源头剔除口径写回 `2026-05-11` 至 `2026-05-13` 本地销售 summary；样本为 LQ `2026-05-12` 无货取消 `SK-5118电磁炉` 从业绩剔除，LQ 当日总销售 `211.67 SAR`。此前提到全历史约 `43,472.16 SAR` 是把退款/退货/派件失败误当源头取消的错误 dry-run 结果，已作废；修正后全历史金额影响仅 `68 SAR`，且就是这笔 LQ 取消单。
- 固定汇率：`1 SAR = 1.8 RMB`；预测利润率默认按 `25%` 粗估，等成本和完整财务接入后替换。
- 遇到 SHEIN 接口 `20302 子系统登录重定向`，先自动恢复登录并重抓；恢复失败时明确提示人工登录，不能用旧数据冒充最新数据。
- 判断店铺登录态/错位时，不要仅凭页面文本或页面里出现的店铺号下结论；应以实际订单接口返回、稳定日期重抓与数据库样本对账为准。当天数据会继续变化，不适合作为最终 profile 错位判断样本。

## 飞书资产与生产链路
- 正式 Base：`https://zcnm3ts63aph.feishu.cn/base/SnnQbrAu6aLzMWsnEICcy0cKnJh`。
- 正式 Base 标题已加暂停备注：`【多维表格同步暂停｜日报正常】SHEIN沙特半托自动驾驶座舱`；这是人工可见提醒，不代表删除 Base。
- 当前月主看板：`SHEIN经营看板 v3-主看板`，Dashboard ID `blkFn3qHrwdsrJyX`，读取 `看板数据-MAIN-*`。
- 上月看板：`SHEIN经营看板 v3-上月`，Dashboard ID `blkWeyZhphgRZYim`，读取 `看板数据-PREV-*`。
- 旧 `看板数据-DSY-*`、`看板数据-LGM-*`、`看板数据-ALL-*` 和旧 Dashboard 已清理，不要恢复为正式链路。
- 程序化读取飞书 Base 记录时必须显式使用 `--format json`，避免解析旧格式导致误判。

## 计划任务
- 2026-05-15 起生产调度转为云端 systemd timer：`shein-bi-cloud-today.timer` 在北京时间 `00:10/02:10/.../22:10` 每两小时刷新当天销售、入仓并生成 BI Portal；`shein-bi-cloud-yesterday.timer` 每天 `00:10` 刷新前一天最终销售并复核前两天稳定日；`shein-bi-db-backup.timer` 每天 `02:30` 备份业务库和 Metabase 元数据库。
- 本地 `SHEIN-*` Windows 计划任务已全部禁用，保留为回滚/迁移参考，不再作为生产调度。除非用户明确回滚，不要重新启用 `SHEIN-Sales-15Stores-Intraday-Daytime`、`SHEIN-BI-Daily-Pipeline-0700`、`SHEIN-Sales-15Stores-LinkManagement-0530`、`SHEIN-Sales-ETForwarder-0420` 或 HL OpenAPI 本地任务。
- 云端自动化已覆盖销售 WebAPI 直连、销售入仓、BI Portal 生成、数据库备份、ET 同步、飞书日报、完整 RTV 复核、链接/业务域日更、异常通知 watchdog、只读飞书问数机器人和 HL OpenAPI 双跑；本地 Windows 任务只作回滚参考。
- ET 和飞书日报已启用云端 Linux 入口：`scripts/cloud_et_forwarder_sync.sh` / `shein-bi-cloud-et-forwarder.timer`、`scripts/cloud_daily_lark_report.sh` / `shein-bi-cloud-daily-lark-report.timer`。ET 服务器侧使用私有 `config/et_forwarder.local.json` 或环境变量账号密码，不能复用 Windows Chrome 保存密码；飞书日报服务器侧使用独立飞书 CLI 应用/机器人与私有 `config/lark_report.json`，旧应用的 `open_id` 不能直接给新应用用，换机器人时需用 `union_id` 重新映射收件人 `open_id`。上述 secret/token/收件人完整 ID 不进 GitHub、文档或聊天。2026-05-16 云端 ET 全量同步和云端飞书日报真实发送均已验证成功。
- 链接/业务域已启用云端 Linux 入口：`scripts/cloud_link_business_sync.sh` / `shein-bi-cloud-link-business.timer`，每天 `05:30` 顺序跑前一完整日；它用服务器私有 `state/shein_browser_sessions/*.local.json` / `state/shein_webapi_sessions/*.local.json` 初始化 headless Chrome，按店抓取、入仓、体检并刷新 BI。不要再用本机隐藏补抓冒充云端日更；纯 Node 零浏览器直连只是后续优化。
- 云端飞书日报图依赖 Linux 中文字体；服务器必须安装 `fonts-noto-cjk` / `fontconfig`，`fc-match 'Noto Sans CJK SC'` 应匹配 Noto CJK，否则 headless Chrome 生成的日报图中文会显示方框。
- GitHub 中的 `outputs/bi-portal/index.html` / `data.json` 是灾备静态快照；服务器执行 `git reset --hard origin/main` 或类似部署后可能覆盖实时 BI 页面。每次服务器拉取/重置代码后，必须重跑 `scripts/cloud_bi_refresh.sh today intraday` 或 `shein-bi-cloud-today.service`，确认 `generatedAt` / `salesUpdatedAt` 更新到当前。
- 本地历史规则仍可作回滚参考：RTV 复核耗时长是正常现象，滚动销售刷新不应等待完整 RTV；BI 门户生成必须在流水线末尾单次执行，默认 `SHEIN_BI_PORTAL_TIMEOUT_MS=900000`，不要恢复“流水线完成 / 简报 / 首次体检”多个状态点重复生成页面。
- 飞书 Base / 看板写入仍受 `state/feishu-base-sync-paused.flag` 约束；云端恢复飞书日报或异常通知前，不要默认认为本地日报任务仍在生产运行。

## 数据与货号归并
- 销售 / 订单历史已全量入 BI 仓库；链接、售后、履约、财务按价值和接口能力逐步补历史，库存只保留最新与滚动快照，不补开店以来全量。
- 货号 360 / 店铺×货号覆盖必须按“每个店自己的最新链接/覆盖快照”聚合，不能用全局 `max(date)` 过滤；16 店同步常会分批完成，若只取全局最新日，会把未在该日完成同步的店铺误判为没有链接。
- 标准货号清单：`config/product_catalog.json`；别名归并：`config/product_aliases.json`；归一化逻辑：`lib/product_sku_normalizer.mjs`。
- 货号开头括号备注不参与归并，例如 `（待定）SK-123`、`（废）SK-123`、`(废)SK-123` 都按 `SK-123` 处理。
- `CM-121E美式咖啡机`、`121E美式咖啡机`、`121E`、`CM121E`、`CM-121E` 是同一个 121E 咖啡机，统一归并到 `CM-121E美式咖啡机`；用户 2026-05-11 咨询低库存保留店铺时已按合并口径判断。
- 发现无法归并、疑似新货号或只凭短号/标题拿不准的货号时，必须汇总给用户确认，不得擅自合并。

## 链接管理规则
- 飞书链接管理功能已废弃：不再写入飞书链接管理表，不再维护飞书链接看板；日常链接管理只走本地 JSON / PostgreSQL / BI 门户。
- 历史飞书链接表仅保留查档且已加前缀：`（暂废弃）链接管理-链接主数据`、`（暂废弃）链接管理-表现日事实`、`（暂废弃）链接管理-展示库存日事实`、`（暂废弃）链接管理-货号店铺覆盖`、`（暂废弃）链接管理-建议`、`（暂废弃）链接管理-今日实操清单`。
- `scripts/run_link_management_job.mjs` 默认 `BI/local-only`，不会写飞书；`scripts/sync_shein_links_to_lark.mjs` 默认拒绝执行，只有显式设置 `SHEIN_ENABLE_DEPRECATED_LARK_LINK_SYNC=1` 才允许一次性历史迁移。
- 已标 `废` 且已下架的链接只作为历史状态忽略，不进入建议或今日实操，也不提醒归档。
- 如果某货号 16 店都没有上架链接，按暂不上或库存未到处理，不进缺链接提醒；只有部分店已上架、部分店缺上架时才提醒补链。
- 待上架链接若后台返回缺证书、缺资质、缺资料、审核驳回等原因，应进入建议和实操清单。
- 备货信息里的库存口径不可信，不用于库存低提醒；正确展示库存优先来自商品列表库存接口，后续真实库存等外部系统接入。
- 今日实操清单必须保持可操作数量，不恢复到千级全量模板建议。

## 营销活动报名规则
- SHEIN 营销活动自动化只允许辅助勾选商品、填写活动价/降幅和复核，不得点击最终 `提交报名`；最终提交必须由用户在可见前端人工审核后点击。
- 营销活动报价规则以 `docs/marketing-campaign-signup-pricing-rules.md` 为准：固定价货号按“基准价 + 随机下浮 `2 SAR` / 上浮 `1 SAR`”填报；利润率货号按“目标利润率随机下浮 `2` 个点 / 上浮 `1` 个点”反推；用户点名固定价/利润率优先于新品保护价和清货候选价；其它货号默认按 `30%` 利润率并允许 `28% ~ 31%` 浮动，平台最低折扣/页面回写作为最终硬约束记录。
- 营销活动选择商品页必须先把右下角每页显示改成 `500 条/页` 再全选，并核对 `总计 N 个` 与 `已选商品 N 个` 一致；不能在默认 `20 条/页` 下全选。
- 当前用户指定规则：`SM-505A/TXSM-505A电动缝纫机 -> 110`、`KF-JN-02便携咖啡机 -> 96`、`SK-185台式榨汁机 -> 91`、`SK-03012台式榨汁机 -> 96`、`SK-03038制冰机 -> 330`；`FZ-666颈部按摩器 -> 15% 利润率`；`SK-7025A/SK-7027/SK-7028 绞肉机 -> 25% 利润率`。
- 用户质疑营销活动漏报或要求“再检查”时，必须逐店重新扫描 DSY 店铺（含 `MZ`，除非用户明确排除）时间窗内仍可报名的活动；不要只补上一次报错活动，因为 SHEIN 系统可能新抓入商品。
- `SK-13034` 是营销活动缺成本的明确例外：用户说明该品不用管、按平台默认最低折扣先填；此例外不得自动扩展到其它缺成本货号。
- 若本期已生成 `outputs/reports/marketing-price-overrides-YYYY-MM-DD.json`，营销活动填报必须带 `--price-overrides`，避免新品保护价、清货底线或用户确认价未生效。
- `2026-05-06` MZ 店铺两个活动已由用户自行提交：`SA-超级爆品活动-第39期 / 40228` 和 `SA New Arrivals Promo_Batch 39 / 40227`；后续不要重复操作 MZ 已提交活动。
- 营销活动半自动入口已纳入仓库：先运行 `python scripts/marketing/build_marketing_cost_map.py` 生成忽略的本地成本映射 `tmp/mbrs/marketing-cost-map.json`，再运行 `node scripts/marketing/dsy_marketing_deadline_fill.mjs --hours 48`；结果和审计仍输出到忽略目录 `tmp/mbrs/deadline-fill-results/`。
- 本系统长期定位不只是 BI 数据分析，也是自动运营驾驶舱；所有写操作默认按“建议/预填/用户复核/人工最终提交/审计留痕”推进，除非用户明确授权并已有回滚方案，否则不得直接提交不可逆运营动作。

## SHEIN BI 系统
- 架构原则：`SHEIN 后台/WebAPI/OpenAPI 抓取 -> 私有源文件 / PostgreSQL 数据仓库 -> Metabase BI / BI Portal`。PostgreSQL 是核心数据仓库；Metabase 当前仍是正式深度分析/自由钻取层，BI Portal 是日常经营入口。没有完整替代前，不要建议直接删除或跳过 Metabase。
- 2026-05-15 起本地 BI 已封存，云端 BI 为正式入口：`http://43.165.167.135/`，由 Nginx Basic Auth 保护；账号密码不写入仓库、文档或日志。本地 `8787` 服务已停止，`SHEIN-*` Windows 计划任务已禁用；除非明确回滚，不要重新启用本地 BI 或本地定时任务。云端可复用改动必须及时同步 GitHub，敏感 session/密钥/数据库 dump 仍不得提交。
- HL OpenAPI 销售试点已建立并行链路：`outputs/shein_openapi_fetch/HL/YYYY-MM-DD.json` -> `scripts/load_shein_openapi_sales_warehouse.mjs` -> `fact.openapi_store_daily_sales` / `fact.openapi_order_header` / `fact.openapi_order_item` / `mart.openapi_sales_reconciliation`；系统状态页会显示 “SHEIN OpenAPI 试点对账”。正式切换生产事实表前必须继续确认多日 `matched`。
- 官方 OpenAPI 与后台 WebAPI 直连是两条不同链路：OpenAPI 需要开放平台应用、授权、`openKeyId` / `secretKey` 和 IP 白名单；后台 WebAPI 直连复用已登录 Cookie/session，当前已优先承接 16 店销售生产抓取。两类密钥/session 都禁止进入仓库。
- CX 开放平台应用 `CX-椿霞SHEIN运营中台` 已在 `2026-05-10` 创建并提交审核，模式为半托管，业务功能选择商品管理、商品合规、订单管理、库存管理、财务管理；审核通过后再录入本地 `.local` 密钥并接入 API 双跑。
- SHEIN OpenAPI 若返回 `openapi00002 IP is not in the whitelist`，优先检查当前出口 IP 是否在开放平台 `https://open.sheincorp.com/backstage/white-list`；`2026-05-07` 已补加当前出口 IP `188.253.112.44`，历史 IP `82.27.116.13` 仍保留。不要把 OpenAPI app secret、店铺 secret、openKeyId 写入聊天、文档或日志。
- BI Portal 静态文件为 `outputs/bi-portal/index.html`，数据文件为 `outputs/bi-portal/data.json`，生成脚本为 `scripts/generate_bi_portal.mjs`；云端由 `scripts/cloud_bi_refresh.sh` 在每次刷新后生成并重启服务。
- BI 门户 UI 冒烟检查脚本为 `scripts/check_bi_portal_ui.mjs`；本地封存后默认不要为“看一眼”重新打开本地前端，云端验证优先用 HTTP health、静态断言和日志。
- GitHub 私有仓库已纳入 `outputs/bi-portal/index.html` 和 `outputs/bi-portal/data.json` 作为当前 BI 门户可复用产物；`outputs/` 其他抓取结果、报表、图片、审计结果仍默认忽略，迁移生产状态时单独备份。
- V1 仍是当前正式 BI Portal；V2.1 是独立经营 BI 预览版，由 `scripts/generate_bi_portal_v2.mjs` 生成到 `outputs/bi-portal/v2/index.html`，只读复用 `outputs/bi-portal/data.json`，用户确认前不得替换 V1 或改生产调度。
- 自 `2026-05-14` 起，V2.1 首页（`tab=overview`）已按 V1 首页功能/操作逻辑重做，必须支持顶部筛选、四个经营矩阵、净/总销售额、净/总销量、退货/利润口径切换、日/月趋势、趋势指标切换、店铺/货号排行下钻和深浅主题；其它 V2 子页面尚未按 V1 全量复刻，不得把 V2 整站视为可替换 V1。
- V2 暂时不进入日常同步刷新链路；它只是平行慢开发/慢优化项目。没有用户明确下达 V2 开发、优化或验收任务时，不要主动生成、同步、维护或把它接入自动任务。
- BI 门户侧栏“链接表现数据”更新时间必须显示链接源文件抓取时间，即 `outputs/shein_links/<店铺>/<链接日>.json` 的 `fetchTime` 最大值；“售后/库存/财务数据”也必须显示业务域源文件抓取时间，即 `outputs/shein_business_domains/<店铺>/<业务日>.json` 的 `fetchTime` 最大值；不要用 BI 重跑入仓时的 `updated_at` 冒充抓取时间。
- 云端 Metabase / PostgreSQL 运行在腾讯云 Ubuntu + Docker；本地旧 WSL + Docker 数据盘仅作历史/回滚参考，长期生产不要再依赖本地 WSL。
- 若本地旧 Docker / Postgres / Metabase 出现 `input/output error`，优先怀疑 `D:\SheinBI\docker-data\docker-data.ext4` 文件系统异常；恢复顺序是先停止 WSL / Docker，再做 volume 备份和 `e2fsck -fy`，最后重启容器并跑 BI audit，不要直接删除 Docker 数据。
- Metabase 管理员凭据只保存在 `infra/metabase/.admin.local.json`，不要写入聊天、文档或日志。
- 当前团队访问转为云端入口；本地局域网协作入口已经封存。若后续明确回滚到本地，才重新检查 `0.0.0.0:8787`、防火墙规则 `SHEIN BI Portal LAN 8787 ReadOnly` 和 `scripts/fix_bi_lan_firewall.ps1`。



## BI 门户 UI 当前规则
- 首页是“总控驾驶舱”，主要承载总览、分组、趋势和排行榜；具体操作下沉到店铺、货号 360、SKC/链接、订单/售后、动作池、系统状态等子页面。
- 首页看板筛选联动是当前首页核心口径，底层数据键为 `DATA.rankings.dailyStoreProducts`；不能只改顶部矩阵而不联动趋势和排行。
- 首页筛选区和时间筛选必须统一放在页面最上方 sticky 工具栏，不能放到 hero、经营总览卡片或页面中段；需要当前时段口径的子页面，也把时间筛选嵌入顶部筛选区，不再另做内容区悬浮时间条。
- 首页顶部筛选栏在宽屏下必须尽量单行展示；提示标签要有足够宽度，不得互相挤压；货号/SKC/品名、店铺/分组、时间筛选要按实际阅读权重分配宽度。
- 普通子页面顶部筛选栏也要保持紧凑：货号/SKC/品名搜索框可适中偏长但不能压缩时间框，店铺框应明显短于搜索框，时间框要能完整显示起止日期；动作池除外，因为动作池不按时间回看。
- 顶部 sticky 工具栏只放真正全局筛选：时间、店铺/分组、货号/SKC/品名、全局搜索；`业务域`、`风险`、`处理状态`、`快速聚焦` 只属于 `今日动作池` 页面局部筛选，不能影响评价、订单/售后、店铺、货号或 SKC/链接页面。
- 今日动作池是当前最新待办池，不按时间段回看；动作池页不显示时间选择窗口，也不把 `startDate/endDate/rangePreset` 写入动作池视图链接。动作池专用筛选（业务域、风险、处理状态、快速聚焦）放在页面顶部 sticky 工具栏，只影响动作池。
- 今日动作池里同一店铺、同一 SKC、同一业务域命中的多条规则必须合并成一张动作卡，展示“合并 N 条”和各规则信号；不要让用户对同一链接重复处理。不同业务域（如链接/库存/售后）仍可分开，避免误合并。
- 首页看板内有货号/SKC/品名筛选和店铺/分组筛选；店铺筛选必须支持 `全部店铺`、`DSY 组`、`LGM 组` 和 16 个单店。
- BI 首页货号/SKC/品名筛选中，短数字/短编号（如 `505`）应优先匹配标准货号、店铺货号、供应商货号等货号字段；不能匹配 SKC 长编号的任意中间片段。只有输入完整或较长 SKC 片段时，才匹配 SKC 字段，避免把无关货号算进动销货号。
- 首页顶部矩阵、日销趋势、月销趋势、店铺排行、产品排行都必须同时受时间段、店铺/分组、货号/SKC 筛选影响；货号 + 店铺组合要使用店铺×货号日粒度数据，不要只看全局货号汇总。
- 首页未筛选时顶部矩阵显示 `总计 / DSY 组 / LGM 组`；筛到单店或分组时显示对应范围。
- 首页日销趋势默认近 30 天，月销趋势默认过去 6 个月；选择非单日时间段后趋势跟随起止日期变化。
- 时间选择弹窗使用大号双日历，左侧开始日期、右侧结束日期；快捷按钮放在弹窗外侧。
- 顶部统一矩阵总盘包含：当前时段销售额、当前时段订单/销量/动销、当前时段退货数量、当前时段真实利润；总计、DSY、LGM 三行固定展示，数字居中并随时间段变化。
- 日销趋势和月销趋势上下排列、各占全宽；折线包含总计、DSY、LGM 三条线，纵轴使用整数刻度，关键节点显示完整数字，悬停显示完整 SAR 值。
- 首页趋势图要减少图表左右留白，但不能用 SVG 非等比强行拉伸；正确方式是扩大自然画布 / viewBox、压缩卡片内边距，并保留坐标轴文字在图内可读区域。
- 排行榜显示完整店铺和标准货号，不使用小框内部滚动；店铺标签只显示 `DL / DX / HL` 这类代号，不重复写 `DSY / LGM`。
- 侧栏每个数据域只显示一条精确到秒的更新时间；数据口径日放在鼠标悬停提示里，避免同一域出现两个时间。
- 从任意子页面点击“总控驾驶舱”必须回到页面顶部。
- 支持浅色 / 深色主题；浅色主题不得出现灰底灰字。
- 店铺视角的 7 天 / 30 天链接指标必须用真正二级表头：第一行指标组，第二行周期，正文每个周期数字独立列；不要用 `<br>` 或小卡片硬拼造成错位。
- 店铺视角的低展示库存预警来自 `fact.visible_inventory_snapshot` 最新正确展示库存快照，按本店已上架且展示库存低的 SKC 全量列出；动作池库存动作只是精选待办，不代表低库存全量。
- 修 BI 门户 UI 时默认不主动打开前端；后台完成代码检查、门户生成和静态 HTML/JSON 断言后，由用户在自己的浏览器刷新查看。不要为了“看一眼”主动打开前端浏览器或可见命令行窗口；只有用户要求或必须排查浏览器交互问题时才打开前端。
- 但涉及页面布局、宽屏留白、对齐、卡片挤压、图表绘图区等视觉判断时，只要用户要求打开前端，就必须用最大化/大视口真实页面验证；不要用未最大化小窗口或纯代码想象来判断宽屏布局。

## 实际库存与去化口径
- `实际库存 / 去化` 页面以成本表批次为库存基数：`到仓/派送日期` 和 `头程运输费` 都有值才计入已到仓库存；有发货日期但缺到仓或头程费用的批次计入在途/待确认；没有发货日期但有数量的批次计入未发/待确认。
- 库存消耗按毛销量扣减，退货、仅退款、派送失败暂不加回库存，避免高估可售库存；这与利润页的净成交/退货成本口径不同。
- 去化速度默认使用 `近7天毛销量/7 × 40% + 近30天毛销量/30 × 60%`；库存可卖天数按估算在库和含在途两套口径展示。
- 店铺/分组筛选只影响销售速度和风险排序，不硬拆物理库存；成本表没有店铺库存分配字段前，库存基数保持全局标准货号口径。
- 该页面是经营估算库存，不是仓库实盘；未来接入真实仓储系统后再升级到货号 × 店铺/仓库粒度。

## 成本与真实利润口径
- 首页和成本/利润页不再用 `25%` 预测利润冒充真实利润；成本未覆盖时必须显示“待成本表 / 成本覆盖率 / 缺成本销售额”。
- 售后/退货金额不能直接用 SHEIN 售后列表展示价 `priceAmountTotal/priceAmount`；优先使用接口里的订单实收/预计收入字段 `checkEstimateIncomeMoney`、`estimatedIncomeAmount`，没有实收字段时才回退展示价。例：`NM / GSH1X61950004DF / SK-10075电油炸锅` 售后展示价 `250 SAR`，订单实收为 `130 SAR`。
- 售后/退货统一口径：只要买家发起售后且状态不是 `已取消`，就默认计入退货/反转，包含 `待买家退货`、`待交接`、`待卖家处理`、`待买家选择方案` 等未落定状态；若后续最终取消，再在下一次业务域同步后自动从净成交、净订单、净销量和利润反转中扣回。
- 首页四个矩阵支持口径切换并联动趋势：销售额可切 净销售额/总销售额，订单销量可切 净销量/总销量，退货售后可切 售后申请时间/订单创建时间，真实利润可切 退货全损保守/RTV已收可二售测算；趋势图按当前所选口径同步变化。
- 成本表文件放在 `inputs/costs/`，当前正式文件为 `inputs/costs/成本.xlsx`，模板为 `inputs/costs/SHEIN成本表模板.xlsx`；导入脚本为 `scripts/import_product_costs.mjs`，模板生成脚本为 `scripts/create_cost_template.mjs`。
- 同货号分批发货时，单位成本 = 完整批次总成本 / 完整批次发货总数；缺“头程运输费金额”的批次只保留缺口，不参与单位成本均摊。
- 成本表中的 `单台总成本（SAR）` 代表单批单件完整成本；入库时先乘以该批数量还原批次总成本，最终仍按所有完整批次加权平均。成本匹配要兼容销售端标准货号和成本表型号代码，匹配键由 `dim.product_match_key()` 提供。

- 成本/利润页的顶部摘要、月利润趋势、月度利润明细、高利润/低利润货号和成本缺口必须同时受顶部时间、店铺/分组、货号/SKC 筛选影响；不能再使用全局历史 `profit_product_summary` 冒充当前筛选口径。
- 成本/利润页的“高利润 / 可加码货号”和“低利润 / 需要处理货号”分界线为 `20%` 利润率：`>= 20%` 进高利润，`< 20%` 进低利润。

- 选品标尺模型不要停留在手填利润计算器；必须基于成本表进货价、历史头程、真实利润率和退货扣减建立“进货价 × 体积”矩阵。当前成本表缺物理长宽高时，体积先按历史头程约 `1600 RMB/方` 倒推，未来选品头程按 `2000 RMB/方 = 2 RMB/L` 重算。
- 历史测试品 `2001/CM-2001` 已按用户确认补手工成本：总成本 `5500 RMB`、数量 `37`，文件为 `inputs/costs/历史手工成本补充.csv`；该品已停做，只用于历史利润复核。
- BI 首页默认销售/成交额为净成交额：所有未取消售后申请、退货、仅退款、派送失败等反转订单不计入首页成交额、订单数、销量、趋势和排行；利润率分母使用剩余净成交额。首页也可切换总销售额/总销量，但 `sales_sar <= 0` 或 `gross_revenue_sar <= 0` 的揽收前取消 / 0 金额行在净口径和总口径里都直接忽略，就当没有发生。
- 退货、仅退款、派送失败等保守处理订单：营收视为 `0`，仍扣商品成本；只有真实退货退款链路额外扣 `13.88 SAR` 退货派送费，`仅退款`、`派件失败`、`派件异常` 不再重复扣退货派送费。
- `sales_sar <= 0` 的揽收前取消 / 0 金额订单行不视为真实售出，不扣商品成本或退货派送费；利润成本必须和正销售额行对齐，避免取消单误扣成本。
- 月趋势按用户选择的日期范围切片，不补全整月；例如 `2026-04-03 ~ 2026-06-03` 中 4 月只统计 `04-03~04-30`，6 月只统计 `06-01~06-03`，页面必须标注。
- 月仓储费只用于月度总利润；DSY/LGM 按净成交额比例分摊，不能拆到单独货号、SKC 或订单。
- 利润分组里 `TS`、`MZ` 在 `2026-03-01` 前归 `LGM`，从 `2026-03-01` 起归 `DSY`。
- 真实利润相关数据库对象：`fact.product_cost_batch`、`fact.monthly_storage_fee`、`mart.product_unit_cost_current`、`mart.profit_order_item`、`mart.profit_daily_store_product`、`mart.profit_month_group`、`mart.profit_product_summary`。

## 工具与避坑
- SHEIN 销售抓取主链路自 `2026-05-11` 起为 Node WebAPI 直连优先：`config/stores.json` 全 16 店 `salesTransport=auto`，`fetch_shein_sales.mjs --transport webapi|auto` 直调 `/gsp/orderPlus/listOrder` / `listOrderItem`；Chrome DevTools/CDP 主要用于导出/刷新 Cookie session、登录续期和回退。
- `state/shein_webapi_sessions/*.local.json` 是 SHEIN 后台 WebAPI 直连的敏感 Cookie session，本地使用且被 `state/` 忽略；不要提交 GitHub、写入文档或聊天。`2026-05-08` 16 店销售 WebAPI 对账已与现有数据库一致，资源实测文件为 `outputs/cloud-migration/webapi-allstores-resource-20260511-201715.json`。
- `run_sales_sync_job.mjs` 在 `salesTransport=auto` 时先 WebAPI 直连；直连成功不启动浏览器，直连失败才启动/刷新对应 Chrome profile 并可继续兜底到后台窗口模式。`launch_store_browser.mjs` / `launch_shein_main_browser.mjs` 在 Windows 下通过 `PowerShell Start-Process` 后台启动 Chrome，避免 `cmd start` 的路径空格问题和 Node detached Chrome 的 libuv assertion。
- `config/lark_report.json` 是日报接收人配置，必须保持合法 UTF-8 JSON；若自动日报读取失败，先校验这个文件。
- `scripts/generate_today_detailed_report_image.mjs` 用于生成只含今日数据的详尽长图，适合临时重发今日战报。
- 飞书看板富文本和卡片样式更新使用 Playwright + 已登录飞书 profile。
- PowerShell 直接运行某些 `.ps1` wrapper 容易被执行策略拦截；优先使用 `.cmd`、`.exe`、`cmd /c` 或已验证的隐藏 VBS 启动方式。
- 不要用 PowerShell here-string 写大量中文 JS/JSON，容易造成编码污染；中文字段、货号、Dashboard 名称优先用 UTF-8 文件、Node 脚本或 `apply_patch`。
- Node 脚本读取大体量子进程 stdout（尤其 PostgreSQL/psql JSON）时，必须收集 Buffer chunks 后 `Buffer.concat(...).toString('utf8')`；不要在每个 `data` chunk 上直接 `toString()` 拼接，否则中文多字节可能被切断成 `U+FFFD`，进而造成 BI 货号缺字和假聚合错误。
- 飞书接口偶发 `EOF`、`HTTP 500/5000`、限流、TLS/CDN 抖动时应重试，不能发布半新半旧数据。

## 2026-05-03 历史乱码归档
- 原 `MEMORY.md` 和执行记录中含大量历史乱码段落，已在本次清理中归档到 `backups/doc-mojibake-archive-2026-05-03T14-20-00/`。
- 当前 `MEMORY.md` 只保留可复用、当前有效的长期规则；历史排障细节以归档文件和 `docs/` 中的权威运维文档为准。




## ET 货代仓接入口径
- ET 货代后台使用独立浏览器 profile：`profiles/persistent-et-forwarder-profile`；入口为 `http://47.90.12.162:9007/Home/Index` 和 `http://wl.et-global.cn/Home/Index`，只保存浏览器登录态，不把密码写进文档或仓库。
- ET 大部分列表/明细接口必须带 `X-Requested-With: XMLHttpRequest` 请求头；否则同一接口会返回 `404 无法找到资源`。接口 `content-type` 可能是 `text/html`，但正文是 JSON，抓取器不能只按 content-type 判断。
- ET 仓库含义：`ETRUH09散件仓` 为核心可售散件仓；`ETRUH01整箱仓` 为海运整箱/待拆箱仓，部分一件一箱货号可直接按箱出库；`ETRUH03_RTV` 为退货/退回仓；`ETRUH04Damaged` 为破损待换包装仓；`ETRUH06报废` 为毁损报废仓。
- ET 发货申请单对应成本表批次，出库单备注/物流号可关联 SHEIN 订单物流号，RTV 的 `ShipmentNumber` 可关联 SHEIN 退货物流号；匹配不到时应进待复核池，不能硬归并。
- ET 本地每日任务 `SHEIN-Sales-ETForwarder-0420` / `scripts/scheduled_et_forwarder_daily.ps1` 已随本地 BI 封存而禁用；ET 抓取和入仓逻辑仍保留，后续需要迁为云端任务后再恢复自动同步。原日常同步规则为“增量游标 + 重叠校验”，抓到上一轮已见约 5 条记录即停止，不固定重抓长时间窗口。
- ET 财务里的头程/上架等费用先作为成本表核对来源，不默认覆盖用户成本表；仓储费若拿不到 SKU 明细，先按库存体积天数估算分摊并在 BI 明确标注。

## 2026-05-07 ET 货代全量补数与替代边界
- ET 抓取器 `scripts/fetch_et_forwarder.mjs` 已支持 `--endpoints` 分模块、`--skip-details` 列表先行、`--detail-offset` / `--max-details` / `--detail-concurrency` 明细分块；出库和财务账单这类大明细必须分块跑，避免一次性超时或压满电脑。
- `2026-05-07` 已完成 ET 全量主体入仓：出库单约 `6201`、出库明细约 `6188`、RTV 约 `311`、库存流水约 `7408`、财务账单约 `7165`、财务账单明细约 `7137`；评估报告位于 `outputs/et-forwarder/reports/et-forwarder-assessment-2026-05-07.md`。
- ET 可优先替代或增强：实际库存、在途/到仓状态、发货申请单批次、箱明细、出库单、RTV、损溢破损、物流/仓储财务复核。ET 暂不直接替代：国内采购成本、已确认头程/上架/下架成本、月仓储费；这些仍以手工成本表或用户确认后的规则为准。
- ET 发货申请单与手工成本表批次核对当前结果：`84` 个批次数量一致，`2` 个批次数量差异，`13` 个批次在 ET 无同名发货申请单或属于历史/手工补录批次；未确认前不要自动覆盖成本表口径。
- ET 货号归并当前仍需用户确认的重点编码包括：`SK-1713-4-GREY`、`GL-BL02`、`SD-175`、`PL4-6L`、`SK-7025-BLACK`、`CM6810`、`C06`、`C06（04031）`、`SM-520A`、`SK-794`、`CX1788`、`PL4-6LPINK`、`FZ-666Beige` 以及 `p-DL-FZ-666/P-DL-FZ-666/p-DLFZ666` 包材/箱子类；确认前不要写死归并。

## 2026-05-07 ET 货代仓与 RTV 利润口径补充
- ET 货号归并已确认：7025 -> SK-7025A绞肉机，LQ榨汁机175 -> SK-JB-175离心式榨汁机；SM-520A电动缝纫机、CX1788手持搅拌器 是新货号且当前在途；p-DL-FZ-666/P-DL-FZ-666/p-DLFZ666/PDLFZ666 是 FZ-666 包材，报废 是占位编码，均不作为可售货号。
- 8A04PD9、8A04QUP、KYD03172GF、KYD05552GF 是其他货代发货批次，不应当作为 ET 发货申请单缺失报警。
- RTV 利润主口径继续保守：退货/仅退款/派送失败等反转订单主利润仍按营收 0 处理，并按既有规则扣商品成本与必要退货派送费；ET 已收 RTV 只新增“可二次销售测算”金额，不替代主利润。
- 当前 ET 数据能确认 RTV 收到后进入 ETRUH03_RTV 或直接进入 ETRUH09散件仓；暂未抓到可精确关联单件从 ETRUH03_RTV 后续转入 ETRUH09散件仓 的调拨链路。若不能确认进 09，主利润仍按保守方式；二售测算按“ET 已收件”单独展示。
- ET 财务账单已能抓到每日仓储费总账（sort_name=仓储费），但当前账单明细未返回 SKU 级仓储费 item rows；在找到仓储费详情接口前，不要用 ET 自动替代按货号仓储费，只能做月总或估算分摊。

## 2026-05-08 ET 自动登录与验证码
- ET 抓取器若遇到登录态过期，本地回滚可读取 `profiles/persistent-et-forwarder-profile` 里 Chrome 已保存的 ET 账号密码；云端正式链路读取服务器私有 `config/et_forwarder.local.json` 或环境变量账号密码，并用 OCR 识别 `/Login/GetAuthCode` 的 4 位验证码后提交登录；实现文件为 `scripts/et_login_helper.py` + `scripts/fetch_et_forwarder.mjs`。本地 04:20 任务已封存，云端 `shein-bi-cloud-et-forwarder.timer` 已启用并验证成功。
- `scripts/et_login_helper.py credentials` 默认只输出用户名和密码长度；只有抓取器本地进程设置 `ET_LOGIN_HELPER_ALLOW_SECRET=1` 时才返回密码，不得把密码写入日志、文档或聊天。
- ET 自动登录依赖项目本地 `.cache/python` 中的 `ddddocr` 和 `cryptography`，不装到 C 盘；如果 OCR 连续失败、保存密码失效或 ET 登录页改版，任务仍会发飞书异常提醒并保留上一版 ET 数据。
- `scripts/scheduled_et_forwarder_daily.ps1` 已加空日期兜底，避免计划任务无参数运行时把空 `--date` 传给 Node 导致 `Invalid time value`。
- `2026-05-09` 04:20 任务失败不是自动登录缺失，而是首页探测阶段在浏览器页内跨 ET 域名/IP 做 `fetch` 时先抛 `TypeError: Failed to fetch`，导致还没进入自动登录就退出；`scripts/fetch_et_forwarder.mjs` 已改为使用当前页面 `location.origin` 组装同源 URL，并对首页探测 fetch 异常做兜底，避免绕过自动登录。

## 2026-05-16 云端 SSH / watchdog / 问数机器人 / RTV / OpenAPI 边界
- 云端 SSH 直连已恢复：本机别名 `ssh shein-bi-tencent`，服务器用户 `sheinops`，key-only 登录，密码登录关闭；当前临时用 `443` 承载 SSH 是因为本地到 `22` 的 SSH 握手会在到达服务器前被断开。后续正式 HTTPS/域名占用 `443` 前，必须先把 SSH 迁到单独高位端口并同步腾讯云防火墙/UFW。
- 云端异常通知走 `scripts/cloud_ops_watchdog.mjs` + `shein-bi-cloud-watchdog.timer`；销售源/BI 页面按 `4.5h` 阈值，ET 按 `36h` 阈值，SHEIN 业务域 / 链接表现是日更低频数据，按 `48h` 阈值，不要把它们当销售高频刷新失败。
- 云端只读飞书问数机器人走 `scripts/lark_sales_qa_bot.mjs` / `shein-bi-lark-sales-qa.service`，只读取 `outputs/bi-portal/data.json` 回答销售额、订单、销量、店铺排行、产品排行等问题，不写 PostgreSQL、飞书 Base 或运营状态。
- `scripts/verify_shein_rtv_tracking.mjs` 已支持 `--transport webapi`，云端由 `scripts/cloud_rtv_verify.sh` / `shein-bi-cloud-rtv-verify.timer` 跑完整 RTV 换单复核；完整复核仍是异步低频任务，不阻塞每两小时滚动销售刷新。
- HL OpenAPI 云端双跑入口 `scripts/cloud_openapi_hl_reconciliation.sh` / `shein-bi-cloud-openapi-hl.timer` 已部署；服务器出口 IP `43.165.167.135` 已加入开放平台白名单；云端 HL OpenAPI 抓取、入仓和 BI OpenAPI 对账已跑通。
- 2026-05-16 链接/业务域 WebAPI 直连探针：同一 HL session 下 `gsp` 售后统计/列表和发货面单 count 可 Node 直连；`mgs` 履约/评价、`pqmp` 质量、`spmp` 商品列表、`idms` 备货、`sbn` 经营/营销、`gsfs` 财务均返回 `20302 子系统登录重定向`。后续直连改造应先解决子系统登录态/初始化，再处理 SBN `x-gw-auth`；若必须用浏览器兜底，云端只能顺序或小并发（建议 1，最多 2）短时启动并及时关闭，不能 16 店同时开浏览器。
- 2026-05-16 已修复云端 BI “未找到体检文件”：`audit_bi_warehouse.mjs` 支持 Linux 下按权限自动使用 `sudo docker exec`，`cloud_bi_refresh.sh` 在生成 BI Portal 前运行体检；云端验证 `audit.ok=true`、`errors=0`。若普通用户手动运行 watchdog 或 BI 生成脚本，要确认 `/srv/shein-bi/logs`、`state/cloud_ops_watchdog`、`outputs/bi-portal` 等运行目录可写，避免 root 运行后的权限残留。
- 2026-05-16 链接/业务域已完成云端闭环：`cloud_link_business_sync.sh` 服务器日志 `link-business-2026-05-15-20260516-163901.log` 显示 16 店全部 `done`，随后 `load_bi_warehouse.mjs --link-date 2026-05-15`、`load_bi_business_domains.mjs --date 2026-05-15`、BI 体检和门户生成均成功；`dates.linkDate=2026-05-15`、`dates.businessDate=2026-05-15`、`warnings=0/errors=0`。该闭环是云服务器自己抓取，不是本机补抓。

## 2026-05-08 RTV 换单号复核口径
- EMile 等退货物流可能在运输途中更换物流单号；`RTV 已收可二售测算` 不能只靠 SHEIN 售后列表里的 `returnExpressInfoList.expressNo` 单向匹配 ET RTV。
- 已新增反向复核视图 `mart.rtv_manual_review_candidates`：从 ET RTV 已收件出发，列出“ET 有收件物流号，但 SHEIN 售后当前物流号未直接匹配”的记录，并按同货号和时间窗口给 SHEIN 售后候选；ET `DL-` 等 SKU 前缀不能硬当销售店铺，只能作为候选排序线索。
- 10 位以上纯数字 ET RTV 物流号标记为 `suspected_emile_handoff=true`，优先人工进入 SHEIN 退货单物流详情核实；未经人工确认前，这些候选不直接改变主利润，只作为提高二售测算召回率的待复核池。
- BI `订单 / 售后` 页面已新增“RTV 换单待复核”表，展示 ET RTV 单号、ET 物流号、货号/SKU、收件仓、判断原因和 SHEIN 候选。
- 已新增自动直连复核脚本 `scripts/verify_shein_rtv_tracking.mjs`：直接复用各店已登录 Chrome profile / CDP 调 SHEIN 售后详情与退货物流详情接口，自动识别 `new waybill number [...]`、`新的运单号[...]`、`运单已...更换` 等中英文换单号证据，并写入 `ops.rtv_tracking_verification`。
- 已验证示例：`ZL / 16FBC044CV / 6031126719507` 通过物流轨迹换单号 `6031326736754` 匹配 ET RTV `TH26040146319`。
- `mart.rtv_recovery_impact`、`mart.rtv_manual_review_candidates` 已吸收 `ops.rtv_tracking_verification.match_status='matched'` 的结果；本地历史 `07:00` BI 流水线会先跑一轮 high/medium/low RTV 换单自动复核（默认 `--include-no-cases --limit 120 --case-limit 60 --max-runtime-ms 3600000`）再刷新门户。该完整复核待迁到云端，滚动销售刷新不应等待它。
- `JT` / `JTE` 退货物流按“同一运单号直接对应”处理：先全店精确匹配 SHEIN 售后退货物流号，不受 ET 货号编码和 SHEIN 标准货号差异阻断；iMile / EMile 数字单号仍以物流详情里的换单轨迹为证据，不能只凭数字单号相似直接入库。
- `mart.et_rtv_destination_allocation` 用 ET 库存流水追踪 RTV 收到后的去向：直接入 `ETRUH09散件仓`、03 后续调拨入 09、仍在 `ETRUH03_RTV`、进入 `ETRUH04Damaged`、转 `ETRUH06报废` 或其它/未知；按同货号库存池 FIFO 分配，是库存流水级证据，不是序列号级扫描。
- `mart.shein_return_rtv_trace` 是面向 BI 的 SHEIN 退货 -> ET 收件/去向明细视图；BI `订单 / 售后` 页面用它展示每条退货“收到没有、收到后去了哪里”。主利润仍保守，09 去向只进入 `rtv_09_recoverable_cost_sar` / “09 可二售”测算。
