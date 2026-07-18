#!/usr/bin/env node
/** Freeze or reopen inventory-cost accounting periods with an auditable approval reference. */
import {spawn} from 'node:child_process';

function parseArgs(argv) {
  const args = {container: 'shein-warehouse-db', database: 'shein_bi', user: 'shein'};
  args.action = String(argv.shift() || '').toLowerCase();
  args.month = String(argv.shift() || '');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--approval-ref') args.approvalRef = argv[++i];
    else if (arg === '--allow-unvalued') args.allowUnvalued = true;
    else if (arg === '--container') args.container = argv[++i];
    else if (arg === '--database') args.database = argv[++i];
    else if (arg === '--user') args.user = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/manage_accounting_period.mjs freeze|reopen YYYY-MM --approval-ref REF [--allow-unvalued]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['freeze', 'reopen'].includes(args.action)) throw new Error('action must be freeze or reopen');
  if (!/^\d{4}-\d{2}$/.test(args.month)) throw new Error('month must be YYYY-MM');
  if (!String(args.approvalRef || '').trim()) throw new Error('--approval-ref is required');
  args.monthStart = `${args.month}-01`;
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

function parseJsonOutput(output) {
  const line = output.split(/\r?\n/).map(value => value.trim()).find(value => value.startsWith('{'));
  return line ? JSON.parse(line) : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const currentParts = new Intl.DateTimeFormat('en-US', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit'})
    .formatToParts(new Date()).reduce((acc, part) => ({...acc, [part.type]: part.value}), {});
  const currentMonth = `${currentParts.year}-${currentParts.month}`;
  if (args.action === 'freeze' && args.month >= currentMonth) {
    throw new Error(`Refusing to freeze an open/current month: requested=${args.month} current=${currentMonth}`);
  }
  const targetStatus = args.action === 'freeze' ? 'frozen' : 'reopened';
  const sql = `
BEGIN;
DO $$
DECLARE
  v_unvalued bigint;
  v_period_rows bigint;
  v_latest_run text;
  v_run_cutoff timestamptz;
BEGIN
  SELECT count(*) INTO v_period_rows
  FROM fact.inventory_cost_ledger
  WHERE effective_at::date >= ${literal(args.monthStart)}::date
    AND effective_at::date < (${literal(args.monthStart)}::date + interval '1 month');
  IF ${args.action === 'freeze' ? 'v_period_rows = 0' : 'false'} THEN
    RAISE EXCEPTION 'refusing to freeze an empty accounting month: %', ${literal(args.month)};
  END IF;
  SELECT count(*) INTO v_unvalued
  FROM fact.inventory_cost_ledger
  WHERE event_type='sale'
    AND unvalued_quantity > 0
    AND effective_at::date >= ${literal(args.monthStart)}::date
    AND effective_at::date < (${literal(args.monthStart)}::date + interval '1 month');
  IF ${args.action === 'freeze' && !args.allowUnvalued ? 'v_unvalued > 0' : 'false'} THEN
    RAISE EXCEPTION 'period has % unvalued sale rows; repair opening cost or pass --allow-unvalued with explicit approval', v_unvalued;
  END IF;
  SELECT run_id,source_cutoff_at INTO v_latest_run,v_run_cutoff
  FROM ops.inventory_cost_run
  WHERE status='completed'
    AND (rebuild_from IS NULL OR rebuild_from <= ${literal(args.monthStart)}::date)
    AND source_cutoff_at >= (${literal(args.monthStart)}::date + interval '1 month')
    AND completed_at >= (${literal(args.monthStart)}::date + interval '1 month')
    AND EXISTS (
      SELECT 1
      FROM fact.inventory_cost_ledger l
      WHERE l.ledger_version = ops.inventory_cost_run.ledger_version
        AND l.effective_at::date >= ${literal(args.monthStart)}::date
        AND l.effective_at::date < (${literal(args.monthStart)}::date + interval '1 month')
    )
  ORDER BY completed_at DESC NULLS LAST
  LIMIT 1;
  IF ${args.action === 'freeze' ? 'v_latest_run IS NULL' : 'false'} THEN
    RAISE EXCEPTION 'no completed inventory cost run fully covers accounting month % through its month-end cutoff', ${literal(args.month)};
  END IF;
  INSERT INTO ops.accounting_period_close(month_start,status,source_cutoff_at,close_run_id,approval_ref,closed_at,updated_at)
  VALUES (${literal(args.monthStart)}::date,${literal(targetStatus)},${args.action === 'freeze' ? 'v_run_cutoff' : 'now()'},v_latest_run,${literal(args.approvalRef)},${args.action === 'freeze' ? 'now()' : 'NULL'},now())
  ON CONFLICT (month_start) DO UPDATE SET
    status=EXCLUDED.status,
    source_cutoff_at=EXCLUDED.source_cutoff_at,
    close_run_id=EXCLUDED.close_run_id,
    approval_ref=EXCLUDED.approval_ref,
    closed_at=EXCLUDED.closed_at,
    updated_at=now();
END $$;
COMMIT;
\\pset tuples_only on
\\pset format unaligned
SELECT jsonb_build_object(
  'monthStart',c.month_start,
  'status',c.status,
  'sourceCutoffAt',c.source_cutoff_at,
  'closeRunId',c.close_run_id,
  'approvalRef',c.approval_ref,
  'closedAt',c.closed_at,
  'unvaluedSaleRows',(
    SELECT count(*) FROM fact.inventory_cost_ledger l
    WHERE l.event_type='sale' AND l.unvalued_quantity > 0
      AND l.effective_at::date >= c.month_start
      AND l.effective_at::date < c.month_start + interval '1 month'
  ),
  'ledgerRows',(
    SELECT count(*) FROM fact.inventory_cost_ledger l
    WHERE l.effective_at::date >= c.month_start
      AND l.effective_at::date < c.month_start + interval '1 month'
  )
)::text
FROM ops.accounting_period_close c
WHERE c.month_start=${literal(args.monthStart)}::date;
`;
  const readback = parseJsonOutput(await psql(args, sql));
  if (!readback || readback.status !== targetStatus || readback.approvalRef !== args.approvalRef) {
    throw new Error(`Accounting period readback failed: ${JSON.stringify(readback)}`);
  }
  console.log(JSON.stringify({ok: true, action: args.action, readback}, null, 2));
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
