# SHEIN BI 数据仓库模型草案

更新时间：2026-05-01

## 模型原则

- 不按飞书表设计，而按业务实体设计。
- 保留原始层，防止后面发现字段遗漏。
- 事实表尽量细，Metabase 和实操台读取派生层。
- 所有日期按北京时间自然日。
- 订单销售事实仍以 SHEIN 订单创建时间和订单商品明细为准。

## Schema 分层

| Schema | 用途 |
| --- | --- |
| `raw` | SHEIN 原始响应索引、抓取批次、接口审计 |
| `dim` | 店铺、货号、SKC、链接、类目、站点、活动等维度 |
| `fact` | 订单、销售、链接表现、库存、评价、售后、履约等明细事实 |
| `mart` | 给 Metabase 和网页使用的聚合宽表 |
| `ops` | 操作建议、人工处理、备注、分配、处理历史 |

## 原始层

### `raw.fetch_batch`

一行代表一次抓取任务。

关键字段：

- `batch_id`
- `source_system`
- `store_key`
- `target_date`
- `date_start`
- `date_end`
- `started_at`
- `finished_at`
- `status`
- `error_summary`

### `raw.api_capture`

一行代表一个接口响应或原始文件。

关键字段：

- `capture_id`
- `batch_id`
- `store_key`
- `domain`
- `route`
- `endpoint`
- `method`
- `status_code`
- `raw_file_path`
- `record_count`
- `captured_at`

## 维度层

### `dim.store`

来自 `config/stores.json`。

- `store_key`
- `group_key`
- `shop_name`
- `profile_key`
- `enabled`

### `dim.product`

标准货号维度。

- `product_key`
- `standard_goods_sn`
- `raw_goods_sn`
- `normalized_from`
- `catalog_status`
- `first_seen_at`
- `last_seen_at`

### `dim.skc`

SKC 维度。

- `skc`
- `spu`
- `standard_goods_sn`
- `raw_goods_sn`
- `sku_code`
- `title`
- `image_url`
- `category_l1`
- `category_l2`
- `category_l3`
- `category_l4`

### `dim.link`

链接维度，粒度建议为 `store_key + site + skc`。

- `link_key`
- `store_key`
- `site`
- `spu`
- `skc`
- `sku_code`
- `standard_goods_sn`
- `raw_goods_sn`
- `first_shelf_at`
- `created_at`
- `latest_status`
- `is_hard_dead`

## 事实层

### `fact.order`

一行一个订单。

- `order_id`
- `order_no`
- `store_key`
- `created_at`
- `created_date`
- `order_status`
- `fulfillment_status`
- `currency`
- `order_amount`
- `raw_summary`

### `fact.order_item`

一行一个订单商品/SKC。

- `order_item_id`
- `order_id`
- `store_key`
- `created_date`
- `standard_goods_sn`
- `raw_goods_sn`
- `spu`
- `skc`
- `sku_code`
- `quantity`
- `currency_price`
- `sale_amount_sar`
- `sale_amount_rmb`
- `raw_summary`

### `fact.store_daily_sales`

店铺日销事实，可从 `fact.order_item` 聚合，也可保留现有口径结果。

- `date`
- `store_key`
- `valid_order_count`
- `item_count`
- `sales_sar`
- `sales_rmb`
- `fetch_time`

### `fact.link_master_snapshot`

每天记录一次链接主状态。

- `snapshot_date`
- `store_key`
- `site`
- `spu`
- `skc`
- `standard_goods_sn`
- `raw_goods_sn`
- `link_status`
- `status_label`
- `is_hard_dead`
- `wait_shelf_blocked`
- `wait_shelf_block_reason`
- `tags`
- `raw_summary`

### `fact.link_performance_daily`

来自商品分析。

- `date`
- `store_key`
- `skc`
- `standard_goods_sn`
- `impression_uv`
- `detail_uv`
- `click_rate`
- `cart_uv`
- `cart_count`
- `cart_rate`
- `pay_uv`
- `pay_order_count`
- `pay_rate`
- `sales_qty`
- `quality_grade`
- `comment_count`
- `bad_comment_rate`
- `return_order_count`
- `return_item_count`
- `activity_tags`
- `rank_name`
- `rank_position`
- `raw_summary`

### `fact.display_inventory_daily`

来自库存菜单，不再使用备货信息库存。

目标接口：

