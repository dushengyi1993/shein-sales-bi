#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=await fs.mkdtemp(path.join(ROOT,'tmp','openapi-catalog-smoke-')); const checks=[];
function check(label,actual,expected){const pass=typeof expected==='function'?expected(actual):actual===expected; checks.push({label,actual,expected:typeof expected==='function'?'predicate':expected,pass});}
function sendJson(res,v,s=200){res.writeHead(s,{'Content-Type':'application/json'});res.end(JSON.stringify(v));}
function readBody(req){return new Promise((resolve,reject)=>{const c=[];req.on('data',x=>c.push(x));req.on('end',()=>resolve(Buffer.concat(c)));req.on('error',reject);});}
async function port(){return new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
function run(args){return new Promise(resolve=>{const child=spawn(process.execPath,args,{cwd:ROOT,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('close',code=>{let json=null;try{json=stdout.trim()?JSON.parse(stdout):null}catch{} resolve({code,stdout,stderr,json});});});}
async function write(name,v){const f=path.join(tmp,name);await fs.writeFile(f,JSON.stringify(v,null,2));return f;}
const calls=[]; const p=await port();
const fake=http.createServer(async(req,res)=>{const body=await readBody(req);const pathname=req.url.split('?')[0];let json={};try{json=JSON.parse(body.toString()||'{}')}catch{} calls.push({path:pathname,body:json});
 if(pathname==='/open-api/openapi-business-backend/query-store-info')return sendJson(res,{code:'0',msg:'OK',info:{merchantId:'merchant-smoke',accountNo:'GS123456'}});
 if(pathname==='/open-api/goods/query-shelf-quota')return sendJson(res,{code:'0',msg:'OK',traceId:'q',info:{need:true,total_quota_count:5,on_shelf_count:3,remain_count:2}});
 if(pathname==='/open-api/goods-recommend-retail-price/batch-save')return sendJson(res,{code:'0',msg:'OK',traceId:'w',info:{accepted:true}});
 return sendJson(res,{code:'404',msg:'Unhandled'},404);
}); await new Promise(r=>fake.listen(p,'127.0.0.1',r));
try{
 const config=await write('openapi.json',{apiBaseUrls:{prodSemiManaged:`http://127.0.0.1:${p}`},stores:[{storeKey:'SMK',openKeyId:'dummy',secretKey:'secret',merchantId:'merchant-smoke'}]});
 const truth=await write('truth.json',{stores:{SMK:{merchantId:'merchant-smoke',accountNo:'GS123456'}}});
 const catalog=await write('catalog.json',{items:[
  {docId:'3001544',title:'获取店铺上架额度',method:'POST',endpoint:'/open-api/goods/query-shelf-quota',read_or_write:'read',project_status:'candidate_unimplemented'},
  {docId:'3999999',title:'写接口样例',method:'POST',endpoint:'/open-api/goods-recommend-retail-price/batch-save',read_or_write:'write',project_status:'candidate_unimplemented'},
  {docId:'3001359',title:'本地图片上传',method:'POST',endpoint:'/open-api/goods/upload-pic',read_or_write:'write',requestBody:{children:[{type:'blob'}]}},
  {docId:'3001450',title:'Webhook',method:'POST',endpoint:'/product_document_audit_status_notice',read_or_write:'webhook',documentKind:'webhook'}
 ]});
 const dryRead=await run(['scripts/openapi_catalog_executor.mjs','--doc-id','3001544','--catalog',catalog,'--config',config,'--store-truth',truth,'--store','SMK','--body-json','{}']);
 check('read dry ok',dryRead.code,0); check('read dry no network',calls.length,0);
 const execRead=await run(['scripts/openapi_catalog_executor.mjs','--doc-id','3001544','--catalog',catalog,'--config',config,'--store-truth',truth,'--store','SMK','--body-json','{}','--mode','execute']);
 check('read execute ok',execRead.json?.ok,true); check('read identity then endpoint',calls.map(c=>c.path).join(','),'/open-api/openapi-business-backend/query-store-info,/open-api/goods/query-shelf-quota');
 calls.length=0;
 const dryWrite=await run(['scripts/openapi_catalog_executor.mjs','--doc-id','3999999','--catalog',catalog,'--config',config,'--store-truth',truth,'--store','SMK','--body-json','{"x":1}']);
 const hash=dryWrite.json?.payloadHash; check('write dry hash',Boolean(hash),true);
 const noHash=await run(['scripts/openapi_catalog_executor.mjs','--doc-id','3999999','--catalog',catalog,'--config',config,'--store-truth',truth,'--store','SMK','--body-json','{"x":1}','--mode','execute','--confirm','SHEIN_OPENAPI_GENERIC_WRITE_SUBMIT']);
 check('write no hash blocks',noHash.code!==0,true); check('write no hash no network',calls.length,0);
 const execWrite=await run(['scripts/openapi_catalog_executor.mjs','--doc-id','3999999','--catalog',catalog,'--config',config,'--store-truth',truth,'--store','SMK','--body-json','{"x":1}','--mode','execute','--confirm','SHEIN_OPENAPI_GENERIC_WRITE_SUBMIT','--payload-hash',hash]);
 check('write execute ok',execWrite.json?.ok,true); check('write identity then endpoint',calls.map(c=>c.path).join(','),'/open-api/openapi-business-backend/query-store-info,/open-api/goods-recommend-retail-price/batch-save');
 const multipart=await run(['scripts/openapi_catalog_executor.mjs','--doc-id','3001359','--catalog',catalog,'--config',config,'--store','SMK','--body-json','{}']);
 check('multipart blocked',multipart.code!==0,true); check('multipart message',multipart.stdout+multipart.stderr,x=>String(x).includes('dedicated adapter'));
 const webhook=await run(['scripts/openapi_catalog_executor.mjs','--doc-id','3001450','--catalog',catalog,'--config',config,'--store','SMK','--body-json','{}']);
 check('webhook blocked',webhook.code!==0,true);
 const failed=checks.filter(c=>!c.pass); console.log(JSON.stringify({ok:failed.length===0,checks,tmp},null,2)); process.exitCode=failed.length?1:0;
}finally{fake.close(); await fs.rm(tmp,{recursive:true,force:true}).catch(()=>{});}
