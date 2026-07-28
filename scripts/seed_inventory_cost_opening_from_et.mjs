#!/usr/bin/env node
/**
 * Create an approved inventory-count reset from the nearest ET sellable stock
 * snapshot strictly before an accounting boundary. The prior-day close becomes
 * the next-day opening; using a same-day snapshot would double count that day's
 * receipts and sales when the event ledger is replayed. Dry-run is the default.
 */
import {spawn} from 'node:child_process';

function parseArgs(argv) {
  const args = {container: 'shein-warehouse-db', database: 'shein_bi', user: 'shein', execute: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') args.date = argv[++i];
    else if (arg === '--approval-ref') args.approvalRef = argv[++i];
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--container') args.container = argv[++i];
    else if (arg === '--database') args.database = argv[++i];
    else if (arg === '--user') args.user = argv[++i];
    else if (arg === '--allow-stale-snapshot') args.allowStaleSnapshot = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/seed_inventory_cost_opening_from_et.mjs --date YYYY-MM-DD --approval-ref REF [--execute] [--allow-stale-snapshot]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.date || ''))) throw new Error('--date YYYY-MM-DD is required');
  if (!String(args.approvalRef || '').trim()) throw new Error('--approval-ref is required');
  return args;
}

function literal(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function psql(args, sql) {
  const useWsl = process.platform === 'win32';
  const command = useWsl ? 'wsl' : (process.env.SHEIN_BI_DOCKER_COMMAND || 'sudo');
  const commandArgs = useWsl
    ? ['-d', process.env.SHEIN_BI_WSL_DISTRO || 'Ubuntu-24.04', '--', 'bash', '-lc', `sudo docker exec -i ${args.container} psql -U ${args.user} -d ${args.database} -v ON_ERROR_STOP=1`]
    : command === 'sudo'
      ? ['-n','docker','exec','-i',args.container,'psql','-U',args.user,'-d',args.database,'-v','ON_ERROR_STOP=1']
      : ['exec','-i',args.container,'psql','-U',args.user,'-d',args.database,'-v','ON_ERROR_STOP=1'];
  const child = spawn(command, commandArgs, {stdio: ['pipe','pipe','pipe'], windowsHide: true});
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  child.stdin.end(sql);
  const code = await new Promise(resolve => child.on('close', resolve));
  const out = Buffer.concat(stdout).toString('utf8');
  if (code !== 0) throw new Error(`psql failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(-5000)}`);
  return out;
}

function parseJson(output) {
  const line = output.split(/\r?\n/).map(value => value.trim()).find(value => value.startsWith('{'));
  return line ? JSON.parse(line) : null;
}

function proposalSql(args) {
  const date = `${literal(args.date)}::date`;
  return `
WITH latest_store AS (
  SELECT b.batch_id, b.target_date, b.fetched_at
  FROM raw.et_fetch_batch b
  WHERE b.ok IS TRUE AND b.mode <> 'smoke' AND b.target_date < ${date}
    AND EXISTS (SELECT 1 FROM fact.et_store_stock_snapshot s WHERE s.batch_id=b.batch_id)
  ORDER BY b.target_date DESC, b.fetched_at DESC NULLS LAST, b.batch_id DESC LIMIT 1
),
latest_box AS (
  SELECT b.batch_id, b.target_date, b.fetched_at
  FROM raw.et_fetch_batch b
  WHERE b.ok IS TRUE AND b.mode <> 'smoke' AND b.target_date < ${date}
    AND EXISTS (SELECT 1 FROM fact.et_box_stock_snapshot x WHERE x.batch_id=b.batch_id)
  ORDER BY b.target_date DESC, b.fetched_at DESC NULLS LAST, b.batch_id DESC LIMIT 1
),
sellable AS (
  SELECT
    coalesce(nullif(match_key,''),dim.product_match_key(standard_goods_sn)) AS match_key,
    sum(coalesce(real_quantity,quantity,0)) FILTER (
      WHERE storeroom_name LIKE '%09%' OR storeroom_name ILIKE '%散件%'
    ) AS quantity,
    (SELECT target_date FROM latest_store) AS store_snapshot_date,
    NULL::date AS box_snapshot_date
  FROM fact.et_store_stock_snapshot
  WHERE batch_id=(SELECT batch_id FROM latest_store)
  GROUP BY coalesce(nullif(match_key,''),dim.product_match_key(standard_goods_sn))

  UNION ALL

  SELECT
    coalesce(nullif(match_key,''),dim.product_match_key(standard_goods_sn)) AS match_key,
    sum(coalesce(real_quantity,quantity,0)) FILTER (
      WHERE storeroom_name LIKE '%01%' OR storeroom_name ILIKE '%整箱%'
    ) AS quantity,
    NULL::date,
    (SELECT target_date FROM latest_box) AS box_snapshot_date
  FROM fact.et_box_stock_snapshot
  WHERE batch_id=(SELECT batch_id FROM latest_box)
  GROUP BY coalesce(nullif(match_key,''),dim.product_match_key(standard_goods_sn))
),
stock AS (
  SELECT
    match_key,
    sum(coalesce(quantity,0)) AS opening_quantity,
    max(store_snapshot_date) AS store_snapshot_date,
    max(box_snapshot_date) AS box_snapshot_date
  FROM sellable
  WHERE coalesce(match_key,'') <> ''
  GROUP BY match_key
),
cost AS (
  SELECT
    dim.product_match_key(standard_goods_sn) AS match_key,
    sum(cost_sar) / nullif(sum(shipped_quantity),0) AS opening_unit_cost_sar,
    count(*) AS cost_batch_count,
    max(arrived_date) AS latest_cost_arrival
  FROM mart.product_cost_batch_timeline
  WHERE complete_batch
    AND arrived_date < ${date}
    AND coalesce(shipped_quantity,0) > 0
    AND cost_sar IS NOT NULL
  GROUP BY dim.product_match_key(standard_goods_sn)
)
SELECT
  'et-count-reset:' || ${literal(args.date)} || ':' || s.match_key AS opening_key,
  ${date} AS effective_date,
  s.match_key,
  s.opening_quantity,
  c.opening_unit_cost_sar,
  s.store_snapshot_date,
  s.box_snapshot_date,
  c.cost_batch_count,
  c.latest_cost_arrival
FROM stock s
JOIN cost c USING (match_key)
WHERE s.opening_quantity > 0 AND c.opening_unit_cost_sar > 0
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const proposal = proposalSql(args);
  const previewSql = `
\\pset tuples_only on
\\pset format unaligned
WITH proposal AS (${proposal})
SELECT jsonb_build_object(
  'mode','dry-run','effectiveDate',${literal(args.date)},
  'rows',count(*),'quantity',sum(opening_quantity),
  'missingSnapshotDays',jsonb_build_object(
    'store',${literal(args.date)}::date-max(store_snapshot_date),
    'box',${literal(args.date)}::date-max(box_snapshot_date)
  ),
  'sample',coalesce(jsonb_agg(to_jsonb(x) ORDER BY opening_quantity DESC) FILTER (WHERE rn<=10),'[]'::jsonb)
)::text
FROM (SELECT p.*,row_number() OVER (ORDER BY opening_quantity DESC) rn FROM proposal p) x;
`;
  const preview = parseJson(await psql(args, previewSql));
  if (!preview || preview.mode !== 'dry-run') throw new Error(`ET opening preview failed: ${JSON.stringify(preview)}`);
  if (!args.execute) {
    console.log(JSON.stringify({ok: true, execute: false, readback: preview}, null, 2));
    return;
  }

  if (Number(preview.rows || 0) <= 0) throw new Error('Refusing to create an empty inventory-cost opening');
  const snapshotGaps = preview.missingSnapshotDays || {};
  const staleSources = ['store', 'box'].filter(source => snapshotGaps[source] == null || Number(snapshotGaps[source]) !== 1);
  if (staleSources.length && !args.allowStaleSnapshot) {
    throw new Error(`Refusing non-prior-day ET opening snapshot: ${staleSources.map(source => `${source}=${snapshotGaps[source] ?? 'missing'}d`).join(' ')}; rerun only after refreshing ET or with --allow-stale-snapshot and an explicit approval reference`);
  }

  const sql = `
BEGIN;
WITH proposal AS (${proposal})
INSERT INTO fact.inventory_cost_opening(
  opening_key,effective_date,match_key,opening_quantity,opening_unit_cost_sar,
  approval_ref,source,status,raw_summary,updated_at
)
SELECT
  opening_key,effective_date,match_key,opening_quantity,opening_unit_cost_sar,
  ${literal(args.approvalRef)},'et_inventory_count_reset','approved',
  jsonb_build_object(
    'storeSnapshotDate',store_snapshot_date,
    'boxSnapshotDate',box_snapshot_date,
    'costBatchCount',cost_batch_count,
    'latestCostArrival',latest_cost_arrival,
    'rule','latest-strictly-before-boundary physical 09 loose plus 01 full-carton; prior-day required unless explicitly overridden; past-arrival weighted cost only',
    'snapshotGapDays',jsonb_build_object('store',${snapshotGaps.store == null ? 'null' : Number(snapshotGaps.store)},'box',${snapshotGaps.box == null ? 'null' : Number(snapshotGaps.box)}),
    'staleSnapshotOverride',${args.allowStaleSnapshot ? 'true' : 'false'}
  ),now()
FROM proposal
ON CONFLICT (opening_key) DO UPDATE SET
  opening_quantity=EXCLUDED.opening_quantity,
  opening_unit_cost_sar=EXCLUDED.opening_unit_cost_sar,
  approval_ref=EXCLUDED.approval_ref,
  source=EXCLUDED.source,
  status=EXCLUDED.status,
  raw_summary=EXCLUDED.raw_summary,
  updated_at=now();
COMMIT;
\\pset tuples_only on
\\pset format unaligned
SELECT jsonb_build_object(
  'mode','executed','effectiveDate',${literal(args.date)},
  'rows',count(*),'quantity',sum(opening_quantity),
  'minUnitCost',min(opening_unit_cost_sar),'maxUnitCost',max(opening_unit_cost_sar),
  'approvalRef',max(approval_ref)
)::text
FROM fact.inventory_cost_opening
WHERE source='et_inventory_count_reset' AND effective_date=${literal(args.date)}::date;
`;
  const readback = parseJson(await psql(args, sql));
  if (!readback || readback.mode !== 'executed') throw new Error(`ET opening readback failed: ${JSON.stringify(readback)}`);
  console.log(JSON.stringify({ok: true, execute: true, preview, readback}, null, 2));
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
