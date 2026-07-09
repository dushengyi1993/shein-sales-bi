# MEMORY

下次 AI 进入 `E:\Codex WorkSpace\Shein销售统计` 必须先遵守本文件红线；详细机制到 `README.md` 和 `docs/` 查，不在此记录历史流水账。

## 红线

- BI 数据判断、开发验收和故障排查只认云端运行时：云端 PostgreSQL、线上 BI、`/api/bi/section/*`、云端日志和 systemd；不得用仓库 `outputs/bi-portal/*` 判断生产现状。
- 不要在本地直连或真实写 SHEIN OpenAPI；写操作走云端/受控脚本，先 dry-run、再人工确认、再回读审计。
- 本地 BI、`8787`、`SHEIN-*` Windows 计划任务已封存；除非用户明确回滚，不得恢复本地生产调度。
- 飞书 Base / 原生看板写入暂停；不要把日报、问数或异常提醒误判成 Base 写入恢复。
- 密钥、session、OpenAPI secret、noVNC token、数据库 dump、店铺密码不写仓库、文档、日志或聊天。
- 云端上传的临时文件、OpenAPI 素材和登录维护文件用完必须清理。

## 店铺与账号真相

- 当前 19 店：DSY `DL DX FY LQ NM HL JY ZL TS MZ`；LGM `CX YJ XL QY QH TZ JSH TZZ XC`。
- 店铺身份以 `config/stores.json`、`config/store_account_truth.json`、浏览器保存账号、实际登录店铺名/账号和 live 抓数归属共同确认；不要沿用旧交叉 profile 结论。
- 正确映射：`YJ=profileKey yj/accountNo GS8146729/port 9346`、`XL=profileKey xl/accountNo GS9307061/port 9344`、`QY=profileKey qy/accountNo GS7451160/port 9345`。
- HL 使用主账号 profile：`profileKey=shein-main`、CDP `9360`、`profiles/persistent-shein-main-profile`；LGM 组本身就是主账号。
- `profiles/persistent-*-profile` 是登录态；不要删除整个 profile。瘦身只清 Chrome 可重建缓存。

## 核心数据口径

- 销售有效性统一走 `lib/shein_sales_validity.mjs`：源头总销售只剔除真正取消/揽收前取消；退款、退货、派件失败由净销售、售后和利润层反转。
- 标准货号、别名归并和用户可见标题分别看 `config/product_catalog.json`、`config/product_aliases.json`、`lib/product_display_name.mjs`；拿不准的新货号必须让用户确认。

## BI 系统

- 架构和调度细节只查 `docs/bi-system-architecture.md` / `docs/bi-system-operations.md`，MEMORY 只保留“云端运行态为准”的红线。
- 正式入口：`https://sa.dushengyi.cc/`；云端代码目录 `/opt/shein-bi/app`；SSH 别名 `ssh shein-bi-tencent`。详细架构见 `docs/bi-system-architecture.md`，运维见 `docs/bi-system-operations.md`。
- GitHub release 只代表源码基线；生产以云端 `/opt/shein-bi/app` 和 systemd 实际状态为准。服务器 pull/reset 后必须重跑 BI 刷新。
- OpenAPI 销售/退货/商品仍以隔离并行层和受控写链为边界；不要回答成“只有 HL 接入”，也不要说已一刀切替代正式事实源。

## ET 货代仓

- ET 账号密码只在服务器私有 `config/et_forwarder.local.json` 或环境变量；不复用 Windows Chrome 保存密码，不写入文档/仓库/聊天。
- ET 核心库位：`09` 可售散件、`01` 整箱、`03_RTV` 退货、`04Damaged` 破损、`06` 报废。
- ET 可售/在库/在途/发货申请单/箱明细是库存台账主证据；仓储费利润口径以 ET 物流仓服账单 `仓储费` 为正式来源。详细模型见 `docs/bi-warehouse-model.md`。
- 匹配 SHEIN/ET 时宁可进待复核池，不能硬归并；未确认 ET 编码不要写死。

## 营销活动

