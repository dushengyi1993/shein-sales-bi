# SHEIN OpenAPI 开发交接索引

> 状态：2026-07-03 首轮 OpenAPI/CLI 能力已落地。本文用于让后续开发者快速找到入口、理解安全边界和继续扩展；不要再把 M1-M6 当作未开始任务。

---

## 1. 项目根目录与技术栈

```powershell
cd "E:\Codex WorkSpace\Shein销售统计"
```

- Node.js ES Modules（`.mjs`），无 TypeScript 构建步骤。
- 发版前总门禁：`node scripts/test_bi_ops_release_gate.mjs`。
- OpenAPI 密钥在 `config/shein_openapi.local.json`，不进 GitHub；店铺身份真值在 `config/store_account_truth.json`。

---

## 2. 当前能力地图

### 2.1 底层与共享模型

| 文件 | 责任 |
|------|------|
| `lib/shein_openapi_client.mjs` | OpenAPI 签名、JSON 请求、multipart/form-data 请求、AES 解密 |
| `lib/openapi_adapters/*.mjs` | 单接口 payload 校验、dry-run/execute 响应解析 |
| `scripts/bi_ops_cli.mjs` | 本机运营 CLI 入口 |
| `scripts/link_ops_maintenance_openapi_executor.mjs` | 自动运营页维护动作受控写链路 |
| `scripts/link_ops_hl_openapi_executor.mjs` | 复制上品受控写链路 |
| `scripts/test_bi_ops_release_gate.mjs` | 发版前总门禁 |

