# 合伙人 Codex App 接入 SHEIN BI 自动运营

> 这份文档给合伙人安装和使用。目标是：他在自己电脑上装好 Codex App 后，可以用自己的 BI 账号发起自动上下架、链接维护、复制链接等任务；所有真实操作仍走云端 BI 的权限、预检、确认和审计，不需要给他服务器 SSH 权限，也不需要把云端 API Key 给他。

## 一句话流程

1. 安装 `Codex App`。
2. 安装 `Node.js 22+`。
3. 从负责人或已登录 BI 的 `/api/partner-cli/package` 取得当前受管 CLI 安装包并运行 `install.ps1`。
4. 安装完成后新开一个 Codex 任务，让新安装的 `shein-bi-ops` Skill 完整加载。
5. 用自己的 BI 账号登录一次。
6. 以后让 Codex 调用稳定启动器；每个业务命令前自动检查 CLI 与负责人规则更新。

> 普通合伙人不需要克隆完整 GitHub 项目。本文出现的 `node scripts/bi_ops_cli.mjs ...` 是维护者在完整仓库中的等价命令；受管安装用户统一改用 `& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" ...`。

## 你需要提前给他的东西

- 正式 BI 地址：`https://sa.dushengyi.cc/`
- 一个 BI 账号和密码。
  - 合伙人/管理员账号：可读全部店铺，可写全部店铺。
  - 普通运营账号：可读全部店铺，只能写自己负责的店铺。
- 当前受管 Partner CLI 安装包；普通合伙人不需要 GitHub 仓库权限。
- 只有参与开发的人才需要完整项目代码。不要把任何服务器密钥、OpenAPI Secret、AI Router Key 写进安装包、文档或聊天。

推荐直接给合伙人最小 CLI 包，而不是整个生产项目。负责人构建：

```powershell
npm run partner-cli:package
```

产物位于忽略目录 `outputs/releases/`，同时生成 `.sha256`。压缩包只包含远程 CLI、负责人规则校验模块、安装脚本和本说明，不包含 `.env`、session、店铺 profile、服务器脚本或任何凭证。

最小包保障 `login/doctor/me/capabilities/ask/chat/jobs/tasks/create/preflight/execute/audit/resolve`、本地 `plan-images`、同任务 `prepare-publish` 以及走云端的图片上传/转换。营销 CSV 候选生成、开发 smoke 等工具仍需要完整项目仓库，不作为合伙人日常必需能力。

## 电脑安装

### 1. 安装 Codex App

让他安装 Codex 桌面版，然后正常登录自己的 Codex 账号。

### 2. 安装 Node.js

安装 `Node.js 22` 或更高版本。

安装好后，在电脑终端里检查：

```powershell
node -v
```

如果能看到 `v22.x.x` 或更高版本，就可以继续。

### 3. 安装受管 CLI

解压当前安装包后，在包目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装器会检查 Node.js 22，把版本化文件装到 `%USERPROFILE%\.shein-bi\cli\versions\`，生成稳定启动器 `%USERPROFILE%\.shein-bi\cli\shein-bi-ops.cmd`，并安装专用 Codex Skill 到 `%USERPROFILE%\.codex\skills\shein-bi-ops\SKILL.md`。`2026.07.13.1` 是自动更新引导版：从更早版本升级到它仍需最后运行一次新安装包；安装后每个业务命令会先检查云端 release，逐文件与 bundle SHA256 校验通过后原子切换版本并重启同一命令，旧版本目录保留用于回滚。

安装后统一让 Codex 调用稳定启动器，不要继续运行解压目录里的旧副本：

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" version
```

安装或升级 Skill 后必须新开一个 Codex 任务；旧任务不会完整重载新 Skill。只有维护/开发项目本身时才把完整仓库放到固定目录并在 Codex 中打开。

## 首次登录 BI 自动运营

受管安装用户运行：

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" login --username 他的BI账号
```

然后按提示输入密码。

登录成功后，本机会保存一个云端登录会话，默认位置：

- Windows：`C:\Users\<用户名>\.shein-bi\ops-session.json`
- macOS/Linux：`~/.shein-bi/ops-session.json`

这个文件只保存登录会话，不保存明文密码。

如果需要确认当前登录的是谁：

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" me
```

