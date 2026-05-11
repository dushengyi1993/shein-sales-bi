#!/usr/bin/env node
/**
 * Generate a shareable Markdown briefing from the local SHEIN BI portal data.
 *
 * This is intentionally file-based: the daily pipeline already generates
 * outputs/bi-portal/data.json, so the briefing can be regenerated without
 * querying SHEIN, Feishu, Metabase, or PostgreSQL again.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    data: path.join(ROOT, 'outputs', 'bi-portal', 'data.json'),
    outDir: path.join(ROOT, 'outputs', 'bi-briefings'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--data') args.data = path.resolve(argv[++i]);
    else if (argv[i] === '--out-dir') args.outDir = path.resolve(argv[++i]);
  }
  return args;
}

const fmt = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 2});
const fmt0 = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 0});
const num = n => fmt0.format(Number(n || 0));
const money = n => `SAR ${fmt.format(Number(n || 0))}`;

function safe(s) {
  return String(s ?? '')
    .replace(/\uFFFD+/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function domainName(d) {
  return ({link:'链接', inventory:'库存', quality:'质量', after_sales:'售后', finance:'财务', business:'经营'}[d] || d || '-');
}

function growthReferenceRisk(link) {
  if (!link) return '';
  const text = [link.health_bucket, link.shelf_status_name, link.action_category, link.reason].map(x => String(x || '')).join(' ');
  if (/下架候选|可下架|先替换再下架|淘汰/.test(text)) return '下架/淘汰候选';
  if (/高访客低支付|低支付|有流量无销量/.test(text)) return '支付转化偏弱';
  if (/高曝光低点击|低点击/.test(text)) return '点击承接偏弱';
  if (/库存|售罄/.test(text)) return '库存/售罄风险';
  return '';
}

function growthReferenceLabel(link) {
  return growthReferenceRisk(link) ? '参考SKC' : '强SKC';
}

function focusMatch(row, key) {
  const cat = String(row.category || row.title || row.reason || row.evidence || '');
  if (key === 'retire') return row.action_domain === 'link' && /下架|淘汰|替换/.test(cat);
  if (key === 'supplement') return row.action_domain === 'link' && /补链接|缺上架链接|缺链接/.test(cat);
  if (key === 'optimize') return row.action_domain === 'link' && /低支付|低点击|无销量|承接|优化|重复弱链接/.test(cat);
  if (key === 'risk') return ['after_sales', 'quality', 'inventory'].includes(row.action_domain);
  return true;
}

function topActions(data, key, limit = 5) {
  return (data.actions || [])
    .filter(a => focusMatch(a, key))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, limit);
}

function productPriorities(data, limit = 8) {
  const actions = data.actions || [];
  const financeGoods = data.financeGoods || [];
  const afterSales = data.afterSales || [];
  const matrix = data.matrix || [];
  return (data.products || []).map(p => {
    const sn = p.standard_goods_sn || '';
    const productActions = actions.filter(a => a.standard_goods_sn === sn);
    const financeRows = financeGoods.filter(x => x.standard_goods_sn === sn);
    const afterRows = afterSales.filter(x => x.standard_goods_sn === sn);
    const matrixRows = matrix.filter(x => x.standard_goods_sn === sn);
    const financeAmount = financeRows.reduce((sum, x) => sum + Number(x.amount || 0), 0);
    const afterAmount = afterRows.reduce((sum, x) => sum + Number(x.price_amount_total || 0), 0);
    const storeActionCount = new Set(productActions.map(x => x.store_key).filter(Boolean)).size;
    const missingStores = matrixRows.filter(x => x.need_supplement_link).length || Number(p.missing_store_count || 0);
    const linkRisk = productActions.filter(x => x.action_domain === 'link').length;
    const qualityRisk = productActions.filter(x => x.action_domain === 'quality' || x.action_domain === 'after_sales').length;
    const crossScore =
      Number(p.risk_score || 0)
      + Math.min(80, productActions.length * 8)
      + Math.min(45, storeActionCount * 6)
      + Math.min(35, financeAmount / 20)
      + Math.min(45, afterRows.length * 4)
      + Math.min(35, missingStores * 4);
    const reasons = [
      productActions.length ? `动作 ${num(productActions.length)} 条` : '',
      linkRisk ? `链接 ${num(linkRisk)}` : '',
      qualityRisk ? `售后/质量 ${num(qualityRisk)}` : '',
      financeRows.length ? `财务在途 ${num(financeRows.length)} 条` : '',
      afterRows.length ? `售后 ${num(afterRows.length)} 单` : '',
      missingStores ? `缺覆盖 ${num(missingStores)} 店` : '',
    ].filter(Boolean);
    return {...p, crossScore, productActions, financeRows, afterRows, financeAmount, afterAmount, missingStores, reasons};
  })
    .filter(x => x.reasons.length || Number(x.sales_sar || 0) > 0)
    .sort((a, b) => Number(b.crossScore || 0) - Number(a.crossScore || 0) || Number(b.sales_sar || 0) - Number(a.sales_sar || 0))
    .slice(0, limit);
}

function actionSearchText(a) {
  return [a.category, a.title, a.reason, a.evidence, a.next_step, a.standard_goods_sn, a.skc, a.store_key, a.action_domain]
    .map(x => String(x || ''))
    .join(' ');
}

function actionBucketCounts(rows) {
  const text = x => actionSearchText(x);
  return {
    retire: rows.filter(a => a.action_domain === 'link' && /下架|淘汰|替换/.test(text(a))).length,
    supplement: rows.filter(a => a.action_domain === 'link' && /补链接|缺上架|缺链接|补覆盖/.test(text(a))).length,
    optimize: rows.filter(a => a.action_domain === 'link' && /低支付|低点击|高访客|高曝光|无销量|优化|承接/.test(text(a))).length,
    afterQuality: rows.filter(a => ['after_sales', 'quality'].includes(a.action_domain)).length,
    inventory: rows.filter(a => a.action_domain === 'inventory').length,
  };
}

function addCause(causes, label, weight, evidence, nextStep) {
  const w = Number(weight || 0);
  if (w <= 0) return;
  causes.push({label, weight: Math.round(w), evidence, nextStep});
}

function rootCauseCenter(data, limit = 6) {
  const actions = data.actions || [];
  const products = data.products || [];
  const stores = data.stores || [];
  const links = data.links || [];
  const afterSales = data.afterSales || [];
  const waybills = data.waybills || [];
  const financeGoods = data.financeGoods || [];
  const rows = [];

  for (const p of products) {
    const sn = p.standard_goods_sn || '';
    if (!sn) continue;
    const productActions = actions.filter(a => a.standard_goods_sn === sn);
    const buckets = actionBucketCounts(productActions);
    const productLinks = links.filter(x => x.standard_goods_sn === sn);
    const productAfter = afterSales.filter(x => x.standard_goods_sn === sn);
    const productFinance = financeGoods.filter(x => x.standard_goods_sn === sn);
    const sales = Number(p.sales_sar || 0);
    const afterCases = Number(p.after_sales_case_count || productAfter.length || 0);
    const afterAmount = Number(p.after_sales_amount_sar || productAfter.reduce((sum, x) => sum + Number(x.price_amount_total || 0), 0));
    const afterPressure = sales > 0 ? Math.min(120, afterAmount / Math.max(1, sales) * 18) : Math.min(90, afterCases * 2);
    const linkExposure = productLinks.reduce((sum, x) => sum + Number(x.eps_uv || 0), 0);
    const linkVisitors = productLinks.reduce((sum, x) => sum + Number(x.goods_uv || 0), 0);
    const linkSales30 = productLinks.reduce((sum, x) => sum + Number(x.c30_sale_cnt || 0), 0);
    const financeAmount = productFinance.reduce((sum, x) => sum + Number(x.amount || 0), 0);
    const causes = [];
    addCause(causes, '售后质量', afterPressure + Math.min(45, Number(p.low_star_comment_count || 0) * 5), `售后 ${num(afterCases)} 单 / ${money(afterAmount)}；低星 ${num(p.low_star_comment_count)}`, '先看退货原因和低星评价，再决定是否降流、换图说明或换链接。');
    addCause(causes, '弱链接止损', buckets.retire * 26, `下架/替换动作 ${num(buckets.retire)} 条`, '先确认是否唯一承接；唯一承接先补新链接，再处理旧链接。');
    addCause(causes, '链接承接', buckets.optimize * 20 + (linkExposure > 0 && linkSales30 === 0 ? 28 : 0), `曝光 ${num(linkExposure)} / 商详 ${num(linkVisitors)} / 30天销量 ${num(linkSales30)}`, '按曝光→点击→商详→支付拆承接问题。');
    addCause(causes, '覆盖缺口', buckets.supplement * 18 + Math.min(36, Number(p.missing_store_count || 0) * 5), `缺覆盖 ${num(p.missing_store_count)} 店；补链动作 ${num(buckets.supplement)} 条`, '只补部分店已上架、部分店缺的货号。');
    addCause(causes, '库存展示', Number(p.low_display_stock_count || 0) * 22 + buckets.inventory * 15, `低展示库存 ${num(p.low_display_stock_count)} 个；库存动作 ${num(buckets.inventory)} 条`, '只处理已上架且近 30 天有销量/订单的展示库存风险。');
    addCause(causes, '财务在途', Math.min(60, financeAmount / 30), `财务商品 ${num(productFinance.length)} 条 / ${money(financeAmount)}`, '核对财务在途商品是否能匹配订单商品。');
    const sorted = causes.sort((a, b) => b.weight - a.weight).slice(0, 4);
    if (!sorted.length) continue;
    const score = Number(p.risk_score || 0) + sorted.reduce((sum, x) => sum + x.weight, 0);
    if (score < 90 && productActions.length < 2) continue;
    rows.push({
      kind: '货号',
      subject: sn,
      score,
      main: sorted[0],
      second: sorted[1],
      causes: sorted,
      conclusion: score >= 220 ? '高优先级：今天先处理或安排负责人。' : '中优先级：可排入本周复核。',
    });
  }

  for (const s of stores) {
    const store = s.store_key || '';
    if (!store) continue;
    const storeWaybills = waybills.filter(x => x.store_key === store && /取消|异常|失败|未/.test(String(x.show_status_desc || x.tag_desc || '')));
    const causes = [];
    addCause(causes, '链接覆盖', Number(s.link_action_count || 0) * 2 + Number(s.missing_product_count || 0) * 1.5, `链接动作 ${num(s.link_action_count)} 条；缺覆盖 ${num(s.missing_product_count)} 个`, '先看该店是否集中缺某些已验证货号。');
    addCause(causes, '售后压力', Math.min(130, Number(s.after_sales_case_count || 0) * 1.7 + Number(s.after_sales_item_amount_sar || 0) / 160), `售后 ${num(s.after_sales_case_count)} 单 / ${money(s.after_sales_item_amount_sar)}`, '优先找售后集中的货号，不要按店铺平均处理。');
    addCause(causes, '质量评价', Number(s.low_star_comment_count || 0) * 8 + Number(s.quality_after_sales_item_count || 0) * 2, `低星 ${num(s.low_star_comment_count)}；质量售后 ${num(s.quality_after_sales_item_count)}`, '把低星评价和售后原因合并看。');
    addCause(causes, '履约面单', Number(s.waybill_exception_count || storeWaybills.length || 0) * 16, `履约异常 ${num(s.waybill_exception_count || storeWaybills.length)} 个`, '先查取消/未揽收/物流异常包裹。');
    addCause(causes, '财务在途', Math.min(80, Number(s.finance_no_finish_order_income_sar || 0) / 80) + Number(s.finance_no_finish_order_count || 0) * 2, `财务在途 ${num(s.finance_no_finish_order_count)} 单 / ${money(s.finance_no_finish_order_income_sar)}`, '有权限店先核对在途收入。');
    const sorted = causes.sort((a, b) => b.weight - a.weight).slice(0, 4);
    if (!sorted.length) continue;
    const score = Number(s.risk_score || 0) + sorted.reduce((sum, x) => sum + x.weight, 0);
    if (score < 120) continue;
    rows.push({
      kind: '店铺',
      subject: store,
      score,
      main: sorted[0],
      second: sorted[1],
      causes: sorted,
      conclusion: '先进入店铺作战台，再按主因分流到动作池或订单/售后明细。',
    });
  }

  const unmatched = financeGoods.filter(x => !x.standard_goods_sn || x.standard_goods_sn === '未匹配货号');
  if (unmatched.length) {
    const amount = unmatched.reduce((sum, x) => sum + Number(x.amount || 0), 0);
    rows.push({
      kind: '财务',
      subject: '财务商品待匹配',
      score: Math.min(260, unmatched.length * 7 + amount / 20),
      main: {label: '匹配规则', evidence: `未匹配财务商品 ${num(unmatched.length)} 条 / ${money(amount)}`, nextStep: '优先用 entity_id / 订单号 / SKU Code 回填标准货号。'},
      second: {label: '收入影响'},
      causes: [],
      conclusion: '先补匹配，避免后续 BI 误判货号利润和趋势。',
    });
  }

  return rows.sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, limit);
}

function growthOpportunities(data, limit = 6) {
  const actions = data.actions || [];
  const financeGoods = data.financeGoods || [];
  const afterSales = data.afterSales || [];
  const matrix = data.matrix || [];
  const links = data.links || [];
  return (data.products || []).map(p => {
    const sn = p.standard_goods_sn || '';
    const productActions = actions.filter(a => a.standard_goods_sn === sn);
    const financeRows = financeGoods.filter(x => x.standard_goods_sn === sn);
    const afterRows = afterSales.filter(x => x.standard_goods_sn === sn);
    const matrixRows = matrix.filter(x => x.standard_goods_sn === sn);
    const linkRows = links.filter(x => x.standard_goods_sn === sn);
    const sales = Number(p.sales_sar || 0);
    const financeAmount = financeRows.reduce((sum, x) => sum + Number(x.amount || 0), 0);
    const afterAmount = afterRows.reduce((sum, x) => sum + Number(x.price_amount_total || 0), 0);
    const afterRate = sales > 0 ? afterAmount / sales : (afterRows.length ? 9 : 0);
    const missingStores = matrixRows.filter(x => x.need_supplement_link).length || Number(p.missing_store_count || 0);
    const onShelfStores = Number(p.on_shelf_store_count || 0);
    const saleStores = Number(p.sale_store_count || 0);
    const c30Sales = linkRows.reduce((sum, x) => sum + Number(x.c30_sale_cnt || 0), 0);
    const exposure = linkRows.reduce((sum, x) => sum + Number(x.eps_uv || 0), 0);
    const lowStars = Number(p.low_star_comment_count || 0);
    const retireActions = productActions.filter(x => /下架|淘汰|替换/.test(String(x.category || x.title || x.reason || ''))).length;
    const riskActions = productActions.filter(x => ['after_sales', 'quality', 'inventory'].includes(x.action_domain)).length;
    const strongLink = linkRows
      .filter(x => Number(x.c30_sale_cnt || 0) > 0 && !x.retire_candidate)
      .sort((a, b) => Number(b.c30_sale_cnt || 0) - Number(a.c30_sale_cnt || 0) || Number(b.eps_uv || 0) - Number(a.eps_uv || 0))[0];
    const positive =
      Math.min(120, sales / 12)
      + Math.min(45, financeAmount / 20)
      + Math.min(55, c30Sales * 8)
      + Math.min(35, exposure / 80)
      + Math.min(70, missingStores * 10)
      + Math.min(35, saleStores * 8)
      + Math.min(25, onShelfStores * 2);
    const penalty =
      Math.min(120, afterRate * 60)
      + Math.min(40, lowStars * 10)
      + Math.min(50, retireActions * 10)
      + Math.min(45, riskActions * 7);
    const growthScore = Math.max(0, Math.round(positive - penalty));
    let opportunityType = '观察放量';
    if (missingStores > 0 && (sales > 0 || c30Sales > 0 || strongLink)) opportunityType = '扩店补覆盖';
    else if (strongLink && exposure > 500) opportunityType = '复制强链接';
    else if (sales > 0 && saleStores > 0) opportunityType = '活动放量';
    const reasons = [
      sales > 0 ? `销售 ${money(sales)}` : '',
      c30Sales > 0 ? `链接30天销量 ${num(c30Sales)}` : '',
      strongLink ? `${growthReferenceLabel(strongLink)} ${safe(strongLink.skc)}` : '',
      missingStores > 0 && onShelfStores > 0 ? `仍可扩 ${num(missingStores)} 店` : '',
      afterRate <= 0.35 ? '售后压力低' : '',
      financeAmount > 0 ? `财务在途 ${money(financeAmount)}` : '',
    ].filter(Boolean);
    return {...p, growthScore, opportunityType, reasons, financeAmount, afterAmount, afterRate, missingStores, onShelfStores, saleStores, c30Sales, exposure, strongLink, referenceRisk: growthReferenceRisk(strongLink), referenceLabel: growthReferenceLabel(strongLink)};
  })
    .filter(x =>
      Number(x.onShelfStores || 0) > 0
      && Number(x.growthScore || 0) >= 30
      && Number(x.afterRate || 0) <= 0.8
      && (Number(x.sales_sar || 0) > 0 || Number(x.c30Sales || 0) > 0 || Number(x.financeAmount || 0) > 0)
      && (Number(x.missingStores || 0) > 0 || x.strongLink || Number(x.saleStores || 0) > 0)
    )
    .sort((a, b) => Number(b.growthScore || 0) - Number(a.growthScore || 0) || Number(b.sales_sar || 0) - Number(a.sales_sar || 0))
    .slice(0, limit);
}

function warningLines(data) {
  const out = [];
  const d = data.dates || {};
  if (d.linkDate && d.salesDate && d.linkDate < d.salesDate) out.push(`链接数据日 ${d.linkDate} 早于销售日 ${d.salesDate}，链接建议按链接日理解。`);
  if (d.linkDate && d.businessDate && d.linkDate < d.businessDate) out.push(`链接数据日 ${d.linkDate} 早于业务日 ${d.businessDate}，请关注 05:30 链接同步。`);
  for (const w of data.audit?.warningMessages || []) {
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

function trendReadiness(data) {
  const t = data.trend || {};
  const rows = [
    ['销售趋势', Number(t.salesDays || 0), '销售额、订单、店铺销售波动'],
    ['链接表现趋势', Number(t.linkDays || 0), '曝光、访客、点击率、支付率、链接销量'],
    ['经营财务摘要趋势', Number(t.businessDays || 0), '交易额、在途、待结算'],
    ['售后趋势', Number(t.afterSalesDays || 0), '售后单量、退货金额、质量风险'],
    ['gsfs 财务明细趋势', Number(t.financeDays || 0), '在途收入订单、财务商品'],
  ];
  const dayReady = rows.filter(x => x[1] >= 2).length;
  const weekReady = rows.filter(x => x[1] >= 7).length;
  const monthReady = rows.filter(x => x[1] >= 30).length;
  const minDays = Math.min(...rows.map(x => x[1]));
  const state = weekReady ? `可做 7 日趋势 ${weekReady}/${rows.length}` : dayReady ? `可做日环比 ${dayReady}/${rows.length}` : `单日观察 0/${rows.length}`;
  return {rows, dayReady, weekReady, monthReady, minDays, state};
}

function buildMarkdown(data) {
  const k = data.kpi || {};
  const d = data.dates || {};
  const financeGoods = data.financeGoods || [];
  const financeMatched = financeGoods.filter(x => x.standard_goods_sn);
  const financeUnmatched = financeGoods.length - financeMatched.length;
  const domains = Object.fromEntries((data.actionDomain || []).map(x => [x.action_domain, Number(x.count || 0)]));
  const topStores = [...(data.stores || [])].sort((a,b)=>Number(b.risk_score||0)-Number(a.risk_score||0)).slice(0, 5);
  const topProducts = productPriorities(data, 6);
  const growthRows = growthOpportunities(data, 6);
  const rootRows = rootCauseCenter(data, 6);
  const warnings = warningLines(data);
  const trend = trendReadiness(data);
  const generated = new Date(data.generatedAt || Date.now()).toLocaleString('zh-CN', {hour12:false});

  const storeCount = Number(data.counts?.stores || (data.stores || []).length || 0) || 0;
  const storeCountText = storeCount ? String(storeCount) : '全部';
  const lines = [];
  lines.push(`# SHEIN BI 今日经营晨报`);
  lines.push('');
  lines.push(`- 生成时间：${generated}`);
  lines.push(`- 数据日期：销售 ${d.salesDate || '-'}；业务 ${d.businessDate || '-'}；链接 ${d.linkDate || '-'}`);
  lines.push(`- 门户入口：\`outputs/bi-portal/index.html\``);
  lines.push('');

  lines.push(`## 1. 今日结论`);
  lines.push('');
  lines.push(`- 销售额：${money(k.salesSar)}；订单：${num(k.orders)}；销量：${num(k.quantity)}。`);
  lines.push(`- 售后：${num(k.afterSalesCases)} 单；低星评价：${num(k.lowStarComments)}；履约异常：${num(k.waybillExceptions)}。`);
  lines.push(`- 动作池：${num((data.actions || []).length)} 条，其中链接 ${num(domains.link)}、售后 ${num(domains.after_sales)}、质量 ${num(domains.quality)}、库存 ${num(domains.inventory)}。`);
  lines.push(`- 财务：gsfs 在途明细 ${num(k.financeNoFinishOrders)} 单 / ${money(k.financeNoFinishIncomeSar)}；首页在途 ${money(k.inTransitSar)}；已结算 ${money(k.payedIncomeSar)}。`);
  lines.push(`- 财务商品：${num(financeGoods.length)} 条，已匹配货号 ${num(financeMatched.length)}，未匹配 ${num(financeUnmatched)}。`);
  lines.push(`- 趋势：${trend.state}；最短只积累 ${num(trend.minDays)} 天，当前不做假趋势。`);
  lines.push(`- 异常归因：${num(rootRows.length)} 个重点对象；先看主因，再按 SOP 分流处理。`);
  lines.push('');

  lines.push(`## 2. 建议作战顺序`);
  lines.push('');
  const pathDefs = [
    ['先止损', 'retire'],
    ['补覆盖', 'supplement'],
    ['修承接', 'optimize'],
    ['控风险', 'risk'],
  ];
  for (const [label, key] of pathDefs) {
    const rows = topActions(data, key, 3);
    lines.push(`### ${label}`);
    if (!rows.length) lines.push(`- 暂无。`);
    rows.forEach((a, idx) => {
      lines.push(`- ${idx + 1}. ${safe(a.store_key)}｜${safe(a.category)}｜${safe(a.standard_goods_sn || a.skc)}｜分数 ${num(a.score)}｜下一步：${safe(a.next_step)}`);
    });
    lines.push('');
  }

  lines.push(`## 3. 经营异常归因`);
  lines.push('');
  if (!rootRows.length) {
    lines.push('- 暂无强异常；按今日作战路径继续处理动作池。');
  } else {
    rootRows.forEach((r, idx) => {
      lines.push(`- ${idx + 1}. ${r.kind}｜${safe(r.subject)}｜分数 ${num(r.score)}｜主因 ${safe(r.main?.label)}｜次因 ${safe(r.second?.label || '暂无')}｜证据：${safe(r.main?.evidence)}｜下一步：${safe(r.main?.nextStep || r.conclusion)}`);
    });
  }
  lines.push('');

  lines.push(`## 4. 跨域优先货号`);
  lines.push('');
  topProducts.forEach((p, idx) => {
    lines.push(`- ${idx + 1}. ${safe(p.standard_goods_sn)}｜跨域分 ${num(p.crossScore)}｜销售 ${money(p.sales_sar)}｜上架 ${num(p.on_shelf_store_count)}/${storeCountText}｜动作 ${num(p.productActions.length)}｜售后 ${num(p.afterRows.length)} 单 / ${money(p.afterAmount)}｜财务 ${money(p.financeAmount)}｜原因：${safe(p.reasons.join('；'))}`);
  });
  lines.push('');

  lines.push(`## 5. 增长机会池`);
  lines.push('');
  if (!growthRows.length) {
    lines.push('- 暂时没有足够稳的增长机会；今天更适合先处理风险、覆盖和承接。');
  } else {
    growthRows.forEach((p, idx) => {
      const riskNote = p.referenceRisk ? `｜注意：${safe(p.referenceLabel)}存在${safe(p.referenceRisk)}，复制前先修承接` : '';
      lines.push(`- ${idx + 1}. ${safe(p.standard_goods_sn)}｜${safe(p.opportunityType)}｜机会分 ${num(p.growthScore)}｜销售 ${money(p.sales_sar)}｜30天销量 ${num(p.c30Sales)}｜已上架 ${num(p.onShelfStores)}/${storeCountText}｜可扩 ${num(p.missingStores)} 店｜售后压力 ${Math.round(Number(p.afterRate || 0) * 100)}%｜原因：${safe(p.reasons.join('；'))}${riskNote}`);
    });
  }
  lines.push('');
  lines.push(`## 6. 优先店铺`);
  lines.push('');
  topStores.forEach((s, idx) => {
    lines.push(`- ${idx + 1}. ${s.store_key}｜风险 ${num(s.risk_score)}｜销售 ${money(s.sales_sar)}｜订单 ${num(s.valid_order_count)}｜售后 ${num(s.after_sales_case_count)}｜链接动作 ${num(s.link_action_count)}｜财务在途 ${num(s.finance_no_finish_order_count)} 单 / ${money(s.finance_no_finish_order_income_sar)}`);
  });
  lines.push('');

  lines.push(`## 7. 首批经营诊断`);
  lines.push('');
  (data.insights || []).slice(0, 10).forEach((x, idx) => {
    lines.push(`- ${idx + 1}. ${safe(x.title)}｜${domainName(x.action_domain || x.insight_domain)}｜${safe(x.store_key || x.standard_goods_sn || '全局')}｜分数 ${num(x.score)}｜${safe(x.evidence)}｜下一步：${safe(x.next_step)}`);
  });
  lines.push('');

  lines.push(`## 8. 趋势准备雷达`);
  lines.push('');
  trend.rows.forEach(([label, days, use]) => {
    const status = days >= 7 ? '可做 7 日趋势' : days >= 2 ? '可做日环比' : '只做横截面';
    const gap = Math.max(0, 7 - days);
    lines.push(`- ${label}：已积累 ${num(days)} 天；${status}${gap ? `；距离稳定 7 日趋势还差 ${num(gap)} 天` : ''}；用途：${use}。`);
  });
  lines.push(`- 结论：可做日环比 ${num(trend.dayReady)}/5；可做 7 日趋势 ${num(trend.weekReady)}/5；可做 30 日下滑预警 ${num(trend.monthReady)}/5。数据不足时只看横截面，不画假趋势。`);
  lines.push('');

  if (warnings.length) {
  lines.push(`## 9. 数据口径提醒`);
    lines.push('');
    warnings.slice(0, 8).forEach(w => lines.push(`- ${safe(w)}`));
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`这份晨报由本地 SHEIN BI 流水线自动生成；飞书生产链路仍保持原计划运行。`);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(await fs.readFile(args.data, 'utf8'));
  await fs.mkdir(args.outDir, {recursive: true});
  const date = data.dates?.salesDate || new Date().toISOString().slice(0, 10);
  const file = path.join(args.outDir, `shein-bi-briefing-${date}.md`);
  const latest = path.join(args.outDir, 'latest.md');
  const md = buildMarkdown(data);
  await fs.writeFile(file, md, 'utf8');
  await fs.writeFile(latest, md, 'utf8');
  console.log(JSON.stringify({ok:true, file, latest, bytes: Buffer.byteLength(md, 'utf8')}, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
