# 发布清单

本清单适用于代码、systemd unit、BI Portal 和运维文档发布。完成本地构建不等于发布完成。

## 发布前

- [ ] 记录 `git status --short` 的 dirty inventory；确认本次变更与他人未提交改动的边界，不使用 reset/checkout 覆盖。
- [ ] 运行与改动风险相称的测试，并记录命令与结果；失败、跳过和未覆盖项必须保留。
- [ ] 搜索并排除 secrets、session、token、私钥、浏览器 profile 和本地运行态；发布物与文档不得包含敏感值。
- [ ] 更新受影响的架构、runbook、业务规则和索引链接；所有相对 Markdown 链接可解析。
- [ ] 若包含 systemd 改动，核对 unit 参数、`systemd-analyze verify` 和实际 `OnCalendar`，不从旧文档复制排班。

## 构建与发布

- [ ] 固定目标 commit SHA，并记录发布分支、Git tag 和 GitHub release（或明确说明为何不创建）。
- [ ] 确认发布资产与目标 SHA 一致，release note 写清变更范围、回滚点和已知限制。
- [ ] CI 已针对目标 SHA 完成；失败、未配置或未运行的检查必须如实列出。
- [ ] 云端部署仅在得到对应权限后执行；普通生产写入遵守 preflight、精确 payload hash、明确确认、审计与 readback。负责人已登记的长期自动化策略可免逐次人工确认，但不得免除 hash：系统必须自动计算、锁定并校验精确 payload/work hash，同时校验授权 ID/上下文、动作与店铺范围、实时证据、预校验、审计和 readback。

## 发布后

- [ ] 对生产入口、关键 service/timer、日志和数据新鲜度做与风险相称的真实验收。
- [ ] 云端真实 warning、partial、stale、blocked 或 reconciliation 差异不得因发布而抹除、静默或改写为成功；在 release note/runbook 中保留其状态和下一步负责人。
- [ ] 记录最终 target SHA、验证证据、残余风险及回滚命令/版本。
