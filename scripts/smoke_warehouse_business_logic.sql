\set ON_ERROR_STOP on

-- Run only against a disposable validation database. Everything is rolled back.
BEGIN;

INSERT INTO dim.store(store_key,group_key,shop_name) VALUES ('S1','G1','validation store');
INSERT INTO dim.product(standard_goods_sn,sample_raw_goods_sn,first_seen_date,last_seen_date)
VALUES ('P1','P1','2026-01-01','2026-01-31'),('P2','P2','2026-01-01','2026-01-31');

INSERT INTO fact.order_item(
  order_item_key,order_key,store_key,group_key,order_no,created_date,order_create_time,
  standard_goods_sn,skc,sku_code,goods_title,quantity,currency_code,sales_sar
) VALUES
  ('OI_PENDING','OK_PENDING','S1','G1','O_PENDING','2026-01-10','2026-01-10 10:00','P1','SKC1','SKU1','P1 pending',1,'SAR',100),
  ('OI_REAL_A','OK_REAL','S1','G1','O_REAL','2026-01-10','2026-01-10 10:01','P1','SKCA','SKUA','P1 realized',1,'SAR',60),
  ('OI_REAL_B','OK_REAL','S1','G1','O_REAL','2026-01-10','2026-01-10 10:01','P2','SKCB','SKUB','P2 realized',1,'SAR',40),
  ('OI_ACT_A','OK_ACT','S1','G1','O_ACT','2026-01-10','2026-01-10 10:02','P1','SKCA','SKUA','P1 actual fee',1,'SAR',60),
  ('OI_ACT_B','OK_ACT','S1','G1','O_ACT','2026-01-10','2026-01-10 10:02','P2','SKCB','SKUB','P2 actual fee',1,'SAR',40),
  ('OI_RETURN_ACT','OK_RETURN_ACT','S1','G1','O_RETURN_ACT','2026-01-10','2026-01-10 10:03','P1','SKCR','SKUR','P1 return-order actual fee',1,'SAR',100);

INSERT INTO fact.inventory_cost_event(
  event_key,match_key,effective_at,event_type,quantity,cost_amount_sar,source_table,
  source_key,source_order_item_key,source_hash,period_key
)
SELECT 'EV_'||order_item_key,dim.product_match_key(standard_goods_sn),order_create_time,'sale',quantity,10,
  'fact.order_item',order_item_key,order_item_key,'validation-hash',date_trunc('month',created_date)::date
FROM fact.order_item;

INSERT INTO fact.inventory_cost_ledger(
  event_key,match_key,effective_at,event_type,source_table,source_key,source_order_item_key,
  quantity,cost_amount_sar,quantity_before,value_before_sar,avg_unit_cost_before_sar,
  quantity_after,value_after_sar,avg_unit_cost_after_sar,valued_quantity,unvalued_quantity,
  cogs_sar,valuation_status,ledger_version
)
SELECT 'EV_'||order_item_key,dim.product_match_key(standard_goods_sn),order_create_time,'sale',
  'fact.order_item',order_item_key,order_item_key,quantity,10,10,100,10,9,90,10,quantity,0,10,
  'valued','validation-v1'
FROM fact.order_item;

-- Preserve the known historical estimate before the first auditable physical
-- count, but fail closed after that cutover when no moving-average assignment
-- exists. This avoids blanking all historical profit during migration without
-- allowing a future receipt to price a post-cutover sale retroactively.
INSERT INTO fact.product_cost_batch(
  batch_key,standard_goods_sn,arrived_date,shipped_quantity,cost_sar,unit_cost_sar,complete_batch
) VALUES ('PCB_LEGACY','P2','2026-01-01',10,100,10,true);
INSERT INTO fact.inventory_cost_opening(
  opening_key,effective_date,match_key,opening_quantity,opening_unit_cost_sar,approval_ref,source,status
) VALUES ('OPEN_CUTOVER','2026-01-15',dim.product_match_key('P1'),10,10,'validation','validation','approved');
INSERT INTO fact.order_item(
  order_item_key,order_key,store_key,group_key,order_no,created_date,order_create_time,
  standard_goods_sn,skc,sku_code,goods_title,quantity,currency_code,sales_sar
) VALUES
  ('OI_LEGACY','OK_LEGACY','S1','G1','O_LEGACY','2026-01-10','2026-01-10 10:03','P2','SKC_LEGACY','SKU_LEGACY','P2 legacy estimate',1,'SAR',40),
  ('OI_POST','OK_POST','S1','G1','O_POST','2026-01-16','2026-01-16 10:03','P2','SKC_POST','SKU_POST','P2 post cutover missing',1,'SAR',40);

