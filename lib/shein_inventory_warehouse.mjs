function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function siteCountry(site) {
  const text = String(site || '').trim().toLowerCase();
  const parts = text.split('-').filter(Boolean);
  return String(parts.at(-1) || '').toUpperCase();
}

function warehouseRows(info) {
  const rows = Array.isArray(info?.list) ? info.list : asArray(info);
  return rows
    .map(row => ({
      ...row,
      warehouseCode: String(row?.warehouseCode || row?.warehouse_code || '').trim(),
      saleCountryList: asArray(row?.saleCountryList || row?.sale_country_list)
        .map(value => String(value || '').trim().toUpperCase())
        .filter(Boolean),
    }))
    .filter(row => row.warehouseCode);
}

export function selectVirtualInventoryWarehouseCode(info, {site = 'shein-sa'} = {}) {
  const rows = warehouseRows(info);
  if (rows.length === 1) return rows[0].warehouseCode;
  if (rows.length === 0) throw new Error('Merchant warehouse list returned no usable warehouse code');

  const country = siteCountry(site);
  const countryMatches = country
    ? rows.filter(row => row.saleCountryList.includes(country))
    : [];
  if (countryMatches.length === 1) return countryMatches[0].warehouseCode;
  if (countryMatches.length > 1) {
    throw new Error(`Multiple merchant warehouses match ${country}: ${countryMatches.map(row => row.warehouseCode).join(',')}`);
  }
  throw new Error(`Merchant warehouse is ambiguous: ${rows.map(row => row.warehouseCode).join(',')}`);
}
