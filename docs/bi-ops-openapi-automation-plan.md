# BI 自动化运营页 × SHEIN OpenAPI 接入方案（当前口径）

> 状态：2026-06-28 已进入 V2 可试用收口阶段。V2 自动运营工作台只属于 BI 门户和云端 Codex CLI 自然语言会话，不再和飞书入口、V1 页面或旧“任务池/验证器”产品心智绑定。19 店 OpenAPI 授权、云端白名单、只读探针和写操作资料检查链路已完成；`copy_product_draft` 不再是单店适配，而是按店铺能力、payload mapper、自然语言确认映射、真实写白名单和回读/审计受控执行。本文仍坚持密钥隔离、资料检查、人工自然语言确认、审计回读和生产数据双跑对账边界，不保存任何 SHEIN 账号、密码、APP_SECRET、openKeyId、secretKey、tempToken 或 Cookie。

## 1. 目标

把 BI 的“自动化运营”页重构成类似 Codex Desktop 的 AI 对话式工作台：

- 用户用自然语言发指令，例如“把 389 空气炸锅在缺货店铺下架”“把 520a 在 DL/DX 上架”“查一下近 7 天 COD 退货异常的 SKC”。
- 云端 Codex CLI / 执行器先理解意图、查证数据、生成计划、做资料检查。
- 用户可见层只有同一个 BI 会话：用户继续用自然语言补字段、确认执行或要求重试；不要让普通员工理解 `dry-run`、任务池、验证器或固定确认码。
- 真正影响 SHEIN 的动作必须经过人工自然语言确认、权限校验、发布资料检查、执行审计、执行后回读。
- 真实写放行必须同时经过两层门：`safeWriteOperations` 物理总闸门（店铺 + 动作）和 `config/bi_ops_write_whitelist.local.json` 试点白名单（人 + 店 + 动作）。任何一层未命中，都只能 dry-run。
- 19 家店铺一次性纳入官方 OpenAPI 接入总账、授权换密钥和只读探针；可用 OpenAPI 稳定替代的数据域仍必须先双跑对账，再切生产。

### 会话事实边界（2026-06-29 补充）