如果需要退出登录：

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" logout
```

## 网页与 Owner CLI 的当前分工（2026-07-12）

- 普通团队成员直接使用 BI 网页自动运营；服务端按登录账号、owner 和店铺读写范围隔离任务、会话与作业。
- Owner/合伙人保留 CLI，用于更明确的诊断、批量编排和审计；不能借 CLI 绕过店铺权限、预检、人工确认或 SHEIN 回读。
- 常用会话/作业命令：

```powershell
node scripts/bi_ops_cli.mjs chat --text "把 DX 的 PA4-6L 库存改成 30" --wait-seconds 120
node scripts/bi_ops_cli.mjs jobs --status running
node scripts/bi_ops_cli.mjs job --job-id <作业ID>
node scripts/bi_ops_cli.mjs wait-job --job-id <作业ID> --wait-seconds 120
node scripts/bi_ops_cli.mjs jobs --scope-all  # 仅 Owner 全局只读
```

- `--profile fast|balanced|deep|owner` 只改变理解深度。默认分层是 Luna low 20 秒、Terra low 45 秒、Terra medium 90 秒、Sol high 300 秒、Owner Sol high 600 秒；`xhigh` 只在 Owner 人工明确要求时使用，网页不启用 max/ultra。
- 后台 `intent_plan` job 只补全店铺、商品、参数、歧义和风险，不直接授权或提交 SHEIN。终态为 `succeeded`、`failed` 或 `uncertain_write`；后两者先看详情，不要重复创建动作。
- 飞书问数已主动暂停，生产 `shein-bi-lark-sales-qa.service` 必须保持 `disabled + inactive`；团队网页和 Owner CLI 不依赖它。
- Owner CLI 的经营问数读取云端 BI section，不依赖伙伴电脑里的完整项目或本地 V3 报表。近 7 天链接多条件筛选（曝光、点击率、销量）由服务端确定性计算：点击率按 `c7_goods_uv / c7_eps_uv` 重算，支持全部 19 店和按店筛选；链接 section 与小时级销售 core 代次不同时，只要双方声明的链接业务日期完全一致即可读取，不能把正常的日更链接数据误判为缺报表。不得误路由为“今日销售额”，也不得把“不要读取认证信息”这种安全约束误判为索取凭据。

### 负责人规则如何传给团队

- 负责人继续在自己的 Codex Desktop/CLI 或本人 BI 账号中工作；本机文件变化采用事件驱动采集，active 规则经脱敏和校验后同时进入云端 PostgreSQL 与 GitHub `owner-knowledge` 分支，无需手工复制给每位同事。
- 同事只需要使用网页。系统会按当前店铺、商品和动作选取相关 active 规则，不会在页面展示“规则包 v…”之类内部版本信息。
- 合伙人使用 CLI 时，每个云端业务命令开始前会自动检查规则 manifest；未变化只返回 304，有变化才在带心跳和进程存活校验的本机文件锁内下载到不可变 generation，写前拒绝旧版本、校验后原子切换缓存指针。即使两个 CLI 同时启动或旧网络请求长时间挂起，旧响应也不能覆盖/删除新规则。合伙人不需要 GitHub 账号、deploy key 或负责人设备 token。
- 同事会话中的补充只影响其当前会话/任务，不能生成、修改或覆盖负责人长期规则；即使账号角色同为 owner，没有 `knowledgePublisher=true` 也无发布权。
- candidate 只用于负责人后续复核，不参与团队真实业务。规则变化发生在预演之后时，系统会要求重新检查和再次确认，不能沿用旧结果直接写 SHEIN。
- 负责人本机安装、状态检查和设备轮换见 `docs/owner-knowledge-sync.md`；同事机器不要安装同步任务，也不要复制负责人设备凭证。

规则包与 CLI 程序版本是两件事：规则包每个任务前自动检查；受管 CLI 在业务命令开始前检查程序 release。发现新版本时先完成哈希校验、不可变版本目录安装和原子指针切换，再用新版本重启原命令；不会 60 秒轮询，也不会在 SHEIN 写入过程中替换代码。云端仍可声明最低版本，更新失败时会在业务动作前停住。

## 安装后自检

先跑一键自检：

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" doctor
```

