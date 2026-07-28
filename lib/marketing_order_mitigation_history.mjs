const DRIFT_FIX_RESULT_PATTERN = /^batch-drift-fix-result-(\d{4}-\d{2}-\d{2})(?:-.*)?\.json$/i;

export function driftFixResultDate(fileName) {
  const match = DRIFT_FIX_RESULT_PATTERN.exec(String(fileName || '').trim());
  if (!match) return '';
  const date = match[1];
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
    ? date
    : '';
}

export function isDriftFixResultEligibleForReport(fileName, reportDate) {
  const resultDate = driftFixResultDate(fileName);
  const normalizedReportDate = String(reportDate || '').trim();
  if (!resultDate || !/^\d{4}-\d{2}-\d{2}$/.test(normalizedReportDate)) return false;
  return resultDate <= normalizedReportDate;
}

export const DRIFT_FIX_RESULT_FILE_PATTERN = /^batch-drift-fix-result-\d{4}-\d{2}-\d{2}(?:-.*)?\.json$/i;
