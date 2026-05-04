# SHEIN 页面避坑清单

这些经验来自旧项目和本项目验证，但只作为避坑参考，不限制后续实现路线。

## 统计口径

- 以“订单创建时间”为准，而不是抓取时间或发货时间。
- 单日筛选只是缩小范围，最终仍要逐单统计。
- 顶部汇总金额不能作为最终事实值。
- 2026-04-26 DL 验证后，优先走接口明细而非页面文本：
  1. `/gsp/orderPlus/listOrder`，参数包含 `allocateTimeStart/End`、`excludeOrderType: 5`、`tabIndex: 1`、分页。
  2. 取返回的 `info.data` 作为 `orderPlusListPageVOList`，调用 `/gsp/orderPlus/listOrderItem`，参数 `{orderPlusListPageVOList, tabIndex: 1}`。
  3. 店铺日销售额汇总 `groupList[].goodsList[].currencyPrice`。
- DL 2026-03-31：上述明细口径为 `1917.17 SAR`，与手工表一致；`/gsp/orderPlus/list/statistics` 同日返回 `orderGoodsTotalPrice=2537.88`，不要使用。
- DL 2026-03 整月当前接口逐日合计为 `19785.23 SAR`，手工表为 `19822.55 SAR`；差异集中在 3/1、3/13、3/20，可能来自历史手工漏记/取整或后续退款导致当前后台历史值变化。后续历史回补需把这类差异作为复核点。

## 登录和 profile

- 每个店铺使用独立工作区 Chrome profile，profile 数据放在 `profiles/persistent-<store>-profile`，不要写入 C 盘默认 Chrome 用户目录。
- Chrome 用户名按 `店铺代号 - 店铺名称` 命名，例如 `DL - DLSDdsy3688`，避免多个浏览器窗口混淆。
- SHEIN 在一台新设备/新 profile 前几次登录时通常需要手机验证码；长期登录几次后通常会减少验证码频率。
- 遇到手机验证码、人机校验、账号异常时，应请用户在可见 Chrome 窗口中处理，不要尝试绕过。

## 页面操作

- 正确订单页入口：`https://sso.geiwohuo.com/#/gsp/order-management/list`
- 筛选前优先：`全部` → `重置`。
- 如果时间字段被切成其他字段，要切回“订单创建时间”。
- 日期控件应分别确认左右日期，不要假设默认年月正确。

## 订单读取

- 点击当前订单卡片的 `更多` 后，只读取当前打开的 popover。
- 不要从整页混合文本硬切订单详情，容易串单。
- 读取字段至少包括：订单号、订单创建时间、订单状态、金额、商品货号、数量。

## 分页

- 不盲目调到最大页大小。
- 优先保证渲染完整和逐单不漏。
