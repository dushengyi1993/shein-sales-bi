#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  buildDeterministicTestShards,
  parseShardSpec,
  selectDeterministicTestShard,
} from '../lib/deterministic_test_shards.mjs';

assert.deepEqual(parseShardSpec('1/4'), {index: 1, count: 4});
assert.deepEqual(parseShardSpec('4/4'), {index: 4, count: 4});
for (const invalid of ['', '0/4', '5/4', '1/0', '1', 'a/b', '1/33']) {
  assert.throws(() => parseShardSpec(invalid), /Invalid shard/);
}

const tests = ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs', 'e.mjs', 'f.mjs'];
const estimates = {'a.mjs': 100, 'b.mjs': 20, 'c.mjs': 10, 'd.mjs': 10, 'e.mjs': 5, 'f.mjs': 5};
const shards = buildDeterministicTestShards(tests, 3, estimates);
assert.equal(shards.length, 3);
assert.deepEqual(shards.flatMap(shard => shard.tests).sort(), tests.slice().sort(), 'every test must appear exactly once');
assert.equal(new Set(shards.flatMap(shard => shard.tests)).size, tests.length);
for (const shard of shards) {
  const originalPositions = shard.tests.map(file => tests.indexOf(file));
  assert.deepEqual(originalPositions, originalPositions.slice().sort((a, b) => a - b), 'each shard keeps source order');
}
assert.deepEqual(buildDeterministicTestShards(tests, 3, estimates), shards, 'sharding must be deterministic');
assert.deepEqual(selectDeterministicTestShard(tests, '2/3', estimates).tests, shards[1].tests);
assert.throws(() => buildDeterministicTestShards(['a', 'a'], 2), /duplicates/);

console.log('Deterministic test sharding tests passed');
