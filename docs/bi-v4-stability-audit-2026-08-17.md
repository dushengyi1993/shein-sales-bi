# BI 自动运营系统 V4 稳定性审计与整改报告

日期：2026-08-17（Asia/Shanghai）
审计范围：BI Portal、只读 CLI、Webhook/实时刷新、section 队列、systemd 定时任务、Codex heartbeat、浏览器 profile、Git/CI/Release/部署链。
生产基线：Release `2026.08.17.6`，commit `0c3f40862463272fc4c4d41b2bc30f7c144e9792`。

## 1. 结论

这不是单一模型、单一接口或单次误操作造成的故障，也不能概括成“DeepSeek 不可靠”。根因是五类问题叠加：

1. Portal 是超大单进程，页面、只读 CLI、Link Ops、知识分发、Webhook 对账、缓存生成和后台 worker 共用进程、堆和发布节奏；任一重任务都能扩大故障面。
2. section 队列虽然后来增加了 warmup 幂等键，但页面 cache-miss、自动重试和部分实时事件仍走无键 enqueue，长任务每次完成都可能被新 revision 作废。
3. tracked source 与 profile、outputs、state 曾通过可写 bind mount 交叉暴露；一次 root 级错误清理可以穿过应用目录删除登录态。没有可验证的 profile 恢复备份，使误删直接变成重新登录。
4. CI、版本边界、Tag、Release 和部署终验不是一个可恢复事务；PR 绿灯、当前 push 绿灯、发布资产和生产 commit 之间曾存在可以漂移的缝隙。
5. systemd timer、Codex heartbeat、Windows 任务和守护提示词缺少同一个维护总闸与唯一 owner；部分提示词还硬编码执行模型或旧任务类型，导致规则互相覆盖。

模型可以放大或缩小实现质量，但不能解释 profile 被 root 清理、V8 OOM、队列 revision 追逐、Release 半写入和多个调度源冲突。最终责任在架构边界、变更治理和主任务验收，不应归咎给某一个子代理。

## 2. 已核实的直接证据

### 2.1 Portal OOM 不是偶发网络问题

- 2026-08-14 事故时核心 `data.json` 为 `210,748,631` bytes。
- Portal 在 V8 heap 约 `1535.5 MB` 时 OOM；单纯把 `NODE_OPTIONS` 提到 `1536 MB` 后仍复发。
- 旧路径对整个文件执行 `readFile + JSON.parse + overlay + JSON.stringify/gzip`，内存放大远高于文件本身。
- PR #84 / Release `2026.08.14.7` 后改为有界流式 core；PR #86 / Release `2026.08.14.8` 固定正式 API section mode。它们修掉了当时的直接 OOM/400 条件，但没有拆掉 Portal 的职责耦合。

### 2.2 当前“表格有数、顶部仍不可用”的真实状态

2026-08-17 13:26 CST 生产只读回读：

- `/api/bi/section/homeRankings` 与 `homeProfit` 已不是 HTTP 400，而是 HTTP 202，表示当前 generation 尚未生成完成。
- `afterSales`、`homeTrafficDaily`、`priceScatter` 返回 HTTP 200，但带 stale section 头，页面展示的是旧缓存，不是当前 generation。
- `state/portal-section-queue/queue.json` 中：
  - `profit.requestRevision=1459`、`claimedRevision=1175`、`attempts=35`；
  - `homeProfit.requestRevision=1399`；
  - `profit.lastError="complete superseded by requestRevision=1176"`。
- `portal-sections.latest.json` 为 `deferred`，原因是 `host_heavy_unavailable:resource_pressure`。

代码原因位于 `scripts/serve_bi_portal.mjs`：warmup 批量路径传了 generation 幂等键，但 `enqueueHostLockedBiSection()` 没有向队列管理器传 `--idempotency-key`。浏览器 cache-miss、重试、empty-cache 和 homeProfit 依赖请求因此仍会改写一个已有 keyed entry。长时间 `profit` 构建只要期间再来一次页面重试，完成结果就被判为 superseded，形成可重复的活锁。

