#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const source = await fs.readFile('scripts/cloud_marketing_repair_worker.sh', 'utf8');
const highClick = source.slice(
  source.indexOf('HIGH_CLICK_STATUS='),
  source.indexOf('MANUAL_STATUS='),
);
const manual = source.slice(
  source.indexOf('MANUAL_STATUS='),
  source.indexOf('DRIFT_STATUS='),
);
const fallback = source.slice(
  source.indexOf('FALLBACK_STATUS='),
  source.indexOf('QUEUE_STATUS=', source.indexOf('FALLBACK_STATUS=')),
);

assert.match(highClick, /--max-items 1/);
assert.match(highClick, /"\$status" -eq 4 && "\$PROCESSED_ITEMS" == "0"/);
assert.match(highClick, /recoverable items were attempted once in this service run/);
assert.match(highClick, /continuing independent repair stages/);
assert.match(highClick, /\n\s+break\n/);

assert.match(fallback, /while \(\( REMAINING_GROUPS > 0 \)\)/);
assert.match(fallback, /begin_stage_critical_section fallbackRepair/);
assert.match(fallback, /--skip-build --execute --max-groups 1/);
assert.match(fallback, /update_stage fallbackRepair pending/);
assert.match(fallback, /consume_group_budget "\$PROCESSED_GROUPS"/);
assert.doesNotMatch(fallback, /--max-groups "\$REMAINING_GROUPS"/);

