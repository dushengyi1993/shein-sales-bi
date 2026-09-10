#!/usr/bin/env node
import {readPublishDiagnostic} from '../lib/link_ops_publish_diagnostics.mjs';
const [id,expectedSha256,...rest]=process.argv.slice(2);
if(rest.length||!id||(expectedSha256&&!/^[a-f0-9]{64}$/.test(expectedSha256)))throw Error('Usage: node scripts/read_link_ops_publish_diagnostic.mjs <diagnostic-id> [sha256]');
console.log(JSON.stringify(await readPublishDiagnostic(id,{expectedSha256}),null,2));
