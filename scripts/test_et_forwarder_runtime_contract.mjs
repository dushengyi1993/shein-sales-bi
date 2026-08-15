#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME_ROOT = '/srv/shein-bi/runtime/et-forwarder';
const PYTHON_PATH = `${RUNTIME_ROOT}/current/bin/python`;
const SESSION_PATH = `${RUNTIME_ROOT}/session/et_forwarder_http_session.local.json`;
const ENSURE_COMMAND = '+/usr/bin/env bash /opt/shein-bi/app/scripts/ensure_et_forwarder_runtime.sh';

const forwarder = read('infra/systemd/shein-bi-cloud-et-forwarder.service');
const recheck = read('infra/systemd/shein-bi-et-low-inventory-recheck.service');
for (const [name, unit] of [
  ['shein-bi-cloud-et-forwarder.service', forwarder],
  ['shein-bi-et-low-inventory-recheck.service', recheck],
]) {
  assert.equal(unit.match(/^Environment=SHEIN_PYTHON=(.*)$/m)?.[1]?.trim(), PYTHON_PATH);
  assert.equal(unit.match(/^Environment=SHEIN_ET_RUNTIME_ROOT=(.*)$/m)?.[1]?.trim(), RUNTIME_ROOT);
  assert.equal(unit.match(/^Environment=SHEIN_ET_HTTP_SESSION_FILE=(.*)$/m)?.[1]?.trim(), SESSION_PATH);
  assert.equal(unit.match(/^ExecStartPre=(.*)$/m)?.[1]?.trim(), ENSURE_COMMAND);
  assert.ok(unit.indexOf('ExecStartPre=') < unit.indexOf('ExecStart='), `${name} prepares before start`);
  assert.doesNotMatch(unit, /\.venv-et|\/opt\/shein-bi\/app\/state\/et_forwarder_http_session/);
}

const sync = read('scripts/cloud_et_forwarder_sync.sh');
assert.match(sync, /ET_RUNTIME_ROOT="\$\{SHEIN_ET_RUNTIME_ROOT:-\/srv\/shein-bi\/runtime\/et-forwarder\}"/);
assert.match(sync, /ET_HTTP_SESSION_FILE="\$\{SHEIN_ET_HTTP_SESSION_FILE:-\$ET_RUNTIME_ROOT\/session\/et_forwarder_http_session\.local\.json\}"/);
assert.doesNotMatch(sync, /(?:rm|unlink)[^\n]*et_forwarder_http_session/i);

const fetch = read('scripts/fetch_et_forwarder.mjs');
assert.match(fetch, /const explicitPython = String\(process\.env\.SHEIN_PYTHON \|\| ''\)\.trim\(\);/);
assert.match(fetch, /if \(explicitPython\) return \[explicitPython\];/,
  'an invalid explicit production interpreter must not fall back to system python');
assert.match(fetch, /path\.join\(ET_RUNTIME_ROOT, 'current', 'bin', 'python'\)/);
assert.match(fetch, /sessionPath: path\.resolve\(process\.env\.SHEIN_ET_HTTP_SESSION_FILE/);
assert.doesNotMatch(fetch, /ROOT, '\.venv-et'|ROOT, 'state', 'et_forwarder_http_session/);

const locked = read('requirements-et-forwarder.lock');
const requirementLines = locked.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));
assert.equal(requirementLines.length, 8);
for (const line of requirementLines) {
  assert.match(line, /^[a-z0-9._-]+==[^ ]+ --hash=sha256:[a-f0-9]{64}$/i);
}
assert.ok(requirementLines.some(line => line.startsWith('ddddocr==1.6.1 ')));

const ensure = read('scripts/ensure_et_forwarder_runtime.sh');
assert.match(ensure, /MODE="verify"/);
assert.match(ensure, /--install\) MODE="install"/);
assert.match(ensure, /LOCK_REQUIREMENTS="\$\{SHEIN_ET_REQUIREMENTS_FILE:-\$REPO_ROOT\/requirements-et-forwarder\.lock\}"/);
assert.match(ensure, /--require-hashes --only-binary=:all:/);
assert.match(ensure, /--no-index --find-links "\$WHEELHOUSE"/);
assert.match(ensure, /VERSION_DIR="\$\(safe_runtime_path "\$VERSIONS_DIR\/\$LOCK_SHA"\)"/);
assert.match(ensure, /ln -s -- "\$VERSION_DIR" "\$tmp_link"/);
assert.match(ensure, /mv -Tf -- "\$tmp_link" "\$CURRENT_LINK"/);
assert.doesNotMatch(ensure, /mv -- "\$CURRENT_LINK"|rm -rf -- "\$CURRENT_LINK"/,
  'activation must never create a current-runtime path gap');
