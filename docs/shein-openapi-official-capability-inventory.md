# SHEIN OpenAPI 官方能力台账

> 基础台账生成时间：`2026-07-03T04:38:53.590Z`；2026-07-19 复核官方目录为 243 条（OpenAPI 220、Webhook 23），新增 Webhook `3001903 商品删除审核通知`。来源：SHEIN 开放平台公开文档中心目录接口；本文件不包含任何密钥、Cookie 或店铺授权值。

## 刷新方式

```powershell
node scripts/bi_ops_cli.mjs official-capabilities --write-default-markdown --pretty
```

## 总览

- 当前官方目录接口数：243（OpenAPI 220，Webhook 23）；下方 OpenAPI 逐项表仍保留 2026-07-03 基础快照，Webhook 已补 2026-07-19 新增项。
- 项目已接只读并行层：13。
- 项目已接受控写适配器：13。
- 首批应补 adapter/schema 的官方能力：6。

## 项目状态口径

- `integrated_read_parallel`：已进入 19 店 OpenAPI 授权/探针/隔离双跑或现有只读探针链路，不直接覆盖生产事实源。
- `controlled_write_adapter`：已有受控写适配器；真实提交仍必须经过 BI 权限、`safeWriteOperations`、真实写白名单、dry-run `payloadHash`、确认和回读/人工核销。
- `schema_ready_adapter_next`：官方能力已确认，适合优先补 CLI/执行器适配，但未完成前不得承诺可真实写。
- `support_candidate`：可作为资料检查、payload mapper 或回读辅助能力排期。
- `candidate_unimplemented`：官方提供但项目未接；需按业务优先级设计 owner、幂等、回读和安全边界。
- `official_available_out_of_current_scope`：官方提供但当前 BI/运营主路径暂不覆盖。
- `webhook_candidate`：官方消息能力；接入前必须设计签名校验、幂等、重放防护和事件落库。

## 分类计数

| 分类 | 数量 |
|---|---:|
| 财务 | 6 |
| 采购单 | 20 |
| 采购单退货 | 13 |
| 店铺 | 3 |
| 定制商品 | 5 |
| 合规 | 18 |
| 价格 | 10 |
| 客单 | 17 |
| 库存和销量 | 6 |
| 密钥 | 1 |
| 面料 | 6 |
| 排产 | 10 |
| 认证仓 | 4 |
| 商品 | 34 |
| 退货退款 | 3 |
| 物流 | 11 |
| Feed | 6 |
| MDP印染 | 20 |
| MES | 24 |
| Webhook | 23 |

## 完整接口台账

