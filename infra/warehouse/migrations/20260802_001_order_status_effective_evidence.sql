BEGIN;

CREATE OR REPLACE VIEW ops.order_status_recheck_effective AS
SELECT DISTINCT ON (oi.order_item_key)
  oi.order_item_key AS fact_order_item_key,
  CASE
    WHEN rs.order_item_key = oi.order_item_key THEN 'exact_item_key'
    WHEN coalesce(oi.sku_code,'') <> '' AND rs.sku_code = oi.sku_code THEN 'store_order_sku'
    WHEN coalesce(oi.goods_id,'') <> '' AND rs.goods_id = oi.goods_id THEN 'store_order_goods'
    WHEN coalesce(oi.skc,'') <> '' AND rs.skc = oi.skc THEN 'store_order_skc'
    ELSE 'store_order_product'
  END AS match_basis,
  rs.*
FROM fact.order_item oi
JOIN ops.order_status_recheck_state rs
  ON rs.store_key = oi.store_key
 AND (
   rs.order_item_key = oi.order_item_key
   OR (
     coalesce(nullif(rs.order_no,''), nullif(rs.bill_no,'')) =
       coalesce(nullif(oi.order_no,''), nullif(oi.bill_no,''))
     AND (
       (coalesce(oi.sku_code,'') <> '' AND rs.sku_code = oi.sku_code)
       OR (coalesce(oi.goods_id,'') <> '' AND rs.goods_id = oi.goods_id)
       OR (coalesce(oi.skc,'') <> '' AND rs.skc = oi.skc)
       OR (
         coalesce(oi.standard_goods_sn,'') <> ''
         AND dim.product_canonical_sn(rs.standard_goods_sn) =
             dim.product_canonical_sn(oi.standard_goods_sn)
       )
     )
   )
 )
ORDER BY
  oi.order_item_key,
  CASE
    WHEN rs.lifecycle_status_group = 'returning'
     AND concat_ws(' ', rs.latest_page_status_desc, rs.latest_goods_performance_status_desc) ~ '(派件失败|未妥投|退回|拒收)' THEN 100
    WHEN rs.lifecycle_status_group = 'done'
     AND concat_ws(' ', rs.latest_page_status_desc, rs.latest_goods_performance_status_desc) ~ '(已签收|已完成|妥投)' THEN 90
    WHEN rs.lifecycle_status_group = 'returning' THEN 80
    WHEN rs.lifecycle_status_group = 'done' THEN 70
    WHEN rs.lifecycle_status_group = 'abnormal' THEN 60
    WHEN rs.lifecycle_status_group = 'shipped' THEN 50
    WHEN rs.lifecycle_status_group = 'pending' THEN 40
    WHEN rs.lifecycle_status_group = 'cancelled' THEN 20
    ELSE 10
  END DESC,
  rs.last_checked_at DESC NULLS LAST,
  CASE
    WHEN rs.order_item_key = oi.order_item_key THEN 50
    WHEN coalesce(oi.sku_code,'') <> '' AND rs.sku_code = oi.sku_code THEN 40
    WHEN coalesce(oi.goods_id,'') <> '' AND rs.goods_id = oi.goods_id THEN 30
    WHEN coalesce(oi.skc,'') <> '' AND rs.skc = oi.skc THEN 20
    ELSE 10
  END DESC,
  rs.updated_at DESC NULLS LAST;

COMMIT;
