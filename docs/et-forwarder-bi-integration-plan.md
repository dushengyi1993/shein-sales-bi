# ET 货代仓接入 BI 系统 PLAN

更新时间：`2026-05-07T17-55-00`
当前状态：已完成首次登录态验证与核心菜单/接口探查；本文件是开发前确认版。

## 1. 目标

把 ET 货代仓后台接入现有 SHEIN BI，补齐现在仅靠成本表和 SHEIN 后台无法稳定回答的问题：

- 每个标准货号真实还剩多少库存，分别在哪些仓：可售、整箱、退货、破损、报废、在途。
- 每批发货申请单从国内发出到海外仓上架的进度，与成本表批次是否一致。
- 买家订单是否真的从货代仓出库，SHEIN 物流单号和 ET 出库单是否能对上。
- 退货/RTV 是否已回到仓库，回到的是可售、破损还是报废。
- 头程、上架、拣货、仓储等费用能否与成本表、利润页互相校验。
- 让 BI 的“实际库存 / 去化周期 / 利润 / 售后履约”从估算升级为仓库实盘 + SHEIN 业务数据互证。

原则：ET 后台只读抓取，不做新增、调拨、支付、提交等写操作。

## 2. 登录与环境

- ET 专属浏览器 profile：`profiles/persistent-et-forwarder-profile`
- 入口：
  - `http://47.90.12.162:9007/Home/Index`
  - `http://wl.et-global.cn/Home/Index`
- 当前验证：用户已完成首次登录，页面标题为 `易通天下物流端`。
- 关键技术点：多数列表接口必须带请求头 `X-Requested-With: XMLHttpRequest`，否则同一 URL 会返回 `404 无法找到资源`。正式抓取器必须统一加这个请求头，并保留浏览器 cookie 登录态。
- 探索证据文件：
  - `outputs/et-forwarder/exploration-2026-05-07T05-25-23-607Z.json`
  - `outputs/et-forwarder/probe-xrw-2026-05-07T05-34-11-330Z.json`

> 注意：探索文件含业务数据样本，只作为本地开发证据，不上传、不发飞书、不展示给同事。

## 3. 仓库口径

| 仓库 | 业务含义 | BI 中的处理 |
|---|---|---|
| `ETRUH09散件仓` | 散件可售仓，绝大多数买家订单从这里发出 | 核心可售库存 |
| `ETRUH01整箱仓` | 海运整箱先到这里，再拆箱上架到 09；个别一件一箱货号可直接用箱号出库，如 `03038制冰机` | 整箱库存 / 待拆箱 / 可售补给来源 |
| `ETRUH03_RTV` | 退货、退回仓库，以及少量外部转运来的货 | 退货回仓库存，需区分可再售/异常 |
| `ETRUH04Damaged` | 破损仓，待换包装后可能再次销售 | 待修复库存，不直接计入可售 |
| `ETRUH06报废` | 毁损报废 | 损失库存，不计入可售 |

后续 BI 库存页同时展示：`可售库存 = 09 + 可直接出库的 01`、`待处理库存 = 03 + 04`、`损失库存 = 06 + 损溢单确认损失`。

## 4. 已探明核心数据源

### 4.1 商品与规格

| 页面 | 接口 | 价值 |
|---|---|---|
| 商品列表 | `/Goods/Goods/GetGridJson`，当前约 78 条 | ET SKU/条码/中文品名/英文名/申报货值/审核状态 |
| 平台条码管理 | `/Goods/PlatformSku/GetGridJson` | 可能用于平台 SKU 映射；当前样本为空，先低优先级 |
| SKU体积重量 | `/Goods/SkuSpecification/GetGridJson`，当前约 69 条 | 长宽高、体积、重量；用于选品利润标尺和体积运费模型 |

### 4.2 库存

| 页面 | 接口 | 当前样本规模 | 价值 |
|---|---|---:|---|
| 仓库库存查询 | `/Goods/StockSearch/GetStoreStockGridJson` | 103 条 | 散件/RTV/报废/破损等 SKU 实盘库存 |
| 整箱仓库存查询 | `/Goods/StockSearch/GetBoxStockGridJson` | 525 条 | 整箱库存、箱号、锁定状态、箱内 SKU |
| 库存流水账 | `/Goods/StockSearch/GetStockRunningGridJson` | 7396 条 | 入库、出库、调拨、损溢后的库存变动轨迹 |

库存本身不需要“开店以来全量快照”，但库存流水账值得全量补，因为它能解释“库存为什么变成现在这样”。

