import fs from 'node:fs/promises';
import fssync from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_FIELDS = new Set([
  'first_shelf_time',
  'inventory_recovery_date',
  'relisted_at',
  'last_shelf_time',
  'marketing_source_at',
  'openapi_fetched_at',
]);

const NUMBER_FIELDS = new Set([
  'c7_exposure',
  'c7_sale_cnt',
  'c30_sale_cnt',
  'current_inventory',
]);

const BASE_FIELDS = [
  'store',
  'skc',
  'standard_goods_sn',
  'current_status',
  'c7_exposure',
  'c7_sale_cnt',
  'c30_sale_cnt',
  'new_goods_tag',
  'first_shelf_time',
  'inventory_recovery_date',
  'relisted_at',
  'last_shelf_time',
  'current_inventory',
  'marketing_effective',
  'retire_candidate_bucket',
  'retire_candidate_reason',
  'missing_inventory_dates',
  'missing_status_dates',
  'evidence_issues',
];

const FIELD_LABELS = {
  store: '店铺标识',
  skc: 'SKC',
  standard_goods_sn: '标准货号',
  current_status: '当前状态',
  c7_exposure: '近7天曝光',
  c7_sale_cnt: '近7天销量',
  c30_sale_cnt: '近30天销量',
  new_goods_tag: '新品标签',
  first_shelf_time: '首次上架时间',
  inventory_recovery_date: '库存恢复日期',
  relisted_at: '重新在售时间',
  last_shelf_time: '最近上架时间',
  current_inventory: '当前库存',
  marketing_source_at: '营销采集时间（北京时间）',
  openapi_fetched_at: '当前状态采集时间',
  marketing_source: '营销证据来源',
  recovery_evidence_complete: '恢复历史是否完整',
  marketing_effective: '营销活动是否生效',
  retire_candidate_bucket: '输入候选分组',
  retire_candidate_reason: '输入候选原因',
  missing_inventory_dates: '缺失库存日期列表',
  missing_status_dates: '缺失状态日期列表',
  evidence_issues: '证据问题列表',
};

const COLORS = {
  navy: '#17324D',
  teal: '#0F766E',
  pale: '#E8F3F1',
  amber: '#FFF3CD',
  redPale: '#FDECEC',
  greenPale: '#D1FAE5',
  light: '#F5F7FA',
  border: '#D7DEE7',
  body: '#1F2937',
  muted: '#5B6470',
};

const FONT = 'Arial';
const MAX_CELL_TEXT_LENGTH = 32767;

function usage() {
  return [
    'Usage:',
    '  node scripts/build_link_retire_review_workbook.mjs --input <analysis.json> --output <absolute.xlsx> [--qa-dir <dir>]',
    '',
    'Artifact Tool loading:',
    '  pass --artifact-tool-entry <path-to-artifact_tool.mjs> or set ARTIFACT_TOOL_ENTRY',
  ].join('\n');
}

function parseArgs(argv) {
  const allowed = new Set(['input', 'output', 'qaDir', 'artifactToolEntry']);
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--help' || raw === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (!raw.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${raw}`);
    }

    const equalsIndex = raw.indexOf('=');
    const rawKey = equalsIndex >= 0 ? raw.slice(2, equalsIndex) : raw.slice(2);
    const key = rawKey.replace(/-([a-z])/g, (_match, character) => character.toUpperCase());
    if (!allowed.has(key)) {
      throw new Error(`Unknown argument: --${rawKey}`);
    }

    const inlineValue = equalsIndex >= 0 ? raw.slice(equalsIndex + 1) : undefined;
    const nextValue = inlineValue === undefined && argv[index + 1] && !argv[index + 1].startsWith('--')
      ? argv[++index]
      : inlineValue;
    if (nextValue === undefined || nextValue === '') {
      throw new Error(`Missing value for --${rawKey}`);
    }
    result[key] = nextValue;
  }

  if (!result.input) {
    throw new Error('Missing required argument: --input <analysis.json>');
  }
  if (!result.output) {
    throw new Error('Missing required argument: --output <absolute.xlsx>');
  }
  if (!path.isAbsolute(result.output)) {
    throw new Error(`--output must be an absolute .xlsx path: ${result.output}`);
  }
  if (path.extname(result.output).toLowerCase() !== '.xlsx') {
    throw new Error(`--output must end with .xlsx: ${result.output}`);
  }

  return {
    input: path.resolve(result.input),
    output: result.output,
    qaDir: result.qaDir ? path.resolve(result.qaDir) : null,
    artifactToolEntry: result.artifactToolEntry || process.env.ARTIFACT_TOOL_ENTRY || '',
  };
}

