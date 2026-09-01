#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./probe_systemd_runtime_bind_paths.sh', import.meta.url), 'utf8');

assert.match(source, /mktemp -d \/tmp\/shein-bi-bind-paths-probe\.XXXXXX/);
assert.match(source, /case "\$tmp" in[\s\S]*\/tmp\/shein-bi-bind-paths-probe\.\*/);
assert.match(source, /mount --bind "\$src" "\$dst"/);
assert.match(source, /mount -o remount,bind,ro "\$dst"/);
assert.match(source, /--property "BindPaths=\$src:\$dst"/);
assert.match(source, /systemd-run[\s\S]*--wait[\s\S]*--collect/);
assert.match(source, /\/usr\/bin\/touch "\$dst\/unit-write"/);
assert.match(source, /\[\[ -f "\$src\/unit-write" \]\]/);
assert.match(source, /--property "BindReadOnlyPaths=\$src:\$dst"/);
assert.match(source, /--property "ReadOnlyPaths=\$src"/);
assert.match(source, /--property "InaccessiblePaths=\$tmp\/blocked-marker"/);
assert.match(source, /omission-write/);
assert.match(source, /canonical-write/);
assert.match(source, /target-write/);
assert.match(source, /probe-both-ro-ok/);
assert.match(source, /systemctl show "\$readback_unit" -p ReadOnlyPaths -p BindReadOnlyPaths -p InaccessiblePaths/);
assert.match(source, /"effectiveReadback":true/);
assert.doesNotMatch(source, /rm\s+-rf|\/opt\/shein-bi|\/data\/shein-bi|\/srv\/shein-bi/,
  'the probe must stay temp-only and avoid recursive deletion');

console.log('systemd runtime BindPaths probe contract passed');
