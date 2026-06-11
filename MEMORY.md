# MEMORY

## 2026-05-13 产品套图提示词长期口径
- 产品套图提示词优先服务 SHEIN 沙特市场，兼顾欧洲市场；Amazon / noon / Temu 只作视觉经验参考，除非用户明确要求对应平台版本。
- 英文和阿文同等重要，交付文档前半部分必须是完整可复制英文提示词；按 `Visual Subject / Model & Styling / Scene & Atmosphere / Composition & Text` 写清人物、服装、动作、场景、光线、构图和英阿双语文案，产品始终是主角。
- 用户只要求改提示词时，不要自动更新桌面压缩包；只有用户明确说“重新打包/更新压缩包”才更新 handoff zip。

## 评价、链接对比与动作池核心口径
- 评价/口碑底库按每店开店以来全量补抓；日常增量默认最近 `14` 天。SHEIN 评论接口宽窗口会报 `mgs97906 数据量太多...缩小评论时间`，全量补抓必须按日期窗口分段并可自动拆分。
- 评论中文只使用 SHEIN 后台评论列表接口 `translate: 1` 的平台译文，写入 `fact.product_comment.goods_comment_content_zh`，`translation_provider='shein-platform'`；不再用本地启发式、浏览器插件或第三方翻译作为正式结果。
- 货号页和动作池遇到重复弱链接时，必须从全量 `DATA.storeLinks` / 链接仓库取同店同标准货号链接；链接对比按 `曝光 -> 访客 -> 销量 -> 支付率` 展示，并在每项下显示 `7天 / 30天`。
- `制冰机`、`03038`、`SK-03038` 及异常尾缀统一归并到 `SK-03038制冰机`。
- 货号 360 的 `本店货号合计销售` 是当前时间段“店铺 + 标准货号”的全部 SKC/链接合计，不是最佳 SKC 单独销售；最佳 SKC 只用于承接、替代和弱链接对比。
- 动作池证据必须转成业务可读字段；筛选为空但底库有数据时，评价/订单售后/动作池必须提示是筛选筛空，不能让用户误以为数据丢失。

## 项目边界
- 工作区固定为 `E:\Codex WorkSpace\Shein销售统计`；SHEIN 脚本、配置、日志、输出、浏览器 profile、BI 门户和项目文档都优先放在这里或 D 盘，避免占用 C 盘。
- Windows PowerShell 5.1 的 `$OutputEncoding` 默认是 `us-ascii`，会把中文管道到 `node/python/lark-cli` 时变成 `?`；本机已设置用户级 PowerShell profile 为 UTF-8，并把 CurrentUser 执行策略设为 `RemoteSigned` 以允许 profile 生效。
- 项目 `.ps1` 必须 dot-source `scripts/use_utf8.ps1`，且文件保存为 UTF-8 with BOM，覆盖 `-NoProfile` 计划任务和 PS5.1 对无 BOM UTF-8 的误判；不要再用 PowerShell here-string 直接向 Node/Python 传中文生成代码，必要时用文件 UTF-8 BOM、`apply_patch` 或 Unicode escape。
- 飞书多维表格 / 原生看板写入已按用户要求临时暂停；暂停开关为 `state/feishu-base-sync-paused.flag`。暂停期间云端继续抓 SHEIN、刷新 BI、发送飞书文字日报 / 可视化日报和异常提醒。
- BI 不从飞书反抓数据作为源头；当前业务数据真相源只在云端运行时：云端私有源文件、PostgreSQL warehouse、线上 BI 门户和 `/api/bi/section/*`。仓库内 `outputs/bi-portal/*` 只是灾备/兼容快照，不得用于当前业务判断、口径验收或性能结论。
- 新建飞书 Base 数据表后，提醒用户手动扩容到 `20000` 行；默认 `2000` 行容易写满。
- 正常抓取、同步、日报、watchdog 和 BI 任务必须后台/隐藏运行；非必要不要打开前端浏览器窗口或命令行窗口。只有登录、验证码、人机校验、用户明确要求看前端，或必须排查浏览器交互问题时才打开可见窗口；临时验证必须优先用静态检查、HTTP/API、CDP 后台连通或 hidden/offscreen，并在验证后关闭。
- Chrome 程序路径优先使用 `C:\Program Files\Google\Chrome\Application\chrome.exe`；D 盘路径只作兜底候选。店铺登录态仍在工作区 `profiles/`，不要因为程序在 C 盘就把 profile 移回 C 盘。

