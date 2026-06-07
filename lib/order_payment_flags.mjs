/**
 * Helpers for extracting order-level payment/COD flags from SHEIN sales
 * artifacts.
 *
 * The sales fact tables intentionally keep their existing metric shape.  COD is
 * modeled as a separate order-level fact so historical backfills and future
 * daily loads can share the same invariant:
 *
 *   one row per store order, keyed by store_key + order identity, with the
 *   strongest available raw evidence for whether the customer selected COD.
 */

export const ORDER_PAYMENT_FLAG_TABLE = 'fact.order_payment_flag';

export const ORDER_PAYMENT_FLAG_COLUMNS = [
  'order_key',
  'store_key',
  'group_key',
  'order_id',
  'order_no',
  'bill_no',
  'created_date',
  'order_create_time',
  'is_cod',
  'payment_method',
  'payment_code',
  'payment_label',
  'payment_source',
  'source_kind',
  'source_file',
  'raw_evidence',
  'updated_at',
];

export const ORDER_PAYMENT_FLAG_CREATE_SQL = `
CREATE TABLE IF NOT EXISTS fact.order_payment_flag (
  order_key text PRIMARY KEY,
  store_key text NOT NULL,
  group_key text,
  order_id text,
  order_no text,
  bill_no text,
  created_date date,
  order_create_time timestamp without time zone,
  is_cod boolean,
  payment_method text,
  payment_code text,
  payment_label text,
  payment_source text,
  source_kind text NOT NULL,
  source_file text,
  raw_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_payment_flag_store_date_idx
  ON fact.order_payment_flag (store_key, created_date);
CREATE INDEX IF NOT EXISTS order_payment_flag_is_cod_date_idx
  ON fact.order_payment_flag (is_cod, created_date)
  WHERE is_cod IS TRUE;
CREATE INDEX IF NOT EXISTS order_payment_flag_order_no_idx
  ON fact.order_payment_flag (store_key, order_no);
`;

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const s = text(value).trim();
    if (s) return s;
  }
  return '';
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isCodTag(tag) {
  if (!tag || typeof tag !== 'object') return false;
  const code = text(tag.tagCode || tag.code || tag.tag_code).trim();
  const desc = text(tag.tagDesc || tag.desc || tag.name || tag.tag_desc).trim();
  const tip = text(tag.tip || tag.title || tag.message).trim();
  return /^COD$/i.test(code)
    || /^COD$/i.test(desc)
    || /货到付款/.test(tip)
    || /\bCash\s+on\s+Delivery\b/i.test(`${desc} ${tip}`);
}

function collectTagEvidence(order) {
  const evidence = [];
  const pushTags = (scope, tags) => {
    for (const tag of asArray(tags)) {
      if (isCodTag(tag)) {
        evidence.push({
          scope,
          tagCode: firstNonEmpty(tag.tagCode, tag.code, tag.tag_code),
          tagDesc: firstNonEmpty(tag.tagDesc, tag.desc, tag.name, tag.tag_desc),
          tip: firstNonEmpty(tag.tip, tag.title, tag.message),
        });
      }
    }
  };
  pushTags('order.tagCodeList', order?.tagCodeList);
  for (const [groupIdx, group] of asArray(order?.groupList).entries()) {
    pushTags(`groupList[${groupIdx}].tagCodeList`, group?.tagCodeList);
    for (const [goodsIdx, goods] of asArray(group?.goodsList).entries()) {
      pushTags(`groupList[${groupIdx}].goodsList[${goodsIdx}].tagCodeList`, goods?.tagCodeList);
    }
  }
  return evidence;
}

function collectWaybillCodEvidence(order) {
  const evidence = [];
  for (const [idx, pkg] of asArray(order?.packageWaybillList).entries()) {
    const carrierCode = firstNonEmpty(pkg?.carrierCode, pkg?.carrier_code);
    const expressShortName = firstNonEmpty(pkg?.expressShortName, pkg?.express_short_name);
    const textBlob = `${carrierCode} ${expressShortName}`;
    if (/\bCOD\b/i.test(textBlob)) {
      evidence.push({scope: `packageWaybillList[${idx}]`, carrierCode, expressShortName});
    }
  }
  return evidence;
}

