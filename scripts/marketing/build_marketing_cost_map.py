from __future__ import annotations

"""Build the local cost map used by marketing campaign signup helpers.

The output stays under tmp/ because it is generated operating data, while this
script is committed so the workflow can be reproduced on another machine.
"""

import json
from pathlib import Path

from openpyxl import load_workbook


ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / "inputs" / "costs" / "成本计算表.xlsx"
OUTPUT = ROOT / "tmp" / "mbrs" / "marketing-cost-map.json"
CNY_TO_SAR = 1 / 1.8


def clean(value) -> str:
    return "" if value is None else str(value).strip()


def num(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip().replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def main() -> None:
    wb = load_workbook(INPUT, data_only=True)
    ws = wb["成本"] if "成本" in wb.sheetnames else wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        raise SystemExit("empty cost sheet")
    headers = [clean(v) for v in rows[0]]

    def idx(names: list[str]) -> int | None:
        keys = [n.replace("\n", "").replace(" ", "") for n in names]
        for i, h in enumerate(headers):
            hh = h.replace("\n", "").replace(" ", "")
            if hh in keys:
                return i
        for i, h in enumerate(headers):
            hh = h.replace("\n", "").replace(" ", "")
            if any(k in hh or hh in k for k in keys):
                return i
        return None

    model_i = idx(["型号", "货号", "标准货号"])
    name_i = idx(["希音标准名", "品名", "商品名称"])
    qty_i = idx(["数量", "发货数量", "总数量"])
    unit_i = idx(["单台总成本（SAR）", "单台总成本SAR", "单台总成本"])
    first_leg_i = idx(["头程运输费", "头程运输费金额"])

    batches = []
    agg: dict[str, dict] = {}
    for rno, row in enumerate(rows[1:], start=2):
        model = clean(row[model_i]) if model_i is not None else ""
        name = clean(row[name_i]) if name_i is not None else ""
        qty = num(row[qty_i]) if qty_i is not None else None
        unit_cost = num(row[unit_i]) if unit_i is not None else None
        first_leg = num(row[first_leg_i]) if first_leg_i is not None else None
        if not model or not qty or qty <= 0 or unit_cost is None:
            continue
        # 用户要求：没有头程运输费金额的批次先忽略，避免失真。
        if first_leg is None:
            continue
        full = f"{model}{name}".replace(" ", "")
        rec = agg.setdefault(full, {"quantity": 0.0, "total_cost": 0.0, "models": set(), "names": set()})
        rec["quantity"] += qty
        rec["total_cost"] += unit_cost * qty
        rec["models"].add(model)
        if name:
            rec["names"].add(name)
        batches.append({"row": rno, "model": model, "name": name, "full": full, "qty": qty, "unit_cost_sar": unit_cost})

    cost_map = {}
    for full, rec in agg.items():
        avg = rec["total_cost"] / rec["quantity"]
        keys = {full}
        for m in rec["models"]:
            keys.add(m)
        for m in rec["models"]:
            for n in rec["names"]:
                keys.add(f"{m}{n}".replace(" ", ""))
        for k in keys:
            cost_map[k] = round(avg, 4)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({"source": str(INPUT), "count": len(cost_map), "costMap": cost_map, "batches": batches}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(OUTPUT), "count": len(cost_map), "batches": len(batches)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
