# Partner CLI 端到端自动发布

## 架构结论

- GitHub 是唯一版本事实源：代码、`config/partner_cli_package.json`、Tag、Release、资产和 CI 结果都在 GitHub 留档。
- BI 是鉴权分发入口：普通合伙人不需要 GitHub 仓库权限，只通过已有 BI 登录态读取当前 `manifest`、`bundle` 和首次安装 ZIP。
- `2026.07.13.1` 是最后一次必须人工安装的引导版。从该版本开始，业务命令执行前会检查 BI；发现新版后完成逐文件哈希校验、不可变目录安装、原子切换并重新执行原命令。

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

正常发布只需创建已发布的 GitHub Release：

```text
partner-cli-vYYYY.MM.DD.N
```

工作流会自动完成构建/资产复用、验证、BI 激活和回读。需要重新验收现有已发布版本时，可手动触发：

```powershell
gh workflow run "Partner CLI release to BI" --repo dushengyi1993/shein-sales-bi -f tag=partner-cli-v2026.07.16.1
```

手动触发仍会执行全部验证，并且同一内容重复部署是幂等的。

## 完成标准

一次发布只有同时满足以下条件才算成功：

- GitHub Actions 工作流成功；
- BI 状态端点回读 `source=managed`；
- 回读版本、Tag、源码 Commit、bundle SHA256 和 ZIP SHA256 与 Release 一致；
- 未登录用户仍无法访问包；
- 已登录 CLI 能看到该版本；
- 失败部署未改变上一版的当前指针。
