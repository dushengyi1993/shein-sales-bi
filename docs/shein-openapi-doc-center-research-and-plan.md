# SHEIN OpenAPI 文档中心系统研究与半托管能力规划

> 生成时间：2026-07-03。来源：SHEIN 开放平台文档中心公开页面（通过浏览器 CDP 逐页读取）+ 官方目录接口抓取。本文档不包含任何密钥、Cookie 或店铺授权值。

---

## 一、研究范围与方法

### 已读板块

| 板块 | 文档数 | 读取方式 |
|------|--------|----------|
| 开发者文档 | 8 篇 | 浏览器 CDP 逐页读取全文 |
| 解决方案 | ~30 篇（去重后约 20 篇独立文档） | 浏览器 CDP 逐页读取全文 |
| API 文档 | 217 条接口 | 官方目录接口 `queryAllApiDocCategoryList?categoryType=1` 抓取 |
| WebHook 文档 | 22 条事件 | 官方目录接口 `queryAllApiDocCategoryList?categoryType=2` 抓取 + 1 条详情样例 |
| 图片方案系统文档 | 1 篇 | 浏览器 CDP 完整读取 |

### 研究方法

1. 通过 `scripts/sync_shein_openapi_doc_catalog.mjs` 抓取官方目录接口，获得 239 条接口/事件的完整清单。
2. 通过 `web-access` CDP 方式逐页读取文档中心侧边栏列出的全部开发者文档和解决方案文档。
3. 对照现有项目 `docs/bi-ops-openapi-automation-plan.md` 和 `scripts/bi_ops_cli.mjs` 能力边界，形成差距分析。

---

## 二、开发者文档核心要点

### 2.1 开发指南（必看）

- **开发者类型**：卖家自研、第三方软件服务商(ISV)、平台特邀。资质审核通过后不可修改。
- **应用类型**：对应卖家合作模式——自运营、半托管、全托管、POP、SHEIN自营、认证仓、其他。应用创建后类型不可修改。
- **半托管应用**：可授权的商家范围为半托管模式商家 + 墨西哥地区的全托管模式商家。
- **接入流程**：注册开发者 → 创建应用 → 应用审核 → 测试应用 → 发布准备（IP白名单、Webhook回调地址审核、域名切换） → 触达卖家授权。
- **测试环境**：`https://openapi-test01.sheincorp.cn`；正式环境半托管/自运营用 `https://openapi.sheincorp.com`。
- **API权限**：大部分权限包在应用审核通过后自动订阅；少数需手动申请。

### 2.2 签名规则

- **算法**：HMAC-SHA256 + Base64。
- **签名数据(VALUE)**：`OpenKeyId + "&" + Timestamp + "&" + Path`
- **签名密钥(KEY)**：`SecretKey + RandomKey`（RandomKey 为 5 位随机字符串）
- **最终签名**：`RandomKey + Base64(HexString(HMAC-SHA256(VALUE, KEY)))`
- **get-by-token 特殊**：调用 `/open-api/auth/get-by-token` 时，签名使用应用的 `APP_ID` 和 `APP_SecretKey`，而非店铺的 openKeyId/secretKey。
- **时间戳**：5 分钟内有效。
- **代码示例**：官方提供 Java、PHP、C#、Python、JavaScript 五种语言的签名生成代码。

### 2.3 API 调用说明

- **请求头**：`Content-Type: application/json;charset=UTF-8`、`x-lt-openKeyId`、`x-lt-timestamp`、`x-lt-signature`。
- **传参方式**：GET 请求在 URL 拼接查询参数；POST 请求在 body 传 JSON。
- **返回格式**：`{ code, msg, info, bbl, traceId }`。`code="0"` 为成功。
- **错误排查**：提供 `traceId`，保留近 3 天。

### 2.4 店铺授权应用手册

- **授权流程**：拼接授权链接 → 卖家登录 SHEIN 后台并授权 → 获取 `tempToken`（10 分钟有效） → 调用 `/open-api/auth/get-by-token` 换取 `openKeyId` 和加密 `secretKey` → 用 `APP_SecretKey` 解密 `secretKey`。
- **授权域名**：`https://openapi-sem.sheincorp.com/#/empower?appid=...&redirectUrl=...&state=...`
- **secretKey 解密**：AES/CBC/PKCS5Padding，默认 IV 为 `space-station-default-iv`（取前 16 字节），密钥为 `APP_SecretKey`（取前 16 字节）。
- **代码示例**：官方提供 Java、PHP、C#、Python、JavaScript 五种语言的授权+解密代码。