- **用户消息才是事实来源**：店铺、货号、补充字段、确认执行都只能从用户消息、任务结构、OpenAPI/BI 数据和执行器证据进入状态机；助手回复只能展示，不允许反向写入 `targets`。例如助手说“源链接是 QY”，不能把 QY 变成目标写店。
- **源店和目标店必须分离**：`sourceStores` 只表示读来源链接；`writeStores` / `stores` 才表示要写的目标店。跨店复制时若源店混入多写店，执行前必须剔除源店，除非用户明确把源店也列为目标写店。
- **复制上品里的标题不是改标题动作**：用户说“标题直接复制源链接/沿用源标题”，这是发布 payload 的字段补齐，不是 `update_title` 维护动作，不能把补链任务混进改标题执行器。
- **新链接默认不自动上架**：所有新上品、复制上品、补链接等从未上过架的新链接，发布 payload 必须默认 `shelf_way=2` 并写入约十年后的 `hope_on_sale_date`；短期内不能自动上架。只有维护已有链接的 `activate_link` / `retire_link` 等上下架动作才按用户指令改变现有链接状态。
- **新链接默认标准货号**：所有新上品、复制上品、补链接等从未上过架的新链接，发布 payload 的 `skc_list[].supplier_code` 和 `skc_list[].sku_list[].supplier_sku` 必须原样使用当前任务的标准货号（优先 `task.standardGoodsSn` / `targets.standardGoodsSn` / `metadata.standardGoodsSn` / `executionContext.standardGoodsSn`，再从 `productRefs` 推导），不得继承源链接或店铺特定 raw `supplier_code`；也不得自行添加店铺前缀、颜色、批次或其他后缀。只有用户明确指定时才允许偏离标准货号。
- **明确动作优先走 BI 状态机**：补链、复制上品、改价、上下架、补字段、自然语言确认等明确运营动作不得先交给旧问答模型生成建议；必须先创建/更新当前会话任务、检查资料、再用人话返回缺口或结果。
- **505 只是验收样例，不是特判对象**：`DL 505` 只能用来验证通用链路；自动运营页必须支持所有已接入 OpenAPI 动作走同一条自然语言状态机，包括 `copy_product_draft`、`activate_link`、`retire_link`、`update_inventory`、`update_supply_price`、`update_product_price`、`update_title`、`update_images`、`certificate_review`。不能给单个货号、单个类目或单个店铺写死流程。
- **平台缺字段按属性 ID 通用闭环**：`publishOrEdit` 返回“某属性(id)必填”时，后续用户在同一聊天里补“按 800W 算 / 电流 1200mA”等自然语言，系统要从上次平台提示里识别属性 ID、写入当前任务事实并重新资料检查；不能只靠 `SM-505A` 的输入电流特判。
- **复制上品成功流必须有非 505 回归**：release gate 必须同时覆盖 `SM-505A/505` 样例和非 505 普通货号，证明通用 `copy_product_draft` 生命周期不是靠缝纫机专用默认值跑通；非 505 场景不得自动带入 `输入电流=1200mA`。
- **维护动作也必须即时检查**：用户说“改库存/改价/上下架/改标题/换图/补证书”时，聊天应立即定位目标链接、生成对应 OpenAPI 维护 payload 和检查快照，并用人话说明“已定位哪些链接、还差什么、能否一句话确认执行”；不能只给补链动作做即时资料检查。
- **下架候选必须保护新链接**：低曝光零销量下架候选只能作为只读明细给用户确认，不能自动执行。候选至少要满足当前已上架、近 7 天曝光 `c7EpsUv <= 300`、近 7 天销量 `c7_sale_cnt = 0`、`raw_summary.newGoodsTag` 为空；同时固定安全闸是首次上架 15 天内一律排除，不能仅依赖新品标签。缺 `first_shelf_time` 的链接进入待确认/不执行，不得纳入下架候选执行清单。用户确认执行后，`retire_link` 下架是硬目标；货号改成 `（废）标准货号` 只是 best-effort，若 `partialEdit` 因属性/标题/规格校验失败，记录“已下架但货号未改”即可，不阻断下架。
- 实现组件：策略库 `lib/link_retire_candidate_policy.mjs`；CSV 报告 `scripts/build_link_retire_candidates_from_csv.mjs`（也可通过 `bi_ops_cli retire-candidates` 调用）；云端执行器 `scripts/execute_retire_candidates_openapi.mjs`；货号修复 `scripts/repair_retire_supplier_code_openapi.mjs` + `lib/retire_supplier_code_repair_payload.mjs`。
- **上传资料后必须回到同一个聊天闭环**：换图、证书等需要补资料的动作，上传图片/PDF/JSON 后要自动重新检查当前处理，并继续在聊天里说明“资料是否通过 / 还缺什么 / 能否一句话执行”；不能要求员工重复创建任务或理解后台验证器。
- **图片素材由 AI 辅助排序，但不能黑箱提交**：用户上传新链接或换图素材后，系统可以根据图片内容判断轮播主图、细节图、方形图和 SKU/色块图顺序；但提交前必须在同一聊天里给出可读的排序结果、质量/冲突提示和调整入口。AI 不得凭图片发明不存在的商品参数、认证或功能。
- **旧任务也要执行前再归一化**：即使运行态文件里保留了历史坏状态，`startControlledLinkOpsExecution` 也必须在 dry-run/execute 前重新合并当前聊天事实并归一化 intent、源店、目标店、人工参数和 payload hash。

## 2. 当前证据与现状

### 已验证能力

仓库已有 HL 试点记录：

- 官方 OpenAPI 生产域名：`https://openapi.sheincorp.com`。
- 合作模式：半托管。
- HL 已完成真实授权，真实密钥仅存在 `config/shein_openapi.local.json`，不进 GitHub。
- 已跑通的 HL 只读接口：
  - 店铺信息：`/open-api/openapi-business-backend/query-store-info`
  - 站点 / 币种：`/open-api/goods/query-site-list`
  - 商家仓库：`/open-api/msc/warehouse/list`
  - 商品列表：`/open-api/openapi-business-backend/product/query`
  - 商品详情：`/open-api/goods/spu-info`
  - SKU 库存：`/open-api/stock/stock-query`
  - 订单列表：`/open-api/order/order-list`
  - 订单详情：`/open-api/order/order-detail`
  - 退货列表：`/open-api/return-order/list`
  - 退货详情：`/open-api/return-order/details`
  - 财务报账单列表：`/open-api/finance/report-order-list`
  - 财务对账单列表：`/open-api/finance/get-check-order-list`
  - 财务对账单详情：`/open-api/finance/get-check-order-detail`
- HL 曾完成 OpenAPI 销售和现有生产销售源双跑对账，2026-05-05 / 2026-05-06 对账一致。
- 商品写方向已有 HL 执行器雏形：`scripts/link_ops_hl_openapi_executor.mjs`。
  - 默认只做 dry-run / 预检。
  - 已验证发布前置能力与 `canPublishProduct=true`。
  - 真实 `publishOrEdit` 仍要求完整 payload 和显式确认，不允许静默提交。

### 官方开放平台公开信息

开放平台首页公开列出的业务解决方案包括：

