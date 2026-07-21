# SHEIN BI / Ops 2026.07.18.1 发布说明

发布日期：2026-07-18
范围：利润、售后、成本、库存、仓储分摊、OpenAPI 日更稳定性、营销无人值守巡检与受控修复

## 结论

本版不是单纯代码整理，而是对业务口径和生产流程做一次完整收口：未结售后不再提前改写真实利润；退货费优先使用财务/退货单实际金额；库存、成本和仓储费都改为可追溯、守恒且缺失即显式未知；营销巡检从“全量扫描夹带几十条同步写入”拆成分钟级只读巡检与有界 repair worker。

## 业务口径

- 待处理售后只展示风险金额，不提前计作最终退款；落定后再进入净销售和利润反转。
- 退货费优先级为：财务核对单已结算金额 -> 退货单商品行 `performancePrice` -> 确认退货包裹但无实价时 `13.88 SAR` 估算。生产 71/71 条已映射，实际出现 `13.88 / 14.35 / 16.77 SAR`。
- 首个可信 ET 实盘日前的历史保留 `legacy_pre_cutover_estimate`；切点以后按生效日前结存与移动加权平均成本核算，未来入库不再穿越改写过去。
- ET 运营可售默认只认 `09`，`SK-03038` 例外为 `09+01`；全仓物理量单列。缺失或过期证据显示 `unknown`，不得伪造为 0。
- 仓储费先按货号证据，再按货号 × 店铺销量分配；无人承担的余额进入 `CENTRAL_POOL`，每日总账、货号和店铺三层守恒。
- `DL-SK-13034` 已归并到 `SK13034`：ET 运营可售 107、物理总量 120、成本 95 SAR、库存余额 11,400 SAR。

详细口径见 [bi-business-logic-hardening-2026-07-18.md](bi-business-logic-hardening-2026-07-18.md)。

## 营销巡检瘦身

### 原根因

旧 service 同时执行全店活动扫描、61 条/32 组同步修复和最终回读；同一营销事实又在日更、stack review、当前价格扫描中重复抓取，并叠加 systemd 前后清理、父脚本清理、子脚本清理和每 30 分钟全局清理。结果不是“平台数据量变大”，而是流程叠床架屋、浏览器反复启停和扫描被写入阶段拖住。

### 新流程

1. guard 仅用 session HTTP 读取 19 店普通活动、15% 券 active 集合、当前/未来普通活动和限时折扣价格层。
2. 当次实时证据完整时，旧 `coupon submit / low-price / old-ordinary` 五份中间扫描只作历史审计；任何店铺、券规则、价格层或同轮时间门禁不完整则 fail closed。
3. guard 只生成精确 manifest、work hash 和 repair queue，不启动浏览器、不持有写授权、不做清理。
4. repair worker 每轮最多处理 8 个活动组；负责人长期授权免逐次人工确认，但不免 hash，仍强制 preflight、精确 hash、旧活动快照、事务 journal、失败补偿和最终全店 readback。
5. 浏览器孤儿清理由每小时 `:15` 的租约感知 cleanup 负责；实际启动浏览器的 worker 只关闭自己持有租约的店铺。

生产实测（2026-07-18 21:06）：

- 完整 19 店 guard：157 秒；
- 当前/未来营销价：1516 行，19/19 店成功；
- Chrome：0 -> 0；
- active 15% 券：7 个，均无当前/未来普通活动或限时折扣重叠；
- 最终报告：0 blocker、0 source warning；
- repair queue：0 待处理组。

## 抓数与数仓稳定性

- 修复业务域错误分支遗漏 `node:fs` 同步依赖；失败不再用空结果覆盖已存在事实。
- OpenAPI 销售/商品 runner 先单进程 `--ensure-only`，并行 worker 使用 `--skip-ensure`，避免多店 DDL 与 upsert 交叉死锁。
- `2026-07-09..15` 销售回灌 133/133 matched，深度差异全 0；因首轮映射/门禁曾有缺陷，仍以 `2026-07-17..23` 为新验证窗口，2026-07-24 出结论前继续使用 WebAPI 生产事实源。
- 利润 mart 使用当轮物化 cache，生产刷新约 119 秒；审计约 8 秒。仓储三层分配最大差额低于 `0.000001 SAR`。

## 调度变化

- guard：`10:30 / 13:30 / 16:30`，当天首次成功后后续窗口只作失败重试。
- repair：`10:50 / 12:50 / 14:50 / 16:50 / 18:50`。
- browser cleanup：每小时 `:15`，不再每 30 分钟全局清理。
- 日更不再重复调用 MBRs 全店营销价格扫描；SBN 营销概览仍属于慢变业务域日更。
- 高频 today/ET/watchdog 使用 `Persistent=false`；每日唯一性任务使用 `Persistent=true` 并依靠锁、日期成功状态和资源门禁防重。
- 飞书问数继续保持 `disabled + inactive`；网页问数和 CLI 不受影响。
- 2026-07-21 修复 Owner CLI 多条件链接问数：此前“近 7 天点击率 ≥ 4%、曝光 ≥ 3000、销量 0”被通用销售分支错路由为今日店铺销售，并可能因否定式安全说明触发模型拒绝；小时级销售 core 更新后，日更链接 section 又会因 envelope 代次不同被错误跳过。现在由结构化 `storeLinks` 筛选器直接计算，链接业务日期一致时允许跨 core 代次读取，覆盖 JSH/TZZ/XC 在内的 19 店。生产同句回读命中 9 条、约 675ms，备份为 `/srv/shein-bi/backups/bi-ops-link-query-20260721-143315`；伙伴电脑无需本地经营报表，也无需升级 CLI 包。

## 验收与回滚

- 自动回归：`npm test`、`git diff --check`、Node/Bash 语法、systemd contract、warehouse 业务口径与营销事务 smoke。
- 云端验收：19 店 guard、repair 写后全店 readback、Portal health、timer 状态、Lark disabled/inactive、Chrome 进程归零。
- 数据库发布前备份：`/srv/shein-bi/backups/auto/20260718-192014`。
- 代码热部署均保留在 `/srv/shein-bi/backups/releases/2026.07.18.1-*`；回滚时恢复对应文件、`systemctl daemon-reload`，再重跑数仓刷新和只读 guard。