这解释了为什么“之前明明修过”：前一次只覆盖 warmup 入口，没有覆盖所有 enqueue 入口，测试也没有模拟长 worker 与高频页面重试同时发生。

### 2.3 profile 丢失是误删与存储拓扑共同造成

- 历史执行审计记录确认：一次 root SSH 清理命令发生错误展开，删除范围穿过应用目录内的可写 bind mount，触及 profile/运行态，不是 Chrome 自己随机清空密码。
- 当时应用目录同时承载 tracked source 和可写 `profiles` / `outputs` 入口，扩大了错误清理的爆炸半径。
- 生产当前 `/data/shein-bi/profiles` 约 `5.5 GB`、20 个 profile；排除 cache/model/log 后，需保护的 profile/session 约 `2.4 GB`。
- 旧数据库备份没有把 profile、Cookie、Login Data、Local State 和 WebAPI session 纳入可验证恢复演练，因此发生删除后只能逐店重登。

### 2.4 Git 历史显示修复密度过高、发布边界过细

仅 2026-08-16 至 2026-08-17，`main` 连续合并多条 Portal、库存、Link Ops、晨间链和 CLI 修复；Portal 又在 PR #108、#110 连续修改 warmup queue owner 和幂等键。高频小修不是原罪，但在以下条件下会变成回归放大器：

- 单个 Portal 文件超过万行，多个职责共享一套启动/关闭流程；
- 全量确定性测试串行运行，最长单测约 20 分钟，失败反馈慢；
- PR CI、main push CI 和源码发布没有统一终态 gate；
- 生产部署完成定义未始终绑定同一 commit、同一 CI attempt 和终态回读。

### 2.5 GitHub Release 当前并非不可变事实源

2026-08-17 GitHub API 只读核验：

- 私有仓库当前套餐不能启用 repository ruleset；
- 最近源码 Release 返回 `immutable:false`；
- 因而“attestation JSON + 同目录 SHA256 文件”只能发现传输损坏，不能防止两者一起被替换。

源码发布必须使用可恢复 draft 状态机，并把 attestation 摘要绑定进 annotated tag；部署时还要独立回读 Tag peeled commit、main push CI run/attempt、Release 终态和生产 commit，不能只信可替换资产。

本轮整改把不可变发布设为硬门而非可选加固：trust policy 强制 `requireImmutableReleases=true` 与 `requireOwnerEnforcement=true`；发布前须串行启用/确认 GitHub immutable releases policy，并权威 GET 回读 `enabled=true` 且 `enforced_by_owner=true`，不能只信 mutation 响应；创建/确认的正式 Release 终态必须 `immutable=true`。源码 attestation 升级为 schema v3（绑定 repository id、trust policy SHA-256、exact CI attempt 的 job count/jobs SHA-256），生产 deployment marker 只看 schema v3 的 `shein-bi-deployed-release/v3`，v2 仅迁移读取兼容、不满足终态。

最终审查质疑 watchdog 只复验本地 attestation/tag cache、没有每轮联网重验 GitHub。复核 [GitHub 官方 immutable Release 语义](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) 后不把它列为缺陷：正式 Release 存在期间，关联 tag 被锁定到特定 commit，不能移动或删除；即使管理员删除 Release 后再删除 tag，同名 tag 也不能复用。因此“tag 静默改指向另一 commit、watchdog 无感”的反例不成立。发布与部署门仍必须每次 fresh 回读 GitHub；日常 watchdog 则只核验当前运行字节、本地 annotated tag、固定 attestation 与 marker，避免 GitHub/token 故障反向把健康生产判死。管理员主动撤回 Release 属于远端审计事件，会在下一次发布/部署门 fail closed，不冒充当前运行字节漂移。

### 2.6 自动化存在真实规则冲突

整改前：

- 四个业务 heartbeat 已人工暂停，但 OpenCodex 守护提示词硬编码“四个业务巡检必须 ACTIVE”，存在自动反向恢复风险。
- 三个业务 heartbeat 提示词硬编码 DeepSeek，不能按当前用户要求或全局配置动态选择。
- 淘汰链接实际是 heartbeat，提示词却仍自称 standalone Scheduled 任务。
- 业务 heartbeat 没有统一读取云端维护 marker，systemd timer、heartbeat 与本机任务无法共享停机事实。

