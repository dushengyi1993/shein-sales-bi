# 飞牛(fnOS) VM 迁移加固共用清单 —— 半托实战复盘，供全托自查

> 背景：半托这台 VM 是从全托模板克隆出来的，所以下面每一条**大概率全托也存在**。半托在 2026-09-15 的迁移当天逐条查出并修掉了 18 处缺口，另在迁移后发现 3 处新问题，都记在这里供全托对照自查。
>
> 用法：先跑第 1 节的五分钟自检，命中哪条跳到对应小节。所有命令都是只读的，最后一条 `systemctl --failed` 为空才算干净。

## 1. 五分钟自检

```bash
# 1. 开机时钟有没有跳（最关键）
sudo journalctl -b -k | grep 'setting system clock'
date -Is; cat /sys/class/rtc/rtc0/since_epoch; date +%s   # 后两个数字应当接近
timedatectl show -p LocalRTC -p Timezone -p NTPSynchronized
cat /etc/adjtime 2>/dev/null; cat /etc/timezone

# 2. persistent timer 的「上次触发」有没有停在错误的未来
systemctl show <你的每日timer>.timer -p LastTriggerUSec -p NextElapseUSecRealtime
ls -l /var/lib/systemd/timers/

# 3. 协调文件与容量
ls -l /run/lock/

# 4. 资源压力阈值是不是旧机器时代的值
sudo journalctl -b | grep -o 'thresholdOverrides"[^}]*}' | tail -1

# 5. 启动后整体状态
systemctl --failed; systemctl list-timers --all | head -30; uptime; free -m

# 6. 中文渲染（云端登录窗口/noVNC 用）
fc-list :lang=zh | wc -l        # 0 就是有问题

# 7. 时区与 hosts 有没有被 cloud-init 重写
sudo ls /etc/cloud/cloud.cfg.d/; grep -c openapi /etc/hosts
```

## 2. 逐项：症状 / 根因 / 取证 / 修复 / 复核

### A. 时钟与时区（最隐蔽，会静默吞掉整晚的班次）

**A1. RTC 解释与 `/etc/adjtime` 不一致，开机跳 8 小时**

- 症状：开机瞬间系统时间比真实时间快 8 小时（或慢 8 小时），NTP 在十几秒后纠正；这十几秒内触发的 `Persistent=true` timer 会把「上次触发」写成那个错误时间。
- 根因：hypervisor 给 guest 的 RTC 内容与 guest 的 `/etc/adjtime` 模式不一致。半托实例：RTC 内容是本地时间，guest 按 UTC 读，于是 23:09（本地）被读成 23:09 UTC，等于第二天 07:09 CST。
- 取证：`sudo journalctl -b -k | grep 'setting system clock'` → `setting system clock to 2026-09-15T23:09:06 UTC`（而当时是 23:09 CST）。
- 真后果（不是只有显示难看）：`shein-bi-db-backup.timer` 每晚 `01:45/02:05/02:25` 三次机会，`LastTriggerUSec` 被写成 `2026-09-16 07:09:10`，晚于三个时点，`NextElapseUSecRealtime` 直接被推到 **9/17 01:45** —— 当晚一次备份都不会跑，NAS 的 `OnSuccess` 同步跟着不触发。其余 timer 因为频率更密、或下一次合法时点仍在当天，所以没被跳掉。
- 修复（两步都要做）：
  ```bash
  # 1) 让 RTC 模式由 RTC 内容推导，而不是硬编码 LOCAL/UTC
  #    delta = cat /sys/class/rtc/rtc0/since_epoch - date +%s
  #    |delta| <= 5min → timedatectl set-local-rtc 0（RTC 就是 UTC）
  #    否则            → timedatectl set-local-rtc 1（RTC 是本地时间）
  # 2) 已经被写坏的 stamp 手工纠正（改 mtime 即可，不要重启 timer 触发补跑）
  sudo touch -d '<该 timer 最后一次真实成功的时间>' /var/lib/systemd/timers/stamp-<unit>.timer
  sudo systemctl restart <unit>.timer
  systemctl show <unit>.timer -p LastTriggerUSec -p NextElapseUSecRealtime   # 复核
  ```
