#!/usr/bin/env python3
"""Sync browser ports from config/stores.json to Lark 店铺配置."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATE = json.loads((ROOT / "state" / "lark_base.json").read_text(encoding="utf-8-sig"))
STORES = {s["storeKey"]: s for s in json.loads((ROOT / "config" / "stores.json").read_text(encoding="utf-8-sig"))["stores"]}
BASE = STATE["baseToken"]
TABLE = STATE["tables"]["店铺配置"]["table_id"]


def run(cmd):
    p = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\nSTDOUT:\n{p.stdout}\nSTDERR:\n{p.stderr}")
    text = p.stdout.strip()
    start = text.find("{")
    if start < 0:
        raise RuntimeError(f"no json output: {text}")
    obj, _ = json.JSONDecoder().raw_decode(text[start:])
    return obj


def main():
    records = run(["lark-cli", "base", "+record-list", "--as", "user", "--base-token", BASE, "--table-id", TABLE, "--limit", "200"])
    data = records["data"]
    fields = data["fields"]
    store_idx = fields.index("店铺代号")
    updates = []
    for row, record_id in zip(data["data"], data["record_id_list"]):
        key = row[store_idx]
        store = STORES.get(key)
        if store and store.get("port"):
            updates.append((record_id, key, int(store["port"])))
    for record_id, key, port in updates:
        payload = {"浏览器端口": port, "备注": "初始化导入；profile 和运行产物保存在工作区，避免占用 C 盘"}
        run(["lark-cli", "base", "+record-upsert", "--as", "user", "--base-token", BASE, "--table-id", TABLE, "--record-id", record_id, "--json", json.dumps(payload, ensure_ascii=False)])
        print(f"updated {key} port={port}")
    print(json.dumps({"updated": len(updates)}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
