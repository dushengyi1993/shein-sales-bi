# V6 E3/E4 库存补查与立即维护实现记录

截至 2026-09-05 19:32，本地实现及下列专项回归已通过；正式源码发布、Partner CLI 发布和云端部署验收尚未完成。本文描述当前代码，历史失败和所有权变更保留在 [执行记录](2026-09-05-v6-repair-execution.md)。

## 当前执行链

`maintain-inventory` 在发出请求前持久保存命令编号，通过 `POST /api/inventory-replenishment-run` 进入既有 Link Ops 持久作业队列。Portal 检查具体操作员、19 店写权限和 Worker 可用性；队列以 owner 与 commandId 区分请求。同一命令重试复用作业，参数漂移拒绝，新命令才分配新批次。

`lib/cloud_inventory_replenishment_job.mjs` 调用现有库存 guard。维护总闸、运行资源锁、新鲜 ET/链接、定向详情、自动授权和 payload hash 检查继续由原执行链承担。guard 以 `runs/<date>/<command-hash>/` 隔离本批次计划、结果、journal 与 marker；作业进程组停止后才释放执行所有权。

## 封存与补查

`scripts/inventory/daily_inventory_version_publisher.mjs` 将计划、结果、journal、marker 和依赖证据保存为不可变快照，以原子写切换 v3 版本索引。`ensureLegacyExecutionArtifactsPreserved` 仍负责首次纳入旧日期路径的原始字节；新批次不再把结果镜像覆盖回旧日期文件。

发布器与 durable append 共用 journal publication ticket。它按完整路径排序获取所有已发现 journal 的锁，加锁后重新发现文件集合；漂移时释放全部锁并有界重试，发布前再核对集合及四件套。不同版本索引也遵循相同 journal 锁顺序，避免两个发布者各持一个 journal 互相等待。

旧 journal 封存后拒绝追加。新批次只读核对旧请求，将终态引用写入自己的 journal，并绑定旧文件 SHA、intent hash 和精确对象；旧计划、结果、journal、marker、封存标识与快照字节保持不变。

- 旧目标已匹配且等于新目标：记为目标已满足，无库存 POST。
- 旧目标已匹配但不同于新目标：关闭旧 intent，新目标标记延期，发布 warning，无修正性 POST。
- 旧目标仍未匹配：保留未决状态与原请求身份，发布经审计的 warning，无重复 POST。
- 仓库漂移、损坏 journal、同命令计划漂移或缺失命令身份：保守阻断，不凭当前数量猜测请求身份。

`validate_daily_operating_refresh.mjs` 对同日异命令 warning 复核旧请求身份、源 journal、目标、仓库、四个原始库存字段、零写入和精确 result journal 事件。已关闭但延期的行计入 warningCount，pendingCount 为 0；不能把它伪装成仍未决 intent。晨间验收绑定 `morning:<date>`，手动作业绑定自己的 exact command，均不以任意最新版本替代。

## 验证证据

所有以下测试使用本地隔离目录和 mock HTTP，没有真实 SHEIN 库存写入。

| 范围 | 证据与结果 |
| --- | --- |
| 新封存批次 | `tmp/v6-main-sealed-final-20260905-192600/opposite-index-final.log`：正式 runner 6506ms 通过；测试包含 25 项检查、库存 POST 为 0、真实执行器和 publication ticket，以及不同索引共享 journal 的并发发布 |
| E3/E4 既有入口及版本回归 | 同目录 `test.log`：E3/E4、封存批次、日运营 validator 三文件通过 |
| 告警与跨日兼容 | `tmp/v6-main-warning-validator-20260905-190350/`：owner-resume、日运营 validator、targeted-detail guard、cross-day 四文件通过 |
| 跨 journal 与既有恢复 | `tmp/v6-main-inventory-regressions-20260905-190056/`：owner-resume、E3/E4、cross-journal、cross-day 四文件通过 |

新封存测试同时验证错误命令、源路径、旧目标、缺失原始字段、仓库漂移、伪造 writes、缺失 result journal、篡改跨 journal 源 hash，以及把已关闭 intent 塞回 unresolved 列表均被拒绝。旧四件套和依赖快照逐字节比较；同命令重复发布仍解析为原版本。

## 发布边界

这些结果证明当前本地实现的上述行为，不替代云端部署验收，也不证明任何历史 SHEIN 请求已经成功。9 月 5 日既有库存与营销队列不重放；正式部署需完成同 SHA CI、发布证明、维护 CAS、inventory writer 兼容性轮转及终态现场回读。