INSERT INTO fact.after_sales_item(
  after_sales_item_key,snapshot_date,store_key,group_key,request_time,aftersales_order_no,
  return_order_no,order_no,resolution_plan_name,order_sub_status_name,return_package_status_name,
  price_amount_total,currency_code,standard_goods_sn,skc,quantity,price_amount
) VALUES
  ('AF_PENDING','2026-01-11','S1','G1','2026-01-11 09:00','AF_PENDING','R_PENDING','O_PENDING',
   '退货退款','待买家退货','待寄回',100,'SAR','P1','SKC1',1,100),
  ('AF_REAL_A','2026-01-11','S1','G1','2026-01-11 09:01','AF_REAL','R_REAL','O_REAL',
   '退货退款','同意退款','已签收',60,'SAR','P1','SKCA',1,60),
  ('AF_REAL_B','2026-01-11','S1','G1','2026-01-11 09:01','AF_REAL','R_REAL','O_REAL',
   '退货退款','同意退款','已签收',40,'SAR','P2','SKCB',1,40),
  ('AF_ACT_A','2026-01-11','S1','G1','2026-01-11 09:02','AF_ACT','R_ACT','O_ACT',
   '退货退款','同意退款','已签收',60,'SAR','P1','SKCA',1,60),
  ('AF_ACT_B','2026-01-11','S1','G1','2026-01-11 09:02','AF_ACT','R_ACT','O_ACT',
   '退货退款','同意退款','已签收',40,'SAR','P2','SKCB',1,40),
  ('AF_RETURN_ACT','2026-01-11','S1','G1','2026-01-11 09:03','AF_RETURN_ACT','R_RETURN_ACT','O_RETURN_ACT',
   '退货退款','同意退款','已签收',100,'SAR','P1','SKCR',1,100);

INSERT INTO fact.openapi_return_order(
  return_order_key,ret_order_date,store_key,group_key,return_order_no,order_no,return_order_status,check_status
) VALUES ('RO_RETURN_ACT','2026-01-11','S1','G1','R_RETURN_ACT','O_RETURN_ACT','7','2');
INSERT INTO fact.openapi_return_item(
  return_item_key,return_order_key,ret_order_date,store_key,group_key,return_order_no,order_no,
  standard_goods_sn,skc,sku,quantity,performance_price,return_expense,return_freight_subsidy,amount_sar
) VALUES ('RI_RETURN_ACT','RO_RETURN_ACT','2026-01-11','S1','G1','R_RETURN_ACT','O_RETURN_ACT',
  'P1','SKCR','SKUR',1,16.77,0,0,83.23);

INSERT INTO fact.openapi_finance_check_order(
  check_order_key,store_key,group_key,check_order_no,bz_order_no,check_status,
  completed_pay_time,currency_code,fetched_at,payload_hash
) VALUES
  ('FC_ACT','S1','G1','FC_ACT','R_ACT',3,'2026-01-15 12:00','SAR',now(),'validation-hash'),
  ('FC_UNMAPPED','S1','G1','FC_UNMAPPED','R_UNKNOWN',3,'2026-01-15 12:01','SAR',now(),'validation-hash');
