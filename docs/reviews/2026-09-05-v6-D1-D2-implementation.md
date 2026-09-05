# V6 D1/D2 实施与验收记录

日期：2026-09-05。状态：本轮独占代码反例修复、默认 VM 与显式审计回归通过；尚有范围外旧测试断言待主控更新，不能称全部测试通过、工作区干净或生产已验收。

工作树：E:/Codex WorkSpace/.worktrees/Shein-BI-V6。
分支 codex/bi-v6-repair-20260905、基线 7d5e38756e519e9daa76854925e7b2ee0b321b50 沿用主控迁移移交信息；本轮按禁止 Git 的要求未重新运行 Git 核实 HEAD/status/diff，也未暂存或提交。

## 范围和依据

本任务拥有以下五个路径。本轮写入 client、generator、测试和本报告；styles 保留此前已实施的库存 class 样式，本轮读回验证，没有新增样式改动。

- scripts/bi_app/client.js
- scripts/bi_app/styles.css
- scripts/generate_bi_portal.mjs
- scripts/test_bi_v6_d1_d2_identity_and_display.mjs
- docs/reviews/2026-09-05-v6-D1-D2-implementation.md

原指定主目录下的 V5 review 文件当前读取返回不存在；已读工作树内同名 docs/reviews/2026-09-05-v5-audit-and-repair-plan.md 的 D1/D2（102、110 行）及第七节纠正（236 行）。没有重做启动审查或修改路由、公共 normalizer、schema、AGENTS、runner、package.json、依赖联接、其他代理文件。没有联网、生产操作、旧 queue 重放或缓存发布。

## 本轮实际源码差异

以下按改前读回与改后源码对照记录，不冒充 Git diff 输出。

| 文件与当前行号 | 改前缺口 | 本轮实际变更 |
| --- | --- | --- |
| client.js:69 canonicalGoodsSn | 前端手抄 KNOWN_EXACT_CANONICAL_ALIASES 补映射 | 删除整张表。非空服务端 canonical_goods_sn 直接优先；没有该字段时只读 D.productCanonicalSnMap 的 own key，缺映射保留原货号。显示名不参与身份。 |
| generate_bi_portal.mjs:5799 buildProductCanonicalSnMap | 复制 alias 配置后另手写两个 W 映射 | 使用现有 getAliasConfig/getCatalogConfig/normalizeGoodsSnDetailed；标准目录值映射自身；旧行的具体货号交给既有 resolver，只有已确认、在目录内的结果进入 map。无手抄型号或新 substring 规则。 |
| generate_bi_portal.mjs:5831 attachProductAliasSearch | map 来源与实际样本脱节 | 将实际 data 传给 mapper；生成器主输出在 17760 行挂接，当前 client.js:112 merge 接收至 D。测试实际执行这两个生产函数。 |
| generate_bi_portal.mjs:793、2551 | overlay 只有 standard 字段，原 supplier 可能丢失 | 两处 overlay 均显式输出 dim.product_canonical_sn(...) AS canonical_goods_sn，rawSupplierCode 为空时保留 supplierCode 原值。 |
| generate_bi_portal.mjs:2614 | link CTE 未显式标识 canonical | 输出既有 dim.product_canonical_sn 的 canonical 字段，并沿 links、duplicate_links、store_links_ranked、store_links 四个 SELECT 投影传到最终 JSON；保留 raw_goods_sn。 |
| generate_bi_portal.mjs:3981 | inventory 只有 standard 字段 | 台账同时输出服务端 canonical_goods_sn 和归一化前 raw_goods_sn。 |
| client.js:897 inventoryProductKey | 仍可回退 pkey/prod 显示字符串 | 统一只调用 canonicalGoodsSn；没有商品身份的行不凭名字建立库存商品主键。 |
| client.js:952 inventorySelectEvidence、964 inventoryMergeEtRows、991 inventoryRowsForView | 两两合并冲突置 null 后，第三条可重新填数；元数据可能来自不同快照 | 先按 canonical 收齐整组证据，再选有数量和有效时间的最新 cohort。同期值不同保持 conflict/null；后来的同值行不能解除冲突，更新时点的一致证据可以取代旧冲突。数量与选中快照时间同行传递。 |
| client.js:964 | 缺时间的已知数字可冒充有效证据 | 缺失/无效/未来时间不参加已知 cohort；无有效采集时间时数量未知。已有有效已知证据不被 null 别名覆盖。移除仓储费用日期作为库存快照的代理。 |
| client.js:908、910、935、1020、1022 | 汇总可能丢掉未知/过期完整性 | 在途未知时总供给未知；同时间 ET 冲突显示原因；虚拟库存汇总同时保留含未知与含过期，且 cell/stats 均在最终使用点检查 45 分钟。缺失及无效时间统一未知，未来或超过时限显示过期。 |
| test_bi_v6_d1_d2_identity_and_display.mjs:19、42、48 | 测试手工抄常量/部分函数并直接修改展开状态，审计计数曾写死 | 执行真实 generator mapper、完整 client VM、真实 merge 与点击监听器；仅屏蔽网络启动和 DOM 挂载。默认 synthetic，--audit 显式参数、manifest/hash 先验、计数现场计算、失败抑制私有数据输出。 |

