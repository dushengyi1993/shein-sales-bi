# V6 B1/B3 实施记录

实现目录为 E:/Codex WorkSpace/.worktrees/Shein-BI-V6。本文记录本地代码与模拟验收，尚未发布部署，不代表生产业务已执行。

资源入口保留领域互斥和负载门禁，将 host/project 改为维护协调用共享锁。OpenAPI 不持有浏览器容量；browser 与 browser-read 共用既有两个容量槽。子进程不继承包装器锁描述符。Portal 沿用原服务和 timer，取消固定分钟准入，使用最多 1800 秒预算和显式 epoch deadline；资源冲突由现有服务失败重启继续队列。Mendel 独占更新两份旧调度回归测试，尚待主任务验收。

人工特价默认存放 Linux /srv/shein-bi/runtime 或 Windows ~/.shein-bi/runtime，可由 SHEIN_BI_RUNTIME_ROOT / SHEIN_BI_MANUAL_LIMITED_DISCOUNT_REGISTRY 指定。锁在登记表旁边，持票据锁更新，同目录原子替换，rename 失败直接失败，不再原地覆盖。migrate 命令仅在目标不存在时保存种子原始字节；目标已存在则校验并保留，禁止发布时覆盖现存业务值。现有云端 56 条登记未改写。

统一解析入口位于 lib/cloud_runtime_path_policy.mjs。生产源码根 /opt/shein-bi/app 的 outputs/state 分别定位 /data/shein-bi/outputs/state；显式导入布局支持 SHEIN_BI_OUTPUTS_ROOT、SHEIN_BI_STATE_ROOT。正式价格基线的 ../../../srv/shein-bi/runtime/marketing-plans/ 引用保持逻辑原文，通过 SHEIN_BI_MARKETING_PLAN_ROOT 解析导入物理位置。服务视图与规范位置若同时存在却字节不同，报告 namespace conflict；规范位置缺失不会改读一个旧副本并宣称成功。

现有 manage_marketing_repair_queue.mjs 增加 inspect-artifacts / export-artifacts / import-artifacts，复用原 queue、guard、阶段计划、rescue、价格文件和营销扫描引用。输出只给逻辑路径、大小、SHA-256；导出保留各文件原始字节及 queue fingerprint，引用缺失或 hash 不符直接停止。身份凭据及仅作来源注释的 stores config 不导出。导入在新目录保存独立证据，拒绝覆盖已有目录，更不覆盖活跃队列。resolve_cloud_runtime_artifact.mjs 是受管 shell 读取同一解析器的入口，cloud worker 接线由 Laplace 完成。

已由主任务实际运行通过：test_host_v6_resource_concurrency、test_manual_discount_runtime、test_marketing_runtime_artifacts、test_cloud_runtime_path_policy、smoke_marketing_repair_manifest、smoke_marketing_repair_queue、test_marketing_repair_queue_cas、smoke_manual_limited_discount_protection。旧 manifest 跨平台 fixture 原来依赖本机私有文件并假设目录深度，已改为两份独立临时文件，仍验证同逻辑指纹与不同物理位置。

补充 Profile 验证：原两个 Node launcher 在确认是否已有 Chrome 前会写 Local State；现改为复用 cross_process_ticket_lock 的物理 Profile 启动锁，核对进程的 Profile 与调试端口，已有 Chrome 只通过 CDP 开页。Python 兼容入口转至同一 Node launcher，禁止另一条无锁元数据写入路径。已有其他任务的有效店铺 lease 会拦住不属于它的调用；session-manager/link-business 传递明确 lease task/runId。后台 Windows 启动使用 Hidden，显式可见请求保持可见。test_chrome_profile_startup 使用两个真实独立 Node 进程证明一次启动/一次元数据写入/一次复用，并覆盖错端口、在用 Profile 的 CDP 失联、不同店与 lease 归属；test_local_browser_profile_cache_cleanup 也已通过。未启动真实 Chrome。

未完成：旧调度回归测试与其他并行修改的整体验证、cloud worker 实际接线、正式发布、生产只读回验及收尾。当前营销 queue fingerprint f6e69d47ef47b8c11692d0c2cbea2f15f3296040a04df734594bf4b10846ec01 和已成功 25 个 SKC 未重放。
