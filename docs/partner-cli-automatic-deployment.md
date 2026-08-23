# Partner CLI 端到端自动发布

## 架构结论

- GitHub 是唯一版本事实源：代码、`config/partner_cli_package.json`、Tag、Release、资产和 CI 结果都在 GitHub 留档。
- BI 是鉴权分发入口：普通合伙人不需要 GitHub 仓库权限，只通过已有 BI 登录态读取当前 `manifest`、`bundle` 和首次安装 ZIP。
- `2026.07.13.1` 是最后一次必须人工安装的引导版。从该版本开始，业务命令执行前会检查 BI；发现新版后完成逐文件哈希校验、不可变目录安装、原子切换并重新执行原命令。
- 本轮稳定化 manifest 版本为 `2026.08.23.1`。运行时 `BI_OPS_CLI_VERSION` 必须在集成时同步，且既有包测试必须证明两者相等后才能发布。
- 同版本修复先在 dot staging 中完成 manifest、逐文件 SHA256 和 bundle hash 全量复验，再用同目录 rename 交换。稳定 bootstrap 与 updater 使用同一个跨进程 ticket 队列；有效死 PID 票据可在身份二次核验后立即回收，无法解析的票据只有超过 stale 窗口才删除。旧 staging/swap backup 是掉电恢复证据，只有在新的 canonical root 再次完整复验后才可清理；连续两次在 swap 前掉电也必须至少保留上一份已验证 staging。
- 离线 bootstrap 只会启动完整验证且受 current/update-state/verified marker 锚定的版本；未锚定或损坏的 staging 永不执行。更新器在 staging、swap-away、swap-in、pointer publish 任一点被杀后，下一次启动都从保留证据确定性恢复或 fail closed。

## 版本不可变门禁

`scripts/check_partner_cli_version_change.mjs` 是无网络、只读取本地 Git 对象的确定性门禁：

- PR CI 以当前 `HEAD` 与 PR merge-base 比较。`main` push CI 必须通过 Actions API 找到当前 run/SHA 之前最近一个 `completed + success` 的 main push CI，绑定 run id / run attempt、回读 latest 与 attempt-specific endpoint，并 fetch 其精确 SHA作为 trusted baseline；同时把非全零且可解析的 `github.event.before` 加为第二个 base，以覆盖一次 push 内的全部 commit。all-zero 或 fetch 后仍无法解析的 before 只允许回退到已验证 trusted baseline；trusted baseline 缺失或取不到时 fail closed。checker 对多个 `--base` 按 commit 去重并逐一检查，因此失败的同版本包漂移不能被下一次只改文档的 push 洗白。
- `source-checks` 通过后，CI 才并行运行四个确定性 shard（`1/4` 至 `4/4`）；`fail-fast=false` 保留全部覆盖，终态 gate 要求 source checks 与四个 shard 全部成功。PR CI 仍不能作为源码发布所要求的同 SHA main push CI。
- 比较范围包括整个 `config/partner_cli_package.json`、base/current manifest 的打包文件并集，以及 `scripts/install_partner_bi_ops_cli.ps1`。
- 任何同版本 manifest 字段或打包内容漂移都会失败；非法 `YYYY.MM.DD.N`（含无效日期）和版本回退也会失败。
- 内容变化只有在版本严格增加时才允许继续；该门禁不调用 GitHub API，也不能替代包构建、包内外逐文件验证或 BI 激活回读。

## 自动发布链路

`.github/workflows/partner-cli-release.yml` 在已发布的 `partner-cli-v*` GitHub Release 上运行：

1. 拒绝草稿、预发布和非 `partner-cli-v*` Tag。
2. 从 Tag 对应的不可变源码运行 `npm ci --ignore-scripts` 和 `npm test`。
3. Release 已有 ZIP 与 checksum 时直接下载，不重新生成或覆盖；两项都不存在时才构建并上传；只缺一项或出现重名时失败。
4. 解压 ZIP，逐文件确认它与 Tag 源码及包清单一致；二进制必须逐字节相同，UTF-8 文本只允许 Windows/Linux 换行符差异，额外文件、缺失文件、符号链接和其他内容变化都会被拒绝。
5. 生成包含源码 Commit、Release 时间、manifest、bundle、ZIP 和全部哈希的部署信封。
6. 使用 GitHub Actions 专用 Bearer 凭证调用 BI 部署端点。
7. BI 再次验证 Tag/版本绑定、Commit 格式、bundle 哈希、逐文件哈希、ZIP 大小和 ZIP SHA256。
8. 发布内容先写入不可变版本目录，全部落盘后才原子替换 `current.json`；随后工作流通过独立状态端点回读版本和源码 Commit。

因此，客户端自动更新不再依赖人工把 GitHub 资产复制到 BI。

## 生产存储与回滚

- 生产发布根目录由 `SHEIN_PARTNER_CLI_RELEASE_DIR` 指定，当前使用 `/srv/shein-bi/partner-cli`。
- 对外 API 永远只读取 `current.json` 指向的一个版本，所以 BI 用户只能下载最新版。
- 服务器私有目录保留当前版本和上一版本，用于故障回滚；它们不映射为静态下载目录。完整历史仍由 GitHub Release 保存。
- 同一版本号内容不可变：版本相同但 bundle 或 ZIP 哈希不同会返回冲突；低于当前版本的发布也会被拒绝。
- 写入或回读失败时不切换，已经工作的当前版本继续服务。

## 权限和密钥

