# SHEIN OpenAPI 适配器开发交接文档

> 状态：2026-07-03 首轮 M1-M6 已落地。本文件保留当时的接口拆分、当前实现位置和后续扩展规范；不是未完成任务清单。

## 1. 项目代码结构

```
scripts/bi_ops_cli.mjs                               # CLI 入口
scripts/openapi_image_asset_executor.mjs             # upload-pic / transform-pic
scripts/openapi_readonly_executor.mjs                # audit-status / search-product / publish-standard / shelf-quota
scripts/openapi_order_fulfillment_executor.mjs       # order-fulfillment 高风险入口
scripts/openapi_catalog_executor.mjs                 # 目录驱动 JSON OpenAPI 兜底
scripts/link_ops_maintenance_openapi_executor.mjs    # 自动运营页维护动作受控写执行器
lib/shein_openapi_client.mjs                         # OpenAPI 签名、JSON 请求、multipart 请求、解密
lib/openapi_adapters/*.mjs                           # 单接口 adapter
lib/link_ops_image_role_planner.mjs                  # 本地图片角色规划器
lib/shein_store_identity.mjs                         # 店铺身份校验
config/shein_openapi.local.json                      # 密钥配置（不进仓库）
config/store_account_truth.json                      # 店铺身份真值表
outputs/shein-openapi-doc-catalog/api-details/*.json # 半托管接口离线 schema
```

## 2. 已完成里程碑

| 里程碑 | 状态 | 主要文件 | 验证 |
|--------|------|----------|------|
| M1 图片上传/转换 | 已完成 | `upload_pic.mjs`, `transform_pic.mjs`, `openapi_image_asset_executor.mjs` | `test_openapi_image_asset_executor.mjs` |
| M2 审核状态/商品查询/发品规范 | 已完成 | `query_document_state.mjs`, `search_product.mjs`, `query_publish_fill_in_standard.mjs`, `openapi_readonly_executor.mjs` | `test_openapi_readonly_executor.mjs` |
| M3 上架额度 + WebHook 设计 | 已完成 | `query_shelf_quota.mjs`, `docs/shein-webhook-receiver-design.md` | `test_openapi_readonly_executor.mjs` + 文档审查 |
| M4 订单履约高风险入口 | 已完成 | `order_fulfillment.mjs`, `openapi_order_fulfillment_executor.mjs` | `test_openapi_order_fulfillment_executor.mjs` |
| M5 目录驱动 JSON 兜底 | 已完成 | `openapi_catalog_executor.mjs` | `test_openapi_catalog_executor.mjs` |
| M6 CLI/门禁/文档整合 | 已完成 | `bi_ops_cli.mjs`, `test_bi_ops_release_gate.mjs`, `docs/*` | `test_bi_ops_release_gate.mjs` |
| M7 partialEdit 修复与正确用法 | 已完成 | `link_ops_maintenance_openapi_executor.mjs`, `docs/shein-openapi-partialEdit-correct-usage.md` | 语法检查 + HL 标题/图片提交成功 |

## 3. 当前 CLI 命令

```bash
node scripts/bi_ops_cli.mjs plan-images --image-dir <图片文件夹> --out roles.json
node scripts/bi_ops_cli.mjs upload-pic --store FY --image-type 2 --file <image.jpg> --mode execute   # 走云端 BI
node scripts/bi_ops_cli.mjs transform-pic --store FY --image-type 2 --url <https://...> --mode execute # 走云端 BI
node scripts/bi_ops_cli.mjs audit-status --store FY --spu <SPU>       # 本机 CLI 不做真实 execute
node scripts/bi_ops_cli.mjs search-product --store FY --product <货号> # 本机 CLI 不做真实 execute
node scripts/bi_ops_cli.mjs publish-standard --store FY --category <末级分类ID> # 本机 CLI 不做真实 execute
node scripts/bi_ops_cli.mjs shelf-quota --store FY                    # 本机 CLI 不做真实 execute
node scripts/bi_ops_cli.mjs order-fulfillment --operation export-address --store FY --order-no <订单号>
node scripts/bi_ops_cli.mjs openapi-call --doc-id <docId> --store FY --body-json '{}'
node scripts/bi_ops_cli.mjs openapi-call --doc-id <GET docId> --store FY --query-json '{"id":"..."}'
node scripts/bi_ops_cli.mjs openapi-catalog-plan --format summary [--out plan.json]
```

默认 `dry-run`。本机边界：

- **本地不能直连真实 SHEIN OpenAPI**：日常 `bi_ops_cli` 不再从本机调用 `openapi_*_executor` 的真实 `execute`。
- 图片上传/转换：`bi_ops_cli --mode execute` 只委托云端 BI `/api/openapi-image-asset/*`，由 `shein-bi-tencent` 使用云端白名单和密钥执行。
- 只读回读/目录兜底/订单履约：需要真实 `execute` 时，到 `shein-bi-tencent` 云端执行器或云端任务审计链路跑；本机只保留 `dry-run`/payload/假接口 smoke。
- 写接口：必须有确认文本和 dry-run `payloadHash`。
- 订单履约使用独立确认文本 `SHEIN_ORDER_FULFILLMENT_SUBMIT`。
- 目录驱动写接口使用 `SHEIN_OPENAPI_GENERIC_WRITE_SUBMIT`。
- 自动运营页受控写仍使用 `SHEIN_OPENAPI_SUBMIT` 和任务审计链路。
- `openapi-catalog-plan` 只读本地官方目录和 schema，不联网、不需要店铺密钥，用于把所有官方接口归入：已专用/并行、JSON GET、JSON POST/写、文件专用、WebHook 设计态、当前范围外。

## 4. 适配器模式