这类冲突不是“规则写了模型不听”，而是不同规则各自都能成立、却没有更高层的唯一状态机。

### 2.7 审查又发现六个“测试绿但生命周期仍不闭合”的缺口

首轮独立对抗审查没有把单测通过当成完成，又找出并复核了六处高风险缺口：

1. Query 超时响应曾先释放并发槽，但底层非协作任务仍可能继续占 CPU/内存；现改为槽位一直持有到任务真正 settle，超过 30 秒 grace 就以 exit 70 终止 Query 进程，由 systemd 单独重启，不拖 Portal。
2. deployment marker 曾能只凭自身字段“自证”；现在 snapshot/watchdog 每次都重读固定 Release attestation 目录、checksum、annotated tag object/message/peeled commit，marker 与本地证明任一漂移都失败。
3. 维护 marker 曾可能在 guard 未完整安装时写入，watchdog 还可能因 marker 而静默隐藏 guard 漂移；现在 `pause` 不只审计 23 个磁盘文件，还要求 `systemctl show` 精确回读 daemon-reload 后的全部有效 `ExecCondition`，guard 审计失败时绝不进入维护抑制。
4. runtime namespace 曾只检查仓库模板；现在 snapshot/watchdog 回读全部 28 个 service 的有效 `RequiresMountsFor`、`BindPaths`、`BindReadOnlyPaths`、`ReadOnlyPaths`、`InaccessiblePaths` 和 `ExecCondition`。
5. 迁移指纹曾只覆盖路径/内容/部分 mode；现在使用确定性 GNU tar 流覆盖 mtime、numeric uid/gid、ACL、全部 xattr（含 capability）、symlink 与 hard-link topology，并对任何 tar warning fail closed；只有读取会改变的 atime/ctime 被排除。
6. Partner CLI 同版本修复曾有 `rm + rename` 掉电窗口，且启动器和更新器并发恢复或连续两次掉电时可能误删唯一好副本；现在两者共享可恢复 ticket lock，票据记录 Linux 进程出生身份；可信存活 owner 永不因心跳停滞/age/mtime 被回收，死 PID 或 PID 出生身份复用立即回收，legacy/malformed 票据仅在超龄后回收，旧 `.tmp/.bak` 证据只在新 canonical root 完整 hash 复验后清理。

这些缺口说明过去的主要问题不是“有没有写测试”，而是测试只覆盖正常返回，没有覆盖超时后仍运行、证明自引用、有效 systemd 配置漂移、元数据损失、掉电和并发恢复。

Query 大响应随后又按真实响应路径完成了有界性复核：独立 120 秒测试实例在 `--max-old-space-size=128` 下，以同一 `Readable → gzip → pipeline` 返回 `30,270,786` bytes 原始 JSON 和 `1,654,191` bytes gzip；identity/gzip 解码后的完整业务响应一致，首末行精确，`gzipSyncUsed=false`。采样结果为 baseline RSS `134.17 MB`、baseline heap `50.01 MB`、额外 peak heap `42.52 MB`、额外 peak external `6.81 MB`、额外 peak max RSS `134.94 MB`，证明响应没有再持有一份约 30 MB 的完整 JSON Buffer。客户端中途断线后 lane 会释放；非协作任务则继续占槽直到 grace 到期并 exit 70，重启后 Query 恢复，且全过程不拖 Portal。

第二轮独立对抗审查又拦住五个边界缺口，均已加入判别测试：daemon-reload 失败后仅有磁盘 guard 不能进入维护；有效 `ExecCondition` 必须是唯一一条精确命令，附加 `/bin/false` 也算漂移；合法旧票据即使 PID 已被复用也不能永久阻塞 CLI；加密归档在 hard-link 发布后的任何报错必须撤销本次正式输出；认证 uid/gid 不接受 POSIX `chown(-1)` 哨兵，且 chown 后必须精确 `lstat` 回读。