- 根治：加一个开机 oneshot（半托叫 `shein-bi-clock-sanity.service`），`Before=timers.target`，在里面 (a) 按上面推导并对齐 RTC 模式，(b) 钉住时区，(c) 有界等待 NTP 同步，(d) 防御性重写「停在未来超过 1 小时」的 persistent timer stamp。这样换机、换 hypervisor 设置都不会再让 schedule 用错时钟。

**A2. cloud-init 每次开机会重写时区**

- 症状：`/etc/localtime` 已经是目标时区，但 `/etc/timezone` 仍是 `Etc/UTC`（半托迁完就是这个状态）。
- 根因：`/etc/cloud/cloud.cfg` 的模块列表里有 `timezone`，每次开机按 datasource 重新应用；没有显式配置时回落到镜像默认值。
- 修复：`/etc/cloud/cloud.cfg.d/99-<project>-time.cfg` 写 `timezone: Asia/Shanghai`；再放一个开机断言（见 A1 的 oneshot）。
- 复核：`timedatectl show -p Timezone`、`cat /etc/timezone`，重启后仍然一致。

**A3. cloud-init 重写 `/etc/hosts`，隧道映射丢失**

- 症状：OpenAPI 走了本地出口，被平台拒（出口 IP 不在白名单）。
- 根因：接入隧道需要的 hosts 映射（例如 `openapi.sheincorp.com → 127.0.0.1`）被 cloud-init 重置。
- 修复：用 cloud-init `bootcmd` 加模板双写，别只写一次 `/etc/hosts`。
- 复核：`grep -c openapi /etc/hosts` 重启后仍大于 0。

**A4. NTP 指向 IPv6-only 默认池，而 guest 关了 IPv6**

- 症状：`timedatectl show-timesync -p ServerAddress` 是 IPv6 地址；同步慢或失败。
- 修复：`/etc/systemd/timesyncd.conf.d/` 里指定可达的 IPv4 服务器（半托用 `ntp.aliyun.com cn.pool.ntp.org ntp.tencent.com`）。

### B. 协调文件与并发容量

**B1. `/run/lock` 协调文件缺失，重任务全部 73/75 defer**

- 根因：这些文件原本由「共享主机」的 tmpfiles 提供；迁到独立 VM 后没有任何东西负责（半托旧云是同机双项目、tmpfiles 归全托维护，独立 VM 后这份责任必须自己接）。
- 症状：`defer ... reason=browser_slot_invalid` / `neutral_lock_invalid` / `browser_slots_busy`。
- 修复：`/etc/tmpfiles.d/<project>-scheduler.conf` 列出 host/project/domain/browser lane 等文件，`systemd-tmpfiles --create` 立即建出来，重启由 `systemd-tmpfiles-setup` 自动重建。
- 复核：`ls -l /run/lock/`，重启后再看一次。

**B2. 并发容量被写死，机器变快也用不上**

- 症状：CPU/内存都空闲，任务却串行、一个活跑很久，甚至要分好几次才跑完。
- 根因：容量参数是按旧机器硬编码或调小的（半托：浏览器 lane 写死 2 个；OpenAPI 财务/对账/营销价格会话被压到 3；link business 浏览器并发被压到 1）。
- 修复：把容量做成可配置（半托把 lane 数改成 `SHEIN_BROWSER_READ_SLOTS`，默认 2，本机设 4），本机档位统一放 systemd drop-in，tracked unit 保留可移植默认。
- 注意：**并发不能超过真实 lane 数**。半托实测每个店铺 worker 只占一个 lane，抢不到就 exit 75 并按 30 秒重试 12 次；所以并发从 2 提到 4 而 lane 只有 2 时并不会更快，只是让多出来的 worker 空转等待。

### C. 资源压力阈值是给旧机器编译的

- 症状：机器明明很健康，任务却 `defer ... reason=resource_pressure`。
- 根因：阈值（最短 uptime、最低可用内存、最大 load/CPU、`ioFullAvg10`）在旧机上调过并写进了代码默认值。半托实例：`ioFullAvg10=5.89` 被判失败，而默认上限是 5。
- 取证：日志里的 `thresholdOverrides` 与 `defaultProfile` 差异，加上 `uptimeSeconds`、`availableMemoryMiB`、`normalizedLoad`。
- 修复：优先用 systemd manager 级 `DefaultEnvironment=` 覆盖这些阈值（半托有 24 个变量），保持 fail-closed 检查本身不动，并保留 `thresholdOverrides` 打印做审计。

