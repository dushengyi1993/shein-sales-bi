# 库存巡检来源编排修复

目标版本：`2026.08.04.4`
发布日期：2026-08-04

## 1. 根因与修复

- 08:00晨间链路虽在08:33完成链接数据入库，但慢速日更到09:20才启动Portal预热；旧实现把预热作为oneshot后台子进程，受到`KillMode=control-group`清理，09:35库存巡检仍读到03:15的旧`linksData`。
- 09:35库存服务现在显式等待晨间链路；晨间任务漏跑时由依赖关系补启动并等待完成。
- 慢速日更同步刷新库存关键`linksData` section，再以前台脚本提交其他异步section请求，不再把预热启动器留在会被systemd清理的后台。
- 库存守卫要求`linksData`缓存不超过30分钟；过期时同步刷新并验收落盘时间，仍过期则重试一次并失败关闭。
- 19店OpenAPI商品/库存快照过期、缺失或存在失败分片时，自动执行一次只读刷新并重建计划。
- 计划器即使以阻断状态码退出，守卫仍读取完整计划、输出精确blocker并保持非零服务状态，不再被`set -e`提前截断。

## 2. 安全边界

- 所有源刷新均为只读；库存写入仍只允许当前自动授权上下文、当天64位hash和可执行计划。
- ET、linksData、OpenAPI、四态、SKU、销量/曝光或实时库存任一门禁失败时继续fail closed。
- 同hash完整结果继续返回`already_completed`，不重复写库存。

## 3. 验证与部署

- `bash -n`、库存策略/调度专项测试、`git diff --check`和完整`npm test`必须通过。
- 云端同步`linksData`实测可更新`cachedAt`并正常完成。
- GitHub `main`、tag `2026.08.04.4`和云端`/opt/shein-bi/app`必须指向同一commit。
- 云端安装更新后的库存systemd unit，保留原09:35 timer，不创建重复定时器。
- 执行`node scripts/check_release_source_state.mjs --expected-commit 2026.08.04.4 --record-deployment 2026.08.04.4`并取得`ok=true`。

## 4. 回滚

- 回滚点为`2026.08.04.3`。
- 回滚只恢复旧来源编排；不得删除当天计划、执行结果或审计文件。
