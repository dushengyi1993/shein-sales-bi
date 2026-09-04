# 源码、发布与云端版本治理

更新时间：2026-08-17

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
5. Partner CLI 打包边界发生变化时，`config/partner_cli_package.json` 的版本必须严格增加。PR CI 比较 merge-base；`main` push CI 必须先通过 Actions API 找到当前 run/SHA 之前最近一个 `completed + success` 的 `main push CI`，记录其 run id / run attempt 并 fetch 精确 SHA，作为不可缺少的 trusted baseline。同时，非全零且可解析的 `github.event.before` 也作为 base，以覆盖一次多 commit push 的完整范围；all-zero 或 fetch 后仍不可解析的 before 只能退回已验证的 trusted baseline，没有 trusted baseline 必须 fail closed。checker 接受并去重多个 `--base`，逐一比较；因此失败的 B 同版本包漂移不能被随后只改文档的 C 洗白。manifest 任意字段、manifest 两侧声明的任一打包文件或 `scripts/install_partner_bi_ops_cli.ps1` 发生同版本漂移都会失败，非法版本、版本回退、空或无法解析的 base 也会失败。
6. CI 先完成 `source-checks`，再以四个独立 runner 执行确定性 `1/4` 至 `4/4` shard；`fail-fast=false` 保证不因单 shard 失败而跳过其余覆盖，终态 gate 要求 source checks 与全部 shard 均为 `success`。只提交已验证范围，推送 `main`，等待目标 SHA 的 **main push CI** 达到 `completed + success`。PR CI 不能替代同一 SHA 的 main push CI。

### 3.2 GitHub 发布

正式源码 Tag / GitHub Release 的唯一支持入口是 `.github/workflows/source-release.yml` 的 `workflow_dispatch`。不支持人工执行 `git tag`、`git push <tag>` 或 `gh release create` 来发布源码版本。

1. 输入精确的 `version=YYYY.MM.DD.N` 与小写 40 位 `expected_commit`。
2. `scripts/check_source_release_version_order.mjs` fresh 枚举远端 `--tags --refs`，按年月日和数字 revision 比较；请求版本低于当前最新源码 Tag 时拒绝，等于最新只允许恢复该版本，高于最新才是前进。该检查在初始、Tag push、draft create、asset upload、publish 和终态重复执行；非源码命名空间的 Tag 不参与比较，污染源码命名空间的非法日期则 fail closed。
3. 工作流只接受从 `refs/heads/main` 发起、且目标为当时 `origin/main` HEAD 的调度；dispatch SHA、checkout、输入 SHA、fresh fetch 的 `origin/main` 四者必须完全一致。
4. 工作流通过 GitHub Actions API 查询该 SHA 最新的 `main` 分支 `push` CI，绑定精确 `runId + runAttempt`，要求 run endpoint 与 attempt-specific endpoint 都回读为同一 SHA、`completed + success`。PR CI、其他分支/事件/SHA、旧 attempt 或尚未完成的 CI 都不满足门禁。
5. `release-attestation.json` 使用确定性的 schema v3，记录 `repository{id,fullName}`、`version/tag/commit`、`trustPolicySha256`、CI 的 workflow path / event / branch / run id / run attempt / URL / `completedAt` / `jobCount` / `jobsSha256`，以及 source workflow path；不写当前 source-release run id、当前时间或其他每次重跑都会变化的字段。其 SHA-256 与 commit、CI run/attempt 一起写入 annotated tag message。
6. 远端无 Tag 时，工作流先创建并精确回读 annotated tag，再通过 Release API 创建 draft，避免 create-release 隐式创建轻量 Tag。已有 Tag 仅在对象类型确为 `tag`、peeled commit、完整 message 与 attestation hash 都精确时复用；轻量 Tag 或任意漂移均拒绝。
7. 状态机允许恢复自己留下的中间状态：精确 tag-only 可继续创建 draft；draft 缺失或漂移的两份 attestation asset 可在 draft 状态用 `--clobber` 重传；正式 Release 若 Tag、CI 绑定、两资产均精确，只做只读终态验证。正式 Release 缺资产或资产错误时拒绝且绝不修改。
8. 两份资产必须经 API 回读 `state=uploaded`、精确 size 与服务端 `digest=sha256:<local>`，并通过 asset API 下载后逐字节比较。Tag、draft 与资产就绪后，紧邻 `draft=false` PATCH 前再次 fresh fetch `origin/main`、查询最新该 SHA CI run/attempt 并访问 attempt-specific endpoint；main 或 CI 有任何漂移时保留可审计 Tag/draft 并 fail closed，不发布旧 HEAD。
9. 发布前必须串行启用/确认 GitHub immutable releases policy（仅当未启用时运行 `PUT /repos/{owner}/{repo}/immutable-releases`），并用权威 GET 回读 `enabled=true`，不能只信 mutation 响应；`enforced_by_owner` 仅在 tracked trust policy 的 `requireOwnerEnforcement=true` 时才是硬门。当前个人仓库保持 `requireImmutableReleases=true`、`requireOwnerEnforcement=false`。发布后再次回读 `origin/main`、最新 CI attempt、annotated tag、Release 的 draft/prerelease/immutable 字段（正式 Release 必须 `immutable=true`）、两资产元数据与下载字节；CI `completedAt` 必须早于 Release `publishedAt`。Release notes 可以记录当前 source workflow run URL，但该 URL 不进入 Tag 绑定的 attestation。

源码发布从前只观察到 `immutable:false`，现已成为硬门而非可选加固：正式源码 Release 必须 `immutable=true`，且仓库 immutable releases policy 必须 `enabled=true`；`enforced_by_owner` 按 tracked trust policy 条件校验。tag 中绑定的 attestation hash、精确 CI attempt 和发布前后 live readback 仍用于防止误操作与普通状态漂移，但不是抵抗有删除/改写权限的恶意管理员的密码学边界。源码 Release 尚未完成生产部署时，仍只能写“源码已发布，生产待部署”。

