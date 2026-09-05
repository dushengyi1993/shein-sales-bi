import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const file = fileURLToPath(new URL('./test_host_v6_resource_concurrency.sh', import.meta.url));
const bashFile = process.platform === 'win32' ? '/mnt/' + file[0].toLowerCase() + file.slice(2).replaceAll('\\', '/') : file;
const result = spawnSync('bash', [bashFile], {encoding: 'utf8', timeout: 30_000});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error || result.status !== 0) throw result.error || new Error(`resource concurrency test failed: ${result.status}`);