确认负责人规则已同步到本机缓存：

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" knowledge-status
```

缓存位置为 `%USERPROFILE%\.shein-bi\owner-knowledge`。`manifest.json` 指向 `generations/<bundleSha256>/bundle.json`；这里只保存脱敏规则包和 GitHub source commit，不包含负责人原始会话、来源路径或发布凭证。

`doctor` 只做本机和云端只读检查，不创建任务、不预检、不执行 SHEIN 写操作。它会检查：

- 本机 `Node.js` 版本是否满足建议要求；
- 本机会话文件是否存在，且没有保存明文密码；
- 当前 BI 登录账号是谁、角色是什么、能写哪些店；
- 云端 OpenAPI 能力总账能否访问；
- 负责人规则 manifest/bundle 是否可读取、hash 是否匹配、CLI 是否达到最低版本；
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
- 批量下架弱链接前必须先出只读明细让用户确认。低曝光零销量候选统一按“已上架 + 近 7 天曝光 `<=300` + 近 7 天销量 `0` + 无平台新品标签 + 首次上架已满 15 天 + 最近库存恢复/重新在售已满 15 天”筛选。恢复日期优先按每日库存从 `0` 变为正数判断，其次读取最近 60 天售罄/下架到在售的状态跃迁，OpenAPI `last_shelf_time` 只作兜底；营销活动刚成功反而属于恢复期保护佐证。首次上架或最近恢复 15 天内的链接一律不进入下架执行清单，缺初次上架时间或恢复证据链不完整时只能放入待确认/不执行。用户确认后才可用 `retire_link` 下架，并尽力把货号改成 `（废）标准货号`；如果改废货号被平台 `partialEdit` 校验卡住，结果按“已下架但货号未改”汇总，不再为了货号阻断下架。
- 维护类适配器使用官方文档：商品上下架 `3001253 /open-api/goods/modify-skc-shelf`（`activate_link` 使用 `shelf_state=1`，`retire_link` 使用 `shelf_state=2`），库存 `3001738 /open-api/stock/change-inventory/v2`，供货价 `3001681 /open-api/goods/update-cost`，售价 `3001407 /open-api/openapi-business-backend/product/price/save`，局部编辑 `3001810 /open-api/goods/product/partialEdit`；证书/资质包含 `3001477 /open-api/goods/save-or-update-certificate-pool`、`3001183 /open-api/goods/save-certificate-pool-skc-bind` 等证书接口。网页端 `update_images` 不能要求普通员工手写 `partialEdit` JSON：用户上传图片后，系统应在聊天里展示 AI 排序和资料缺口，再由执行层转换成 SHEIN 需要的图片 URL 与 `partialEdit` 字段；若转换不完整，任务停在资料检查。CLI/脚本仍可传完整结构化 payload 做管理员验收。`certificate_review` 要求提供 `certificatePayloads[{endpoint,body}]`，提交后默认人工核销审核状态。
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

每次 `chat/create/preflight/execute/prepare-publish` 等业务命令会先检查 CLI release，再执行轻量规则检查。release 和规则都支持 ETag；无变化只返回 304，不拉整仓库，也不产生模型 Token。`execute` 发现云端 active bundle 尚未同步到 GitHub 时会暂时停住，稍后重试即可。

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

[https://sa.dushengyi.cc/](https://sa.dushengyi.cc/)

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

### 上新或换图要上传图片

网页端的目标体验是直接在当前自动运营会话上传图片，然后继续用自然语言沟通：

- 新链接或复制上品需要重新配图时，上传图片后系统应把文件挂到当前会话资料，并尝试判断图片用途。
- 本地图包可以是 14 张、15 张或少于 14 张；这不是异常。路径任一层包含 `备用` / `backup` / `bak` 的图片不要用；文件名包含 `产品封面` / `AB测试` 的图只作为 AB 测试素材，默认忽略不提交。
- 前端角色按用户语言理解：`细节图11` 的第 1 张才是主图，放主封面；单独 `轮播图` 不是主图，而是主封面之外最好看的第二封面；方形图使用 1:1 图；其他细节图最多 10 张，排序为先卖点、再参数、最后场景；不足 10 张就有多少放多少，不强行补满。
- SKU 图不是必填兜底位。扣除主封面、方形图和单独轮播/第二封面后，如果其他候选图超过 10 张，才把最低优先级的高清图放到 SKU 图；否则 SKU 图不提交。SKU 图禁止使用 `sku-80` / `80x80` 等裁切小图。
- AI 可以根据图片内容给出排序建议、重复图/低质图/错品风险提示；用户可以继续说“把第 3 张做主图”“第 5 张不要”“细节图 2 和 6 交换”。图片理解不能替代商品事实：AI 不得根据图片发明不存在的功率、认证、配件或功能；发现图片和链接资料冲突时必须停下来提示。
- 本地 CLI 可先做离线规划：`node scripts/bi_ops_cli.mjs plan-images --image-dir <图包路径> --out image-role-plan.json`。这个命令只扫描本地文件、排除备用/AB 测试封面并输出前端角色规划，不上传图片、不生成完整 `partialEdit`、不提交 SHEIN。
- 用户当轮明确指令和目录名含“已审可用”的人工审核结果高于 AI 语义推断。“某参数不进入最终标题/核心卖点”不等于“含该参数的已审图片禁用”；AI 可以提示，但不得擅自排除。只有文件损坏、格式/大小不支持、明确错品、平台角色/容量冲突或 SHEIN 真实校验失败可以阻断。
- 有本地图包的新发品不要逐张 `upload-pic` 后再新建缩写任务。应在原任务上运行：

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" prepare-publish --task-id <任务ID> --store JSH --image-dir '<已审可用目录>' --approved-assets --standard-goods-sn '(全)SK-999食品料理机' --supply-price 210 --inventory 100
```

