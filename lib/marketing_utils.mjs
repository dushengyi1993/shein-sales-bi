/**
 * Shared marketing utility functions.
 *
 * P1-#3 refactor: extracts commonly duplicated utility functions
 * from 12-16 marketing scripts into a single shared module.
 */

export function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[%SAR,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function round4(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

export function floor2(value) {
  return Math.floor((Number(value) + 1e-9) * 100) / 100;
}

export function normalizeStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

export function normalizeSkc(value) {
  return String(value || '').trim();
}

export function compact(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, '').replace(/[()（）【】\[\]_:：/\\]/g, '').toUpperCase();
}

export function splitList(value) {
  return String(value || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

export function splitStores(value) {
  return String(value || '')
    .split(',')
    .map(x => x.trim().toUpperCase())
    .filter(Boolean);
}

export function rel(root, file) {
  if (!file) return '';
  const path = require('node:path');
  return path.relative(root, file).replaceAll('\\', '/');
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function parseLocalDateTime(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] || 0),
    Number(m[5] || 0),
    Number(m[6] || 0),
  );
}

export function parseAnyDateTime(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const parsed = new Date(s);
  if (Number.isFinite(parsed.getTime())) return parsed;
  return parseLocalDateTime(s);
}

export function formatLocalDate(d) {
  const pad2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function formatLocalDateTime(d) {
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return '';
  const pad2 = n => String(n).padStart(2, '0');
  return `${formatLocalDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function ageHours(now, then) {
  if (!now || !then) return null;
  return Math.round(((now.getTime() - then.getTime()) / 36_000)) / 100;
}

export function listFiles(dir, regex) {
  const fsSync = require('node:fs');
  const path = require('node:path');
  if (!fsSync.existsSync(dir)) return [];
  return fsSync.readdirSync(dir, {withFileTypes: true})
    .filter(d => d.isFile() && regex.test(d.name))
    .map(d => path.join(dir, d.name))
    .sort((a, b) => fsSync.statSync(b).mtimeMs - fsSync.statSync(a).mtimeMs);
}

export function latestFile(dir, regex) {
  return listFiles(dir, regex)[0] || '';
}

export function readJsonSafe(file) {
  const fsSync = require('node:fs');
  try {
    return JSON.parse(fsSync.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function readJsonIfExists(file, fallback = null) {
  const fs = await import('node:fs/promises');
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}
