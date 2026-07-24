function asFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function buildMarketingRepairBlockerNotice(report = {}) {
  const rows = [];
  for (const result of Array.isArray(report.results) ? report.results : []) {
    for (const topUp of Array.isArray(result.inventoryTopUps) ? result.inventoryTopUps : []) {
      const evidence = topUp.execute || topUp.dryRun || {};
      const decision = evidence.decision || evidence.initialDecision || {};
      if (!decision || decision.ok !== false) continue;
      rows.push({
        storeKey: String(result.storeKey || evidence.storeKey || '').trim().toUpperCase(),
        skc: String(topUp.skc || evidence.skc || '').trim(),
        canonical: String(evidence.canonical || '').trim(),
        platformStock: asFinite(decision.platformStock),
        etStock: asFinite(decision.etStock),
        required: asFinite(decision.required ?? evidence?.target?.activityStock),
        reason: String(decision.reason || '').trim(),
      });
    }
  }

  const title = `营销兜底未完成：${rows.length} 条链接库存不足`;
  const detailLines = rows.map(row => {
    const name = row.canonical || row.skc || '未识别商品';
    const platform = row.platformStock === null ? '未知' : row.platformStock;
    const et = row.etStock === null ? '未知' : row.etStock;
    const required = row.required === null ? '未知' : row.required;
    return `- ${row.storeKey} · ${name}：平台可用 ${platform}，ET 可用 ${et}，计划活动库存 ${required}`;
  });
  const message = [
    '系统已完成检查，但以下链接的实盘库存不足，未创建限时折扣：',
    ...detailLines,
    '',
    '系统没有虚增库存，也没有提交这些活动。补货后次日巡检会自动重试；如果希望按当前实盘数量报名，需要单独调整活动库存规则。',
  ].join('\n');
  return {title, message, rows};
}
