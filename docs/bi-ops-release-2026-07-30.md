# SHEIN BI / Ops 2026.07.30.1 发布说明

发布日期：2026-07-30

标签：`2026.07.30.1`

上一正式版本：`2026.07.28.4`

## 本版范围

### 利润与售后

- 首页“订单创建时间”的待落定金额与利润“待决售后风险”共用标准化风险金额；同一售后申请在多个流程状态中的重复行不再重复计款，风险金额按实际订单收入封顶。
- RTV 入仓测算改为“风险调整后利润 + 已确认回仓可二售成本”，并消除日粒度四舍五入后再汇总产生的分币漂移。

### 营销自动化

- 高点击低转化专属折扣增加“近 7 天曝光 >= 3000、加车访客 >= 20、销量 = 0”入口；原曝光/点击率入口继续保留。
- 高点击专属折扣优先于新品、重新上架和普通漏兜底阶段；相同 `storeKey + SKC` 不再被两个策略重复处理。
- 最新原始链接快照可以在不覆盖 BI 流量、活动和库存证据的前提下修正更新的上架状态与首次上架时间。
- 完整 19 店营销扫描与定点补扫明确分离；定点扫描不能冒充完整基线。
- 普通活动列表差额统一使用平台 `allowGoodsNum - applyGoodsNum`，并把新增专项 smoke 纳入确定性测试。
- 已批准普通活动截止前新增可报差额、加车访客专属折扣入口和精确回读规则已同步到长期运维文档与项目 skill。

### OpenAPI、磁盘与部署治理

- 补齐 OpenAPI 排除销售对账的表头/商品行一致性。
- 半托 profiles、outputs、runtime、backup 已迁移到 100GB 数据盘，并收紧本地保留与 COS 归档规则。
- Portal `index.html`、`data.json` 和 section cache 改为纯运行时生成物，不再进入 Git。
- 人工特殊限时折扣生产登记迁到 `/srv/shein-bi/runtime`；仓库配置只作种子，数据库备份会同步保存该登记。
- 新增源码、GitHub release、云端 checkout 与运行态的版本治理规则；正式发布完成时云端 tracked source 必须精确落到本 tag commit 且无源码脏改。

## 验证

- `npm test`
- `git diff --check`
- Markdown 相对链接检查
- 云端 PostgreSQL 利润 mart 刷新与本月售后/RTV 公式回读
- Portal `afterSales`、`profit`、`homeProfit` section 预热
- Portal health、systemd unit、数据库审计和 GitHub CI

## 部署与回滚

- 正式生产部署必须以本 tag 指向的 commit 为唯一源码目标，并在部署后重新生成 Portal。
- 生产运行态、数据库、日志、profile 和 mutable registry 不随 Git reset/pull 覆盖。
- 源码回滚点：`2026.07.28.4`。回滚源码后仍需按该版本 schema/unit 边界重建 Portal，并保留当前数据库与运行态备份。

## 已知边界

- Webhook/OpenAPI、Portal 页面和数据库读回仍是业务真相；Git tag 只能证明源码版本。
- 营销自动写仍只覆盖负责人已批准的长期策略范围；未批准的新普通活动、优惠券和补预算不因本版扩大权限。
