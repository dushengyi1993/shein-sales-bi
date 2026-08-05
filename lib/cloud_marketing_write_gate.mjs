import fs from 'node:fs';

const CLOUD_GATE_TOKEN = 'bounded-repair-v1';

function commandLine(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
  } catch {
    return '';
  }
}

function parentPid(pid) {
  try {
    return Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s+(\d+)/m)?.[1] || 0);
  } catch {
    return 0;
  }
}

function hasMarketingHostWrapperAncestor(startPid = process.ppid) {
  let pid = Number(startPid || 0);
  for (let depth = 0; pid > 1 && depth < 24; depth += 1) {
    const command = commandLine(pid);
    if (command.includes('run_host_heavy_job.sh') && command.includes('--domain marketing-repair')) return true;
    pid = parentPid(pid);
  }
  return false;
}

function hasWriteIntent(argv) {
  return argv.some(arg => arg === '--execute' || arg === '--submit');
}

function isCloudHost() {
  return process.platform !== 'win32'
    && fs.existsSync('/srv/shein-bi')
    && fs.existsSync('/run/lock/shein-host-heavy.lock');
}

export function assertCloudMarketingWriteGate({argv = process.argv.slice(2)} = {}) {
  if (!hasWriteIntent(argv) || !isCloudHost()) return {cloud: false, required: false};
  if (process.env.SHEIN_BI_HOST_HEAVY_WRAPPED !== '1') {
    throw new Error('cloud_marketing_write_requires_shared_host_wrapper');
  }
  if (process.env.SHEIN_BI_HOST_HEAVY_DOMAIN !== 'marketing-repair') {
    throw new Error('cloud_marketing_write_requires_marketing_repair_domain');
  }
  if (process.env.SHEIN_BI_MARKETING_CLOUD_WRITE_GATE !== CLOUD_GATE_TOKEN) {
    throw new Error('cloud_marketing_write_gate_token_missing');
  }
  if (!hasMarketingHostWrapperAncestor()) {
    throw new Error('cloud_marketing_write_wrapper_ancestor_missing');
  }
  return {cloud: true, required: true, gate: CLOUD_GATE_TOKEN};
}

export {CLOUD_GATE_TOKEN};
