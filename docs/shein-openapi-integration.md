# SHEIN OpenAPI 接入计划（半托管 / 沙特市场）

> 当前项目正在从“登录浏览器抓取 SHEIN 后台数据”逐步切换到 SHEIN 官方开放平台 API。本文记录当前已确认的官方规则、应用创建口径、本地配置边界和分阶段接入计划。

> 2026-06-28 补充：当前项目同时存在两条“API 化”链路。`SHEIN 官方 OpenAPI` 需要开放平台应用、授权和签名，19 店已完成授权/探针/隔离对账与受控写预检；`SHEIN 后台 WebAPI 直连` 复用已登录 Cookie/session 调后台接口，仍用于当前销售生产抓取的无浏览器直连优先。两者不要混为一谈，密钥和 Cookie session 都不得进入 GitHub。

## 当前已确认信息

- 开发者主体：广州皓兰商贸有限公司。
- 开发者账号类型：卖家自研。
- 当前店铺模式：半托管。
- 当前主要市场：中东沙特市场。
- 应用合作模式：选择 `半托管`。
- 半托管正式 API 域名：`https://openapi.sheincorp.com`。
- 测试环境 API 域名：`https://openapi-test01.sheincorp.cn`。
- 授权域名和 API 调用域名不是同一个域名。

## 当前收口（2026-06-28）

- 19 店官方 OpenAPI 授权、云端白名单、只读探针和脱敏能力总账已完成；销售、退货退款、商品/链接基础资料仍写 `fact.openapi_*` / `mart.openapi_*_reconciliation` 隔离层，不直接覆盖生产事实源。
- 自动化运营受控写适配器已接入 `copy_product_draft`、`activate_link`、`retire_link`、`update_inventory`、`update_supply_price`、`update_product_price`、`update_title`、`update_images`、`certificate_review`。真实提交必须走 BI 账号写权限、`safeWriteOperations`、真实写白名单、人 + 店 + 动作、dry-run `payloadHash`、任务 `waiting_review`、确认和回读/审计。
- `copy_product_draft` 已使用 OpenAPI 商品详情 / `spu-info` mapper 还原类目、属性、图片、SKU、供货价、库存和尺寸重量等关键发布字段；强指纹回读未命中时只能人工核销，不能用平台 SKU、源 SKC 或货号文本弱匹配自动判完成。
- 新上品、复制上品、补链接等从未上过架的新链接默认 `shelf_way=2`，并写入约十年后的 `hope_on_sale_date`；短期内不能自动上架。维护已有链接的 `activate_link` / `retire_link` 才按用户指令改变现有链接状态。
- TZ/JSH/TZZ/XC 等店铺身份校验允许静态 `merchantId` fallback，但只能在配置真相匹配且无 GS 账号冲突时使用；不得运行时自动回填或放宽 `account_mismatch`。
- 网页端最终提交不再显示固定确认框；用户在同一聊天里说“可以执行 / 提交吧 / 照做”等自然语言，服务端在唯一当前事项、资料检查通过、权限和白名单命中时内部映射为安全码 `SHEIN_OPENAPI_SUBMIT`。CLI 和脚本仍必须显式传安全码。
- 当前 release gate 覆盖前端确认/反馈、OpenAPI 商品详情 mapper、店铺身份 merchantId fallback、权限矩阵、CLI flow、真实写白名单作用域、生产安全、复制上品成功/弱回读和维护写执行器 smoke。
- 发版门禁已纳入下架候选策略/CSV 构建/货号修复 payload 三个 smoke 测试。

## 应用创建建议

创建应用时，“合作模式”一旦创建成功后不可修改，因此本项目按当前业务选择 `半托管`。

为避免后续只够 BI 读取、却不能做运营自动化，计划对接业务功能建议全部勾选：

- 商品管理：发布 / 编辑商品、商品价格、上下架等。
- 商品合规：环保标、GPSR、证书等合规资料。
- 订单管理：订单履约、发货、退货等客单流程。
- 库存管理：查询和调整库存。
- 财务管理：收入账单、对账单。

