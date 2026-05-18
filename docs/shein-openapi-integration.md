# SHEIN OpenAPI 接入计划（半托管 / 沙特市场）

> 当前项目正在从“登录浏览器抓取 SHEIN 后台数据”逐步切换到 SHEIN 官方开放平台 API。本文记录当前已确认的官方规则、应用创建口径、本地配置边界和分阶段接入计划。

> 2026-05-11 补充：当前项目同时存在两条“API 化”链路。`SHEIN 官方 OpenAPI` 需要开放平台应用、授权和签名，HL 仍是并行试点；`SHEIN 后台 WebAPI 直连` 复用已登录 Cookie/session 调后台接口，已用于 16 店销售生产抓取的无浏览器直连优先。两者不要混为一谈，密钥和 Cookie session 都不得进入 GitHub。

## 当前已确认信息

- 开发者主体：广州皓兰商贸有限公司。
- 开发者账号类型：卖家自研。
- 当前店铺模式：半托管。
- 当前主要市场：中东沙特市场。
- 应用合作模式：选择 `半托管`。
- 半托管正式 API 域名：`https://openapi.sheincorp.com`。
- 测试环境 API 域名：`https://openapi-test01.sheincorp.cn`。
- 授权域名和 API 调用域名不是同一个域名。

## 应用创建建议

创建应用时，“合作模式”一旦创建成功后不可修改，因此本项目按当前业务选择 `半托管`。

为避免后续只够 BI 读取、却不能做运营自动化，计划对接业务功能建议全部勾选：

- 商品管理：发布 / 编辑商品、商品价格、上下架等。
- 商品合规：环保标、GPSR、证书等合规资料。
- 订单管理：订单履约、发货、退货等客单流程。
- 库存管理：查询和调整库存。
- 财务管理：收入账单、对账单。

第一阶段代码只做“读数据 + 对账 + 入仓”，不自动执行价格、库存、上下架、发货等写操作。写操作后续必须单独加开关、日志、人工确认和回滚策略。

## 授权与密钥流程

1. 开发者在开放平台创建并审核通过应用，获得应用级 `APP_ID` 和 `APP_SECRET_KEY`。
2. 拼接店铺授权链接，让店铺主账号完成授权。
3. 授权回调会带回 `tempToken`，有效期约 10 分钟。
4. 后端调用 `/open-api/auth/get-by-token` 换取店铺级 `openKeyId` 和加密后的 `secretKey`。
5. 用应用级 `APP_SECRET_KEY` 解密返回的 `secretKey`。
6. 后续普通 API 调用使用店铺级 `openKeyId` + 解密后的 `secretKey` 生成签名。

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
- 当前本机出口 IP 已加入开放平台 IP 白名单；`2026-05-07` 已补加 `188.253.112.44`。后续若本机出口 IP 变化或迁移云端，还要把新的固定出口 IP 加入白名单。
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
- 当前已完成：HL OpenAPI 销售数据写入 API 并行层，并在 BI 系统状态页展示 OpenAPI / 当前生产销售源对账。下一步继续累计多日 `matched`，并在已申请权限审核通过后扩展库存、退货、财务、SFS 等更多业务域。
- 2026-05-18 链接管理中台已把 HL 识别为“OpenAPI 已授权店铺”，不会再把 HL 补链/复制上品请求笼统回复为“无权限”。但当前代码仍只验证了商品/订单/库存等只读与销售对账链路，商品发布/提交审核写适配器尚未实现验证；相关任务会先进入任务池和执行器预检，待写适配器接入后才能真实提交审核。

### P3：16 店分批替换

- 每批授权若干店铺。
- 同一数据域先双跑：官方 OpenAPI 与当前生产销售源（WebAPI 直连优先，必要时浏览器回退）并行一段时间。
- 对账稳定后，将该数据域切到 API。
- 浏览器 profile 仅保留为登录、Cookie/session 刷新、排障和回退工具。

### P4：运营自动化

在读数据链路稳定后，再逐步开放自动化运营能力：

- 商品上下架。
- 更新供货价。
- 库存调整。
- 订单履约 / 运单回传。
- 退货处理。
- 合规证书和资料维护。

所有写操作都必须具备：权限开关、操作者留痕、执行前预览、执行后对账、失败重试边界和人工回滚方案。

## 2026-05-06 进展：HL OpenAPI 并行入仓与 BI 对账展示

本阶段已把 HL 的 OpenAPI 销售数据写入并行表，不覆盖生产销售事实表：

- `fact.openapi_store_daily_sales`
- `fact.openapi_order_header`
- `fact.openapi_order_item`
- `mart.openapi_sales_reconciliation`

可复跑脚本：

```powershell
node scripts/fetch_shein_openapi_sales.mjs HL --start 2026-05-05 --end 2026-05-06
node scripts/load_shein_openapi_sales_warehouse.mjs --store HL --start 2026-05-05 --end 2026-05-06
node scripts/generate_bi_portal.mjs
```

验证结果：

- 2026-05-05：浏览器销售 `108.24 SAR`，OpenAPI 销售 `108.24 SAR`，差异 `0`。
- 2026-05-06：浏览器销售 `0 SAR`，OpenAPI 销售 `0 SAR`，差异 `0`。
- 两天订单数、正销售订单数、商品行数、销售额、浏览器独有订单数、API 独有订单数均一致。
- `outputs/bi-portal/data.json` 已包含 `openapiReconciliation`。
- `outputs/bi-portal/index.html` 的系统状态页已展示 “SHEIN OpenAPI 试点对账” 卡片。

当前结论：HL 销售入口已经具备“官方 OpenAPI 与当前生产销售源双跑、并行入仓、BI 可见对账”的最小闭环；正式切换生产事实表前，仍需继续积累多日 matched 结果，并等待已申请权限审核完成后再扩展销量、SFS、库存、财务等更多业务域。

## 2026-05-10 进展：CX 开放平台应用已提交审核

已在 CX 店铺对应开放平台账号中创建并提交应用：

- 应用名：`CX-椿霞SHEIN运营中台`
- 合作模式：半托管
- 业务功能：商品管理、商品合规、订单管理、库存管理、财务管理
- 当前状态：审核中

该应用仍未写入任何真实密钥到仓库。审核通过并完成店铺授权后，按 HL 的接入方式把 CX 加入 `.local` 配置，先走官方 OpenAPI / 当前生产销售源双跑对账，再决定是否替换生产数据入口。

## 2026-05-07 进展：HL OpenAPI 固定双跑计划任务

已把 HL 官方 OpenAPI 销售试点从手动/不定期核对改为固定计划任务双跑：

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