function browserPaymentEvidence(order) {
  const codTags = collectTagEvidence(order);
  if (codTags.length) {
    const first = codTags[0] || {};
    return {
      isCod: true,
      paymentMethod: 'COD',
      paymentCode: first.tagCode || 'COD',
      paymentLabel: first.tagDesc || first.tip || 'COD',
      paymentSource: 'browser_tag_code_list',
      rawEvidence: {codTags},
    };
  }
  return {
    isCod: false,
    paymentMethod: 'NON_COD',
    paymentCode: '',
    paymentLabel: '',
    paymentSource: 'browser_no_cod_tag',
    rawEvidence: {
      tagCodeListCount: asArray(order?.tagCodeList).length,
    },
  };
}

function openApiPaymentEvidence(order) {
  const isCodValue = num(order?.isCod);
  const waybillCod = collectWaybillCodEvidence(order);
  if (isCodValue === 1 || waybillCod.length) {
    return {
      isCod: true,
      paymentMethod: 'COD',
      paymentCode: isCodValue === null ? 'WAYBILL_COD' : String(order.isCod),
      paymentLabel: waybillCod[0]?.expressShortName || 'COD',
      paymentSource: isCodValue === 1 ? 'openapi_is_cod' : 'openapi_waybill_cod',
      rawEvidence: {
        isCod: order?.isCod ?? null,
        paymentTime: order?.paymentTime ?? null,
        paymentInfo: order?.paymentInfo ?? null,
        waybillCod,
      },
    };
  }
  if (isCodValue !== null) {
    return {
      isCod: false,
      paymentMethod: 'NON_COD',
      paymentCode: String(order.isCod),
      paymentLabel: '',
      paymentSource: 'openapi_is_cod',
      rawEvidence: {
        isCod: order?.isCod ?? null,
        paymentTime: order?.paymentTime ?? null,
        paymentInfo: order?.paymentInfo ?? null,
      },
    };
  }
  return {
    isCod: null,
    paymentMethod: '',
    paymentCode: '',
    paymentLabel: '',
    paymentSource: 'openapi_missing_payment_flag',
    rawEvidence: {
      paymentTime: order?.paymentTime ?? null,
      paymentInfo: order?.paymentInfo ?? null,
    },
  };
}

function orderCreateTime(order, fallbackRows = []) {
  return firstNonEmpty(
    order?.orderCreateTime,
    order?.orderTime,
    order?.orderAllocateTime,
    order?.paymentTime,
    order?.g_zcs_allocateTime,
    order?.allocateTimeFull,
    order?.allocateTime,
    fallbackRows[0]?.orderCreateTime,
    fallbackRows[0]?.allocateTimeFull,
    fallbackRows[0]?.allocateTime,
  );
}

function buildFlagRow({data, order, date, sourceFile, sourceKind, fallbackRows = [], idx = 0}) {
  const storeKey = firstNonEmpty(data?.storeKey, data?.store_key).toUpperCase();
  const groupKey = firstNonEmpty(data?.groupKey, data?.group_key);
  const orderId = firstNonEmpty(order?.id, order?.orderId, order?.orderNo, fallbackRows[0]?.orderId, fallbackRows[0]?.orderNo, idx);
  const orderNo = firstNonEmpty(order?.orderNo, order?.billno, fallbackRows[0]?.orderNo);
  const billNo = firstNonEmpty(order?.billno, order?.billNo, orderNo);
  const evidence = sourceKind === 'openapi'
    ? openApiPaymentEvidence(order)
    : browserPaymentEvidence(order);
  return {
    order_key: `${storeKey}__${orderId}`,
    store_key: storeKey,
    group_key: groupKey,
    order_id: orderId,
    order_no: orderNo,
    bill_no: billNo,
    created_date: date,
    order_create_time: orderCreateTime(order, fallbackRows),
    is_cod: evidence.isCod,
    payment_method: evidence.paymentMethod,
    payment_code: evidence.paymentCode,
    payment_label: evidence.paymentLabel,
    payment_source: evidence.paymentSource,
    source_kind: sourceKind,
    source_file: sourceFile,
    raw_evidence: {
      ...evidence.rawEvidence,
      orderType: order?.orderType ?? fallbackRows[0]?.orderType ?? null,
      orderStatus: order?.orderStatus ?? fallbackRows[0]?.orderStatus ?? null,
    },
    updated_at: new Date().toISOString(),
  };
}

