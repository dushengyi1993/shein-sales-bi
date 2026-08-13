# SHEIN BI Ops 2026.08.13.2 发布说明

Git tag：`partner-cli-v2026.08.13.2`

## 这次解决什么

- 受控 CLI execute 被 `owner knowledge distribution contains sensitive text at $.rules[14].ruleKey` 误阻断。2026.08.13.1 安装包内的 `lib/owner_knowledge_distribution.mjs` 早于 #76（allow structural owner rule tokens），缺少 `ruleKey`/`risk`/`activation` 等结构标识 token 的白名单。
- 本版按当前 main（bf2a243 起）重新打包，发行包内置已修复的敏感扫描：结构 key 不再误报，真实 secret/token/cookie/password 仍被拦截。

## 验证

- `scripts/test_owner_knowledge_distribution.mjs`：覆盖 `rules[n].ruleKey` 结构 token 放行与真实敏感值拦截。
- `scripts/test_partner_cli_package.mjs`：断言发行包内含 ruleKey 结构 token 守卫。
- Partner CLI release pipeline 测试通过。