该命令读取实际尺寸、按角色上传、把返回 URL 与货号/供货价/库存等显式事实绑定到同一任务，然后基于新 payload 重新预演。返回结果必须看到 `payloadSource=task`、图片数量/名称、方形图尺寸和新的 payload hash；它本身不真实发布。
- 真正提交 SHEIN 前，后台仍要把图片转成 SHEIN 可接受的图片 URL，先查官方图片方案，再把前端角色映射到 `partialEdit` / 发布 payload 的 SPU/SKC/SKU 层级。不同类目图片方案可能不同，不能把“轮播图/细节图/SKU 图”的前端叫法直接等同于固定 OpenAPI 字段。
- CLI / 执行器会在 `update_images` 的 dry-run 阶段检查图片 payload：SPU 层 `image_info` 必须搭配 `is_spu_pic=true`，SKC 图类型只能是 `1/2/5/6` 且主图唯一，细节图总数最多 11 张，SKU 图只能用 `image_type=1` 的高清主图；疑似 `sku-80` / `80x80` 裁切图会被阻断。`partialEdit` 返回成功并生成版本号，或后台任务已进入流转 / 待审核 / 审核中 / 待终审，即代表 SHEIN 已接收提交；后续是平台审核生命周期，不要当作“没提交”反复执行。最终当前态仍以审核完成后的回读或后台可见态为准。

### 任务显示“已提交待回读”或“需人工处理”

不要重复创建同一个真实写任务，也不要反复点执行。先到 SHEIN 后台确认真实状态，再由管理员用 `resolve` 人工核销；如果拿不准，就保留任务，不要强行关闭。

如果审计里出现 `suspicious_write_attempted`、`submittedPossibly=true` 或 `requiresManualResolve=true`，意思是系统在真实提交模式下无法确认 SHEIN 是否已经接收请求。此时必须按“可能已经提交”处理，不能重复执行。

如果审计里出现 `weak_match_only` 或 `weakMatchedCount > 0`，意思是只找到了平台 SKU、源 SKC 或货号文本这类弱证据；这不能证明新链接已经可靠生成，也需要人工确认后再核销。

**Q: 已下架但货号没改成`（废）...`怎么办？**
A: 用 `scripts/repair_retire_supplier_code_openapi.mjs` 在云端单独修复，只调 `partialEdit` 改货号，不影响已完成的下架状态。

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
node scripts/test_link_ops_image_role_planner.mjs
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
- `test_bi_ops_maintenance_executor_flow.mjs` 使用本地假 OpenAPI 服务验证维护写执行器：恢复上架、下架、库存、供货价、售价、改标题、换图、证书绑定完整 payload、dry-run hash 锁定、显式确认 execute、库存 + 商品回读；同时覆盖换图 payload 摘要和危险 SKU 小图阻断。它不会调用真实 SHEIN。
- `test_link_ops_image_role_planner.mjs` 使用临时本地图包验证离线图片角色规划：排除 `备用` 和 `产品封面` AB 测试图，识别主封面、第二封面、1:1 方形图，按卖点→参数→场景排序，容量不足时不硬凑 11 张，容量溢出时才分配高清 SKU 图。它不会上传图片或调用 SHEIN。
- `test_shein_openapi_doc_detail_parser.mjs` 使用离线 fixture 验证官方文档详情解析器，确保 `modify-skc-shelf` / `shelf_state` 这类维护写接口不会因为解析器变动而误判；它不访问外网、不需要登录态、不保存 Cookie。
- `test_bi_ops_maintenance_readiness.mjs` 验证维护写 readiness 检查器：缺证据时必须阻断，只有 schema 时只能到 `schema_ready`，只有 schema + 逐店权限 + 强回读三类脱敏证据都齐全时才会到 `pilot_ready`，且含 `secretKey/openKeyId/Cookie/token` 等敏感字段的证据会被拒绝。

## 2026-07-03 OpenAPI CLI 能力补充

以下命令均走本机受控 CLI，不保存 SHEIN 密钥，不打印 `openKeyId/secretKey`。默认 `dry-run` 不调用 SHEIN。

