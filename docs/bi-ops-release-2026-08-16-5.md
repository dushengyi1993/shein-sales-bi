# SHEIN BI Ops 2026.08.16.5

目标源码版本：`2026.08.16.5`
配套受控 CLI：`partner-cli-v2026.08.16.4`

## 范围

- `prepare-publish` 新增 `--reuse-approved-binding`：同一 `copy_product_draft` 任务仅修正结构化发布字段时，复用服务端既有已审图片，零本地扫描、零图片上传，并重新 dry-run 锁定新 payload hash。
- OpenAPI 商品详情映射丢弃 `attribute_id/attributeId <= 0`、缺失或非数字的退化属性行，避免 `sale_attribute_list=[{attribute_id:0}]` 进入 `publishOrEdit`。
- CLI 互斥门禁、零上传请求、服务端 dry-run、camelCase/snake_case 退化属性和合法属性保留均有确定性回归测试。

## 数据与迁移

- 无数据库迁移、无定时器变更。
- 发布本身不执行 SHEIN 商品写；业务任务仍需新鲜 preflight、确认范围内的 execute 与 live readback。

## 验收与回滚

- GitHub `main`、tag `2026.08.16.5` 与云端 `/opt/shein-bi/app` 必须指向同一 commit。
- 云端执行 `node scripts/check_release_source_state.mjs --expected-commit 2026.08.16.5 --record-deployment 2026.08.16.5` 并取得 `ok=true`。
- 配套 Partner CLI 工作流必须回读 managed version `2026.08.16.4` 与相同源码 commit。
- 回滚点为源码 `2026.08.16.4`、Partner CLI `partner-cli-v2026.08.16.3`；回滚源码不会撤销已由 SHEIN 接收的商品提交。
