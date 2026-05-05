CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS dim;
CREATE SCHEMA IF NOT EXISTS fact;
CREATE SCHEMA IF NOT EXISTS mart;
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS dim.store (
  store_key text PRIMARY KEY,
  group_key text NOT NULL,
  shop_name text,
  profile_key text,
  cdp_port integer,
  profile_name text,
  enabled boolean DEFAULT true,
  product_stats_enabled boolean DEFAULT true,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dim.product (
  standard_goods_sn text PRIMARY KEY,
  sample_raw_goods_sn text,
  needs_review boolean DEFAULT false,
  review_reason text,
  first_seen_date date,
  last_seen_date date,
  updated_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION dim.product_match_key(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  WITH k AS (
    SELECT upper(regexp_replace(coalesce(value,''), '[^A-Za-z0-9]+', '', 'g')) AS key
  )
  SELECT CASE
    WHEN key IN ('2001','CM2001') THEN '2001'
    WHEN key IN ('MZ7028','SK7028','7028') THEN 'SK7028'
    ELSE key
  END
  FROM k;
$$;

CREATE TABLE IF NOT EXISTS dim.skc (
  skc text PRIMARY KEY,
  spu text,
  standard_goods_sn text,
  raw_goods_sn text,
  sku_code text,
  title text,
  image_url text,
  category_l1 text,
  category_l2 text,
  category_l3 text,
  category_l4 text,
  first_seen_date date,
  last_seen_date date,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw.local_file_catalog (
  file_path text PRIMARY KEY,
  file_kind text NOT NULL,
  store_key text,
  target_date date,
  loaded_at timestamptz DEFAULT now(),
  record_count integer,
  raw_meta jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS fact.store_daily_sales (
  date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  valid_order_count integer,
  goods_line_count integer,
  quantity_all numeric,
  quantity_positive_amount numeric,
  sales_sar numeric,
  sales_rmb numeric,
  fetch_time timestamptz,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (date, store_key)
);

CREATE TABLE IF NOT EXISTS fact.order_header (
  order_key text PRIMARY KEY,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  order_id text,
  order_no text,
  bill_no text,
  created_date date,
  order_create_time timestamp,
  allocate_time timestamp,
  site text,
  order_status text,
  order_status_desc text,
  perform_status text,
  perform_status_desc text,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_header_date_store ON fact.order_header(created_date, store_key);

CREATE TABLE IF NOT EXISTS fact.order_item (
  order_item_key text PRIMARY KEY,
  order_key text,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  order_id text,
  order_no text,
  bill_no text,
  created_date date,
  order_create_time timestamp,
  site text,
  standard_goods_sn text,
  raw_goods_sn text,
  goods_id text,
  entity_id text,
  skc text,
  sku_code text,
  sku_sn text,
  sku_suffix text,
  goods_title text,
  quantity numeric,
  currency_code text,
  currency_price numeric,
  sales_sar numeric,
  sales_rmb numeric,
  goods_status text,
  goods_performance_status text,
  goods_performance_status_desc text,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_item_date_store ON fact.order_item(created_date, store_key);
CREATE INDEX IF NOT EXISTS idx_order_item_product ON fact.order_item(standard_goods_sn, created_date);
CREATE INDEX IF NOT EXISTS idx_order_item_skc ON fact.order_item(skc, created_date);

CREATE TABLE IF NOT EXISTS fact.home_finance_snapshot (
  unique_key text PRIMARY KEY,
  snapshot_date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  home_update_time text,
  trade_amount_sar numeric,
  pay_user_count numeric,
  goods_uv numeric,
  sale_count numeric,
  in_transit_order_amount_sar numeric,
  pending_settlement_income_sar numeric,
  settlement_abnormal_sar numeric,
  withdrawable_amount_sar numeric,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_home_finance_date_store ON fact.home_finance_snapshot(snapshot_date, store_key);

CREATE TABLE IF NOT EXISTS fact.after_sales_item (
  after_sales_item_key text PRIMARY KEY,
  snapshot_date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  request_time timestamp,
  aftersales_order_no text,
  return_order_no text,
  order_no text,
  order_id text,
  site text,
  resolution_plan text,
  resolution_plan_name text,
  order_sub_status text,
  order_sub_status_name text,
  return_package_status text,
  return_package_status_name text,
  reason_codes text,
  reason_names text,
  price_amount_total numeric,
  currency_code text,
  goods_id text,
  entity_id text,
  standard_goods_sn text,
  raw_goods_sn text,
  skc text,
  sku_sn text,
  suffix text,
  goods_title text,
  quantity numeric,
  price_amount numeric,
  return_expense numeric,
  performance_price numeric,
  freeze_amount numeric,
  estimated_income_amount numeric,
  performance_fee_amount numeric,
  return_expense_amount numeric,
  appeal_status text,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_after_sales_date_store ON fact.after_sales_item(snapshot_date, store_key);
CREATE INDEX IF NOT EXISTS idx_after_sales_order ON fact.after_sales_item(order_no, store_key);
CREATE INDEX IF NOT EXISTS idx_after_sales_product ON fact.after_sales_item(standard_goods_sn, snapshot_date);

CREATE TABLE IF NOT EXISTS fact.waybill_package (
  package_key text PRIMARY KEY,
  snapshot_date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  place_order_package_id text,
  place_batch_code text,
  express_code text,
  express_no text,
  warehouse_name text,
  warehouse_code text,
  provider_name text,
  place_state text,
  print_state text,
  performance_status text,
  show_status_code text,
  show_status_desc text,
  tag_code text,
  tag_desc text,
  collect_time timestamp,
  print_time timestamp,
  weight numeric,
  length numeric,
  width numeric,
  height numeric,
  estimate_performance_price numeric,
  currency_code text,
  order_no_list text,
  goods_sn_list text,
  skc_list text,
  goods_quantity numeric,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_waybill_date_store ON fact.waybill_package(snapshot_date, store_key);
CREATE INDEX IF NOT EXISTS idx_waybill_express ON fact.waybill_package(express_code, express_no);

CREATE TABLE IF NOT EXISTS fact.fulfillment_performance_daily (
  unique_key text PRIMARY KEY,
  date date NOT NULL,
  snapshot_date date,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  collect_ok_rate numeric,
  collect_ok_cnt numeric,
  collect_ok_total_cnt numeric,
  sign_ok_rate numeric,
  sign_ok_cnt numeric,
  sign_ok_total_cnt numeric,
  collect_bad_rate numeric,
  collect_bad_cnt numeric,
  collect_bad_total_cnt numeric,
  sign_bad_rate numeric,
  sign_bad_cnt numeric,
  sign_bad_total_cnt numeric,
  seller_cancel_rate numeric,
  seller_cancel_cnt numeric,
  seller_cancel_total_cnt numeric,
  delivery_timeout_rate numeric,
  num_delivery_timeout numeric,
  num_delivery numeric,
  valid_track_rate numeric,
  total_order_item_cnt numeric,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fulfillment_date_store ON fact.fulfillment_performance_daily(date, store_key);

CREATE TABLE IF NOT EXISTS fact.visible_inventory_snapshot (
  unique_key text PRIMARY KEY,
  snapshot_date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  spu text,
  standard_goods_sn text,
  raw_goods_sn text,
  skc_list text,
  sku_code_list text,
  shelf_statuses text,
  inventory_quantity numeric,
  usable_inventory numeric,
  order_locked_quantity numeric,
  pay_locked_quantity numeric,
  display_stock_low boolean,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visible_inventory_date_store ON fact.visible_inventory_snapshot(snapshot_date, store_key);
CREATE INDEX IF NOT EXISTS idx_visible_inventory_product ON fact.visible_inventory_snapshot(standard_goods_sn, snapshot_date);

CREATE TABLE IF NOT EXISTS fact.management_indicator_daily (
  unique_key text PRIMARY KEY,
  date date NOT NULL,
  snapshot_date date,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  push_skc_cnt numeric,
  push_skc_success_rate numeric,
  release_skc_cnt numeric,
  sale_cny_cd numeric,
  shop_click_rate numeric,
  shop_cart_rate numeric,
  shop_pay_rate numeric,
  refund_price numeric,
  bad_comment_rate numeric,
  raw_trade jsonb DEFAULT '{}'::jsonb,
  raw_goods jsonb DEFAULT '{}'::jsonb,
  raw_flow jsonb DEFAULT '{}'::jsonb,
  raw_service jsonb DEFAULT '{}'::jsonb,
  raw_purchase jsonb DEFAULT '{}'::jsonb,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_management_indicator_date_store ON fact.management_indicator_daily(date, store_key);

CREATE TABLE IF NOT EXISTS fact.marketing_overview_daily (
  unique_key text PRIMARY KEY,
  date date NOT NULL,
  snapshot_date date,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  business_activity_type text,
  sale_cnt numeric,
  sale_cnt_change_pct numeric,
  sale_amt numeric,
  sale_amt_change_pct numeric,
  avg_goods_uv_idx numeric,
  avg_goods_uv_idx_change_pct numeric,
  has_activity boolean,
  last_campaign_date date,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_overview_date_store ON fact.marketing_overview_daily(date, store_key);

CREATE TABLE IF NOT EXISTS fact.marketing_campaign_snapshot (
  unique_key text PRIMARY KEY,
  snapshot_date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  business_activity_type text,
  business_activity_id text,
  activity_name text,
  active_status text,
  start_date date,
  end_date date,
  active_product_cnt numeric,
  avg_product_sale numeric,
  avg_product_amt numeric,
  goods_uv numeric,
  cart_uv numeric,
  sale_amt numeric,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_campaign_store ON fact.marketing_campaign_snapshot(snapshot_date, store_key);

CREATE TABLE IF NOT EXISTS fact.quality_skc_snapshot (
  unique_key text PRIMARY KEY,
  snapshot_date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  skc text,
  spu text,
  standard_goods_sn text,
  raw_goods_sn text,
  product_grade text,
  on_sale_status text,
  sales_volume_7d numeric,
  goods_quality_level text,
  goods_quality_level_type text,
  return_volume numeric,
  quality_return_volume numeric,
  quality_return_rate numeric,
  show_bad_eval_rate numeric,
  eval_cnt numeric,
  bad_eval_cnt numeric,
  optimize_status text,
  optimize_sub_status text,
  potential_quality_risks text,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quality_skc_date_store ON fact.quality_skc_snapshot(snapshot_date, store_key);
CREATE INDEX IF NOT EXISTS idx_quality_skc_product ON fact.quality_skc_snapshot(standard_goods_sn, snapshot_date);

CREATE TABLE IF NOT EXISTS fact.product_comment (
  comment_key text PRIMARY KEY,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  comment_id text,
  comment_date date,
  comment_time timestamp,
  order_time timestamp,
  bill_no text,
  supply_order_no text,
  standard_goods_sn text,
  raw_goods_sn text,
  spu text,
  skc text,
  sku text,
  goods_title text,
  goods_attribute text,
  goods_comment_star numeric,
  goods_comment_star_name text,
  goods_comment_content text,
  goods_comment_content_zh text,
  translation_provider text,
  translated_at timestamptz,
  bad_comment_labels text,
  logistic_comment_star numeric,
  is_quality text,
  is_quality_label text,
  is_quality_complaint text,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_comment_date_store ON fact.product_comment(comment_date, store_key);
CREATE INDEX IF NOT EXISTS idx_product_comment_skc ON fact.product_comment(skc, comment_date);

CREATE TABLE IF NOT EXISTS fact.finance_income_overview_snapshot (
  unique_key text PRIMARY KEY,
  snapshot_date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  module_enum text,
  title text,
  tip text,
  seller_currency_code text,
  pay_amount numeric,
  seller_financing_deduction_amount numeric,
  ext_show_infos jsonb DEFAULT '[]'::jsonb,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_income_date_store ON fact.finance_income_overview_snapshot(snapshot_date, store_key);
CREATE INDEX IF NOT EXISTS idx_finance_income_module ON fact.finance_income_overview_snapshot(module_enum, snapshot_date);

CREATE TABLE IF NOT EXISTS fact.finance_module_stat_snapshot (
  unique_key text PRIMARY KEY,
  snapshot_date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  module_enum text,
  tip_msg text,
  seller_currency_code text,
  income numeric,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_module_stat_date_store ON fact.finance_module_stat_snapshot(snapshot_date, store_key);

CREATE TABLE IF NOT EXISTS fact.finance_account_period_snapshot (
  unique_key text PRIMARY KEY,
  snapshot_date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  account_period_days numeric,
  privilege_provide_time date,
  is_high_quality_supplier boolean,
  privilege_config_type text,
  privilege_config_type_desc text,
  allow_view_report boolean,
  report_delay_show boolean,
  is_new_platform_gray boolean,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_account_date_store ON fact.finance_account_period_snapshot(snapshot_date, store_key);

CREATE TABLE IF NOT EXISTS fact.finance_no_finish_order (
  finance_order_key text PRIMARY KEY,
  snapshot_date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  finance_row_id text,
  order_no text,
  check_order_no text,
  bz_order_no text,
  big_category text,
  big_category_name text,
  first_order_type text,
  second_order_type text,
  second_order_type_name text,
  income_expenditure_type text,
  seller_currency_code text,
  estimate_income_money_total numeric,
  site text,
  store_type text,
  check_status text,
  order_delivery_time date,
  goods_detail_count integer,
  finance_detail_count integer,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_no_finish_date_store ON fact.finance_no_finish_order(snapshot_date, store_key);
CREATE INDEX IF NOT EXISTS idx_finance_no_finish_order_no ON fact.finance_no_finish_order(order_no, store_key);

CREATE TABLE IF NOT EXISTS fact.finance_no_finish_order_goods (
  finance_goods_key text PRIMARY KEY,
  finance_order_key text,
  snapshot_date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  order_no text,
  standard_goods_sn text,
  raw_goods_sn text,
  spu text,
  skc text,
  sku_code text,
  goods_id text,
  entity_id text,
  goods_title text,
  quantity numeric,
  amount numeric,
  currency_code text,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_goods_date_store ON fact.finance_no_finish_order_goods(snapshot_date, store_key);
CREATE INDEX IF NOT EXISTS idx_finance_goods_product ON fact.finance_no_finish_order_goods(standard_goods_sn, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_finance_goods_skc ON fact.finance_no_finish_order_goods(skc, snapshot_date);

CREATE TABLE IF NOT EXISTS fact.link_master_snapshot (
  unique_key text PRIMARY KEY,
  snapshot_date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  standard_goods_sn text,
  raw_goods_sn text,
  spu text,
  skc text,
  sku_codes text,
  sale_name text,
  image_url text,
  product_name_cn text,
  product_name_en text,
  brand_name text,
  shelf_status text,
  shelf_status_name text,
  is_on_shelf boolean,
  is_wait_shelf boolean,
  is_sold_out boolean,
  is_out_shelf boolean,
  is_hard_dead boolean,
  wait_shelf_blocked boolean,
  wait_shelf_block_reason text,
  created_time timestamp,
  shelf_time timestamp,
  first_shelf_time timestamp,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_link_master_date_store ON fact.link_master_snapshot(snapshot_date, store_key);
CREATE INDEX IF NOT EXISTS idx_link_master_product ON fact.link_master_snapshot(standard_goods_sn, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_link_master_skc ON fact.link_master_snapshot(skc, snapshot_date);

CREATE TABLE IF NOT EXISTS fact.link_performance_daily (
  unique_key text PRIMARY KEY,
  date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  standard_goods_sn text,
  raw_goods_sn text,
  spu text,
  skc text,
  goods_name text,
  image_url text,
  sale_cnt numeric,
  pay_order_cnt numeric,
  eps_uv numeric,
  goods_uv numeric,
  click_rate numeric,
  cart_uv numeric,
  cart_pv numeric,
  cart_rate numeric,
  pay_uv numeric,
  pay_rate numeric,
  c7_sale_cnt numeric,
  prev7_sale_cnt numeric,
  c30_sale_cnt numeric,
  quality_grade text,
  comment_count numeric,
  bad_comment_rate numeric,
  return_order_count numeric,
  return_item_count numeric,
  activity_tag text,
  activity_names text,
  flow_diagnose_tabs text,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_link_perf_date_store ON fact.link_performance_daily(date, store_key);
CREATE INDEX IF NOT EXISTS idx_link_perf_product ON fact.link_performance_daily(standard_goods_sn, date);
CREATE INDEX IF NOT EXISTS idx_link_perf_skc ON fact.link_performance_daily(skc, date);

CREATE TABLE IF NOT EXISTS fact.product_store_coverage (
  unique_key text PRIMARY KEY,
  date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  standard_goods_sn text,
  coverage_status text,
  has_on_shelf_link boolean,
  need_supplement_link boolean,
  link_count integer,
  on_shelf_count integer,
  wait_shelf_count integer,
  sold_out_count integer,
  out_shelf_count integer,
  hard_dead_count integer,
  duplicate_on_shelf boolean,
  best_skc text,
  best_link_c30_sale numeric,
  skc_list text,
  recommendation text,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coverage_date_store ON fact.product_store_coverage(date, store_key);
CREATE INDEX IF NOT EXISTS idx_coverage_product ON fact.product_store_coverage(standard_goods_sn, date);

CREATE TABLE IF NOT EXISTS fact.link_suggestion (
  unique_key text PRIMARY KEY,
  date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  target_type text,
  target_key text,
  standard_goods_sn text,
  skc text,
  rule_code text,
  suggestion_type text,
  priority integer,
  reason text,
  action text,
  evidence text,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suggestion_date_store ON fact.link_suggestion(date, store_key);
CREATE INDEX IF NOT EXISTS idx_suggestion_product ON fact.link_suggestion(standard_goods_sn, date);
CREATE INDEX IF NOT EXISTS idx_suggestion_rule ON fact.link_suggestion(rule_code, date);

CREATE TABLE IF NOT EXISTS mart.link_action_candidate (
  action_id text PRIMARY KEY,
  date date NOT NULL,
  type text,
  category text,
  priority text,
  score numeric,
  store_key text,
  group_key text,
  shop_name text,
  standard_goods_sn text,
  skc text,
  image_url text,
  title text,
  reason text,
  evidence text,
  next_step text,
  source text,
  focus boolean DEFAULT false,
  metrics jsonb DEFAULT '{}'::jsonb,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_candidate_date_store ON mart.link_action_candidate(date, store_key);
CREATE INDEX IF NOT EXISTS idx_action_candidate_focus ON mart.link_action_candidate(date, focus, score DESC);

CREATE TABLE IF NOT EXISTS mart.store_cockpit_daily (
  date date NOT NULL,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  shop_name text,
  today_sar numeric,
  today_qty numeric,
  today_orders numeric,
  last7_sar numeric,
  last30_sar numeric,
  sales7_change_rate numeric,
  link_count integer,
  on_shelf integer,
  wait_shelf integer,
  sold_out integer,
  out_shelf integer,
  link_c30_sale numeric,
  link_c30_exposure numeric,
  action_count integer,
  focus_count integer,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (date, store_key)
);

CREATE TABLE IF NOT EXISTS ops.action (
  action_id text PRIMARY KEY,
  date date NOT NULL,
  action_type text,
  priority text,
  store_key text,
  standard_goods_sn text,
  skc text,
  title text,
  reason text,
  evidence text,
  status text DEFAULT 'open',
  assigned_to text,
  note text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.product_cost_batch (
  batch_key text PRIMARY KEY,
  standard_goods_sn text NOT NULL,
  raw_goods_sn text,
  batch_no text,
  shipped_quantity numeric,
  goods_cost_amount numeric,
  first_leg_freight_amount numeric,
  other_cost_amount numeric,
  total_cost_amount numeric,
  currency_code text DEFAULT 'CNY',
  cost_sar numeric,
  unit_cost_sar numeric,
  complete_batch boolean DEFAULT false,
  ignored_reason text,
  purchase_unit_price numeric,
  length_cm numeric,
  width_cm numeric,
  height_cm numeric,
  volume_l numeric,
  weight_kg numeric,
  source_file text,
  source_sheet text,
  source_row_no integer,
  imported_at timestamptz DEFAULT now(),
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_cost_batch_product ON fact.product_cost_batch(standard_goods_sn);
CREATE INDEX IF NOT EXISTS idx_product_cost_batch_complete ON fact.product_cost_batch(standard_goods_sn, complete_batch);

CREATE TABLE IF NOT EXISTS fact.monthly_storage_fee (
  month_start date PRIMARY KEY,
  total_fee_amount numeric,
  currency_code text DEFAULT 'SAR',
  total_fee_sar numeric,
  note text,
  source_file text,
  imported_at timestamptz DEFAULT now(),
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_monthly_storage_fee_month ON fact.monthly_storage_fee(month_start);

CREATE OR REPLACE VIEW mart.product_unit_cost_current AS
SELECT
  standard_goods_sn,
  count(*) FILTER (WHERE complete_batch) AS complete_batch_count,
  count(*) FILTER (WHERE NOT complete_batch) AS ignored_batch_count,
  sum(coalesce(shipped_quantity,0)) FILTER (WHERE complete_batch) AS costed_quantity,
  sum(coalesce(cost_sar,0)) FILTER (WHERE complete_batch) AS total_cost_sar,
  CASE
    WHEN sum(coalesce(shipped_quantity,0)) FILTER (WHERE complete_batch) > 0
    THEN sum(coalesce(cost_sar,0)) FILTER (WHERE complete_batch)
      / nullif(sum(coalesce(shipped_quantity,0)) FILTER (WHERE complete_batch), 0)
    ELSE NULL
  END AS unit_cost_sar,
  avg(purchase_unit_price) FILTER (WHERE complete_batch AND purchase_unit_price IS NOT NULL) AS avg_purchase_unit_price,
  avg(volume_l) FILTER (WHERE complete_batch AND volume_l IS NOT NULL) AS avg_volume_l,
  avg(weight_kg) FILTER (WHERE complete_batch AND weight_kg IS NOT NULL) AS avg_weight_kg,
  max(imported_at) AS last_imported_at,
  string_agg(DISTINCT ignored_reason, ' / ') FILTER (WHERE ignored_reason IS NOT NULL AND ignored_reason <> '') AS ignored_reasons,
  dim.product_match_key(standard_goods_sn) AS match_key
FROM fact.product_cost_batch
GROUP BY standard_goods_sn;

CREATE OR REPLACE VIEW mart.product_unit_cost_by_match_key AS
SELECT
  match_key,
  string_agg(DISTINCT standard_goods_sn, ' / ' ORDER BY standard_goods_sn) AS cost_standard_goods_sn_list,
  sum(complete_batch_count) AS complete_batch_count,
  sum(ignored_batch_count) AS ignored_batch_count,
  sum(costed_quantity) AS costed_quantity,
  sum(total_cost_sar) AS total_cost_sar,
  CASE
    WHEN sum(costed_quantity) > 0
    THEN sum(total_cost_sar) / nullif(sum(costed_quantity), 0)
    ELSE NULL
  END AS unit_cost_sar,
  avg(avg_purchase_unit_price) FILTER (WHERE avg_purchase_unit_price IS NOT NULL) AS avg_purchase_unit_price,
  avg(avg_volume_l) FILTER (WHERE avg_volume_l IS NOT NULL) AS avg_volume_l,
  avg(avg_weight_kg) FILTER (WHERE avg_weight_kg IS NOT NULL) AS avg_weight_kg,
  max(last_imported_at) AS last_imported_at,
  string_agg(DISTINCT ignored_reasons, ' / ') FILTER (WHERE ignored_reasons IS NOT NULL AND ignored_reasons <> '') AS ignored_reasons
FROM mart.product_unit_cost_current
WHERE coalesce(match_key,'') <> ''
GROUP BY match_key;

CREATE OR REPLACE VIEW mart.profit_after_sales_impact AS
WITH classified AS (
  SELECT
    store_key,
    order_no,
    standard_goods_sn,
    nullif(skc,'') AS skc,
    aftersales_order_no,
    coalesce(quantity, 1) AS quantity,
    coalesce(price_amount_total, price_amount, 0) AS amount_sar,
    resolution_plan_name,
    order_sub_status_name,
    return_package_status_name,
    (
      (
        coalesce(return_package_status_name,'') ILIKE '%派件失败%'
        OR coalesce(return_package_status_name,'') ILIKE '%派件异常%'
        OR coalesce(resolution_plan_name,'') ILIKE '%退货%'
        OR coalesce(resolution_plan_name,'') ILIKE '%仅退款%'
        OR coalesce(order_sub_status_name,'') ILIKE '%同意退款%'
        OR coalesce(order_sub_status_name,'') ILIKE '%已妥投%'
        OR coalesce(order_sub_status_name,'') ILIKE '%待交接%'
        OR coalesce(order_sub_status_name,'') ILIKE '%待买家退货%'
      )
      AND NOT (
        coalesce(resolution_plan_name,'') ILIKE '%驳回%'
        OR coalesce(order_sub_status_name,'') ILIKE '%已关闭%'
        OR (
          coalesce(order_sub_status_name,'') ILIKE '%已取消%'
          AND coalesce(return_package_status_name,'') NOT ILIKE '%派件%'
        )
      )
    ) AS revenue_reversal
  FROM fact.after_sales_item
  WHERE coalesce(order_no,'') <> ''
)
SELECT
  store_key,
  order_no,
  standard_goods_sn,
  skc,
  bool_or(revenue_reversal) AS revenue_reversal,
  count(DISTINCT aftersales_order_no) AS after_sales_cases,
  sum(quantity) FILTER (WHERE revenue_reversal) AS impact_quantity,
  sum(amount_sar) FILTER (WHERE revenue_reversal) AS impact_amount_sar,
  string_agg(DISTINCT resolution_plan_name, ' / ') FILTER (WHERE coalesce(resolution_plan_name,'') <> '') AS resolution_plans,
  string_agg(DISTINCT order_sub_status_name, ' / ') FILTER (WHERE coalesce(order_sub_status_name,'') <> '') AS order_sub_statuses,
  string_agg(DISTINCT return_package_status_name, ' / ') FILTER (WHERE coalesce(return_package_status_name,'') <> '') AS return_package_statuses
FROM classified
GROUP BY store_key, order_no, standard_goods_sn, skc;

CREATE OR REPLACE VIEW mart.profit_order_item AS
SELECT
  oi.order_item_key,
  oi.order_key,
  oi.store_key,
  CASE
    WHEN oi.created_date < DATE '2026-03-01' AND oi.store_key IN ('TS','MZ') THEN 'LGM'
    WHEN oi.store_key IN ('TS','MZ') THEN 'DSY'
    ELSE coalesce(oi.group_key, s.group_key)
  END AS group_key,
  oi.order_no,
  oi.bill_no,
  oi.created_date,
  date_trunc('month', oi.created_date)::date AS month_start,
  oi.order_create_time,
  oi.standard_goods_sn,
  oi.raw_goods_sn,
  oi.skc,
  oi.goods_title,
  coalesce(oi.quantity,0) AS quantity,
  coalesce(oi.sales_sar,0) AS gross_revenue_sar,
  CASE WHEN coalesce(ai.revenue_reversal,false) THEN 0 ELSE coalesce(oi.sales_sar,0) END AS net_revenue_sar,
  c.unit_cost_sar,
  CASE
    WHEN c.unit_cost_sar IS NULL THEN NULL
    WHEN coalesce(oi.sales_sar,0) <= 0 THEN 0
    ELSE c.unit_cost_sar * coalesce(oi.quantity,0)
  END AS product_cost_sar,
  CASE
    WHEN coalesce(ai.revenue_reversal,false)
      AND coalesce(oi.sales_sar,0) > 0
      AND coalesce(ai.resolution_plans,'') ILIKE '%退货%'
      AND coalesce(ai.resolution_plans,'') NOT ILIKE '%仅退款%'
      AND coalesce(ai.return_package_statuses,'') NOT ILIKE '%派件失败%'
      AND coalesce(ai.return_package_statuses,'') NOT ILIKE '%派件异常%'
      AND coalesce(ai.order_sub_statuses,'') NOT ILIKE '%派件失败%'
      AND coalesce(ai.order_sub_statuses,'') NOT ILIKE '%派件异常%'
    THEN 13.88
    ELSE 0
  END AS return_delivery_fee_sar,
  CASE
    WHEN c.unit_cost_sar IS NULL THEN NULL
    ELSE (CASE WHEN coalesce(ai.revenue_reversal,false) THEN 0 ELSE coalesce(oi.sales_sar,0) END)
      - CASE WHEN coalesce(oi.sales_sar,0) <= 0 THEN 0 ELSE c.unit_cost_sar * coalesce(oi.quantity,0) END
      - CASE
          WHEN coalesce(ai.revenue_reversal,false)
            AND coalesce(oi.sales_sar,0) > 0
            AND coalesce(ai.resolution_plans,'') ILIKE '%退货%'
            AND coalesce(ai.resolution_plans,'') NOT ILIKE '%仅退款%'
            AND coalesce(ai.return_package_statuses,'') NOT ILIKE '%派件失败%'
            AND coalesce(ai.return_package_statuses,'') NOT ILIKE '%派件异常%'
            AND coalesce(ai.order_sub_statuses,'') NOT ILIKE '%派件失败%'
            AND coalesce(ai.order_sub_statuses,'') NOT ILIKE '%派件异常%'
          THEN 13.88
          ELSE 0
        END
  END AS profit_before_storage_sar,
  CASE
    WHEN c.unit_cost_sar IS NULL THEN NULL
    WHEN (CASE WHEN coalesce(ai.revenue_reversal,false) THEN 0 ELSE coalesce(oi.sales_sar,0) END) = 0 THEN NULL
    ELSE (
      (CASE WHEN coalesce(ai.revenue_reversal,false) THEN 0 ELSE coalesce(oi.sales_sar,0) END)
      - CASE WHEN coalesce(oi.sales_sar,0) <= 0 THEN 0 ELSE c.unit_cost_sar * coalesce(oi.quantity,0) END
      - CASE
          WHEN coalesce(ai.revenue_reversal,false)
            AND coalesce(oi.sales_sar,0) > 0
            AND coalesce(ai.resolution_plans,'') ILIKE '%退货%'
            AND coalesce(ai.resolution_plans,'') NOT ILIKE '%仅退款%'
            AND coalesce(ai.return_package_statuses,'') NOT ILIKE '%派件失败%'
            AND coalesce(ai.return_package_statuses,'') NOT ILIKE '%派件异常%'
            AND coalesce(ai.order_sub_statuses,'') NOT ILIKE '%派件失败%'
            AND coalesce(ai.order_sub_statuses,'') NOT ILIKE '%派件异常%'
          THEN 13.88
          ELSE 0
        END
    ) / nullif((CASE WHEN coalesce(ai.revenue_reversal,false) THEN 0 ELSE coalesce(oi.sales_sar,0) END), 0)
  END AS profit_margin_before_storage,
  c.complete_batch_count::bigint AS complete_batch_count,
  c.ignored_batch_count::bigint AS ignored_batch_count,
  (c.unit_cost_sar IS NULL) AS cost_missing,
  coalesce(ai.revenue_reversal,false) AS revenue_reversal,
  coalesce(ai.after_sales_cases,0) AS after_sales_cases,
  coalesce(ai.impact_quantity,0) AS impact_quantity,
  coalesce(ai.impact_amount_sar,0) AS impact_amount_sar,
  ai.resolution_plans,
  ai.order_sub_statuses,
  ai.return_package_statuses
FROM fact.order_item oi
LEFT JOIN dim.store s ON s.store_key = oi.store_key
LEFT JOIN mart.product_unit_cost_by_match_key c
  ON c.match_key <> ''
 AND c.match_key = dim.product_match_key(oi.standard_goods_sn)
LEFT JOIN LATERAL (
  SELECT *
  FROM mart.profit_after_sales_impact x
  WHERE x.store_key = oi.store_key
    AND x.order_no = oi.order_no
    AND x.revenue_reversal
    AND (
      (coalesce(x.skc,'') <> '' AND x.skc = oi.skc)
      OR (coalesce(x.standard_goods_sn,'') <> '' AND x.standard_goods_sn = oi.standard_goods_sn)
      OR (coalesce(x.skc,'') = '' AND coalesce(x.standard_goods_sn,'') = '')
    )
  ORDER BY CASE WHEN x.skc = oi.skc THEN 0 WHEN x.standard_goods_sn = oi.standard_goods_sn THEN 1 ELSE 2 END
  LIMIT 1
) ai ON true;

CREATE OR REPLACE VIEW mart.profit_daily_store_product AS
SELECT
  created_date AS date,
  store_key,
  group_key,
  standard_goods_sn,
  count(*) AS order_lines,
  count(DISTINCT order_key) AS orders,
  sum(quantity) AS quantity,
  sum(gross_revenue_sar) AS gross_revenue_sar,
  sum(net_revenue_sar) AS net_revenue_sar,
  sum(product_cost_sar) FILTER (WHERE NOT cost_missing) AS product_cost_sar,
  sum(return_delivery_fee_sar) AS return_delivery_fee_sar,
  sum(profit_before_storage_sar) FILTER (WHERE NOT cost_missing) AS profit_before_storage_sar,
  sum(net_revenue_sar) FILTER (WHERE NOT cost_missing) AS known_net_revenue_sar,
  sum(gross_revenue_sar) FILTER (WHERE NOT cost_missing) AS known_gross_revenue_sar,
  sum(gross_revenue_sar) FILTER (WHERE cost_missing) AS missing_cost_revenue_sar,
  sum(quantity) FILTER (WHERE cost_missing) AS missing_cost_quantity,
  count(*) FILTER (WHERE cost_missing) AS missing_cost_lines,
  count(*) FILTER (WHERE revenue_reversal) AS reversal_lines,
  sum(return_delivery_fee_sar) FILTER (WHERE revenue_reversal) AS reversal_fee_sar,
  CASE
    WHEN sum(net_revenue_sar) FILTER (WHERE NOT cost_missing) > 0
    THEN sum(profit_before_storage_sar) FILTER (WHERE NOT cost_missing)
      / nullif(sum(net_revenue_sar) FILTER (WHERE NOT cost_missing), 0)
    ELSE NULL
  END AS profit_margin_before_storage,
  CASE
    WHEN sum(gross_revenue_sar) > 0
    THEN sum(gross_revenue_sar) FILTER (WHERE NOT cost_missing) / nullif(sum(gross_revenue_sar), 0)
    ELSE NULL
  END AS cost_coverage_revenue_rate
FROM mart.profit_order_item
GROUP BY created_date, store_key, group_key, standard_goods_sn;

CREATE OR REPLACE VIEW mart.profit_month_group AS
WITH group_month AS (
  SELECT
    month_start,
    group_key,
    sum(gross_revenue_sar) AS gross_revenue_sar,
    sum(net_revenue_sar) AS net_revenue_sar,
    sum(product_cost_sar) FILTER (WHERE NOT cost_missing) AS product_cost_sar,
    sum(return_delivery_fee_sar) AS return_delivery_fee_sar,
    sum(profit_before_storage_sar) FILTER (WHERE NOT cost_missing) AS profit_before_storage_sar,
    sum(gross_revenue_sar) FILTER (WHERE NOT cost_missing) AS known_gross_revenue_sar,
    sum(gross_revenue_sar) FILTER (WHERE cost_missing) AS missing_cost_revenue_sar,
    count(*) FILTER (WHERE cost_missing) AS missing_cost_lines,
    count(*) FILTER (WHERE revenue_reversal) AS reversal_lines
  FROM mart.profit_order_item
  GROUP BY month_start, group_key
),
month_total AS (
  SELECT month_start, sum(net_revenue_sar) AS month_net_revenue_sar
  FROM group_month
  GROUP BY month_start
)
SELECT
  g.month_start,
  g.group_key,
  g.gross_revenue_sar,
  g.net_revenue_sar,
  g.product_cost_sar,
  g.return_delivery_fee_sar,
  g.profit_before_storage_sar,
  g.known_gross_revenue_sar,
  g.missing_cost_revenue_sar,
  g.missing_cost_lines,
  g.reversal_lines,
  coalesce(sf.total_fee_sar,0) AS month_storage_fee_sar,
  CASE
    WHEN coalesce(mt.month_net_revenue_sar,0) > 0
    THEN coalesce(sf.total_fee_sar,0) * g.net_revenue_sar / nullif(mt.month_net_revenue_sar,0)
    ELSE 0
  END AS allocated_storage_fee_sar,
  g.profit_before_storage_sar
    - CASE
        WHEN coalesce(mt.month_net_revenue_sar,0) > 0
        THEN coalesce(sf.total_fee_sar,0) * g.net_revenue_sar / nullif(mt.month_net_revenue_sar,0)
        ELSE 0
      END AS profit_after_storage_sar,
  CASE
    WHEN g.net_revenue_sar > 0
    THEN (
      g.profit_before_storage_sar
      - CASE
          WHEN coalesce(mt.month_net_revenue_sar,0) > 0
          THEN coalesce(sf.total_fee_sar,0) * g.net_revenue_sar / nullif(mt.month_net_revenue_sar,0)
          ELSE 0
        END
    ) / nullif(g.net_revenue_sar,0)
    ELSE NULL
  END AS profit_margin_after_storage,
  CASE
    WHEN g.gross_revenue_sar > 0 THEN g.known_gross_revenue_sar / nullif(g.gross_revenue_sar,0)
    ELSE NULL
  END AS cost_coverage_revenue_rate
FROM group_month g
JOIN month_total mt ON mt.month_start = g.month_start
LEFT JOIN fact.monthly_storage_fee sf ON sf.month_start = g.month_start;

CREATE OR REPLACE VIEW mart.profit_product_summary AS
SELECT
  p.standard_goods_sn,
  sum(p.gross_revenue_sar) AS gross_revenue_sar,
  sum(p.net_revenue_sar) AS net_revenue_sar,
  sum(p.quantity) AS quantity,
  sum(p.product_cost_sar) AS product_cost_sar,
  sum(p.return_delivery_fee_sar) AS return_delivery_fee_sar,
  sum(p.profit_before_storage_sar) AS profit_before_storage_sar,
  CASE
    WHEN sum(p.net_revenue_sar) FILTER (WHERE p.missing_cost_lines = 0) > 0
    THEN sum(p.profit_before_storage_sar) / nullif(sum(p.known_net_revenue_sar),0)
    ELSE NULL
  END AS profit_margin_before_storage,
  sum(p.missing_cost_revenue_sar) AS missing_cost_revenue_sar,
  sum(p.missing_cost_quantity) AS missing_cost_quantity,
  sum(p.missing_cost_lines) AS missing_cost_lines,
  sum(p.reversal_lines) AS reversal_lines,
  max(c.unit_cost_sar) AS unit_cost_sar,
  max(c.complete_batch_count)::bigint AS complete_batch_count,
  max(c.ignored_batch_count)::bigint AS ignored_batch_count,
  max(c.costed_quantity) AS costed_quantity,
  max(c.avg_purchase_unit_price) AS avg_purchase_unit_price,
  max(c.avg_volume_l) AS avg_volume_l,
  max(c.avg_weight_kg) AS avg_weight_kg,
  max(c.last_imported_at) AS last_cost_imported_at,
  CASE
    WHEN sum(p.gross_revenue_sar) > 0
    THEN sum(p.known_gross_revenue_sar) / nullif(sum(p.gross_revenue_sar),0)
    ELSE NULL
  END AS cost_coverage_revenue_rate
FROM mart.profit_daily_store_product p
LEFT JOIN mart.product_unit_cost_by_match_key c
  ON c.match_key <> ''
 AND c.match_key = dim.product_match_key(p.standard_goods_sn)
GROUP BY p.standard_goods_sn;

CREATE OR REPLACE VIEW mart.bi_store_overview_current AS
WITH latest_sales AS (
  SELECT max(date) AS date FROM fact.store_daily_sales
),
latest_link AS (
  SELECT max(snapshot_date) AS date FROM fact.link_master_snapshot
),
latest_action AS (
  SELECT max(date) AS date FROM mart.link_action_candidate
),
link_counts AS (
  SELECT
    store_key,
    count(*) FILTER (WHERE is_on_shelf) AS on_shelf_links,
    count(*) FILTER (WHERE is_wait_shelf) AS wait_shelf_links,
    count(*) FILTER (WHERE is_sold_out) AS sold_out_links,
    count(*) FILTER (WHERE is_out_shelf AND coalesce(is_hard_dead,false) = false) AS out_shelf_links,
    count(*) FILTER (WHERE wait_shelf_blocked) AS wait_shelf_blocked_links,
    count(DISTINCT standard_goods_sn) FILTER (WHERE is_on_shelf) AS on_shelf_product_count
  FROM fact.link_master_snapshot
  WHERE snapshot_date = (SELECT date FROM latest_link)
    AND coalesce(is_hard_dead,false) = false
  GROUP BY store_key
),
action_counts AS (
  SELECT
    store_key,
    count(*) AS action_count,
    count(*) FILTER (WHERE focus) AS focus_action_count,
    count(*) FILTER (WHERE type ILIKE '%补%' OR category ILIKE '%缺%') AS supplement_action_count,
    count(*) FILTER (WHERE type ILIKE '%优化%' OR category ILIKE '%优化%') AS optimize_action_count,
    count(*) FILTER (WHERE type ILIKE '%下架%' OR category ILIKE '%淘汰%') AS retire_action_count
  FROM mart.link_action_candidate
  WHERE date = (SELECT date FROM latest_action)
  GROUP BY store_key
),
coverage_counts AS (
  SELECT
    store_key,
    count(*) FILTER (WHERE need_supplement_link) AS missing_product_count,
    count(*) FILTER (WHERE duplicate_on_shelf) AS duplicate_product_count
  FROM fact.product_store_coverage
  WHERE date = (SELECT date FROM latest_link)
  GROUP BY store_key
)
SELECT
  s.store_key,
  s.group_key,
  s.shop_name,
  (SELECT date FROM latest_sales) AS sales_date,
  (SELECT date FROM latest_link) AS link_date,
  coalesce(sd.sales_sar, 0) AS sales_sar,
  coalesce(sd.sales_rmb, 0) AS sales_rmb,
  coalesce(sd.valid_order_count, 0) AS valid_order_count,
  coalesce(sd.goods_line_count, 0) AS goods_line_count,
  coalesce(sd.quantity_all, 0) AS quantity_all,
  coalesce(lc.on_shelf_links, 0) AS on_shelf_links,
  coalesce(lc.wait_shelf_links, 0) AS wait_shelf_links,
  coalesce(lc.sold_out_links, 0) AS sold_out_links,
  coalesce(lc.out_shelf_links, 0) AS out_shelf_links,
  coalesce(lc.wait_shelf_blocked_links, 0) AS wait_shelf_blocked_links,
  coalesce(lc.on_shelf_product_count, 0) AS on_shelf_product_count,
  coalesce(cc.missing_product_count, 0) AS missing_product_count,
  coalesce(cc.duplicate_product_count, 0) AS duplicate_product_count,
  coalesce(ac.action_count, 0) AS action_count,
  coalesce(ac.focus_action_count, 0) AS focus_action_count,
  coalesce(ac.supplement_action_count, 0) AS supplement_action_count,
  coalesce(ac.optimize_action_count, 0) AS optimize_action_count,
  coalesce(ac.retire_action_count, 0) AS retire_action_count
FROM dim.store s
LEFT JOIN fact.store_daily_sales sd
  ON sd.store_key = s.store_key AND sd.date = (SELECT date FROM latest_sales)
LEFT JOIN link_counts lc ON lc.store_key = s.store_key
LEFT JOIN action_counts ac ON ac.store_key = s.store_key
LEFT JOIN coverage_counts cc ON cc.store_key = s.store_key
WHERE s.enabled = true;

CREATE OR REPLACE VIEW mart.bi_store_product_matrix_current AS
WITH latest_sales AS (
  SELECT max(created_date) AS date FROM fact.order_item
),
latest_link AS (
  SELECT max(date) AS date FROM fact.product_store_coverage
),
sales AS (
  SELECT
    store_key,
    standard_goods_sn,
    sum(sales_sar) AS sales_sar,
    sum(quantity) AS quantity,
    count(DISTINCT order_key) AS order_count
  FROM fact.order_item
  WHERE created_date = (SELECT date FROM latest_sales)
  GROUP BY store_key, standard_goods_sn
),
actions AS (
  SELECT
    store_key,
    standard_goods_sn,
    count(*) AS action_count,
    count(*) FILTER (WHERE focus) AS focus_action_count,
    max(score) AS max_action_score
  FROM mart.link_action_candidate
  WHERE date = (SELECT date FROM latest_link)
  GROUP BY store_key, standard_goods_sn
)
SELECT
  c.date AS link_date,
  (SELECT date FROM latest_sales) AS sales_date,
  c.group_key,
  c.store_key,
  c.shop_name,
  c.standard_goods_sn,
  c.coverage_status,
  c.has_on_shelf_link,
  c.need_supplement_link,
  c.link_count,
  c.on_shelf_count,
  c.wait_shelf_count,
  c.sold_out_count,
  c.out_shelf_count,
  c.duplicate_on_shelf,
  c.best_skc,
  c.best_link_c30_sale,
  c.skc_list,
  coalesce(s.sales_sar, 0) AS sales_sar,
  coalesce(s.quantity, 0) AS quantity,
  coalesce(s.order_count, 0) AS order_count,
  coalesce(a.action_count, 0) AS action_count,
  coalesce(a.focus_action_count, 0) AS focus_action_count,
  coalesce(a.max_action_score, 0) AS max_action_score
FROM fact.product_store_coverage c
LEFT JOIN sales s
  ON s.store_key = c.store_key AND s.standard_goods_sn = c.standard_goods_sn
LEFT JOIN actions a
  ON a.store_key = c.store_key AND a.standard_goods_sn = c.standard_goods_sn
WHERE c.date = (SELECT date FROM latest_link);

CREATE OR REPLACE VIEW mart.bi_product_overview_current AS
WITH base AS (
  SELECT * FROM mart.bi_store_product_matrix_current
)
SELECT
  standard_goods_sn,
  max(link_date) AS link_date,
  max(sales_date) AS sales_date,
  sum(sales_sar) AS sales_sar,
  sum(quantity) AS quantity,
  sum(order_count) AS order_count,
  count(*) FILTER (WHERE has_on_shelf_link) AS on_shelf_store_count,
  count(*) FILTER (WHERE need_supplement_link) AS missing_store_count,
  string_agg(store_key, ',' ORDER BY store_key) FILTER (WHERE need_supplement_link) AS missing_stores,
  string_agg(store_key, ',' ORDER BY store_key) FILTER (WHERE has_on_shelf_link) AS on_shelf_stores,
  sum(action_count) AS action_count,
  sum(focus_action_count) AS focus_action_count,
  max(max_action_score) AS max_action_score,
  max(best_skc) FILTER (WHERE best_skc IS NOT NULL AND best_skc <> '') AS sample_skc,
  sum(on_shelf_count) AS on_shelf_link_count,
  sum(wait_shelf_count) AS wait_shelf_link_count,
  sum(sold_out_count) AS sold_out_link_count,
  sum(out_shelf_count) AS out_shelf_link_count
FROM base
WHERE standard_goods_sn IS NOT NULL AND standard_goods_sn <> ''
GROUP BY standard_goods_sn;

CREATE OR REPLACE VIEW mart.bi_link_health_current AS
WITH latest_link AS (
  SELECT max(snapshot_date) AS date FROM fact.link_master_snapshot
),
perf AS (
  SELECT *
  FROM fact.link_performance_daily
  WHERE date = (SELECT date FROM latest_link)
),
store_product_link_count AS (
  SELECT
    store_key,
    standard_goods_sn,
    count(*) FILTER (WHERE is_on_shelf) AS on_shelf_count
  FROM fact.link_master_snapshot
  WHERE snapshot_date = (SELECT date FROM latest_link)
    AND coalesce(is_hard_dead,false) = false
  GROUP BY store_key, standard_goods_sn
)
SELECT
  l.snapshot_date AS link_date,
  l.group_key,
  l.store_key,
  l.shop_name,
  l.standard_goods_sn,
  l.raw_goods_sn,
  l.spu,
  l.skc,
  l.sale_name,
  l.product_name_cn,
  l.image_url,
  l.shelf_status,
  l.shelf_status_name,
  l.is_on_shelf,
  l.is_wait_shelf,
  l.is_sold_out,
  l.is_out_shelf,
  l.wait_shelf_blocked,
  l.wait_shelf_block_reason,
  CASE
    WHEN l.first_shelf_time IS NULL THEN NULL
    ELSE (l.snapshot_date - l.first_shelf_time::date)
  END AS shelf_age_days,
  coalesce(p.sale_cnt, 0) AS sale_cnt,
  coalesce(p.c7_sale_cnt, 0) AS c7_sale_cnt,
  coalesce(p.prev7_sale_cnt, 0) AS prev7_sale_cnt,
  coalesce(p.c30_sale_cnt, 0) AS c30_sale_cnt,
  coalesce(p.eps_uv, 0) AS eps_uv,
  coalesce(p.goods_uv, 0) AS goods_uv,
  coalesce(p.click_rate, 0) AS click_rate,
  coalesce(p.cart_uv, 0) AS cart_uv,
  coalesce(p.cart_rate, 0) AS cart_rate,
  coalesce(p.pay_uv, 0) AS pay_uv,
  coalesce(p.pay_rate, 0) AS pay_rate,
  p.quality_grade,
  coalesce(p.comment_count, 0) AS comment_count,
  coalesce(p.bad_comment_rate, 0) AS bad_comment_rate,
  coalesce(p.return_order_count, 0) AS return_order_count,
  coalesce(p.return_item_count, 0) AS return_item_count,
  p.activity_tag,
  p.activity_names,
  p.flow_diagnose_tabs,
  coalesce(sp.on_shelf_count, 0) AS same_product_on_shelf_count,
  (l.is_on_shelf
    AND coalesce(l.is_hard_dead,false) = false
    AND l.first_shelf_time IS NOT NULL
    AND l.first_shelf_time::date <= (l.snapshot_date - 30)
    AND coalesce(p.c30_sale_cnt,0) = 0) AS retire_candidate,
  (l.is_on_shelf
    AND coalesce(p.eps_uv,0) >= 100
    AND coalesce(p.click_rate,0) > 0
    AND coalesce(p.click_rate,0) < 0.02) AS high_exposure_low_click,
  (l.is_on_shelf
    AND coalesce(p.goods_uv,0) >= 30
    AND coalesce(p.pay_rate,0) < 0.01) AS high_visit_low_pay,
  (l.is_wait_shelf AND l.wait_shelf_blocked) AS wait_shelf_block_candidate,
  CASE
    WHEN l.is_wait_shelf AND l.wait_shelf_blocked THEN '待上架卡点'
    WHEN l.is_on_shelf AND coalesce(p.c30_sale_cnt,0) = 0
      AND l.first_shelf_time IS NOT NULL
      AND l.first_shelf_time::date <= (l.snapshot_date - 30) THEN '下架候选'
    WHEN l.is_on_shelf AND coalesce(p.eps_uv,0) >= 100 AND coalesce(p.click_rate,0) < 0.02 THEN '优化：高曝光低点击'
    WHEN l.is_on_shelf AND coalesce(p.goods_uv,0) >= 30 AND coalesce(p.pay_rate,0) < 0.01 THEN '优化：高访客低支付'
    WHEN l.is_on_shelf THEN '正常在售'
    WHEN l.is_sold_out THEN '已售罄'
    ELSE coalesce(l.shelf_status_name, '未知')
  END AS health_bucket
FROM fact.link_master_snapshot l
LEFT JOIN perf p
  ON p.date = l.snapshot_date AND p.store_key = l.store_key AND p.skc = l.skc
LEFT JOIN store_product_link_count sp
  ON sp.store_key = l.store_key AND sp.standard_goods_sn = l.standard_goods_sn
WHERE l.snapshot_date = (SELECT date FROM latest_link)
  AND coalesce(l.is_hard_dead,false) = false;

CREATE OR REPLACE VIEW mart.bi_action_queue_current AS
SELECT
  date,
  group_key,
  store_key,
  shop_name,
  focus,
  type,
  category,
  priority,
  score,
  standard_goods_sn,
  skc,
  title,
  reason,
  evidence,
  next_step,
  source,
  action_id
FROM mart.link_action_candidate
WHERE date = (SELECT max(date) FROM mart.link_action_candidate);

CREATE OR REPLACE VIEW mart.bi_business_store_current AS
WITH latest_sales AS (SELECT max(date) AS date FROM fact.store_daily_sales),
latest_link AS (SELECT max(snapshot_date) AS date FROM fact.link_master_snapshot),
latest_business AS (SELECT max(snapshot_date) AS date FROM fact.home_finance_snapshot),
latest_fulfillment AS (SELECT max(date) AS date FROM fact.fulfillment_performance_daily),
finance_overview AS (
  SELECT
    store_key,
    max(pay_amount) FILTER (WHERE module_enum = 'NO_FINISH_ORDER') AS gsfs_in_transit_order_amount_sar,
    max(pay_amount) FILTER (WHERE module_enum = 'WAIT_PAY') AS gsfs_pending_settlement_income_sar,
    max(pay_amount) FILTER (WHERE module_enum = 'PAYED') AS gsfs_payed_income_sar
  FROM fact.finance_income_overview_snapshot
  WHERE snapshot_date = (SELECT date FROM latest_business)
  GROUP BY store_key
),
finance_order AS (
  SELECT
    store_key,
    count(*) AS finance_no_finish_order_count,
    sum(coalesce(estimate_income_money_total,0)) AS finance_no_finish_order_income_sar
  FROM fact.finance_no_finish_order
  WHERE snapshot_date = (SELECT date FROM latest_business)
  GROUP BY store_key
),
finance_account AS (
  SELECT DISTINCT ON (store_key)
    store_key,
    account_period_days,
    privilege_provide_time,
    is_high_quality_supplier,
    privilege_config_type_desc,
    allow_view_report,
    report_delay_show
  FROM fact.finance_account_period_snapshot
  WHERE snapshot_date = (SELECT date FROM latest_business)
  ORDER BY store_key, updated_at DESC
),
after_sales AS (
  SELECT
    store_key,
    count(DISTINCT aftersales_order_no) AS after_sales_case_count,
    count(*) AS after_sales_item_count,
    sum(coalesce(price_amount, 0)) AS after_sales_item_amount_sar,
    count(*) FILTER (WHERE reason_names ILIKE '%质量%' OR reason_names ILIKE '%坏%' OR reason_names ILIKE '%破%') AS quality_after_sales_item_count
  FROM fact.after_sales_item
  WHERE snapshot_date = (SELECT date FROM latest_business)
  GROUP BY store_key
),
waybill AS (
  SELECT
    store_key,
    count(*) AS waybill_package_count,
    count(*) FILTER (WHERE tag_desc ILIKE '%揽收%' OR show_status_desc ILIKE '%成功%') AS waybill_success_count,
    count(*) FILTER (WHERE show_status_code ILIKE '%FAIL%' OR place_state::text IN ('3','4')) AS waybill_exception_count,
    sum(coalesce(estimate_performance_price,0)) AS estimated_fulfillment_fee_sar
  FROM fact.waybill_package
  WHERE snapshot_date = (SELECT date FROM latest_business)
  GROUP BY store_key
),
inventory AS (
  SELECT
    store_key,
    count(*) AS inventory_spu_count,
    sum(coalesce(inventory_quantity,0)) AS display_inventory_total,
    sum(coalesce(usable_inventory,0)) AS usable_inventory_total,
    count(*) FILTER (WHERE display_stock_low AND coalesce(shelf_statuses,'') LIKE '%ON_SHELF%') AS low_display_stock_count
  FROM fact.visible_inventory_snapshot
  WHERE snapshot_date = (SELECT date FROM latest_business)
  GROUP BY store_key
),
quality AS (
  SELECT
    store_key,
    count(*) AS quality_skc_count,
    count(*) FILTER (WHERE coalesce(quality_return_rate,0) > 0) AS quality_return_skc_count,
    avg(quality_return_rate) AS avg_quality_return_rate,
    avg(show_bad_eval_rate) AS avg_bad_eval_rate
  FROM fact.quality_skc_snapshot
  WHERE snapshot_date = (SELECT date FROM latest_business)
  GROUP BY store_key
),
comments AS (
  SELECT
    store_key,
    count(*) AS comment_count,
    count(*) FILTER (WHERE goods_comment_star <= 3) AS low_star_comment_count,
    avg(goods_comment_star) AS avg_comment_star
  FROM fact.product_comment
  WHERE comment_date >= ((SELECT date FROM latest_business) - 90)
  GROUP BY store_key
),
marketing AS (
  SELECT
    store_key,
    max(sale_amt) AS marketing_sale_amt,
    max(sale_cnt) AS marketing_sale_cnt,
    max(avg_goods_uv_idx) AS marketing_goods_uv_idx
  FROM fact.marketing_overview_daily
  WHERE date = (SELECT date FROM latest_business)
  GROUP BY store_key
),
campaign AS (
  SELECT
    store_key,
    count(*) AS campaign_count,
    count(*) FILTER (WHERE current_date BETWEEN start_date AND end_date) AS active_campaign_count
  FROM fact.marketing_campaign_snapshot
  WHERE snapshot_date = (SELECT date FROM latest_business)
  GROUP BY store_key
),
fulfillment AS (
  SELECT DISTINCT ON (store_key)
    store_key,
    collect_ok_rate,
    sign_ok_rate,
    collect_bad_rate,
    sign_bad_rate,
    seller_cancel_rate,
    delivery_timeout_rate,
    valid_track_rate,
    total_order_item_cnt
  FROM fact.fulfillment_performance_daily
  WHERE date = (SELECT date FROM latest_fulfillment)
  ORDER BY store_key, date DESC
)
SELECT
  s.store_key,
  s.group_key,
  s.shop_name,
  (SELECT date FROM latest_sales) AS sales_date,
  (SELECT date FROM latest_link) AS link_date,
  (SELECT date FROM latest_business) AS business_snapshot_date,
  coalesce(sd.sales_sar,0) AS sales_sar,
  coalesce(sd.valid_order_count,0) AS valid_order_count,
  coalesce(sd.quantity_positive_amount,0) AS quantity,
  coalesce(h.trade_amount_sar,0) AS realtime_trade_amount_sar,
  coalesce(h.pay_user_count,0) AS realtime_pay_user_count,
  coalesce(h.goods_uv,0) AS realtime_goods_uv,
  coalesce(fo.gsfs_in_transit_order_amount_sar, h.in_transit_order_amount_sar,0) AS in_transit_order_amount_sar,
  coalesce(fo.gsfs_pending_settlement_income_sar, h.pending_settlement_income_sar,0) AS pending_settlement_income_sar,
  coalesce(h.settlement_abnormal_sar,0) AS settlement_abnormal_sar,
  coalesce(h.withdrawable_amount_sar,0) AS withdrawable_amount_sar,
  coalesce(l.on_shelf_links,0) AS on_shelf_links,
  coalesce(l.wait_shelf_blocked_links,0) AS wait_shelf_blocked_links,
  coalesce(l.missing_product_count,0) AS missing_product_count,
  coalesce(l.action_count,0) AS link_action_count,
  coalesce(l.retire_action_count,0) AS retire_action_count,
  coalesce(a.after_sales_case_count,0) AS after_sales_case_count,
  coalesce(a.after_sales_item_count,0) AS after_sales_item_count,
  coalesce(a.after_sales_item_amount_sar,0) AS after_sales_item_amount_sar,
  coalesce(a.quality_after_sales_item_count,0) AS quality_after_sales_item_count,
  coalesce(w.waybill_package_count,0) AS waybill_package_count,
  coalesce(w.waybill_success_count,0) AS waybill_success_count,
  coalesce(w.waybill_exception_count,0) AS waybill_exception_count,
  coalesce(w.estimated_fulfillment_fee_sar,0) AS estimated_fulfillment_fee_sar,
  coalesce(i.inventory_spu_count,0) AS inventory_spu_count,
  coalesce(i.display_inventory_total,0) AS display_inventory_total,
  coalesce(i.usable_inventory_total,0) AS usable_inventory_total,
  coalesce(i.low_display_stock_count,0) AS low_display_stock_count,
  coalesce(q.quality_skc_count,0) AS quality_skc_count,
  coalesce(q.quality_return_skc_count,0) AS quality_return_skc_count,
  coalesce(q.avg_quality_return_rate,0) AS avg_quality_return_rate,
  coalesce(q.avg_bad_eval_rate,0) AS avg_bad_eval_rate,
  coalesce(c.comment_count,0) AS comment_count,
  coalesce(c.low_star_comment_count,0) AS low_star_comment_count,
  coalesce(c.avg_comment_star,0) AS avg_comment_star,
  coalesce(f.collect_ok_rate,0) AS collect_ok_rate,
  coalesce(f.seller_cancel_rate,0) AS seller_cancel_rate,
  coalesce(f.delivery_timeout_rate,0) AS delivery_timeout_rate,
  coalesce(m.marketing_sale_amt,0) AS marketing_sale_amt,
  coalesce(ca.campaign_count,0) AS campaign_count,
  coalesce(ca.active_campaign_count,0) AS active_campaign_count,
  CASE
    WHEN coalesce(sd.sales_sar,0) = 0 THEN NULL
    ELSE round((coalesce(a.after_sales_item_amount_sar,0) / nullif(sd.sales_sar,0))::numeric, 4)
  END AS after_sales_amount_rate,
  (
    coalesce(l.action_count,0) * 1.0
    + coalesce(l.retire_action_count,0) * 2.0
    + coalesce(a.quality_after_sales_item_count,0) * 3.0
    + coalesce(i.low_display_stock_count,0) * 2.0
    + coalesce(w.waybill_exception_count,0) * 2.0
    + coalesce(c.low_star_comment_count,0) * 1.5
  ) AS risk_score,
  coalesce(fo.gsfs_payed_income_sar,0) AS payed_income_sar,
  coalesce(fno.finance_no_finish_order_count,0) AS finance_no_finish_order_count,
  coalesce(fno.finance_no_finish_order_income_sar,0) AS finance_no_finish_order_income_sar,
  fa.account_period_days AS account_period_days,
  fa.privilege_provide_time AS privilege_provide_time,
  coalesce(fa.is_high_quality_supplier,false) AS is_high_quality_supplier,
  fa.privilege_config_type_desc AS privilege_config_type_desc,
  coalesce(fa.allow_view_report,false) AS allow_view_report,
  coalesce(fa.report_delay_show,false) AS report_delay_show
FROM dim.store s
LEFT JOIN mart.bi_store_overview_current l ON l.store_key = s.store_key
LEFT JOIN fact.store_daily_sales sd ON sd.store_key = s.store_key AND sd.date = (SELECT date FROM latest_sales)
LEFT JOIN fact.home_finance_snapshot h ON h.store_key = s.store_key AND h.snapshot_date = (SELECT date FROM latest_business)
LEFT JOIN finance_overview fo ON fo.store_key = s.store_key
LEFT JOIN finance_order fno ON fno.store_key = s.store_key
LEFT JOIN finance_account fa ON fa.store_key = s.store_key
LEFT JOIN after_sales a ON a.store_key = s.store_key
LEFT JOIN waybill w ON w.store_key = s.store_key
LEFT JOIN inventory i ON i.store_key = s.store_key
LEFT JOIN quality q ON q.store_key = s.store_key
LEFT JOIN comments c ON c.store_key = s.store_key
LEFT JOIN fulfillment f ON f.store_key = s.store_key
LEFT JOIN marketing m ON m.store_key = s.store_key
LEFT JOIN campaign ca ON ca.store_key = s.store_key
WHERE s.enabled = true;

CREATE OR REPLACE VIEW mart.bi_product_360_current AS
WITH latest_business AS (SELECT max(snapshot_date) AS date FROM fact.home_finance_snapshot),
latest_link AS (SELECT max(snapshot_date) AS date FROM fact.link_master_snapshot),
sales AS (
  SELECT
    standard_goods_sn,
    sum(sales_sar) AS sales_sar,
    sum(quantity) AS quantity,
    count(DISTINCT order_key) AS order_count,
    count(DISTINCT store_key) AS sale_store_count
  FROM fact.order_item
  WHERE created_date = (SELECT max(created_date) FROM fact.order_item)
  GROUP BY standard_goods_sn
),
coverage AS (
  SELECT
    standard_goods_sn,
    count(*) FILTER (WHERE has_on_shelf_link) AS on_shelf_store_count,
    count(*) FILTER (WHERE need_supplement_link) AS missing_store_count,
    sum(on_shelf_count) AS on_shelf_link_count,
    sum(wait_shelf_count) AS wait_shelf_link_count,
    sum(sold_out_count) AS sold_out_link_count
  FROM fact.product_store_coverage
  WHERE date = (SELECT date FROM latest_link)
  GROUP BY standard_goods_sn
),
inventory AS (
  SELECT
    standard_goods_sn,
    sum(coalesce(usable_inventory,0)) AS usable_inventory,
    sum(coalesce(inventory_quantity,0)) AS display_inventory,
    count(*) FILTER (WHERE display_stock_low AND coalesce(shelf_statuses,'') LIKE '%ON_SHELF%') AS low_display_stock_count
  FROM fact.visible_inventory_snapshot
  WHERE snapshot_date = (SELECT date FROM latest_business)
  GROUP BY standard_goods_sn
),
quality AS (
  SELECT
    standard_goods_sn,
    count(*) AS quality_skc_count,
    sum(coalesce(return_volume,0)) AS return_volume,
    sum(coalesce(quality_return_volume,0)) AS quality_return_volume,
    avg(quality_return_rate) AS avg_quality_return_rate,
    avg(show_bad_eval_rate) AS avg_bad_eval_rate
  FROM fact.quality_skc_snapshot
  WHERE snapshot_date = (SELECT date FROM latest_business)
  GROUP BY standard_goods_sn
),
after_sales AS (
  SELECT
    standard_goods_sn,
    count(DISTINCT aftersales_order_no) AS after_sales_case_count,
    sum(coalesce(price_amount,0)) AS after_sales_amount_sar,
    string_agg(DISTINCT reason_names, ' / ') AS after_sales_reasons
  FROM fact.after_sales_item
  WHERE snapshot_date = (SELECT date FROM latest_business)
  GROUP BY standard_goods_sn
),
comments AS (
  SELECT
    standard_goods_sn,
    count(*) AS comment_count,
    count(*) FILTER (WHERE goods_comment_star <= 3) AS low_star_comment_count,
    avg(goods_comment_star) AS avg_comment_star
  FROM fact.product_comment
  WHERE comment_date >= ((SELECT date FROM latest_business) - 90)
  GROUP BY standard_goods_sn
)
SELECT
  coalesce(s.standard_goods_sn, c.standard_goods_sn, i.standard_goods_sn, q.standard_goods_sn, a.standard_goods_sn, cm.standard_goods_sn) AS standard_goods_sn,
  coalesce(s.sales_sar,0) AS sales_sar,
  coalesce(s.quantity,0) AS quantity,
  coalesce(s.order_count,0) AS order_count,
  coalesce(s.sale_store_count,0) AS sale_store_count,
  coalesce(c.on_shelf_store_count,0) AS on_shelf_store_count,
  coalesce(c.missing_store_count,0) AS missing_store_count,
  coalesce(c.on_shelf_link_count,0) AS on_shelf_link_count,
  coalesce(c.wait_shelf_link_count,0) AS wait_shelf_link_count,
  coalesce(c.sold_out_link_count,0) AS sold_out_link_count,
  coalesce(i.usable_inventory,0) AS usable_inventory,
  coalesce(i.display_inventory,0) AS display_inventory,
  coalesce(i.low_display_stock_count,0) AS low_display_stock_count,
  coalesce(q.quality_skc_count,0) AS quality_skc_count,
  coalesce(q.return_volume,0) AS return_volume,
  coalesce(q.quality_return_volume,0) AS quality_return_volume,
  coalesce(q.avg_quality_return_rate,0) AS avg_quality_return_rate,
  coalesce(q.avg_bad_eval_rate,0) AS avg_bad_eval_rate,
  coalesce(a.after_sales_case_count,0) AS after_sales_case_count,
  coalesce(a.after_sales_amount_sar,0) AS after_sales_amount_sar,
  coalesce(a.after_sales_reasons,'') AS after_sales_reasons,
  coalesce(cm.comment_count,0) AS comment_count,
  coalesce(cm.low_star_comment_count,0) AS low_star_comment_count,
  coalesce(cm.avg_comment_star,0) AS avg_comment_star,
  (
    coalesce(c.missing_store_count,0) * 2.0
    + coalesce(i.low_display_stock_count,0) * 3.0
    + coalesce(q.quality_return_volume,0) * 3.0
    + coalesce(a.after_sales_case_count,0) * 2.0
    + coalesce(cm.low_star_comment_count,0) * 1.5
  ) AS risk_score
FROM sales s
FULL JOIN coverage c ON c.standard_goods_sn = s.standard_goods_sn
FULL JOIN inventory i ON i.standard_goods_sn = coalesce(s.standard_goods_sn, c.standard_goods_sn)
FULL JOIN quality q ON q.standard_goods_sn = coalesce(s.standard_goods_sn, c.standard_goods_sn, i.standard_goods_sn)
FULL JOIN after_sales a ON a.standard_goods_sn = coalesce(s.standard_goods_sn, c.standard_goods_sn, i.standard_goods_sn, q.standard_goods_sn)
FULL JOIN comments cm ON cm.standard_goods_sn = coalesce(s.standard_goods_sn, c.standard_goods_sn, i.standard_goods_sn, q.standard_goods_sn, a.standard_goods_sn)
WHERE coalesce(s.standard_goods_sn, c.standard_goods_sn, i.standard_goods_sn, q.standard_goods_sn, a.standard_goods_sn, cm.standard_goods_sn) IS NOT NULL
  AND coalesce(s.standard_goods_sn, c.standard_goods_sn, i.standard_goods_sn, q.standard_goods_sn, a.standard_goods_sn, cm.standard_goods_sn) <> '';

CREATE OR REPLACE VIEW mart.bi_guided_action_current AS
WITH
latest_inventory AS (SELECT max(snapshot_date) AS date FROM fact.visible_inventory_snapshot),
latest_link_perf AS (SELECT max(date) AS date FROM fact.link_performance_daily),
latest_coverage AS (SELECT max(date) AS date FROM fact.product_store_coverage),
latest_quality AS (SELECT max(snapshot_date) AS date FROM fact.quality_skc_snapshot),
latest_after_sales AS (SELECT max(snapshot_date) AS date FROM fact.after_sales_item),
after_sales_group AS (
  SELECT
    snapshot_date AS date,
    store_key,
    group_key,
    standard_goods_sn,
    max(skc) AS skc,
    count(DISTINCT aftersales_order_no) AS case_count,
    sum(coalesce(price_amount, 0)) AS amount_sar,
    string_agg(DISTINCT nullif(reason_names, ''), ' / ') AS reasons,
    string_agg(DISTINCT nullif(order_sub_status_name, ''), ' / ') AS statuses
  FROM fact.after_sales_item
  WHERE snapshot_date = (SELECT date FROM latest_after_sales)
    AND coalesce(standard_goods_sn, '') <> ''
  GROUP BY snapshot_date, store_key, group_key, standard_goods_sn
),
link_sales_group AS (
  SELECT
    store_key,
    standard_goods_sn,
    sum(coalesce(c30_sale_cnt,0)) AS c30_sale_cnt
  FROM fact.link_performance_daily
  WHERE date = (SELECT date FROM latest_link_perf)
    AND coalesce(standard_goods_sn, '') <> ''
  GROUP BY store_key, standard_goods_sn
),
order_sales_30 AS (
  SELECT
    store_key,
    standard_goods_sn,
    sum(coalesce(quantity,0)) AS order_qty_30
  FROM fact.order_item
  WHERE created_date >= ((SELECT date FROM latest_inventory) - 30)
    AND coalesce(standard_goods_sn, '') <> ''
  GROUP BY store_key, standard_goods_sn
),
coverage_latest AS (
  SELECT
    store_key,
    standard_goods_sn,
    max(CASE WHEN coalesce(has_on_shelf_link,false) THEN 1 ELSE 0 END) AS has_on_shelf_link,
    max(coalesce(on_shelf_count,0)) AS on_shelf_count
  FROM fact.product_store_coverage
  WHERE date = (SELECT date FROM latest_coverage)
    AND coalesce(standard_goods_sn, '') <> ''
  GROUP BY store_key, standard_goods_sn
),
inventory_group AS (
  SELECT
    i.snapshot_date AS date,
    i.store_key,
    i.group_key,
    i.standard_goods_sn,
    string_agg(DISTINCT nullif(i.spu, ''), ',') AS spu_list,
    count(*) AS spu_rows,
    min(coalesce(i.usable_inventory, i.inventory_quantity, 0)) AS min_usable_inventory,
    sum(coalesce(i.inventory_quantity, 0)) AS inventory_quantity,
    sum(coalesce(i.usable_inventory, 0)) AS usable_inventory,
    sum(coalesce(i.order_locked_quantity,0)+coalesce(i.pay_locked_quantity,0)) AS locked_quantity,
    bool_or(coalesce(i.shelf_statuses,'') LIKE '%ON_SHELF%') AS low_row_on_shelf,
    max(coalesce(c.has_on_shelf_link,0)) AS has_on_shelf_link,
    max(coalesce(c.on_shelf_count,0)) AS on_shelf_count,
    max(coalesce(ls.c30_sale_cnt,0)) AS c30_sale_cnt,
    max(coalesce(os.order_qty_30,0)) AS order_qty_30
  FROM fact.visible_inventory_snapshot i
  LEFT JOIN link_sales_group ls ON ls.store_key = i.store_key AND ls.standard_goods_sn = i.standard_goods_sn
  LEFT JOIN order_sales_30 os ON os.store_key = i.store_key AND os.standard_goods_sn = i.standard_goods_sn
  LEFT JOIN coverage_latest c ON c.store_key = i.store_key AND c.standard_goods_sn = i.standard_goods_sn
  WHERE i.snapshot_date = (SELECT date FROM latest_inventory)
    AND i.display_stock_low
    AND coalesce(i.standard_goods_sn, '') <> ''
  GROUP BY i.snapshot_date, i.store_key, i.group_key, i.standard_goods_sn
  HAVING bool_or(coalesce(i.shelf_statuses,'') LIKE '%ON_SHELF%')
     AND (max(coalesce(ls.c30_sale_cnt,0)) > 0 OR max(coalesce(os.order_qty_30,0)) > 0)
),
raw_actions AS (
  SELECT
    'link' AS action_domain,
    date,
    store_key,
    group_key,
    standard_goods_sn,
    skc,
    category,
    priority,
    score::numeric AS score,
    title,
    reason,
    evidence,
    next_step
  FROM mart.bi_action_queue_current
  WHERE priority = '高'
     OR coalesce(score, 0) >= 80
     OR category IN ('补链接', '可下架候选', '先替换再下架', '销量下滑')
  UNION ALL
  SELECT
    'inventory' AS action_domain,
    date,
    store_key,
    group_key,
    standard_goods_sn,
    '' AS skc,
    '展示库存低' AS category,
    CASE WHEN min_usable_inventory <= 3 THEN '高' ELSE '中' END AS priority,
    (92 - least(40, greatest(0, min_usable_inventory) * 3))::numeric AS score,
    coalesce(standard_goods_sn, spu_list) AS title,
    'SHEIN商品列表库存接口显示展示库存偏低。' AS reason,
    concat('min_usable=', min_usable_inventory, ', usable_total=', usable_inventory, ', inventory_total=', inventory_quantity, ', locked=', locked_quantity, ', rows=', spu_rows, ', c30_sale=', c30_sale_cnt, ', order30=', order_qty_30, ', on_shelf=', on_shelf_count) AS evidence,
    '如果这个链接还要继续卖，优先去SHEIN后台把展示库存调高；如果已经不准备卖，保留观察即可。' AS next_step
  FROM inventory_group
  UNION ALL
  SELECT
    'quality' AS action_domain,
    snapshot_date AS date,
    store_key,
    group_key,
    standard_goods_sn,
    skc,
    '质量/评价风险' AS category,
    CASE WHEN coalesce(quality_return_volume,0) >= 2 OR coalesce(bad_eval_cnt,0) >= 2 OR coalesce(quality_return_rate,0) >= 0.2 THEN '高' ELSE '中' END AS priority,
    least(95, 65
      + coalesce(quality_return_volume,0) * 8
      + coalesce(bad_eval_cnt,0) * 6
      + coalesce(return_volume,0) * 2
      + coalesce(quality_return_rate,0) * 50
    )::numeric AS score,
    coalesce(standard_goods_sn, skc) AS title,
    '质量退货、低星评价或质量等级出现异常。' AS reason,
    concat('quality_return_rate=', quality_return_rate, ', bad_eval_cnt=', bad_eval_cnt, ', return_volume=', return_volume, ', level=', goods_quality_level) AS evidence,
    '结合评论内容、退货原因、链接表现判断：优先优化详情/图片/质检；严重时考虑替换或下架。' AS next_step
  FROM fact.quality_skc_snapshot
  WHERE snapshot_date = (SELECT date FROM latest_quality)
    AND coalesce(standard_goods_sn, '') <> ''
    AND (
      coalesce(bad_eval_cnt,0) > 0
      OR coalesce(quality_return_volume,0) > 0
      OR coalesce(return_volume,0) >= 3
      OR coalesce(quality_return_rate,0) >= 0.1
    )
  UNION ALL
  SELECT
    'after_sales' AS action_domain,
    date,
    store_key,
    group_key,
    standard_goods_sn,
    skc,
    '售后集中' AS category,
    CASE WHEN case_count >= 3 OR amount_sar >= 150 THEN '高' ELSE '中' END AS priority,
    least(92, 60 + case_count * 7 + amount_sar / 25)::numeric AS score,
    standard_goods_sn AS title,
    coalesce(reasons, statuses, '售后集中') AS reason,
    concat('cases=', case_count, ', amount=', round(amount_sar::numeric,2), ', status=', statuses) AS evidence,
    '把售后原因和质量/评论/链接表现放在一起看，判断是产品问题、描述误导、物流履约还是个别异常。' AS next_step
  FROM after_sales_group
  WHERE case_count >= 2 OR amount_sar >= 120
),
domain_ranked AS (
  SELECT
    *,
    row_number() OVER (PARTITION BY action_domain, store_key ORDER BY score DESC, standard_goods_sn, skc) AS rn_domain_store
  FROM raw_actions
  WHERE coalesce(standard_goods_sn, '') <> ''
    AND coalesce(score, 0) >= 60
),
ranked AS (
  SELECT
    *,
    row_number() OVER (PARTITION BY store_key ORDER BY score DESC, action_domain, standard_goods_sn, skc) AS rn_store
  FROM domain_ranked
  WHERE rn_domain_store <= 3
)
SELECT
  action_domain,
  date,
  store_key,
  group_key,
  standard_goods_sn,
  skc,
  category,
  priority,
  score,
  title,
  reason,
  evidence,
  next_step
FROM ranked
WHERE rn_store <= 12
  AND rn_domain_store <= 3;
