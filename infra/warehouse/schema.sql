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
    WHEN key IN ('EN6236812014A112017', 'PDLFZ666') THEN ''
    WHEN key IN ('2001', 'CM2001') THEN '2001'
    WHEN key IN ('BHRL09') THEN 'BHRL09'
    WHEN key IN ('121', '121E', 'CM121E') THEN 'CM121E'
    WHEN key IN ('CX1788') THEN 'CX1788'
    WHEN key IN ('666', 'FZ666', 'FZ666BEIGE', 'MZ666') THEN 'FZ666'
    WHEN key IN ('GREPC12A', 'NMGREPC12A') THEN 'GREPC12A'
    WHEN key IN ('025', 'HS025') THEN 'HS025'
    WHEN key IN ('389', '689', 'JD389', 'LQ389', 'NM389', 'YJ389', 'ZL389') THEN 'JD389'
    WHEN key IN ('KFJN02') THEN 'KFJN02'
    WHEN key IN ('102', 'HY811', 'KJ102', 'SK102') THEN 'KJ102'
    WHEN key IN ('KJ102S', 'SK102S') THEN 'KJ102S'
    WHEN key IN ('LQPA4L', 'PA4', 'PA46L', 'PA4L', 'PL46L', 'PL46LPINK') THEN 'PA46L'
    WHEN key IN ('1810', 'BL02', 'BL031', 'GLBL02', 'S1810', 'WK102') THEN 'S1810'
    WHEN key IN ('03012', 'LQ03012', 'MK03012', 'SK03012') THEN 'SK03012'
    WHEN key IN ('03038', 'SK03038') THEN 'SK03038'
    WHEN key IN ('FY29', 'SK04029') THEN 'SK04029'
    WHEN key IN ('04031', 'C06', 'C0604031', 'SK04031') THEN 'SK04031'
    WHEN key IN ('088', 'NMSK088', 'SK088') THEN 'SK088'
    WHEN key IN ('10075', 'SK10075') THEN 'SK10075'
    WHEN key IN ('11004', 'CY808B', 'HY808', 'MZ11004', 'SK11004') THEN 'SK11004'
    WHEN key IN ('11041', 'LQ11041', 'QY11041', 'SK11041') THEN 'SK11041'
    WHEN key IN ('13014', 'SK13014') THEN 'SK13014'
    WHEN key IN ('13015', 'SK13015') THEN 'SK13015'
    WHEN key IN ('13034', 'SK13034') THEN 'SK13034'
    WHEN key IN ('13065', 'FY065', 'SK13065') THEN 'SK13065'
    WHEN key IN ('15013', 'SK15013') THEN 'SK15013'
    WHEN key IN ('SK15030') THEN 'SK15030'
    WHEN key IN ('DX60', 'SK15061') THEN 'SK15061'
    WHEN key IN ('QY1711', 'SK1711') THEN 'SK1711'
    WHEN key IN ('1713', '17134', 'MZ1713', 'QY1713', 'SK1713', 'SK17134', 'SK17134GREY') THEN 'SK17134'
    WHEN key IN ('1714', 'SK1714', 'SK17145') THEN 'SK17145'
    WHEN key IN ('185', 'LQ185', 'MA185', 'QY185', 'SK185') THEN 'SK185'
    WHEN key IN ('1914', 'QHSK1914', 'RW2017F', 'SK1914') THEN 'SK1914'
    WHEN key IN ('1924', 'MZSK1924', 'QHSK1924', 'SK1924') THEN 'SK1924'
    WHEN key IN ('1928', 'SK1928') THEN 'SK1928'
    WHEN key IN ('223', 'SK223') THEN 'SK223'
    WHEN key IN ('270', 'SK270', 'YJSK270') THEN 'SK270'
    WHEN key IN ('271', 'SK271') THEN 'SK271'
    WHEN key IN ('272', 'SK272') THEN 'SK272'
    WHEN key IN ('3378', 'QY3378', 'SK3378') THEN 'SK3378'
    WHEN key IN ('446', 'SK446') THEN 'SK446'
    WHEN key IN ('5110', 'NMSK5110', 'SK5110') THEN 'SK5110'
    WHEN key IN ('5118', 'NMSK5118', 'SK5118') THEN 'SK5118'
    WHEN key IN ('6810', 'CM6810', 'SK6810') THEN 'SK6810'
    WHEN key IN ('DX6863', 'KFJ683901', 'LQ63', 'SK6863') THEN 'SK6863'
    WHEN key IN ('7015', 'SK7015', 'YSJ053') THEN 'SK7015'
    WHEN key IN ('7025', 'MZ7025A', 'SK7025', 'SK7025A', 'SK7025BLACK') THEN 'SK7025A'
    WHEN key IN ('7027', 'MZ7027', 'SK7027') THEN 'SK7027'
    WHEN key IN ('7028', 'MZ7028', 'SK7028') THEN 'SK7028'
    WHEN key IN ('777', 'SK777') THEN 'SK777'
    WHEN key IN ('999', 'SK999') THEN 'SK999'
    WHEN key IN ('3065', 'MZ3065', 'QY3065', 'SK3065', 'SKGT3065') THEN 'SKGT3065'
    WHEN key IN ('175', 'LQ175', 'MZ175', 'SD175', 'SK175', 'SKJB175') THEN 'SKJB175'
    WHEN key IN ('675', 'SK675', 'SKJFB675B', 'YJSKJFB675B') THEN 'SKJFB675B'
    WHEN key IN ('794', 'NMSKJFB794', 'SK794', 'SKJFB794') THEN 'SKJFB794'
    WHEN key IN ('7032', 'NMSKYM7032', 'SK7032', 'SKYM7032') THEN 'SKYM7032'
    WHEN key IN ('6699', 'MZ6699', 'SK6699', 'SL6699') THEN 'SL6699'
    WHEN key IN ('505', '505A', 'QY505', 'SM505A', 'TXSM505A') THEN 'SM505A'
    WHEN key IN ('520', '520A', 'NMSM520A', 'SM520', 'SM520A') THEN 'SM520A'
    WHEN key IN ('SM825', 'YASM825', 'YASM825A', 'YJSM825') THEN 'SM825'
    WHEN key IN ('961', 'SM961') THEN 'SM961'
    WHEN key IN ('T1') THEN 'T1'
    WHEN key IN ('V22') THEN 'V22'
    WHEN key IN ('1710', 'LQ1710', 'MZ1710', 'WK1710', 'WK17104') THEN 'WK17104'
    ELSE key
  END
  FROM k;
$$;

