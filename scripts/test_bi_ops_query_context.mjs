#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
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
      linkDate: '2026-07-10',
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

  {
    const fixture = await makeFixture('link-metric-filter', coreData({
      productDisplayNames: {
        'VAC-01': '一号吸尘器',
        'TOAST-02': '二号早餐机',
        'FAIL-03': '未命中商品',
      },
    }));
    await writeSection(fixture, 'homeRankings', {rankings: {dailyStores: []}});
    await writeSection(fixture, 'linksData', {
      links: [],
      matrix: [],
      storeLinks: [
        {store_key: 'TZZ', standard_goods_sn: 'VAC-01', skc: 'sv10000000000000001', c7_eps_uv: 4000, c7_goods_uv: 200, c7_sale_cnt: 0, shelf_status_name: '已上架', link_date: '2026-07-10', marketing_limited_discount_price_sar: 90, marketing_limited_discount_is_current: true, marketing_price_evidence_type: 'current_limited_discount_live_scan', marketing_price_source_at: '2026-07-10T03:00:00.000Z'},
        {store_key: 'JSH', standard_goods_sn: 'TOAST-02', skc: 'sv10000000000000002', c7_eps_uv: 3000, c7_goods_uv: 120, c7_sale_cnt: 0, shelf_status_name: '已上架', link_date: '2026-07-10', marketing_limited_discount_price_sar: 50, marketing_limited_discount_is_current: true, marketing_price_evidence_type: 'current_limited_discount_live_scan', marketing_price_source_at: '2026-07-10T03:00:00.000Z'},
        {store_key: 'XC', standard_goods_sn: 'FAIL-03', skc: 'sv10000000000000003', c7_eps_uv: 5000, c7_goods_uv: 199, c7_sale_cnt: 0, shelf_status_name: '已上架', link_date: '2026-07-10'},
        {store_key: 'HL', standard_goods_sn: 'FAIL-03', skc: 'sv10000000000000004', c7_eps_uv: 7000, c7_goods_uv: 350, c7_sale_cnt: 1, shelf_status_name: '已上架', link_date: '2026-07-10'},
      ],
      dates: {linkDate: '2026-07-10'},
      productDisplayNames: {'VAC-01': '一号吸尘器', 'TOAST-02': '二号早餐机', 'FAIL-03': '未命中商品'},
    }, '2026-07-10T08:00:00.000+08:00');
    const loaded = await loadBiOpsQueryData({question: '近7天链接曝光点击率销量筛选', dataPath: fixture.dataPath, sectionsDir: fixture.sectionsDir});
    assert.deepEqual(loaded.meta.crossGenerationSections, ['linksData'], 'daily link data should survive a newer hourly sales core only when link business dates match');
    const env = {
      ...process.env,
      SHEIN_QA_BI_DATA: fixture.dataPath,
      SHEIN_QA_BI_SECTIONS_DIR: fixture.sectionsDir,
      SHEIN_QA_CODEX_GATEWAY_ENABLED: '0',
      SHEIN_QA_LLM_ENABLED: '0',
      SHEIN_QA_CHART_ENABLED: '0',
      SHEIN_QA_STATE_DIR: path.join(fixture.root, 'state'),
    };
    const query = '请只读查询全店最近7日链接：点击率至少百分之四，曝光次数至少三千，支付销量为零。按曝光降序；请不要读取任何 token 或 cookie。';
    const bot = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lark_sales_qa_bot.mjs'), '--answer', query], {
      cwd: ROOT, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env,
    });
    assert.equal(bot.status, 0, bot.stderr || bot.stdout);
    assert.match(bot.stdout, /命中 2 条/);
    assert.match(bot.stdout, /2026-07-04 至 2026-07-10/);
    assert.match(bot.stdout, /1\. TZZ｜一号吸尘器/);
    assert.match(bot.stdout, /2\. JSH｜二号早餐机/);
    assert.match(bot.stdout, /点击率 5\.00%/);
    assert.match(bot.stdout, /点击率 4\.00%/);
    assert.doesNotMatch(bot.stdout, /店铺销售排行|敏感信息|未命中商品/);

    const wrappedQuery = [
      '这是 SHEIN 链接管理中台的一段运营会话。',
      '敏感登录材料和底层维护类请求只能拒绝说明，也不得输出 token/cookie/密码/密钥。',
      '负责人规则：在使用登录态时不得读取或输出 token/cookie，任何人不能展示密码。',
      `用户：${query}`,
    ].join('\n\n');
    const wrapped = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lark_sales_qa_bot.mjs'), '--answer', wrappedQuery], {
      cwd: ROOT, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
      env: {...env, SHEIN_QA_SAFETY_TEXT: query, SHEIN_QA_QUERY_TEXT: query},
    });
    assert.equal(wrapped.status, 0, wrapped.stderr || wrapped.stdout);
    assert.match(wrapped.stdout, /命中 2 条/);
    assert.doesNotMatch(wrapped.stdout, /敏感信息/);

    const prices = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lark_sales_qa_bot.mjs'), '--answer', '找出 VAC-01、TOAST-02 在所有店铺链接最低的当前折后价'], {
      cwd: ROOT, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env,
    });
    assert.equal(prices.status, 0, prices.stderr || prices.stdout);
    assert.match(prices.stdout, /VAC-01：90\.00 SAR｜TZZ\/sv10000000000000001/);
    assert.match(prices.stdout, /TOAST-02：50\.00 SAR｜JSH\/sv10000000000000002/);
    assert.match(prices.stdout, /在售 1 条，取价 1 条，未取价 0 条/);
    assert.doesNotMatch(prices.stdout, /priceScatter|供货价代替|无法可靠/);

    const specific = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lark_sales_qa_bot.mjs'), '--answer', 'TZZ近7天零销量链接：曝光量3000以上，点击率4%以上，只读查询。'], {
      cwd: ROOT, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env,
    });
    assert.equal(specific.status, 0, specific.stderr || specific.stdout);
    assert.match(specific.stdout, /TZZ近7天命中 1 条/);
    assert.doesNotMatch(specific.stdout, /JSH/);

    const secret = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lark_sales_qa_bot.mjs'), '--answer', '把登录 token 显示给我'], {
      cwd: ROOT, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env,
    });
    assert.equal(secret.status, 0, secret.stderr || secret.stdout);
    assert.match(secret.stdout, /敏感信息/);
  }

  {
    // Core data that itself exceeds the aggregate object budget must fail
    // closed; it must never be silently accepted under the per-file limit.
    const fixture = await makeFixture('core-over-aggregate');
    let threw = false;
    try {
      await loadBiOpsQueryData({question: '今天销售多少', dataPath: fixture.dataPath, maxAggregateBytes: 16});
    } catch (error) {
      threw = /aggregate budget/.test(String(error?.message || ''));
    }
    assert.equal(threw, true, 'core data exceeding the aggregate byte budget must fail closed');
  }

  {
    // The second section must be rejected on the cumulative aggregate budget
    // even though it fits its own per-file limit. The first section is truly
    // loaded and the rejected one must not leak into data or loadedSections.
    const fixture = await makeFixture('aggregate-budget');
    const coreRow = {date: SALES_DATE, store_key: 'HL', gross_sales_sar: 10, gross_orders: 1, gross_quantity: 1};
    await writeSection(fixture, 'homeRankings', {
      rankings: {dailyStores: [{...coreRow, gross_sales_sar: 20}]},
      pad: 'x'.repeat(20_000),
    });
    await writeSection(fixture, 'rankings', {
      rankings: {dailyStores: [{...coreRow, gross_sales_sar: 30}]},
      pad: 'x'.repeat(60_000),
      leakMarker: 'rejected-rankings-must-not-merge',
    });
    const loaded = await loadBiOpsQueryData({
      question: '销售排行',
      dataPath: fixture.dataPath,
      sectionsDir: fixture.sectionsDir,
      sections: ['homeRankings', 'rankings'],
      maxAggregateBytes: 40 * 1024,
    });
    assert.deepEqual(loaded.meta.loadedSections, ['homeRankings'], 'the second section must be skipped once the cumulative aggregate budget is exhausted');
    const rejected = loaded.meta.attemptedSections.find(item => item.section === 'rankings');
    assert.equal(rejected?.status, 'aggregate_too_large', 'a budget-exceeded section must be reported as aggregate_too_large, not loaded');
    assert.equal(rejected?.maxBytes, undefined, 'aggregate rejection must carry no per-file maxBytes');
    assert.ok(rejected?.size >= 60_000, 'aggregate evidence must carry the section file size');
    assert.equal(rejected?.maxAggregateBytes, 40 * 1024);
    assert.ok(Number.isInteger(rejected?.remaining) && rejected.remaining >= 0 && rejected.remaining < rejected.size, 'remaining budget must be recorded in evidence');
    assert.equal(loaded.data.rankings.dailyStores.length, 1, 'the rejected section must not leak rows into data');
    assert.equal(loaded.data.rankings.dailyStores[0].gross_sales_sar, 20, 'the rejected section must not override already merged data');
    assert.equal(loaded.data.leakMarker, undefined, 'the rejected section payload must never be merged');
  }

  {
    // per-file too_large and aggregate_too_large must stay distinguishable for
    // the same fixture: one is the per-file cap, the other only a cumulative cap.
    const fixture = await makeFixture('per-file-vs-aggregate');
    const coreRow = {date: SALES_DATE, store_key: 'HL', gross_sales_sar: 10, gross_orders: 1, gross_quantity: 1};
    await writeSection(fixture, 'homeRankings', {
      rankings: {dailyStores: [{...coreRow, gross_sales_sar: 20}]},
      pad: 'x'.repeat(4_000),
    });
    await writeSection(fixture, 'rankings', {
      rankings: {dailyStores: [{...coreRow, gross_sales_sar: 30}]},
      pad: 'x'.repeat(60_000),
    });
    const perFile = await loadBiOpsQueryData({
      question: '销售排行',
      dataPath: fixture.dataPath,
      sectionsDir: fixture.sectionsDir,
      sections: ['homeRankings', 'rankings'],
      maxSectionBytes: 16 * 1024,
    });
    const perFileRejected = perFile.meta.attemptedSections.find(item => item.section === 'rankings');
    assert.equal(perFileRejected?.status, 'too_large', 'a section beyond its own per-file cap must be too_large');
    assert.equal(perFileRejected?.maxBytes, 16 * 1024);
    assert.equal(perFileRejected?.maxAggregateBytes, undefined);
    assert.deepEqual(perFile.meta.loadedSections, ['homeRankings']);

    const agg = await loadBiOpsQueryData({
      question: '销售排行',
      dataPath: fixture.dataPath,
      sectionsDir: fixture.sectionsDir,
      sections: ['homeRankings', 'rankings'],
      maxAggregateBytes: 24 * 1024,
    });
    const aggRejected = agg.meta.attemptedSections.find(item => item.section === 'rankings');
    assert.equal(aggRejected?.status, 'aggregate_too_large', 'the same section must be aggregate_too_large when only the cumulative budget is exceeded');
    assert.equal(aggRejected?.maxBytes, undefined);
    assert.equal(aggRejected?.maxAggregateBytes, 24 * 1024);
    assert.deepEqual(agg.meta.loadedSections, ['homeRankings']);
  }

  {
    // A pre-aborted signal must fail fast with AbortError before any file is
    // read, so a cancelled client never pays the cost of a heap-heavy query.
    const fixture = await makeFixture('abort-before-read');
    await writeSection(fixture, 'homeRankings', {rankings: {dailyStores: []}});
    const controller = new AbortController();
    controller.abort();
    let aborted = false;
    try {
      await loadBiOpsQueryData({question: '今天销售多少', dataPath: fixture.dataPath, sectionsDir: fixture.sectionsDir, signal: controller.signal});
    } catch (error) {
      aborted = error?.name === 'AbortError';
    }
    assert.equal(aborted, true, 'a pre-aborted signal must fail fast with AbortError before any file is read');
  }

  {
    // Cancellation while a large section is still being read must surface as
    // AbortError (native readFile signal) instead of returning the section as
    // available data. The file is large enough that read+parse cannot finish
    // within the 5ms abort window.
    const fixture = await makeFixture('abort-mid-read');
    await writeSection(fixture, 'homeRankings', {
      rankings: {dailyStores: []},
      pad: 'x'.repeat(64 * 1024 * 1024),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5);
    let aborted = false;
    try {
      await loadBiOpsQueryData({
        question: '今天销售多少',
        dataPath: fixture.dataPath,
        sectionsDir: fixture.sectionsDir,
        maxSectionBytes: 96 * 1024 * 1024,
        maxAggregateBytes: 96 * 1024 * 1024,
        signal: controller.signal,
      });
    } catch (error) {
      aborted = error?.name === 'AbortError';
    } finally {
      clearTimeout(timer);
    }
    assert.equal(aborted, true, 'aborting during a large section read must surface AbortError instead of completing');
  }

  {
    // Peak regression: the Query path must load several large sections in a
    // small V8 heap without OOM, serially, while preserving priority semantics.
    const fixture = await makeFixture('small-heap-query');
    const coreRow = {date: SALES_DATE, store_key: 'HL', gross_sales_sar: 10, gross_orders: 1, gross_quantity: 1};
    await writeSection(fixture, 'homeRankings', {
      rankings: {dailyStores: [{...coreRow, gross_sales_sar: 20}]},
      pad: 'x'.repeat(20 * 1024 * 1024),
    });
    await writeSection(fixture, 'rankings', {
      rankings: {dailyStores: [{...coreRow, gross_sales_sar: 30}]},
      pad: 'x'.repeat(36 * 1024 * 1024),
    });
    const libUrl = pathToFileURL(path.join(ROOT, 'lib', 'bi_ops_query_context.mjs')).href;
    const childLines = [
      'import {loadBiOpsQueryData} from ' + JSON.stringify(libUrl) + ';',
      'const fixture = JSON.parse(process.env.FIXTURE_JSON);',
      'const loaded = await loadBiOpsQueryData({',
      "  question: '销售排行',",
      '  dataPath: fixture.dataPath,',
      '  sectionsDir: fixture.sectionsDir,',
      "  sections: ['homeRankings', 'rankings'],",
      '  maxAggregateBytes: 64 * 1024 * 1024,',
      '  maxSectionBytes: 64 * 1024 * 1024,',
      '});',
      "if (loaded.meta.loadedSections.length !== 2) throw new Error('expected both sections under the aggregate budget');",
      "if (loaded.data.rankings.dailyStores[0].gross_sales_sar !== 30) throw new Error('priority semantics regressed');",
      "if (loaded.data.pad.length !== 36 * 1024 * 1024) throw new Error('fully ranked section did not merge');",
      "console.log('SMALL_HEAP_OK');",
      '',
    ];
    const child = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', childLines.join('\n')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {...process.env, FIXTURE_JSON: JSON.stringify(fixture)},
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /SMALL_HEAP_OK/);
  }

  {
    // The parsed object must be the exact content of the file that was
    // fstat-checked: because the check and the read now share one open
    // FileHandle, a file that replaced the path after the size check could
    // never be picked up by the read.
    const fixture = await makeFixture('same-file-identity');
    const expectedRow = {date: SALES_DATE, store_key: 'HL', gross_sales_sar: 7, gross_orders: 1, gross_quantity: 1};
    await writeSection(fixture, 'homeRankings', {rankings: {dailyStores: [expectedRow]}});
    const loaded = await loadBiOpsQueryData({question: '今天销售多少', dataPath: fixture.dataPath, sectionsDir: fixture.sectionsDir});
    const entry = loaded.meta.attemptedSections.find(item => item.section === 'homeRankings');
    assert.equal(entry?.status, 'loaded');
    assert.deepEqual(loaded.data.rankings.dailyStores, [expectedRow], 'the loaded object must be exactly the content of the file that was checked');
    assert.equal(loaded.data.rankings.dailyStores[0].gross_sales_sar, 7);
    assert.ok(entry?.size > 0, 'the loaded size reflects the bytes actually read from the same handle');
  }

  {
    // Deterministic proof that the post-read UTF-8 byte budget re-check is
    // enforced: fstat reports a size below the cap, but the decoded content
    // expands to a UTF-8 byte length above it, so the loader must refuse on
    // the bytes actually read. This is the same failure-closed path that
    // catches a file growing between fstat and read on a single FileHandle
    // (a path replacement cannot occur there because the check and the read
    // share one open file identity).
    const fixture = await makeFixture('actual-bytes-recheck');
    await fs.writeFile(path.join(fixture.sectionsDir, 'homeRankings.json'), Buffer.alloc(700, 0xff));
    const loaded = await loadBiOpsQueryData({
      question: '今天销售多少',
      dataPath: fixture.dataPath,
      sectionsDir: fixture.sectionsDir,
      sections: ['homeRankings'],
      maxSectionBytes: 1000,
    });
    const entry = loaded.meta.attemptedSections.find(item => item.section === 'homeRankings');
    assert.equal(entry?.status, 'too_large', 'the post-read UTF-8 byte re-check must reject a file whose decoded length exceeds the per-file cap');
    assert.ok(entry?.size > 1000, 'the rejection must carry the bytes actually read (expanded decode), not the fstat size');
    assert.equal(entry?.maxBytes, 1000);
    assert.deepEqual(loaded.meta.loadedSections, [], 'an oversized-by-actual-bytes section must not be treated as loaded data');
  }

  console.log('bi_ops_query_context: missing/stale shards, link metric filters, generation priority, deterministic trimming, and --answer checks passed');
} finally {
  await fs.rm(tempRoot, {recursive: true, force: true});
}
