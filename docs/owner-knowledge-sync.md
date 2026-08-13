# 负责人经验单向同步

## 目标

本机 Codex Desktop、Codex CLI 与负责人本人 BI 任务在结束时生成一张规则检查单；只有负责人显式审核通过的候选才进入长期规则层，并把脱敏后的 active 规则发布到 GitHub `owner-knowledge` 分支形成可回滚版本。其他 BI 账号只消费规则，其任务结束不会生成检查单、候选、覆盖记录或任何负责人知识数据。

这不是多账号共享聊天记忆，也不依赖云端 Codex 自己“记住”。规则由 BI 服务端存储、筛选并注入模型与受控任务；云端模型只是消费者。

## 身份边界

- `role=owner` 不等于规则发布者。
- 只有 `config/bi_access_roles.json` 中显式设置 `knowledgePublisher=true` 的负责人账号可以从 BI 会话发布。
- 本机通过一次性登记的设备令牌发布；设备令牌归属于固定 `SHEIN_OWNER_KNOWLEDGE_PRINCIPAL`，默认是 `dushengyi`。
- operator、其他 owner、admin 和服务器内部任务都不能发布负责人规则。
- 普通同事界面不展示规则包版本号。版本、fingerprint、候选数和设备状态只存在于负责人状态 API 与审计记录。

## 经验分层

- 任务结束检查只允许输出 `no_rule`、`candidate` 或 `review_required`；模型无权直接激活规则。
- 负责人明确说出的长期要求也先进入 candidate，必须由负责人本人登录 BI 审核通过后才进入 active。
- 旧会话扫描、关键词耐久判断和 BI 单条聊天消息采集均已废弃；不会再扫描 session、archived session 或 memory note。
- Bearer、password、token、Cookie、Authorization、API key、private key、Slack 风格 token 和无标签高熵疑似凭证在本机发送前脱敏；服务端和 GitHub bundle 校验再做一次相同防线。
- 一个 `ruleKey` 同时只保留一个 active 版本；负责人新规则通过 current pointer 覆盖旧版本，历史 version/event 保留审计。

## 运行链路

1. Codex 的任务结束通知调用 `scripts/owner_knowledge_turn_ended.mjs`；仅目标项目且仅负责人本机任务进入脱敏的本地待处理目录。
2. 后台分析继承当前全局模型设置，输出结构化检查单；失败或不确定时写 `review_required`，不静默跳过。
3. 隐藏运行的 `scripts/owner_knowledge_sync.mjs upload` 只上传已经生成的检查单；离线时保留，恢复后按任务和回合标识幂等重传。
4. BI 负责人任务进入 done/archived 时生成检查单；同事身份在入口处直接跳过，零记录。
5. `lib/owner_knowledge_service.mjs` 使用 revision、payload hash、idempotency 和 event 存储；采集入口强制 candidate，负责人审核才更新 current pointer。
5. active bundle 先做服务端二次脱敏、禁止字段检查和 fingerprint 校验，再由 `lib/owner_knowledge_distribution.mjs` 写入专用 Git 仓库并推送 GitHub `owner-knowledge` 分支。GitHub 只保存规则包，不保存原始会话、来源路径、设备、账号或 token。
6. 服务端先把远端已回读的 commit 保存为 pending；GitHub Actions 再从该 commit 校验 immutable bundle、fingerprint 和 SHA-256，成功后用专用短权限令牌调用激活端点。只有 commit、fingerprint、bundle hash 与当前 active 规则全部一致，pending 才能成为 current distribution。
7. 云端保存已通过 GitHub CI 的 distribution snapshot；每轮网页问答与任务创建按店铺、动作、商品和关键词选择相关 active 规则。
8. 合伙人 CLI 每个云端业务命令前请求 `GET /api/owner-knowledge/manifest`，使用 ETag 无变化返回 304；有变化才下载到不可变 generation 目录，完整校验后再原子切换 manifest pointer。跨进程文件锁覆盖整次检查，旧请求不能覆盖新规则。CLI 不需要 GitHub 账号或 GitHub token。
9. 规则文本进入云端 agent context；结构化 `machinePolicy` 只能由服务端按 `ruleKey` 推导，客户端夹带字段会被丢弃；策略与 fingerprint 进入任务内部快照，不投影给普通前端。
10. 负责人规则在系统检查后发生变化时，旧后台规划结果会被判 stale；真实提交必须按新规则重新系统检查。GitHub 发布或 CI 激活尚未追平 current bundle 时，服务端会关闭网页、聊天和 CLI 的全部真实 `execute`。执行开始与子执行器真实写调用之间还会在一致性互斥区内复核 distribution snapshot 与进程内规则 generation，避免检查后并发变更的 TOCTOU 旁路。

## 本机命令

```powershell
npm run owner-knowledge:upload
npm run owner-knowledge:status
```

