# 源码、发布与云端版本治理

更新时间：2026-07-30

## 1. 结论

不要求本机、GitHub、云端的所有文件在每一秒完全相同，但必须区分三类状态：

1. **源码版本**：本机 Git commit、GitHub `main`、Git tag / release、云端 `/opt/shein-bi/app` 的 tracked source。
2. **部署状态**：数据库 schema、systemd unit、Portal shell、服务进程当前实际运行的版本。
3. **运行数据**：PostgreSQL、Portal section cache、日志、浏览器 profile、session、备份和自动化运行状态。

稳定发布完成时，源码版本必须收敛到同一个目标 commit；部署状态必须有该 commit 的真实验收。运行数据天然不同步，也不应提交到 Git。

## 2. 允许和不允许的差异

| 场景 | 是否允许 | 边界 |
|---|---|---|
| 本机正在开发，工作树有未提交改动 | 允许 | 不得冒充正式版本；发版前必须分类、测试、提交或明确丢弃 |
| GitHub 已推送，云端正在等待部署/验收 | 短时允许 | 发布记录必须写“未部署”；完成后云端必须追到目标 commit |
| 云端运行数据比 GitHub 新 | 正常 | 运行数据在 `/srv`、`/data`、数据库和忽略目录，不反向污染源码 |
| 云端 tracked source 长期手改、Git HEAD 落后 | 不允许 | 属于第二套源码分支，会造成覆盖、漏发和无法回滚 |
| GitHub release 已发布但云端未部署 | 可以存在 | 不能称为“生产版本”，必须明确源码发布与生产部署边界 |
| 云端紧急热修 | 只允许短时 | 同一事故内回填 GitHub、发版、按 commit 重部署并清掉源码脏改 |

## 3. 统一发布流程

### 3.1 本机收口

1. 盘点 `git status --short`，区分源码、文档、生成物和他人改动。
2. 删除或忽略可重建生成物；不得用 `git add -A` 混入运行数据。
3. 更新架构、runbook、业务规则、发布说明和索引。
4. 运行 `npm test`、`git diff --check` 及改动对应的专项测试；`npm test` 必须从源码生成测试壳层，不能依赖工作区残留的 Portal 成品。
5. 只提交已验证范围，推送 `main`，等待目标 SHA 的 CI 成功。

### 3.2 GitHub 发布

1. tag 必须直接指向已经通过 CI 的目标 commit。
2. release note 写明：范围、测试、数据/迁移影响、云端部署状态、回滚点和已知限制。
3. 发布时若云端尚未部署，明确标记“源码已发布，生产待部署”。

### 3.3 云端部署

1. 先备份 tracked diff、关键运行态和当前 Portal 输出。
2. 确认热修均已回填 GitHub；运行态文件已经迁出 tracked source。
3. 以 `sheinops` fetch，并让 `/opt/shein-bi/app` 精确落到 release commit；禁止长期靠逐文件 `scp` 维持生产。
4. 应用 schema、systemd unit、服务重启和 section 预热。
5. 验收：
   - `git rev-parse HEAD` 等于 release target SHA；
   - `node scripts/check_release_source_state.mjs --expected-commit <release SHA>` 通过；
   - 不得用 `skip-worktree` / `assume-unchanged` 隐藏缺失或被改写的 tracked 文件；
   - CI 成功；
   - Portal health、关键 service/timer、数据库和业务读回通过。

## 4. 运行态与源码隔离

- `outputs/bi-portal/index.html`、`data.json`、`sections/` 是生成物，不进入 Git。
- 生产人工特殊折扣登记使用 `/srv/shein-bi/runtime/marketing_manual_limited_discount_overrides.json`；仓库 `config/marketing_manual_limited_discount_overrides.json` 只作为本地/首次迁移种子。
- profiles、sessions、logs、state、数据库 dump 和备份不进入 Git。
- 数据库备份同时保存人工特殊折扣登记，并按现有保留策略归档到 COS。

## 5. 发布验收命令

```bash
# 本机
git status --short --branch
git diff --check
npm test
node scripts/check_release_source_state.mjs --expected-commit HEAD
gh run list --repo dushengyi1993/shein-sales-bi --limit 5

# 云端
cd /opt/shein-bi/app
node scripts/check_release_source_state.mjs --expected-commit 2026.07.30.2
systemctl is-active shein-bi-portal.service shein-bi-webhook.service
curl -fsS http://127.0.0.1:8787/api/health
```

版本一致只解决“运行的是什么代码”，不能代替业务验收。销售、利润、营销和 Webhook 结论仍需回读云端 PostgreSQL、OpenAPI、日志和正式 Portal。