### 2.5 事件回调接入说明（WebHook）

- **适用场景**：SHEIN 内部系统数据变更主动通知外部 ERP，如订单状态变更、商品审核通知、采购单信息变更等。
- **接入条件**：已认证开发者账号 + 已注册应用。
- **接入步骤**：
  1. 在开发者后台录入正式环境和测试环境的回调地址（校验有效性，超时 1.5 秒）。
  2. 保存应用的 `app_id` 和 `app_secretKey`，用于 Webhook 签名验证。
  3. 在门户订阅所需的事件。
- **回调内容**：
  - 请求类型：POST
  - 请求头：`x-lt-openKeyId`、`x-lt-eventCode`、`x-lt-appid`、`x-lt-timestamp`、`x-lt-signature`、`Content-Type: multipart/form-data`
  - 请求体：`eventData`（加密内容，AES 加密）
- **验签**：使用应用的 `app_id` 和 `app_secretKey`（不是店铺的 openKeyId/secretKey）。
- **解密**：AES 加密，默认 IV 为 `space-station-default-iv`，密钥为 `app_secretKey`。
- **最佳实践**：收到 Webhook 后立即异步处理并返回 2xx（如 200），避免超时误判失败。平台判断 2xx 为成功。
- **IP 地址**：SHEIN Webhook 消息推送的 IP 地址可在文档中查看。

### 2.6 其他开发者文档

- **开发者账号类型介绍**：卖家自研（用 SHEIN 商家账号验证）、ISV（提交公司主体+软件功能信息）、平台特邀（仅限认证仓等）。
- **测试工具介绍**：平台提供测试商家授权工具、测试接口调用工具、商品发布调试工具。不支持开发者自行创建测试环境应用/店铺。
- **常见名词说明**：SPU/SKC/SKU 层级关系、主/次销售属性、商品公文、售价/供货价、客单/采购单等。
- **应用类型介绍**：半托管应用接口差异——商品发布用 `cost_price`（不用 `price_info_list`）、更新价格用更新成本价接口、可使用商品上下架接口、无法使用 Feed 模块、可使用合规/客单/退货退款/库存/财务/店铺模块。

---

## 三、半托管解决方案核心要点

### 3.1 半托管模式接入指南

半托管模式下可对接的业务模块：

| 模块 | 可用能力 | WebHook |
|------|----------|---------|
| 商品 | 发布、编辑、上下架、查询、图片上传/转换、证书 | 商品接收通知、商品审核通知、商品上下架通知、商品额度变动通知 |
| 商品合规 | 环保标、GPSR、实拍图、代理公司、警告语 | 商品合规信息失效通知 |
| 客单管理 | 订单列表/详情、导出地址发货、在线下单、打印面单、确认无货、超限拆包、退货退款 | 订单同步通知、退货单同步通知 |
| 库存 | 仓库查询、库存查询、库存修改 | — |
| 财务 | 对账单列表/详情 | — |

### 3.2 商品发布-半托管

- **核心接口**：`/open-api/goods/product/publishOrEdit`
- **半托管特征**：提供成本价（`cost_info`），销售价由平台决定。
- **发布准备**：查询发布字段规范 → 获取品牌 → 获取类目树 → 获取属性 → 图片转换。
- **发布规范接口**：`/open-api/goods/query-publish-fill-in-standard`，返回默认语种、必填字段、图片配置。
- **图片要求**：通过 `picture_config_list` 判断新旧方案，新方案需 `is_spu_pic=true`。

### 3.3 商品编辑-半托管

- **编辑前提**：SPU 已通过审核 + 当前无进行中的审核流程。
- **可编辑**：标题、描述、品牌、包装重量、分类、属性、尺码、所有图片、货号。
- **不可编辑**：供货价（用 `update-cost`）、建议零售价、主/次销售属性、库存（用 `change-inventory`）、上架站点（用 `modify-skc-shelf`）。
- **编辑规则**：覆盖逻辑——不传字段按清空处理；必须传平台生成的唯一编码（`spu_name`、`skc_name`、`sku_code`、`image_group_code`）。
- **新增 SKC/SKU**：在已有 SPU 下按发布规则填写新 SKC/SKU。

### 3.4 商品图片方案（关键）

**新旧方案对比**：