读数据 / 对账 / 入仓已形成 19 店隔离并行层；价格、库存、上下架、复制上品、标题/图片、证书等写操作必须走自动化运营任务池，不得绕过 `safeWriteOperations`、真实写白名单、dry-run `payloadHash`、确认、回读和审计。

## 授权与密钥流程

1. 开发者在开放平台创建并审核通过应用，获得应用级 `APP_ID` 和 `APP_SECRET_KEY`。
2. 拼接店铺授权链接，让店铺主账号完成授权。
3. 授权回调会带回 `tempToken`，有效期约 10 分钟。
4. 后端调用 `/open-api/auth/get-by-token` 换取店铺级 `openKeyId` 和加密后的 `secretKey`。
5. 用应用级 `APP_SECRET_KEY` 解密返回的 `secretKey`。
6. 后续普通 API 调用使用店铺级 `openKeyId` + 解密后的 `secretKey` 生成签名。

19 店全量接入时要额外注意：不同店铺可能属于不同开放平台应用主体。私有配置支持全局默认 `app`，也支持 `apps.<appKey>` 或店铺级 `stores[].appId/appSecretKey` 覆盖；授权换密钥时必须使用该店对应应用的密钥，不能把 HL 应用密钥默认复用给所有店。

注意：`/open-api/auth/get-by-token` 比较特殊，此时还没有店铺级密钥，签名要用应用级 `APP_ID` 和 `APP_SECRET_KEY`，请求头使用 `x-lt-appid`。

## API 请求头

普通接口请求头：

- `Content-Type: application/json;charset=UTF-8`
- `x-lt-openKeyId: <店铺授权获得的 openKeyId>`
- `x-lt-timestamp: <毫秒时间戳，5 分钟内有效>`
- `x-lt-signature: <签名>`

`/open-api/auth/get-by-token` 请求头：

- `Content-Type: application/json;charset=UTF-8`
- `x-lt-appid: <应用 APP_ID>`
- `x-lt-timestamp: <毫秒时间戳，5 分钟内有效>`
- `x-lt-signature: <用 APP_ID + APP_SECRET_KEY 生成的签名>`

签名规则：

```text
VALUE = OpenKeyId + "&" + Timestamp + "&" + Path
KEY = SecretKey + RandomKey
HexString = HMAC-SHA256(VALUE, KEY).toHexString()
Base64String = Base64Encode(HexString)
Signature = RandomKey + Base64String
```

## 本地安全边界

真实密钥只允许放在本机忽略文件中，例如：

- `config/shein_openapi.local.json`

仓库只保留模板：

- `config/shein_openapi.example.json`

不要把下面内容写入 GitHub、聊天、公开文档或日志：

- `APP_SECRET_KEY`
- 店铺级 `secretKey`
- 店铺级 `openKeyId`
- 授权回调拿到的 `tempToken`
- 未脱敏的完整 API 请求头

## 当前验证结果（2026-05-06）

- HL 真实应用 `HL-皓兰SHEIN运营中台` 已审核通过并启用。
- 用户已提交 `销量查询` 与 `SFS备货履约` 权限包申请，等待 SHEIN 审核结果。
- HL 店铺授权已完成，`tempToken` 已通过 `/open-api/auth/get-by-token` 换取店铺级密钥。
- 真实应用级密钥与店铺级密钥只保存在 `config/shein_openapi.local.json`，该文件被 `.gitignore` 排除，不进入 GitHub。
- 当前生产云服务器出口 IP `43.165.167.135` 已加入开放平台 IP 白名单；本机排障时还需确认当前出口 IP 是否在对应开发者账号白名单中。历史本机出口 `188.253.112.44` / `82.27.116.13` 只作追溯参考。
- 本地 OpenAPI 客户端已成功调用半托管生产环境 `https://openapi.sheincorp.com`。
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
- 已确认财务对账单列表按生成时间查询的窗口不能超过 7 天，项目探针默认使用 6 天窗口。
- 2026-05-05 与 2026-05-06 两天 HL 订单对账已经通过：订单数、正销售订单数、商品行数、正销售件数、销售额、订单号集合、商品 `goodsId` 集合均与浏览器抓取一致。

可复跑脚本：

