import fs from 'node:fs/promises';
import path from 'node:path';

// A business-day claim survives failed/unknown sends and changed XLSX bytes.
// Reconciliation is explicit; this workflow never deletes or resets a claim.
export async function claimRetireReviewDelivery({root, date, fingerprint}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('invalid delivery identity');
  const base = path.resolve(root);
  const stat = await fs.lstat(base);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe delivery root');
  const day = path.join(base, date);
  async function hasPriorDelivery() {
    try {
      const s = await fs.lstat(day);
      if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('unsafe business day directory');
      return (await fs.readdir(day)).length > 0;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  if (await hasPriorDelivery()) throw new Error('business day already has delivery evidence; read back the original, do not resend');
  const claim = path.join(base, `.review-${date}.claim.json`);
  const handle = await fs.open(claim, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({schemaVersion: 'retire-review-day-claim/v1', date, fingerprint, claimedAt: new Date().toISOString()}));
    await handle.sync();
  } finally { await handle.close(); }
  if (await hasPriorDelivery()) throw new Error('concurrent delivery evidence appeared; claim retained, do not resend');
  return {claimed: true, date, fingerprint};
}
