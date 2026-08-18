# SHEIN BI Ops 2026.08.17.7 源码发布说明

## 结论

本版本收口 2026-08-14 至 2026-08-17 的 Portal OOM/section 活锁、CLI 与 Portal 共故障域、运行态误删、调度冲突和发布证据断层。源码 Release 与生产部署是两个独立终态；本文不以 Tag 代替云端验收，生产事实以 schema v3 的 `shein-bi-deployed-release/v3`（v2 仅迁移读取兼容）、runtime snapshot、systemd/journal、数据库和业务 section 回读为准。

## 主要变更

- Portal：cache-miss、force、accounting、warmup 与 live event enqueue 全部使用稳定事实幂等键；warmup 指数退避；section integrity 重验证以进程级 FIFO/keyed limiter 在扫描/hash/gzip 前准入，不同事实 key 受硬并发上限、重复 key（含排队项）共享 Promise，非法上限直接拒绝；HTTP shutdown 在关闭 admission 后会把仍在途响应标为 `Connection: close`，并在响应从 active 转为 idle 时再次清理 keep-alive。HTTP drain 与 worker/bridge drain 在同一 deadline 并发执行，store 仅在两边成功后关闭；executor child 在 SIGTERM→SIGKILL 后仍有有界最终 settle，永不 close 时返回明确失败而不悬挂。错误提示不再把不可用 KPI 伪装成 0。
- Link Ops：发品及全部维护写动作（上下架、标题、描述、图片、库存、供货价、售价、证书）在子执行器获得 `execute=true` 前，必须先以单任务 repository CAS 持久化精确 store/operations/payload-hash/nonce claim；维护真实提交强制单店串行，子执行器逐项重验 claim，缺失或漂移时不调用 SHEIN。执行结果只做单任务 CAS，写后异常按 exact revision + repository payload hash 恢复；已提交/终态任务拒绝盲重试。HTTP 返回只带本次任务，外部审计暂时失败会明确返回 committed + audit-pending，不再把已提交写入伪装成可重试 500；旧 Portal UI 会将局部任务响应合并回本地列表。库存、描述和待审核纠图保留 operation-specific 强回读；其他维护动作不能再用“商品身份仍存在”伪装字段变更成功，提交后保持待核销直到获得精确字段证据。
- Query：新增 `shein-bi-query.service`（8788）和 Nginx 9 个精确认证只读路由；并发 1、排队 3，独立 heap/cgroup，不启动 worker、Webhook、AI、实时桥、warmup 或生成。大 JSON 使用有界 encoder 和同一 `Readable → gzip → pipeline`，lane 持有到流或底层任务真实结束；首块前错误返回结构化 JSON，中途流失败/断线终止连接，非协作任务超过 grace 以 exit 70 由 systemd 独立恢复。30,270,786 bytes 响应已在 128 MB old-space 下同时通过 identity/gzip 完整性与有界内存探针，未调用 `gzipSync`。
- CLI：同版本安装损坏可从 TTL、304、current pointer 和 peer-repair 路径自修复；稳定 bootstrap 与 updater 共享可恢复 ticket lock，票据带 Linux 进程出生身份；可信存活 owner 永不因心跳停滞/age/mtime 被回收，进程死亡或 PID 出生身份复用立即回收，legacy/malformed 票据仅在超龄后回收，旧 `.tmp/.bak` 只在新 root 完整复验后 GC；五个发布中断点、连续二次掉电及并发恢复均不会执行坏包或删除唯一好副本。JSON pointer/marker 不再采用先移走 live 文件的 `.bak` fallback；同路径原子替换持续失败时旧 pointer 保持字节不变且旧 CLI 仍可启动。Query 429 只在原总预算内按 `Retry-After` 重试。Partner CLI manifest 版本提升到 `2026.08.17.1`。
- 维护：28 个 service、18 个 timer、1 个 path 进入完整 policy；唯一 CAS marker 位于 `/var/lib/shein-bi-control/cloud-maintenance.json`，由 root 原子写为 `root:root 0644`，服务用户只读，同时约束 systemd、watchdog 和既有 Codex heartbeat。canonical 祖先路径、owner、mode、symlink 或 hard-link 异常均 fail closed；`pause` 先验证 23 个 guard 文件并通过 `systemctl show` 精确回读 daemon-reload 后的唯一有效 `ExecCondition`；额外条件、缺失条件或 readback 失败都阻止 marker，guard 漂移时 watchdog 不抑制任何检查。watchdog 使用带文件/目录 fsync 的持久 outbox，并把同轮业务恢复与维护结束合并成一次通知。
- 运行态：canonical `/data/shein-bi/{profiles,state,outputs}`；宿主 app 下 profiles/state 只读，outputs 不再宿主挂载；每个 service 使用独立最小权限 namespace（`BindPaths`/`BindReadOnlyPaths`/`ReadOnlyPaths`/`InaccessiblePaths`/`RequiresMountsFor`），Query 不可见 profile；snapshot/watchdog 回读全部 28 个 service 的有效隔离属性，只看 drop-in 文件不算通过。迁移 A-R 故障注入覆盖恢复、回滚、篡改、有效 systemd 配置漂移、原子 fstab 发布和缺失备份；指纹覆盖内容、mtime、mode、numeric uid/gid、ACL、全部 xattr/capability、symlink 与 hard-link topology，只排除读取会改变的 atime/ctime。
- 灾备：数据库备份与 Profile/session 归档解耦；生产 unit 默认关闭后者，避免让 5GB 级登录态和密钥托管进入数据库备份 SLA。仓库仍保留 AES-256-GCM v2 create/verify/restore 能力及完整故障注入覆盖，后续只有独立批准密钥托管和恢复演练后才启用。数据库/COS 归档仍要求逐成员类型、路径、清单和实际内容 hash，final 目录发布拒绝同名 collision，并按 staging dev:ino 做终态回读。数据库备份的宿主 deadline 从失效的 `01:52` 修正为 `02:37`，为 `01:45` 任务提供真实窗口并在 `02:45` 昨日最终核对前保留 8 分钟交接。
- CI/Release：source checks + 四个确定性 shard + 独立 release-gate job + terminal gate；旧发布总门不再嵌套重跑全套；确定性登记测试每项只在所属 shard 执行一次，独立 release-gate job 唯一运行 `test_bi_ops_release_gate.mjs`，二者交集为零且无测试丢失（source checks 只做 `check:generated`/`check:source` 静态与 Partner CLI 版本边界检查，不执行确定性套件）；Link Ops fixture 统一使用测试私有 `SHEIN_BI_OUTPUT_DIR`，禁止并发测试写删仓库全局 source cache；Partner CLI 多 base 防“失败 push 被文档 push 洗白”；源码版本单调递增；可恢复 source-release 状态机绑定 exact main-push CI run/attempt、annotated tag 和两份 attestation 资产。Partner CLI 发布链同时改为唯一的 manual draft-first 状态机：发布前上传并逐字节回读 ZIP/SHA256，再 fresh 核验 main/tag/CI/immutable policy 后只发送一次 publish PATCH；已发布 immutable 版本只读复验并幂等部署，不再由 `release: published` 触发第二次运行。
- 部署证明：`check_release_source_state.mjs --record-deployment` 以 live GitHub 回读验证 checksum、attestation schema v3、origin repository、trust policy SHA-256、annotated tag object/message/peeled commit、immutable Release 与 exact source fingerprint，并原子写出 schema v3 deployment marker；之后 snapshot/watchdog 从固定 attestation 目录复算两份资产并重验本地 tag 和运行字节，marker 不能自证。日常 watchdog 的 `remoteEvidenceRole=cache-only` 是有意的故障域隔离：GitHub 官方 immutable Release 会锁定关联 tag，不能移动到另一 commit；远端新鲜性在每次发布/部署门重新获取，不把 GitHub/token 可用性变成生产运行健康依赖。

