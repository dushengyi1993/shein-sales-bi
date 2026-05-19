# 链接管理中台：商品资料母库设计

更新时间：2026-05-19

## 目标

商品资料母库用于支撑“把源店已上商品复制到目标店”的自动化流程。它不是 SHEIN 发布 payload 的简单镜像，而是把跨店可复用的商品结构沉淀下来：

- 商品货号、类目、品牌、标题、动态品类属性、销售属性、SKU 变体模板、尺寸重量、报价策略、证书/资质引用；
- 不保存图片文件，也不保存图片 URL；
- 不把平台生成的 `skc` / `skuCode` 当成可复用的商家 SKU；
- 同一货号出现参数分歧时，进入人工核实，不静默覆盖。

## 名词口径

- `skc`：SHEIN 平台给某个链接/颜色组生成的编号，例如 `sv...`、`sb...`。新链接审核通过后会生成新的 `skc`。
- `skuCode`：SHEIN 平台给 SKU 生成的编号，例如 `I0mm...`。这是平台产物，只能做源/目标映射追溯。
- `supplierSku` / `supplier_sku`：商家自定义 SKU。当前 HL OpenAPI `spu-info` 里存在该字段，但部分已上商品为空；系统不能用源店平台 `skuCode` 冒充它。若发布接口强制要求，再按规则或人工补。
- 商品货号：当前项目的经营口径，例如 `S1810电热水壶`，是母库的主要归并键。

## 字段来源边界

### 当前 WebAPI 快照已能抓到

来自 `outputs/shein_links/<店铺>/<日期>.json` 与 `outputs/shein_links_raw/<店铺>/<日期>/*.json`：

- 源店、源日期、源 `spu`、源 `skc`、源 `skuCode`；
- 商品货号、标题、类目 ID、类目名称/路径、品牌；
- 销售属性的部分 `attribute_id` / `attribute_value_id`；
- 商品图候选 URL（只用于任务执行临时素材，不进入母库）；
- 链接状态、表现、库存展示页指标。

不足：

- 不是完整编辑页详情，通常缺 `productTypeId`；
- 缺完整 `product_attribute_list`；
- 缺 SKU 尺寸、重量；
- 缺官方发布可直接使用的供货价/报价结构；
- `supplierSku` 多数抓不到或为空。

### 已验证 HL OpenAPI 可抓到

只读接口：

- `/open-api/openapi-business-backend/product/query`
- `/open-api/goods/spu-info`

2026-05-19 本地验证：HL `product-query` 成功返回 20 条商品；取首个 `spuName` 调 `spu-info` 成功。该接口返回字段包括：

- `spuName`
- `categoryId`
- `productTypeId`
- `brandCode`
- `supplierCode`
- `productMultiNameList`
- `productAttributeInfoList`
- `skcInfoList[].skcName`
- `skcInfoList[].attributeId`
- `skcInfoList[].attributeValueId`
- `skcInfoList[].skuInfoList[].skuCode`
- `skcInfoList[].skuInfoList[].supplierSku`
- `skcInfoList[].skuInfoList[].length / width / height / weight`
- `skcInfoList[].skuInfoList[].costInfoList`
- 图片字段也会返回，但母库不保存。

样本：HL 首个商品 `FZ-666颈部按摩器` 可生成 `candidate_ready` 母库候选：类目、`productTypeId`、15 个商品属性、1 个销售属性、1 个 SKU 模板、尺寸重量、SAR 成本均可取到；图片未写入母库。

## 母库结构

母库采用 JSONB / 动态属性数组，不做固定宽表。原因是不同品类字段不同，电器、服饰、美妆、工具类属性差异大，且 SHEIN 属性模板可能变化。

JSON Schema：

- `schemas/shein-product-master.schema.json`

生成脚本：

```powershell
node scripts/link_ops_build_product_master_candidate.mjs --source-store DL --source-skc sv260315124105439111444 --date 2026-05-15
node scripts/link_ops_build_product_master_candidate_from_openapi.mjs --store HL
```

核心层级：

- `identity`
  - `standardGoodsSn`
  - `canonicalProductKey`
  - `sourceGoodsSnList`
- `categoryProfile`
  - `categoryId`
  - `productTypeId`
  - `brandCode`
  - `categoryPath`
