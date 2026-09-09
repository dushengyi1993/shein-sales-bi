# 本轮已确认工作簿价格

普通活动可在已有用户授权下，用当前工作簿的精确行价覆盖历史标准。此能力只用于本轮普通活动的已锁定行，不修改全局三档标准，不成为后续日期或其他活动的默认价。

价格行保留真实 `storeKey`、`activityId`、`skc`、`canonical`、完整精度的 `cost` 和 `storageUnitCostSar`。在用户确认的行上添加：

```json
{
  "reviewedWorkbookPrice": {
    "schemaVersion": "ordinary-reviewed-workbook-price/v1",
    "workbookSha256": "原工作簿的64位SHA256",
    "businessDate": "2026-09-09",
    "tier": 0,
    "targetPrice": 91.53,
    "sourceCells": ["价格表!I2"],
    "reason": "本轮用户保存的高点击价格修改"
  }
}
```

示例单元格只是格式示例，执行者必须填写实际工作表和单元格。`tier` 为当前数据证明的档位：0 高点击、1 前五/新品、2 普通。参数备注生成的价格也要记录实际备注单元格及计算依据。所有存在的 `targetPrice`、`finalTargetPrice`、`limitedDiscountPrice`、`specialPrice` 必须与声明价格一致。当前成本用于校验与利润披露，不得通过修改成本使价格通过。

仅在本轮明确精确改价、备注覆盖或已审继承标准需要重新核对的行上使用此声明。其余行继续沿用用户已允许的浮动和成本精度规则，不因 225.40 到 225.41 这类已授权浮动而扩大阻断。可以先用 `classifyFixedTierLink(row, context)` 从完整当前数据得到档位，再采用对应授权数值或参数；此只读分类函数不提供提交权限。新增能力不改变八品固定价和平台限制的原有规则。

将同一工作簿复制为执行运行目录内的普通文件，用原锁定命令和原授权文字生成新锁，增加 `--reviewed-workbook <本地文件>`，同时传入 `--workbook-sha256 <已核实SHA256>`。仅添加声明或修改已锁文件不能生效。锁命令会验证工作簿字节和当日声明；执行器再次验证工作簿、选择/价格文件哈希、工作指纹及精确行子集。

仅成功加载的审批清单可签发本进程能力。离线规划器如需验证新锁，使用 `loadOrdinaryCampaignApproval()` 返回的 `reviewedWorkbookPriceCapability`，传入 `buildLowEtFastSellerPricingContext()` 或 `buildFixedTierContext()` 的同名参数，然后调用现有 apply/verify/revalidate。序列化复制能力、旧行标记、没有清单的单独声明均不能授权。

此能力允许已确认的精确价格处理旧继承标准的待核对标记、已确认的新标准以及高点击派生底线冲突。仍需当前在售和商品身份、完整分类数据、相同档位、相同完整成本及平台限制；人工特殊折扣保护保持有效。价格和利润按实际平台约束记录。档位、成本、工作簿或本轮范围变化必须重新生成相符的新锁，不能重放不确定的提交。

平台报名、资源清理和云端机器人交付继续由原业务任务独占。代码发布前不得将本地源码补丁复制到正在执行的 `.5` 运行目录；维护开始前先确认所有在途请求和浏览器状态。
