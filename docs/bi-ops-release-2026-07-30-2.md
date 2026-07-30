# SHEIN BI / Ops 2026.07.30.2 发布说明

发布日期：2026-07-30

标签：`2026.07.30.2`

上一正式版本：`2026.07.30.1`

## 本版范围

- 延续 `2026.07.30.1` 的利润、售后、营销自动化、磁盘迁移和运行态/源码隔离改动。
- 新增源码发布状态门禁：除目标 commit 与普通 Git 工作树外，同时检查 `skip-worktree`、`assume-unchanged` 和缺失的 tracked 文件。
- 修复云端历史遗留的 246 个 `skip-worktree` 标记；正式 checkout 不再以“Git 状态看似干净、实际文件缺失”的方式节省空间。
- Portal 构建成品继续由部署和测试从源码生成，不重新纳入 Git。

## 验证

- 本机与 GitHub CI：完整 `npm test`。
- 全新 Portal 成品缺失场景：测试前自动生成壳层。
- 云端：`check_release_source_state`、完整 `npm test`、Portal health、核心 section warmup、Webhook、营销 timer、PostgreSQL schema 与利润 cache。

## 部署与回滚

- 生产必须精确部署到本 tag commit，并由 `check_release_source_state` 给出 `ok=true`。
- 运行态继续保留在 PostgreSQL、`/srv`、`/data` 和被忽略的 Portal 输出中。
- 源码回滚点：`2026.07.30.1`；业务回滚仍需保留当前数据库和运行态备份。
