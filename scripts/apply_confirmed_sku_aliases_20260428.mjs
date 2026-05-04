#!/usr/bin/env node
import fs from 'node:fs';

const file = 'config/product_aliases.json';
const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

// 移除上一轮 PowerShell 编码污染产生的坏规则。
cfg.aliases = (cfg.aliases || []).filter(row => {
  const text = [row.canonical, ...(row.aliases || []).map(a => typeof a === 'string' ? a : a?.value)].join('\n');
  return !text.includes('?');
});

const additions = [
  ['S1810电热水壶', ['1810']],
  ['SK-11004蒸汽熨烫机', ['11004']],
  ['SK-1713-4手持搅拌器', ['1713', 'QY1713搅拌器']],
  ['SK-7028绞肉机', ['7028']],
  ['SK-185台式榨汁机', ['QY185榨汁机', 'LQ185榨汁机']],
  ['KJ-102三明治机和早餐机', ['102', 'KJ-102三角形三明治机']],
  ['PA4-6L便携式冰箱', ['冰箱']],
  ['SK-999食品料理机', ['999']],
  ['SK-1924直发夹板', ['1924']],
  ['SM-961厨师机', ['961']],
  ['SK-1928直发夹板', ['1928']],
  ['HS-025直发夹板', ['025']],
  ['SK-3378杆式吸尘器', ['LQ杆式吸尘器']],
  ['SK-04029半自动意式咖啡机', ['SK-04029意式咖啡机']],
  ['SK-JFB-794卷发钳和卷发棒', ['SK-JFB-794卷发钳和卷发棒']],
];

for (const [canonical, aliases] of additions) {
  let row = cfg.aliases.find(x => x.canonical === canonical);
  if (!row) {
    row = {canonical, aliases: []};
    cfg.aliases.push(row);
  }
  for (const alias of aliases) {
    if (!row.aliases.includes(alias)) row.aliases.push(alias);
  }
}

cfg.version = Math.max(Number(cfg.version || 0), 5) + 1;
cfg.notes = cfg.notes || [];
const note = '2026-04-28 用户确认新增归并：1810->S1810；11004->SK-11004；1713/QY1713->SK-1713-4；7028->SK-7028；QY185/LQ185->SK-185；102/KJ-102三角形->KJ-102；冰箱->PA4-6L；999->SK-999；1924->SK-1924；961->SM-961；1928->SK-1928；025->HS-025；LQ杆式吸尘器->SK-3378；SK-04029意式咖啡机->SK-04029半自动意式咖啡机；补充 SK-JFB-794 完整别名。';
if (!cfg.notes.includes(note)) cfg.notes.push(note);

fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
console.log(JSON.stringify({ok: true, version: cfg.version, additions: additions.length}, null, 2));