function artifactToolCandidates(configuredPath) {
  const resolved = path.resolve(configuredPath);
  const candidates = [resolved];
  let isDirectory = false;
  try {
    isDirectory = fssync.statSync(resolved).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (isDirectory) {
    candidates.push(
      path.join(resolved, 'dist', 'artifact_tool.mjs'),
      path.join(resolved, 'artifact_tool.mjs'),
      path.join(resolved, '@oai', 'artifact-tool', 'dist', 'artifact_tool.mjs'),
      path.join(resolved, 'node_modules', '@oai', 'artifact-tool', 'dist', 'artifact_tool.mjs'),
    );
  }
  return [...new Set(candidates)];
}

async function loadArtifactTool(configuredPath) {
  const explicit = String(configuredPath || '').trim();
  if (explicit) {
    const entry = artifactToolCandidates(explicit).find(candidate => fssync.existsSync(candidate) && fssync.statSync(candidate).isFile());
    if (!entry) {
      throw new Error(`@oai/artifact-tool entry not found under: ${path.resolve(explicit)}`);
    }
    return import(pathToFileURL(entry).href);
  }

  try {
    return await import('@oai/artifact-tool');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load @oai/artifact-tool. Pass --artifact-tool-entry <path> or set ARTIFACT_TOOL_ENTRY. ${detail}`);
  }
}

function assertInputDocument(document, inputPath) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`Input must be a JSON object: ${inputPath}`);
  }
  if (!document.summary || typeof document.summary !== 'object' || Array.isArray(document.summary)) {
    throw new Error('Input must contain an object at summary');
  }
  if (!Array.isArray(document.evaluated)) {
    throw new Error('Input must contain an array at evaluated');
  }
  for (let index = 0; index < document.evaluated.length; index += 1) {
    const row = document.evaluated[index];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`evaluated[${index}] must be an object`);
    }
  }
}

function classifyForPresentation(row) {
  const bucket = row?.retire_candidate_bucket;
  if (bucket === 'candidate' || String(bucket || '').trim() === 'candidate') return 'candidate';
  if (bucket === 'cannotJudge' || String(bucket || '').trim() === 'cannotJudge') return 'cannotJudge';
  return 'other';
}

function collectFields(rows) {
  const fields = new Set(BASE_FIELDS);
  for (const row of rows) {
    for (const key of Object.keys(row)) fields.add(key);
  }
  const extras = [...fields].filter(key => !BASE_FIELDS.includes(key)).sort((left, right) => left.localeCompare(right));
  return [...BASE_FIELDS, ...extras];
}

function jsonCellValue(value, fieldName, rowIndex) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  if (serialized.length > MAX_CELL_TEXT_LENGTH) {
    throw new Error(`JSON field exceeds Excel cell limit at evaluated[${rowIndex - 1}].${fieldName}`);
  }
  return serialized;
}

function numericCellValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value.trim());
    if (Number.isFinite(number)) return number;
  }
  return value;
}

function dateCellValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(text) && Number.isFinite(Date.parse(text))) return new Date(Date.parse(text)+8*3600000);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):?(\d{2})?(?::?(\d{2})(?:\.(\d+))?)?)?/);
  if (!match) return value;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  const millisecond = Number(String(match[7] || '').slice(0, 3).padEnd(3, '0')) || 0;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  return Number.isNaN(date.getTime()) ? value : date;
}

function cellValue(value, fieldName, rowIndex) {
  if (value === null || value === undefined || value === '') return null;
  if (DATE_FIELDS.has(fieldName)) return dateCellValue(value);
  if (NUMBER_FIELDS.has(fieldName)) return numericCellValue(value);
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return jsonCellValue(value, fieldName, rowIndex);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

function columnLetter(zeroBasedIndex) {
  let number = zeroBasedIndex + 1;
  let result = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

function displayWidth(fieldName) {
  if (fieldName === 'source_row_index') return 13;
  if (fieldName === '审核决定') return 14;
  if (fieldName === 'store') return 14;
  if (fieldName === 'skc') return 20;
  if (fieldName === 'standard_goods_sn') return 22;
  if (fieldName === 'current_status') return 20;
  if (NUMBER_FIELDS.has(fieldName)) return 14;
  if (DATE_FIELDS.has(fieldName)) return 19;
  if (fieldName === 'marketing_effective') return 18;
  if (fieldName === 'retire_candidate_bucket') return 23;
  if (fieldName === 'retire_candidate_reason') return 40;
  if (fieldName === 'evidence_issues') return 44;
  if (fieldName === 'new_goods_tag') return 18;
  return Math.min(32, Math.max(16, fieldName.length + 4));
}

function fieldDescription(fieldName) {
  return FIELD_LABELS[fieldName] || '输入字段原样保留';
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex');
}

function baseSheetFormat(sheet, lastColumn) {
  sheet.getRange(`A1:${lastColumn}40`).format.font = { name: FONT, size: 10, color: COLORS.body };
  sheet.getRange(`A1:${lastColumn}40`).format.verticalAlignment = 'center';
  sheet.getRange(`A1:${lastColumn}40`).format.wrapText = false;
  sheet.showGridLines = false;
}

function writeMergedRow(sheet, range, value, format) {
  const merged = sheet.getRange(range);
  merged.merge();
  merged.values = [[value]];
  merged.format = format;
}

function writeBucketSheet({ workbook, name, title, note, rows, fields, editable, tableName, freezeColumns }) {
  const sheet = workbook.worksheets.add(name);
  const firstFieldColumn = editable ? 2 : 1;
  const headers = editable
    ? ['审核决定', 'source_row_index', ...fields]
    : ['source_row_index', ...fields];
  const lastColumn = columnLetter(headers.length - 1);
  const dataStart = 5;
  const dataEnd = dataStart + rows.length - 1;
  const tableEnd = Math.max(4, dataEnd);

  baseSheetFormat(sheet, lastColumn);
  writeMergedRow(sheet, `A1:${lastColumn}1`, title, {
    fill: COLORS.navy,
    font: { name: FONT, bold: true, color: '#FFFFFF', size: 15 },
    rowHeight: 30,
    verticalAlignment: 'center',
  });
  writeMergedRow(sheet, `A2:${lastColumn}2`, note, {
    fill: editable ? COLORS.pale : COLORS.light,
    font: { name: FONT, color: editable ? COLORS.teal : COLORS.muted, bold: true },
    rowHeight: 30,
    verticalAlignment: 'center',
    wrapText: true,
  });

  sheet.getRange(`A4:${lastColumn}4`).values = [name==='来源数据' ? headers : headers.map(h=>h==='source_row_index'?'来源行号':FIELD_LABELS[h] || h)];
  sheet.getRange(`A4:${lastColumn}4`).format = {
    fill: COLORS.teal,
    font: { name: FONT, bold: true, color: '#FFFFFF', size: 10 },
    wrapText: true,
    horizontalAlignment: 'center',
    verticalAlignment: 'center',
    rowHeight: 38,
    borders: { preset: 'outside', style: 'thin', color: COLORS.border },
  };

  const rowValues = rows.map(({ row, sourceRowIndex }) => {
    const sourceValues = fields.map(fieldName => cellValue(row[fieldName], fieldName, sourceRowIndex));
    return editable ? ['待确认', sourceRowIndex, ...sourceValues] : [sourceRowIndex, ...sourceValues];
  });
  if (rowValues.length > 0) {
    sheet.getRange(`A${dataStart}:${lastColumn}${dataEnd}`).values = rowValues;
    sheet.getRange(`A${dataStart}:${lastColumn}${dataEnd}`).format = {
      font: { name: FONT, size: 10, color: COLORS.body },
      verticalAlignment: 'center',
      rowHeight: 32,
      borders: { insideHorizontal: { style: 'thin', color: COLORS.border } },
    };
    rowValues.forEach((values,index)=>{
      const lines=Math.max(2,...fields.map((field,i)=>Math.ceil(String(values[firstFieldColumn+i] ?? '').length/Math.max(10,displayWidth(field)-3))));
      sheet.getRange(`A${dataStart+index}:${lastColumn}${dataStart+index}`).format.rowHeight=Math.min(400,lines*15+8);
    });
  }

  const headerOffset = editable ? 2 : 1;
  for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
    const fieldName = fields[fieldIndex];
    const column = columnLetter(headerOffset + fieldIndex);
    sheet.getRange(`${column}:${column}`).format.columnWidth = displayWidth(fieldName);
    if (rows.length > 0 && DATE_FIELDS.has(fieldName)) {
      sheet.getRange(`${column}${dataStart}:${column}${dataEnd}`).format.numberFormat = 'yyyy-mm-dd hh:mm';
      rows.forEach(({row}, index) => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(row[fieldName] || ''))) {
          sheet.getRange(`${column}${dataStart+index}`).format.numberFormat = 'yyyy-mm-dd';
        }
      });
    }
    if (rows.length > 0 && NUMBER_FIELDS.has(fieldName)) {
      sheet.getRange(`${column}${dataStart}:${column}${dataEnd}`).format.numberFormat = '#,##0.##';
    }
    if (rows.length > 0 && ['retire_candidate_reason', 'evidence_issues','missing_inventory_dates','missing_status_dates','marketing_source'].includes(fieldName)) {
      sheet.getRange(`${column}${dataStart}:${column}${dataEnd}`).format.wrapText = true;
      sheet.getRange(`${column}${dataStart}:${column}${dataEnd}`).format.verticalAlignment = 'top';
    }
  }
  sheet.getRange('A:A').format.columnWidth = editable ? displayWidth('审核决定') : displayWidth('source_row_index');
  if (editable) sheet.getRange('B:B').format.columnWidth = displayWidth('source_row_index');

  if (rows.length > 0 && editable) {
    sheet.getRange(`A${dataStart}:A${dataEnd}`).dataValidation = {
      rule: { type: 'list', values: ['待确认', '确认下架', '保留'] },
    };
    sheet.getRange(`A${dataStart}:A${dataEnd}`).conditionalFormats.add('containsText', {
      text: '确认下架',
      format: { fill: COLORS.greenPale, font: { bold: true, color: '#065F46' } },
    });
    sheet.getRange(`A${dataStart}:A${dataEnd}`).conditionalFormats.add('containsText', {
      text: '保留',
      format: { fill: COLORS.redPale, font: { bold: true, color: '#991B1B' } },
    });
    sheet.getRange(`A${dataStart}:A${dataEnd}`).conditionalFormats.add('containsText', {
      text: '待确认',
      format: { fill: COLORS.amber, font: { bold: true, color: '#7A4E00' } },
    });
  }

  const table = sheet.tables.add(`A4:${lastColumn}${tableEnd}`, true, tableName);
  table.style = 'TableStyleMedium2';
  sheet.freezePanes.freezeRows(4);
  sheet.freezePanes.freezeColumns(freezeColumns);

  return {
    sheet,
    name,
    title,
    lastColumn,
    dataStart,
    dataEnd: Math.max(dataStart - 1, dataEnd),
    rowCount: rows.length,
  };
}

function writeSummarySheet({ workbook, summary, inputPath, groups, fields }) {
  const sheet = workbook.worksheets.add('来源摘要');
  const lastColumn = 'H';
  baseSheetFormat(sheet, lastColumn);
  writeMergedRow(sheet, 'A1:H1', '弱链接审核工作簿：来源与规则摘要', {
    fill: COLORS.navy,
    font: { name: FONT, bold: true, color: '#FFFFFF', size: 15 },
    rowHeight: 30,
    verticalAlignment: 'center',
  });
  writeMergedRow(sheet, 'A2:H2', '本工作簿只呈现输入分析结果。分类使用 evaluated[].retire_candidate_bucket，未重新计算业务判定或补造证据。', {
    fill: COLORS.pale,
    font: { name: FONT, color: COLORS.teal, bold: true },
    rowHeight: 32,
    verticalAlignment: 'center',
    wrapText: true,
  });

  const summaryRows = [
    ['input_file_name', path.basename(inputPath)],
    ['protectionReferenceDate', cellValue(summary.runDate, 'protectionReferenceDate', 0)],
    ...Object.entries(summary)
      .filter(([key]) => key !== 'protectionReferenceDate')
      .map(([key, value]) => [key, cellValue(value, key, 0)]),
  ];
  const summaryHeaderRow = 4;
  const summaryStartRow = 5;
  const summaryEndRow = summaryStartRow + summaryRows.length - 1;
  sheet.getRange(`A${summaryHeaderRow}:B${summaryHeaderRow}`).values = [['summary_key', 'summary_value']];
  sheet.getRange(`A${summaryHeaderRow}:B${summaryHeaderRow}`).format = {
    fill: COLORS.teal,
    font: { name: FONT, bold: true, color: '#FFFFFF' },
    horizontalAlignment: 'center',
  };
  sheet.getRange(`A${summaryStartRow}:B${summaryEndRow}`).values = summaryRows;
  sheet.getRange(`A${summaryStartRow}:B${summaryEndRow}`).format = {
    verticalAlignment: 'top',
    wrapText: true,
    borders: { insideHorizontal: { style: 'thin', color: COLORS.border } },
    rowHeight: 30,
  };
  summaryRows.forEach((r,i)=>{sheet.getRange(`A${summaryStartRow+i}:B${summaryStartRow+i}`).format.rowHeight=Math.max(30,Math.ceil(String(r[1] ?? '').length/65)*16+8);});

  const groupRows = [
    ['candidate', groups.candidate.length, '审核清单'],
    ['cannotJudge', groups.cannotJudge.length, '待确认'],
    ['other', groups.other.length, '排除复核'],
    ['total evaluated', groups.candidate.length + groups.cannotJudge.length + groups.other.length, '来源数据'],
  ];
  sheet.getRange('D4:F4').values = [['presentation_bucket', 'row_count', 'worksheet']];
  sheet.getRange('D4:F4').format = {
    fill: COLORS.teal,
    font: { name: FONT, bold: true, color: '#FFFFFF' },
    horizontalAlignment: 'center',
  };
  sheet.getRange(`D5:F${4 + groupRows.length}`).values = groupRows;
  sheet.getRange(`D5:F${4 + groupRows.length}`).format = {
    verticalAlignment: 'center',
    borders: { insideHorizontal: { style: 'thin', color: COLORS.border } },
  };
  sheet.getRange(`E5:E${4 + groupRows.length}`).format.numberFormat = '#,##0';

  const inputCounts = summary.counts && typeof summary.counts === 'object' && !Array.isArray(summary.counts)
    ? summary.counts
    : {};
  const countRows = ['inputRows', 'basePool', 'candidates', 'pending', 'excluded']
    .map(key => [key, cellValue(inputCounts[key], key, 0)]);
  sheet.getRange('G4:H4').values = [['summary_count_key', 'summary_count_value']];
  sheet.getRange('G4:H4').format = {
    fill: COLORS.teal,
    font: { name: FONT, bold: true, color: '#FFFFFF' },
    horizontalAlignment: 'center',
  };
  sheet.getRange(`G5:H${4 + countRows.length}`).values = countRows;
  sheet.getRange(`G5:H${4 + countRows.length}`).format = {
    verticalAlignment: 'center',
    borders: { insideHorizontal: { style: 'thin', color: COLORS.border } },
  };
  sheet.getRange(`H5:H${4 + countRows.length}`).format.numberFormat = '#,##0';

  const ruleRows = [
    ['分类依据', '严格按输入字段 evaluated[].retire_candidate_bucket 分组。'],
    ['candidate', '进入“审核清单”；只有此页的“审核决定”列提供下拉选择。'],
    ['cannotJudge', '进入“待确认”；保留原因和证据问题，不提供审核决定。'],
    ['其他 bucket', '进入“排除复核”；保留原 bucket、原因和证据问题，不提供审核决定。'],
    ['缺失数据', 'null、undefined 和空字符串保持空白，不替换为数字 0。'],
    ['长字段', '数组和对象使用 JSON 字符串写入单元格；不截断可写入 Excel 的字段。'],
    ['来源摘要', 'summary 中的 querySha256、evidenceSha256、fingerprint、counts 等字段按输入原样附在上方。'],
  ];
  const ruleHeaderRow = Math.max(summaryEndRow + 3, 12);
  sheet.getRange(`A${ruleHeaderRow}:B${ruleHeaderRow}`).values = [['rule_or_scope', 'description']];
  sheet.getRange(`A${ruleHeaderRow}:B${ruleHeaderRow}`).format = {
    fill: COLORS.teal,
    font: { name: FONT, bold: true, color: '#FFFFFF' },
    horizontalAlignment: 'center',
  };
  sheet.getRange(`A${ruleHeaderRow + 1}:B${ruleHeaderRow + ruleRows.length}`).values = ruleRows;
  sheet.getRange(`A${ruleHeaderRow + 1}:B${ruleHeaderRow + ruleRows.length}`).format = {
    verticalAlignment: 'top',
    wrapText: true,
    borders: { insideHorizontal: { style: 'thin', color: COLORS.border } },
    rowHeight: 30,
  };

  const fieldHeaderRow = ruleHeaderRow + ruleRows.length + 3;
  const fieldRows = fields.map(fieldName => [fieldName, fieldDescription(fieldName), DATE_FIELDS.has(fieldName) ? 'date' : NUMBER_FIELDS.has(fieldName) ? 'number' : 'source value']);
  sheet.getRange(`A${fieldHeaderRow}:C${fieldHeaderRow}`).values = [['field_key', 'meaning', 'cell_type']];
  sheet.getRange(`A${fieldHeaderRow}:C${fieldHeaderRow}`).format = {
    fill: COLORS.teal,
    font: { name: FONT, bold: true, color: '#FFFFFF' },
    horizontalAlignment: 'center',
  };
  sheet.getRange(`A${fieldHeaderRow + 1}:C${fieldHeaderRow + fieldRows.length}`).values = fieldRows;
  sheet.getRange(`A${fieldHeaderRow + 1}:C${fieldHeaderRow + fieldRows.length}`).format = {
    verticalAlignment: 'center',
    borders: { insideHorizontal: { style: 'thin', color: COLORS.border } },
  };

  sheet.getRange('A:A').format.columnWidth = 25;
  sheet.getRange('B:B').format.columnWidth = 62;
  sheet.getRange('C:C').format.columnWidth = 18;
  sheet.getRange('D:D').format.columnWidth = 22;
  sheet.getRange('E:E').format.columnWidth = 14;
  sheet.getRange('F:F').format.columnWidth = 16;
  sheet.getRange('G:G').format.columnWidth = 22;
  sheet.getRange('H:H').format.columnWidth = 18;
  sheet.freezePanes.freezeRows(4);

  const summaryTable = sheet.tables.add(`A4:B${summaryEndRow}`, true, 'RetireInputSummary');
  summaryTable.style = 'TableStyleMedium2';
  const bucketTable = sheet.tables.add(`D4:F${4 + groupRows.length}`, true, 'RetireBucketSummary');
  bucketTable.style = 'TableStyleMedium2';
  const countTable = sheet.tables.add(`G4:H${4 + countRows.length}`, true, 'RetireCountSummary');
  countTable.style = 'TableStyleMedium2';
  const ruleTable = sheet.tables.add(`A${ruleHeaderRow}:B${ruleHeaderRow + ruleRows.length}`, true, 'RetireRuleSummary');
  ruleTable.style = 'TableStyleMedium2';
  const fieldTable = sheet.tables.add(`A${fieldHeaderRow}:C${fieldHeaderRow + fieldRows.length}`, true, 'RetireFieldSummary');
  fieldTable.style = 'TableStyleMedium2';

  return {
    sheet,
    name: '来源摘要',
    lastColumn,
    dataStart: 4,
    dataEnd: fieldHeaderRow + fieldRows.length,
    rowCount: summaryRows.length,
  };
}

async function writeQaArtifacts(workbook, qaDir, sheetInfos) {
  if (!qaDir) return;
  await fs.mkdir(qaDir, { recursive: true });
  const renderFiles = {
    来源摘要: 'summary.png',
    审核清单: 'candidate-review.png',
    待确认: 'cannot-judge.png',
    排除复核: 'excluded-review.png',
    来源数据: 'source-data.png',
  };
  const qaSheets = [];
  for (const info of sheetInfos) {
    const renderEnd = Math.min(info.dataEnd, info.dataStart + 16);
    const range = `A1:${info.lastColumn}${Math.max(renderEnd, 6)}`;
    const preview = await workbook.render({
      sheetName: info.name,
      range,
      scale: 1,
      format: 'png',
    });
    const fileName = renderFiles[info.name] || `${info.name}.png`;
    await fs.writeFile(path.join(qaDir, fileName), new Uint8Array(await preview.arrayBuffer()));

    const inspect = await workbook.inspect({
      kind: 'table',
      range: `${info.name}!A1:${info.lastColumn}${Math.max(renderEnd, 6)}`,
      include: 'values,formulas',
      tableMaxRows: 18,
      tableMaxCols: 32,
      tableMaxCellChars: 160,
      maxChars: 24000,
    });
    await fs.writeFile(path.join(qaDir, `${fileName.replace(/\.png$/u, '')}.ndjson`), String(inspect?.ndjson || ''), 'utf8');
    qaSheets.push({ name: info.name, range, render: fileName, rowCount: info.rowCount });
  }

  const errors = await workbook.inspect({
    kind: 'match',
    searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',
    options: { useRegex: true, maxResults: 300 },
    summary: 'final formula error scan',
  });
  const errorText = String(errors?.ndjson || '');
  await fs.writeFile(path.join(qaDir, 'formula-errors.ndjson'), errorText, 'utf8');
  const hasFormulaErrorMatches = errorText
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .some(line => {
      try {
        const record = JSON.parse(line);
        return !(record.kind === 'notice' && /matched 0 entries/u.test(String(record.message || '')));
      } catch {
        return true;
      }
    });
  await fs.writeFile(path.join(qaDir, 'qa-manifest.json'), JSON.stringify({
    ok: true,
    renderedSheets: qaSheets,
    formulaErrorScan: hasFormulaErrorMatches ? 'matches_found' : 'empty',
  }, null, 2), 'utf8');
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const inputText = await fs.readFile(cli.input, 'utf8');
  let document;
  try {
    document = JSON.parse(inputText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in --input ${cli.input}: ${detail}`);
  }
  assertInputDocument(document, cli.input);

  const evaluated = document.evaluated;
  if (document.summary.runDate === null || document.summary.runDate === undefined || document.summary.runDate === '') {
    throw new Error('Input summary.runDate is required so protectionReferenceDate can bind to it');
  }
  if (Object.hasOwn(document.summary, 'protectionReferenceDate')
    && String(document.summary.protectionReferenceDate) !== String(document.summary.runDate)) {
    throw new Error('Input summary.protectionReferenceDate must equal summary.runDate');
  }
  const groups = { candidate: [], cannotJudge: [], other: [] };
  evaluated.forEach((row, index) => {
    groups[classifyForPresentation(row)].push({ row, sourceRowIndex: index + 1 });
  });
  const fields = collectFields(evaluated);
  const { SpreadsheetFile, Workbook } = await loadArtifactTool(cli.artifactToolEntry);
  if (!SpreadsheetFile || !Workbook) {
    throw new Error('@oai/artifact-tool entry does not expose SpreadsheetFile and Workbook');
  }

  const workbook = Workbook.create();
  const summaryInfo = writeSummarySheet({ workbook, summary: document.summary, inputPath: cli.input, groups, fields });
  const candidateInfo = writeBucketSheet({
    workbook,
    name: '审核清单',
    title: 'SHEIN 弱链接候选审核清单',
    note: `输入分组 candidate，共 ${groups.candidate.length} 条。仅“审核决定”列可编辑；此工作簿不执行下架或货号修改。`,
    rows: groups.candidate,
    fields,
    editable: true,
    tableName: 'RetireCandidateReview',
    freezeColumns: 2,
  });
  const cannotJudgeInfo = writeBucketSheet({
    workbook,
    name: '待确认',
    title: 'SHEIN 弱链接待确认',
    note: `输入分组 cannotJudge，共 ${groups.cannotJudge.length} 条。缺失证据补齐前不进入候选清单。`,
    rows: groups.cannotJudge,
    fields,
    editable: false,
    tableName: 'RetireCannotJudge',
    freezeColumns: 1,
  });
  const otherInfo = writeBucketSheet({
    workbook,
    name: '排除复核',
    title: 'SHEIN 弱链接排除复核',
    note: `输入分组为其他 bucket，共 ${groups.other.length} 条。保留原始 bucket、原因与证据问题，不提供审核决定。`,
    rows: groups.other,
    fields,
    editable: false,
    tableName: 'RetireExcludedReview',
    freezeColumns: 1,
  });
  const sourceInfo = writeBucketSheet({
    workbook,
    name: '来源数据',
    title: '来源数据（全部 evaluated 行）',
    note: `全部 ${evaluated.length} 条 evaluated 行按输入顺序保留。source_row_index 用于回溯，不代表业务排序。`,
    rows: evaluated.map((row, index) => ({ row, sourceRowIndex: index + 1 })),
    fields,
    editable: false,
    tableName: 'RetireSourceData',
    freezeColumns: 2,
  });

  workbook.recalculate();
  await writeQaArtifacts(workbook, cli.qaDir, [summaryInfo, candidateInfo, cannotJudgeInfo, otherInfo, sourceInfo]);

  await fs.mkdir(path.dirname(cli.output), { recursive: true });
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(cli.output);
  const analysisSha256 = await sha256File(cli.input);
  const workbookSha256 = await sha256File(cli.output);
  const manifestPath = `${cli.output}.manifest.json`;
  await fs.writeFile(manifestPath, JSON.stringify({
    schemaVersion: 'link-retire-review-workbook-v1',
    analysisSha256,
    workbookSha256,
    fingerprint: document.summary.fingerprint ?? null,
    runDate: document.summary.runDate,
    performanceDate: document.summary.performanceDate ?? null,
    protectionReferenceDate: document.summary.runDate,
    counts: document.summary.counts ?? null,
    inputRows: evaluated.length,
    candidateRows: groups.candidate.length,
    cannotJudgeRows: groups.cannotJudge.length,
    otherRows: groups.other.length,
    fieldCount: fields.length,
  }, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    output: cli.output,
    manifest: manifestPath,
    qaDir: cli.qaDir,
    inputRows: evaluated.length,
    candidateRows: groups.candidate.length,
    cannotJudgeRows: groups.cannotJudge.length,
    otherRows: groups.other.length,
    fieldCount: fields.length,
    sheets: ['来源摘要', '审核清单', '待确认', '排除复核', '来源数据'],
    classification: 'preserved from evaluated[].retire_candidate_bucket',
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(`[build_link_retire_review_workbook] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
