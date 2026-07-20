# SHEIN BI / Ops 2026.07.20.1 发布说明

发布日期：2026-07-20
范围：SHEIN OpenAPI Webhook 第一阶段、BI“平台动态”、订单/退货按单增量、授权/额度安全闸门、P0 飞书摘要

## 发布结论

本版把 SHEIN 平台事件从“等待下一轮抓数才发现”升级为可靠的实时触发层，但不改变受控写边界：Webhook 只负责接收、记录、补充只读事实和关闭风险闸门，永不直接修改 SHEIN。

BI 新增独立“平台动态”子页面，普通状态变化不再塞入首页或飞书。飞书只发送 P0：授权关系变化、额度归零、审核失败、非预期下架/删除和必需合规失效。

## 第一阶段能力

### 商品生命周期

- 商品接收、普通/全渠道审核、上下架、删除审核进入平台动态。
- 保留店铺和平台强身份供后续关联，但公网 receiver 不读取/修改 `ops.link_ops_*`；任务自动挂接留给独立最小权限 reconciler。
- 审核失败、非预期下架、删除获批或删除审核失败为 P0。

### 订单与退货

- 收到订单号或退货单号后调用对应 OpenAPI 详情接口。
- 空 item 详情直接拒绝写；同一事务通过受控数据库函数按 `店铺 + 单号 + source_snapshot_at` 领取替换权，只有不旧于现有版本时才精准替换子项并 upsert header；不删除日期切片、不重写整日 reconciliation。
- targeted 与日快照都在各自首次 API 请求前锁定抓取版本并共用店铺 advisory lock；即使旧日快照先抓、后落库，也不能因“完成得更晚”伪装成新版本覆盖 Webhook 事实。写后同时核对 source snapshot 与 header、item、payment flag 数量；已被更新快照取代时明确返回 superseded。

### 授权、额度与合规

- 授权关系变化立即关闭该店授权闸门；只有事件之后更新且成功的店铺只读探针可以自动解除。
- 商品额度为 0 时关闭额度闸门，收到恢复为正数的事件后开闸。
- 合规失效按商品/证书对象记录，不误封整店。

## 可靠性与安全

- 正式公网回调：`https://sa.dushengyi.cc/api/shein/webhook/v1/events`；`8443` 只保留为受限故障回退，不是开放平台生产配置。
- 标准 443 链路为 Cloudflare -> HAProxy 443 -> Caddy 10443 -> Nginx -> receiver。HAProxy 只让 Cloudflare 直接来源进入该域名的 HTTPS 分支，Caddy 只在这条受控链路中接受 `CF-Connecting-IP`，Nginx 再按 SHEIN 官方推送 IP 放行；官方 HMAC 签名始终是主校验。
- 应用入口预算 1.2 秒、receipt SQL statement timeout 0.8 秒、Nginx read timeout 1.4 秒；仅在密文 receipt 与队列可靠落库后返回 200。
- PostgreSQL 只保存 AES 密文与最小规范化投影，不保存解密后的原始 payload；BI API 不返回 App/openKey、密文或买家原始信息。
- worker 使用租约、`FOR UPDATE SKIP LOCKED`、续租失败中止、指数重试与 dead-letter；授权/额度事件先完成数据库封闸，再启动可能较慢的飞书通知。
- worker 以独立 `shein_webhook_ops` PostgreSQL 角色调用两个按单 `SECURITY DEFINER` apply 函数，不调用 sudo/Docker；事实表只有只读回读权限，没有原始 INSERT/UPDATE/DELETE、`ops.link_ops_*`、日汇总或 reconciliation 写权限。Portal 的 `shein_link_ops` 只能读取 receipt/gate 安全投影并调用受控授权恢复函数，不能读密文、任意改 gate 或修改订单/退货事实。
- 授权无业务时间的重复真实事件不会被永久去重，重签重试以 10 分钟时间桶抑制重复飞书；额度 gate 按平台 `sendTimeStamp` 单调更新，延迟到达的旧恢复不能覆盖更新的额度归零。缺失/非法事件顺序的额度归零仍会立即失败关闭，并禁止不确定的自动恢复。
- 真实 SHEIN 提交在预检查、整批 executor、每个店铺子执行器启动前，以及子执行器每一次真实 `client.request` 写调用的紧前一刻核验平台 gate；repository 缺失、目标店缺失或查询异常均失败关闭。
- P0 通知有稳定幂等键；普通事件和 P1 只留在 BI。
- 平台订阅/消息测试可能使用“App 有效、openKey 不是任一店铺正式 openKey”的技术探针。此类投递只在 App 能唯一映射到店铺时接收，并强制标记为 `appScopedOnly + P3`：只保留审计 receipt，不封闸、不调用订单/退货处理、不修改运营任务、不发飞书；worker 重建规范化对象时必须保留该隔离标记。
- `x-lt-eventCode` 同时兼容开放平台实际发送的路由名与历史数字编号，内部统一映射到固定事件定义，不再把路由名误判为未知事件。

## 界面

- 顶部导航新增“平台动态”独立入口。
- 展示最近 24 小时、待处理、失败、P0 和最后接收时间。
- 支持店铺、级别、事件类型和处理状态筛选。
- 页面只使用规范化业务字段，并沿用 `bi_session + readStores` 权限；SQL 再做一次店铺范围限制。
- 正常“平台动态”摘要与时间线默认排除 `appScopedOnly` 技术验证记录；技术记录仍保留在数据库并可由明确的审计调用读取，避免把订阅调试样例展示成业务动态。

