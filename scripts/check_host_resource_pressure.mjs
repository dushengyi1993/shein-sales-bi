#!/usr/bin/env node

import os from 'node:os';
import {readFile} from 'node:fs/promises';

export const HOST_RESOURCE_PRESSURE_PROFILES = Object.freeze({
  browser: Object.freeze({
    minimumUptimeSeconds: 900,
    minimumAvailableMemoryMiB: 2560,
    maximumLoadPerCpu: 0.75,
    maximumMemoryFullAvg10: 1,
    maximumIoFullAvg10: 5,
  }),
  'browser-secondary': Object.freeze({
    minimumUptimeSeconds: 900,
    minimumAvailableMemoryMiB: 4096,
    maximumLoadPerCpu: 0.65,
    maximumMemoryFullAvg10: 0.5,
    maximumIoFullAvg10: 3,
  }),
  openapi: Object.freeze({
    minimumUptimeSeconds: 900,
    minimumAvailableMemoryMiB: 2048,
    maximumLoadPerCpu: 0.85,
    maximumMemoryFullAvg10: 2,
    maximumIoFullAvg10: 8,
  }),
  materializer: Object.freeze({
    minimumUptimeSeconds: 1200,
    minimumAvailableMemoryMiB: 2048,
    maximumLoadPerCpu: 0.75,
    maximumMemoryFullAvg10: 1,
    maximumIoFullAvg10: 5,
  }),
});

export const HOST_RESOURCE_DEFER_EXIT_CODE = 75;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function parseArgs(argv = []) {
  let resourceClass = null;
  for (const token of argv) {
    const match = /^--class=(browser|browser-secondary|openapi|materializer)$/.exec(token);
    if (!match || resourceClass !== null) {
      throw new TypeError('HOST_RESOURCE_PRESSURE_ARGUMENT_INVALID');
    }
    resourceClass = match[1];
  }
  if (!resourceClass) throw new TypeError('HOST_RESOURCE_PRESSURE_CLASS_REQUIRED');
  return Object.freeze({resourceClass});
}

export function parseMemAvailableMiB(text) {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(String(text ?? ''));
  return match ? Number(match[1]) / 1024 : null;
}

export function parseLoadAverage(text) {
  return finiteNonNegative(String(text ?? '').trim().split(/\s+/)[0]);
}

export function parseUptimeSeconds(text) {
  return finiteNonNegative(String(text ?? '').trim().split(/\s+/)[0]);
}

export function parsePressureFullAvg10(text) {
  const line = String(text ?? '').split(/\r?\n/).find(candidate => candidate.startsWith('full '));
  if (!line) return null;
  const match = /\bavg10=(\d+(?:\.\d+)?)\b/.exec(line);
  return match ? finiteNonNegative(match[1]) : null;
}

export function evaluateHostResourcePressure(snapshot, profile) {
  const reasons = [];
  const cpuCount = Number(snapshot?.cpuCount);
  const load1 = finiteNonNegative(snapshot?.load1);
  const normalizedLoad = load1 !== null && Number.isSafeInteger(cpuCount) && cpuCount > 0
    ? load1 / cpuCount
    : null;
  const uptimeSeconds = finiteNonNegative(snapshot?.uptimeSeconds);
  const availableMemoryMiB = finiteNonNegative(snapshot?.availableMemoryMiB);
  const memoryFullAvg10 = snapshot?.memoryFullAvg10 === null
    ? null
    : finiteNonNegative(snapshot?.memoryFullAvg10);
  const ioFullAvg10 = snapshot?.ioFullAvg10 === null
    ? null
    : finiteNonNegative(snapshot?.ioFullAvg10);

  if (uptimeSeconds === null) reasons.push('UPTIME_UNAVAILABLE');
  else if (uptimeSeconds < profile.minimumUptimeSeconds) reasons.push('BOOT_SETTLING');
  if (availableMemoryMiB === null) reasons.push('MEMORY_AVAILABLE_UNAVAILABLE');
  else if (availableMemoryMiB < profile.minimumAvailableMemoryMiB) reasons.push('MEMORY_PRESSURE');
  if (normalizedLoad === null) reasons.push('LOAD_UNAVAILABLE');
  else if (normalizedLoad > profile.maximumLoadPerCpu) reasons.push('CPU_LOAD_PRESSURE');
  if (memoryFullAvg10 !== null && memoryFullAvg10 > profile.maximumMemoryFullAvg10) {
    reasons.push('MEMORY_STALL_PRESSURE');
  }
  if (ioFullAvg10 !== null && ioFullAvg10 > profile.maximumIoFullAvg10) {
    reasons.push('IO_STALL_PRESSURE');
  }

  return Object.freeze({
    ready: reasons.length === 0,
    reasons: Object.freeze(reasons),
    evidence: Object.freeze({
      uptimeSeconds,
      cpuCount: Number.isSafeInteger(cpuCount) && cpuCount > 0 ? cpuCount : null,
      load1,
      normalizedLoad,
      availableMemoryMiB,
      memoryFullAvg10,
      ioFullAvg10,
    }),
  });
}

async function optionalRead(file, reader) {
  try {
    return await reader(file, 'utf8');
  } catch {
    return null;
  }
}

export async function readHostResourcePressureSnapshot({
  reader = readFile,
  cpuCount = os.availableParallelism(),
} = {}) {
  const [uptime, load, meminfo, memoryPressure, ioPressure] = await Promise.all([
    optionalRead('/proc/uptime', reader),
    optionalRead('/proc/loadavg', reader),
    optionalRead('/proc/meminfo', reader),
    optionalRead('/proc/pressure/memory', reader),
    optionalRead('/proc/pressure/io', reader),
  ]);
  return Object.freeze({
    uptimeSeconds: parseUptimeSeconds(uptime),
    cpuCount,
    load1: parseLoadAverage(load),
    availableMemoryMiB: parseMemAvailableMiB(meminfo),
    memoryFullAvg10: parsePressureFullAvg10(memoryPressure),
    ioFullAvg10: parsePressureFullAvg10(ioPressure),
  });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const {resourceClass} = parseArgs(argv);
  const snapshot = await readHostResourcePressureSnapshot(dependencies);
  const result = evaluateHostResourcePressure(
    snapshot,
    HOST_RESOURCE_PRESSURE_PROFILES[resourceClass],
  );
  console.log(JSON.stringify({
    ok: result.ready,
    status: result.ready ? 'READY' : 'DEFERRED',
    resourceClass,
    reasonCodes: result.reasons,
    ...result.evidence,
  }));
  return result.ready ? 0 : HOST_RESOURCE_DEFER_EXIT_CODE;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/check_host_resource_pressure.mjs')) {
  main().then(exitCode => {
    process.exitCode = exitCode;
  }).catch(error => {
    console.error(JSON.stringify({
      ok: false,
      status: 'DEFERRED',
      errorCode: String(error?.message ?? 'HOST_RESOURCE_PRESSURE_CHECK_FAILED')
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_')
        .slice(0, 80),
    }));
    process.exitCode = HOST_RESOURCE_DEFER_EXIT_CODE;
  });
}
