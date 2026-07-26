#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shell = fs.readFileSync(path.join(root, 'scripts', 'generate_bi_portal_shell.mjs'), 'utf8');
const client = fs.readFileSync(path.join(root, 'scripts', 'bi_app', 'client.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'scripts', 'bi_app', 'styles.css'), 'utf8');

assert.match(shell, /<meta name="description"/);
assert.match(shell, /class="skip-link" href="#content"/);
assert.match(shell, /<nav class="nav" id="nav" aria-label="主导航"/);
assert.match(shell, /<main class="main" id="content" tabindex="-1"/);
assert.match(shell, /<footer class="foot">/);

assert.match(client, /aria-current=\"page\"/);
assert.match(client, /aria-pressed=/);
assert.match(client, /role=\"status\" aria-live=\"polite\"/);
assert.match(client, /role=\"alert\"/);
assert.match(client, /event\.key!==['"]Escape['"]/);
assert.match(client, /querySelectorAll\('\.table-wrap'\)/);
assert.doesNotMatch(client, /<main class=\"ops-chat-main\"/, 'the document must not render a nested second main landmark');
assert.match(client, /<label class=\"ops-upload-label.*for=\"opsUploadFiles\"/, 'file upload has a native associated label');
assert.match(client, /id=\"opsUploadFiles\"[^>]*aria-describedby=\"opsUploadHelp\"/, 'file upload announces its accepted formats and size limits');
assert.match(client, /<input class=\"ops-upload-file-input\"[^>]*id=\"opsUploadFiles\"[\s\S]*?<label class=\"ops-upload-label/,
  'hidden file input must precede its visible label so keyboard focus can be forwarded');
assert.match(css, /\.ops-upload-file-input:focus-visible\+\.ops-upload-label/,
  'keyboard focus on the native file input must be visible on the upload label');
assert.match(client, /range-preset-strip\" role=\"group\" aria-label=\"快捷日期范围/, 'date shortcut grouping uses a valid semantic role');
assert.match(client, /trend-toggle\" role=\"group\" aria-label=\"趋势指标/, 'trend toggle grouping uses a valid semantic role');
assert.match(client, /document\.addEventListener\('focusin'.*\[data-tip\]/, 'keyboard focus exposes chart detail tooltips');
assert.match(client, /chart-readable-details/, 'scatter chart includes a screen-reader-readable table entry point');
assert.match(css, /\.section-failure-notice\{border:2px solid #b42318/, 'unavailable data alert has high-contrast visual treatment');
assert.match(css, /\.chart-hit:focus-visible,.price-scatter-dot:focus-visible/, 'keyboard chart focus has a visible indicator');

assert.match(css, /:focus-visible/);
assert.match(css, /prefers-reduced-motion:reduce/);
assert.match(css, /@media\(max-width:1280px\)/);
assert.match(css, /\.nav\{grid-column:2;display:flex/);

console.log('bi_frontend_accessibility: landmarks, keyboard states, focus, and responsive navigation checks passed');