```powershell
node scripts/shein_openapi_authorize_hl.mjs --store HL --port 9360
node scripts/probe_shein_openapi_hl.mjs --store HL
node scripts/fetch_shein_openapi_sales.mjs HL --date 2026-05-05
node scripts/reconcile_shein_openapi_hl_sales.mjs --store HL --start 2026-05-05 --end 2026-05-06
```

注意：第一条授权脚本只在店铺授权过期或更换应用密钥时需要重新执行。

`scripts/fetch_shein_openapi_sales.mjs` 输出目录为 `outputs/shein_openapi_fetch/`，结构尽量兼容原 `outputs/shein_fetch/`，但不会覆盖当前生产销售源文件。当前已通过 `load_bi_warehouse.mjs --dry-run` 验证可被现有销售入仓流程识别；正式试点入仓使用 `scripts/load_shein_openapi_sales_warehouse.mjs` 写入并行表和对账表，不覆盖生产事实表。

已补安全开关：

```powershell
node scripts/load_bi_warehouse.mjs --sales-dir outputs/shein_openapi_fetch --sales-date 2026-05-05 --skip-links --skip-dashboard --dry-run
```

其中 `--skip-links` 会跳过链接域，`--skip-dashboard` 会跳过旧动作池 / 店铺驾驶舱片段，避免 API 销售试点时误动其他业务域。

## 分阶段接入计划

### P0：本地底座

- 固化官方文档关键规则。
- 建立配置模板。
- 实现签名、AES 解密、授权换密钥和基础请求客户端。
- 用官方示例验证签名结果。

### P1：测试环境验证

- 用开放平台测试工具获取测试店铺密钥。
- 调用测试环境接口验证请求头、签名、错误处理和响应落盘格式。
- 优先验证半托管相关读接口。

### P2：一个真实店铺试点

- HL 店铺已完成真实授权。
- 只读接入已验证：站点 / 币种、商品列表、订单列表 / 详情、库存、财务对账、退货。
- 初步订单销售对账已通过。
- 历史已更新：HL 单店 OpenAPI 销售试点已升级为 19 店 OpenAPI 销售双跑并行层。官方 OpenAPI 结果只写 `fact.openapi_*`、`fact.openapi_order_payment_flag` 和 `mart.openapi_sales_reconciliation`，不覆盖正式销售事实表；切生产源前仍需连续日期对账。
- 2026-05-18 起，链接管理中台已把 HL 识别为“OpenAPI 已授权店铺”，不会再把 HL 补链/复制上品请求笼统回复为“无权限”。2026-05-20 后，HL `copy_product_draft` 任务可从 BI 当前会话直接进入 `/api/link-ops-execute`，由 `scripts/link_ops_hl_openapi_executor.mjs` 做 OpenAPI 权限、站点、品牌、仓库和 payload 预检；真实 `publishOrEdit` 仍必须 payload 完整且用户二次确认。

### P3：当前启用店铺分批替换

- 每批授权若干店铺。
- 同一数据域先双跑：官方 OpenAPI 与当前生产销售源（WebAPI 直连优先，必要时浏览器回退）并行一段时间。
- 对账稳定后，将该数据域切到 API。
- 浏览器 profile 仅保留为登录、Cookie/session 刷新、排障和回退工具。

2026-07-11 更新：19 店店铺级 OpenAPI 授权、实时只读探针、销售对账、退货对账和商品/链接对账均已回读为 19 店成功。总账的 `writeConfirmable=19` 表示 19 店均存在至少一类“可进入受控提交链路”的写适配器和店铺总闸门，不表示所有动作都已执行，也不代表可静默写入；每次真实提交仍必须通过当前账号店铺权限、具体动作白名单、资料系统检查、payload hash、用户确认和提交后回读。

商品/链接并行层边界：