冻结前的完整 Link Ops 长流程又暴露了一个“平台写入已落盘、HTTP 却未返回任务”的事故模型：测试保留现场显示任务实际已经是 `done/submitted_readback_matched`，但请求在结果落盘之后的整库投影/外部审计阶段抛错。旧客户端看到通用 500 后可能盲重试；同时，非描述维护动作没有持久 write-claim，Portal 进程若在调用 SHEIN 后、任务结果落盘前崩溃，重启后无法证明上次是否已写。这不是测试噪声，而是典型 post-commit ambiguity。

现已统一收口：发品和九类维护动作都在真实执行前以单任务 repository CAS 落盘精确 claim；维护真实提交只能单店串行，子执行器必须逐项匹配 nonce、taskId、store、state、operations 和 payload hash。写后结果不再整库替换，只做单任务 CAS；adapter 在原子提交后抛错时，仅 exact `repositoryRevision + repositoryPayloadHash` 可恢复为 committed。API 只返回本次任务，外部审计失败明确标记 `auditPending`，终态/已有提交证据的任务返回 409，不能再次调用平台写接口。执行器和 Portal 集成测试均包含“无 claim 不写”、post-commit 注入、审计失败、局部响应和终态二次提交判别。

同一轮复核还发现维护执行器把“商品查询仍能找到该链接”当成了标题、价格、上下架或图片修改成功的回读证明。身份存在不能证明目标字段已改变，这会产生 `submitted_readback_matched` 假阳性。现已取消该弱证明：库存仍以 SKU 库存精确值回读，描述仍以逐语言 hash + 提交版本/审核状态回读，待审核纠图仍以 exact document version/state 回读；其他维护动作在没有 operation-specific 精确字段证据前只记录 identity probe，保持 `submitted_readback_failed` 与 unconfirmed claim，必须人工核销，绝不报“回读成功”。

完整分片复跑还实际触发了测试间污染：多个 Link Ops 集成测试直接在仓库全局 `outputs/shein_links*` 和 `outputs/shein_openapi_products` 写/删同名 source fixture；当长属性流与发品 smoke 并行时，后者的 cleanup 会删除前者尚在使用的源详情，造成 step-2 随机 blocked。这类共享可变测试状态也是过去“单跑正常、组合就失败”的直接原因。现已把 mapper 数据根改为可注入 `SHEIN_BI_OUTPUT_DIR`，所有相关测试使用各自 `tmpRoot/outputs`，并加入源码 hygiene 断言禁止测试重新写回全局 SHEIN fixture 根。

冻结前的最终 shutdown 审查又构造出一个此前测试没有覆盖的 keep-alive 竞态：请求在 shutdown 开始时仍 active，50 ms 后完成并转为 idle；Node 24.15.0 的初始 `server.close()` / `closeIdleConnections()` 只清理关停瞬间已 idle 的连接，原实现因此等待完整 `keepAliveTimeout=5000 ms`，在 `5013 ms` 才 forced close 并返回失败。现已在 admission 关闭时把在途响应切为 `Connection: close`，并在响应 settle 后重新清理 active-to-idle 连接；同一确定性反例为 `67 ms`、`forced=false`，原有挂死请求超时与 worker→store 顺序断言仍通过。

候选冻结主审又补齐三处并发/恢复边界。第一，section integrity 缺失或失配时会扫描、hash 并重建 gzip/sidecar；原并发上限没有在重验证真正开始前完成准入，突发的不同 section 可以同时进入重 I/O。现改为进程级 FIFO 准入：不同事实 key 先排队再启动，同 key（包括已排队）共享同一个 Promise，成功或失败都会释放槽位，非法并发配置直接失败而不是永久排队。第二，HTTP drain 与 worker/bridge drain 过去存在串行依赖，HTTP 卡死可能把 worker 的实际收口挤出总预算；现在二者在同一 deadline 内并发执行，store 只有在两边都成功后才关闭，且 executor child 在 SIGTERM→SIGKILL 后仍有有界、保持进程存活的最终 settle 证据，永不 close 的 child 也只能返回明确的 ambiguous failure。第三，Profile restore 的失败清理曾存在“先 `lstat` 证明 staging、再按路径递归删除”的 TOCTOU 窗口；现在 Linux 发布绑定父目录 fd 与 staging dev:ino，只允许 `renameat2(RENAME_NOREPLACE)`，父目录 fsync 必须精确返回 `ok`。任意 restore 失败都保留 captured staging，竞争 destination、替换 staging 和已发布 destination 均不递归删除；fsync unsupported/error 被报告为“已发布但耐久性未确认”，强制人工核验。