### D. 运行时依赖与权限

- **D1 挂载**：旧云上 `/data/...` 之类的路径要改成真实 bind mount 并写进 `/etc/fstab`，否则重启或 cloud-init 重置后目录消失、权限错。
- **D2 语言运行时**：ET/OCR 这类 venv 必须在新机重装（哈希锁定的 wheel）。半托实例：`ET runtime is not installed` 让 22:20 的班次真实失败。
- **D3 sudoers**：服务账号需要的 NOPASSWD 条目要补（半托是 `/etc/sudoers.d/90-sheinops-codex`，portal 的 `sudo psql` 依赖它）。
- **D4 目录权限**：活跃状态目录如果是 `root:root 755`，要改成服务账号的 `2770`。
- **D5 日志目录**：缺失会让浏览器启动器 EACCES。
- **D6 家目录**：GitHub 部署私钥、`.gitconfig`（`safe.directory`）、hooks、CLI 配置目录都要一起搬；半托实例：`secrets/` 里那把部署密钥 GitHub 并不认，真正生效的是家目录那把。
- **D7 控制面状态**：`/var/lib/<control>/` 下的维护模式标记与兼容性记录（半托是 `cloud-maintenance.json`、`inventory-writer-compatibility/`），缺了会让业务写入 fail-closed。
- **D8 发布权威证据**：`deployed_release.json`、`release-attestations/<tag>/` 没搬会让守卫断言失败（半托从 `INVENTORY_WRITER_RELEASE_RECEIPT_INVALID` 一路修到 `[OK]`）。
- **D9 证据类输出窗口**：按店按日的归档如果只按「近 24 小时」打包，会裁掉当天真正需要的业务日期；迁移时要按目录逐个核对，不要整包通配。

### E. 备份

- 症状：备份根目录和数据盘在同一块物理盘上，盘坏了就只剩没有备份。
- 修复：加异机（NAS）副本：接收端要有**有界保留**（半托保留最新 14 份）和「不删未校验或外来目录」的保护；发送端用 `OnSuccess` 触发并做双向 sha256 校验。
- 复核：真实归档同步后两端 sha 一致；保留策略先用合成样本演练，确认没误删真实备份。

### F. 人机界面（云端登录窗口）

- **F1 中文字体**：新 VM 默认没有 CJK 字体（半托 `fc-list :lang=zh | wc -l` 为 0，旧云是 31），noVNC 里的 Chrome 把中文渲染成乱码或方块，看起来像网页坏了。修复：`apt-get install -y fonts-noto-cjk`，然后**重开**登录窗口（Chrome 启动时才加载字体）。
- **F2 profile 登录态**：把会话元数据文件一起搬过去即可；用一次 headless Chrome 起对应 profile、核对店铺身份就能证明登录态可用，不必让同事把每个店手动重登一遍。只有平台明确报失效的店才单独补登录。

### G. 访问路径与网络

- **G1 局域网直连**：VM 直接挂在办公网时，最省事的是给反代的 server 块并列加一个监听（例如 `listen 192.168.1.200:80;`），而不是改应用绑定。半托实测同一个页面：局域网 **2.2 ms**，走公网域名加隧道 **3.24 s**。
- **G2 隧道与回调**：确认隧道服务开机自启（`systemctl is-enabled`）、出口 IP 与平台白名单一致、回调端口在安全组放行；改完从公网侧真实打一次回读，别只看本机 curl。

### H. 迁移日当天的流程纪律

1. 改之前先**对比源与目标的哈希**（systemd 单元和配置逐文件），把差异当待确认项，不要凭印象认为一致。
2. 迁移后**必须重启一次**做端到端验收：时钟、timer 重挂、`systemctl --failed` 为空、隧道与反代可用。半托就是这样才发现时钟跳变和 timer stamp 被写坏。
3. 每改一处**立刻读回**；没把握的明说未验证，不要用「应该可以」交付。
4. 凭据与会话类文件只比对字节和哈希，不要打印内容。半托这次把一份会话文件和一份发布 token 打印进了对话，只能把对应登录态当已暴露处理。
5. 迁移后要单独复核巡检任务的绑定：自动化脚本或定时器如果跟着工作树、profile 一起被重建，用户侧会表现成「我的巡检不见了」。