## 一次性生产迁移顺序

1. 维持当前人工冻结，fresh 核验既有 systemd 业务 timer/service、Windows task、四个业务 heartbeat 和所有写链均为 inactive/paused；首次引入总闸时旧 Release 尚无可用 guard，禁止假定可以先执行新 CLI `pause`。检查 legacy `/srv/shein-bi/runtime/maintenance/cloud-maintenance.json`：若存在 active marker，必须用旧版本受控恢复并回读为 inactive，再确认不会与新路径 split-brain。
2. 下载并 live 核验 Release 两份 attestation、Tag、immutable Release 终态与 exact CI attempt；备份 tracked diff、关键运行态和 Portal 输出。Profile/session 不属于本次部署备份范围。
3. 在冻结状态下精确部署 attested commit，但不启动或恢复任何业务 timer/写链；安装 maintenance guards，执行 daemon-reload，并权威回读 23 个唯一有效 `ExecCondition`。
4. 先以普通 `sheinops` 读取 canonical absent 状态并确认 `.lock` 不存在，再由 root 使用 fresh generation/hash CAS 在 `/var/lib/shein-bi-control/cloud-maintenance.json` 进入 `mode=all`；canonical orphan lock 不自动回收，只有在核对 marker、PID/process-start 与当前进程后才可人工处置。分别以 root 与 `sudo -u sheinops` 回读完整 marker hash，并验证 scheduled/infrastructure `systemd-condition` 返回 1 而非 64/255；若返回“已提交但锁清理未确认”，禁止盲重试。
5. 安装并回读 28-service runtime namespace 和 Query/Nginx 配置。在全部 SHEIN BI 业务 service inactive、无 Chrome 的前提下先做 runtime layout V2 只读审计，再执行迁移；为保证 state/outputs underlay 可原子 rename，备份与 v2 journal 固定在与 `/opt/shein-bi/app` 同盘、但位于 Git 工作树外的 root 专用目录 `/var/lib/shein-bi-layout-migration-backups`。中断后保留阶段证据，以同一 `--apply` 恢复，不能隐式回滚或另开迁移 run。
6. 保持 Profile/session 归档开关关闭，不生成新密钥；只核对迁移器不会复制、删除或改写 canonical Profile 内容。
7. 写入 schema v3 deployment marker（`shein-bi-deployed-release/v3`），启动 Portal/Query/Webhook/watchdog，预热并回读当前 generation 的受影响 section。
8. 完成浸泡后由 root 使用 fresh generation/hash CAS 退出维护，按只读巡检 → timer → 写链分阶段恢复；每阶段 fresh preflight 与终态回读，不使用 `enable --now` 批量拉起。

