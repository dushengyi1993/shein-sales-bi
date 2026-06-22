#!/usr/bin/env node
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {findChromeExecutable} from '../lib/chrome_executable.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {
  baseUrl: process.env.ET_FORWARDER_BASE_URL || 'http://47.90.12.162:9007',
  port: Number(process.env.ET_PROBE_PORT || 9397),
  profileDir: process.env.ET_FORWARDER_PROFILE_DIR
    ? path.resolve(process.env.ET_FORWARDER_PROFILE_DIR)
    : path.join(ROOT, 'profiles', 'persistent-et-forwarder-profile'),
  shipOrderId: process.argv[2] || 'F2604025462250',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function httpJson(url){const r=await fetch(url); if(!r.ok) throw new Error(`${r.status} ${url}`); return r.json()}
async function ready(){try{return !!(await httpJson(`http://127.0.0.1:${args.port}/json/version`)).webSocketDebuggerUrl}catch{return false}}
async function launch(){
  if(await ready()) return;
  const chrome=findChromeExecutable();
  if(!chrome) throw new Error('no chrome');
  await fs.mkdir(args.profileDir,{recursive:true});
  const chromeArgs=[`--remote-debugging-port=${args.port}`,`--user-data-dir=${args.profileDir}`,'--no-first-run','--no-default-browser-check','--disable-popup-blocking','--disable-dev-shm-usage','--no-sandbox','--headless=new','--disable-gpu',args.baseUrl+'/Home/Index'];
  const child=spawn(chrome,chromeArgs,{cwd:ROOT,detached:true,stdio:'ignore',env:{...process.env}});
  child.unref();
  for(let i=0;i<40;i++){if(await ready()) return; await sleep(500)}
  throw new Error('cdp not ready');
}
class Cdp{
  constructor(ws){this.wsUrl=ws;this.seq=1;this.pending=new Map()}
  async connect(){
    this.ws=new WebSocket(this.wsUrl);
    await new Promise((res,rej)=>{this.ws.onopen=res;this.ws.onerror=rej});
    this.ws.onmessage=ev=>{const msg=JSON.parse(ev.data); if(msg.id&&this.pending.has(msg.id)){const p=this.pending.get(msg.id);this.pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result)}};
  }
  call(method,params={}){const id=this.seq++; this.ws.send(JSON.stringify({id,method,params})); return new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject}))}
  async eval(functionText,args=[]){const expression=`(${functionText})(...${JSON.stringify(args)})`; const r=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value}
  close(){try{this.ws.close()}catch{}}
}
async function page(){const pages=await httpJson(`http://127.0.0.1:${args.port}/json/list`); return pages.find(p=>p.type==='page'&&p.webSocketDebuggerUrl&&String(p.url||'').startsWith(args.baseUrl))||pages.find(p=>p.type==='page'&&p.webSocketDebuggerUrl)}

await launch();
const p=await page();
const cdp=new Cdp(p.webSocketDebuggerUrl); await cdp.connect();
const urls=[
  `/Delivery/ShipOrder/Index`,
  `/Delivery/ShipOrder/DetailForm?shipOrderId=${encodeURIComponent(args.shipOrderId)}`,
  `/Delivery/ShipOrder/Detail?shipOrderId=${encodeURIComponent(args.shipOrderId)}`,
  `/Delivery/ShipOrder/Form?shipOrderId=${encodeURIComponent(args.shipOrderId)}`,
  `/Delivery/ShipOrder/DetailView?shipOrderId=${encodeURIComponent(args.shipOrderId)}`,
  `/Delivery/ShipOrder/Trace?shipOrderId=${encodeURIComponent(args.shipOrderId)}`,
  `/Delivery/ShipOrder/Track?shipOrderId=${encodeURIComponent(args.shipOrderId)}`,
  `/Delivery/ShipOrder/Logistics?shipOrderId=${encodeURIComponent(args.shipOrderId)}`,
  `/Delivery/ShipOrder/GetTrace?shipOrderId=${encodeURIComponent(args.shipOrderId)}`,
  `/Delivery/ShipOrder/GetTrack?shipOrderId=${encodeURIComponent(args.shipOrderId)}`,
  `/Delivery/ShipOrder/GetLogistics?shipOrderId=${encodeURIComponent(args.shipOrderId)}`,
  `/Delivery/ShipOrder/GetLogisticsTrace?shipOrderId=${encodeURIComponent(args.shipOrderId)}`,
  `/Delivery/ShipOrder/GetLogisticsTrack?shipOrderId=${encodeURIComponent(args.shipOrderId)}`,
  `/Delivery/ShipOrder/GetShipOrderTrack?shipOrderId=${encodeURIComponent(args.shipOrderId)}`,
];
const fetchOne = async (u) => {
  const target=new URL(u, location.origin).href;
  const r=await fetch(target,{credentials:'include',headers:{'X-Requested-With':'XMLHttpRequest','Accept':'application/json, text/javascript, text/html, */*; q=0.01'}});
  const text=await r.text();
  let json=null; try{json=JSON.parse(text)}catch(e){}
  const scriptMatches=[];
  const patterns=[
    /url\s*:\s*['"]([^'"]+)/g,
    /fetch\(\s*['"]([^'"]+)/g,
    /\$\.get(?:JSON)?\(\s*['"]([^'"]+)/g,
    /\$\.post\(\s*['"]([^'"]+)/g,
  ];
  for(const re of patterns){let m; while((m=re.exec(text))&&scriptMatches.length<120)scriptMatches.push(m[1]);}
  const textMatches=[];
  const methodRe=/Get[A-Za-z0-9_]*(?:Trace|Track|Logistic|Logistics|Time|Detail|Route)[A-Za-z0-9_]*/g;
  let mm; while((mm=methodRe.exec(text))&&textMatches.length<120)textMatches.push(mm[0]);
  return {u,status:r.status,url:r.url,contentType:r.headers.get('content-type')||'',title:(text.match(/<title>([^<]+)/)||[])[1]||'',isJson:!!json,jsonKeys:json&&typeof json==='object'?Object.keys(json).slice(0,20):[],jsonSample:json?JSON.stringify(json).slice(0,1200):'',head:text.slice(0,700),scriptMatches:[...new Set(scriptMatches)].slice(0,80),textMatches:[...new Set(textMatches)].slice(0,80)};
};
const result=[];
try {
  for (const u of urls) result.push(await cdp.eval(fetchOne.toString(), [u, args.baseUrl]));
  const outDir=path.join(ROOT,'outputs','et-forwarder-probes');
  await fs.mkdir(outDir,{recursive:true});
  const outPath=path.join(outDir,`ship-order-routes-${args.shipOrderId}-${new Date().toISOString().replace(/[:.]/g,'')}.json`);
  await fs.writeFile(outPath, JSON.stringify({shipOrderId:args.shipOrderId, baseUrl:args.baseUrl, createdAt:new Date().toISOString(), result}, null, 2));
  console.log(JSON.stringify({ok:true, outPath:path.relative(ROOT,outPath).replace(/\\/g,'/'), result}, null, 2));
} finally {
  cdp.close();
}
