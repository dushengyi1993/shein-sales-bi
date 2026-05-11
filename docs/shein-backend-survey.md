# SHEIN 后台深度盘点

更新时间：2026-05-11

## 目的

为后续专业 BI 系统建立数据地图，不再只按飞书表或现有看板倒推。盘点对象包括：

- 后台菜单与页面；
- 页面真实调用接口；
- 前端包中暴露的候选 API；
- 每个数据域是否适合进入数据仓库；
- 当前账号权限阻塞。

本轮盘点为只读操作，不修改 SHEIN 后台、飞书 Base 或计划任务。

## 盘点方式

- 使用当前 DL 店铺已登录 Chrome 会话，通过 Chrome DevTools Protocol 只读访问页面。
- 记录页面菜单、页面文字、接口路径、状态码、前端静态包中的 API 字符串。
- 不保存 cookie、token、请求正文、响应正文和账号密码。

盘点脚本：

- `scripts/survey_shein_backend.mjs`

最新输出：

- `outputs/shein_backend_survey/2026-05-01T21-32-10/summary.json`
- `outputs/shein_backend_survey/2026-05-01T21-32-10/static-api-inventory.json`
- `outputs/shein_backend_survey/2026-05-01T21-40-50/summary.json`

## 已确认菜单与页面

| 菜单域 | 页面 | 路由 | 当前价值 |
| --- | --- | --- | --- |
| 首页 | 首页待办/实时数据 | `#/home` | 可做“异常/待办总览”，例如证书缺失、售罄、下架、库存预警、限流风险 |
| 订单 | 我的订单 | `#/gsp/order-management/list` | 当前销售统计核心来源，可继续做订单事实、订单商品/SKC 明细 |
| 订单 | 退货退款 | `#/gsp/order-management/after-sales-list` | 可补售后、退货、退款、退货码和退货原因分析 |
| 订单 | 发货面单 | `#/gsp/order-management/deliver-waybill-list` | 可补发货、面单、预约、履约过程分析 |
| 订单 | 履约设置 | `#/gsp/order-management/performance-setting` | 主要是配置类，BI 价值较低 |
| 库存 | 库龄列表 | `#/gsp/inventory-management/storage-age` | 这是用户提到的正确库存菜单，适合做展示库存与库龄事实 |
| 订单 | 缺货商品 | `#/gsp/order-management/out-of-stock-goods` | 可做缺货取消/缺货订单辅助分析 |
| 商品 | 商品发布 | `#/spmp/commoditiesCategory/followsales-pro/list`，实际跳转 `#/spmc/commodities-category/followsales-pro/list` | 发品类目、机会商品、常用分类、品牌和发品配置 |
| 商品 | 商品列表 | `#/spmp/commdities/list` | 链接主数据、状态、上架覆盖核心来源 |
| 商品 | 备货信息 | `#/idms/stockup` | 有标签/备货/价格/近 7/30 天销量；库存口径不可靠，不能做库存低预警 |
| 商品 | 素材中心 | `#/spmc/material-center` | 商品素材、图片/文件夹、素材容量 |
| 商品 | 商品诊断 | `#/spmp/commoditiesDiagnosis/list`，实际跳转 `#/spmc/commodities-diagnosis/list` | 商品诊断分数、可优化问题、证书弹窗 |
| 商品 | 商品质量 | `#/pqmp/commoditiesQuality/list` | 质量分析、质量词、预警、优化状态、违规商品 |
| 商品 | 商品评价 | `#/mgs/store-management/product-feedback` | 评论、申诉、用户评价 |
| 商品 | 侵权元素 | `#/pgs/element-library`，实际跳转 `#/pgc/element-library` | 侵权元素、知识库、合规风险 |
| 数据 | 经营分析 | `#/sbn/managementAnalysis/index` | 店铺经营概览、实时指标、综合指标 |
| 数据 | 商品分析 | `#/sbn/merchandise` | 链接曝光、点击、支付、销量、质量、退货、流量诊断核心来源 |
| 数据 | 营销分析 | `#/sbn/marketing` | 活动报名、营销概览、活动效果 |
| 数据 | 履约分析 | `#/mgs/performance_time_analysis` | 揽收、延迟、取消、履约趋势 |
| 数据 | 市场分析 | `#/sbn/market-analysis` | 缺失货盘、热搜词、热销排行，可做机会发现 |
| 财务 | 结算列表 | `#/pfmp/finance-management/list` | 结算、账单、发票，当前只做候选域 |
| 服务 | 服务质量 | `#/sbn/service/quality` | 服务质量，当前页面接口较少，后续继续验证 |
| 消息 | 消息中心 | `#/ssls/message` | 订单发货、商品预警、违规处罚、营销活动、财务等消息 |
| 下载 | 下载中心 | `#/download-management/list` | 导出任务状态和文件下载记录 |

## 关键接口初版

## 2026-05-11 销售 WebAPI 直连结论

