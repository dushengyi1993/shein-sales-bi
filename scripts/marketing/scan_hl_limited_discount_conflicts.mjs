import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue');

function parseArgs(argv) {
  const out = {rescue: '', outDir: DEFAULT_OUT_DIR, port: 9360, endCutoff: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--rescue') out.rescue = path.resolve(argv[++i] || '');
    else if (a.startsWith('--rescue=')) out.rescue = path.resolve(a.slice('--rescue='.length));
    else if (a === '--out-dir') out.outDir = path.resolve(argv[++i] || '');
    else if (a.startsWith('--out-dir=')) out.outDir = path.resolve(a.slice('--out-dir='.length));
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice('--port='.length));
    else if (a === '--end-cutoff') out.endCutoff = argv[++i] || '';
    else if (a.startsWith('--end-cutoff=')) out.endCutoff = a.slice('--end-cutoff='.length);
    else if (!a.startsWith('--') && !out.rescue) out.rescue = path.resolve(a);
    else if (!a.startsWith('--')) out.port = Number(a);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!out.rescue) throw new Error('Missing --rescue <rescue-json>. Do not rely on hard-coded one-off batch paths.');
  if (!Number.isFinite(out.port) || out.port <= 0) throw new Error(`Invalid --port: ${out.port}`);
  if (!out.endCutoff) throw new Error('Missing --end-cutoff "YYYY-MM-DD HH:mm:ss" for the rescue activity window.');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const rescuePath = args.rescue;
const outDir = args.outDir;
const port = args.port;
const now = new Date();
const endCutoff = new Date(String(args.endCutoff).replace(' ', 'T') + '+08:00');
if (!Number.isFinite(endCutoff.getTime())) throw new Error(`Invalid --end-cutoff: ${args.endCutoff}`);

const rescue = JSON.parse(await fs.readFile(rescuePath, 'utf8'));
const targetRows = rescue.rows || [];
const targetSkcs = [...new Set(targetRows.map(r => String(r.skc || '').trim()).filter(Boolean))];
await fs.mkdir(outDir, {recursive: true});

async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return await res.json();
}
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.seq = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const {resolve, reject} = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once: true});
      this.ws.addEventListener('error', reject, {once: true});
    });
    await this.call('Runtime.enable');
  }
  call(method, params={}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 120000);
      this.pending.set(id, {resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); }});
    });
  }
  async eval(expression, arg) {
    const res = await this.call('Runtime.evaluate', {expression: `(async()=>{ const __arg=${JSON.stringify(arg)}; ${expression} })()`, awaitPromise: true, returnByValue: true});
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails, null, 2));
    return res.result.value;
  }
  close(){ try{this.ws.close();}catch{} }
}
async function connect(port) {
  const pages = await httpJson(`http://127.0.0.1:${port}/json/list`);
  const page = pages.find(p => p.type === 'page' && String(p.url || '').includes('sso.geiwohuo.com')) || pages.find(p => p.type === 'page');
  if (!page) throw new Error(`No page at ${port}`);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

const cdp = await connect(port);
try {
  const result = await cdp.eval(`
    const headers={'content-type':'application/json;charset=UTF-8'};
    async function post(path, body){
      const res=await fetch('/mrs-api-prefix'+path,{method:'POST',headers,body:JSON.stringify(body),credentials:'include'});
      const text=await res.text(); let json; try{json=JSON.parse(text)}catch{}
      if(!res.ok || !json || json.code !== '0') throw new Error(path+' '+res.status+' '+text.slice(0,500));
      return json.info || json;
    }
    const first = await post('/promotion/obm/query_obm_activity_list',{page_num:1,page_size:200,system:'mrs',ref_tools_id:175});
    const activities = first.data || [];
    const detailed=[];
    for (const act of activities) {
      const goodsInfo = await post('/promotion/simple_platform/query_activity_goods',{activity_id:act.activity_id,page_num:1,page_size:1000});
      const goods = goodsInfo.data || [];
      detailed.push({activity: act, goods});
    }
    return {href: location.href, title: document.title, activities, detailed};
  `, {});

  const targetSet = new Set(targetSkcs);
  const overlaps = [];
  const activeOrFuture = [];
  const allGoodsRows = [];
  for (const entry of result.detailed || []) {
    const a = entry.activity;
    const start = a.start_time ? new Date(String(a.start_time).replace(' ', 'T') + '+08:00') : null;
    const end = a.end_time ? new Date(String(a.end_time).replace(' ', 'T') + '+08:00') : null;
    const overlapsWindow = (!end || end >= now) && (!start || start <= endCutoff);
    const liveState = [2,3].includes(Number(a.state));
    if (liveState && overlapsWindow) activeOrFuture.push(a);
    for (const g of entry.goods || []) {
      const row = {activity_id:a.activity_id, act_name:a.act_name, state:a.state, start_time:a.start_time, end_time:a.end_time, skc:g.skc, sku_supplier_no:g.sku_supplier_no, product_act_price:g.product_act_price, max_product_act_price:g.max_product_act_price, attend_num_sum:g.attend_num_sum, stock_num:g.stock_num, id:g.id, is_sale_attribute:g.is_sale_attribute, goods_state:g.goods_state, error_code:g.error_code};
      allGoodsRows.push(row);
      if (liveState && overlapsWindow && targetSet.has(String(g.skc))) overlaps.push(row);
    }
  }
  const covered = [...new Set(overlaps.map(o => o.skc))];
  const uncovered = targetSkcs.filter(s => !covered.includes(s));
  const doc = {createdAt:new Date().toISOString(), port, rescuePath:path.relative(ROOT,rescuePath), targetCount:targetSkcs.length, activeOrFuture, overlapCount:overlaps.length, overlapSkcCount:covered.length, overlaps, uncoveredCount:uncovered.length, uncovered, allActivityCount:(result.activities||[]).length, allGoodsRows};
  const out = path.join(outDir, `hl-limited-discount-conflict-scan-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  await fs.writeFile(out, JSON.stringify(doc,null,2),'utf8');
  console.log(JSON.stringify({out:path.relative(ROOT,out), targetCount:doc.targetCount, activeOrFuture:activeOrFuture.map(a=>({activity_id:a.activity_id,state:a.state,start:a.start_time,end:a.end_time,name:a.act_name})), overlapCount:doc.overlapCount, overlapSkcCount:doc.overlapSkcCount, uncoveredCount:doc.uncoveredCount, overlaps:overlaps.map(o=>({activity_id:o.activity_id, skc:o.skc, supplier:o.sku_supplier_no, price:o.product_act_price, end:o.end_time}))}, null, 2));
} finally { cdp.close(); }