Partner CLI 的 `partner-cli-v*` Release 与 BI 自动激活走独立的 `.github/workflows/partner-cli-release.yml`，不由 source-release 工作流代替。该链同样要求当前 main 上的发布自动化、目标 commit 的精确同 SHA main-push CI、annotated tag 与已启用的 immutable policy；owner enforcement 仅在 tracked policy 要求时校验。入口只能是带 `tag + expected_commit` 的手动 dispatch。操作者先创建 draft Release，draft 的 expected commit 必须仍是当前 main；工作流在 draft 中上传并下载回读唯一 ZIP/SHA256，紧邻单次 publish PATCH 前 fresh 复验全部门禁，正式终态必须 `immutable=true`。已发布 immutable 版本使用独立 release-source checkout，因此 main 后续前进也可按原 exact commit 只读复验并幂等部署，禁止再上传、覆盖或删除资产。不得恢复 `release: published` 自动触发，否则单次发布会产生重复部署 run。

### 3.3 云端部署

1. 从目标源码 GitHub Release 下载 `release-attestation.json` 与 `release-attestation.json.sha256`；逐字节核对下载资产、校验 checksum，并核对 Release asset API 的 `state`、`size`、`digest`。任一失败时停止部署，不得退化为只信 Tag 名称。
2. 读取 schema v3 attestation，确认 `repository{id,fullName}`、`version`、`tag`、`commit`、`trustPolicySha256`、CI `workflow/event/branch/runId/runAttempt/url/completedAt/jobCount/jobsSha256` 和 `sourceWorkflow.path` 均精确，且 `repository.id` 等于 trust policy 的 repository id；查询最新该 SHA 的 main push CI 及 attempt-specific endpoint，必须仍与 attestation 完全一致。Tag 必须是 annotated tag、peeled commit 等于 attested commit、完整 message 中的 attestation SHA-256 精确；Release 必须非 draft、非 prerelease 且 `immutable=true`，CI `completedAt` 必须早于 Release `publishedAt`；immutable releases policy 必须已 `enabled=true`，并按 tracked policy 条件核对 `enforced_by_owner`，以权威 GET 回读为据。
3. 先备份 tracked diff、关键运行态和当前 Portal 输出。
4. 确认热修均已回填 GitHub；运行态文件已经迁出 tracked source。
5. 以 `sheinops` fetch，并让 `/opt/shein-bi/app` 精确落到 attested commit；禁止长期靠逐文件 `scp` 维持生产。
6. 应用 schema、systemd unit、服务重启和 section 预热。
7. 验收：
   - `git rev-parse HEAD` 等于 attestation 的 `commit`；
   - 两份证明资产已放入 `/srv/shein-bi/runtime/release-attestations/<release tag>/`；`node scripts/check_release_source_state.mjs --expected-commit <release tag> --record-deployment <release tag>` 同时验证源码、checksum、schema v3、origin repository、trust policy SHA-256、annotated tag message/object/peeled commit 与 exact source fingerprint，并原子写入 schema v3 的 `shein-bi-deployed-release/v3` 生产 marker；
   - 不得用 `skip-worktree` / `assume-unchanged` 隐藏缺失或被改写的 tracked 文件；
   - CI 成功；
   - Portal health、关键 service/timer、数据库和业务读回通过。
   - Inventory writer 兼容门与当前 checkout 使用同一 commit/source fingerprint/bundle/release receipt：执行 `node scripts/inventory/assert_inventory_writer_release_aligned.mjs --cwd /opt/shein-bi/app --expected-commit <exact commit> --json` 必须 exit 0；未通过前不得释放 maintenance。

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

# 唯一支持的源码发布入口（只恢复精确中间态；COMMIT 必须仍是 origin/main HEAD）
gh workflow run source-release.yml --repo dushengyi1993/shein-sales-bi \
  -f version="$VERSION" -f expected_commit="$COMMIT"

# 部署前下载并核验发布证明；生产最终保存到
# /srv/shein-bi/runtime/release-attestations/$VERSION/
gh release download "$VERSION" --repo dushengyi1993/shein-sales-bi \
  --pattern release-attestation.json --pattern release-attestation.json.sha256
sha256sum --check release-attestation.json.sha256
jq -e --arg version "$VERSION" --arg commit "$COMMIT" \
  '.schemaVersion == 3
   and .repository.fullName == "dushengyi1993/shein-sales-bi"
   and (.repository.id | type == "number")
   and .version == $version and .tag == $version and .commit == $commit
   and (.trustPolicySha256 | type == "string")
   and .ci.workflow == ".github/workflows/ci.yml"
   and .ci.event == "push" and .ci.branch == "main"
   and (.ci.runId | type == "number") and (.ci.runAttempt | type == "number")
   and (.ci.jobCount | type == "number") and (.ci.jobsSha256 | type == "string")
   and .sourceWorkflow.path == ".github/workflows/source-release.yml"' \
  release-attestation.json

# 云端
cd /opt/shein-bi/app
node scripts/check_release_source_state.mjs --expected-commit <release tag> --record-deployment <release tag>
systemctl is-active shein-bi-portal.service shein-bi-query.service shein-bi-webhook.service
curl -fsS http://127.0.0.1:8787/api/health
curl -fsS http://127.0.0.1:8791/api/health
```

版本一致只解决“运行的是什么代码”，不能代替业务验收。销售、利润、营销和 Webhook 结论仍需回读云端 PostgreSQL、OpenAPI、日志和正式 Portal。
