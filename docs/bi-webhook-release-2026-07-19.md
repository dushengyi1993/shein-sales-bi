# SHEIN BI / Ops 2026.07.19.2 发布说明

发布日期：2026-07-19
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

- 公网回调：`https://sa.dushengyi.cc:8443/api/shein/webhook/v1/events`。
- UFW/Caddy 只接受 Cloudflare 边缘来源，Nginx 再按 SHEIN 官方推送 IP 放行；官方 HMAC 签名始终是主校验。
- 应用入口预算 1.2 秒、receipt SQL statement timeout 0.8 秒、Nginx read timeout 1.4 秒；仅在密文 receipt 与队列可靠落库后返回 200。
- PostgreSQL 只保存 AES 密文与最小规范化投影，不保存解密后的原始 payload；BI API 不返回 App/openKey、密文或买家原始信息。
- worker 使用租约、`FOR UPDATE SKIP LOCKED`、续租失败中止、指数重试与 dead-letter；授权/额度事件先完成数据库封闸，再启动可能较慢的飞书通知。
- worker 以独立 `shein_webhook_ops` PostgreSQL 角色调用两个按单 `SECURITY DEFINER` apply 函数，不调用 sudo/Docker；事实表只有只读回读权限，没有原始 INSERT/UPDATE/DELETE、`ops.link_ops_*`、日汇总或 reconciliation 写权限。Portal 的 `shein_link_ops` 只能读取 receipt/gate 安全投影并调用受控授权恢复函数，不能读密文、任意改 gate 或修改订单/退货事实。
- 授权无业务时间的重复真实事件不会被永久去重，重签重试以 10 分钟时间桶抑制重复飞书；额度 gate 按平台 `sendTimeStamp` 单调更新，延迟到达的旧恢复不能覆盖更新的额度归零。缺失/非法事件顺序的额度归零仍会立即失败关闭，并禁止不确定的自动恢复。
- 真实 SHEIN 提交在预检查、整批 executor、每个店铺子执行器启动前，以及子执行器每一次真实 `client.request` 写调用的紧前一刻核验平台 gate；repository 缺失、目标店缺失或查询异常均失败关闭。
- P0 通知有稳定幂等键；普通事件和 P1 只留在 BI。

## 界面

- 顶部导航新增“平台动态”独立入口。
- 展示最近 24 小时、待处理、失败、P0 和最后接收时间。
- 支持店铺、级别、事件类型和处理状态筛选。
- 页面只使用规范化业务字段，并沿用 `bi_session + readStores` 权限；SQL 再做一次店铺范围限制。

## 发布与验收

- 本地门禁：官方 payload 样例、19 店映射、幂等仓库、乱序 gate、双重提交闸门、租约 worker、单号定向入仓、Portal 权限、Caddy/Nginx/systemd 安全契约与完整 `npm test`。官方未提供签名/密文 golden vector，最终以生产真实 secret 合成验签和平台官方调试推送补足。
- 云端采用精确文件热部署并先备份，不拉取/重置生产脏工作树；Caddy 只合并 8443 block，不覆盖其他域名。
- 数据库迁移：`infra/warehouse/migrations/20260719_001_shein_webhook_runtime.sql`。
- 飞书问数服务必须继续保持 `disabled + inactive`。
- “接收端已部署”不等于“19 个 App 已产生真实回调”；各 App 的回调订阅/平台审核和真实事件 readback 需独立验收。

详细运行与回滚边界见 [SHEIN Webhook 接收与平台动态](shein-webhook-receiver-design.md)。