- 普通营销活动真实报名/取消、优惠券提交/取消、补预算仍需要当前线程明确授权；每日巡检已授权自动处理“限时折扣价格漂移、新链接/新上架 7 天/漏限时折扣兜底”这三类限时折扣写入，但必须通过身份、价格栈、库存/平台规则、dry-run、执行后回读，并关闭浏览器。
- 营销定价以 `docs/marketing-campaign-signup-pricing-rules.md`、`config/marketing_pricing_policy.json`、`lib/marketing_pricing_policy.mjs` 为准；整数目标价提交前做安全 jitter 并复查。
- 普通活动、优惠券、限时折扣、旧活动价、成本、仓储费和利润率必须做叠加安全审核；活动扫描过期或证据缺失时 fail closed。
- 新链接/新 SKC 不得简单标“待定价”：若能从最新已执行全量计划、同标准货号全局曝光 Top5 规则、成本/仓储费/底价推导出安全目标价，必须自动生成限时折扣兜底并回读；只有缺成本/目标价/仓储费、身份、库存或平台规则阻断时才 fail closed。
- 新上架 7 天未报活动优先补一期限时折扣；首次新品/超级新品按全局曝光 Top5 力度；已有冲突旧限时折扣则安全结束后重报。
- 普通活动报名完成后，活动开始前只检查后台已报/待生效、限时折扣兜底和旧活动风险；订单成交价低/高于本期普通活动目标的 blocker 只从活动实际开始时间后计算，窗口外订单只作线索。

## 链接 / 自动运营规则

- 链接管理不再写飞书链接表；日常只走云端私有源文件、PostgreSQL、BI 门户和受控 OpenAPI。
- 批量复制链接到多店走 `scripts/link_ops_hl_openapi_executor.mjs`；已支持 `supplyPriceRange` 随机供货价、`shuffleImages` 细节图加密洗牌、`inferInputCurrentOverride` 从功率/电压推电流、`skipPayloadHashLock` 随机 payload 跳 hash 锁。
- 限时折扣价格漂移自动修复走 `scripts/marketing/guard_limited_discount_drift.mjs` → `batch_fix_limited_discount_drift.mjs`；逐店串行"删漂移 SKC → dry-run → 剔除平台阻断 → execute 可执行子集 → readback → 关闭浏览器"。
- 新上链接默认用标准货号（带中文）；图片顺序为卖点 -> 参数 -> 场景；细节图第一张必须是主封面。
- 批量下架候选走 `scripts/build_link_retire_candidates_from_csv.mjs`（或 `bi_ops_cli retire-candidates`），执行走 `scripts/execute_retire_candidates_openapi.mjs`；已下架但货号未改的修复走 `scripts/repair_retire_supplier_code_openapi.mjs`，只调 `partialEdit` 不调 shelf，修复失败不阻断下架。
- 下架规则：近 7 天曝光 <= 300 且销量 = 0 -> 下架；排除新品标签；排除首次上架 15 天内；货号按去掉“废”标记后的标准货号判断。
- 商品复制优先用官方 OpenAPI 商品详情 / `spu-info` mapper 还原 canonical draft；源详情不足才回退 WebAPI/云端登录态，不能让用户手工拼完整 payload。

## BI 门户 UI

- UI 细则见 `docs/bi-portal-ui-current.md`；MEMORY 只保留红线。
- 首页矩阵、趋势、排行必须受时间、店铺/分组、货号/SKC/品名筛选影响；货号+店铺组合用店铺×货号日粒度。
- 顶部 sticky 工具栏只放全局筛选；动作池筛选只影响动作池。同店同 SKC 同业务域多规则合并成一张动作卡。
- 数据域更新时间必须显示源文件抓取时间，不用入仓 `updated_at` 冒充。
- 修 UI 默认先代码检查、生成、HTTP/API、静态 HTML/JSON 断言；需要视觉/交互排查才打开真实页面。

- 成交价散点图（priceScatter）已上线：基于 `fact.order_item` 的 `unit_price_sar = sales_sar / quantity`，横轴订单日期、纵轴成交单价；不筛选货号时显示全货盘分布，筛选后缩小到单货号。新增 section 必须同时在 `serve_bi_portal.mjs` 的 `BI_PORTAL_SECTION_KEYS` 白名单注册。

## 工具避坑

- PowerShell 5.1 中文管道易编码污染；项目 `.ps1` dot-source `scripts/use_utf8.ps1`，文件保存 UTF-8 with BOM。
- 不要用 PowerShell here-string 写大量中文 JS/JSON；优先用 UTF-8 文件、Node 脚本或 `apply_patch`。
- Node 读取大 stdout 时收集 Buffer 后 `Buffer.concat(...).toString('utf8')`，避免中文多字节被切断。
- SHEIN `20302 子系统登录重定向` 先自动恢复登录并重抓；恢复失败明确报人工处理，不能用旧数据冒充最新。
- 飞书接口 `EOF`、`HTTP 500/5000`、限流、TLS/CDN 抖动应重试，不能发布半新半旧数据。
