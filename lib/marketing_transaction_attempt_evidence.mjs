import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const preMutationPhases = new Set(['initialized', 'dry_run', 'pre_delete_snapshot_locked', 'pre_mutation_deadline_deferred', 'safe_blocked']);

export async function readLimitedDiscountMutationEvidence({
  root = process.cwd(), storeKey, sourceRescuePath, transactionId = '',
  journalDir = path.join(root, 'state', 'marketing-replacement-transactions'),
} = {}) {
  const unknown = reason => ({state: 'unknown', verified: false, reason});
  try {
    const sourceBytes = await fs.readFile(path.resolve(root, sourceRescuePath));
    const sourceRescueHash = sha256(sourceBytes);
    const store = String(storeKey || '').toUpperCase();
    const id = transactionId || sha256(store + '\n' + sourceRescueHash).slice(0, 24);
    if (!/^[A-Z0-9]+$/.test(store) || !/^[A-Za-z0-9_-]+$/.test(id)) return unknown('invalid transaction identity');
    const journalPath = path.join(journalDir, 'limited-discount-tx-' + store + '-' + id + '.json');
    const stat = await fs.lstat(journalPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return unknown('journal is not a regular file');
    const bytes = await fs.readFile(journalPath);
    const journal = JSON.parse(bytes.toString('utf8'));
    if (journal.schemaVersion !== 1 || journal.transactionId !== id || journal.storeKey !== store
      || journal.rescueHash !== sourceRescueHash || typeof journal.mutationsStarted !== 'boolean'
      || !Array.isArray(journal.snapshots) || !Array.isArray(journal.removals)) return unknown('journal binding mismatch');
    const proof = {verified: true, journalPath, journalSha256: sha256(bytes), transactionId: id, sourceRescueHash};
    if (journal.mutationsStarted || journal.currentMutation || journal.createAttempt
      || journal.removals.length || journal.result?.writeAttempted || journal.result?.mutationsStarted) {
      return {...proof, state: 'started'};
    }
    if (preMutationPhases.has(journal.phase)) return {...proof, state: 'not_started'};
    if (journal.phase === 'completed' && journal.result?.status === 'already_exactly_covered'
      && journal.result.writeAttempted === false && journal.result.mutationsStarted === false) {
      return {...proof, state: 'not_started'};
    }
    return unknown('journal does not prove absence of a mutation');
  } catch (error) { return unknown('mutation evidence unavailable: ' + String(error.code || 'invalid_json')); }
}