## 发布与验收

- 本地门禁：官方 payload 样例、19 店映射、幂等仓库、乱序 gate、双重提交闸门、租约 worker、单号定向入仓、Portal 权限、Caddy/Nginx/systemd 安全契约与完整 `npm test`。官方未提供签名/密文 golden vector，最终以生产真实 secret 合成验签和平台官方调试推送补足。
- 云端采用精确文件热部署并先备份，不拉取/重置生产脏工作树；标准 443 信任链只精确修改 HAProxy/Caddy 对应配置，不覆盖其他域名或 SSH 分流。
- 数据库迁移：`infra/warehouse/migrations/20260719_001_shein_webhook_runtime.sql`。
- 飞书问数服务必须继续保持 `disabled + inactive`。
- “接收端已部署”不等于“19 个 App 已产生真实回调”；各 App 的回调订阅/平台审核和真实事件 readback 需独立验收。

### 生产验收记录

- 生产备份：`/srv/shein-bi/backups/webhook-20260719-201237-pre-704acad`，包含应用文件、服务、Nginx、Caddy、UFW 与数据库 ACL 基线；未对生产脏工作树执行 pull、reset 或 clean。
- `shein-bi-portal`、`shein-bi-webhook`、Nginx、Caddy 均为 `active`；Webhook 启动回读为 19 个 App / 19 个店铺、数据库正常、worker 已启用。Portal `/api/health`、Webhook `/healthz`、平台动态 summary/events API 均返回成功；平台动态入口已出现在生产 HTML。
- 正式回调已切到标准 443。HAProxy 对 `sa.dushengyi.cc` 的 TLS 分支增加 Cloudflare 直接来源约束并继续保留 SSH-over-443；Caddy 10443 只在该受控上游后使用 Cloudflare 原始来源头，Nginx 仍执行 SHEIN 官方推送 IP allowlist。受限 8443 回退入口继续保留，但不再写入开放平台回调配置。
- 使用生产 App 凭据在服务器本机生成 AES 密文与官方 HMAC 签名，向事件 `3000910` 发送唯一 P3 合成回调：入口返回 200、异步 receipt 进入 `succeeded`、worker `failed=0`；测试 receipt 随后按唯一业务键删除，剩余 0。该事件不触发飞书、不调用 SHEIN 写接口。
- 实测数据库隔离：`shein_webhook_ops` 原始修改订单事实表、读取 `ops.link_ops_*` 均被拒绝；`shein_link_ops` 读取 receipt 密文、直接修改 gate 均被拒绝；worker 仅保留两个受控 apply 函数执行权。
- 本轮完整 `npm test` 为 104/104；4 个变更运行文件与本地候选 SHA-256 一致，生产 HAProxy 配置与仓库模板一致。漏装的 catalog executor 闸门版本和修复后的角色配置脚本已单独热补，并把旧文件保存到此前备份的 `app-final-hotfix` 子目录。
- 飞书问数服务已复核为 `disabled + inactive`；普通/P1/P3 事件不会发飞书，只有 P0 使用稳定幂等键发送摘要。
- 部署中发现系统 `/usr/lib` 原有元数据为 `sheinops:sheinops 0750`。纠正所有者后曾短暂形成 `root:root 0750`，导致普通 SSH shell 无法执行；已通过腾讯云执行命令恢复为 `root:root 0755`，随后验证 SSH、sudo、Caddy reload 及全部核心服务正常，全程未重启主机。共享 secrets 目录保持 `root:sheinops 0750`，Webhook 独立环境文件为 `root:root 0600`。
- 2026-07-20 已完成 19/19 个半托管 App 的正式/测试回调审核，目标均为标准 443 URL，最新记录均为审核通过；每店允许的 10 类事件均逐项订阅并回读为 10/10。CX 的官方“消息测试”已成功发送并由 receiver/worker 正常接收。
- 全店订阅验证共形成 190 条技术 receipt，最终全部为 `succeeded + P3 + appScopedOnly`，队列、失败、dead-letter、P0、业务 gate、合成订单/退货行和飞书发送均为 0。验证期间发现 worker 曾在重新解密时丢失隔离标记，导致样例短暂误触发 28 个 gate、14 个退货 header/14 个 item，并实际发送 74 条飞书高优先级测试消息；根因修复后已精确回滚数据库副作用、撤回全部 74 条消息并发送一次更正说明，不删除 190 条审计 receipt。
- 隔离上线后又真实收到 NM、MZ 两条订单事件，均完成按单入仓并在 BI“平台动态”展示；页面当前为 2 条业务事件、待处理 0、失败 0、P0 0，且不显示 190 条技术验证记录。
- 本轮关键备份：`/srv/shein-bi/backups/webhook-trusted-proxy-20260720-165027`、`/srv/shein-bi/backups/webhook-worker-quarantine-20260720-173224`、`/srv/shein-bi/backups/webhook-subscription-fixture-remediation-20260720-173325`、`/srv/shein-bi/backups/webhook-final-rollout-20260720-175338`。生产 `shein-bi-webhook.service` 保持 `active + enabled`、worker 正常轮询；飞书问数服务与 Codex `shein-webhook` 续跑任务继续保持暂停。

详细运行与回滚边界见 [SHEIN Webhook 接收与平台动态](shein-webhook-receiver-design.md)。
