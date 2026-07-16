#!/usr/bin/env node
/**
 * Import product cost batches and monthly storage fees into the BI warehouse.
 *
 * Cost batches:
 * - One row = one shipping/purchase batch for one standard product.
 * - Batches missing first-leg freight are stored but excluded from unit cost.
 *
 * Storage fees:
 * - One row = one month total warehouse/storage fee.
 * - Used only for month/group total profit allocation, never forced onto SKU profit.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {normalizeGoodsSnDetailed} from '../lib/product_sku_normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PYTHON = 'C:\\Users\\dushengyi\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
const CNY_TO_SAR = Number(process.env.SHEIN_COST_CNY_TO_SAR || (1 / 1.8));

function parseArgs(argv) {
  const args = {
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    file: '',
    dir: path.join(ROOT, 'inputs', 'costs'),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--file') args.file = path.resolve(argv[++i]);
    else if (a === '--dir') args.dir = path.resolve(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function cleanKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[()（）【】\[\]_\-:：/\\]/g, '')
    .toLowerCase();
}

function pick(row, aliases) {
  const entries = Object.entries(row || {});
  const wanted = aliases.map(cleanKey);
  for (const [k, v] of entries) {
    const kk = cleanKey(k);
    if (wanted.includes(kk)) return v;
  }
  for (const [k, v] of entries) {
    const kk = cleanKey(k);
    if (wanted.some(w => kk.includes(w) || w.includes(kk))) return v;
  }
  return '';
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value).normalize('NFKC').trim();
  if (!s || s === '-' || s === '--') return null;
  s = s
    .replace(/(SAR|CNY|RMB|USD|AED|ر\.س|人民币|元|￥|¥)/gi, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '')
    .replace(/%$/, '')
    .replace(/[^\d.+\-Ee]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function text(value) {
  return String(value ?? '').trim();
}

function monthStart(value) {
  const s = text(value);
  if (!s) return '';
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-01`;
  m = s.match(/^(\d{4})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-01`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  return '';
}

function dateOnly(value) {
  const s = text(value);
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}

function currency(value, fallback = 'CNY') {
  const s = text(value).toUpperCase();
  if (/SAR|ر\.س|里亚尔|沙特/.test(s)) return 'SAR';
  if (/RMB|CNY|￥|人民币|元/.test(s)) return 'CNY';
  return fallback;
}

function toSar(amount, ccy) {
  const n = num(amount);
  if (n === null) return null;
  const c = currency(ccy, 'CNY');
  if (c === 'SAR') return n;
  if (c === 'CNY' || c === 'RMB') return n * CNY_TO_SAR;
  return n;
}

function volumeL(lengthCm, widthCm, heightCm) {
  const l = num(lengthCm);
  const w = num(widthCm);
  const h = num(heightCm);
  if (l === null || w === null || h === null) return null;
  return l * w * h / 1000;
}

function hasMeaningful(row) {
  return Object.values(row || {}).some(v => text(v) !== '');
}

function rowLooksStorage(row) {
  const fee = pick(row, ['仓储费', '仓储费金额', '仓租', '仓储成本', '月仓储费', '总仓储费']);
  const month = pick(row, ['月份', '年月', '月份开始', 'month', 'month_start']);
  return text(month) && num(fee) !== null;
}

function rowLooksCost(row) {
  const sku = pick(row, ['货号', '标准货号', '商品货号', 'goods_sn', 'sku', '型号']);
  const qty = pick(row, ['发货数量', '数量', '出货数量', '入仓数量', '总数量']);
  const goodsCost = pick(row, ['货款金额', '商品成本', '采购成本', '货值', '货款', '成本金额']);
  return text(sku) && (num(qty) !== null || num(goodsCost) !== null);
}

function buildCostRow(row, sourceFile, sourceSheet, idx) {
  const rawGoodsSn = text(pick(row, ['货号', '标准货号', '商品货号', 'goods_sn', 'sku', '型号']));
  const title = text(pick(row, ['品名', '商品名称', '标题', '产品名称']));
  const normalized = normalizeGoodsSnDetailed(rawGoodsSn, {goodsTitle: title});
  const batchNo = text(pick(row, ['发货单号', '发货申请单', '发货申请单号', '批次号', '发货批次', '采购单号', '单号'])) || `${path.basename(sourceFile)}-${sourceSheet}-${idx}`;
  const shippedDate = dateOnly(pick(row, ['发货日期', '发货时间', '发货日', '出货日期', '出货时间', 'shipping_date', 'shipped_date']));
  const arrivedDate = dateOnly(pick(row, ['到仓/派送日期', '到仓日期', '到仓时间', '派送日期', '派送时间', '入仓日期', '入库日期', 'arrived_date', 'warehouse_arrived_date']));
  const shippedQuantity = num(pick(row, ['发货数量', '数量', '出货数量', '入仓数量', '总数量']));
  const goodsCost = num(pick(row, ['货款金额', '商品成本', '采购成本', '货值', '货款', '成本金额']));
  const firstLegFreight = num(pick(row, ['头程运输费金额', '头程运费', '头程运输费', '头程费用', '运输费金额']));
  const otherCost = num(pick(row, ['其他费用', '其他成本', '杂费']));
  const finalUnitCostSar = num(pick(row, ['单台总成本SAR', '单台总成本', '单件总成本SAR', '单件总成本', '单位总成本SAR', '单位成本SAR', 'unit_cost_sar']));
  const ccy = currency(pick(row, ['币种', '货币', 'currency']), 'CNY');
  const totalNative = num(pick(row, ['总成本', '总成本金额', '合计成本', '总金额'])) ?? (
    (goodsCost ?? 0) + (firstLegFreight ?? 0) + (otherCost ?? 0)
  );
  const complete = Boolean(rawGoodsSn && shippedQuantity && shippedQuantity > 0 && goodsCost !== null && firstLegFreight !== null);
  const ignored = complete ? '' : [
    !rawGoodsSn ? '缺货号' : '',
    !(shippedQuantity && shippedQuantity > 0) ? '缺发货数量' : '',
    goodsCost === null ? '缺货款金额' : '',
    firstLegFreight === null ? '缺头程运输费金额' : '',
  ].filter(Boolean).join('；');
  const costSar = complete ? (finalUnitCostSar !== null ? finalUnitCostSar * shippedQuantity : toSar(totalNative, ccy)) : null;
  const l = pick(row, ['长cm', '长度cm', '长', 'length']);
  const w = pick(row, ['宽cm', '宽度cm', '宽', 'width']);
  const h = pick(row, ['高cm', '高度cm', '高', 'height']);
  return {
    batch_key: `${normalized.canonical || rawGoodsSn}__${batchNo}__${rel(sourceFile)}__${sourceSheet}__${idx}`,
    standard_goods_sn: normalized.canonical || rawGoodsSn,
    raw_goods_sn: rawGoodsSn,
    batch_no: batchNo,
    shipped_date: shippedDate,
    arrived_date: arrivedDate,
    shipped_quantity: shippedQuantity,
    goods_cost_amount: goodsCost,
    first_leg_freight_amount: firstLegFreight,
    other_cost_amount: otherCost,
    total_cost_amount: totalNative,
    currency_code: ccy,
    cost_sar: costSar,
    unit_cost_sar: complete && shippedQuantity ? (finalUnitCostSar !== null ? finalUnitCostSar : costSar / shippedQuantity) : null,
    complete_batch: complete,
    ignored_reason: ignored,
    purchase_unit_price: num(pick(row, ['采购单价', '进货价', '单价'])),
    length_cm: num(l),
    width_cm: num(w),
    height_cm: num(h),
    volume_l: volumeL(l, w, h),
    weight_kg: num(pick(row, ['重量kg', '重量', '单品重量kg'])),
    source_file: rel(sourceFile),
    source_sheet: sourceSheet,
    source_row_no: idx,
    raw_summary: row,
  };
}

function buildStorageRow(row, sourceFile, sourceSheet, idx) {
  const month = monthStart(pick(row, ['月份', '年月', '月份开始', 'month', 'month_start']));
  const fee = num(pick(row, ['仓储费', '仓储费金额', '仓租', '仓储成本', '月仓储费', '总仓储费']));
  const ccy = currency(pick(row, ['币种', '货币', 'currency']), 'SAR');
  return {
    month_start: month,
    total_fee_amount: fee,
    currency_code: ccy,
    total_fee_sar: toSar(fee, ccy === 'CNY' ? 'CNY' : 'SAR'),
    note: text(pick(row, ['备注', '说明', 'note'])),
    source_file: rel(sourceFile),
    raw_summary: {...row, sourceSheet, sourceRowNo: idx},
  };
}

async function parseWorkbookWithPython(file) {
  const py = pythonCommand();
  const code = String.raw`
import json, sys, os, csv
file = sys.argv[1]
ext = os.path.splitext(file)[1].lower()
out = []

def unique_headers(headers):
    counts = {}
    result = []
    for idx, header in enumerate(headers):
        base = '' if header is None else str(header).strip()
        if not base:
            base = '__blank_%d' % (idx + 1)
        counts[base] = counts.get(base, 0) + 1
        if counts[base] == 1:
            result.append(base)
        else:
            result.append('%s__%d' % (base, counts[base]))
    return result

if ext in ['.xlsx', '.xlsm']:
    import openpyxl
    wb = openpyxl.load_workbook(file, data_only=True, read_only=True)
    for ws in wb.worksheets:
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            continue
        header_idx = None
        for i, row in enumerate(rows[:20]):
            nonempty = [str(x).strip() for x in row if x is not None and str(x).strip()]
            if len(nonempty) >= 2:
                header_idx = i
                break
        if header_idx is None:
            continue
        headers = unique_headers(rows[header_idx])
        for ridx, row in enumerate(rows[header_idx+1:], start=header_idx+2):
            obj = {}
            for h, v in zip(headers, row):
                if not h:
                    continue
                if hasattr(v, 'isoformat'):
                    v = v.isoformat()
                obj[h] = '' if v is None else v
            out.append({'sheet': ws.title, 'rowNo': ridx, 'row': obj})
elif ext == '.csv':
    with open(file, 'r', encoding='utf-8-sig', newline='') as f:
        reader = csv.reader(f)
        try:
            headers = unique_headers(next(reader))
        except StopIteration:
            headers = []
        for i, row in enumerate(reader, start=2):
            obj = {}
            for idx, h in enumerate(headers):
                if not h:
                    continue
                obj[h] = row[idx] if idx < len(row) else ''
            out.append({'sheet': 'CSV', 'rowNo': i, 'row': obj})
else:
    raise SystemExit('unsupported file type: ' + ext)
print(json.dumps(out, ensure_ascii=False))
`;
  const res = spawnSync(py, ['-c', code, file], {encoding: 'utf8', windowsHide: true, maxBuffer: 80 * 1024 * 1024});
  if (res.status !== 0) throw new Error(`parse file failed: ${res.stderr || res.stdout}`);
  return JSON.parse(res.stdout || '[]');
}

function commandExists(command) {
  const res = spawnSync(command, ['--version'], {encoding: 'utf8', windowsHide: true, timeout: 10_000});
  return res.status === 0;
}

function pythonCommand() {
  if (process.platform === 'win32' && fssync.existsSync(DEFAULT_PYTHON)) return DEFAULT_PYTHON;
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const candidate of candidates) {
    if (commandExists(candidate)) return candidate;
  }
  throw new Error(`Python runtime not found; tried ${candidates.join(', ')}`);
}

function csvEscape(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvLine(values) {
  return values.map(csvEscape).join(',') + '\n';
}

function qIdent(ident) {
  return ident.split('.').map(x => `"${x.replace(/"/g, '""')}"`).join('.');
}

async function runPsqlScript(args, script) {
  const psql = psqlSpawnCommand(args);
  const child = spawn(psql.command, psql.args, {cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.stdin.write(script);
  child.stdin.end();
  const code = await new Promise(resolve => child.on('close', resolve));
  if (code !== 0) throw new Error(`psql failed (${code})\n${stderr}\n${stdout.slice(-2000)}`);
  return stdout.trim();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function dockerPrefix() {
  if (process.platform === 'win32') return 'sudo ';
  if (typeof process.getuid === 'function' && process.getuid() === 0) return '';
  return 'sudo ';
}

function psqlSpawnCommand(args) {
  const psql = `${dockerPrefix()}docker exec -i ${shellQuote(args.container)} psql -U ${shellQuote(args.user)} -d ${shellQuote(args.database)} -v ON_ERROR_STOP=1`;
  if (process.platform === 'win32') {
    return {
      command: 'wsl',
      args: ['-d', args.distro, '--', 'bash', '-lc', psql],
    };
  }
  return {
    command: 'bash',
    args: ['-lc', psql],
  };
}

function sqlLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function appendStageUpsert(script, table, columns, conflictColumns, rows, stageSuffix) {
  if (!rows.length) return script;
  const stage = `stage_${table.replace(/\W/g, '_')}_${stageSuffix}`;
  const sqlColumns = columns.map(qIdent).join(', ');
  const updateSet = columns
    .filter(c => !conflictColumns.includes(c))
    .map(c => `${qIdent(c)} = EXCLUDED.${qIdent(c)}`)
    .join(',\n    ');
  script += `CREATE TEMP TABLE "${stage}" (LIKE ${qIdent(table)} INCLUDING DEFAULTS) ON COMMIT DROP;\n`;
  script += `COPY "${stage}" (${sqlColumns}) FROM STDIN WITH (FORMAT csv, NULL '');\n`;
  for (const row of rows) script += csvLine(columns.map(c => row[c]));
  script += '\\.\n';
  script += `INSERT INTO ${qIdent(table)} (${sqlColumns})\n`;
  script += `SELECT ${sqlColumns} FROM "${stage}"\n`;
  script += `ON CONFLICT (${conflictColumns.map(qIdent).join(', ')}) DO UPDATE SET\n    ${updateSet};\n`;
  return script;
}

async function replaceImportedRowsAtomically(args, files, costRows, storageRows) {
  const sourceFiles = [...new Set(files.map(file => rel(file)).filter(Boolean))];
  const results = [
    {operation: 'replace-source-files', sourceFiles: sourceFiles.length, dryRun: args.dryRun},
    {table: 'fact.product_cost_batch', rows: costRows.length, ...(args.dryRun ? {dryRun: true} : {})},
    {table: 'fact.monthly_storage_fee', rows: storageRows.length, ...(args.dryRun && storageRows.length ? {dryRun: true} : {})},
  ];
  if (args.dryRun || !sourceFiles.length) return results;

  const costColumns = [
    'batch_key','standard_goods_sn','raw_goods_sn','batch_no','shipped_date','arrived_date','shipped_quantity',
    'goods_cost_amount','first_leg_freight_amount','other_cost_amount','total_cost_amount',
    'currency_code','cost_sar','unit_cost_sar','complete_batch','ignored_reason',
    'purchase_unit_price','length_cm','width_cm','height_cm','volume_l','weight_kg',
    'source_file','source_sheet','source_row_no','raw_summary'
  ];
  const storageColumns = [
    'month_start','total_fee_amount','currency_code','total_fee_sar','note','source_file','raw_summary'
  ];
  const inList = sourceFiles.map(sqlLiteral).join(', ');
  const stageSuffix = `${Date.now()}_${process.pid}`;
  let script = 'BEGIN;\n';
  script += `DELETE FROM fact.product_cost_batch WHERE source_file IN (${inList});\n`;
  script += `DELETE FROM fact.monthly_storage_fee WHERE source_file IN (${inList});\n`;
  script = appendStageUpsert(script, 'fact.product_cost_batch', costColumns, ['batch_key'], costRows, `${stageSuffix}_cost`);
  script = appendStageUpsert(script, 'fact.monthly_storage_fee', storageColumns, ['month_start'], storageRows, `${stageSuffix}_storage`);
  script += 'COMMIT;\n';
  await runPsqlScript(args, script);
  return results;
}

async function ensureSchema(args) {
  const schema = await fs.readFile(path.join(ROOT, 'infra', 'warehouse', 'schema.sql'), 'utf8');
  if (!args.dryRun) await runPsqlScript(args, schema);
}

async function importFile(file) {
  const parsed = await parseWorkbookWithPython(file);
  const costRows = [];
  const storageRows = [];
  for (const item of parsed) {
    const row = item.row || {};
    if (!hasMeaningful(row)) continue;
    if (rowLooksStorage(row)) {
      const s = buildStorageRow(row, file, item.sheet || '', item.rowNo || 0);
      if (s.month_start && s.total_fee_sar !== null) storageRows.push(s);
      continue;
    }
    if (rowLooksCost(row)) {
      const c = buildCostRow(row, file, item.sheet || '', item.rowNo || 0);
      if (c.standard_goods_sn) costRows.push(c);
    }
  }
  return {file, costRows, storageRows};
}

async function findInputFiles(args) {
  if (args.file) return [args.file];
  if (!fssync.existsSync(args.dir)) return [];
  const names = await fs.readdir(args.dir);
  return names
    .filter(x => /\.(xlsx|xlsm|csv)$/i.test(x) && !/^~\$/.test(x))
    .filter(x => !/(模板|template|sample|示例)/i.test(x))
    .map(x => path.join(args.dir, x))
    .sort();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = await findInputFiles(args);
  if (!files.length) {
    console.log(JSON.stringify({ok: true, message: 'no cost files found', dir: rel(args.dir)}, null, 2));
    return;
  }
  const allCost = [];
  const allStorage = [];
  const perFile = [];
  for (const file of files) {
    const result = await importFile(file);
    allCost.push(...result.costRows);
    allStorage.push(...result.storageRows);
    perFile.push({file: rel(file), costRows: result.costRows.length, storageRows: result.storageRows.length});
  }
  await ensureSchema(args);
  const results = await replaceImportedRowsAtomically(args, files, allCost, allStorage);
  const complete = allCost.filter(r => r.complete_batch).length;
  const ignored = allCost.length - complete;
  const missingFreight = allCost.filter(r => /头程/.test(r.ignored_reason || '')).length;
  console.log(JSON.stringify({
    ok: true,
    dryRun: args.dryRun,
    files: perFile,
    costRows: allCost.length,
    completeCostRows: complete,
    ignoredCostRows: ignored,
    missingFirstLegFreightRows: missingFreight,
    storageRows: allStorage.length,
    cnyToSar: CNY_TO_SAR,
    results,
  }, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