## 店铺、账号与统计口径
- 当前 19 店：DSY 组 `DL DX FY LQ NM HL JY ZL TS MZ`；LGM 组 `CX YJ XL QY QH TZ JSH TZZ XC`。新增 LGM 三店 `JSH/TZZ/XC` 已完成本地与云端登录、销售/链接/业务域入仓和 BI 刷新；三店 `accountUtcOffsetHours=8`，端口分别为 `9349/9350/9351`，profileKey 为 `jsh/tzz/xc`。
- 当前 19 店登录态保存在 `profiles/persistent-*-profile`；不要删除整个 profile。若要瘦身，只清理 Chrome 可重建缓存，例如 `OptGuideOnDeviceModel`。
- 2026-06-05 已覆盖旧的 YJ/XL/QY 交叉 profile 结论：当前正确映射为 `YJ=profileKey yj/accountNo GS8146729/port 9346`、`XL=profileKey xl/accountNo GS9307061/port 9344`、`QY=profileKey qy/accountNo GS7451160/port 9345`。后续核验店铺错位必须同时比对 `config/stores.json`、`config/store_account_truth.json`、浏览器保存账号、实际登录后的店铺名/账号和 live 抓数归属；不能再用 `2026-05-10` 的 profile 目录名交叉结论指导生产操作。
- 2026-05-08 已删除 8 个 `profiles/*/OptGuideOnDeviceModel` Chrome 可重建模型缓存，释放约 `31.81GB`；清理日志为 `outputs/cleanup/chrome-optguide-cache-delete-20260508-143959.json`。删除后当时店铺 profile、飞书 profile、ET profile 和 BI 入口均已验证仍存在。
- HL 已切换为主账号：`profileKey=shein-main`，CDP 端口 `9360`，正式 profile 为 `profiles/persistent-shein-main-profile`；旧 `profiles/persistent-hl-profile` 已删除。
- LGM 组当前本身就是主账号，不需要替换。
- 统计日按北京时间自然日；订单销售以 SHEIN 订单创建时间为准。除非用户明确确认，不给单店保留猜测性时区偏移。
- 销售有效性必须统一走 `lib/shein_sales_validity.mjs`：源头总销售只剔除真正取消、揽收前取消等“未形成销售”的商品行，例如 `pageStatus=CANCEL`、`goodsPerformanceStatus=6`、订单/履约状态文本含取消；用户已退款、退货、派件失败等不能在源头抹掉，应保留为总销售，再由净销售额、售后/利润层反转。后台原始金额仍保留在明细中用于追溯。
- `2026-05-13` 已按取消单源头剔除口径写回 `2026-05-11` 至 `2026-05-13` 本地销售 summary；样本为 LQ `2026-05-12` 无货取消 `SK-5118电磁炉` 从业绩剔除，LQ 当日总销售 `211.67 SAR`。此前提到全历史约 `43,472.16 SAR` 是把退款/退货/派件失败误当源头取消的错误 dry-run 结果，已作废；修正后全历史金额影响仅 `68 SAR`，且就是这笔 LQ 取消单。
- 固定汇率：`1 SAR = 1.8 RMB`；`25%` 只能作为新选品或缺成本试算口径，不得冒充 BI 首页或成本/利润页的真实利润。
- 遇到 SHEIN 接口 `20302 子系统登录重定向`，先自动恢复登录并重抓；恢复失败时明确提示人工登录，不能用旧数据冒充最新数据。
- 判断店铺登录态/错位时，不要仅凭页面文本或页面里出现的店铺号下结论；应以实际订单接口返回、稳定日期重抓与数据库样本对账为准。当天数据会继续变化，不适合作为最终 profile 错位判断样本。

## 飞书资产与生产链路
- 正式 Base：`https://zcnm3ts63aph.feishu.cn/base/SnnQbrAu6aLzMWsnEICcy0cKnJh`，标题已加暂停备注 `【多维表格同步暂停｜日报正常】SHEIN沙特半托自动驾驶座舱`；这是人工可见提醒，不代表删除 Base。
- 当前月主看板：`SHEIN经营看板 v3-主看板`，Dashboard ID `blkFn3qHrwdsrJyX`，读取 `看板数据-MAIN-*`。
- 上月看板：`SHEIN经营看板 v3-上月`，Dashboard ID `blkWeyZhphgRZYim`，读取 `看板数据-PREV-*`。
- 旧 `看板数据-DSY-*`、`看板数据-LGM-*`、`看板数据-ALL-*` 和旧 Dashboard 已清理，不要恢复为正式链路。
- 程序化读取飞书 Base 记录时必须显式使用 `--format json`，避免解析旧格式导致误判。

