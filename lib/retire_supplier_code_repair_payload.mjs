const WASTE_PREFIX_PATTERN = /^（\s*废\s*）|^\(\s*废\s*\)/;

export const PRODUCT_MODEL_ATTRIBUTE_ID = 1000546;
export const POWER_SUPPLY_ATTRIBUTE_ID = 147;
export const POWER_SUPPLY_WALL_PLUG_VALUE_ID = 1047;
export const PLUG_VOLTAGE_ATTRIBUTE_ID = 1001466;
export const VOLTAGE_ATTRIBUTE_ID = 1000101;
export const RATED_VOLTAGE_ATTRIBUTE_ID = 1000935;
export const VOLTAGE_VALUE_ATTRIBUTE_ID = 1001974;
export const INPUT_VOLTAGE_ATTRIBUTE_ID = 1002322;
export const INPUT_CURRENT_ATTRIBUTE_ID = 1002323;
export const INPUT_VOLTAGE_AC_VALUE_ID = 301114341;
export const INPUT_CURRENT_A_VALUE_ID = 304301999;
export const INPUT_CURRENT_MA_VALUE_ID = 304302428;
export const HAZARD_CATEGORY_ATTRIBUTE_ID = 1000462;
export const HAZARD_CATEGORY_NON_TRANSPORT_SENSITIVE_VALUE_ID = 1006206;
export const HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID = 1002328;
export const DEFAULT_TITLE_MAX = {ar: 325};