- 抓取脚本：`scripts/fetch_shein_openapi_products.mjs`，只调用商品列表、商品详情和 SKU 虚拟库存查询。
- 入仓脚本：`scripts/load_shein_openapi_products_warehouse.mjs`，只写 `fact.openapi_product_link` 和 `mart.openapi_product_reconciliation`。
- 调度脚本：`scripts/cloud_openapi_product_reconciliation.sh`；生产 `shein-bi-cloud-daily-refresh.service` 已开启 `SHEIN_BI_DAILY_OPENAPI_PRODUCT_RECONCILIATION=1`，每天随慢变日更写入隔离对账层，不切商品/库存生产源。
- 云端验证：2026-06-26 19 店全量抓取/入库成功，商品列表、详情、库存分片均成功；正式 `/api/openapi-capabilities` 显示 `productReconciliationReady=19` 且密钥泄露扫描为 false。
- 仍不能切生产的原因：OpenAPI 商品状态目前只适合按“是否已上架”二值对账；现有浏览器源有 `待上架 / 已上架 / 已售罄 / 已下架` 四档。OpenAPI 的四档状态差异只可作为 evidence，不可直接替代商品列表页、库存页或流量页的链接状态。
- 库存边界：OpenAPI `stock-query` 是 SHEIN 店铺虚拟库存证据，不是 ET 实际库存；不得替代 ET 可售、在库、在途、发货申请单或仓储费口径。
- 价格边界：OpenAPI / 商品详情中的供货价是基础证据，不是营销折后价；不得替代营销活动、限时折扣、优惠券叠加后的前台折后价。

### P4：运营自动化

在读数据链路稳定后，再逐步开放自动化运营能力：

- 商品上下架。
- 更新供货价。
- 库存调整。
- 订单履约 / 运单回传。
- 退货处理。
- 合规证书和资料维护。

所有写操作都必须具备：权限开关、操作者留痕、执行前预览、执行后对账、失败重试边界和人工回滚方案。

2026-06-27 补充：维护类写动作已从“候选接口”升级为受控 OpenAPI 适配器。

- 已接入动作与官方文档：
- `activate_link` / `retire_link`：`3001253 /open-api/goods/modify-skc-shelf`，恢复/重新上架使用 `shelf_state=1`，下架使用 `shelf_state=2`。
- 批量低曝光零销量下架候选必须先走只读确认表，不能直接执行。统一规则：当前已上架、近 7 天曝光 `c7EpsUv <= 300`、近 7 天销量 `c7_sale_cnt = 0`、平台新品标签 `newGoodsTag` 为空，并且首次上架已满 15 天；首次上架 15 天内无论是否有新品标签都排除，缺 `first_shelf_time` 进入待确认/不执行。用户确认后，真实下架仍走 `retire_link` 受控任务；货号改成 `（废）标准货号` 是 best-effort，若 `partialEdit` 校验失败，保留下架结果并把未改货号项列入汇总。
- 下架后货号修复：`scripts/repair_retire_supplier_code_openapi.mjs` 是独立的修复专用执行器，只调 `partialEdit` 改货号为`（废）标准货号`，绝不调 shelf 接口。硬排除 FY SK-5110 和指定 SK-270。本机 Windows 只能 dry-run，真实执行必须在云端。修复失败不阻断已完成的下架结果。
  - `update_inventory`：`3001738 /open-api/stock/change-inventory/v2`，按 SKU 写虚拟库存并用 `/open-api/stock/stock-query` 回读。
  - `update_supply_price`：`3001681 /open-api/goods/update-cost`，按 SKC/SKU 写供货价。
  - `update_product_price`：`3001407 /open-api/openapi-business-backend/product/price/save`，同时写 `shopPrice` 与 `specialPrice`，避免未传 `specialPrice` 被平台解析为 `0`。
  - `update_title` / `update_images`：`3001810 /open-api/goods/product/partialEdit`。换图只接受完整 SHEIN 图片 JSON（`spu_name + image_info/skc_list/site_detail_image_info_list`），普通图片上传/外链转换需先取得 SHEIN 图片 URL。
  - `certificate_review`：证书要求查询、证书池创建/编辑、店铺证书池创建/编辑、SKC 绑定商品证书池等证书接口；执行器接受 `certificatePayloads[{endpoint,body}]`，endpoint 必须在证书允许列表内，提交后默认人工核销审核状态。