CREATE OR REPLACE FUNCTION dim.product_canonical_sn(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE dim.product_match_key(value)
    WHEN '' THEN ''
    WHEN '2001' THEN '2001胶囊咖啡机'
    WHEN 'BHRL09' THEN 'BHRL-09激光脱毛仪'
    WHEN 'CM121E' THEN 'CM-121E美式咖啡机'
    WHEN 'CX1788' THEN 'CX1788手持搅拌器'
    WHEN 'FZ666' THEN 'FZ-666颈部按摩器'
    WHEN 'GREPC12A' THEN 'GR-EPC12A电压力锅'
    WHEN 'HS025' THEN 'HS-025直发夹板'
    WHEN 'JD389' THEN 'JD-389空气炸锅'
    WHEN 'KFJN02' THEN 'KF-JN-02便携咖啡机'
    WHEN 'KJ102' THEN 'KJ-102三明治机和早餐机'
    WHEN 'KJ102S' THEN 'KJ-102S三明治机和早餐机'
    WHEN 'PA46L' THEN 'PA4-6L便携式冰箱'
    WHEN 'S1810' THEN 'S1810电热水壶'
    WHEN 'SK03012' THEN 'SK-03012台式榨汁机'
    WHEN 'SK03038' THEN 'SK-03038制冰机'
    WHEN 'SK04029' THEN 'SK-04029半自动意式咖啡机'
    WHEN 'SK04031' THEN 'SK-04031胶囊咖啡机'
    WHEN 'SK088' THEN 'SK-088绞肉机'
    WHEN 'SK10075' THEN 'SK-10075电油炸锅'
    WHEN 'SK11004' THEN 'SK-11004蒸汽熨烫机'
    WHEN 'SK11041' THEN 'SK-11041蒸汽熨烫机'
    WHEN 'SK13014' THEN 'SK-13014杆式吸尘器'
    WHEN 'SK13015' THEN 'SK-13015杆式吸尘器'
    WHEN 'SK13034' THEN 'SK-13034杆式吸尘器'
    WHEN 'SK13065' THEN 'SK-13065吸尘器'
    WHEN 'SK15013' THEN 'SK-15013卷发钳和卷发棒'
    WHEN 'SK15030' THEN 'SK-15030热风梳'
    WHEN 'SK15061' THEN 'SK-15061热风梳'
    WHEN 'SK1711' THEN 'SK-1711手持搅拌器'
    WHEN 'SK17134' THEN 'SK-1713-4手持搅拌器'
    WHEN 'SK17145' THEN 'SK-1714-5手持搅拌器'
    WHEN 'SK185' THEN 'SK-185台式榨汁机'
    WHEN 'SK1914' THEN 'SK-1914热风梳'
    WHEN 'SK1924' THEN 'SK-1924直发夹板'
    WHEN 'SK1928' THEN 'SK-1928直发夹板'
    WHEN 'SK223' THEN 'SK-223三明治机和早餐机'
    WHEN 'SK270' THEN 'SK-270厨师机'
    WHEN 'SK271' THEN 'SK-271厨师机'
    WHEN 'SK272' THEN 'SK-272厨师机'
    WHEN 'SK3378' THEN 'SK-3378杆式吸尘器'
    WHEN 'SK446' THEN 'SK-446电动刀与切片器'
    WHEN 'SK5110' THEN 'SK-5110电磁炉'
    WHEN 'SK5118' THEN 'SK-5118电磁炉'
    WHEN 'SK6810' THEN 'SK-6810半自动意式咖啡机'
    WHEN 'SK6863' THEN 'SK-6863半自动意式咖啡机'
    WHEN 'SK7015' THEN 'SK-7015绞肉机'
    WHEN 'SK7025A' THEN 'SK-7025A绞肉机'
    WHEN 'SK7027' THEN 'SK-7027绞肉机'
    WHEN 'SK7028' THEN 'SK-7028绞肉机'
    WHEN 'SK777' THEN 'SK-777碎冰机和刨冰机'
    WHEN 'SK999' THEN 'SK-999食品料理机'
    WHEN 'SKGT3065' THEN 'SK-GT-3065蒸汽熨烫机'
    WHEN 'SKJB175' THEN 'SK-JB-175离心式榨汁机'
    WHEN 'SKJFB675B' THEN 'SK-JFB-675B卷发钳和卷发棒'
    WHEN 'SKJFB794' THEN 'SK-JFB-794卷发钳和卷发棒'
    WHEN 'SKYM7032' THEN 'SK-YM-7032绞肉机'
    WHEN 'SL6699' THEN 'SL-6699蒸汽熨烫机'
    WHEN 'SM505A' THEN 'SM-505A电动缝纫机'
    WHEN 'SM520A' THEN 'SM-520A电动缝纫机'
    WHEN 'SM825' THEN 'SM-825电动缝纫机'
    WHEN 'SM961' THEN 'SM-961厨师机'
    WHEN 'T1' THEN 'T1激光脱毛仪'
    WHEN 'V22' THEN 'V22行车记录仪'
    WHEN 'WK17104' THEN 'WK-1710-4手持搅拌器'
    ELSE coalesce(value,'')
  END;
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

CREATE TABLE IF NOT EXISTS raw.et_fetch_batch (
  batch_id text PRIMARY KEY,
  mode text,
  target_date date,
  fetched_at timestamptz,
  base_url text,
  profile_dir text,
  manifest_path text,
  ok boolean,
  sync_windows jsonb DEFAULT '{}'::jsonb,
  raw_manifest jsonb DEFAULT '{}'::jsonb,
  loaded_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw.et_endpoint_row (
  row_key text PRIMARY KEY,
  batch_id text REFERENCES raw.et_fetch_batch(batch_id),
  endpoint_key text NOT NULL,
  parent_endpoint_key text,
  natural_id text,
  target_date date,
  fetched_at timestamptz,
  source_file text,
  row_data jsonb NOT NULL,
  loaded_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_et_endpoint_row_endpoint_date ON raw.et_endpoint_row(endpoint_key, target_date);
CREATE INDEX IF NOT EXISTS idx_et_endpoint_row_natural_id ON raw.et_endpoint_row(endpoint_key, natural_id);

CREATE TABLE IF NOT EXISTS fact.et_sku_master (
  goods_id text PRIMARY KEY,
  barcode text,
  sku_code text,
  model_number text,
  standard_goods_sn text,
  match_key text,
  title_cn text,
  title_en text,
  brand_name text,
  report_price numeric,
  status text,
  status_name text,
  created_time timestamp,
  source_batch_id text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_et_sku_master_standard ON fact.et_sku_master(standard_goods_sn);

CREATE TABLE IF NOT EXISTS fact.et_sku_specification (
  sku_id text PRIMARY KEY,
  barcode text,
  sku_code text,
  standard_goods_sn text,
  match_key text,
  sku_length numeric,
  sku_width numeric,
  sku_height numeric,
  sku_volume numeric,
  sku_weight numeric,
  goods_length numeric,
  goods_width numeric,
  goods_height numeric,
  goods_weight numeric,
  goods_volume numeric,
  status text,
  created_time timestamp,
  source_batch_id text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_store_stock_snapshot (
  unique_key text PRIMARY KEY,
  snapshot_date date NOT NULL,
  batch_id text,
  f_id text,
  sku_id text,
  storeroom_id text,
  storeroom_name text,
  barcode text,
  sku_code text,
  standard_goods_sn text,
  match_key text,
  title_cn text,
  title_en text,
  quantity numeric,
  real_quantity numeric,
  s_b2b_quantity numeric,
  s_b2b_real_quantity numeric,
  fbn_quantity numeric,
  fbn_real_quantity numeric,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_et_store_stock_date_product ON fact.et_store_stock_snapshot(snapshot_date, standard_goods_sn);
CREATE INDEX IF NOT EXISTS idx_et_store_stock_warehouse ON fact.et_store_stock_snapshot(snapshot_date, storeroom_name);

CREATE TABLE IF NOT EXISTS fact.et_box_stock_snapshot (
  unique_key text PRIMARY KEY,
  snapshot_date date NOT NULL,
  batch_id text,
  f_id text,
  box_id text,
  sku_id text,
  goods_id text,
  storeroom_id text,
  storeroom_name text,
  store_site_id text,
  barcode text,
  sku_code text,
  standard_goods_sn text,
  match_key text,
  title_cn text,
  title_en text,
  quantity numeric,
  real_quantity numeric,
  sku_lock_status_name text,
  site_lock_status_name text,
  update_time timestamp,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_et_box_stock_date_product ON fact.et_box_stock_snapshot(snapshot_date, standard_goods_sn);

CREATE TABLE IF NOT EXISTS fact.et_stock_running (
  f_id text PRIMARY KEY,
  batch_id text,
  storeroom_name text,
  barcode text,
  sku_code text,
  standard_goods_sn text,
  match_key text,
  title_cn text,
  title_en text,
  quantity numeric,
  balance numeric,
  supply_price numeric,
  sort text,
  sort_name text,
  from_id text,
  created_time timestamp,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_et_stock_running_time ON fact.et_stock_running(created_time);
CREATE INDEX IF NOT EXISTS idx_et_stock_running_product ON fact.et_stock_running(standard_goods_sn, created_time);

CREATE TABLE IF NOT EXISTS fact.et_ship_order (
  ship_order_id text PRIMARY KEY,
  batch_id text,
  storeroom_id text,
  storeroom_title text,
  transport_title text,
  status text,
  status_name text,
  send_quantity numeric,
  inland_quantity numeric,
  overseas_quantity numeric,
  platform_quantity numeric,
  case_number numeric,
  all_box_number numeric,
  send_box_count numeric,
  store_box_count numeric,
  weight numeric,
  volume numeric,
  country_id text,
  city_id text,
  storage_area text,
  create_time timestamp,
  check_time timestamp,
  ship_time timestamp,
  into_time timestamp,
  end_time timestamp,
  remark text,
  waybill_code text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_ship_order_item (
  unique_key text PRIMARY KEY,
  batch_id text,
  ship_order_id text REFERENCES fact.et_ship_order(ship_order_id),
  f_id text,
  goods_id text,
  sku_id text,
  barcode text,
  sku_code text,
  model_number text,
  standard_goods_sn text,
  match_key text,
  title_cn text,
  title_en text,
  goods_title text,
  quantity numeric,
  cost_price numeric,
  price numeric,
  receive1 numeric,
  receive2 numeric,
  receive3 numeric,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_et_ship_order_item_product ON fact.et_ship_order_item(standard_goods_sn);

CREATE TABLE IF NOT EXISTS fact.et_ship_order_box (
  unique_key text PRIMARY KEY,
  batch_id text,
  ship_order_id text REFERENCES fact.et_ship_order(ship_order_id),
  box_id text,
  client_box_id text,
  barcode text,
  sku_code text,
  standard_goods_sn text,
  match_key text,
  goods_title text,
  case_quantity numeric,
  real_quantity numeric,
  storeroom_name text,
  target_store text,
  length numeric,
  width numeric,
  height numeric,
  weight numeric,
  etd timestamp,
  eta timestamp,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_box (
  box_id text PRIMARY KEY,
  batch_id text,
  client_box_id text,
  ship_order_id text,
  storeroom_name text,
  city_name text,
  transport_name text,
  status_name text,
  logistics_status text,
  get_time timestamp,
  go_time timestamp,
  volume numeric,
  weight numeric,
  storage_area text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_box_item (
  unique_key text PRIMARY KEY,
  batch_id text,
  box_id text,
  f_id text,
  goods_id text,
  sku_id text,
  barcode text,
  sku_code text,
  model_number text,
  standard_goods_sn text,
  match_key text,
  goods_title text,
  case_quantity numeric,
  real_quantity numeric,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_outbound (
  outbound_id text PRIMARY KEY,
  batch_id text,
  storeroom_id text,
  storeroom_title text,
  from_id text,
  status text,
  status_name text,
  sku_count numeric,
  box_count numeric,
  create_time timestamp,
  reserve_time timestamp,
  outbound_time timestamp,
  logistics_title text,
  remark text,
  waybill_code text,
  file_url text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_et_outbound_remark ON fact.et_outbound(remark);
CREATE INDEX IF NOT EXISTS idx_et_outbound_time ON fact.et_outbound(outbound_time);

CREATE TABLE IF NOT EXISTS fact.et_outbound_form (
  outbound_id text PRIMARY KEY REFERENCES fact.et_outbound(outbound_id),
  batch_id text,
  receive_text text,
  shipper_code text,
  shipper_name text,
  shipper_match text,
  detail_url text,
  detail_status text,
  detail_content_type text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_et_outbound_form_shipper ON fact.et_outbound_form(shipper_code);

CREATE TABLE IF NOT EXISTS fact.et_outbound_item (
  unique_key text PRIMARY KEY,
  batch_id text,
  outbound_id text REFERENCES fact.et_outbound(outbound_id),
  f_id text,
  sku_id text,
  barcode text,
  sku_code text,
  standard_goods_sn text,
  match_key text,
  title_cn text,
  title_en text,
  quantity numeric,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_return_order (
  return_order_id text PRIMARY KEY,
  batch_id text,
  store_name_out text,
  store_name_in text,
  rtv text,
  shipment_number text,
  status text,
  status_name text,
  to_pickup_name text,
  to_instock_name text,
  is_worn_in_name text,
  out_quantity numeric,
  in_quantity numeric,
  all_weight numeric,
  reserve_time timestamp,
  create_time timestamp,
  operator text,
  reason text,
  reason_remark text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_et_return_shipment ON fact.et_return_order(shipment_number);
CREATE INDEX IF NOT EXISTS idx_et_return_time ON fact.et_return_order(create_time);

CREATE TABLE IF NOT EXISTS fact.et_return_order_item (
  unique_key text PRIMARY KEY,
  batch_id text,
  return_order_id text REFERENCES fact.et_return_order(return_order_id),
  f_id text,
  goods_id text,
  sku_id text,
  barcode text,
  sku_code text,
  standard_goods_sn text,
  match_key text,
  goods_title text,
  quantity numeric,
  instock numeric,
  differ numeric,
  create_time timestamp,
  remark text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_allocate (
  allocate_id text PRIMARY KEY,
  batch_id text,
  from_id text,
  out_storeroom text,
  out_storeroom_id text,
  in_storeroom text,
  in_storeroom_id text,
  status text,
  status_name text,
  case_number numeric,
  real_number numeric,
  logistics_name text,
  logistics_no text,
  create_time timestamp,
  reserve_time timestamp,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_allocate_item (
  unique_key text PRIMARY KEY,
  batch_id text,
  allocate_id text REFERENCES fact.et_allocate(allocate_id),
  f_id text,
  goods_id text,
  sku_id text,
  barcode text,
  sku_code text,
  standard_goods_sn text,
  match_key text,
  goods_title text,
  quantity numeric,
  pick_amount numeric,
  refuse_amount numeric,
  receive_quantity numeric,
  stock numeric,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_store_receipt (
  receipt_id text PRIMARY KEY,
  batch_id text,
  storeroom_name text,
  sort_name text,
  from_id text,
  total_plan_quantity numeric,
  total_quantity numeric,
  remark text,
  create_time timestamp,
  end_time timestamp,
  status_name text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_change_pack (
  change_id text PRIMARY KEY,
  batch_id text,
  damage_store text,
  pack_store text,
  single_store text,
  change_sort_name text,
  pack_sort_name text,
  barcode text,
  standard_goods_sn text,
  match_key text,
  quantity numeric,
  quantity2 numeric,
  money numeric,
  status text,
  status_name text,
  create_time timestamp,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_box_damaged (
  dlno text PRIMARY KEY,
  batch_id text,
  box_id text,
  oversea_id text,
  ship_order_id text,
  title text,
  allocate_id text,
  allocate_name text,
  allocate_status text,
  box_damaged_status text,
  box_damaged_name text,
  sort_name text,
  barcode text,
  standard_goods_sn text,
  match_key text,
  sku_qty numeric,
  check_qty numeric,
  differ numeric,
  create_time timestamp,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_income_bill (
  income_bill_id text PRIMARY KEY,
  batch_id text,
  client_from_id text,
  oversea_id text,
  source_type text,
  sort text,
  sort_name text,
  status text,
  status_name text,
  freight numeric,
  tariff numeric,
  other_income numeric,
  cq_money numeric,
  in_money numeric,
  out_money numeric,
  pay_id text,
  pay_sort text,
  ship_time timestamp,
  create_time timestamp,
  push_time timestamp,
  first_date timestamp,
  billing_period_date timestamp,
  remark text,
  waybill_code text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_et_income_bill_time ON fact.et_income_bill(ship_time);
CREATE INDEX IF NOT EXISTS idx_et_income_bill_source ON fact.et_income_bill(source_type, client_from_id, oversea_id);

CREATE TABLE IF NOT EXISTS fact.et_income_bill_item (
  unique_key text PRIMARY KEY,
  batch_id text,
  income_bill_id text REFERENCES fact.et_income_bill(income_bill_id),
  goods_title text,
  sku_code text,
  standard_goods_sn text,
  match_key text,
  quantity numeric,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_income_bill_summary (
  unique_key text PRIMARY KEY,
  batch_id text,
  target_date date,
  sort text,
  sort_name text,
  country_id text,
  country_name text,
  total_freight numeric,
  total_tariff numeric,
  total_other_income numeric,
  total_cq_money numeric,
  total_fee numeric,
  total_in_money numeric,
  total_out_money numeric,
  total_unmatured numeric,
  total_expire numeric,
  total_overdue numeric,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_income_payment (
  f_id text PRIMARY KEY,
  batch_id text,
  income_bill_id text,
  pay_id text,
  pay_sort text,
  pay_money numeric,
  currency text,
  status text,
  status_name text,
  create_time timestamp,
  pay_time timestamp,
  invoice_no text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact.et_storage_fee_product_detail (
  unique_key text PRIMARY KEY,
  batch_id text,
  income_bill_id text NOT NULL REFERENCES fact.et_income_bill(income_bill_id),
  fee_date date NOT NULL,
  warehouse_name text,
  storage_type text,
  storage_code text NOT NULL,
  sku_code text,
  standard_goods_sn text,
  match_key text,
  quantity numeric,
  volume_m3_per_unit numeric,
  volume_m3_total numeric,
  rate_rmb_per_m3_day numeric,
  storage_fee_rmb_before_discount numeric,
  member_discount numeric,
  shown_fee_rmb numeric,
  actual_fee_rmb numeric,
  actual_fee_sar numeric,
  allocation_method text NOT NULL DEFAULT 'download_detail',
  source_file text,
  source_row_no integer,
  download_url text,
  content_type text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_et_storage_fee_product_detail_date ON fact.et_storage_fee_product_detail(fee_date);
CREATE INDEX IF NOT EXISTS idx_et_storage_fee_product_detail_bill ON fact.et_storage_fee_product_detail(income_bill_id);
CREATE INDEX IF NOT EXISTS idx_et_storage_fee_product_detail_match ON fact.et_storage_fee_product_detail(match_key);
CREATE INDEX IF NOT EXISTS idx_et_storage_fee_product_detail_code ON fact.et_storage_fee_product_detail(storage_code);

CREATE TABLE IF NOT EXISTS fact.et_freight_rate (
  unique_key text PRIMARY KEY,
  batch_id text,
  transport_id text,
  transport_title text,
  country_id text,
  country_title text,
  sort_id text,
  sort_title text,
  sort_status text,
  tier_a text,
  tier_b text,
  tier_c text,
  tier_d text,
  tier_e text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE OR REPLACE VIEW mart.et_product_inventory_current AS
WITH
latest_store AS (
  SELECT b.batch_id, b.target_date AS snapshot_date
  FROM raw.et_fetch_batch b
  WHERE b.ok IS TRUE
    AND b.mode <> 'smoke'
    AND EXISTS (SELECT 1 FROM fact.et_store_stock_snapshot s WHERE s.batch_id = b.batch_id)
  ORDER BY b.fetched_at DESC NULLS LAST, b.batch_id DESC
  LIMIT 1
),
latest_box AS (
  SELECT b.batch_id, b.target_date AS snapshot_date
  FROM raw.et_fetch_batch b
  WHERE b.ok IS TRUE
    AND b.mode <> 'smoke'
    AND EXISTS (SELECT 1 FROM fact.et_box_stock_snapshot x WHERE x.batch_id = b.batch_id)
  ORDER BY b.fetched_at DESC NULLS LAST, b.batch_id DESC
  LIMIT 1
),
store_agg_raw AS (
  SELECT
    standard_goods_sn,
    match_key,
    max(title_cn) FILTER (WHERE coalesce(title_cn,'') <> '') AS sample_title_cn,
    sum(coalesce(real_quantity, quantity, 0)) AS loose_total_qty,
    sum(coalesce(real_quantity, quantity, 0)) FILTER (WHERE storeroom_name LIKE '%09%' OR storeroom_name ILIKE '%散件%') AS loose_sellable_qty,
    sum(coalesce(real_quantity, quantity, 0)) FILTER (WHERE storeroom_name LIKE '%03%' OR storeroom_name ILIKE '%RTV%') AS rtv_qty,
    sum(coalesce(real_quantity, quantity, 0)) FILTER (WHERE storeroom_name LIKE '%04%' OR storeroom_name ILIKE '%Damaged%' OR storeroom_name ILIKE '%破损%') AS damaged_qty,
    sum(coalesce(real_quantity, quantity, 0)) FILTER (WHERE storeroom_name LIKE '%06%' OR storeroom_name ILIKE '%报废%') AS scrap_qty,
    string_agg(DISTINCT nullif(storeroom_name,''), ' / ') AS loose_warehouses,
    max(snapshot_date) AS store_snapshot_date
  FROM fact.et_store_stock_snapshot
  WHERE batch_id = (SELECT batch_id FROM latest_store)
    AND coalesce(standard_goods_sn,'') <> ''
  GROUP BY standard_goods_sn, match_key
),
store_agg AS (
  SELECT
    max(standard_goods_sn) AS standard_goods_sn,
    match_key,
    max(sample_title_cn) FILTER (WHERE coalesce(sample_title_cn,'') <> '') AS sample_title_cn,
    sum(coalesce(loose_total_qty,0)) AS loose_total_qty,
    sum(coalesce(loose_sellable_qty,0)) AS loose_sellable_qty,
    sum(coalesce(rtv_qty,0)) AS rtv_qty,
    sum(coalesce(damaged_qty,0)) AS damaged_qty,
    sum(coalesce(scrap_qty,0)) AS scrap_qty,
    string_agg(DISTINCT nullif(loose_warehouses,''), ' / ') AS loose_warehouses,
    max(store_snapshot_date) AS store_snapshot_date
  FROM store_agg_raw
  GROUP BY match_key
),
box_agg_raw AS (
  SELECT
    standard_goods_sn,
    match_key,
    max(title_cn) FILTER (WHERE coalesce(title_cn,'') <> '') AS sample_title_cn,
    sum(coalesce(real_quantity, quantity, 0)) AS box_total_qty,
    sum(coalesce(real_quantity, quantity, 0)) FILTER (WHERE storeroom_name LIKE '%01%' OR storeroom_name ILIKE '%整箱%') AS full_carton_qty,
    count(DISTINCT box_id) AS box_count,
    string_agg(DISTINCT nullif(storeroom_name,''), ' / ') AS box_warehouses,
    max(snapshot_date) AS box_snapshot_date
  FROM fact.et_box_stock_snapshot
  WHERE batch_id = (SELECT batch_id FROM latest_box)
    AND coalesce(standard_goods_sn,'') <> ''
  GROUP BY standard_goods_sn, match_key
),
box_agg AS (
  SELECT
    max(standard_goods_sn) AS standard_goods_sn,
    match_key,
    max(sample_title_cn) FILTER (WHERE coalesce(sample_title_cn,'') <> '') AS sample_title_cn,
    sum(coalesce(box_total_qty,0)) AS box_total_qty,
    sum(coalesce(full_carton_qty,0)) AS full_carton_qty,
    sum(coalesce(box_count,0))::bigint AS box_count,
    string_agg(DISTINCT nullif(box_warehouses,''), ' / ') AS box_warehouses,
    max(box_snapshot_date) AS box_snapshot_date
  FROM box_agg_raw
  GROUP BY match_key
)
SELECT
  coalesce(s.standard_goods_sn, b.standard_goods_sn) AS standard_goods_sn,
  coalesce(s.match_key, b.match_key) AS match_key,
  coalesce(s.sample_title_cn, b.sample_title_cn) AS sample_title_cn,
  coalesce(s.loose_sellable_qty,0) AS loose_sellable_qty,
  coalesce(b.full_carton_qty,0) AS full_carton_qty,
  coalesce(s.rtv_qty,0) AS rtv_qty,
  coalesce(s.damaged_qty,0) AS damaged_qty,
  coalesce(s.scrap_qty,0) AS scrap_qty,
  coalesce(s.loose_total_qty,0) AS loose_total_qty,
  coalesce(b.box_total_qty,0) AS box_total_qty,
  coalesce(s.loose_sellable_qty,0) + coalesce(b.full_carton_qty,0) AS estimated_available_qty,
  coalesce(s.rtv_qty,0) + coalesce(s.damaged_qty,0) AS pending_process_qty,
  coalesce(b.box_count,0) AS box_count,
  s.loose_warehouses,
  b.box_warehouses,
  s.store_snapshot_date,
  b.box_snapshot_date
FROM store_agg s
FULL JOIN box_agg b
  ON b.match_key = s.match_key;

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
CREATE INDEX IF NOT EXISTS idx_order_item_order_no ON fact.order_item(order_no);

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
CREATE INDEX IF NOT EXISTS idx_after_sales_order_no ON fact.after_sales_item(order_no);
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
  expect_shelf_time timestamp,
  source_file text,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_link_master_date_store ON fact.link_master_snapshot(snapshot_date, store_key);
CREATE INDEX IF NOT EXISTS idx_link_master_product ON fact.link_master_snapshot(standard_goods_sn, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_link_master_skc ON fact.link_master_snapshot(skc, snapshot_date);
ALTER TABLE fact.link_master_snapshot ADD COLUMN IF NOT EXISTS expect_shelf_time timestamp;

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
CREATE INDEX IF NOT EXISTS idx_link_perf_product_traffic_daily
  ON fact.link_performance_daily(date, store_key, standard_goods_sn)
  INCLUDE (group_key, sale_cnt, pay_order_cnt, eps_uv, goods_uv, cart_uv, pay_uv, skc)
  WHERE coalesce(standard_goods_sn,'') <> '';

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

CREATE TABLE IF NOT EXISTS ops.order_status_recheck_state (
  order_item_key text PRIMARY KEY,
  order_key text,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  order_id text,
  order_no text,
  bill_no text,
  created_date date NOT NULL,
  order_create_time timestamp,
  standard_goods_sn text,
  raw_goods_sn text,
  goods_id text,
  entity_id text,
  skc text,
  sku_code text,
  goods_title text,
  latest_goods_status text,
  latest_goods_performance_status text,
  latest_goods_performance_status_desc text,
  latest_page_status text,
  latest_page_status_desc text,
  latest_order_status text,
  latest_order_status_desc text,
  latest_perform_status text,
  latest_perform_status_desc text,
  lifecycle_status_group text NOT NULL,
  is_terminal boolean DEFAULT false,
  first_seen_at timestamptz DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  check_count integer NOT NULL DEFAULT 1,
  consecutive_same_count integer NOT NULL DEFAULT 1,
  terminal_at timestamptz,
  source_file text,
  transport text,
  fetch_time timestamptz,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_status_recheck_date_store
  ON ops.order_status_recheck_state(created_date, store_key);
CREATE INDEX IF NOT EXISTS idx_order_status_recheck_order
  ON ops.order_status_recheck_state(store_key, order_no);
CREATE INDEX IF NOT EXISTS idx_order_status_recheck_group
  ON ops.order_status_recheck_state(lifecycle_status_group, is_terminal, last_checked_at);

CREATE TABLE IF NOT EXISTS ops.rtv_tracking_verification (
  verification_id text PRIMARY KEY,
  store_key text,
  et_return_order_id text,
  et_shipment_number text,
  et_shipment_number_raw text,
  standard_goods_sn text,
  shein_aftersales_order_no text,
  shein_order_no text,
  shein_order_id text,
  shein_return_order_no text,
  shein_return_order_id text,
  shein_current_express_no text,
  match_status text NOT NULL DEFAULT 'unchecked',
  match_source text,
  matched_tracking_no text,
  discovered_tracking_numbers jsonb DEFAULT '[]'::jsonb,
  current_express_numbers jsonb DEFAULT '[]'::jsonb,
  route_summary jsonb DEFAULT '[]'::jsonb,
  raw_detail jsonb,
  raw_return_detail jsonb,
  raw_route jsonb,
  error_message text,
  verified_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rtv_tracking_verification_et
  ON ops.rtv_tracking_verification (et_return_order_id, et_shipment_number);

CREATE INDEX IF NOT EXISTS idx_rtv_tracking_verification_shein
  ON ops.rtv_tracking_verification (store_key, shein_aftersales_order_no);

CREATE TABLE IF NOT EXISTS fact.product_cost_batch (
  batch_key text PRIMARY KEY,
  standard_goods_sn text NOT NULL,
  raw_goods_sn text,
  batch_no text,
  shipped_date date,
  arrived_date date,
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

ALTER TABLE fact.product_cost_batch ADD COLUMN IF NOT EXISTS shipped_date date;
ALTER TABLE fact.product_cost_batch ADD COLUMN IF NOT EXISTS arrived_date date;

CREATE INDEX IF NOT EXISTS idx_product_cost_batch_product ON fact.product_cost_batch(standard_goods_sn);
CREATE INDEX IF NOT EXISTS idx_product_cost_batch_complete ON fact.product_cost_batch(standard_goods_sn, complete_batch);
CREATE INDEX IF NOT EXISTS idx_product_cost_batch_arrival ON fact.product_cost_batch(standard_goods_sn, arrived_date);

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

CREATE TABLE IF NOT EXISTS dim.storage_fee_policy (
  policy_key text PRIMARY KEY,
  currency_code text NOT NULL DEFAULT 'CNY',
  sar_to_rmb numeric NOT NULL DEFAULT 1.8,
  billing_discount numeric NOT NULL DEFAULT 0.5,
  effective_from date NOT NULL DEFAULT '2025-01-01',
  note text,
  updated_at timestamptz DEFAULT now()
);

INSERT INTO dim.storage_fee_policy(policy_key, currency_code, sar_to_rmb, billing_discount, effective_from, note)
VALUES ('et_default', 'CNY', 1.8, 0.5, '2025-01-01', 'ET仓储费显示金额按RMB；实际减半收取；利润按SAR展示。')
ON CONFLICT (policy_key) DO UPDATE SET
  currency_code = EXCLUDED.currency_code,
  sar_to_rmb = EXCLUDED.sar_to_rmb,
  billing_discount = EXCLUDED.billing_discount,
  effective_from = EXCLUDED.effective_from,
  note = EXCLUDED.note,
  updated_at = now();

CREATE TABLE IF NOT EXISTS dim.storage_warehouse_rate (
  warehouse_match text PRIMARY KEY,
  warehouse_label text NOT NULL,
  rate_rmb_per_m3_day numeric NOT NULL,
  warehouse_discount numeric NOT NULL DEFAULT 1,
  billable boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  note text,
  updated_at timestamptz DEFAULT now()
);

INSERT INTO dim.storage_warehouse_rate(warehouse_match, warehouse_label, rate_rmb_per_m3_day, warehouse_discount, billable, priority, note)
VALUES
  ('%09%', 'ETRUH09散件仓', 8, 0.75, true, 10, '用户确认：09仓8元一方，实际0.75折；最终按ET每日总账校准。'),
  ('%03%', 'ETRUH03_RTV', 8, 0.75, true, 20, 'RTV仓缺明细时按同费率估算，后续以ET导出明细修正。'),
  ('%04%', 'ETRUH04Damaged', 8, 0.75, true, 30, '破损仓缺明细时按同费率估算，页面标注兜底口径。'),
  ('%06%', 'ETRUH06报废', 8, 0.75, true, 40, '报废仓缺明细时按同费率估算，页面标注兜底口径。')
ON CONFLICT (warehouse_match) DO UPDATE SET
  warehouse_label = EXCLUDED.warehouse_label,
  rate_rmb_per_m3_day = EXCLUDED.rate_rmb_per_m3_day,
  warehouse_discount = EXCLUDED.warehouse_discount,
  billable = EXCLUDED.billable,
  priority = EXCLUDED.priority,
  note = EXCLUDED.note,
  updated_at = now();

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
        OR coalesce(order_sub_status_name,'') ILIKE '%待卖家处理%'
        OR coalesce(order_sub_status_name,'') ILIKE '%待买家选择方案%'
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

CREATE OR REPLACE VIEW mart.et_rtv_09_allocation AS
WITH rtv_in AS (
  SELECT
    from_id AS return_order_id,
    coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn)) AS match_key,
    standard_goods_sn,
    quantity::numeric AS rtv_quantity,
    created_time AS rtv_received_time
  FROM fact.et_stock_running
  WHERE sort_name = '平台RTV'
    AND quantity > 0
    AND coalesce(from_id,'') LIKE 'TH%'
    AND (coalesce(storeroom_name,'') ILIKE '%03%' OR coalesce(storeroom_name,'') ILIKE '%RTV%')
),
transfer_pairs AS (
  SELECT
    o.from_id AS transfer_id,
    coalesce(nullif(o.match_key,''), dim.product_match_key(o.standard_goods_sn)) AS match_key,
    sum(abs(o.quantity))::numeric AS out_qty_03,
    least(
      sum(abs(o.quantity))::numeric,
      coalesce(sum(i.quantity) FILTER (WHERE coalesce(i.storeroom_name,'') ILIKE '%09%' OR coalesce(i.storeroom_name,'') ILIKE '%散件%'),0)::numeric
    ) AS in_qty_09,
    least(
      sum(abs(o.quantity))::numeric,
      coalesce(sum(i.quantity) FILTER (WHERE coalesce(i.storeroom_name,'') ILIKE '%04%' OR coalesce(i.storeroom_name,'') ILIKE '%Damaged%'),0)::numeric
    ) AS in_qty_damaged,
    least(
      sum(abs(o.quantity))::numeric,
      coalesce(sum(i.quantity) FILTER (WHERE coalesce(i.storeroom_name,'') ILIKE '%06%' OR coalesce(i.storeroom_name,'') ILIKE '%报废%'),0)::numeric
    ) AS in_qty_scrap,
    min(o.created_time) AS out_time_03,
    max(i.created_time) AS in_time,
    string_agg(DISTINCT i.storeroom_name, ' / ') FILTER (WHERE coalesce(i.storeroom_name,'') <> '') AS destination_warehouses
  FROM fact.et_stock_running o
  LEFT JOIN fact.et_stock_running i
    ON lower(i.from_id) = lower(o.from_id)
   AND coalesce(nullif(i.match_key,''), dim.product_match_key(i.standard_goods_sn)) = coalesce(nullif(o.match_key,''), dim.product_match_key(o.standard_goods_sn))
   AND i.quantity > 0
  WHERE o.sort_name = '调拨单'
    AND o.quantity < 0
    AND (coalesce(o.storeroom_name,'') ILIKE '%03%' OR coalesce(o.storeroom_name,'') ILIKE '%RTV%')
  GROUP BY o.from_id, coalesce(nullif(o.match_key,''), dim.product_match_key(o.standard_goods_sn))
),
rtv_seq AS (
  SELECT
    *,
    coalesce(sum(rtv_quantity) OVER (
      PARTITION BY match_key
      ORDER BY rtv_received_time, return_order_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ),0) AS rtv_start,
    sum(rtv_quantity) OVER (
      PARTITION BY match_key
      ORDER BY rtv_received_time, return_order_id
      ROWS UNBOUNDED PRECEDING
    ) AS rtv_end
  FROM rtv_in
),
transfer_09_seq AS (
  SELECT
    *,
    coalesce(sum(in_qty_09) OVER (
      PARTITION BY match_key
      ORDER BY coalesce(in_time,out_time_03), transfer_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ),0) AS t09_start,
    sum(in_qty_09) OVER (
      PARTITION BY match_key
      ORDER BY coalesce(in_time,out_time_03), transfer_id
      ROWS UNBOUNDED PRECEDING
    ) AS t09_end
  FROM transfer_pairs
  WHERE in_qty_09 > 0
),
alloc_09 AS (
  SELECT
    r.return_order_id,
    r.match_key,
    r.standard_goods_sn,
    r.rtv_quantity,
    r.rtv_received_time,
    sum(
      CASE
        WHEN t.transfer_id IS NULL THEN 0
        ELSE greatest(0, least(r.rtv_end, t.t09_end) - greatest(r.rtv_start, t.t09_start))
      END
    ) AS rtv_to_09_quantity,
    string_agg(DISTINCT t.transfer_id, ' / ') FILTER (
      WHERE t.transfer_id IS NOT NULL
        AND greatest(0, least(r.rtv_end, t.t09_end) - greatest(r.rtv_start, t.t09_start)) > 0
    ) AS transfer_to_09_ids,
    max(t.in_time) FILTER (
      WHERE t.transfer_id IS NOT NULL
        AND greatest(0, least(r.rtv_end, t.t09_end) - greatest(r.rtv_start, t.t09_start)) > 0
    ) AS latest_09_time
  FROM rtv_seq r
  LEFT JOIN transfer_09_seq t
    ON t.match_key = r.match_key
   AND coalesce(t.in_time,t.out_time_03) >= r.rtv_received_time
   AND least(r.rtv_end, t.t09_end) > greatest(r.rtv_start, t.t09_start)
  GROUP BY r.return_order_id, r.match_key, r.standard_goods_sn, r.rtv_quantity, r.rtv_received_time
)
SELECT
  return_order_id,
  match_key,
  standard_goods_sn,
  rtv_quantity,
  least(rtv_quantity, coalesce(rtv_to_09_quantity,0)) AS rtv_to_09_quantity,
  transfer_to_09_ids,
  rtv_received_time,
  latest_09_time,
  CASE
    WHEN coalesce(rtv_to_09_quantity,0) > 0 THEN 'fifo_by_product_stock_ledger'
    ELSE 'not_traced_to_09'
  END AS allocation_method
FROM alloc_09;

CREATE OR REPLACE VIEW mart.et_rtv_destination_allocation AS
WITH rtv_in AS (
  SELECT
    from_id AS return_order_id,
    coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn)) AS match_key,
    max(standard_goods_sn) AS standard_goods_sn,
    storeroom_name AS initial_warehouse,
    sum(quantity)::numeric AS rtv_quantity,
    min(created_time) AS rtv_received_time
  FROM fact.et_stock_running
  WHERE sort_name = '平台RTV'
    AND quantity > 0
    AND coalesce(from_id,'') LIKE 'TH%'
  GROUP BY from_id, coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn)), storeroom_name
),
transfer_out_03 AS (
  SELECT
    lower(o.from_id) AS transfer_id,
    coalesce(nullif(o.match_key,''), dim.product_match_key(o.standard_goods_sn)) AS match_key,
    sum(abs(o.quantity))::numeric AS out_qty,
    min(o.created_time) AS out_time
  FROM fact.et_stock_running o
  WHERE o.sort_name = '调拨单'
    AND o.quantity < 0
    AND (coalesce(o.storeroom_name,'') ILIKE '%03%' OR coalesce(o.storeroom_name,'') ILIKE '%RTV%')
  GROUP BY lower(o.from_id), coalesce(nullif(o.match_key,''), dim.product_match_key(o.standard_goods_sn))
),
transfer_pos_03 AS (
  SELECT
    lower(i.from_id) AS transfer_id,
    coalesce(nullif(i.match_key,''), dim.product_match_key(i.standard_goods_sn)) AS match_key,
    CASE
      WHEN coalesce(i.storeroom_name,'') ILIKE '%09%' OR coalesce(i.storeroom_name,'') ILIKE '%散件%' THEN '09'
      WHEN coalesce(i.storeroom_name,'') ILIKE '%04%' OR coalesce(i.storeroom_name,'') ILIKE '%Damaged%' THEN 'damaged'
      WHEN coalesce(i.storeroom_name,'') ILIKE '%06%' OR coalesce(i.storeroom_name,'') ILIKE '%报废%' THEN 'scrap'
      ELSE 'other'
    END AS dest_type,
    string_agg(DISTINCT i.storeroom_name, ' / ') FILTER (WHERE coalesce(i.storeroom_name,'') <> '') AS dest_warehouses,
    sum(i.quantity)::numeric AS pos_qty,
    max(i.created_time) AS in_time
  FROM fact.et_stock_running i
  WHERE i.sort_name = '调拨单'
    AND i.quantity > 0
  GROUP BY lower(i.from_id), coalesce(nullif(i.match_key,''), dim.product_match_key(i.standard_goods_sn)),
    CASE
      WHEN coalesce(i.storeroom_name,'') ILIKE '%09%' OR coalesce(i.storeroom_name,'') ILIKE '%散件%' THEN '09'
      WHEN coalesce(i.storeroom_name,'') ILIKE '%04%' OR coalesce(i.storeroom_name,'') ILIKE '%Damaged%' THEN 'damaged'
      WHEN coalesce(i.storeroom_name,'') ILIKE '%06%' OR coalesce(i.storeroom_name,'') ILIKE '%报废%' THEN 'scrap'
      ELSE 'other'
    END
),
transfer_pos_total_03 AS (
  SELECT transfer_id, match_key, sum(pos_qty) AS total_pos_qty
  FROM transfer_pos_03
  GROUP BY transfer_id, match_key
),
transfer_events_03 AS (
  SELECT
    o.transfer_id,
    o.match_key,
    p.dest_type,
    p.dest_warehouses,
    CASE
      WHEN coalesce(t.total_pos_qty,0) > o.out_qty THEN o.out_qty * p.pos_qty / nullif(t.total_pos_qty,0)
      ELSE p.pos_qty
    END AS event_qty,
    o.out_time,
    p.in_time
  FROM transfer_out_03 o
  JOIN transfer_pos_03 p
    ON p.transfer_id = o.transfer_id
   AND p.match_key = o.match_key
  LEFT JOIN transfer_pos_total_03 t
    ON t.transfer_id = o.transfer_id
   AND t.match_key = o.match_key

  UNION ALL

  SELECT
    o.transfer_id,
    o.match_key,
    'other' AS dest_type,
    '无正向入库记录' AS dest_warehouses,
    greatest(0, o.out_qty - coalesce(t.total_pos_qty,0)) AS event_qty,
    o.out_time,
    o.out_time AS in_time
  FROM transfer_out_03 o
  LEFT JOIN transfer_pos_total_03 t
    ON t.transfer_id = o.transfer_id
   AND t.match_key = o.match_key
  WHERE greatest(0, o.out_qty - coalesce(t.total_pos_qty,0)) > 0
),
rtv_03_seq AS (
  SELECT
    *,
    coalesce(sum(rtv_quantity) OVER (
      PARTITION BY match_key
      ORDER BY rtv_received_time, return_order_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ),0) AS rtv_start,
    sum(rtv_quantity) OVER (
      PARTITION BY match_key
      ORDER BY rtv_received_time, return_order_id
      ROWS UNBOUNDED PRECEDING
    ) AS rtv_end
  FROM rtv_in
  WHERE coalesce(initial_warehouse,'') ILIKE '%03%' OR coalesce(initial_warehouse,'') ILIKE '%RTV%'
),
transfer_03_seq AS (
  SELECT
    *,
    coalesce(sum(event_qty) OVER (
      PARTITION BY match_key
      ORDER BY coalesce(in_time,out_time), transfer_id, dest_type
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ),0) AS event_start,
    sum(event_qty) OVER (
      PARTITION BY match_key
      ORDER BY coalesce(in_time,out_time), transfer_id, dest_type
      ROWS UNBOUNDED PRECEDING
    ) AS event_end
  FROM transfer_events_03
  WHERE event_qty > 0
),
alloc_03_detail AS (
  SELECT
    r.return_order_id,
    r.match_key,
    t.dest_type,
    greatest(0, least(r.rtv_end, t.event_end) - greatest(r.rtv_start, t.event_start)) AS allocated_qty,
    t.transfer_id,
    t.dest_warehouses,
    t.in_time
  FROM rtv_03_seq r
  JOIN transfer_03_seq t
    ON t.match_key = r.match_key
   AND coalesce(t.in_time,t.out_time) >= r.rtv_received_time
   AND least(r.rtv_end, t.event_end) > greatest(r.rtv_start, t.event_start)
),
alloc_03 AS (
  SELECT
    return_order_id,
    match_key,
    sum(allocated_qty) FILTER (WHERE dest_type = '09') AS from_03_to_09_quantity,
    sum(allocated_qty) FILTER (WHERE dest_type = 'damaged') AS from_03_to_damaged_quantity,
    sum(allocated_qty) FILTER (WHERE dest_type = 'scrap') AS from_03_to_scrap_quantity,
    sum(allocated_qty) FILTER (WHERE dest_type = 'other') AS from_03_to_other_quantity,
    string_agg(DISTINCT transfer_id, ' / ') FILTER (WHERE dest_type = '09') AS transfer_to_09_ids,
    string_agg(DISTINCT transfer_id, ' / ') FILTER (WHERE dest_type = 'damaged') AS transfer_to_damaged_ids,
    string_agg(DISTINCT transfer_id, ' / ') FILTER (WHERE dest_type = 'scrap') AS transfer_to_scrap_ids,
    string_agg(DISTINCT transfer_id, ' / ') FILTER (WHERE dest_type = 'other') AS transfer_to_other_ids,
    string_agg(DISTINCT dest_warehouses, ' / ') FILTER (WHERE coalesce(dest_warehouses,'') <> '') AS routed_warehouses,
    max(in_time) AS latest_route_time,
    sum(allocated_qty) AS allocated_from_03_quantity
  FROM alloc_03_detail
  GROUP BY return_order_id, match_key
),
base_alloc AS (
  SELECT
    r.return_order_id,
    r.match_key,
    r.standard_goods_sn,
    r.initial_warehouse,
    r.rtv_quantity,
    r.rtv_received_time,
    CASE WHEN coalesce(r.initial_warehouse,'') ILIKE '%09%' OR coalesce(r.initial_warehouse,'') ILIKE '%散件%' THEN r.rtv_quantity ELSE 0 END AS direct_09_quantity,
    CASE WHEN coalesce(r.initial_warehouse,'') ILIKE '%04%' OR coalesce(r.initial_warehouse,'') ILIKE '%Damaged%' THEN r.rtv_quantity ELSE 0 END AS direct_damaged_quantity,
    CASE WHEN coalesce(r.initial_warehouse,'') ILIKE '%06%' OR coalesce(r.initial_warehouse,'') ILIKE '%报废%' THEN r.rtv_quantity ELSE 0 END AS direct_scrap_quantity,
    CASE
      WHEN coalesce(r.initial_warehouse,'') ILIKE '%03%' OR coalesce(r.initial_warehouse,'') ILIKE '%RTV%'
      THEN greatest(0, r.rtv_quantity - coalesce(a.allocated_from_03_quantity,0))
      ELSE 0
    END AS still_03_quantity,
    coalesce(a.from_03_to_09_quantity,0) AS from_03_to_09_quantity,
    coalesce(a.from_03_to_damaged_quantity,0) AS from_03_to_damaged_quantity,
    coalesce(a.from_03_to_scrap_quantity,0) AS from_03_to_scrap_quantity,
    coalesce(a.from_03_to_other_quantity,0) AS from_03_to_other_quantity,
    a.transfer_to_09_ids,
    a.transfer_to_damaged_ids,
    a.transfer_to_scrap_ids,
    a.transfer_to_other_ids,
    a.routed_warehouses,
    a.latest_route_time
  FROM rtv_in r
  LEFT JOIN alloc_03 a
    ON a.return_order_id = r.return_order_id
   AND a.match_key = r.match_key
),
damaged_pool AS (
  SELECT
    *,
    (direct_damaged_quantity + from_03_to_damaged_quantity) AS damaged_input_quantity,
    coalesce(latest_route_time, rtv_received_time) AS damaged_time
  FROM base_alloc
  WHERE (direct_damaged_quantity + from_03_to_damaged_quantity) > 0
),
transfer_out_04 AS (
  SELECT
    lower(o.from_id) AS transfer_id,
    coalesce(nullif(o.match_key,''), dim.product_match_key(o.standard_goods_sn)) AS match_key,
    sum(abs(o.quantity))::numeric AS out_qty,
    min(o.created_time) AS out_time
  FROM fact.et_stock_running o
  WHERE o.sort_name = '调拨单'
    AND o.quantity < 0
    AND (coalesce(o.storeroom_name,'') ILIKE '%04%' OR coalesce(o.storeroom_name,'') ILIKE '%Damaged%')
  GROUP BY lower(o.from_id), coalesce(nullif(o.match_key,''), dim.product_match_key(o.standard_goods_sn))
),
transfer_pos_04 AS (
  SELECT
    lower(i.from_id) AS transfer_id,
    coalesce(nullif(i.match_key,''), dim.product_match_key(i.standard_goods_sn)) AS match_key,
    CASE
      WHEN coalesce(i.storeroom_name,'') ILIKE '%09%' OR coalesce(i.storeroom_name,'') ILIKE '%散件%' THEN '09'
      WHEN coalesce(i.storeroom_name,'') ILIKE '%06%' OR coalesce(i.storeroom_name,'') ILIKE '%报废%' THEN 'scrap'
      ELSE 'other'
    END AS dest_type,
    sum(i.quantity)::numeric AS pos_qty,
    max(i.created_time) AS in_time
  FROM fact.et_stock_running i
  WHERE i.sort_name = '调拨单'
    AND i.quantity > 0
  GROUP BY lower(i.from_id), coalesce(nullif(i.match_key,''), dim.product_match_key(i.standard_goods_sn)),
    CASE
      WHEN coalesce(i.storeroom_name,'') ILIKE '%09%' OR coalesce(i.storeroom_name,'') ILIKE '%散件%' THEN '09'
      WHEN coalesce(i.storeroom_name,'') ILIKE '%06%' OR coalesce(i.storeroom_name,'') ILIKE '%报废%' THEN 'scrap'
      ELSE 'other'
    END
),
transfer_pos_total_04 AS (
  SELECT transfer_id, match_key, sum(pos_qty) AS total_pos_qty
  FROM transfer_pos_04
  GROUP BY transfer_id, match_key
),
transfer_events_04 AS (
  SELECT
    o.transfer_id,
    o.match_key,
    p.dest_type,
    CASE
      WHEN coalesce(t.total_pos_qty,0) > o.out_qty THEN o.out_qty * p.pos_qty / nullif(t.total_pos_qty,0)
      ELSE p.pos_qty
    END AS event_qty,
    o.out_time,
    p.in_time
  FROM transfer_out_04 o
  JOIN transfer_pos_04 p
    ON p.transfer_id = o.transfer_id
   AND p.match_key = o.match_key
  LEFT JOIN transfer_pos_total_04 t
    ON t.transfer_id = o.transfer_id
   AND t.match_key = o.match_key
),
damaged_seq AS (
  SELECT
    *,
    coalesce(sum(damaged_input_quantity) OVER (
      PARTITION BY match_key
      ORDER BY damaged_time, return_order_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ),0) AS damaged_start,
    sum(damaged_input_quantity) OVER (
      PARTITION BY match_key
      ORDER BY damaged_time, return_order_id
      ROWS UNBOUNDED PRECEDING
    ) AS damaged_end
  FROM damaged_pool
),
transfer_04_seq AS (
  SELECT
    *,
    coalesce(sum(event_qty) OVER (
      PARTITION BY match_key
      ORDER BY coalesce(in_time,out_time), transfer_id, dest_type
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ),0) AS event_start,
    sum(event_qty) OVER (
      PARTITION BY match_key
      ORDER BY coalesce(in_time,out_time), transfer_id, dest_type
      ROWS UNBOUNDED PRECEDING
    ) AS event_end
  FROM transfer_events_04
  WHERE event_qty > 0
),
alloc_04 AS (
  SELECT
    d.return_order_id,
    d.match_key,
    sum(greatest(0, least(d.damaged_end, t.event_end) - greatest(d.damaged_start, t.event_start))) FILTER (WHERE t.dest_type = 'scrap') AS damaged_to_scrap_quantity,
    sum(greatest(0, least(d.damaged_end, t.event_end) - greatest(d.damaged_start, t.event_start))) FILTER (WHERE t.dest_type = '09') AS damaged_to_09_quantity,
    sum(greatest(0, least(d.damaged_end, t.event_end) - greatest(d.damaged_start, t.event_start))) FILTER (WHERE t.dest_type = 'other') AS damaged_to_other_quantity,
    string_agg(DISTINCT t.transfer_id, ' / ') FILTER (WHERE t.dest_type = 'scrap') AS damaged_to_scrap_transfer_ids,
    max(t.in_time) AS latest_damaged_route_time
  FROM damaged_seq d
  JOIN transfer_04_seq t
    ON t.match_key = d.match_key
   AND coalesce(t.in_time,t.out_time) >= d.damaged_time
   AND least(d.damaged_end, t.event_end) > greatest(d.damaged_start, t.event_start)
  GROUP BY d.return_order_id, d.match_key
)
SELECT
  b.return_order_id,
  b.match_key,
  b.standard_goods_sn,
  b.initial_warehouse,
  b.rtv_quantity,
  b.rtv_received_time,
  b.direct_09_quantity,
  b.from_03_to_09_quantity,
  coalesce(a4.damaged_to_09_quantity,0) AS damaged_to_09_quantity,
  least(b.rtv_quantity, b.direct_09_quantity + b.from_03_to_09_quantity + coalesce(a4.damaged_to_09_quantity,0)) AS final_09_quantity,
  b.still_03_quantity,
  greatest(0, b.direct_damaged_quantity + b.from_03_to_damaged_quantity - coalesce(a4.damaged_to_scrap_quantity,0) - coalesce(a4.damaged_to_09_quantity,0) - coalesce(a4.damaged_to_other_quantity,0)) AS final_damaged_quantity,
  least(b.rtv_quantity, b.direct_scrap_quantity + b.from_03_to_scrap_quantity + coalesce(a4.damaged_to_scrap_quantity,0)) AS final_scrap_quantity,
  b.from_03_to_other_quantity + coalesce(a4.damaged_to_other_quantity,0) AS final_other_quantity,
  b.transfer_to_09_ids,
  b.transfer_to_damaged_ids,
  b.transfer_to_scrap_ids,
  a4.damaged_to_scrap_transfer_ids,
  b.routed_warehouses,
  greatest(b.latest_route_time, a4.latest_damaged_route_time) AS latest_destination_time,
  concat_ws(' / ',
    CASE WHEN b.direct_09_quantity > 0 THEN '直接入09' END,
    CASE WHEN b.from_03_to_09_quantity > 0 THEN '03调拨入09' END,
    CASE WHEN coalesce(a4.damaged_to_09_quantity,0) > 0 THEN '04调拨入09' END,
    CASE WHEN b.still_03_quantity > 0 THEN '仍在03_RTV' END,
    CASE WHEN greatest(0, b.direct_damaged_quantity + b.from_03_to_damaged_quantity - coalesce(a4.damaged_to_scrap_quantity,0) - coalesce(a4.damaged_to_09_quantity,0) - coalesce(a4.damaged_to_other_quantity,0)) > 0 THEN '破损仓04' END,
    CASE WHEN b.direct_scrap_quantity + b.from_03_to_scrap_quantity + coalesce(a4.damaged_to_scrap_quantity,0) > 0 THEN '报废仓06' END,
    CASE WHEN b.from_03_to_other_quantity + coalesce(a4.damaged_to_other_quantity,0) > 0 THEN '其它/未知' END
  ) AS destination_summary,
  'stock_ledger_fifo_by_product' AS allocation_method
FROM base_alloc b
LEFT JOIN alloc_04 a4
  ON a4.return_order_id = b.return_order_id
 AND a4.match_key = b.match_key;

CREATE OR REPLACE VIEW mart.rtv_recovery_impact AS
WITH after_sales_raw AS (
  SELECT
    ai.store_key,
    ai.order_no,
    ai.standard_goods_sn,
    nullif(ai.skc,'') AS skc,
    nullif(regexp_replace(upper(coalesce(x->>'expressNo','')), '[^0-9A-Z]', '', 'g'), '') AS express_no,
    ai.aftersales_order_no,
    ai.return_order_no,
    coalesce(ai.quantity, 1) AS quantity
  FROM fact.after_sales_item ai
  LEFT JOIN LATERAL jsonb_array_elements(coalesce(ai.raw_summary->'case'->'returnExpressInfoList','[]'::jsonb)) x ON true
  WHERE coalesce(ai.order_no,'') <> ''
    AND coalesce(ai.return_order_no,'') <> ''
    AND nullif(regexp_replace(upper(coalesce(x->>'expressNo','')), '[^0-9A-Z]', '', 'g'), '') IS NOT NULL

  UNION

  SELECT
    ai.store_key,
    ai.order_no,
    ai.standard_goods_sn,
    nullif(ai.skc,'') AS skc,
    nullif(regexp_replace(upper(coalesce(v.et_shipment_number,'')), '[^0-9A-Z]', '', 'g'), '') AS express_no,
    ai.aftersales_order_no,
    ai.return_order_no,
    coalesce(ai.quantity, 1) AS quantity
  FROM ops.rtv_tracking_verification v
  JOIN fact.after_sales_item ai
    ON ai.store_key = v.store_key
   AND ai.aftersales_order_no = v.shein_aftersales_order_no
  WHERE v.match_status = 'matched'
    AND coalesce(ai.order_no,'') <> ''
    AND coalesce(ai.return_order_no,'') <> ''
    AND nullif(regexp_replace(upper(coalesce(v.et_shipment_number,'')), '[^0-9A-Z]', '', 'g'), '') IS NOT NULL
),
after_sales_express AS (
  SELECT
    store_key,
    order_no,
    standard_goods_sn,
    skc,
    express_no,
    sum(quantity) AS after_sales_return_qty,
    string_agg(DISTINCT aftersales_order_no, ' / ') FILTER (WHERE coalesce(aftersales_order_no,'') <> '') AS aftersales_order_nos,
    string_agg(DISTINCT return_order_no, ' / ') FILTER (WHERE coalesce(return_order_no,'') <> '') AS shein_return_order_nos
  FROM after_sales_raw
  WHERE express_no IS NOT NULL
  GROUP BY store_key, order_no, standard_goods_sn, skc, express_no
),
et_return_received_base AS (
  SELECT
    nullif(regexp_replace(upper(coalesce(ro.shipment_number,'')), '[^0-9A-Z]', '', 'g'), '') AS express_no,
    coalesce(nullif(ri.match_key,''), dim.product_match_key(ri.standard_goods_sn)) AS match_key,
    string_agg(DISTINCT ro.return_order_id, ' / ') FILTER (WHERE coalesce(ro.return_order_id,'') <> '') AS et_return_order_ids,
    concat_ws(
      ' / ',
      string_agg(DISTINCT ro.store_name_in, ' / ') FILTER (WHERE coalesce(ro.store_name_in,'') <> ''),
      string_agg(DISTINCT rdest.destination_summary, ' / ') FILTER (WHERE coalesce(rdest.destination_summary,'') <> '')
    ) AS et_return_warehouses,
    greatest(max(ro.create_time), max(rdest.latest_destination_time)) AS et_received_time,
    sum(
      CASE
        WHEN coalesce(ro.status_name,'') IN ('已完结','已到货')
          AND (coalesce(ro.in_quantity,0) > 0 OR coalesce(ri.instock,0) > 0)
        THEN greatest(
          coalesce(ri.instock,0),
          CASE WHEN coalesce(ri.instock,0) > 0 THEN 0 ELSE coalesce(ri.quantity,0) END,
          CASE WHEN ri.return_order_id IS NULL THEN coalesce(ro.in_quantity,0) ELSE 0 END
        )
        ELSE 0
      END
    ) AS et_received_qty,
    sum(
      CASE
        WHEN (coalesce(ro.store_name_in,'') ILIKE '%09%' OR coalesce(ro.store_name_in,'') ILIKE '%散件%')
          AND coalesce(ro.status_name,'') IN ('已完结','已到货')
          AND (coalesce(ro.in_quantity,0) > 0 OR coalesce(ri.instock,0) > 0)
        THEN greatest(
          coalesce(ri.instock,0),
          CASE WHEN coalesce(ri.instock,0) > 0 THEN 0 ELSE coalesce(ri.quantity,0) END,
          CASE WHEN ri.return_order_id IS NULL THEN coalesce(ro.in_quantity,0) ELSE 0 END
        )
        ELSE 0
      END
    ) + max(coalesce(rdest.final_09_quantity,0)) AS et_received_to_09_qty,
    sum(
      CASE
        WHEN (coalesce(ro.store_name_in,'') ILIKE '%03%' OR coalesce(ro.store_name_in,'') ILIKE '%RTV%')
          AND coalesce(ro.status_name,'') IN ('已完结','已到货')
          AND (coalesce(ro.in_quantity,0) > 0 OR coalesce(ri.instock,0) > 0)
        THEN greatest(
          coalesce(ri.instock,0),
          CASE WHEN coalesce(ri.instock,0) > 0 THEN 0 ELSE coalesce(ri.quantity,0) END,
          CASE WHEN ri.return_order_id IS NULL THEN coalesce(ro.in_quantity,0) ELSE 0 END
        )
        ELSE 0
      END
    ) AS et_received_to_rtv_qty
  FROM fact.et_return_order ro
  LEFT JOIN fact.et_return_order_item ri ON ri.return_order_id = ro.return_order_id
  LEFT JOIN mart.et_rtv_destination_allocation rdest
    ON rdest.return_order_id = ro.return_order_id
   AND rdest.match_key = coalesce(nullif(ri.match_key,''), dim.product_match_key(ri.standard_goods_sn))
  WHERE nullif(regexp_replace(upper(coalesce(ro.shipment_number,'')), '[^0-9A-Z]', '', 'g'), '') IS NOT NULL
  GROUP BY nullif(regexp_replace(upper(coalesce(ro.shipment_number,'')), '[^0-9A-Z]', '', 'g'), ''), coalesce(nullif(ri.match_key,''), dim.product_match_key(ri.standard_goods_sn))
),
et_return_received_verification AS (
  SELECT
    nullif(regexp_replace(upper(coalesce(v.et_shipment_number,'')), '[^0-9A-Z]', '', 'g'), '') AS express_no,
    dim.product_match_key(ai.standard_goods_sn) AS match_key,
    string_agg(DISTINCT ro.return_order_id, ' / ') FILTER (WHERE coalesce(ro.return_order_id,'') <> '') AS et_return_order_ids,
    concat_ws(
      ' / ',
      string_agg(DISTINCT ro.store_name_in, ' / ') FILTER (WHERE coalesce(ro.store_name_in,'') <> ''),
      string_agg(DISTINCT rdest_any.destination_summary, ' / ') FILTER (WHERE coalesce(rdest_any.destination_summary,'') <> '')
    ) AS et_return_warehouses,
    greatest(max(ro.create_time), max(rdest_any.latest_destination_time)) AS et_received_time,
    sum(
      CASE
        WHEN coalesce(ro.status_name,'') IN ('已完结','已到货')
          AND (coalesce(ro.in_quantity,0) > 0 OR coalesce(ri.instock,0) > 0)
        THEN greatest(
          coalesce(ri.instock,0),
          CASE WHEN coalesce(ri.instock,0) > 0 THEN 0 ELSE coalesce(ri.quantity,0) END,
          CASE WHEN ri.return_order_id IS NULL THEN coalesce(ro.in_quantity,0) ELSE 0 END
        )
        ELSE 0
      END
    ) AS et_received_qty,
    sum(
      CASE
        WHEN (coalesce(ro.store_name_in,'') ILIKE '%09%' OR coalesce(ro.store_name_in,'') ILIKE '%散件%')
          AND coalesce(ro.status_name,'') IN ('已完结','已到货')
          AND (coalesce(ro.in_quantity,0) > 0 OR coalesce(ri.instock,0) > 0)
        THEN greatest(
          coalesce(ri.instock,0),
          CASE WHEN coalesce(ri.instock,0) > 0 THEN 0 ELSE coalesce(ri.quantity,0) END,
          CASE WHEN ri.return_order_id IS NULL THEN coalesce(ro.in_quantity,0) ELSE 0 END
        )
        ELSE 0
      END
    ) + max(coalesce(rdest_any.final_09_quantity,0)) AS et_received_to_09_qty,
    sum(
      CASE
        WHEN (coalesce(ro.store_name_in,'') ILIKE '%03%' OR coalesce(ro.store_name_in,'') ILIKE '%RTV%')
          AND coalesce(ro.status_name,'') IN ('已完结','已到货')
          AND (coalesce(ro.in_quantity,0) > 0 OR coalesce(ri.instock,0) > 0)
        THEN greatest(
          coalesce(ri.instock,0),
          CASE WHEN coalesce(ri.instock,0) > 0 THEN 0 ELSE coalesce(ri.quantity,0) END,
          CASE WHEN ri.return_order_id IS NULL THEN coalesce(ro.in_quantity,0) ELSE 0 END
        )
        ELSE 0
      END
    ) AS et_received_to_rtv_qty
  FROM ops.rtv_tracking_verification v
  JOIN fact.after_sales_item ai
    ON ai.store_key = v.store_key
   AND ai.aftersales_order_no = v.shein_aftersales_order_no
  JOIN fact.et_return_order ro
    ON ro.return_order_id = v.et_return_order_id
  LEFT JOIN fact.et_return_order_item ri
    ON ri.return_order_id = ro.return_order_id
  LEFT JOIN LATERAL (
    SELECT
      sum(final_09_quantity) AS final_09_quantity,
      max(latest_destination_time) AS latest_destination_time,
      string_agg(DISTINCT destination_summary, ' / ') FILTER (WHERE coalesce(destination_summary,'') <> '') AS destination_summary
    FROM mart.et_rtv_destination_allocation x
    WHERE x.return_order_id = ro.return_order_id
  ) rdest_any ON true
  WHERE v.match_status = 'matched'
    AND nullif(regexp_replace(upper(coalesce(v.et_shipment_number,'')), '[^0-9A-Z]', '', 'g'), '') IS NOT NULL
    AND dim.product_match_key(ai.standard_goods_sn) IS NOT NULL
  GROUP BY nullif(regexp_replace(upper(coalesce(v.et_shipment_number,'')), '[^0-9A-Z]', '', 'g'), ''), dim.product_match_key(ai.standard_goods_sn)
),
et_return_received AS (
  SELECT
    express_no,
    match_key,
    string_agg(DISTINCT et_return_order_ids, ' / ') FILTER (WHERE coalesce(et_return_order_ids,'') <> '') AS et_return_order_ids,
    string_agg(DISTINCT et_return_warehouses, ' / ') FILTER (WHERE coalesce(et_return_warehouses,'') <> '') AS et_return_warehouses,
    max(et_received_time) AS et_received_time,
    max(et_received_qty) AS et_received_qty,
    max(et_received_to_09_qty) AS et_received_to_09_qty,
    max(et_received_to_rtv_qty) AS et_received_to_rtv_qty
  FROM (
    SELECT * FROM et_return_received_base
    UNION ALL
    SELECT * FROM et_return_received_verification
  ) x
  GROUP BY express_no, match_key
),
stock_running_09 AS (
  SELECT
    nullif(regexp_replace(upper(coalesce(from_id,'')), '[^0-9A-Z]', '', 'g'), '') AS express_no,
    coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn)) AS match_key,
    sum(coalesce(quantity,0)) AS stock_running_09_qty,
    string_agg(DISTINCT storeroom_name, ' / ') FILTER (WHERE coalesce(storeroom_name,'') <> '') AS stock_running_warehouses,
    max(created_time) AS stock_running_09_time
  FROM fact.et_stock_running
  WHERE nullif(regexp_replace(upper(coalesce(from_id,'')), '[^0-9A-Z]', '', 'g'), '') IS NOT NULL
    AND coalesce(quantity,0) > 0
    AND (coalesce(storeroom_name,'') ILIKE '%09%' OR coalesce(storeroom_name,'') ILIKE '%散件%')
  GROUP BY nullif(regexp_replace(upper(coalesce(from_id,'')), '[^0-9A-Z]', '', 'g'), ''), coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn))
),
per_express AS (
  SELECT
    af.store_key,
    af.order_no,
    af.standard_goods_sn,
    af.skc,
    af.express_no,
    af.after_sales_return_qty,
    least(
      coalesce(af.after_sales_return_qty,0),
      greatest(coalesce(er.et_received_qty,0), coalesce(sr.stock_running_09_qty,0))
    ) AS rtv_received_quantity,
    least(
      coalesce(af.after_sales_return_qty,0),
      greatest(coalesce(er.et_received_to_09_qty,0), coalesce(sr.stock_running_09_qty,0))
    ) AS rtv_received_to_09_quantity,
    least(
      coalesce(af.after_sales_return_qty,0),
      coalesce(er.et_received_to_rtv_qty,0)
    ) AS rtv_received_to_rtv_quantity,
    er.et_return_order_ids,
    af.aftersales_order_nos,
    af.shein_return_order_nos,
    concat_ws(' / ', nullif(er.et_return_warehouses,''), nullif(sr.stock_running_warehouses,'')) AS rtv_warehouses,
    greatest(er.et_received_time, sr.stock_running_09_time) AS rtv_latest_received_time
  FROM after_sales_express af
  LEFT JOIN et_return_received er
    ON er.express_no = af.express_no
   AND er.match_key = dim.product_match_key(af.standard_goods_sn)
  LEFT JOIN stock_running_09 sr
    ON sr.express_no = af.express_no
   AND sr.match_key = dim.product_match_key(af.standard_goods_sn)
)
SELECT
  store_key,
  order_no,
  standard_goods_sn,
  skc,
  sum(after_sales_return_qty) AS after_sales_return_qty,
  sum(rtv_received_quantity) AS rtv_received_quantity,
  sum(rtv_received_to_09_quantity) AS rtv_received_to_09_quantity,
  sum(rtv_received_to_rtv_quantity) AS rtv_received_to_rtv_quantity,
  CASE
    WHEN sum(rtv_received_to_09_quantity) > 0 THEN 'confirmed_09'
    WHEN sum(rtv_received_quantity) > 0 THEN 'received_not_09'
    ELSE 'not_received_or_unmatched'
  END AS rtv_recovery_status,
  string_agg(DISTINCT express_no, ' / ') FILTER (WHERE coalesce(express_no,'') <> '') AS rtv_express_numbers,
  string_agg(DISTINCT et_return_order_ids, ' / ') FILTER (WHERE coalesce(et_return_order_ids,'') <> '') AS et_return_order_ids,
  string_agg(DISTINCT aftersales_order_nos, ' / ') FILTER (WHERE coalesce(aftersales_order_nos,'') <> '') AS aftersales_order_nos,
  string_agg(DISTINCT shein_return_order_nos, ' / ') FILTER (WHERE coalesce(shein_return_order_nos,'') <> '') AS shein_return_order_nos,
  string_agg(DISTINCT rtv_warehouses, ' / ') FILTER (WHERE coalesce(rtv_warehouses,'') <> '') AS rtv_warehouses,
  max(rtv_latest_received_time) AS rtv_latest_received_time
FROM per_express
GROUP BY store_key, order_no, standard_goods_sn, skc;

CREATE OR REPLACE VIEW mart.rtv_manual_review_candidates AS
WITH after_sales_raw AS (
  SELECT DISTINCT
    ai.store_key,
    ai.group_key,
    ai.order_no,
    ai.return_order_no,
    ai.aftersales_order_no,
    ai.request_time,
    ai.standard_goods_sn,
    nullif(ai.skc,'') AS skc,
    dim.product_match_key(ai.standard_goods_sn) AS match_key,
    nullif(regexp_replace(upper(coalesce(x->>'expressNo','')), '[^0-9A-Z]', '', 'g'), '') AS express_no,
    ai.resolution_plan_name,
    ai.order_sub_status_name,
    ai.return_package_status_name,
    coalesce(ai.quantity,1) AS quantity
  FROM fact.after_sales_item ai
  LEFT JOIN LATERAL jsonb_array_elements(coalesce(ai.raw_summary->'case'->'returnExpressInfoList','[]'::jsonb)) x ON true
  WHERE coalesce(ai.return_order_no,'') <> ''
    AND coalesce(ai.order_no,'') <> ''

  UNION

  SELECT DISTINCT
    ai.store_key,
    ai.group_key,
    ai.order_no,
    ai.return_order_no,
    ai.aftersales_order_no,
    ai.request_time,
    ai.standard_goods_sn,
    nullif(ai.skc,'') AS skc,
    dim.product_match_key(ai.standard_goods_sn) AS match_key,
    nullif(regexp_replace(upper(coalesce(v.et_shipment_number,'')), '[^0-9A-Z]', '', 'g'), '') AS express_no,
    ai.resolution_plan_name,
    ai.order_sub_status_name,
    ai.return_package_status_name,
    coalesce(ai.quantity,1) AS quantity
  FROM ops.rtv_tracking_verification v
  JOIN fact.after_sales_item ai
    ON ai.store_key = v.store_key
   AND ai.aftersales_order_no = v.shein_aftersales_order_no
  WHERE v.match_status = 'matched'
    AND coalesce(ai.return_order_no,'') <> ''
    AND coalesce(ai.order_no,'') <> ''
),
after_sales_express AS (
  SELECT *
  FROM after_sales_raw
  WHERE express_no IS NOT NULL
),
et_return AS (
  SELECT
    ro.return_order_id,
    ro.rtv,
    ro.shipment_number AS et_shipment_number_raw,
    nullif(regexp_replace(upper(coalesce(ro.shipment_number,'')), '[^0-9A-Z]', '', 'g'), '') AS et_shipment_number,
    CASE
      WHEN nullif(regexp_replace(upper(coalesce(ro.shipment_number,'')), '[^0-9A-Z]', '', 'g'), '') ~ '^[0-9]{10,}$' THEN true
      ELSE false
    END AS suspected_emile_handoff,
    ro.status_name,
    ro.store_name_in,
    ro.to_instock_name,
    ro.in_quantity,
    ro.create_time,
    ri.standard_goods_sn,
    ri.match_key,
    ri.sku_code,
    substring(upper(coalesce(ri.sku_code,'')) from '^([A-Z]{2})[-_]') AS store_key_guess,
    ri.barcode,
    ri.goods_title,
    coalesce(nullif(ri.instock,0), nullif(ri.quantity,0), nullif(ro.in_quantity,0), 0) AS received_quantity
  FROM fact.et_return_order ro
  LEFT JOIN fact.et_return_order_item ri ON ri.return_order_id = ro.return_order_id
  WHERE nullif(regexp_replace(upper(coalesce(ro.shipment_number,'')), '[^0-9A-Z]', '', 'g'), '') IS NOT NULL
    AND nullif(regexp_replace(upper(coalesce(ro.shipment_number,'')), '[^0-9A-Z]', '', 'g'), '') <> ''
    AND coalesce(ro.status_name,'') IN ('已完结','已到货')
    AND (
      coalesce(ro.in_quantity,0) > 0
      OR coalesce(ri.instock,0) > 0
      OR coalesce(ro.to_instock_name,'') <> ''
    )
),
exact_match AS (
  SELECT
    e.return_order_id,
    e.match_key,
    count(*) AS exact_match_count
  FROM et_return e
  JOIN after_sales_express af
    ON af.express_no = e.et_shipment_number
   AND af.match_key = e.match_key
  GROUP BY e.return_order_id, e.match_key
)
SELECT
  e.return_order_id,
  e.rtv,
  e.et_shipment_number_raw,
  e.et_shipment_number,
  e.suspected_emile_handoff,
  e.status_name,
  e.store_name_in,
  e.to_instock_name,
  e.in_quantity,
  e.create_time,
  e.standard_goods_sn,
  e.match_key,
  e.sku_code,
  e.store_key_guess,
  e.barcode,
  e.goods_title,
  e.received_quantity,
  coalesce(x.exact_match_count,0) AS exact_match_count,
  coalesce(c.candidate_case_count,0) AS candidate_case_count,
  c.candidate_cases,
  CASE
    WHEN e.suspected_emile_handoff THEN 'ET RTV 已收，但物流号像 EMile/换单后的数字单号；需进 SHEIN 退货单物流详情核实原退货单'
    ELSE 'ET RTV 已收，但 SHEIN 售后现有退货物流号未直接匹配；需人工核实是否换单号'
  END AS review_reason,
  CASE
    WHEN e.suspected_emile_handoff AND coalesce(c.candidate_case_count,0) > 0 THEN 'high'
    WHEN coalesce(c.candidate_case_count,0) > 0 THEN 'medium'
    ELSE 'low'
  END AS review_priority
FROM et_return e
LEFT JOIN exact_match x
  ON x.return_order_id = e.return_order_id
 AND x.match_key = e.match_key
LEFT JOIN LATERAL (
  SELECT
    count(*) AS candidate_case_count,
    string_agg(
      concat_ws(' · ',
        af.store_key,
        af.order_no,
        '退货单 ' || af.return_order_no,
        '售后单 ' || af.aftersales_order_no,
        'SHEIN物流 ' || coalesce(af.express_no,'-'),
        to_char(af.request_time, 'YYYY-MM-DD')
      ),
      ' || '
      ORDER BY af.request_time DESC NULLS LAST
    ) AS candidate_cases
  FROM (
    SELECT DISTINCT
      af.store_key,
      af.order_no,
      af.return_order_no,
      af.aftersales_order_no,
      af.express_no,
      af.request_time,
      CASE
        WHEN e.store_key_guess IS NULL OR e.store_key_guess = '' THEN 0
        WHEN af.store_key = e.store_key_guess THEN 0
        ELSE 1
      END AS store_rank
    FROM after_sales_express af
    WHERE af.match_key = e.match_key
      AND (
        e.create_time IS NULL
        OR af.request_time IS NULL
        OR af.request_time BETWEEN e.create_time - interval '90 days' AND e.create_time + interval '15 days'
      )
    ORDER BY store_rank, af.request_time DESC NULLS LAST
    LIMIT 20
  ) af
) c ON true
WHERE coalesce(x.exact_match_count,0) = 0
  AND NOT EXISTS (
    SELECT 1
    FROM ops.rtv_tracking_verification v
    WHERE v.match_status = 'matched'
      AND v.et_return_order_id = e.return_order_id
  );

CREATE OR REPLACE VIEW mart.shein_return_rtv_trace AS
WITH after_sales AS (
  SELECT
    ai.store_key,
    ai.group_key,
    ai.order_no,
    ai.return_order_no,
    ai.aftersales_order_no,
    ai.request_time,
    ai.standard_goods_sn,
    nullif(ai.skc,'') AS skc,
    ai.resolution_plan_name,
    ai.order_sub_status_name,
    ai.return_package_status_name,
    coalesce(ai.quantity,1) AS quantity,
    string_agg(
      DISTINCT nullif(regexp_replace(upper(coalesce(x->>'expressNo','')), '[^0-9A-Z]', '', 'g'), ''),
      ' / '
    ) FILTER (WHERE nullif(regexp_replace(upper(coalesce(x->>'expressNo','')), '[^0-9A-Z]', '', 'g'), '') IS NOT NULL) AS shein_return_express_numbers
  FROM fact.after_sales_item ai
  LEFT JOIN LATERAL jsonb_array_elements(coalesce(ai.raw_summary->'case'->'returnExpressInfoList','[]'::jsonb)) x ON true
  WHERE coalesce(ai.return_order_no,'') <> ''
    AND coalesce(ai.order_no,'') <> ''
  GROUP BY ai.store_key, ai.group_key, ai.order_no, ai.return_order_no, ai.aftersales_order_no,
    ai.request_time, ai.standard_goods_sn, nullif(ai.skc,''), ai.resolution_plan_name,
    ai.order_sub_status_name, ai.return_package_status_name, coalesce(ai.quantity,1)
)
SELECT
  a.store_key,
  a.group_key,
  a.order_no,
  a.return_order_no,
  a.aftersales_order_no,
  a.request_time,
  a.standard_goods_sn,
  a.skc,
  a.resolution_plan_name,
  a.order_sub_status_name,
  a.return_package_status_name,
  a.quantity,
  a.shein_return_express_numbers,
  coalesce(rr.rtv_received_quantity,0) AS rtv_received_quantity,
  coalesce(rr.rtv_received_to_09_quantity,0) AS rtv_received_to_09_quantity,
  coalesce(rr.rtv_received_to_rtv_quantity,0) AS rtv_received_to_rtv_quantity,
  rr.rtv_recovery_status,
  rr.rtv_express_numbers,
  rr.et_return_order_ids,
  rr.rtv_warehouses,
  rr.rtv_latest_received_time,
  coalesce(dest.final_09_quantity,0) AS final_09_quantity,
  coalesce(dest.still_03_quantity,0) AS still_03_quantity,
  coalesce(dest.final_damaged_quantity,0) AS final_damaged_quantity,
  coalesce(dest.final_scrap_quantity,0) AS final_scrap_quantity,
  coalesce(dest.final_other_quantity,0) AS final_other_quantity,
  dest.destination_summary,
  CASE
    WHEN coalesce(rr.rtv_received_quantity,0) <= 0 THEN '未匹配到ET收件'
    WHEN coalesce(dest.final_09_quantity,0) > 0 THEN '已收-可售09'
    WHEN coalesce(dest.final_damaged_quantity,0) > 0 THEN '已收-破损04'
    WHEN coalesce(dest.final_scrap_quantity,0) > 0 THEN '已收-报废06'
    WHEN coalesce(dest.still_03_quantity,0) > 0 THEN '已收-仍在03_RTV'
    WHEN coalesce(dest.final_other_quantity,0) > 0 THEN '已收-其它/未知去向'
    ELSE '已收-未解析去向'
  END AS trace_status
FROM after_sales a
LEFT JOIN mart.rtv_recovery_impact rr
  ON rr.store_key = a.store_key
 AND rr.order_no = a.order_no
 AND (
   (coalesce(a.skc,'') <> '' AND a.skc = rr.skc)
   OR dim.product_match_key(a.standard_goods_sn) = dim.product_match_key(rr.standard_goods_sn)
 )
 AND (
   coalesce(rr.aftersales_order_nos,'') = ''
   OR position(a.aftersales_order_no in rr.aftersales_order_nos) > 0
 )
LEFT JOIN LATERAL (
  SELECT
    sum(final_09_quantity) AS final_09_quantity,
    sum(still_03_quantity) AS still_03_quantity,
    sum(final_damaged_quantity) AS final_damaged_quantity,
    sum(final_scrap_quantity) AS final_scrap_quantity,
    sum(final_other_quantity) AS final_other_quantity,
    string_agg(DISTINCT destination_summary, ' / ') FILTER (WHERE coalesce(destination_summary,'') <> '') AS destination_summary
  FROM mart.et_rtv_destination_allocation d
  WHERE d.return_order_id = ANY(regexp_split_to_array(coalesce(rr.et_return_order_ids,''), '\\s*/\\s*'))
) dest ON true;

CREATE OR REPLACE VIEW mart.profit_order_item AS
WITH base AS (
  SELECT
    oi.order_item_key,
    oi.order_key,
    oi.store_key,
    coalesce(oi.group_key, s.group_key) AS group_key,
    oi.order_no,
    oi.bill_no,
    oi.created_date,
    date_trunc('month', oi.created_date)::date AS month_start,
    oi.order_create_time,
    dim.product_canonical_sn(oi.standard_goods_sn) AS standard_goods_sn,
    oi.raw_goods_sn,
    oi.skc,
    oi.goods_title,
    coalesce(oi.quantity,0) AS quantity,
    coalesce(oi.sales_sar,0) AS gross_revenue_sar,
    CASE WHEN coalesce(ai.revenue_reversal,false) THEN 0 ELSE coalesce(oi.sales_sar,0) END AS net_revenue_sar,
    c.unit_cost_sar,
    c.complete_batch_count::bigint AS complete_batch_count,
    c.ignored_batch_count::bigint AS ignored_batch_count,
    (c.unit_cost_sar IS NULL) AS cost_missing,
    coalesce(ai.revenue_reversal,false) AS revenue_reversal,
    coalesce(ai.after_sales_cases,0) AS after_sales_cases,
    coalesce(ai.impact_quantity,0) AS impact_quantity,
    coalesce(ai.impact_amount_sar,0) AS impact_amount_sar,
    ai.resolution_plans,
    ai.order_sub_statuses,
    ai.return_package_statuses,
    coalesce(rr.rtv_received_quantity,0) AS rtv_received_quantity,
    coalesce(rr.rtv_received_to_09_quantity,0) AS rtv_received_to_09_quantity,
    coalesce(rr.rtv_received_to_rtv_quantity,0) AS rtv_received_to_rtv_quantity,
    rr.rtv_recovery_status,
    rr.rtv_express_numbers,
    rr.et_return_order_ids,
    rr.rtv_warehouses,
    rr.rtv_latest_received_time,
    (
      coalesce(ai.revenue_reversal,false)
      AND coalesce(oi.sales_sar,0) > 0
      AND coalesce(ai.resolution_plans,'') ILIKE '%退货%'
      AND coalesce(ai.resolution_plans,'') NOT ILIKE '%仅退款%'
      AND coalesce(ai.return_package_statuses,'') NOT ILIKE '%派件失败%'
      AND coalesce(ai.return_package_statuses,'') NOT ILIKE '%派件异常%'
      AND coalesce(ai.order_sub_statuses,'') NOT ILIKE '%派件失败%'
      AND coalesce(ai.order_sub_statuses,'') NOT ILIKE '%派件异常%'
    ) AS should_charge_return_delivery_fee
  FROM fact.order_item oi
  LEFT JOIN dim.store s ON s.store_key = oi.store_key
  LEFT JOIN mart.product_unit_cost_by_match_key c
    ON c.match_key <> ''
   AND c.match_key = dim.product_match_key(oi.standard_goods_sn)
  LEFT JOIN LATERAL (
    SELECT *
    FROM mart.profit_after_sales_impact x
    WHERE x.order_no = oi.order_no
      AND x.revenue_reversal
      AND (
        (coalesce(x.skc,'') <> '' AND x.skc = oi.skc)
        OR (
          coalesce(x.standard_goods_sn,'') <> ''
          AND dim.product_match_key(x.standard_goods_sn) = dim.product_match_key(oi.standard_goods_sn)
        )
        OR (coalesce(x.skc,'') = '' AND coalesce(x.standard_goods_sn,'') = '')
      )
    ORDER BY CASE
      WHEN x.store_key = oi.store_key AND x.skc = oi.skc THEN -1
      WHEN x.skc = oi.skc THEN 0
      WHEN x.store_key = oi.store_key AND x.standard_goods_sn = oi.standard_goods_sn THEN 1
      WHEN x.standard_goods_sn = oi.standard_goods_sn THEN 2
      WHEN x.store_key = oi.store_key AND dim.product_match_key(x.standard_goods_sn) = dim.product_match_key(oi.standard_goods_sn) THEN 3
      WHEN dim.product_match_key(x.standard_goods_sn) = dim.product_match_key(oi.standard_goods_sn) THEN 4
      ELSE 5
    END
    LIMIT 1
  ) ai ON true
  LEFT JOIN LATERAL (
    SELECT *
    FROM mart.rtv_recovery_impact x
    WHERE x.order_no = oi.order_no
      AND x.rtv_received_quantity > 0
      AND (
        (coalesce(x.skc,'') <> '' AND x.skc = oi.skc)
        OR (
          coalesce(x.standard_goods_sn,'') <> ''
          AND dim.product_match_key(x.standard_goods_sn) = dim.product_match_key(oi.standard_goods_sn)
        )
        OR (coalesce(x.skc,'') = '' AND coalesce(x.standard_goods_sn,'') = '')
      )
    ORDER BY CASE
      WHEN x.store_key = oi.store_key AND x.skc = oi.skc THEN -1
      WHEN x.skc = oi.skc THEN 0
      WHEN x.store_key = oi.store_key AND x.standard_goods_sn = oi.standard_goods_sn THEN 1
      WHEN x.standard_goods_sn = oi.standard_goods_sn THEN 2
      WHEN x.store_key = oi.store_key AND dim.product_match_key(x.standard_goods_sn) = dim.product_match_key(oi.standard_goods_sn) THEN 3
      WHEN dim.product_match_key(x.standard_goods_sn) = dim.product_match_key(oi.standard_goods_sn) THEN 4
      ELSE 5
    END
    LIMIT 1
  ) rr ON true
)
SELECT
  order_item_key,
  order_key,
  store_key,
  group_key,
  order_no,
  bill_no,
  created_date,
  month_start,
  order_create_time,
  standard_goods_sn,
  raw_goods_sn,
  skc,
  goods_title,
  quantity,
  gross_revenue_sar,
  net_revenue_sar,
  unit_cost_sar,
  CASE
    WHEN unit_cost_sar IS NULL THEN NULL
    WHEN gross_revenue_sar <= 0 THEN 0
    ELSE unit_cost_sar * quantity
  END AS product_cost_sar,
  CASE WHEN should_charge_return_delivery_fee THEN 13.88 ELSE 0 END AS return_delivery_fee_sar,
  CASE
    WHEN unit_cost_sar IS NULL THEN NULL
    WHEN revenue_reversal AND gross_revenue_sar > 0
    THEN least(quantity, rtv_received_quantity) * unit_cost_sar
    ELSE 0
  END AS rtv_recoverable_cost_sar,
  CASE
    WHEN unit_cost_sar IS NULL THEN NULL
    WHEN revenue_reversal AND gross_revenue_sar > 0
    THEN least(quantity, rtv_received_to_09_quantity) * unit_cost_sar
    ELSE 0
  END AS rtv_09_recoverable_cost_sar,
  CASE
    WHEN unit_cost_sar IS NULL THEN NULL
    ELSE net_revenue_sar
      - CASE WHEN gross_revenue_sar <= 0 THEN 0 ELSE unit_cost_sar * quantity END
      - CASE WHEN should_charge_return_delivery_fee THEN 13.88 ELSE 0 END
  END AS profit_before_storage_sar,
  CASE
    WHEN unit_cost_sar IS NULL THEN NULL
    ELSE net_revenue_sar
      - CASE WHEN gross_revenue_sar <= 0 THEN 0 ELSE unit_cost_sar * quantity END
      - CASE WHEN should_charge_return_delivery_fee THEN 13.88 ELSE 0 END
      + CASE
          WHEN revenue_reversal AND gross_revenue_sar > 0
          THEN least(quantity, rtv_received_quantity) * unit_cost_sar
          ELSE 0
        END
  END AS profit_if_rtv_received_resellable_sar,
  CASE
    WHEN unit_cost_sar IS NULL THEN NULL
    ELSE net_revenue_sar
      - CASE WHEN gross_revenue_sar <= 0 THEN 0 ELSE unit_cost_sar * quantity END
      - CASE WHEN should_charge_return_delivery_fee THEN 13.88 ELSE 0 END
      + CASE
          WHEN revenue_reversal AND gross_revenue_sar > 0
          THEN least(quantity, rtv_received_to_09_quantity) * unit_cost_sar
          ELSE 0
        END
  END AS profit_if_rtv_09_resellable_sar,
  CASE
    WHEN unit_cost_sar IS NULL THEN NULL
    WHEN net_revenue_sar = 0 THEN NULL
    ELSE (
      net_revenue_sar
      - CASE WHEN gross_revenue_sar <= 0 THEN 0 ELSE unit_cost_sar * quantity END
      - CASE WHEN should_charge_return_delivery_fee THEN 13.88 ELSE 0 END
    ) / nullif(net_revenue_sar, 0)
  END AS profit_margin_before_storage,
  complete_batch_count,
  ignored_batch_count,
  cost_missing,
  revenue_reversal,
  after_sales_cases,
  impact_quantity,
  impact_amount_sar,
  rtv_received_quantity,
  rtv_received_to_09_quantity,
  rtv_received_to_rtv_quantity,
  rtv_recovery_status,
  rtv_express_numbers,
  et_return_order_ids,
  rtv_warehouses,
  rtv_latest_received_time,
  resolution_plans,
  order_sub_statuses,
  return_package_statuses
FROM base;

CREATE OR REPLACE VIEW mart.product_display_by_match_key AS
WITH sales_candidate AS (
  SELECT
    dim.product_match_key(standard_goods_sn) AS match_key,
    standard_goods_sn AS display_standard_goods_sn,
    'profit_order_item'::text AS display_source,
    0 AS source_priority,
    max(created_date)::date AS last_seen_date,
    count(*)::bigint AS row_count,
    sum(abs(coalesce(net_revenue_sar, gross_revenue_sar, 0)))::numeric AS amount_weight
  FROM mart.profit_order_item
  WHERE coalesce(standard_goods_sn,'') <> ''
  GROUP BY dim.product_match_key(standard_goods_sn), standard_goods_sn
),
product_candidate AS (
  SELECT
    dim.product_match_key(standard_goods_sn) AS match_key,
    standard_goods_sn AS display_standard_goods_sn,
    'dim_product'::text AS display_source,
    1 AS source_priority,
    max(last_seen_date)::date AS last_seen_date,
    0::bigint AS row_count,
    0::numeric AS amount_weight
  FROM dim.product
  WHERE coalesce(standard_goods_sn,'') <> ''
  GROUP BY dim.product_match_key(standard_goods_sn), standard_goods_sn
),
candidates AS (
  SELECT * FROM sales_candidate
  UNION ALL
  SELECT * FROM product_candidate
)
SELECT DISTINCT ON (match_key)
  match_key,
  display_standard_goods_sn,
  display_source,
  last_seen_date
FROM candidates
WHERE coalesce(match_key,'') <> ''
  AND coalesce(display_standard_goods_sn,'') <> ''
ORDER BY
  match_key,
  source_priority,
  last_seen_date DESC NULLS LAST,
  row_count DESC,
  amount_weight DESC NULLS LAST,
  display_standard_goods_sn;

CREATE OR REPLACE VIEW mart.et_storage_fee_daily AS
WITH policy AS (
  SELECT * FROM dim.storage_fee_policy WHERE policy_key = 'et_default'
),
base AS (
  SELECT
    coalesce(ship_time::date, create_time::date, push_time::date) AS fee_date,
    income_bill_id,
    status AS bill_status,
    status_name AS bill_status_name,
    coalesce(other_income,0) AS shown_fee_rmb,
    out_money AS diagnostic_out_money_rmb,
    billing_period_date::date AS billing_period_date,
    raw_summary
  FROM fact.et_income_bill
  WHERE sort_name = '仓储费'
)
SELECT
  b.fee_date,
  b.income_bill_id,
  b.bill_status,
  b.bill_status_name,
  b.shown_fee_rmb,
  b.diagnostic_out_money_rmb,
  b.billing_period_date,
  p.billing_discount,
  round((b.shown_fee_rmb * p.billing_discount)::numeric, 6) AS actual_fee_rmb,
  round((b.shown_fee_rmb * p.billing_discount / nullif(p.sar_to_rmb,0))::numeric, 6) AS actual_fee_sar,
  p.currency_code,
  p.sar_to_rmb,
  'et_income_bill'::text AS source,
  b.raw_summary
FROM base b
CROSS JOIN policy p
WHERE b.fee_date IS NOT NULL;

CREATE OR REPLACE VIEW mart.storage_fee_store_daily AS
WITH fee_daily AS (
  SELECT fee_date AS date, sum(actual_fee_sar) AS actual_fee_sar
  FROM mart.et_storage_fee_daily
  GROUP BY fee_date
),
store_day AS (
  SELECT
    created_date::date AS date,
    store_key,
    group_key,
    sum(net_revenue_sar) AS net_revenue_sar
  FROM mart.profit_order_item
  GROUP BY created_date::date, store_key, group_key
),
day_total AS (
  SELECT date, sum(net_revenue_sar) AS day_net_revenue_sar
  FROM store_day
  GROUP BY date
),
store_month AS (
  SELECT
    date_trunc('month', date)::date AS month_start,
    store_key,
    group_key,
    sum(net_revenue_sar) AS month_net_revenue_sar
  FROM store_day
  GROUP BY date_trunc('month', date)::date, store_key, group_key
),
month_total AS (
  SELECT month_start, sum(month_net_revenue_sar) AS month_net_revenue_sar
  FROM store_month
  GROUP BY month_start
)
SELECT
  sf.date,
  sm.store_key,
  sm.group_key,
  coalesce(sd.net_revenue_sar,0) AS net_revenue_sar,
  CASE
    WHEN coalesce(dt.day_net_revenue_sar,0) > 0 THEN coalesce(sd.net_revenue_sar,0) / nullif(dt.day_net_revenue_sar,0)
    WHEN coalesce(mt.month_net_revenue_sar,0) > 0 THEN coalesce(sm.month_net_revenue_sar,0) / nullif(mt.month_net_revenue_sar,0)
    ELSE 0
  END AS revenue_share,
  sf.actual_fee_sar * CASE
    WHEN coalesce(dt.day_net_revenue_sar,0) > 0 THEN coalesce(sd.net_revenue_sar,0) / nullif(dt.day_net_revenue_sar,0)
    WHEN coalesce(mt.month_net_revenue_sar,0) > 0 THEN coalesce(sm.month_net_revenue_sar,0) / nullif(mt.month_net_revenue_sar,0)
    ELSE 0
  END AS allocated_storage_fee_sar,
  CASE
    WHEN coalesce(dt.day_net_revenue_sar,0) > 0 THEN 'daily_net_revenue'
    WHEN coalesce(mt.month_net_revenue_sar,0) > 0 THEN 'monthly_net_revenue_fallback'
    ELSE 'unallocated_no_revenue'
  END AS allocation_method
FROM fee_daily sf
JOIN store_month sm
  ON sm.month_start = date_trunc('month', sf.date)::date
LEFT JOIN store_day sd
  ON sd.date = sf.date AND sd.store_key = sm.store_key
LEFT JOIN day_total dt
  ON dt.date = sf.date
LEFT JOIN month_total mt
  ON mt.month_start = sm.month_start;

CREATE OR REPLACE VIEW mart.storage_fee_product_daily_estimated AS
WITH fee_daily AS (
  SELECT fee_date AS date, sum(actual_fee_sar) AS actual_fee_sar
  FROM mart.et_storage_fee_daily
  GROUP BY fee_date
),
latest_sku AS (
  SELECT DISTINCT ON (match_key)
    match_key,
    standard_goods_sn,
    CASE
      WHEN sku_volume > 0 AND sku_volume < 500000 THEN sku_volume / 1000000.0
      WHEN goods_volume > 0 AND goods_volume < 500000 THEN goods_volume / 1000000.0
      ELSE NULL
    END AS volume_m3_per_unit
  FROM fact.et_sku_specification
  WHERE coalesce(match_key,'') <> ''
  ORDER BY match_key, source_batch_id DESC
),
stock AS (
  SELECT snapshot_date AS date, storeroom_name, match_key, standard_goods_sn, sum(coalesce(real_quantity, quantity, 0)) AS on_hand_qty
  FROM fact.et_store_stock_snapshot
  WHERE coalesce(match_key,'') <> ''
  GROUP BY snapshot_date, storeroom_name, match_key, standard_goods_sn
  UNION ALL
  SELECT snapshot_date AS date, storeroom_name, match_key, standard_goods_sn, sum(coalesce(real_quantity, quantity, 0)) AS on_hand_qty
  FROM fact.et_box_stock_snapshot
  WHERE coalesce(match_key,'') <> ''
  GROUP BY snapshot_date, storeroom_name, match_key, standard_goods_sn
),
stock_rated_observed AS (
  SELECT
    s.date,
    s.storeroom_name,
    s.match_key,
    max(s.standard_goods_sn) AS standard_goods_sn,
    sum(s.on_hand_qty) AS on_hand_qty,
    max(ls.volume_m3_per_unit) AS volume_m3_per_unit,
    max(r.rate_rmb_per_m3_day) AS rate_rmb_per_m3_day,
    max(r.warehouse_discount) AS warehouse_discount
  FROM stock s
  LEFT JOIN latest_sku ls ON ls.match_key = s.match_key
  LEFT JOIN LATERAL (
    SELECT *
    FROM dim.storage_warehouse_rate wr
    WHERE s.storeroom_name ILIKE wr.warehouse_match
      AND wr.billable
    ORDER BY wr.priority
    LIMIT 1
  ) r ON true
  WHERE r.warehouse_match IS NOT NULL
  GROUP BY s.date, s.storeroom_name, s.match_key
),
stock_for_fee AS (
  SELECT
    f.date,
    pick.source_snapshot_date,
    CASE
      WHEN pick.source_snapshot_date = f.date THEN 'same_day_snapshot'
      WHEN pick.source_snapshot_date < f.date THEN 'latest_prior_snapshot'
      WHEN pick.source_snapshot_date > f.date THEN 'first_available_forward_snapshot'
      ELSE 'missing_stock_snapshot'
    END AS stock_snapshot_method,
    s.storeroom_name,
    s.match_key,
    s.standard_goods_sn,
    s.on_hand_qty,
    s.volume_m3_per_unit,
    s.rate_rmb_per_m3_day,
    s.warehouse_discount
  FROM fee_daily f
  LEFT JOIN LATERAL (
    SELECT coalesce(
      (SELECT max(x.date) FROM stock_rated_observed x WHERE x.date <= f.date),
      (SELECT min(x.date) FROM stock_rated_observed x WHERE x.date > f.date)
    ) AS source_snapshot_date
  ) pick ON true
  JOIN stock_rated_observed s ON s.date = pick.source_snapshot_date
),
weighted AS (
  SELECT
    date,
    source_snapshot_date,
    stock_snapshot_method,
    coalesce(nullif(standard_goods_sn,''), match_key) AS standard_goods_sn,
    match_key,
    storeroom_name AS warehouse_name,
    on_hand_qty,
    volume_m3_per_unit,
    rate_rmb_per_m3_day,
    warehouse_discount,
    on_hand_qty * volume_m3_per_unit AS stock_m3_days,
    on_hand_qty * volume_m3_per_unit * rate_rmb_per_m3_day * warehouse_discount AS estimated_fee_rmb_before_calibration
  FROM stock_for_fee
  WHERE coalesce(on_hand_qty,0) > 0
    AND coalesce(volume_m3_per_unit,0) > 0
    AND coalesce(rate_rmb_per_m3_day,0) > 0
),
daily_weight AS (
  SELECT date, sum(estimated_fee_rmb_before_calibration) AS total_estimated_fee_rmb
  FROM weighted
  GROUP BY date
)
SELECT
  w.date,
  w.source_snapshot_date,
  w.stock_snapshot_method,
  coalesce(pd.display_standard_goods_sn, w.standard_goods_sn) AS standard_goods_sn,
  w.match_key,
  w.warehouse_name,
  w.on_hand_qty AS quantity,
  w.volume_m3_per_unit,
  w.stock_m3_days AS volume_m3_total,
  w.stock_m3_days,
  w.rate_rmb_per_m3_day,
  w.warehouse_discount,
  w.estimated_fee_rmb_before_calibration,
  f.actual_fee_sar * w.estimated_fee_rmb_before_calibration / nullif(dw.total_estimated_fee_rmb,0) AS actual_allocated_fee_sar,
  ('volume_stock_days_estimated:' || w.stock_snapshot_method)::text AS storage_allocation_method
FROM weighted w
JOIN daily_weight dw ON dw.date = w.date
JOIN fee_daily f ON f.date = w.date
LEFT JOIN mart.product_display_by_match_key pd
  ON pd.match_key = w.match_key;

CREATE OR REPLACE VIEW mart.storage_fee_product_daily AS
WITH policy AS (
  SELECT * FROM dim.storage_fee_policy WHERE policy_key = 'et_default'
),
fee_daily AS (
  SELECT fee_date AS date, sum(shown_fee_rmb) AS shown_fee_rmb, sum(actual_fee_sar) AS actual_fee_sar
  FROM mart.et_storage_fee_daily
  GROUP BY fee_date
),
detail_day AS (
  SELECT
    d.fee_date AS date,
    count(*) AS detail_rows,
    sum(coalesce(d.shown_fee_rmb,0)) AS detail_shown_fee_rmb,
    max(f.shown_fee_rmb) AS fee_shown_fee_rmb,
    abs(sum(coalesce(d.shown_fee_rmb,0)) - max(f.shown_fee_rmb)) <= 0.05 AS detail_complete,
    max(f.shown_fee_rmb) / nullif(sum(coalesce(d.shown_fee_rmb,0)),0) AS detail_bill_scale
  FROM fact.et_storage_fee_product_detail d
  JOIN fee_daily f ON f.date = d.fee_date
  GROUP BY d.fee_date
),
box_items AS (
  SELECT
    box_id,
    coalesce(nullif(standard_goods_sn,''), match_key) AS standard_goods_sn,
    coalesce(dim.product_match_key(standard_goods_sn), nullif(match_key,'')) AS match_key,
    sum(coalesce(real_quantity, case_quantity, 0)) AS item_quantity
  FROM fact.et_box_item
  WHERE coalesce(box_id,'') <> ''
    AND coalesce(standard_goods_sn, match_key, '') <> ''
  GROUP BY box_id, coalesce(nullif(standard_goods_sn,''), match_key), coalesce(dim.product_match_key(standard_goods_sn), nullif(match_key,''))
),
box_totals AS (
  SELECT
    box_id,
    sum(coalesce(item_quantity,0)) AS total_item_quantity,
    count(*) AS item_count
  FROM box_items
  GROUP BY box_id
),
detail_expanded AS (
  SELECT
    d.fee_date AS date,
    NULL::date AS source_snapshot_date,
    NULL::text AS stock_snapshot_method,
    CASE
      WHEN bi.box_id IS NOT NULL THEN bi.standard_goods_sn
      ELSE coalesce(nullif(d.standard_goods_sn,''), nullif(d.match_key,''), d.storage_code)
    END AS standard_goods_sn,
    CASE
      WHEN bi.box_id IS NOT NULL THEN bi.match_key
      ELSE coalesce(dim.product_match_key(d.standard_goods_sn), dim.product_match_key(d.storage_code), nullif(d.match_key,''))
    END AS match_key,
    d.warehouse_name,
    CASE WHEN dd.detail_complete THEN 'download_detail' ELSE 'download_detail_scaled_to_bill' END AS storage_allocation_method,
    CASE WHEN bi.box_id IS NOT NULL THEN bi.item_quantity ELSE d.quantity END AS quantity,
    CASE WHEN bi.box_id IS NOT NULL THEN NULL::numeric ELSE d.volume_m3_per_unit END AS volume_m3_per_unit,
    CASE
      WHEN bi.box_id IS NOT NULL AND coalesce(bt.total_item_quantity,0) > 0 THEN d.volume_m3_total * bi.item_quantity / nullif(bt.total_item_quantity,0)
      WHEN bi.box_id IS NOT NULL AND coalesce(bt.item_count,0) > 0 THEN d.volume_m3_total / nullif(bt.item_count,0)
      ELSE d.volume_m3_total
    END AS volume_m3_total,
    d.rate_rmb_per_m3_day,
    CASE
      WHEN bi.box_id IS NOT NULL AND coalesce(bt.total_item_quantity,0) > 0 THEN d.shown_fee_rmb * coalesce(dd.detail_bill_scale,1) * bi.item_quantity / nullif(bt.total_item_quantity,0)
      WHEN bi.box_id IS NOT NULL AND coalesce(bt.item_count,0) > 0 THEN d.shown_fee_rmb * coalesce(dd.detail_bill_scale,1) / nullif(bt.item_count,0)
      ELSE d.shown_fee_rmb * coalesce(dd.detail_bill_scale,1)
    END AS shown_fee_rmb
  FROM fact.et_storage_fee_product_detail d
  JOIN detail_day dd
    ON dd.date = d.fee_date
   AND coalesce(dd.detail_rows,0) > 0
   AND coalesce(dd.detail_shown_fee_rmb,0) <> 0
  LEFT JOIN box_items bi
    ON d.storage_type ILIKE '%整箱%'
   AND bi.box_id = d.storage_code
  LEFT JOIN box_totals bt
    ON bt.box_id = d.storage_code
  WHERE coalesce(d.storage_code,'') <> ''
),
detail_rows AS (
  SELECT
    e.date,
    e.source_snapshot_date,
    e.stock_snapshot_method,
    coalesce(pd.display_standard_goods_sn, e.standard_goods_sn, e.match_key) AS standard_goods_sn,
    e.match_key,
    e.warehouse_name,
    sum(e.quantity) AS quantity,
    max(e.volume_m3_per_unit) AS volume_m3_per_unit,
    sum(e.volume_m3_total) AS volume_m3_total,
    sum(e.volume_m3_total) AS stock_m3_days,
    max(e.rate_rmb_per_m3_day) AS rate_rmb_per_m3_day,
    NULL::numeric AS warehouse_discount,
    sum(e.shown_fee_rmb) AS shown_fee_rmb,
    sum(e.shown_fee_rmb) * max(p.billing_discount) AS actual_fee_rmb,
    sum(e.shown_fee_rmb) * max(p.billing_discount) / nullif(max(p.sar_to_rmb),0) AS actual_allocated_fee_sar,
    e.storage_allocation_method::text AS storage_allocation_method
  FROM detail_expanded e
  CROSS JOIN policy p
  LEFT JOIN mart.product_display_by_match_key pd
    ON pd.match_key = e.match_key
  WHERE coalesce(e.standard_goods_sn, e.match_key, '') <> ''
  GROUP BY e.date, e.source_snapshot_date, e.stock_snapshot_method, coalesce(pd.display_standard_goods_sn, e.standard_goods_sn, e.match_key), e.match_key, e.warehouse_name, e.storage_allocation_method
),
fallback_rows AS (
  SELECT
    e.date,
    e.source_snapshot_date,
    e.stock_snapshot_method,
    coalesce(pd.display_standard_goods_sn, e.standard_goods_sn, e.match_key) AS standard_goods_sn,
    e.match_key,
    e.warehouse_name,
    e.quantity,
    e.volume_m3_per_unit,
    e.volume_m3_total,
    e.stock_m3_days,
    e.rate_rmb_per_m3_day,
    e.warehouse_discount,
    NULL::numeric AS shown_fee_rmb,
    NULL::numeric AS actual_fee_rmb,
    e.actual_allocated_fee_sar,
    e.storage_allocation_method
  FROM mart.storage_fee_product_daily_estimated e
  LEFT JOIN mart.product_display_by_match_key pd
    ON pd.match_key = e.match_key
  LEFT JOIN detail_day d
    ON d.date = e.date
   AND coalesce(d.detail_rows,0) > 0
   AND coalesce(d.detail_shown_fee_rmb,0) <> 0
  WHERE d.date IS NULL
)
SELECT * FROM detail_rows
UNION ALL
SELECT * FROM fallback_rows;

CREATE OR REPLACE VIEW mart.storage_fee_product_store_daily AS
WITH product_fee AS (
  SELECT
    date,
    coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn)) AS match_key,
    max(standard_goods_sn) AS standard_goods_sn,
    sum(actual_allocated_fee_sar) AS product_storage_fee_sar,
    string_agg(DISTINCT storage_allocation_method, ' / ') AS storage_fee_method
  FROM mart.storage_fee_product_daily
  GROUP BY date, coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn))
),
store_product_sales AS (
  SELECT
    created_date::date AS date,
    store_key,
    group_key,
    standard_goods_sn,
    dim.product_match_key(standard_goods_sn) AS match_key,
    sum(net_revenue_sar) FILTER (WHERE NOT cost_missing) AS known_net_revenue_sar,
    sum(quantity) AS quantity
  FROM mart.profit_order_item
  WHERE coalesce(standard_goods_sn,'') <> ''
  GROUP BY created_date::date, store_key, group_key, standard_goods_sn, dim.product_match_key(standard_goods_sn)
),
product_day_sales AS (
  SELECT
    date,
    match_key,
    sum(coalesce(known_net_revenue_sar,0)) AS product_known_net_revenue_sar,
    sum(coalesce(quantity,0)) AS product_quantity
  FROM store_product_sales
  GROUP BY date, match_key
)
SELECT
  s.date,
  s.store_key,
  s.group_key,
  s.standard_goods_sn,
  f.product_storage_fee_sar * CASE
    WHEN coalesce(t.product_known_net_revenue_sar,0) > 0 THEN coalesce(s.known_net_revenue_sar,0) / nullif(t.product_known_net_revenue_sar,0)
    WHEN coalesce(t.product_quantity,0) > 0 THEN coalesce(s.quantity,0) / nullif(t.product_quantity,0)
    ELSE 0
  END AS storage_fee_sar,
  f.storage_fee_method || ':store_product_sales_bridge' AS storage_fee_method
FROM store_product_sales s
JOIN product_fee f
  ON f.date = s.date
 AND f.match_key = s.match_key
JOIN product_day_sales t
  ON t.date = s.date
 AND t.match_key = s.match_key;

CREATE OR REPLACE VIEW mart.storage_fee_daily_reconciliation AS
WITH fee AS (
  SELECT
    fee_date,
    sum(shown_fee_rmb) AS shown_fee_rmb,
    sum(actual_fee_rmb) AS actual_fee_rmb,
    sum(actual_fee_sar) AS actual_fee_sar
  FROM mart.et_storage_fee_daily
  GROUP BY fee_date
),
store_alloc AS (
  SELECT date AS fee_date, sum(allocated_storage_fee_sar) AS store_allocated_fee_sar
  FROM mart.storage_fee_store_daily
  GROUP BY date
),
product_alloc AS (
  SELECT date AS fee_date, sum(actual_allocated_fee_sar) AS product_allocated_fee_sar
  FROM mart.storage_fee_product_daily
  GROUP BY date
)
SELECT
  f.fee_date,
  f.shown_fee_rmb,
  f.actual_fee_rmb,
  f.actual_fee_sar,
  coalesce(sa.store_allocated_fee_sar,0) AS store_allocated_fee_sar,
  coalesce(pa.product_allocated_fee_sar,0) AS product_allocated_fee_sar,
  f.actual_fee_sar - coalesce(sa.store_allocated_fee_sar,0) AS store_allocation_delta_sar,
  f.actual_fee_sar - coalesce(pa.product_allocated_fee_sar,0) AS product_allocation_delta_sar
FROM fee f
LEFT JOIN store_alloc sa ON sa.fee_date = f.fee_date
LEFT JOIN product_alloc pa ON pa.fee_date = f.fee_date;

CREATE OR REPLACE VIEW mart.profit_daily_store_product AS
WITH base AS (
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
    sum(rtv_recoverable_cost_sar) FILTER (WHERE NOT cost_missing) AS rtv_recoverable_cost_sar,
    sum(rtv_09_recoverable_cost_sar) FILTER (WHERE NOT cost_missing) AS rtv_09_recoverable_cost_sar,
    sum(rtv_received_quantity) AS rtv_received_quantity,
    sum(rtv_received_to_09_quantity) AS rtv_received_to_09_quantity,
    sum(profit_before_storage_sar) FILTER (WHERE NOT cost_missing) AS profit_before_storage_sar,
    sum(profit_if_rtv_received_resellable_sar) FILTER (WHERE NOT cost_missing) AS profit_if_rtv_received_resellable_sar,
    sum(profit_if_rtv_09_resellable_sar) FILTER (WHERE NOT cost_missing) AS profit_if_rtv_09_resellable_sar,
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
  GROUP BY created_date, store_key, group_key, standard_goods_sn
),
storage AS (
  SELECT
    date,
    store_key,
    group_key,
    dim.product_match_key(standard_goods_sn) AS match_key,
    sum(storage_fee_sar) AS storage_fee_sar,
    string_agg(DISTINCT storage_fee_method, ' / ') AS storage_fee_method
  FROM mart.storage_fee_product_store_daily
  GROUP BY date, store_key, group_key, dim.product_match_key(standard_goods_sn)
)
SELECT
  b.*,
  coalesce(s.storage_fee_sar,0) AS storage_fee_sar,
  b.profit_before_storage_sar - coalesce(s.storage_fee_sar,0) AS profit_after_storage_sar,
  CASE
    WHEN b.known_net_revenue_sar > 0
    THEN (b.profit_before_storage_sar - coalesce(s.storage_fee_sar,0)) / nullif(b.known_net_revenue_sar,0)
    ELSE NULL
  END AS profit_margin_after_storage,
  b.profit_if_rtv_received_resellable_sar - coalesce(s.storage_fee_sar,0) AS profit_if_rtv_received_resellable_after_storage_sar,
  b.profit_if_rtv_09_resellable_sar - coalesce(s.storage_fee_sar,0) AS profit_if_rtv_09_resellable_after_storage_sar,
  coalesce(s.storage_fee_method,'none') AS storage_fee_method
FROM base b
LEFT JOIN storage s
  ON s.date = b.date
 AND s.store_key = b.store_key
 AND s.group_key = b.group_key
 AND s.match_key = dim.product_match_key(b.standard_goods_sn);

CREATE OR REPLACE VIEW mart.profit_month_group AS
WITH group_month AS (
  SELECT
    month_start,
    group_key,
    sum(gross_revenue_sar) AS gross_revenue_sar,
    sum(net_revenue_sar) AS net_revenue_sar,
    sum(product_cost_sar) FILTER (WHERE NOT cost_missing) AS product_cost_sar,
    sum(return_delivery_fee_sar) AS return_delivery_fee_sar,
    sum(rtv_recoverable_cost_sar) FILTER (WHERE NOT cost_missing) AS rtv_recoverable_cost_sar,
    sum(rtv_09_recoverable_cost_sar) FILTER (WHERE NOT cost_missing) AS rtv_09_recoverable_cost_sar,
    sum(rtv_received_quantity) AS rtv_received_quantity,
    sum(rtv_received_to_09_quantity) AS rtv_received_to_09_quantity,
    sum(profit_before_storage_sar) FILTER (WHERE NOT cost_missing) AS profit_before_storage_sar,
    sum(profit_if_rtv_received_resellable_sar) FILTER (WHERE NOT cost_missing) AS profit_if_rtv_received_resellable_sar,
    sum(profit_if_rtv_09_resellable_sar) FILTER (WHERE NOT cost_missing) AS profit_if_rtv_09_resellable_sar,
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
),
storage_group_month AS (
  SELECT
    date_trunc('month', date)::date AS month_start,
    group_key,
    sum(allocated_storage_fee_sar) AS allocated_storage_fee_sar,
    string_agg(DISTINCT allocation_method, ' / ') AS storage_fee_method
  FROM mart.storage_fee_store_daily
  GROUP BY date_trunc('month', date)::date, group_key
),
storage_month_total AS (
  SELECT
    date_trunc('month', fee_date)::date AS month_start,
    sum(actual_fee_sar) AS total_storage_fee_sar
  FROM mart.et_storage_fee_daily
  GROUP BY date_trunc('month', fee_date)::date
)
SELECT
  g.month_start,
  g.group_key,
  g.gross_revenue_sar,
  g.net_revenue_sar,
  g.product_cost_sar,
  g.return_delivery_fee_sar,
  g.rtv_recoverable_cost_sar,
  g.rtv_09_recoverable_cost_sar,
  g.rtv_received_quantity,
  g.rtv_received_to_09_quantity,
  g.profit_before_storage_sar,
  g.profit_if_rtv_received_resellable_sar,
  g.profit_if_rtv_09_resellable_sar,
  g.known_gross_revenue_sar,
  g.missing_cost_revenue_sar,
  g.missing_cost_lines,
  g.reversal_lines,
  coalesce(smt.total_storage_fee_sar,0) AS month_storage_fee_sar,
  coalesce(sgm.allocated_storage_fee_sar,0) AS allocated_storage_fee_sar,
  g.profit_before_storage_sar
    - coalesce(sgm.allocated_storage_fee_sar,0) AS profit_after_storage_sar,
  g.profit_if_rtv_received_resellable_sar
    - coalesce(sgm.allocated_storage_fee_sar,0) AS profit_if_rtv_received_resellable_after_storage_sar,
  g.profit_if_rtv_09_resellable_sar
    - coalesce(sgm.allocated_storage_fee_sar,0) AS profit_if_rtv_09_resellable_after_storage_sar,
  CASE
    WHEN g.net_revenue_sar > 0
    THEN (
      g.profit_before_storage_sar
      - coalesce(sgm.allocated_storage_fee_sar,0)
    ) / nullif(g.net_revenue_sar,0)
    ELSE NULL
  END AS profit_margin_after_storage,
  CASE
    WHEN g.gross_revenue_sar > 0 THEN g.known_gross_revenue_sar / nullif(g.gross_revenue_sar,0)
    ELSE NULL
  END AS cost_coverage_revenue_rate
FROM group_month g
JOIN month_total mt ON mt.month_start = g.month_start
LEFT JOIN storage_group_month sgm
  ON sgm.month_start = g.month_start
 AND sgm.group_key = g.group_key
LEFT JOIN storage_month_total smt ON smt.month_start = g.month_start;

CREATE OR REPLACE VIEW mart.profit_product_summary AS
SELECT
  p.standard_goods_sn,
  sum(p.gross_revenue_sar) AS gross_revenue_sar,
  sum(p.net_revenue_sar) AS net_revenue_sar,
  sum(p.quantity) AS quantity,
  sum(p.product_cost_sar) AS product_cost_sar,
  sum(p.return_delivery_fee_sar) AS return_delivery_fee_sar,
  sum(p.rtv_recoverable_cost_sar) AS rtv_recoverable_cost_sar,
  sum(p.rtv_09_recoverable_cost_sar) AS rtv_09_recoverable_cost_sar,
  sum(p.rtv_received_quantity) AS rtv_received_quantity,
  sum(p.rtv_received_to_09_quantity) AS rtv_received_to_09_quantity,
  sum(p.profit_before_storage_sar) AS profit_before_storage_sar,
  sum(p.profit_if_rtv_received_resellable_sar) AS profit_if_rtv_received_resellable_sar,
  sum(p.profit_if_rtv_09_resellable_sar) AS profit_if_rtv_09_resellable_sar,
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
  END AS cost_coverage_revenue_rate,
  coalesce(max(ps.storage_fee_sar),0) AS storage_fee_sar,
  sum(p.profit_before_storage_sar) - coalesce(max(ps.storage_fee_sar),0) AS profit_after_storage_sar,
  CASE
    WHEN sum(p.net_revenue_sar) FILTER (WHERE p.missing_cost_lines = 0) > 0
    THEN (sum(p.profit_before_storage_sar) - coalesce(max(ps.storage_fee_sar),0)) / nullif(sum(p.known_net_revenue_sar),0)
    ELSE NULL
  END AS profit_margin_after_storage,
  sum(p.profit_if_rtv_received_resellable_sar) - coalesce(max(ps.storage_fee_sar),0) AS profit_if_rtv_received_resellable_after_storage_sar,
  sum(p.profit_if_rtv_09_resellable_sar) - coalesce(max(ps.storage_fee_sar),0) AS profit_if_rtv_09_resellable_after_storage_sar,
  coalesce(max(ps.storage_fee_method),'none') AS storage_fee_method,
  coalesce(max(ps.storage_fee_days),0) AS storage_fee_days,
  max(ps.storage_source_snapshot_min) AS storage_source_snapshot_min,
  max(ps.storage_source_snapshot_max) AS storage_source_snapshot_max
FROM mart.profit_daily_store_product p
LEFT JOIN mart.product_unit_cost_by_match_key c
  ON c.match_key <> ''
 AND c.match_key = dim.product_match_key(p.standard_goods_sn)
LEFT JOIN (
  SELECT
    coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn)) AS match_key,
    sum(actual_allocated_fee_sar) AS storage_fee_sar,
    string_agg(DISTINCT storage_allocation_method, ' / ') AS storage_fee_method,
    count(DISTINCT date) AS storage_fee_days,
    min(source_snapshot_date) AS storage_source_snapshot_min,
    max(source_snapshot_date) AS storage_source_snapshot_max
  FROM mart.storage_fee_product_daily
  GROUP BY coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn))
) ps
  ON ps.match_key <> ''
 AND ps.match_key = dim.product_match_key(p.standard_goods_sn)
GROUP BY p.standard_goods_sn;

CREATE OR REPLACE VIEW mart.inventory_depletion_product_current AS
WITH sales_anchor AS (
  SELECT max(created_date)::date AS max_date FROM mart.profit_order_item
),
batch_base AS (
  SELECT
    dim.product_match_key(standard_goods_sn) AS match_key,
    standard_goods_sn,
    raw_goods_sn,
    nullif(raw_summary->>'希音标准名','') AS cost_product_name,
    batch_no,
    shipped_date,
    arrived_date,
    coalesce(shipped_quantity,0) AS shipped_quantity,
    goods_cost_amount,
    first_leg_freight_amount,
    other_cost_amount,
    cost_sar,
    unit_cost_sar,
    purchase_unit_price,
    complete_batch,
    ignored_reason,
    source_file,
    source_sheet,
    source_row_no,
    raw_summary,
    (
      coalesce(shipped_quantity,0) > 0
      AND arrived_date IS NOT NULL
      AND first_leg_freight_amount IS NOT NULL
    ) AS is_arrived_stock,
    (
      coalesce(shipped_quantity,0) > 0
      AND shipped_date IS NOT NULL
      AND NOT (
        arrived_date IS NOT NULL
        AND first_leg_freight_amount IS NOT NULL
      )
    ) AS is_incoming_stock,
    (
      coalesce(shipped_quantity,0) > 0
      AND shipped_date IS NULL
    ) AS is_not_shipped_stock
  FROM fact.product_cost_batch
  WHERE coalesce(dim.product_match_key(standard_goods_sn),'') <> ''
),
batch_agg AS (
  SELECT
    match_key,
    string_agg(DISTINCT standard_goods_sn, ' / ' ORDER BY standard_goods_sn) AS cost_standard_goods_sn_list,
    string_agg(DISTINCT raw_goods_sn, ' / ' ORDER BY raw_goods_sn) FILTER (WHERE coalesce(raw_goods_sn,'') <> '') AS raw_goods_sn_list,
    max(cost_product_name) FILTER (WHERE cost_product_name IS NOT NULL) AS cost_product_name,
    count(*) AS batch_count,
    count(*) FILTER (WHERE is_arrived_stock) AS arrived_batch_count,
    count(*) FILTER (WHERE is_incoming_stock) AS incoming_batch_count,
    count(*) FILTER (WHERE is_not_shipped_stock) AS not_shipped_batch_count,
    sum(shipped_quantity) FILTER (WHERE is_arrived_stock) AS arrived_quantity,
    sum(shipped_quantity) FILTER (WHERE is_incoming_stock) AS incoming_quantity,
    sum(shipped_quantity) FILTER (WHERE is_not_shipped_stock) AS not_shipped_quantity,
    sum(coalesce(cost_sar,0)) FILTER (WHERE is_arrived_stock AND complete_batch) AS arrived_cost_sar,
    min(shipped_date) FILTER (WHERE shipped_date IS NOT NULL) AS first_shipped_date,
    max(shipped_date) FILTER (WHERE shipped_date IS NOT NULL) AS latest_shipped_date,
    min(arrived_date) FILTER (WHERE arrived_date IS NOT NULL) AS first_arrived_date,
    max(arrived_date) FILTER (WHERE arrived_date IS NOT NULL) AS latest_arrived_date,
    string_agg(DISTINCT ignored_reason, ' / ') FILTER (WHERE coalesce(ignored_reason,'') <> '') AS ignored_reasons
  FROM batch_base
  GROUP BY match_key
),
sales_base AS (
  SELECT
    dim.product_match_key(standard_goods_sn) AS match_key,
    standard_goods_sn,
    goods_title,
    created_date::date AS date,
    CASE WHEN coalesce(gross_revenue_sar,0) > 0 THEN coalesce(quantity,0) ELSE 0 END AS gross_quantity,
    CASE WHEN coalesce(net_revenue_sar,0) > 0 THEN coalesce(quantity,0) ELSE 0 END AS net_quantity,
    coalesce(gross_revenue_sar,0) AS gross_revenue_sar,
    coalesce(net_revenue_sar,0) AS net_revenue_sar,
    coalesce(revenue_reversal,false) AS revenue_reversal
  FROM mart.profit_order_item
  WHERE coalesce(dim.product_match_key(standard_goods_sn),'') <> ''
),
sales_agg AS (
  SELECT
    match_key,
    string_agg(DISTINCT standard_goods_sn, ' / ' ORDER BY standard_goods_sn) AS sales_standard_goods_sn_list,
    max(goods_title) FILTER (WHERE coalesce(goods_title,'') <> '') AS sales_product_name,
    sum(gross_quantity) AS gross_sold_quantity,
    sum(net_quantity) AS net_sold_quantity,
    sum(gross_revenue_sar) AS gross_revenue_sar,
    sum(net_revenue_sar) AS net_revenue_sar,
    sum(gross_quantity) FILTER (WHERE revenue_reversal) AS reversal_quantity,
    count(*) FILTER (WHERE revenue_reversal) AS reversal_lines,
    sum(gross_quantity) FILTER (WHERE date >= (SELECT max_date FROM sales_anchor) - interval '6 days') AS gross_sold_7d,
    sum(gross_quantity) FILTER (WHERE date >= (SELECT max_date FROM sales_anchor) - interval '13 days') AS gross_sold_14d,
    sum(gross_quantity) FILTER (WHERE date >= (SELECT max_date FROM sales_anchor) - interval '29 days') AS gross_sold_30d,
    max(date) FILTER (WHERE gross_quantity > 0) AS last_sale_date,
    min(date) FILTER (WHERE gross_quantity > 0) AS first_sale_date
  FROM sales_base
  GROUP BY match_key
),
keys AS (
  SELECT match_key FROM batch_agg
  UNION
  SELECT match_key FROM sales_agg
)
SELECT
  dim.product_canonical_sn(coalesce(nullif(split_part(b.cost_standard_goods_sn_list, ' / ', 1), ''), nullif(split_part(s.sales_standard_goods_sn_list, ' / ', 1), ''), k.match_key)) AS standard_goods_sn,
  k.match_key,
  coalesce(b.cost_standard_goods_sn_list, s.sales_standard_goods_sn_list) AS standard_goods_sn_list,
  b.raw_goods_sn_list,
  coalesce(b.cost_product_name, s.sales_product_name, '') AS goods_title,
  coalesce(b.batch_count,0)::bigint AS batch_count,
  coalesce(b.arrived_batch_count,0)::bigint AS arrived_batch_count,
  coalesce(b.incoming_batch_count,0)::bigint AS incoming_batch_count,
  coalesce(b.not_shipped_batch_count,0)::bigint AS not_shipped_batch_count,
  coalesce(b.arrived_quantity,0) AS arrived_quantity,
  coalesce(b.incoming_quantity,0) AS incoming_quantity,
  coalesce(b.not_shipped_quantity,0) AS not_shipped_quantity,
  coalesce(s.gross_sold_quantity,0) AS gross_sold_quantity,
  coalesce(s.net_sold_quantity,0) AS net_sold_quantity,
  coalesce(s.reversal_quantity,0) AS reversal_quantity,
  coalesce(s.reversal_lines,0)::bigint AS reversal_lines,
  greatest(coalesce(b.arrived_quantity,0) - coalesce(s.gross_sold_quantity,0), 0) AS estimated_on_hand_quantity,
  greatest(coalesce(b.arrived_quantity,0) + coalesce(b.incoming_quantity,0) - coalesce(s.gross_sold_quantity,0), 0) AS estimated_total_supply_quantity,
  greatest(coalesce(s.gross_sold_quantity,0) - coalesce(b.arrived_quantity,0), 0) AS oversold_or_missing_batch_quantity,
  CASE WHEN coalesce(b.arrived_quantity,0) > 0 THEN coalesce(s.gross_sold_quantity,0) / nullif(b.arrived_quantity,0) ELSE NULL END AS depletion_rate,
  coalesce(s.gross_sold_7d,0) AS gross_sold_7d,
  coalesce(s.gross_sold_14d,0) AS gross_sold_14d,
  coalesce(s.gross_sold_30d,0) AS gross_sold_30d,
    (0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)) AS weighted_daily_gross_sales,
  CASE
    WHEN (0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)) > 0
    THEN greatest(coalesce(b.arrived_quantity,0) - coalesce(s.gross_sold_quantity,0), 0)
      / nullif((0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)),0)
    ELSE NULL
  END AS days_of_supply_on_hand,
  CASE
    WHEN (0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)) > 0
    THEN greatest(coalesce(b.arrived_quantity,0) + coalesce(b.incoming_quantity,0) - coalesce(s.gross_sold_quantity,0), 0)
      / nullif((0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)),0)
    ELSE NULL
  END AS days_of_supply_with_incoming,
  s.last_sale_date,
  s.first_sale_date,
  b.first_shipped_date,
  b.latest_shipped_date,
  b.first_arrived_date,
  b.latest_arrived_date,
  round(coalesce(b.arrived_cost_sar,0)::numeric, 2) AS arrived_cost_sar,
  c.unit_cost_sar,
  c.avg_purchase_unit_price,
  c.avg_volume_l,
  c.avg_weight_kg,
  b.ignored_reasons,
  CASE
    WHEN coalesce(b.arrived_quantity,0) = 0 AND coalesce(s.gross_sold_quantity,0) > 0 THEN '成本表缺到仓批次'
    WHEN coalesce(b.arrived_quantity,0) = 0 AND coalesce(b.incoming_quantity,0) > 0 THEN '在途未到仓'
    WHEN coalesce(b.arrived_quantity,0) = 0 AND coalesce(b.not_shipped_quantity,0) > 0 THEN '未发/待确认'
    WHEN greatest(coalesce(b.arrived_quantity,0) - coalesce(s.gross_sold_quantity,0), 0) = 0 AND coalesce(b.incoming_quantity,0) > 0 THEN '等补货/在途承接'
    WHEN greatest(coalesce(b.arrived_quantity,0) - coalesce(s.gross_sold_quantity,0), 0) = 0 AND coalesce(s.gross_sold_quantity,0) > 0 THEN '已售罄/疑似缺货'
    WHEN coalesce(s.gross_sold_30d,0) = 0 AND greatest(coalesce(b.arrived_quantity,0) - coalesce(s.gross_sold_quantity,0), 0) > 0 THEN '低动销库存'
    WHEN (0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)) > 0
      AND greatest(coalesce(b.arrived_quantity,0) - coalesce(s.gross_sold_quantity,0), 0)
        / nullif((0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)),0) <= 14 THEN '14天内断货'
    WHEN (0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)) > 0
      AND greatest(coalesce(b.arrived_quantity,0) - coalesce(s.gross_sold_quantity,0), 0)
        / nullif((0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)),0) <= 30 THEN '30天内需补货'
    WHEN (0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)) > 0
      AND greatest(coalesce(b.arrived_quantity,0) - coalesce(s.gross_sold_quantity,0), 0)
        / nullif((0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)),0) > 120 THEN '库存偏慢'
    ELSE '健康'
  END AS stock_status,
  CASE
    WHEN coalesce(b.arrived_quantity,0) = 0 AND coalesce(s.gross_sold_quantity,0) > 0 THEN 'high'
    WHEN coalesce(b.arrived_quantity,0) = 0 AND coalesce(b.incoming_quantity,0) > 0 THEN 'mid'
    WHEN greatest(coalesce(b.arrived_quantity,0) - coalesce(s.gross_sold_quantity,0), 0) = 0 AND coalesce(s.gross_sold_quantity,0) > 0 THEN 'high'
    WHEN coalesce(s.gross_sold_30d,0) = 0 AND greatest(coalesce(b.arrived_quantity,0) - coalesce(s.gross_sold_quantity,0), 0) > 0 THEN 'mid'
    WHEN (0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)) > 0
      AND greatest(coalesce(b.arrived_quantity,0) - coalesce(s.gross_sold_quantity,0), 0)
        / nullif((0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)),0) <= 14 THEN 'high'
    WHEN (0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)) > 0
      AND greatest(coalesce(b.arrived_quantity,0) - coalesce(s.gross_sold_quantity,0), 0)
        / nullif((0.7 * (coalesce(s.gross_sold_7d,0) / 7.0) + 0.3 * (coalesce(s.gross_sold_30d,0) / 30.0)),0) <= 30 THEN 'mid'
    ELSE 'low'
  END AS risk_level
FROM keys k
LEFT JOIN batch_agg b USING (match_key)
LEFT JOIN sales_agg s USING (match_key)
LEFT JOIN mart.product_unit_cost_by_match_key c USING (match_key);

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
latest_coverage AS (
  SELECT max(date) AS max_date FROM fact.product_store_coverage
),
latest_store_coverage AS (
  SELECT store_key, max(date) AS date
  FROM fact.product_store_coverage
  WHERE date >= (SELECT max_date FROM latest_coverage) - interval '3 days'
  GROUP BY store_key
),
sales AS (
  SELECT
    store_key,
    dim.product_canonical_sn(standard_goods_sn) AS standard_goods_sn,
    sum(sales_sar) AS sales_sar,
    sum(quantity) AS quantity,
    count(DISTINCT order_key) AS order_count
  FROM fact.order_item
  WHERE created_date = (SELECT date FROM latest_sales)
    AND coalesce(standard_goods_sn,'') <> ''
  GROUP BY store_key, dim.product_canonical_sn(standard_goods_sn)
),
actions AS (
  SELECT
    store_key,
    dim.product_canonical_sn(standard_goods_sn) AS standard_goods_sn,
    count(*) AS action_count,
    count(*) FILTER (WHERE focus) AS focus_action_count,
    max(score) AS max_action_score
  FROM mart.link_action_candidate
  WHERE date = (SELECT max_date FROM latest_coverage)
    AND coalesce(standard_goods_sn,'') <> ''
  GROUP BY store_key, dim.product_canonical_sn(standard_goods_sn)
),
coverage AS (
  SELECT
    c.date AS link_date,
    (SELECT date FROM latest_sales) AS sales_date,
    c.group_key,
    c.store_key,
    max(c.shop_name) FILTER (WHERE coalesce(c.shop_name,'') <> '') AS shop_name,
    dim.product_canonical_sn(c.standard_goods_sn) AS standard_goods_sn,
    coalesce(
      max(c.coverage_status) FILTER (WHERE coalesce(c.has_on_shelf_link,false)),
      max(c.coverage_status) FILTER (WHERE coalesce(c.need_supplement_link,false)),
      max(c.coverage_status)
    ) AS coverage_status,
    bool_or(coalesce(c.has_on_shelf_link,false)) AS has_on_shelf_link,
    bool_or(coalesce(c.need_supplement_link,false)) AS need_supplement_link,
    sum(coalesce(c.link_count,0))::integer AS link_count,
    sum(coalesce(c.on_shelf_count,0))::integer AS on_shelf_count,
    sum(coalesce(c.wait_shelf_count,0))::integer AS wait_shelf_count,
    sum(coalesce(c.sold_out_count,0))::integer AS sold_out_count,
    sum(coalesce(c.out_shelf_count,0))::integer AS out_shelf_count,
    bool_or(coalesce(c.duplicate_on_shelf,false)) AS duplicate_on_shelf,
    max(c.best_skc) FILTER (WHERE coalesce(c.best_skc,'') <> '') AS best_skc,
    max(coalesce(c.best_link_c30_sale,0)) AS best_link_c30_sale,
    string_agg(DISTINCT nullif(c.skc_list,''), ' ') FILTER (WHERE nullif(c.skc_list,'') IS NOT NULL) AS skc_list
  FROM fact.product_store_coverage c
  JOIN latest_store_coverage lsc
    ON lsc.store_key = c.store_key AND lsc.date = c.date
  WHERE coalesce(dim.product_canonical_sn(c.standard_goods_sn),'') <> ''
  GROUP BY c.date, c.group_key, c.store_key, dim.product_canonical_sn(c.standard_goods_sn)
)
SELECT
  c.link_date,
  c.sales_date,
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
FROM coverage c
LEFT JOIN sales s
  ON s.store_key = c.store_key AND s.standard_goods_sn = c.standard_goods_sn
LEFT JOIN actions a
  ON a.store_key = c.store_key AND a.standard_goods_sn = c.standard_goods_sn
;

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
    dim.product_canonical_sn(standard_goods_sn) AS standard_goods_sn,
    count(*) FILTER (WHERE is_on_shelf) AS on_shelf_count
  FROM fact.link_master_snapshot
  WHERE snapshot_date = (SELECT date FROM latest_link)
    AND coalesce(is_hard_dead,false) = false
    AND coalesce(standard_goods_sn,'') <> ''
  GROUP BY store_key, dim.product_canonical_sn(standard_goods_sn)
)
SELECT
  l.snapshot_date AS link_date,
  l.group_key,
  l.store_key,
  l.shop_name,
  dim.product_canonical_sn(l.standard_goods_sn) AS standard_goods_sn,
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
  ON sp.store_key = l.store_key AND sp.standard_goods_sn = dim.product_canonical_sn(l.standard_goods_sn)
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
sales AS (
  SELECT
    dim.product_canonical_sn(standard_goods_sn) AS standard_goods_sn,
    sum(sales_sar) AS sales_sar,
    sum(quantity) AS quantity,
    count(DISTINCT order_key) AS order_count,
    count(DISTINCT store_key) AS sale_store_count
  FROM fact.order_item
  WHERE created_date = (SELECT max(created_date) FROM fact.order_item)
    AND coalesce(standard_goods_sn,'') <> ''
  GROUP BY dim.product_canonical_sn(standard_goods_sn)
),
coverage AS (
  SELECT
    standard_goods_sn,
    count(*) FILTER (WHERE has_on_shelf_link) AS on_shelf_store_count,
    count(*) FILTER (WHERE need_supplement_link) AS missing_store_count,
    sum(on_shelf_count) AS on_shelf_link_count,
    sum(wait_shelf_count) AS wait_shelf_link_count,
    sum(sold_out_count) AS sold_out_link_count,
    min(link_date) AS min_link_date,
    max(link_date) AS max_link_date,
    count(DISTINCT store_key) AS coverage_store_count
  FROM mart.bi_store_product_matrix_current
  GROUP BY standard_goods_sn
),
inventory AS (
  SELECT
    dim.product_canonical_sn(standard_goods_sn) AS standard_goods_sn,
    sum(coalesce(usable_inventory,0)) AS usable_inventory,
    sum(coalesce(inventory_quantity,0)) AS display_inventory,
    count(*) FILTER (WHERE display_stock_low AND coalesce(shelf_statuses,'') LIKE '%ON_SHELF%') AS low_display_stock_count
  FROM fact.visible_inventory_snapshot
  WHERE snapshot_date = (SELECT date FROM latest_business)
    AND coalesce(standard_goods_sn,'') <> ''
  GROUP BY dim.product_canonical_sn(standard_goods_sn)
),
quality AS (
  SELECT
    dim.product_canonical_sn(standard_goods_sn) AS standard_goods_sn,
    count(*) AS quality_skc_count,
    sum(coalesce(return_volume,0)) AS return_volume,
    sum(coalesce(quality_return_volume,0)) AS quality_return_volume,
    avg(quality_return_rate) AS avg_quality_return_rate,
    avg(show_bad_eval_rate) AS avg_bad_eval_rate
  FROM fact.quality_skc_snapshot
  WHERE snapshot_date = (SELECT date FROM latest_business)
    AND coalesce(standard_goods_sn,'') <> ''
  GROUP BY dim.product_canonical_sn(standard_goods_sn)
),
after_sales AS (
  SELECT
    dim.product_canonical_sn(standard_goods_sn) AS standard_goods_sn,
    count(DISTINCT aftersales_order_no) AS after_sales_case_count,
    sum(coalesce(price_amount,0)) AS after_sales_amount_sar,
    string_agg(DISTINCT reason_names, ' / ') AS after_sales_reasons
  FROM fact.after_sales_item
  WHERE snapshot_date = (SELECT date FROM latest_business)
    AND coalesce(standard_goods_sn,'') <> ''
  GROUP BY dim.product_canonical_sn(standard_goods_sn)
),
comments AS (
  SELECT
    dim.product_canonical_sn(standard_goods_sn) AS standard_goods_sn,
    count(*) AS comment_count,
    count(*) FILTER (WHERE goods_comment_star <= 3) AS low_star_comment_count,
    avg(goods_comment_star) AS avg_comment_star
  FROM fact.product_comment
  WHERE comment_date >= ((SELECT date FROM latest_business) - 90)
    AND coalesce(standard_goods_sn,'') <> ''
  GROUP BY dim.product_canonical_sn(standard_goods_sn)
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
    dim.product_canonical_sn(standard_goods_sn) AS standard_goods_sn,
    max(skc) AS skc,
    count(DISTINCT aftersales_order_no) AS case_count,
    sum(coalesce(price_amount, 0)) AS amount_sar,
    string_agg(DISTINCT nullif(reason_names, ''), ' / ') AS reasons,
    string_agg(DISTINCT nullif(order_sub_status_name, ''), ' / ') AS statuses
  FROM fact.after_sales_item
  WHERE snapshot_date = (SELECT date FROM latest_after_sales)
    AND coalesce(standard_goods_sn, '') <> ''
  GROUP BY snapshot_date, store_key, group_key, dim.product_canonical_sn(standard_goods_sn)
),
link_sales_group AS (
  SELECT
    store_key,
    dim.product_canonical_sn(standard_goods_sn) AS standard_goods_sn,
    sum(coalesce(c30_sale_cnt,0)) AS c30_sale_cnt
  FROM fact.link_performance_daily
  WHERE date = (SELECT date FROM latest_link_perf)
    AND coalesce(standard_goods_sn, '') <> ''
  GROUP BY store_key, dim.product_canonical_sn(standard_goods_sn)
),
order_sales_30 AS (
  SELECT
    store_key,
    dim.product_canonical_sn(standard_goods_sn) AS standard_goods_sn,
    sum(coalesce(quantity,0)) AS order_qty_30
  FROM fact.order_item
  WHERE created_date >= ((SELECT date FROM latest_inventory) - 30)
    AND coalesce(standard_goods_sn, '') <> ''
  GROUP BY store_key, dim.product_canonical_sn(standard_goods_sn)
),
coverage_latest AS (
  SELECT
    store_key,
    dim.product_canonical_sn(standard_goods_sn) AS standard_goods_sn,
    max(CASE WHEN coalesce(has_on_shelf_link,false) THEN 1 ELSE 0 END) AS has_on_shelf_link,
    max(coalesce(on_shelf_count,0)) AS on_shelf_count
  FROM fact.product_store_coverage
  WHERE date = (SELECT date FROM latest_coverage)
    AND coalesce(standard_goods_sn, '') <> ''
  GROUP BY store_key, dim.product_canonical_sn(standard_goods_sn)
),
inventory_group AS (
  SELECT
    i.snapshot_date AS date,
    i.store_key,
    i.group_key,
    dim.product_canonical_sn(i.standard_goods_sn) AS standard_goods_sn,
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
  LEFT JOIN link_sales_group ls ON ls.store_key = i.store_key AND ls.standard_goods_sn = dim.product_canonical_sn(i.standard_goods_sn)
  LEFT JOIN order_sales_30 os ON os.store_key = i.store_key AND os.standard_goods_sn = dim.product_canonical_sn(i.standard_goods_sn)
  LEFT JOIN coverage_latest c ON c.store_key = i.store_key AND c.standard_goods_sn = dim.product_canonical_sn(i.standard_goods_sn)
  WHERE i.snapshot_date = (SELECT date FROM latest_inventory)
    AND i.display_stock_low
    AND coalesce(i.standard_goods_sn, '') <> ''
  GROUP BY i.snapshot_date, i.store_key, i.group_key, dim.product_canonical_sn(i.standard_goods_sn)
  HAVING bool_or(coalesce(i.shelf_statuses,'') LIKE '%ON_SHELF%')
     AND (max(coalesce(ls.c30_sale_cnt,0)) > 0 OR max(coalesce(os.order_qty_30,0)) > 0)
),
raw_actions AS (
  SELECT
    'link' AS action_domain,
    date,
    store_key,
    group_key,
    dim.product_canonical_sn(standard_goods_sn) AS standard_goods_sn,
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
    coalesce(dim.product_canonical_sn(standard_goods_sn), skc) AS title,
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
canonical_actions AS (
  SELECT
    action_domain,
    date,
    store_key,
    group_key,
    dim.product_canonical_sn(standard_goods_sn) AS standard_goods_sn,
    skc,
    category,
    priority,
    score,
    CASE
      WHEN coalesce(title,'') = coalesce(standard_goods_sn,'') THEN dim.product_canonical_sn(standard_goods_sn)
      ELSE title
    END AS title,
    reason,
    evidence,
    next_step
  FROM raw_actions
),
domain_ranked AS (
  SELECT
    *,
    row_number() OVER (PARTITION BY action_domain, store_key ORDER BY score DESC, standard_goods_sn, skc) AS rn_domain_store
  FROM canonical_actions
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
