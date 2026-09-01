#!/usr/bin/env node

import {runImmediateAuthorizationCli} from '../lib/cloud_marketing_immediate_authorization.mjs';

runImmediateAuthorizationCli(process.argv.slice(2)).catch(error => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = error?.code === 'IMMEDIATE_AUTHORIZATION_USAGE'
    || String(error?.code || '').startsWith('IMMEDIATE_AUTHORIZATION_')
    ? 64
    : 75;
});
