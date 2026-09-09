#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {buildMarketingObligationLedger} from '../../lib/marketing_obligation_ledger.mjs';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2) {
  if (!['--roster','--observations','--out','--as-of'].includes(args[i]) || !args[i+1] || options[args[i]]) throw Error('Usage: --roster original-roster.json [--observations official-readbacks.json] --out exclusive-ledger.json [--as-of ISO-time]');
  options[args[i]]=args[i+1];
}
if (!options['--roster'] || !options['--out']) throw Error('original roster and exclusive output are required');
const read=async p=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));
const observations=options['--observations']?await read(options['--observations']):[];
if (!Array.isArray(observations)) throw Error('observations must be an array of normalized official readbacks');
const result=buildMarketingObligationLedger({roster:await read(options['--roster']),observations,asOf:options['--as-of'] || new Date()});
const out=path.resolve(options['--out']);await fs.mkdir(path.dirname(out),{recursive:true});
await fs.writeFile(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({out,complete:result.complete,...result.counts,productionWrites:0}));