| 图片名称 | 旧方案 | 新方案A | 新方案B | 图片类型枚举 | 规格要求 |
|----------|--------|---------|---------|-------------|----------|
| SPU轮播图 | ✗ | 选填1张 | 必填上限11张 | 1-主图(最多1张), 2-细节图(最多10张) | 1340×1785px 或 1:1(900-2200px) |
| SPU方形图 | ✗ | ✗ | 必填1张 | 5-方块图 | 1200×1200px |
| SKC主图 | 必填1张 | 必填1张 | 必填1张 | 1-主图 | 1340×1785px 或 1:1(900-2200px) |
| SKC细节图 | 必填上限10张 | 必填上限10张 | ✗ | 2-细节图 | 同上 |
| SKC方形图 | 必填1张 | 必填1张 | ✗ | 5-方块图 | 1:1(900-2200px) |
| SKC色块图 | 单SKC非必填/多SKC必填 | 同左 | 同左 | 6-色块图 | 80×80px |
| SKU图 | 选填1张 | 选填1张 | 选填1张 | 1-主图 | 1340×1785px 或 1:1(900-2200px) |

**判断方式**：
- 旧方案：`picture_config_list` 只有 `switch_spu_picture`，`is_spu_pic=false`。
- 新方案A：`spu_image_detail_show=true` + `spu_image_detail_single=true`（SPU轮播图单张）。
- 新方案B：`spu_image_detail_show=true` + `spu_image_detail_single=false`（SPU轮播图多张，主图+细节图）。

**图片上传**：
- 本地图片：`/open-api/goods/upload-pic`（multipart/form-data）
- 外链转换：`/open-api/goods/transform-pic`（限流 20次/秒）

**编辑场景**：必须传 `image_group_code`，可以不传 `image_item_id`。

### 3.5 ERP 订单履约方案

- **适用**：自运营 + 半托管。
- **履约方式**：商家自行发货（导出地址）、SHEIN合作物流发货（在线下单）、平台指定物流发货、SHEIN认证仓发货、SFS模式。
- **订单状态**：Pending(1) → ToBeShipped(2) → ToBePickedUp(7) → Shipped(4) → Delivered(5) / Refunded(6)。
- **异常处理**：通过 `printOrderStatus` 和 `unProcessReason` 字段判断。
- **WebHook**：订单同步通知、在线下单结果通知、CTE开票状态通知。

### 3.6 库存管理解决方案

- **库存类型**：商家虚拟库存(VI)、SHEIN仓实物库存(PI)、商家JIT虚拟库存(JI)。
- **查询接口**：`/open-api/stock/stock-query`（支持 SKU/SKC/SPU 维度查询）。
- **修改接口**：`/open-api/gsp/goods/change-inventory/v2`（新接口，支持幂等键，旧接口 2026-12-31 下线）。
- **限制**：SHEIN仓库存不可通过接口直接修改，只能通过采购/退供管理。

### 3.7 客单退货退款服务

- **接口**：退货列表、退货详情、退货签收。
- **状态流转**：AlreadyApplied(2) → WaitingTransit(8) → PendingHandover(7) → Delivered(6) → Received(5) → Completed(9)。
- **QPS限制**：每店 5/s。

### 3.8 商品合规管理

- **合规类型**：资质证书(ZSZZL)、代理公司(GSL)、警告语(HGXXL)、实拍图。
- **流程**：先查 SKC 合规缺失情况 → 按 complianceGroupCode 进入对应分支。
- **新证书接口**（2026年6月推出）：`goods-certificates/search`、`goods-certificate-schemas/detail`、`goods-certificate-files/upload`、`goods-certificates/save`、`goods-certificates/bind`。
- **WebHook**：商品合规信息失效通知。

### 3.9 商品SKU建议零售价

- **查询规则**：`/open-api/goods/query-recommend-retail-price-rule`
- **发布时传**：`skc_list[].sku_list[].site_rrp_info_list[]`
- **调价**：`/open-api/goods-recommend-retail-price/batch-save`（全量更新）
- **查询状态**：`/open-api/goods-recommend-retail-price/search`
- **WebHook**：审核状态更新、有效期变更。
- **有效期**：审核通过后 60 天，剩余 ≤10 天时提醒续期。

---

## 四、官方能力台账总览

### 4.1 接口统计

| 指标 | 数量 |
|------|------|
| 官方目录接口总数 | 239 |
| OpenAPI 接口 | 217 |
| WebHook 事件 | 22 |
| 只读接口 | 137 |
| 写接口 | 80 |

### 4.2 项目接入状态