- `titleSet`
  - 按语言保存标题。
- `categoryAttributes`
  - `productAttributes[]`
  - `saleAttributes[]`
  - 每个属性保存 `attributeId / valueId / valueText / scope / source / status`。
- `skuTemplates[]`
  - `sourcePlatformSkuCode` 只做追溯；
  - `supplierSku` 可为空，不能用平台 `skuCode` 填；
  - `dimensions`
  - `costInfo`
  - `stockPolicy.initialStock = 100`
- `pricingPolicy`
  - 默认策略一：按商品 `50%` 利润率报价；
  - 默认策略二：按同款其它店铺最高核价报价；
  - 允许人工覆盖；
  - 不同店铺核价不同不视为商品参数冲突。
- `imagePolicy`
  - `storeImagesInMaster = false`
  - `strategy = task_temp_material_package_only`
- `sourceObservations[]`
  - 保存来源店、来源 `spu/skc/skuCode`、抓取时间、原始哈希和指针。
- `conflicts[]`
  - 用于人工核实字段分歧或必填资料缺失。

## 冲突与人工核实

需要进入人工核实的情况：

- 同一货号出现多个互斥类目；
- 同一货号在多个源链接中商品属性不一致，例如容量、功率、材质、插头规格；
- 尺寸/重量差异明显；
- 证书/资质要求不一致；
- 类目属性模板变化导致旧属性不再有效。

不作为商品资料冲突的情况：

- 不同店铺的核价/供货价不同；
- 不同链接活动价、折扣价不同；
- 平台生成的 `skc` / `skuCode` 不同。

价格处理走 `pricingPolicy`：执行发品前按 50% 利润率或同款最高核价生成本次报价；需要时人工覆盖。

## 当前验证结果

### DL S1810 WebAPI 快照

命令：

```powershell
node scripts/link_ops_build_product_master_candidate.mjs --source-store DL --source-skc sv260315124105439111444 --date 2026-05-15
```

结果：

- 状态：`candidate_needs_review`
- 商品货号：`S1810电热水壶`
- 类目 ID：`4681`
- 标题：1 条
- 销售属性：1 条
- SKU 模板：1 条
- 图片进入 `imagePolicy`，母库内无图片 URL
- 仍需补：`productTypeId`、完整商品属性、尺寸重量

### HL OpenAPI 源读取

命令：

```powershell
node scripts/link_ops_build_product_master_candidate_from_openapi.mjs --store HL
```

结果：

- 状态：`candidate_ready`
- 样本商品：`FZ-666颈部按摩器`
- `productTypeId`、商品属性、销售属性、尺寸重量、SAR 成本均可从 OpenAPI 取得；
- `supplierSku` 为空，但不阻断，因为不能用平台 `skuCode` 冒充；
- 图片未写入母库。

### DL S1810 商品编辑页 WebAPI -> HL 草稿

2026-05-19 已完成一次真实草稿保存验证：

- 源读取：DL 商品编辑页 `/spmp/product/get_similar_product_detail` 读取 `S1810电热水壶`，可补齐链接快照缺失的 `productTypeId`、商品属性、SKU 尺寸/重量、成本等字段。
- 目标写入：HL 商品子系统 `/spmp/product/save_draft` 更新草稿箱已有草稿 `v2603291437289685`，回读确认类目 `4681`、`product_type_id=1939`、属性 10 条、SKC 图 11 张、库存 100、成本 `70 SAR`、计划上架 `2036-05-19 10:00:00`。
- 发布站点校验：SPMP 商品编辑页复制时，源店详情可能带空 `site_list`；写入 HL 草稿前必须强制保留/补齐目标店站点 `shein / shein-sa`，否则页面“发布站点”会漏勾，后续提交审核前还要人工补选。
- 边界：本次只保存草稿，未提交审核或正式发布；图片不进入商品资料母库，只在执行时临时复制/引用，用后按任务素材生命周期清理。

结论：如果源店也有 OpenAPI，读取母库资料的完整度通常高于链接快照；短期没有源店 OpenAPI 时，商品编辑页 WebAPI 已证明能补齐链接快照缺口，但还需固化为受控执行器，并继续处理登录态、仓库/报价/证书/类目规则等校验。
