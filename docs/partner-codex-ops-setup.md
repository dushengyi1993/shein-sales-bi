# 合伙人 Codex App 接入 SHEIN BI 自动运营

> 这份文档给合伙人安装和使用。目标是：他在自己电脑上装好 Codex App 后，可以用自己的 BI 账号发起自动上下架、链接维护、复制链接等任务；所有真实操作仍走云端 BI 的权限、预检、确认和审计，不需要给他服务器 SSH 权限，也不需要把云端 API Key 给他。

## 一句话流程

1. 安装 `Codex App`。
2. 安装 `Node.js 20+`。
3. 拿到项目代码。
4. 在 Codex App 里打开项目目录。
5. 用自己的 BI 账号登录一次。
6. 之后直接让 Codex 帮他创建、预检和执行自动运营任务。

## 你需要提前给他的东西

- 正式 BI 地址：`https://shein-bi.dushengyi.xyz/`
- 一个 BI 账号和密码。
  - 合伙人/管理员账号：可读全部店铺，可写全部店铺。
  - 普通运营账号：可读全部店铺，只能写自己负责的店铺。
- 项目代码，至少要包含这些文件：
  - `scripts/bi_ops_cli.mjs`
  - `docs/partner-codex-ops-setup.md`
- 如果他只会使用、不参与开发，可以给他一个压缩包或 GitHub 下载方式；不要把任何服务器密钥、OpenAPI Secret、AI Router Key 写进文档或发给他。

## 电脑安装

### 1. 安装 Codex App

让他安装 Codex 桌面版，然后正常登录自己的 Codex 账号。

### 2. 安装 Node.js

安装 `Node.js 20` 或更高版本。

安装好后，在电脑终端里检查：

```powershell
node -v
```

如果能看到类似 `v20.x.x`、`v22.x.x` 这样的版本号，就可以继续。

### 3. 放置项目代码

建议放在一个固定目录，例如：

- Windows：`D:\Shein销售统计`
- macOS/Linux：`~/Shein销售统计`

然后在 Codex App 里打开这个项目目录。

## 首次登录 BI 自动运营

在项目目录运行：

```powershell
node scripts/bi_ops_cli.mjs login --username 他的BI账号
```

然后按提示输入密码。

登录成功后，本机会保存一个云端登录会话，默认位置：

- Windows：`C:\Users\<用户名>\.shein-bi\ops-session.json`
- macOS/Linux：`~/.shein-bi/ops-session.json`

这个文件只保存登录会话，不保存明文密码。

如果需要确认当前登录的是谁：

```powershell
node scripts/bi_ops_cli.mjs me
```

如果需要退出登录：

```powershell
node scripts/bi_ops_cli.mjs logout
```

## 安装后自检

先跑一键自检：

```powershell
node scripts/bi_ops_cli.mjs doctor
```

`doctor` 只做本机和云端只读检查，不创建任务、不预检、不执行 SHEIN 写操作。它会检查：

- 本机 `Node.js` 版本是否满足建议要求；
- 本机会话文件是否存在，且没有保存明文密码；
- 当前 BI 登录账号是谁、角色是什么、能写哪些店；
- 云端 OpenAPI 能力总账能否访问；
- 任务池接口是否可访问；
- 真实写总闸门和真实写试点白名单当前状态。

也可以在正式操作前检查某个账号对“某个店 + 某个动作”到底到哪一步可用：

```powershell
node scripts/bi_ops_cli.mjs doctor --operation activate_link --stores DL
node scripts/bi_ops_cli.mjs doctor --operation retire_link --stores DL
node scripts/bi_ops_cli.mjs doctor --operation copy_product_draft --source-stores CX --target-stores HL
node scripts/bi_ops_cli.mjs doctor --operation copy_product_draft --target-stores HL --require-real-submit
```

