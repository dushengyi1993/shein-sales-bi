BEGIN;

CREATE TABLE IF NOT EXISTS ops.historical_store_identity_correction (
  correction_id text PRIMARY KEY,
  incident_id text NOT NULL,
  source_store_key text NOT NULL REFERENCES dim.store(store_key),
  effective_store_key text NOT NULL REFERENCES dim.store(store_key),
  start_date date NOT NULL,
  end_date date NOT NULL,
  expected_item_rows integer,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_store_key <> effective_store_key),
  CHECK (start_date <= end_date)
);

CREATE TABLE IF NOT EXISTS ops.order_store_reassignment_audit (
  run_id text NOT NULL,
  correction_id text NOT NULL,
  old_order_item_key text NOT NULL,
  new_order_item_key text NOT NULL,
  old_order_key text,
  new_order_key text,
  order_no text,
  created_date date,
  source_store_key text NOT NULL,
  effective_store_key text NOT NULL,
  standard_goods_sn text,
  skc text,
  quantity numeric,
  sales_sar numeric,
  source_file text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  repaired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, old_order_item_key)
);

CREATE INDEX IF NOT EXISTS order_store_reassignment_audit_order_idx
  ON ops.order_store_reassignment_audit(order_no,created_date);

CREATE OR REPLACE VIEW mart.after_sales_settlement_detail AS
WITH raw AS (
  SELECT
    ai.after_sales_item_key,
    ai.store_key,
    ai.order_no,
    ai.standard_goods_sn,
    nullif(ai.skc,'') AS skc,
    ai.aftersales_order_no,
    ai.return_order_no,
    coalesce(ai.quantity, 1) AS quantity,
    coalesce(ai.price_amount_total, ai.price_amount, 0) AS amount_sar,
    ai.resolution_plan_name,
    ai.order_sub_status_name,
    ai.return_package_status_name,
    concat_ws(':', ai.store_key, coalesce(nullif(ai.return_order_no,''), nullif(ai.aftersales_order_no,''), ai.order_no)) AS package_key,
    (pca.package_key IS NOT NULL) AS has_actual_return_cost,
    (
      coalesce(ai.resolution_plan_name,'') ILIKE '%退货%'
      OR coalesce(ai.resolution_plan_name,'') ILIKE '%仅退款%'
      OR coalesce(ai.order_sub_status_name,'') ILIKE ANY (ARRAY['%同意退款%','%已妥投%','%待交接%','%待买家退货%','%待卖家处理%','%待买家选择方案%'])
      OR coalesce(ai.return_package_status_name,'') ILIKE ANY (ARRAY['%已签收%','%派件失败%','%派件异常%'])
    ) AS reversal_candidate,
    (
      coalesce(ai.resolution_plan_name,'') ILIKE '%驳回%'
      OR coalesce(ai.order_sub_status_name,'') ILIKE '%已关闭%'
      OR (
        coalesce(ai.order_sub_status_name,'') ILIKE '%已取消%'
        AND coalesce(ai.return_package_status_name,'') NOT ILIKE '%派件%'
      )
    ) AS invalid_or_cancelled,
    (
      coalesce(ai.order_sub_status_name,'') ILIKE '%同意退款%'
      OR (
        coalesce(ai.order_sub_status_name,'') ILIKE '%已取消%'
        AND coalesce(ai.return_package_status_name,'') ILIKE ANY (ARRAY['%派件失败%','%派件异常%'])
      )
    ) AS final_signal
  FROM fact.after_sales_item ai
  LEFT JOIN mart.return_cost_package_actual pca
    ON pca.package_key = concat_ws(
      ':',
      ai.store_key,
      coalesce(nullif(ai.return_order_no,''),nullif(ai.aftersales_order_no,''),ai.order_no)
    )
  WHERE coalesce(ai.order_no,'') <> ''
),
classified AS (
  SELECT
    *,
    reversal_candidate AND NOT invalid_or_cancelled AND final_signal AS realized_reversal,
    reversal_candidate AND NOT invalid_or_cancelled AND NOT final_signal AS pending_revenue_risk,
    (
      reversal_candidate AND NOT invalid_or_cancelled AND final_signal
      AND coalesce(resolution_plan_name,'') ILIKE '%退货%'
      AND coalesce(resolution_plan_name,'') NOT ILIKE '%仅退款%'
      AND NOT (coalesce(return_package_status_name,'') ILIKE ANY (ARRAY['%派件失败%','%派件异常%']))
      AND NOT has_actual_return_cost
    ) AS charge_estimated_return_package
  FROM raw
)
SELECT
  *,
  CASE
    WHEN invalid_or_cancelled THEN 'closed_without_refund'
    WHEN realized_reversal THEN 'realized'
    WHEN pending_revenue_risk THEN 'pending'
    ELSE 'not_refund_candidate'
  END AS settlement_state,
  CASE
    WHEN invalid_or_cancelled THEN '已取消/关闭'
    WHEN realized_reversal THEN '退款已落定'
    WHEN pending_revenue_risk THEN '退款待落定'
    ELSE '不影响退款'
  END AS settlement_state_label
FROM classified;

CREATE OR REPLACE VIEW mart.profit_after_sales_impact AS
WITH classified AS (
  SELECT *
  FROM mart.after_sales_settlement_detail
),
package_basis AS (
  SELECT
    package_key,
    bool_or(charge_estimated_return_package) AS charge_package,
    sum(CASE WHEN charge_estimated_return_package THEN greatest(amount_sar,0) ELSE 0 END) AS amount_basis,
    sum(CASE WHEN charge_estimated_return_package THEN greatest(quantity,0) ELSE 0 END) AS quantity_basis
  FROM classified
  GROUP BY package_key
),
allocated AS (
  SELECT
    c.*,
    CASE
      WHEN p.charge_package AND c.charge_estimated_return_package AND p.amount_basis > 0 THEN 13.88 * greatest(c.amount_sar,0) / p.amount_basis
      WHEN p.charge_package AND c.charge_estimated_return_package AND p.quantity_basis > 0 THEN 13.88 * greatest(c.quantity,0) / p.quantity_basis
      ELSE 0
    END AS estimated_return_delivery_fee_sar
  FROM classified c
  JOIN package_basis p USING (package_key)
)
SELECT
  store_key,
  order_no,
  standard_goods_sn,
  skc,
  bool_or(realized_reversal) AS revenue_reversal,
  count(DISTINCT aftersales_order_no) AS after_sales_cases,
  sum(quantity) FILTER (WHERE realized_reversal) AS impact_quantity,
  sum(amount_sar) FILTER (WHERE realized_reversal) AS impact_amount_sar,
  string_agg(DISTINCT resolution_plan_name, ' / ') FILTER (WHERE coalesce(resolution_plan_name,'') <> '') AS resolution_plans,
  string_agg(DISTINCT order_sub_status_name, ' / ') FILTER (WHERE coalesce(order_sub_status_name,'') <> '') AS order_sub_statuses,
  string_agg(DISTINCT return_package_status_name, ' / ') FILTER (WHERE coalesce(return_package_status_name,'') <> '') AS return_package_statuses,
  bool_or(realized_reversal) AS realized_revenue_reversal,
  bool_or(pending_revenue_risk) AS pending_revenue_risk,
  sum(quantity) FILTER (WHERE pending_revenue_risk) AS pending_impact_quantity,
  sum(amount_sar) FILTER (WHERE pending_revenue_risk) AS pending_impact_amount_sar,
  sum(estimated_return_delivery_fee_sar) AS estimated_return_delivery_fee_sar
FROM allocated
GROUP BY store_key, order_no, standard_goods_sn, skc;

COMMIT;