### 2.8 冻结审查发现维护总闸存在跨身份权限缺陷

候选原先仍把 canonical marker 放在旧 runtime 维护目录。生产中的 `pause` 由 root 执行时，受 root umask 与父目录权限影响，marker 会成为 `root:root 0600`，维护目录也可能是 `0750`；而 systemd `ExecCondition`、runtime snapshot 与 watchdog 大多随业务 service 以 `User=sheinops` 执行。结果不是安全阻断，而是合法 marker 对业务身份不可读：guard 返回 `MAINTENANCE_MARKER_UNREADABLE` / exit 64，systemd 映射为 255，维护结束后业务 timer 仍可能被永久挡住。

最终契约将唯一 canonical marker 固定到 `/var/lib/shein-bi-control/cloud-maintenance.json`：`/`、`/var`、`/var/lib` 与控制目录都必须由 root 持有且 group/world 不可写，控制目录精确为 `root:root 0755`，marker 精确为 `root:root 0644`、regular、非 symlink、`nlink=1`。canonical mutation 只允许 uid 0；临时文件在 rename 前显式 `fchmod`/`fchown` 并用已打开 handle 回读，读取优先 `O_NOFOLLOW`，不依赖 umask 或 path-based `lstat` 后再重开。canonical orphan lock 不做自动 stale recovery，避免判死后到 rename 之间误搬新 owner；marker 提交后必须按完整字节 SHA-256 回读，锁清理无法确认则显式失败并要求先读 marker/锁再决定后续。首次部署必须先排除旧路径 active marker 的 split-brain，再安装并回读 guards，最后分别以 root 与 `sheinops` 验证同一 generation/hash；任一步失败都保持人工冻结，不能恢复自动化。

### 2.9 最终主审补齐四个小窗口

最后逐行复核没有把既有长测试绿灯当作冻结，继续补齐四个可确定复现的边界：

1. Partner CLI 的 `current.json`、`update-state.json` 和 `.verified.json` 在 Windows `EPERM/EEXIST` fallback 中仍曾先把 live 文件移到随机 `.bak`，再把 temp 移入；掉电会留下 canonical 文件缺失。现统一为同路径原子替换重试，持续失败则保留旧文件并失败关闭，绝不 move-away。新增持续 `EPERM` 反例证明旧 pointer 字节不变、无 `.bak`、旧 CLI 仍可启动，下一次更新可恢复。
2. Portal 聊天真实执行的通用 catch 曾无条件说“让我重试”。若平台写后发生 repository CAS 冲突，这会诱导重复写。现统一说明“是否已提交不能凭报错判断”，要求先回读任务与 SHEIN 平台状态，并在存在提交锁/证据时人工核销。
3. watchdog 虽已有持久 outbox 和稳定幂等键，但本地 alert/maintenance state 仍是未 fsync 的临时文件 rename。现复用同目录、文件 fsync、rename、目录 fsync 的原子发布器，保证外部发送前持久化的 delivery key 经进程/主机故障后仍可复用。
4. 数据库备份最终目录发布曾使用普通 `mv source destination`；若同秒目标目录已存在，GNU `mv` 可能把 staging 嵌入目标目录。现发布前拒绝 final collision，使用 `mv -T`，并按 dev:ino 回读确认 final 正是 staging inode。

主审中一度尝试把 `ctime` 纳入 deployment marker 的跨重命名 CAS；Windows 反例立即证明合法 rename 会改变 `ctime`，导致错误恢复旧 marker。该候选未保留：`ctime` 只用于同一打开文件读取期的篡改检测，跨 rename CAS 仍使用稳定 dev/ino/size/mtime 身份。