- 商品管理：通过 OpenAPI 发布商品到 SHEIN 平台。
- 客单平台履约：通过 OpenAPI 预约发货、打印面单。
- 客单卖家自履约：通过 OpenAPI 上传运单号并更新订单状态。
- 备货履约：通过 OpenAPI 完成备货单发货。
- 开放能力：Webhook、OpenApi。
- 合作流程：账号申请 → 创建应用 → 应用审核 → 对接授权 → 对接解决方案。

### 19 店接入现状（2026-06-28）

当前状态不再是“只证明 HL 启用”：

- 19 店店铺级 OpenAPI 授权、云端 IP 白名单、只读探针和脱敏能力总账已完成；`/api/openapi-capabilities` 是当前店铺能力总账入口。
- 销售订单当前保留 WebAPI 生产事实源；官方 OpenAPI 已完成有效销售口径修正并具备候选切换条件，但按 2026-07-09 决策继续双跑一周，只写隔离并行层和对账层，不覆盖正式销售事实。退货退款、商品/链接基础资料同样仍写隔离并行层，不覆盖正式售后/链接事实。后续事实源切换必须按数据域继续看连续对账趋势和历史 warning。
- 自动化运营写链路已接入官方 OpenAPI 动作：`copy_product_draft`、`activate_link`、`retire_link`、`update_inventory`、`update_supply_price`、`update_product_price`、`update_title`、`update_images`、`certificate_review`。
- `copy_product_draft` 已从单店适配推进到 19 店能力 smoke：源链接参数优先从 OpenAPI 商品列表 + `spu-info` / 商品详情 mapper 还原，不要求用户人工补完整发布 payload；强指纹回读未命中时只能进入人工核销，不能弱匹配自动判成功。
- 批量复制支持：随机供货价区间 `supplyPriceRange`、细节图洗牌 `shuffleImages`、自动电流推断 `inferInputCurrentOverride`（从功率/电压推算）、随机 payload 跳 hash 锁 `skipPayloadHashLock`。
- `copy_product_draft` / 新链接发布默认只创建十年后定时上架的新链接，防止补链后短期自动上架；测试必须覆盖 payload 级和 SKC 级 `shelf_way=2` / `hope_on_sale_date`。
- TZ/JSH/TZZ/XC 等 `query-store-info` 不返回 GS 账号的店铺，只允许在 `config/stores.json` / `config/store_account_truth.json` 的静态 `merchantId` 与实际候选一致、且没有 GS 账号冲突时使用 fallback；不得运行时自动回填或放宽身份校验。
- 网页端最终确认不再显示固定确认框；用户在同一聊天里说“可以执行 / 提交吧 / 照做”等自然语言，服务端只在唯一当前事项、资料检查通过、权限和白名单命中时，内部映射到安全确认码。CLI/脚本仍必须显式传 `--confirm SHEIN_OPENAPI_SUBMIT`，防止绕过网页会话边界。

当前 19 店为：

`CX, DL, DX, FY, HL, JSH, JY, LQ, MZ, NM, QH, QY, TS, TZ, TZZ, XC, XL, YJ, ZL`。

## 3. API 替换现有抓数的分级策略

### A 类：优先 OpenAPI 双跑，稳定后可替换

这些数据和 HL 已验证接口高度一致，适合先接 19 店 API 并双跑：

1. 销售订单
   - OpenAPI：`order-list` + `order-detail`
   - 现状：生产销售事实源保留 WebAPI；`shein-bi-cloud-today.service`、`shein-bi-cloud-yesterday.service`、晨间链路和 `cloud_bi_refresh.sh` 默认使用 `SHEIN_SALES_TRANSPORT=webapi`。OpenAPI 每日/按需双跑写 `fact.openapi_*` 与 `mart.openapi_sales_reconciliation`。
   - 策略：WebAPI 高频销售链路继续写 `fact.store_daily_sales`、`fact.order_header`、`fact.order_item`、`fact.order_payment_flag`；OpenAPI 并行层 `fact.openapi_*` 和 `mart.openapi_sales_reconciliation` 按店铺 × 日期对账订单数、订单号集合、商品行、销售额、取消/无效行、COD/订单状态字段，作为一周双跑切换证据。
   - 注意：日内对账可能因为 API 抓取时点不同出现短时差异；切换前必须确认已结算日期 WebAPI 与 OpenAPI 的有效销售金额、订单数、商品行、取消/无效行和 SAR 单价口径完全一致。商品四档状态、营销活动、ET 库存、订单闭环复查不随销售订单一起切 OpenAPI。

2. 退货退款
   - OpenAPI：`return-order/list` + `return-order/details`
   - 策略：与当前售后 WebAPI/RTV 复核双跑；重点核对售后申请时间、订单创建时间、售后状态、退款金额、退货原因、COD/RTV 字段。