> 2026-07-03 边界更新：本机因 SHEIN OpenAPI 白名单/身份边界不能直连真实 OpenAPI。日常 `bi_ops_cli` 的真实上传、提交、回读必须走 `shein-bi-tencent` 云端；本机只做图包规划、payload/dry-run 和假接口 smoke。底层 `scripts/openapi_*_executor.mjs` 保留给云端运行和本地 fake OpenAPI 测试，不作为本机真实业务入口。
### 下架候选与货号修复

```powershell
# 生成下架候选明细（只读）
node scripts/bi_ops_cli.mjs retire-candidates --file <enriched-csv> --performance-date <YYYY-MM-DD>

# 云端执行已确认下架
node scripts/execute_retire_candidates_openapi.mjs --input <confirmed-candidates.json> --execute --confirm SHEIN_OPENAPI_SUBMIT

# 云端修复已下架但货号未改的链接
node scripts/repair_retire_supplier_code_openapi.mjs --input <repair-rows.json> --execute --confirm SHEIN_OPENAPI_SUBMIT
```

货号修复是独立流程，只调 `partialEdit`，不调 shelf 接口；修复失败不阻断已完成的下架。


### 图片和图包

```bash
node scripts/bi_ops_cli.mjs plan-images --image-dir <图片文件夹> --out roles.json
node scripts/bi_ops_cli.mjs upload-pic --store FY --image-type 2 --file <image.jpg> [--mode execute]
node scripts/bi_ops_cli.mjs transform-pic --store FY --image-type 2 --url <https://...> [--mode execute]
```

- `plan-images` 只做本地图包角色规划，不上传、不提交；备用目录和文件名含“产品封面/AB测试”的图不提交。
- `upload-pic` 是官方“本地图片上传”能力名称；通过 `bi_ops_cli --mode execute` 使用时会转交云端 BI 执行，不从当前 Windows 本机直连 SHEIN。
- `transform-pic` 是外链图片转换；通过 `bi_ops_cli --mode execute` 使用时同样转交云端 BI 执行。

### 商品只读/回读能力

```bash
node scripts/bi_ops_cli.mjs audit-status --store FY --spu <SPU> [--mode execute]
node scripts/bi_ops_cli.mjs search-product --store FY --product <商家货号> [--mode execute]
node scripts/bi_ops_cli.mjs publish-standard --store FY --category <末级分类ID> [--mode execute]
node scripts/bi_ops_cli.mjs shelf-quota --store FY [--mode execute]
```

这些命令的真实回读必须在云端执行器里跑；本机 `bi_ops_cli` 不再允许用 `--openapi-config --mode execute` 直连 SHEIN。若要做本地开发验证，只能连 fake OpenAPI。

### 高风险订单履约

```bash
# 第一步：dry-run，拿 payloadHash
node scripts/bi_ops_cli.mjs order-fulfillment --operation export-address --store FY --order-no <订单号>

# 第二步：确认 hash 后才允许真实 execute
node scripts/bi_ops_cli.mjs order-fulfillment --operation export-address --store FY --order-no <订单号> \
  --mode execute --confirm SHEIN_ORDER_FULFILLMENT_SUBMIT --payload-hash <dry-run输出的payloadHash>
```

`order-fulfillment` 覆盖 `export-address`、`import-express`、`place-express-order`、`print-express-info`。这是高风险入口：真实 execute 必须在云端边界内，同时满足确认文本、payload hash 和店铺身份探针；本机不允许直连真实履约接口。

### 目录驱动兜底调用

```bash
node scripts/bi_ops_cli.mjs openapi-call --doc-id <docId> --store FY --body-json '{}'
```

`openapi-call` 读取 `outputs/shein-openapi-doc-catalog/official-capabilities.latest.json`，用于官方 JSON OpenAPI 的兜底 dry-run/受控 execute。真实 execute 只能在云端边界内使用：

- 只读接口：execute 前校验店铺身份。
- 写接口：execute 必须 `--confirm SHEIN_OPENAPI_GENERIC_WRITE_SUBMIT` + `--payload-hash <dry-run hash>`。
- multipart/file 接口和 WebHook 会被阻断，必须走专用适配器或 WebHook receiver。

### WebHook

运行说明见 `docs/shein-webhook-receiver-design.md`。接收端、密文队列、异步 worker 和 BI“平台动态”子页面已实现；真实事件是否开始进入，以各 SHEIN App 的回调订阅/审核状态为准。普通动态只在 BI 展示，飞书仅接收 P0 摘要；飞书不是事件事实源，已暂停的问数服务也不因此恢复。