### 2.2 已落地 CLI 命令

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
node scripts/bi_ops_cli.mjs openapi-call --doc-id <GET docId> --store FY --query-json '{"id":"..."}'
node scripts/bi_ops_cli.mjs openapi-catalog-plan --format summary [--out plan.json]
```

默认均为 `dry-run`。真实 `execute` 的边界：

- 图片上传/外链转换/只读回读：execute 前校验店铺身份。
- 订单履约：必须 `--confirm SHEIN_ORDER_FULFILLMENT_SUBMIT` + dry-run `payloadHash` + 店铺身份探针。
- 目录驱动 `openapi-call`：只支持官方 JSON OpenAPI；GET 用 `--query-json/--query-file`，POST 用 `--body-json/--body-file`；写接口必须 `--confirm SHEIN_OPENAPI_GENERIC_WRITE_SUBMIT` + dry-run `payloadHash`；multipart/file/WebHook 被阻断。
- `openapi-catalog-plan`：只读本地官方目录和详情 schema，输出所有接口的归位矩阵，不联网、不需要店铺密钥、不启用 WebHook receiver。
- 自动运营页已有写链路仍使用 `SHEIN_OPENAPI_SUBMIT`、真实写白名单、任务 `waiting_review`、审计和回读，不被 CLI 兜底命令绕过。

### 2.3 已落地适配器与测试

| 能力 | 适配器/执行器 | 测试 |
|------|---------------|------|
| 本地图片上传 `upload-pic` | `lib/openapi_adapters/upload_pic.mjs`, `scripts/openapi_image_asset_executor.mjs` | `scripts/test_openapi_image_asset_executor.mjs` |
| 外链图片转换 `transform-pic` | `lib/openapi_adapters/transform_pic.mjs`, `scripts/openapi_image_asset_executor.mjs` | `scripts/test_openapi_image_asset_executor.mjs` |
| 图包角色规划 | `lib/link_ops_image_role_planner.mjs` | `scripts/test_link_ops_image_role_planner.mjs` |
| 审核状态/商品查询/发品规范/上架额度 | `lib/openapi_adapters/query_*.mjs`, `search_product.mjs`, `scripts/openapi_readonly_executor.mjs` | `scripts/test_openapi_readonly_executor.mjs` |
| 订单履约 | `lib/openapi_adapters/order_fulfillment.mjs`, `scripts/openapi_order_fulfillment_executor.mjs` | `scripts/test_openapi_order_fulfillment_executor.mjs` |
| 目录驱动 JSON 兜底 + 全量 catalog 归位矩阵 | `scripts/openapi_catalog_executor.mjs` | `scripts/test_openapi_catalog_executor.mjs` |

---

## 3. 官方文档与台账

| 文件 | 用途 |
|------|------|
| `docs/shein-openapi-doc-center-research-and-plan.md` | 文档中心研究、开发优先级和半托管能力范围 |
| `docs/shein-openapi-official-capability-inventory.md` | 官方能力台账与当前落地状态 |
| `docs/shein-openapi-api-schema-index.md` | API schema 索引，含重点接口字段和示例 |
| `docs/openapi-adapter-development-handoff.md` | 首轮 M1-M6 落地复盘和后续开发规范 |
| `docs/shein-webhook-receiver-design.md` | WebHook receiver 设计；当前未启用真实回调 |
| `outputs/shein-openapi-doc-catalog/official-capabilities.latest.json` | 结构化官方能力目录，供 `openapi-call` dry-run/execute 读取 |
| `outputs/shein-openapi-doc-catalog/api-details/*.json` | 离线 schema 证据 |

刷新官方能力台账：

```bash
node scripts/sync_shein_openapi_doc_catalog.mjs --write-default-markdown --pretty
node scripts/generate_api_schema_index.mjs
```

---

## 4. 图片换图边界

- `plan-images` 只扫描本地图包并输出角色建议，不上传、不生成完整 `partialEdit`、不提交 SHEIN。
- 任一路径包含 `备用` / `backup` / `bak` 的图片不使用；文件名含 `产品封面` / `AB测试` 的图默认忽略。
- 前端口径：`细节图11` 的第 1 张才是主图；单独 `轮播图` 是第二封面；方形图用 1:1；其他细节按场景 → 卖点 → 参数排序；只有容量外还有第 11 张其他高清图时才放 SKU 图。
- 真正换图仍要先将图片变成 SHEIN URL，再按官方图片方案映射到 SPU/SKC/SKU 的 `partialEdit` 字段；不同类目图片方案不能硬编码为同一套字段。
- `partialEdit` 返回版本号，或后台任务进入流转 / 待审核 / 审核中 / 待终审，即表示平台已接收提交，不应重复提交。

---

## 5. 后续扩展建议

优先级从“专用适配器”到“目录驱动兜底”：

1. 高频、高风险、需要业务回读的接口，继续新增 `lib/openapi_adapters/<name>.mjs` + 专用 executor + fake OpenAPI 测试。
2. 低频 JSON 接口可先用 `openapi-catalog-plan` 判断 lane，再用 `openapi-call` dry-run 验证 schema；确认稳定后再沉淀专用适配器。
3. 文件上传、批量导入和含 `blob/file/multipart` 的接口不得走 `openapi-call`；当前 catalog 计划会把它们标为 `dedicated_file_adapter_required`。
4. WebHook 不要直接接飞书群：先做云端 receiver，完成验签、解密、幂等、落库和快速 2xx，再由云端机器人转发飞书通知。本轮未开发、未启用 receiver。
4. 订单履约、采购单、RRP、合规证书等真实写动作，必须保留 dry-run hash、确认文本、店铺身份探针和人工审计。

---

## 6. 发版前检查

```bash
node --check lib/shein_openapi_client.mjs
node --check scripts/bi_ops_cli.mjs
node scripts/test_link_ops_image_role_planner.mjs
node scripts/test_openapi_image_asset_executor.mjs
node scripts/test_openapi_readonly_executor.mjs
node scripts/test_openapi_order_fulfillment_executor.mjs
node scripts/test_openapi_catalog_executor.mjs
node scripts/test_bi_ops_release_gate.mjs
```

不要把 `config/*.local.json`、`profiles/`、`state/`、`logs/`、`outputs/cleanup/` 或真实 Cookie / token / 密钥提交进仓库。
