# 2026.08.06.4 本地后台浏览器与云端兜底排班

## 目标

营销浏览器重活优先使用负责人本机的后台 headless Chrome，避免长期占用半托/全托共用服务器；云端继续常驻完成每日只读检查、任务事实和最终复核，并在负责人电脑离线时提供有界应急兜底。

## 排班

- 云端每日营销检查：`11:00/13:00/16:00`，session HTTP，只读且不启动浏览器；当天首次成功后后两轮只重试失败。
- 本机营销执行：`11:10/13:10/16:10`；首轮主执行，后两轮只续跑未终态工作。逐店串行 headless，完成后立即关闭。
- 云端应急兜底：`20:45/21:15`；每段先做 19 店只读重扫，只处理本机尚未闭环的长期授权缺口，每段最多 1 店/1组，分别在 `20:57/21:27` 前收口，为全托 `21:02/21:32` 核心首页车道留出 5 分钟。
- 本地与云端 Profile/session 独立维护；任一侧登录恢复不得冒充另一侧已恢复。

## 本机磁盘治理

- `launch_store_browser.mjs` 将 Windows Chrome 磁盘缓存移出持久 Profile，统一放到 `%LOCALAPPDATA%/SheinBI/browser-cache/<profile>`，单 Profile 缓存上限 100MB。
- 禁用自动化不需要的 Chrome 本地 AI/Optimization Guide 模型下载。
- 新增 `cleanup_local_shein_browser_profile_cache.mjs`：默认 dry-run，只有 `--apply` 才删除；活动 Profile 必跳过。清理范围只包含模型、Crashpad、Cache/Code Cache/GPU Cache 等可丢弃数据，明确保护 Cookies、Login Data、Local/Session Storage 和 IndexedDB。
- 2026-08-06 首次安全清理回收 `46.51GB`，24 个 Profile 从约 `50.5GB` 降至约 `4.04GB`，错误 `0`，登录态保护目录未触碰。

## 安全边界

- 云端 fallback 开始写入前必须重建当日精确队列，避免重放本机已经完成的活动。
- 云端每窗最多 1 组；剩余硬截止预算不足 6 分钟时拒绝启动新事务。
- 未批准的新普通活动、优惠券、补预算和任何超出负责人长期授权的写入继续失败关闭。
- 无论本机还是云端，每店均须 dry-run、事务 journal、执行后定点回读和浏览器零残留。

## 验证

- `npm test`：`156/156` 通过。
- 本地缓存清理隔离测试：缓存/模型删除，4 类登录态文件全部保留。
- 云端 fallback wrapper 非法时段返回 `75`，不会启动浏览器。
- systemd 安全与共享主机排班合同测试通过。