- `/gsp/storage/stockAge/list`

字段草案：

- `date`
- `store_key`
- `warehouse_country`
- `spu`
- `skc`
- `sku`
- `standard_goods_sn`
- `inventory_total`
- `quantity_age_json`
- `updated_at_beijing`
- `raw_summary`

当前状态：

- 已确认页面和接口；
- 当前账号缺少 `库龄列表-查看节点` 权限，字段需权限补齐后验证。

### `fact.after_sales`

来自退货退款。

- `date`
- `store_key`
- `order_no`
- `skc`
- `standard_goods_sn`
- `after_sales_type`
- `refund_reason`
- `return_code`
- `status`
- `raw_summary`

### `fact.product_quality_daily`

来自商品质量。

- `date`
- `store_key`
- `skc`
- `standard_goods_sn`
- `quality_grade`
- `warning_status`
- `optimize_status`
- `quality_words`
- `illegal_flag`
- `raw_summary`

### `fact.product_comment`

来自商品评价。

- `comment_id`
- `store_key`
- `skc`
- `standard_goods_sn`
- `comment_time`
- `rating`
- `sentiment`
- `appeal_status`
- `raw_summary`

### `fact.fulfillment_daily`

来自履约分析。

- `date`
- `store_key`
- `on_time_collection_rate`
- `delayed_collection_rate`
- `seller_cancel_rate`
- `non_compliant_order_count`
- `raw_summary`

### `fact.marketing_campaign_daily`

来自营销分析。

- `date`
- `store_key`
- `campaign_id`
- `campaign_name`
- `activity_type`
- `start_time`
- `end_time`
- `impression`
- `click`
- `sales_qty`
- `sales_amount`
- `raw_summary`

### `fact.market_opportunity_daily`

来自市场分析。

- `date`
- `site`
- `category`
- `keyword`
- `opportunity_type`
- `rank`
- `missing_goods_signal`
- `raw_summary`

## 派生层

### `mart.product_store_coverage`

回答“某货号在 16 店哪些已上架、哪些缺链接”。

- `date`
- `standard_goods_sn`
- `on_shelf_store_count`
- `wait_shelf_store_count`
- `sold_out_store_count`
- `out_shelf_store_count`
- `missing_store_count`
- `has_any_on_shelf`
- `needs_link_action`

规则：

- 16 店都没有已上架链接：不提醒；
- 部分店有已上架、部分店没有：进入补链候选。

### `mart.link_health_score`

链接健康度评分。

维度：

- 销售趋势；
- 曝光趋势；
- 点击率；
- 支付率；
- 退货/差评；
- 活动状态；
- 是否唯一链接；
- 是否有替代链接；
- 库存展示风险。

### `mart.link_action_candidates`

每日建议候选，不等于全部要处理。

建议类型：

- `MISSING_LINK`
- `WAIT_SHELF_BLOCKED`
- `OPTIMIZE_LOW_CLICK`
- `OPTIMIZE_LOW_PAY`
- `DECLINING`
- `NO_SALE_REVIEW`
- `DELIST_CANDIDATE`
- `DISPLAY_INVENTORY_LOW`
- `DATA_REVIEW`

### `mart.daily_ops_focus`

每日实操入口，必须比候选集更窄。

原则：

- 不机械每店固定 8 条；
- 按全局优先级、收益、紧急程度、是否可操作排序；
- 店铺、货号、SKC 都是筛选维度；
- 每天只给可处理数量。

### `mart.et_rtv_destination_allocation`

ET RTV 收件后的库存流水去向视图。用途是回答“退件收到后去了哪里”，并给利润页的 `rtv_09_recoverable_cost_sar` 提供 09 可二售测算依据。

核心口径：

- 直接入 `ETRUH09散件仓` 的 RTV 直接计为可售 09；
- 入 `ETRUH03_RTV` 后，按同货号后续 `调拨单` 的库存流水 FIFO 分配到 09、04、06、仍在 03 或其它/未知；
- `ETRUH04Damaged` 后续若转 `ETRUH06报废`，会从破损口径转入报废口径；
- 这是库存流水级 / 同货号 FIFO 证据，不是单件序列号扫描。

### `mart.shein_return_rtv_trace`

SHEIN 售后退货单到 ET RTV 收件和仓库去向的明细视图。BI `订单 / 售后` 页面使用它展示“退货收件 / 仓库去向追踪”。