- 不带 `--require-real-submit` 时，只要求能建任务 / dry-run；适合普通运营确认“我能不能先做预检”。
- 带 `--require-real-submit` 时，会要求该账号、店铺和动作已经具备真实提交能力；如果仍被总闸门、白名单、账号写权限或动作适配器挡住，命令会退出非 0，并在 `requestedActionReadiness.items[].blockers` 里列出原因。
- 目前已接入的官方 OpenAPI 写适配器包括：`copy_product_draft`、`activate_link`、`retire_link`、`update_inventory`、`update_supply_price`、`update_product_price`、`update_title`、`update_images`、`certificate_review`。它们默认只做 dry-run；真实执行必须同时满足账号写权限、`safeWriteOperations`、真实写白名单、人 + 店 + 动作、上一次 dry-run 的 `payloadHash`、`waiting_review` 状态和确认文本 `SHEIN_OPENAPI_SUBMIT`。网页端不会要求用户输入英文安全码或固定确认框，而是在同一聊天里用“可以执行 / 提交吧 / 照做”等自然语言确认；服务端内部映射成安全确认码，CLI/脚本仍使用 `SHEIN_OPENAPI_SUBMIT`。
- 维护类适配器使用官方文档：商品上下架 `3001253 /open-api/goods/modify-skc-shelf`（`activate_link` 使用 `shelf_state=1`，`retire_link` 使用 `shelf_state=2`），库存 `3001738 /open-api/stock/change-inventory/v2`，供货价 `3001681 /open-api/goods/update-cost`，售价 `3001407 /open-api/openapi-business-backend/product/price/save`，局部编辑 `3001810 /open-api/goods/product/partialEdit`；证书/资质包含 `3001477 /open-api/goods/save-or-update-certificate-pool`、`3001183 /open-api/goods/save-certificate-pool-skc-bind` 等证书接口。`update_images` 要求提供完整 SHEIN `partialEdit` 图片 JSON（`spu_name + image_info/skc_list/site_detail_image_info_list`），避免错误清空图片层级；`certificate_review` 要求提供 `certificatePayloads[{endpoint,body}]`，提交后默认人工核销审核状态。
- `campaign_signup` / `flash_discount` 当前不走官方 OpenAPI：公开目录未发现营销报名、限时折扣、优惠券报名写接口证据，所以它们继续走本地营销运营流程、价格栈守卫和人工确认，不会在 OpenAPI 总账里伪装成“可真实提交”。
- 管理员验证维护写前，可先用 `node scripts/verify_shein_openapi_doc_detail.mjs --doc-id 3001253 --endpoint /open-api/goods/modify-skc-shelf --require-verified --pretty` 拉取脱敏 schema 证据，再用 `node scripts/check_bi_ops_maintenance_readiness.mjs --operation retire_link --doc-evidence <schema证据> --store-probe <逐店权限证据> --readback-evidence <回读证据> --expect pilot_ready --pretty` 做总检查。证据文件只放忽略目录；脚本不会打印或保存 Cookie，也不会调用 SHEIN 业务写接口。

如果需要单独确认云端自动运营接口能访问：

```powershell
node scripts/bi_ops_cli.mjs capabilities
```

查看任务池：

```powershell
node scripts/bi_ops_cli.mjs tasks --pretty
```

如果能看到账号信息、店铺权限或任务列表，说明他的 Codex App 已经能通过本机连接云端 BI。

## 日常怎么使用

### 推荐方式：直接让 Codex 调用工具

在 Codex App 里可以这样说：

```text
请调用 node scripts/bi_ops_cli.mjs create --stores DL --products 520a --text "把 DL 的 520a 做下架预检，不要真实提交"
```

或者：

```text
请调用 node scripts/bi_ops_cli.mjs create --stores TZZ --products SM-961 --text "复制 CX 的 SM-961 链接到 TZZ，先做预检"
```

跨店复制时，建议把来源店和写入店拆开写，避免把“读来源店”误当成“写来源店”：

```text
请调用 node scripts/bi_ops_cli.mjs create --source-stores CX --target-stores TZZ --products SM-961 --text "复制 CX 的 SM-961 链接到 TZZ，先做预检"
```

### 标准操作步骤

#### 1. 创建任务