### 2.10 不可变发布门暴露 Partner CLI 发布顺序反转

源码冻结前对 GitHub 官方 immutable Release 语义做交叉检查时，发现既有 Partner CLI 工作流由 `release: published` 触发，却在 Release 已发布后才构建并上传 ZIP/SHA256。旧仓库尚未启用 immutable policy 时这条链偶尔能跑通；一旦按本轮设计启用不可变发布，GitHub 会拒绝发布后的资产 mutation，工作流必然失败。这不是 DeepSeek 或 CLI 命令本身的问题，而是发布状态机顺序与平台约束直接矛盾，也解释了为什么“上个包/链接”会在发布阶段反复补洞。

现已删除自动 published 触发，改为唯一的 manual draft-first 链：输入 exact `tag + expected_commit`，先验证部署凭据、当前 main、annotated tag、manifest、同 SHA main-push CI 与 owner-enforced immutable policy；只在 draft 中构建、上传并逐字节下载回读两份资产，发布前再 fresh 复验全部事实，只发一次 publish PATCH。PATCH 结果不明时只轮询权威终态，不自动重发。当前 main 的自动化 checkout 与 tag 对应的 release-source checkout 已分离：draft 仍必须等于当前 main；已发布且 `immutable=true` 的版本即使 main 后续前进，也能按原 exact commit 只读复验资产并幂等部署，绝不上传、覆盖或删除资产。BI 部署前还会再次读取 main/tag/Release/CI/policy，部署后回读 managed version/source commit。静态契约与全部 Bash run block 语法已加入回归；最终效力仍以合并后的 GitHub Actions 与真实 draft 发布终验为准。

## 3. 为什么每次修复耗时很长、下次仍出问题

故障处理过去常沿着表象逐层补丁：502 就加 heap，400 就改 mode，缓存不新就加 warmup，warmup 重复就加一个幂等键，任务冲突就暂停某一个 timer。每个补丁可能局部正确，但没有同时验证：

- 所有生产入口是否都经过同一个 invariant；
- 失败、重跑、重启、force push、半发布和状态漂移是否可恢复；
- 浏览器、CLI、Portal、Webhook 是否共享故障域；
- 调度状态是否只有一个 owner；
- 生产终态是否与测试所验证的 exact generation / commit 相同。

因此修复时间主要消耗在重新发现遗漏入口、等待长串行测试、手工恢复运行态和多次生产回读，不是单纯“代码难写”。本轮还直接发现 `test_bi_ops_release_gate.mjs` 在自身几十项串行 smoke 之后再次串行执行整套 220+ 项 deterministic tests，而 CI 已另行运行四个 shard；这会重复 8 分钟迁移套件和约 20 分钟属性流。现已改为独立 release-gate job 唯一运行 `test_bi_ops_release_gate.mjs`，确定性登记测试每项只由所属 shard 执行一次，二者交集为零且不丢测试。

## 4. 本轮整改设计

