# SHEIN OpenAPI 接入计划（半托管 / 沙特市场）

> 当前项目正在从“登录浏览器抓取 SHEIN 后台数据”逐步切换到 SHEIN 官方开放平台 API。本文记录当前已确认的官方规则、应用创建口径、本地配置边界和分阶段接入计划。

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

- 应用审核通过后，先授权 1 个店铺。
- 只读接入：站点 / 币种、商品列表、订单列表 / 详情、库存、财务对账、退货。
- 与当前浏览器抓取结果对账，确认口径差异。
- API 数据入 PostgreSQL 后刷新 BI 门户。

### P3：15 店分批替换

- 每批授权若干店铺。
- 同一数据域先双跑：API 与浏览器抓取并行一段时间。
- 对账稳定后，将该数据域切到 API。
- 浏览器 profile 仅保留为登录、排障、回退工具。

### P4：运营自动化

在读数据链路稳定后，再逐步开放自动化运营能力：

- 商品上下架。
- 更新供货价。
- 库存调整。
- 订单履约 / 运单回传。
- 退货处理。
- 合规证书和资料维护。

所有写操作都必须具备：权限开关、操作者留痕、执行前预览、执行后对账、失败重试边界和人工回滚方案。
