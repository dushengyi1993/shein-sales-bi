#!/usr/bin/env node
import fs from 'node:fs/promises';
const port = Number(process.argv[2] || 9333);
const out = 'outputs/captures/js-endpoint-search.txt';
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(p=>p.type==='page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq=0; const pending=new Map();
ws.addEventListener('message', ev=>{ const msg=JSON.parse(ev.data); if(msg.id&&pending.has(msg.id)){ const p=pending.get(msg.id); pending.delete(msg.id); msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result); }});
await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true});});
function send(method,params={}){const id=++seq; ws.send(JSON.stringify({id,method,params})); return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));}
const evalRes=await send('Runtime.evaluate',{expression:`performance.getEntriesByType('resource').map(e=>e.name).filter(u=>u.endsWith('.js') && u.includes('gspFront'))`, returnByValue:true});
ws.close();
const urls=evalRes.result.value;
const hits=[];
for (const url of urls) {
  try {
    const txt=await (await fetch(url)).text();
    const patterns=['orderPlus','listOrder','statistics','orderDetail','detail','goodsList','orderGoods'];
    for (const pat of patterns) {
      let idx=txt.indexOf(pat);
      while(idx>=0){ hits.push({url, pat, snippet: txt.slice(Math.max(0,idx-300), idx+500)}); idx=txt.indexOf(pat, idx+pat.length); if(hits.length>500) break; }
      if(hits.length>500) break;
    }
  } catch(e) { hits.push({url, error:String(e)}); }
}
await fs.mkdir('outputs/captures',{recursive:true});
await fs.writeFile(out, hits.map(h=>`URL: ${h.url}\nPAT: ${h.pat||''}\n${h.snippet||h.error}\n---`).join('\n'), 'utf8');
console.log(JSON.stringify({out, hits:hits.length, urls:urls.length},null,2));
