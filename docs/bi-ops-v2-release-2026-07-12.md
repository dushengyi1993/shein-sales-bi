# 2026.07.12 BI 自动运营 V2、受控上新与负责人经验同步

版本标签：`2026.07.12-bi-ops-v2-owner-knowledge`

## 范围

本次交付入口、权限、模型路由、PostgreSQL runtime、JSON/PG 迁移回滚、可恢复 jobs、CLI 与网页重设计，并收口跨店商品复制、重新上架营销兜底和负责人经验单向继承。普通团队成员主入口是网页 BI 自动运营；Owner/合伙人保留 `bi_ops_cli`。网页按账号/店铺隔离，Owner 的 `scope=all` 仅全局只读，不能静默替别人写。

飞书问数已主动暂停：生产 `shein-bi-lark-sales-qa.service` 必须 disabled + inactive。网页问数和 CLI 不依赖它；本 release 不启用、不启动该服务。

## 兼容性

- 现有网页登录、店铺权限、任务确认、OpenAPI 适配器和回读流程保持兼容。
- CLI 新增/明确 `jobs`、`job`、`wait-job`、`chat --wait-seconds`、`--profile`、`--scope-all` 说明；旧 task 命令仍可用。
- `scope=all` 不改变写权限；模型 profile 不改变权限。网页不使用 max/ultra，xhigh 只限人工显式 Owner CLI。
- JSON runtime 仍可作为回滚兼容层；PostgreSQL 是目标运行存储，revision/idempotency/event/job 字段不可省略。

## 迁移顺序

1. 备份并确认仓库外的服务器私有环境、session 和数据库连接正常；不把凭据写入仓库。
2. 本次按用户确认不保留旧网页会话/任务。执行 `node scripts/migrate_link_ops_runtime_to_postgres.mjs --dry-run --skip-legacy-conversations --manifest-out <manifest.json>`，确认 source 为 31 tasks / 4 sessions / 15 messages，而导入 counts 为 0/0/0；旧 JSON 只保留在校验备份。
3. 确认无阻断后使用同一 `--skip-legacy-conversations` 参数执行 `--execute`；检查 import batch、hash 回读、revision、幂等重放和 event 追加。
4. 运行 `scripts/provision_link_ops_postgres_role.sh`（仅服务器 root，凭据由脚本生成到私有环境文件）。
5. 切换网页/服务使用 PG repository，观察 job 的 queued/running/终态与账号/店铺隔离。
6. systemd 部署只启用获授权的网页/刷新/timer；保持 `shein-bi-lark-sales-qa.service` disabled + inactive。

## 回滚

切回 JSON 前运行 `node scripts/export_link_ops_postgres_snapshot.mjs --output-dir <rollback-dir>`，验证 manifest 后保留快照。若需回滚，停止写入窗口，切回 JSON repository，使用 snapshot 继续服务并保留 PG 事件/导入批次；不要删除 PG 表或直接覆盖他人数据。修复后重新 dry-run、hash 校验，再按迁移顺序重试。

## 验证清单

- [x] 网页普通成员只能看到授权账号/店铺，写入目标也被服务端拒绝越权（隔离烟测）。
- [x] Owner `scope=all` 可读 jobs/审计但不能扩大写权限（隔离烟测）。
- [x] Luna 20s / Terra 45s / Terra 90s / Sol 300s / Owner Sol 600s 路由正确；网页无 max/ultra。
- [x] PG 行级记录、optimistic revision、idempotency、append-only event 和可恢复 intent_plan job 均可用。
- [x] JSON -> PG dry-run/execute 的 manifest/hash 与回读一致，且新网页初始 tasks/sessions/jobs 都为空。
- [x] PG -> JSON rollback snapshot 可读取，未写入密码/密钥。
- [x] `shein_link_ops` 受限角色无 superuser/建库/建角色权限，event 不可 UPDATE/DELETE。
- [x] `shein-bi-lark-sales-qa.service` 为 disabled + inactive，部署命令没有 enable/start 它。
- [x] `node scripts/test_bi_ops_release_gate.mjs`、`node scripts/test_bi_ops_intent_job_flow.mjs`、`node scripts/test_bi_ops_multitenant_isolation.mjs`、`node scripts/test_migrate_link_ops_runtime_to_postgres.mjs` 通过。

## 生产验收记录