| 领域 | 整改 | 验收重点 |
| --- | --- | --- |
| Portal | cache-miss、force、accounting、warmup 全部使用稳定且有界的事实身份；section integrity 重验证在重 I/O 前做 FIFO/keyed 准入；错误采用指数退避；HTTP 与 worker 在同一 deadline 并发 drain，清理 active-to-idle keep-alive | 高频重试不增长 revision；完整性突发不越过并发上限；长 worker 最终可完成；store 不早关；正常重启不误触 forced failure；无 SIGKILL 掩盖 |
| 只读 CLI | 独立 query-only 进程、端口、cgroup 和 Nginx 精确路由 | Portal OOM/重启不影响 query；query 进程无 worker/生成/写路由 |
| 维护总闸 | `/var/lib/shein-bi-control/cloud-maintenance.json` + CAS；root-only mutation、服务只读；每个已安装 service 有明确 class | owner/mode/symlink/hard-link/祖先路径异常均 fail closed；维护时 timer/manual start/heartbeat 都不能绕过 |
| 运行态存储 | host 只读 source 入口；按 unit 使用 `BindPaths=` 提供最小私有读写 namespace | root 清理 app 不能穿透 profile/outputs；迁移可审计、可回滚 |
| profile 备份 | profile + WebAPI session 流式 gzip、AES-256-GCM、逐文件 hash、numeric uid/gid、mode/mtime、完整 verify；Linux 父 fd + dev:ino 绑定的 no-replace 原子发布 | 不落明文 archive；create 先受资源上限；未认证归档不创建 staging；parent fsync 只接受 `ok`；失败保留 captured staging 且不删除竞争路径；真实恢复演练通过 |
| CLI 自更新 | version + bundle hash + 本地入口/文件完整性共同决定健康；启动器与更新器共享可恢复锁 | TTL/304/current/peer/掉电/并发恢复都不执行坏包或删除唯一好副本 |
| CI | source checks + 4 个确定性 shard + 独立 release-gate job + terminal gate；发布门不再嵌套重跑全套；可信历史基线阻止失败 push 洗白 | 确定性测试每项只在所属 shard 执行一次；release gate 只在独立 job 执行一次；二者无重叠且无测试丢失；多 commit、force/首推、失败后下一推均不能绕过版本门 |
| Release | 源码使用可恢复 tag→draft→assets→publish 状态机并绑定 CI attempt/tag attestation；Partner CLI 使用 annotated tag + draft→assets→single publish→BI deploy，已发布分支只读；两者正式 Release 均须 `immutable=true`，发布前权威回读 policy | 任一步失败可精确续跑；main/CI/Tag/Release/资产终态一致；不存在 published 后上传资产或重复触发部署 |
| 自动化 | 既有 ID/时间/会话不变；统一维护 gate；提示词不硬编码任务模型 | 不创建重复任务；维护期间保持 PAUSED；分阶段恢复 |

## 5. 当前完成边界

截至源码集成阶段：