function groupFallbackRowsByOrder(data) {
  const byOrder = new Map();
  for (const row of asArray(data?.orderRows)) {
    const keys = [
      firstNonEmpty(row.orderId, row.id, row.orderNo),
      firstNonEmpty(row.orderNo),
      firstNonEmpty(row.billno),
    ].filter(Boolean);
    for (const key of keys) {
      if (!byOrder.has(key)) byOrder.set(key, []);
      byOrder.get(key).push(row);
    }
  }
  return byOrder;
}

function mergeDuplicateFlags(left, right) {
  if (!left) return right;
  if (!right) return left;
  const isCod = left.is_cod === true || right.is_cod === true
    ? true
    : left.is_cod === false || right.is_cod === false
      ? false
      : null;
  const chosen = right.is_cod === true && left.is_cod !== true ? right : left;
  return {
    ...chosen,
    created_date: [left.created_date, right.created_date].filter(Boolean).sort()[0] || chosen.created_date,
    is_cod: isCod,
    payment_method: isCod === true ? 'COD' : isCod === false ? 'NON_COD' : chosen.payment_method,
    raw_evidence: {
      merged: true,
      left: left.raw_evidence,
      right: right.raw_evidence,
    },
    updated_at: new Date().toISOString(),
  };
}

export function extractPaymentFlagsFromSalesArtifact(data, options = {}) {
  const date = options.date || data?.start || data?.date || '';
  const sourceFile = options.sourceFile || '';
  const sourceKind = options.sourceKind || (data?.source === 'shein-openapi' ? 'openapi' : 'browser_webapi');
  const fallbackByOrder = groupFallbackRowsByOrder(data);
  const out = new Map();
  for (const [idx, order] of asArray(data?.orders).entries()) {
    if (!order || typeof order !== 'object') continue;
    const fallbackKeys = [
      firstNonEmpty(order.id, order.orderId, order.orderNo),
      firstNonEmpty(order.orderNo),
      firstNonEmpty(order.billno),
    ].filter(Boolean);
    const fallbackRows = fallbackKeys.flatMap((key) => fallbackByOrder.get(key) || []);
    const row = buildFlagRow({data, order, date, sourceFile, sourceKind, fallbackRows, idx});
    if (!row.store_key || !row.order_no) continue;
    out.set(row.order_key, mergeDuplicateFlags(out.get(row.order_key), row));
  }

  // Some older or transformed artifacts may only have normalized orderRows.
  // They cannot prove COD unless the fetcher already put `isCod` there, but
  // keeping the fallback makes future transformations robust.
  if (!out.size) {
    for (const [idx, row] of asArray(data?.orderRows).entries()) {
      const pseudoOrder = {
        id: row.orderId || row.id || row.orderNo,
        orderId: row.orderId,
        orderNo: row.orderNo,
        billno: row.billno,
        orderStatus: row.orderStatus,
        orderType: row.orderType,
        isCod: row.isCod,
        paymentTime: row.paymentTime,
        paymentInfo: row.paymentInfo,
        tagCodeList: row.tagCodeList,
        orderCreateTime: row.orderCreateTime,
        allocateTimeFull: row.allocateTimeFull,
      };
      const rowOut = buildFlagRow({
        data,
        order: pseudoOrder,
        date,
        sourceFile,
        sourceKind,
        fallbackRows: [row],
        idx,
      });
      if (!rowOut.store_key || !rowOut.order_no) continue;
      out.set(rowOut.order_key, mergeDuplicateFlags(out.get(rowOut.order_key), rowOut));
    }
  }
  return [...out.values()];
}