export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function safeString(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function normalizeAttributeId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? Math.trunc(id) : null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function normalizeNumericOrString(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const text = String(value).trim();
  const n = Number(text);
  return Number.isFinite(n) && text !== '' ? n : text;
}

function englishOrAny(rows, keys) {
  const list = asArray(rows);
  const preferred = list.find(row => safeString(row?.language || row?.lang, 20).toLowerCase() === 'en') || list[0] || null;
  for (const key of keys) {
    const value = preferred?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

export function hasWastePrefix(value) {
  return WASTE_PREFIX_PATTERN.test(safeString(value, 260));
}

export function wasteGoodsSn(row) {
  const suggested = safeString(row?.suggested_waste_goods_sn || row?.waste_goods_sn || row?.expectedWaste || '', 260);
  if (suggested) return suggested;
  const standard = safeString(row?.standard_goods_sn || row?.standardGoodsSn || row?.goods_sn || '', 240);
  return hasWastePrefix(standard) ? standard : `${WASTE_PREFIX}${standard}`;
}

export const WASTE_PREFIX = '（废）';

export function targetKey(row) {
  return `${safeString(row?.store || row?.storeKey, 40).toUpperCase()}|${safeString(row?.skc || row?.skcName, 180)}`;
}

export function extractAttributeLabel(row) {
  return safeString(
    row?.attribute_name
    || row?.attributeName
    || row?.attribute_name_en
    || row?.attributeNameEn
    || englishOrAny(row?.attributeMultiList || row?.attribute_multi_list, ['attributeName', 'attribute_name'])
    || row?.attribute_id
    || row?.attributeId,
    180,
  );
}

export function extractAttributeValueLabel(row) {
  return safeString(
    row?.attribute_value
    || row?.attributeValue
    || row?.value
    || row?.attribute_value_name
    || row?.attributeValueName
    || englishOrAny(row?.attributeValueMultiList || row?.attribute_value_multi_list, ['attributeValueName', 'attribute_value_name'])
    || '',
    240,
  );
}

export function normalizeOpenApiProductAttribute(row) {
  if (!row || typeof row !== 'object') return null;
  const attributeId = normalizeAttributeId(row.attribute_id ?? row.attributeId);
  if (!attributeId) return null;
  const attributeValueId = normalizeAttributeId(row.attribute_value_id ?? row.attributeValueId);
  const attributeExtraValue = firstNonEmpty(
    row.attribute_extra_value,
    row.attributeExtraValue,
    row.attribute_value,
    row.attributeValue,
    row.value,
  );
  const out = {attribute_id: attributeId};
  if (attributeValueId && attributeValueId !== 0) out.attribute_value_id = attributeValueId;
  if (attributeExtraValue !== '') out.attribute_extra_value = safeString(attributeExtraValue, 500);
  return out;
}

export function productAttributesFromSpuInfo(info) {
  return asArray(info?.productAttributeInfoList || info?.product_attribute_info_list)
    .map(row => ({source: row, normalized: normalizeOpenApiProductAttribute(row), label: extractAttributeLabel(row), valueLabel: extractAttributeValueLabel(row)}))
    .filter(item => item.normalized);
}

export function normalizeTemplateAttributeRows(data) {
  const out = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const attributeId = normalizeAttributeId(node.attribute_id ?? node.attributeId);
    if (attributeId && (
      node.attribute_mode !== undefined
      || node.attributeMode !== undefined
      || node.attribute_value_info_list
      || node.attributeValueInfoList
      || node.attribute_name
      || node.attributeName
    )) {
      out.push({
        attribute_id: attributeId,
        attribute_name: safeString(node.attribute_name ?? node.attributeName ?? node.attribute_name_en ?? node.attributeNameEn ?? '', 180),
        attribute_mode: Number(node.attribute_mode ?? node.attributeMode),
        attribute_type: Number(node.attribute_type ?? node.attributeType),
        attribute_status: Number(node.attribute_status ?? node.attributeStatus),
        attribute_value_info_list: asArray(node.attribute_value_info_list || node.attributeValueInfoList).map(value => ({
          attribute_value_id: normalizeAttributeId(value?.attribute_value_id ?? value?.attributeValueId),
          attribute_value: safeString(value?.attribute_value ?? value?.attributeValue ?? value?.attribute_value_en ?? value?.attributeValueEn ?? '', 120),
          is_custom_attribute_value: Boolean(value?.is_custom_attribute_value ?? value?.isCustomAttributeValue),
        })).filter(value => value.attribute_value_id || value.attribute_value),
      });
    }
    for (const child of Object.values(node)) {
      if (child && typeof child === 'object') visit(child);
    }
  }
  visit(data?.info || data);
  const byId = new Map();
  for (const row of out) if (!byId.has(row.attribute_id)) byId.set(row.attribute_id, row);
  return [...byId.values()];
}

function templateValueIds(templateRow) {
  return new Set(asArray(templateRow?.attribute_value_info_list).map(row => normalizeAttributeId(row?.attribute_value_id)).filter(Boolean));
}

export function pruneProductAttributesWithTemplate(attributeItems, templateRows) {
  const byId = new Map(asArray(templateRows).map(row => [normalizeAttributeId(row.attribute_id), row]).filter(([id]) => id));
  const kept = [];
  const pruned = [];
  for (const item of asArray(attributeItems)) {
    const row = jsonClone(item.normalized || item);
    const attributeId = normalizeAttributeId(row?.attribute_id ?? row?.attributeId);
    if (!attributeId) continue;
    const template = byId.get(attributeId);
    if (!template) {
      pruned.push({attribute_id: attributeId, reason: 'attribute_not_in_current_template', label: item.label || ''});
      continue;
    }
    const valueId = normalizeAttributeId(row.attribute_value_id ?? row.attributeValueId);
    const values = templateValueIds(template);
    const extra = safeString(row.attribute_extra_value ?? row.attributeExtraValue ?? '', 500);
    if (valueId && values.size && !values.has(valueId) && !extra) {
      pruned.push({attribute_id: attributeId, attribute_value_id: valueId, reason: 'attribute_value_id_not_in_current_template', label: item.label || template.attribute_name || ''});
      continue;
    }
    if (valueId && values.size && !values.has(valueId) && extra && Number(template.attribute_mode) !== 4) {
      pruned.push({attribute_id: attributeId, attribute_value_id: valueId, reason: 'attribute_value_id_not_in_current_template_non_manual', label: item.label || template.attribute_name || ''});
      continue;
    }
    kept.push(row);
  }
  return {rows: dedupeAttributesById(kept), pruned};
}

export function dedupeAttributesById(rows) {
  const byId = new Map();
  for (const row of asArray(rows)) {
    const id = normalizeAttributeId(row?.attribute_id ?? row?.attributeId);
    if (!id) continue;
    byId.set(id, {...row, attribute_id: id});
  }
  return [...byId.values()];
}

function attrText(item) {
  const row = item?.source || item;
  return [
    item?.label,
    item?.valueLabel,
    row?.attribute_extra_value,
    row?.attributeExtraValue,
    row?.attribute_value,
    row?.attributeValue,
    row?.value,
    englishOrAny(row?.attributeValueMultiList || row?.attribute_value_multi_list, ['attributeValueName', 'attribute_value_name']),
  ].map(value => safeString(value, 240)).filter(Boolean).join(' ');
}

export function extractVoltageRangeText(value) {
  const text = safeString(value, 300);
  if (!text) return '';
  const range = text.match(/([0-9]{2,3}(?:\.[0-9]+)?)\s*V?\s*[-–—~至到]\s*([0-9]{2,3}(?:\.[0-9]+)?)\s*V/i);
  if (range) return `${range[1]}-${range[2]}`;
  const single = text.match(/([0-9]{2,3}(?:\.[0-9]+)?)\s*V/i);
  return single ? single[1] : '';
}

export function inferInputVoltage(attributeItems) {
  const priority = [PLUG_VOLTAGE_ATTRIBUTE_ID, VOLTAGE_ATTRIBUTE_ID, RATED_VOLTAGE_ATTRIBUTE_ID, VOLTAGE_VALUE_ATTRIBUTE_ID];
  for (const id of priority) {
    for (const item of attributeItems) {
      const attributeId = normalizeAttributeId(item.normalized?.attribute_id ?? item.attribute_id ?? item.source?.attributeId);
      if (attributeId !== id) continue;
      const voltage = extractVoltageRangeText(attrText(item));
      if (voltage) return {attribute_extra_value: voltage, source_attribute_id: id, source_value: attrText(item)};
    }
  }
  return null;
}

export function existingInputVoltage(attributeItems) {
  for (const item of attributeItems) {
    const row = item.normalized || item;
    if (normalizeAttributeId(row.attribute_id ?? row.attributeId) !== INPUT_VOLTAGE_ATTRIBUTE_ID) continue;
    const extra = safeString(row.attribute_extra_value ?? row.attributeExtraValue ?? '', 80);
    const valueId = normalizeAttributeId(row.attribute_value_id ?? row.attributeValueId);
    if (extra && valueId) return {attribute_extra_value: extra, attribute_value_id: valueId, source: 'existing_input_voltage'};
  }
  return null;
}

function parseNumber(value) {
  const match = safeString(value, 240).match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseCurrentCandidate(value) {
  const text = safeString(value, 240);
  const n = parseNumber(text);
  if (!n) return null;
  if (/ma|毫安/i.test(text)) return {attribute_extra_value: String(Math.round(n)), attribute_value_id: INPUT_CURRENT_MA_VALUE_ID, unit: 'mA', source_value: text};
  if (/(^|[^m])a\b|安/i.test(text)) return {attribute_extra_value: stripTrailingZeros(n), attribute_value_id: INPUT_CURRENT_A_VALUE_ID, unit: 'A', source_value: text};
  return null;
}

function stripTrailingZeros(value) {
  return Number(value).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function voltageLow(voltageText) {
  const nums = safeString(voltageText, 100).match(/[0-9]+(?:\.[0-9]+)?/g)?.map(Number).filter(Number.isFinite) || [];
  if (!nums.length) return null;
  return Math.min(...nums.filter(n => n > 0));
}

function parseWatts(value) {
  const text = safeString(value, 240);
  if (!/w\b|瓦|功率|power/i.test(text)) return null;
  const n = parseNumber(text);
  return n && n > 0 ? n : null;
}

export function existingInputCurrent(attributeItems) {
  for (const item of attributeItems) {
    const row = item.normalized || item;
    if (normalizeAttributeId(row.attribute_id ?? row.attributeId) !== INPUT_CURRENT_ATTRIBUTE_ID) continue;
    const extra = safeString(row.attribute_extra_value ?? row.attributeExtraValue ?? '', 80);
    const valueId = normalizeAttributeId(row.attribute_value_id ?? row.attributeValueId);
    if (extra && valueId) return {attribute_extra_value: extra, attribute_value_id: valueId, source: 'existing_input_current'};
  }
  return null;
}

export function inferInputCurrent(attributeItems, {voltage = '', hint = null} = {}) {
  const existing = existingInputCurrent(attributeItems);
  if (existing) return existing;
  if (hint?.attribute_extra_value && normalizeAttributeId(hint.attribute_value_id)) {
    return {...hint, source: hint.source || 'sibling_current_hint'};
  }
  for (const item of attributeItems) {
    const attributeId = normalizeAttributeId(item.normalized?.attribute_id ?? item.attribute_id ?? item.source?.attributeId);
    if (attributeId === INPUT_CURRENT_ATTRIBUTE_ID) continue;
    const text = attrText(item);
    if (!/current|电流|تيار/i.test(`${item.label || ''} ${text}`)) continue;
    const parsed = parseCurrentCandidate(text);
    if (parsed) return {...parsed, source: `attribute_${attributeId || 'unknown'}`};
  }
  const low = voltageLow(voltage);
  if (low) {
    for (const item of attributeItems) {
      const attributeId = normalizeAttributeId(item.normalized?.attribute_id ?? item.attribute_id ?? item.source?.attributeId);
      if (attributeId === POWER_SUPPLY_ATTRIBUTE_ID) continue;
      const text = `${item.label || ''} ${attrText(item)}`;
      const watts = parseWatts(text);
      if (!watts) continue;
      const amps = watts / low;
      if (amps > 0 && amps < 100) {
        return {attribute_extra_value: stripTrailingZeros(amps), attribute_value_id: INPUT_CURRENT_A_VALUE_ID, unit: 'A', source: `watts_over_voltage_attribute_${attributeId || 'unknown'}`, source_value: safeString(text, 240)};
      }
    }
  }
  return null;
}

function templateHasValue(templateRows, attributeId, valueId) {
  const template = asArray(templateRows).find(row => normalizeAttributeId(row.attribute_id) === attributeId);
  if (!template) return false;
  const values = templateValueIds(template);
  return values.has(valueId);
}

function findTemplateRow(templateRows, attributeId) {
  return asArray(templateRows).find(row => normalizeAttributeId(row?.attribute_id ?? row?.attributeId) === attributeId) || null;
}

function chooseTemplateValueId(templateRows, attributeId, matcher, fallbackValueId = null) {
  const template = findTemplateRow(templateRows, attributeId);
  const values = asArray(template?.attribute_value_info_list || template?.attributeValueInfoList);
  const fallback = normalizeAttributeId(fallbackValueId);
  if (fallback && values.some(row => normalizeAttributeId(row?.attribute_value_id ?? row?.attributeValueId) === fallback)) return fallback;
  const hit = values.find(row => matcher(safeString(row?.attribute_value ?? row?.attributeValue ?? row?.attribute_value_en ?? row?.attributeValueEn ?? '', 120)));
  if (hit) return normalizeAttributeId(hit.attribute_value_id ?? hit.attributeValueId);
  return values.length === 1 ? normalizeAttributeId(values[0]?.attribute_value_id ?? values[0]?.attributeValueId) : null;
}

function chooseInputVoltageValueId(templateRows) {
  return chooseTemplateValueId(templateRows, INPUT_VOLTAGE_ATTRIBUTE_ID, value => /vac|v\s*ac|交流/i.test(value), INPUT_VOLTAGE_AC_VALUE_ID);
}

function upsertAttribute(rows, nextRow) {
  const id = normalizeAttributeId(nextRow?.attribute_id ?? nextRow?.attributeId);
  if (!id) return false;
  const existing = rows.find(row => normalizeAttributeId(row.attribute_id ?? row.attributeId) === id);
  if (existing) Object.assign(existing, nextRow, {attribute_id: id});
  else rows.push({...nextRow, attribute_id: id});
  return true;
}

export function ensureWallPlugInputPowerAttributes({
  rows,
  sourceAttributeItems,
  templateRows,
  inputCurrentHint = null,
  inputVoltageHint = null,
  requiredLinkedAttributeIds = null,
}) {
  const nextRows = dedupeAttributesById(rows).map(row => ({...row}));
  const powerSupply = nextRows.find(row => normalizeAttributeId(row.attribute_id) === POWER_SUPPLY_ATTRIBUTE_ID);
  const powerSupplyValueId = normalizeAttributeId(powerSupply?.attribute_value_id);
  const applied = [];
  const blockers = [];
  if (powerSupplyValueId !== POWER_SUPPLY_WALL_PLUG_VALUE_ID) return {rows: nextRows, applied, blockers};
  const linkedRequired = requiredLinkedAttributeIds == null
    ? null
    : new Set(asArray(requiredLinkedAttributeIds).map(normalizeAttributeId).filter(Boolean));
  const requireVoltage = linkedRequired == null || linkedRequired.has(INPUT_VOLTAGE_ATTRIBUTE_ID);
  const requireCurrent = linkedRequired == null || linkedRequired.has(INPUT_CURRENT_ATTRIBUTE_ID);

  const voltageExisting = nextRows.find(row => normalizeAttributeId(row.attribute_id) === INPUT_VOLTAGE_ATTRIBUTE_ID);
  const voltageHasValue = safeString(voltageExisting?.attribute_extra_value, 120) && normalizeAttributeId(voltageExisting?.attribute_value_id);
  let voltage = voltageHasValue
    ? {attribute_extra_value: safeString(voltageExisting.attribute_extra_value, 120), attribute_value_id: normalizeAttributeId(voltageExisting.attribute_value_id), source: 'existing_input_voltage'}
    : (inputVoltageHint?.attribute_extra_value ? inputVoltageHint : inferInputVoltage(sourceAttributeItems));
  if (voltage?.attribute_extra_value && !normalizeAttributeId(voltage.attribute_value_id)) {
    voltage = {...voltage, attribute_value_id: chooseInputVoltageValueId(templateRows)};
  }
  if (requireVoltage && (!voltage?.attribute_extra_value || !normalizeAttributeId(voltage.attribute_value_id))) {
    blockers.push(`Power Supply=Wall Plug requires Input voltage(${INPUT_VOLTAGE_ATTRIBUTE_ID}), but voltage could not be inferred from current spu-info attributes.`);
  } else if (requireVoltage && !templateHasValue(templateRows, INPUT_VOLTAGE_ATTRIBUTE_ID, normalizeAttributeId(voltage.attribute_value_id))) {
    blockers.push(`Input voltage(${INPUT_VOLTAGE_ATTRIBUTE_ID}) unit value ${voltage.attribute_value_id} is not present in current attribute template.`);
  } else if (requireVoltage && !voltageHasValue) {
    upsertAttribute(nextRows, {attribute_id: INPUT_VOLTAGE_ATTRIBUTE_ID, attribute_value_id: normalizeAttributeId(voltage.attribute_value_id), attribute_extra_value: safeString(voltage.attribute_extra_value, 120)});
    applied.push(`input_voltage=${voltage.attribute_extra_value}`);
  }

  const currentExisting = nextRows.find(row => normalizeAttributeId(row.attribute_id) === INPUT_CURRENT_ATTRIBUTE_ID);
  const currentHasValue = safeString(currentExisting?.attribute_extra_value, 120) && normalizeAttributeId(currentExisting?.attribute_value_id);
  const current = currentHasValue
    ? {attribute_extra_value: safeString(currentExisting.attribute_extra_value, 120), attribute_value_id: normalizeAttributeId(currentExisting.attribute_value_id), source: 'existing_input_current'}
    : inferInputCurrent(sourceAttributeItems, {voltage: voltage?.attribute_extra_value || '', hint: inputCurrentHint});
  if (requireCurrent && (!current?.attribute_extra_value || !normalizeAttributeId(current.attribute_value_id))) {
    blockers.push(`Power Supply=Wall Plug requires Input current(${INPUT_CURRENT_ATTRIBUTE_ID}), but current could not be inferred from current spu-info, sibling current, or power/voltage attributes.`);
  } else if (requireCurrent && !templateHasValue(templateRows, INPUT_CURRENT_ATTRIBUTE_ID, normalizeAttributeId(current.attribute_value_id))) {
    blockers.push(`Input current(${INPUT_CURRENT_ATTRIBUTE_ID}) unit value ${current.attribute_value_id} is not present in current attribute template.`);
  } else if (requireCurrent && !currentHasValue) {
    upsertAttribute(nextRows, {attribute_id: INPUT_CURRENT_ATTRIBUTE_ID, attribute_value_id: normalizeAttributeId(current.attribute_value_id), attribute_extra_value: safeString(current.attribute_extra_value, 120)});
    applied.push(`input_current=${current.attribute_extra_value}${current.attribute_value_id === INPUT_CURRENT_MA_VALUE_ID ? 'mA' : 'A'}`);
  }
  return {rows: dedupeAttributesById(nextRows), applied, blockers};
}

function payloadAttributeHasValue(row) {
  if (!row || typeof row !== 'object') return false;
  return Boolean(
    normalizeAttributeId(row.attribute_value_id ?? row.attributeValueId)
    || safeString(row.attribute_extra_value ?? row.attributeExtraValue ?? row.attribute_value ?? row.attributeValue ?? '', 500),
  );
}

function chooseNonDangerousGoodsValueId(templateRow) {
  const values = asArray(templateRow?.attribute_value_info_list || templateRow?.attributeValueInfoList);
  const exact = values.find(value => /this product is not classified as dangerous goods|该商品不属于危险品|此商品不属于危险品/i.test(safeString(value?.attribute_value ?? value?.attributeValue, 240)));
  if (exact) return normalizeAttributeId(exact.attribute_value_id ?? exact.attributeValueId);
  const fallback = values.find(value => /not (?:classified as )?dangerous goods|non[-\s]?dangerous|非危险品|不属于危险品/i.test(safeString(value?.attribute_value ?? value?.attributeValue, 240)));
  return normalizeAttributeId(fallback?.attribute_value_id ?? fallback?.attributeValueId);
}

export function ensureHazardousMaterialsClassification({rows, templateRows, classificationHint = null}) {
  const nextRows = dedupeAttributesById(rows).map(row => ({...row}));
  const applied = [];
  const blockers = [];
  const template = findTemplateRow(templateRows, HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID);
  if (!template) return {rows: nextRows, applied, blockers};
  const existing = nextRows.find(row => normalizeAttributeId(row.attribute_id ?? row.attributeId) === HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID);
  if (payloadAttributeHasValue(existing)) return {rows: nextRows, applied, blockers};
  const hintedValueId = normalizeAttributeId(classificationHint?.attribute_value_id ?? classificationHint?.attributeValueId);
  if (hintedValueId) {
    if (!templateHasValue(templateRows, HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID, hintedValueId)) {
      blockers.push(`Hazardous materials classification(${HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID}) hint value ${hintedValueId} is not present in the current template.`);
      return {rows: nextRows, applied, blockers};
    }
    upsertAttribute(nextRows, {attribute_id: HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID, attribute_value_id: hintedValueId});
    applied.push(`hazardous_materials_classification=approved_or_sibling_hint_${hintedValueId}`);
    return {rows: dedupeAttributesById(nextRows), applied, blockers};
  }
  // A transport category is not proof of the product's dangerous-goods
  // classification.  Never infer this legally significant value from a
  // neighbouring attribute; require an existing value or reviewed hint.
  if (Number(template?.attribute_status ?? template?.attributeStatus) === 3) {
    blockers.push(`Hazardous materials classification(${HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID}) is required; provide an approved product-specific or unanimous sibling hint.`);
  }
  return {rows: nextRows, applied, blockers};
}

export function requiredTemplateAttributeBlockers(rows, templateRows) {
  const blockers = [];
  for (const template of asArray(templateRows)) {
    if (Number(template?.attribute_status ?? template?.attributeStatus) !== 3) continue;
    const attributeId = normalizeAttributeId(template?.attribute_id ?? template?.attributeId);
    if (!attributeId) continue;
    const row = asArray(rows).find(item => normalizeAttributeId(item?.attribute_id ?? item?.attributeId) === attributeId);
    if (payloadAttributeHasValue(row)) continue;
    const label = safeString(template?.attribute_name ?? template?.attributeName ?? `Required attribute ${attributeId}`, 180);
    blockers.push(`${label}(${attributeId}) is required by the current SHEIN product type template.`);
  }
  return blockers;
}

export function applyRequiredTemplateAttributeHints({rows, templateRows, hints = null}) {
  const nextRows = dedupeAttributesById(rows).map(row => ({...row}));
  const applied = [];
  const blockers = [];
  for (const [rawAttributeId, hint] of Object.entries(hints || {})) {
    const attributeId = normalizeAttributeId(rawAttributeId);
    if (!attributeId) continue;
    const template = findTemplateRow(templateRows, attributeId);
    if (!template || Number(template?.attribute_status ?? template?.attributeStatus) !== 3) continue;
    const existing = nextRows.find(row => normalizeAttributeId(row?.attribute_id ?? row?.attributeId) === attributeId);
    if (payloadAttributeHasValue(existing)) continue;
    const valueId = normalizeAttributeId(hint?.attribute_value_id ?? hint?.attributeValueId);
    const extraValue = safeString(hint?.attribute_extra_value ?? hint?.attributeExtraValue ?? '', 500);
    if (valueId && !templateHasValue(templateRows, attributeId, valueId)) {
      blockers.push(`Required attribute ${attributeId} hint value ${valueId} is not present in the current template.`);
      continue;
    }
    if (!valueId && !extraValue) {
      blockers.push(`Required attribute ${attributeId} hint is empty.`);
      continue;
    }
    const row = {attribute_id: attributeId};
    if (valueId) row.attribute_value_id = valueId;
    if (extraValue) row.attribute_extra_value = extraValue;
    upsertAttribute(nextRows, row);
    applied.push(`required_attribute_hint_${attributeId}=${valueId || extraValue}`);
  }
  return {rows: dedupeAttributesById(nextRows), applied, blockers};
}

export function namesFromSpuInfo(info, skcName = '') {
  const skcs = asArray(info?.skcInfoList || info?.skc_info_list || info?.skcList || info?.skc_list);
  const matched = skcs.find(row => safeString(row?.skcName || row?.skc_name || row?.skc, 180) === safeString(skcName, 180)) || skcs[0] || null;
  const rows = [
    ...asArray(matched?.productMultiNameList || matched?.product_multi_name_list),
    ...asArray(info?.productMultiNameList || info?.product_multi_name_list),
  ];
  const byLanguage = new Map();
  for (const row of rows) {
    const language = safeString(row?.language || row?.lang || row?.languageCode || '', 40).toLowerCase();
    const name = safeString(row?.name || row?.productName || row?.product_name || row?.value || '', 2000);
    if (!language || !name || byLanguage.has(language)) continue;
    byLanguage.set(language, {language, name});
  }
  return [...byLanguage.values()];
}

export function titleMaxLengthMap(fillStandardInfo = {}) {
  const out = new Map();
  for (const row of asArray(fillStandardInfo.language_title_max_length_list || fillStandardInfo.languageTitleMaxLengthList)) {
    const language = safeString(row?.language || row?.lang || '', 40).toLowerCase();
    const max = Number(row?.max_length ?? row?.maxLength);
    if (language && Number.isFinite(max) && max > 0) out.set(language, Math.trunc(max));
  }
  const defaultLanguage = safeString(fillStandardInfo.default_language || fillStandardInfo.defaultLanguage || '', 40).toLowerCase();
  const defaultMax = Number(fillStandardInfo.default_language_title_max_length ?? fillStandardInfo.defaultLanguageTitleMaxLength);
  if (defaultLanguage && Number.isFinite(defaultMax) && defaultMax > 0 && !out.has(defaultLanguage)) out.set(defaultLanguage, Math.trunc(defaultMax));
  for (const [language, max] of Object.entries(DEFAULT_TITLE_MAX)) if (!out.has(language)) out.set(language, max);
  return out;
}

export function defaultLanguageFromFillStandard(fillStandardInfo = {}) {
  return safeString(fillStandardInfo.default_language || fillStandardInfo.defaultLanguage || 'ar', 40).toLowerCase() || 'ar';
}

export function applyTitleLengthGuard(names, {fillStandardInfo = {}, defaultLanguage = ''} = {}) {
  const maxByLanguage = titleMaxLengthMap(fillStandardInfo);
  const defaultLang = safeString(defaultLanguage, 40).toLowerCase() || defaultLanguageFromFillStandard(fillStandardInfo);
  const out = [];
  const applied = [];
  const byLanguage = new Map();
  for (const row of asArray(names)) {
    const language = safeString(row?.language || '', 40).toLowerCase();
    let name = safeString(row?.name || '', 2000);
    if (!language || !name || byLanguage.has(language)) continue;
    const max = maxByLanguage.get(language);
    if (max && name.length > max) {
      name = name.slice(0, max);
      applied.push(`title_${language}_truncate_${max}`);
    }
    const next = {language, name};
    byLanguage.set(language, next);
    out.push(next);
  }
  const defaultTitle = byLanguage.get(defaultLang)?.name || out[0]?.name || '';
  return {names: out, defaultLanguage: defaultLang, defaultTitle, applied: [...new Set(applied)], maxByLanguage: Object.fromEntries(maxByLanguage.entries())};
}

export function buildSupplierCodeRepairPayload({
  row,
  spuInfo,
  attributeTemplateRows = [],
  fillStandardInfo = {},
  inputCurrentHint = null,
  inputVoltageHint = null,
  hazardousClassificationHint = null,
  requiredAttributeHints = null,
  requiredLinkedAttributeIds = null,
}) {
  const info = spuInfo?.info || spuInfo || {};
  const skcName = safeString(row?.skc || row?.skcName, 180);
  const sourceAttributes = productAttributesFromSpuInfo(info);
  const pruned = pruneProductAttributesWithTemplate(sourceAttributes, attributeTemplateRows);
  const power = ensureWallPlugInputPowerAttributes({
    rows: pruned.rows,
    sourceAttributeItems: sourceAttributes,
    templateRows: attributeTemplateRows,
    inputCurrentHint,
    inputVoltageHint,
    requiredLinkedAttributeIds,
  });
  const hazardous = ensureHazardousMaterialsClassification({
    rows: power.rows,
    templateRows: attributeTemplateRows,
    classificationHint: hazardousClassificationHint,
  });
  const requiredHints = applyRequiredTemplateAttributeHints({
    rows: hazardous.rows,
    templateRows: attributeTemplateRows,
    hints: requiredAttributeHints,
  });
  const names = applyTitleLengthGuard(namesFromSpuInfo(info, skcName), {fillStandardInfo});
  const blockers = [
    ...power.blockers,
    ...hazardous.blockers,
    ...requiredHints.blockers,
    ...requiredTemplateAttributeBlockers(requiredHints.rows, attributeTemplateRows),
  ];
  if (!names.names.length) blockers.push('missing_multi_language_name_list_from_spu_info');
  if (!names.defaultTitle) blockers.push(`missing_default_language_title_${names.defaultLanguage}`);
  const skc = {
    skc_name: skcName,
    supplier_code: wasteGoodsSn(row),
  };
  if (names.defaultTitle) skc.skc_title = names.defaultTitle;
  const candidateBody = {
    spu_name: safeString(row?.spu || row?.spuName || info?.spuName || info?.spu_name, 180),
    multi_language_name_list: names.names,
    product_attribute_list: requiredHints.rows,
    skc_list: [skc],
  };
  return {
    body: blockers.length ? null : candidateBody,
    blockers,
    applied: [...new Set([...pruned.pruned.map(item => `pruned_${item.attribute_id}_${item.reason}`), ...power.applied, ...hazardous.applied, ...requiredHints.applied, ...names.applied])],
    evidence: {
      productTypeId: info.productTypeId ?? info.product_type_id ?? null,
      categoryId: info.categoryId ?? info.category_id ?? null,
      productAttributeCount: candidateBody.product_attribute_list.length,
      prunedAttributes: pruned.pruned,
      defaultLanguage: names.defaultLanguage,
      titleMaxLength: names.maxByLanguage,
      defaultTitleLength: names.defaultTitle.length,
      hasInputVoltage: candidateBody.product_attribute_list.some(row => normalizeAttributeId(row.attribute_id) === INPUT_VOLTAGE_ATTRIBUTE_ID),
      hasInputCurrent: candidateBody.product_attribute_list.some(row => normalizeAttributeId(row.attribute_id) === INPUT_CURRENT_ATTRIBUTE_ID),
      requiredLinkedAttributeIds: requiredLinkedAttributeIds == null
        ? null
        : [...new Set(asArray(requiredLinkedAttributeIds).map(normalizeAttributeId).filter(Boolean))].sort((a, b) => a - b),
      requiredTemplateAttributeIds: attributeTemplateRows
        .filter(row => Number(row?.attribute_status ?? row?.attributeStatus) === 3)
        .map(row => normalizeAttributeId(row?.attribute_id ?? row?.attributeId))
        .filter(Boolean),
      hazardousClassificationHint: hazardousClassificationHint
        ? {
          attributeValueId: normalizeAttributeId(hazardousClassificationHint?.attribute_value_id ?? hazardousClassificationHint?.attributeValueId),
          source: safeString(hazardousClassificationHint?.source || '', 300),
        }
        : null,
      requiredAttributeHintIds: Object.keys(requiredAttributeHints || {}).map(normalizeAttributeId).filter(Boolean),
    },
  };
}

export function inputCurrentFromPayloadAttributes(rows) {
  const row = asArray(rows).find(item => normalizeAttributeId(item?.attribute_id ?? item?.attributeId) === INPUT_CURRENT_ATTRIBUTE_ID);
  if (!row) return null;
  const extra = safeString(row.attribute_extra_value ?? row.attributeExtraValue ?? '', 80);
  const valueId = normalizeAttributeId(row.attribute_value_id ?? row.attributeValueId);
  if (!extra || !valueId) return null;
  return {attribute_extra_value: extra, attribute_value_id: valueId, source: 'sibling_current_hint'};
}

export function isHardExcludedRetireRow(row, {
  store = 'FY',
  standardGoodsSn = 'SK-5110电磁炉',
  skc = 'sv260108224672888369376',
} = {}) {
  const rowStore = safeString(row?.store || row?.storeKey, 40).toUpperCase();
  const expectedStore = safeString(store, 40).toUpperCase();
  if (rowStore !== expectedStore) return false;
  const rowStandard = safeString(row?.standard_goods_sn || row?.standardGoodsSn || row?.goods_sn || '', 260);
  const rowRaw = safeString(row?.raw_goods_sn || row?.rawGoodsSn || '', 260);
  const rowProduct = safeString(row?.product_name || row?.productName || '', 260);
  const rowSkc = safeString(row?.skc || row?.skcName || '', 180);
  const expectedStandard = safeString(standardGoodsSn, 260);
  const expectedSkc = safeString(skc, 180);
  return rowStandard === expectedStandard
    || rowRaw === expectedStandard
    || rowProduct === expectedStandard
    || (expectedSkc && rowSkc === expectedSkc);
}

export function supplierCodeRepairFinalStatus(row) {
  const expected = wasteGoodsSn(row);
  const supplierCode = safeString(
    row?.supplierCode
    || row?.supplier_code
    || row?.post?.supplierCode
    || row?.readback?.supplierCode
    || '',
    260,
  );
  const retired = row?.retired === true
    || row?.retireOk === true
    || row?.readback?.retired === true
    || (row?.post && Number(row.post.siteShelfStatus ?? row.post.skcShelfStatus) !== 1);
  if (!retired) return 'not_retired';
  if (supplierCode === expected) return 'retired+supplierCodeChanged';
  if (row?.partialOk === true || row?.partialVersion || row?.documentState === 1) return 'retired+pendingReview';
  return 'retired+supplierCodeNotChanged';
}
