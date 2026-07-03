# SHEIN OpenAPI 半托管接口 Schema 索引

> 生成时间：`2026-07-03T04:59:45.653Z`。来源：SHEIN 开放平台文档中心详情接口。共 103 个半托管接口（mode 包含 5）。本文件不包含密钥或授权值。

## 总览

- 半托管接口总数：103
- 有请求示例：75
- 有响应示例：75
- 有请求体 schema：85

## 按分类分组

### 财务（3）

| docId | 名称 | 方法 | endpoint | 读/写 | 请求字段数 | 响应字段数 | 有示例 |
|---:|---|---|---|---|---:|---:|---|
| 3001621 | 查询对账单详情 | GET | `/open-api/finance/get-check-order-detail` | read | 1 | 4 | ✓ |
| 3001625 | 查询报账单列表 | POST | `/open-api/finance/report-order-list` | read | 7 | 3 | ✗ |
| 3001631 | 查询对账单列表 | POST | `/open-api/finance/get-check-order-list` | read | 11 | 4 | ✓ |

### 采购单（11）

| docId | 名称 | 方法 | endpoint | 读/写 | 请求字段数 | 响应字段数 | 有示例 |
|---:|---|---|---|---|---:|---:|---|
| 3001293 | 发货单维度打印面单 | POST | `/open-api/shipping/delivery/print-package` | write | 1 | 4 | ✓ |
| 3001294 | 备货单审核列表 | POST | `/open-api/idms/review-orders` | read | 7 | 3 | ✓ |
| 3001340 | 物流产品查询 | POST | `/open-api/shipping/express-company-list-v2` | read | 5 | 3 | ✓ |
| 3001443 | 查询商品备货信息列表 | POST | `/open-api/openapi-business-backend/stock-goods-list` | read | 2 | 3 | ✓ |
| 3001537 | 手工下备货单 | POST | `/open-api/idms/create-order` | write | 1 | 2 | ✓ |
| 3001646 | 收货仓信息查询 | GET | `/open-api/shipping/warehouse` | read | 0 | 4 | ✓ |
| 3001650 | 修改和取消发货单订单信息 | POST | `/open-api/shipping/modify-delivery-order-info` | write | 5 | 4 | ✓ |
| 3001651 | 订单接口-获取采购单信息 | GET | `/open-api/order/purchase-order-infos` | read | 0 | 4 | ✓ |
| 3001654 | 发货基本信息查询接口 | GET | `/open-api/shipping/basic` | read | 0 | 4 | ✓ |
| 3001679 | 国内发货 | POST | `/open-api/shipping/orderToShipping` | write | 16 | 4 | ✓ |
| 3001756 | 查询发货单列表 | GET | `/open-api/shipping/delivery` | read | 0 | 4 | ✓ |

### 店铺（1）

| docId | 名称 | 方法 | endpoint | 读/写 | 请求字段数 | 响应字段数 | 有示例 |
|---:|---|---|---|---|---:|---:|---|
| 3001499 | 查询店铺信息 | POST | `/open-api/openapi-business-backend/query-store-info` | read | 0 | 3 | ✓ |

### 定制商品（5）

| docId | 名称 | 方法 | endpoint | 读/写 | 请求字段数 | 响应字段数 | 有示例 |
|---:|---|---|---|---|---:|---:|---|
| 3001665 | 查询加车结构信息 | POST | `/open-api/ccst/v1/custom-info/queryAddCartInfo` | read | 1 | 3 | ✗ |
| 3001668 | 获取定制数据 V1 | GET | `/open-api/ccst/v1/custom-infos` | read | 0 | 3 | ✓ |
| 3001670 | 获取模版数据V1 | GET | `/open-api/ccst/v1/custom-info/templates` | read | 0 | 3 | ✓ |
| 3001671 | 查询任务结果V1 | GET | `/open-api/ccst/v1/composite/queryTask` | read | 0 | 3 | ✓ |
| 3001672 | 创建⽣产模板任务V1 | POST | `/open-api/ccst/v1/composite/task` | write | 3 | 3 | ✓ |

### 合规（18）

