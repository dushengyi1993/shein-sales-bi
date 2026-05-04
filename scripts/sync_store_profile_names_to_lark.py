#!/usr/bin/env python3
"""Ensure 店铺配置 has Chrome用户名 and sync profile names/ports."""
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


def ensure_field():
    fields = run(["lark-cli", "base", "+field-list", "--as", "user", "--base-token", BASE, "--table-id", TABLE, "--limit", "100"])["data"]["fields"]
    if any(f.get("name") == "Chrome用户名" for f in fields):
        return False
    run(["lark-cli", "base", "+field-create", "--as", "user", "--base-token", BASE, "--table-id", TABLE, "--json", json.dumps({"type":"text","name":"Chrome用户名"}, ensure_ascii=False)])
    return True


def sync_records():
    records = run(["lark-cli", "base", "+record-list", "--as", "user", "--base-token", BASE, "--table-id", TABLE, "--limit", "200"])["data"]
    fields = records["fields"]
    store_idx = fields.index("店铺代号")
    count = 0
    for row, record_id in zip(records["data"], records["record_id_list"]):
        key = row[store_idx]
        store = STORES.get(key)
        if not store:
            continue
        payload = {
            "Chrome用户名": store.get("profileName") or f"{store['storeKey']} - {store['shopName']}",
            "浏览器端口": int(store.get("port") or 0) or None,
            "备注": "初始化导入；profile 和运行产物保存在工作区，避免占用 C 盘；新设备前几次登录可能需要手机验证码。",
        }
        run(["lark-cli", "base", "+record-upsert", "--as", "user", "--base-token", BASE, "--table-id", TABLE, "--record-id", record_id, "--json", json.dumps(payload, ensure_ascii=False)])
        count += 1
    return count


def main():
    created = ensure_field()
    updated = sync_records()
    print(json.dumps({"field_created": created, "records_updated": updated}, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