## 3. 半托当天的实际结果（可作对照基线）

- 迁移后 `systemctl --failed` 有 3 个失败，修复后为 **0 个**；重启后内核读到 `2026-09-15T15:35:30 UTC`（即北京时间 23:35:30），不再跳 8 小时。
- `shein-bi-db-backup.timer` 的 `LastTriggerUSec` 从错误的 `2026-09-16 07:09:10` 修正为 `2026-09-15 21:43:00`，`NextElapseUSecRealtime` 回到 `2026-09-16 01:45:00`。
- `shein-bi-cloud-et-forwarder.service`（曾因 ET runtime 未安装真实失败）改后实跑 `status=0`，运行时校验 `lock_sha=60da40cb...` 与锁一致，ET HTTP 会话 `cookieCount=4`、probe `ok`。
- 浏览器 lane 从写死的 2 个改成可配置，本机设 4；压力阈值按 6 vCPU 重设；OpenAPI 与营销并发 3 到 6。
- 局域网 `http://<VM_IP>/` 与公网同一页面：2.2 ms 对 3.24 s。

## 4. 迁移后第 2 批发现（半托 2026-09-16 凌晨补充）

**4.1 外部 guard 二进制没跟着搬 → 库存写入类服务全部 203/EXEC**

- 症状：`ExecStartPre` 报 `status=203/EXEC`，三个库存写入服务（日更补货守卫、ET 低库存守卫、ET 低库存复检）全部起不来。因为是 fail-closed，业务表现是「不补货」，不会报数据错误。
- 根因：`/usr/local/libexec/<guard>` 是**部署时安装**的外部文件，不在 tracked source 里；迁移只搬了 systemd 的 drop-in，没搬二进制。
- 自查：`ls -l /usr/local/libexec/`；老云上应有一个 43 KB 左右的 guard（半托是 `shein-bi-inventory-writer-compatibility-guard`）。
- 修复：用仓库自己的安装器 `scripts/install_inventory_writer_compatibility_guard.sh`，先跑一次默认 audit 拿 `manifest=<hash>`，再用 `--replace --expected-installed-manifest-sha256 <hash> --confirm REPLACE_INVENTORY_WRITER_COMPATIBILITY_GUARD_V1`。装完对每个服务单独跑一次 guard（带 `--unit <service>` 和 activation/compatibility 文件参数）必须返回 ok=true。

**4.2 app 根与 tracked 树的权限漂移（解包 umask 不对）**

- 症状：guard 报 `INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT`，按顺序会点出 `app root must be root-owned 0750-compatible` → `runtime allowlist root:tmp` → `mutable tracked source:<file>`。
- 根因：迁移解包时用了普通用户 umask 002，展开出 `app` 根 `<user>:<user> 0755`、tracked 文件 664/775（group-writable）。半托实测 1220 个文件受影响。
- 期望（以老云为基准逐条比对）：app 根 `root:sheinops 0750`；tracked 文件 `root` 属主且 group/other 不可写（多为 0640/0644）；tracked 文件的父目录 `root:sheinops 0750`；运行态可写根只有 `state/tmp/outputs/profiles/node_modules`，其中 managed 的（半托是 `tmp/outputs/node_modules`）必须 `root:sheinops 1770`（sticky）。
- 修复：按 tracked 清单逐条对齐，不要 `chmod -R` 一把梭，也别改 `state/tmp/outputs/profiles/node_modules` 自身。注意数据侧与 app 侧要分别对齐（半托数据侧 `outputs` 是 `sheinops:sheinops 0775`，app 侧是 `root:sheinops 1770`）。

**4.3 新增 systemd 单元要同时登记四处，否则维护窗口根本开不起来**

