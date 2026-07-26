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
  ('OI_RETURN_ACT','OK_RETURN_ACT','S1','G1','O_RETURN_ACT','2026-01-10','2026-01-10 10:03','P1','SKCR','SKUR','P1 return-order actual fee',1,'SAR',100),
  ('OI_PARTIAL_A','OK_PARTIAL','S1','G1','O_PARTIAL','2026-01-10','2026-01-10 10:04','P1','SKCP','SKUP','P1 partial A',1,'SAR',120),
  ('OI_PARTIAL_B','OK_PARTIAL','S1','G1','O_PARTIAL','2026-01-10','2026-01-10 10:04','P1','SKCP','SKUP','P1 partial B',1,'SAR',80),
  ('OI_PENDING_PART_A','OK_PENDING_PART','S1','G1','O_PENDING_PART','2026-01-10','2026-01-10 10:05','P1','SKCPP','SKUPP','P1 pending partial A',1,'SAR',120),
  ('OI_PENDING_PART_B','OK_PENDING_PART','S1','G1','O_PENDING_PART','2026-01-10','2026-01-10 10:05','P1','SKCPP','SKUPP','P1 pending partial B',1,'SAR',80),
  ('OI_RTV_A','OK_RTV','S1','G1','O_RTV','2026-01-10','2026-01-10 10:06','P1','SKCRTV','SKURTV','P1 RTV split A',1,'SAR',50),
  ('OI_RTV_B','OK_RTV','S1','G1','O_RTV','2026-01-10','2026-01-10 10:06','P1','SKCRTV','SKURTV','P1 RTV split B',1,'SAR',50),
  ('OI_RETURN_MIX_A','OK_RETURN_MIX','S1','G1','O_RETURN_MIX','2026-01-10','2026-01-10 10:07','P1','SKCRM_A','SKURM_A','P1 package actual A',1,'SAR',60),
  ('OI_RETURN_MIX_B','OK_RETURN_MIX','S1','G1','O_RETURN_MIX','2026-01-10','2026-01-10 10:07','P2','SKCRM_B','SKURM_B','P2 package actual B',1,'SAR',40),
  ('OI_MULTI','OK_MULTI','S1','G1','O_MULTI','2026-01-10','2026-01-10 10:08','P1','SKC_MULTI','SKU_MULTI','P1 realized plus pending',1,'SAR',100),
  ('OI_RTV_ZERO','OK_RTV_ZERO','S1','G1','O_RTV_ZERO','2026-01-10','2026-01-10 10:09','P1','SKC_RTV_ZERO','SKU_RTV_ZERO','cancelled zero-quantity line',0,'SAR',0);

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
   '退货退款','同意退款','已签收',100,'SAR','P1','SKCR',1,100),
  ('AF_PARTIAL','2026-01-11','S1','G1','2026-01-11 09:04','AF_PARTIAL','R_PARTIAL','O_PARTIAL',
   '退货退款','同意退款','已签收',100,'SAR','P1','SKCP',1,100),
  ('AF_PENDING_PART','2026-01-11','S1','G1','2026-01-11 09:05','AF_PENDING_PART','R_PENDING_PART','O_PENDING_PART',
   '退货退款','待买家退货','待寄回',50,'SAR','P1','SKCPP',1,50),
  ('AF_RTV','2026-01-11','S1','G1','2026-01-11 09:06','AF_RTV','R_RTV','O_RTV',
   '退货退款','同意退款','已签收',50,'SAR','P1','SKCRTV',1,50),
  ('AF_RETURN_MIX_A','2026-01-11','S1','G1','2026-01-11 09:07','AF_RETURN_MIX','R_RETURN_MIX','O_RETURN_MIX',
   '退货退款','同意退款','已签收',60,'SAR','P1','SKCRM_A',1,60),
  ('AF_RETURN_MIX_B','2026-01-11','S1','G1','2026-01-11 09:07','AF_RETURN_MIX','R_RETURN_MIX','O_RETURN_MIX',
   '退货退款','同意退款','已签收',40,'SAR','P2','SKCRM_B',1,40),
  ('AF_MULTI_REAL','2026-01-11','S1','G1','2026-01-11 09:08','AF_MULTI_REAL','R_MULTI_REAL','O_MULTI',
   '退货退款','同意退款','已签收',50,'SAR','P1','SKC_MULTI',0.5,50),
  ('AF_MULTI_PENDING','2026-01-11','S1','G1','2026-01-11 09:09','AF_MULTI_PENDING','R_MULTI_PENDING','O_MULTI',
   '退货退款','待买家退货','待寄回',30,'SAR','P1',NULL,0.3,30),
  ('AF_RTV_ZERO','2026-01-11','S1','G1','2026-01-11 09:10','AF_RTV_ZERO','R_RTV_ZERO','O_RTV_ZERO',
   '退货退款','同意退款','已签收',0,'SAR','P1','SKC_RTV_ZERO',1,0);