| docId | 名称 | 方法 | endpoint | 读/写 | 请求字段数 | 响应字段数 | 有示例 |
|---:|---|---|---|---|---:|---:|---|
| 3001172 | 绑定SKC和代理公司 | POST | `/open-api/goods-compliance/save-skc-agency` | write | 3 | 3 | ✓ |
| 3001176 | 上传实拍图图片 | POST | `/open-api/goods-compliance/upload-skc-label-picture` | write | 1 | 4 | ✓ |
| 3001373 | 查询SKC可用的标签模板 | POST | `/open-api/goods-compliance/get-label-template` | read | 1 | 4 | ✓ |
| 3001385 | 打印合规标签 | POST | `/open-api/goods-compliance/label-print` | write | 1 | 3 | ✓ |
| 3001394 | 查询SKC的实拍图要求 | POST | `/open-api/goods-compliance/skc-label-list` | read | 6 | 4 | ✓ |
| 3001399 | 绑定SKC和实拍图 | POST | `/open-api/goods-compliance/skc-save-label` | write | 4 | 4 | ✓ |
| 3001848 | 查询代理公司列表 | POST | `/open-api/goods-compliance/agency-list` | read | 4 | 4 | ✗ |
| 3001849 | 查询SKC的合规信息要求 | POST | `/open-api/goods-compliance-requirements/list` | read | 5 | 4 | ✗ |
| 3001850 | 查询资质证书列表 | POST | `/open-api/goods-certificates/search` | read | 6 | 4 | ✗ |
| 3001852 | 上传证书文件 | POST | `/open-api/goods-certificate-files/upload` | write | 1 | 4 | ✗ |
| 3001853 | 创建/编辑资质证书 | POST | `/open-api/goods-certificates/save` | write | 5 | 4 | ✗ |
| 3001854 | SKC绑定资质证书 | POST | `/open-api/goods-certificates/bind` | write | 2 | 4 | ✗ |
| 3001855 | 查询SKC的代理公司绑定要求 | POST | `/open-api/goods-compliance/skc-agency-detail` | write | 6 | 4 | ✓ |
| 3001856 | 查询SKC的警告语绑定状态 | POST | `/open-api/goods-compliance/query-skc-warning-status` | read | 5 | 5 | ✗ |
| 3001857 | 查询警告语证书的填写规则 | POST | `/open-api/goods-compliance/query-warning-certificate-rules` | read | 0 | 4 | ✗ |
| 3001858 | 更新SKC的警告语 | POST | `/open-api/goods-compliance/update-skc-warning-certificate` | write | 3 | 4 | ✗ |
| 3001877 | 查询资质证书填写规则 | POST | `/open-api/goods-certificate-schemas/detail` | read | 2 | 4 | ✗ |
| 3001902 | 获取全量耗材类型和耗材材质信息-V2 | GET | `/open-api/goods-quality/environmental-label-rule/material-quality-tree-v2` | read | 0 | 4 | ✓ |

### 价格（9）

| docId | 名称 | 方法 | endpoint | 读/写 | 请求字段数 | 响应字段数 | 有示例 |
|---:|---|---|---|---|---:|---:|---|
| 3001884 | 更新供货价 | POST | `/open-api/goods/update-cost` | write | 2 | 4 | ✓ |
| 3001885 | 获取涨价原因枚举值 | POST | `/open-api/goods/query-change-price-reason` | read | 1 | 4 | ✗ |
| 3001886 | 价格证明材料上传 | POST | `/open-api/goods/discuss/upload-discuss-file` | write | 1 | 5 | ✗ |
| 3001890 | 查询建议零售价审核记录 | POST | `/open-api/goods-recommend-retail-price-audit/search` | read | 5 | 4 | ✗ |
| 3001891 | 获取议价单列表 | POST | `/open-api/goods/discuss/query-discuss-list` | read | 3 | 3 | ✗ |
| 3001892 | 处理议价单 | POST | `/open-api/goods/discuss/process-discuss` | write | 2 | 3 | ✗ |
| 3001893 | 查询建议零售价列表 | POST | `/open-api/goods-recommend-retail-price/search` | read | 1 | 4 | ✗ |
| 3001894 | 获取SKU建议零售价规则 | POST | `/open-api/goods/query-recommend-retail-price-rule` | read | 1 | 4 | ✗ |
| 3001895 | 提交建议零售价 | POST | `/open-api/goods-recommend-retail-price/batch-save` | write | 1 | 4 | ✗ |

### 客单（16）

| docId | 名称 | 方法 | endpoint | 读/写 | 请求字段数 | 响应字段数 | 有示例 |
|---:|---|---|---|---|---:|---:|---|
| 3001269 | 请求订单列表 | POST | `/open-api/order/order-list` | read | 9 | 4 | ✓ |
| 3001274 | 批量上传运单号 | POST | `/open-api/order/import-batch-multiple-express` | write | 2 | 4 | ✓ |
| 3001279 | Cancel splitting order packages | POST | `/open-api/order/unpacking-group-remove` | write | 1 | 3 | ✓ |
| 3001280 | Confirm splitting order packages | POST | `/open-api/order/unpacking-group-confirm` | write | 1 | 3 | ✓ |
| 3001415 | 确认无货接口 | POST | `/open-api/order/confirm-no-stock` | write | 3 | 4 | ✓ |
| 3001466 | 导出地址接口 | POST | `/open-api/order/export-address` | write | 2 | 4 | ✓ |
| 3001598 | order ship channel query | POST | `/open-api/order/express-channel` | read | 1 | 4 | ✓ |
| 3001600 | 在线下单 | POST | `/open-api/gsp/place-express-order` | write | 3 | 4 | ✓ |
| 3001602 | 切换导出地址发货 | POST | `/open-api/gsp/switch-self-shipping` | write | 1 | 3 | ✓ |
| 3001603 | 打印面单接口 | POST | `/open-api/order/print-express-info` | write | 3 | 4 | ✓ |
| 3001655 | 查询订单可用物流信息 | POST | `/open-api/gsp/order-mapping-channels` | read | 5 | 4 | ✓ |
| 3001785 | 请求订单详情 | POST | `/open-api/order/order-detail` | read | 1 | 4 | ✓ |
| 3001786 | 查询仓库地址 | POST | `/open-api/gsp/warehouse-address` | read | 0 | 4 | ✓ |
| 3001814 | 客单物流轨迹查询 | GET | `/open-api/gsp/logistics-track` | read | 0 | 4 | ✓ |
| 3001815 | 查询订单可用发货仓库 | POST | `/open-api/gsp/available-shipping-warehouse` | read | 1 | 4 | ✗ |
| 3001880 | 查询下单结果 | POST | `/open-api/gsp/check-express-order` | write | 2 | 4 | ✗ |

