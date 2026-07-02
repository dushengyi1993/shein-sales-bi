import json, os, sys

root = sys.argv[1].rstrip('/')
stores = [s for s in sys.argv[2].split(',') if s]
dates = [d for d in sys.argv[3].split(',') if d]

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
        'goodsSn': pick(merged, 'goodsSn', 'goods_sn', 'standardGoodsSn'),
        'skuCode': pick(merged, 'skuCode', 'sku_code'),
        'skuSn': pick(merged, 'skuSn', 'sku_sn'),
        'suffix': pick(merged, 'suffix'),
        'entityId': pick(merged, 'entityId'),
        'goodsId': pick(merged, 'goodsId'),
        'orderId': pick(merged, 'orderId', 'id'),
        'goodsTitle': pick(merged, 'goodsTitle', 'goods_title', 'productName'),
        'number': pick(merged, 'number', 'quantity', 'goodsNumber', 'goods_number'),
        'currencyPrice': pick(merged, 'currencyPrice', 'currency_price'),
        'currencyCode': pick(merged, 'currencyCode', 'currency', 'currency_code'),
        'isValidSale': pick(merged, 'isValidSale', 'validSale'),
        'salesExclusionReason': pick(merged, 'salesExclusionReason'),
        'orderStatus': pick(merged, 'orderStatus'),
        'orderStatusDesc': pick(merged, 'orderStatusDesc'),
        'performStatus': pick(merged, 'performStatus'),
        'performStatusDesc': pick(merged, 'performStatusDesc'),
        'goodsPerformanceStatus': pick(merged, 'goodsPerformanceStatus'),
        'goodsPerformanceStatusDesc': pick(merged, 'goodsPerformanceStatusDesc'),
        'newOrderGoodsStatus': pick(merged, 'newOrderGoodsStatus'),
        'performanceTag': pick(merged, 'performanceTag'),
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

out = {'files': []}
for store in stores:
    for date in dates:
        remote_path = os.path.join(root, 'outputs', 'shein_fetch', store, date + '.json')
        item = {
            'storeKey': store,
            'date': date,
            'remotePath': remote_path,
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
print(json.dumps(out, ensure_ascii=False))