## 计划任务
- 2026-05-15 起生产调度转为云端 systemd timer：`shein-bi-cloud-today.timer` 在北京时间 `00:10/02:10/.../22:10` 每两小时刷新当天销售、入仓并生成 BI Portal；`shein-bi-cloud-yesterday.timer` 每天 `00:10` 刷新前一天最终销售并复核前两天稳定日；`shein-bi-db-backup.timer` 每天 `02:30` 备份业务库和 Metabase 元数据库。
- 本地 `SHEIN-*` Windows 计划任务已全部禁用，保留为回滚/迁移参考，不再作为生产调度。除非用户明确回滚，不要重新启用 `SHEIN-Sales-15Stores-Intraday-Daytime`、`SHEIN-BI-Daily-Pipeline-0700`、`SHEIN-Sales-15Stores-LinkManagement-0530`、`SHEIN-Sales-ETForwarder-0420` 或 HL OpenAPI 本地任务。
- 云端自动化已覆盖销售 WebAPI 直连、销售入仓、BI Portal 生成、数据库备份、ET 同步、飞书日报、完整 RTV 复核、链接/业务域日更、异常通知 watchdog、只读飞书问数机器人和 HL OpenAPI 双跑；本地 Windows 任务只作回滚参考。
- ET 和飞书日报已启用云端 Linux 入口：`scripts/cloud_et_forwarder_sync.sh` / `shein-bi-cloud-et-forwarder.timer`、`scripts/cloud_daily_lark_report.sh` / `shein-bi-cloud-daily-lark-report.timer`。ET 服务器侧使用私有 `config/et_forwarder.local.json` 或环境变量账号密码，不能复用 Windows Chrome 保存密码；ET 入仓依赖 Docker/root 环境，服务仍保留 root 执行，但验证码下载的一次性 `fetch failed` 必须进入重试而不是直接中断。飞书日报服务器侧使用独立飞书 CLI 应用/机器人与私有 `config/lark_report.json`，旧应用的 `open_id` 不能直接给新应用用，换机器人时需用 `union_id` 重新映射收件人 `open_id`。上述 secret/token/收件人完整 ID 不进 GitHub、文档或聊天。2026-05-16 云端 ET 全量同步和云端飞书日报真实发送均已验证成功。
- 链接/业务域已启用云端 Linux 入口：`scripts/cloud_link_business_sync.sh` / `shein-bi-cloud-link-business.timer`，每天 `08:10` 顺序跑前一完整日；它通过 `scripts/restore_shein_store_session.mjs` 用服务器私有 `state/shein_browser_sessions/*.local.json` / `state/shein_webapi_sessions/*.local.json` 初始化 headless Chrome，并验证 GSP + SBN 后再抓取、入仓、体检并刷新 BI；若全店日指标仍全 0，则跳过入仓刷新，避免把未出数日期写入 BI。`shein-bi-cloud-link-business.service` 必须以 `sheinops` 运行，不能用 root 写 SHEIN 店铺 profile，否则次日 `shein-bi-cloud-session-manager.service` 会因 root-owned profile 报 `EACCES`。不要再用本机隐藏补抓冒充云端日更；纯 Node 零浏览器直连只是后续优化。
- 云端覆盖审计口径：最新日防漏用 `scripts/audit_cloud_data_coverage.mjs --expected-start range-start`，要求当前应覆盖店铺齐全；历史断档排查用 `--expected-start first-seen`，只检查每个店首个有效日期之后是否中间断档，不得把店铺未开通/未接入前的日期当成缺抓。销售按 first-seen 复验无历史中间断档；链接/流量若出现 first-seen 后缺店才需要补。
- 云端飞书日报图依赖 Linux 中文字体；服务器必须安装 `fonts-noto-cjk` / `fontconfig`，`fc-match 'Noto Sans CJK SC'` 应匹配 Noto CJK，否则 headless Chrome 生成的日报图中文会显示方框。
- GitHub 中的 `outputs/bi-portal/index.html` / `data.json` 是灾备静态快照；服务器执行 `git reset --hard origin/main` 或类似部署后可能覆盖实时 BI 页面。每次服务器拉取/重置代码后，必须重跑 `scripts/cloud_bi_refresh.sh today intraday` 或 `shein-bi-cloud-today.service`，确认 `generatedAt` / `salesUpdatedAt` 更新到当前。BI 用户可见改动先在云端页面/服务输出验证，用户确认后再发布 GitHub release；本地验证不替代云端最终审核。
- 本地历史规则仍可作回滚参考：RTV 复核耗时长是正常现象，滚动销售刷新不应等待完整 RTV；BI 门户生成必须在流水线末尾单次执行，默认 `SHEIN_BI_PORTAL_TIMEOUT_MS=900000`，不要恢复“流水线完成 / 简报 / 首次体检”多个状态点重复生成页面。
- 飞书 Base / 看板写入仍受 `state/feishu-base-sync-paused.flag` 约束；飞书日报和 watchdog 已云端化，但不要默认认为本地日报/提醒任务仍在生产运行。
- 飞书日报文字和日报图不得再附飞书 Base / 多维表格 / 原生看板链接；日报图店铺排行必须从 `config/stores.json` 当前启用店铺完整渲染，不能沿用旧 Top15/16 店截断。

## 数据与货号归并
- 销售 / 订单历史已全量入 BI 仓库；链接、售后、履约、财务按价值和接口能力逐步补历史，库存只保留最新与滚动快照，不补开店以来全量。
- 货号 360 / 店铺×货号覆盖必须按“每个店自己的最新链接/覆盖快照”聚合，不能用全局 `max(date)` 过滤；全店同步常会分批完成，若只取全局最新日，会把未在该日完成同步的店铺误判为没有链接。
- 标准货号清单：`config/product_catalog.json`；别名归并：`config/product_aliases.json`；归一化逻辑：`lib/product_sku_normalizer.mjs`；用户可见产品主标题由 `lib/product_display_name.mjs` 生成 `product_display_name`，优先显示完整“标准货号+中文品名”，但后台 key 仍是 `standard_goods_sn`。
- 仓库 `dim.product_match_key()` / `dim.product_canonical_sn()` 必须由 `config/product_aliases.json` 同步生成（`scripts/generate_product_match_key_schema.mjs`），不能在 SQL 里长期手写一份会漂移的别名表；营销活动前尤其要验证 ET 短码如 `SK-3065`、`SK-675` 能归并到对应标准货号。
- `BL02` / `GL-BL02` / `BL02热水壶` 已确认归并到 `S1810电热水壶`；仓库 `dim.product_match_key()`、库存页、BI 前端和飞书问数机器人都应按 S1810 处理，不再展示独立 BL02 库存产品行。
- 货号开头括号备注不参与归并，例如 `（待定）SK-123`、`（废）SK-123`、`(废)SK-123` 都按 `SK-123` 处理。
- `CM-121E美式咖啡机`、`121E美式咖啡机`、`121E`、`CM121E`、`CM-121E` 是同一个 121E 咖啡机，统一归并到 `CM-121E美式咖啡机`；用户 2026-05-11 咨询低库存保留店铺时已按合并口径判断。
- 发现无法归并、疑似新货号或只凭短号/标题拿不准的货号时，必须汇总给用户确认，不得擅自合并。

## 链接管理规则
- 飞书链接管理功能已废弃：不再写入飞书链接管理表，不再维护飞书链接看板；日常链接管理只走云端私有源文件 / PostgreSQL / BI 门户。
- 历史飞书链接表仅保留查档且已加前缀：`（暂废弃）链接管理-链接主数据`、`（暂废弃）链接管理-表现日事实`、`（暂废弃）链接管理-展示库存日事实`、`（暂废弃）链接管理-货号店铺覆盖`、`（暂废弃）链接管理-建议`、`（暂废弃）链接管理-今日实操清单`。
- `scripts/run_link_management_job.mjs` 默认 `BI/local-only`，不会写飞书；`scripts/sync_shein_links_to_lark.mjs` 默认拒绝执行，只有显式设置 `SHEIN_ENABLE_DEPRECATED_LARK_LINK_SYNC=1` 才允许一次性历史迁移。
- 已标 `废` 且已下架的链接只作为历史状态忽略，不进入建议或今日实操，也不提醒归档。
- 如果某货号当前启用店铺都没有上架链接，按暂不上或库存未到处理，不进缺链接提醒；只有部分店已上架、部分店缺上架时才提醒补链。
- 待上架链接若后台返回缺证书、缺资质、缺资料、审核驳回等原因，应进入建议和实操清单。
- 备货信息里的库存口径不可信，不用于库存低提醒；正确展示库存优先来自商品列表库存接口，后续真实库存等外部系统接入。
- 今日实操清单必须保持可操作数量，不恢复到千级全量模板建议。