### 4.3 发货、箱子与入库

| 页面 | 接口 | 当前样本规模 | 价值 |
|---|---|---:|---|
| 发货申请单 | `/Delivery/ShipOrder/GetGridJson` | 89 单 | 对应成本表批次：发货单号、仓库、发出数量、重量、体积、运输方式、状态 |
| 发货申请单明细 | `/Delivery/ShipOrder/GetShipOrderDetailForm` | 按单 | 发货单下 SKU、数量、成本价、品名 |
| 发货申请单箱明细 | `/Delivery/ShipOrder/GetBoxDetailForm` | 按单 | 箱号、箱内数量、长宽高、重量、到仓状态 |
| 装箱管理 | `/Delivery/BoxList/GetGridJson` | 2562 箱 | 箱级运输状态，整箱仓和拆箱的桥梁 |
| 装箱明细 | `/Delivery/BoxList/GetDetailsGridJson` | 按箱 | 箱内 SKU/数量 |
| 入库单 | `/Delivery/StoreReceipt/GetGridJson` | 当前 30 天样本 0 | 作为入库确认补充证据，优先级低于发货申请单和库存流水 |

### 4.4 出库、RTV、调拨、损溢

| 页面 | 接口 | 当前样本规模 | 价值 |
|---|---|---:|---|
| 出库单 | `/Delivery/Outbound/GetGridJson` | 6150 单 | 买家订单出库，备注里的 `JTE...` 可关联 SHEIN 物流单号 |
| 出库明细 | `/Delivery/Outbound/GetOutboundDetailViewGridJson` | 按单 | 出库 SKU、数量，核对订单商品是否一致 |
| 平台RTV | `/Delivery/ReturnOrder/GetGridJson` | 311 单 | 退货回仓，`ShipmentNumber` 可关联 SHEIN 退货物流单号 |
| RTV 明细 | `/Delivery/ReturnOrder/GetDetailGridJson?id=...` | 按单 | 回仓 SKU、数量、入库数量、差异 |
| 调拨管理 | `/Delivery/Allocate/GetGridJson` | 7 单 | 01/03/04/06/09 之间移动，解释可售/破损/报废转换 |
| 调拨明细 | `/Delivery/Allocate/GetDetailGridJson?id=...` | 按单 | 调拨 SKU、数量、拒收/实收 |
| 换包装任务 | `/Delivery/ChangePack/GetGridJson` | 1 单 | 04 破损仓换包装后恢复可售的路径 |
| 损溢单 | `/Delivery/BoxDamaged/GetGridJson` | 65 单 | 头程/清关/盘点破损或丢失，影响真实损耗和利润 |

### 4.5 财务

| 页面 | 接口 | 当前样本规模 | 价值 |
|---|---|---:|---|
| 物流仓服账单 | `/Finance/IncomeBill/GetGridJson` | 7144 条 | 仓储费、拣货费、物流费、上架/下架等费用总账 |
| 物流仓服账单明细 | `/Finance/IncomeBill/GetDetailGridJson?id=...` | 按账单 | 拣货费等可回到 SKU；仓储费样本明细为空，需要继续看导出接口 |
| 账单汇总 | `/Finance/IncomeBill/GetSummaryGridJson` | 7 类 | 按费用类型汇总，用于月度财务校验 |
| 支付记录 | `/Finance/IncomeBillDetail/GetGridJson` | 35 条 | 账单是否已支付、支付批次、发票信息 |
| 运费查询 | `/Finance/FreightQuery/GetGridJson` | 11 条 | 未来运费估算、选品模型参考 |
| 资金流水账 / 物流发票 | 对应 `Finance` 接口 | 当前样本为空 | 低优先级，先保留接口能力 |

财务口径建议：成本表仍是头程和上架等已整理费用的主口径；ET 财务先用于核对和补充“仓储费、拣货费、出库相关费用”。如果仓储费无法直接拿到 SKU 明细，先按“库存量 × 体积 × 天数”的 stock-days 模型摊分，页面明确标注为估算分摊。

## 5. 与现有 SHEIN BI 的关联键