```powershell
node scripts/bi_ops_cli.mjs create --stores DL --products 520a --text "把 DL 的 520a 做下架预检，不要真实提交"
```

跨店复制：

```powershell
node scripts/bi_ops_cli.mjs create --source-stores CX --target-stores TZZ --products SM-961 --text "复制 CX 的 SM-961 链接到 TZZ，先做预检"
```

创建后会返回一个任务 ID。

#### 2. 做预检

```powershell
node scripts/bi_ops_cli.mjs preflight --task-id <任务ID>
```

预检会检查：

- 当前账号有没有目标店铺写权限；
- 目标货号、店铺、链接是否能识别；
- 是否缺少素材、价格、状态或其他必要信息；
- 是否存在会阻断真实提交的问题。

#### 3. 查看审计记录

```powershell
node scripts/bi_ops_cli.mjs audit --task-id <任务ID>
```

审计会记录：谁、什么时候、从哪里、对哪个店铺、做了什么、结果是什么。

#### 4. 真实执行

真实执行必须非常明确，不能误触。命令是：

```powershell
node scripts/bi_ops_cli.mjs execute --task-id <任务ID> --confirm SHEIN_OPENAPI_SUBMIT
```

只有同时满足下面条件才会提交：

- 服务端预检通过；
- 任务处于可复核/可执行状态；
- 当前账号有目标店铺写权限；
- 当前账号、目标店铺和动作同时命中云端“真实写试点白名单”；
- 确认文本必须精确等于 `SHEIN_OPENAPI_SUBMIT`；
- 服务端会再次复核权限和任务状态。

注意：这条命令不等于一定会真实提交。现在系统默认仍是安全模式；如果云端没有给这个“人 + 店 + 动作”开试点白名单，它会自动降级为预检 / dry-run，并在任务和审计里写明阻断原因。

#### 5. 人工核销异常任务（管理员才用）

如果某个任务已经发起真实提交，但回读证据暂时没有对上，系统会把任务锁住，避免重复提交同一个动作。管理员确认 SHEIN 后台已经闭环后，可以人工核销：

```powershell
node scripts/bi_ops_cli.mjs resolve --task-id <任务ID> --status done --note "人工确认 SHEIN 后台已闭环"
```

如果确认这个任务不应该继续处理，可以归档：

```powershell
node scripts/bi_ops_cli.mjs resolve --task-id <任务ID> --status archived --note "人工确认不再处理"
```

人工核销也会写入审计。普通运营账号不能做这一步；这一步只用于处理“已提交待回读 / 需人工处理”的任务，不用于绕过预检或确认文本。

## 网页端怎么用

同一个账号也可以直接登录：

