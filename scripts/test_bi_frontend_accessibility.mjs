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

assert.match(css, /:focus-visible/);
assert.match(css, /prefers-reduced-motion:reduce/);
assert.match(css, /@media\(max-width:1280px\)/);
assert.match(css, /\.nav\{grid-column:2;display:flex/);

console.log('bi_frontend_accessibility: landmarks, keyboard states, focus, and responsive navigation checks passed');
