# SHEIN BI / Ops 2026.07.19.2 发布说明

发布日期：2026-07-19
范围：SHEIN OpenAPI Webhook 第一阶段、BI“平台动态”、订单/退货按单增量、授权/额度安全闸门、P0 飞书摘要

## 发布结论

本版把 SHEIN 平台事件从“等待下一轮抓数才发现”升级为可靠的实时触发层，但不改变受控写边界：Webhook 只负责接收、记录、补充只读事实和关闭风险闸门，永不直接修改 SHEIN。

BI 新增独立“平台动态”子页面，普通状态变化不再塞入首页或飞书。飞书只发送 P0：授权关系变化、额度归零、审核失败、非预期下架/删除和必需合规失效。

## 第一阶段能力

### 商品生命周期

- 商品接收、普通/全渠道审核、上下架、删除审核进入平台动态。
- 只有“店铺 + 至少两个平台强身份字段”唯一命中现有运营任务时，才追加任务 readback；不唯一时只记录事件。
- 审核失败、非预期下架、删除获批或删除审核失败为 P0。

### 订单与退货

- 收到订单号或退货单号后调用对应 OpenAPI 详情接口。
- 同一事务只精准替换该 `店铺 + 单号` 的子项，再 upsert header；不删除日期切片、不重写整日 reconciliation。
- 写后按同一业务键核对 header、item 和 payment flag 数量。

### 授权、额度与合规

- 授权关系变化立即关闭该店授权闸门；只有事件之后更新且成功的店铺只读探针可以自动解除。
- 商品额度为 0 时关闭额度闸门，收到恢复为正数的事件后开闸。
- 合规失效按商品/证书对象记录，不误封整店。

## 可靠性与安全

- 公网回调：`https://sa.dushengyi.cc:8443/api/shein/webhook/v1/events`。
- UFW/Caddy 只接受 Cloudflare 边缘来源，Nginx 再按 SHEIN 官方推送 IP 放行；官方 HMAC 签名始终是主校验。
- 应用入口预算 1.2 秒、receipt SQL statement timeout 0.8 秒、Nginx read timeout 1.4 秒；仅在密文 receipt 与队列可靠落库后返回 200。
- PostgreSQL 只保存 AES 密文与最小规范化投影，不保存解密后的原始 payload；BI API 不返回 App/openKey、密文或买家原始信息。
- worker 使用租约、`FOR UPDATE SKIP LOCKED`、续租失败中止、指数重试与 dead-letter。
- worker 以独立 `shein_webhook_ops` PostgreSQL 角色直接执行精准 SQL，不调用 sudo/Docker；没有日汇总和 reconciliation 写权限。Portal 的 `shein_link_ops` 只能读取 receipt 安全投影，不能读密文或删除订单/退货事实。
- 授权无业务时间的重复真实事件不会被永久去重；gate 按 receipt ID 单调更新，旧额度恢复不能覆盖更新的额度归零。
- 真实 SHEIN 提交在预检查与 executor 前各核验一次平台 gate，repository 缺失或查询异常均失败关闭。
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
