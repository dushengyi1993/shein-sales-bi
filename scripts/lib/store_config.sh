#!/usr/bin/env bash

configured_store_count() {
  local config_file="${1:-${SHEIN_BI_ROOT:-/opt/shein-bi/app}/config/stores.json}"
  node - "$config_file" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const fallback = ['CX','DL','DX','FY','HL','HY','JSH','JY','LG','LQ','MZ','NM','QH','QY','TS','TZ','TZZ','XC','XL','YJ','ZL'];
try {
  const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const stores = Array.isArray(config?.stores) ? config.stores : [];
  const keys = [...new Set(stores.filter(row => row && row.enabled !== false && row.storeKey)
    .map(row => String(row.storeKey).trim().toUpperCase()).filter(Boolean))];
  process.stdout.write(String(keys.length || fallback.length));
} catch (error) {
  if (error?.code === 'ENOENT') process.stdout.write(String(fallback.length));
  else { process.stderr.write(`${error.message}\n`); process.exit(1); }
}
NODE
}