- 症状：`manage_cloud_maintenance_mode.mjs pause` 返回 64 `repository service policy contract is invalid`（`SERVICE_POLICY_NOT_UNIQUE` / `RUNTIME_PATH_POLICY_MISSING`）。这会直接堵死部署轮转，因为轮转必须在 `maintenance=all` 下跑。
- 必须同步的位置：`lib/cloud_runtime_inventory.mjs` 的 `CLOUD_MAINTENANCE_POLICY_ROWS`、`lib/cloud_runtime_path_policy.mjs` 的 `CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE`，以及各契约测试里硬编码的服务数/安装数（半托这次动了 4 个测试文件里的 28→30、23→24、47→49 等）。
- 教训：加一个 unit 不是只放 `.service` 文件，等于同时声明维护策略、运行时路径策略和清单计数。维护策略的类要选对：开机自愈类用 `always`（不装守卫），跟随备份的拷贝类用 `infrastructure`。

**4.4 源码轮转必须 `maintenance=all`，所以要避开夜间任务**

- `lib/inventory_write_cutover.mjs` 明确要求 `maintenanceMode === 'all'`；该模式下被暂停的服务**不是延后执行，而是当天取消**（ExecCondition 不满足即不启动，timer 推到下一个时点）。
- 半托夜间窗口：`00:45` 登录态维护（deadline 01:27）、`01:45/02:05/02:25` 数据库备份（deadline 02:37）、`02:45/03:05/03:20` 昨日定稿（deadline 03:27）。因此部署窗口应选 **03:30 之后到 06:50（订单闭环）之前**，或晨链跑完之后。

**4.5 主机上的「非 dpkg」依赖最容易漏：lark-cli 与外部 guard**

- 症状：watchdog 日志里 `"notified": false, "notifyCode": 1`（这是**投递失败**，不是业务告警本身）；每日 Lark 报表同理。
- 根因：告警投递走 `scripts/notify_sync_issue.mjs` → 全局 npm 包 `@larksuite/cli`（老云 `/usr/bin/lark-cli` → `/usr/lib/node_modules/@larksuite/cli/scripts/run.js`）+ `/root/.lark-cli/config.json`（241 B、0600 root）。这两样都不在 dpkg 里，整包对比看不出来；同类还有 `/usr/local/libexec/` 下的外部 guard。
- 自查：`npm ls -g --depth=0`、`ls -l /usr/local/libexec/`、`ls -l /usr/bin/lark-cli`、`ls -l /root/.lark-cli/`。
- 修复：`sudo npm install -g @larksuite/cli@<老云版本>`（半托是 1.0.80），再把老云的 `/root/.lark-cli/config.json` 搬过来（只搬不打印）；验证用 `lark-cli im +messages-send --as <identity> --chat-id <id> --text x --dry-run`：dry-run 只校验请求、不发消息，rc=0 且返回 `/open-apis/im/v1/messages` 即链路通。
- 教训：迁移后要做三类清单对比——① `dpkg --get-selections`；② `npm ls -g --depth=0`；③ `/usr/local/libexec/` 与 `/usr/bin` 下的符号链接。半托实测 dpkg 差 261 个包但几乎全是历史包袱，真正影响运行的恰恰是第②③类。
**4.5 补充（2026-09-16）：第④类——apt 装、但只被脚本 import 的 Python 模块。** 半托当天营销巡检首跑失败（报告绑定报 `marketingCostMapSource.sha256 ... missing`、`guardStatus=66`、当天报告没发布），根因是 `scripts/marketing/build_marketing_cost_map.py` 崩在 `from openpyxl import load_workbook`；老云有 `python3-openpyxl 3.1.2+dfsg-6` + `python3-et-xmlfile 1.0.1-2.1`，这两个包就在那 261 个「历史包袱」差集里，看包名看不出危害。核对法：把仓库所有 `*.py` 的顶层 import 收一遍，在目标机逐个 `python3 -c import <mod>` 试，而不是只比 `dpkg` 包名差。另一个连带教训是「命名空间」：在服务 bind mount 之外手动跑同一个脚本会读到空的 `outputs/`，得到看似成功但内容缺失的产物（半托这次先得到 25 KB / `trueCostCount=0` 的错误成本图，在正确的服务环境里重建后是 403,828 字节 / `trueCostCount=263`）。要么用 `systemd-run` 带上同款挂载，要么直接重跑那个 unit。