assert.match(manual, /"\$status" -eq 2 && "\$PROCESSED_ITEMS" == "1"/);
assert.match(manual, /"\$REMAINING_ITEMS" =~ \^\[1-9\]\[0-9\]\*\$/);
assert.match(manual, /original receipt and exact queue preserved for guarded continuation/);
assert.doesNotMatch(manual, /fresh authorization|\n\s+break\n/);
assert.match(manual, /pending manual work must settle before fallback"\n\s+exit 75/);
assert.match(manual, /execute\/readback failed status=\$status/);

function toBashPath(file) {
  const normalized = path.resolve(file).replaceAll('\\', '/');
  if (normalized.startsWith('/')) return normalized;
  return `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
}

const root = toBashPath(process.cwd());
const oldQueueProbe = spawnSync('bash', [], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: process.env,
  input: [
    `export SHEIN_BI_ROOT='${root}'`,
    "export SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION='local'",
    "export SHEIN_BI_MARKETING_REPAIR_DATE='2000-01-01'",
    `bash '${root}/scripts/cloud_marketing_repair_worker.sh'`,
    '',
  ].join('\n'),
});
assert.equal(oldQueueProbe.status, 75);
assert.match(oldQueueProbe.stderr, /refusing non-current repair queue/);

// Run the exact shell function with the real resolver on a POSIX sibling
// checkout/data layout, including when this registered test starts on Windows.
const pathProbe = spawnSync('bash', [], {
  cwd: process.cwd(), encoding: 'utf8', env: process.env, timeout: 20000,
  input: `export REPO_ROOT='${root}'\nnode --input-type=module <<'TEST_NODE'\n` + String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const repo = process.env.REPO_ROOT;
const source = await fs.readFile(path.join(repo, 'scripts/cloud_marketing_repair_worker.sh'), 'utf8');
const fn = source.slice(source.indexOf('queue_source_guard_file_locked() {'), source.indexOf('\nguard_registry_hash_value() {')).replaceAll('\r\n', '\n');
const policyFile = path.join(repo, 'lib/cloud_runtime_path_policy.mjs');
const {runtimeArtifactLocation} = await import(pathToFileURL(policyFile));
assert.equal(runtimeArtifactLocation({root:'/opt/shein-bi/app',file:'/data/shein-bi/outputs/reports/guard.json',env:{}}).path,
  '/data/shein-bi/outputs/reports/guard.json');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'marketing-guard-path-'));
let checks = 0;
try {
  const root = path.join(temp, 'opt/shein-bi/app');
  const outputs = path.join(temp, 'data/shein-bi/outputs');
  const state = path.join(temp, 'data/shein-bi/state');
  await fs.mkdir(path.join(root,'lib'), {recursive:true});
  await fs.copyFile(policyFile,path.join(root,'lib/cloud_runtime_path_policy.mjs'));
  await fs.mkdir(path.join(outputs,'reports'),{recursive:true});
  await fs.mkdir(state,{recursive:true});
  const name = 'marketing-daily-guard-2026-09-06.json';
  const canonical = path.join(outputs,'reports',name);
  const bytes = JSON.stringify({targetPlanSelection:{registryHash:'a'.repeat(64)}});
  await fs.writeFile(canonical,bytes);
  const queueFile = path.join(temp,'queue.json');
  const probe = async (sourceGuard, expected, error) => {
    const queueBytes = JSON.stringify({sourceGuard,sourceGuardHash:'b'.repeat(64)});
    await fs.writeFile(queueFile,queueBytes);
    const result = spawnSync('bash', [], {encoding:'utf8',timeout:3000,
      input:fn+'\nqueue_source_guard_file_locked\n',env:{...process.env,ROOT:root,QUEUE_FILE:queueFile,
        SHEIN_BI_OUTPUTS_ROOT:outputs,SHEIN_BI_STATE_ROOT:state}});
    assert.equal(result.error,undefined);
    assert.equal(result.status,expected ? 0 : 66,result.stderr);
    if (expected) assert.equal(result.stdout,expected);
    else {assert.equal(result.stdout,''); assert.match(result.stderr,error);}
    assert.equal(await fs.readFile(queueFile,'utf8'),queueBytes,'function must not rewrite queue');
    assert.equal(await fs.readFile(canonical,'utf8'),bytes,'function must not rewrite canonical guard');
    checks++;
  };
  const migrated = '../../../data/shein-bi/outputs/reports/'+name;
  assert.equal(path.relative(root,canonical),migrated);
  await probe(migrated,canonical);
  await probe(canonical,canonical);
  await probe('outputs/reports/'+name,canonical);
  await probe(path.join(root,'outputs/reports',name),canonical);
  const local = path.join(root,'local-guard.json');
  await fs.writeFile(local,bytes);
  await probe('local-guard.json',local);
  const outside = path.join(temp,'unrelated.json');
  await fs.writeFile(outside,bytes);
  await probe(outside,null,/escapes approved roots/);
  await probe(path.relative(root,outside),null,/escapes approved roots/);
  await probe(path.join(outputs+'-other','guard.json'),null,/escapes approved roots/);
  await probe(path.join(state,'guard.json'),null,/escapes approved roots/);
  await probe('outputs/../local-guard.json',null,/noncanonical traversal/);
  await probe('../../../data/shein-bi/outputs/../outputs/reports/'+name,null,/noncanonical traversal/);
  await probe('',null,/non-empty single-line/);
  await probe(migrated+'\n',null,/non-empty single-line/);
  await probe('outputs/reports/missing.json',null,/Artifact unavailable/);
  await fs.symlink(outside,path.join(outputs,'reports/link.json'));
  await probe('outputs/reports/link.json',null,/regular file/);
  await fs.mkdir(path.join(temp,'outside-dir'));
  await fs.writeFile(path.join(temp,'outside-dir/guard.json'),bytes);
  await fs.symlink(path.join(temp,'outside-dir'),path.join(outputs,'escape'));
  await probe('outputs/escape/guard.json',null,/outside its data root/);
  await fs.symlink(outside,path.join(root,'local-link.json'));
  await probe('local-link.json',null,/regular file/);
  await fs.mkdir(path.join(root,'outputs/reports'),{recursive:true});
  await fs.writeFile(path.join(root,'outputs/reports',name),'{}');
  await probe(migrated,null,/namespace conflict/);
  await fs.writeFile(path.join(root,'outputs/reports',name),bytes);
  await probe(migrated,canonical);
  console.log(JSON.stringify({ok:true,pathChecks:checks,exactShellFunction:true,realRuntimeResolver:true}));
} finally {
  await fs.rm(temp,{recursive:true,force:true});
}
` + '\nTEST_NODE\n',
});
assert.equal(pathProbe.error, undefined);
assert.equal(pathProbe.status, 0, pathProbe.stderr || pathProbe.stdout);
const pathResult = JSON.parse(pathProbe.stdout.trim());
assert.equal(pathResult.pathChecks, 19);
console.log(JSON.stringify({ok: true, checks: 18, ...pathResult}, null, 2));
