#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = await fs.mkdtemp(path.join(ROOT, 'tmp', 'openapi-order-fulfillment-smoke-'));
const checks = [];
function check(label, actual, expected) { const pass = typeof expected === 'function' ? expected(actual) : actual === expected; checks.push({label, actual, expected: typeof expected === 'function' ? 'predicate' : expected, pass}); }
function sendJson(res, value, status = 200) { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(value)); }
function readBody(req) { return new Promise((resolve,reject)=>{const chunks=[]; req.on('data',c=>chunks.push(c)); req.on('end',()=>resolve(Buffer.concat(chunks))); req.on('error',reject);}); }
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer(); s.on('error',reject); s.listen(0,'127.0.0.1',()=>{const p=s.address().port; s.close(()=>resolve(p));});});}
function runNode(args){return new Promise(resolve=>{const child=spawn(process.execPath,args,{cwd:ROOT,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('close',code=>{let json=null;try{json=stdout.trim()?JSON.parse(stdout):null;}catch{} resolve({code,stdout,stderr,json});});});}
async function writeJson(name,value){const file=path.join(tmpRoot,name); await fs.writeFile(file, JSON.stringify(value,null,2)); return file;}
const calls=[]; const port=await freePort();
const fake=http.createServer(async(req,res)=>{const body=await readBody(req); const pathname=req.url.split('?')[0]; let json={}; try{json=JSON.parse(body.toString()||'{}')}catch{} calls.push({path:pathname,body:json});
 if(pathname==='/open-api/openapi-business-backend/query-store-info') return sendJson(res,{code:'0',msg:'OK',info:{merchantId:'merchant-smoke',accountNo:'GS123456'}});
 if(pathname==='/open-api/order/export-address') return sendJson(res,{code:0,msg:'OK',traceId:'trace-address',info:{receiveMsgList:[{orderNo:json.orderNo,firstName:'A'}]}});
 if(pathname==='/open-api/order/import-batch-multiple-express') return sendJson(res,{code:0,msg:'OK',traceId:'trace-express',info:[{expressCode:json.infoList?.[0]?.expressCode,goodsId:json.infoList?.[0]?.goodsId,status:'2'}]});
 if(pathname==='/open-api/gsp/place-express-order') return sendJson(res,{code:'0',msg:'OK',traceId:'trace-place',info:{deliveryNo:'GU123',placeRequestId:'REQ2'}});
 if(pathname==='/open-api/order/print-express-info') return sendJson(res,{code:'0',msg:'OK',traceId:'trace-print',info:[{orderNo:json.orderNo,filePdfUrl:'https://pdf.test/1.pdf'}]});
 return sendJson(res,{code:'404',msg:'Unhandled'},404);
});
await new Promise(r=>fake.listen(port,'127.0.0.1',r));
try{
 const config=await writeJson('openapi.json',{apiBaseUrls:{prodSemiManaged:`http://127.0.0.1:${port}`},stores:[{storeKey:'SMK',openKeyId:'dummy',secretKey:'secret',merchantId:'merchant-smoke'}]});
 const truth=await writeJson('truth.json',{stores:{SMK:{merchantId:'merchant-smoke',accountNo:'GS123456'}}});
 const cliBlocked=await runNode(['scripts/bi_ops_cli.mjs','order-fulfillment','--operation','export-address','--openapi-config',config,'--store-truth',truth,'--store','SMK','--order-no','GSO123']);
 check('CLI local order-fulfillment dry-run blocked', cliBlocked.code !== 0, true);
 check('CLI local order-fulfillment block mentions cloud boundary', `${cliBlocked.stdout}\n${cliBlocked.stderr}`, t=>/cannot run local SHEIN OpenAPI through bi_ops_cli|outside the SHEIN OpenAPI whitelist boundary/.test(String(t)));
 check('CLI local order-fulfillment block made no network', calls.length, 0);
 const dry=await runNode(['scripts/openapi_order_fulfillment_executor.mjs','export-address','--config',config,'--store-truth',truth,'--store','SMK','--order-no','GSO123']);
 check('direct fake dry exits 0', dry.code, 0); check('direct fake dry ok', dry.json?.ok, true); check('direct fake dry no network', calls.length, 0); const hash=dry.json?.adapterResult?.payloadHash; check('direct fake dry has hash', Boolean(hash), true);
 const noConfirm=await runNode(['scripts/openapi_order_fulfillment_executor.mjs','export-address','--config',config,'--store-truth',truth,'--store','SMK','--order-no','GSO123','--mode','execute','--payload-hash',hash]);
 check('direct fake execute without confirm blocks', noConfirm.code !== 0, true); check('direct fake no confirm no network', calls.length, 0);
 const exec=await runNode(['scripts/openapi_order_fulfillment_executor.mjs','export-address','--config',config,'--store-truth',truth,'--store','SMK','--order-no','GSO123','--mode','execute','--confirm','SHEIN_ORDER_FULFILLMENT_SUBMIT','--payload-hash',hash]);
 check('execute exits 0', exec.code, 0); check('execute ok', exec.json?.ok, true); check('identity then address', calls.map(c=>c.path).join(','), '/open-api/openapi-business-backend/query-store-info,/open-api/order/export-address');
 calls.length=0;
 const importDry=await runNode(['scripts/openapi_order_fulfillment_executor.mjs','import-express','--config',config,'--store-truth',truth,'--store','SMK','--order-no','GSO123','--goods-id','123','--express-code','EXP1','--express-id-code','DHL']);
 check('import express dry ok', importDry.json?.ok, true);
 const placeDry=await runNode(['scripts/openapi_order_fulfillment_executor.mjs','place-express-order','--config',config,'--store-truth',truth,'--store','SMK','--order-no','GSO123','--goods-ids','123,124','--express-channel-code','CH1','--pre-request-id','PRE1']);
 check('place express dry ok', placeDry.json?.ok, true);
 const printDry=await runNode(['scripts/openapi_order_fulfillment_executor.mjs','print-express-info','--config',config,'--store-truth',truth,'--store','SMK','--order-no','GSO123','--package-no','PKG1']);
 check('print express dry ok', printDry.json?.ok, true);
 const failed=checks.filter(c=>!c.pass); console.log(JSON.stringify({ok:failed.length===0,checks,tmpRoot},null,2)); process.exitCode=failed.length?1:0;
} finally { fake.close(); await fs.rm(tmpRoot,{recursive:true,force:true}).catch(()=>{}); }
