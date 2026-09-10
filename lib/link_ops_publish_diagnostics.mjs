import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_PUBLISH_DIAGNOSTICS_ROOT='/srv/shein-bi/runtime/link-ops-private-diagnostics';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const rows=value=>Array.isArray(value)?value:value==null?[]:[value];

// Select only platform validation text. Never persist request bodies, headers,
// client objects or credentials. The ordinary task result stays hash-only.
export function buildPublishDiagnostic({result,taskId,runId,storeKey,sensitiveValues=[]}){
  const redact=value=>{
    let text=typeof value==='string'?value:typeof value==='number'?String(value):'';
    const originalSha256=sha(text);
    for(const secret of [...new Set(sensitiveValues.filter(v=>typeof v==='string'&&v.length))].sort((a,b)=>b.length-a.length)){
      text=text.split(secret).join('[redacted]');
    }
    text=text.replace(/(?:Bearer|Basic)\s+[^\s,;]+/gi,'[credential redacted]')
      .replace(/((?:x-lt-(?:signature|openKeyId)|secretKey|openKeyId|access_token|refresh_token|authorization|cookie|password)["']?\s*[=:]\s*["']?)[^\s,;"'}]+/gi,'$1[redacted]');
    return {text:text.slice(0,4000),sha256:originalSha256,truncated:text.length>4000};
  };
  const info=result?.info&&typeof result.info==='object'?result.info:{};
  return {schemaVersion:'publish-validation-diagnostic/v1',createdAt:new Date().toISOString(),
    taskId:String(taskId||''),runId:String(runId||''),storeKey:String(storeKey||''),
    traceId:redact(result?.traceId||''),code:redact(result?.code??''),httpStatus:Number(result?.httpStatus)||null,
    success:Object.hasOwn(info,'success')&&typeof info.success==='boolean'?info.success:null,
    message:redact(result?.msg),preValidResult:rows(info.pre_valid_result||info.preValidResult).slice(0,30).map(row=>({
      module:redact(row?.module),form:redact(row?.form_name||row?.form),
      messages:rows(row?.messages||row?.message).slice(0,10).map(redact),
    })),requestPayloadStored:false,credentialsStored:false};
}

export async function persistPublishDiagnostic(input,{root=DEFAULT_PUBLISH_DIAGNOSTICS_ROOT}={}){
  const record=buildPublishDiagnostic(input);
  const id=sha(JSON.stringify([record.taskId,record.runId,record.traceId.sha256]));
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Invalid diagnostic directory');
  if(process.platform!=='win32'&&(stat.mode&0o077)!==0)throw Error('Diagnostic directory must be private');
  const bytes=Buffer.from(JSON.stringify(record,null,2));
  const file=path.join(root,id+'.json'),fd=await fs.open(file,'wx',0o600);
  try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
  return {ok:true,id,sha256:sha(bytes),schemaVersion:record.schemaVersion};
}

export async function readPublishDiagnostic(id,{root=DEFAULT_PUBLISH_DIAGNOSTICS_ROOT,expectedSha256}={}){
  if(!/^[a-f0-9]{64}$/.test(id))throw Error('Exact diagnostic ID required');
  const file=path.join(root,id+'.json'),stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1500000)throw Error('Invalid diagnostic artifact');
  const bytes=await fs.readFile(file);if(expectedSha256&&sha(bytes)!==expectedSha256)throw Error('Diagnostic evidence hash mismatch');
  const record=JSON.parse(bytes);if(record.schemaVersion!=='publish-validation-diagnostic/v1')throw Error('Diagnostic schema mismatch');
  return {ok:true,id,sha256:sha(bytes),record};
}
