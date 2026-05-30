from __future__ import annotations

"""Build the local cost map used by marketing campaign signup helpers.

The output stays under tmp/ because it is generated operating data, while this
script is committed so the workflow can be reproduced on another machine.
"""

import json
from pathlib import Path

from openpyxl import load_workbook


ROOT = Path(__file__).resolve().parents[2]
COST_INPUT_CANDIDATES = [
    ROOT / "inputs" / "costs" / "成本.xlsx",
    ROOT / "inputs" / "costs" / "成本计算表.xlsx",
]
OUTPUT = ROOT / "tmp" / "mbrs" / "marketing-cost-map.json"
BI_PATH = ROOT / "outputs" / "bi-portal" / "data.json"
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


def compact(value: object) -> str:
    return "".join(ch for ch in clean(value).upper() if ch.isalnum())


def lookup_cost(cost_map: dict[str, float], keys: list[str]) -> float | None:
    by_compact = {compact(k): v for k, v in cost_map.items()}
    for key in keys:
        if key in cost_map:
            return cost_map[key]
        c = compact(key)
        if c in by_compact:
            return by_compact[c]
    return None


def build_true_cost_map(cost_map: dict[str, float]) -> dict[str, dict]:
    if not BI_PATH.exists():
        return {}
    try:
        bi = json.loads(BI_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    products = (bi.get("profit") or {}).get("products") or []
    product_storage_daily = (bi.get("profit") or {}).get("productStorageDaily") or []
    storage_methods_by_key: dict[str, set[str]] = {}
    for row in product_storage_daily:
        key = compact(row.get("standard_goods_sn"))
        if not key:
            continue
        method = clean(row.get("storage_fee_method"))
        if method:
            storage_methods_by_key.setdefault(key, set()).add(method)

    true_map: dict[str, dict] = {}
    for p in products:
        standard = clean(p.get("standard_goods_sn"))
        if not standard:
            continue
        keys = [standard, compact(standard)]
        base_cost = lookup_cost(cost_map, keys)
        if base_cost is None:
            base_cost = num(p.get("unit_cost_sar"))
        if base_cost is None:
            continue
        storage_fee = num(p.get("storage_fee_sar")) or 0.0
        qty = num(p.get("quantity")) or 0.0
        storage_unit = (storage_fee / qty) if qty > 0 and storage_fee else None
        method = clean(p.get("storage_fee_method")) or "missing"
        method_set = storage_methods_by_key.get(compact(standard))
        if method_set:
            method = " / ".join(sorted(method_set))
        true_unit = base_cost + (storage_unit or 0.0)
        info = {
            "unitCostSar": round(base_cost, 4),
            "storageUnitCostSar30d": None if storage_unit is None else round(storage_unit, 4),
            "trueUnitCostSar": round(true_unit, 4),
            "storageMethod": method,
            "storageFeeSar": round(storage_fee, 4),
            "quantityBasis": round(qty, 4),
            "source": "outputs/bi-portal/data.json",
        }
        for key in keys:
            if key:
                true_map[key] = info
    return true_map


def resolve_cost_input() -> Path:
    for candidate in COST_INPUT_CANDIDATES:
        if candidate.exists():
            return candidate
    expected = " / ".join(str(p) for p in COST_INPUT_CANDIDATES)
    raise SystemExit(f"missing cost workbook; expected one of: {expected}")


def main() -> None:
    input_path = resolve_cost_input()
    wb = load_workbook(input_path, data_only=True)
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

    true_cost_map = build_true_cost_map(cost_map)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({
        "source": str(input_path),
        "biSource": str(BI_PATH) if BI_PATH.exists() else None,
        "count": len(cost_map),
        "trueCostCount": len(true_cost_map),
        "costMap": cost_map,
        "trueCostMap": true_cost_map,
        "batches": batches,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(OUTPUT), "count": len(cost_map), "trueCostCount": len(true_cost_map), "batches": len(batches)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
