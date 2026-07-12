# 负责人经验单向同步

## 目标

本机 Codex Desktop、Codex CLI 与负责人本人 BI 会话中的可复用经验，自动进入 BI 的长期规则层；其他 BI 账号只能在业务流程中消费这些规则，其会话内容不会反向生成、修改或覆盖负责人规则。

这不是多账号共享聊天记忆，也不依赖云端 Codex 自己“记住”。规则由 BI 服务端存储、筛选并注入模型与受控任务；云端模型只是消费者。

## 身份边界

- `role=owner` 不等于规则发布者。
- 只有 `config/bi_access_roles.json` 中显式设置 `knowledgePublisher=true` 的负责人账号可以从 BI 会话发布。
- 本机通过一次性登记的设备令牌发布；设备令牌归属于固定 `SHEIN_OWNER_KNOWLEDGE_PRINCIPAL`，默认是 `dushengyi`。
- operator、其他 owner、admin 和服务器内部任务都不能发布负责人规则。
- 普通同事界面不展示规则包版本号。版本、fingerprint、候选数和设备状态只存在于负责人状态 API 与审计记录。

## 经验分层

- 负责人明确说出的长期要求，例如“以后、默认、后续每次、不要再、以某项为准”，校验后进入 active。
- 故障结论、模型总结和可能可复用但未被负责人明确设为长期规则的内容进入 candidate，不影响同事任务。
- 本机采集器只读取当前项目的已整理 memory note，以及当前项目 Codex session 中的用户消息和最终结论；不会上传 reasoning、tool output、整段原始会话或其他项目。
- Bearer、password、token、Cookie、Authorization、API key 和 private key 在本机发送前脱敏。
- 一个 `ruleKey` 同时只保留一个 active 版本；负责人新规则通过 current pointer 覆盖旧版本，历史 version/event 保留审计。

## 运行链路

1. `scripts/owner_knowledge_sync.mjs` 从本机 Codex Home 增量采集。
2. 采集结果通过设备 Bearer token 发送到 `POST /api/owner-knowledge/events`。
3. `lib/owner_knowledge_service.mjs` 使用 Link Ops repository 的通用 record、revision、payload hash、idempotency 和 event 存储。
4. BI 会话由 `scripts/serve_bi_portal.mjs` 在负责人发言后直接提炼；非负责人跳过。
5. 每轮网页问答与任务创建会按店铺、动作、商品和关键词选择相关 active 规则。
6. 规则文本进入云端 agent context；结构化 `machinePolicy` 与 fingerprint 进入任务内部快照，不投影给普通前端。
7. 负责人规则在系统检查后发生变化时，旧后台规划结果会被判 stale；真实提交必须按新规则重新系统检查。

## 本机命令

```powershell
npm run owner-knowledge:scan
npm run owner-knowledge:sync
npm run owner-knowledge:status
```

默认本机文件：

- 凭证：`%USERPROFILE%\.codex\owner-knowledge\device.json`
- 增量状态：`%USERPROFILE%\.codex\owner-knowledge\sync-state.json`
- 服务地址：`https://sa.dushengyi.cc`

凭证不得提交 Git、复制到聊天或放入项目目录。

## 设备登记

云端管理员可以在加载 portal PostgreSQL 环境后执行：

```bash
node scripts/owner_knowledge_admin.mjs issue-device \
  --publisher-user '<负责人BI用户名>' \
  --device-id '<稳定设备ID>' \
  --device-name '<可读设备名>'
```

命令返回的 token 只显示一次，应直接写入本机凭证文件并限制 ACL。正常 BI 会话也可以调用 `POST /api/owner-knowledge/devices` 登记设备；knowledge device 自己无权继续创建其他设备。

安装 Windows 登录后常驻同步：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install_owner_knowledge_sync_task.ps1
```

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install_owner_knowledge_sync_task.ps1 -Uninstall
```

## 运行检查与故障处理

```powershell
Get-ScheduledTask -TaskName SHEIN-Owner-Knowledge-Sync
Get-ScheduledTaskInfo -TaskName SHEIN-Owner-Knowledge-Sync
npm run owner-knowledge:status
```

- 计划任务应为 `Running`，增量状态文件的修改时间应持续推进；无网络时同步器保留原 offset，恢复后自动补传。
- 401 表示设备 token 无效或已轮换；重新登记同一 device id 后，旧 token 立即失效。
- 403 表示当前 BI 账号不是负责人发布者，这是正常权限边界，不能通过给同事安装设备 token 解决。
- 5xx 先检查云端 Portal、PostgreSQL 与 `owner_knowledge_*` record，再跑 owner knowledge 测试；不得直接改数据库 current pointer 或任务内部快照。
- Windows PowerShell 5 运行安装脚本时使用纯 ASCII 脚本内容，避免无 BOM UTF-8 中文被错误解码；用户文档仍保持中文。

## API

- `POST /api/owner-knowledge/events`：负责人 BI 会话或已登记设备发布经验。
- `GET /api/owner-knowledge/status`：仅负责人/设备查看内部状态。
- `GET /api/owner-knowledge/active?q=...`：仅负责人/设备调试相关规则。
- `POST /api/owner-knowledge/devices`：仅负责人本人 BI 会话登记/轮换设备。

同事无需调用这些 API；网页服务会在后台自动使用规则。

## 验收

- 负责人本机新增长期规则后，后台同步周期内进入 active。
- 其他 owner/operator 对发布 API 返回 403。
- 同事使用相反的长期措辞后，active rule/version 数量不变。
- 同事任务内部带负责人规则快照，但 API 投影和界面不出现 fingerprint、versionId 或规则包版本文案。
- 无网络时不推进本机 offset；恢复后按 sourceId/content hash 幂等重传。
- 新 fingerprint 出现后，旧 intent-plan 结果不允许覆盖任务，旧系统检查不允许直接真实提交。
