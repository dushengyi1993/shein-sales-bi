#!/usr/bin/env node
/**
 * Upload local files to a BI link-ops task asset package.
 *
 * Usage:
 *   node scripts/upload_link_ops_assets.mjs --task lot_xxx --file ./a.jpg --file ./title.txt --url https://shein-bi.faceair.me
 *
 * Optional auth:
 *   set SHEIN_BI_BASIC_AUTH=user:password
 */
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    taskId: '',
    url: process.env.SHEIN_BI_URL || 'http://127.0.0.1:8787',
    files: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--task' || a === '--task-id') args.taskId = argv[++i] || '';
    else if (a === '--url') args.url = argv[++i] || args.url;
    else if (a === '--file') args.files.push(argv[++i]);
    else if (!a.startsWith('--')) args.files.push(a);
  }
  if (!args.taskId) throw new Error('Missing --task');
  if (!args.files.length) throw new Error('Missing --file');
  return args;
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.csv') return 'text/csv';
  if (ext === '.json') return 'application/json';
  if (ext === '.txt' || ext === '.md') return 'text/plain';
  return 'application/octet-stream';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = [];
  for (const file of args.files) {
    const abs = path.resolve(file);
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new Error(`Not a file: ${file}`);
    if (st.size > 10 * 1024 * 1024) throw new Error(`File too large: ${file}`);
    const bytes = await fs.readFile(abs);
    files.push({
      name: path.basename(abs),
      type: mimeFor(abs),
      size: bytes.length,
      dataBase64: bytes.toString('base64'),
    });
  }
  const headers = {'Content-Type': 'application/json'};
  if (process.env.SHEIN_BI_BASIC_AUTH) {
    headers.Authorization = `Basic ${Buffer.from(process.env.SHEIN_BI_BASIC_AUTH, 'utf8').toString('base64')}`;
  }
  const endpoint = new URL('/api/link-ops-assets', args.url.replace(/\/+$/, '') + '/');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({taskId: args.taskId, files}),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.ok) {
    throw new Error(payload.error || `HTTP ${res.status}`);
  }
  console.log(JSON.stringify({
    ok: true,
    taskId: args.taskId,
    uploaded: payload.assets?.map(a => ({id: a.id, name: a.originalName, kind: a.kind, bytes: a.bytes})) || [],
  }, null, 2));
}

main().catch(err => {
  console.error(err?.message || String(err));
  process.exit(1);
});