链接实体去重继续使用 client.js:847 productLinkRows 的 store+SKC 键；旧 overlay 更新已有实体，新增真实 SKC 仍保留。raw_goods_sn 与台账 raw_goods_sn_list 用于追溯。

ET 共享证据不相加。在库/在途均按各自最新时间 cohort 选证据；同时间冲突返回未知。历史累计销量/成本发货等字段保留原先去重复用的最大证据策略，它不再用于决定当前 ET 实盘数值。

styles.css:423、425 的 zero-part 规则存在背景、文字和边框声明，真实 cell HTML 使用同一 class。此次是 VM HTML 与 CSS 规则检查，不是浏览器截图/像素验收。

## 聚焦测试与实际命令

所有命令工作目录显式为 E:/Codex WorkSpace/.worktrees/Shein-BI-V6，以下命令使用绝对路径；没有生成测试业务产物。

~~~powershell
node 'E:/Codex WorkSpace/.worktrees/Shein-BI-V6/scripts/test_bi_v6_d1_d2_identity_and_display.mjs'
node 'E:/Codex WorkSpace/.worktrees/Shein-BI-V6/scripts/test_bi_v6_d1_d2_identity_and_display.mjs' --audit 'C:/Users/dushengyi/AppData/Local/Temp/shein-v5-audit-20260905-query.json'
node --check 'E:/Codex WorkSpace/.worktrees/Shein-BI-V6/scripts/bi_app/client.js'
node --check 'E:/Codex WorkSpace/.worktrees/Shein-BI-V6/scripts/generate_bi_portal.mjs'
node --check 'E:/Codex WorkSpace/.worktrees/Shein-BI-V6/scripts/test_bi_v6_d1_d2_identity_and_display.mjs'
node 'E:/Codex WorkSpace/.worktrees/Shein-BI-V6/scripts/test_product_display_name.mjs'
~~~

默认 VM、审计 VM、三项语法检查均 exit 0。既有 display 测试 exit 0，输出 product_display_name: 7 direct checks plus recursive enrich checks passed。

新测试唯一路径：scripts/test_bi_v6_d1_d2_identity_and_display.mjs；未注册 runner，由主控统一集成。

默认测试实际输出摘要：

~~~text
[Identity path] 8 distinct canonical/unknown/accessory identities with the same label stay separate in mapper, links, ET, stats and cells.
[ET] 80 cohort permutations passed: persistent conflict, latest known stock, missing/invalid time unknown.
[D1/D2] Real links -> stats -> ledger -> matrix/cell: 7+11=18, 2 SKCs, 1 ET row (600).
[Matrix synthetic] 121 input rows; 120 before real click, 121 after; render invoked once.
PASS V6 D1/D2 real generator/client VM
~~~

