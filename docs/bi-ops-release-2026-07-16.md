# SHEIN BI Ops 2026.07.16.1 发布说明

发布日期：2026-07-16
Git tag：`partner-cli-v2026.07.16.1`

## 发布范围

本版同时整理自动运营源码、营销 timer 安全边界、上新/下架规则、负责人知识与合伙人 CLI 文档。GitHub Release 是干净源码和 CLI 发行基线；生产 BI 仍以 `/opt/shein-bi/app`、PostgreSQL、systemd 和线上 API 的实际状态为准。

## 主要变化

### 上新、图片与标题

- `已审可用` 素材不再因 AI 主观判断被静默剔除；只有文件损坏、平台格式/尺寸、明确错品、角色冲突或 SHEIN 真实校验错误可阻断。
- 图片规划器补齐“产品单镜封面”等客观角色识别，并先读取真实尺寸再判断方形图。
- 19 店默认标题组进入公共 `config/store_style_profiles.json`，规划结果保留 `defaultTitleGroup` 结构化事实；当轮明确指定优先。
- 合伙人 CLI 包含同一配置，负责人本机、BI 网页和同事 CLI 不再各自记一套规则。

### 下架与货号修复

- 下架候选缺首次上架日期时不再自动放行；必须有明确恢复/历史上架证据，否则进入待确认。
- 下架后货号修复对 Wall Plug、电压、电流、危险品分类等模板必填项 fail closed；存在 blocker 时不生成可提交 body。
- 活动目录只保留通用 `build_supplier_code_normalization_plan.mjs`；六个一次性批次脚本退出生产入口。
- OpenAPI 请求超时覆盖响应正文读取，避免 headers 已返回但 body 卡住时无限等待。

### 营销 timer

- 云端 `10:30` timer 使用负责人长期授权 `owner-standing-cloud-marketing-v1`。策略白名单内的限时折扣动作**不要求逐次 payload hash**；普通活动、优惠券、预算和策略外动作仍需单独授权。
- 授权动作包括：人工特殊折扣恢复、目标价漂移修复、新链接/新上架 7 天/重新上架无活动兜底，以及这些动作的 ET 门控虚拟库存补齐。
- 写阶段严格串行；任一阶段失败后跳过后续写入，只做最终 live scan/guard，避免继续使用旧快照。
- 新建/恢复活动按活动 ID、逐 SKC 精确价格、活动库存、截止时间和唯一覆盖回读；任一不符返回非零。
- 人工特殊折扣覆盖同时核验价格、`activityStock` 和 `validTo`。登记更新使用跨进程锁；库存补齐在逐链接锁内二次回读，并使用确定性 idempotency key。
- 新链接原始快照 overlay、19 店完整覆盖、当前/未来活动区分和局部复扫合并均 fail closed；失败、partial、旧 overlay 或店铺键不一致不能生成“无待办”。

### CLI、知识同步与文档

- Partner CLI 版本提升到 `2026.07.16.1`；Release 发布后由 GitHub Actions 构建 ZIP/SHA256、校验不可变源码并原子部署到 BI 下载入口。
- 负责人经验继续采用“本人单向发布、同事只消费”；同事任务前检查 GitHub/BI 最新版本，不反向覆盖负责人规则。
- 新增 `docs/README.md`、发布清单、每日营销巡检交接和历史营销运行归档；运行排班统一以 systemd timer 的 `OnCalendar` 为准。

## 发布与验收边界

- 本地发布前验收已通过：`npm test`（79/79）、`node scripts/test_bi_ops_release_gate.mjs`、语法/JSON/Markdown 链接检查、敏感信息检查，以及 CLI ZIP 解包与 SHA256 一致性校验。
- Release workflow 必须在目标 tag 上重新执行 Node 22 全量测试，再上传 `shein-bi-ops-cli-2026.07.16.1.zip` 与校验文件并验证 BI `managed` 版本/源 commit。
- 生产应用目录存在受控运行态差异，禁止 `reset --hard`、`clean` 或全目录覆盖；非 CLI 的云端脚本与 unit 采用逐文件备份、安装、`systemd-analyze verify` 和只读状态回查。
- 不为发版手动触发营销写服务；部署后核对 timer、unit 环境和下一次计划时间即可。

## 已知状态

- 2026-07-16 营销巡检曾因部分平台阻断留下 warning；后续最终 live scan 已覆盖 19 店且最终 blocker 为 0。历史 warning 保留，不改写成从未发生。
- supplier-code normalization 的历史失败 unit/审计记录继续保留；本版只收紧后续入口，不篡改旧结果。
- 飞书问数服务继续保持 `disabled + inactive`，本版没有恢复。

## 发布后验收

- Release 源 commit 为 `4c27ce29521f445d3c672005e3a001fc8298a790`；[main CI](https://github.com/dushengyi1993/shein-sales-bi/actions/runs/29490660400) 与 [Partner CLI 发布部署](https://github.com/dushengyi1993/shein-sales-bi/actions/runs/29490758157) 均通过。
- GitHub Release 已生成 ZIP 与 SHA256；线上托管版本为 `2026.07.16.1`，元数据回读的 `sourceCommit` 与 Release 源 commit 一致，包 SHA256 为 `0e05d8bbbd95532043e6a6178adb6e8f927981627cbfc3b1620f5a349509e102`。
- 50 个非 CLI 运行文件已按清单逐文件备份、校验和安装；回滚备份位于 `/srv/shein-bi/backups/releases/2026.07.16.1-20260716-184104`。没有覆盖实时 Portal 数据，也没有执行全目录 `reset`、`clean` 或同步。
- Portal 已重启并完成缓存预热；`/login` 返回 `200`、根入口返回 `302`，未登录访问 `/api/health` 按鉴权设计返回 `401`，重启后没有 error 级日志。
- 营销 timer 保持 `active + waiting`，下一次计划为 2026-07-17 10:30（Asia/Shanghai）；unit 已加载长期授权 ID、`cloud_timer` 上下文和自动修复开关。本次发版没有手动触发营销 service。
- 营销 oneshot 继续保留 2026-07-16 10:30 巡检的 `Result=exit-code` 与 warning 状态，没有执行 `reset-failed` 掩盖历史结果；飞书问数仍为 `disabled + inactive`。

## 回滚

- 源码回滚：回到本 tag 的前一稳定 commit，并按逐文件生产部署流程恢复备份。
- Partner CLI 回滚：重新发布/部署上一稳定 `partner-cli-v*` 版本；不得直接覆盖活动安装目录。
- systemd 回滚：恢复部署前 unit 备份，执行 `systemctl daemon-reload`，只启动 timer，不手动触发对应营销 service。