- 已完成事故止血：业务 timer、四个业务 heartbeat、OpenCodex 守护均保持暂停；没有创建新 timer/automation/queue。
- 已修正五个 heartbeat 的维护语义和任务类型冲突，原 ID、时间、绑定会话保持不变。
- 已完成 Portal 全入口稳定幂等键、指数退避、section integrity FIFO/keyed 准入与有界关闭；58 秒真实 lease/高频重试、完整性准入先于重 I/O、HTTP 卡死时 worker 仍收口、永不 close child 的 SIGKILL 后最终 settle、active-to-idle keep-alive 正常关停、挂死请求强制终止及双 drain→store 门序回归均已通过，不再只覆盖 warmup 单入口。
- 已完成 Query `8791` 只读隔离面、Nginx 9 个精确路由、1+3 并发队列与独立 cgroup；Portal 重启时 Query PID/查询保持独立，写路由在 Query 上拒绝。约 30.27 MB 的 identity/gzip 响应已在 128 MB old-space 限额下通过逐字节完整性、首末行和有界内存验证；中途断线、非协作超时、exit 70 重启后的 lane 生命周期也已覆盖。受管 CLI 对 429 只在总预算内按 `Retry-After` 重试。
- 已完成 28-service/18-timer/1-path 维护 policy、CAS 总闸、systemd guard、死亡 lock owner 安全回收、watchdog 抑制/恢复合并，以及五个既有 heartbeat 提示词对账；未创建新调度源。
- 已完成 canonical runtime path policy、installer 与可回滚迁移器；systemd 255 临时探针证明 host RO + unit-private RW 可用。迁移 A-R 全故障注入已通过，指纹覆盖 mtime/mode/uid/gid/ACL/xattr/hard-link；正式生产迁移尚未执行。
- 已完成 encrypted profile/session backup、完整认证与空 staging restore 测试；create/verify/restore 共用条目、单文件、总字节、压缩比上限，认证 manifest 同时保存 numeric uid/gid 与 mode/mtime，避免 root 备份恢复成不可用的 root-owned Profile。Linux 恢复以绑定父目录 fd 的 `renameat2(RENAME_NOREPLACE)` 发布并要求 parent fsync=`ok`；任意失败保留 captured staging，绝不递归删除 destination 或被替换路径。Windows fail-closed 与 WSL Ubuntu root 真恢复已独立通过。数据库备份的 COS 归档改为逐成员类型/路径/内容校验，单归档总量显式上限为 8 GiB。生产密钥异机副本、真实备份和真实 staging restore 尚未执行。
- 已完成 Partner CLI 同版本自修复、五个发布中断点、连续两次 swap 前掉电、死锁/PID 复用票据恢复和启动器/更新器并发串行测试；发布工作流已由 published 后上传改为 manual draft-first，加入 exact main/CI/annotated tag/immutable policy、单次 publish、终态资产回读和部署前 fresh preflight 契约。已完成四分片 CI、源码 release 可恢复状态机、版本防回退，以及 attestation/annotated-tag/CI-bound 的生产 deployment marker v3（schema `shein-bi-deployed-release/v3`；v2 仅迁移读取兼容）。
- 已移除 Partner CLI JSON pointer/marker 的 move-away `.bak` fallback；持续 Windows 原子替换失败保留旧 pointer 字节和可启动旧版本。watchdog outbox 状态改为文件与目录 fsync 的原子发布；数据库备份 final 目录增加 collision 拒绝与 dev:ino 终态回读。
- 已完成 Link Ops 发品与全部维护真实写的持久 claim、单店串行、单任务 CAS 结果提交、post-commit 精确恢复、局部 HTTP 响应、审计 pending 和终态防重；直接执行器与 Portal 八类维护集成回归均已加入 claim 判别。
- 已修正聊天真实执行通用异常措辞：写后不确定状态绝不邀请重试，必须先回读并按提交证据人工核销。
- 已移除“商品仍存在即证明维护成功”的弱回读；只有库存、描述和待审核纠图当前具备 operation-specific 强回读，其余维护提交保持人工核销，不再假报成功。
- 已隔离所有 Link Ops source fixture 输出根；发品、源详情锁、live 标题和 mapper 专项可并行执行且互不清理，源码 hygiene 会阻断新的全局 fixture 写法。
- 冻结后完整 `npm test` 已终态 232/232 PASS、0 失败；同轮 source integrity 覆盖 619 个 JavaScript、281 个 JSON、50 个 shell 文件。此前四个确定性 shard、聚焦回归、Query 隔离、运行时有效配置回读、迁移 A-R、Partner CLI 包/发布链和非嵌套发布总门也均已通过；前两轮独立审查发现的问题已修并加入回归。仍需 exact-SHA GitHub CI、正式 Release 与生产终验，不能把本地全绿写成线上已完成。
- 尚未 commit、push、建 PR、发布或部署；生产仍是干净的 `2026.08.17.6`。

## 6. 发布与恢复的硬门

只有以下条件全部成立，才允许恢复自动化：

1. 本地聚焦测试、四分片全量 CI、独立对抗复核全部通过，无 skipped/partial 冒充成功。
2. PR 合并后，同一 SHA 的 main push CI 达到 completed + success；绑定 exact `run_id + run_attempt`。
3. Release draft、两类证明资产、annotated tag 和正式 Release 完成可恢复终态回读。
4. 生产从该 Release 精确部署，tracked source clean，release marker 与 commit 一致。
5. profile/session 加密备份完成 verify，并以 no-replace 原子发布真实恢复到全新 staging；parent fsync 精确为 `ok`，再逐文件核验。
6. runtime 路径迁移完成，host 入口只读，所有 unit 的私有读写权限与 policy 一致。
7. query-only、Portal、Webhook、watchdog 分别健康；Portal 重启/OOM 模拟不影响 CLI query。
8. 当前 generation 的五个受影响 section 全部终态 200、非 stale、无 pending、无 revision 追逐。
9. 完成浸泡观察，`NRestarts`、OOM、journal、队列 revision、业务 freshness 均无回退。
10. 先恢复只读巡检，再恢复依赖最少的 timer，最后恢复写链；每一步都做新鲜预检和终态回读。

任一条件缺失时，结论只能是“修复中/部分完成”，不能宣布系统已恢复。