## 营销活动报名规则
- SHEIN 营销活动自动化只允许辅助勾选商品、填写活动价/降幅和复核，不得点击最终 `提交报名`；最终提交必须由用户在可见前端人工审核后点击。
- 营销活动报价规则以 `docs/marketing-campaign-signup-pricing-rules.md` 为准：固定价货号按“基准价 + 随机下浮 `2 SAR` / 上浮 `1 SAR`”填报；利润率货号按“目标利润率随机下浮 `2` 个点 / 上浮 `1` 个点”反推；用户点名固定价/利润率优先于新品保护价和清货候选价；其它货号默认按 `30%` 利润率并允许 `28% ~ 31%` 浮动，平台最低折扣/页面回写作为最终硬约束记录。
- 营销定价机器可读策略在 `config/marketing_pricing_policy.json`，共享逻辑在 `lib/marketing_pricing_policy.mjs`：限时折扣是必须存在但不得干扰目标价的兜底层，默认 `15%` 折扣起算；同货号 BI 正曝光前五 SKC 可比其他链接低 `5` 个百分点目标利润率但不得低于 `15%` 底价，基础目标已是 `15%` 时前五保持 `15%`、其他提高到 `20%`；固定价和逐行覆盖价优先。无正曝光指标不得按 SKC 字典序猜前五。
- 营销活动选择商品页必须先把右下角每页显示改成 `500 条/页` 再全选，并核对 `总计 N 个` 与 `已选商品 N 个` 一致；标准导出不能只读前端 DOM，因为 SHEIN 表格虚拟滚动即使 500 条/页也可能只挂可见行，必须优先用 `query_supplier_goods_list_v2?page_size=500` 接口全量取数并核对 `total`。
- 当前用户指定规则：`SM-505A/TXSM-505A电动缝纫机 -> 110`、`KF-JN-02便携咖啡机 -> 96`、`SK-185台式榨汁机 -> 91`、`SK-03012台式榨汁机 -> 96`、`SK-03038制冰机 -> 330`；`FZ-666颈部按摩器 -> 15% 利润率`；`SK-7025A/SK-7027/SK-7028 绞肉机 -> 25% 利润率`。
- 用户质疑营销活动漏报或要求“再检查”时，必须逐店重新扫描 DSY 店铺（含 `MZ`，除非用户明确排除）全部未截止可报名活动；默认排除优惠券活动，只有用户明确要求才带 `--include-coupon`。活动列表必须分页全量读 `get_activity_list?page_size=100`，不能只读第一页 / 前 30 条。
- 优惠券活动不要套普通营销活动报名路径；活动 `34810 / 平台优惠券招商活动` 已验证正确链路是 `#/mbrs/marketing/coupon/detail/34810` -> `继续报名` -> `#/mbrs/marketing/coupon/rule/signup/34810/{levelRuleId}?from=detail`。批量导入 `确定` 会直接真实提报；配套券长期目标必须是“普通活动 selection-plan ∩ 15% 可报集合”，不能把 `MULTI_LEVEL_RULE_GOODS` 全量可报 SKC 都当成应报目标。
- 优惠券提交入口 `scripts/marketing/submit_coupon_activity_goods.mjs` 默认必须传 `--target-plan`，只有显式 `--allow-all-15pct-available` 才能全量报名；只读复扫 `scripts/marketing/export_marketing_stack_review.mjs --coupon-target-plan <plan.json>` 必须看 `15%券档已报是否等于普通计划` 和 `15%券档已报但不在普通计划数`，不要把“可报未入已报集合”误判成漏报；遇到 MBRs `20302` 先自动进入登录页并用真实鼠标点击恢复，恢复失败才报告具体登录/身份/接口阻塞。真实 15% 券提交路径会读取最新 `marketing-stack-review` 和旧普通活动填报价；活动扫描过期、stack review 不可用、证据目录缺失/解析失败，或目标 SKC 有旧普通/度假季标签但无旧活动价证据时，必须 fail closed。
- 优惠券误报取消不能用普通活动 `batch_cancel_partake_goods` / `cancel_activity`；多档券取消页是 `#/mbrs/marketing/coupon/rule/goods/{activityId}/{levelRuleId}`，接口是 `/mrs-api-prefix/mbrs/activity/multi-level/partake/cancel`，payload 来自已报集合的 `partake_good_id`、`partake_level_rule_id`、`partake_rule_good_id`、`skc`。取消前必须二次加载普通活动计划，禁止取消配套计划内 SKC。
- 新一期活动报名前必须先做“叠加安全审核”，把普通营销活动、优惠券、限时折扣按时间窗口合并；同一窗口取最低普通活动/限时折扣价后再叠加优惠券，审核表必须展示原始/当前价、商品成本、仓储费摊销、含仓储费成本、最终成交价、商品利润率、含仓储费利润率、风险提示和用户备注栏。目标只到定规则时不得报名新活动，也不得批量取消/重报限时折扣。
- 营销确认表的仓储费/件必须用 ET 当前仍在仓库存的移动平均累计仓储成本（BI `profit.productStorageDaily` 每日仓储费加入库存成本余额；库存数量下降时按当前平均成本剔除已出库产品携带的历史仓储成本），不得用累计仓储费除以历史销量，也不得把全历史仓储费一刀切压到当前库存。确认表生成后必须跑 `scripts/marketing/verify_marketing_sku_approval.mjs`，覆盖用户标注回归、全表仓储正数、利润率同价同口径、券策略无歧义和旧别名不独立出现。
- `SK-13034` 是营销活动缺成本的明确例外：用户说明该品不用管、按平台默认最低折扣先填；此例外不得自动扩展到其它缺成本货号。
- 若用户先审核标准，交付应是“按标准货号一行”的汇总表，不要让用户看 700+ 行执行明细；用户备注转换为 `outputs/reports/marketing-price-overrides-YYYY-MM-DD-approved.json` 后，填报必须带 `--price-overrides`，其中 `storeKey + activityId + skc` 逐行覆盖价优先级高于全局固定价/利润率。
- `2026-05-06` MZ 店铺两个活动已由用户自行提交：`SA-超级爆品活动-第39期 / 40228` 和 `SA New Arrivals Promo_Batch 39 / 40227`；后续不要重复操作 MZ 已提交活动。
- 营销活动半自动入口：先运行 `python scripts/marketing/build_marketing_cost_map.py`，标准导出用 `node scripts/marketing/export_dsy_marketing_standards.mjs --stores DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ --all-open`，填报用 `node scripts/marketing/dsy_marketing_deadline_fill.mjs --stores DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ --all-open --price-overrides outputs/reports/marketing-price-overrides-YYYY-MM-DD-approved.json --min-discount-fallback SK-13034`；结果和审计在 `tmp/mbrs/deadline-fill-results/`。
- 浏览器操作必须用用户可见前台；若有店铺未登录，先用 `scripts/auto_relogin_shein_store.mjs` 或可见页面自己点登录。填完后只保留需要用户提交的活动编辑页，关闭列表页、中间页和无需提交的店铺窗口。
- 本系统长期定位不只是 BI 数据分析，也是自动运营驾驶舱；所有写操作默认按“建议/预填/用户复核/人工最终提交/审计留痕”推进，除非用户明确授权并已有回滚方案，否则不得直接提交不可逆运营动作。