关键字段：

- `trace_status`：`未匹配到ET收件`、`已收-可售09`、`已收-仍在03_RTV`、`已收-破损04`、`已收-报废06`、`已收-其它/未知去向`、`已收-未解析去向`；
- `shein_return_express_numbers`：SHEIN 售后侧退货物流号；
- `et_return_order_ids` / `rtv_express_numbers`：ET RTV 单号和 ET 侧物流号；
- `destination_summary`：ET 库存流水推断出的仓库去向；
- `final_09_quantity` / `still_03_quantity` / `final_damaged_quantity` / `final_scrap_quantity` / `final_other_quantity`：按去向拆分的数量。

## 操作层

### `ops.action`

系统生成或人工创建的处理动作。

- `action_id`
- `date`
- `priority`
- `action_type`
- `store_key`
- `standard_goods_sn`
- `skc`
- `title`
- `reason`
- `evidence`
- `status`
- `assigned_to`
- `created_at`
- `updated_at`

### `ops.action_history`

动作处理流水。

- `history_id`
- `action_id`
- `operator`
- `operation`
- `note`
- `created_at`

### `ops.rtv_tracking_verification`

RTV 换单自动复核记录。用途是把 ET RTV 已收物流号与 SHEIN 售后详情 / 退货物流详情里的真实换单号关联起来，避免只靠售后列表当前退货物流号造成漏匹配。

关键字段：

- `verification_id`
- `store_key`
- `et_return_order_id`
- `et_shipment_number`
- `et_shipment_number_raw`
- `standard_goods_sn`
- `shein_aftersales_order_no`
- `shein_order_no`
- `shein_return_order_no`
- `shein_current_express_no`
- `match_status`
- `match_source`
- `matched_tracking_no`
- `discovered_tracking_numbers`
- `current_express_numbers`
- `route_summary`
- `verified_at`

口径：

- `match_status='matched'` 才会被 `mart.rtv_recovery_impact` 吸收。
- 主利润仍保守；确认 RTV 已收只进入 `RTV 已收可二次销售测算`，不直接改主利润。
- `mart.rtv_manual_review_candidates` 的候选售后单按标准货号 + 时间窗口生成；ET `sku_code` / `barcode` 的店铺前缀只能作为候选排序线索，不作为过滤条件，避免跨店销售的退货被漏掉。

## Metabase 建模建议

先只接入这些表：

1. `mart.store_daily`
2. `mart.product_store_coverage`
3. `mart.link_health_score`
4. `mart.link_action_candidates`
5. `fact.link_performance_daily`
6. `fact.order_item`

原因：

- 能先覆盖经营首页、店铺视角、货号视角、链接视角；
- 不把所有原始表一次性暴露给 Metabase，避免字段太乱。

## 待验证

- `/gsp/storage/stockAge/list` 真实库存字段和分页字段；
- 财务结算明细字段；
- 服务质量页面是否有更深层接口；
- 客服/工单是否有可用结构化接口；
- 合规/店铺评估页面的可抓取字段。

## 当前落地脚本

- 初始化 schema：`scripts/init_bi_warehouse.ps1`
- Schema DDL：`infra/warehouse/schema.sql`
- 入仓脚本：`scripts/load_bi_warehouse.mjs`

示例：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\init_bi_warehouse.ps1
node .\scripts\load_bi_warehouse.mjs --sales-date 2026-05-01 --link-date 2026-04-30
```

当前已导入：

| 表 | 行数 |
| --- | ---: |
| `dim.store` | 15 |
| `dim.product` | 139 |
| `dim.skc` | 1692 |
| `fact.store_daily_sales` | 15 |
| `fact.order_header` | 56 |
| `fact.order_item` | 56 |
| `fact.link_master_snapshot` | 1692 |
| `fact.link_performance_daily` | 1257 |
| `fact.product_store_coverage` | 1125 |
| `fact.link_suggestion` | 2288 |
| `mart.link_action_candidate` | 700 |
| `mart.store_cockpit_daily` | 15 |

校验：

- `fact.store_daily_sales` 的 `2026-05-01` 销售额合计为 `5296.19 SAR`。
- `fact.order_item` 的 `2026-05-01` 商品明细销售额合计同为 `5296.19 SAR`。
- 入仓脚本重跑时会先按 `日期 + 店铺` 删除旧切片，再写入新数据，避免旧明细残留。