关键覆盖：

- 3 条和 4 条 ET 同期冲突的全部排列；第三/四条同值、null、旧值不能把冲突洗成确数。新 600 胜过旧 720；新时点一致证据可以取代旧时点冲突；已知值不被未知覆盖。
- 服务端明确 canonical，包括配件、不同正式货号，经过 mapper → merge → links → stats → ET → cell 保持分离；3065 与 W 独立，未知同显示名不合并。
- [0,110] 显示 110/部分缺货；[100,未知] 明示已知/另有未知；fresh+expired、fresh+missing、fresh+unknown+expired 汇总与 cell 对齐。
- 缺失和非法 fetched timestamp 先通过 inventoryStoreCellRows 保留身份，再在实际 cell 显示未知；未来或过期显示失效。可售未知而总库存 80 时显示“未知(总 80)”。
- 同一份已缓存行在时钟到 45 分钟仍有效，多 1 毫秒即过期；统计同步排除其数量。
- 121 个合成商品先渲染 120 个，调用原 client 注册的点击处理器后渲染全部 121 个，确实触发一次 render。

负例命令：

~~~powershell
node 'E:/Codex WorkSpace/.worktrees/Shein-BI-V6/scripts/test_bi_v6_d1_d2_identity_and_display.mjs' --audit 'E:/Codex WorkSpace/.worktrees/Shein-BI-V6/__missing_audit_fixture__.json'
~~~

该路径未创建。实际 exit 1，末行 [Audit] FAILED at manifest; private evidence details suppressed.，没有最终 PASS；明确请求但缺文件不会静默跳过。

## 私有审计样本：只记录聚合计数

先读同路径 .manifest.json，确认 succeeded、readOnly=true、cloud_bi_query_data 来源、linksData/inventoryTrend 覆盖、issueCount=0，再验 artifact 大小及 SHA 后解析数据。

- 文件字节数：12309703。
- SHA256：a4576550abed5c2a917857cc7d69a7248e005fb28120506607e37cc07d8417f4。
- 回归时钟固定为 manifest 的查询完成时点；不使用运行当下的新鲜度推断历史业务状态。
- 样本没有 canonical_goods_sn 或 productCanonicalSnMap，测试通过当前真实生成器与既有本地 alias/catalog resolver 补兼容映射，再经生产 client merge 输入 D。不是声称原样本已有新字段或线上已经使用新 SQL。

实际审计输出：

~~~text
[Audit entities] {"storeLinks":2200,"overlay":497,"legacyRows":2284,"legacyDuplicateEntities":48,"mergedEntities":2236,"duplicateEntities":0,"legitimateMultiLinkGroups":620}
[Audit inventory] {"rawCombinedRows":114,"rawLedgerRows":73,"canonicalLedgerRows":72,"combinedMatrixRows":107,"duplicateCanonicalRows":0,"renderedMatrixRows":107,"canonicalWithLinkStats":98}
~~~

旧重复计数由同一固定样本按 V5 文档记载的 store+货号+SKC 旧键重建的参考 reducer 得到；本轮没有执行 Git 中的基线脚本。修复后实际执行当前 productLinkRows，并逐一比较输入实体集合和输出实体集合完全相等；48→0 不是写死日志，合法 SKC 没有丢失。

口径纠正：114 是在当前 client 中关闭兼容 map 后台账加链接的原始货号行数；实际 map 生效后为 107。73 条原始台账归并为 72 个 canonical，加入链接-only 货号后是 107 行矩阵，全部 107 行实际渲染。前一版报告的 111 不能作为当前代码验收值，已撤回。121 是独立 synthetic 展开边界，不是从真实样本伪造的行数；二者不能混报。

## 最终源码指纹

以下为本轮测试后文件的 SHA256，便于主控确认接收的是同一组字节；不代表 Git 状态证明。

