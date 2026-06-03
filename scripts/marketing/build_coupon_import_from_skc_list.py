import json
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
ET.register_namespace('', NS)

if len(sys.argv) != 4:
    print('usage: build_coupon_import_from_skc_list.py <template_xlsx> <skc_list_json> <output_xlsx>')
    sys.exit(1)

template_xlsx = Path(sys.argv[1])
skc_list_json = Path(sys.argv[2])
output_xlsx = Path(sys.argv[3])

rows = json.loads(skc_list_json.read_text(encoding='utf-8'))
if not isinstance(rows, list):
    raise SystemExit('skc list json must be a list')
rows = [str(x) for x in rows if str(x).strip()]
if not rows:
    raise SystemExit('empty skc list')

sheet_xml = None
other_files = {}
with zipfile.ZipFile(template_xlsx, 'r') as zin:
    for name in zin.namelist():
        data = zin.read(name)
        if name == 'xl/worksheets/sheet1.xml':
            sheet_xml = data
        else:
            other_files[name] = data

root = ET.fromstring(sheet_xml)
ns = {'a': NS}
dim = root.find('a:dimension', ns)
sheet_data = root.find('a:sheetData', ns)
if sheet_data is None:
    raise SystemExit('sheetData not found')

for child in list(sheet_data):
    sheet_data.remove(child)

def inline_cell(ref: str, text: str):
    c = ET.Element(f'{{{NS}}}c', {'r': ref, 't': 'inlineStr'})
    is_el = ET.SubElement(c, f'{{{NS}}}is')
    t_el = ET.SubElement(is_el, f'{{{NS}}}t')
    if '\n' in text:
        t_el.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    t_el.text = text
    return c

header_rows = [
    '填写说明：\n1、SKC：必填，须在该活动的可报商品列表中\n2、一次仅支持上传400000条数据\n',
    'SKC\n(必填)',
]
all_rows = header_rows + rows
for idx, value in enumerate(all_rows, start=1):
    row_el = ET.SubElement(sheet_data, f'{{{NS}}}row', {'r': str(idx)})
    row_el.append(inline_cell(f'A{idx}', value))

if dim is not None:
    dim.set('ref', f'A1:A{len(all_rows)}')

output_xlsx.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output_xlsx, 'w', compression=zipfile.ZIP_DEFLATED) as zout:
    for name, data in other_files.items():
        zout.writestr(name, data)
    zout.writestr('xl/worksheets/sheet1.xml', ET.tostring(root, encoding='utf-8', xml_declaration=False))

print(json.dumps({'rows': len(rows), 'output': str(output_xlsx), 'sample': rows[:10]}, ensure_ascii=False, indent=2))