| ET 字段 | 对应现有数据 | 用途 |
|---|---|---|
| `Barcode` / `SkuCode` / `ModelNumber` | `config/product_catalog.json` + `config/product_aliases.json` + `lib/product_sku_normalizer.mjs` | 归并到标准货号 |
| `ShipOrderId`，如 `F260...` | 成本表发货申请单号 | 成本批次、到仓、在途、发货数量互证 |
| `OutboundId`，如 `CK260...` | ET 财务 `ClientFromId` / 账单来源单号 | 拣货费、出库费用、出库明细 |
| 出库单 `Remark` / `WaybillCode` | SHEIN 订单物流单号 | 判断订单是否真实出库、何时出库、哪个仓发出 |
| RTV `ShipmentNumber` | SHEIN 退货物流单号 | 判断退货是否回仓、回到哪个仓 |
| `BoxId` / `ClientBoxId` | 发货申请单箱明细、整箱库存 | 01 整箱仓、拆箱、箱号出库跟踪 |
| 财务 `IncomeBillId` | 财务明细/支付记录 | 费用支付状态与费用归因 |

需要特别处理：

- ET SKU 可能带店铺/批次前缀，例如 `DL-...`、`DL00...`，不能直接当标准货号。正式入仓前必须走现有货号归并规则；无法归并的集中列给用户确认。
- RTV 的物流号有时和 SHEIN 退货物流号对不上，因为 SHEIN 物流商可能中途换面单；这种情况需要在 SHEIN 退货物流详情里补抓真实物流号后再匹配。
- `03038制冰机` 等一件一箱货号可能从 01 整箱仓直接按箱号发货，库存和出库不能只看 09 散件仓。

## 6. 数据仓库设计

建议采用“原始抓取层 -> 事实表 -> 分析宽表”的结构。

### 6.1 原始层

- `raw.et_fetch_batch`：每次抓取批次、开始/结束时间、登录状态、成功/失败接口、错误信息。
- `raw.et_api_capture`：接口原始响应、URL、参数、页码、抓取时间、响应摘要。敏感字段不写入可视化层。

### 6.2 事实表

商品/规格：`fact.et_sku_master`、`fact.et_sku_specification`、`fact.et_platform_sku_map`。
库存：`fact.et_store_stock_snapshot`、`fact.et_box_stock_snapshot`、`fact.et_stock_running`。
发货/箱：`fact.et_ship_order`、`fact.et_ship_order_item`、`fact.et_ship_order_box`、`fact.et_box`、`fact.et_box_item`。
履约/退货/损耗：`fact.et_outbound`、`fact.et_outbound_item`、`fact.et_return_order`、`fact.et_return_order_item`、`fact.et_allocate`、`fact.et_allocate_item`、`fact.et_store_receipt`、`fact.et_change_pack`、`fact.et_box_damaged`。
财务：`fact.et_income_bill`、`fact.et_income_bill_item`、`fact.et_income_bill_summary`、`fact.et_income_payment`、`fact.et_freight_rate`。

### 6.3 分析层

- `mart.et_product_inventory_current`：标准货号维度的当前库存：09、01、03、04、06、在途、待拆箱、损耗。
- `mart.et_product_inventory_depletion`：结合 SHEIN 销量后的去化速度、可卖天数、补货/清货建议。
- `mart.et_ship_order_cost_reconciliation`：成本表批次 vs ET 发货申请单 vs 箱明细 vs 到仓状态。
- `mart.et_order_outbound_reconciliation`：SHEIN 订单物流号 vs ET 出库单，查漏发、重复、延迟。
- `mart.et_return_rtv_reconciliation`：SHEIN 售后/退货 vs ET RTV 入仓，查退货未回仓、破损、报废。
- `mart.et_warehouse_fee_monthly`：仓储/拣货/物流费用月度汇总和分摊。
- `mart.et_inventory_risk_actions`：可直接进入今日动作池的库存/仓储/退货风险。

## 7. 全量补数与日常更新节奏

### 7.1 一次性全量补数

建议全量补：

- 发货申请单 + 发货明细 + 箱明细：对应成本表批次。
- 装箱管理 + 箱明细：解释整箱库存和拆箱。
- 出库单 + 出库明细：用于订单真实履约校验。
- 平台RTV + RTV 明细：用于售后回仓校验。
- 损溢单：用于损耗和利润保守口径。
- 调拨、换包装：用于解释 03/04/06/09 仓间转换。
- 物流仓服账单、账单汇总、支付记录：用于财务核对和仓储费。
- 库存流水账：用于解释库存变化。
- SKU 体积重量、运费查询：用于选品模型。