- 正式入口：`https://sa.dushengyi.cc/#ops`。Owner 登录态下完成桌面与 `390 x 844` 移动视口检查；页面显示“服务在线”、`2/2` 数据源就绪、无旧会话，未在验收中发送运营指令。
- 云端切换前备份：`/srv/shein-bi/backups/manual/bi-ops-v2-20260711-150512`；本机全量备份：`E:\Codex Backups\Shein销售统计\bi-ops-full-20260711-133151`。备份、发布包、迁移 manifest 和 PG rollback snapshot 均做 SHA-256 回读。
- 迁移 batch：`linkops_20260711072606_2ddf2d3727df`；migration hash：`4e601520b83c08940465cfaa2f29a2e5ce747c82b7236dc023a8a27da39a888c`；fresh-runtime manifest hash：`2ddf2d3727dfeb824e4f0dd219d30e0c4ba09177392c8a0b5ec6eef720c7e75e`。
- 旧 JSON 读取到 `31 tasks / 4 sessions / 15 messages / 0 actions`，按用户确认跳过会话与任务导入；切换后 PostgreSQL 为 `0 tasks / 0 sessions / 0 messages / 0 jobs / 0 events`。旧 JSON 权限收紧为 `0640`，仅作回滚材料。
- restricted role 核验：`shein_link_ops` 非 superuser、不可建库/建角色/复制；`ops.link_ops_event` 仅 SELECT/INSERT，不可 UPDATE/DELETE；所有 ops 表均无 DELETE/TRUNCATE 授权。
- PG -> JSON rollback snapshot 已落到同一云端备份目录的 `pg-rollback-after-cutover/`，counts 全为 `0` 且 SHA-256 校验通过。
- 云端 `codex-cli 0.144.1` 与 npm latest 一致，`CODEX_HOME=/home/sheinops/.codex` 显示 ChatGPT 登录有效。CLI 默认入口已收口到 `https://sa.dushengyi.cc`。
- 本地与云端 `npm test` 均为 `48/48`；本地和云端 BI Ops release gate 均通过。生产 Portal 为 enabled + active、PostgreSQL storage healthy；飞书问数仍为 disabled + inactive、进程数 `0`。

## 已知边界

- 本 release 是文档/运行边界收口，不宣称所有 SHEIN 写动作已打开；真实写仍受白名单、资料、确认、payload hash 和回读限制。
- 飞书代码和 unit 保留但生产停用；任何恢复都需要单独授权、验证和新的发布记录。
- 本地 JSON/HTML 是兼容或回滚材料，不等于云端业务事实；生产判断仍回到线上 API、PostgreSQL、日志和 systemd。
- 文档只给命令和占位符，不保存任何密码、token、Cookie、密钥或私有环境内容。

## 17:00 首条真实会话复修

- Owner 在生产页面首次发送 TZ / `SM-505A电动缝纫机` 处理指令时，`POST /api/link-ops-chats` 被误拒绝为 `Cross-origin state-changing request denied`。根因是 Caddy 已传入外部 `X-Forwarded-Proto: https`，Nginx 却用内部 HTTP hop 的 `$scheme` 覆盖成 `http`；Portal 同源保护因此把真实 `https://sa.dushengyi.cc` 误判为跨域。
- 店铺能力卡同时暴露第二个口径错误：当通用只读探针超过 14 天时，代码只剩 HL 单店硬编码就绪兜底，因而错显为 `19 授权 / 1 已验证读 / 1 可真实提交`。生产私有总闸门和真实写白名单实际均已覆盖 19 店和已接入的 9 类 OpenAPI 写动作。
- 19 店只读探针已在云端重跑：`19/19 read_probe_ok`、`failed=0`；当日销售/退货/商品对账也均为 19 店成功。代码已取消 HL 硬编码就绪权威，并把新鲜且带有效领域指标的日常 OpenAPI 对账纳入读链路证据。页面改为 `API 已接通 / 可系统检查 / 当前账号可受控提交`，不再把探针、全局安全门或他人权限误说成店铺有无 API。
- 回归门禁新增两个生产形状：“通用探针已过期，但 19 店商品日常对账新鲜成功”仍应判定 19 店可进入受控流程；Nginx 模板必须保留上游 `X-Forwarded-Proto`，不得回退到 `$scheme`。
- 同一条生产原文还暴露了意图分流缺口：`缺上架链接` 最初被当成问数。确定性解析器现将其识别为 `copy_product_draft`，只把 TZ 放进写店铺，并用 `sourceScope=all_stores` 从全部店铺选源，不会把缺链接的 TZ 当成来源或扩大写范围。
- 慢速结构化模型曾在确定性预演完成后追加相互矛盾的追问。现在已有 action 的任务事实完全由确定性状态机负责，模型无论返回 query/action/mixed 都只能 advisory：不能改 intents、店铺、货号、参数、execution、preflight 或 payload hash；模型运行期间任务若被后续消息更新，旧 job 按 `repositoryRevision + business fingerprint` fail-closed 为 stale。冲突/过期模型摘要不会再写入聊天或覆盖完成横幅。
- PostgreSQL 空白首会话复测发现 task 先于 session 落库会触发 `link_ops_task_chat_session_id_fkey`。新会话现先持久化 session，再创建 FK 绑定任务；对应顺序门禁已加入前端/服务静态 smoke。用于任务投影的 `example.invalid` 网络依赖同时改为本地 fake OpenAPI，门禁不再受 DNS/网络超时影响。
- 最终生产验收会话 `los_20260711110200_537109ac`、任务 `lot_20260711110200_0cebc9d0`：页面为 `19/19 API 已接通 · 19 可系统检查 · 19 当前账号可受控提交`；只影响 TZ，选源为 QY `sv25082869650540305`，状态为 `waiting_review / openapi_product_preflight_ready`。聊天仅有用户原文和一条确定性答复；后台 job 为 `succeeded + advisoryOnly + chatFeedbackSuppressed`。`actualWriteSubmitted=false`、`issuedExecuteToExecutor=false`、`sheinWriteAttempted=false`，部署后无新的 `mutation-origin-denied`。
- 本地与云端最终再次通过 `npm test 48/48` 和 BI Ops release gate；Portal active，飞书问数仍为 disabled + inactive。定向云端备份包括 `/srv/shein-bi/backups/manual/bi-intent-final-20260711-184730`、`/srv/shein-bi/backups/manual/bi-session-bootstrap-20260711-190018`、`/srv/shein-bi/backups/manual/bi-job-banner-20260711-192904`。

