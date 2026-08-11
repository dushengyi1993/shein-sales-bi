# 审核资料三语核心卖点描述绑定（Phase A）

Phase A 只做“当前待发布 copy_product_draft 任务的审核资料描述绑定 + 新发品强制描述门”。
历史存量链接的 `update_description`/partialEdit 写链路（dry-run 形状、live spu-info 锁、
check-edit-permission/query-document-state 解析、execute 回读分类）属于 Phase B，本分支未实现。

## 契约（锁定事实）

- 官方 `publishOrEdit`（docId 3001812）与 `partialEdit`（docId 3001810）字段
  `multi_language_desc_list`：元素严格 `{language, name}`；`name` ≤5000 字符、无 HTML、
  无 emoji/代理项；有描述时必须含默认语言（沙特默认 ar）。
- 用户要求内容只能逐字取审核资料“三语核心卖点”，不得生成/翻译/改写，不得用源 OpenAPI
  描述（`productMultiDescList` 等）自动映射。
- 生产 payload 固定 `ar`、`en` 各恰好 5 行（以 `\n` 连接）；`zh-cn` 五行仅作材料审计
  SHA，不进 payload。
- 历史 SK-13015 的 19 个成功 payload 均为 ar/en 各 5 行、元素 `{language,name}`。

## 文件

### 纯函数模块 `lib/link_ops_product_descriptions.mjs`

- `validateDescriptionMaterialJson`：严格 material JSON schema
  `{schemaVersion:1, sourceLabel, sourceFileSha256, rows:{ar,en,'zh-cn'}}`，每语言恰好 5 个
  原文 line + 声明 sha256。验证只允许：line 非空、无内嵌 CR/LF、无 HTML（尖括号）、无
  emoji/代理项、joined UTF-8 SHA 匹配；不做 trim/normalize/改标点。`sourceLabel` 必须是
  basename（不得含路径分隔符）。
- `buildDescriptionPayloadRows`：固定 ar→en 顺序生成 `{language, name}`，`name = lines.join('\n')`，
  限长 5000。
- `describeDescriptionMaterial` / `describePublishPayloadDescription`：只输出
  hashes/counts/languages，绝不含全文。
- `verifyDescriptionMaterialSourceFile`：从用户提供的实际源文件字节计算 SHA 并核对声明值。
- `validatePublishPayloadDescription`：新发品门——最终 payload 必须恰好 ar+en 两条、各 5 行
  非空、无 HTML/emoji、限长；额外/重复/未知语言一律 blocker；同时出现 camelCase/
  `productMultiDescList` 等描述别名也一律拒绝。
- `validateDescriptionBindingLock`：dry-run/execute 前把 `task.descriptionMaterialBinding` 的
  exact-key schema、服务端 HTML 证明、目标店、base revision、bindingRequestKey、图片指纹、
  task 当前 `openapiPublishPayload` stable hash 及 ar/en 描述 hashes 全部锁定校验；仅行数通过
  不够，任何字节或 metadata 漂移即 blocker。
- `evaluateDescriptionReadback`：spu-info `productMultiDescList` 的 live 回读门——ar/en 各恰好
  1 条且逐字 hash 等于绑定 hashes；返回 exact/missing/duplicate/mismatch 状态与
  hashes/lineCounts（无全文）。
- `buildPrepareDescriptionsCliOutput`：CLI 终端输出装配器（只含 hashes/counts/languages）。

### 确定性 HTML 提取 `lib/link_ops_description_material_extract.mjs`

- 从实际 HTML 的唯一 `<section id="s09">` 提取：英文/阿文 `<code>`（标签取 code 所在
  article/card 内最近 h1-h6 标题，支持 英文/英语/English/EN、阿文/阿拉伯/العربية/Arabic/AR、
  中文/汉语/Chinese/ZH，含“阿文”），中文 `displaybox`（严格恰好 5 个直接子元素、每个子元素
  恰好一行）。
- section 不唯一、标签缺失/多语言同时命中、行数≠5、任一字节与 material 不同、displaybox
  结构不符 → 全部拒绝。禁止 LLM/模糊语言分类。