INSERT INTO fact.openapi_finance_check_order_item(
  check_order_item_key,check_order_key,store_key,group_key,check_order_no,bz_order_no,
  check_status,completed_pay_time,currency_code,fetched_at,line_index,sku_code,
  return_expense_sar,return_freight_subsidy_sar,net_return_cost_sar,payload_hash
) VALUES
  ('FCI_ACT','FC_ACT','S1','G1','FC_ACT','R_ACT',3,'2026-01-15 12:00','SAR',now(),0,'SKUA',25,5,20,'validation-hash'),
  ('FCI_UNMAPPED','FC_UNMAPPED','S1','G1','FC_UNMAPPED','R_UNKNOWN',3,'2026-01-15 12:01','SAR',now(),0,'UNKNOWN',15,3,12,'validation-hash');

INSERT INTO fact.et_income_bill(
  income_bill_id,sort_name,status,status_name,other_income,ship_time,create_time,billing_period_date
) VALUES
  ('BILL_POOL','仓储费','done','done',100,'2026-01-05 08:00','2026-01-05 08:00','2026-01-05'),
  ('BILL_LINK','仓储费','done','done',100,'2026-01-06 08:00','2026-01-06 08:00','2026-01-06');
INSERT INTO fact.et_storage_fee_product_detail(
  unique_key,income_bill_id,fee_date,warehouse_name,storage_type,storage_code,
  standard_goods_sn,match_key,quantity,shown_fee_rmb,actual_fee_rmb,actual_fee_sar
) VALUES ('SFD_LINK','BILL_LINK','2026-01-06','ETRUH09散件仓','散件','P1','P1',dim.product_match_key('P1'),10,100,75,75/1.88);
INSERT INTO fact.link_master_snapshot(
  unique_key,snapshot_date,store_key,group_key,standard_goods_sn,skc,is_on_shelf,is_wait_shelf,
  is_sold_out,is_out_shelf,is_hard_dead
) VALUES ('LINK_P1','2026-01-04','S1','G1','P1','SKCA',true,false,false,false,false);

DO $$
DECLARE
  v_net numeric;
  v_risk numeric;
  v_risk_profit numeric;
  v_fee numeric;
  v_actual numeric;
  v_actual_rows bigint;
  v_unmapped numeric;
  v_reconcile_delta numeric;
  v_return_actual_source text;
  v_legacy_cost numeric;
  v_legacy_missing boolean;
  v_legacy_status text;
  v_post_cost numeric;
  v_post_missing boolean;
  v_post_status text;
