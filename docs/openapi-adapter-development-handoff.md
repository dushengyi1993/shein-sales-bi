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

## 3. 当前 CLI 命令

```bash
node scripts/bi_ops_cli.mjs plan-images --image-dir <图片文件夹> --out roles.json
node scripts/bi_ops_cli.mjs upload-pic --store FY --image-type 2 --file <image.jpg> [--mode execute]
node scripts/bi_ops_cli.mjs transform-pic --store FY --image-type 2 --url <https://...> [--mode execute]
node scripts/bi_ops_cli.mjs audit-status --store FY --spu <SPU> [--mode execute]
node scripts/bi_ops_cli.mjs search-product --store FY [--spu <SPU>|--product <货号>] [--mode execute]
node scripts/bi_ops_cli.mjs publish-standard --store FY --category <末级分类ID> [--mode execute]
node scripts/bi_ops_cli.mjs shelf-quota --store FY [--mode execute]
node scripts/bi_ops_cli.mjs order-fulfillment --operation export-address --store FY --order-no <订单号>
node scripts/bi_ops_cli.mjs openapi-call --doc-id <docId> --store FY --body-json '{}'
```

默认 `dry-run`。`execute` 规则：

- 只读/图片接口：先做店铺身份探针。
- 写接口：必须有确认文本和 dry-run `payloadHash`。
- 订单履约使用独立确认文本 `SHEIN_ORDER_FULFILLMENT_SUBMIT`。
- 目录驱动写接口使用 `SHEIN_OPENAPI_GENERIC_WRITE_SUBMIT`。
- 自动运营页受控写仍使用 `SHEIN_OPENAPI_SUBMIT` 和任务审计链路。

## 4. 适配器模式

每个专用 adapter 放在 `lib/openapi_adapters/<name>.mjs`，通常包含：

- `buildPayload(params)`：参数校验、字段归一化、构建官方请求体。
- `execute(client, params, {mode})`：`dry-run` 只返回 payload/hash/摘要；`execute` 才调用 OpenAPI。
- 响应解析：只输出业务需要字段，错误时保留 SHEIN `code/msg`，不打印密钥或完整二进制内容。

JSON 接口使用 `SheinOpenApiClient.request()`；multipart/file 接口使用 `requestMultipart()`，不要手工拼 `Content-Type` 覆盖 boundary。

## 5. 安全边界

- 密钥不进仓库、不进前端、不进日志。
- 默认 dry-run 不联网；execute 必须显式要求。
- 所有 execute 前必须校验店铺身份，不能只相信 CLI `--store`。
- 写操作必须 dry-run → 人工确认 → payload hash 锁定 → execute → 审计/回读。
- `openapi-call` 只是 JSON 兜底，不替代高频/高风险接口专用适配器。
- WebHook 当前仅设计未启用；真实开发必须先做验签、解密、幂等和落库。

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
- 合规、RRP、采购单等低频 JSON 接口可先用 `openapi-call` 验证，再沉淀专用 adapter。
- 文件上传、批量导入、WebHook 不走 `openapi-call`；必须单独实现并测试边界。
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