- `verifyDescriptionMaterialAgainstHtml`：source-only 模式直接以实际字节 SHA 构造 material；
  提供 material JSON 时要求声明 SHA 与三语逐字全部一致，任一字节不同即拒绝。

### 服务端 `scripts/serve_bi_portal.mjs`

- `/api/link-ops-prepare-descriptions`：只允许未提交的单一目标店 `copy_product_draft` 任务；
  请求必须携带实际审核 HTML 的 basename+严格 base64 字节及正整数 expected repository
  revision；服务端自己计算文件 SHA、解析唯一 `section#s09` 并逐字比对 material，拒绝只提交
  自报文本/hash。校验 actor/writeStore/taskId/status/sourceApproved=true；如果任务只有
  source/asset snapshot 而无持久化 payload，先由同一个 OpenAPI dry-run executor 只读捕获并
  物化 payload，再在同一次 CAS 中绑定，测试不再直接写任务文件绕路。克隆
  `openapiPublishPayload`，只设置 `multi_language_desc_list`，
  删除该字段后前后 stable hash 必须相同，图片结构 fingerprint 与
  `publishAssetBinding.bindingFingerprint` 必须不变。
- 任何 `actualWriteSubmitted`、`sheinWriteAttempted`、`issuedExecuteToExecutor`、
  submitted-possibly/suspicious、publishResult/publishOrEdit call、锁定/人工核销证据都先
  fail closed；禁止把历史写证据重置成 false 或重新开放任务。
- 持久化走单任务原子 CAS：`args.linkOpsStoreGateway.updateTaskRecord(expectedRevision=读取时
  锁定的 revision)`（postgres `WHERE revision=$n` / json repository 文件锁内校验），并发改动
  返回 HTTP 409 `LINK_OPS_REVISION_CONFLICT`，绝不做整库 stale overwrite。
- 记录 `descriptionMaterialBinding`（源文件 SHA、三语 SHA/行数、contentSha256、
  source byte length/server proof、publishLanguages=ar/en、base revision、请求 key、绑定人/时间、
  当前 task payload hash）；重置顶层 `preflight`、`lifecycle`、
  `execution.state/executors/preflight`、`writeAudit` 及所有可提交/已发标志，旧 payloadHash
  清空，必须重新 dry-run 才能再 ready；`note` 追加而非覆盖（保留既有用户上下文）。
- 任务记录/history 与 repository `task_updated` 事件随 CAS 提交；提交后做独立精确回读。
  外部 JSONL 审计失败不会伪装成“未提交”：返回 `bindingCommitted/readbackVerified/auditPending`
  与明确 stage；相同 base revision+content 的重试幂等补审计，不重复绑定。
- 审计/历史只落 hashes/counts，绝不落全文。

### 发品执行器 `scripts/link_ops_hl_openapi_executor.mjs`

- `validatePublishPayload` 接入描述门（缺 ar/en 各5行描述即 blocker）。
- `extractPayloadSummary` / `extractReadbackFingerprint` 含 descriptionCount/languages/
  lineCounts/hashes；dry-run/execute 前做 binding-lock 校验。
- `publishOrEdit` 成功判定收紧：必须 `code='0'` 且 `info.success===true`（无显式 success
  字段的 code=0 不再视为成功）。
- publishResult 持久化改为字段 allowlist；平台若回显任一描述行/多行内容，只存回显 SHA，
  blocker/审计/客户端响应均不保存描述全文。
- spu-info 回读（languageList en/ar）：身份强匹配后仍要求 live `productMultiDescList` 的
  ar/en 各 1 条且 hash 与绑定一致；缺失/漂移/重复 → readback.ok=false 且明确 mismatch 状态，
  生命周期为 `submitted_readback_failed`（需人工核销），绝不冒充 `submitted_readback_matched`。
- 客户端投影（`projectLinkOpsProductExecutorForClient`）新增脱敏
  payload.found/payloadHash + 描述 summary（count/languages/lineCounts/hashes/
  descriptionBindingLocked）与 readback.ok/status/descriptionReadback（仅 hash/count），
  供 CLI 确认使用；绝不含全文/URL/敏感响应。