## 2026-07-12 首次确认执行复修

- 用户在上述任务中于次日发送“可以执行”后，payload hash 安全锁阻止了提交。审计确认 `actualWriteSubmitted=false`、`sheinWriteAttempted=false`；没有调用 `publishOrEdit`，不存在重复链接。
- 根因不是后台结构化模型，而是执行器在真实执行时重新按最新流量排名选源：预演锁定的是 QY `sv25082869650540305`，执行时漂成 YJ `sv260211111931313305907`；计划上架日期也从 `2036-07-11 10:00:00` 漂成 `2036-07-12 10:00:00`。安全锁行为正确，错误在于预演后未锁住源链接和计划日期。
- 执行器现在从最近一次成功预演（包括后续失败覆盖后的历史记录）恢复目标店对应的源店、源 SKC、计划日期和预演 hash。执行只复用用户确认过的源链接/日期；若源商品、类目模板或最终发布资料本身真的变化，hash 锁仍会 fail-closed，不会为了通过而跳过校验。
- 客户端不再展示 64 位内部校验值，也不再误导用户“补字段”；发生真实资料漂移时会明确说明已安全停止、未发出 SHEIN 创建请求，并要求重新检查后确认。
- UI 同步修复：完成态后台检查横幅始终保留状态图标列，避免正文挤进 18px 图标列；结构化辅助检查改为清晰的标签+正文布局；全局 19 店 API 能力从任务右栏移到工作台全局状态区；“执行控制 / 从理解到回读”右栏加宽并提高字号、行高和文字对比度。
- 门禁新增 `test_link_ops_preflight_product_lock.mjs`，覆盖“当前失败记录为 YJ，但必须从成功预演历史恢复 QY 和原计划日期”的事故形状。发布成功假服务测试同时按既定字段边界修正：产品型号保留纯型号，`supplier_code / supplier_sku / standard_goods_sn` 才使用业务货号。当地 `npm test` 为 `49/49`，完整 BI Ops release gate 通过。
- 生产当前任务已用 `reusePreflightLock=true` 连续完成两次只读预演：两次最终发布资料 hash 一致，源链接保持 QY `sv25082869650540305`，计划日期保持 `2036-07-11 10:00:00`；状态恢复为 `waiting_review / openapi_product_preflight_ready`，且两次均 `actualWriteSubmitted=false`、`issuedExecuteToExecutor=false`、`sheinWriteAttempted=false`。页面未替用户继续真实提交，仍等待新的明确确认。
- 生产可见态复核：全局能力区显示 `19/19 已接通 · 19 可系统检查 · 19 当前账号可受控提交`，右侧任务栏不再重复店铺能力；正文无 64 位内部 hash，“当前状态”显示预演通过；右栏主文字 `13px`、说明文字 `11.5px`，最终实拍保存在本地 `tmp/ops-final-verified-20260712.png`。
- 定向备份：本机 `E:\Codex Backups\Shein销售统计\bi-preflight-lock-ui-20260712-131107`；云端 `/srv/shein-bi/backups/manual/bi-preflight-lock-ui-20260712-133050`。

