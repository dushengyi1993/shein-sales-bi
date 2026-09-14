# 迁移飞牛后的阈值重估（半托）

本文只处理 2026-09-14 交接清单第三节「阈值」和第四节的迁移契约，不重放历史业务，也不改 `config/stores.json` 的启用店铺集合。代码改动与测试见交接说明；**本文表格里的「实测依据」列必须在新机器上量出来再定值**，不能在没测量的情况下照抄或放宽。

现有数值全部是按旧云 2 vCPU / 约 7.5 GiB 定的。全托迁移经验给的半托目标规格是 **4 vCPU / 8 GiB / 独立 200 GiB 数据盘**，但要注意三点：

- 4 vCPU 是虚拟处理器数量，不等于独占 4 个物理核心；同一块机械盘的 I/O 竞争不会因为分了独立虚拟盘而消失。
- 分配 8 GiB 不等于宿主立刻回收；ZFS ARC 也不是随时可以占用的空闲内存。
- 迁移后重任务排班仍要跨系统错开，`/run` 文件锁分 VM 后彼此不可见，不能假设旧共机锁还在协调。

## 1. 要重估的阈值与改动位置

| 阈值 | 当前值 | 代码位置 | 迁移时可用的调整方式 | 需要的实测依据 |
|---|---|---|---|---|
| host-heavy 负载闸门（browser 类） | `maximumLoadPerCpu=0.75` | `scripts/check_host_resource_pressure.mjs` 的 `HOST_RESOURCE_PRESSURE_PROFILES.browser` | 环境变量 `SHEIN_BI_HOST_PRESSURE_BROWSER_MAXIMUM_LOAD_PER_CPU`（其余字段同理，`browser-secondary`/`openapi`/`materializer` 各自独立） | 新 VM 核数；核心数据线运行时与空闲时的 `load1`、CPU busy ratio、`MemAvailable`、PSI full avg10 |
| host-heavy 负载闸门（其余类） | `browser-secondary 0.65`、`openapi 0.85`、`materializer 0.75` | 同上 | 同名规则，类名 token 为大写下划线，如 `SHEIN_BI_HOST_PRESSURE_OPENAPI_MAXIMUM_LOAD_PER_CPU` | 同上，按类分别采样 |
| 负载高但 CPU 实际空闲的豁免 | `maximumCpuBusyRatioWhenLoadHigh=0.5` | 同上（`shortCpuIdleOverride`） | 同上，`..._MAXIMUM_CPU_BUSY_RATIO_WHEN_LOAD_HIGH`（0–1） | CPU busy ratio 与 load1 的关系采样；这正是「按核心数据线是否在跑」判定的落点 |
| 其余压力项 | 内存 `minimumAvailableMemoryMiB`、PSI `maximumMemoryFullAvg10`/`maximumIoFullAvg10`、`minimumUptimeSeconds` | 同上 | 同名规则 | 开机后稳定期的内存与 PSI 采样；机械盘共享下的 I/O 等待 |
| 写入闸门分钟窗 | 每小时 `:23–:42` 拒绝 batch 写入 | `infra/bin/shein-bi-node` | 改常量需代码评审；先确认 `:32–:43` 核心数据线在新排班下是否仍是这个区间 | 新机器上核心数据线的实际起止时间 |
| 写入并发上限 | `--max-groups`/`--max-items` 必须恰好为 1 | 同上 | 同上；放宽是独立决策，不随迁移自动放宽 | 单组实际耗时、每窗口可用时间、I/O 延迟 |
| 单日执行窗口 | 计划内仅 `20:45 后 / 21:15 后 / 22 点`，graceful cutoff `22:55`，outer hard `23:10` | `scripts/run_cloud_marketing_fallback_slot.sh` | 改常量需评审 | 新机器上一轮的实测耗时分布 |
| repair timer 时点 | `11..20:45` 加 `21:15` | `infra/systemd/shein-bi-cloud-marketing-repair.timer` | 改 `OnCalendar` 需评审 | 同上；注意 `21:45` 之后当天已无槽位 |

任何覆盖值都会在 `check_host_resource_pressure.mjs` 的输出里以 `thresholdOverrides` + `defaultProfile` 回显，发布回读必须带上这段，否则等于放宽了却看不见。非法值（非数字、≤0、比率 >1）直接 fail closed。

## 2. 测量协议（每项都要有样本，不接受推断）

1. 记下 `nproc`、`MemTotal`、`MemAvailable`、数据盘设备与文件系统。
2. 在三个状态下各采一段（建议 ≥10 分钟，含峰值）：空闲、核心数据线运行中（昨日最终核对/物化）、单个营销 repair 组执行中。
3. 每次采样同时记录 `load1`、CPU busy ratio（`/proc/stat` 差值）、`MemAvailable`、`/proc/pressure/memory` 与 `/proc/pressure/io` 的 full avg10。
4. 用「核心数据线运行时」的上沿作为闸门基线，而不是用绝对 load；空闲时的高 load 交给 `shortCpuIdleOverride`。
5. 用 `node scripts/check_host_resource_pressure.mjs --class=browser` 在生产前 dry-run，确认输出里的 `thresholdOverrides` 与实测值一致。

## 3. 从全托迁移直接照搬的教训

- **验门禁，不看 enabled**：`ConditionPathExists` 这类启动门禁必须回读生效值（`systemctl show -p ConditionPathExists`）。候选环境的 timer/worker 默认不得消费真实任务。
- **drop-in 不能靠空赋值复位**：用空的 `Requires=`/`After=` 覆盖旧依赖没有达到预期；本次是改完整 unit 并回读有效依赖。
- **单执行方**：同一个队列/写入源只能有一个执行者。本地执行入口只在显式授权且当天有队列时才动，禁止和云端 timer 并行消费同一队列。
- **文件改了进程没变**：常驻进程不自动重读 env，必要时受控重启并回读实际进程环境与实际业务结果。
- **开机时间**：全托出现过 RTC/来宾时间差 8 小时导致排班错位；迁移后每次开机都要核对 `NextElapse`，不能认为上次的排班修复已永久生效。
- **健康检查不等于业务成功**：`200`/`401` 只能证明可达，要分别验认证、持久化、消费、调度和页面。
- **不照抄全托实例**：端口、unit 名、secrets、数据库、隧道、白名单主体都必须按半托重新盘点；`shein-fm` 前缀属全托专属。