INSERT INTO fact.et_return_order(
  return_order_id,store_name_in,shipment_number,status,status_name,in_quantity,create_time
) VALUES
  ('ET_RTV','ETRUH09散件仓','EXP_RTV','done','已到货',1,'2026-01-12 10:00'),
  ('ET_RTV_ZERO','ETRUH09散件仓','EXP_RTV_ZERO','done','已到货',1,'2026-01-12 10:01');
INSERT INTO fact.et_return_order_item(
  unique_key,return_order_id,standard_goods_sn,match_key,quantity,instock,create_time
) VALUES
  ('ET_RTV_ITEM','ET_RTV','P1',dim.product_match_key('P1'),1,1,'2026-01-12 10:00'),
  ('ET_RTV_ZERO_ITEM','ET_RTV_ZERO','P1',dim.product_match_key('P1'),1,1,'2026-01-12 10:01');
INSERT INTO ops.rtv_tracking_verification(
  verification_id,store_key,et_return_order_id,et_shipment_number,standard_goods_sn,
  shein_aftersales_order_no,shein_order_no,shein_return_order_no,match_status,match_source
) VALUES
  ('RTV_SPLIT_VALIDATION','S1','ET_RTV','EXP_RTV','P1',
   'AF_RTV','O_RTV','R_RTV','matched','validation'),
  ('RTV_ZERO_VALIDATION','S1','ET_RTV_ZERO','EXP_RTV_ZERO','P1',
   'AF_RTV_ZERO','O_RTV_ZERO','R_RTV_ZERO','matched','validation');

INSERT INTO fact.openapi_return_order(
  return_order_key,ret_order_date,store_key,group_key,return_order_no,order_no,return_order_status,check_status
) VALUES
  ('RO_RETURN_ACT','2026-01-11','S1','G1','R_RETURN_ACT','O_RETURN_ACT','7','2'),
  ('RO_RETURN_MIX','2026-01-11','S1','G1','R_RETURN_MIX','O_RETURN_MIX','7','2');
INSERT INTO fact.openapi_return_item(
  return_item_key,return_order_key,ret_order_date,store_key,group_key,return_order_no,order_no,
  standard_goods_sn,skc,sku,quantity,performance_price,return_expense,return_freight_subsidy,amount_sar
) VALUES
  ('RI_RETURN_ACT','RO_RETURN_ACT','2026-01-11','S1','G1','R_RETURN_ACT','O_RETURN_ACT',
   'P1','SKCR','SKUR',1,16.77,0,0,83.23),
  -- One actual package charge is present on product A only. Product B must not
  -- retain its share of the 13.88 estimate; the 16.77 package actual is
  -- allocated over both returned products.
  ('RI_RETURN_MIX','RO_RETURN_MIX','2026-01-11','S1','G1','R_RETURN_MIX','O_RETURN_MIX',
   'P1','SKCRM_A','SKURM_A',1,16.77,0,0,43.23);

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
  income_bill_id,client_from_id,sort_name,status,status_name,other_income,ship_time,create_time,billing_period_date
) VALUES
  ('BILL_POOL',NULL,'仓储费','done','done',100,'2026-01-05 08:00','2026-01-05 08:00','2026-01-05'),
  ('BILL_LINK',NULL,'仓储费','done','done',100,'2026-01-06 08:00','2026-01-06 08:00','2026-01-06'),
  ('BILL_REPL_PENDING',NULL,'仓储费','waiting','等待支付',515.51,'2026-04-04 08:00','2026-04-04 08:00','2026-04-04'),
  ('BILL_REPL_PAID',NULL,'仓储费','paid','已支付',515.51,'2026-04-04 09:00','2026-04-04 09:00','2026-04-04'),
  ('BILL_PAID_A',NULL,'仓储费','paid','已支付',100,'2026-04-05 08:00','2026-04-05 08:00','2026-04-05'),
  ('BILL_PAID_B',NULL,'仓储费','paid','已支付',100,'2026-04-05 09:00','2026-04-05 09:00','2026-04-05'),
  ('BILL_CLIENT_A_PAID','CLIENT_A','仓储费','paid','已支付',100,'2026-04-06 08:00','2026-04-06 08:00','2026-04-06'),
  ('BILL_CLIENT_B_PENDING','CLIENT_B','仓储费','waiting','等待支付',100,'2026-04-06 09:00','2026-04-06 09:00','2026-04-06'),
  ('BILL_INHERIT_PENDING',NULL,'仓储费','waiting','等待支付',200,'2026-04-07 08:00','2026-04-07 08:00','2026-04-07'),
  ('BILL_INHERIT_PAID',NULL,'仓储费','paid','已支付',200,'2026-04-07 09:00','2026-04-07 09:00','2026-04-07'),
  ('BILL_MIX_DETAIL',NULL,'仓储费','paid','已支付',100,'2026-04-08 08:00','2026-04-08 08:00','2026-04-08'),
  ('BILL_MIX_MISSING',NULL,'仓储费','paid','已支付',200,'2026-04-08 09:00','2026-04-08 09:00','2026-04-08');
