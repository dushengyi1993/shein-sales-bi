# 淘汰链接审核工作簿入口

`scripts/link_retire_review.mjs` 是 shein-3 审核交付入口；旧 `build_link_retire_candidates_from_csv.mjs` 仅保留离线策略兼容，不能作为完整业务审核工作簿。

前置：维护放行、唯一 morning-chain 与 `validate_daily_operating_refresh.mjs` 当日成功。使用业务任务已保存的受管 `linksData,productState` query 和同名 manifest，不重新执行 query。

1. `node scripts/link_retire_review.mjs --query <query.json> --run-date YYYY-MM-DD --performance-date YYYY-MM-DD --out-dir outputs/<exclusive-run>`
2. `node scripts/build_link_retire_review_workbook.mjs --input outputs/<exclusive-run>/analysis.json --output outputs/<exclusive-run>/review.xlsx --qa-dir outputs/<exclusive-run>/qa`
3. 验证工作簿与 manifest 后，沿用步骤1参数，增加 `--evidence outputs/<exclusive-run>/evidence.json --workbook outputs/<exclusive-run>/review.xlsx --send`。显式发送只走云端 bot，automationId 固定 shein-3，保存 delivery-receipt.json。未知发送结果不得改指纹重发。

工作簿依赖路径遵循 builder 帮助/环境配置。不得运行写死日期的历史 collector/builder。已有 evidence.json 不覆盖；配套 manifest 锁定受管主机、collector SHA、请求、来源清单和证据字节。`--evidence` 验证 manifest 后纯本地重算。仅补读历史文件时，可用独立输出目录和 `--supplement-evidence <原 evidence.json>`，验证原 manifest 并沿用原数据库结果，不再执行 SQL。旧版没有 manifest 的历史证据只保留归档，不作为新发送输入。

## 来源与缺项

- query manifest 校验成功、字节数、SHA-256、两 section 与 19 店 storeLinks，拒绝重复店铺+SKC和日期回退。
- PostgreSQL READ ONLY 事务：指定表现日 raw_summary 的新品标签/7天曝光/销量，当前 OpenAPI SPU、状态、库存、首次/最新上架时间，逐店SKC库存日序列。空值不转0。
- 状态历史直接读取 `fact.link_master_snapshot`，并与当日 marker 依赖中的不可变原始工件比对 hash/bytes；无 snapshot 时读取原始工件，检查店铺、日期、成功状态。数据库可覆盖缺失原文件，但两者冲突、缺SKC日期或重复记录均待确认，不能用全店覆盖代表单SKC覆盖。
- 营销读取已完成的 live scan，验证店铺成功、北京时间当日采集和有效活动起止时间。历史业务标签不等于当日活动。
- 营销状态用于展示与保护核查；无当前营销活动本身不增加淘汰排除条件。当前上架状态必须明确，缺销量或曝光分别进入待确认。
- 保护期以审核日为准，保留前一天基线以识别保护窗口首日恢复；当天由已验证的当前 OpenAPI 观察补齐，旧 last_shelf_time 不能代替完整库存/状态历史。
- 明确新品、近期上架/恢复、当前非上架可排除；其他缺项逐店SKC列入工作簿，不能把 server retire_candidate 当最终结论。缺曝光的在售零销售行单独保留待确认。

工作簿同一文件含候选审核、待确认、排除及来源说明。输入证据指纹与交付指纹用途不同：前者锁查询/补充证据，后者由受管交付管线锁 automationId+审核日+XLSX SHA256，摘要另有 SHA256 并由持久状态校验。双端验收必须检查云端持久记录、摘要消息、附件消息及SHA256/bytes/fingerprint一致；仅工作簿生成成功不表示已交付。任何报告都不是下架授权。

本入口在云端以 shein-3 + 审核日原子认领一次发送机会。该日已有任意交付工件，或已有成功、失败、部分、未知发送认领时，本入口均禁止再次发送，包括换目录或重新生成不同 XLSX 字节。云端通用接收端也持有日级跨进程锁，强制所有入口只能使用该日原指纹；原受管补投链只允许补交同一报告明确失败的部分，已成功项目跳过，未知项目禁止重发。保留原认领、receipt/readback，不能改指纹创建第二份当日报告；需要修正时先明确核验已有结果，再由人工处理。

发布验证除注册的确定性 evidence/entry/day-claim 测试外，还必须运行 `node scripts/test_link_retire_review_workbook.mjs --artifact-tool-entry <bundled artifact_tool.mjs>`。该显式本地发布门禁覆盖 producer→XLSX→重新导入及五张表渲染；GitHub runner 没有桌面 artifact-tool，不能将 CI 通过冒充工作簿验收。
