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

// Called under the receiver's per-day cross-process lock. All receiver entry
// points (including retry) are bound to one immutable report fingerprint.
export async function assertRetireReviewDayBinding({root, date, fingerprint}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('invalid delivery identity');
  const day=path.join(root,date),claim=path.join(root,`.review-${date}.claim.json`);
  let existing=[];
  try {
    const stat=await fs.lstat(day);
    if(!stat.isDirectory() || stat.isSymbolicLink())throw new Error('unsafe business day directory');
    existing=await fs.readdir(day);
  } catch(error) {if(error.code!=='ENOENT')throw error;}
  if(existing.some(name=>name!==fingerprint))throw new Error('business day is bound to another report; do not resend');
  let binding;
  try {
    const stat=await fs.lstat(claim);
    if(!stat.isFile() || stat.isSymbolicLink())throw new Error('unsafe daily claim');
    binding=JSON.parse(await fs.readFile(claim,'utf8'));
  } catch(error) {if(error.code!=='ENOENT')throw error;}
  if(binding) {
    if(binding.schemaVersion!=='retire-review-day-claim/v1' || binding.date!==date || binding.fingerprint!==fingerprint)throw new Error('business day claim differs; do not resend');
    return;
  }
  const handle=await fs.open(claim,'wx',0o600);
  try {await handle.writeFile(JSON.stringify({schemaVersion:'retire-review-day-claim/v1',date,fingerprint,claimedAt:new Date().toISOString()}));await handle.sync();}
  finally {await handle.close();}
}