- `/gsp/orderPlus/listOrder` 与 `/gsp/orderPlus/listOrderItem` 已可在 Node 中直接请求，不需要打开页面执行 `fetch`。
- 直连依赖 `state/shein_webapi_sessions/<店铺>.local.json` 中从已登录 Chrome profile 导出的 Cookie header / User-Agent / client hints；这是敏感本地运行态。
- `2026-05-08` 已完成 16 店销售直连抓取并与当前数据库切片对账一致；因此销售域已具备“无常驻浏览器”的云迁移前置条件。
- 其它业务域中，退货、面单、商品、库存、评价/翻译、履约、经营/营销/质量等后台 WebAPI 也已探测可用；财务收入概览仍有密码/验证限制，SBN 个别接口需要 `x-gw-auth` 等额外头，后续按域逐步固化。

### 订单 / 销售

- `/gsp/orderPlus/listOrder`
- `/gsp/orderPlus/listOrderItem`
- `/gsp/orderPlus/list/statistics`
- `/gsp/orderPlus/list/listCount`
- `/gsp/aftersalesOrder/list`
- `/gsp/aftersalesOrder/statistic`
- `/gsp/refundReason/listGroup`

BI 用途：

- 店铺日销、订单、商品/SKC 销售明细；
- 退货、退款、售后原因；
- 后续与链接表现、库存、履约打通。

### 商品 / 链接

- `/spmp-api-prefix/spmp/product/list`
- `/spmp-api-prefix/spmp/product/publish/config/query_supplier_config_combine`
- `/spmp-api-prefix/spmp/product/publish/config/query_supplier_config_combine_for_list`
- `/spmp-api-prefix/spmp/product/publish/assist/query_publish_config`
- `/spmp-api-prefix/spmp/product/publish/record/query_tab_display_config`
- `/spmp-api-prefix/spmp/product/skc/shelf/query_quota`
- `/spmp-api-prefix/spmp/product/query_quick_filter_items`
- `/spmp-api-prefix/spmp/product/query_quick_filter_items_v2`
- `/spmp-api-prefix/spmp/todo/query_items`
- `/spmp-api-prefix/spmp/supplier/query_site_list`

BI 用途：

- 链接主数据；
- 状态：待上架、已上架、已售罄、已下架；
- 硬死链识别仍按“已下架 + 货号前缀（废）”，但只作历史忽略，不再进入处理清单。

### 商品 / 发品、素材、诊断、质量、评价、合规

- `/spmc-api-prefix/spmp/supplier/query_category_tree`
- `/spmc-api-prefix/spmp/supplier/query_top_category`
- `/spmc-api-prefix/spmp/supplier/query_brand_list`
- `/spmc-api-prefix/spmp/material/folder/tree`
- `/spmc-api-prefix/spmp/material/storge/query_capacity`
- `/spmc-api-prefix/spmp/material/page`
- `/spmc-api-prefix/spmp/product/diagnosis/store_info`
- `/spmc-api-prefix/spmp/product/diagnosis/query_diag_config`
- `/spmc-api-prefix/spmp/product/diagnosis/list`
- `/spmc-api-prefix/spmp/certificate/is_pop`
- `/pqmp-api-prefix/pqmp/quality_analysis/new_list`
- `/pqmp-api-prefix/pqmp/quality_analysis/count_warning_status`
- `/pqmp-api-prefix/pqmp/quality_analysis/count_optimize_status`
- `/pqmp-api-prefix/pqmp/quality_analysis/query_quality_word_order`
- `/pqmp-api-prefix/pqmp/quality_analysis/query_supplier_illegal_product_info`
- `/mgs-api-prefix/goods/comment/list`
- `/mgs-api-prefix/goods/comment/user`
- `/mgs-api-prefix/goods/comment/seller/appealConfig`
- `/pgs-api-prefix/mcc_seller/out_gate_way/mcc-knowledge-base/mcc-knowledge/common/element/type/list`
- `/pgs-api-prefix/mcc_seller/out_gate_way/mcc-knowledge-base/mcc-knowledge/seller/element/page`

BI 用途：

- 发品类目和机会商品；
- 素材容量和素材使用；
- 商品诊断、证书/资质提示；
- 质量预警、质量词、违规商品；
- 评论、评价、申诉；
- 侵权元素和合规风险。

### 备货 / 商品供应标签

- `/idms/goods-skc/list`
- `/idms/goods-skc/count-stock-warn-status`
- `/idms/goods-skc/quality-label`
- `/idms/goods-skc/activity-label`
- `/idms/goods-skc/goods-label`
- `/idms/common/goodsLevel`
- `/idms/common/goodsCategoryTree`

BI 用途：

- SHEIN 标签、活动标签、质量标签；
- 备货、价格、近 7/30 天销量；
- 不再把这里的库存当成准确展示库存。

### 正确库存 / 库龄

- `/gsp/storage/stockAge/list`
- `/gsp/storage/stockAge/export`

页面字段：

- `商品信息`
- `属性集`
- `SKU`
- `仓库所属国/地区`
- `库存总数`
- `quantityInfos` 动态库龄分段
- 页面显示“数据更新于北京时间”

当前阻塞：