| 分类 | docId | 名称 | 方法 | endpoint | 读/写 | 项目状态 | 风险 | CLI 下一步 |
|---|---:|---|---|---|---|---|---|---|
| 财务 | 3001621 | 查询对账单详情 | GET | /open-api/finance/get-check-order-detail | read | integrated_read_parallel | medium | 继续按数据域双跑对账；稳定前不替换生产事实源。 |
| 财务 | 3001625 | 查询报账单列表 | POST | /open-api/finance/report-order-list | read | integrated_read_parallel | medium | 继续按数据域双跑对账；稳定前不替换生产事实源。 |
| 财务 | 3001626 | 报账单列表 | POST | /open-api/finance/report-list | read | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 财务 | 3001628 | 报账单补扣款收支明细 | POST | /open-api/finance/report-adjustment-detail | read | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 财务 | 3001631 | 查询对账单列表 | POST | /open-api/finance/get-check-order-list | read | integrated_read_parallel | medium | 继续按数据域双跑对账；稳定前不替换生产事实源。 |
| 财务 | 3001674 | 报账单销售款收支明细 | POST | /open-api/finance/report-sales-detail | read | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001293 | 发货单维度打印面单 | POST | /open-api/shipping/delivery/print-package | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001294 | 备货单审核列表 | POST | /open-api/idms/review-orders | read | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001300 | 物流公司信息查询（即将废弃） | GET | /open-api/shipping/express-company-list | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001312 | 查shein合作物流预估运费 | POST | /open-api/openapi-business-backend/purchase-estimated-fee | read | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001340 | 物流产品查询 | POST | /open-api/shipping/express-company-list-v2 | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001443 | 查询商品备货信息列表 | POST | /open-api/openapi-business-backend/stock-goods-list | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001537 | 手工下备货单 | POST | /open-api/idms/create-order | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001646 | 收货仓信息查询 | GET | /open-api/shipping/warehouse | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001647 | ​查询货代信息 | POST | /open-api/pfmp/shipping/thirdPartyAndChannelList | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001650 | 修改和取消发货单订单 | POST | /open-api/shipping/modify-delivery-order-info | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001651 | 获取采购单信息 | GET | /open-api/order/purchase-order-infos | read | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001653 | 商品打印条码 | POST | /open-api/goods/print-barcode | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001654 | 发货基本信息查询接口 | GET | /open-api/shipping/basic | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001659 | 打印箱唛或包裹面单 | POST | /open-api/order/print-package | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001660 | 查询SHEIN仓库的收件信息 | GET | /open-api/order/storage-receiver-info | read | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001679 | 创建发货单 | POST | /open-api/shipping/orderToShipping | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001754 | 打印物流面单 | POST | /open-api/pfmp/print-purchase-logisticsLabel | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001756 | 查询发货单列表 | GET | /open-api/shipping/delivery | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001813 | JIT母单及子单对应关系查询接口 | GET | /open-api/order/get-mothe-child-orders | read | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单 | 3001847 | 查询智能拆包结果接口 | POST | /open-api/purchase/intelligent-packing-result | read | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单退货 | 3001771 | 查询商家可选择的处理方式 | GET | /open-api/purchase/return-disposals | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单退货 | 3001774 | 查询退货方式 | POST | /open-api/purchase/return-pickup-methods | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单退货 | 3001779 | 查询退货与报废单包裹明细 | POST | /open-api/purchase/return-package-detail | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单退货 | 3001780 | 查询退货与报废单商品明细 | POST | /open-api/purchase/return-product-detail | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单退货 | 3001781 | 修改退货单的退货方式 | POST | /open-api/purchase/update-pickup-methods | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单退货 | 3001796 | 查询退货可选择的物流 | POST | /open-api/purchase/return-carriers | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单退货 | 3001798 | 查询退货申请单商品明细 | POST | /open-api/purchase/return-application-detail | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单退货 | 3001802 | 查询退货申请单列表 | POST | /open-api/purchase/return-application-list | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单退货 | 3001803 | 查询商家退货地址 | POST | /open-api/purchase/query-return-address | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单退货 | 3001804 | 确认退货申请单 | POST | /open-api/purchase/confirm-return-application | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单退货 | 3001805 | 查询商品可退库存数 | POST | /open-api/purchase/returnable-inventory | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单退货 | 3001806 | 创建退货申请单 | POST | /open-api/purchase/create-return-application | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 采购单退货 | 3001826 | 查询退货与报废单列表 | POST | /open-api/purchase/return-list | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 店铺 | 3001144 | 查询公告列表 | POST | /open-api/ssls/announcement/get-anno-list | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 店铺 | 3001145 | 获取公告详情 | POST | /open-api/ssls/announcement/get-anno-detail | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 店铺 | 3001499 | 查询店铺信息 | POST | /open-api/openapi-business-backend/query-store-info | read | integrated_read_parallel | low | 继续按数据域双跑对账；稳定前不替换生产事实源。 |
| 定制商品 | 3001665 | 查询加车结构信息 | POST | /open-api/ccst/v1/custom-info/queryAddCartInfo | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 定制商品 | 3001668 | 获取定制数据 | GET | /open-api/ccst/v1/custom-infos | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 定制商品 | 3001670 | 获取模版数据 | GET | /open-api/ccst/v1/custom-info/templates | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 定制商品 | 3001671 | 查询任务结果 | GET | /open-api/ccst/v1/composite/queryTask | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 定制商品 | 3001672 | 创建⽣产模板任务 | POST | /open-api/ccst/v1/composite/task | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 合规 | 3001172 | 绑定SKC和代理公司 | POST | /open-api/goods-compliance/save-skc-agency | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 合规 | 3001176 | 上传实拍图图片 | POST | /open-api/goods-compliance/upload-skc-label-picture | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 合规 | 3001373 | 查询SKC可用的标签模板 | POST | /open-api/goods-compliance/get-label-template | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 合规 | 3001385 | 打印合规标签 | POST | /open-api/goods-compliance/label-print | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 合规 | 3001394 | 查询SKC的实拍图要求 | POST | /open-api/goods-compliance/skc-label-list | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 合规 | 3001399 | 绑定SKC和实拍图 | POST | /open-api/goods-compliance/skc-save-label | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 合规 | 3001848 | 查询代理公司列表 | POST | /open-api/goods-compliance/agency-list | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 合规 | 3001849 | 查询SKC的合规信息要求 | POST | /open-api/goods-compliance-requirements/list | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 合规 | 3001850 | 查询资质证书列表 | POST | /open-api/goods-certificates/search | read | support_candidate | high | 作为资料检查、回读或 payload mapper 的辅助能力排期。 |
| 合规 | 3001852 | 上传资质证书文件 | POST | /open-api/goods-certificate-files/upload | write | support_candidate | high | 作为资料检查、回读或 payload mapper 的辅助能力排期。 |
| 合规 | 3001853 | 创建/编辑资质证书 | POST | /open-api/goods-certificates/save | write | support_candidate | high | 作为资料检查、回读或 payload mapper 的辅助能力排期。 |
| 合规 | 3001854 | SKC绑定资质证书 | POST | /open-api/goods-certificates/bind | write | support_candidate | high | 作为资料检查、回读或 payload mapper 的辅助能力排期。 |
| 合规 | 3001855 | 查询SKC的代理公司绑定要求 | POST | /open-api/goods-compliance/skc-agency-detail | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 合规 | 3001856 | 查询SKC的警告语绑定状态 | POST | /open-api/goods-compliance/query-skc-warning-status | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 合规 | 3001857 | 查询警告语证书的填写规则 | POST | /open-api/goods-compliance/query-warning-certificate-rules | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 合规 | 3001858 | 更新SKC的警告语 | POST | /open-api/goods-compliance/update-skc-warning-certificate | write | controlled_write_adapter | high | 保持 BI 权限、safeWriteOperations、真实写白名单、payloadHash、确认和回读/人工核销边界。 |
| 合规 | 3001877 | 查询资质证书填写规则 | POST | /open-api/goods-certificate-schemas/detail | read | support_candidate | high | 作为资料检查、回读或 payload mapper 的辅助能力排期。 |
| 合规 | 3001902 | 获取全量环保耗材信息 | GET | /open-api/goods-quality/environmental-label-rule/material-quality-tree-v2 | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 价格 | 3001883 | 更新商品售价 | POST | /open-api/openapi-business-backend/product/price/save | write | controlled_write_adapter | high | 保持 BI 权限、safeWriteOperations、真实写白名单、payloadHash、确认和回读/人工核销边界。 |
| 价格 | 3001884 | 更新成本价 | POST | /open-api/goods/update-cost | write | controlled_write_adapter | high | 保持 BI 权限、safeWriteOperations、真实写白名单、payloadHash、确认和回读/人工核销边界。 |
| 价格 | 3001885 | 获取成本价涨价原因枚举值 | POST | /open-api/goods/query-change-price-reason | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 价格 | 3001886 | 价格证明材料上传 | POST | /open-api/goods/discuss/upload-discuss-file | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 价格 | 3001890 | 查询建议零售价审核记录 | POST | /open-api/goods-recommend-retail-price-audit/search | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 价格 | 3001891 | 获取议价单列表 | POST | /open-api/goods/discuss/query-discuss-list | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 价格 | 3001892 | 处理议价单 | POST | /open-api/goods/discuss/process-discuss | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 价格 | 3001893 | 查询商品建议零售价 | POST | /open-api/goods-recommend-retail-price/search | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 价格 | 3001894 | 查询建议零售价填写规则 | POST | /open-api/goods/query-recommend-retail-price-rule | read | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 价格 | 3001895 | 提交建议零售价 | POST | /open-api/goods-recommend-retail-price/batch-save | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001269 | 请求订单列表 | POST | /open-api/order/order-list | read | integrated_read_parallel | medium | 继续按数据域双跑对账；稳定前不替换生产事实源。 |
| 客单 | 3001274 | 批量上传运单号 | POST | /open-api/order/import-batch-multiple-express | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001279 | 取消超限拆分包裹 | POST | /open-api/order/unpacking-group-remove | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001280 | 确认超限拆分包裹 | POST | /open-api/order/unpacking-group-confirm | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001415 | 确认无货接口 | POST | /open-api/order/confirm-no-stock | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001466 | 导出地址接口 | POST | /open-api/order/export-address | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001527 | 回传发票信息 | POST | /open-api/order/sync-invoice-info | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001598 | 商家维度查渠道信息 | POST | /open-api/order/express-channel | read | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001600 | 在线下单 | POST | /open-api/gsp/place-express-order | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001602 | 切换导出地址发货 | POST | /open-api/gsp/switch-self-shipping | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001603 | 打印面单接口 | POST | /open-api/order/print-express-info | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001655 | 查询订单可用物流信息 | POST | /open-api/gsp/order-mapping-channels | read | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001785 | 请求订单详情 | POST | /open-api/order/order-detail | read | integrated_read_parallel | medium | 继续按数据域双跑对账；稳定前不替换生产事实源。 |
| 客单 | 3001786 | 查询仓库地址 | POST | /open-api/gsp/warehouse-address | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001814 | 客单物流轨迹查询 | GET | /open-api/gsp/logistics-track | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001815 | 查询订单可用发货仓库 | POST | /open-api/gsp/available-shipping-warehouse | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 客单 | 3001880 | 查询下单结果 | POST | /open-api/gsp/check-express-order | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 库存和销量 | 3001304 | 全托管/SHEIN自营商家库存更新 | POST | /open-api/goods/stock-update | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 库存和销量 | 3001305 | 根据SKU查询销量 | POST | /open-api/goods/query-sku-sales | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 库存和销量 | 3001691 | 商家仓库列表查询 | GET | /open-api/msc/warehouse/list | read | integrated_read_parallel | low | 继续按数据域双跑对账；稳定前不替换生产事实源。 |
| 库存和销量 | 3001692 | 更新商家库存接口v1 | POST | /open-api/gsp/goods/change-inventory | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 库存和销量 | 3001695 | 商家库存查询接口 | POST | /open-api/stock/stock-query | read | integrated_read_parallel | high | 继续按数据域双跑对账；稳定前不替换生产事实源。 |
| 库存和销量 | 3001738 | 更新商家库存接口v2 | POST | /open-api/stock/change-inventory/v2 | write | controlled_write_adapter | high | 保持 BI 权限、safeWriteOperations、真实写白名单、payloadHash、确认和回读/人工核销边界。 |
| 密钥 | 3001520 | 获取openKeyId和secretKey | POST | /open-api/auth/get-by-token | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 面料 | 3000489 | 供应商库存-出库同步接口 | POST | /open-api/material/out-inventory | read | official_available_out_of_current_scope | high | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 面料 | 3000490 | 供应商订单-发货信息 | POST | /open-api/material/sales-order-deliver-info | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 面料 | 3000491 | 供应商库存-库存同步接口 | POST | /open-api/material/sync-inventory | write | official_available_out_of_current_scope | high | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 面料 | 3000492 | 供应商质检-验布报告 | POST | /open-api/material/receive-cloth-report | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 面料 | 3000493 | 供应商库存-入库同步接口 | POST | /open-api/material/in-inventory | read | official_available_out_of_current_scope | high | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 面料 | 3001378 | 发起快速加供任务 | POST | /open-api/material/mesCreateAddSupp | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 排产 | 3001865 | 查询任务节点配置 | POST | /open-api/sims/srp/progress-node-query | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 排产 | 3001866 | 查询任务进度交期配置 | POST | /open-api/sims/srp/timeline-query | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 排产 | 3001867 | 查询作业流程配置 | POST | /open-api/sims/srp/procedure-query | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 排产 | 3001868 | 分页查询排产计划 | POST | /open-api/sims/srp/production-plan-query | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 排产 | 3001869 | 分页查询生产任务 | POST | /open-api/sims/srp/task-query | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 排产 | 3001870 | 根据排单计划批量创建成品生产任务 | POST | /open-api/sims/srp/tasks-create-by-production-nos | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 排产 | 3001871 | 根据排单计划批量创建半成品生产任务 | POST | /open-api/sims/srp/sfp-tasks-create-by-production-nos | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 排产 | 3001872 | 根据商品信息批量创建成品排单计划和生产任务 | POST | /open-api/sims/srp/tasks-create-by-products | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 排产 | 3001873 | 根据商品信息批量创建半成品排单计划和生产任务 | POST | /open-api/sims/srp/sfp-tasks-create-by-sfps | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 排产 | 3001874 | 更新生产任务接口 | POST | /open-api/sims/srp/task-update | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 认证仓 | 3001262 | 认证仓调用-上传物流运单接口 | POST | /open-api/order/openapi/auth/order/express-upload | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 认证仓 | 3001263 | 认证仓调用-回调出库单创建结果接口 | POST | /open-api/order/openapi/auth/order/outbound-result | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 认证仓 | 3001264 | 认证仓调用-作废出库单接口 | POST | /open-api/order/openapi/auth/order/outbound-cancel | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 认证仓 | 3001265 | 认证仓调用-接收认证仓服务商仓库渠道变更接口 | POST | /open-api/lsps-java/auth/entity-change | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 商品 | 3001085 | sku商品详情查询（即将作废） | POST | /open-api/openapi-business-backend/product/full-detail | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 商品 | 3001239 | 商品列表接口 | POST | /open-api/openapi-business-backend/product/query | read | integrated_read_parallel | low | 继续按数据域双跑对账；稳定前不替换生产事实源。 |
| 商品 | 3001249 | 查询店铺站点和币种信息（新） | POST | /open-api/goods/query-site-list | read | integrated_read_parallel | low | 继续按数据域双跑对账；稳定前不替换生产事实源。 |
| 商品 | 3001253 | 商品上下架 | POST | /open-api/goods/modify-skc-shelf | write | controlled_write_adapter | high | 保持 BI 权限、safeWriteOperations、真实写白名单、payloadHash、确认和回读/人工核销边界。 |
| 商品 | 3001254 | 查询店铺站点和站点币种（旧） | POST | /open-api/openapi-business-backend/site/query | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 商品 | 3001359 | 本地图片上传 | POST | /open-api/goods/upload-pic | write | schema_ready_adapter_next | medium | 优先补最小 CLI/执行器适配：只读/上传/转换先 dry-run 或预检，真实写仍走受控任务。 |
| 商品 | 3001360 | 图片链接转换 | POST | /open-api/goods/transform-pic | read | schema_ready_adapter_next | low | 优先补最小 CLI/执行器适配：只读/上传/转换先 dry-run 或预检，真实写仍走受控任务。 |
| 商品 | 3001363 | 图文识别推荐类目 | POST | /open-api/goods/image-category-suggestion | read | support_candidate | low | 作为资料检查、回读或 payload mapper 的辅助能力排期。 |
| 商品 | 3001368 | 查询商品审核状态 | POST | /open-api/goods/query-document-state | read | schema_ready_adapter_next | low | 优先补最小 CLI/执行器适配：只读/上传/转换先 dry-run 或预检，真实写仍走受控任务。 |
| 商品 | 3001369 | 查询是否支持自定义属性值 | POST | /open-api/goods/get-custom-attribute-permission-config | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 商品 | 3001380 | 确认商品是否可编辑 | POST | /open-api/goods/product/check-edit-permission | write | support_candidate | medium | 作为资料检查、回读或 payload mapper 的辅助能力排期。 |
| 商品 | 3001437 | 查询商家sku是否已存在 | POST | /open-api/goods/product/check-supplierSku-repeated | read | support_candidate | low | 作为资料检查、回读或 payload mapper 的辅助能力排期。 |
| 商品 | 3001483 | 添加自定义属性值 | POST | /open-api/goods/add-custom-attribute-value | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 商品 | 3001485 | 商品接口-根据条码批量获取SKC与尺码 | POST | /open-api/goods/batch-skc-size | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 商品 | 3001486 | 商品接口-全量查询SKC/SKU/设计款号关系列表 | GET | /open-api/goods/number-list | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 商品 | 3001544 | 获取店铺上架额度 | POST | /open-api/goods/query-shelf-quota | read | schema_ready_adapter_next | low | 优先补最小 CLI/执行器适配：只读/上传/转换先 dry-run 或预检，真实写仍走受控任务。 |
| 商品 | 3001589 | 确认店铺是否可发品 | GET | /open-api/goods/product/check-publish-permission | write | support_candidate | medium | 作为资料检查、回读或 payload mapper 的辅助能力排期。 |
| 商品 | 3001594 | 店铺查商品末级分类 | POST | /open-api/goods/query-category-tree | read | support_candidate | low | 作为资料检查、回读或 payload mapper 的辅助能力排期。 |
| 商品 | 3001634 | 商品综合查询 | POST | /open-api/goods/searchProduct | read | schema_ready_adapter_next | low | 优先补最小 CLI/执行器适配：只读/上传/转换先 dry-run 或预检，真实写仍走受控任务。 |
| 商品 | 3001680 | 查询关联属性填写规则 | POST | /open-api/goods/get-associated-attribute-rules | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 商品 | 3001810 | 商品部分编辑 | POST | /open-api/goods/product/partialEdit | write | controlled_write_adapter | high | 保持 BI 权限、safeWriteOperations、真实写白名单、payloadHash、确认和回读/人工核销边界。 |
| 商品 | 3001812 | 商品发布/编辑 | POST | /open-api/goods/product/publishOrEdit | write | controlled_write_adapter | high | 保持 BI 权限、safeWriteOperations、真实写白名单、payloadHash、确认和回读/人工核销边界。 |
| 商品 | 3001859 | 查询商品证书要求和审核状态 | POST | /open-api/goods/get-certificate-rule | read | controlled_write_adapter | high | 保持 BI 权限、safeWriteOperations、真实写白名单、payloadHash、确认和回读/人工核销边界。 |
| 商品 | 3001860 | 查询证书所需上传资料（新） | POST | /open-api/goods/certificate/get-all-certificate-type-list-v2 | read | controlled_write_adapter | high | 保持 BI 权限、safeWriteOperations、真实写白名单、payloadHash、确认和回读/人工核销边界。 |
| 商品 | 3001861 | 上传证书文件 | POST | /open-api/goods/upload-certificate-file | write | controlled_write_adapter | high | 保持 BI 权限、safeWriteOperations、真实写白名单、payloadHash、确认和回读/人工核销边界。 |
| 商品 | 3001862 | 商品证书池创建/编辑 | POST | /open-api/goods/save-or-update-certificate-pool | write | controlled_write_adapter | high | 保持 BI 权限、safeWriteOperations、真实写白名单、payloadHash、确认和回读/人工核销边界。 |
| 商品 | 3001863 | 店铺证书池创建/编辑 | POST | /open-api/goods/save-or-update-supplier-certificate | write | controlled_write_adapter | high | 保持 BI 权限、safeWriteOperations、真实写白名单、payloadHash、确认和回读/人工核销边界。 |
| 商品 | 3001864 | SKC绑定商品证书池 | POST | /open-api/goods/save-certificate-pool-skc-bind | write | controlled_write_adapter | high | 保持 BI 权限、safeWriteOperations、真实写白名单、payloadHash、确认和回读/人工核销边界。 |
| 商品 | 3001896 | 撤回商品审核 | POST | /open-api/goods/revoke-product | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 商品 | 3001897 | spu商品详情查询 | POST | /open-api/goods/spu-info | read | integrated_read_parallel | low | 继续按数据域双跑对账；稳定前不替换生产事实源。 |
| 商品 | 3001898 | 商品发布字段规范 | POST | /open-api/goods/query-publish-fill-in-standard | read | schema_ready_adapter_next | low | 优先补最小 CLI/执行器适配：只读/上传/转换先 dry-run 或预检，真实写仍走受控任务。 |
| 商品 | 3001899 | 查询分类可用属性 | POST | /open-api/goods/query-attribute-template | read | support_candidate | low | 作为资料检查、回读或 payload mapper 的辅助能力排期。 |
| 商品 | 3001900 | 查询可用品牌列表 | POST | /open-api/goods/query-brand-list | read | support_candidate | low | 作为资料检查、回读或 payload mapper 的辅助能力排期。 |
| 商品 | 3001901 | 查询可用IP列表 | POST | /open-api/goods/query-ip-list | read | support_candidate | low | 作为资料检查、回读或 payload mapper 的辅助能力排期。 |
| 退货退款 | 3001281 | 查询退货单列表 | POST | /open-api/return-order/list | read | integrated_read_parallel | high | 继续按数据域双跑对账；稳定前不替换生产事实源。 |
| 退货退款 | 3001282 | 退货单详情查询 | POST | /open-api/return-order/details | read | integrated_read_parallel | high | 继续按数据域双跑对账；稳定前不替换生产事实源。 |
| 退货退款 | 3001283 | 退货单签收 | POST | /open-api/return-order/sign-return-order | write | candidate_unimplemented | high | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| 物流 | 3000496 | 物流商网点回调接口 | POST | /open-api/cargo/express-website-message | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 物流 | 3000498 | 顺丰运单未揽收包裹明细回调接口 | POST | /open-api/cargo/qc-outside-cancel-sf-express | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 物流 | 3000499 | 物流商接口-物流商运单回调 | POST | /open-api/cargo/express-notify | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 物流 | 3000501 | 物流商推送轨迹数据-统一接口 | POST | /open-api/cargo/track-notify | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 物流 | 3000502 | 物流商推送轨迹数据-trackingmore | POST | /open-api/cargo/track-notify-trackingmore | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 物流 | 3000503 | 上传结算异常举证 | POST | /open-api/cargo/quote-return | write | official_available_out_of_current_scope | high | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 物流 | 3000504 | 揽收超时/取消运单原因回传 | POST | /open-api/cargo/timeout-cancel-reason-return | write | official_available_out_of_current_scope | high | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 物流 | 3000505 | 【新】物流轨迹回调 | POST | /open-api/cargo/logistics-trajectory-callback | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 物流 | 3000928 | 【新】物流重量回调 | POST | /open-api/cargo/weight-callback | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 物流 | 3001045 | 车牌信息回调 | POST | /open-api/cargo/platenum-callback | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| 物流 | 3001498 | 物流接口-获取快递公司信息 | GET | /open-api/order/express-infos | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| Feed | 3001226 | 查询Feed文件 | GET | /open-api/sem/feed/getFeedDocument | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| Feed | 3001227 | 上传Feed文件 | POST | /open-api/sem/feed/uploadDocumentContent | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| Feed | 3001229 | 创建Feed文件 | POST | /open-api/sem/feed/createFeedDocument | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| Feed | 3001230 | 创建Feed任务 | POST | /open-api/sem/feed/createFeed | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| Feed | 3001233 | 取消Feed任务 | POST | /open-api/sem/feed/cancelFeed | write | candidate_unimplemented | medium | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| Feed | 3001234 | 查看Feed任务 | GET | /open-api/sem/feed/getFeed | read | candidate_unimplemented | low | 按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。 |
| MDP印染 | 3001417 | 微信小程序登陆 | POST | /open-api/mdp/wx-mini-program/login | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001418 | 提供更新MDP转印任务结束 | POST | /open-api/mdp/product/transfer-print-task/finish | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001419 | 提供更新MDP转印任务开始 | POST | /open-api/mdp/product/transfer-print-task/begin | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001420 | 提供扫码排产创建波次 | POST | /open-api/mdp/product/schedule/allocation-confirm | write | official_available_out_of_current_scope | high | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001421 | 提供更新MDP打印任务开始 | POST | /open-api/mdp/product/print-task/begin | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001422 | 提供更新MDP打印任务完成 | POST | /open-api/mdp/product/print-task/finish | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001424 | 给外部供应商调用- 重录订单米数和裁片 | POST | /open-api/mdp/order/goods/reenter-order-info | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001425 | 根据名称获取可用的印花厂 | POST | /open-api/mdp/order/customer-requirement/get-factory-list | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001426 | 根据印花厂code获取客户信息 | POST | /open-api/mdp/order/customer-requirement/get-factory-customer-list | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001427 | 创建待补全审核的客户需求 | POST | /open-api/mdp/order/customer-requirement/create-customer-requirement | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001429 | 获取大货订单信息 | POST | /open-api/mdp/get-order-info-list | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001430 | 挂卡聚合操作（上架or出库or移位） | POST | /open-api/mdp/hangcard/operate | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001431 | 新增或更新挂卡信息 | POST | /open-api/mdp/hang-card/add-or-update | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001432 | 获取打印设备列表 | POST | /open-api/mdp/basic-configure/production-equipment/get-print-equipmentList | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001433 | 添加或取消设备异常 | POST | /open-api/mdp/basic-configure/production-equipment/add-or-cancel-equipment-exception | write | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001434 | 接收外部ERP完结订单 | POST | /open-api/mdp/order/goods/external/receive-external-erp-complete-order | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001467 | 给外部供应商调用- 同步订单信息（状态，发货） | POST | /open-api/mdp/order/goods/sync-order-info | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001469 | 提供外部ERP版料任务查询接口 | POST | /open-api/mdp/process/get-process-develop-info-list | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001470 | 外部查询操作日志（供小程序调用） | POST | /open-api/mdp/order/external/get-order-log-list | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MDP印染 | 3001474 | 提供外部ERP花型开发分页查询接口 | POST | /open-api/mdp/flower/get-pattern-dev-page-list | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3000508 | MES-FAC-003 领料信息接口 | POST | /open-api/mes/get-material-info | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3000509 | MES-FAC-004 二次工艺接口 | POST | /open-api/mes/get-second-precess | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3000510 | MES-FAC-005 大货bom接口 | POST | /open-api/mes/get-big-goods-bom | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3000511 | 扎信息查询接口 | POST | /open-api/mes/bundle-info | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3000512 | 查询物料异常详细接口 | POST | /open-api/mes/material-anomalous/list | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3000513 | 查询采购单详细接口 | POST | /open-api/mes/purchase-detail-info-list | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3000514 | 按时间查询生产制单号 | POST | /open-api/mes/query-produce-order-ids | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3000515 | 查询发货单信息 | POST | /open-api/mes/deliver-order/list | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3000517 | 裁床完成 | POST | /open-api/mes/end-cut-bed | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3000518 | 车缝完工 | POST | /open-api/mes/sew-end | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3000519 | 更新供应商尾货 | POST | /open-api/mes/order-inventory-surplus/update | write | official_available_out_of_current_scope | high | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3000520 | MES-FAC-001 订单数据获取接口 | POST | /open-api/mes/get-order-info | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3000521 | 查询生产订单 | POST | /open-api/mes/get-produce-order-info | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3000522 | 查询供应商尾货 | POST | /open-api/mes/order-inventory-surplus/list | read | official_available_out_of_current_scope | high | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3001816 | 入库单列表查询 | POST | /open-api/sims/inbound-order-query | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3001817 | 出库订单列表查询 | POST | /open-api/sims/outbound-order-query | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3001818 | 库位列表数据 | POST | /open-api/sims/location-query | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3001819 | 库存结余列表查询 | POST | /open-api/sims/stock-query | read | official_available_out_of_current_scope | high | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3001820 | 自营供应商库存更新 | POST | /open-api/sims/stock-update | write | official_available_out_of_current_scope | high | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3001821 | 自营供应商入库单确认 | POST | /open-api/sims/inbound-order-confirm | write | official_available_out_of_current_scope | high | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3001822 | MES-FAC-002 采购信息接口 | POST | /open-api/mes/get-purchase-info | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3001824 | 分页查询商家SKC列表 | POST | /open-api/spss/skc-page-query | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3001876 | 批量查询SKC信息 | POST | /open-api/spss/skc-info-query | read | official_available_out_of_current_scope | low | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| MES | 3001882 | 根据订单号查询订单信息 | POST | /open-api/mes/query-produce-order-info-by-id | read | official_available_out_of_current_scope | medium | 当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。 |
| Webhook | 3000804 | 商品价格异常通知 | POST | /product_prices_abnormal_notice | webhook | webhook_candidate | low | 如业务需要实时通知，先设计签名校验、幂等、重放防护和事件落库，再接收回调。 |
| Webhook | 3000848 | 商品上下架通知 | POST | /product_shelves_notice | webhook | webhook_first_phase_integrated | high | 已进入第一阶段可靠接收、非预期下架 P0 告警、任务回填和 BI 平台动态。 |
| Webhook | 3000910 | 商品接收通知 | POST | /product_document_receive_status_notice | webhook | webhook_first_phase_integrated | high | 已进入第一阶段可靠接收、任务唯一强身份回填和 BI 平台动态。 |
| Webhook | 3000912 | 商品涨价审批结果通知 | POST | /product_price_audit_status_notice | webhook | webhook_candidate | low | 如业务需要实时通知，先设计签名校验、幂等、重放防护和事件落库，再接收回调。 |
| Webhook | 3000914 | 退货单同步通知 | POST | /return_order_push_notice | webhook | webhook_first_phase_integrated | high | 已进入第一阶段可靠接收、按退货单号定向详情/upsert/readback 和 BI 平台动态。 |
| Webhook | 3001048 | 推送缺货需求库存数（新） | POST | /out_of_stock_notice | webhook | webhook_candidate | low | 如业务需要实时通知，先设计签名校验、幂等、重放防护和事件落库，再接收回调。 |
| Webhook | 3001061 | 商品额度变动通知 | POST | /product_quota_change_notice | webhook | webhook_first_phase_integrated | high | 已进入第一阶段可靠接收、额度 0 写闸门/P0 告警与正数恢复。 |
| Webhook | 3001068 | SKU库存预警通知 | POST | /inventory_warning_notice | webhook | webhook_candidate | low | 如业务需要实时通知，先设计签名校验、幂等、重放防护和事件落库，再接收回调。 |
| Webhook | 3001082 | cte开票通知 | POST | /invoice_status_notice | webhook | webhook_candidate | low | 如业务需要实时通知，先设计签名校验、幂等、重放防护和事件落库，再接收回调。 |
| Webhook | 3001104 | 商品合规信息失效通知 | POST | /product_compliance_change_notice | webhook | webhook_first_phase_integrated | high | 已进入第一阶段可靠接收和必需合规 P0；按商品/证书处理，不误封整店。 |
| Webhook | 3001435 | 采购单通知 | POST | /purchase_order_notice | webhook | webhook_candidate | low | 如业务需要实时通知，先设计签名校验、幂等、重放防护和事件落库，再接收回调。 |
| Webhook | 3001441 | 发货单变更通知 | POST | /delivery_modify_notice | webhook | webhook_candidate | low | 如业务需要实时通知，先设计签名校验、幂等、重放防护和事件落库，再接收回调。 |
| Webhook | 3001442 | 订单同步通知 | POST | /order_push_notice | webhook | webhook_first_phase_integrated | high | 已进入第一阶段可靠接收、按订单号定向详情/upsert/readback 和 BI 平台动态。 |
| Webhook | 3001449 | 商品发布公文审核通知（全渠道） | POST | /product_document_audit_status_notice_all_channels | webhook | webhook_first_phase_integrated | high | 已进入第一阶段可靠接收、审核失败 P0、任务回填和 BI 平台动态。 |
| Webhook | 3001450 | 商品审核通知 | POST | /product_document_audit_status_notice | webhook | webhook_first_phase_integrated | high | 已进入第一阶段可靠接收、审核失败 P0、任务回填和 BI 平台动态。 |
| Webhook | 3001461 | SHEIN合作物流单下单通知 | POST | /logistics_order_result_notice | webhook | webhook_candidate | low | 如业务需要实时通知，先设计签名校验、幂等、重放防护和事件落库，再接收回调。 |
| Webhook | 3001503 | 店铺授权关系变更通知 | POST | /authorization_change_notice | webhook | webhook_first_phase_integrated | high | 已进入第一阶段可靠接收、店铺授权写闸门和 P0 告警。 |
| Webhook | 3001744 | 采购退货申请单状态通知 | POST | /purchase_order_return_application_notice | webhook | webhook_candidate | low | 如业务需要实时通知，先设计签名校验、幂等、重放防护和事件落库，再接收回调。 |
| Webhook | 3001765 | 采购单合作物流通知 | POST | /logistics_forecast_result_notice | webhook | webhook_candidate | low | 如业务需要实时通知，先设计签名校验、幂等、重放防护和事件落库，再接收回调。 |
| Webhook | 3001792 | 建议零售价审核状态更新 | POST | /product_rrp_review_status_changed | webhook | webhook_candidate | low | 如业务需要实时通知，先设计签名校验、幂等、重放防护和事件落库，再接收回调。 |
| Webhook | 3001793 | 建议零售价有效期变更 | POST | /product_rrp_validity_changed | webhook | webhook_candidate | low | 如业务需要实时通知，先设计签名校验、幂等、重放防护和事件落库，再接收回调。 |
| Webhook | 3001801 | 采购退货单状态通知 | POST | /purchase_order_return_notice | webhook | webhook_candidate | low | 如业务需要实时通知，先设计签名校验、幂等、重放防护和事件落库，再接收回调。 |
| Webhook | 3001903 | 商品删除审核通知 | POST | /product_delete_audit | webhook | webhook_first_phase_integrated | high | 已进入第一阶段可靠接收；删除获批或审核失败均为 P0，并进入 BI 平台动态；不直接触发 SHEIN 写。 |


## 2026-07-03 适配器开发进展

- M1 图片能力已落地：`upload-pic`、`transform-pic`、`plan-images`，并纳入 `scripts/test_bi_ops_release_gate.mjs`。
- M2 只读回读已落地：`audit-status`、`search-product`、`publish-standard`。
- M3 已落地：`shelf-quota`、Webhook 第一阶段接收/队列/处理器，以及 BI“平台动态”。
- M4 已落地：`order-fulfillment` 高风险 executor，execute 强制确认文本、payload hash、店铺身份探针。
- M5 已建立目录驱动兜底：`openapi-call` 可覆盖官方 JSON OpenAPI 的 dry-run/受控 execute；multipart/file 和 WebHook 被阻断。

安全边界：默认 dry-run 不联网；只读 execute 要身份探针；写 execute 要身份探针 + 确认文本 + payload hash；订单履约使用独立确认文本 `SHEIN_ORDER_FULFILLMENT_SUBMIT`。
