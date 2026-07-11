# 2026-07-10 全面审查与优化闭环

## 结论

本轮审查确认项目不是“整体不可维护”，但曾同时存在业务口径分散、超大入口文件、重复底层实现、前端大载荷、移动端不可用、缺少稳定回归门禁和生产权限过宽等问题。高风险项已经按“先备份、再改造、最后云端实证”的顺序收口；不会用重写系统或覆盖生产热修来制造表面整洁。

动工前完整工作区（含当时未提交内容）已备份到 GitHub `main`：

- `ada7a9a40ce700448041412ca23f2c8e87209f4e`：优化前完整备份。
- `947c604c8c1fb36ce648530f0b68f279a284d2af`：业务规则与确定性测试第一阶段。
- `e7927499cdb6345d31a1eafdebf68c738cbb79eb`：Portal 安全、载荷和运行时第二阶段。
- `11fc04f`：共享运行时边界、systemd 收紧与 BI 前端收口。
- `e18dafc`、`ec23a99`、`3f29f94`：权限脚本、跨平台生成器和私有 fixture 门禁修正。
- `759b7c2`：营销价格扫描 CLI 改为 fail-safe，`--help`、未知参数和错误分组不再误触发全店扫描。
- `9aab1e1`、`3d9047c`：补齐 GitHub Actions 确定性测试工作流，并升级到 `actions/checkout@v7` / `actions/setup-node@v6`。

## 已发现并处理

### 1. 逻辑与业务口径

- 商品别名/归并规则改为单一 schema 生成，修正 SQL 中易漂移的重复条件，并增加 `--check`。
- 营销日期只含日期时按业务自然日解释，避免 UTC/本地时区边界误判。
- OpenAPI 店铺身份 fallback 统一进入 `lib/shein_store_identity.mjs`；当 payload 同时出现冲突 merchantId 时必须拒绝，不能“找到一个期望值就通过”。
- 商品、订单、图片、链接维护、下架等执行器删除各自复制的 merchant fallback，统一测试同一安全规则。

### 2. “屎山”与重复实现

- `serve_bi_portal.mjs` 的 section cache、gzip、generation/stale 校验抽到 `lib/bi_section_cache.mjs`，模块可独立单测。
- 15 个浏览器/CDP 消费脚本统一使用 `lib/shein_browser.mjs` 的有界请求、事件订阅和关闭语义；历史抓取、登录恢复、session 导出、业务域探针、库存/库龄与 RTV 复核不再各自维护无超时的私有客户端。
- 仍然较大的 BI 门户和生成器保留渐进拆分策略：本轮先抽高风险且可独立验证的基础设施，不做一次性重写。

### 3. 性能与大载荷

- 首页和商品/流量数据拆成按需 section：`productSalesDaily`、`homeTrafficDaily`、`productTrafficDaily`。
- section cache 支持 raw JSON 与 gzip sidecar，校验源 `generatedAt`，拒绝跨代旧缓存。
- 商品矩阵首屏只渲染 40 组，按需继续加载；客户端 section 请求支持版本回退、刷新和 hash/history 路由。

### 4. 安全与可靠性

- Portal 增加 CSP/HSTS/X-Frame-Options/COOP、同源写请求校验、登录节流、Secure cookie、POST logout、WebSocket 鉴权和串行写队列。
- CDP 请求具有超时、容量上限和重试边界，避免单个浏览器连接无限挂起。
- Portal 与飞书问数 systemd unit 固化 umask、内核/控制组保护和资源上限；飞书问数从 root 迁移到 `sheinops`，并启用 `NoNewPrivileges` / `PrivateTmp`。
- `scripts/harden_cloud_runtime_permissions.sh` 用于移除生产 app 的 world-write；不递归改属主，不破坏 root/`sheinops` 混合调度。
- 所有生产 `flock` 锁统一迁入 `state/locks`，由 `scripts/lib/shared_lock.sh` 以目录 `2770`、文件 `0660`、组 `sheinops` 创建；删除复制粘贴的 `chmod 0666` 和可预测 `/tmp/*.lock`。

### 5. 前端与可访问性

- 1200px 以下改为顶部导航，390px 手机宽度下页面本体无横向溢出；长导航在自身区域滚动。
- 增加 skip link、可见焦点、语义 main/footer、ARIA 状态、键盘可达表格区域、Escape 关闭日期弹层并恢复焦点。
- 统一视觉层级，去除冲突的紫色光晕，保留单一陶土色强调；支持 reduced-motion 和高对比度偏好。