## SHEIN BI 系统
- BI 数据判断、开发验收和故障排查只认云端运行时：云端 PostgreSQL warehouse、云端 BI 门户、线上 `/api/bi/section/*`、云端日志和 systemd 状态；仓库快照可能严重过期，只能作为灾备/兼容产物，不能拿来判断当前经营数据。
- 架构原则：`SHEIN 后台/WebAPI/OpenAPI 抓取 -> 私有源文件 / PostgreSQL 数据仓库 -> Metabase BI / BI Portal`。PostgreSQL 是核心数据仓库；Metabase 当前仍是正式深度分析/自由钻取层，BI Portal 是日常经营入口。没有完整替代前，不要建议直接删除或跳过 Metabase。
- 2026-05-15 起本地 BI 已封存，云端 BI 为正式入口：`https://shein-bi.faceair.me/`，旧 IP `http://43.165.167.135/` 仅作兜底；Basic Auth 账号密码不写入仓库、文档或日志。本地 `8787` 服务已停止，`SHEIN-*` Windows 计划任务已禁用；除非明确回滚，不要重新启用本地 BI 或本地定时任务。云端可复用改动必须及时同步 GitHub，敏感 session/密钥/数据库 dump 仍不得提交。
- HL OpenAPI 销售试点已建立并行链路：`outputs/shein_openapi_fetch/HL/YYYY-MM-DD.json` -> `scripts/load_shein_openapi_sales_warehouse.mjs` -> `fact.openapi_store_daily_sales` / `fact.openapi_order_header` / `fact.openapi_order_item` / `mart.openapi_sales_reconciliation`；系统状态页会显示 “SHEIN OpenAPI 试点对账”。正式切换生产事实表前必须继续确认多日 `matched`。
- 官方 OpenAPI 与后台 WebAPI 直连是两条不同链路：OpenAPI 需要开放平台应用、授权、`openKeyId` / `secretKey` 和 IP 白名单；后台 WebAPI 直连复用已登录 Cookie/session，当前已优先承接 19 店销售生产抓取。两类密钥/session 都禁止进入仓库。
- CX 开放平台应用 `CX-椿霞SHEIN运营中台` 已在 `2026-05-10` 提交审核；ZL 开放平台应用 `ZL-紫翎SHEIN运营中台` 已在 `2026-05-28` 提交审核。两者均为半托管，业务功能选择商品管理、商品合规、订单管理、库存管理、财务管理；审核通过后再录入本地 `.local` 密钥并接入 API 双跑。
- SHEIN OpenAPI 若返回 `openapi00002 IP is not in the whitelist`，优先检查服务器出口 IP `43.165.167.135` 是否在开放平台白名单；ZL 申请时还添加过本机出口 `38.181.81.164`，历史本机出口 `188.253.112.44` / `82.27.116.13` 只作排障参考。不要把 OpenAPI app secret、店铺 secret、openKeyId 写入聊天、文档或日志。
- BI Portal 生成脚本为 `scripts/generate_bi_portal.mjs`；云端由 `scripts/cloud_bi_refresh.sh` 刷新 core 并启动 `prewarm_bi_portal_sections.sh`，`serve_bi_portal.mjs` 还会在服务启动和首页访问时用 core `generatedAt` watcher 兜底后台预热 section。线上运行态的 API section cache 在云端 `outputs/bi-portal/sections/`，首页首屏应命中轻量 `homeRankings`（不是完整 `rankings`）和 gzip sidecar；`homeProfit` 必须从当前 `profit` cache 派生，`sourceGeneratedAt` 必须等于当前 core 且 `staleSource=false`，旧源利润不能当成当前业务真相。仓库内 `outputs/bi-portal/index.html` / `data.json` 只是灾备/兼容快照。
- BI 门户 UI 冒烟检查脚本为 `scripts/check_bi_portal_ui.mjs`；本地封存后默认不要为“看一眼”重新打开本地前端，云端验证优先用 HTTP health、静态断言和日志。V1 时间筛选弹窗的关键不变量：日期输入是文本 `YYYY-MM-DD`，月份切换后弹窗保持打开并更新月份，绑定根节点必须是实际弹窗而不是旧 toolbar root。
- GitHub 私有仓库已纳入 `outputs/bi-portal/index.html` 和 `outputs/bi-portal/data.json` 作为 BI 门户灾备/兼容快照；它们不代表当前云端经营数据。`outputs/` 其他抓取结果、报表、图片、审计结果仍默认忽略，迁移生产状态时单独备份。
- V1 仍是当前正式 BI Portal；V2 只是独立经营 BI 预览版，由 `scripts/generate_bi_portal_v2.mjs` 输出到 `outputs/bi-portal/v2/index.html`。V2 数据判断和验收必须走云端运行态/线上 section API；仓库快照只作页面启动兼容。用户明确验收前不得替换 V1、改生产调度或把 V2 整站视为可替换 V1。
- BI 门户侧栏“链接表现数据”更新时间必须显示链接源文件抓取时间，即 `outputs/shein_links/<店铺>/<链接日>.json` 的 `fetchTime` 最大值；“售后/库存/财务数据”也必须显示业务域源文件抓取时间，即 `outputs/shein_business_domains/<店铺>/<业务日>.json` 的 `fetchTime` 最大值；不要用 BI 重跑入仓时的 `updated_at` 冒充抓取时间。
- 云端 Metabase / PostgreSQL 运行在腾讯云 Ubuntu + Docker；本地旧 WSL + Docker 数据盘仅作历史/回滚参考，长期生产不要再依赖本地 WSL。
- 若本地旧 Docker / Postgres / Metabase 出现 `input/output error`，优先怀疑 `D:\SheinBI\docker-data\docker-data.ext4` 文件系统异常；恢复顺序是先停止 WSL / Docker，再做 volume 备份和 `e2fsck -fy`，最后重启容器并跑 BI audit，不要直接删除 Docker 数据。
- Metabase 管理员凭据只保存在 `infra/metabase/.admin.local.json`，不要写入聊天、文档或日志。
- 当前团队访问转为云端入口；本地局域网协作入口已经封存。若后续明确回滚到本地，才重新检查 `0.0.0.0:8787`、防火墙规则 `SHEIN BI Portal LAN 8787 ReadOnly` 和 `scripts/fix_bi_lan_firewall.ps1`。