默认本机文件：

- 凭证：`%USERPROFILE%\.codex\owner-knowledge\device.json`
- 检查单目录：`%USERPROFILE%\.codex\owner-knowledge\completion-spool`
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

默认每 30 秒尝试上传待发送检查单；任务全程通过 `wscript.exe` 隐藏运行。

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install_owner_knowledge_sync_task.ps1 -Uninstall
```

## 运行检查与故障处理

```powershell
Get-ScheduledTask -TaskName SHEIN-Owner-Knowledge-Completion-Uploader
Get-ScheduledTaskInfo -TaskName SHEIN-Owner-Knowledge-Completion-Uploader
npm run owner-knowledge:status
```

- 计划任务应为 `Running`。`sync-state.json` 只会在启动对账、实际文件事件或低频 reconciliation 后推进，不应再每分钟刷新；`sync.log` 只记录摘要和错误，不记录 token 或规则全文。
- 无网络时同步器保留原 offset，恢复后由下一次文件事件、重启或低频 reconciliation 自动幂等补传。
- 401 表示设备 token 无效或已轮换；重新登记同一 device id 后，旧 token 立即失效。
- 403 表示当前 BI 账号不是负责人发布者，这是正常权限边界，不能通过给同事安装设备 token 解决。
- 5xx 先检查云端 Portal、PostgreSQL 与 `owner_knowledge_*` record，再跑 owner knowledge 测试；不得直接改数据库 current pointer 或任务内部快照。
- distribution 的 `current=false` 表示 PostgreSQL active bundle、GitHub commit 或 CI 激活尚未追平。先看 `Owner knowledge distribution` workflow：若 commit 尚未生成，运行 `node scripts/owner_knowledge_admin.mjs publish --force`；若 workflow 失败，修复校验或激活错误后重跑。不得手改 manifest、pending 或 current pointer。
- Windows PowerShell 5 运行安装脚本时使用纯 ASCII 脚本内容，避免无 BOM UTF-8 中文被错误解码；用户文档仍保持中文。

## API

- `POST /api/owner-knowledge/completions`：负责人本机或 BI 任务提交结束检查单。
- `GET /api/owner-knowledge/reviews`：负责人查看候选。
- `POST /api/owner-knowledge/reviews/decide`：负责人批准或拒绝候选。
- `POST /api/owner-knowledge/rules/deprecate`：负责人废止当前规则；历史版本保留。
- `POST /api/owner-knowledge/events`：兼容入口，只能新增 candidate，不能直接 active。
- `GET /api/owner-knowledge/manifest`：所有已登录 BI 账号可读取脱敏规则版本、GitHub source commit、CLI 最低版本和 ETag；不返回规则来源或设备信息。
- `GET /api/owner-knowledge/bundle`：所有已登录 BI 账号可读取与 manifest 精确对应的脱敏 active bundle，供 CLI 原子缓存。
- `GET /api/owner-knowledge/status`：仅负责人/设备查看内部状态。
- `GET /api/owner-knowledge/active?q=...`：仅负责人/设备调试相关规则。
- `POST /api/owner-knowledge/devices`：仅负责人本人 BI 会话登记/轮换设备。
- `POST /api/owner-knowledge/distribution/activate`：仅 GitHub Actions 使用专用 Bearer token 激活已校验的 pending commit；不接受 BI Cookie 代替。

同事无需调用这些 API；网页服务会在后台自动使用规则。

## 验收

- 负责人本机新增长期规则后，文件事件稳定 15 秒左右进入 active；GitHub `owner-knowledge` 分支产生新 commit，workflow 校验和激活成功后，云端 distribution 的 `fingerprint/sourceCommit` 与之对应。
- 其他 owner/operator 对发布 API 返回 403。
- 同事使用相反的长期措辞后，active rule/version 数量不变。
- 同事任务内部带负责人规则快照，但 API 投影和界面不出现 fingerprint、versionId 或规则包版本文案。
- 合伙人 CLI 首次任务下载规则包；后续无变化只得到 304，不重复下载。缓存更新顺序为进入带 nonce/PID/心跳的唯一 ticket 队列 -> 写入 `generations/<bundleSha256>/bundle.json` -> 写前再次比较当前 pointer -> 完整回读校验 -> 原子切换 `manifest.json` pointer。每个 contender 只删除自己的 ticket，死亡 ticket 可按唯一文件安全清理，不需要可能遗留的固定 recovery mutex。旧 generation 自动保留，避免失效请求误删当前 bundle；如需清理必须离线确认不等于当前 pointer。
- 无网络时不推进负责人本机 offset；恢复后按 sourceId/content hash 幂等重传。
- 新 fingerprint 出现后，旧 intent-plan 结果不允许覆盖任务，旧系统检查不允许直接真实提交。