## 2026-07-12 14:05 平台预校验与目标店去重复修

- 用户再次确认后，执行器调用了 `publishOrEdit`，但 SHEIN 返回 `code=0 / info.success=false`：缺 `Hazardous materials classification`，且 `Power Supply(147)=Power Adapter(1007239)` 时缺 `Input voltage(1002322)`。审计为 `sheinWriteAttempted=true`、`actualWriteSubmitted=false`、`submitted=false`；平台没有创建新链接，任务保持可重新检查而非锁死。
- 根因有两处：输入电压条件只覆盖旧值 `Wall Plug(1047)`，漏掉当前商品的 `Power Adapter(1007239)`；源商品虽有 `Hazard Category=Others (Non-Transport Sensitive Items)`，执行器却没有把它映射到新商品类型模板新增的危险品分类必填项。
- 执行器现在读取目标店实时官方属性模板并确定性补齐：`Input voltage(1002322)=220-240 + Vac 50–60Hz(301114341)`；`Hazardous materials classification(1002328)=This product is not classified as dangerous goods(316914660)`；既有 `Input current(1002323)=1200mA(304302428)` 保持不变。模板中 `attribute_status=3` 的必填属性会在提交前统一核对，缺失时 fail-closed，不再等 `publishOrEdit` 才发现。
- 新增目标店同货号去重守卫：每次预演和执行前先用目标店 OpenAPI `searchProduct` 按最终 `supplier_code` 查询，再以 `spu-info` 核对上下架和回收站状态。在售同货号链接直接阻断；下架但未回收链接阻断并提示优先恢复；历史已回收链接不冒充当前在售链接，但必须在确认前明确提示“新链接将与历史回收记录并存”。
- 本次实时去重查到 TZ 历史链接 `sv260605191002817415915`（SPU `v2606051910028174`）：`shelfStatus=0`、`recycleStatus=1`，最后状态更新时间为 `2026-06-09 15:38:00`。它不是本次失败产生的链接，而是早已有的回收站记录；当前计划仍是创建新链接，不会恢复旧链接。
- 聊天回复同步修复：平台字段错误改为中文、去除重复明细，不再让运营人员猜技术属性；系统先按源商品和官方模板自动补齐。预演已通过时也会展示重要 warning，而不是只说“资料已经够了”。
- 生产连续两次只读预演均为 `waiting_review / openapi_product_preflight_ready`，最终发布资料 hash 均为 `68993a9c21c47444e342076390ead9780be8f9e51b1dd9c2fe2f775d3ca05f42`；源链接保持 QY `sv25082869650540305`，计划日期保持 `2036-07-11 10:00:00`，两次均未调用 `publishOrEdit`，`actualWriteSubmitted=false`、`sheinWriteAttempted=false`。
- 本地和云端 `npm test` 均为 `49/49`，BI Ops release gate 均为 `131/131`；Portal active/healthy，PostgreSQL runtime 正常，飞书问数继续保持 disabled + inactive。
- 定向备份：本机 `E:\Codex Backups\Shein销售统计\sm505-template-attrs-20260712-141208`；云端 `/srv/shein-bi/backups/manual/sm505-template-attrs-20260712-141208`、`/srv/shein-bi/backups/manual/sm505-duplicate-guard-20260712-1450`。

## 2026-07-12 最终生产闭环与负责人经验同步