INSERT INTO fact.et_storage_fee_product_detail(
  unique_key,income_bill_id,fee_date,warehouse_name,storage_type,storage_code,
  standard_goods_sn,match_key,quantity,shown_fee_rmb,actual_fee_rmb,actual_fee_sar
) VALUES
  ('SFD_LINK','BILL_LINK','2026-01-06','ETRUH09散件仓','散件','P1','P1',dim.product_match_key('P1'),10,100,50,50/1.8),
  -- This pending detail must be ignored after BILL_REPL_PAID supersedes it.
  ('SFD_REPL_PENDING','BILL_REPL_PENDING','2026-04-04','ETRUH09散件仓','散件','P2','P2',dim.product_match_key('P2'),10,100,50,50/1.8),
  ('SFD_REPL_PAID','BILL_REPL_PAID','2026-04-04','ETRUH09散件仓','散件','P1','P1',dim.product_match_key('P1'),10,100,50,50/1.8),
  ('SFD_PAID_A','BILL_PAID_A','2026-04-05','ETRUH09散件仓','散件','P1','P1',dim.product_match_key('P1'),10,50,25,25/1.8),
  ('SFD_PAID_B','BILL_PAID_B','2026-04-05','ETRUH09散件仓','散件','P2','P2',dim.product_match_key('P2'),10,50,25,25/1.8),
  -- Paid replacement has no detail; its one pending predecessor is inherited.
  ('SFD_INHERIT_PENDING','BILL_INHERIT_PENDING','2026-04-07','ETRUH09散件仓','散件','P2','P2',dim.product_match_key('P2'),10,100,50,50/1.8),
  ('SFD_MIX_DETAIL','BILL_MIX_DETAIL','2026-04-08','ETRUH09散件仓','散件','P1','P1',dim.product_match_key('P1'),10,100,50,50/1.8);