### managed CLI `scripts/bi_ops_cli.mjs`

- `prepare-descriptions --task-id <id> --store <store> --source-file <实际审核资料HTML>
  [--material-json <可选>] [--expected-revision <n>]`：本地用确定性 extractor 逐字提取/核验
  三语各5行并计算源文件字节 SHA；先 fresh-read task revision（显式 revision 若漂移即停止），
  将实际 HTML 字节交给服务端独立复核后绑定，再对同 task 重新 dry-run；
  终端只输出 hashes/counts/languages/new payload hash/dry-run 状态。
- `--material-json` 提供时做逐字核验，任一字节不同即拒绝；不提供时由实际文件直接构造。
- 绑定已提交但 readback/audit/dry-run 失败时，CLI 分阶段输出“已绑定/未预演”等事实，禁止把
  post-commit 故障当作未绑定重试；错误不打印绝对本地路径或原始服务响应。

### 受管 CLI 包

- `config/partner_cli_package.json` 与 `lib/partner_knowledge_cache.mjs` 版本升至
  `2026.08.11.1`，包文件清单加入两个新 lib 模块（否则安装包 module-not-found）。
- `codex/skills/shein-bi-ops/SKILL.md` 增加 prepare-descriptions 用法与门禁说明。

## 测试

- `scripts/test_link_ops_product_descriptions.mjs`（75 项）：严格 schema、emoji（含 astral
  U+1F600、BMP、组合）、360°/阿文/中文无误伤、SHA、payload 门、binding lock、live 回读
  exact/missing/duplicate/mismatch、双字段/伪 payload hash/额外 metadata 拒绝、CLI 输出无全文。
- `scripts/test_link_ops_description_material_extract.mjs`（26 项）：s09 唯一性、诱饵段落、
  重复 s09、空行、实体解码、字节差异、标签歧义/缺失、displaybox 嵌套/4子元素/游离文本。
- `scripts/test_link_ops_prepare_descriptions_flow.mjs`（126 项）：门户 + 假 OpenAPI + managed CLI 集成——
  缺描述阻断、绑定仅改 desc、图片/绑定指纹不变、旧预演/提交锁全部重置、CAS 409、新 dry-run
  后 ready、execute 显式 success 判定、live 描述回读 exact/drift、列表强匹配不得绕过 SPU
  描述回读、searchProduct/product-query exact+drift 矩阵、双 writer CAS、既有写证据保留、
  post-commit 审计故障/幂等补审计、CLI source-only 绑定/路径脱敏、审计无全文。
- `scripts/test_link_ops_extract_sk11004.mjs`：SK-11004 实际 HTML 只读验收（需
  `--html <实际文件>`；脚本内锁定完整源文件 SHA 与三语 SHA，也可显式覆盖），输出仅
  hashes/counts；已注册 deterministic runner，无实际文件环境明确 skip，有文件时强校验。
- source/asset-only copy success smoke 不再直接注入 `openapiPublishPayload`，而是验证正式
  executor capture→同任务绑定→dry-run→execute→live readback 全链路。
- 注册进 `scripts/run_deterministic_tests.mjs`（描述纯函数、HTML extractor、实际源文件门、
  门户/假 OpenAPI 集成专项）。

## 未完成（Phase B / 剩余 blocker）

- 历史存量 `update_description` 结构化操作（intent/CLI operate/safeWriteOperations/
  capabilities/model policy/readiness/maintenance executor）、partialEdit 最小 body、
  check-edit-permission 与 query-document-state 的保守解析、execute 前 live 门禁重跑、
  submitted_readback_pending/needs_manual_resolve 分类。
- `extract-description-material` 独立命令（卖点章节的其他历史结构：selling-card、
  copy-panel 等）未实现；DOCX/历史格式留 Phase B。
- SK-11004 实际 HTML 已完成只读验收：源文件 SHA256 为
  `08fc51ba7cc5b5133b45304d85891aaaf4f6d9f20102718f38118e0ecb032f2d`，英文/阿文/中文
  均恰好 5 行，三组逐字 SHA 与锁定值一致；验收输出只有 basename、行数和 SHA，不含正文。