| 路径 | SHA256 |
| --- | --- |
| scripts/bi_app/client.js | f9cfc4557c9ad017f4124897b87f9d96b6cc96fc618bada55c4030d656bd2954 |
| scripts/bi_app/styles.css | a9e18a98c64655143fb1a5a312d90d3588a613f26100d10f4311902909379968 |
| scripts/generate_bi_portal.mjs | 953dfff8f6db728ee93c0c1bcb4e08c23c98b06a778a3aa134fafe741ce3e410 |
| scripts/test_bi_v6_d1_d2_identity_and_display.mjs | 9656db09b2bba5fe6fdb5ea988c6de6ae097e886e09087bba369745e2ac49d17 |

## 确切未完成点和验证边界

1. **旧测试断言已按追加授权修正并通过。** 本段取代此前“旧测试仍失败/等待主控更新”的记录：在用户明确追加 scripts/test_bi_client_resilience.mjs 写范围后，保留刷新、版本回退和历史覆盖，将过时断言改为真实 client VM 的 canonical/store+SKC 身份、多链接保留、库存完整性及过期显示、137 条链接和 241 个商品可查看/点击验收。实跑 node scripts/test_bi_client_resilience.mjs、node scripts/test_bi_v6_d1_d2_identity_and_display.mjs 及后者显式 --audit 私有审计路径均 exit 0；主控随后独立重跑 resilience 与 --audit 均 PASS，并正式接收 D1/D2 源码及测试、接回 ownership。审计口径仍为 48→0 重复、2236 实体、620 合法多链接组、107 真实矩阵行；121 行为独立 synthetic 反例，不混报为真实审计行。本次仅更新这条过时记录，未重新执行 D1/D2 测试或改动其生产源码。
2. **尚未注册新测试到 runner**，按用户分工交由主控，package.json/test runner 未改。
3. **尚未执行 PostgreSQL/线上缓存生成、部署或业务读写。** SQL 的 dim.product_canonical_sn 调用及字段传播已做源码检查；当前线上维度函数内容、新数据生成结果和实际缓存刷新需要集成/发布阶段另行验收。
4. **尚未做真实浏览器截图/像素验收。** 此轮覆盖完整 client VM、真实 mapper/merge、真实点击监听器、实际矩阵 HTML 和样式声明；启动网络调用和 DOM mount 在测试中被屏蔽。
5. **未核实工作树 Git 状态，也不宣称干净。** 代码保留供主控核对集成；没有 Git 操作或其他代理文件清理。只读检查 lib/bi_inventory_identity.mjs、patch_client.cjs 均不存在，没有重新创建。

本报告仅包含代码证据、合成反例和审计聚合计数，不含凭据、私有原始业务行或 SKC 标识。

## 后续独占测试合同：pre-submit 与不可变晨间证据

2026-09-05：D1/D2 已由主控正式接收。本轮仅更新上方第 121 行的过时失败记录，并按新授权修改以下两份现有测试；没有新增测试文件或改动 runner。此合同的两份测试 ownership 交回主控。