[https://shein-bi.dushengyi.xyz/](https://shein-bi.dushengyi.xyz/)

网页端和 Codex App 调用的是同一套云端权限和审计链路。也就是说：

- 网页能做的，Codex App 也可以通过 CLI 发起；
- Codex App 发起的任务，云端也能看到审计；
- 普通运营不能绕过网页权限去写其他人的店铺。

## 权限边界

- 合伙人/管理员：可读全部店铺，可写全部店铺。
- 普通运营：可读全部店铺；自动运营写操作只允许自己的店铺。
- “账号写权限”和“真实写试点白名单”是两层门：账号有某店写权限，只代表可以创建任务、上传素材、预检和复核；真正提交到 SHEIN，还必须由管理员在云端私有白名单里单独放行。
- 复制同事店铺链接到自己店铺：允许读取同事店铺信息，但真实写入只能写到自己有权限的店铺；CLI 里用 `--source-stores` 表示只读来源，用 `--target-stores` 表示写入目标。
- 越权写操作会返回 `403`，并写入云端审计。
- 不建议给合伙人或普通运营服务器 SSH 权限；所有动作都应通过 BI 账号、任务池、预检、确认和审计链路完成。

## 常见问题

### 看到 `401`

一般是没有登录、会话过期或密码错误。重新运行：

```powershell
node scripts/bi_ops_cli.mjs login --username 他的BI账号
```

### 看到 `403`

说明当前账号没有目标店铺的写权限，或者操作被服务端安全策略挡住了。

### 网页聊天说“提交吧”后仍然没有真实提交

这是正常安全机制。除了账号写权限和自然语言确认，还必须命中云端私有的真实写试点白名单。没有白名单时，系统只做资料检查，不会碰 SHEIN 后台。CLI/脚本路径仍需要显式 `--confirm SHEIN_OPENAPI_SUBMIT`。

### 提示 `Task not found`

任务 ID 不存在或写错了。先查看任务池：

```powershell
node scripts/bi_ops_cli.mjs tasks --pretty
```

### 预检没通过

按返回的阻断原因处理，比如补素材、修正店铺、修正货号、补登录态、补价格或重新创建任务。不要跳过预检直接执行。

### 任务显示“已提交待回读”或“需人工处理”

不要重复创建同一个真实写任务，也不要反复点执行。先到 SHEIN 后台确认真实状态，再由管理员用 `resolve` 人工核销；如果拿不准，就保留任务，不要强行关闭。

如果审计里出现 `suspicious_write_attempted`、`submittedPossibly=true` 或 `requiresManualResolve=true`，意思是系统在真实提交模式下无法确认 SHEIN 是否已经接收请求。此时必须按“可能已经提交”处理，不能重复执行。

如果审计里出现 `weak_match_only` 或 `weakMatchedCount > 0`，意思是只找到了平台 SKU、源 SKC 或货号文本这类弱证据；这不能证明新链接已经可靠生成，也需要人工确认后再核销。

### 换电脑或换账号

先退出：

```powershell
node scripts/bi_ops_cli.mjs logout
```

再用新账号登录。

## 安全原则

- 不把 BI 密码写进文档、Git 或脚本。
- 不把云端 API Key、OpenAPI Secret、服务器 SSH 权限发给普通电脑。
- 本机只保存会话 cookie，不保存明文密码。
- 所有真实写操作都要能在云端审计里追溯到：操作者、时间、来源、目标店铺、任务、预检结果、执行结果和回读证据。
- 没有预检通过、没有明确确认文本、没有真实写试点白名单，不允许真实提交。

## 管理员维护建议

- 给每个人单独账号，不共用账号。
- 合伙人账号可以给全部店铺写权限。
- 普通运营账号只给自己负责店铺的写权限。
- 员工离职或岗位调整时，先改 BI 账号权限或禁用账号。
- 定期抽查审计记录，尤其是上下架、改价、复制链接、批量维护等写操作。
- 真实写试点白名单只放在云端私有 `config/bi_ops_write_whitelist.local.json`，不要提交 GitHub；仓库里的 `config/bi_ops_write_whitelist.example.json` 只是格式样例。
- 普通发版或日常巡检时，建议在云端跑 `node scripts/check_bi_ops_production_safety.mjs --expect locked --pretty`，确认生产真实写仍处于锁定态。
- 如果要开启首个真实写试点，先只放行 `copy_product_draft`，并在云端跑 `node scripts/check_bi_ops_production_safety.mjs --expect pilot --require-store <店铺> --require-operation copy_product_draft --require-user <BI账号> --pretty`。这一步只读，不会调用 SHEIN；通过后仍必须先 dry-run、人工确认、带 `SHEIN_OPENAPI_SUBMIT` 执行并回读。

## 管理员验收脚本

发版或调整账号权限后，建议先在本地或云端项目目录跑隔离 smoke。脚本会创建临时账号、临时任务池和临时审计文件，不使用生产任务池，也不会打开真实写白名单。

```powershell
node scripts/test_bi_ops_release_gate.mjs
node scripts/test_bi_ops_permissions.mjs
node scripts/test_bi_ops_cli_flow.mjs
node scripts/test_bi_ops_write_whitelist_scope.mjs
node scripts/test_bi_ops_frontend_confirm_feedback.mjs
node scripts/test_link_ops_product_draft_openapi_detail.mjs
node scripts/test_shein_store_identity_merchant_fallback.mjs
node scripts/test_bi_ops_production_safety.mjs
node scripts/test_bi_ops_copy_product_success_flow.mjs
node scripts/test_bi_ops_maintenance_executor_flow.mjs
```

- `test_bi_ops_release_gate.mjs` 是发版前总入口，会串联语法检查、权限矩阵 smoke、CLI flow smoke、真实写白名单作用域 smoke、前端中文确认/反馈 smoke、商品详情 mapper smoke、店铺身份 merchantId fallback smoke、`git diff --check` 和旧确认文本扫描。
- `test_bi_ops_permissions.mjs` 验证服务端权限矩阵：普通运营可写自己店、不可写非负责店，跨店复制只校验写入店铺，全店管理账号可写全部店铺，`local-system` 不能写自动运营入口。
- `test_bi_ops_cli_flow.mjs` 验证合伙人 / 本机 Codex App 的 CLI 调用链：`login`、`me`、`capabilities`、`create`、`preflight`、`audit`、`logout`，并确认 session 文件不保存明文密码、预检不触发真实写。
- `test_bi_ops_write_whitelist_scope.mjs` 会在隔离临时门户里临时开启 `safeWriteOperations` 和一条真实写白名单，验证只有指定“人 + 店 + 动作”能命中；其他账号、店铺和动作仍被挡住，并且在缺少 dry-run、`waiting_review`、payload hash 等条件时不会真实提交。
- `test_bi_ops_frontend_confirm_feedback.mjs` 静态验证自动化运营页前端：网页端中文 `确认` 会映射到安全确认码，执行按钮有忙碌/完成/失败反馈，任务证据不覆盖聊天内容，回答可按 Markdown 分段展示。
- `test_link_ops_product_draft_openapi_detail.mjs` 使用离线 fixture 验证 `copy_product_draft` 能从 OpenAPI 商品详情 / `spu-info` 映射类目、属性、图片、SKU、供货价、尺寸重量等发布 payload 关键字段，不要求用户手工补完整 payload。
- `test_shein_store_identity_merchant_fallback.mjs` 验证 TZ/JSH/TZZ/XC 等 `query-store-info` 不返回 GS 账号时，只能在静态真相表 `merchantId` 匹配且没有 GS 冲突时使用 fallback；不得运行时自动回填或放宽店铺身份校验。
- `test_bi_ops_production_safety.mjs` 验证生产安全检查器本身：锁定态通过、复制上品试点通过、维护写试点通过，`*` 通配、角色泛放、未实现动作放行和总闸门大于白名单都会失败。
- `test_bi_ops_copy_product_success_flow.mjs` 使用本地假 OpenAPI 服务验证 `copy_product_draft` 成功闭环：任务创建、JSON payload 附件、dry-run 锁定 payload hash、显式确认执行、publish 成功、商品查询强指纹回读、任务自动 `done`。它不会调用真实 SHEIN；release gate 还会额外用 `--weak-readback` 跑一次，证明只有平台 SKU / 源 SKC / 货号文本等弱证据时，任务必须进入人工核销，不能自动判成功。
- `test_bi_ops_maintenance_executor_flow.mjs` 使用本地假 OpenAPI 服务验证维护写执行器：恢复上架、下架、库存、供货价、售价、改标题、换图、证书绑定完整 payload、dry-run hash 锁定、显式确认 execute、库存 + 商品回读。它不会调用真实 SHEIN。
- `test_shein_openapi_doc_detail_parser.mjs` 使用离线 fixture 验证官方文档详情解析器，确保 `modify-skc-shelf` / `shelf_state` 这类维护写接口不会因为解析器变动而误判；它不访问外网、不需要登录态、不保存 Cookie。
- `test_bi_ops_maintenance_readiness.mjs` 验证维护写 readiness 检查器：缺证据时必须阻断，只有 schema 时只能到 `schema_ready`，只有 schema + 逐店权限 + 强回读三类脱敏证据都齐全时才会到 `pilot_ready`，且含 `secretKey/openKeyId/Cookie/token` 等敏感字段的证据会被拒绝。
