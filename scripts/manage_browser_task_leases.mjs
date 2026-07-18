#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  acquireBrowserTaskLease,
  heartbeatBrowserTaskLease,
  releaseBrowserTaskLease,
} from '../lib/browser_task_lease.mjs';

function parseArgs(argv) {
  const action = argv[0] || '';
  const out = {action, root: process.cwd(), task: '', runId: '', ownerPid: process.pid, ttlSec: 3600, group: 'ALL', stores: []};
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => argv[++i] || '';
    if (arg === '--root') out.root = path.resolve(take());
    else if (arg === '--task') out.task = take();
    else if (arg === '--run-id') out.runId = take();
    else if (arg === '--owner-pid') out.ownerPid = Number(take());
    else if (arg === '--ttl-sec') out.ttlSec = Number(take());
    else if (arg === '--group') out.group = String(take()).toUpperCase();
    else if (arg === '--stores' || arg === '--store') out.stores.push(...String(take()).split(',').map(value => value.trim().toUpperCase()).filter(Boolean));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['acquire', 'heartbeat', 'release'].includes(action)) throw new Error(`Unknown action: ${action}`);
  if (!out.task || !out.runId) throw new Error('Missing --task or --run-id');
  if (!Number.isInteger(out.ownerPid) || out.ownerPid <= 0) throw new Error(`Invalid --owner-pid: ${out.ownerPid}`);
  if (!Number.isInteger(out.ttlSec) || out.ttlSec < 60) throw new Error(`Invalid --ttl-sec: ${out.ttlSec}`);
  return out;
}

function selectedStores(args) {
  const config = JSON.parse(fs.readFileSync(path.join(args.root, 'config', 'stores.json'), 'utf8'));
  const enabled = new Set((config.stores || []).filter(store => store.enabled !== false).map(store => String(store.storeKey).toUpperCase()));
  if (args.stores.length) {
    const selected = [...new Set(args.stores)];
    const unknown = selected.filter(storeKey => !enabled.has(storeKey));
    if (unknown.length) throw new Error(`Unknown or disabled stores: ${unknown.join(',')}`);
    return selected;
  }
  const allowed = args.group === 'ALL' ? null : new Set((config.groups?.[args.group] || []).map(String));
  const stores = (config.stores || [])
    .filter(store => store.enabled !== false && (!allowed || allowed.has(String(store.storeKey))))
    .map(store => String(store.storeKey).toUpperCase());
  if (!stores.length) throw new Error(`No enabled stores selected for group=${args.group}`);
  return stores;
}

const args = parseArgs(process.argv.slice(2));
const stores = selectedStores(args);
const results = [];
if (args.action === 'acquire') {
  try {
    for (const storeKey of stores) {
      const result = acquireBrowserTaskLease({
        root: args.root,
        task: args.task,
        storeKey,
        runId: args.runId,
        ownerPid: args.ownerPid,
        ttlSec: args.ttlSec,
        metadata: {source: 'manage_browser_task_leases', group: args.group},
      });
      results.push({storeKey, acquired: true, expiresAt: result.lease.expiresAt});
    }
  } catch (error) {
    for (const item of results) {
      releaseBrowserTaskLease({root: args.root, task: args.task, storeKey: item.storeKey, runId: args.runId});
    }
    throw error;
  }
} else if (args.action === 'heartbeat') {
  for (const storeKey of stores) {
    const result = heartbeatBrowserTaskLease({
      root: args.root,
      task: args.task,
      storeKey,
      runId: args.runId,
      ownerPid: args.ownerPid,
      ttlSec: args.ttlSec,
    });
    results.push({storeKey, heartbeat: true, expiresAt: result.lease.expiresAt});
  }
} else {
  for (const storeKey of stores) {
    const result = releaseBrowserTaskLease({root: args.root, task: args.task, storeKey, runId: args.runId});
    results.push({storeKey, released: result.released === true});
  }
}

console.log(JSON.stringify({ok: true, action: args.action, task: args.task, runId: args.runId, group: args.group, stores: results}, null, 2));
