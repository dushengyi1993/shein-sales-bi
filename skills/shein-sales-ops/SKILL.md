---
name: shein-sales-ops
description: SHEIN/希音销售统计自动化项目专用工作流。用户提到 SHEIN 店铺抓取、DSY/LGM、订单创建时间、SAR/RMB、货号归并、飞书 Base、经营看板、日报、历史回补、退货/成本利润或本工作区时使用。优先执行脚本，Markdown 只保留长期规则和入口。
---

# SHEIN Sales Ops

## 先读
- `MEMORY.md`
- `.codex/plans/2026-04-26T16-56-52-shein-sales-automation-plan.md`
- 本文件

读取后优先用脚本获取当前状态，不要把历史流水全塞进上下文。

## 当前资产
- 工作区：`E:\Codex WorkSpace\Shein销售统计`
- Base：`https://zcnm3ts63aph.feishu.cn/base/SnnQbrAu6aLzMWsnEICcy0cKnJh`
- 当月主看板：`SHEIN经营看板 v3-主看板`，ID `blkFn3qHrwdsrJyX`，数据源 `看板数据-MAIN-*`
- 上月看板：`SHEIN经营看板 v3-上月`，ID `blkWeyZhphgRZYim`，数据源 `看板数据-PREV-*`
- 店铺：DSY=`DL DX FY LQ NM HL JY ZL TS MZ`；LGM=`CX YJ XL QY QH`
- LGM profile 映射：`CX=profile cx/GS9489101`，`YJ=profile qy/GS7451160`，`XL=profile yj/GS8146729`，`QY=profile xl/GS9307061`，`QH=profile qh/GS8715910`

## 业务口径
- 统计日：北京时间自然日。
- 销售额：按 SHEIN 订单创建时间，汇总商品明细正金额行。
- 汇率：`1 SAR = 1.8 RMB`；预测利润率：`25%`。
- 产品销量：按标准货号归并；一单同产品 2 件计 2。
- 今日动销产品数：按分组、按当天统计标准货号去重数；某标准货号当天在该组任一店铺销量 `>0` 即计 1。
- 不做猜测性单店时区偏移；HL 的错误 `accountUtcOffsetHours=3` 已删除并回补。

## 定时任务
- `00:10`：前一天最终版。
- `08:10 / 10:10 / 12:10 / 14:10 / 16:10 / 18:10 / 20:10 / 22:10`：当天滚动同步。
- 日报：早上 08:10 同步成功后自动发送；上午后续成功同步可补发一次，用 `state/daily-report-sent-YYYYMMDD.flag` 防重复。
- watchdog：`09:20` 和 Windows 登录时，只做漏跑补偿。
- 计划任务必须通过 `wscript.exe` + `scripts/run_scheduled_hidden.vbs` 隐藏运行，最长 90 分钟。

## 数据层
- 事实表：`店铺日报事实`、`产品日销量事实`、`订单明细事实`、`订单商品SKC明细事实`、`SKC链接映射`。
- 不合并订单明细事实和订单商品/SKC 明细事实；订单到商品/SKC 是一对多。
- 独立月表只保留当月和上月；更早月份进入年度汇总。
- 产品周/月销量只保留宽表。跨周/月必须先补齐新周期列再写入。
- 新建飞书 Base 表后提醒用户手动扩容到 `20000` 行。

## 货号规则
- 标准货号：`config/product_catalog.json`
- 别名归并：`config/product_aliases.json`
- 归一化：`lib/product_sku_normalizer.mjs`
- 括号前缀只当备注，例如 `（废）SK-123` 按 `SK-123`。
- `2001胶囊咖啡机` 独立；`SK-3065/3065` 并入 `SK-GT-3065蒸汽熨烫机`。
- 2026-05-01 已新增 `SK-1711手持搅拌器`。
- 发现无法归并、疑似新货号或拿不准的短号/标题时，先生成确认清单给用户，不要擅自合并。