## 质量门禁

- `npm test`：generated schema、源码完整性和确定性回归总入口。
- `scripts/test_bi_ops_release_gate.mjs`：运营/OpenAPI 总门禁。
- 新增 section cache、前端可访问性、systemd 安全契约、共享 CDP、身份冲突等回归。
- UI 验收覆盖桌面、1200px、390px，以及 home/orders/products/traffic/ops/system 路由、键盘焦点和浏览器 console。

## 生产部署实证（2026-07-10）

- 生产目标文件在变更前已逐一备份到 `/opt/shein-bi/app/backups/codex-full-optimization-20260710-210751`，其中包含文件校验清单、原 systemd unit/drop-in、数据库函数和 Git 状态。
- 优化源码按文件安装至 `/opt/shein-bi/app`；生产工作树已有业务热修，因此刻意没有执行 `pull`、`reset --hard` 或全目录覆盖。
- `shein-bi-portal.service` 与 `shein-bi-lark-sales-qa.service` 均以 `sheinops:sheinops` 运行；Portal 健康检查、Lark WebSocket、systemd 安全属性和最近日志均已回读。
- 正式入口 `https://sa.dushengyi.cc/` 已验证登录跳转、安全响应头、桌面/1200px/390px 布局和六个主路由；浏览器 console 无新增错误。
- 云端再次执行 `npm test`：30/30 通过；`scripts/test_bi_ops_release_gate.mjs` 通过。两项 SK-5110 私有 handoff fixture 在云端不存在，按门禁设计明确标记为 skipped，而不是伪装为已执行。
- 云端 app 中普通文件和目录的 world-writable 数量从 45 收口为 0；定时任务也不会再把共享锁恢复成 `0666`。symlink、非锁文件属主和既有 group 权限不做破坏性重写。

## 外部状态与人工项闭环（2026-07-11）

- GitHub OAuth 已取得 `workflow` scope；`.github/workflows/ci.yml` 已提交并推送。GitHub Actions [run 29138830979](https://github.com/dushengyi1993/shein-sales-bi/actions/runs/29138830979) 完整通过，且升级 Actions runtime 后不再出现旧 Node runtime 注解。
- 云端 `sheinops` 已通过设备代码完成独立 Codex 登录，没有复制本机 `auth.json`。同一用户、`gpt-5.5`、`read-only` 边界下的真实 `codex exec` 返回 `AUTH_PROBE_OK`；Lark 问数服务重启后 WebSocket 已连接，未再出现 `refresh_token_reused` / `token_expired` / 401。
- 日更留下的 `marketing price scan failed` 历史状态没有删除或改写。当天后续 live guard 产出的更新扫描完整覆盖 19/19 店、`ok=true`、`partial=false`、622 行；watchdog 只在验证这份更新且新鲜的完整证据后，将该条“仅扫描失败”告警标记为 recovered，并在报告中保留 `recoveries` 与原 `dailyRefresh`。混合告警、过期扫描、缺店、重复店、失败店或行数不一致仍照常告警。

## 仍需长期治理的边界

- Portal 仍是高功能密度服务。后续只应按“鉴权与会话 / section API / 登录维护 / 链接运营”逐模块迁移，并保持接口契约测试；禁止无测试的大爆炸重写。
- Portal 当前需要执行受控 `sudo docker` 子命令并共享浏览器临时目录，因此不能启用 `NoNewPrivileges` / `PrivateTmp`。若未来把这些子任务拆成独立 worker，再收紧该边界。
- 生产仓库存在业务运行热修和生成物漂移。部署必须逐文件备份/复制，不得 `reset --hard`、`clean` 或 blanket rsync 覆盖云端。
- GitHub Actions 与本地 `npm test` 使用同一确定性命令；远端 CI 不能替代本地发布前门禁，反之亦然。

## 发布完成标准

1. 本地 `npm test`、release gate、`git diff --check` 全绿。
2. 云端每个目标文件先备份，再逐文件安装；不覆盖已识别的云端业务热修。
3. `systemd-analyze verify` 通过，Portal/Lark 服务 active，journal 无新增错误。
4. 线上安全头、gzip section、移动端布局、登录鉴权和主要页面实测通过。
5. 云端 app 无非 symlink 的 world-writable 项，Lark bot effective user 为 `sheinops`。
