# BI Ops / Partner CLI 2026.07.28.2

## 修复范围

本补丁处理合伙人只读查询在业务请求开始前被 CLI 更新检查拦住的问题，并补齐链接级近 7 天/30 天加车访客指标。

### 1. 401 登录恢复

- 旧版在 `/api/partner-cli/manifest` 返回纯文本 `401` 时，会误报 `Partner CLI release endpoint returned invalid JSON`。
- 新版先识别 HTTP 状态，稳定返回 `BI_SESSION_EXPIRED` 或 `BI_LOGIN_REQUIRED`，明确说明查询尚未开始，并给出一次性重新登录命令。
- CLI 顶层错误输出增加 `code`，便于 Codex 区分登录问题、权限问题和数据问题。
- 合伙人重新登录一次后，受管启动器会继续完成哈希校验、版本安装和原命令重试；无需重新安装整包。

### 2. 加车访客口径

- 链接数据新增 `c7_cart_uv`、`c30_cart_uv`，分别表示近 7 天、近 30 天加车访客。
- 同时保留单日 `cart_uv`、`cart_rate`、`pay_uv`，避免把商品访客 `c7_goods_uv` 误当成加车访客。
- 后续链接日更会直接保存平台返回的 7 天/30 天加车指标；旧快照通过同一链接的逐日明细汇总兼容。
- 普通“近 7 天加车 + 曝光 + 销量”筛选只需读取约两千条链接行，不再默认加载六万多条逐日明细。

## 本次只读结果复核

查询口径：当前在售、2026-07-21 至 2026-07-27、加车访客 `>= 20`、曝光 `>= 2000`、销量 `= 0`。

- 命中 10 条链接。
- `c7_eps_uv` / `c7_sale_cnt` 与逐日 7 天汇总逐条一致。
- 查询响应为 `mode=direct-bi-data`、`aiInvoked=false`；未调用 BI 问数机器人、飞书机器人或浏览器抓数。
- 本次没有创建运营任务，也没有修改 SHEIN 商品。

## 验收

- `npm test`：124 / 124 通过。
- Partner CLI 更新器包含纯文本 401 回归测试。
- 新版链接 SQL 已在生产 PostgreSQL 上只读执行，返回 2052 条链接并包含 `cart_uv`、`cart_rate`、`c7_cart_uv`、`c30_cart_uv`。
- Partner CLI 包 SHA256：`5b6e6b58dbd087bb6676208b451bf49a27b263aa19b2f95147fc621d1610b318`。
