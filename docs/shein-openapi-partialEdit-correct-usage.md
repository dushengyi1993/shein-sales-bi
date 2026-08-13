# SHEIN OpenAPI partialEdit 正确用法和陷阱

## 核心接口

- **endpoint**: `/open-api/goods/product/partialEdit`
- **docId**: 3001810
- **方法**: POST
- **适用模式**: 自运营、全托管、半托管
- **QPS**: 40

## 关键行为模型

### 1. 返回值判定

`partialEdit` 返回 `code=0, msg=OK` **不代表修改成功**。必须检查 `info.success`：

```json
{
  "code": "0",
  "msg": "OK",
  "info": {
    "success": true,   // ← 这才是真正的成功标志
    "version": "SPMP...",  // 审核版本号
    "pre_valid_result": null  // null 表示校验通过
  }
}
```

如果 `info.success=false`，`info.pre_valid_result` 数组包含具体校验错误。

### 2. 全量校验

`partialEdit` 虽然是"部分编辑"，但平台会**补齐未入参字段后进行全量商品校验**。这意味着：

- 即使只改标题，如果商品本身缺必填属性，校验也会失败。
- 必须确保商品整体数据符合平台要求，包括新增的必填属性。

### 2.1 标题 + 图片必须合并提交

同一个旧链接维护任务里同时有 `update_title` 和 `update_images` 时，执行器必须构造**一个** `partialEdit` payload：

- operation 记为 `update_title_and_images`
- 同一个 body 里同时包含 `multi_language_name_list`、`skc_list[].skc_title`、SPU/SKC/SKU 图片字段
- 真实提交时只调用一次 `/open-api/goods/product/partialEdit`

原因：`partialEdit` 提交成功后会进入审核流；如果先提交标题，平台可能因为审核中拒绝第二次图片编辑，反过来也一样。

本地不能直连 SHEIN OpenAPI。开发期只允许用假 OpenAPI smoke 测试证明 payload 和门禁逻辑；真实上传/提交/回读只在 `shein-bi-tencent` 云端执行。

### 3. 标题覆盖陷阱

**平台全量校验用的是 SKC 标题（`skc_title`），不是 SPU 标题（`multi_language_name_list`）。**

- 如果 SKC 的 `skc_title`（默认语种 ar）超过 325 字符，只传 `multi_language_name_list` 无法解决。
- 必须在 `skc_list` 里传 `skc_title` 来覆盖 SKC 标题。
- 默认语种通过 `query-publish-fill-in-standard` 获取（沙特站为 `ar`）。

### 4. 必填属性陷阱

商品属性有关联必填规则。例如：

- Power Supply(147) = Wall Plug(1047) → Input voltage(1002322) 和 Input current(1002323) 必填。
- `partialEdit` 全量校验时会检查这些关联必填属性。
- 需要在 `product_attribute_list` 中同时传入缺失的必填属性。
- 对新上 `publishOrEdit`，执行器会先查官方 `query-attribute-template`，再从已有 `Plug(Voltage)` / `Voltage` 属性推导 `Input voltage`。例如 `UK Plug(220-240V)` 可补为 `attribute_id=1002322`、`attribute_value_id=301114341`（`Vac 50–60Hz`）、`attribute_extra_value=220-240`。如果模板或已有属性不足以推导，执行器按负责人授权执行同货号 provenance 补值：仅从相同标准货号的其他 OpenAPI 链接（`searchProduct` → `spu-info`，单页最多 10 条）提取 `1002322` 直接值，或用现有确定性范围解析从官方 `Plug(Voltage)`/`Voltage` 属性推导范围；`1002322` 单位值 ID 复用受控目录映射 `301114341`（evidence 标注 `official_catalog_mapping`，与当前模板 Vac 单位值 ID 冲突则阻断）。所有同货号候选归一后唯一一致才填入（来源 SPU/SKC、value id、extra value 写入审计与证据并进入 payload hash）；来源缺失、范围歧义、货号不一致或无法解析一律保持阻断，不能硬编码猜值或按文字猜测。

属性查询方式：
- `query-attribute-template`（需要 `product_type_id_list`，从 `spu-info` 获取 `productTypeId`）
- `attribute_mode=4` 的属性需要同时传 `attribute_value_id` 和 `attribute_extra_value`

### 5. 图片排序

