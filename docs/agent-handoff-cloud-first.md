# SHEIN BI Agent 交接说明（云端优先）

> 更新时间：2026-07-26
> 用途：后续 agent 接手开发、排障、部署或业务核验时的最短入口。详细排班以 `infra/systemd/*.timer` 为准，运行步骤见 [cloud-bi-operations.md](cloud-bi-operations.md)。

## 1. 一句话原则

**GitHub 是可恢复源码基线，云端运行态是生产事实；两者都不能代替另一方。**

- 判断当前数据、页面、服务、timer 或故障：查云端 PostgreSQL、线上 API、日志和 systemd。
- 修改代码和发版：在 GitHub 工作树审查、测试、提交和打 tag。
- 部署：先备份云端，再把目标 commit 的精确文件部署到 `/opt/shein-bi/app`，重启必要服务并做真实回读。
- 不能拿仓库 `outputs/bi-portal/*` 推断线上数据，也不能把云端未审查的运行态差异整包提交回 GitHub。

## 2. 当前生产入口

| 项 | 当前值 |
|---|---|
| BI Portal | `https://sa.dushengyi.cc/` |
| 登录维护 | `https://sa.dushengyi.cc/cloud-login-maintenance` |
| 云端 SSH | `ssh shein-bi-tencent` |
| 应用目录 | `/opt/shein-bi/app` |
| 数据底座 | PostgreSQL warehouse + Metabase |
| 半托 OpenAPI | DL 单一 App + 19 店唯一 OpenKey |
| 当天销售 | 订单 Webhook → 按单 OpenAPI → 正式事实 → Portal SSE |
| 最终日销售 | WebAPI 独立核对 + 19/19 OpenAPI 深度匹配后原子晋升 |
| 飞书 | Base/看板暂停；日报手动；P0 异常提醒保留；问数 service 停用 |

19 店：`CX DL DX FY HL JSH JY LQ MZ NM QH QY TS TZ TZZ XC XL YJ ZL`。

## 3. 当前关键服务

- `shein-bi-portal.service`：BI、section API、网页问数、自动运营任务与 SSE。
- `shein-bi-webhook.service`：半托 Webhook 接收、幂等队列、按单同步与经营风险事件。
- `shein-warehouse-db` / `shein-metabase` / `shein-metabase-db`：Docker 数据与分析层。
- `shein-bi-cloud-yesterday.timer`：`03:00` 最终日核对与 OpenAPI 晋升门禁。
- `shein-bi-cloud-morning-chain.timer`：`08:00` 前一完整日慢变补采。
- `shein-bi-cloud-marketing-live-guard.timer`：`10:30/13:30/16:30` 只读巡检/重试。
- `shein-bi-cloud-marketing-repair.timer`：有界营销修复与最终回读。
- `shein-bi-cloud-watchdog.timer`：每小时 `:50` 只读体检与异常提醒。
- `shein-bi-cloud-browser-cleanup.timer`：`03:45/09:50/21:00` 租约感知的孤儿浏览器清理。
- `shein-bi-lark-sales-qa.service`：必须保持 `disabled + inactive`。

不要从本文件复制完整排班；部署前直接读取：

```bash
systemctl list-timers --all | grep -E 'shein-bi|gaobao' || true
systemctl cat shein-bi-cloud-yesterday.timer
systemctl cat shein-bi-cloud-marketing-live-guard.timer
systemctl cat shein-bi-cloud-marketing-repair.timer
systemctl cat shein-bi-cloud-browser-cleanup.timer
```

## 4. 数据与业务边界

### 销售

- 2026-07-23 起，半托当天销售由 Webhook 触发按单 OpenAPI 写正式事实，不再运行每小时全店 `today` timer。
- `03:00` WebAPI 只生成独立核对文件；切换日以后不得成为第二份正式事实。
- 只有 19/19 店 OpenAPI 与 WebAPI 深度匹配，才调用受限数据库函数原子晋升最终日切片。
- 当天无订单可以是合法零值；事件驱动日不能仅因缺销售行报警。

### 其它数据域

- 商品流量、四档状态、营销活动、编辑级商品资料、订单生命周期复查、ET 和 RTV 没有因销售切源而全部实时化。
- Webhook 是变化触发源，不代替详情查询；它永不直接修改 SHEIN。
- 退货实时更新经营风险与收入冲回；准确 RTV、退货费、仓储费和最终会计利润由日更收口。

### 自动运营