## BI 门户 UI 当前规则
- 详细 UI 规则以 `docs/bi-portal-ui-current.md` 为准；`MEMORY.md` 只保留下次开发最容易踩坑的红线。
- 首页“总控驾驶舱”的矩阵、趋势、排行必须同时受时间、店铺/分组、货号/SKC/品名筛选影响；货号 + 店铺组合要用店铺×货号日粒度数据，不要只看全局货号汇总。
- 顶部 sticky 工具栏只放全局筛选；动作池专用筛选只影响动作池。今日动作池是当前待办池，不按时间段回看，且同店同 SKC 同业务域多规则必须合并成一张动作卡。
- 短数字/短编号货号筛选优先匹配标准货号、店铺货号、供应商货号；不要匹配 SKC 长编号任意中间片段。
- 侧栏各数据域更新时间必须显示源文件抓取时间，不用入仓 `updated_at` 冒充。
- 修 BI 门户 UI 时默认不主动打开前端；先用代码检查、生成、HTTP/API、静态 HTML/JSON 断言。只有用户要求或必须排查浏览器交互/视觉问题时才打开最大化真实页面。

## 实际库存与去化口径
- 详细口径见 `README.md` / `docs/bi-portal-ui-current.md`；这里保留红线：库存基数来自成本表完整批次，消耗按毛销量扣减，退货/仅退款/派送失败暂不加回库存。
- 店铺/分组筛选只影响销售速度和风险排序，不硬拆物理库存；该页面是经营估算库存，不是仓库实盘。

## 成本与真实利润口径
- 详细口径见 `README.md`、`docs/data-model.md`、`docs/bi-warehouse-model.md`；首页和成本/利润页不得用 `25%` 预测利润冒充真实利润，成本未覆盖必须显示缺口。
- 售后/退货金额优先用订单实收/预计收入字段；所有未取消售后默认计入退货/反转，最终取消后再冲回。`sales_sar <= 0` 或 `gross_revenue_sar <= 0` 的揽收前取消 / 0 金额行不计订单、销量、成本或退货派送费。
- 2026-05-29 云端 SQL 重审确认：主利润公式未发现少扣退货；5 月利润暂高主要因售后反转率仍低、成本率较低和退货快递费较少。看月利润必须同时看订单创建月利润和售后申请月回冲影响，未成熟月份不能当最终利润，详见 `docs/bi-profit-audit-2026-03-05.md`。
- 成本表正式文件为 `inputs/costs/成本.xlsx`；`单台总成本（SAR）` 是单批单件完整成本，入库后按完整批次加权平均，匹配键走 `dim.product_match_key()`。
- 成本/利润页必须受顶部时间、店铺/分组、货号/SKC 筛选影响；高/低利润分界线固定 `20%`。利润分组里 `TS`、`MZ` 开店以来都归 `DSY`。
- 真实利润核心对象：`fact.product_cost_batch`、`fact.et_storage_fee_product_detail`、`dim.storage_fee_policy`、`mart.product_unit_cost_current`、`mart.et_storage_fee_daily`、`mart.storage_fee_store_daily`、`mart.storage_fee_product_daily`、`mart.profit_order_item`、`mart.profit_daily_store_product`、`mart.profit_month_group`、`mart.profit_product_summary`；`fact.monthly_storage_fee` 仅保留为旧手工/历史兜底表。