- `scripts/test_daily_operating_refresh_validator.mjs:919`：真实 `validateInventoryArtifacts` 与完整 `validateDailyOperatingRefresh` 验证 exact plan/result、原始 `kind: result` journal 事件、无相关 intent 的 `pre_submit_blocked` 警告；两种允许原因均通过，最终 operating marker 尚不存在的 pre-warning 审核通过。严格完成模式拒绝把该状态当作终态 readback。
- `scripts/test_daily_operating_refresh_validator.mjs:981`：35 个反例逐项拒绝，含伪造证明/marker、缺失 journal 或原始 result 不同、计划/command/目标/store/SKC/SKU/rule 漂移、已发生写入、同计划 pending/closed intent、同 command 不同计划的 closed intent、其他计划同 scope 的 pending intent。`blocked` 无论有无伪装证明都拒绝。反向正例保留不同计划/command 的已闭合历史，不因存在任意历史 intent 而全局拒绝。
- `scripts/test_daily_operating_refresh_validator.mjs:1075`：真实 `writeMarker({snapshotEvidence:true})` 保存完整晨间 manifest 和 38 份依赖；原始 38 文件及原 manifest 全部改写后，完整 daily validator 仍返回 `ok:true/storeCount:19/artifactCount:38`。42 个不同快照文件（四项顶层证据加 38 依赖）逐个做等长、合法 JSON 的字节变更，均因 hash mismatch 拒绝；逐个恢复后均通过。移除一份依赖绑定也拒绝。
- `scripts/test_pipeline_marker.mjs:276`：用真实 `writeMorningResumeEvidence` 生成 19×2 小型合成文件清单，保留相对 business root 的 artifact.path；实际 CLI `write --snapshot-evidence`/`require --require-evidence` 在隔离 business root 的 cwd 运行（第 37 行）。断言 record.path 不变、snapshotPath 独立、38 依赖的原路径/字节/hash 完整。
- `scripts/test_pipeline_marker.mjs:312`：捕获前依赖漂移拒绝且不发布完成 marker；捕获后 39 个原文件变化不影响旧 marker。39 个快照逐一等长篡改均返回 `evidence_hash_mismatch`，恢复后均通过；丢失已保存依赖返回 `evidence_missing`。保留已有普通 marker、日志快照及 CLI 覆盖。
- 两测试新增可选 `SHEIN_TEST_TMP_ROOT` 以便本机使用 E 盘独立临时目录；默认仍用系统 tmp，CI 不探测任何用户私有业务文件。清理前核对绝对父目录及专用前缀，Windows 短暂占用使用有界 cleanup retry。历史 2026-08-16 fixture 的 `locked-only/v1` 兼容保持不变。

实际命令（每个 exec_command 的 workdir 均为 `E:\Codex WorkSpace\.worktrees\Shein-BI-V6`）：

```powershell
$env:SHEIN_TEST_TMP_ROOT = 'E:\'
node scripts/test_daily_operating_refresh_validator.mjs
node scripts/test_pipeline_marker.mjs
node --check scripts/test_daily_operating_refresh_validator.mjs
node --check scripts/test_pipeline_marker.mjs
```

| 命令 | 实际结果 |
| --- | --- |
| daily operating validator | exit 0；35 个 pre-submit 反例拒绝；38 依赖、39 原文件变更后通过；42 快照篡改拒绝；旧 checks 全部通过 |
| pipeline marker | exit 0；morningDependencies=38，originalFilesChanged=39，snapshotHashTamperRejections=39，relativePathCli/dependencyDriftRejected/missingSnapshotRejected=true |
| 两个 node --check | exit 0，无输出 |

失败与边界：

1. worktree 下初跑 validator exit 1：finally 清理时 `EBUSY/unlink`，该次测试主体结果被清理错误遮蔽。补有界 cleanup retry 后第二次 exit 1：`empty_journal` 反例在读取合成 OpenAPI 文件时遇到 `EBUSY/open`，尚未到预期语义拒绝。改用 E 盘根下唯一临时目录后全量聚焦用例 exit 0；没有放宽语义断言，没有据此改生产实现。这两次文件访问失败不计 PASS。
2. 自动审批拒绝了清理首轮残留目录的命令，仅提供 `blocked by policy`，无更具体原因。残留 `E:\Codex WorkSpace\.worktrees\Shein-BI-V6\daily-operating-validator-8KJqvg` 保留，供主控处理；没有尝试绕过。后续通过的测试自行清理各自临时目录，不宣称整个工作区干净。
3. Windows 下 POSIX mode 检查按现有测试逻辑跳过，输出 `skipped-posix-mode-on-windows`；未在 Linux 实跑。没有网络、Git、真实业务写入或部署，本轮没有新生产行为缺陷证据。
4. 生产文件只读，首尾 SHA-256 一致：`lib/durable_inventory_write.mjs` = `c17fd4368ffbc19630094abd8207810164eb10b869630deaa444fff3686e4054`；`scripts/validate_daily_operating_refresh.mjs` = `3a08d1d452e99e9330455e7da4e314eae14c5379a613a0d4ac630d2b92299061`；`scripts/pipeline_marker.mjs` = `50d765042bca00a16b4a3884dddb907903b8d3ec1569e8c032b49ba2e215d889`。