3. 商品列表 / 商品详情
   - OpenAPI：`product/query` + `goods/spu-info`
   - 策略：先进入隔离并行层，作为链接基础资料、类目、属性、供货价、图片、SKU 和 SHEIN 虚拟库存的证据源；和现有链接/业务域 section 双跑。
   - 当前结论（2026-06-26）：19 店已能全量抓取商品列表、商品详情和 `stock-query`，并写入 `fact.openapi_product_link` / `mart.openapi_product_reconciliation`；正式总账显示 `productReconciliationReady=19`，但每店仍有 warning。
   - 关键边界：OpenAPI 商品状态目前稳定可比的是“是否已上架”二值；现有浏览器源是 `待上架 / 已上架 / 已售罄 / 已下架` 四档。四档状态差异只能留作 evidence，不能用 OpenAPI 直接替代商品页/库存页的四档状态。
   - 注意：复制发品所需的源商品编辑级详情、包装尺寸重量、品类属性和证书等，不一定都能靠只读 SPU 接口补齐；商品资料母库仍需要继续吸收 WebAPI 编辑页快照作为 fallback。

4. SKU 库存
   - OpenAPI：`stock-query`
   - 策略：只作为 SHEIN 虚拟店铺库存证据；ET 实际库存仍以 ET 为准。商品页/库存页中的“店铺已上架库存矩阵”后续可以参考 API 回读，但必须继续明确“这是 SHEIN 前台/店铺虚拟库存，不是 ET 实际库存”。
   - 禁止：不能把 OpenAPI `stock-query` 直接替代 ET 可售、在库、在途、发货申请单或仓储费口径。

5. 财务报账 / 对账
   - OpenAPI：`finance/*`
   - 策略：先做财务明细并行层，不直接替换利润口径；因为利润还依赖成本、仓储费、RTV、ET 等非 SHEIN 单源数据。

### 已落地并行层现状（2026-06-26）

- 19 店授权与只读探针：已完成，云端 19/19 `read_probe_ok`。
- 2026-07-11 复核：19 店实时只读探针重跑为 `19/19 read_probe_ok`，当日销售、退货、商品 OpenAPI 对账也均为 19 店成功。能力总账已取消 HL 单店硬编码就绪兜底，通用探针或新鲜且存在有效对账行的日常 OpenAPI 对账均可作为读链路证据；网页分开显示“API 已接通 / 可系统检查 / 当前账号可受控提交”，不再把探针时效、全局白名单或他人权限误说成店铺有无 API。
- 销售订单：WebAPI 仍是生产事实源；OpenAPI 写 `fact.openapi_store_daily_sales`、`fact.openapi_order_header`、`fact.openapi_order_item`、`fact.openapi_order_payment_flag`、`mart.openapi_sales_reconciliation` 作一周双跑验证，不覆盖正式 `fact.store_daily_sales` / `fact.order_item`。
- 退货退款：已进入 OpenAPI 并行层，只写 `fact.openapi_return_order`、`fact.openapi_return_item`、`mart.openapi_return_reconciliation`，不覆盖生产售后事实。
- 商品/链接基础资料：已进入 OpenAPI 并行层，只写 `fact.openapi_product_link`、`mart.openapi_product_reconciliation`，不覆盖 `fact.link_master_snapshot`、商品页、库存页或任何生产维表。
- OpenAPI 总账：`/api/openapi-capabilities` 只返回脱敏状态、对账摘要和密钥存在布尔值；不得返回 `APP_SECRET`、`openKeyId`、`secretKey`、`tempToken`、Cookie 或任何可还原密钥的信息。
- 调度：销售订单生产刷新由 `cloud_bi_refresh.sh` 通过 WebAPI 执行；销售订单、退货退款、商品/链接 OpenAPI 对账仍接入 `scripts/cloud_daily_refresh.sh`。生产 `shein-bi-cloud-daily-refresh.service` 保留 `SHEIN_BI_DAILY_OPENAPI_RECONCILIATION=1`、`SHEIN_BI_DAILY_OPENAPI_RETURN_RECONCILIATION=1`、`SHEIN_BI_DAILY_OPENAPI_PRODUCT_RECONCILIATION=1`；销售对账用于一周双跑质量监控，退货/商品仍只写隔离并行对账层。自动化运营写操作走独立任务池、权限、白名单、确认和审计链路。
- 空间：商品原始抓取文件位于忽略目录 `outputs/shein_openapi_products/`，脚本默认每店只保留最近 2 个时间戳快照和 `latest.json`，避免云盘长期膨胀。
- 空间：凡图包、源图、转换后图片、上传暂存文件或其他大文件同步到 `shein-bi-tencent` 用于 OpenAPI 上传/批量执行，执行结束后必须清理源图和中间大文件；只保留轻量 `summary` / `log` / `manifest` / 审计证据和平台回执日志。清理动作必须记录路径和清理前后大小，禁止删除最终汇总、manifest、审计日志、平台回执日志。