### 库存和销量（5）

| docId | 名称 | 方法 | endpoint | 读/写 | 请求字段数 | 响应字段数 | 有示例 |
|---:|---|---|---|---|---:|---:|---|
| 3001305 | 根据SKU查询销量 | POST | `/open-api/goods/query-sku-sales` | read | 1 | 5 | ✓ |
| 3001691 | 商家仓库列表查询 | GET | `/open-api/msc/warehouse/list` | read | 0 | 4 | ✓ |
| 3001692 | 修改库存接口 | POST | `/open-api/gsp/goods/change-inventory` | write | 1 | 4 | ✓ |
| 3001695 | 商家仓/SFS仓库存查询 | POST | `/open-api/stock/stock-query` | read | 5 | 4 | ✓ |
| 3001738 | 更新商家库存接口v2 | POST | `/open-api/stock/change-inventory/v2` | write | 1 | 4 | ✗ |

### 密钥（1）

| docId | 名称 | 方法 | endpoint | 读/写 | 请求字段数 | 响应字段数 | 有示例 |
|---:|---|---|---|---|---:|---:|---|
| 3001520 | 用户授权-根据临时token获取api key和secret key | POST | `/open-api/auth/get-by-token` | read | 1 | 4 | ✓ |

### 商品（31）

| docId | 名称 | 方法 | endpoint | 读/写 | 请求字段数 | 响应字段数 | 有示例 |
|---:|---|---|---|---|---:|---:|---|
| 3001085 | 商品详情查询（新） | POST | `/open-api/openapi-business-backend/product/full-detail` | read | 2 | 4 | ✓ |
| 3001239 | 商品列表接口 | POST | `/open-api/openapi-business-backend/product/query` | read | 6 | 4 | ✓ |
| 3001249 | 店铺查询站点列表 | POST | `/open-api/goods/query-site-list` | read | 0 | 5 | ✓ |
| 3001253 | 商品上下架 | POST | `/open-api/goods/modify-skc-shelf` | write | 1 | 5 | ✓ |
| 3001254 | 查找站点+语种+币种接口 | POST | `/open-api/openapi-business-backend/site/query` | read | 2 | 4 | ✓ |
| 3001359 | 本地图片上传 | POST | `/open-api/goods/upload-pic` | write | 2 | 5 | ✓ |
| 3001360 | 图片链接转换 | POST | `/open-api/goods/transform-pic` | read | 2 | 5 | ✓ |
| 3001363 | 图片或文本识别推荐分类 | POST | `/open-api/goods/image-category-suggestion` | read | 2 | 5 | ✓ |
| 3001368 | 查询商品审核状态 | POST | `/open-api/goods/query-document-state` | read | 1 | 4 | ✓ |
| 3001369 | 查询是否支持自定义属性值 | POST | `/open-api/goods/get-custom-attribute-permission-config` | read | 1 | 4 | ✓ |
| 3001380 | 确认商品是否可编辑 | POST | `/open-api/goods/product/check-edit-permission` | write | 1 | 3 | ✓ |
| 3001437 | 查询商家sku是否已存在 | POST | `/open-api/goods/product/check-supplierSku-repeated` | read | 1 | 4 | ✗ |
| 3001544 | 获取店铺上架额度 | POST | `/open-api/goods/query-shelf-quota` | read | 0 | 4 | ✗ |
| 3001589 | 确认店铺是否可发品 | GET | `/open-api/goods/product/check-publish-permission` | write | 0 | 3 | ✓ |
| 3001594 | 店铺查商品末级分类 | POST | `/open-api/goods/query-category-tree` | read | 0 | 5 | ✓ |
| 3001634 | 商品综合查询 | POST | `/open-api/goods/searchProduct` | read | 14 | 4 | ✗ |
| 3001680 | 查询关联属性填写规则 | POST | `/open-api/goods/get-associated-attribute-rules` | read | 1 | 4 | ✓ |
| 3001810 | 商品部分编辑（门户可见版，字段少于内部接口） | POST | `/open-api/goods/product/partialEdit` | write | 13 | 4 | ✗ |
| 3001812 | 商品发布/编辑 | POST | `/open-api/goods/product/publishOrEdit` | write | 19 | 5 | ✓ |
| 3001859 | 获取证书要求及证书信息 | POST | `/open-api/goods/get-certificate-rule` | read | 6 | 5 | ✓ |
| 3001860 | 查询证书所需上传资料（新） | POST | `/open-api/goods/certificate/get-all-certificate-type-list-v2` | read | 0 | 4 | ✓ |
| 3001861 | 上传证书文件 | POST | `/open-api/goods/upload-certificate-file` | write | 1 | 5 | ✓ |
| 3001862 | 新增或修改SKC维度证书池 | POST | `/open-api/goods/save-or-update-certificate-pool` | write | 6 | 5 | ✓ |
| 3001863 | 新增或修改供应商维度证书 | POST | `/open-api/goods/save-or-update-supplier-certificate` | write | 4 | 4 | ✓ |
| 3001864 | SKC绑定证书池 | POST | `/open-api/goods/save-certificate-pool-skc-bind` | write | 1 | 4 | ✓ |
| 3001896 | 商品撤回 | POST | `/open-api/goods/revoke-product` | write | 1 | 3 | ✓ |
| 3001897 | spu查商品详情(新) | POST | `/open-api/goods/spu-info` | read | 2 | 5 | ✓ |
| 3001898 | 商品发布字段规范 | POST | `/open-api/goods/query-publish-fill-in-standard` | read | 2 | 5 | ✓ |
| 3001899 | 店铺查可选属性 | POST | `/open-api/goods/query-attribute-template` | read | 1 | 5 | ✓ |
| 3001900 | 店铺查品牌列表 | POST | `/open-api/goods/query-brand-list` | read | 0 | 5 | ✓ |
| 3001901 | 获取店铺可用IP列表 | POST | `/open-api/goods/query-ip-list` | read | 2 | 4 | ✗ |

