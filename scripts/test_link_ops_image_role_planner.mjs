#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planLinkOpsImageRoles} from '../lib/link_ops_image_role_planner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'link-ops-image-role-planner-'));
const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

function pngBuffer(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 2;
  buf[26] = 0;
  buf[27] = 0;
  buf[28] = 0;
  return buf;
}

async function writePng(dir, name, width = 900, height = 1200) {
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, name), pngBuffer(width, height));
}

function runCli(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/bi_ops_cli.mjs', ...args], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
      resolve({code, stdout, stderr, json});
    });
  });
}

try {
  const base = path.join(tmpRoot, 'sample');
  await writePng(base, '01-沙特传统与现代高效主封面-v1.png');
  await writePng(base, '02-沙特奢华质感产品封面-v1.png');
  await writePng(base, '03-方形沙特温馨封面-v1.png', 1000, 1000);
  await writePng(base, '05-核心优势轮播图-v1.png');
  await writePng(base, '06-温馨沙特家庭场景-v1.png');
  await writePng(base, '07-沙特别墅露台烹饪场景-v1.png');
  await writePng(base, '08-2000W双灶发热卖点-v1.png');
  await writePng(base, '09-5档独立旋钮控温卖点-v1.png');
  await writePng(base, '10-不挑锅具兼容性卖点-v1.png');
  await writePng(base, '11-轻巧收纳与便携卖点-v1.png');
  await writePng(base, '12-双红色加热指示灯卖点-v1.png');
  await writePng(base, '14-发热线圈与防滑底脚特写-v2.png');
  await writePng(base, '17-效率加倍对比图-v1.png');
  await writePng(base, '18-最后收尾厨房场景-v1.png');
  await writePng(base, '19-额外沙特生活场景-v1.png');
  await writePng(path.join(base, '备用'), '99-备用不要用.png');

  const plan = await planLinkOpsImageRoles({dir: base});
  check('plan ok', plan.ok, true);
  check('scans only non-backup image files plus ignored AB cover', plan.counts.scannedImages, 15);
  check('ignores product cover AB image', plan.roles.ignoredAbTestCovers.map(x => x.name).join(','), '02-沙特奢华质感产品封面-v1.png');
  check('main cover is 01', plan.roles.mainCover.name, '01-沙特传统与现代高效主封面-v1.png');
  check('carousel second cover is 05', plan.roles.carouselSecondCover.name, '05-核心优势轮播图-v1.png');
  check('square image is 03', plan.roles.squareImage.name, '03-方形沙特温馨封面-v1.png');
  check('frontend detail capacity is 11', plan.roles.frontendDetailImages.length, 11);
  check('frontend detail first is main cover', plan.roles.frontendDetailImages[0].name, '01-沙特传统与现代高效主封面-v1.png');
  check('sku gets overflow low priority closeup', plan.roles.skuImage.name, '14-发热线圈与防滑底脚特写-v2.png');
  check('main cover mapping remains front-role not fixed full payload', plan.roles.mainCover.openApiMapping.targetLevel.join(','), 'skc');
  check('second cover mapping calls out SPU scheme dependency', plan.roles.carouselSecondCover.openApiMapping.targetLevel.join(','), 'spu');
  check('backup image is absent', JSON.stringify(plan), x => !x.includes('99-备用不要用'));
  check('product cover is not submitted roles', [plan.roles.mainCover, plan.roles.carouselSecondCover, plan.roles.squareImage, plan.roles.skuImage, ...plan.roles.frontendDetailImages].filter(Boolean).map(x => x.name).includes('02-沙特奢华质感产品封面-v1.png'), false);

  const noSku = path.join(tmpRoot, 'no-sku');
  for (const name of [
    '01-主封面.png', '02-产品封面.png', '03-方形图.png', '04-参数规格图.png', '05-核心优势轮播图.png',
    '06-家庭场景.png', '07-露台场景.png', '08-2000W卖点.png', '09-控温卖点.png',
    '10-兼容卖点.png', '11-便携卖点.png', '12-指示灯卖点.png', '14-特写卖点.png', '17-效率对比图.png',
  ]) await writePng(noSku, name, /^03/.test(name) ? 1000 : 900, /^03/.test(name) ? 1000 : 1200);
  const noSkuPlan = await planLinkOpsImageRoles({dir: noSku});
  check('no sku package ok', noSkuPlan.ok, true);
  check('no sku package uses available detail images without forcing 11', noSkuPlan.roles.frontendDetailImages.length, 11);
  check('no sku package does not assign SKU image', noSkuPlan.roles.skuImage, null);
  check('no sku package keeps closeup near end before parameter', noSkuPlan.roles.frontendDetailImages.map(x => x.name).join(' > '), x => /14-特写卖点.*04-参数规格图/.test(String(x)) && String(x).endsWith('04-参数规格图.png'));

  const outFile = path.join(tmpRoot, 'roles.json');
  const cli = await runCli(['plan-images', '--image-dir', base, '--out', outFile]);
  check('bi_ops_cli plan-images exit', cli.code, 0);
  check('bi_ops_cli plan-images json ok', cli.json?.ok, true);
  check('bi_ops_cli plan-images savedTo', cli.json?.savedTo, outFile);
  const saved = JSON.parse(await fs.readFile(outFile, 'utf8'));
  check('saved plan keeps main cover', saved.roles?.mainCover?.name, '01-沙特传统与现代高效主封面-v1.png');
} finally {
  const ok = checks.every(x => x.pass);
  console.log(JSON.stringify({ok, tmpRoot, checks}, null, 2));
  if (ok) await fs.rm(tmpRoot, {recursive: true, force: true});
  else process.exitCode = 1;
}