## 工具与避坑
- SHEIN 销售抓取主链路自 `2026-05-11` 起为 Node WebAPI 直连优先：`config/stores.json` 当前 19 店 `salesTransport=auto`，`fetch_shein_sales.mjs --transport webapi|auto` 直调 `/gsp/orderPlus/listOrder` / `listOrderItem`；Chrome DevTools/CDP 主要用于导出/刷新 Cookie session、登录续期和回退。
- `state/shein_webapi_sessions/*.local.json` 是 SHEIN 后台 WebAPI 直连的敏感 Cookie session，本地使用且被 `state/` 忽略；不要提交 GitHub、写入文档或聊天。`2026-05-08` 16 店销售 WebAPI 对账已与现有数据库一致，资源实测文件为 `outputs/cloud-migration/webapi-allstores-resource-20260511-201715.json`。
- `run_sales_sync_job.mjs` 在 `salesTransport=auto` 时先 WebAPI 直连；直连成功不启动浏览器，直连失败才启动/刷新对应 Chrome profile 并可继续兜底到后台窗口模式。`launch_store_browser.mjs` / `launch_shein_main_browser.mjs` 在 Windows 下通过 `PowerShell Start-Process` 后台启动 Chrome，避免 `cmd start` 的路径空格问题和 Node detached Chrome 的 libuv assertion。
- `config/lark_report.json` 是日报接收人配置，必须保持合法 UTF-8 JSON；若自动日报读取失败，先校验这个文件。
- `scripts/generate_today_detailed_report_image.mjs` 用于生成只含今日数据的详尽长图，适合临时重发今日战报。
- 飞书看板富文本和卡片样式更新使用 Playwright + 已登录飞书 profile。
- PowerShell 直接运行某些 `.ps1` wrapper 容易被执行策略拦截；优先使用 `.cmd`、`.exe`、`cmd /c` 或已验证的隐藏 VBS 启动方式。
- 不要用 PowerShell here-string 写大量中文 JS/JSON，容易造成编码污染；中文字段、货号、Dashboard 名称优先用 UTF-8 文件、Node 脚本或 `apply_patch`。
- Node 脚本读取大体量子进程 stdout（尤其 PostgreSQL/psql JSON）时，必须收集 Buffer chunks 后 `Buffer.concat(...).toString('utf8')`；不要在每个 `data` chunk 上直接 `toString()` 拼接，否则中文多字节可能被切断成 `U+FFFD`，进而造成 BI 货号缺字和假聚合错误。
- 飞书接口偶发 `EOF`、`HTTP 500/5000`、限流、TLS/CDN 抖动时应重试，不能发布半新半旧数据。

## ET 货代仓核心口径
- ET 货代后台使用独立 profile；云端正式链路读取服务器私有 `config/et_forwarder.local.json` 或环境变量账号密码，不把密码写入文档、仓库、日志或聊天。大部分列表/明细接口必须带 `X-Requested-With: XMLHttpRequest`。
- ET 仓库核心含义：`09` 可售散件、`01` 整箱、`03_RTV` 退货、`04Damaged` 破损、`06` 报废。
- ET 可增强库存、在途/到仓、发货申请单、箱明细、出库、RTV、损溢破损、物流/仓储财务复核；仓储费利润口径以 ET 物流仓服账单 `仓储费` 为正式来源，实际扣费按显示金额减半后折 SAR，店铺/DSY/LGM 按净销售额分摊，货号层优先 ET `ExportStoreFee` 明细，缺明细日期才允许体积库存天数估算并标注兜底。活动定价用的单件仓储费按库存数量口径算，不按销量口径算。
- ET 抓取器支持分模块、列表先行和明细分块；匹配 SHEIN/ET 时宁可进待复核池，不能硬归并。自动登录由 `scripts/et_login_helper.py` + OCR 处理，失败时发飞书异常并保留上一版 ET 数据。
- ET 货号归并：已确认 `7025 -> SK-7025A绞肉机`、`LQ榨汁机175 -> SK-JB-175离心式榨汁机`；`SM-520A电动缝纫机`、`CX1788手持搅拌器` 是新货号且当前在途；`p-DL-FZ-666/P-DL-FZ-666/p-DLFZ666/PDLFZ666` 是 FZ-666 包材，`报废` 是占位编码，不作为可售货号。未确认编码不要写死归并。
- `8A04PD9`、`8A04QUP`、`KYD03172GF`、`KYD05552GF` 是其他货代发货批次，不应作为 ET 发货申请单缺失报警。
- RTV 利润主口径保守：退货/仅退款/派送失败等反转订单主利润仍按营收 0 并扣成本/必要费用；ET 已收 RTV 只新增“可二次销售测算”，不替代主利润。