### 退货退款（3）

| docId | 名称 | 方法 | endpoint | 读/写 | 请求字段数 | 响应字段数 | 有示例 |
|---:|---|---|---|---|---:|---:|---|
| 3001281 | 退货单-查询退货单列表 | POST | `/open-api/return-order/list` | read | 6 | 4 | ✓ |
| 3001282 | 退货单-退货单详情查询 | POST | `/open-api/return-order/details` | read | 1 | 4 | ✓ |
| 3001283 | 退货单-退货单签收 | POST | `/open-api/return-order/sign-return-order` | write | 2 | 4 | ✓ |

## 优先开发接口 Schema 详情

### 3001359 — 本地图片上传

- **endpoint**: `/open-api/goods/upload-pic`
- **method**: POST
- **modes**: 自运营, 全托管, 半托管
- **QPS**: -
- **描述**: 支持将图片文件转换成SHEIN可用的在线图片链接。各类型图片需满足下方要求，否则无法转换，建议开发者将图片在本地处理完成后再调用接口。- 主图（type=1)、细节图（type=2)：像素满足1340px*1785px，或宽高比例1:1，像素范围900px-2200px；格式JPG/JPEG/PNG；大小≤3MB- 方形图（type=5）：宽高比例1:1；像素范围900*900~2200*2200 px；格式JPG/JPEG/PNG；大小≤3MB- 色块图（type=6）：宽高比例1:1；像素80×80 px；格式JPG/JPEG/PNG；大小≤3MB- 详情图（type=7）：宽高比例3:4，像素大于900px； 格式JPG/JPEG/PNG；大小≤3MB每个店铺的各个分类下，需要传什么类型的图、可以传几张图，可通过文档确认：商品图片。

**请求体**:

- `(root)` (object)
  - `image_type` (int64, 必填) — 图片类型(1:主图; 2:细节图; 5:方块图; 6:色块图; 7:详情图) 各个类型的图片要求参考文档顶部的描述。
  - `file` (blob, 必填) — 图片文件

**响应体**:

- `(root)` (object)
  - `bbl` (object, 必填)
    - `info` (object, 必填)
    - `npid` (string)
  - `code` (string)
  - `info` (object, 必填)
    - `height` (integer) — 高
    - `image_hex_type` (string) — 图片类型
    - `image_url` (string) — 图片链接
    - `size` (integer) — 大小
    - `width` (integer) — 宽
  - `msg` (string)
  - `traceId` (string) — 请求的唯一标识；用于异常报错跟踪

**请求示例**:
```
curl --location --request POST 'https://openapi-test01.sheincorp.cn/open-api/goods/upload-pic' \ --header 'language: zh-cn' \ --header 'x-lt-openKeyId: test' \ --header 'x-lt-signature: test' \ --header 'x-lt-timestamp: 1752733538805' \ --header 'Host: openapi-test01.sheincorp.cn' \ --form 'image_type="2"' \ --form 'file=@"/Users/10124378/Downloads/760eecab5aab4e7a8adec5961c795e50 (1).jpg"'
```

