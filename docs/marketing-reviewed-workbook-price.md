# 本轮工作簿基准价与执行报价

2026-09-10 补充：遵循[营销名单必须逐项完成](marketing-roster-completion.md)。缺当前曝光不能抹掉原已审档位；没有已审档位且补抓仍缺时按普通档，未知指标不造零。普通和限时共用最新已审基准，不以旧方案是否执行完作为价格继承条件；原未完成执行状态必须保留。

用户于 2026-09-09 明确：工作簿价格是基准，包括八品和 KF-JN-02 的 91.53，允许链接间小幅浮动。按价格制定的标准允许 -2 至 +1 SAR；按利润率制定的标准允许 -2 至 +1 个百分点。每行按对应的一种方式计算，不叠加两种偏移，也不再应用旧的整数随机浮动。225.40 到 225.41 等已授权差异不应造成整份方案冻结。

## 准备与锁定

通过共享层 lib/marketing_price_variation.mjs 为新执行单元生成一次结果：

```js
const basis = {kind: 'price', tiers: [91.53, 91.53, 97.25]};
// 利润率标准示例：{kind: 'full_cost_margin', tiers: [.23, .25, .30]}
const resolution = resolveTierPriceVariation({
  basis,
  tier,
  fullUnitCostSar: Number(row.cost) + Number(row.storageUnitCostSar),
  seedKey: priceVariationSeed(row, businessDate),
  platformMaximum: knownPlatformMaximum ?? null,
});
```

价格、利润率数组须来自本轮实际已审工作簿及用户备注；上述数组仅作格式示例。tier 由完整当前数据证明：0 高点击、1 前五/新品、2 普通。可先调用 classifyFixedTierLink(row, context) 分类；分类函数不授予提交权限。成本必须保留真实完整精度，不使用工作簿展示值倒推或修改成本。

偏移由规则版本、业务日期、店铺、活动、SKC 和规范货号确定。同一输入复现同一结果。共享层先限制允许浮动区间，再按相邻档基准的中点划分报价区间，保证同成本条件下不同基准档位的报价顺序；相等基准可在同一分钱相接。平台上限最后应用，向下取到分，可能使报价相等；不同链接的平台上限或真实成本不同，也可能改变最终价格顺序。须记录真实平台约束，不能声称此时仍有严格的跨链接价序。

在需要本轮工作簿覆盖历史待核对标准的行上记录：

```js
row.targetPrice = resolution.price;
row.finalTargetPrice = resolution.price;
row.reviewedWorkbookPrice = {
  schemaVersion: 'ordinary-reviewed-workbook-price/v2',
  workbookSha256,
  businessDate,
  tier,
  targetPrice: resolution.price,
  basis,
  resolution,
  sourceCells: actualReviewedCells,
  reason: actualAuthorizationReason,
};
```

sourceCells 使用实际工作表、价格或备注单元格。若行上还有 limitedDiscountPrice、specialPrice，也必须等于生成后的最终报价。基准、完整计算记录和报价一起锁定；精确锁定的是执行 payload，不是要求最终价等于基准价。旧 v1 声明不能用于此规则。

把同一工作簿复制为运行目录内的普通文件。原锁命令增加 --reviewed-workbook <文件>，同时保留 --workbook-sha256 <已核实SHA256>、选择文件、价格文件及已有授权来源。锁命令核实工作簿字节、当日范围和完整计算记录；执行器再次核实这些文件、工作指纹和精确行子集。单独添加声明或修改已锁文件不会生效。

## 执行与历史记录

只有成功加载清单的 loadOrdinaryCampaignApproval() 才能签发本进程的 reviewedWorkbookPriceCapability。传入 buildLowEtFastSellerPricingContext() 或 buildFixedTierContext() 后使用原 apply/verify/revalidate。序列化复制的对象、旧标记和没有清单的声明均不能替代这一能力。

执行读取锁定的报价与偏移，不重新抽样；平台上限提高不能提高已批准报价，降低时按原平台约束规则审计实际价格。已提交、待回读、不确定单元保持原锁、原价格和回执，不能生成新日期偏移后重新提交。历史清单仍可读取原价格用于对账，但返回 historical_readback_only 且不签发当前执行能力。

本轮已审标准可处理旧继承标准的待核对标记、已确认的新标准和高点击派生底线冲突。仍校验在售与商品身份、分类数据、档位、完整成本和平台上限，保留人工特殊折扣保护与用户明确例外。用户备注优先，包括 SK-1710-4 对应 WK-1710-4、SK-1714-5 的 23%/25%/30%、KF 的两档 91.53 基准。成本、档位或授权范围变化时，只为尚未提交的受影响单元重新准备和锁定。

共享标准从 2026-09-09 启用浮动；旧日期的基准行为保留供历史核对。源规则变化不会自动迁移旧执行锁。普通报名、浏览器资源和飞书交付由原业务任务独占；不得把本地源码补丁复制进正在执行的 .5 运行目录。正式部署须等业务任务明确清空在途请求和浏览器资源。