## 回滚

- 代码回滚必须选择已有、已核验的 Release commit；不得改写本版本 Tag/资产或在生产手改 tracked source。
- Query/Nginx 可先回退精确 location 与 unit；Portal/Webhook 保留各自上一个 unit/配置备份。
- runtime layout 只使用迁移器生成的 source-tree 外备份和脚本 rollback 路径；普通失败/SIGKILL 必须保留 journal 与现场，先只读审计 `recovery.action`、phase、stamp，再以同一 `--apply --confirm MIGRATE_CLOUD_RUNTIME_LAYOUT_V2` 恢复。只有审阅 active journal、fstab 与备份指纹后，才可显式执行 `--rollback --confirm MIGRATE_CLOUD_RUNTIME_LAYOUT_V2`；禁止手工递归移动/删除 profile、state 或 outputs。
- maintenance marker 在 rollback 验证完成前保持 `mode=all`；任何恢复证据不完整时不恢复自动化。
- 数据库、Profile/session 和 COS 本地删除规则均 fail closed；回滚不能用旧缓存或空目录冒充恢复成功。

## 验收边界

源码候选必须通过 `npm test`、四分片 CI、`git diff --check`、独立 GPT 对抗审查和同 SHA main-push CI。Link Ops 还必须证明无 claim 不写、claim/结果均为单任务 CAS、post-commit 异常不会诱导重试、终态不能二次提交；任何聊天通用异常也不得邀请写操作盲重试。生产完成还必须同时满足：schema v3 deployment marker（`shein-bi-deployed-release/v3`）、Portal/Query/Webhook/watchdog 健康、Query 无副作用、Portal 重启不影响 Query、五个事故 section 为当前 generation 的 200/非 stale/无 revision 追逐、canonical Profile 身份与内容未被迁移器改写、无 OOM/restart 回退，以及自动化分阶段恢复回读。