- DL 当前账号打开页面会提示：`你没有当前功能的权限，请主账号在系统设置中添加(库龄列表-查看节点)权限`
- 页面结构和接口已经确认，但当前账号没有完整查看节点权限，无法可靠抓取真实库存行数据。

建议：

- 给当前抓取账号补 `库龄列表-查看节点` 权限；
- 或后续用主账号/有权限账号验证 `/gsp/storage/stockAge/list` 的字段与样本，例如 `sv25082988192111895`。

### 数据 / 商品分析

- `/sbn/new_goods/performance_indicator`
- `/sbn/new_goods/critical_indicator`
- `/sbn/new_goods/critical_indicator_curve_chart`
- `/sbn/new_goods/get_skc_diagnose_list`
- `/sbn/new_goods/get_skc_diagnose_trend`
- `/sbn/new_goods/quality_diagram`
- `/sbn/goods/flowDiagnose/querySiteTimezone`
- `/sbn/goods/flowDiagnose/queryAllTabs`
- `/sbn/goods/flowDiagnose/querySkcList`

BI 用途：

- 曝光、点击、商详访客、加车、支付、销量；
- 商品质量、评论、差评、退货；
- 官方诊断可保留，但只作为参考信号，最终建议由自定义规则综合判断。

### 数据 / 经营分析

- `/sbn/index/getRealTimeIndicator`
- `/sbn/index/getRealTimeIndicatorCurveChart`
- `/sbn/index/get_goods_top`
- `/sbn/index/get_comprehensive_indicator`

BI 用途：

- 店铺经营首页；
- 实时趋势与核心指标；
- 可作为销售抓取口径的旁证，但最终销售额仍以订单明细事实为主。

### 数据 / 营销分析

- `/sbn/marketing/overview`
- `/sbn/marketing/overview_chart`
- `/sbn/marketing/campaign/list`
- `/sbn/marketing/query_enroll`
- `/sbn/marketing/activity_enum`

BI 用途：

- 活动效果；
- 活动中的链接表现对比；
- 判断“下滑是否与活动结束有关”。

### 数据 / 履约分析

- `/mgs-api-prefix/estimate/newPerformanceIndicator`
- `/mgs-api-prefix/estimate/newPerformanceLineChart`
- `/mgs-api-prefix/estimate/queryPerformanceNonCompliantOrder`
- `/mgs-api-prefix/supplierGrowth/querySupplierCommonData`

BI 用途：

- 按时揽收率；
- 延迟揽收率；
- 卖家原因取消；
- 履约异常对销售/链接表现的影响。

### 数据 / 市场分析

- `/sbn/marketAnalysis/queryCategory`
- `/sbn/marketAnalysis/queryTopCategory`
- `/sbn/marketAnalysis/querySite`
- `/sbn/marketAnalysis/categoryInsights/queryMissingGoods`

BI 用途：

- 缺失货盘；
- 热销排行；
- 类目机会；
- 反向支持“哪些货号应该补链接/补店铺”。

### 消息 / 下载 / 财务候选

- `/ssls/tab/getMsgCategoryInfo`
- `/ssls/tab/getMsgPageInfo`
- `/ssls/announcement/getUnreadCount`
- `/sso/notice/unReadCountAll`
- `/sso/common/fileExport/list`
- `/pfmp/common/flag`
- `/pfmp/common/system/config`
- `/pfmp/common/supplier/config`
- `/pfmp/delivery/deliveryConfig`

BI 用途：

- 消息中心可做“后台提醒收集器”，尤其是商品预警、违规处罚、营销活动、财务消息；
- 下载中心用于追踪导出任务；
- 财务域目前只确认到配置/入口，后续需继续进入结算明细页验证账单字段。

## BI 主题域初版

后续数据仓库不再围绕飞书表设计，而是围绕业务主题域设计：

1. 销售订单域：订单、订单商品、SKU/SKC 销售、店铺日销。
2. 商品链接域：SPU/SKC、链接状态、上架覆盖、待上架卡点、重复链接。
3. 流量转化域：曝光、点击、商详、加车、支付、销量、趋势。
4. 库存库龄域：正确展示库存、仓库国家、SKU 库龄分段、库存更新时间。
5. 售后质量域：退款、退货、差评、质量等级、退货原因。
6. 履约物流域：揽收、延迟、取消、面单、履约异常。
7. 营销活动域：活动报名、活动效果、活动期链接表现。
8. 市场机会域：缺失货盘、热搜词、热销排行、类目机会。
9. 规则建议域：补链接、优化、下架候选、库存调整、待上架卡点、复核项。

## 下一步

1. 继续扩大页面盘点范围，补财务、客服、合规、店铺、服务等菜单。
2. 优先解决库存菜单权限，验证 `/gsp/storage/stockAge/list` 的真实字段和样本库存。
3. 设计 PostgreSQL 数据仓库表结构。
4. 先把现有销售事实和链接事实双写到数据仓库。
5. 用 Metabase 先做经营驾驶舱原型，再决定哪些自定义操作台功能需要单独开发。