- GitHub 仓库 Secret：`PARTNER_CLI_DEPLOY_TOKEN`。
- BI Portal 环境变量：`SHEIN_PARTNER_CLI_GITHUB_DEPLOY_TOKEN`。
- 两端值相同，但值本身不得写入仓库、Release、日志、文档或工作流输出。
- 部署端点和状态端点只接受该 Bearer 身份；普通 BI Cookie、负责人账号和合伙人账号都不能发布版本。

## 发布方式

Partner CLI 必须使用 draft-first 链路。先确认目标是当前 `origin/main` 的完整 commit，创建指向该 commit 的 annotated tag 和非 prerelease 的 draft Release；不得手工先发布，也不得创建 lightweight tag：

```powershell
$commit = '<exact-main-commit>'
$tag = 'partner-cli-vYYYY.MM.DD.N'
git tag -a $tag $commit -m "Partner CLI release $tag"
git push origin "refs/tags/$tag"
gh release create $tag --repo dushengyi1993/shein-sales-bi --draft --verify-tag --title $tag --notes-file <release-notes.md>
```

随后只通过手动工作流提交 tag 和同一个完整 commit：

```powershell
gh workflow run "Partner CLI release to BI" --repo dushengyi1993/shein-sales-bi -f tag=$tag -f expected_commit=$commit
```

工作流先检查部署凭据、当前 `origin/main`、annotated tag peeled commit、manifest 版本、GitHub repository identity、精确同 SHA main-push CI，以及 immutable releases policy 的 `enabled=true` / `enforced_by_owner=true`。它只跑静态门、Portal shell 构建和 Partner CLI 聚焦测试，不在 45 分钟发布工作流内嵌套整套长测试；整套覆盖由同 SHA main CI 证明。

draft 路径在 Release 尚可修改时构建并上传唯一 ZIP/SHA256，逐字节下载回读，同时核对 asset API 的 `state`、size 和服务端 digest；发布前再次 fresh 核对 main、tag、CI、policy 和两份资产，只发送一次 `draft=false` PATCH。无论 PATCH 响应是否明确，都只轮询权威 Release 终态，不自动重发发布请求；只有 `draft=false`、`prerelease=false`、`immutable=true` 和两份精确资产全部成立后，才构建部署 envelope、原子激活 BI 并读取状态端点。

已发布版本只有在 Release 已经 immutable 且资产精确时才允许重跑。工作流将当前 main 的发布自动化与 annotated tag 指向的目标源码分开 checkout：draft 目标必须仍是当前 main；已发布 immutable 目标即使 main 后续前进，也按其 exact `expected_commit`、同 SHA CI 和 Release 资产只读复验后幂等部署。该分支不会上传、覆盖或删除 Release 资产。若首次工作流在 Release 已发布后、BI 激活前失败，使用相同 `tag + expected_commit` 重跑；不要重建 tag/Release。工作流已删除 `release: published` 触发，避免发布动作再启动第二条重复部署链。

`.github/workflows/source-release.yml` 只发布源码版本 `YYYY.MM.DD.N`，是正式源码 Tag / Release 的唯一支持路径；它不会创建 `partner-cli-v*` Release，也不会调用 BI Partner CLI 部署端点。反过来，`.github/workflows/partner-cli-release.yml` 只负责 `partner-cli-v*` draft-first 资产发布、不可变终验、BI 原子激活和回读，两条链路不得相互替代。

源码 release workflow 是可恢复状态机：它把确定性 schema v3 attestation 的 SHA-256、commit 和精确 main push CI `runId + runAttempt` 写进 annotated tag；只复用完整精确的 annotated tag、tag-only 或 draft 中间态，draft 两资产可重传，已经正式发布的精确 Release 只做只读终态验证。发布前紧邻 `draft=false` PATCH 会重查 `origin/main` 与最新 CI attempt，并核对 immutable releases policy（`enabled=true` 且 `enforced_by_owner=true`）；漂移时保留 Tag/draft并拒绝发布旧 HEAD。该流程不创建或替代 `partner-cli-v*` 发布链。

生产部署源码时，必须从对应源码 Release 下载并逐字节核对 `release-attestation.json` 与 `release-attestation.json.sha256`，同时核对 asset API 的 `state=uploaded`、size 和服务端 SHA-256 digest；再确认 schema v3 attestation 中 repository id、commit、trustPolicySha256、CI workflow/event/branch/run id/run attempt/URL/`completedAt`/`jobCount`/`jobsSha256`、source workflow path，与最新 main push CI 的 attempt-specific API 回读一致。Tag 必须是 annotated tag，peeled commit 与完整 tag message 中的 attestation hash 必须精确；Release 必须非 draft、非 prerelease 且 `immutable=true`，CI 时间早于发布时间，且 immutable releases policy 已 `enabled=true` 与 `enforced_by_owner=true`（发布前串行启用并以权威 GET 回读）。任一项缺失或漂移都停止部署。

## 完成标准

一次发布只有同时满足以下条件才算成功：

- GitHub Actions 工作流成功；
- annotated tag peeled commit、当前 main 与 exact main-push CI 都等于 `expected_commit`；
- Release 为非 draft、非 prerelease 且 `immutable=true`，ZIP/SHA256 各唯一一份，API digest/size/state 与下载字节一致；
- BI 状态端点回读 `source=managed`；
- 回读版本、Tag、源码 Commit、bundle SHA256 和 ZIP SHA256 与 Release 一致；
- 未登录用户仍无法访问包；
- 已登录 CLI 能看到该版本；
- 失败部署未改变上一版的当前指针。