## 协作变更后重新验收（2026-09-05，当前终态）

本轮已完成两文件测试合同，归还测试 ownership。沿用上节四条命令及 E 盘隔离 tmp；实际结果为 validator **exit 0**、pipeline marker **exit 0**、两条 `node --check` 各 **exit 0**。未改生产文件、独立 owner-resume 测试、runner 或依赖，无 Git/网络/业务操作。

本轮首跑 validator **exit 1**，首因已准确定位：原测试第 603 行预期 `lacks exact terminal readback.*strict mode`，真实错误为 `INVENTORY_JOURNAL_PENDING_SCOPE_CONFLICT`。生产 reader 已切换为统一 `readInventoryIntentJournals` 的 `currentJournalFile` / `quarantineHistoricalDanglingSupersedes` 选项，仍保留 snapshot 映射；旧 dangling supersede 因而正确恢复为该实体的 pending。测试此前将该历史场景文件遗留给后续独立的当天 pending 场景，形成两个同 scope pending。这是测试夹具隔离缺陷，不是放宽生产保护的理由。

唯一代码增量位于 `scripts/test_daily_operating_refresh_validator.mjs:446` / `:518`：明确本次运行的历史 fixture 路径，保留既有历史完成及 tombstone 断言，新增“隔离后的历史 pending 与另一同 scope pending 冲突必须拒绝”的真实 validator 断言，并验证历史 journal 字节不变；随后恢复当天 journal、移除本次运行自己创建的该场景文件。没有删除失败断言或放宽其正则。后续 35 个 pre-submit 反例及完整快照验收恢复通过。

当前证据位置与输出计数：

- `scripts/test_daily_operating_refresh_validator.mjs:940`：exact plan/result、原始 result journal、无相关 intent 的证明警告通过；两种原因和无最终 marker 的 pre-warning 通过；严格完成拒绝。
- 同文件 `:1002`：35 个证明/身份/journal/intent/marker 反例拒绝，含仅 `blocked` 不升级。
- 同文件 `:1096` / `:1112`：38 依赖、39 个原文件（含 manifest）变动后完整 daily validator 仍通过，42 个不同快照的等长篡改分别拒绝，依赖绑定缺失拒绝。
- `scripts/test_pipeline_marker.mjs:289` / `:324`：真实 CLI 正确 cwd、38 相对路径依赖、39 个原文件后续变化仍通过、39 个快照逐项 hash 篡改拒绝；捕获前 drift 和快照缺失拒绝。该文件本轮没有代码改动。
- validator 聚合输出另有 `historicalQuarantine.sameScopePendingConflictRejected/originalJournalUnchanged/scenarioIsolated=true`。Windows POSIX mode 检查仍按既有逻辑跳过，没有 Linux 实跑结论。

本轮验证首尾生产 SHA 一致：validator = `4903be4adb272a6c703d6f9d1004aeaa3f920fc41e25842883b740f567824649`（上节旧 SHA 仅代表上一轮版本）；durable lib 与 pipeline marker 仍为上节 SHA。测试最终 SHA：daily validator = `7601c59650eeb164f30377a046cb4d3838048be40a6ffedcfd3a982e102c9c80`，pipeline marker = `ff1328e0988c7af2a2ed2a5dc9b874d69509036fbe0acf88f0316069d0dac6bb`。

残留归属：`E:\Codex WorkSpace\.worktrees\Shein-BI-V6\daily-operating-validator-8KJqvg` 与本任务首轮 `EBUSY/unlink` 工具输出路径完全相同，确认是本任务失败 fixture；只读检查为非 reparse point，43 文件、21,587 字节，首尾计数一致。本轮未清理、未尝试删除该旧目录。新 E 盘隔离测试目录已自行清理，没有仍运行的测试工具。目录仍留待主控处理，不宣称工作区干净。
