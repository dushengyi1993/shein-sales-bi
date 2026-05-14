#!/usr/bin/env node
/**
 * Generate SHEIN BI V2 preview.
 *
 * V2 is intentionally independent from the V1 DOM. It consumes the same
 * outputs/bi-portal/data.json, but owns its information architecture and visual
 * system. V1 outputs/bi-portal/index.html is never modified here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'outputs', 'bi-portal', 'v2');
const outFile = path.join(outDir, 'index.html');

const css = String.raw`
:root{
  --bg:#f7f4ed;
  --paper:#fffefa;
  --paper-2:#f0ece3;
  --ink:#24231f;
  --muted:#746e62;
  --faint:#aaa196;
  --line:#ded8cd;
  --line-strong:#cfc7ba;
  --accent:#5f745f;
  --accent-2:#b8794b;
  --danger:#a24f45;
  --warn:#b8794b;
  --good:#4f775c;
  --side:#181713;
  --side-muted:#b9b0a2;
  --radius-xl:22px;
  --radius-lg:18px;
  --radius-md:12px;
  --ease:cubic-bezier(.32,.72,0,1);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;
  background:
    radial-gradient(circle at 8% 0%,rgba(95,116,95,.13),transparent 34rem),
    radial-gradient(circle at 92% 4%,rgba(184,121,75,.14),transparent 33rem),
    linear-gradient(135deg,#fbf8f1 0%,var(--bg) 42%,#f4efe6 100%);
  color:var(--ink);
  font-family:"Geist","Plus Jakarta Sans","Aptos","Segoe UI Variable","Microsoft YaHei",system-ui,-apple-system,sans-serif;
  font-size:14px;
  line-height:1.55;
  overflow-x:hidden;
}
body:before{
  content:"";
  position:fixed;
  inset:0;
  pointer-events:none;
  z-index:50;
  opacity:.09;
  background-image:linear-gradient(rgba(36,35,31,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(36,35,31,.045) 1px,transparent 1px);
  background-size:64px 64px;
  mask-image:linear-gradient(to bottom,black 0%,transparent 76%);
}
button,input,select{font:inherit}
button{cursor:pointer}
a{color:inherit;text-decoration:none}
.app{min-height:100dvh}
.sidebar{
  position:fixed;
  inset:18px auto 18px 18px;
  width:232px;
  border-radius:24px;
  background:linear-gradient(180deg,#1d1b17,#13120f);
  color:#fffaf0;
  padding:18px;
  display:flex;
  flex-direction:column;
  z-index:20;
  box-shadow:0 22px 58px rgba(40,34,24,.14), inset 0 1px 0 rgba(255,255,255,.07);
}
.brand{
  padding:8px 8px 18px;
  border-bottom:1px solid rgba(255,255,255,.10);
  margin-bottom:14px;
}
.brand-mark{
  width:40px;height:40px;border-radius:14px;
  display:grid;place-items:center;
  background:#f7f4ed;color:#171713;
  font-weight:800;letter-spacing:-.08em;
  box-shadow:inset 0 -1px 0 rgba(0,0,0,.18);
}
.brand h1{font-size:20px;line-height:1.1;margin:14px 0 5px;letter-spacing:-.06em}
.brand p{margin:0;color:var(--side-muted);font-size:12px}
.nav{display:grid;gap:6px;margin-top:4px}
.nav button{
  border:0;
  min-height:39px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  padding:0 13px;
  border-radius:14px;
  background:transparent;
  color:var(--side-muted);
  transition:background .45s var(--ease),color .45s var(--ease),transform .45s var(--ease);
}
.nav button:hover{background:rgba(255,255,255,.08);color:#fff;transform:translateX(2px)}
.nav button.active{background:#f7f4ed;color:#171713}
.nav .dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.38}
.side-footer{
  margin-top:auto;
  border:1px solid rgba(255,255,255,.10);
  border-radius:18px;
  padding:14px;
  color:var(--side-muted);
  background:rgba(255,255,255,.04);
}
.side-footer b{display:block;color:#fffaf0;font-weight:650;margin-bottom:4px}
.main{
  margin-left:264px;
  padding:16px 24px 72px 0;
  min-height:100dvh;
}
.command{
  position:sticky;
  top:0;
  z-index:18;
  padding:16px 0 14px;
  backdrop-filter:blur(18px);
}
.command-inner{
  border:1px solid rgba(222,216,205,.82);
  border-radius:22px;
  background:rgba(255,254,250,.82);
  box-shadow:0 14px 42px rgba(55,45,32,.055), inset 0 1px 0 rgba(255,255,255,.84);
  padding:10px;
  display:grid;
  grid-template-columns:minmax(300px,1.35fr) 148px 138px 138px auto;
  gap:8px;
  align-items:center;
}
.field{
  min-height:40px;
  border:1px solid var(--line);
  border-radius:999px;
  background:#fffdfa;
  display:flex;
  align-items:center;
  gap:8px;
  padding:0 13px;
}
.field label{font-size:11px;color:var(--faint);white-space:nowrap}
.field input,.field select{
  width:100%;
  border:0;
  outline:0;
  background:transparent;
  color:var(--ink);
  min-width:0;
}
.quick{
  display:flex;
  gap:6px;
  justify-content:flex-end;
  flex-wrap:wrap;
}
.quick button,.chip,.pill-btn{
  border:1px solid var(--line);
  background:#fffdfa;
  color:var(--ink);
  border-radius:999px;
  min-height:34px;
  padding:0 12px;
  transition:transform .38s var(--ease),border-color .38s var(--ease),background .38s var(--ease);
}
.quick button:hover,.chip:hover,.pill-btn:hover{transform:translateY(-1px);border-color:var(--line-strong)}
.quick button.active,.chip.active,.pill-btn.active{background:var(--ink);color:#fff;border-color:var(--ink)}
.view{padding:12px 0 0}
.hero{
  display:grid;
  grid-template-columns:minmax(0,1.15fr) minmax(420px,.85fr);
  gap:18px;
  margin-bottom:18px;
  align-items:start;
}
.hero-main,.hero-side,.panel,.paper{
  border:1px solid var(--line);
  border-radius:var(--radius-xl);
  background:rgba(255,254,250,.86);
  box-shadow:0 16px 44px rgba(55,45,32,.052),inset 0 1px 0 rgba(255,255,255,.88);
}
.hero-main{padding:28px 30px;min-height:0;position:relative;overflow:hidden}
.hero-main:after{
  content:"";
  position:absolute;
  right:-90px;top:-90px;
  width:280px;height:280px;border-radius:50%;
  background:radial-gradient(circle,rgba(95,116,95,.24),transparent 66%);
}
.eyebrow{
  display:inline-flex;align-items:center;gap:8px;
  height:28px;padding:0 11px;border-radius:999px;
  border:1px solid var(--line);
  color:var(--muted);font-size:11px;font-weight:650;letter-spacing:.12em;text-transform:uppercase;
  background:rgba(247,244,237,.72);
}
.eyebrow i{width:7px;height:7px;border-radius:50%;background:var(--accent);display:block}
h2,h3,h4,p{margin-top:0}
.hero-title{
  margin:18px 0 12px;
  font-size:clamp(32px,3.1vw,48px);
  line-height:1.02;
  letter-spacing:-.08em;
  max-width:980px;
}
.hero-copy{max-width:860px;color:var(--muted);font-size:15px}
.hero-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}
.primary{
  border:0;
  background:var(--ink);
  color:#fff;
  border-radius:999px;
  min-height:45px;
  padding:0 18px;
  display:inline-flex;align-items:center;gap:12px;
  transition:transform .38s var(--ease),background .38s var(--ease);
}
.primary:hover{transform:translateY(-1px);background:#11100e}
.primary .arrow{
  width:28px;height:28px;border-radius:50%;
  display:grid;place-items:center;
  background:rgba(255,255,255,.12);
}
.hero-side{padding:18px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-content:start}
.decision-card{
  padding:13px;border-radius:16px;background:#f4efe6;border:1px solid var(--line);
}
.decision-card b{display:block;font-size:15px;line-height:1.28;letter-spacing:-.04em;margin-bottom:6px}
.decision-card p{margin:0;color:var(--muted);font-size:12px}
.meta-line{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
.hero-side .meta-line{grid-column:1/-1}
.grid{display:grid;gap:18px}
.kpi-grid{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:20px}
.kpi{
  padding:20px 22px;
  min-height:166px;
  border:1px solid var(--line);
  border-radius:20px;
  background:#fffefa;
  position:relative;
  overflow:hidden;
}
.kpi:before{content:"";position:absolute;inset:0 0 auto;height:4px;background:var(--accent);opacity:.9}
.kpi.warn:before{background:var(--warn)}
.kpi.danger:before{background:var(--danger)}
.kpi.good:before{background:var(--good)}
.kpi-label{color:var(--muted);font-size:12px;font-weight:650;margin-bottom:14px}
.kpi-value{
  font-size:clamp(30px,3.25vw,50px);
  line-height:1;
  letter-spacing:-.07em;
  font-weight:760;
  font-variant-numeric:tabular-nums;
}
.kpi-sub{margin-top:12px;color:var(--muted);font-size:13px}
.kpi-small{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:18px}
.kpi-small span{display:block;color:var(--faint);font-size:11px}
.kpi-small b{font-size:18px;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.overview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:18px 0 22px}
.overview-card{
  border:1px solid var(--line);
  border-radius:24px;
  background:rgba(255,254,250,.9);
  box-shadow:0 14px 40px rgba(55,45,32,.045),inset 0 1px 0 rgba(255,255,255,.86);
  overflow:hidden;
}
.overview-card-head{
  min-height:72px;
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:18px;
  padding:18px 20px 12px;
  border-bottom:1px solid var(--line);
}
.overview-card-head h4{margin:0;font-size:17px;letter-spacing:-.045em}
.overview-card-head .sub{margin-top:4px;color:var(--muted);font-size:12px}
.mode-switch,.trend-toggle{
  display:inline-flex;
  align-items:center;
  gap:4px;
  border:1px solid var(--line);
  background:#f5f0e8;
  border-radius:999px;
  padding:4px;
}
.mode-switch button,.trend-toggle button{
  border:0;
  min-height:30px;
  padding:0 11px;
  border-radius:999px;
  background:transparent;
  color:var(--muted);
  font-weight:650;
  font-size:12px;
  transition:background .28s var(--ease),color .28s var(--ease),transform .28s var(--ease);
}
.mode-switch button:hover,.trend-toggle button:hover{transform:translateY(-1px);color:var(--ink)}
.mode-switch button.active,.trend-toggle button.active{background:var(--ink);color:#fff}
.home-matrix{
  display:grid;
  grid-template-columns:minmax(104px,.72fr) repeat(var(--cols),minmax(116px,1fr));
  border-top:0;
}
.home-matrix .cell{
  min-height:58px;
  display:flex;
  align-items:center;
  justify-content:center;
  text-align:center;
  padding:10px 12px;
  border-right:1px solid var(--line);
  border-bottom:1px solid var(--line);
  font-variant-numeric:tabular-nums;
}
.home-matrix .cell:nth-child(1),
.home-matrix .cell:nth-child(2),
.home-matrix .cell:nth-child(3),
.home-matrix .cell:nth-child(4){background:#f5f0e8;color:var(--muted);font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
.home-matrix .label{font-weight:850;color:var(--ink);background:#f8f4ec}
.home-matrix .value{font-size:20px;font-weight:850;letter-spacing:-.045em;color:var(--ink)}
.home-matrix .cell.value{flex-direction:column;gap:2px}
.home-matrix .value small{display:block;margin-top:4px;font-size:10px;font-weight:650;color:var(--muted);letter-spacing:0}
.home-matrix .positive{color:#10a464}.home-matrix .warn{color:#c47a23}.home-matrix .danger{color:#b94b41}
.overview-scope-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin-top:12px}
.trend-toolbar{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:30px 0 14px}
.trend-toolbar h3{margin:0;font-size:25px;letter-spacing:-.055em}
.trend-toolbar p{margin:4px 0 0;color:var(--muted)}
.trend-stack{display:grid;grid-template-columns:1fr;gap:16px}
.trend-panel .chart-wrap{height:360px;margin-top:8px}
.home-rank-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.home-rank-list{display:grid;gap:7px}
.home-rank-row{
  width:100%;
  border:1px solid var(--line);
  border-radius:15px;
  background:#fffdfa;
  padding:10px 12px;
  display:grid;
  grid-template-columns:34px minmax(0,1fr) auto;
  gap:10px;
  align-items:center;
  text-align:left;
  transition:transform .28s var(--ease),border-color .28s var(--ease),background .28s var(--ease);
}
.home-rank-row:hover{transform:translateY(-1px);border-color:var(--line-strong);background:#fff}
.home-rank-row .rank-name{font-weight:780;letter-spacing:-.035em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.home-rank-row .rank-meta{display:block;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.home-rank-row .rank-number{font-weight:850;font-variant-numeric:tabular-nums;text-align:right}
.home-rank-row .rank-number small{display:block;color:var(--muted);font-size:11px;font-weight:600}
.dark-toggle{white-space:nowrap}
body[data-theme="dark"]{
  --bg:#151412;
  --paper:#1d1b18;
  --paper-2:#25221e;
  --ink:#f4efe6;
  --muted:#bdb4a8;
  --faint:#91887d;
  --line:#343029;
  --line-strong:#4a443b;
  background:
    radial-gradient(circle at 10% 0%,rgba(95,116,95,.22),transparent 34rem),
    radial-gradient(circle at 92% 4%,rgba(184,121,75,.14),transparent 33rem),
    linear-gradient(135deg,#171613 0%,#11100e 100%);
}
body[data-theme="dark"] .command-inner,
body[data-theme="dark"] .hero-main,
body[data-theme="dark"] .hero-side,
body[data-theme="dark"] .panel,
body[data-theme="dark"] .paper,
body[data-theme="dark"] .overview-card,
body[data-theme="dark"] .kpi,
body[data-theme="dark"] .operation-card,
body[data-theme="dark"] .table-wrap{background:rgba(29,27,24,.92)}
body[data-theme="dark"] .field,
body[data-theme="dark"] .quick button,
body[data-theme="dark"] .chip,
body[data-theme="dark"] .pill-btn,
body[data-theme="dark"] .home-rank-row,
body[data-theme="dark"] .rank-row{background:#211f1b;color:var(--ink)}
body[data-theme="dark"] .home-matrix .cell:nth-child(1),
body[data-theme="dark"] .home-matrix .cell:nth-child(2),
body[data-theme="dark"] .home-matrix .cell:nth-child(3),
body[data-theme="dark"] .home-matrix .cell:nth-child(4),
body[data-theme="dark"] .home-matrix .label,
body[data-theme="dark"] .mode-switch,
body[data-theme="dark"] .trend-toggle{background:#24211d}
.section-head{display:flex;justify-content:space-between;align-items:end;gap:20px;margin:34px 0 14px}
.section-head h3{margin:0;font-size:25px;letter-spacing:-.055em}
.section-head p{margin:4px 0 0;color:var(--muted)}
.bento{display:grid;grid-template-columns:1.15fr .85fr;gap:18px}
.panel{padding:24px;overflow:hidden}
.panel h4{font-size:18px;letter-spacing:-.045em;margin-bottom:4px}
.panel-sub{color:var(--muted);font-size:13px;margin-bottom:18px}
.chart-wrap{height:340px}
.chart-wrap svg{width:100%;height:100%;overflow:visible}
.axis{stroke:#e6e0d6;stroke-width:1}
.axis-text{fill:#8c8376;font-size:11px;font-variant-numeric:tabular-nums}
.line-total{fill:none;stroke:var(--accent);stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round}
.line-dsy{fill:none;stroke:#2f6fca;stroke-width:2.7;stroke-linecap:round;stroke-linejoin:round}
.line-lgm{fill:none;stroke:#d06d2f;stroke-width:2.7;stroke-linecap:round;stroke-linejoin:round}
.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12px}
.legend i{display:inline-block;width:16px;height:3px;border-radius:999px;margin-right:6px;vertical-align:middle}
.rank-list{display:grid;gap:8px}
.rank-row{
  border:1px solid var(--line);
  border-radius:14px;
  background:#fffdfa;
  padding:11px 12px;
  display:grid;
  grid-template-columns:34px minmax(0,1fr) auto;
  gap:10px;
  align-items:center;
  transition:transform .38s var(--ease),border-color .38s var(--ease),background .38s var(--ease);
}
.rank-row:hover{transform:translateY(-1px);border-color:var(--line-strong);background:#fff}
.rank-no{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#f0ece3;color:var(--muted);font-size:12px}
.rank-main{min-width:0}
.rank-title{font-weight:700;letter-spacing:-.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rank-meta{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rank-value{text-align:right;font-weight:760;font-variant-numeric:tabular-nums}
.rank-value span{display:block;color:var(--muted);font-weight:500;font-size:11px}
.cards-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.cards-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.operation-card{
  border:1px solid var(--line);
  border-radius:20px;
  background:#fffefa;
  padding:22px;
  min-height:174px;
  display:flex;
  flex-direction:column;
  justify-content:space-between;
  transition:transform .45s var(--ease),border-color .45s var(--ease);
}
.operation-card:hover{transform:translateY(-2px);border-color:var(--line-strong)}
.operation-card h4{font-size:20px;margin:0 0 8px;letter-spacing:-.05em}
.operation-card p{color:var(--muted);margin:0}
.operation-foot{display:flex;justify-content:space-between;align-items:center;margin-top:20px}
.big-num{font-size:34px;line-height:1;letter-spacing:-.07em;font-weight:770;font-variant-numeric:tabular-nums}
.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:24px;background:#fffefa}
.table-wrap{border-radius:18px}
table{width:100%;border-collapse:separate;border-spacing:0;min-width:820px}
th,td{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.10em;color:var(--muted);font-weight:750;background:#f6f2ea;position:sticky;top:0}
td{font-size:13px}
tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
.badge{display:inline-flex;align-items:center;gap:7px;border-radius:999px;border:1px solid var(--line);background:#f8f4ec;padding:4px 9px;font-size:12px;color:var(--muted);white-space:nowrap}
.badge:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent)}
.badge.high:before{background:var(--danger)}
.badge.warn:before{background:var(--warn)}
.badge.good:before{background:var(--good)}
.action-layout{display:grid;grid-template-columns:280px minmax(0,1fr);gap:18px}
.filter-panel{position:sticky;top:108px;align-self:start}
.filter-panel .chip{width:100%;justify-content:space-between;margin:0 0 8px;text-align:left;display:flex;align-items:center}
.action-stack{display:grid;gap:12px}
.action-card{
  border:1px solid var(--line);
  border-radius:20px;
  background:#fffefa;
  padding:18px;
  display:grid;
  grid-template-columns:minmax(0,1fr) auto;
  gap:18px;
}
.action-card.high{border-color:#e4c0ba;background:#fff9f7}
.action-card h4{margin:0 0 6px;font-size:18px;letter-spacing:-.045em}
.action-card p{margin:0;color:var(--muted)}
.action-evidence{margin-top:12px;padding:12px;border-radius:18px;background:#f6f2ea;color:#4f4a42}
.action-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.action-score{text-align:right;font-size:32px;line-height:1;letter-spacing:-.07em;font-weight:780;font-variant-numeric:tabular-nums}
.action-side{display:flex;flex-direction:column;align-items:flex-end;gap:10px}
.status-row{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.status-row button{min-height:30px;padding:0 9px;border-radius:999px;border:1px solid var(--line);background:#fff;color:var(--muted)}
.status-row button.active{background:var(--ink);color:#fff;border-color:var(--ink)}
.star{letter-spacing:1px;color:#c07a35;white-space:nowrap}
.comment-zh{font-weight:700;letter-spacing:-.02em}
.comment-raw{color:var(--muted);font-size:12px;max-width:520px}
.empty{border:1px dashed var(--line-strong);border-radius:20px;padding:32px;text-align:center;color:var(--muted);background:rgba(255,254,250,.62)}
.footer-note{margin-top:28px;color:var(--muted);font-size:12px;text-align:center}
.page-intro{
  border:1px solid var(--line);
  border-radius:20px;
  background:rgba(255,254,250,.78);
  box-shadow:0 12px 34px rgba(55,45,32,.04),inset 0 1px 0 rgba(255,255,255,.86);
  padding:18px 22px;
  margin:12px 0 18px;
  display:grid;
  grid-template-columns:minmax(0,1fr) auto;
  gap:20px;
  align-items:center;
}
.page-intro h2{
  margin:0;
  font-size:clamp(26px,2.4vw,40px);
  line-height:1.08;
  letter-spacing:-.065em;
}
.page-intro p{margin:6px 0 0;color:var(--muted);font-size:14px}
.page-intro .eyebrow{height:26px}
@media (max-width:1280px){
  .command-inner{grid-template-columns:1fr 140px 132px 132px}
  .quick{grid-column:1/-1;justify-content:flex-start}
  .kpi-grid{grid-template-columns:repeat(2,1fr)}
  .overview-grid,.home-rank-grid{grid-template-columns:1fr}
  .hero,.bento,.action-layout{grid-template-columns:1fr}
  .hero-side{grid-template-columns:repeat(2,minmax(0,1fr))}
  .filter-panel{position:relative;top:auto}
}
@media (max-width:860px){
  .sidebar{position:relative;inset:auto;width:auto;margin:12px}
  .main{margin-left:0;padding:0 12px 40px}
  .command{top:0}
  .command-inner{grid-template-columns:1fr}
  .kpi-grid,.cards-2,.cards-3{grid-template-columns:1fr}
  .hero-title{font-size:42px}
  .hero-main{padding:24px}
  .hero-side{grid-template-columns:1fr}
  .page-intro{grid-template-columns:1fr}
}
`;

const clientJs = String.raw`
(function(){
  const CNY = 1.8;
  const STORE_ORDER = ['DL','DX','FY','LQ','NM','HL','JY','ZL','TS','MZ','CX','YJ','XL','QY','QH','TZ'];
  const TABS = [
    ['overview','总控驾驶舱'],
    ['stores','店铺视角'],
    ['products','货号 360'],
    ['links','SKC / 链接'],
    ['reviews','评价 / 口碑'],
    ['orders','订单 / 售后'],
    ['profit','成本 / 利润'],
    ['inventory','实际库存 / 去化'],
    ['actions','今日动作池'],
    ['system','系统状态']
  ];
  let DATA = null;
  let state = {};
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
  const round = (v, d=0) => num(v).toLocaleString('en-US', {maximumFractionDigits:d, minimumFractionDigits:0});
  const money = v => 'SAR ' + round(v, 2);
  const rmb = v => 'RMB ' + round(num(v) * CNY, 2);
  const pct = v => v == null || !isFinite(Number(v)) ? '-' : (Number(v)*100).toFixed(1) + '%';
  const todayStr = () => DATA?.dates?.salesDate || new Date().toISOString().slice(0,10);
  const dateObj = s => new Date(String(s || '').slice(0,10) + 'T00:00:00');
  const pad2 = v => String(v).padStart(2,'0');
  const iso = d => d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate());
  const addDays = (s, days) => { const d = dateObj(s); d.setDate(d.getDate()+days); return iso(d); };
  const inRange = (date, start, end) => {
    if(!date) return false;
    const x = String(date).slice(0,10);
    return x >= start && x <= end;
  };
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g,'');
  const html = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uniq = arr => Array.from(new Set(arr.filter(Boolean)));
  const displayTime = v => {
    if(!v) return '-';
    return String(v).replace('T',' ').replace(/\.\d+(Z|\+08:00)?$/,'').replace(/\+08:00$/,'').replace(/Z$/,'');
  };

  function parseHash(){
    const raw = location.hash.replace(/^#/, '');
    const p = new URLSearchParams(raw);
    return {
      tab: p.get('tab') || 'overview',
      startDate: p.get('startDate') || '',
      endDate: p.get('endDate') || '',
      rangePreset: p.get('rangePreset') || 'today',
      store: p.get('store') || 'ALL',
      product: p.get('product') || '',
      q: p.get('q') || p.get('product') || '',
      trendMetric: p.get('trendMetric') || 'sales',
      salesMode: p.get('salesMode') || 'net',
      qtyMode: p.get('qtyMode') || 'net',
      returnsMode: p.get('returnsMode') || 'request',
      profitMode: p.get('profitMode') || 'loss',
      domain: p.get('domain') || 'all',
      priority: p.get('priority') || 'all',
      actionStatus: p.get('actionStatus') || 'open'
    };
  }
  function syncHash(replace=true){
    const p = new URLSearchParams();
    Object.entries(state).forEach(([k,v]) => { if(v && v !== 'ALL' && v !== 'all' && v !== 'open') p.set(k,v); });
    p.set('tab', state.tab || 'overview');
    p.set('startDate', state.startDate);
    p.set('endDate', state.endDate);
    const url = location.pathname + location.search + '#' + p.toString();
    if(replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
  }
  function setState(patch, push=false){
    state = Object.assign({}, state, patch);
    syncHash(!push);
    render();
  }

  function storeMeta(){
    const out = {};
    (DATA.stores || []).forEach(s => { out[s.store_key] = s; });
    STORE_ORDER.forEach(k => { if(!out[k]) out[k] = {store_key:k, group_key:k <= 'MZ' ? 'DSY' : 'LGM'}; });
    return out;
  }
  function rowScopeOk(r){
    const s = state.store || 'ALL';
    if(s === 'ALL' || s === '') return true;
    if(s === 'DSY' || s === 'LGM') return String(r.group_key || '').toUpperCase() === s;
    if(s === 'GROUP:DSY' || s === 'GROUP:LGM') return String(r.group_key || '').toUpperCase() === s.replace('GROUP:','');
    return String(r.store_key || '').toUpperCase() === s;
  }
  function rowQueryOk(r){
    const q = norm(state.q || state.product);
    if(!q) return true;
    const productFields = [r.standard_goods_sn, r.goods_title, r.raw_goods_sn, r.product_name_cn, r.skc_label].map(norm).join(' ');
    if(productFields.includes(q)) return true;
    if(q.length >= 8){
      const skcFields = [r.skc, r.skc_list, r.sku, r.sku_code].map(norm).join(' ');
      return skcFields.includes(q);
    }
    return false;
  }
  function scopedRows(rows, dateField){
    return (rows || []).filter(r => rowScopeOk(r) && rowQueryOk(r) && (!dateField || inRange(r[dateField], state.startDate, state.endDate)));
  }
  function salesRowsFor(start=state.startDate, end=state.endDate){
    return (DATA.rankings?.dailyStoreProducts || []).filter(r => rowScopeOk(r) && rowQueryOk(r) && inRange(r.date, start, end));
  }
  function profitRowsFor(start=state.startDate, end=state.endDate){
    return (DATA.profit?.dailyStoreProducts || []).filter(r => rowScopeOk(r) && rowQueryOk(r) && inRange(r.date, start, end));
  }
  function afterSalesRows(mode=state.returnsMode){
    const rows = DATA.afterSalesReview || DATA.afterSales || [];
    const field = mode === 'order' ? 'order_created_date' : 'request_time';
    return rows.filter(r => rowScopeOk(r) && rowQueryOk(r) && inRange(r[field], state.startDate, state.endDate));
  }
  function inventoryRows(){
    if(Array.isArray(DATA.inventoryDepletion)) return DATA.inventoryDepletion;
    if(Array.isArray(DATA.inventoryDepletion?.products)) return DATA.inventoryDepletion.products;
    return [];
  }
  function sum(rows, field){ return rows.reduce((a,r)=>a+num(r[field]),0); }
  function groupBy(rows, keyFn){
    const m = new Map();
    rows.forEach(r => {
      const k = keyFn(r);
      if(!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    });
    return m;
  }
  function salesSummary(rows){
    return {
      netSales: sum(rows,'sales_sar'),
      grossSales: sum(rows,'gross_sales_sar'),
      orders: sum(rows,'orders'),
      grossOrders: sum(rows,'gross_orders'),
      qty: sum(rows,'quantity'),
      grossQty: sum(rows,'gross_quantity'),
      activeProducts: uniq(rows.filter(r=>num(r.quantity)>0).map(r=>r.standard_goods_sn)).length
    };
  }
  function profitSummary(rows){
    const net = sum(rows,'net_revenue_sar');
    const gross = sum(rows,'gross_revenue_sar');
    const conservative = sum(rows,'profit_before_storage_sar');
    const rtv = sum(rows,'profit_if_rtv_received_resellable_sar');
    const cost = sum(rows,'product_cost_sar');
    const fee = sum(rows,'return_delivery_fee_sar');
    const chosen = state.profitMode === 'rtv' ? rtv : conservative;
    return {net, gross, conservative, rtv, chosen, cost, fee, margin: net ? chosen / net : null};
  }
  function returnSummary(rows){
    return {cases: rows.length, amount: rows.reduce((a,r)=>a+num(r.amount_sar || r.order_sales_sar || r.price_amount_total),0)};
  }
  function current(){
    const sales = salesSummary(salesRowsFor());
    const profit = profitSummary(profitRowsFor());
    const returns = returnSummary(afterSalesRows());
    return {sales, profit, returns};
  }
  function metricSalesValue(sales){
    return state.salesMode === 'gross' ? sales.grossSales : sales.netSales;
  }
  function metricOrders(sales){
    return state.qtyMode === 'gross'
      ? {orders:sales.grossOrders, qty:sales.grossQty}
      : {orders:sales.orders, qty:sales.qty};
  }

  function setPreset(name){
    const t = todayStr();
    let s = t, e = t;
    if(name === 'yesterday'){ s = e = addDays(t,-1); }
    if(name === 'last7'){ s = addDays(t,-6); }
    if(name === 'last30'){ s = addDays(t,-29); }
    if(name === 'month'){ s = t.slice(0,8)+'01'; }
    if(name === 'lastMonth'){
      const d = dateObj(t); d.setDate(1); d.setMonth(d.getMonth()-1);
      s = iso(d); const eD = new Date(d); eD.setMonth(eD.getMonth()+1); eD.setDate(0); e = iso(eD);
    }
    setState({startDate:s,endDate:e,rangePreset:name}, true);
  }

  function renderShell(){
    $('#nav').innerHTML = TABS.map(t => '<button data-tab="'+t[0]+'" class="'+(state.tab===t[0]?'active':'')+'"><span>'+t[1]+'</span><span class="dot"></span></button>').join('');
    const stores = storeMeta();
    $('#storeSelect').innerHTML = ['<option value="ALL">全部店铺</option><option value="DSY">DSY 组</option><option value="LGM">LGM 组</option>']
      .concat(STORE_ORDER.map(k => '<option value="'+k+'">'+k+' · '+(stores[k]?.group_key || '')+'</option>')).join('');
    $('#storeSelect').value = state.store || 'ALL';
    $('#globalQ').value = state.q || '';
    $('#startDate').value = state.startDate;
    $('#endDate').value = state.endDate;
    document.querySelectorAll('[data-preset]').forEach(btn => btn.classList.toggle('active', btn.dataset.preset === state.rangePreset));
    $('#dataFresh').innerHTML =
      '<b>数据刷新</b>' +
      '<div>SHEIN 销售：'+html(displayTime(DATA.dates?.salesUpdatedAt || DATA.dates?.salesDate))+'</div>' +
      '<div>业务域：'+html(displayTime(DATA.dates?.businessUpdatedAt || DATA.dates?.businessDate))+'</div>' +
      '<div>ET 仓：'+html(displayTime(DATA.dates?.etUpdatedAt))+'</div>';
  }

  function pageTitle(){
    const range = state.startDate === state.endDate ? state.startDate : state.startDate + ' 至 ' + state.endDate;
    const scope = state.store === 'ALL' || !state.store ? '全部店铺' : String(state.store).replace('GROUP:','') + (String(state.store).startsWith('GROUP:') ? ' 组' : '');
    return {range, scope, q: state.q ? ' · '+state.q : ''};
  }

  function homeScopeRows(){
    const s = state.store || 'ALL';
    if(s === 'DSY' || s === 'GROUP:DSY') return [{label:'DSY 组', scope:'GROUP:DSY'}];
    if(s === 'LGM' || s === 'GROUP:LGM') return [{label:'LGM 组', scope:'GROUP:LGM'}];
    if(s && s !== 'ALL') return [{label:s, scope:s}];
    return [{label:'总计', scope:'ALL'}, {label:'DSY 组', scope:'GROUP:DSY'}, {label:'LGM 组', scope:'GROUP:LGM'}];
  }
  function scopeMatch(r, scope){
    if(!scope || scope === 'ALL') return true;
    if(scope === 'GROUP:DSY' || scope === 'GROUP:LGM') return String(r.group_key || '').toUpperCase() === scope.replace('GROUP:','');
    return String(r.store_key || '').toUpperCase() === String(scope).toUpperCase();
  }
  function productScopeQuery(){ return String(state.q || state.product || '').trim(); }
  function productScopedOk(r){ return rowQueryOk(r); }
  function salesKey(){ return state.salesMode === 'gross' ? 'gross_sales_sar' : 'sales_sar'; }
  function orderKey(){ return state.qtyMode === 'gross' ? 'gross_orders' : 'orders'; }
  function qtyKey(){ return state.qtyMode === 'gross' ? 'gross_quantity' : 'quantity'; }
  function profitKey(){ return state.profitMode === 'rtv' ? 'profit_if_rtv_received_resellable_sar' : 'profit_before_storage_sar'; }
  function scopedSalesRows(start, end, scope){
    const hasProduct = Boolean(productScopeQuery());
    const source = hasProduct ? (DATA.rankings?.dailyStoreProducts || []) : (DATA.rankings?.dailyStores || []);
    return source.filter(r => {
      const d = String(r.date || '').slice(0,10);
      if(!d || d < start || d > end) return false;
      if(!scopeMatch(r, scope)) return false;
      if(hasProduct && !productScopedOk(r)) return false;
      return true;
    });
  }
  function scopedProductRows(start, end, scope){
    return (DATA.rankings?.dailyStoreProducts || []).filter(r => {
      const d = String(r.date || '').slice(0,10);
      return d && d >= start && d <= end && scopeMatch(r, scope) && productScopedOk(r);
    });
  }
  function salesForScope(start, end, scope){
    const rows = scopedSalesRows(start, end, scope);
    return {sales_sar:sum(rows, salesKey()), orders:sum(rows, orderKey()), quantity:sum(rows, qtyKey())};
  }
  function activeProductsForScope(start, end, scope){
    const set = new Set();
    scopedProductRows(start, end, scope).forEach(r => {
      if(num(r[qtyKey()] ?? r.quantity) > 0 && r.standard_goods_sn) set.add(r.standard_goods_sn);
    });
    return set.size;
  }
  function afterSalesForScope(start, end, scope){
    const hasProduct = Boolean(productScopeQuery());
    if(state.returnsMode === 'order'){
      const rows = scopedSalesRows(start, end, scope);
      return {
        cases: rows.reduce((a,r)=>a+Math.max(0, num(r.gross_orders ?? r.orders) - num(r.orders)), 0),
        amount_sar: rows.reduce((a,r)=>a+Math.max(0, num(r.gross_sales_sar ?? r.sales_sar) - num(r.sales_sar)), 0)
      };
    }
    const rows = (DATA.afterSales || DATA.afterSalesReview || []).filter(r => {
      const d = String(r.request_time || r.snapshot_date || '').slice(0,10);
      if(!d || d < start || d > end) return false;
      if(String(r.order_sub_status_name || r.status || '').trim() === '已取消') return false;
      if(!scopeMatch(r, scope)) return false;
      if(hasProduct && !productScopedOk(r)) return false;
      return true;
    });
    return {cases: rows.length, amount_sar: rows.reduce((a,r)=>a+num(r.price_amount_total || r.amount_sar || r.order_sales_sar || r.refund_amount),0)};
  }
  function profitForScope(start, end, scope){
    const rows = (DATA.profit?.dailyStoreProducts || []).filter(r => {
      const d = String(r.date || '').slice(0,10);
      return d && d >= start && d <= end && scopeMatch(r, scope) && productScopedOk(r);
    });
    const revenue = sum(rows,'net_revenue_sar');
    const profit = sum(rows, profitKey());
    return {revenue, profit, margin: revenue ? profit / revenue : null, missing: sum(rows,'missing_cost_lines')};
  }
  function modeSwitch(key, items){
    return '<div class="mode-switch">'+items.map(it => '<button type="button" class="'+(state[key] === it.value ? 'active' : '')+'" data-mode-key="'+key+'" data-mode-value="'+it.value+'">'+html(it.label)+'</button>').join('')+'</div>';
  }
  function matrixCell(v, cls){ return '<div class="cell '+(cls || 'value')+'">'+v+'</div>'; }
  function homeMatrix(cols, heads, rows){
    return '<div class="home-matrix" style="--cols:'+cols+'">'+matrixCell('范围','head')+heads.map(h=>matrixCell(html(h),'head')).join('')+rows.join('')+'</div>';
  }
  function overviewCard(title, sub, switchHtml, body){
    return '<article class="overview-card"><div class="overview-card-head"><div><h4>'+html(title)+'</h4><div class="sub">'+html(sub)+'</div></div>'+switchHtml+'</div>'+body+'</article>';
  }
  function overviewMatrices(){
    const p = pageTitle();
    const rows = homeScopeRows().map(r => {
      const s = salesForScope(state.startDate, state.endDate, r.scope);
      const a = afterSalesForScope(state.startDate, state.endDate, r.scope);
      const pr = profitForScope(state.startDate, state.endDate, r.scope);
      return {...r, sales:s, after:a, profit:pr, active:activeProductsForScope(state.startDate, state.endDate, r.scope)};
    });
    const salesBody = homeMatrix(2, ['SAR','RMB'], rows.map(r => matrixCell(html(r.label),'label')+matrixCell(money(r.sales.sales_sar).replace('SAR ','')+'<small>'+html(state.salesMode === 'gross' ? '总销售额' : '净销售额')+'</small>')+matrixCell(rmb(r.sales.sales_sar).replace('RMB ',''))));
    const qtyBody = homeMatrix(3, ['订单','销量','动销货号'], rows.map(r => matrixCell(html(r.label),'label')+matrixCell(round(r.sales.orders,0)+' <small>单</small>')+matrixCell(round(r.sales.quantity,0)+' <small>件</small>')+matrixCell(round(r.active,0)+' <small>个</small>')));
    const returnsBody = homeMatrix(3, ['数量','SAR','RMB'], rows.map(r => matrixCell(html(r.label),'label')+matrixCell(round(r.after.cases,0)+' <small>单</small>')+matrixCell(money(r.after.amount_sar).replace('SAR ',''))+matrixCell(rmb(r.after.amount_sar).replace('RMB ',''))));
    const profitBody = homeMatrix(3, ['SAR','RMB','利润率'], rows.map(r => {
      const cls = r.profit.margin == null ? '' : r.profit.margin >= .2 ? 'positive' : r.profit.margin >= .1 ? 'warn' : 'danger';
      return matrixCell(html(r.label),'label')+matrixCell('<span class="'+cls+'">'+money(r.profit.profit).replace('SAR ','')+'</span><small>'+html(state.profitMode === 'rtv' ? 'RTV二售测算' : '退货全损保守')+'</small>')+matrixCell(rmb(r.profit.profit).replace('RMB ',''))+matrixCell(r.profit.margin == null ? '-' : '<span class="'+cls+'">'+pct(r.profit.margin)+'</span>');
    }));
    return '<div class="overview-grid">'+
      overviewCard(state.salesMode === 'gross' ? '当前时段总销售额' : '当前时段净销售额', p.range+' · '+p.scope, modeSwitch('salesMode', [{value:'net',label:'净销售额'}, {value:'gross',label:'总销售额'}]), salesBody)+
      overviewCard('当前时段订单 / 销量 / 动销', p.range+' · '+p.scope, modeSwitch('qtyMode', [{value:'net',label:'净销量'}, {value:'gross',label:'总销量'}]), qtyBody)+
      overviewCard('当前时段退货 / 售后', state.returnsMode === 'order' ? '按订单创建时间 · 未取消售后' : '按售后申请时间', modeSwitch('returnsMode', [{value:'request',label:'售后申请时间'}, {value:'order',label:'订单创建时间'}]), returnsBody)+
      overviewCard('当前时段真实利润', state.profitMode === 'rtv' ? '按RTV已收入仓可二售测算' : '按退货全损保守估计', modeSwitch('profitMode', [{value:'loss',label:'全损保守'}, {value:'rtv',label:'RTV入仓测算'}]), profitBody)+
    '</div>';
  }
  function addMonths(dateText, delta){ const d = dateObj(dateText); d.setMonth(d.getMonth()+delta); return iso(d); }
  function monthStart(dateText){ return String(dateText || '').slice(0,7) + '-01'; }
  function monthEnd(dateText){ const d = dateObj(monthStart(dateText)); d.setMonth(d.getMonth()+1); d.setDate(0); return iso(d); }
  function chartRange(kind){
    const e = state.endDate || todayStr();
    const s = state.startDate || e;
    if(kind === 'month') return s === e ? {start:monthStart(addMonths(e,-5)), end:e} : {start:s, end:e};
    return s === e ? {start:addDays(e,-29), end:e} : {start:s, end:e};
  }
  function trendMetricKey(){ if(state.trendMetric === 'qty') return 'quantity'; return ['sales','quantity','returns','profit'].includes(state.trendMetric) ? state.trendMetric : 'sales'; }
  function trendMetricLabel(){ return ({sales:'销售额', quantity:'销量', returns:'退货数量', profit:'利润额'})[trendMetricKey()] || '销售额'; }
  function trendMetricButtonsHome(){
    return '<div class="trend-toggle">'+[['sales','销售额'],['quantity','销量'],['returns','退货数量'],['profit','利润额']].map(x=>'<button type="button" class="'+(trendMetricKey()===x[0]?'active':'')+'" data-trend="'+x[0]+'">'+x[1]+'</button>').join('')+'</div>';
  }
  function metricValueForScope(start, end, scope){
    const metric = trendMetricKey();
    if(metric === 'sales') return salesForScope(start, end, scope).sales_sar;
    if(metric === 'quantity') return salesForScope(start, end, scope).quantity;
    if(metric === 'returns') return afterSalesForScope(start, end, scope).cases;
    if(metric === 'profit') return profitForScope(start, end, scope).profit;
    return 0;
  }
  function metricSeries(kind){
    const r = chartRange(kind);
    const scopes = homeScopeRows();
    const scoped = scopes.length === 1;
    const rows = [];
    if(kind === 'month'){
      for(let m = monthStart(r.start); m <= monthStart(r.end); m = monthStart(addMonths(m,1))){
        const bs = m < r.start ? r.start : m;
        const me = monthEnd(m);
        const be = me > r.end ? r.end : me;
        const row = {date:m.slice(0,7), label:m.slice(0,7)};
        if(scoped) row.scope = metricValueForScope(bs, be, scopes[0].scope);
        else { row.total = metricValueForScope(bs, be, 'ALL'); row.dsy = metricValueForScope(bs, be, 'GROUP:DSY'); row.lgm = metricValueForScope(bs, be, 'GROUP:LGM'); }
        rows.push(row);
      }
      return rows;
    }
    for(let d = r.start; d <= r.end; d = addDays(d,1)){
      const row = {date:d, label:d};
      if(scoped) row.scope = metricValueForScope(d, d, scopes[0].scope);
      else { row.total = metricValueForScope(d, d, 'ALL'); row.dsy = metricValueForScope(d, d, 'GROUP:DSY'); row.lgm = metricValueForScope(d, d, 'GROUP:LGM'); }
      rows.push(row);
    }
    return rows;
  }
  function homeLineChart(rows){
    if(!rows.length) return '<div class="empty">当前范围暂无趋势数据。</div>';
    const scoped = rows[0].scope != null;
    const keys = scoped ? ['scope'] : ['total','dsy','lgm'];
    const color = {scope:'var(--accent)', total:'var(--accent)', dsy:'#2f6fca', lgm:'#d06d2f'};
    const W=1500,H=330,L=78,R=24,T=26,B=56;
    const vals = rows.flatMap(r=>keys.map(k=>num(r[k])));
    const max = Math.max(1, ...vals) * 1.1;
    const x = i => L + (rows.length<=1 ? 0 : i*(W-L-R)/(rows.length-1));
    const y = v => H-B - (num(v)/max)*(H-T-B);
    const path = key => rows.map((r,i)=> (i?'L':'M') + x(i).toFixed(1) + ' ' + y(r[key]).toFixed(1)).join(' ');
    const ticks = [0,.25,.5,.75,1].map(p=>Math.round(max*p));
    const labelStep = Math.max(1, Math.ceil(rows.length / 7));
    const valueText = v => round(v,0);
    return '<svg viewBox="0 0 '+W+' '+H+'" role="img">'+
      ticks.map(v=>'<line class="axis" x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v)+'" y2="'+y(v)+'"></line><text class="axis-text" x="'+(L-12)+'" y="'+(y(v)+4)+'" text-anchor="end">'+valueText(v)+'</text>').join('')+
      rows.map((r,i)=> i%labelStep===0 || i===rows.length-1 ? '<text class="axis-text" x="'+x(i)+'" y="'+(H-18)+'" text-anchor="middle">'+html((r.label || '').slice(5) || r.label)+'</text>' : '').join('')+
      keys.map(k=>'<path d="'+path(k)+'" style="fill:none;stroke:'+color[k]+';stroke-width:'+(k==='total'||k==='scope'?3.2:2.7)+';stroke-linecap:round;stroke-linejoin:round"></path>').join('')+
      rows.map((r,i)=> (i===rows.length-1 || (rows.length>8 && i===Math.floor(rows.length/2))) ? keys.map(k=>'<g><circle cx="'+x(i)+'" cy="'+y(r[k])+'" r="4" fill="'+color[k]+'"></circle><text class="axis-text" x="'+x(i)+'" y="'+(y(r[k])-10)+'" text-anchor="middle">'+valueText(r[k])+'</text></g>').join('') : '').join('')+
      '</svg>';
  }
  function homeLegend(){
    const scoped = homeScopeRows().length === 1;
    if(scoped) return '<div class="legend"><span><i style="background:var(--accent)"></i>'+html(pageTitle().scope)+'</span></div>';
    return '<div class="legend"><span><i style="background:var(--accent)"></i>总计</span><span><i style="background:#2f6fca"></i>DSY</span><span><i style="background:#d06d2f"></i>LGM</span></div>';
  }
  function homeStoreRanksBy(key){
    const rows = salesRowsFor();
    return Array.from(groupBy(rows, r=>r.store_key).entries()).map(([store,list]) => {
      const s = salesSummary(list);
      return {key:store,title:store,group:list[0]?.group_key || '',sales:s.netSales,quantity:s.qty,orders:s.orders,days:uniq(list.map(r=>r.date)).length,value:key==='quantity'?s.qty:s.netSales};
    }).sort((a,b)=>b.value-a.value);
  }
  function homeProductRanksBy(key){
    const rows = salesRowsFor();
    return Array.from(groupBy(rows, r=>r.standard_goods_sn || '-').entries()).map(([p,list]) => {
      const s = salesSummary(list);
      return {key:p,title:p,sales:s.netSales,quantity:s.qty,orders:s.orders,stores:uniq(list.map(r=>r.store_key)).length,days:uniq(list.map(r=>r.date)).length,value:key==='quantity'?s.qty:s.netSales};
    }).sort((a,b)=>b.value-a.value);
  }
  function homeRankList(items, type, metric){
    if(!items.length) return '<div class="empty">当前筛选暂无排行数据。</div>';
    return '<div class="home-rank-list">'+items.map((r,i) => {
      const value = metric === 'quantity' ? round(r.value,0)+' 件' : money(r.value).replace('SAR ','');
      const sub = metric === 'quantity' ? money(r.sales) : rmb(r.sales);
      const meta = type === 'store' ? (r.group+' · 订单 '+round(r.orders,0)+' · 销量 '+round(r.quantity,0)+' 件 · '+round(r.days,0)+' 天') : ('覆盖 '+round(r.stores,0)+' 店 · 订单 '+round(r.orders,0)+' · 销量 '+round(r.quantity,0)+' 件 · '+round(r.days,0)+' 天');
      return '<button class="home-rank-row" data-home-'+type+'="'+html(r.key)+'"><span class="rank-no">'+(i+1)+'</span><span><span class="rank-name">'+html(r.title)+'</span><span class="rank-meta">'+html(meta)+'</span></span><span class="rank-number">'+html(value)+'<small>'+html(sub)+'</small></span></button>';
    }).join('')+'</div>';
  }
  function renderOverview(){
    const p = pageTitle();
    const actionCount = (DATA.actions || []).length;
    const linkDate = DATA.dates?.linkDate || '-';
    return [
      '<section class="hero">',
        '<div class="hero-main">',
          '<span class="eyebrow"><i></i>Overview</span>',
          '<h2 class="hero-title">经营总控驾驶舱</h2>',
          '<p class="hero-copy">当前口径：'+html(p.range)+' · '+html(p.scope)+html(p.q)+'。这里完整复刻 V1 首页的筛选、四个经营矩阵、趋势切换和排行榜下钻；视觉层只做 V2 优化。</p>',
          '<div class="overview-scope-line"><span class="badge">销售/订单 '+html(displayTime(DATA.dates?.salesUpdatedAt || DATA.dates?.salesDate))+'</span><span class="badge">业务域 '+html(displayTime(DATA.dates?.businessUpdatedAt || DATA.dates?.businessDate))+'</span><span class="badge">链接 '+html(linkDate)+'</span></div>',
        '</div>',
        '<aside class="hero-side">',
          '<div class="decision-card"><b>'+round(actionCount,0)+' 条当前动作</b><p>具体处理进入今日动作池；首页只放总体判断。</p></div>',
          '<div class="decision-card"><b>'+html(state.salesMode === 'gross' ? '总销售额口径' : '净销售额口径')+'</b><p>销售额矩阵与趋势图会跟随切换。</p></div>',
          '<div class="decision-card"><b>'+html(state.profitMode === 'rtv' ? 'RTV入仓测算' : '退货全损保守')+'</b><p>利润矩阵与利润趋势同步使用该口径。</p></div>',
          '<div class="decision-card"><b>'+html(state.returnsMode === 'order' ? '按订单创建时间' : '按售后申请时间')+'</b><p>退货售后矩阵与趋势同步使用该口径。</p></div>',
          '<div class="meta-line"><span>页面生成 '+html(displayTime(DATA.generatedAt))+'</span><span>销售日 '+html(DATA.dates?.salesDate||'-')+'</span></div>',
        '</aside>',
      '</section>',
      overviewMatrices(),
      '<div class="trend-toolbar"><div><h3>趋势</h3><p>日趋势默认近 30 天，月趋势默认近 6 个月；选择店铺、分组或货号后自动切到对应范围。</p></div>'+trendMetricButtonsHome()+'</div>',
      '<section class="trend-stack">',
        '<article class="panel trend-panel"><h4>日趋势 · '+html(trendMetricLabel())+'</h4><p class="panel-sub">'+html(homeScopeRows().length === 1 ? pageTitle().scope : '总计 / DSY / LGM 三条线')+'</p><div class="chart-wrap">'+homeLineChart(metricSeries('day'))+'</div>'+homeLegend()+'</article>',
        '<article class="panel trend-panel"><h4>月趋势 · '+html(trendMetricLabel())+'</h4><p class="panel-sub">按所选日期切片聚合，非整月时只统计选中日期范围内的数据。</p><div class="chart-wrap">'+homeLineChart(metricSeries('month'))+'</div>'+homeLegend()+'</article>',
      '</section>',
      '<div class="section-head"><div><h3>排行榜</h3><p>店铺只显示代号；货号按标准货号归并。排行完整展示当前筛选结果，点击即可下钻。</p></div></div>',
      '<section class="home-rank-grid">',
        '<article class="panel"><h4>店铺净成交额排行</h4><p class="panel-sub">当前时段 · 按 SAR 排序。</p>'+homeRankList(homeStoreRanksBy('sales'),'store','sales')+'</article>',
        '<article class="panel"><h4>店铺净销量排行</h4><p class="panel-sub">当前时段 · 按净销量件数排序。</p>'+homeRankList(homeStoreRanksBy('quantity'),'store','quantity')+'</article>',
        '<article class="panel"><h4>产品净成交额排行</h4><p class="panel-sub">当前时段 · 按标准货号归并。</p>'+homeRankList(homeProductRanksBy('sales'),'product','sales')+'</article>',
        '<article class="panel"><h4>产品净销量排行</h4><p class="panel-sub">当前时段 · 按标准货号归并。</p>'+homeRankList(homeProductRanksBy('quantity'),'product','quantity')+'</article>',
      '</section>'
    ].join('');
  }

  function renderKpis(c){
    const salesValue = metricSalesValue(c.sales);
    const oq = metricOrders(c.sales);
    return '<section class="grid kpi-grid">' +
      '<div class="kpi"><div class="kpi-label">当前时段'+(state.salesMode==='gross'?'总销售额':'净销售额')+'</div><div class="kpi-value">'+money(salesValue).replace('SAR ','')+'</div><div class="kpi-sub">'+rmb(salesValue)+' · <button class="chip '+(state.salesMode==='net'?'active':'')+'" data-sales-mode="net">净</button> <button class="chip '+(state.salesMode==='gross'?'active':'')+'" data-sales-mode="gross">总</button></div></div>' +
      '<div class="kpi good"><div class="kpi-label">订单 / 销量 / 动销</div><div class="kpi-small"><div><span>订单</span><b>'+round(oq.orders,0)+'</b></div><div><span>销量</span><b>'+round(oq.qty,0)+'</b></div><div><span>货号</span><b>'+round(c.sales.activeProducts,0)+'</b></div></div><div class="kpi-sub"><button class="chip '+(state.qtyMode==='net'?'active':'')+'" data-qty-mode="net">净销量</button> <button class="chip '+(state.qtyMode==='gross'?'active':'')+'" data-qty-mode="gross">总销量</button></div></div>' +
      '<div class="kpi warn"><div class="kpi-label">退货 / 售后</div><div class="kpi-value">'+round(c.returns.cases,0)+'</div><div class="kpi-sub">'+money(c.returns.amount)+' · '+rmb(c.returns.amount)+'<br><button class="chip '+(state.returnsMode==='request'?'active':'')+'" data-returns-mode="request">申请时间</button> <button class="chip '+(state.returnsMode==='order'?'active':'')+'" data-returns-mode="order">订单时间</button></div></div>' +
      '<div class="kpi danger"><div class="kpi-label">真实经营利润</div><div class="kpi-value">'+round(c.profit.chosen,2)+'</div><div class="kpi-sub">'+money(c.profit.chosen)+' · 利润率 '+pct(c.profit.margin)+'<br><button class="chip '+(state.profitMode==='loss'?'active':'')+'" data-profit-mode="loss">全损</button> <button class="chip '+(state.profitMode==='rtv'?'active':'')+'" data-profit-mode="rtv">RTV</button></div></div>' +
    '</section>';
  }
  function trendName(){ return ({sales:'销售额',qty:'销量',returns:'退货数量',profit:'利润额'})[state.trendMetric] || '销售额'; }
  function dailyTrend(){
    const end = state.endDate || todayStr();
    const start = state.startDate === state.endDate ? addDays(end,-29) : state.startDate;
    const days=[]; for(let d=start; d<=end; d=addDays(d,1)) days.push(d);
    const rows = state.trendMetric === 'profit' ? profitRowsFor(start,end) : salesRowsFor(start,end);
    const retRows = state.trendMetric === 'returns' ? (DATA.afterSalesReview||[]).filter(r=>inRange(r.request_time,start,end) && rowScopeOk(r) && rowQueryOk(r)) : [];
    return days.map(day => {
      const rowDay = rows.filter(r=>r.date===day);
      const retDay = retRows.filter(r=>String(r.request_time||'').slice(0,10)===day);
      const byGroup = g => rowDay.filter(r=>g==='ALL' || r.group_key===g);
      const valueFor = list => state.trendMetric==='qty' ? sum(list,'quantity') : state.trendMetric==='profit' ? sum(list, state.profitMode==='rtv'?'profit_if_rtv_received_resellable_sar':'profit_before_storage_sar') : sum(list, state.salesMode==='gross'?'gross_sales_sar':'sales_sar');
      return {
        date: day,
        total: state.trendMetric==='returns' ? retDay.length : valueFor(rowDay),
        dsy: state.trendMetric==='returns' ? retDay.filter(r=>r.group_key==='DSY').length : valueFor(byGroup('DSY')),
        lgm: state.trendMetric==='returns' ? retDay.filter(r=>r.group_key==='LGM').length : valueFor(byGroup('LGM'))
      };
    });
  }
  function lineChart(rows){
    const W=980,H=300,L=62,R=24,T=24,B=44;
    const vals = rows.flatMap(r=>[r.total,r.dsy,r.lgm]).map(num);
    const max = Math.max(1, ...vals) * 1.08;
    const x = i => L + (rows.length<=1 ? 0 : i*(W-L-R)/(rows.length-1));
    const y = v => H-B - (num(v)/max)*(H-T-B);
    const path = key => rows.map((r,i)=> (i?'L':'M') + x(i).toFixed(1) + ' ' + y(r[key]).toFixed(1)).join(' ');
    const ticks = [0,.25,.5,.75,1].map(p=>Math.round(max*p));
    const labels = rows.filter((r,i)=> i===0 || i===rows.length-1 || i%Math.ceil(rows.length/5)===0);
    return '<svg viewBox="0 0 '+W+' '+H+'" role="img">' +
      ticks.map(v=>'<line class="axis" x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v)+'" y2="'+y(v)+'"></line><text class="axis-text" x="'+(L-10)+'" y="'+(y(v)+4)+'" text-anchor="end">'+round(v,0)+'</text>').join('') +
      labels.map(r=>'<text class="axis-text" x="'+x(rows.indexOf(r))+'" y="'+(H-14)+'" text-anchor="middle">'+r.date.slice(5)+'</text>').join('') +
      '<path class="line-total" d="'+path('total')+'"></path><path class="line-dsy" d="'+path('dsy')+'"></path><path class="line-lgm" d="'+path('lgm')+'"></path>' +
      rows.filter((r,i)=>i===rows.length-1 || (rows.length>8 && i===Math.floor(rows.length/2))).map((r,i)=>'<g><circle cx="'+x(rows.indexOf(r))+'" cy="'+y(r.total)+'" r="4" fill="var(--accent)"></circle><text class="axis-text" x="'+x(rows.indexOf(r))+'" y="'+(y(r.total)-10)+'" text-anchor="middle">'+round(r.total,0)+'</text></g>').join('') +
      '</svg>';
  }
  function legend(){
    return '<div class="legend"><span><i style="background:var(--accent)"></i>总计</span><span><i style="background:#2f6fca"></i>DSY</span><span><i style="background:#d06d2f"></i>LGM</span></div>';
  }
  function storeRanks(){
    const rows = salesRowsFor();
    return Array.from(groupBy(rows, r=>r.store_key).entries()).map(([store,list]) => {
      const s = salesSummary(list);
      return {key:store,title:store,meta:(list[0]?.group_key||'')+' · 订单 '+round(s.orders,0)+' · 销量 '+round(s.qty,0),value:s.sales_sar || s.netSales || sum(list,'sales_sar'), sub:rmb(sum(list,'sales_sar')), store};
    }).sort((a,b)=>b.value-a.value);
  }
  function productRanks(){
    const rows = salesRowsFor();
    return Array.from(groupBy(rows, r=>r.standard_goods_sn || '-').entries()).map(([p,list]) => {
      const s = salesSummary(list);
      return {key:p,title:p,meta:'覆盖 '+uniq(list.map(r=>r.store_key)).length+' 店 · 订单 '+round(s.orders,0)+' · 销量 '+round(s.qty,0),value:sum(list,'sales_sar'), sub:rmb(sum(list,'sales_sar')), product:p};
    }).sort((a,b)=>b.value-a.value);
  }
  function rankList(items,type){
    if(!items.length) return '<div class="empty">当前筛选没有排行数据。</div>';
    return '<div class="rank-list">' + items.map((r,i)=>'<button class="rank-row" data-'+type+'="'+html(r.key)+'"><span class="rank-no">'+(i+1)+'</span><span class="rank-main"><span class="rank-title">'+html(r.title)+'</span><span class="rank-meta">'+html(r.meta)+'</span></span><span class="rank-value">'+money(r.value).replace('SAR ','')+'<span>'+html(r.sub||'')+'</span></span></button>').join('') + '</div>';
  }
  function operationMini(){
    const actions = DATA.actions || [];
    const inv = inventoryRows();
    const profit = DATA.profit?.products || [];
    const comments = DATA.comments || [];
    return '<div class="grid">' +
      '<div class="operation-card" data-tab="actions"><h4>今日动作池</h4><p>'+actions.length+' 条待办，按分数排序处理。</p><div class="operation-foot"><span class="big-num">'+actions.length+'</span><button class="pill-btn">处理</button></div></div>' +
      '<div class="operation-card" data-tab="inventory"><h4>库存去化</h4><p>高风险库存和断货候选。</p><div class="operation-foot"><span class="big-num">'+inv.filter(x=>x.risk_level==='high').length+'</span><button class="pill-btn">查看</button></div></div>' +
      '<div class="operation-card" data-tab="profit"><h4>利润分层</h4><p>20% 利润率作为高低分界。</p><div class="operation-foot"><span class="big-num">'+profit.filter(x=>num(x.profit_margin_before_storage)>=.2).length+'</span><button class="pill-btn">分析</button></div></div>' +
      '<div class="operation-card" data-tab="reviews"><h4>评价风险</h4><p>低星和质量投诉集中复核。</p><div class="operation-foot"><span class="big-num">'+comments.filter(x=>num(x.goods_comment_star)<=3).length+'</span><button class="pill-btn">复核</button></div></div>' +
    '</div>';
  }
  function operationCards(){
    const acts = DATA.actions || [];
    const after = DATA.afterSalesReview || DATA.afterSales || [];
    const inv = inventoryRows();
    const profits = DATA.profit?.products || [];
    const cards = [
      ['orders','订单 / 售后','成交是否真实，售后压力来自哪里。', after.length, '售后记录'],
      ['profit','成本 / 利润','哪些货号值得加码，哪些正在吃利润。', profits.filter(p=>num(p.profit_margin_before_storage)<.2).length, '低利润货号'],
      ['inventory','实际库存 / 去化','在库、在途和断货风险是否能接上。', inv.filter(x=>x.risk_level==='high').length, '高风险货号'],
      ['actions','运营动作','今天先处理什么，谁负责，是否复查。', acts.length, '动作']
    ];
    return cards.map(c=>'<button class="operation-card" data-tab="'+c[0]+'"><div><h4>'+c[1]+'</h4><p>'+c[2]+'</p></div><div class="operation-foot"><span><span class="big-num">'+round(c[3],0)+'</span><br><span class="kpi-sub">'+c[4]+'</span></span><span class="primary">进入 <span class="arrow">→</span></span></div></button>').join('');
  }

  function renderStores(){
    const ranks = storeRanks();
    const latest = storeMeta();
    return sectionIntro('店铺视角','这个页面回答：哪个店今天最该看，问题来自销售、售后、链接还是库存。') +
      '<section class="grid cards-3">' + STORE_ORDER.map(k => {
        const r = ranks.find(x=>x.store===k) || {value:0,meta:'无当前销售'};
        const m = latest[k] || {};
        return '<button class="operation-card" data-store="'+k+'"><div><span class="badge '+(num(m.risk_score)>120?'high':'')+'">'+html(m.group_key||'')+'</span><h4 style="margin-top:14px">'+k+'</h4><p>'+html(m.shop_name||'')+'</p></div><div class="operation-foot"><span><span class="big-num">'+round(r.value,0)+'</span><br><span class="kpi-sub">'+html(r.meta)+'</span></span><span class="pill-btn">下钻</span></div></button>';
      }).join('') + '</section>' +
      '<div class="section-head"><div><h3>店铺完整排行</h3><p>点击任意店铺会把全局筛选切到该店。</p></div></div><section class="panel">'+rankList(ranks,'store')+'</section>';
  }
  function renderProducts(){
    const products = productRanks();
    const profitMap = new Map((DATA.profit?.products||[]).map(p=>[p.standard_goods_sn,p]));
    const matrix = DATA.matrix || [];
    const rows = products.slice(0,80).map(p=>{
      const pr = profitMap.get(p.key) || {};
      const mRows = matrix.filter(x=>x.standard_goods_sn===p.key);
      const onShelf = uniq(mRows.filter(x=>num(x.on_shelf_count)>0).map(x=>x.store_key)).length;
      const actions = (DATA.actions||[]).filter(a=>a.standard_goods_sn===p.key).length;
      return {p,pr,onShelf,actions};
    });
    return sectionIntro('货号 360','这个页面回答：一个标准货号在 16 店的覆盖、销售、利润和风险是否匹配。') +
      '<section class="panel"><div class="table-wrap"><table><thead><tr><th>货号</th><th class="num">净销售额</th><th class="num">销量</th><th class="num">覆盖</th><th class="num">利润率</th><th class="num">动作</th><th>建议</th></tr></thead><tbody>' +
      rows.map(x=>'<tr><td><button class="pill-btn" data-product="'+html(x.p.key)+'">'+html(x.p.key)+'</button><div class="kpi-sub">'+html(x.p.meta)+'</div></td><td class="num">'+money(x.p.value)+'</td><td class="num">'+html((x.p.meta.match(/销量 ([\\d,]+)/)||[])[1]||'-')+'</td><td class="num">'+x.onShelf+'/16</td><td class="num">'+pct(x.pr.profit_margin_before_storage)+'</td><td class="num">'+x.actions+'</td><td>'+productAdvice(x.pr,x.onShelf,x.actions)+'</td></tr>').join('') +
      '</tbody></table></div></section>';
  }
  function productAdvice(pr,onShelf,actions){
    if(pr && num(pr.profit_margin_before_storage) >= .28 && onShelf < 16) return '<span class="badge good">可扩覆盖</span>';
    if(pr && num(pr.profit_margin_before_storage) < .2) return '<span class="badge high">利润偏低</span>';
    if(actions > 5) return '<span class="badge warn">先处理动作</span>';
    return '<span class="badge">观察</span>';
  }
  function renderLinks(){
    const links = scopedRows(DATA.links || [], null).slice().sort((a,b)=>num(b.c30_eps_uv)-num(a.c30_eps_uv));
    const retire = links.filter(x=>x.retire_candidate).length;
    const weak = links.filter(x=>x.high_visit_low_pay || x.high_exposure_low_click).length;
    const wait = links.filter(x=>x.wait_shelf_block_candidate).length;
    return sectionIntro('SKC / 链接','这个页面回答：链接该补、该修、该替换还是该下架。') +
      '<section class="grid kpi-grid"><div class="kpi danger"><div class="kpi-label">可下架候选</div><div class="kpi-value">'+retire+'</div></div><div class="kpi warn"><div class="kpi-label">有流量无承接</div><div class="kpi-value">'+weak+'</div></div><div class="kpi"><div class="kpi-label">待上架受阻</div><div class="kpi-value">'+wait+'</div></div><div class="kpi good"><div class="kpi-label">当前链接数</div><div class="kpi-value">'+links.length+'</div></div></section>' +
      '<section class="panel"><div class="table-wrap"><table><thead><tr><th>店铺 / SKC</th><th>货号</th><th>状态 / 标签</th><th class="num">7天曝光</th><th class="num">7天访客</th><th class="num">7天销量</th><th class="num">30天曝光</th><th class="num">30天销量</th><th>判断</th></tr></thead><tbody>' +
      links.slice(0,120).map(l=>'<tr><td><b>'+html(l.store_key)+'</b><div class="kpi-sub">'+html(l.skc)+'</div></td><td>'+html(l.standard_goods_sn)+'</td><td><span class="badge '+(l.retire_candidate?'high':l.is_on_shelf?'good':'warn')+'">'+html(l.shelf_status_name||'-')+'</span><div class="kpi-sub">'+html((l.skc_tags||l.performance_layer_name||'').slice(0,80))+'</div></td><td class="num">'+round(l.c7_eps_uv,0)+'</td><td class="num">'+round(l.c7_goods_uv,0)+'</td><td class="num">'+round(l.c7_sale_cnt,0)+'</td><td class="num">'+round(l.c30_eps_uv,0)+'</td><td class="num">'+round(l.c30_sale_cnt,0)+'</td><td>'+linkAdvice(l)+'</td></tr>').join('') +
      '</tbody></table></div></section>';
  }
  function linkAdvice(l){
    if(l.retire_candidate) return '<span class="badge high">复核后下架</span>';
    if(l.high_visit_low_pay) return '<span class="badge warn">优化价格/评价/详情</span>';
    if(l.high_exposure_low_click) return '<span class="badge warn">优化主图标题</span>';
    if(l.wait_shelf_block_candidate) return '<span class="badge warn">补资料上架</span>';
    if(l.is_on_shelf && num(l.c7_sale_cnt)>0) return '<span class="badge good">保留复制打法</span>';
    return '<span class="badge">观察</span>';
  }
  function renderReviews(){
    const rows = scopedRows(DATA.comments || [], 'comment_date').slice().sort((a,b)=>num(a.goods_comment_star)-num(b.goods_comment_star) || String(b.comment_date).localeCompare(String(a.comment_date)));
    return sectionIntro('评价 / 口碑','先看中文译文和低星，再回到货号/店铺判断是否影响链接承接。') +
      '<section class="panel"><div class="table-wrap"><table><thead><tr><th>日期</th><th>店铺</th><th>货号 / SKC</th><th>星级</th><th>中文译文</th><th>原文</th></tr></thead><tbody>' +
      rows.slice(0,180).map(r=>'<tr><td>'+html(r.comment_date||r.comment_time||'-')+'</td><td>'+html(r.store_key||'-')+'</td><td><button class="pill-btn" data-product="'+html(r.standard_goods_sn||'')+'">'+html(r.standard_goods_sn||'-')+'</button><div class="kpi-sub">'+html(r.skc||'')+'</div></td><td><span class="star">'+stars(r.goods_comment_star)+'</span></td><td class="comment-zh">'+html(r.goods_comment_content_zh || '暂无译文')+'</td><td class="comment-raw">'+html(r.goods_comment_content || '')+'</td></tr>').join('') +
      '</tbody></table></div></section>';
  }
  function stars(n){ n=Math.max(0,Math.min(5,Math.round(num(n)))); return '★★★★★'.slice(0,n)+'☆☆☆☆☆'.slice(0,5-n); }
  function renderOrders(){
    const c = current();
    const rows = afterSalesRows().slice().sort((a,b)=>String(b.request_time).localeCompare(String(a.request_time)));
    return sectionIntro('订单 / 售后','这不是流水账，而是复核台：成交是否真实、售后是否需要默认反转、哪些订单要查。') +
      renderKpis(c) +
      '<section class="panel"><h4>售后优先复核</h4><p class="panel-sub">按售后申请时间或订单创建时间跟随顶部切换。</p><div class="table-wrap"><table><thead><tr><th>售后时间</th><th>店铺</th><th>订单</th><th>货号</th><th class="num">金额</th><th>状态</th><th>原因</th></tr></thead><tbody>' +
      rows.slice(0,160).map(r=>'<tr><td>'+html(String(r.request_time||'').replace('T',' '))+'</td><td>'+html(r.store_key||'-')+'</td><td>'+html(r.order_no||'-')+'<div class="kpi-sub">'+html(r.return_order_no||r.aftersales_order_no||'')+'</div></td><td>'+html(r.standard_goods_sn||'-')+'</td><td class="num">'+money(r.amount_sar||r.order_sales_sar||r.price_amount_total)+'</td><td><span class="badge warn">'+html(r.order_sub_status_name||r.review_status||'-')+'</span></td><td>'+html(r.reason_names||r.review_reason||'')+'</td></tr>').join('') +
      '</tbody></table></div></section>';
  }
  function renderProfit(){
    const rows = (DATA.profit?.products || []).filter(rowQueryOk).slice();
    const high = rows.filter(r=>num(r.profit_margin_before_storage)>=.2).sort((a,b)=>num(b.profit_margin_before_storage)-num(a.profit_margin_before_storage));
    const low = rows.filter(r=>num(r.profit_margin_before_storage)<.2).sort((a,b)=>num(a.profit_margin_before_storage)-num(b.profit_margin_before_storage));
    const c = current();
    return sectionIntro('成本 / 利润','20% 利润率分界：高于它才谈加码，低于它先找成本、价格和退货原因。') +
      renderKpis(c) +
      '<section class="bento"><div class="panel"><h4>高利润 / 可加码</h4><p class="panel-sub">按利润率从高到低。</p>'+profitTable(high.slice(0,28))+'</div><div class="panel"><h4>低利润 / 需要处理</h4><p class="panel-sub">按利润率从低到高。</p>'+profitTable(low.slice(0,28))+'</div></section>' +
      '<div class="section-head"><div><h3>选品标尺</h3><p>用历史样本估算：采购价、体积和未来头程对利润率的影响。</p></div></div>' +
      '<section class="grid cards-3">'+selectionCards(rows)+'</section>';
  }
  function profitTable(rows){
    if(!rows.length) return '<div class="empty">当前没有数据。</div>';
    return '<div class="table-wrap"><table><thead><tr><th>货号</th><th class="num">利润率</th><th class="num">利润</th><th class="num">净营收</th><th class="num">单位成本</th></tr></thead><tbody>' +
      rows.map(r=>'<tr><td>'+html(r.standard_goods_sn)+'</td><td class="num">'+pct(r.profit_margin_before_storage)+'</td><td class="num">'+money(r.profit_before_storage_sar)+'</td><td class="num">'+money(r.net_revenue_sar)+'</td><td class="num">'+money(r.unit_cost_sar)+'</td></tr>').join('') +
      '</tbody></table></div>';
  }
  function selectionCards(rows){
    const valid = rows.filter(r=>num(r.avg_purchase_unit_price)>0 && num(r.inferred_volume_l_1600)>0);
    const best = valid.slice().sort((a,b)=>num(b.profit_margin_before_storage)-num(a.profit_margin_before_storage)).slice(0,5);
    const avgMargin = valid.length ? valid.reduce((a,r)=>a+num(r.profit_margin_before_storage),0)/valid.length : 0;
    return [
      ['样本利润率',pct(avgMargin),'历史完整成本样本的平均利润率。'],
      ['高利润样本',best.length ? html(best[0].standard_goods_sn) : '-','当前样本里利润率最高的货号。'],
      ['未来头程口径','2000 RMB/方','用于新选品估算，不直接覆盖历史成本。']
    ].map(x=>'<div class="operation-card"><div><h4>'+x[0]+'</h4><p>'+x[2]+'</p></div><div class="big-num" style="font-size:26px">'+x[1]+'</div></div>').join('');
  }
  function renderInventory(){
    const rows = inventoryRows().filter(rowQueryOk).sort((a,b)=>num(a.days_of_supply_on_hand)-num(b.days_of_supply_on_hand));
    return sectionIntro('实际库存 / 去化','用成本表批次和 ET 库存估算：哪些快断货，哪些库存沉淀，哪些在途能接上。') +
      '<section class="panel"><div class="table-wrap"><table><thead><tr><th>货号</th><th>状态</th><th class="num">估算在库</th><th class="num">在途</th><th class="num">7天销量</th><th class="num">30天销量</th><th class="num">可卖天数</th><th>建议</th></tr></thead><tbody>' +
      rows.slice(0,120).map(r=>'<tr><td>'+html(r.standard_goods_sn)+'</td><td><span class="badge '+(r.risk_level==='high'?'high':r.risk_level==='medium'?'warn':'good')+'">'+html(r.stock_status||r.risk_level||'-')+'</span></td><td class="num">'+round(r.estimated_on_hand_quantity,0)+'</td><td class="num">'+round(r.incoming_quantity,0)+'</td><td class="num">'+round(r.gross_sold_7d,0)+'</td><td class="num">'+round(r.gross_sold_30d,0)+'</td><td class="num">'+round(r.days_of_supply_on_hand,1)+'</td><td>'+inventoryAdvice(r)+'</td></tr>').join('') +
      '</tbody></table></div></section>';
  }
  function inventoryAdvice(r){
    if(num(r.days_of_supply_on_hand)<=7 && num(r.incoming_quantity)<=0) return '<span class="badge high">优先保留强店/补货</span>';
    if(num(r.days_of_supply_with_incoming)>90 && num(r.gross_sold_30d)<=5) return '<span class="badge warn">清货促销</span>';
    if(num(r.incoming_quantity)>0) return '<span class="badge">等在途承接</span>';
    return '<span class="badge good">正常观察</span>';
  }
  function renderActions(){
    let rows = (DATA.actions || []).slice().sort((a,b)=>num(b.score)-num(a.score));
    if(state.domain !== 'all') rows = rows.filter(a=>String(a.action_domain||'')===state.domain);
    if(state.priority !== 'all') rows = rows.filter(a=>String(a.priority||'')===state.priority);
    rows = rows.filter(rowScopeOk).filter(rowQueryOk);
    if(state.actionStatus !== 'all') rows = rows.filter(a=>getActionStatus(a) === state.actionStatus);
    const domains = uniq((DATA.actions||[]).map(a=>a.action_domain)).filter(Boolean);
    return sectionIntro('今日动作池','动作池不按历史时间回看，只看当前最新待办；同一动作处理状态只保存在 V2 本地预览。') +
      '<section class="action-layout"><aside class="panel filter-panel"><h4>动作筛选</h4><p class="panel-sub">这里是动作池专用筛选，不影响其它页面。</p>' +
        '<button class="chip '+(state.domain==='all'?'active':'')+'" data-domain="all">全部业务域</button>' +
        domains.map(d=>'<button class="chip '+(state.domain===d?'active':'')+'" data-domain="'+html(d)+'">'+html(domainName(d))+'</button>').join('') +
        '<hr style="border:0;border-top:1px solid var(--line);margin:14px 0">' +
        ['all:全部优先级','高:高优先级','中:中优先级','低:低优先级'].map(x=>{const [k,n]=x.split(':');return '<button class="chip '+(state.priority===k?'active':'')+'" data-priority="'+k+'">'+n+'</button>';}).join('') +
        '<hr style="border:0;border-top:1px solid var(--line);margin:14px 0">' +
        ['open:未处理','done:已处理','review:待复查','ignore:忽略','all:全部状态'].map(x=>{const [k,n]=x.split(':');return '<button class="chip '+(state.actionStatus===k?'active':'')+'" data-action-status="'+k+'">'+n+'</button>';}).join('') +
      '</aside><div class="action-stack">' +
        (rows.length ? rows.slice(0,160).map(actionCard).join('') : '<div class="empty">当前筛选下没有动作。</div>') +
      '</div></section>';
  }
  function actionKey(a){ return [a.date,a.store_key,a.action_domain,a.skc,a.standard_goods_sn,a.category].map(x=>x||'').join('|'); }
  function getActionStatus(a){ return localStorage.getItem('shein-v2-action:'+actionKey(a)) || 'open'; }
  function actionCard(a){
    const st = getActionStatus(a);
    return '<article class="action-card '+(a.priority==='高'?'high':'')+'"><div><span class="badge '+(a.priority==='高'?'high':'warn')+'">'+html(domainName(a.action_domain))+' · '+html(a.priority||'')+'</span><h4>'+html(a.title||a.category)+'</h4><p>'+html(a.reason||'')+'</p><div class="action-evidence">'+html(humanEvidence(a.evidence||''))+'</div><div class="action-meta"><span class="badge">'+html(a.store_key||'-')+'</span><span class="badge">'+html(a.standard_goods_sn||'-')+'</span>'+(a.skc?'<span class="badge">'+html(a.skc)+'</span>':'')+'</div></div><aside class="action-side"><div class="action-score">'+round(a.score,0)+'</div><div class="status-row">'+['open:未处理','done:已处理','review:待复查','ignore:忽略'].map(x=>{const [k,n]=x.split(':'); return '<button class="'+(st===k?'active':'')+'" data-set-action="'+k+'" data-action-key="'+html(actionKey(a))+'">'+n+'</button>';}).join('')+'</div><div class="status-row"><button data-store="'+html(a.store_key||'')+'">看店铺</button><button data-product="'+html(a.standard_goods_sn||'')+'">看货号</button><button data-tab="links" data-q="'+html(a.skc||a.standard_goods_sn||'')+'">看SKC</button></div></aside></article>';
  }
  function humanEvidence(e){
    let s = String(e || '');
    s = s.replace(/[,，]\s*/g, '；');
    const pairs = {
      weakC30:'弱链接30天销量',
      bestC30:'最佳链接30天销量',
      weakC7:'弱链接7天销量',
      bestC7:'最佳链接7天销量',
      cases:'售后单数',
      amount:'售后金额',
      status:'当前状态',
      quality_return_rate:'质量退货率',
      bad_eval_cnt:'低星/差评数',
      return_volume:'退货量',
      level:'质量等级',
      min_usable:'最低可用库存',
      usable_total:'可用库存',
      inventory_total:'展示库存',
      locked:'锁定库存',
      rows:'库存行数',
      c30_sale:'链接30天销量',
      order30:'订单30天销量',
      on_shelf:'上架链接数'
    };
    Object.entries(pairs).forEach(([k,v]) => {
      s = s.replace(new RegExp('(^|[^A-Za-z0-9_])'+k+'\\s*=', 'g'), '$1'+v+' ');
    });
    s = s.replace(/质量退货率 ([0-9.]+)/g, (_,v) => '质量退货率 ' + (Number(v)*100).toFixed(1) + '%');
    s = s.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)=/g, (_,k) => {
      const readable = k.replace(/_/g,' ');
      return readable + ' ';
    });
    return s;
  }
  function domainName(d){ return ({link:'链接',quality:'质量',after_sales:'售后',aftersales:'售后',inventory:'库存',finance:'财务',business:'经营'})[d] || d || '-'; }
  function renderSystem(){
    const p = DATA.pipeline?.latestLog || {};
    const audit = DATA.audit || {};
    return sectionIntro('系统状态','这里回答：今天的数据能不能放心看。') +
      '<section class="grid cards-3">' +
      infoCard('销售源更新时间', DATA.dates?.salesUpdatedAt || DATA.dates?.salesDate || '-') +
      infoCard('业务域更新时间', DATA.dates?.businessUpdatedAt || DATA.dates?.businessDate || '-') +
      infoCard('链接表现更新时间', DATA.dates?.linkUpdatedAt || DATA.dates?.linkDate || '-') +
      infoCard('ET 货代仓', DATA.dates?.etUpdatedAt || '-') +
      infoCard('最新流水线', (p.status||'-') + ' · ' + (p.startedAt||'-')) +
      infoCard('体检', audit.ok === false ? '存在异常' : '通过') +
      '</section>';
  }
  function infoCard(t,v){ return '<div class="operation-card"><h4>'+html(t)+'</h4><p>'+html(v)+'</p></div>'; }
  function sectionIntro(title,copy){
    return '<section class="page-intro"><div><span class="eyebrow"><i></i>'+html(title)+'</span><h2>'+html(title)+'</h2><p>'+html(copy)+'</p></div><div class="badge">当前筛选：'+html(pageTitle().range)+' · '+html(pageTitle().scope)+html(pageTitle().q)+'</div></section>';
  }

  function render(){
    if(!DATA) return;
    renderShell();
    const map = {overview:renderOverview, stores:renderStores, products:renderProducts, links:renderLinks, reviews:renderReviews, orders:renderOrders, profit:renderProfit, inventory:renderInventory, actions:renderActions, system:renderSystem};
    $('#view').innerHTML = (map[state.tab] || renderOverview)();
    window.scrollTo({top:0, behavior:'instant'});
  }
  function applyTheme(theme){
    const next = theme === 'dark' ? 'dark' : 'light';
    document.body.dataset.theme = next;
    try { localStorage.setItem('SHEIN_BI_V2_THEME', next); } catch {}
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => { btn.textContent = next === 'dark' ? '浅色' : '深色'; });
  }
  function initTheme(){
    let saved = '';
    try { saved = localStorage.getItem('SHEIN_BI_V2_THEME') || ''; } catch {}
    applyTheme(saved || 'light');
  }
  function bindEvents(){
    let qTimer = null;
    document.addEventListener('click', e => {
      const b = e.target.closest('button');
      if(!b) return;
      if(b.dataset.tab){ setState({tab:b.dataset.tab, q:b.dataset.q || state.q}, true); return; }
      if(b.dataset.homeStore){ setState({tab:'stores', store:b.dataset.homeStore, q:'', product:''}, true); return; }
      if(b.dataset.homeProduct){ setState({tab:'products', q:b.dataset.homeProduct, product:b.dataset.homeProduct}, true); return; }
      if(b.dataset.store){ setState({tab:'stores', store:b.dataset.store}, true); return; }
      if(b.dataset.product){ setState({tab:'products', q:b.dataset.product}, true); return; }
      if(b.dataset.trend){ setState({trendMetric:b.dataset.trend}, true); return; }
      if(b.dataset.modeKey){ const patch = {}; patch[b.dataset.modeKey] = b.dataset.modeValue; setState(patch, true); return; }
      if(b.dataset.salesMode){ setState({salesMode:b.dataset.salesMode}, true); return; }
      if(b.dataset.qtyMode){ setState({qtyMode:b.dataset.qtyMode}, true); return; }
      if(b.dataset.returnsMode){ setState({returnsMode:b.dataset.returnsMode}, true); return; }
      if(b.dataset.profitMode){ setState({profitMode:b.dataset.profitMode}, true); return; }
      if(b.dataset.domain){ setState({domain:b.dataset.domain}, true); return; }
      if(b.dataset.priority){ setState({priority:b.dataset.priority}, true); return; }
      if(b.dataset.actionStatus){ setState({actionStatus:b.dataset.actionStatus}, true); return; }
      if(b.dataset.setAction){ localStorage.setItem('shein-v2-action:'+b.dataset.actionKey, b.dataset.setAction); render(); return; }
      if(b.dataset.preset){ setPreset(b.dataset.preset); return; }
      if(b.dataset.themeToggle){ applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'); return; }
    });
    $('#globalQ').addEventListener('input', e=>{
      clearTimeout(qTimer);
      const value = e.target.value;
      qTimer = setTimeout(()=>setState({q:value, product:value}, true), 260);
    });
    $('#globalQ').addEventListener('change', e=>setState({q:e.target.value, product:e.target.value}, true));
    $('#storeSelect').addEventListener('change', e=>setState({store:e.target.value}, true));
    $('#startDate').addEventListener('change', e=>setState({startDate:e.target.value}, true));
    $('#endDate').addEventListener('change', e=>setState({endDate:e.target.value}, true));
    window.addEventListener('hashchange', () => { state = Object.assign(state, parseHash()); render(); });
  }
  async function init(){
    $('#view').innerHTML = '<div class="empty">正在读取 BI 数据...</div>';
    DATA = await fetch('../data.json?ts=' + Date.now()).then(r=>r.json());
    state = parseHash();
    const t = todayStr();
    state.startDate = state.startDate || t;
    state.endDate = state.endDate || t;
    syncHash(true);
    initTheme();
    bindEvents();
    render();
  }
  init().catch(err => {
    console.error(err);
    $('#view').innerHTML = '<div class="empty">V2 加载失败：'+html(err.message)+'</div>';
  });
})();
`;

const html = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>SHEIN BI V2 · Operating Intelligence</title>',
  '<style>', css, '</style></head><body>',
  '<div class="app">',
  '<aside class="sidebar">',
  '<div class="brand"><div class="brand-mark">S</div><h1>SHEIN BI V2</h1><p>Operating intelligence preview</p></div>',
  '<nav class="nav" id="nav"></nav>',
  '<div class="side-footer" id="dataFresh"><b>数据刷新</b><div>读取中...</div></div>',
  '</aside>',
  '<main class="main">',
  '<div class="command"><div class="command-inner">',
  '<div class="field"><label>搜索</label><input id="globalQ" placeholder="货号 / 品名；完整 SKC 也可搜"></div>',
  '<div class="field"><label>范围</label><select id="storeSelect"></select></div>',
  '<div class="field"><label>开始</label><input id="startDate" type="date"></div>',
  '<div class="field"><label>结束</label><input id="endDate" type="date"></div>',
  '<div class="quick">',
  '<button data-preset="today">今天</button><button data-preset="yesterday">昨天</button><button data-preset="last7">近7天</button><button data-preset="last30">近30天</button><button data-preset="month">本月</button><button data-preset="lastMonth">上月</button>',
  '<button class="dark-toggle" data-theme-toggle="1">深色</button>',
  '</div>',
  '</div></div>',
  '<div class="view" id="view"></div>',
  '<div class="footer-note">V2 Preview · 只读复用 data.json · 不替换 V1</div>',
  '</main></div>',
  '<script>', clientJs.replace(/<\/script>/g,'<\\/script>'), '</script>',
  '</body></html>'
].join('');

await fs.mkdir(outDir, {recursive:true});
await fs.writeFile(outFile, html, 'utf8');

console.log(JSON.stringify({
  ok:true,
  mode:'independent-v2-operating-intelligence',
  outFile:path.relative(ROOT,outFile),
  url:'http://127.0.0.1:8787/v2/'
}, null, 2));
