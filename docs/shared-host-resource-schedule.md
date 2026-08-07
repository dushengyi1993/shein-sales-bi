# 半托 / 全托共用主机任务与资源合同

> 联合基线：2026-08-07。生产事实仍以两项目各自正式 release、云端 `systemctl list-timers`、业务 run manifest 和 Portal 当前发布版本为准。

## 1. 业务任务边界

- 一个逻辑任务只有一个 `coordinator / run_id / timer`。
- 内部可以按店、主体或数据域并发，也可以记录 checkpoint、等待资源、只重试失败项；这些都是同一个 run，不得再拆成多个对用户可见的批次。
- 只有完整 manifest 到达 `READY_TO_PUBLISH` 后才能一次原子发布；`PARTIAL / WAITING / DEFERRED` 保留上一份完整页面，不把缺项冒充 0，也不触发第二次全量物化。
- Webhook、半托当天销售 reconciliation、当前库存等实时轻量流独立运行，不属于日结分片。
- systemd 的成功只表示该业务 run 已完整发布；资源忙和平台未 ready 是同 run 的等待状态，不得伪装成成功后再创建另一个补跑任务。

统一状态：

`CREATED → RUNNING → WAITING_PLATFORM / WAITING_RESOURCE → RETRYING → READY_TO_PUBLISH → PUBLISHED`

## 2. 半托任务

| 逻辑任务 | 入口 | 完整边界 | 目标 |
| --- | --- | --- | --- |
| 实时销售 | Webhook + 每15分钟 reconciliation | 只更新受影响订单/当天事实与轻量投影 | 分钟级 |
| 当前库存 | 每小时 `:12/:45` OpenAPI | 19店本轮全部成功后切换 `inventoryStock` | 15分钟内 |
| 每日经营刷新 | 每天 `07:10` 一个 `shein-bi-cloud-morning-chain.service` | 19店链接/业务域 → 失败店同run重试 → 仓库合并 → OpenAPI/成本/利润补充 → 一次Portal发布 → 当日库存维护 | 上班前完成；硬安全上限3小时 |
| 昨日销售定稿 | 每天 `02:45` | 19店OpenAPI完整门禁后一次晋升 | 03:30前 |
| RTV | 每天一次独立业务run | 完整追踪复核后更新RTV投影 | 日结前 |
| 订单闭环 | 每天一次独立业务run | 只重查未终态订单，完成后一次刷新订单投影 | 上班前 |
| ET | 8个经营检查点 | 每个检查点是一次完整增量；HTTP优先，不为读请求预留Chrome | 对应检查点后及时 |
| 仓储费 | 每天账单ready后一次 | canonical明细、利润cache和四层对账完整后发布 | 当日账单ready后 |
| 营销 | 只读guard与受控write分开 | 日常只读优先session HTTP；普通活动和需要大量浏览器的工作默认本机；写事务单店终态后回读 | 不阻塞实时/日结 |

半托每日经营刷新允许同一个 coordinator 内最多两个不同店铺的只读浏览器 worker。第二个槽只有在主机可用内存和负载门禁通过时才启动；任一店完成立即关闭自己的 Profile 并释放槽位。并行 worker 不是独立业务任务，最终仍只有一份19店 manifest 和一次发布。

旧的 `chunk-2 / recovery / supplements / inventory-retry` timer 已废弃，不得重新启用。失败店由原 run 的 checkpoint 定向续跑，不能从头重跑已完成店铺。

## 3. 全托任务

| 逻辑任务 | 完整边界 | 目标 |
| --- | --- | --- |
| `FM_REALTIME_COCKPIT` | 每小时一个run，同时收25店OpenAPI销售与session-HTTP经营事实，完整后一次物化 | 目标6分钟，硬SLO10分钟 |
| `FM_DAILY_OPERATIONS_CLOSE` | D-1 readiness → 25店history/ledger checkpoint → 一次发布 | 06:30目标，07:00硬SLO |
| `FM_DAILY_SUPPLY_CLOSE` | 25店/域checkpoint，失败只重试失败店/域，一次supply manifest | 03:00前 |
| `FM_DAILY_FINANCE_CLOSE` | 平台ready后单run、并发2、一次发布 | 04:00前 |
| `FM_SESSION_MAINTENANCE` | HTTP验证25店，只对失效店启动浏览器恢复 | HTTP阶段30秒，事件恢复15分钟 |
| Webhook hydration | 受影响对象增量回查和小投影 | 不逐事件重建整站 |

五个5店日更 timer、整批 retry timer、独立高频 materializer 不再代表用户业务。内部 worker 可以分组，但必须服从同一个 run_id；`PARTIAL/75` 不触发 `OnSuccess` 物化。

## 4. 共机资源令牌

- `api-light`：全机并发2；内部OpenAPI全局建议不超过3，同主体/同应用并发1。实时销售、Webhook和库存轻量流不等待浏览器锁。
- `browser-read`：全机最多2个不同 Profile。第2槽仅在 `MemAvailable >= 4GiB` 且负载/PSI门禁通过时准入。
- `browser-write`：全机1个，排他；事务中不中杀，店铺终态后才释放。
- `db-projection`：全机1个，只覆盖最终成本/利润/Portal投影阶段。
- `io-heavy`：全机1个，备份、恢复测试、大归档不与大物化并行。
- coordinator 按阶段拿取并释放令牌，禁止在HTTP等待、平台未ready或整个多店循环期间长期占有不需要的重令牌。

## 5. 浏览器原则

- 能用 OpenAPI、Webhook 或已导出的 session HTTP 准确完成的流程，不开浏览器。
- 浏览器只用于平台没有接口的数据、失效授权恢复、验证码/协议弹窗和确需页面提交的写操作。
- 本地与云端登录态分别维护，不能互相冒充。
- 每个 worker 只关闭自己租约创建的 Profile；孤儿清理由租约保护，禁止粗暴 `pkill`。
- 周普通营销等大批浏览器工作优先本机后台执行；本机可以3–4个Profile一批，批次结束全部关闭再开下一批。

## 6. 完成与验收

一次业务任务完成必须同时满足：

1. 预期店铺/域 checkpoint 齐全，或缺口被标记为明确的终态能力差异；
2. run manifest 的 business date、source checksum 和店铺集合一致；
3. 只执行一次最终物化/原子切换；
4. Portal 只读取 `PUBLISHED` manifest，失败时仍返回上一完整版本；
5. systemd timer 只有一个用户任务入口，旧分片 timer 为 disabled/absent；
6. 云端 release、GitHub commit、deployment marker 和 tracked source 完全一致；
7. 实跑记录真实墙钟、失败店/域重试次数、浏览器峰值和最终页面数据时间。
