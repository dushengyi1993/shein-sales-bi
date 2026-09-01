const DEFAULT_ESTIMATE_MS = 2_000;

export function parseShardSpec(value) {
  const match = String(value || '').trim().match(/^(\d+)\/(\d+)$/);
  if (!match) throw new Error(`Invalid shard specification: ${value}; expected INDEX/COUNT`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > 32 || index < 1 || index > count) {
    throw new Error(`Invalid shard bounds: ${value}`);
  }
  return {index, count};
}

/**
 * Deterministically balance tests by measured/declared duration while keeping
 * their original order inside each shard. Every caller computes the same bins
 * independently, so CI needs no mutable coordinator or generated manifest.
 */
export function buildDeterministicTestShards(tests, count, estimates = {}) {
  if (!Array.isArray(tests) || !tests.length) throw new Error('Tests must be a non-empty array');
  if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error(`Invalid shard count: ${count}`);
  if (new Set(tests).size !== tests.length) throw new Error('Deterministic test list contains duplicates');
  const rows = tests.map((file, order) => {
    const configured = Number(estimates[file]);
    const estimateMs = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_ESTIMATE_MS;
    return {file, order, estimateMs};
  });
  rows.sort((a, b) => b.estimateMs - a.estimateMs || a.file.localeCompare(b.file, 'en'));
  const shards = Array.from({length: count}, (_, index) => ({index: index + 1, estimatedMs: 0, rows: []}));
  for (const row of rows) {
    shards.sort((a, b) => a.estimatedMs - b.estimatedMs || a.index - b.index);
    shards[0].rows.push(row);
    shards[0].estimatedMs += row.estimateMs;
  }
  shards.sort((a, b) => a.index - b.index);
  return shards.map(shard => ({
    index: shard.index,
    estimatedMs: shard.estimatedMs,
    tests: shard.rows.sort((a, b) => a.order - b.order).map(row => row.file),
  }));
}

export function selectDeterministicTestShard(tests, spec, estimates = {}) {
  const {index, count} = typeof spec === 'string' ? parseShardSpec(spec) : spec;
  const shards = buildDeterministicTestShards(tests, count, estimates);
  return {count, ...shards[index - 1]};
}