- TZ 的 `SM-505A电动缝纫机` 已在负责人明确确认后完成真实 `publishOrEdit`，任务 `lot_20260712071413_1424a130` 进入 `done / submitted_readback_matched`。商品列表强回读匹配到新 SKC `sv260712151443331683679`、SPU `v2607121514433316`；`actualWriteSubmitted=true`、`sheinWriteAttempted=true`，不是弱匹配或仅凭接口弹窗判成功。
- 负责人经验链路已上线：本机 Codex Desktop/CLI 增量采集、负责人 BI 消息采集、active/candidate 分层、相关规则注入、任务快照和 stale 保护均已接入。首次同步写入 92 个经验版本，其中 19 个 active 信号合并为 18 条当前规则，73 条 candidate 不影响团队任务。
- 发布权限与普通 owner 角色分离：当前只有 `config/bi_access_roles.json` 中显式 `knowledgePublisher=true` 的负责人可发布；其他 owner/operator 只能消费。普通同事界面不展示规则包版本号、fingerprint 或内部快照。
- 后续收口已把本机 Windows 登录任务 `SHEIN-Owner-Knowledge-Sync` 从每 60 秒扫描改为文件事件驱动：默认 15 秒去抖、启动立即对账、每 60 分钟低频兜底。设备凭证只保存在用户 Codex Home 并限制 ACL，不进入项目或 GitHub。
- active 规则经过服务端二次脱敏、禁止字段和 hash 校验后发布到 GitHub `owner-knowledge` 分支；远端 commit 先进入 pending，只有 GitHub Actions 复验 immutable bundle 并以专用令牌激活后才成为 current。合伙人 CLI 每个云端业务命令前用 ETag 检查 manifest，只有版本变化才在跨进程锁内写入不可变 generation 并原子切换指针；普通网页不展示内部版本号。
- 真实 `execute` 的规则一致性守卫已下沉到 Portal 服务端，网页、自然语言聊天、直接 API 和 CLI 都不能在 distribution 未追平时绕过。激活端点只接受 GitHub Actions 专用 Bearer token，不接受普通 BI Cookie；secret 不进入仓库、unit 或日志。
- 收口复审又补上执行前后二次 snapshot/generation 校验与互斥、缓存与 Git publisher 的 nonce/PID/心跳唯一 ticket 队列、写前防回滚、Git 调用超时、未知高熵凭证脱敏，以及 session 事件内 timestamp 校验；死亡 ticket 可按其唯一文件安全清理，不再引入可能遗留的固定 recovery mutex。未来或非法时间只进 candidate，客户端 `machinePolicy` 被丢弃并由服务端按 `ruleKey` 推导。旧 generation 不自动删除，避免失效请求清理掉当前规则。
- 线上首次启用后复核了 unchanged `publish --force`：同一 Git commit/fingerprint/hash 现在直接保持 current，并幂等清理同 commit 的旧 pending，不再制造没有新 push/CI run 的幽灵 pending 状态。
- 首轮线上状态压测发现 PostgreSQL 动态 `listRecords` 对不同 WHERE 形状复用同一个 prepared-statement 名称，会造成连接复用后的随机 500。动态查询现保持 unnamed，并增加回归；修复后 10 次串行 + 10 次并行状态请求全部为 HTTP 200。
- 营销兜底同时覆盖“历史下架/售罄后重新上架且当前无生效活动”的链接；若最终版计划没有同货号目标价但商品成本存在，则按 Top5 利润率规则推导，不再把仓储费缺失误报成商品成本缺失。
- 最终补丁在本机与云端 `/opt/shein-bi/app` 的 `npm test` 均为 `63/63`；本机 BI Ops release gate 为 `151` 项全通过，`staleConfirm=true`、`deploymentBoundary=true`。Portal 重启后 `active + enabled`，本机 HTTP 健康检查为 `200`；`shein-bi-lark-sales-qa.service` 保持 `disabled + inactive`。
- 负责人本机补传 13 条增量（4 active、9 candidate）后，服务端为 105 个版本、21 条 active、82 条 candidate。GitHub `owner-knowledge` commit `e00ffc62edb3ca501993954f7c0abba53bca0966` 已由 workflow run `29201837075` 校验并激活；最终 `ready=true / current=true / source=github / pending=false`，active 与 distribution fingerprint 一致。
- Windows 任务已按新参数重装并实测为 `Running / MultipleInstances=IgnoreNew / debounce=15s / reconcile=3600s`；后续 session 文件变化产生 `reason=event` 的同步日志，而不是每 60 秒空转。
- 合伙人包 `outputs/releases/shein-bi-ops-cli-2026.07.12.1.zip` 已完成临时解压、安装、版本检查、生产 `knowledge-status` 和 `me` 端到端验收；SHA-256 为 `60976f27670c54faac579ec0e7aaa960bc93dc2b7e20d71409bd0403ad40d353`，安装目录与规则缓存扫描未发现 session cookie。
- 云端精确覆盖前备份为 `/srv/shein-bi/runtime/backups/owner-knowledge-20260712T171059Z-pre-3bae82c6`；unchanged publish 幂等补丁备份为 `/srv/shein-bi/runtime/backups/owner-idempotency-20260712T172004Z-pre-b8840cac`。部署未 reset 或暂存生产主工作树的其他 168 项既有改动。
