#!/usr/bin/env node
/**
 * Create Excel templates for product cost batches and monthly storage fees.
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PYTHON = 'C:\\Users\\dushengyi\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
const outFile = path.join(ROOT, 'inputs', 'costs', 'SHEIN成本表模板.xlsx');
fs.mkdirSync(path.dirname(outFile), {recursive: true});

const py = fs.existsSync(DEFAULT_PYTHON) ? DEFAULT_PYTHON : 'python';
const code = String.raw`
import sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

out = sys.argv[1]
wb = Workbook()
ws = wb.active
ws.title = "成本批次"
headers = [
    "货号", "品名", "发货申请单", "发货数量", "货款金额",
    "头程运输费金额", "其他费用", "总成本", "币种",
    "采购单价", "长cm", "宽cm", "高cm", "重量kg", "备注"
]
ws.append(headers)
ws.append(["SM-505A电动缝纫机", "示例：电动缝纫机", "SHIP-2026-001", 100, 12000, 1800, 0, "", "CNY", 120, 38, 20, 30, 4.2, "头程运费为空的批次会被忽略"])
ws.append(["SK-03038制冰机", "示例：制冰机", "SHIP-2026-002", 80, 16000, "", 0, "", "CNY", 200, 42, 32, 36, 8.5, "这行因缺头程运输费不纳入单位成本"])
for col in range(1, len(headers)+1):
    cell = ws.cell(1, col)
    cell.font = Font(bold=True, color="FFFFFF")
    cell.fill = PatternFill("solid", fgColor="2563EB")
    cell.alignment = Alignment(horizontal="center")
    ws.column_dimensions[get_column_letter(col)].width = 16
ws.column_dimensions["A"].width = 24
ws.column_dimensions["B"].width = 24
ws.column_dimensions["C"].width = 20
ws.column_dimensions["O"].width = 36
ws.freeze_panes = "A2"

ws2 = wb.create_sheet("月仓储费")
headers2 = ["月份", "仓储费金额", "币种", "备注"]
ws2.append(headers2)
ws2.append(["2026-05", 3000, "SAR", "月总仓储费，只用于月总利润/分组利润，不拆到货号"])
for col in range(1, len(headers2)+1):
    cell = ws2.cell(1, col)
    cell.font = Font(bold=True, color="FFFFFF")
    cell.fill = PatternFill("solid", fgColor="059669")
    cell.alignment = Alignment(horizontal="center")
    ws2.column_dimensions[get_column_letter(col)].width = 18
ws2.column_dimensions["D"].width = 48
ws2.freeze_panes = "A2"

ws3 = wb.create_sheet("说明")
notes = [
    ["规则", "一行成本批次代表同一个货号的一批货。"],
    ["关键", "缺少头程运输费金额的批次会保留记录，但不会纳入单位成本均摊。"],
    ["单位成本", "同货号完整批次总成本 / 完整批次发货总数。"],
    ["退货利润", "发生退货/派送失败时，订单营收按 0，仍扣商品成本，并额外加 13.88 SAR 退货派送费。"],
    ["仓储费", "月仓储费只用于月总利润和 DSY/LGM 分组利润，按成交额比例分摊，不拆到单货号。"],
    ["分组", "TS/MZ 开店以来都归 DSY 组。"],
]
for row in notes:
    ws3.append(row)
ws3.column_dimensions["A"].width = 18
ws3.column_dimensions["B"].width = 90
for cell in ws3[1]:
    cell.font = Font(bold=True)

wb.save(out)
print(out)
`;

const res = spawnSync(py, ['-c', code, outFile], {encoding: 'utf8', windowsHide: true});
if (res.status !== 0) {
  console.error(res.stderr || res.stdout);
  process.exit(res.status || 1);
}
console.log(JSON.stringify({ok: true, file: path.relative(ROOT, outFile).replace(/\\/g, '/')}, null, 2));
