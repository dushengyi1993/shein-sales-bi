# BI 自动化运营页 × SHEIN OpenAPI 接入方案（草案）

> 状态：2026-06-24 已确认开工。用户确认 OpenAPI 接入可以 19 店一次性推进，不再按 2→5→19 分批；本文仍坚持密钥隔离、dry-run、人工确认、审计回读和生产数据双跑对账边界，不保存任何 SHEIN 账号、密码、APP_SECRET、openKeyId、secretKey、tempToken 或 Cookie。

## 1. 目标

把 BI 的“自动化运营”页重构成类似 Codex Desktop 的 AI 对话式工作台：

- 用户用自然语言发指令，例如“把 389 空气炸锅在缺货店铺下架”“把 520a 在 DL/DX 上架”“查一下近 7 天 COD 退货异常的 SKC”。
- 云端 Codex CLI / 执行器先理解意图、查证数据、生成计划、做预检。
- 写操作默认只进入 `dry-run` / 任务池，不直接提交 SHEIN。
- 真正影响 SHEIN 的动作必须经过人工确认、权限校验、payload 预检、执行审计、执行后回读。
- 真实写放行必须同时经过两层门：`safeWriteOperations` 物理总闸门（店铺 + 动作）和 `config/bi_ops_write_whitelist.local.json` 试点白名单（人 + 店 + 动作）。任何一层未命中，都只能 dry-run。
- 19 家店铺一次性纳入官方 OpenAPI 接入总账、授权换密钥和只读探针；可用 OpenAPI 稳定替代的数据域仍必须先双跑对账，再切生产。

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

### 19 店接入现状

本地当前 `config/shein_openapi.local.json` 只显示：

- `HL`：真实启用授权。
- `DL`：示例/禁用条目。

因此不能宣称 19 店已接入。下一步必须逐店完成审核状态复核、授权换密钥、配置写入和双跑验证。

根据项目配置，当前 19 店为：

`CX, DL, DX, FY, HL, JSH, JY, LQ, MZ, NM, QH, QY, TS, TZ, TZZ, XC, XL, YJ, ZL`。

历史文档显示：

- `HL` 已真实授权。
- `ZL` 应用已审核通过，但是否已完成授权/换密钥仍需复核。
- DSY 组和 LGM 组大部分应用已提交审核或用户后续注册认证完成，但当前本地安全配置未体现 19 店真实授权。

## 3. API 替换现有抓数的分级策略

### A 类：优先 OpenAPI 双跑，稳定后可替换

这些数据和 HL 已验证接口高度一致，适合先接 19 店 API 并双跑：

1. 销售订单
   - OpenAPI：`order-list` + `order-detail`
   - 现状：云端 WebAPI 直连优先，浏览器登录态回退。
   - 策略：每店授权后先写入并行层 `fact.openapi_*`，按店铺 × 日期对账订单数、订单号集合、商品行、销售额、COD/订单状态字段；至少连续 14 天 matched 后再考虑替换。
   - 注意：历史 HL 日内双跑曾出现 API 抓取时间晚于 Web 源导致的短时差异，因此 OpenAPI 销售不能“一接上就替换生产源”。

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
- 销售订单：已进入 OpenAPI 并行层，只写 `fact.openapi_*`、`fact.openapi_order_payment_flag`、`mart.openapi_sales_reconciliation`，不覆盖生产销售事实。
- 退货退款：已进入 OpenAPI 并行层，只写 `fact.openapi_return_order`、`fact.openapi_return_item`、`mart.openapi_return_reconciliation`，不覆盖生产售后事实。
- 商品/链接基础资料：已进入 OpenAPI 并行层，只写 `fact.openapi_product_link`、`mart.openapi_product_reconciliation`，不覆盖 `fact.link_master_snapshot`、商品页、库存页或任何生产维表。
- OpenAPI 总账：`/api/openapi-capabilities` 只返回脱敏状态、对账摘要和密钥存在布尔值；不得返回 `APP_SECRET`、`openKeyId`、`secretKey`、`tempToken`、Cookie 或任何可还原密钥的信息。
- 调度：销售订单、退货退款、商品/链接 OpenAPI 对账均已接入 `scripts/cloud_daily_refresh.sh`；生产 `shein-bi-cloud-daily-refresh.service` 已开启 `SHEIN_BI_DAILY_OPENAPI_RECONCILIATION=1`、`SHEIN_BI_DAILY_OPENAPI_RETURN_RECONCILIATION=1`、`SHEIN_BI_DAILY_OPENAPI_PRODUCT_RECONCILIATION=1`。这些步骤只写隔离并行对账层，不切生产事实源，也不执行 SHEIN 写操作。
- 空间：商品原始抓取文件位于忽略目录 `outputs/shein_openapi_products/`，脚本默认每店只保留最近 2 个时间戳快照和 `latest.json`，避免云盘长期膨胀。