BEGIN
  SELECT net_revenue_sar,pending_revenue_risk_sar,risk_adjusted_profit_before_storage_sar
    INTO v_net,v_risk,v_risk_profit
  FROM mart.profit_order_item WHERE order_item_key='OI_PENDING';
  IF v_net <> 100 OR v_risk <> 100 OR v_risk_profit <> -10 THEN
    RAISE EXCEPTION 'pending refund contract failed: net %, risk %, risk profit %',v_net,v_risk,v_risk_profit;
  END IF;

  SELECT sum(return_delivery_fee_sar) INTO v_fee
  FROM mart.profit_order_item WHERE order_no='O_REAL';
  IF abs(v_fee-13.88) > 0.005 THEN
    RAISE EXCEPTION 'package estimate must be once per package, got %',v_fee;
  END IF;

  SELECT sum(return_delivery_fee_sar),sum(actual_return_cost_sar),count(*) FILTER (WHERE actual_return_cost_sar IS NOT NULL)
    INTO v_fee,v_actual,v_actual_rows
  FROM mart.profit_order_item WHERE order_no='O_ACT';
  IF abs(v_fee-20) > 0.005 OR abs(v_actual-20) > 0.005 OR v_actual_rows <> 2 THEN
    RAISE EXCEPTION 'finance actual must replace the whole package estimate: fee %, actual %, rows %',v_fee,v_actual,v_actual_rows;
  END IF;

  SELECT return_delivery_fee_sar,actual_return_cost_sar,return_delivery_fee_source
    INTO v_fee,v_actual,v_return_actual_source
  FROM mart.profit_order_item WHERE order_no='O_RETURN_ACT';
  IF abs(v_fee-16.77) > 0.005 OR abs(v_actual-16.77) > 0.005
     OR v_return_actual_source <> 'return_order_performance_price_actual' THEN
    RAISE EXCEPTION 'return-order performancePrice actual must replace package estimate: fee %, actual %, source %',v_fee,v_actual,v_return_actual_source;
  END IF;

  SELECT sum(unmapped_net_return_cost_sar),max(abs(reconciliation_delta_sar))
    INTO v_unmapped,v_reconcile_delta
  FROM mart.finance_return_cost_reconciliation;
  IF abs(v_unmapped-12) > 0.005 OR coalesce(v_reconcile_delta,999) > 0.005 THEN
    RAISE EXCEPTION 'unmapped finance actual must remain visible and reconcile: unmapped %, delta %',v_unmapped,v_reconcile_delta;
  END IF;

  SELECT product_cost_sar,cost_missing,cost_valuation_status
    INTO v_legacy_cost,v_legacy_missing,v_legacy_status
  FROM mart.profit_order_item WHERE order_item_key='OI_LEGACY';
  IF abs(v_legacy_cost-10) > 0.005 OR v_legacy_missing OR v_legacy_status <> 'legacy_pre_cutover_estimate' THEN
    RAISE EXCEPTION 'pre-cutover legacy estimate contract failed: cost %, missing %, status %',v_legacy_cost,v_legacy_missing,v_legacy_status;
  END IF;

  SELECT product_cost_sar,cost_missing,cost_valuation_status
    INTO v_post_cost,v_post_missing,v_post_status
  FROM mart.profit_order_item WHERE order_item_key='OI_POST';
  IF v_post_cost IS NOT NULL OR NOT v_post_missing OR v_post_status <> 'ledger_missing' THEN
    RAISE EXCEPTION 'post-cutover missing ledger must fail closed: cost %, missing %, status %',v_post_cost,v_post_missing,v_post_status;
  END IF;
END $$;

DO $$
DECLARE
  v_fee numeric;
  v_alloc numeric;
  v_store text;
  v_delta numeric;
BEGIN
  SELECT actual_fee_sar INTO v_fee FROM mart.et_storage_fee_daily WHERE fee_date='2026-01-05';
  SELECT sum(storage_fee_sar),max(store_key) INTO v_alloc,v_store
  FROM mart.storage_fee_product_store_daily WHERE date='2026-01-05';
  IF abs(v_fee-v_alloc) > 0.005 OR v_store <> 'CENTRAL_POOL' THEN
    RAISE EXCEPTION 'no-evidence storage fee must remain visible in central pool: fee %, alloc %, store %',v_fee,v_alloc,v_store;
  END IF;

  SELECT sum(storage_fee_sar),max(store_key) INTO v_alloc,v_store
  FROM mart.storage_fee_product_store_daily WHERE date='2026-01-06' AND match_key=dim.product_match_key('P1');
  IF abs(v_fee-v_alloc) > 0.005 OR v_store <> 'S1' THEN
    RAISE EXCEPTION 'active-link storage allocation failed: fee %, alloc %, store %',v_fee,v_alloc,v_store;
  END IF;

  SELECT max(abs(product_store_allocation_delta_sar)) INTO v_delta
  FROM mart.storage_fee_daily_reconciliation WHERE fee_date IN ('2026-01-05','2026-01-06');
  IF coalesce(v_delta,999) > 0.01 THEN
    RAISE EXCEPTION 'storage reconciliation delta too large: %',v_delta;
  END IF;
END $$;

SELECT jsonb_build_object(
  'ok',true,
  'contracts',jsonb_build_array(
    'pending_refund_is_risk_not_realized',
    'legacy_history_is_labeled_before_cutover',
    'post_cutover_missing_ledger_fails_closed',
    'package_estimate_once',
    'finance_actual_replaces_estimate',
    'return_order_performance_price_actual_replaces_estimate',
    'finance_unmapped_actual_is_visible_and_reconciles',
    'storage_active_link_or_central_pool',
    'storage_reconciles'
  )
) AS warehouse_business_logic_smoke;

ROLLBACK;
