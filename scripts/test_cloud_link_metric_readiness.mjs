import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellFile = path.join(root, 'scripts', 'cloud_link_business_sync.sh');
const source = await fs.readFile(shellFile, 'utf8');

function extractFunction(name, endMarker) {
  const start = source.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker for ${name}`);
  return source.slice(start, end);
}

const candidateFunction = extractFunction('metric_candidate_is_ready', '\nrun_metric_refetch_round()');
const readinessFunction = extractFunction('calculate_metric_readiness', '\nset +e\nMETRIC_READY_JSON=');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-link-metric-readiness-'));
const date = '2026-09-04';
const stores = 'CX DL DX FY HL JSH JY LQ MZ NM QH QY TS TZ TZZ XC XL YJ ZL'.split(' ');

function runBash(script, env) {
  const toShellPath = value => {
    const raw = String(value);
    if (process.platform !== 'win32') return raw;
    const match = raw.replaceAll('\\', '/').match(/^([A-Za-z]):(\/.*)$/);
    return match ? `/mnt/${match[1].toLowerCase()}${match[2]}` : raw;
  };
  const normalizedEnv = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, toShellPath(value)]));
  const result = process.platform === 'win32'
    ? spawnSync('wsl.exe', ['--exec', 'env', ...Object.entries(normalizedEnv).map(([key, value]) => `${key}=${value}`), 'bash', '-lc', script], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 30_000,
    })
    : spawnSync('bash', ['-c', script], {
      cwd: root,
      env: {...process.env, ...normalizedEnv},
      encoding: 'utf8',
      timeout: 30_000,
    });
  assert.equal(result.error, undefined, result.error?.message || 'bash spawn failed');
  return result;
}

try {
  const candidate = path.join(tempRoot, 'candidate.json');
  const validPayload = {
    ok: true,
    date,
    store: {storeKey: 'DL'},
    counts: {diagnoseDay: 0, performanceRows: 1},
    performanceRows: [{epsUv: 0, goodsUv: 0, saleCnt: 0, payOrderCnt: 0}],
  };
  await fs.writeFile(candidate, JSON.stringify(validPayload));
  let result = runBash(`${candidateFunction}
metric_candidate_is_ready "$CANDIDATE" DL`, {
    CANDIDATE: candidate,
    STORE: 'DL',
    DATE: date,
  });
  assert.equal(result.status, 0, `diagnoseDay=0 should be ready: ${result.stderr}`);

  for (const counts of [{performanceRows: 1}, {diagnoseDay: -1, performanceRows: 1}, {diagnoseDay: 0, performanceRows: 2}]) {
    await fs.writeFile(candidate, JSON.stringify({...validPayload, counts}));
    result = runBash(`${candidateFunction}\nmetric_candidate_is_ready "$CANDIDATE" DL`, {
      CANDIDATE: candidate,
      STORE: 'DL',
      DATE: date,
    });
    assert.notEqual(result.status, 0, `invalid diagnostic/count contract was accepted: ${JSON.stringify(counts)}`);
  }

  assert.match(readinessFunction, /if \(!diagnoseDay\.ok\) storeIssues\.push/,
    'calculate_metric_readiness must still reject a missing or malformed diagnostic count');
  assert.match(readinessFunction, /else if \(!Number\.isInteger\(diagnoseDay\.value\)\)/,
    'calculate_metric_readiness must reject a non-integer diagnostic count');
  assert.doesNotMatch(readinessFunction, /counts\.diagnoseDay:source_unavailable/,
    'diagnoseDay=0 must no longer be treated as source unavailable');
  assert.match(readinessFunction, /performanceCount\.value !== rows\.length/,
    'performance row count mismatch must remain a blocker');
} finally {
  await fs.rm(tempRoot, {recursive: true, force: true});
}

console.log('cloud link metric readiness focused contract: ok');

// Execute the real pre-refetch configuration gate against business and BI-only stores.
{
  const fs = await import('node:fs');
const source=fs.readFileSync(new URL('./cloud_link_business_sync.sh',import.meta.url),'utf8');
const block=source.split('validate_metric_refetch_paths_and_stores() {')[1].split("\nNODE\n}")[0].split("<<'NODE'\n")[1];assert(block);
const canonical=source.match(/^CANONICAL_METRIC_STORES="([^"]+)"/m)[1].split(' ');assert.equal(canonical.length,19);
const current=JSON.parse(fs.readFileSync(new URL('../config/stores.json',import.meta.url),'utf8')).stores;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'metric-refetch-scope-'));
try{
 fs.mkdirSync(path.join(dir,'config'));fs.mkdirSync(path.join(dir,'state','cloud_ops_alerts'),{recursive:true});
 const run=rows=>{fs.writeFileSync(path.join(dir,'config','stores.json'),JSON.stringify({stores:rows}));return spawnSync(process.execPath,['--input-type=commonjs','-e',block],{env:{...process.env,ROOT:dir,STATE_FILE:path.join(dir,'state','cloud_ops_alerts','fixture.json'),CANONICAL_STORES:canonical.join(' ')},encoding:'utf8',timeout:10000})};
 const active=current.filter(s=>s.enabled!==false);const bi=current.filter(s=>s.enabled===false&&s.biEnabled===true);assert(bi.length>=1);
 for(const rows of [active,current]){const r=run(rows);assert.equal(r.status,0,r.stderr)}
 for(const [label,rows] of [
 ['missing business store',current.filter(s=>s.storeKey!==canonical[0])],
 ['extra enabled store',[...current,{storeKey:'ZZ',enabled:true}]],
 ['unknown disabled extra',[...current,{storeKey:'ZZ',enabled:false}]],
 ['duplicate BI key',[...current,bi[0]]],
 ['duplicate business key',[...current,active[0]]],
 ['disabled canonical with BI flag',current.map(s=>s.storeKey===canonical[0]?{...s,enabled:false,biEnabled:true}:s)],
 ['nonboolean BI flag',[...active,{storeKey:'ZZ',enabled:false,biEnabled:'true'}]],
 ]){const r=run(rows);assert.notEqual(r.status,0,label+' must fail')}
 console.log(JSON.stringify({ok:true,test:'metric_refetch_store_scope',businessStores:active.length,biOnlyStores:bi.length,invalidCasesRejected:7}));
}finally{fs.rmSync(dir,{recursive:true,force:true})}

}
