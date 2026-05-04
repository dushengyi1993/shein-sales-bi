#!/usr/bin/env node
import {spawn} from 'node:child_process';

function pad2(n) { return String(n).padStart(2, '0'); }
function previousBeijingMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(new Date()).reduce((a,p)=>{ if(p.type!=='literal') a[p.type]=p.value; return a; }, {});
  const d = new Date(`${parts.year}-${parts.month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}`;
}
const month = process.argv.includes('--month') ? process.argv[process.argv.indexOf('--month') + 1] : previousBeijingMonth();
const passthrough = [];
for (let i = 0; i < process.argv.slice(2).length; i++) {
  const a = process.argv.slice(2)[i];
  if (a === '--month') { i++; continue; }
  passthrough.push(a);
}
const args = ['scripts/setup_lark_dashboard_main_v3.mjs', '--month', month, '--name', 'SHEIN\u7ecf\u8425\u770b\u677f v3-\u4e0a\u6708', '--source-prefix', 'PREV', '--period-mode', 'month', ...passthrough];
const child = spawn(process.execPath, args, {stdio:'inherit'});
child.on('exit', code => process.exit(code ?? 1));
