#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {planLinkOpsImageRoles} from '../lib/link_ops_image_role_planner.mjs';

function parseArgs(argv) {
  const args = {dir: '', out: '', pretty: false, approved: null};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir' || a === '--image-dir') args.dir = String(argv[++i] || '').trim();
    else if (a === '--out' || a === '--output') args.out = path.resolve(String(argv[++i] || ''));
    else if (a === '--pretty') args.pretty = true;
    else if (a === '--approved' || a === '--approved-assets') args.approved = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage:\n  node scripts/link_ops_plan_image_roles.mjs --dir <图片文件夹> [--approved] [--out roles.json] [--pretty]');
      process.exit(0);
    } else if (!args.dir) args.dir = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.dir) throw new Error('missing --dir <图片文件夹>');
  return args;
}

function printPretty(plan) {
  console.log(`图片规划：${plan.ok ? '通过' : '需处理'}  可用 ${plan.counts.eligibleImages}/${plan.counts.scannedImages}`);
  const role = plan.roles || {};
  const line = (label, item) => console.log(`${label}: ${item?.relativePath || item?.name || '-'}`);
  line('主封面/细节第1张', role.mainCover);
  line('单独轮播/第二封面', role.carouselSecondCover);
  line('方形图', role.squareImage);
  console.log('细节图顺序:');
  for (const [idx, item] of (role.frontendDetailImages || []).entries()) console.log(`  ${idx + 1}. ${item.relativePath}`);
  line('SKU图', role.skuImage);
  if (role.ignoredAbTestCovers?.length) console.log(`忽略AB测试封面: ${role.ignoredAbTestCovers.map(x => x.relativePath).join(', ')}`);
  for (const warning of plan.warnings || []) console.log(`WARN: ${warning}`);
  for (const blocker of plan.blockers || []) console.log(`BLOCKER: ${blocker}`);
}

const args = parseArgs(process.argv.slice(2));
const plan = await planLinkOpsImageRoles({dir: args.dir, sourceApproved: args.approved});
if (args.out) {
  await fs.mkdir(path.dirname(args.out), {recursive: true});
  await fs.writeFile(args.out, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  plan.savedTo = args.out;
}
if (args.pretty) printPretty(plan);
else console.log(JSON.stringify(plan, null, 2));
if (!plan.ok) process.exitCode = 1;
