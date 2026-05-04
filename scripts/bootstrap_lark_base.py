#!/usr/bin/env python3
"""Create a fresh Lark Base from schemas/lark-base-schema.json.

This script intentionally keeps the first bootstrap small and deterministic:
- create one new Base
- create tables sequentially with their fields
- write state/lark_base.json for later scripts

It does not store secrets.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schemas" / "lark-base-schema.json"
STATE_PATH = ROOT / "state" / "lark_base.json"
STORES_PATH = ROOT / "config" / "stores.json"
ORDER_URL = "https://sso.geiwohuo.com/#/gsp/order-management/list"


def run(cmd):
    p = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\nSTDOUT:\n{p.stdout}\nSTDERR:\n{p.stderr}")
    text = p.stdout.strip()
    # lark-cli may append notices; parse the first JSON object/array block.
    start = min([i for i in [text.find('{'), text.find('[')] if i >= 0], default=-1)
    if start < 0:
        raise RuntimeError(f"no json output from command: {' '.join(cmd)}\n{text}")
    decoder = json.JSONDecoder()
    obj, _ = decoder.raw_decode(text[start:])
    return obj, p.stdout, p.stderr


def get_base_token(resp):
    base = resp.get("base") or resp.get("data", {}).get("base") or resp
    for key in ["base_token", "app_token", "token"]:
        if isinstance(base, dict) and base.get(key):
            return base[key]
    # Fallback recursive search.
    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if k in ("base_token", "app_token") and isinstance(v, str):
                    return v
                got = walk(v)
                if got:
                    return got
        elif isinstance(x, list):
            for item in x:
                got = walk(item)
                if got:
                    return got
        return None
    token = walk(resp)
    if not token:
        raise RuntimeError(f"cannot find base token in response: {json.dumps(resp, ensure_ascii=False)[:1000]}")
    return token


def get_table_id(resp):
    table = resp.get("table") or resp.get("data", {}).get("table") or resp
    for key in ["table_id", "id"]:
        if isinstance(table, dict) and table.get(key):
            return table[key]
    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if k in ("table_id", "id") and isinstance(v, str) and v.startswith("tbl"):
                    return v
                got = walk(v)
                if got:
                    return got
        elif isinstance(x, list):
            for item in x:
                got = walk(item)
                if got:
                    return got
        return None
    token = walk(resp)
    if not token:
        raise RuntimeError(f"cannot find table id in response: {json.dumps(resp, ensure_ascii=False)[:1000]}")
    return token


def create_base(schema):
    cmd = [
        "lark-cli", "base", "+base-create",
        "--as", "user",
        "--name", schema["baseName"],
        "--time-zone", schema.get("timeZone", "Asia/Shanghai"),
    ]
    resp, stdout, _ = run(cmd)
    return resp, get_base_token(resp), stdout


def create_table(base_token, table):
    fields_json = json.dumps(table["fields"], ensure_ascii=False)
    cmd = [
        "lark-cli", "base", "+table-create",
        "--as", "user",
        "--base-token", base_token,
        "--name", table["name"],
        "--fields", fields_json,
    ]
    resp, stdout, _ = run(cmd)
    return resp, get_table_id(resp), stdout


def seed_store_config(base_token, table_id):
    stores = json.loads(STORES_PATH.read_text(encoding="utf-8-sig"))["stores"]
    rows = []
    for s in stores:
        rows.append([
            s["storeKey"],
            s["shopName"],
            s["groupKey"],
            bool(s.get("enabled", True)),
            bool(s.get("productStatsEnabled", False)),
            s.get("profileKey", ""),
            ORDER_URL,
            None,
            "初始化导入；端口/profile 以后按实际登录态补齐",
        ])
    payload = {
        "fields": ["店铺代号", "店铺名称", "分组", "是否启用", "商品统计启用", "ProfileKey", "订单页入口", "浏览器端口", "备注"],
        "rows": rows,
    }
    cmd = [
        "lark-cli", "base", "+record-batch-create",
        "--as", "user",
        "--base-token", base_token,
        "--table-id", table_id,
        "--json", json.dumps(payload, ensure_ascii=False),
    ]
    resp, stdout, _ = run(cmd)
    return resp, stdout


def seed_system_params(base_token, table_id):
    rows = [
        ["SAR_TO_RMB", "1.8", "固定汇率：1 SAR = 1.8 RMB"],
        ["PROFIT_RATE", "0.25", "预测利润率：25%"],
        ["DATE_BASIS", "订单创建时间", "SHEIN 统计口径"],
    ]
    payload = {"fields": ["参数名", "参数值", "说明"], "rows": rows}
    cmd = [
        "lark-cli", "base", "+record-batch-create",
        "--as", "user",
        "--base-token", base_token,
        "--table-id", table_id,
        "--json", json.dumps(payload, ensure_ascii=False),
    ]
    resp, stdout, _ = run(cmd)
    return resp, stdout


def main():
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8-sig"))
    print(f"Creating Base: {schema['baseName']}", flush=True)
    base_resp, base_token, base_stdout = create_base(schema)
    tables = {}
    for table in schema["tables"]:
        print(f"Creating table: {table['name']}", flush=True)
        resp, table_id, _ = create_table(base_token, table)
        tables[table["name"]] = {"table_id": table_id, "raw": resp}
    if "店铺配置" in tables:
        print("Seeding store config", flush=True)
        seed_store_config(base_token, tables["店铺配置"]["table_id"])
    if "系统参数" in tables:
        print("Seeding system params", flush=True)
        seed_system_params(base_token, tables["系统参数"]["table_id"])
    state = {
        "baseName": schema["baseName"],
        "baseToken": base_token,
        "baseCreateResponse": base_resp,
        "tables": tables,
    }
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"baseName": schema["baseName"], "baseToken": base_token, "tables": {k: v["table_id"] for k, v in tables.items()}, "state": str(STATE_PATH)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