assert.match(ensure, /if \[\[ "\$MODE" == "install" \]\]; then\s+install_version/s);
assert.match(ensure, /ET runtime is not installed; run \$0 --install during deployment/);
assert.match(ensure, /install -m 0600 "\$LEGACY_SESSION" "\$SESSION_FILE"/);
assert.doesNotMatch(ensure, /(?:rm|unlink|rmdir)[^\n]*SESSION/i);

// Interpreter ABI gate: CPython 3.12, x86_64, Linux, glibc, before any use.
assert.match(ensure, /platform\.python_implementation\(\)/);
assert.match(ensure, /sys\.version_info\[0\]/);
assert.match(ensure, /platform\.machine\(\)\.lower\(\)/);
assert.match(ensure, /platform\.system\(\)/);
assert.match(ensure, /platform\.libc_ver\(\)/);
assert.ok(ensure.includes('CPython\\|3.12\\|x86_64\\|Linux\\|glibc\\|*'),
  'the ABI probe must require CPython 3.12 on x86_64 Linux with glibc');
assert.match(ensure, /interpreter ABI mismatch[\s\S]*current\/unit will NOT be switched[\s\S]*return 1/,
  'an ABI mismatch must fail without switching current or the systemd unit');
assert.ok(ensure.indexOf('verify_python_abi "$BOOTSTRAP_PYTHON"') >= 0
  && ensure.indexOf('verify_python_abi "$BOOTSTRAP_PYTHON"') < ensure.indexOf('-m pip download'),
  'the bootstrap interpreter ABI must be verified before any wheel download');
assert.ok(ensure.indexOf('verify_python_abi "$VERSION_PYTHON"') < ensure.indexOf('"$VERSION_PYTHON" -m pip install'),
  'the venv interpreter ABI must be verified before the offline install');
assert.ok(ensure.indexOf('verify_python_abi "$CURRENT_LINK/bin/python"') < ensure.indexOf('verify_version "$CURRENT_LINK/bin/python"'),
  'verify-only must check the runtime Python ABI before the import check');