### B 类：可用 API 辅助，但不能马上完全替换

1. 流量数据
   - 目前未看到已验证的官方 OpenAPI 流量接口。
   - 策略：继续用现有链接表现/业务域抓取；开放平台若有流量/商品分析权限，必须先确认接口、粒度是否达到“日期 × 店铺 × 标准货号 × SKC”。

2. 营销活动 / 限时折扣 / 优惠券
   - 目前主要来自 SHEIN 后台/营销扫描产物。
   - 当前官方公开 OpenAPI 目录未发现普通营销活动报名、限时折扣、优惠券报名的写接口；因此 `campaign_signup` / `flash_discount` 不列入“官方 API 可实现动作”，继续走本地营销运营流程、价格栈守卫和人工确认。若 SHEIN 后续开放官方营销写接口，再按同一套 dry-run / 白名单 / 确认文本 / 回读审计接入。

3. 商品上下架 / 发布 / 编辑
   - OpenAPI 有商品管理和 `publishOrEdit` 方向，但 payload 完整性复杂。
   - 策略：先做 dry-run 执行器和草稿/预检；真实发布、编辑、上下架必须二次确认。
   - `copy_product_draft` 作为首个真实写试点候选时，提交后回读不能只看商品列表第一页，也不能用平台 SKU / 源 SKC / 货号文本这类弱证据直接判定成功；必须分页扫描，并优先用目标商家 SKU / 商家货号强指纹匹配。只有强指纹命中才可自动闭环为完成；弱匹配、未命中或查询失败都要保持任务锁定，等待全店管理账号人工核销。
   - `activate_link` / `retire_link` / `update_inventory` / `update_supply_price` / `update_product_price` / `update_title` / `update_images` / `certificate_review` 已接入 `scripts/link_ops_maintenance_openapi_executor.mjs`：先 dry-run 定位链接、解析 SKU、生成官方 OpenAPI payload 并锁定 `payloadHash`，真实提交仍必须走总闸门、真实写白名单、确认文本和回读/人工核销。
   - `update_images` 的用户体验目标是“上传图片 + 自然语言调整”，不是让员工手写 `partialEdit` JSON。执行层仍必须把图片素材转换成 SHEIN 可接受的图片 URL 和 `partialEdit` 图片字段后再提交；在图片上传/转换链路未生成完整字段前，普通图片文件只能作为会话素材和资料缺口，不能直接静默换图。`certificate_review` 不自动判成功；证书 payload 提交后默认进入人工核销，避免把平台审核中误当完成。

### C 类：暂不承诺 API 替换

1. ET 货代仓、出库单、发货申请单、轨迹
   - 来源是 ET，不是 SHEIN OpenAPI。
   - 仍需 ET 抓取/API/后台接口。

2. 成本表、产品别名、中文标准货号、员工分组、权限
   - 是本项目自有维表和业务口径，不来自 SHEIN。

3. BI 利润最终口径
   - 需要 SHEIN 销售 + 售后 + ET 库存/仓储 + 成本 + 退款/RTV 组合。
   - OpenAPI 只能替换部分输入源，不能直接替代利润口径。

## 4. 19 店 OpenAPI 接入步骤

用户已确认：API 接入可以覆盖全部 19 店，不需要按批次推进。这里的“全量接入”指同一套授权、换密钥、探针和总账一次性覆盖所有店铺；不表示未授权店铺可以被页面冒充为已接，也不表示生产抓数和真实写操作可以绕过双跑/确认。每个店铺按同一流程走，不允许把一个店铺的密钥复制给另一个店铺。

1. 开放平台应用状态复核
   - 进入该店开放平台账号。
   - 确认应用是否已审核通过。
   - 确认合作模式是半托管。
   - 确认业务功能至少包含：商品管理、商品合规、订单管理、库存管理、财务管理。

2. IP 白名单
   - 云服务器出口 IP 必须加入应用白名单。
   - 本机只用于人工排障；生产调用以云端 IP 为准。

3. 店铺授权
   - 先确认该店铺对应的开放平台应用主体；19 店可能不是同一个 `APP_ID`，私有配置支持 `stores[].app`、`stores[].appId/appSecretKey`、`stores[].appKey + apps.<key>` 或全局 `app` fallback。
   - 使用该店对应应用的授权链接，让该店铺主账号授权。
   - 获取 `tempToken`。
   - 后端调用 `/open-api/auth/get-by-token` 换店铺级 `openKeyId` 和加密 `secretKey`。
   - 使用应用级 secret 解密店铺级 secret。
   - 写入云端/本机私有 `.local` 配置，禁止进 GitHub。

4. 只读探针
   - 对每店跑 `store-info/site-list/warehouse-list/product-query/order-list/return-order-list/finance`。
   - 保存脱敏摘要，失败时记录 code/msg/traceId。