执行方式：必须分模块、分日期窗口跑，避免一次压满电脑。抓取器支持 `--endpoints` 指定模块，例如先跑 `store_stock,box_stock`，再跑 `ship_order,box_list`，再跑 `outbound,return_order,box_damaged`，最后跑 `income_bill,income_payment`。每个模块补完再入仓和抽样校验。

不建议补“库存快照全历史”：库存快照只代表某个时间点，历史快照从现在无法反推；以后从接入当天开始每日保存即可。

### 7.2 日常更新

建议新增 ET 日常任务：

- `04:20`：ET 货代仓每日同步。
  - 抓当前库存快照、整箱库存快照、SKU 规格、运费表。
  - 出库、RTV、损溢、调拨、换包装、库存流水、发货申请单、箱明细、财务账单、支付记录都按“增量游标 + 重叠校验”抓：从最新页开始，抓到上一轮已见过的约 5 条记录即停止。
  - 日期条件只作为接口查询保险，不作为固定重抓窗口；若已有 state，以已见记录为准停抓；若还没有 state，日常任务最多先抓 2 页，完整历史补数单独跑。
  - 只有发现接口排序异常、登录中断、账单延迟或 state 缺口时，才临时扩大窗口补漏；不在每日任务里固定重抓 14/45/60 天。
- `05:30`：保持现有 SHEIN 链接/业务域抓取。
- `07:00`：BI 每日流水线统一入仓、体检、刷新门户和日报。

如果 ET 任务掉登录、验证码失败或接口异常：已抓到的数据正常落地，不中断 SHEIN / BI 主链路；BI 系统状态页显示 ET 数据过期/缺口；飞书日报或异常消息提醒具体失败模块。

## 8. BI 页面改造方案

### 8.1 实际库存 / 去化页升级

现有页面基于成本表估算库存，接入 ET 后改为三层：

1. 仓库实盘：09 可售、01 整箱、03 RTV、04 破损、06 报废。
2. 经营估算：近 7/30 天销量、去化速度、预计可卖天数。
3. 差异解释：成本表理论库存 vs ET 实盘差异，出库、RTV、损溢、调拨解释差异来源。

关键提醒：09 可售库存低且有销量、01 有货但 09 缺货、03 RTV 积压、04 破损积压、06 报废增加。

### 8.2 发货批次 / 在途页

展示每个标准货号的批次：成本表批次、ET 发货申请单、箱数、发出数量、海外仓入库数量、预计/实际到仓、是否缺头程费。用于看在途、到仓未上架、成本表与 ET 数量/体积/重量差异。

### 8.3 出库 / 履约核对页

以 SHEIN 订单为主线，关联 ET 出库单：SHEIN 有订单但 ET 无出库、ET 有出库但 SHEIN 无订单、SKU 不一致、出库延迟等都进风险池。

### 8.4 RTV / 售后回仓页

以 SHEIN 售后/退货为主线，关联 ET RTV：已退款未回仓、回仓到 03、回仓到 04/06、物流号对不上等分别提示。

### 8.5 财务 / 仓储费用页

展示仓储费、拣货费、物流费、其他费用月度趋势；ET 账单 vs 成本表费用 vs 利润页扣费差异；未支付账单和到期账单提醒。

### 8.6 今日动作池新增 ET 维度

新增动作类型：可售库存低、01 有货但 09 缺货、RTV 回仓未处理、破损仓待换包装、报废/损溢异常、订单未匹配 ET 出库、退货未匹配 ET RTV、成本表批次与 ET 发货申请单数量不一致。

## 9. 实施步骤

1. ET 只读抓取器：固化 profile、CDP 登录态检查、分页、重试、限速、原始响应落地。
2. 数据库表与入仓：建立 `fact.et_*` / `mart.et_*`，并接入现有标准货号归并。
3. 全量补数：按域回补并做断点续跑、行数/日期/字段体检。
4. BI 页面开发：先升级 `实际库存 / 去化`，再做发货批次、出库履约、RTV售后回仓、财务仓储，最后接动作池。
5. 定时任务与提醒：新增 `04:20 ET 货代仓同步`，`07:00 BI` 增加 ET 入仓和体检，飞书日报增加 ET 数据状态灯号。

## 10. 需要你确认的点

1. ET 每天同步时间是否按 `04:20` 执行？这样给 `05:30` SHEIN 抓取和 `07:00` BI 刷新留出缓冲。
2. 仓储费如果 ET 暂时拿不到 SKU 明细，是否接受先按“库存体积 × 天数”估算分摊？
3. 出库单和 RTV 的物流号匹配规则，是否同意先用 `Remark / ShipmentNumber` 直接匹配 SHEIN 物流号，匹配不到的再进入待复核池？
4. ET 财务里头程/上架等费用，是否继续只作为核对，不覆盖你成本表里的正式成本？我建议先不覆盖。

