# 文档索引

本目录面向接手开发、运维和业务操作人员。生产调度以 `infra/systemd/*.timer` 的 `OnCalendar` 为事实源；生产 runbook 见 [cloud-bi-operations.md](cloud-bi-operations.md)。

## 当前架构

- [BI 系统架构](bi-system-architecture.md)、[运行环境架构](runtime-architecture.md)、[仓库数据模型](data-model.md)、[BI 数仓模型](bi-warehouse-model.md)
- [BI Portal 当前界面](bi-portal-ui-current.md)、[Metabase BI](metabase-bi.md)、[链接运营产品主数据](link-ops-product-master.md)
- [OpenAPI 集成](shein-openapi-integration.md)、[OpenAPI 单应用生产切换（2026-07-26）](openapi-single-app-production-cutover-2026-07-26.md)、[OpenAPI API schema 索引](shein-openapi-api-schema-index.md)、[Webhook 接收与平台动态](shein-webhook-receiver-design.md)

## 运维 runbook

- [云端 BI 运行说明](cloud-bi-operations.md)、[BI 系统运行说明](bi-system-operations.md)、[云端优先交接](agent-handoff-cloud-first.md)；商品对账、凌晨互斥、Linux 健康语义见上述运行说明与 [systemd unit 参数](../infra/systemd/README.md)
- [应急恢复与备份](emergency-recovery-backup.md)、[迁移与恢复](migration-and-restore.md)、[全历史回补](bi-full-history-backfill.md)、[实际库存耗尽](actual-inventory-depletion.md)
- [每日营销巡检交接](marketing-daily-inspection-handoff.md)、[发布清单](release-checklist.md)、[systemd unit 参数](../infra/systemd/README.md)
- [源码、发布与云端版本治理](release-and-deployment-version-policy.md)

## 业务规则

- [营销活动报名定价规则](marketing-campaign-signup-pricing-rules.md)、[营销自动化路线图](marketing-automation-roadmap.md)
- [产品套图方法论](product-image-suite-methodology.md)、[产品套图研究](product-image-suite-research.md)、[参考月表结构](reference-month-table-structure.md)

## 参考与开发交接

- [脚本清单](scripts-inventory.md)、[后端调研](shein-backend-survey.md)、[OpenAPI 开发交接索引](shein-openapi-dev-handoff-index.md)
- [官方能力盘点](shein-openapi-official-capability-inventory.md)、[官方文档研究与计划](shein-openapi-doc-center-research-and-plan.md)、[partialEdit 正确用法](shein-openapi-partialEdit-correct-usage.md)
- [OpenAPI 适配器交接](openapi-adapter-development-handoff.md)、[OpenAPI 自动化计划](bi-ops-openapi-automation-plan.md)、[ET forwarder 集成计划](et-forwarder-bi-integration-plan.md)、[合作方 Codex 运维设置](partner-codex-ops-setup.md)、[合作方 CLI 自动部署](partner-cli-automatic-deployment.md)

## 历史、发布与归档

- [当前发布说明（2026.07.30.4）](bi-ops-release-2026-07-30-4.md)、[共享商品详情额度与持续门禁（2026.07.30.3）](bi-ops-release-2026-07-30-3.md)、[源码一致性门禁（2026.07.30.2）](bi-ops-release-2026-07-30-2.md)、[利润、营销与运行态隔离（2026.07.30.1）](bi-ops-release-2026-07-30.md)、[上一正式版本（2026.07.28.4）](bi-ops-release-2026-07-28-4.md)、[Partner CLI 长会话（2026.07.28.3）](bi-ops-release-2026-07-28-3.md)、[加车访客与查询修复（2026.07.28.2）](bi-ops-release-2026-07-28-2.md)、[无模型只读 query（2026.07.28.1）](bi-ops-release-2026-07-28.md)、[利润成本修复（2026-07-28）](bi-profit-cost-correction-2026-07-28.md)
- [CLI 自动更新收口（2026.07.27.3）](bi-ops-release-2026-07-27.3.md)、[售后对账可见性修复（2026.07.27.2）](bi-ops-release-2026-07-27.2.md)、[历史店铺与售后口径修复（2026.07.27.1）](bi-ops-release-2026-07-27.md)、[全项目审查修复（2026.07.26.2）](bi-ops-release-2026-07-26.md)、[单应用生产切换（2026-07-26）](openapi-single-app-production-cutover-2026-07-26.md)、[半托 Webhook 实时销售切换（2026-07-23）](bi-webhook-live-cutover-2026-07-23.md)
- [Partner CLI 最低折后价修复（2026.07.21.1，历史 ask 口径）](bi-ops-release-2026-07-21.md)、[自动运营与 Partner CLI（2026.07.16.1）](bi-ops-release-2026-07-16.md)
- [Webhook/平台动态发布说明（2026.07.20.2）](bi-webhook-release-2026-07-19.md)、[仓储费发布说明（2026.07.19.1）](bi-ops-release-2026-07-19.md)、[仓储费历史重述（2026-07-19）](storage-fee-history-restatement-2026-07-19.md)、[业务逻辑与营销加固（2026.07.18.1）](bi-ops-release-2026-07-18.md)、[BI V2 发布说明（2026-07-12）](bi-ops-v2-release-2026-07-12.md)
- [业务逻辑加固收口（2026-07-18）](bi-business-logic-hardening-2026-07-18.md)、[优化复盘（2026-07-10）](optimization-review-2026-07-10.md)、[实施路线（历史）](implementation-roadmap.md)、[OpenAPI 自动运营原始方案（历史）](bi-ops-openapi-automation-plan.md)
- [利润审计（2026-03-05）](bi-profit-audit-2026-03-05.md)、[负责人知识同步](owner-knowledge-sync.md)、[合作方 CLI 发布（2026-07-13）](partner-cli-release-2026-07-13.md)
- [营销运行归档：2026-07-13 至 2026-07-16](archive/marketing-runs/2026-07-13-to-2026-07-16.md)、[存储费利润集成历史计划](superpowers/plans/2026-05-30-storage-fee-profit-integration.md)