| 项目状态 | 数量 | 说明 |
|----------|------|------|
| `integrated_read_parallel` | 13 | 已进入 19 店 OpenAPI 授权/探针/隔离双跑 |
| `controlled_write_adapter` | 13 | 已有受控写适配器 |
| `schema_ready_adapter_next` | 6 | 优先补 CLI/执行器适配 |
| `support_candidate` | 13 | 可作为资料检查/回读辅助 |
| `candidate_unimplemented` | 97 | 官方提供但项目未接 |
| `official_available_out_of_current_scope` | 75 | 当前 BI/运营主路径暂不覆盖 |
| `webhook_candidate` | 22 | 官方消息能力 |

### 4.3 优先补适配器的 6 个接口

| 接口 | 用途 | 优先级原因 |
|------|------|-----------|
| `/open-api/goods/upload-pic` | 本地图片上传 | 换图链路核心能力 |
| `/open-api/goods/transform-pic` | 外链转 SHEIN 图片 URL | 换图链路核心能力 |
| `/open-api/goods/query-document-state` | 商品审核状态回读 | 替代轮询，提升回读效率 |
| `/open-api/goods/query-shelf-quota` | 上架额度查询 | 发品前预检 |
| `/open-api/goods/searchProduct` | 商品综合查询 | 强回读候选 |
| `/open-api/goods/query-publish-fill-in-standard` | 发品字段规范 | 减少类目属性缺口 |

### 4.4 WebHook 22 个事件清单

| 事件 | 路径 | 业务价值 |
|------|------|----------|
| 商品审核通知 | `/product_document_audit_status_notice` | 替代轮询审核状态 |
| 商品接收通知 | `/product_document_receive_status_notice` | 确认平台已接收提交 |
| 商品上下架通知 | `/product_shelves_notice` | 上下架状态变更实时感知 |
| 商品价格异常通知 | `/product_prices_abnormal_notice` | 价格异常监控 |
| 商品涨价审批结果通知 | `/product_price_audit_status_notice` | 涨价审批跟踪 |
| 商品额度变动通知 | `/product_quota_change_notice` | 上架额度监控 |
| SKU库存预警通知 | `/inventory_warning_notice` | 库存预警 |
| 缺货需求库存数通知 | `/out_of_stock_notice` | 缺货补货提醒 |
| 商品合规信息失效通知 | `/product_compliance_change_notice` | 合规失效预警 |
| 订单同步通知 | `/order_push_notice` | 新订单实时推送 |
| 退货单同步通知 | `/return_order_push_notice` | 退货实时推送 |
| 发货单变更通知 | `/delivery_modify_notice` | 发货单变更 |
| 采购单通知 | `/purchase_order_notice` | 备货单推送 |
| 采购退货申请单状态通知 | `/purchase_order_return_application_notice` | 退货申请跟踪 |
| 采购退货单状态通知 | `/purchase_order_return_notice` | 退货单跟踪 |
| SHEIN合作物流单下单通知 | `/logistics_order_result_notice` | 在线下单结果 |
| 采购单合作物流通知 | `/logistics_forecast_result_notice` | 物流预估 |
| CTE开票通知 | `/invoice_status_notice` | 巴西发票 |
| 店铺授权关系变更通知 | `/authorization_change_notice` | 授权变更 |
| 商品发布公文审核通知(全渠道) | `/product_document_audit_status_notice_all_channels` | 全渠道审核 |
| 建议零售价审核状态更新 | `/product_rrp_review_status_changed` | RRP审核 |
| 建议零售价有效期变更 | `/product_rrp_validity_changed` | RRP有效期 |

---

## 五、WebHook 接入模型建议

### 5.1 架构建议

```
SHEIN 平台 → Webhook 回调 → 云端机器人/API 服务（第一层）
                                    ↓
                              事件落库 + 签名验证 + 幂等去重 + AES 解密
                                    ↓
                              事件分发器
                                    ↓
                    ┌───────────────┼───────────────┐
                    ↓               ↓               ↓
              BI 门户通知      飞书群聊通知      CLI/执行器触发
              （用户可见）     （后续接入）      （自动处理）
```

### 5.2 为什么先接云端机器人后接飞书

- **可靠性**：事件入口必须可靠、幂等、可回放，不能依赖聊天平台可用性。
- **安全性**：签名验证、AES 解密、幂等去重需要在服务端完成，不适合在聊天平台做。
- **审计**：所有事件需要落库审计，服务端是唯一可靠的事件存储 owner。
- **飞书角色**：飞书群聊只做后续通知/人工确认层，不做第一层事件入口。

### 5.3 接入前提

