import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone


def pick(d, *keys):
    if not isinstance(d, dict):
        return None
    for key in keys:
        if key in d and d.get(key) not in (None, ''):
            return d.get(key)
    return None


def normalize_row(row, order, store, date):
    merged = {}
    if isinstance(order, dict):
        merged.update(order)
    if isinstance(row, dict):
        merged.update(row)
    return {
        'storeKey': pick(merged, 'storeKey', 'store', 'store_key') or store,
        'date': date,
        'orderNo': pick(merged, 'orderNo', 'billno', 'order_no'),
        'billno': pick(merged, 'billno', 'orderNo', 'order_no'),
        'orderCreateTime': pick(merged, 'orderCreateTime', 'order_create_time'),
        'orderCustomerTime': pick(merged, 'orderCustomerTime', 'order_customer_time'),
        'allocateTimeFull': pick(merged, 'allocateTimeFull', 'g_zcs_allocateTime'),
        'allocateTime': pick(merged, 'allocateTime'),
        'skc': pick(merged, 'skc', 'skcName', 'skc_name'),
        'goodsSn': pick(merged, 'goodsSn', 'goods_sn', 'standardGoodsSn', 'standard_goods_sn'),
        'skuCode': pick(merged, 'skuCode', 'sku_code'),
        'skuSn': pick(merged, 'skuSn', 'sku_sn'),
        'suffix': pick(merged, 'suffix', 'sku_suffix'),
        'entityId': pick(merged, 'entityId', 'entity_id'),
        'goodsId': pick(merged, 'goodsId', 'goods_id'),
        'orderId': pick(merged, 'orderId', 'id', 'order_id'),
        'goodsTitle': pick(merged, 'goodsTitle', 'goods_title', 'productName'),
        'number': pick(merged, 'number', 'quantity', 'goodsNumber', 'goods_number'),
        'currencyPrice': pick(merged, 'currencyPrice', 'currency_price'),
        'currencyCode': pick(merged, 'currencyCode', 'currency', 'currency_code'),
        'isValidSale': pick(merged, 'isValidSale', 'validSale', 'is_valid_sale'),
        'salesExclusionReason': pick(merged, 'salesExclusionReason', 'sales_exclusion_reason'),
        'orderStatus': pick(merged, 'orderStatus', 'order_status'),
        'orderStatusDesc': pick(merged, 'orderStatusDesc', 'order_status_desc'),
        'performStatus': pick(merged, 'performStatus', 'perform_status'),
        'performStatusDesc': pick(merged, 'performStatusDesc', 'perform_status_desc'),
        'goodsPerformanceStatus': pick(merged, 'goodsPerformanceStatus', 'goods_performance_status'),
        'goodsPerformanceStatusDesc': pick(merged, 'goodsPerformanceStatusDesc', 'goods_performance_status_desc'),
        'newOrderGoodsStatus': pick(merged, 'newOrderGoodsStatus'),
        'performanceTag': pick(merged, 'performanceTag', 'performance_tag'),
        'site': pick(merged, 'site'),
    }


def extract_rows(doc, store, date):
    rows = []
    goods_rows = doc.get('goodsRows') if isinstance(doc, dict) else None
    if isinstance(goods_rows, list):
        for row in goods_rows:
            if isinstance(row, dict):
                rows.append(normalize_row(row, {}, store, date))
    if rows:
        return rows
    orders = doc.get('orders') if isinstance(doc, dict) else None
    if not isinstance(orders, list):
        return rows
    for order in orders:
        if not isinstance(order, dict):
            continue
        groups = order.get('groupList') or order.get('groups') or []
        if not isinstance(groups, list):
            continue
        for group in groups:
            if not isinstance(group, dict):
                continue
            goods_list = group.get('goodsList') or group.get('goods_rows') or group.get('goodsRows') or []
            if not isinstance(goods_list, list):
                continue
            for row in goods_list:
                if isinstance(row, dict):
                    rows.append(normalize_row(row, order, store, date))
    return rows