INSERT INTO fact.link_master_snapshot(
  unique_key,snapshot_date,store_key,group_key,standard_goods_sn,skc,is_on_shelf,is_wait_shelf,
  is_sold_out,is_out_shelf,is_hard_dead
) VALUES
  ('LINK_P1','2026-01-04','S1','G1','P1','SKCA',true,false,false,false,false),
  ('LINK_P2','2026-01-04','S1','G1','P2','SKCB',true,false,false,false,false);

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
  v_partial_net numeric;
  v_partial_impact numeric;
  v_pending_partial_risk numeric;
  v_pending_partial_adjusted numeric;
  v_rtv_received numeric;
  v_rtv_09_received numeric;
  v_rtv_recoverable numeric;
  v_rtv_zero_received numeric;
  v_rtv_zero_recoverable numeric;
  v_multi_net numeric;
  v_multi_pending numeric;
  v_multi_risk_adjusted numeric;
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

  SELECT sum(net_revenue_sar),sum(impact_amount_sar),sum(return_delivery_fee_sar)
    INTO v_partial_net,v_partial_impact,v_fee
  FROM mart.profit_order_item WHERE order_no='O_PARTIAL';
  IF abs(v_partial_net-100) > 0.005
     OR abs(v_partial_impact-100) > 0.005
     OR abs(v_fee-13.88) > 0.005 THEN
    RAISE EXCEPTION 'partial_refund_and_split_package_fee contract failed: net %, impact %, fee %',
      v_partial_net,v_partial_impact,v_fee;
  END IF;

  SELECT sum(pending_revenue_risk_sar),sum(risk_adjusted_net_revenue_sar)
    INTO v_pending_partial_risk,v_pending_partial_adjusted
  FROM mart.profit_order_item WHERE order_no='O_PENDING_PART';
  IF abs(v_pending_partial_risk-50) > 0.005
     OR abs(v_pending_partial_adjusted-150) > 0.005 THEN
    RAISE EXCEPTION 'pending_partial_refund contract failed: risk %, adjusted %',
      v_pending_partial_risk,v_pending_partial_adjusted;
  END IF;

  SELECT
    sum(rtv_received_quantity),
    sum(rtv_received_to_09_quantity),
    sum(rtv_recoverable_cost_sar)
    INTO v_rtv_received,v_rtv_09_received,v_rtv_recoverable
  FROM mart.profit_order_item
  WHERE order_no='O_RTV';
  IF abs(v_rtv_received-1) > 0.005
     OR abs(v_rtv_09_received-1) > 0.005
     OR abs(v_rtv_recoverable-10) > 0.005 THEN
    RAISE EXCEPTION 'split_order_item_rtv_is_allocated_once contract failed: received %, received09 %, recoverable %',
      v_rtv_received,v_rtv_09_received,v_rtv_recoverable;
  END IF;

  SELECT sum(rtv_received_quantity),sum(rtv_recoverable_cost_sar)
    INTO v_rtv_zero_received,v_rtv_zero_recoverable
  FROM mart.profit_order_item
  WHERE order_no='O_RTV_ZERO';
  IF abs(coalesce(v_rtv_zero_received,0)) > 0.005
     OR abs(coalesce(v_rtv_zero_recoverable,0)) > 0.005 THEN
    RAISE EXCEPTION 'zero_quantity_order_must_not_receive_rtv_recovery contract failed: received %, recoverable %',
      v_rtv_zero_received,v_rtv_zero_recoverable;
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

  SELECT
    sum(return_delivery_fee_sar),
    sum(actual_return_cost_sar),
    count(*) FILTER (WHERE actual_return_cost_sar IS NOT NULL)
    INTO v_fee,v_actual,v_actual_rows
  FROM mart.profit_order_item
  WHERE order_no='O_RETURN_MIX';
  IF abs(v_fee-16.77) > 0.005
     OR abs(v_actual-16.77) > 0.005
     OR v_actual_rows <> 2 THEN
    RAISE EXCEPTION 'one product actual fee must replace the whole mixed package estimate: fee %, actual %, rows %',
      v_fee,v_actual,v_actual_rows;
  END IF;

  SELECT net_revenue_sar,pending_revenue_risk_sar,risk_adjusted_net_revenue_sar
    INTO v_multi_net,v_multi_pending,v_multi_risk_adjusted
  FROM mart.profit_order_item
  WHERE order_item_key='OI_MULTI';
  IF abs(v_multi_net-50) > 0.005
     OR abs(v_multi_pending-30) > 0.005
     OR abs(v_multi_risk_adjusted-20) > 0.005 THEN
    RAISE EXCEPTION 'realized and pending after-sales candidates must both survive matching: net %, pending %, adjusted %',
      v_multi_net,v_multi_pending,v_multi_risk_adjusted;
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
  v_count bigint;
  v_superseded text[];
  v_p1_fee numeric;
  v_pool_fee numeric;
  v_detail_source text;
  v_detail_reason text;
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

  SELECT count(*)
    INTO v_count
  FROM mart.et_storage_fee_bill_canonical
  WHERE fee_date='2026-04-04';
  SELECT superseded_income_bill_ids INTO v_superseded
  FROM mart.et_storage_fee_bill_canonical
  WHERE fee_date='2026-04-04'
  LIMIT 1;
  IF v_count <> 1 OR v_superseded <> ARRAY['BILL_REPL_PENDING']::text[] THEN
    RAISE EXCEPTION 'pending-to-paid replacement must retain only paid canonical bill: rows %, superseded %',v_count,v_superseded;
  END IF;

  SELECT sum(shown_fee_rmb),sum(actual_fee_rmb),sum(actual_fee_sar)
    INTO v_fee,v_alloc,v_delta
  FROM mart.et_storage_fee_daily
  WHERE fee_date='2026-04-04';
  IF abs(v_fee-515.51) > 0.005
     OR abs(v_alloc-(515.51*0.5)) > 0.005
     OR abs(v_delta-(515.51*0.5/1.8)) > 0.005 THEN
    RAISE EXCEPTION 'canonical storage fee must use other_income * 0.5 / 1.8: shown %, rmb %, sar %',v_fee,v_alloc,v_delta;
  END IF;

  SELECT count(*),sum(shown_fee_rmb) INTO v_count,v_fee
  FROM mart.et_storage_fee_bill_canonical
  WHERE fee_date='2026-04-05';
  IF v_count <> 2 OR abs(v_fee-200) > 0.005 THEN
    RAISE EXCEPTION 'two independently paid bills must remain distinct: rows %, shown %',v_count,v_fee;
  END IF;

  SELECT count(*) INTO v_count
  FROM mart.et_storage_fee_bill_canonical
  WHERE fee_date='2026-04-06';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'same-date paid/pending bills from different clients must not be cross-collapsed: rows %',v_count;
  END IF;

  SELECT detail_source_income_bill_id,detail_source_reason
    INTO v_detail_source,v_detail_reason
  FROM mart.et_storage_fee_canonical_detail_source
  WHERE fee_date='2026-04-07' AND canonical_income_bill_id='BILL_INHERIT_PAID';
  IF v_detail_source <> 'BILL_INHERIT_PENDING' OR v_detail_reason <> 'superseded_bill_detail_fallback' THEN
    RAISE EXCEPTION 'paid bill without detail must inherit exactly one pending detail source: source %, reason %',v_detail_source,v_detail_reason;
  END IF;

  SELECT sum(actual_allocated_fee_sar) INTO v_p1_fee
  FROM mart.storage_fee_product_daily
  WHERE date='2026-04-07' AND match_key=dim.product_match_key('P2');
  IF abs(v_p1_fee-(200*0.5/1.8)) > 0.005
     OR EXISTS (
       SELECT 1 FROM mart.storage_fee_product_daily
       WHERE date='2026-04-07' AND match_key=dim.product_match_key('P1')
     ) THEN
    RAISE EXCEPTION 'inherited pending detail must allocate once to its canonical paid bill: P2 %',v_p1_fee;
  END IF;

  SELECT sum(actual_allocated_fee_sar) INTO v_p1_fee
  FROM mart.storage_fee_product_daily
  WHERE date='2026-04-04' AND match_key=dim.product_match_key('P1');
  IF abs(v_p1_fee-(515.51*0.5/1.8)) > 0.005
     OR EXISTS (
       SELECT 1 FROM mart.storage_fee_product_daily
       WHERE date='2026-04-04' AND match_key=dim.product_match_key('P2')
     ) THEN
    RAISE EXCEPTION 'only canonical paid-bill detail may define product distribution: P1 %',v_p1_fee;
  END IF;

  SELECT
    sum(actual_allocated_fee_sar) FILTER (WHERE match_key=dim.product_match_key('P1')),
    sum(actual_allocated_fee_sar) FILTER (WHERE match_key='CENTRAL_POOL')
    INTO v_p1_fee,v_pool_fee
  FROM mart.storage_fee_product_daily
  WHERE date='2026-04-08';
  IF abs(v_p1_fee-(100*0.5/1.8)) > 0.005
     OR abs(v_pool_fee-(200*0.5/1.8)) > 0.005 THEN
    RAISE EXCEPTION 'same_day_independent_missing_detail_bill must not scale onto detailed bill: P1 %, pool %',
      v_p1_fee,v_pool_fee;
  END IF;

  SELECT max(greatest(abs(store_allocation_delta_sar),abs(product_allocation_delta_sar),abs(product_store_allocation_delta_sar)))
    INTO v_delta
  FROM mart.storage_fee_daily_reconciliation
  WHERE fee_date IN ('2026-04-04','2026-04-05','2026-04-07','2026-04-08');
  IF coalesce(v_delta,999) > 0.01 THEN
    RAISE EXCEPTION 'scaled canonical detail must conserve across ledger, product, and store layers: %',v_delta;
  END IF;
END $$;

SELECT jsonb_build_object(
  'ok',true,
  'contracts',jsonb_build_array(
    'pending_refund_is_risk_not_realized',
    'legacy_history_is_labeled_before_cutover',
    'post_cutover_missing_ledger_fails_closed',
    'package_estimate_once',
    'partial_refund_and_split_package_fee',
    'pending_partial_refund',
    'split_order_item_rtv_is_allocated_once',
    'zero_quantity_order_must_not_receive_rtv_recovery',
    'finance_actual_replaces_estimate',
    'return_order_performance_price_actual_replaces_estimate',
    'mixed_package_actual_replaces_all_estimate',
    'realized_and_pending_candidates_both_survive',
    'finance_unmapped_actual_is_visible_and_reconciles',
    'storage_active_link_or_central_pool',
    'storage_reconciles',
    'storage_pending_paid_replacement_is_canonicalized',
    'storage_two_paid_bills_are_not_merged',
    'storage_different_clients_are_not_cross_collapsed',
    'storage_superseded_detail_is_inherited_once_when_paid_detail_missing',
    'storage_detail_scales_to_canonical_bill_and_conserves',
    'same_day_independent_missing_detail_bill'
  )
) AS warehouse_business_logic_smoke;

ROLLBACK;
