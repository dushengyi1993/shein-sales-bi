export function normalizeSheinSkc(value) {
  const text = String(value ?? '').trim();
  return /^s(?:v|b)\d+$/i.test(text) ? text.toLowerCase() : '';
}

export function isSheinSkc(value) {
  return Boolean(normalizeSheinSkc(value));
}

export function sameSheinSkc(left, right) {
  const a = normalizeSheinSkc(left);
  const b = normalizeSheinSkc(right);
  return Boolean(a && b && a === b);
}