- 会话、任务、job、事件和审计在 PostgreSQL `ops.link_ops_*`。
- 真实写默认先预演、锁 payload hash、明确确认、受控执行和回读。
- 负责人长期营销授权只覆盖白名单限时折扣动作；用户无需逐次提供 hash，但系统每轮仍必须自动计算、锁定和校验精确 work hash。
- 负责人经验单向发布；同事只消费，不能反向覆盖。

## 5. 云端核验命令

```bash
cd /opt/shein-bi/app

git rev-parse HEAD
git status --short

systemctl is-active shein-bi-portal.service
systemctl is-active shein-bi-webhook.service
systemctl is-enabled shein-bi-lark-sales-qa.service || true
systemctl is-active shein-bi-lark-sales-qa.service || true

systemctl list-timers --all | grep shein-bi
journalctl -u shein-bi-portal.service -n 100 --no-pager
journalctl -u shein-bi-webhook.service -n 100 --no-pager

node scripts/cloud_ops_watchdog.mjs --dry-run
node scripts/audit_bi_warehouse.mjs
```

涉及当前页面数据时，还要带有效 BI 登录会话回读 `/api/health` 和受影响的 `/api/bi/section/*`；未登录公网返回 `401` 不是服务故障。

## 6. GitHub 与云端差异处理

1. 先记录本地和云端 `HEAD`、`git status --short`。
2. 将云端差异分成：
   - 可再生运行产物；
   - 私有 `.local`/secret/session；
   - 已审核生产热修；
   - 过期或未知文件。
3. 私有运行态绝不回填 GitHub。
4. 生产热修只按精确文件审查、测试和提交，不能 `git add -A` 把云端目录整体当源码。
5. GitHub 发布不自动代表已部署；云端部署后必须记录目标 SHA、服务状态和业务回读。

标准顺序：

```text
审查 GitHub 工作树
→ 测试
→ commit/tag/release
→ 云端备份
→ 部署目标 SHA
→ daemon-reload/重启必要服务
→ API、数据库、timer、日志和业务回读
→ 记录回滚点
```

## 7. 敏感信息红线

以下内容不得进入 Git、Release、文档、日志摘录或聊天：

- SHEIN/OpenAPI App Secret、OpenKey、temp token；
- BI/飞书/ET 账号密码与 session；
- Cookie、浏览器 profile、noVNC token；
- PostgreSQL/Metabase 密码和数据库 dump；
- 云端 `.local` 配置或 EnvironmentFile。

允许提交的只是脱敏模板、schema、迁移、脚本和不含真实值的配置示例。

## 8. 不要恢复的旧架构

- 本地 `127.0.0.1:8787`、局域网 8787 和 `SHEIN-*` Windows 计划任务只作回滚参考。
- 不恢复每小时当天销售 timer；实时销售异常应查 Webhook receipt、OpenAPI targeted sync、PostgreSQL `NOTIFY` 和 Portal SSE。
- 不恢复每 30 分钟或每小时全局浏览器清理；当前只清无有效租约的孤儿。
- 不启用飞书问数 service 或 Base/看板写入，除非用户重新明确授权并完成独立验收。
- 不把旧 18 个独立 OpenAPI App 重新混入生产配置；回滚必须按 [单应用切换记录](openapi-single-app-production-cutover-2026-07-26.md) 完整执行。

## 9. 推荐工作流

1. 先读根目录 `README.md`、`MEMORY.md` 和本文件。
2. 按任务再读：
   - 运维：[cloud-bi-operations.md](cloud-bi-operations.md)
   - 架构：[bi-system-architecture.md](bi-system-architecture.md)
   - Webhook：[shein-webhook-receiver-design.md](shein-webhook-receiver-design.md)
   - 营销：[marketing-daily-inspection-handoff.md](marketing-daily-inspection-handoff.md)
   - 自动运营：[bi-ops-v2-release-2026-07-12.md](bi-ops-v2-release-2026-07-12.md)
3. 当前事实先查云端；只读证据不足时明确说缺什么，不用旧快照补结论。
4. 修改前记录 dirty inventory；不 reset/checkout 覆盖他人改动。
5. 运行与风险相称的测试；真实写继续遵守预演、确认、审计和回读。

## 10. 完成定义

一次任务不能只以“脚本退出 0”结束。至少回答：

- 改了什么、没改什么；
- GitHub target SHA/tag 是什么；
- 是否实际部署云端；
- 哪些测试通过；
- 当前服务、数据和业务回读是否通过；
- 仍有什么 warning、blocked 或待人工动作；
- 回滚点在哪里。