**4.6 飞书告警投递：三层依赖，最容易漏的是密钥库**

- 症状：watchdog 日志 `"notified": false, "notifyCode": 1`；`state/cloud_ops_watchdog/alert-state.json` 里 dispatch 一直是 `pending`、`attemptCount` 递增。
- 三层依赖（半托实测，缺任何一层都失败）：① 全局 npm 包 `@larksuite/cli`（`/usr/bin/lark-cli`）；② `~/.lark-cli/config.json`（appId/brand/lang/users，**不含明文 secret**）；③ **`~/.local/share/lark-cli/` 里的 `appsecret_<appid>.enc` + `master.key`（0600）** ← 真正的密钥库，最容易漏，dpkg 和 `npm ls -g` 都看不到。
- 定位方法：把 `HOME` 指到一个只放 `~/.lark-cli` 的临时目录，跑同一个只读探针 `lark-cli api GET /open-apis/im/v1/chats`。半托实测：临时 HOME 里失败、`HOME=/root` 成功 → 说明生效凭据在 HOME 的其他位置（就是 `.local/share/lark-cli`）。
- 验证（只读、不发消息）：上面那个探针返回 `ok:true` 且能列出目标群。
- 投递验证：用 watchdog 自己的 `scripts/notify_sync_issue.mjs --kind cloud-watchdog --mode watchdog --message '<原文>' --force --idempotency-key <dispatch key>`；成功后必须用 `lib/cloud_watchdog_alert_state.mjs` 的 `markWatchdogDispatchSent` / `markWatchdogOutboxSent` 把状态标 `sent`，否则下一轮 watchdog 会再发一条重复告警。

**4.7 家目录隐藏状态要按「路径集合」对照，别只看显眼目录**

- 半托实测：迁移时搬了 `.lark-cli`、`.gitconfig`、`.local` 这些「显眼」项，仍然漏了：
  - `/root/.local/share/lark-cli/`（密钥库，见 4.6——漏了它告警投递全断）；
  - `/root/.gitconfig`（`[safe] directory = /opt/shein-bi/app`，root 跑 git 时需要）与 `/root/.npmrc`（registry 指向）；
  - `/home/sheinops/.agents/`（Codex 插件市场状态）与 `/home/sheinops/.codex/{agent-packs,agents}`（约 3.7 MB；`enabled-agent-packs.txt` 里启用了 engineering/design/testing，缺 packs 就出现「已启用但不存在」）。
- 方法：两台机分别跑
  `find /root /home/<service-user> -maxdepth 3 \( -name .cache -o -name .npm -o -name node_modules -o -name tmp -o -name logs -o -name .git \) -prune -o -printf '%p\n' | sort`
  然后**只比较路径集合**（不比大小，避免日志/缓存噪声），过滤掉 `.bak*/backups/cache/skills/bun/docker` 等噪声，剩下的就是真正要搬的。
- 判断标准：服务运行需要的是「状态 / 凭据 / 配置」；其它 agent CLI 的 skills 目录（`~/.config/<agent>/skills`、`~/.rovodev/skills` 等）与本项目运行无关，可以不管。

**4.8 部署交接：三个会让你以为「迁移坏了」的坑**

- **只 chown 目录行不够**：`git fetch` 要写已存在的 `.git/FETCH_HEAD`（root 属主），目录可写无效 → `error: cannot open '.git/FETCH_HEAD': Permission denied`。交接清单（`*plan.json` 的 `managedSourcePaths`）里的**文件也要一起临时 chown**，检出后再由加固器统一收回 root。
- **不要给 git 传 `GIT_SSH_COMMAND`**：部署密钥是在仓库 `core.sshCommand` 里声明的（形如 `ssh -i ~/.ssh/<deploy_key> -o IdentitiesOnly=yes`）；用环境变量覆盖会把它整体顶掉，报 `git@github.com: Permission denied (publickey)`。以服务用户跑 git 时保持环境干净即可。
- **轮转预检工件是 no-replace**：同一路径重复 dry-run 报 `EEXIST`；重跑换文件名，不要删旧工件（activation/compatibility/receipt 文件更是禁止手删改）。
- 附带一条发布侧的：`gh release view <version>` 查不到不代表没发布——远端 release 的 tag_name 是 `untagged-<hex>`，用 `gh release list` 按标题找。