每个专用 adapter 放在 `lib/openapi_adapters/<name>.mjs`，通常包含：

- `buildPayload(params)`：参数校验、字段归一化、构建官方请求体。
- `execute(client, params, {mode})`：`dry-run` 只返回 payload/hash/摘要；`execute` 才调用 OpenAPI。
- 响应解析：只输出业务需要字段，错误时保留 SHEIN `code/msg`，不打印密钥或完整二进制内容。

JSON 接口使用 `SheinOpenApiClient.request()`；multipart/file 接口使用 `requestMultipart()`，不要手工拼 `Content-Type` 覆盖 boundary。

## 4.1 partialEdit 关键陷阱

详见 docs/shein-openapi-partialEdit-correct-usage.md。摘要：

- **返回值判定**：code=0 不代表成功，必须检查 info.success。执行器已修复 compactCallResult 保留 infoSuccess/infoVersion/preValidResult。
- **全量校验**：partialEdit 虽是部分编辑，但平台补齐未入参字段后做全量校验。缺必填属性会失败。
- **标题覆盖**：平台全量校验用 SKC skc_title（默认语种 ar），不是 SPU multi_language_name_list。需在 skc_list 传 skc_title。
- **必填属性**：如 Power Supply=Wall Plug 导致 Input voltage/current 必填，需在 product_attribute_list 同时传入。新上执行器会在官方属性模板确认后，从 `Plug(Voltage)` / `Voltage` 中推导 `Input voltage`（例如 `UK Plug(220-240V)` → `220-240` + `Vac 50–60Hz`）；无法推导时必须 dry-run 阻断，不允许静默猜。
- **合并提交**：同一个维护任务同时包含 update_title + update_images 时，必须合并为一个 partialEdit payload（operation=`update_title_and_images`），避免先改标题进入审核后图片无法再提交，或图片/标题被拆成两张审核单。
- **图片排序**：image_sort 必须全局唯一，不能按 image_type 分组排序。
- **图片组编码**：编辑场景必须传 image_group_code（从 spu-info 获取）。
- **审核流程**：提交后进入审核队列，query-document-state 查状态，审核中不能再次提交。

本地开发只能做 payload 构造、语法检查、假 OpenAPI smoke 测试；真实上传图片、partialEdit、publishOrEdit、审核状态回读必须在 `shein-bi-tencent` 云端执行器里跑。本地因白名单/身份边界不能直连 SHEIN OpenAPI，不要把本地直连失败当作业务证据。

## 4.2 图片角色规划规则

lib/link_ops_image_role_planner.mjs 实现的排序规则：

- 细节图顺序：**卖点 → 参数 → 场景**（场景 ≥3 张时最后一张留做收尾）。
- 主封面 = 细节图第 1 张（主图）。
- 单独轮播图 = 主封面之外最适合做第二封面的图。
- 方形图 = 1:1 或文件名含"方形/1:1"的图。
- SKU 图 = 容量外（>10 张细节候选）最低优先级高清图。
- 文件名含"产品封面/AB测试"的图忽略不提交。
- 备用目录的图不使用。

## 5. 安全边界

- 密钥不进仓库、不进前端、不进日志。
- 默认 dry-run 不联网；execute 必须显式要求。
- 所有 execute 前必须校验店铺身份，不能只相信 CLI `--store`。
- 写操作必须 dry-run → 人工确认 → payload hash 锁定 → execute → 审计/回读。
- `openapi-call` 只是 JSON 兜底，不替代高频/高风险接口专用适配器；GET 接口必须用 `--query-json/--query-file`，POST 接口用 `--body-json/--body-file`。
- `openapi-call` 会读取离线详情 schema 检测 `blob/file/multipart`，文件接口会被阻断并要求专用 adapter。
- WebHook 当前仅设计未启用，本轮没有开发 receiver；真实开发必须先做验签、解密、幂等和落库。

## 6. 官方 schema 证据

- 结构化目录：`outputs/shein-openapi-doc-catalog/official-capabilities.latest.json`
- 详情 schema：`outputs/shein-openapi-doc-catalog/api-details/<docId>.json`
- API 索引：`docs/shein-openapi-api-schema-index.md`
- 能力台账：`docs/shein-openapi-official-capability-inventory.md`

新增或更新官方接口时，先刷新目录和 schema，再改 adapter：

```bash
node scripts/sync_shein_openapi_doc_catalog.mjs --write-default-markdown --pretty
node scripts/generate_api_schema_index.mjs
```

## 7. 后续开发路线

- 高频换图/上新/回读继续走专用 adapter，并接入 `test_bi_ops_release_gate.mjs`。
- 合规、RRP、采购单等低频 JSON 接口可先用 `openapi-call` 验证，再沉淀专用 adapter；执行前先用 `openapi-catalog-plan` 看该 docId 所属 lane。
- 文件上传、批量导入、WebHook 不走 `openapi-call`；必须单独实现并测试边界。当前本地 catalog 口径：239 个官方条目中，15 个低频 GET JSON、90 个低频 POST/写 JSON 可由目录兜底预检，5 个文件接口要求专用 adapter，22 个 WebHook 保持设计态，75 个当前范围外。
- 对任何真实写新增能力，先补 fake OpenAPI 测试，再考虑真实 execute。

## 8. 发版检查

```bash
node --check lib/shein_openapi_client.mjs
node --check scripts/bi_ops_cli.mjs
node scripts/test_openapi_image_asset_executor.mjs
node scripts/test_openapi_readonly_executor.mjs
node scripts/test_openapi_order_fulfillment_executor.mjs
node scripts/test_openapi_catalog_executor.mjs
node scripts/test_bi_ops_release_gate.mjs
```