## 云端生产、RTV、问数机器人与链接管理口径
- 云端 SSH 本机别名 `ssh shein-bi-tencent`，用户 `sheinops`，key-only；`https://shein-bi.faceair.me/` 通过 HAProxy 在 443 分流 SSH/HTTPS，Caddy 管 TLS，nginx + Basic Auth 转 BI Portal。不要绕过网关直接暴露 Node。
- 云端自动化已覆盖销售 WebAPI、BI、数据库备份、ET、飞书日报、完整 RTV 复核、链接/业务域日更、watchdog、只读飞书问数和 HL OpenAPI 双跑；本地 Windows 任务只作回滚参考。watchdog 阈值：销售/BI `4.5h`、ET `36h`、业务域/链接日更 `48h`，不要把低频日更当销售高频失败。
- 链接/业务域当前生产是云端顺序 headless Chrome + 私有登录态日更；纯 Node 零浏览器直连仍是后续优化。若浏览器兜底，建议并发 1、最多 2，不能全店同时开。
- 2026-05-19 链接/业务域日更报错根因是 SBN 商品分析子系统登录态丢失：销售 WebAPI 正常不代表 SBN 可用。`bootstrap_shein_browser_session.mjs` 必须合并新鲜 WebAPI cookie 与浏览器导出的子系统 storage；`cloud_link_business_sync.sh` 部分失败时默认不入仓刷新 BI，避免把不完整结果展示成全量成功。若云端 SBN 态失效，优先从本机已保存密码自动登录并导出 `state/shein_browser_sessions/*.local.json` 同步到云端私有目录，session 不进 GitHub。
- 云端 Codex / 飞书问数机器人为受控只读网关：`shein-bi-lark-sales-qa.service` -> `scripts/lark_sales_qa_bot.mjs` -> `codex exec --sandbox read-only`，`CODEX_HOME=/home/sheinops/.codex`；不绑定本机 Codex App，本机关机不影响。`auth.json`、`config.toml`、第三方凭据只在服务器私有目录，不进 GitHub、文档或日志；飞书/BI 不能裸调用 shell 或 Codex CLI。
- 云端飞书问数机器人支持“受控图表能力”：只基于当前 BI JSON 生成店铺销售、货号排行、链接表现、ET/库存去化等 PNG 图表并用飞书图片回复；渲染脚本为 `scripts/render_lark_qa_chart.py`，依赖服务器 `python3 + Pillow + Noto CJK`。这不是任意 AI 画图，也不开放后台写操作。
- 本机旧飞书监听不要再用 PowerShell 原生命令长管道直连 `lark-cli event consume | node ...`，长时间运行时会缓冲导致事件到达但处理器不回；使用 `scripts/run_lark_sales_qa_event_pipe.mjs` 直接 spawn 并 pipe 事件流。用户已明确否定轮询方案，不得再改回轮询。当前本机自动拉起由 Windows 计划任务 `SHEIN-Local-Lark-Sales-QA` 负责，触发器为当前用户登录，入口脚本为 `scripts/start_local_lark_sales_qa.ps1`，安装脚本为 `scripts/install_local_lark_sales_qa_task.ps1`。
- 2026-05-19 云端 Codex 已修复：可从本机私有 auth 覆盖 `/home/sheinops/.codex/auth.json`，服务器已安装 `bubblewrap`、修正 sessions 权限、设置 `kernel.apparmor_restrict_unprivileged_userns=0`、将 `codex_hooks` 改为 `hooks`；`codex exec --sandbox read-only --skip-git-repo-check "只回复 OK"` 返回 OK，短暂 `Reconnecting...` 只按网络抖动处理。
- RTV 换单复核不能只靠 SHEIN 售后列表原始退货物流号；iMile/EMile/JT/JTE 等必须结合 SHEIN 物流详情换单轨迹和 ET RTV 反向候选。`mart.rtv_manual_review_candidates`、`ops.rtv_tracking_verification`、`mart.et_rtv_destination_allocation`、`mart.shein_return_rtv_trace` 是当前复核/展示主链路；未经人工确认的候选不改变主利润。
- BI Portal 链接管理中台是“会话即任务工作台”：自然语言每轮按最新一句和会话上下文从当前 `outputs/bi-portal/data.json` 动态取数；明确动作命令（下架、换图、改标题、补链、报活动等）必须创建/更新同一会话任务并留 IP/UA/备注/审计，不能只回复“没权限”。用户点“开始执行 / 预检”后才进入 `/api/link-ops-execute`。
- 链接管理素材上传走 `/api/link-ops-assets` 白名单和任务隔离私有目录；`/api/link-ops-execute` 做自动确认、素材/权限边界、HL 子执行器调度、进度和审计回写。HL 写执行器 `scripts/link_ops_hl_openapi_executor.mjs` 已验证 `canPublishProduct=true`、站点 `shein-sa/SAR`、品牌 `SOKANY`；默认 dry-run，真实 `publishOrEdit` 必须 payload 完整且显式二次确认。`copy_product_draft` 会先尝试从源商品快照复制图片/证书，源商品候选必须命中明确 SKC 或货号文本后才按销量排序。
- 商品复制架构：不等源店 OpenAPI；短期“源店 WebAPI/云端登录态读取商品详情 -> canonical draft -> 目标店 HL OpenAPI/商品子系统写草稿”，后续源店有 OpenAPI 时只替换源读取器。2026-05-19 已用 DL 商品编辑页 `/spmp/product/get_similar_product_detail` 复制 `S1810电热水壶` 到 HL `/spmp/product/save_draft` 草稿 `v2603291437289685`，只保存草稿，未提交审核/发布。
- SPMP 商品编辑页写草稿时必须强制勾选目标发布站点；HL 沙特至少要写入 `site_list=[{main_site:"shein", sub_site_list:["shein-sa"]}]`。不能继承源店 `get_similar_product_detail` 返回的空 `site_list`，否则草稿页面“发布站点”会漏勾，提交审核前还需人工补选。
- 商品资料母库不保存图片文件或图片 URL，图片只在任务执行时临时复制/换链/清理；平台 `skc` / `skuCode` 只作追溯，不能冒充商家 `supplierSku`。不同店铺核价/供货价差异不是商品参数冲突，发品前按报价策略处理（默认 50% 利润率或同款其它店最高核价，允许人工覆盖）。
- 云端 BI 临时人工登录入口 `/cloud-login-maintenance` 只用于登录态失效、验证码/滑块等人工维护；状态、日志和 noVNC 短期 token 是服务器私有运行态，不进 GitHub。生产同步活跃时不要强杀浏览器/VNC。