**响应示例**:
```
code": "0", "msg": "OK", "info": { "image_url": "http://imgdeal-test01.shein.com/images3_pi/2023/11/15/3c/17000397694031071724_square.jpg", "width": 1200, "height": 1200, "size": 363846, "image_hex_type": "jpg" }, "bbl": null }
```

### 3001360 — 图片链接转换

- **endpoint**: `/open-api/goods/transform-pic`
- **method**: POST
- **modes**: 自运营, 全托管, 半托管
- **QPS**: -
- **描述**: 支持将外部的图片地址转换成SHEIN可用的图片地址，各类型图片需满足下方要求，否则无法转换，建议开发者将图片在本地处理完成后再调用接口。- 主图（type=1)、细节图（type=2)：像素满足1340px*1785px，或宽高比例1:1，像素范围900px-2200px；格式JPG/JPEG/PNG；大小≤3MB- 方形图（type=5）：宽高比例1:1；像素范围900*900~2200*2200 px；格式JPG/JPEG/PNG；大小≤3MB- 色块图（type=6）：宽高比例1:1；像素80×80 px；格式JPG/JPEG/PNG；大小≤3MB - 详情图（type=7）：宽高比例3:4，像素大于900px； 格式JPG/JPEG/PNG；大小≤3MB每个店铺的各个分类下，需要传什么类型的图、可以传几张图，可通过文档确认：商品图片。

**请求体**:

- `(root)` (object, 选填)
  - `image_type` (integer, 必填) — 图片类型(1:主图; 2:细节图; 5:方块图; 6:色块图; 7:详情图) 。各个类型的图片要求参考文档顶部的描述。
  - `original_url` (string, 必填) — 图片地址。

**响应体**:

- `(root)` (object, 选填)
  - `bbl` (object, 选填) — bbl
    - `info` (object, 选填)
      - `*` (object, 选填)
    - `npid` (string, 选填)
  - `code` (string, 必填) — 成功: 0
  - `info` (object, 选填)
    - `failure_reason` (string, 选填) — 失败原因
    - `original` (string, 必填) — 图片链接
    - `transformed` (string, 选填) — 转换后的图片链接
  - `msg` (string, 选填) — 错误描述, 成功: OK
  - `traceId` (string) — 请求的唯一标识；用于异常报错跟踪

**请求示例**:
```
curl --location --request POST 'https://openapi-test01.sheincorp.cn/open-api/goods/transform-pic' \ --header 'language: zh-cn' \ --header 'x-lt-openKeyId: test' \ --header 'x-lt-signature: test' \ --header 'x-lt-timestamp: 1752733538805' \ --header 'Content-Type: application/json' \ --header 'Host: openapi-test01.sheincorp.cn' \ --data-raw '{ "image_type": 2, "original_url": "http://imgdeal-test01.shein.com/images3_pi/2023/11/15/fe/17000325694031071724_square.jpg" }'
```

**响应示例**:
```
code": "0", "msg": "OK", "info": { "original": "http://imgdeal-test01.shein.com/images3_pi/2023/11/15/fe/17000325694031071724_square.jpg", "transformed": "", "failure_reason": "图片下载异常" }, "bbl": null }
```

### 3001368 — 查询商品审核状态

- **endpoint**: `/open-api/goods/query-document-state`
- **method**: POST
- **modes**: 自运营, 全托管, 半托管, POP
- **QPS**: -
- **描述**: 支持通过spu查询skc的审核状态，支持查询spu指定版本的审核状态；同时，平台也支持webhook消息通知的方式推送商品审核结果，具体可查看商品公文审核通知

**请求体**:

- `(root)` (object, 选填)
  - `spuList` (object, 必填) — spu列表，1次最多传10个spu
    - `spuName` (string, 必填) — spuName，spuName是SHEIN生成的系统编码
    - `version` (string, 选填) — 审核版本号。当商品发布或编辑提交后，响应中会包含version。

**响应体**:

- `(root)` (object, 选填)
  - `code` (string, 必填) — 响应编码 成功：0
  - `info` (object, 选填)
    - `data` (object, 选填) — 结果
      - `skcList` (object, 选填) — skc集合
        - `documentSn` (string, 选填) — 公文号
        - `documentState` (integer, 选填) — 公文状态。-1：接受失败 1：待审核 2：审批成功 3：审批失败 4：已撤回 5：申诉中
        - `failedReason` (object, 选填) — 审批失败的原因
          - `content` (string, 选填) — 内容
          - `language` (string, 选填) — 语种
        - `skcName` (string, 选填) — skcName，skcNname是SHEIN生成的系统编码
      - `spuName` (string, 选填) — spuName，spuName是SHEIN生成的系统编码
      - `version` (string, 选填) — 审核版本号
    - `meta` (object, 选填) — 元数据
      - `count` (integer, 选填) — 数据记录数
      - `customObj` (object, 选填) — 用户自定义扩展
  - `msg` (string, 选填) — 错误描述,成功：OK
  - `traceId` (string) — 请求的唯一标识；用于异常报错跟踪