5. 双跑对账
   - 销售订单、退货、商品、库存分别进入并行层。
   - 至少店铺 × 日期维度对账。
   - 通过后再单域切换，不做“一口气全切”。

6. 全量接入与安全切换
   - 19 店授权、换密钥、只读探针和能力总账一次性推进。
   - 未授权、密钥不完整或探针失败的店铺必须在总账里显示为待授权/待探针，不能显示为已接。
   - 订单、退货、商品、库存等生产数据源切换仍按数据域逐项双跑对账；通过后再切换，不做“一接入就全切”。
   - 真实写操作按动作和店铺逐项放开，必须 dry-run、人工确认、审计和回读。

7. 写操作能力评级
   - 每店给出能力状态：
     - `read_ready`：只读可用。
     - `write_precheck_ready`：写操作能做 dry-run 预检。
     - `write_confirmable`：具备完整 payload、权限、回读和人工确认链路。
     - `write_blocked`：权限、payload、站点、品牌、仓库、证书或类目属性缺失。

## 5. 自动化运营页设计

### 页面形态

整体模仿 Codex Desktop，而不是传统表格页；面向普通员工时必须以“聊天即操作入口”为主，不暴露技术验证器。

- 左侧：会话列表 / 当前登录账号 / 可管店铺摘要。
- 中间：AI 对话区 + 当前任务确认区。
  - 用户自然语言输入。
  - AI 先回答“理解到的目标、影响范围、需要的数据、风险”。
  - 如果是写操作，直接在对话下方显示人话任务卡：系统已检查什么、还缺什么、下一步点什么。
  - 平台预校验、payload hash、白名单、OpenAPI trace 等后台证据继续记录，但默认不堆给普通员工；只在审计/排障里展开。
- 真实提交前，网页端最终确认不再要求固定输入框；用户在同一聊天里说“可以执行 / 提交吧 / 照做”等自然语言，服务端在唯一当前事项、资料检查通过、权限和白名单命中时内部映射到安全确认码。
- 右侧：当前会话任务进度 / 上下文摘要。
  - 只展示当前会话相关任务，不展示全局历史任务堆。
  - 只看进度和结果，不在右侧放执行按钮，避免员工在多个入口之间迷路。
  - 当前筛选范围、店铺能力、订单/库存/链接/营销/售后/评价证据作为上下文摘要或审计入口展示。
- 底部：输入框。
  - 支持文字指令。
  - 支持把标题、图片、Excel/CSV/JSON、PDF 证书等素材先上传到云端会话/任务素材包；图片素材可以先由 AI 做内容理解、去重、质量检查和顺序建议，但真实写仍以结构化任务事实、图片字段、权限、确认和回读为准。

### 对话流程

#### 只读查询

例：`查一下近 7 天 389 空气炸锅哪个店铺流量高但转化低`

流程：

1. 解析意图。
2. 读取 BI section / warehouse / OpenAPI 并行层。
3. 返回结论、证据和建议动作。
4. 不创建写任务。

#### 写操作

例：`把 520a 在 DL、DX 已断货的链接下架`

流程：

1. 解析目标：货号、店铺、动作、筛选条件。
2. 拉取证据：当前上架状态、ET 库存、近 7/30 天销量、OpenAPI 权限。
3. 生成计划卡片并写入任务草稿池：
   - 影响店铺 / SKC / 链接数量。
   - 预计动作。
   - 风险：是否有库存、是否近期有销量、是否参与活动。
4. dry-run 预检：
   - 权限校验。
   - payload 校验。
   - 店铺/站点/仓库/品牌/类目校验。
5. 用户点击确认。
6. 执行器写 SHEIN。
7. 回读确认：状态是否真的变化。
8. 记录审计。

### 任务状态

建议统一状态机：

- `draft`：AI 刚生成计划，未预检。
- `prechecking`：正在查 API 权限、payload、风险。
- `needs_review`：需要人工确认或补素材。
- `blocked`：权限/资料/状态不满足。
- `approved`：用户已确认。
- `executing`：正在调用 API/WebAPI。
- `verifying`：执行后回读。
- `done`：完成并回读一致。
- `failed`：失败，附 traceId/log。
- `reverted`：如后续支持回滚，记录回滚结果。
- `submitted_but_readback_pending`：SHEIN 写接口已返回成功，但回读还没可靠匹配；任务锁定，禁止重复提交。
- `submitted_readback_failed` / `needs_manual_resolve`：SHEIN 写接口可能已经生效但回读失败；必须全店管理账号人工核销，不能自动重试提交。
- `suspicious_write_attempted` / `needs_manual_resolve`：真实提交模式下，子执行器超时、崩溃或未返回可解析结果；系统无法确认 SHEIN 是否已接收写请求，必须按“可能已提交”处理，任务锁定，禁止重复提交，只能人工核销。
- `copy_product_draft` 的可靠回读标准：`targetSupplierSkus` 或 `targetSupplierCodes` 强指纹命中；`targetPlatformSkuCodes`、平台 SKC 名、源 SKC、货号文本只作为弱证据写入审计，不能单独把任务判定为完成。

