const LOCAL_BUSINESS_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
const EXPLICIT_ZONE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;

function hasValidCalendarFields(match) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

export function parseChinaBusinessDateTime(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const localMatch = raw.match(LOCAL_BUSINESS_TIME);
  const zonedMatch = raw.match(EXPLICIT_ZONE_TIME);
  const match = localMatch || zonedMatch;
  if (!match || !hasValidCalendarFields(match)) return null;
  const source = localMatch ? `${raw.replace(' ', 'T')}+08:00` : raw;
  const parsed = new Date(source);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
