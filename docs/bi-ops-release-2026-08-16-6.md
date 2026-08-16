# SHEIN BI Ops 2026.08.16.6

目标源码版本：`2026.08.16.6`
配套受控 CLI：`partner-cli-v2026.08.16.5`

## 范围

- 上一版本 `partner-cli-v2026.08.16.4` 因长测专用 720s 超时不足（同一 commit 在 GitHub CI 为 626s、另一 runner 超过 720s）未构建、未部署；该 failed tag 已标记 prerelease（assets 仍为空、tag 不改、保留审计、不重写），因此旧 workflow 的 `isPrerelease=false` 门禁会阻断对该 tag 的重放，`2026.08.16.4` 从未激活。
- 本补丁将 `scripts/run_deterministic_tests.mjs` 中 attribute flow 的专用超时提升至 `900_000`ms（不降覆盖、不跳过、不并行），`partner-cli-release.yml` job `timeout-minutes` 由 25 提升到 45，并在每个确定性测试启动前向 stderr 打印 `START <file> timeoutMs=<n>` 以增强超时可观测性；测试顺序与结果语义不变。
- 业务修复沿用上一版本（`prepare-publish --reuse-approved-binding`、OpenAPI 商品详情退化属性行过滤等），本补丁不改业务代码与业务语义。
- 版本边界：`config/partner_cli_package.json` 与 `lib/partner_knowledge_cache.mjs` 同步至 `2026.08.16.5`。

## 数据与迁移

- 无数据库迁移、无定时器变更。
- 发布本身不执行 SHEIN 商品写；业务任务仍需新鲜 preflight、确认范围内的 execute 与 live readback。

## 验收与回滚

- GitHub `main`、tag `2026.08.16.6` 与云端 `/opt/shein-bi/app` 必须指向同一 commit。
- 云端执行 `node scripts/check_release_source_state.mjs --expected-commit 2026.08.16.6 --record-deployment 2026.08.16.6` 并取得 `ok=true`。
- 配套 Partner CLI 工作流必须回读 managed version `2026.08.16.5` 与相同源码 commit。
- 回滚点为源码 `2026.08.16.5`、Partner CLI `partner-cli-v2026.08.16.3`（`partner-cli-v2026.08.16.4` 从未激活）；回滚源码不会撤销已由 SHEIN 接收的商品提交。
