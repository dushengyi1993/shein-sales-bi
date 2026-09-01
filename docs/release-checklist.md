# 发布清单

本清单适用于代码、systemd unit、BI Portal 和运维文档发布。完成本地构建不等于发布完成。

## 发布前

- [ ] 记录 `git status --short` 的 dirty inventory；确认本次变更与他人未提交改动的边界，不使用 reset/checkout 覆盖。
- [ ] 运行与改动风险相称的测试，并记录命令与结果；失败、跳过和未覆盖项必须保留。
- [ ] 搜索并排除 secrets、session、token、私钥、浏览器 profile 和本地运行态；发布物与文档不得包含敏感值。
- [ ] `outputs/bi-portal/index.html`、`data.json`、section cache 和生产可变登记表均未进入 tracked source；生产可变登记表已落在 `/srv/shein-bi/runtime` 并有备份。
- [ ] 更新受影响的架构、runbook、业务规则和索引链接；所有相对 Markdown 链接可解析。
- [ ] 若包含 systemd 改动，核对 unit 参数、`systemd-analyze verify` 和实际 `OnCalendar`，不从旧文档复制排班。
- [ ] 若包含凌晨互斥或凭据落盘改动，核对共享 `flock` 路径、等待预算、`UMask` 和实际 lock/credential 文件权限；不得用 `After=`/`Requires=` 替代跨 timer 的运行期互斥。
- [ ] 若包含 OpenAPI 对账改动，验证 OpenAPI-only/合法非上架/浏览器四态差异不会单独 warning；详情缺失、库存缺失、无 Webhook 的状态回退仍必须可行动地告警。
- [ ] 若包含利润/成本改动，在隔离数据库重建完整 schema，并验证退款总额不超过订单行、包裹实际退货费替代整包估算、RTV 经济事件不重复、仓储费守恒、cache 与 canonical 视图一致。
- [ ] 若包含 Webhook 实时链路改动，验证“销售先到、利润后补”有明确 `accountingPending`，事件合并、失败重试和服务启动追赶均不会用假零值或静态成本兜底。

## 构建与发布

- [ ] 固定目标 commit SHA；源码版本不低于 fresh 远端最新 `YYYY.MM.DD.N`，Tag/Release 只通过 `source-release.yml` 状态机创建或恢复，不人工创建轻量 Tag。
- [ ] 确认 annotated tag message、peeled commit、schema v3 attestation（repository id、trust policy SHA-256、CI job count/jobs SHA-256）、checksum、Release asset API digest/size/state 和下载字节全部一致；正式 Release 必须 `immutable=true`；release note 写清变更范围、回滚点和已知限制。
- [ ] 发布前串行启用/确认 GitHub immutable releases policy，并权威 GET 回读 `enabled=true`；`enforced_by_owner` 仅在 tracked trust policy 明确要求时才是硬门（当前个人仓库不要求）；不能只信 mutation 响应。
- [ ] release note 明确“仅源码发布”或“已部署生产”；不得把 GitHub tag 自动等同于生产版本。
- [ ] PR CI 与合并后同一 SHA 的 main-push CI 均完成；源码发布绑定后者的精确 run ID + run attempt，并在 publish 前后重新回读。失败、未配置或未运行的检查必须如实列出。
- [ ] 若发布 Partner CLI，先创建指向同一 `origin/main` commit 的 annotated `partner-cli-vYYYY.MM.DD.N` tag 和 draft Release；只以 `tag + expected_commit` 手动触发 `partner-cli-release.yml`，不得手工先 publish。工作流必须在 draft 阶段上传并回读唯一 ZIP/SHA256，fresh 复验 CI/immutable policy 后单次 publish；已发布 immutable 重跑不得修改资产。
- [ ] GitHub Actions 使用固定 commit SHA；Dependabot 已覆盖 `github-actions` 更新。
- [ ] 云端部署仅在得到对应权限后执行；普通生产写入遵守 preflight、精确 payload hash、明确确认、审计与 readback。负责人已登记的长期自动化策略可免逐次人工确认，但不得免除 hash：系统必须自动计算、锁定并校验精确 payload/work hash，同时校验授权 ID/上下文、动作与店铺范围、实时证据、预校验、审计和 readback。

## 发布后

- [ ] 对生产入口、关键 service/timer、日志和数据新鲜度做与风险相称的真实验收。
- [ ] 云端 `HEAD` 等于 attested commit，两份证明资产位于 `/srv/shein-bi/runtime/release-attestations/<tag>/`，且 `node scripts/check_release_source_state.mjs --expected-commit <release tag> --record-deployment <release tag>` 写出有效 schema v3 的 `shein-bi-deployed-release/v3`；watchdog 持续检查 attestation/CI 绑定、commit、脏改、隐藏索引和缺失文件。
- [ ] Portal `8787`、Query `8791`、Webhook `8792` 分别健康；重启 Portal 不改变 Query PID，Query health 的 `surface=query` 且 `sideEffectsStarted=[]`。
- [ ] 维护 marker 已通过 fresh generation/hash CAS 恢复；只读巡检、timer、写链按阶段恢复，没有 `Persistent` catch-up 或重复 scheduler 意外拉起。
- [ ] 云端真实 warning、partial、stale、blocked 或 reconciliation 差异不得因发布而抹除、静默或改写为成功；在 release note/runbook 中保留其状态和下一步负责人。
- [ ] 记录最终 target SHA、验证证据、残余风险及回滚命令/版本。
