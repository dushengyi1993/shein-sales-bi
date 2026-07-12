#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildBiOpsQueryContext,
  loadBiOpsQueryData,
  serializeBiOpsQueryContext,
} from '../lib/bi_ops_query_context.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATION = '2026-07-11T08:00:00.000+08:00';
const SALES_DATE = '2026-07-11';
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-ops-query-context-'));

function coreData(extra = {}) {
  return {
    generatedAt: GENERATION,
    dates: {
      salesDate: SALES_DATE,
      salesUpdatedAt: '2026-07-11T07:59:00.000+08:00',
    },
    productDisplayNames: {'TEST-01': '测试商品'},
    __sections: {
      mode: 'api',
      generatedAt: GENERATION,
      keys: ['homeRankings', 'rankings'],
      loaded: ['core'],
    },
    ...extra,
  };
}

async function makeFixture(name, core = coreData()) {
  const root = path.join(tempRoot, name);
  const sectionsDir = path.join(root, 'sections');
  const dataPath = path.join(root, 'data.json');
  await fs.mkdir(sectionsDir, {recursive: true});
  await fs.writeFile(dataPath, JSON.stringify(core), 'utf8');
  return {root, sectionsDir, dataPath};
}

async function writeSection(fixture, section, data, generatedAt = GENERATION, extra = {}) {
  await fs.writeFile(path.join(fixture.sectionsDir, `${section}.json`), JSON.stringify({
    ok: true,
    section,
    generatedAt,
    cachedAt: '2026-07-11T00:01:00.000Z',
    data,
    ...extra,
  }), 'utf8');
}

try {
  {
    const fixture = await makeFixture('missing');
    const loaded = await loadBiOpsQueryData({question: '今天销售多少', dataPath: fixture.dataPath});
    assert.deepEqual(loaded.meta.loadedSections, []);
    assert.deepEqual(
      loaded.meta.attemptedSections.map(item => [item.section, item.status]),
      [['homeRankings', 'missing'], ['rankings', 'missing']],
      'a missing compact shard must fall through to the complete rankings shard without crashing',
    );
    assert.equal(loaded.data.generatedAt, GENERATION);
  }

  {
    const coreRow = {date: SALES_DATE, store_key: 'HL', gross_sales_sar: 10, gross_orders: 1, gross_quantity: 1};
    const fixture = await makeFixture('stale', coreData({rankings: {dailyStores: [coreRow]}}));
    await writeSection(fixture, 'homeRankings', {
      rankings: {dailyStores: [{...coreRow, gross_sales_sar: 9999}]},
    }, '2026-07-10T08:00:00.000+08:00');
    const loaded = await loadBiOpsQueryData({question: '今天销售多少', dataPath: fixture.dataPath});
    assert.equal(loaded.meta.attemptedSections[0].status, 'stale_generation');
    assert.equal(loaded.data.rankings.dailyStores[0].gross_sales_sar, 10, 'stale section data must not override core data');
    assert.equal(loaded.meta.sourceByPath['rankings.dailyStores'], 'core');
  }

  {
    const coreRow = {date: SALES_DATE, store_key: 'HL', gross_sales_sar: 10, gross_orders: 1, gross_quantity: 1};
    const fixture = await makeFixture('priority', coreData({rankings: {dailyStores: [coreRow]}}));
    await writeSection(fixture, 'homeRankings', {
      rankings: {dailyStores: [{...coreRow, gross_sales_sar: 20}]},
    });
    await writeSection(fixture, 'rankings', {
      rankings: {
        dailyStores: [{...coreRow, gross_sales_sar: 30}],
        salesSummary: [{period_key: 'day', end_date: SALES_DATE, gross_sales_sar: 30, gross_orders: 1, gross_quantity: 1}],
      },
    });
    const loaded = await loadBiOpsQueryData({
      question: '销售排行',
      dataPath: fixture.dataPath,
      sections: ['homeRankings', 'rankings'],
    });
    assert.deepEqual(loaded.meta.loadedSections, ['homeRankings', 'rankings']);
    assert.equal(loaded.data.rankings.dailyStores[0].gross_sales_sar, 30, 'complete rankings must outrank homeRankings at the same generation');
    assert.equal(loaded.meta.sourceByPath['rankings.dailyStores'], 'rankings');
  }

  {
    const fixture = await makeFixture('basic-sales');
    await writeSection(fixture, 'homeRankings', {
      rankings: {
        dailyStores: [
          {date: SALES_DATE, store_key: 'HL', gross_sales_sar: 100, sales_sar: 95, gross_orders: 2, orders: 2, gross_quantity: 3, quantity: 3},
          {date: SALES_DATE, store_key: 'NM', gross_sales_sar: 50, sales_sar: 48, gross_orders: 1, orders: 1, gross_quantity: 2, quantity: 2},
        ],
        dailyProducts: [
          {date: SALES_DATE, standard_goods_sn: 'TEST-01', gross_sales_sar: 150, gross_orders: 3, gross_quantity: 5},
        ],
        dailyStoreProducts: [
          {date: SALES_DATE, store_key: 'HL', standard_goods_sn: 'TEST-01', gross_sales_sar: 100, gross_orders: 2, gross_quantity: 3},
        ],
      },
    });
    const loaded = await loadBiOpsQueryData({question: '今天销售多少', dataPath: fixture.dataPath});
    const day = loaded.data.rankings.salesSummary.find(row => row.period_key === 'day' && row.end_date === SALES_DATE);
    assert.equal(day.gross_sales_sar, 150, 'homeRankings daily stores should deterministically provide a basic daily total');
    assert.equal(loaded.meta.sourceByPath['rankings.salesSummary'], 'derived:homeRankings');

    const bot = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lark_sales_qa_bot.mjs'), '--answer', '今天销售多少'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        SHEIN_QA_BI_DATA: fixture.dataPath,
        SHEIN_QA_BI_SECTIONS_DIR: fixture.sectionsDir,
        SHEIN_QA_CODEX_GATEWAY_ENABLED: '0',
        SHEIN_QA_LLM_ENABLED: '0',
        SHEIN_QA_CHART_ENABLED: '0',
        SHEIN_QA_STATE_DIR: path.join(fixture.root, 'state'),
      },
    });
    assert.equal(bot.status, 0, bot.stderr || bot.stdout);
    assert.match(bot.stdout, /总销售/);
    assert.match(bot.stdout, /150 SAR/);
  }

  {
    const raw = {
      dataFreshness: {askedDate: SALES_DATE, generatedAt: GENERATION},
      links: Array.from({length: 300}, (_, index) => ({index, label: `row-${index}`, detail: 'x'.repeat(1200)})),
    };
    const first = buildBiOpsQueryContext(raw, {maxBytes: 4096});
    const second = buildBiOpsQueryContext(raw, {maxBytes: 4096});
    assert.equal(serializeBiOpsQueryContext(first), serializeBiOpsQueryContext(second), 'context output must be deterministic');
    assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 4096, 'model context must honor the byte budget');
    assert.equal(first.links?.[0]?.index, 0, 'deterministic trimming keeps the highest-priority first row');
    assert.equal(first.contextPolicy?.truncated, true);
  }

  console.log('bi_ops_query_context: missing/stale shards, generation priority, deterministic trimming, and --answer sales checks passed');
} finally {
  await fs.rm(tempRoot, {recursive: true, force: true});
}