## 6. 后端执行架构

### 核心组件

1. `ops_chat_gateway`
   - 接收对话消息。
   - 调用云端 Codex CLI 或受控模型，生成结构化意图。
   - 不直接写 SHEIN。

2. `ops_intent_parser`
   - 将自然语言转成 JSON：动作、店铺、货号、SKC、条件、时间范围。
   - 低置信度时反问或进入人工确认，不猜。

3. `ops_evidence_builder`
   - 从 BI section、warehouse、OpenAPI、ET 拉证据。
   - 所有写操作必须有证据快照。

4. `ops_task_store`
   - 保存任务、计划、证据、预检结果、审批、执行日志。
   - 建议入 PostgreSQL，而不是继续只用 JSON 文件；旧 `state/bi_link_ops_tasks.json` 只能作为过渡兼容层。

5. `openapi_capability_registry`
   - 每店记录 read/write 能力、权限包、白名单、最近探针结果。

6. `ops_executor`
   - 每类动作一个执行器：上下架、发品/复制、改价、库存、营销报名、订单履约等。
   - 所有执行器默认 dry-run。

7. `ops_audit_log`
   - 记录操作者、时间、原始指令、解析结果、影响对象、确认人、API traceId、回读结果。
   - 真实写操作后延迟回读，若回读状态与预期不一致，任务标记 `verify_failed` 并在系统健康中提示。

### 执行器优先级

第一阶段只做：

- 19 店 OpenAPI 探针与能力 registry。
- 只读查询。
- 链接上下架 dry-run / 任务卡片。
- 对已授权且具备适配器的店铺做商品发布/编辑能力预检；未授权店铺只显示缺口。

第二阶段再做：

- 订单/退货/商品/库存 OpenAPI 双跑入仓，覆盖全部已授权店铺。
- 真实上架/下架小流量试点，只选择已授权、预检通过、风险低的动作。

第三阶段再做：

- 批量上下架。
- 复制发品。
- 改价。
- 营销活动报名。

## 7. 安全边界

必须坚持：

- API secret、openKeyId、secretKey、tempToken、Cookie 不进 GitHub、不进前端、不进日志明文。
- 不同店铺若属于不同开放平台应用主体，必须使用各自 `APP_ID/APP_SECRET_KEY` 换密钥；不得把 HL 应用密钥默认复用给全部店铺。
- 写操作不得静默提交；用户必须在同一 BI 会话里用自然语言明确确认，服务端再映射成内部安全确认码。
- 自然语言不能绕过授权；必须转换成结构化会话事实、资料检查快照、payload hash 和审计记录后，才允许进入真实执行。
- 写接口必须先完成不提交的资料检查，再 execute。
- 网页端不再显示固定确认文本或按钮式验证器；CLI/脚本仍必须显式传确认参数，避免绕过网页登录会话边界。
- 执行前必须保存证据快照，执行后必须回读。
- 如果执行器在真实提交模式下中断或结果不可解析，不能把任务退回 `waiting_review`；必须进入需人工核销状态，审计里标记 `suspiciousWriteAttempted` / `submittedPossibly` / `requiresManualResolve`。
- 回读只接受目标商家 SKU / 商家货号强指纹自动闭环；弱匹配数量可进入审计辅助排查，但不能自动判定成功。
- 高风险动作默认阻断：
  - 批量影响超过阈值。
  - 近期有销量但要下架。
  - ET 有库存但要下架。
  - 正在生效活动中要改价/下架。
  - payload 缺类目属性、证书、尺寸重量、站点、品牌、仓库。

## 8. 不应承诺的点

当前不能承诺：

- “OpenAPI 已替换全部生产事实源 / 可静默执行全部真实写”——19 店授权、探针、资料检查和受控写适配器已完成，但事实源切换和真实提交仍按数据域、动作、店铺、账号和白名单受控放行。
- “OpenAPI 可以立刻替换全部现有抓取”——流量、营销、ET、利润输入仍有缺口。
- “AI 可以绕过确认直接自动上下架”——不允许。用户在聊天里明确确认后，系统才会用内部确认码执行，并记录审计和回读结果。
- “商品复制/发布一定可一键完成”——payload 完整性、证书、类目属性、图片、站点、品牌和仓库都可能阻断。
- “AI 看图后可以直接无确认换图/上新”——不允许。AI 可判断图片顺序和质量，但必须先生成可审查的图片结构。当前换图前端角色口径是：`细节图11` 的第 1 张才是主图；单独轮播图是第二封面；文件名含 `产品封面` 的 AB 测试图忽略；方形图用 1:1；其他细节最多 10 张，按卖点→参数→场景排序；只有容量外还有第 11 张其他图时才提交 SKU 高清图。用户可用自然语言调整后才进入提交链路；提交前仍需按官方图片方案映射到 SPU/SKC/SKU 字段。
- “利润页可以完全由 SHEIN OpenAPI 生成”——利润依赖 ET、成本和项目自有口径。