- 图片 `image_sort` 必须全局唯一，不能按 `image_type` 分组排序。
- 方形图（image_type=5）的 sort 不能和主图（image_type=1）重复。
- 建议方形图 sort 从最大 sort+1 开始。

### 6. 图片组编码

- 编辑场景必须传 `image_group_code`（从 `spu-info` 获取）。
- SPU 图片和 SKC 图片有不同的 `image_group_code`。

### 7. 审核流程

- `partialEdit` 提交后进入平台审核队列，不是立即生效。
- 审核状态通过 `query-document-state` 查询（需要 `spuName` + `version`）。
- `documentState=1` 表示审核中。
- 审核期间不能再次提交修改（返回 `code=20100`）。
- 可以用 `revoke-product` 撤回审核，然后重新提交。

### 8. 编辑前提

- SPU 已通过审核
- 当前无进行中的审核流程
- 可通过 `check-edit-permission` 检查是否可编辑

## 正确的 partialEdit payload 结构

```json
{
  "spu_name": "v2601281707824057",
  "is_spu_pic": true,
  "multi_language_name_list": [
    {"language": "en", "name": "英文标题"},
    {"language": "ar", "name": "阿拉伯文标题"}
  ],
  "image_info": {
    "image_group_code": "G07jcx3aofr3",
    "image_info_list": [
      {"image_type": 1, "image_sort": 1, "image_url": "https://..."}
    ]
  },
  "skc_list": [
    {
      "skc_name": "sv260128170782405768770",
      "skc_title": "阿拉伯文标题（默认语种）",
      "image_info": {
        "image_group_code": "G07jcx0w7s01",
        "image_info_list": [
          {"image_type": 1, "image_sort": 1, "image_url": "https://..."},
          {"image_type": 2, "image_sort": 2, "image_url": "https://..."},
          {"image_type": 5, "image_sort": 12, "image_url": "https://..."}
        ]
      },
      "sku_list": [
        {
          "sku_code": "I4mkxt7llaypea",
          "image_info": {
            "image_info_list": [
              {"image_type": 1, "image_sort": 1, "image_url": "https://..."}
            ]
          }
        }
      ]
    }
  ],
  "product_attribute_list": [
    {"attribute_id": 1002322, "attribute_value_id": 301114341, "attribute_extra_value": "220-240"},
    {"attribute_id": 1002323, "attribute_value_id": 304301999, "attribute_extra_value": "9.1"}
  ]
}
```

## 执行器修复记录

### compactCallResult 修复

**问题**：`compactCallResult` 只保留 `code/msg/traceId`，丢弃了 `info` 字段，导致 `info.success=false` 的提交被误判为成功。

**修复**：`compactCallResult` 现在保留 `infoSuccess`、`infoVersion`、`preValidResult`、`skcList`。

### 提交成功判定修复

**问题**：`actualWriteSubmitted` 只检查 `String(r.code)==='0'`，不检查 `info.success`。

**修复**：改为 `String(r.code)==='0' && r.infoSuccess!==false`，并在 `info.success=false` 时将 `pre_valid_result` 加入 blockers。

### parseTitleFromText 修复

**问题**：正则 `(?:改成|改为|...|：|:)` 中 `改成` 匹配后不消费 `：`，导致标题以 `：` 开头。

**修复**：在 alternation 后加 `[：:]?` 消费可选冒号。

## 相关接口

| 接口 | endpoint | 用途 |
|------|----------|------|
| 商品部分编辑 | `/open-api/goods/product/partialEdit` | 修改商品信息 |
| 商品发布/编辑 | `/open-api/goods/product/publishOrEdit` | 完整发布/编辑 |
| 确认商品是否可编辑 | `/open-api/goods/product/check-edit-permission` | 检查编辑权限 |
| 查询商品审核状态 | `/open-api/goods/query-document-state` | 查审核状态 |
| 商品撤回 | `/open-api/goods/revoke-product` | 撤回审核 |
| spu查商品详情 | `/open-api/goods/spu-info` | 获取商品完整信息 |
| 商品综合查询 | `/open-api/goods/searchProduct` | 搜索商品 |
| 商品发布字段规范 | `/open-api/goods/query-publish-fill-in-standard` | 获取默认语种和必填字段 |
| 店铺查可选属性 | `/open-api/goods/query-attribute-template` | 查属性配置和可选值 |
| 查询关联属性填写规则 | `/open-api/goods/get-associated-attribute-rules` | 查关联必填规则 |
