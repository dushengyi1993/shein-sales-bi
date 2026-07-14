# Partner CLI 2026.07.13.1

发布日期：2026-07-13

## 结论

这是合伙人 CLI 的自动更新引导版，也是“已审图片不被本地 Codex 擅自否决”修复版。

- 旧版 `2026.07.12.1` 本身没有更新器，因此必须最后手动安装一次本版本。
- 从本版本开始，稳定启动器会在业务命令前检查云端 release；发现新版本后校验 manifest、bundle SHA256 和逐文件 SHA256，安装到不可变版本目录，原子切换 `current.json`，再重启同一命令。
- GitHub `partner-cli-v*` Release 发布后，由 `Partner CLI release to BI` 工作流自动验证 Tag 源码和 Release 资产、调用 BI 专用部署端点、原子切换云端当前版本并回读；不再需要人工把新包复制到 BI。完整发布说明见 `docs/partner-cli-automatic-deployment.md`。
- 不使用定时轮询，不在 SHEIN 写操作中途热替换代码。
- 安装器同步安装 `shein-bi-ops` Codex Skill。用户当轮指令和“已审可用”素材高于 AI 建议；标题未采用某参数不能被推导成图片禁用。
- 新增 `prepare-publish`：本地图片读取真实尺寸并上传后，URL、货号、供货价、库存、可选标题/分类会写回同一任务的完整发布 payload，再重新预演。旧预演 hash 自动失效，禁止上传后另建短任务或静默回退源链接图片。
- 修复自然语言中的 Windows/UNC 路径片段被误识别成商品货号的问题。

## 一次性升级

解压 `shein-bi-ops-cli-2026.07.13.1.zip` 后执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" version
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" doctor
```

后续统一调用 `%USERPROFILE%\.shein-bi\cli\shein-bi-ops.cmd`，不再运行旧解压目录中的脚本副本。

## 安全边界

- 自动更新包只对已登录 BI 账号提供，不包含店铺 Secret、服务器密钥、密码或 session。
- 图片上传仍走云端 SHEIN OpenAPI 白名单和账号店铺权限。
- `prepare-publish` 只上传、绑定和 dry-run；真实发布仍要求精确 payload hash、用户确认、审计和回读。