## 11. 风险与边界

- ET 登录有验证码和掉线风险；抓取器已接入本地自动登录：从 ET 专属 Chrome profile 读取已保存账号密码、识别 4 位验证码并提交登录。若验证码连续识别失败、密码失效或后台改版，仍会发送飞书异常提醒并保留上一版 ET 数据。
- `店铺管理` 页面含接口密钥等敏感字段，正式抓取默认不采集、不入库、不展示。
- ET 后台接口返回 `text/html` 但内容是 JSON，不能只靠 `content-type` 判断。
- 财务仓储费明细目前样本中仓储费账单的明细为空，需要后续继续探导出接口；如果确实拿不到 SKU 级明细，只能估算分摊。
- 所有 ET 后台操作必须保持只读；任何支付、调拨、新增发货单、创建退货单等按钮都不碰。
## 12. 2026-05-07 已确认落地补充

### 12.1 货号归并与非销售编码

- 7025 归并到 SK-7025A绞肉机。
- LQ榨汁机175 归并到 SK-JB-175离心式榨汁机。
- SM-520A电动缝纫机、CX1788手持搅拌器 作为新标准货号记录，目前属于在途新品。
- p-DL-FZ-666、P-DL-FZ-666、p-DLFZ666、PDLFZ666 等是 FZ-666 包材/箱子，不作为可售货号；报废 是 ET 占位编码，也不作为可售货号。
- 8A04PD9、8A04QUP、KYD03172GF、KYD05552GF 是其他货代批次，不作为 ET 发货申请单缺失报警。

### 12.2 RTV 已收后的利润双口径

当前系统采用两套口径：

1. 主口径仍然保守：退货/仅退款/派送失败等反转订单，营收按 0，商品成本仍扣除，真实退货退款按既有规则额外扣 13.88 SAR 退货派送费。
2. 辅助口径新增“RTV 已收可二次销售测算”：如果 SHEIN 售后退件物流号能在 ET RTV 中确认已收件，则按当前单位成本回补一笔 `rtv_recoverable_cost_sar`，并形成 `profit_if_rtv_received_resellable_sar`。这只是测算金额，不替代主口径。

当前 ET 数据能判断退件直接入 09、入 03 后续调拨到 09、仍在 03、进入 04 破损、转 06 报废或其它/未知。03 后续去向通过 `mart.et_rtv_destination_allocation` 按同货号库存流水 FIFO 推断，因此：

- 已收但只确认在 03：进入二售测算，不改主利润。
- 能确认直接到 09，或通过库存流水 FIFO 追到 09：进入 `rtv_09_recoverable_cost_sar`，后续可作为更强证据。
- 进入 04 破损或 06 报废：保留去向明细，主利润仍按保守损失。
- 查不到 ET 收件或去向未知：完全保持保守口径。

#### 12.2.1 EMile / 换单号反向复核

- 有些来自 EMile 的退货在运输途中会更换物流单号，SHEIN 售后列表里的 `returnExpressInfoList.expressNo` 可能不是 ET RTV 最终入仓单号。
- 因此不能只做 “SHEIN 退货物流号 -> ET RTV” 单向匹配；还要反向做 “ET RTV 已收物流号 -> SHEIN 售后候选”。
- `mart.rtv_manual_review_candidates`：
  - 取 ET RTV 已收件、已入库或已有收件仓的记录；
  - 排除已经和 SHEIN 售后物流号或 `ops.rtv_tracking_verification` 匹配的记录；
  - 对 10 位以上纯数字物流号标记 `suspected_emile_handoff=true`，作为疑似 EMile/换单后的数字单号；
  - 按同标准货号、时间窗口全店生成 SHEIN 售后候选；ET SKU 上的店铺前缀只作排序线索，不作硬过滤。
- `scripts/verify_shein_rtv_tracking.mjs`：
  - 直接复用各店已登录 Chrome profile / CDP；
  - 读取 `aftersalesOrder/detail`、`returnOrder/detail`、`returnOrder/expressRoute` 和必要时的 `order/expressRoute`；
  - JT/JTE 退货物流按同一运单号直连；iMile/EMile 通过物流详情里的 `new waybill number [...]`、`新的运单号[...]`、`运单已...更换` 等中英文换单文本确认；确认结果写入 `ops.rtv_tracking_verification`。