- 执行边界：所有动作默认只 dry-run，生成并锁定 `payloadHash`；真实提交必须同时满足 BI 账号写权限、`safeWriteOperations`、真实写白名单、人 + 店 + 动作、任务处于 `waiting_review`、确认文本 `SHEIN_OPENAPI_SUBMIT`、提交后回读或人工核销。
- 营销边界：公开 OpenAPI 目录当前未发现普通营销活动报名、限时折扣、优惠券报名写接口；`campaign_signup` / `flash_discount` 不列入官方 OpenAPI 可实现动作，继续走本地营销运营流程、价格栈守卫和人工确认。
- 官方文档验证入口示例：

```powershell
node scripts/verify_shein_openapi_doc_detail.mjs `
  --doc-id 3001253 `
  --endpoint /open-api/goods/modify-skc-shelf `
  --out tmp/shein-openapi-doc-detail/modify-skc-shelf.local.json `
  --require-verified `
  --pretty
```

- 维护执行器隔离验收入口：

```powershell
node scripts/test_bi_ops_maintenance_executor_flow.mjs
node scripts/test_bi_ops_release_gate.mjs
```

- 生产放行前仍建议跑 readiness 和安全检查：

```powershell
node scripts/check_bi_ops_maintenance_readiness.mjs --operation retire_link --expect blocked --pretty
node scripts/check_bi_ops_production_safety.mjs --expect locked
```


## 2026-05-06 / 2026-06-25 进展：OpenAPI 并行入仓与 BI 对账展示

本阶段已把 OpenAPI 销售数据写入并行表，不覆盖生产销售事实表。2026-06-25 起支持 19 店统一调度：

- `fact.openapi_store_daily_sales`
- `fact.openapi_order_header`
- `fact.openapi_order_item`
- `mart.openapi_sales_reconciliation`

可复跑脚本：

```powershell
node scripts/run_shein_openapi_sales_reconciliation.mjs --date YYYY-MM-DD
node scripts/run_shein_openapi_returns_reconciliation.mjs --date YYYY-MM-DD
node scripts/run_shein_openapi_products_reconciliation.mjs
```

验证结果：

- 2026-05-05：浏览器销售 `108.24 SAR`，OpenAPI 销售 `108.24 SAR`，差异 `0`。
- 2026-05-06：浏览器销售 `0 SAR`，OpenAPI 销售 `0 SAR`，差异 `0`。
- 两天订单数、正销售订单数、商品行数、销售额、浏览器独有订单数、API 独有订单数均一致。
- `outputs/bi-portal/data.json` 已包含 `openapiReconciliation`。
- `outputs/bi-portal/index.html` 曾在系统状态页展示 “SHEIN OpenAPI 试点对账” 卡片；2026-06-17 起该卡片默认关闭，不再作为生产验收项。

历史结论：HL 销售入口曾具备“官方 OpenAPI 与当前生产销售源双跑、并行入仓、BI 可见对账”的最小闭环；该 单店 入口已被 19 店销售/退货/商品隔离双跑层取代。

## 2026-05-19 进展：HL 商品写执行器预检接入

已按官方文档和真实接口返回确认 HL 具备商品发布前置能力：

- 官方接口：`/open-api/goods/product/check-publish-permission`，文档页：<https://open.sheincorp.com/documents/apidoc/detail/3001589>。
- 官方商品发布/编辑接口：`/open-api/goods/product/publishOrEdit`，文档页：<https://open.sheincorp.com/documents/apidoc/detail/3001707>。
- 真实 HL 探针返回：`canPublishProduct=true`。
- 真实站点列表包含 `shein-sa`，币种 `SAR`。
- 真实品牌列表包含 `SOKANY`，`brand_code=2a64l`。

已新增受控执行器：

```powershell
node scripts/link_ops_hl_openapi_executor.mjs --task-id <任务ID> --dry-run
```

执行器默认只做预检，不调用发布接口。它会真实调用 HL OpenAPI 检查发品权限、站点、品牌和仓库，然后寻找任务里的 `openapiPublishPayload` 或任务素材 JSON 中的发布 payload。

真实提交必须同时满足：

- 任务已确认；
- 目标店铺包含 `HL`；
- intent 包含 `copy_product_draft`；
- 发布 payload 完整，包含类目、属性、站点、SKC 图片、销售属性、SKU、供货价/成本、库存、尺寸重量和上架方式等字段；
- 命令显式传入 `--execute --confirm SHEIN_OPENAPI_SUBMIT`，且任务命中服务端 `safeWriteOperations` 总闸门和 `config/bi_ops_write_whitelist.local.json` 的“人 + 店 + 动作”真实写试点白名单。

当前边界：执行器已经不再停留在“HL 没有权限 / 适配器未实现”，但 BI 现有链接表现数据不足以直接还原完整商品发布 payload。复制 DL 等非 OpenAPI 店铺的已上 SKC 到 HL 时，还需要“源商品详情抓取/映射器”把源后台详情转换成 `publishOrEdit` 所需 payload；否则执行器会阻断并说明缺失类目、属性、SKU、成本、库存和尺寸重量等资料。图片素材对 `copy_product_draft` 不再作为第一层硬阻断，执行器会先尝试从源商品快照复制，源快照不足时再阻断。

2026-05-19 已补第一版源店 WebAPI 快照映射基座：

```powershell
node scripts/link_ops_build_product_draft_from_webapi.mjs --source-store DL --source-skc sv260315124105439111444 --date 2026-05-15
```

- 新增 `lib/link_ops_product_draft_mapper.mjs`：从 `outputs/shein_links/<店铺>/<日期>.json` 和 `outputs/shein_links_raw/<店铺>/<日期>/*.json` 汇总源商品列表、备货库存、诊断表现等快照，生成 `canonical product draft`。
- 新增 `scripts/link_ops_build_product_draft_from_webapi.mjs`：用于单独生成草稿和排查缺口，不写 SHEIN 后台。
- `scripts/link_ops_hl_openapi_executor.mjs` 在任务没有上传 `openapiPublishPayload` 时，会尝试从任务里的源店 + 源 SKC 自动生成 WebAPI 快照 payload 草稿，再进入 HL OpenAPI 预检。
- DL `S1810电热水壶 / sv260315124105439111444` 样本已能生成：类目 `4681`、品牌 `2a64l`、英文标题、3 个图片候选、1 个 SKC、1 个 SKU、库存草稿 `100`、计划上架时间 `10` 年后；但仍会阻断真实提交，因为当前快照缺 `product_attribute_list`、SKU 尺寸/重量、`supplier_sku` 和 `cost_info`。
- 长期架构保持不变：短期源店读取走 WebAPI/云端登录态；后续 DL 等源店拿到官方 OpenAPI 后，只替换源读取器，继续复用 canonical draft 和 HL 目标写执行器。
- 2026-05-20 起，`/api/link-ops-execute` 会把当前任务快照传给 HL 子执行器；草稿任务点击开始时自动确认并写入执行审计，前端任务区显示“开始执行 / 预检”和预检通过后的二次提交入口。源商品候选必须命中明确 SKC 或货号文本后才按销量排序，避免误选无关高销量链接。

2026-05-19 已进一步验证“商品编辑页 WebAPI -> HL 草稿箱”链路：

- 源读取：DL 商品编辑页 `/spmp/product/get_similar_product_detail` 可按 `spu_name` 返回复制上品所需详情，包含 `product_type_id`、商品属性、图片、SKU 尺寸重量、成本等字段，比链接快照完整。
- 目标写入：HL 商品子系统 `/spmp/product/save_draft` 已真实更新草稿箱已有 `S1810电热水壶` 草稿 `v2603291437289685`，返回 `code=0`；回读确认类目 `4681`、`product_type_id=1939`、属性 10 条、SKC 图 11 张、库存 100、成本 `70 SAR`、计划上架 `2036-05-19 10:00:00`。
- 复盘修正：本次草稿实际可提交审核，但页面“发布站点”未自动勾选；后续 SPMP `/spmp/product/save_draft` 写草稿不能直接继承源店空 `site_list`，必须强制写入目标店发布站点 `[{main_site:"shein", sub_site_list:["shein-sa"]}]`，并在执行器预检中阻断未包含 `shein-sa` 的 payload。
- 安全边界：本次只保存草稿，未调用 `/spmp/product/publish`、OpenAPI `publishOrEdit` 或任何提交审核/上架接口。后续需把一次性 WebAPI 探测脚本固化为受控执行器，再接 BI 任务流。

2026-05-19 已补商品资料母库结构与 HL OpenAPI 源读取验证：

- 母库设计文档：`docs/link-ops-product-master.md`。
- 母库候选 JSON Schema：`schemas/shein-product-master.schema.json`。
- WebAPI 快照候选生成：`scripts/link_ops_build_product_master_candidate.mjs`。
- OpenAPI 源读取候选生成：`scripts/link_ops_build_product_master_candidate_from_openapi.mjs`。
- DL `S1810电热水壶 / sv260315124105439111444` 用当前 WebAPI 快照可生成 `candidate_needs_review`，母库不含图片 URL，但仍缺 `productTypeId`、完整商品属性、尺寸重量。
- HL OpenAPI 已验证可从 `/open-api/openapi-business-backend/product/query` 取 `spuName`，再调用 `/open-api/goods/spu-info` 获取较完整商品详情；样本 `FZ-666颈部按摩器` 可生成 `candidate_ready`，包含 `productTypeId`、商品属性、销售属性、尺寸重量、SAR 成本等字段。OpenAPI 返回的 `skuCode` 是平台编号，只做追溯；`supplierSku` 为空时不拿平台 `skuCode` 冒充。
- 价格/核价不作为商品资料冲突。复制发品前按报价策略处理：默认可按 `50%` 利润率或同款其它店最高核价报价，并允许人工覆盖。



## 历史归档：2026-06-05 LGM 组剩余开放平台应用提交审核

用户已完成 LGM 组剩余店铺开放平台注册与认证；本轮使用各店铺独立可见 Chrome profile 和桌面 `LOGO` 文件夹中按店铺命名的 PNG，按 DSY 同一口径创建 / 提交应用。未读取、保存或写入任何真实 `APP_ID`、`APP_SECRET_KEY`、店铺 `openKeyId`、`secretKey` 或授权 `tempToken`。

- 用户确认此前已完成：`CX`。
- 本轮已提交审核中：
  - `YJ-永爵SHEIN运营中台`。
  - `XL-夏莲SHEIN运营中台`。
  - `QY-秋英SHEIN运营中台`。
  - `QH-谦和SHEIN运营中台`。
  - `TZ-天舟SHEIN运营中台`。
  - `JSH-君思昊SHEIN运营中台`。
  - `TZZ-天子舟SHEIN运营中台`。
  - `XC-鑫诚SHEIN运营中台`。
- 合作模式：半托管。
- 计划对接业务功能：商品管理、商品合规、订单管理、库存管理、财务管理。
- 应用图标：来自本机桌面 `LOGO` 文件夹中按店铺命名的 PNG；图片均为 1:1 且小于 10MB。
- 非敏感状态摘要：`outputs/reports/lgm-openapi-application-final-status-20260605.json`。

下一步必须等应用审核通过后，再逐店完成授权、换取店铺级密钥并写入本机忽略配置；在授权和多日双跑对账完成前，不得切换生产销售源。

## 2026-05-30 进展：DSY 组开放平台应用已批量提交

已使用各店铺独立可见 Chrome profile，在 SHEIN 开放平台按既有口径创建 / 提交 DSY 组应用；未读取、保存或写入任何真实 `APP_ID`、`APP_SECRET_KEY`、店铺 `openKeyId` 或 `secretKey`。

- 已审核通过：
  - `HL-皓兰SHEIN运营中台`。
  - `ZL-紫翎SHEIN运营中台`。
- 已提交审核中：
  - `DL-地利SHEIN运营中台`。
  - `DX-冬玺SHEIN运营中台`。
  - `FY-锋炎SHEIN运营中台`。
  - `LQ-乐棋SHEIN运营中台`。
  - `NM-南墨SHEIN运营中台`。
  - `JY-钧羽SHEIN运营中台`。
  - `TS-天实SHEIN运营中台`。
  - `MZ-妙镇SHEIN运营中台`。
- 合作模式：半托管。
- 计划对接业务功能：商品管理、商品合规、订单管理、库存管理、财务管理。
- 应用图标：来自本机桌面 `LOGO` 文件夹中按店铺命名的 PNG；图片均为 1:1 且小于 10MB。
- 非敏感状态摘要：`outputs/reports/dsy-openapi-application-final-status-20260530-2043.json`。

下一步必须等应用审核通过后，再逐店完成授权、换取店铺级密钥并写入本机忽略配置；在授权和多日双跑对账完成前，不得切换生产销售源。

## 历史归档：2026-05-28 ZL 开放平台应用提交审核

已在 ZL 店铺对应开放平台账号中创建并提交应用：

- 开发者主体：`广州番禺紫翎贸易商行（个体工商户）`。
- 应用名：`ZL-紫翎SHEIN运营中台`。
- 合作模式：半托管。
- 业务功能：商品管理、商品合规、订单管理、库存管理、财务管理。
- 当前状态：审核通过（2026-05-30 通过 ZL profile 页面复核）。
- IP 白名单已添加云服务器 `43.165.167.135` 和当时本机出口 `38.181.81.164`。

该应用仍未写入任何真实密钥到仓库。审核通过并完成店铺授权后，按 HL 的接入方式把 ZL 加入 `.local` 配置，先走官方 OpenAPI / 当前生产销售源双跑对账，再决定是否替换生产数据入口。

## 历史归档：2026-05-10 CX 开放平台应用提交审核

已在 CX 店铺对应开放平台账号中创建并提交应用：

- 应用名：`CX-椿霞SHEIN运营中台`
- 合作模式：半托管
- 业务功能：商品管理、商品合规、订单管理、库存管理、财务管理
- 当前状态：审核中

该应用仍未写入任何真实密钥到仓库。审核通过并完成店铺授权后，按 HL 的接入方式把 CX 加入 `.local` 配置，先走官方 OpenAPI / 当前生产销售源双跑对账，再决定是否替换生产数据入口。

## 历史归档：2026-05-07 HL OpenAPI 固定双跑计划任务

历史说明：以下 Windows 计划任务是早期 HL 单店试点任务，当前已被云端 19 店 `cloud_openapi_*_reconciliation.sh` 与 `shein-bi-cloud-daily-refresh.service` 取代：

- `SHEIN-Sales-OpenAPI-HL-YesterdayFinal-0025`：每天 `00:25` 抓取并对账前一天最终版销售。
- `SHEIN-Sales-OpenAPI-HL-Intraday-1225`：每天 `12:25` 抓取并对账当天日内销售。
- 调度入口：`scripts/scheduled_openapi_hl_yesterday_final.ps1`、`scripts/scheduled_openapi_hl_intraday.ps1`。
- 统一执行脚本：`scripts/scheduled_openapi_hl_reconciliation.ps1`。
- 任务安装入口：`scripts/install_windows_scheduled_tasks.ps1 -IncludeOpenApiPilot`。

边界保持不变：官方 OpenAPI 结果只写入 `fact.openapi_store_daily_sales` / `fact.openapi_order_header` / `fact.openapi_order_item` 和 `mart.openapi_sales_reconciliation`，不覆盖生产销售事实表。

白名单处理与复跑结果：

- `2026-05-07 12:59` 手动验证曾返回 `openapi00002 IP is not in the whitelist: 188.253.112.44`。
- `2026-05-07 13:28` 已在 SHEIN 开放平台 `IP白名单` 页补加 `188.253.112.44`，页面白名单包含 `188.253.112.44` 与历史 IP `82.27.116.13`。
- 复跑 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scheduled_openapi_hl_reconciliation.ps1 -Mode intraday` 成功，日志为 `logs/scheduled/openapi-hl-intraday-20260507-132856.log`，并刷新 `outputs/bi-portal/data.json` / `outputs/bi-portal/index.html`。
- 当日 intraday 对账状态为 `warning`：API 销售 `472 SAR`、浏览器源文件销售 `227 SAR`，API 多 1 个订单；这是日内 API 抓取时间晚于浏览器上一轮同步导致的待复核差异，不是白名单错误。下一轮浏览器同步后应继续观察是否回到 `matched`。