1. 在开发者后台录入正式环境回调地址（需平台审核）。
2. 保存应用 `app_id` 和 `app_secretKey`（用于验签，不是店铺密钥）。
3. 在门户订阅所需事件。
4. 实现验签（HMAC-SHA256，用 app_id + app_secretKey）+ 解密（AES/CBC/PKCS5Padding，IV=`space-station-default-iv`，密钥=app_secretKey）。
5. 收到回调后立即返回 2xx，异步处理业务逻辑。
6. 实现幂等：同一事件不重复处理。

---

## 六、现有 CLI/项目能力对照

### 6.1 已实现

| 能力 | CLI 命令/脚本 | 状态 |
|------|-------------|------|
| 只读探针（13接口） | `bi_ops_cli.mjs` + 云端并行层 | 19店 ready |
| 受控写适配器（13接口） | `link_ops_maintenance_openapi_executor.mjs` | dry-run + 真实写白名单 |
| 图片角色规划 | `link_ops_plan_image_roles.mjs` | 只读本地规划 |
| 官方能力台账 | `sync_shein_openapi_doc_catalog.mjs` | 239条接口已索引 |
| 自动化运营方案 | `docs/bi-ops-openapi-automation-plan.md` | V2 可试用 |

### 6.2 差距分析

| 缺口 | 优先级 | 说明 |
|------|--------|------|
| 图片上传/转换适配器 | P0 | 换图链路核心，`upload-pic` + `transform-pic` |
| 审核状态回读 | P1 | `query-document-state` 替代轮询 |
| 商品综合查询 | P1 | `searchProduct` 强回读 |
| 发品字段规范 | P1 | `query-publish-fill-in-standard` 减少缺口 |
| 上架额度查询 | P2 | `query-shelf-quota` 发品预检 |
| WebHook 接收服务 | P2 | 事件驱动替代轮询 |
| 订单履约链路 | P3 | 导出地址、上传运单、打印面单等 |
| 库存修改v2 | P3 | 新接口切换，旧接口 2026-12-31 下线 |
| 合规管理新接口 | P3 | 2026年6月新证书接口 |
| 建议零售价 | P3 | RRP 提交/查询/审核跟踪 |
| 超限拆包 | P4 | 巴西/非巴西拆包流程 |
| 采购单/退货 | P4 | 备货单履约 |

---

## 七、后续开发优先级建议

### 阶段一：补齐换图链路（P0）

- 实现 `upload-pic` multipart 适配器
- 实现 `transform-pic` 外链转换适配器
- 将图片角色规划与上传/转换链路打通
- 验证：dry-run 上传 + URL 转换 + `partialEdit` 图片字段映射

### 阶段二：补齐回读与预检（P1）

- 实现 `query-document-state` 审核状态回读
- 实现 `searchProduct` 商品综合查询（强回读）
- 实现 `query-publish-fill-in-standard` 发品字段规范查询
- 验证：发品后自动回读审核状态 + 发品前自动检查字段缺口

### 阶段三：WebHook 接入（P2）

- 在云端机器人/API 服务实现 WebHook 接收端点
- 实现验签 + AES 解密 + 幂等 + 事件落库
- 优先订阅：商品审核通知、订单同步通知、商品上下架通知
- 验证：签名验证正确 + 事件不丢失 + 异步处理不超时

### 阶段四：订单履约与库存（P3）

- 实现订单导出地址发货链路
- 实现上传运单号
- 切换库存修改到 v2 新接口
- 验证：端到端订单履约流程

### 阶段五：合规与建议零售价（P3-P4）

- 接入 2026年6月新证书接口
- 接入建议零售价提交/查询/审核跟踪
- 接入超限拆包流程
- 验证：合规缺失检测 + 证书创建/绑定 + RRP 提交

### 阶段六：采购单与全托管扩展（P4）

- 接入采购单查询/发货链路
- 接入采购单退货流程
- 评估全托管/POP 模式扩展需求

---

## 八、关键安全边界（不变）

- 密钥（`APP_SECRET`、`openKeyId`、`secretKey`、`tempToken`、`app_secretKey`）不进 GitHub、不进前端、不进日志明文。
- 写操作不静默提交；必须经过 dry-run、人工确认、审计和回读。
- WebHook 验签用应用维度 `app_id` + `app_secretKey`，不是店铺维度密钥。
- 不同店铺若属于不同应用主体，必须使用各自密钥。
- 库存修改 v2 需使用幂等键，防止超卖。
- 所有接口返回时间为北京时间（GMT+8）。