- `mart.rtv_recovery_impact` 与 `mart.rtv_manual_review_candidates` 已吸收 `ops.rtv_tracking_verification` 中 `match_status='matched'` 的结果；确认匹配后，相关 RTV 会自动退出待复核池，并计入 `RTV 已收可二售测算`。
- BI `订单 / 售后` 页面已新增 “RTV 换单待复核” 表；这部分只用于提高 `RTV 已收可二售测算` 的召回率，未经人工确认前不直接改主利润。

#### 12.2.2 收件后的仓库去向追踪

- `mart.et_rtv_destination_allocation` 从 ET 库存流水追踪 RTV 收件后的去向：直接入 `ETRUH09散件仓`、03 后续调拨入 09、仍在 `ETRUH03_RTV`、进入 `ETRUH04Damaged`、转 `ETRUH06报废` 或其它/未知。
- 分配方法是同货号库存池 FIFO，不是单件序列号扫描；它适合用于二售测算和经营复核，但页面必须标明口径。
- `mart.shein_return_rtv_trace` 将 SHEIN 退货单、ET RTV 收件和 ET 库存流水去向串成明细。BI `订单 / 售后` 页面中的 “退货收件 / 仓库去向追踪” 表用于回答每条退货“收到没有、收到后去了哪里”。
### 12.3 仓储费明细边界

ET 财务账单中已能抓到每日仓储费总账（sort_name=仓储费），但当前抓到的账单明细没有返回 SKU 级 item rows。后续要继续探索仓储费详情页/接口；在拿到稳定 SKU 级明细前，ET 仓储费不能按货号替代手工月仓储费，只能用于月总核对或估算分摊。

## 13. 2026-05-08 ET 自动登录修复

- 早上 `SHEIN-Sales-ETForwarder-0420` 失败的直接原因是 ET 登录态过期，页面回到 `登入 - 易通天下客户中心`；旧抓取器只检查登录态并报警，没有进入验证码登录流程。
- 已新增 `scripts/et_login_helper.py`：从 `profiles/persistent-et-forwarder-profile` 的 Chrome `Login Data` 读取已保存 ET 账号密码，并用本地 `.cache/python` 中的 OCR 依赖识别 `/Login/GetAuthCode` 4 位验证码。默认手动运行不会打印密码，只有抓取器进程设置 `ET_LOGIN_HELPER_ALLOW_SECRET=1` 时才把密码返回给本地进程。
- 已升级 `scripts/fetch_et_forwarder.mjs`：检测到登录页时自动取凭据、拉取验证码图片、OCR、提交 `/Login/CheckCustomerLogin`，登录成功后继续原抓取流程；最多尝试 5 次，仍失败再发飞书异常提醒。
- 同步修复 `scripts/scheduled_et_forwarder_daily.ps1` 的空日期保护，避免计划任务把空 `--date` 传给 Node 后触发 `Invalid time value`。
- 已用临时 profile 演练“无登录 cookie + 已保存密码 + 验证码 OCR”的完整链路，自动登录成功；随后补跑 `2026-05-08` ET 日同步并入仓成功，BI 门户已重新生成。

## 14. 2026-05-09 ET 同源探测修复

- `2026-05-09 04:20` ET 任务失败不是验证码识别失败，而是首页探测阶段在页面内跨 ET 域名/IP 做 `fetch`，触发 `TypeError: Failed to fetch`，导致还没进入自动登录流程。
- `scripts/fetch_et_forwarder.mjs` 已改为使用当前页面 `location.origin` 组装同源 URL；`probeEtHome` 对 fetch 异常返回可处理状态，不再直接抛异常。
- 已手动补跑 `2026-05-09` ET 日同步并入仓成功；随后使用 `Start-ScheduledTask -TaskName SHEIN-Sales-ETForwarder-0420` 直接触发计划任务入口复验，`LastTaskResult=0`。

## ET 前台窗口规则
- ET 货代仓也适用“非必要不打开前端窗口”：`scripts/fetch_et_forwarder.mjs` 默认 `visible=false` 并用 `WindowStyle Hidden` 启动 Chrome；自动登录优先走 `scripts/et_login_helper.py` + OCR。只有 OCR/验证码连续失败、登录态必须人工处理、用户明确要求，或必须排查浏览器交互问题时，才允许临时加 `--visible` 打开 ET 前台窗口，处理完必须关闭。