**4.9 宿主机的「网页密码」不等于 Linux 密码**

- 飞牛（fnOS）账号密码只在网页后台生效。Linux 侧 `sshd`、`sudo` 都走 `common-auth`（`pam_unix.so nullok` + `pam_winbind.so … try_first_pass`），实测该口令被拒：`ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no <user>@<host>` → `Permission denied (publickey,password)`，`sudo` 报 `no password was provided` / `incorrect password attempt`。`root` 同样不可用口令登录。
- 影响：想「不走浏览器直接改宿主机」（例如开虚拟机的开机自启动、改宿主机网络/存储）就必须二选一——① 在网页后台给账号设一个 Linux 密码；② 加一条免密 sudoers。否则宿主机层只能由用户在网页后台操作。VM 内部的运维不受影响（VM 的 `dushengyi` 免密 sudo 正常）。

**4.10 cgroup 软上限低于真实工作集，会「毒化」全机的压力信号**

- 症状：所有走资源闸门的浏览器/重任务集体以 `MEMORY_STALL_PRESSURE` 让位，但机器其实很闲——`MemAvailable` 5.7–6.9 GiB、无 swap、CPU idle 90%、`vmstat` 无 `si/so`。
- 机制：`scripts/check_host_resource_pressure.mjs` 读的是 `/proc/pressure/memory` 的 `full avg10`（半托实测：在叶子 cgroup 里读与在 root 读**完全同值**，即全局量）。任何 cgroup 超过自己的 `MemoryHigh`，内核就会持续回收它，这份 stall 立刻变成全机 PSI，于是**所有**闸门任务一起让位。
- 半托踩了两处，都是「按主进程估的软上限，没算 cgroup 里的子进程」：
  1. `shein-bi-portal.service` 的 cgroup 还装着 `generate_bi_portal.mjs --section ...` 的子进程（只受 `NODE_OPTIONS=--max-old-space-size=1536` 约束，RSS 可到约 1.8 GiB）。`MemoryHigh=1200M` 下那个 profit 生成进程卡死 14 分钟、`memory.events.high` 66 万次、PSI 常年 90；抬到 `1900M/2600M` 后 **12 秒**退出、cgroup 1380→227 MiB、PSI 94→0.20。
  2. 晨链自己：4 条 lane 的工作集实测 **3.3–4.1 GiB**（5 店探针峰值 3,470,336,000 B；真实链路 `memory.peak` 4,075 MiB），旧 `2600M/3400M` 同样自锁。抬到 `4600M/5600M`。
- 自查：`systemctl show <unit> -p MemoryHigh -p MemoryPeak`，再看 `/sys/fs/cgroup/.../<unit>/memory.events` 的 `high` 计数（持续增长 = 长期在软上限之上被回收）。
- 口径：软上限要高于「该 cgroup 内所有进程（含子进程/worker）」的最坏工作集，而不是只按主进程估；硬上限留出足够带宽，让节流（而不是 OOM）成为第一反应。

**4.11 共享日志目录的属主要钉在服务账号上**

- 症状：某个阶段静默失败，日志里只有一行 `.../<name>-<stamp>.log: Permission denied`。
- 机制：同一个日志目录被不同用户的调用者共用（半托是 `User=root` 的 ET forwarder 与 sheinops 的晨链共用 `/srv/shein-bi/logs/cloud-portal-prewarm`）。谁先跑谁建目录；root 建出来的是 `root:sheinops 0750`，sheinops 连自己的日志文件都建不了，脚本在 `exec >>"$LOG_FILE"` 这一步就退出。
- 修法：脚本在以 root 运行时 `chown <service-user>:<service-group> "$LOG_DIR"` 再 `chmod 0750`；迁移完成后顺手机核对 `logs/*/` 每个目录的属主是否等于实际写入者（半托只有这一处不符，其它 root 属主的目录都是 root 自己写）。
- 影响面（半托实例）：库存关键的 `linksData` 段因此整段没刷新，晨链落到 warning 并需要重试；修完在链路自己的重试里 131 秒内恢复。