## 9. 当前上线验收口径

### 已完成并纳入 release gate

- OpenAPI 接入总账：19 店授权、云端 IP 白名单、只读探针、读写能力和账号权限统一展示。
- BI 自动化运营页：只保留 Codex 式聊天入口；右侧只展示当前会话进度，不让普通员工理解任务池、验证器、固定确认码或后台审计按钮。
- 官方 OpenAPI 可写动作：`copy_product_draft`、`activate_link`、`retire_link`、`update_inventory`、`update_supply_price`、`update_product_price`、`update_title`、`update_images`、`certificate_review` 已进入受控执行链路。
- 非 505 通用链路：改库存、改供货价、改商品售价、改标题、上下架、换图和证书/资质均已通过独立聊天 smoke；上传资料后会自动重新检查并回写当前会话。505 只作为补链验收样例，不允许成为特判对象。
- 图片上传体验验收：用户不需要理解 `partialEdit` 图片 JSON；页面应能接收图片素材、展示已上传文件和 AI 排序建议，并允许用自然语言调整主图/细节图/方形图/SKU 图分配。执行器只有在生成完整 SHEIN 图片字段、权限和确认均满足后才可提交。`partialEdit` 返回版本号，或后台任务进入流转 / 待审核 / 审核中 / 待终审，都视为平台已接收提交；之后不重复提交，只等待审核生命周期或人工后台确认。
- 安全边界：资料检查、payload hash、账号权限、店铺权限、真实写白名单、执行审计和回读/人工核销仍在后台强制执行。
- 发版前必须跑 `node scripts/test_bi_ops_release_gate.mjs`；该 gate 覆盖权限矩阵、CLI flow、白名单作用域、前端聊天-only 静态检查、正式 `outputs/bi-portal/index.html` 与 `scripts/bi_app/client.js` 同步检查、补链/维护执行器、OpenAPI readiness 和自然语言聊天路由。凡是修改 `scripts/bi_app/client.js` 或 `scripts/bi_app/styles.css`，都必须重新生成 `outputs/bi-portal/index.html`，否则不能发布。
- 发版门禁已纳入下架候选策略/CSV 构建/货号修复 payload smoke 测试。

### 仍不属于官方 OpenAPI 可写范围

- 营销活动报名、限时折扣、优惠券报名目前没有已验证的 SHEIN 官方 OpenAPI 写接口证据，不能伪装成同一套 OpenAPI 真实提交能力。
- 这些动作可以在 BI 聊天里生成建议、候选和操作说明；真实报名仍走已有营销运营流程，后续如官方开放接口，再按同一套资料检查、白名单、确认和回读机制接入。

## 10. 用户确认点

建议先确认以下方向后再开工：

1. 已确认 V2 自动化运营页以 BI 内聊天为唯一用户操作入口，不再沿用飞书/V1/旧任务池产品心智。
2. 已确认 API 接入按 19 店全量推进；官方 OpenAPI 能实现的写动作全部接入同一套受控执行链路。
3. 已确认网页端用自然语言确认执行；后台仍强制资料检查、内部确认码、审计和回读。

## 11. Reviewer 补充意见

独立 reviewer 已审阅本方案，结论是“可以继续，但必须保持保守边界”：

- OpenAPI 销售替换按当前决策至少保持一周全店双跑；不能因局部 matched 就直接替换。若一周内订单数、商品行、金额、取消/无效行、SAR 单价和 BI 价格散点均 100% 无误，再完全切换。
- 用户已推翻 `2 → 5 → 19` 接入节奏：接入总账、授权和探针按 19 店一次性推进；reviewer 原有保守意见只保留为“生产数据切换和真实写操作必须双跑/确认/回读”的安全边界。
- 自然语言必须先生成结构化 Intent、资料检查快照和 payload hash；只有同一会话里唯一当前事项满足权限、白名单和确认条件时，才允许由服务端执行真实写接口。
- 页面应采用“聊天主导 + 当前任务进度侧栏”的模式：后台 dry-run / 预校验 / 审计保留，普通员工界面只展示人话结论、缺口和确认动作。
- 真实写操作必须记录 payload、traceId/code、操作者、回读结果。
- 不能承诺完全摆脱 WebAPI/headless；营销、流量、商品编辑细节和验证码/风控仍可能需要浏览器 fallback。
