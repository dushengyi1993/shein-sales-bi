# 发布拒绝诊断

旧任务只有哈希时，不能还原平台错误原文。traceId 是关联线索，不是已实现的查询接口。官方 query-document-state 需要 SPU 和 version；提交前拒绝且两者为空时不能拿 traceId 冒充这些参数，也不能为了取得诊断重放发布。

新执行器收到非成功响应后，在 /srv/shein-bi/runtime/link-ops-private-diagnostics 保存追加式诊断。只选取平台 code、trace、module、form 和 messages；去除已知凭据、认证值及已审核文案片段，不保存请求、headers、client 或完整 payload。目录仅执行用户可访问，文件权限0600。普通任务结果保持原有哈希脱敏，新增 publishDiagnostic 仅提供ID、文件SHA-256和保存状态。

在云端按精确证据读取：

    node scripts/read_link_ops_publish_diagnostic.mjs <publishDiagnostic.id> <publishDiagnostic.sha256>

此命令只读已存文件，不调用SHEIN、不修改任务、不重新提交。保存失败只产生明确警告，不改变已尝试请求的受理、拒绝或未知状态。回环模拟提交不会创建生产诊断文件。

旧LG拒绝没有这种文件且原响应已被哈希化时，本修复不能补回原文；需要官方支持按trace排查或已存在的官方原始请求日志。当前代码没有已核实的traceId查询原响应API，不能根据相同哈希推断具体字段问题。
