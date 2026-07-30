# SHEIN BI / Ops 2026.07.30.6 发布说明

发布日期：2026-07-30

标签：`2026.07.30.6`

上一正式版本：`2026.07.30.5`

## 本版范围

- BI同步异常、watchdog、营销提醒和SHEIN Webhook P0通知统一改发团队运营群，不再默认私聊负责人。
- 飞书目标抽成统一解析层：`recipientChatId`优先，个人`recipientUserId`仅作灾备。
- 日报文字、日报图片和手动日报入口同步支持群目标。
- 新增每天20:30团队巡检摘要，附巡检结论Markdown和营销巡检人话版报告。
- 云端飞书CLI由1.0.44升级到1.0.80，以支持外部群识别和发送。

## 验证

- 目标外部群由云端机器人身份精确搜索并匹配唯一群。
- 群文本消息与Markdown文件附件真实发送回读。
- notifier、Webhook通知契约、systemd安全和完整确定性测试通过。
- 新timer、watchdog、云端源码和发布标记一致。

## 回滚

- 源码回滚到`2026.07.30.5`。
- 私有配置移除`recipientChatId`后会回退个人`recipientUserId`；不得同时删除两个目标。
- 停用`shein-bi-cloud-daily-ops-group-digest.timer`只影响每日群摘要，不影响BI、Webhook和异常检测。