**请求示例**:
```
curl --location --request POST 'https://openapi-test01.sheincorp.cn/open-api/goods/query-document-state' \ --header 'language: zh-cn' \ --header 'x-lt-openKeyId: test' \ --header 'x-lt-signature: test' \ --header 'x-lt-timestamp: 1752724239028' \ --header 'Content-Type: application/json' \ --header 'Host: openapi-test01.sheincorp.cn' \ --data-raw '{ "spuList": [ { "spuName": "MM2404076986", "version": "SPMP240407262081729" } ] }'
```

**响应示例**:
```
code": "0", "msg": "OK", "info": { "data": [ { "spuName": "MM2404076986", "version": "SPMP240407262081729", "skcList": [ { "skcName": "sMM24040769866671", "documentSn": "SPMPA320240407000135", "documentState": 3, "failedReason": [ { "language": "zh-cn", "content": "禁忌:frankie test12;1111111" }, { "language": "zh-cn", "content": "上新管控:测试上新管控驳回·1;1111111" } ] } ] } ], "meta": { "count": 1, "customObj": null } }, "bbl": null }
```

### 3001634 — 商品综合查询

- **endpoint**: `/open-api/goods/searchProduct`
- **method**: POST
- **modes**: 自运营, 全托管, 半托管, POP
- **QPS**: -
- **描述**: 商品列表接口，支持使用各种条件综合查询，查询结果按SPU维度提供，每个SPU下会提供商品的关键信息。支持的条件：平台编码、商家维护货号、上架状态、类目、发布时间和更新时间；各条件间是且的关系。返回的信息：各层级的编码和货号、标题属性、主图、上架状态、价格、库存

**请求体**:

- `(root)` (object, 选填) — 商品列表V2请求参数
  - `pageNum` (integer, 必填) — 分页页码，从1开始
  - `pageSize` (integer, 必填) — 分页大小，最大10
  - `categoryIds` (int64, 选填) — 末级分类ID列表，单次最多10个。
  - `spuNameList` (string, 选填) — SPU编码列表（平台编码），单次最多10个。
  - `skcNameList` (string, 选填) — SKC编码列表（平台编码），单次最多10个。
  - `skuCodeList` (string, 选填) — SKU编码列表（平台编码），单次最多10个。
  - `skcSupplierCodeList` (string, 选填) — SKC货号列表（商家维护的货号），单次最多10个。
  - `supplierSkuList` (string, 选填) — 商家SKU列表（商家维护的SKU货号），单次最多10个
  - `skcShelfStatus` (integer, 选填) — SKC上架状态，0:下架 1:上架。待上架和已售罄均属于下架状态。
  - `languageList` (string, 选填) — 语种列表，决定商品信息中名称、属性名称、属性值名称返回的语种内容。单次最多入参5个语种，不传时默认返回英语。支持的语种包括：英语:en、法语:fr、西班牙语:es、德语:de、中文简体:zh-cn、泰语:th、巴西葡语:pt-br、日语:ja、韩语:ko
  - `createTimeStart` (string, 选填) — SPU的发布时间段（开始时间），格式 yyyy-MM-dd HH:mm:ss。发布时间定义：SPU首次审核通过时间。
  - `createTimeEnd` (string, 选填) — SPU的发布时间段（结束时间），格式 yyyy-MM-dd HH:mm:ss。发布时间定义：SPU首次审核通过时间。
  - `updateTimeEnd` (string, 选填) — SPU的更新时间段（结束时间），格式 yyyy-MM-dd HH:mm:ss。更新时间定义：SPU下任意SKC的标题、品牌、IP、属性变更导致的更新。不包括价格、库存的更新。
  - `updateTimeStart` (string, 选填) — SPU的更新时间段（开始时间），格式 yyyy-MM-dd HH:mm:ss。更新时间定义：SPU下任意SKC的标题、品牌、IP、属性变更导致的更新。不包括价格、库存的更新。

**响应体**:

- `(root)` (object, 选填) — OK
  - `code` (string, 必填) — 响应编码 成功：0
  - `msg` (string, 选填) — 错误描述,成功：OK
  - `info` (object, 选填) — 查询结果
    - `meta` (object, 选填) — 分页元信息
      - `count` (integer, 选填) — 符合查询条件的SPU数量
    - `data` (object, 选填) — SPU列表。默认按SPU发布时间降序排序。
      - `spuName` (string, 选填) — spu编码，平台生成的编码
      - `spuShelfStatus` (integer, 选填) — SPU的上架状态，0:下架 1:上架。待上架和已售罄均属于下架状态。
      - `categoryId` (string, 选填) — 末级类目ID
      - `skcList` (object, 选填) — SKC列表
        - `skcName` (string, 选填) — SKC的平台编码
        - `skcShelfStatus` (integer, 选填) — SKC上架状态，0:下架 1:上架。待上架和已售罄均属于下架状态。
        - `supplierCode` (string, 选填) — SKC的商家货号
        - `skcMainPicUrl` (string, 选填) — SKC主图URL
        - `skcTitle` (object, 选填) — SKC标题列表
          - `language` (string, 选填) — 语种。返回的语种取决于入参中的languageList
          - `title` (string, 选填) — 标题内容
        - `skcSalesAttribute` (object, 选填) — SKC销售属性列表
          - `language` (string, 选填) — 语种。返回的语种取决于入参中的languageList
          - `attributeId` (string, 选填) — 属性ID
          - `attributeName` (string, 选填) — 属性名称
          - `attributeValueId` (string, 选填) — 属性值ID
          - `attributeValueName` (string, 选填) — 属性值名称
        - `skcSiteShelfStatusList` (object, 选填) — SKC的站点维度上架状态
          - `status` (integer, 选填) — 上架状态，0:下架 1:上架。
          - `subSite` (string, 选填) — 子站点，例如shein-us
        - `skuList` (object, 选填) — SKU列表
          - `skuCode` (string, 选填) — SKU的平台编码
          - `supplierSku` (string, 选填) — 商家维护的SKU，即发布接口中的supplier_sku
          - `skuSalesAttributeList` (object, 选填) — SKU销售属性列表。如果列表为空，说明商品没有次规格属性。
            - `language` (string, 选填) — 语种。返回的语种取决于入参中的languageList
            - `attributeId` (string, 选填) — 属性ID
            - `attributeName` (string, 选填) — 属性名称
            - `attributeValueId` (string, 选填) — 属性值ID
            - `attributeValueName` (string, 选填) — 属性值名称
          - `costList` (object, 选填) — 成本价列表。仅半托管/全托管模式商家会返回此数据
            - `cost` (double, 选填) — 金额
            - `currency` (string, 选填) — 币种
          - `priceList` (object, 选填) — 售价列表。仅自运营商家返回此数据
            - `site` (string, 选填) — 站点。例如shein-us
            - `currency` (string, 选填) — 币种
            - `basePrice` (double, 选填) — 原价
            - `specialPrice` (double, 选填) — 特价。特价=0，代表商家发布商品时没有维护特价。特价为0时可视为无特价。
          - `inventoryList` (object, 选填) — 库存列表。如果为空，则说明商品在任一仓库都没有维护库存数据
            - `warehouseId` (string, 选填) — 仓库ID
            - `inventoryNum` (integer, 选填) — 库存数量
  - `traceId` (string) — 请求跟踪码

### 3001898 — 商品发布字段规范

- **endpoint**: `/open-api/goods/query-publish-fill-in-standard`
- **method**: POST
- **modes**: 自运营, 全托管, 半托管
- **QPS**: -
- **描述**: 每个店铺在各个分类下有不同的商品发布字段填写规范（要求）。建议在调用商品发布接口前，先调用此接口。本接口可查询的要求范围包括：1、商品标题和商品描述的必填默认语种（default_language）2、商品发布时是否必传竞品链接和库存证明（reference_product_link和proof_of_stock）3、商品发布时是否必传样品信息（sample_info）4、商品发布时是否必传品牌（brand_code）5、商品发布时是否必传skc标题（skc_title）6、半托管和全托管的供货价币种（currency）7、商品是否支持sku和spu维度的图片（picture_config_list）8、商品发布时是否必传最小备货数量（minimum_stock_quantity）9、商品是否支持上传详情图（product_detail_picture）10、商品是否支持在SKU维度传件数（quantity_info)11、商品是否支持传SKC建议零售价（suggest_price）12、商品是否支持填写商家条码（supplier_barcode）13、商品是否支持填写SKU包装类型（

**请求体**:

- `(root)` (object, 选填)
  - `category_id` (long) — 末级分类id。查询以下信息的填写规范时需要入参末级分类ID:分类是否支持SPU维度图片、样品信息、SKU包装类型、SKU维度件数、站点详情图、标题默认语种的最大字符数
  - `spu_name` (string) — SHEIN生成的SKC编码。该入参仅用于查询某个SPU当前是否正在使用图片新方案，其它场景不需要传；使用场景较少。

**响应体**:

- `(root)` (object, 选填)
  - `bbl` (object, 选填) — bbl
    - `info` (object, 选填)
      - `*` (object, 选填)
    - `npid` (string, 选填)
  - `code` (string, 必填) — result(success: 0)
  - `info` (object, 选填)
    - `fill_in_standard_list` (object, 必填) — 商品发布接口中字段的填写规范列表。每个field_key值会对应发布接口中的一个入参字段，可确认某个入参能否传值、是否必传。
      - `field_key` (string, 必填) — 规范内容。以下是此接口枚举值 - 对应的发布接口入参字段名1、reference_product_link - competing_product_link2、sample_spec - sample_info3、proof_of_stock - proof_of_stock_list4、shelf_require - shelf_require5、brand_code -brand_code6、skc_title - skc_title7、minimum_stock_quantity - minimum_stock_quantity8、product_detail_picture - site_detail_image_info_list9、quantity_info - filled_quantity_to_sku和quantity_info10、suggest_price - suggested_retail_price11、supplier_barcode -supplier_barcode12、package_type -package_type13、ip_character - ip_character_list
      - `module` (string, 必填) — 该模块是对应shein后台发品页面的模块，对应以下模块: 1、基本信息2、供应信息3、参考信息4、样品信息
      - `required` (boolean, 必填) — field key中内容是否必填。true-必填，false非必填
      - `show` (boolean, 必填) — field key中内容是否可传。true可传，false不可传（传了反而会报错）。
    - `currency` (string, 必填) — 商品供货价币种。半托管和全托管使用，在发布接口的cost_info -> currency 中使用。
    - `default_language` (string, 必填) — 商家的默认语言。在发布接口的multi_language_desc_list、multi_language_name_list中使用。默认语种的商品名称必填，
    - `default_language_title_max_length` (integer) — 商品标题的默认语种的最大字符数。平台从26年6月开始对默认语种字符数进行管控，不同商品分类+语种，默认语种的字符数限制不同。请入参category_id后获取最大字符数。
    - `language_title_max_length_list` (object) — 商品标题的所有语种的字符数限制（含默认语种）
      - `language` (string) — 语种
      - `max_length` (double) — 语种的最大字符数（含空格）
    - `picture_config_list` (object) — 查询店铺是否支持SPU、SKC、SKU维度上传图片
      - `field_key` (string) — 字段Code
      - `is_true` (boolean) — 枚举：是/否
    - `weight_config` (object) — SKU的重量填写规则。只有在传入 category_id 时返回，否则为 null。
      - `is_required` (boolean) — SKU重量是否必填
      - `available_units` (string) — SKU重量可用单位列表。不同商家和分类可能会有所不同。
    - `length_width_height_config` (object) — SKU的长宽高填写规则。只有在传入 category_id 时返回，否则为 null。
      - `is_required` (string) — 是否必填
      - `available_units` (string) — 可用单位标识符列表，枚举值：cm / Inch / Ft
    - `support_sale_attribute_sort` (boolean) — 该字段判断是否支持次销售属性值排序；主销售属性值默认都支持排序
  - `msg` (string, 选填) — 错误描述， success: OK
  - `traceId` (string) — 请求的唯一标识；用于异常报错跟踪

**请求示例**:
```
curl --location --request POST 'https://openapi-test01.sheincorp.cn/open-api/goods/query-publish-fill-in-standard' \ --header 'language: zh-cn' \ --header 'x-lt-openKeyId: test' \ --header 'x-lt-signature: test' \ --header 'x-lt-timestamp: 1752733538805' \ --header 'Content-Type: application/json' \ --header 'Host: openapi-test01.sheincorp.cn' \ --data-raw ''
```

**响应示例**:
```
code": "0", "msg": "OK", "info": { "fill_in_standard_list": [ { "module": "reference_info", "field_key": "reference_product_link", "required": false, "show": false }, { "module": "reference_info", "field_key": "proof_of_stock", "required": false, "show": false }, { "module": "basic_info", "field_key": "skc_title", "required": false, "show": true }, { "module": "supplier_info", "field_key": "minimum_stock_quantity", "required": false, "show": false }, { "module": "sales_info", "field_key": "shelf_require", "required": false, "show": false }, { "module": "basic_info", "field_key": "brand_code", "required": true, "show": true } ], "default_language": "en", "picture_config_list": [], "currency": "GBP", "support_sale_attribute_sort": null }, "bbl": null, "traceId": "19291dc98a3812a8" }
```

### 3001544 — 获取店铺上架额度

- **endpoint**: `/open-api/goods/query-shelf-quota`
- **method**: POST
- **modes**: 自运营, 半托管, POP
- **QPS**: -
- **描述**: 平台对店铺可上架的商品SKC数量有管控，请在调用商品上架接口之前先查询店铺可上架额度，有额度时再操作上架。仅自运营、半托管模式的商家会被管控上架额度。

**响应体**:

- `(root)` (object)
  - `code` (string) — 响应编码 成功：0
  - `msg` (string) — 响应信息。成功：OK
  - `info` (object, 必填) — 详细信息
    - `need` (boolean) — 店铺是否被管控上架额度。true=被管控，剩余可用额度（remain_count）大于0时，代表还能上架SKC；false=不被管控，即店铺可上架SKC数没有限制；
    - `total_quota_count` (integer) — 总的可上架SKC数量。
    - `on_shelf_count` (integer) — 已上架的SKC数量
    - `remain_count` (integer) — 剩余可上架SKC数量
  - `traceId` (string) — 追踪码