### B 类：可用 API 辅助，但不能马上完全替换

1. 流量数据
   - 目前未看到已验证的官方 OpenAPI 流量接口。
   - 策略：继续用现有链接表现/业务域抓取；开放平台若有流量/商品分析权限，必须先确认接口、粒度是否达到“日期 × 店铺 × 标准货号 × SKC”。

2. 营销活动 / 限时折扣 / 优惠券
   - 目前主要来自 SHEIN 后台/营销扫描产物。
   - 策略：若开放平台有营销接口，先接“只读活动报名与生效价”；写报名必须单独设计，不与商品上下架混在一起。

3. 商品上下架 / 发布 / 编辑
   - OpenAPI 有商品管理和 `publishOrEdit` 方向，但 payload 完整性复杂。
   - 策略：先做 dry-run 执行器和草稿/预检；真实发布、编辑、上下架必须二次确认。
   - `copy_product_draft` 作为首个真实写试点候选时，提交后回读不能只看商品列表第一页，也不能用平台 SKU / 源 SKC / 货号文本这类弱证据直接判定成功；必须分页扫描，并优先用目标商家 SKU / 商家货号强指纹匹配。只有强指纹命中才可自动闭环为完成；弱匹配、未命中或查询失败都要保持任务锁定，等待全店管理账号人工核销。
   - `retire_link` / `update_inventory` / `update_supply_price` / `update_product_price` / `update_title` / `update_images` 已接入 `scripts/link_ops_maintenance_openapi_executor.mjs`：先 dry-run 定位链接、解析 SKU、生成官方 OpenAPI payload 并锁定 `payloadHash`，真实提交仍必须走总闸门、真实写白名单、确认文本和回读/人工核销。
   - `update_images` 不自动猜图片层级；只有提供完整 SHEIN `partialEdit` 图片 JSON 时才生成换图 payload。普通图片文件或外链必须先经图片上传/外链转换拿到 SHEIN 图片 URL，再放入 partialEdit JSON。

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

整体模仿 Codex Desktop，而不是传统表格页，但采用“双轨”模式：

- 左侧：会话列表 / 最近任务 / 常用指令模板。
- 中间：AI 对话区。
  - 用户自然语言输入。
  - AI 先回答“理解到的目标、影响范围、需要的数据、风险”。
  - 如果是写操作，生成执行计划卡片。
- 右侧：任务池 / 上下文面板。
  - 写操作提案自动进入右侧任务池。
  - 右侧展示 `Sandbox / Dry-run` 预检状态，例如“权限通过”“缺重量尺寸阻断”“正在生效活动中，禁止下架”。
  - 只有在右侧任务卡手动点击 `Execute` 后，才允许进入真实执行。
  - 当前筛选范围：店铺、负责人、货号、SKC、日期。
  - API 能力状态：每店 read/write 状态。
  - 相关证据：订单、库存、链接、营销、售后、评价摘要。
- 底部：输入框。
  - 支持文字指令。
  - 后续可支持上传标题/图片/Excel 等素材，但素材必须先进入云端任务包。

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
- 真实上下架小流量试点，只选择已授权、预检通过、风险低的动作。

第三阶段再做：

- 批量上下架。
- 复制发品。
- 改价。
- 营销活动报名。

## 7. 安全边界

必须坚持：

- API secret、openKeyId、secretKey、tempToken、Cookie 不进 GitHub、不进前端、不进日志明文。
- 不同店铺若属于不同开放平台应用主体，必须使用各自 `APP_ID/APP_SECRET_KEY` 换密钥；不得把 HL 应用密钥默认复用给全部店铺。
- 写操作不得由 AI 直接自动提交。
- 自然语言不能等同于授权；必须转换成可审计任务卡片，再确认。
- 写接口必须先 dry-run，后 execute。
- execute 必须有显式确认文本或页面按钮确认。
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

