# Partner CLI 2026.07.28.3

## 目标

减少合伙人电脑因长期不用、CLI 会话文件写入中断或意外损坏而重复登录。

## 变更

- BI 网页登录继续使用 90 天会话。
- 通过 `shein-bi-ops-cli/*` User-Agent 或 `client=partner-cli` 登录的 Partner CLI 单独使用 365 天会话。
- 服务端登录响应明确返回会话类型、有效天数和到期时间。
- CLI 会话改为原子写入，并维护权限为仅当前用户可读的备份；主文件损坏时自动恢复。
- 退出登录时同时删除主会话和备份。
- 明文密码只参与当次 HTTPS 登录请求，不写入任何会话文件。

## 验收

- 网页 Cookie 仍为 `Max-Age=7776000`。
- Partner CLI Cookie 为 `Max-Age=31536000`。
- CLI 测试覆盖主会话损坏、从备份恢复及退出后双文件清理。
- `npm test`：124 / 124 通过。
- 本机 Windows 构建 ZIP SHA256：`76923cff8cf8fa77a0c32c2037ae868e499198fe5c537e886288b34cba609851`。
- GitHub Release 生产 ZIP SHA256：`c2b683ed049b1826568e2cc8827cbe36b960d360d8c15d0e1ff56eb557bf9af4`；受管 bundle 内容 SHA256：`4a869ae526b74d5db1ad62fe8ea30ee5b2595751584282389584f58001a27bb7`。
