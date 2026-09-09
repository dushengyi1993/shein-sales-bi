# 营销名单必须逐项完成

2026-09-10 用户明确：报名名单中的每一项都必须处理，不能因内部缺指标、程序失败或价格受限而缩小名单。普通活动、限时兜底共用最新已审工作簿、备注及价格基准；尚未执行完不影响已审价格作为后续基准，也不能据此把旧执行标成完成。

- 先补抓曝光等依据；仍未知时保留已审档位，无已审档位按普通档。未知值保持 null，不伪造曝光、排名或销量。无既有价格标准按含仓储利润率23%/25%/30%，普通档30%；平台上限优先，按已授权规则保留小幅浮动。
- BI 缺商品/在售字段不能作为平台拒绝。价格准备与执行资格分开；平台实时身份、可报名名单、SKU及真实库存仍要核实。准备价格不等于已取得资格或已提交。
- 原名单是不可缩水的任务全集。可恢复的错误修好继续；截止的普通活动转查限时折扣兜底；真正平台拒绝保留“未完成”、原错误和下一动作，不能声称已报名。
- 按店铺+SKC合并限时兜底，但保留每个原活动的对应关系。先核已有活动、价格栈、人工特殊保护和库存事务；已有准确覆盖只核验，混合活动按单品操作，不能为了一个品结束其他品的活动。
- 已提交、待核回或不确定项仅沿原任务核回，不能重复提交。任何“必须报”的要求都不能被实现成重复提交或伪造平台结果。
- 原业务任务独占业务执行、浏览器和报告；开发任务负责代码和正式发布。用户只接收有意义的最终交付，不因内部轮询新增定时提醒。

## 正式工具与验收

`buildFixedTierContext` / `resolveFixedTierPrice` / `verifyFixedTierBinding` 为普通和限时共用价格层。9月10日起的缺分类回退保存 `pricingClassificationFallback`，注明已审档位或普通档、真实未知指标、原失败原因和待平台校验状态。最新已审源通过精确SHA/审批清单绑定，`reviewedWorkbookPrice` v2 的三档依据与备注可跨日继承；执行报价仍按新单元锁定。六项已审补充标准已纳入 `config/marketing_fixed_tier_standard.json`，旧“待核”标记不再覆盖这些已审依据。

`build_new_listing_limited_discount_plan.mjs --required-roster <原名单.json>` 接受 rows/items 数组中的 storeKey、skc、canonical。名单内缺BI行也保留为候选，输出每个去重链接的准备状态、未完成原因和下一动作；该参数不授权创建活动。仍使用原受管批次、dry-run、精确锁、实时校验及创建后核回。定价生成器和限时的两个复验入口均消费相同规则。

`build_marketing_obligation_ledger.mjs --roster <完整原报名名单.json> --observations <已核实回执.json> --out <新版本清单.json>` 保留全部活动行。输入 roster 可以是数组或 items/rows/blocked 数组，包含 storeKey/store/st、activityId/aid、skc、canonical/c；不能把筛过的可执行子集当作完整原名单。

observations 由原业务任务核对官方原文件后归一化：state 为 ordinary_confirmed 或 limited_confirmed，必须有 officialReadback、identityMatched、priceMatched 均为 true，inventoryState 为 not_changed/restored，receiptPath、receiptSha256、readbackAt。限时还需 validFrom/validTo；未来超过两小时、已结束、库存未恢复或仅有提交状态均不算覆盖。提交不确定使用 submissionState=unknown/pending/submitted，仅生成原提交核回动作。不得把计划、UI点击或机器人摘要转成官方回执。

每次最终报告都使用原名单清单，分别列普通核回、限时兜底核回、未完成和原提交待核回。用 `build_marketing_daily_guard_report.mjs --obligation-ledger <清单>` 或受管环境变量 `SHEIN_BI_MARKETING_OBLIGATION_LEDGER` 接入日报；日报从原名单及观察重新计算，不能直接相信历史 complete 标记。未完成的行全部保留原因和下一步，不截断出分母。

本次回归覆盖375项原名单、208项过期活动对应104个去重链接、未提交与未知状态保护、缺BI/曝光普通档、已审档位继承、平台cap、真实成本缺失、限时计划生成和两个执行前价格复验入口。测试通过只证明代码；正式版本、实际任务核回和飞书回执分别验收。