- “19 店 API 已全部接入”——当前配置只证明 HL 启用。
- “OpenAPI 可以立刻替换全部现有抓取”——流量、营销、ET、利润输入仍有缺口。
- “AI 可以直接自动上下架”——必须先 dry-run、确认、审计、回读。
- “商品复制/发布一定可一键完成”——payload 完整性、证书、类目属性、图片、站点、品牌和仓库都可能阻断。
- “利润页可以完全由 SHEIN OpenAPI 生成”——利润依赖 ET、成本和项目自有口径。

## 9. 建议实施里程碑

### M1：OpenAPI 接入总账

- 新建能力 registry。
- 把 19 店审核/授权/白名单/只读探针状态可视化。
- 先不做写操作。

### M2：自动化运营页 shell

- 页面改成 Codex Desktop 式对话框。
- 接只读问数和任务卡片。
- 支持生成 dry-run 计划，不 execute。

### M3：19 店 OpenAPI 授权与只读探针

- 对 19 店一次性完成开放平台授权、换取店铺密钥、写入私有配置。
- 对已授权店铺跑只读探针；未授权/失败店铺在总账里明确标记。
- 不切生产。

### M4：19 店订单/退货/商品/库存并行入仓

- 写并行事实表。
- BI 系统健康页展示 OpenAPI 对账状态。
- 连续 14 天稳定后，逐域切换。

### M5：上下架 dry-run 执行器

- 先支持“识别要动哪些链接 + 生成计划 + 预检”。
- 页面展示阻断原因。

### M6：小范围真实写试点

- 只选 1 个已授权店铺、1 个低风险动作。当前推荐首个试点动作是 `copy_product_draft`（复制上品 / 补链接），因为它是新增草稿/待审核类动作；`retire_link`、`update_title`、`update_images` 会影响存量在售链接，未具备官方维护接口、旧值备份和可靠回读前不得放行。
- 人工确认后执行。
- 执行后回读和审计完整。
- 通过 `config/bi_ops_write_whitelist.local.json` 明确绑定“人 + 店 + 动作”，默认空白名单；不要直接打开全局所有店铺/所有动作。
- 任何发版或试点白名单变更前，必须先跑 `node scripts/test_bi_ops_release_gate.mjs`。其中 `test_bi_ops_write_whitelist_scope.mjs` 会在隔离临时门户里临时开启 `safeWriteOperations` 和一条真实写白名单，验证只有指定“人 + 店 + 动作”能命中；其他账号、店铺和动作仍被阻断，并且在缺少 dry-run、`waiting_review`、payload hash 等条件时不会真实提交。
- 维护类写动作发版前还必须跑官方文档详情解析和 readiness smoke。`test_bi_ops_release_gate.mjs` 已纳入 `test_shein_openapi_doc_detail_parser.mjs` 和 `test_bi_ops_maintenance_readiness.mjs`：前者使用离线 fixture 验证 `/open-api/goods/modify-skc-shelf` 的 endpoint 和 `shelf_state` 识别逻辑，后者验证只有 schema + 逐店权限 + 强回读三类脱敏证据齐全时才会到 `pilot_ready`，且含敏感字段的证据会被拒绝。真实 schema 验证则通过 `verify_shein_openapi_doc_detail.mjs --cookie-file <登录态Cookie文件> --require-verified` 单独跑，结果只写入 `tmp/` 忽略目录。

## 10. 用户确认点

建议先确认以下方向后再开工：

1. 已确认先做“OpenAPI 接入总账 + Codex 式对话 shell + dry-run 任务卡片”，不直接真实上下架。
2. 已确认 API 接入可 19 店全量推进，不用分批；但 OpenAPI 替换抓数仍走“并行层双跑对账 → 单域切换”，不一次性全切。
3. 写操作确认方式后续再定，当前默认页面按钮 + dry-run + 审计回读。

## 11. Reviewer 补充意见

独立 reviewer 已审阅本方案，结论是“可以继续，但必须保持保守边界”：

- OpenAPI 销售替换要至少 14 天双跑，不能因 HL 早期两天 matched 就直接替换。
- 用户已推翻 `2 → 5 → 19` 接入节奏：接入总账、授权和探针按 19 店一次性推进；reviewer 原有保守意见只保留为“生产数据切换和真实写操作必须双跑/确认/回读”的安全边界。
- 自然语言只能生成结构化 Intent 和任务草稿；不能直连真实写接口。
- 页面应采用“左侧对话 + 右侧 dry-run 任务池”的双轨模式。
- 真实写操作必须记录 payload、traceId/code、操作者、回读结果。
- 不能承诺完全摆脱 WebAPI/headless；营销、流量、商品编辑细节和验证码/风控仍可能需要浏览器 fallback。