// Wheel-tag compatibility: authoritative packaging.tags parsing, never
// filename pattern guessing; offline pip dry-run is the deterministic
// fallback when packaging is unavailable.
assert.match(ensure, /from pip\._vendor\.packaging\.tags import sys_tags/);
assert.match(ensure, /from pip\._vendor\.packaging\.utils import parse_wheel_filename/);
assert.match(ensure, /parse_wheel_filename\(wheel\.name\)/);
assert.match(ensure, /set\(tags\) & supported/);
assert.match(ensure, /pip install --dry-run --no-index --find-links "\$wheelhouse"/);
assert.match(ensure, /wheelhouse compatibility check failed[\s\S]*current\/unit will NOT be switched[\s\S]*return 1/);
assert.doesNotMatch(ensure, /\[\[ "\$wheel" == \*cp312\*/,
  'wheel compatibility must use packaging.tags, not filename pattern guessing');
assert.ok(ensure.indexOf('verify_wheelhouse_compat "$BOOTSTRAP_PYTHON" "$WHEELHOUSE"') > ensure.indexOf('-m pip download'),
  'the downloaded wheelhouse must be checked after download');
assert.ok(ensure.lastIndexOf('verify_wheelhouse_compat') < ensure.lastIndexOf('activate_version'),
  'current must never be activated before the wheelhouse passes compatibility');
assert.ok(ensure.indexOf('install -m 0600 "$LEGACY_SESSION" "$SESSION_FILE"') < ensure.lastIndexOf('activate_version'),
  'session migration must finish before current is atomically activated');
assert.match(ensure, /\[\[ ! -L "\$SESSION_FILE" \]\] \|\| fail "refusing symlink ET session path; current\/unit will NOT be switched"/);

// Real Bash behavior check for the P0 regression: RUNTIME_ROOT itself must be
// accepted. Verify-only may create private directories, but must stop at the
// missing offline runtime without invoking pip or reporting path escape.
const bash = spawnSync('bash', ['--version'], {encoding: 'utf8'});
if (bash.status === 0) {
  spawnSync('bash', ['-lc', 'rm -rf -- /tmp/et-runtime-contract-codex'], {cwd: ROOT});
  const run = spawnSync('bash', ['-lc',
    'env SHEIN_ET_RUNTIME_ROOT=/tmp/et-runtime-contract-codex/runtime SHEIN_ET_RUNTIME_GROUP= ./scripts/ensure_et_forwarder_runtime.sh --verify'],
  {cwd: ROOT, encoding: 'utf8'});
  spawnSync('bash', ['-lc', 'rm -rf -- /tmp/et-runtime-contract-codex'], {cwd: ROOT});
  assert.equal(run.status, 1);
  assert.match(run.stderr, /ET runtime is not installed/);
  assert.doesNotMatch(run.stderr, /refusing path outside runtime root/);
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /pip (?:download|install)/i);
}

// ABI gate behavior with a controlled fake interpreter, so the contract does
// not depend on the test host being Linux CPython 3.12. Each case verifies
// the gate blocks and that the current symlink is never switched.
if (bash.status === 0) {
  const tools = spawnSync('bash', ['-lc', 'command -v sha256sum && command -v flock && command -v readlink && command -v ln'], {encoding: 'utf8'});
  if (tools.status === 0) {
    const lockSha = crypto.createHash('sha256')
      .update(fs.readFileSync(new URL('../requirements-et-forwarder.lock', import.meta.url)))
      .digest('hex');
    const root = '/tmp/et-abi-contract-codex';
    const versionDir = `${root}/venvs/${lockSha}`;
    const setup = [
      `rm -rf -- ${root}`,
      `mkdir -p ${versionDir}/bin`,
      `cat > ${versionDir}/bin/python <<'FAKE'`,
      '#!/usr/bin/env bash',
      `cat ${root}/probe`,
      'exit 0',
      'FAKE',
      `chmod +x ${versionDir}/bin/python`,
      `ln -s ${versionDir} ${root}/current`,
    ].join('\n');
    const runAbiCase = probe => {
      spawnSync('bash', ['-lc', `${setup}\nprintf '%s\\n' ${JSON.stringify(probe)} > ${root}/probe`], {cwd: ROOT, encoding: 'utf8'});
      const run = spawnSync('bash', ['-lc',
        `env SHEIN_ET_BOOTSTRAP_PYTHON=${versionDir}/bin/python SHEIN_ET_RUNTIME_ROOT=${root} SHEIN_ET_RUNTIME_GROUP= ./scripts/ensure_et_forwarder_runtime.sh --verify`],
      {cwd: ROOT, encoding: 'utf8'});
      const link = spawnSync('bash', ['-lc', `readlink -- ${root}/current`], {encoding: 'utf8'}).stdout.trim();
      spawnSync('bash', ['-lc', `rm -rf -- ${root}`], {cwd: ROOT});
      return {run, link};
    };
    const assertAbiBlocked = (probe, hint) => {
      const {run, link} = runAbiCase(probe);
      assert.equal(run.status, 1, `${hint}\nstdout=${run.stdout}\nstderr=${run.stderr}`);
      assert.match(run.stderr, /interpreter ABI mismatch/);
      assert.match(run.stderr, /current\/unit will NOT be switched/);
      assert.doesNotMatch(run.stdout, /ready mode=verify/);
      assert.equal(link, versionDir, 'a failed ABI check must never switch the current runtime');
    };
    assertAbiBlocked('CPython|3.11|x86_64|Linux|glibc|2.31', 'non-3.12 CPython must block');
    assertAbiBlocked('CPython|3.12|aarch64|Linux|glibc|2.31', 'non-x86_64 machine must block');
    assertAbiBlocked('CPython|3.12|x86_64|Linux|musl|1.2', 'non-glibc libc must block');
    assertAbiBlocked('CPython|3.12|x86_64|Darwin|glibc|', 'non-Linux platform must block');
    assertAbiBlocked('PyPy|3.12|x86_64|Linux|glibc|2.31', 'non-CPython implementation must block');
    const valid = runAbiCase('CPython|3.12|x86_64|Linux|glibc|2.31');
    assert.equal(valid.run.status, 0, 'a CPython 3.12 x86_64 Linux glibc interpreter must pass verify');
    assert.match(valid.run.stdout, /ready mode=verify/);
    assert.equal(valid.link, versionDir, 'a passing verify must keep the current runtime untouched');
  }
}

// A session preparation failure must leave an existing current runtime
// untouched. The fake interpreter only emulates the bounded commands needed
// to reach the session gate; no network or package install occurs.
if (bash.status === 0) {
  const root = '/tmp/et-session-failure-contract-codex';
  const lockPath = `${root}/requirements.lock`;
  const legacyPath = `${root}/legacy-session.json`;
  const oldVersion = `${root}/old-version`;
  const fakePython = `${root}/fake-python`;
  const setup = [
    `rm -rf -- ${root}`,
    `mkdir -p ${root}/session ${oldVersion}/bin`,
    `printf '%s\\n' 'ddddocr==1.6.1 --hash=sha256:c7c70f4ae2d0335440ae8b272eea48c9f6888ecef46785fe2311f0c97a133935' > ${lockPath}`,
    `printf '%s\\n' '{"session":"redacted-test-value"}' > ${legacyPath}`,
    `cat > ${fakePython} <<'FAKE'`,
    '#!/usr/bin/env bash',
    'if [[ "\\${1:-}" == "-c" ]]; then',
    '  printf "%s\\n" "CPython|3.12|x86_64|Linux|glibc|2.39"',
    '  exit 0',
    'fi',
    'if [[ "\\${1:-}" == "-m" && "\\${2:-}" == "pip" && "\\${3:-}" == "download" ]]; then exit 0; fi',
    'if [[ "\\${1:-}" == "-m" && "\\${2:-}" == "venv" ]]; then',
    '  target="\\${3:-}"; mkdir -p "\\$target/bin"; cp "\\$0" "\\$target/bin/python"; chmod +x "\\$target/bin/python"; exit 0',
    'fi',
    'if [[ "\\${1:-}" == "-" ]]; then exit 0; fi',
    'exit 0',
    'FAKE',
    `chmod +x ${fakePython}`,
    `cp ${fakePython} ${oldVersion}/bin/python`,
    `ln -s ${oldVersion} ${root}/current`,
    `ln -s ${root}/outside-session.json ${root}/session/et_forwarder_http_session.local.json`,
  ].join('\n');
  const setupRun = spawnSync('bash', ['-lc', setup], {cwd: ROOT, encoding: 'utf8'});
  assert.equal(setupRun.status, 0, `session failure fixture setup failed\nstdout=${setupRun.stdout}\nstderr=${setupRun.stderr}`);
  const run = spawnSync('bash', ['-lc',
    `env SHEIN_ET_BOOTSTRAP_PYTHON=${fakePython} SHEIN_ET_RUNTIME_ROOT=${root} SHEIN_ET_RUNTIME_GROUP= SHEIN_ET_REQUIREMENTS_FILE=${lockPath} SHEIN_ET_LEGACY_SESSION_FILE=${legacyPath} ./scripts/ensure_et_forwarder_runtime.sh --install`],
  {cwd: ROOT, encoding: 'utf8'});
  const link = spawnSync('bash', ['-lc', `readlink -- ${root}/current`], {encoding: 'utf8'}).stdout.trim();
  assert.equal(run.status, 1, `session path failure must abort install\nstdout=${run.stdout}\nstderr=${run.stderr}`);
  assert.match(run.stderr, /refusing symlink ET session path/);
  assert.equal(link, oldVersion, 'session migration failure must leave current pointing at the old runtime');
  assert.doesNotMatch(run.stdout, /ready mode=install/);
  spawnSync('bash', ['-lc', `rm -rf -- ${root}`], {cwd: ROOT});
}

const runner = read('scripts/run_deterministic_tests.mjs');
assert.match(runner, /'scripts\/test_et_forwarder_runtime_contract\.mjs'/);

console.log(JSON.stringify({ok: true, runtime: RUNTIME_ROOT, lockedPackages: requirementLines.length}, null, 2));