def sql_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def query_warehouse_rows(stores, dates):
    if str(os.environ.get('SHEIN_BI_ORDER_WAREHOUSE_FALLBACK', '1')).lower() in ('0', 'false', 'no'):
        return None
    safe_stores = [s for s in stores if re.fullmatch(r'[A-Z0-9_-]+', s)]
    safe_dates = [d for d in dates if re.fullmatch(r'\d{4}-\d{2}-\d{2}', d)]
    if not safe_stores or not safe_dates:
        return None
    stores_sql = ','.join(sql_literal(s) for s in safe_stores)
    dates_sql = ','.join(sql_literal(d) for d in safe_dates)
    sql = f"""
SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json)::text
FROM (
  SELECT
    oi.store_key AS "storeKey",
    oi.created_date::text AS date,
    COALESCE(NULLIF(oi.order_no,''), NULLIF(oi.bill_no,'')) AS "orderNo",
    COALESCE(NULLIF(oi.bill_no,''), NULLIF(oi.order_no,'')) AS billno,
    to_char(oi.order_create_time, 'YYYY-MM-DD HH24:MI:SS') AS "orderCreateTime",
    oi.skc,
    oi.standard_goods_sn AS "goodsSn",
    oi.sku_code AS "skuCode",
    oi.sku_sn AS "skuSn",
    oi.sku_suffix AS suffix,
    oi.entity_id AS "entityId",
    oi.goods_id AS "goodsId",
    oi.order_id AS "orderId",
    oi.goods_title AS "goodsTitle",
    oi.quantity AS number,
    oi.currency_price AS "currencyPrice",
    COALESCE(NULLIF(oi.currency_code,''), 'SAR') AS "currencyCode",
    (
      COALESCE(oi.quantity, 0) > 0
      AND COALESCE(oi.currency_price, 0) > 0
      AND COALESCE(oi.sales_sar, 0) > 0
    ) AS "isValidSale",
    CASE
      WHEN COALESCE(oi.quantity, 0) <= 0 THEN 'quantity_not_positive'
      WHEN COALESCE(oi.currency_price, 0) <= 0 THEN 'currency_price_not_positive'
      WHEN COALESCE(oi.sales_sar, 0) <= 0 THEN 'sales_sar_not_positive'
      ELSE ''
    END AS "salesExclusionReason",
    oh.order_status AS "orderStatus",
    oh.order_status_desc AS "orderStatusDesc",
    oh.perform_status AS "performStatus",
    oh.perform_status_desc AS "performStatusDesc",
    oi.goods_performance_status AS "goodsPerformanceStatus",
    oi.goods_performance_status_desc AS "goodsPerformanceStatusDesc",
    oi.site,
    GREATEST(oi.updated_at, COALESCE(oh.updated_at, oi.updated_at))::text AS "sourceUpdatedAt"
  FROM fact.order_item oi
  LEFT JOIN fact.order_header oh ON oh.order_key = oi.order_key
  WHERE oi.store_key IN ({stores_sql})
    AND oi.created_date::text IN ({dates_sql})
  ORDER BY oi.created_date, oi.store_key, oi.order_create_time, oi.order_item_key
) q;
"""
    command = [
        'sudo', '-n', 'docker', 'exec',
        os.environ.get('SHEIN_BI_WAREHOUSE_DB_CONTAINER', 'shein-warehouse-db'),
        'psql',
        '-U', os.environ.get('SHEIN_BI_WAREHOUSE_DB_USER', 'shein'),
        '-d', os.environ.get('SHEIN_BI_WAREHOUSE_DB_NAME', 'shein_bi'),
        '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
        '-c', sql,
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=True)
        rows = json.loads(result.stdout.strip() or '[]')
        return {
            'ok': True,
            'queriedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'rows': rows if isinstance(rows, list) else [],
        }
    except Exception as exc:
        return {'ok': False, 'error': str(exc), 'rows': []}


def read_fixture(path):
    if not path:
        return None
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            value = json.load(fh)
        return value if isinstance(value, dict) else None
    except Exception as exc:
        return {'ok': False, 'error': str(exc), 'rows': []}


def build_output(root, stores, dates, warehouse_result=None):
    root = root.rstrip('/')
    out = {'files': []}
    missing_items = []
    for store in stores:
        for date in dates:
            remote_path = os.path.join(root, 'outputs', 'shein_fetch', store, date + '.json')
            item = {
                'storeKey': store,
                'date': date,
                'remotePath': remote_path,
                'sourceType': 'shein_fetch_file',
                'exists': os.path.exists(remote_path),
                'ok': False,
                'fetchTime': '',
                'start': '',
                'end': '',
                'docStoreKey': '',
                'rows': [],
                'rowCount': 0,
            }
            if not item['exists']:
                missing_items.append(item)
                out['files'].append(item)
                continue
            try:
                with open(remote_path, 'r', encoding='utf-8') as fh:
                    doc = json.load(fh)
                item['ok'] = True
                item['fetchTime'] = doc.get('fetchTime') or ''
                item['start'] = doc.get('start') or ''
                item['end'] = doc.get('end') or ''
                item['docStoreKey'] = doc.get('storeKey') or ''
                item['rows'] = extract_rows(doc, store, date)
                item['rowCount'] = len(item['rows'])
            except Exception as exc:
                item['error'] = str(exc)
            out['files'].append(item)

    if missing_items and warehouse_result is None:
        warehouse_result = query_warehouse_rows(stores, dates)
    if not missing_items or not isinstance(warehouse_result, dict) or warehouse_result.get('ok') is not True:
        if isinstance(warehouse_result, dict) and warehouse_result.get('error'):
            out['warehouseFallbackError'] = warehouse_result.get('error')
        return out

    rows_by_key = {}
    for raw in warehouse_result.get('rows') or []:
        if not isinstance(raw, dict):
            continue
        store = str(raw.get('storeKey') or raw.get('store_key') or '').upper()
        date = str(raw.get('date') or '')[:10]
        key = (store, date)
        rows_by_key.setdefault(key, []).append(normalize_row(raw, {}, store, date))
    queried_at = warehouse_result.get('queriedAt') or datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    for item in missing_items:
        key = (item['storeKey'], item['date'])
        item['sourceType'] = 'warehouse_webhook_order_item'
        item['remotePath'] = f"warehouse://fact.order_item/{item['storeKey']}/{item['date']}"
        item['exists'] = True
        item['ok'] = True
        item['fetchTime'] = queried_at
        item['start'] = item['date'] + ' 00:00:00'
        item['end'] = item['date'] + ' 23:59:59'
        item['docStoreKey'] = item['storeKey']
        item['rows'] = rows_by_key.get(key, [])
        item['rowCount'] = len(item['rows'])
    out['warehouseFallback'] = {
        'used': True,
        'queriedAt': queried_at,
        'fileCount': len(missing_items),
        'rowCount': sum(item['rowCount'] for item in missing_items),
        'source': 'fact.order_item',
    }
    return out


def main():
    root = sys.argv[1]
    stores = [s for s in sys.argv[2].split(',') if re.fullmatch(r'[A-Z0-9_-]+', s)]
    dates = [d for d in sys.argv[3].split(',') if re.fullmatch(r'\d{4}-\d{2}-\d{2}', d)]
    fixture = read_fixture(sys.argv[4]) if len(sys.argv) > 4 else None
    print(json.dumps(build_output(root, stores, dates, fixture), ensure_ascii=False))


if __name__ == '__main__':
    main()