## 关键脚本
- 单店浏览器：`node scripts/launch_store_browser.mjs DL --headless|--visible|--background`
- 单店抓取：`node scripts/fetch_shein_sales.mjs DL --date YYYY-MM-DD`
- 单组同步：`node scripts/run_sales_sync_job.mjs --mode intraday --group DSY`
- 15 店当天同步：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scheduled_intraday_dsy.ps1`
- 月表：`node scripts/generate_monthly_sales_table.mjs --month YYYY-MM --include-lgm`
- 年度/宽表：`node scripts/generate_compact_display_tables.mjs --group ALL --current-month YYYY-MM --recent-months 2`
- 当月看板：`node scripts/setup_lark_dashboard_main_v3.mjs --month YYYY-MM`
- 上月看板：`node scripts/setup_lark_dashboard_previous_month.mjs --month YYYY-MM`
- 日报：`node scripts/send_daily_lark_report.mjs --send --visual`
- 今日详尽日报图：`node scripts/generate_today_detailed_report_image.mjs --date YYYY-MM-DD`
- 货号扫描：`node scripts/report_product_sku_candidates.mjs --group ALL --start YYYY-MM-DD --end YYYY-MM-DD`
- 逻辑体检：`node scripts/audit_shein_sales_logic.mjs --month YYYY-MM --date YYYY-MM-DD`
- 安装计划任务：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install_windows_scheduled_tasks.ps1 -IncludeWatchdog`
- 安全关店铺 Chrome：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/close_store_browsers.ps1 -Group DSY`

## 看板规则
- 用户会手动调整正式看板布局和大小；默认不调用 `+dashboard-arrange`，不重建无关组件，不改布局和尺寸。只有用户明确允许时才传 `--arrange`。
- 顶部 KPI 卡必须读 `KPI*` 字段，避免 `全部 + DSY + LGM` 重复求和。
- 颜色规范：全部/合计=绿色系，DSY=蓝色系，LGM=橙色系，产品榜=紫粉系。
- 店铺排行标签只显示排名+店铺代号，不显示 `DSY/`、`LGM/`。
- 不同榜单必须用独立排序字段：产品销量、产品销售额、店铺销售额、店铺销量不能共用排序标签。
- 顶部 `数据时间说明` 是飞书内部 `RICH_TEXT`。不要用公开 `dashboard-block-update` 改已存在 text block；用 `scripts/update_dashboard_time_richtext_ui.mjs` 走已登录飞书网页 profile 的内部保存链路。该步骤已在主看板脚本中做 3 次重试；失败时数据源可能已刷新，只是时间块滞后。
- 顶部 statistics 卡底板/字体颜色不在公开 `data_config` 中；用 `scripts/apply_dashboard_kpi_card_styles_ui.mjs` 或同类 Playwright 脚本通过飞书内部 `chart/user_change` 保存。

## 登录与抓取硬规则
- 页面显示“我的订单/首页”不代表接口可用；接口 `20302 子系统登录重定向` 才是登录态失效硬信号。
- 遇到 `20302`，`run_sales_sync_job.mjs` 必须先调用 `auto_relogin_shein_store.mjs` 恢复登录并重新抓取；失败时提示人工登录，不得用旧数据。
- 自动登录脚本不读取、不输出账号密码，只检查保存密码是否填入并点击登录。
- 若某店保存密码看似失效，先确认启动时是否正确使用对应 profile 和 `--profile-directory=Profile 1`；JY 曾因 profile 环境未命中导致自动恢复失败。
- SHEIN 登录 URL redirect 必须 base64 编码。

## 工具
- 生产抓取链路：自写 Node + Chrome DevTools Protocol/WebSocket + 工作区 Chrome profile。
- Chrome 路径：`launch_store_browser.mjs` 优先 C 盘正式安装路径，D 盘只兜底；店铺 profile 仍必须留在工作区。headless 启动失败时同步脚本会 fallback 到后台窗口模式。
- 飞书 Base/IM：`lark-cli`。
- 飞书看板富文本和样式：Playwright + `profiles/persistent-feishu-profile`。
- 本机有 `opencli`，PowerShell 下应调用 `C:\Users\dushengyi\AppData\Roaming\npm\opencli.cmd`。当前稳定生产链路暂不替换；可用于后续网页探索、临时浏览器操作或封装 lark-cli。

## 避坑
- 不要用 PowerShell here-string 写大量中文 JS/JSON；中文字段、货号、Dashboard 组件名优先用 UTF-8 文件、Node 脚本或 `apply_patch`。
- PowerShell `Set-Content -Encoding UTF8` 可能带 BOM；给 `lark-cli --json @file.json` 传 payload 时优先用 Node 写无 BOM JSON。
- 飞书 `EOF`、`HTTP 500/5000`、限流、证书/CDN 抖动先重试；不要发布半新半旧数据。
- `config/lark_report.json` 必须是合法 UTF-8 JSON；如果日报发送/读取配置异常，先用 JSON parser 校验它。
- 关键改动后跑逻辑体检，目标 `0 error / 0 warning`。
