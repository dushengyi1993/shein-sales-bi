# 迁移与复用说明

本文说明 GitHub 仓库包含什么、不包含什么，以及后续换电脑、云端迁移或让别人复用时，哪些文件需要单独处理。

## 结论

- GitHub 仓库用于保存代码、配置模板、数据结构、运维文档和可重复执行的脚本。
- 浏览器登录态、真实账号密码、session、运行日志、抓取输出、数据库文件和本地备份不上传 GitHub。
- 这些不上传的文件不是“漏掉”，而是因为它们要么含敏感登录信息，要么体积很大，要么是运行时可再生成数据。
- 如果要完整迁移当前正在运行的系统，需要在 GitHub 仓库之外，再做一份“运行数据与密钥迁移包”或数据库备份。

## GitHub 仓库里应该有

- `README.md`：项目当前状态、入口、核心口径和目录说明。
- `MEMORY.md`：项目长期规则和避坑边界。
- `config/*.example.json`：可公开的配置模板。
- `config/stores.json`、`config/product_catalog.json`、`config/product_aliases.json`：店铺、汇率、货号和归并规则。
- `docs/`：架构、运维、数据模型、迁移说明。
- `infra/`：Metabase / PostgreSQL / 数据仓库结构和部署配置模板。
- `lib/`：通用业务逻辑。
- `schemas/`：飞书 Base 等结构参考。
- `scripts/`：抓取、同步、BI 入仓、门户生成、定时任务、运维脚本。
- `skills/shein-sales-ops/`：项目专用业务规则 skill。
- 根目录 `.cmd`：给人直接双击使用的入口。

## GitHub 仓库里故意不放

| 路径 | 为什么不传 | 迁移时怎么处理 |
| --- | --- | --- |
| `profiles/` | Chrome 店铺登录态，包含 cookies、session 和大量可重建缓存 | 当前仍用浏览器抓取时，换电脑要用安全方式单独复制；API 替换完成后不应依赖它 |
| `outputs/` | 抓取结果、BI 静态数据、报表图片等运行输出，体积会持续增长 | 可重新跑流水线生成；若要保留历史快照，单独归档 |
| `logs/` | 计划任务日志、审计日志，可能含业务运行细节 | 排障或审计需要时单独备份 |
| `state/` | 本地运行状态、动作处理状态、同步 flag | 迁移当前局域网协作状态时，单独复制 `state/bi_action_state.json`；正式团队版建议入 PostgreSQL |
| `backups/` | 本地历史备份和归档，体积大 | 只在需要回查旧资料时单独保存 |
| `tmp/` | 临时文件 | 不迁移 |
| `.codex/` | Codex 执行记录，不是项目运行依赖 | 不迁移；仅当前开发上下文需要 |
| `config/*.local.json` | 本地账号、局域网登录配置、机器私有配置 | 按模板在新环境重建，或通过加密渠道单独迁移 |
| `config/lark_report.json` | 飞书真实接收人配置 | 用 `config/lark_report.example.json` 复制后在新环境填写真实值 |
| `infra/metabase/.env` | Metabase / PostgreSQL 本地环境变量 | 用 `.env.example` 复制后填写真实值 |
| `infra/metabase/.admin.local.json` | Metabase 管理员账号密码 | 在新环境重建管理员，或通过密码管理器单独迁移 |
| `infra/metabase/.session.local.json` | Metabase 会话 token | 不迁移；新环境重新登录生成 |
| `infra/metabase/data/`、`infra/metabase/plugins/` | Docker 运行数据和插件目录 | 生产迁移时用数据库 dump / volume 备份，不进 Git |

## 换电脑或云端迁移的最小流程

### 1. 先从 GitHub 拿代码

```powershell
git clone https://github.com/dushengyi1993/shein-sales-bi.git
```

### 2. 重建本地配置

- 从 `config/settings.example.json` 复制出本地真实配置。
- 从 `config/lark_report.example.json` 复制出 `config/lark_report.json`，填写真实飞书接收人。
- 从 `infra/metabase/.env.example` 复制出 `infra/metabase/.env`，填写数据库和 Metabase 密码。
- Metabase 管理员凭据不要写进 GitHub，继续只放本地或密码管理器。

### 3. 迁移数据

如果只是复用系统结构，可以不迁移历史输出，重新跑同步即可。

如果要把当前生产状态完整搬走，需要另外备份：

- PostgreSQL / Metabase 数据：优先使用数据库 dump 或 Docker volume 备份。
- 当前 BI 动作处理状态：`state/bi_action_state.json`。
- 必要的审计日志：`logs/bi_portal_action_audit.jsonl`。
- 仍未 API 化前的浏览器登录态：`profiles/persistent-*-profile`。

### 4. 启动和验证

- 先验证本地配置文件存在且格式正确。
- 再跑 BI 数据入仓和门户生成脚本。
- 最后验证：
  - 本机 BI 门户可访问。
  - 若是局域网试用，局域网地址可访问。
  - 定时任务不会和旧机器同时重复跑。
  - 飞书日报和异常通知只发一次。

## 迁移到云端时的建议

云端正式版不建议迁移浏览器 profile 作为长期方案。

更稳的目标是：

- SHEIN 数据抓取改为官方 API。
- API 密钥放在云服务器环境变量或密钥管理服务中。
- 数据库存 PostgreSQL。
- BI 动作状态从 `state/bi_action_state.json` 改为 PostgreSQL 表。
- 通过 HTTPS、账号权限、备份和监控来承载团队使用。

在 API 完全替换前，如果必须把浏览器抓取搬到云端，需要单独评估验证码、人机校验、登录态失效和服务器图形环境问题。

## 当前版本迁移边界

当前 GitHub Release 代表“本地 + 局域网协作可用基线”，适合：

- 保存当前代码版本。
- 后续开发官方 API 试点。
- 后续云迁移前做对照和回滚。

它不代表：

- 已经包含所有历史运行数据。
- 已经包含浏览器登录态。
- 已经可以不配置密钥直接在新机器运行。
- 已经完成云端生产化部署。
