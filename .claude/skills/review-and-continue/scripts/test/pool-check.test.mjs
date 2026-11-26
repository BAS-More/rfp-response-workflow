// Run: node <skill>/scripts/run-tests.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { familyStem, versionOf, isNewer } from '../pool-check.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(SKILL, 'scripts', 'pool-check.mjs');

// Prices in OpenRouter's shape: USD per token, as strings; created is unix seconds.
const perM = (usd) => String(usd / 1e6);
const orModel = (
  id,
  inM,
  outM,
  { context = 1_000_000, tools = true, created = 1_750_000_000 } = {},
) => ({
  id,
  name: `Name of ${id}`,
  created,
  context_length: context,
  pricing: { prompt: perM(inM), completion: perM(outM) },
  supported_parameters: tools ? ['tools', 'temperature'] : ['temperature'],
});
const BASE = [
  orModel('z-ai/glm-5.3', 0.08, 1.4),
  orModel('moonshotai/kimi-k3', 0.24, 11.94),
  orModel('qwen/qwen3.8-max-0902', 2.0, 6.0),
];
const POOL = [
  { label: 'GLM 5.3', pricingId: 'z-ai/glm-5.3', palModel: 'glm/glm-5.3', clink: 'claude-glm' },
  {
    label: 'Kimi K3',
    pricingId: 'moonshotai/kimi-k3',
    palModel: 'kimi/kimi-k3',
    clink: 'claude-kimi',
  },
  {
    label: 'Qwen3.8 Max',
    pricingId: 'qwen/qwen3.8-max-0902',
    palModel: 'qwen/qwen3.8-max',
    clink: 'claude-qwen',
  },
];
const SNAP = {
  date: '2026-10-01',
  prices: {
    'z-ai/glm-5.3': { inPerM: 0.08, outPerM: 1.4, context: 1_000_000 },
    'moonshotai/kimi-k3': { inPerM: 0.24, outPerM: 11.94, context: 1_000_000 },
    'qwen/qwen3.8-max-0902': { inPerM: 2.0, outPerM: 6.0, context: 1_000_000 },
  },
};

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const dirOf = () => {
  const d = mkdtempSync(join(tmpdir(), 'rac pool check-')); // space on purpose
  made.push(d);
  return d;
};
function setup({ models = BASE, pool = POOL, snap = SNAP } = {}) {
  const dir = dirOf();
  const prices = join(dir, 'prices.json');
  writeFileSync(prices, JSON.stringify({ data: models }));
  const poolF = join(dir, 'pool.json');
  writeFileSync(poolF, JSON.stringify({ pool }));
  const snapshot = join(dir, 'snap.json');
  if (snap) writeFileSync(snapshot, JSON.stringify(snap));
  return { dir, prices, pool: poolF, snapshot };
}
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const check = (f, extra = []) =>
  run(['check', '--pool', f.pool, '--prices', f.prices, '--snapshot', f.snapshot, ...extra]);
const json = (r) => JSON.parse(r.stdout);

test('familyStem strips version digits, dots and date suffixes but keeps the vendor', () => {
  assert.equal(familyStem('z-ai/glm-5.3'), 'z-ai/glm-');
  assert.equal(familyStem('moonshotai/kimi-k3'), 'moonshotai/kimi-k');
  assert.equal(familyStem('qwen/qwen3.8-max-0902'), 'qwen/qwen-max');
  assert.equal(familyStem('z-ai/glm-5.4'), familyStem('z-ai/glm-5.3'));
  assert.notEqual(familyStem('qwen/qwen3.9-plus'), familyStem('qwen/qwen3.8-max-0902'));
});

test('versionOf ignores the date suffix; isNewer compares version first, created only on a tie', () => {
  assert.deepEqual(versionOf('qwen/qwen3.8-max-0902'), [3, 8]);
  assert.deepEqual(versionOf('z-ai/glm-5.10'), [5, 10]);
  assert.ok(isNewer({ id: 'z-ai/glm-5.10', created: 1 }, { id: 'z-ai/glm-5.9', created: 2 }));
  assert.ok(!isNewer({ id: 'z-ai/glm-4.9', created: 9 }, { id: 'z-ai/glm-5.3', created: 1 }));
  assert.ok(
    isNewer(
      { id: 'qwen/qwen3.8-max-1201', created: 9 },
      { id: 'qwen/qwen3.8-max-0902', created: 1 },
    ),
  );
  assert.ok(!isNewer({ id: 'z-ai/glm-5.3', created: 1 }, { id: 'z-ai/glm-5.3', created: 1 }));
});

test('check: no changes exits 0 with an empty list', () => {
  const r = check(setup());
  assert.equal(r.status, 0, r.stderr);
  const out = json(r);
  assert.deepEqual(out.changes, []);
  assert.equal(out.snapshotDate, '2026-10-01');
  assert.ok(Array.isArray(out.notes));
});

test('check: a price move of 10% or more is a change; 9% is not', () => {
  const models = [
    orModel('z-ai/glm-5.3', 0.088, 1.4), // +10% in
    orModel('moonshotai/kimi-k3', 0.24, 11.94 * 1.09), // +9% out: under the threshold
    orModel('qwen/qwen3.8-max-0902', 2.0, 4.8), // -20% out
  ];
  const r = check(setup({ models }));
  assert.equal(r.status, 2, r.stderr);
  const price = json(r).changes.filter((c) => c.type === 'price');
  assert.deepEqual(price.map((c) => c.pricingId).sort(), ['qwen/qwen3.8-max-0902', 'z-ai/glm-5.3']);
  const glm = price.find((c) => c.pricingId === 'z-ai/glm-5.3');
  assert.equal(glm.label, 'GLM 5.3');
  assert.deepEqual(glm.inPerM, { was: 0.08, now: 0.088 });
  assert.equal(glm.pct, 10);
  assert.equal(price.find((c) => c.label === 'Qwen3.8 Max').pct, -20);
});

test('check: a pool id gone from the list is reported missing', () => {
  const r = check(setup({ models: BASE.filter((m) => m.id !== 'moonshotai/kimi-k3') }));
  assert.equal(r.status, 2);
  assert.deepEqual(json(r).changes, [
    { type: 'missing', label: 'Kimi K3', pricingId: 'moonshotai/kimi-k3' },
  ]);
});

test('check: newer family member is flagged; unrelated vendor and same-vendor other family are ignored', () => {
  const models = [
    ...BASE,
    orModel('z-ai/glm-5.4', 0.1, 1.5, { created: 1_760_000_000 }),
    orModel('z-ai/glm-4.9', 0.01, 0.1, { created: 1_770_000_000 }), // older version, newer date
    orModel('other/glm-9.9', 0.1, 1.5), // unrelated vendor
    orModel('z-ai/zeta-9', 0.1, 1.5), // same vendor, different family
    orModel('moonshotai/kimi-dev-72b', 0.1, 1.5), // different family stem
  ];
  const r = check(setup({ models }));
  assert.equal(r.status, 2, r.stderr);
  const newer = json(r).changes.filter((c) => c.type === 'newer');
  assert.equal(newer.length, 1, JSON.stringify(newer));
  assert.equal(newer[0].label, 'GLM 5.3');
  assert.equal(newer[0].pricingId, 'z-ai/glm-5.3');
  assert.deepEqual(newer[0].candidate, {
    id: 'z-ai/glm-5.4',
    name: 'Name of z-ai/glm-5.4',
    created: 1_760_000_000,
    inPerM: 0.1,
    outPerM: 1.5,
    context: 1_000_000,
    tools: true,
  });
});

test('check: no snapshot says so in notes and still reports newer/missing', () => {
  const f = setup({ snap: null, models: [...BASE, orModel('moonshotai/kimi-k4', 1, 1)] });
  const r = check(f);
  assert.equal(r.status, 2, r.stderr);
  const out = json(r);
  assert.equal(out.snapshotDate, null);
  assert.match(out.notes.join(' '), /no snapshot/i);
  assert.deepEqual(
    out.changes.map((c) => c.type),
    ['newer'],
  );

  const clean = check(setup({ snap: null }));
  assert.equal(clean.status, 0, 'no snapshot and nothing newer/missing exits 0');
  assert.match(json(clean).notes.join(' '), /price changes cannot be computed/i);
});

test('snapshot writes the pool prices and a later check against it is clean', () => {
  const f = setup({ snap: null });
  const target = join(f.dir, 'sub dir', 'snap.json');
  const w = run(['snapshot', '--pool', f.pool, '--prices', f.prices, '--snapshot', target]);
  assert.equal(w.status, 0, w.stderr);
  assert.ok(existsSync(target));
  const snap = JSON.parse(readFileSync(target, 'utf8'));
  assert.match(snap.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(snap.prices).sort(), POOL.map((p) => p.pricingId).sort());
  assert.deepEqual(snap.prices['z-ai/glm-5.3'], { inPerM: 0.08, outPerM: 1.4, context: 1_000_000 });
  assert.equal(json(w).written, 3);
  const r = run(['check', '--pool', f.pool, '--prices', f.prices, '--snapshot', target]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(json(r).snapshotDate, snap.date);
});

// Alternatives fixture. review job: 100k in + 15k out, no tools, 128k context.
// Dropped GLM 5.3: 0.1*100k/1e6 + 1.0*15k/1e6 = 0.01 + 0.015 = 0.025; cap 1.2x = 0.03.
const ALT_MODELS = [
  orModel('z-ai/glm-5.3', 0.1, 1.0),
  orModel('moonshotai/kimi-k3', 0.1, 1.2), // pool, 0.028 ok
  orModel('qwen/qwen3.8-max-0902', 2.0, 6.0), // pool, too dear
  orModel('moonshotai/kimi-k4', 0.05, 0.5), // newer family, 0.0125
  orModel('z-ai/glm-5.4', 0.1, 1.3), // newer family, 0.0295 ok
  orModel('cheap/thing', 0.01, 0.1), // catalog 0.0025
  orModel('cheap/small-ctx', 0.01, 0.1, { context: 32_000 }), // ineligible: context
  orModel('cheap/no-tools', 0.01, 0.1, { tools: false }), // ok for review, not for drift
  orModel('dear/thing', 1, 10), // catalog, too dear
];
const alt = (f, extra) =>
  run(['alternatives', '--pool', f.pool, '--prices', f.prices, '--snapshot', f.snapshot, ...extra]);

test('alternatives: tiers ordered pool, newer-family, catalog; cheapest first; 1.2x cost cap; eligibility', () => {
  const f = setup({ models: ALT_MODELS });
  const r = alt(f, ['--for', 'z-ai/glm-5.3', '--job', 'review']);
  assert.equal(r.status, 0, r.stderr);
  const c = json(r).candidates;
  assert.deepEqual(
    c.map((x) => [x.tier, x.id]),
    [
      ['pool', 'moonshotai/kimi-k3'],
      ['newer-family', 'moonshotai/kimi-k4'],
      ['newer-family', 'z-ai/glm-5.4'],
      ['catalog', 'cheap/no-tools'],
      ['catalog', 'cheap/thing'],
    ],
  );
  assert.equal(c[0].caliber, 'pool-approved');
  assert.equal(c[1].caliber, 'newer-version-of-pool-family');
  assert.match(c[3].caliber, /^UNVERIFIED: no benchmark/);
  for (const x of c) {
    for (const k of ['id', 'name', 'tier', 'estUsd', 'context', 'tools', 'caliber'])
      assert.ok(k in x, k);
    assert.ok(x.estUsd <= 0.03 + 1e-12, x.id);
  }
  assert.ok(
    !c.some((x) => x.id === 'z-ai/glm-5.3'),
    'the dropped model is never its own alternative',
  );
});

test('alternatives: a tools job drops models without tool support', () => {
  const f = setup({ models: ALT_MODELS });
  const r = alt(f, ['--for', 'z-ai/glm-5.3', '--job', 'drift']);
  assert.equal(r.status, 0, r.stderr);
  const ids = json(r).candidates.map((x) => x.id);
  assert.ok(!ids.includes('cheap/no-tools'));
  assert.ok(ids.includes('cheap/thing'));
});

test('alternatives: a dropped model missing from the list is priced from the snapshot', () => {
  const f = setup({
    models: ALT_MODELS.filter((m) => m.id !== 'z-ai/glm-5.3'),
    snap: {
      date: '2026-10-01',
      prices: { 'z-ai/glm-5.3': { inPerM: 0.1, outPerM: 1.0, context: 1_000_000 } },
    },
  });
  const r = alt(f, ['--for', 'z-ai/glm-5.3', '--job', 'review']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).dropped.priceSource, 'snapshot');
  assert.equal(json(r).candidates.length, 5);
});

test('alternatives: empty list still exits 0', () => {
  const f = setup({ models: [orModel('z-ai/glm-5.3', 0.0001, 0.0001)] });
  const r = alt(f, ['--for', 'z-ai/glm-5.3', '--job', 'review']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(json(r).candidates, []);
});

test('exit 1 when prices are unavailable, for every command', () => {
  const f = setup();
  const bad = join(f.dir, 'nope.json');
  for (const args of [
    ['check'],
    ['snapshot'],
    ['alternatives', '--for', 'z-ai/glm-5.3', '--job', 'review'],
  ]) {
    const r = run([...args, '--pool', f.pool, '--prices', bad, '--snapshot', f.snapshot]);
    assert.equal(r.status, 1, args[0]);
    assert.match(r.stderr, /prices unavailable/);
  }
});

test('exit 3 on bad arguments, with no stack trace', () => {
  const f = setup();
  const base = ['--pool', f.pool, '--prices', f.prices, '--snapshot', f.snapshot];
  const badSnap = join(f.dir, 'bad.json');
  writeFileSync(badSnap, '{not json');
  for (const args of [
    ['frobnicate', ...base],
    ['alternatives', ...base],
    ['alternatives', '--for', 'z-ai/glm-5.3', '--job', 'nope', ...base],
    ['alternatives', '--for', 'unknown/model', '--job', 'review', ...base],
    ['check', '--pool', join(f.dir, 'no-pool.json'), '--prices', f.prices],
    ['check', '--pool', f.pool, '--prices', f.prices, '--snapshot', badSnap],
    ['check', '--prices'],
  ]) {
    const r = run(args);
    assert.equal(r.status, 3, args.join(' '));
    assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/, 'no stack trace');
  }
});

// ---- reviewer findings ----

test('finding 2: parameter-size and context tokens are not part of the family stem or the version', () => {
  assert.deepEqual(versionOf('meta-llama/llama-3.1-70b'), [3, 1]);
  assert.deepEqual(versionOf('meta-llama/llama-3.1-8b-instruct'), [3, 1]);
  assert.deepEqual(versionOf('meta-llama/llama-3.1-405b'), [3, 1]);
  assert.deepEqual(versionOf('qwen/qwen3-235b-a22b'), [3]);
  assert.deepEqual(versionOf('qwen/qwen2.5-32b-128k'), [2, 5]);
  assert.deepEqual(versionOf('x/tiny-1.5b'), []);
  assert.equal(familyStem('meta-llama/llama-3.1-70b'), familyStem('meta-llama/llama-3.1-8b'));
  assert.equal(familyStem('meta-llama/llama-3.1-70b'), 'meta-llama/llama-');
  assert.equal(familyStem('qwen/qwen3-235b-a22b'), 'qwen/qwen');
  assert.equal(familyStem('qwen/qwen2.5-32b-128k'), 'qwen/qwen');
  assert.ok(
    !isNewer(
      { id: 'meta-llama/llama-3.1-70b', created: 5 },
      { id: 'meta-llama/llama-3.1-8b', created: 5 },
    ),
    'a bigger size of the same version is not newer',
  );
  assert.ok(
    isNewer(
      { id: 'meta-llama/llama-3.2-8b', created: 5 },
      { id: 'meta-llama/llama-3.1-70b', created: 5 },
    ),
  );
});

test('finding 2: check does not flag a bigger size of a pool model as newer', () => {
  const pool = [{ label: 'Llama 8B', pricingId: 'meta-llama/llama-3.1-8b', clink: 'c' }];
  const models = [
    orModel('meta-llama/llama-3.1-8b', 0.02, 0.05),
    orModel('meta-llama/llama-3.1-70b', 0.1, 0.3),
    orModel('meta-llama/llama-3.1-405b', 1, 3),
  ];
  const r = check(setup({ models, pool, snap: null }));
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(json(r).changes, []);
});

test('finding 3: a lower version created later is not newer (an older line refreshed is not an upgrade)', () => {
  assert.ok(
    !isNewer(
      { id: 'z-ai/glm-4.9', created: 1_800_000_000 },
      { id: 'z-ai/glm-5.3', created: 1_700_000_000 },
    ),
  );
  assert.ok(
    isNewer(
      { id: 'z-ai/glm-5.3', created: 1_700_000_000 },
      { id: 'z-ai/glm-4.9', created: 1_800_000_000 },
    ),
  );
  const header = readFileSync(SCRIPT, 'utf8').split('\nimport ')[0];
  assert.match(header, /later-created lower version/i, 'header documents why');
  assert.match(header, /not an upgrade/i);
});

test('finding 4: malformed snapshot entries are skipped with a note, never a spurious change', () => {
  const snap = {
    date: '2026-10-01',
    prices: {
      'z-ai/glm-5.3': { inPerM: null, outPerM: 1.4, context: 1_000_000 },
      'moonshotai/kimi-k3': { inPerM: '0.24', outPerM: 11.94 },
      'qwen/qwen3.8-max-0902': 7,
    },
  };
  const models = [
    orModel('z-ai/glm-5.3', 0.08, 1.4),
    orModel('moonshotai/kimi-k3', 0.5, 20), // a big move if the string were trusted
    orModel('qwen/qwen3.8-max-0902', 2.0, 6.0),
  ];
  const r = check(setup({ models, snap }));
  assert.equal(r.status, 0, r.stdout);
  const out = json(r);
  assert.deepEqual(out.changes, []);
  const notes = out.notes.join('\n');
  for (const id of ['z-ai/glm-5.3', 'moonshotai/kimi-k3', 'qwen/qwen3.8-max-0902'])
    assert.ok(notes.includes(`malformed snapshot entry for ${id}`), notes);
});

test('finding 4: a malformed snapshot entry is not used to price a dropped model', () => {
  const f = setup({
    models: ALT_MODELS.filter((m) => m.id !== 'z-ai/glm-5.3'),
    snap: {
      date: '2026-10-01',
      prices: { 'z-ai/glm-5.3': { inPerM: 'x', outPerM: 1.0, context: 1_000_000 } },
    },
  });
  const r = alt(f, ['--for', 'z-ai/glm-5.3', '--job', 'review']);
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stderr, /no price for z-ai\/glm-5\.3/);
});

test('finding 5: an empty pool exits 3 with "pool is empty"', () => {
  const f = setup({ pool: [] });
  for (const args of [
    ['check'],
    ['snapshot'],
    ['alternatives', '--for', 'z-ai/glm-5.3', '--job', 'review'],
  ]) {
    const r = run([...args, '--pool', f.pool, '--prices', f.prices, '--snapshot', f.snapshot]);
    assert.equal(r.status, 3, args[0]);
    assert.match(r.stderr, /pool is empty/);
  }
});

test('finding 6: unknown or misspelled flags exit 3 and list the allowed flags', () => {
  const f = setup();
  for (const flag of [['--pol', f.pool], ['--snap', f.snapshot], ['--verbose'], ['--no-cache']]) {
    const r = run([
      'check',
      '--pool',
      f.pool,
      '--prices',
      f.prices,
      '--snapshot',
      f.snapshot,
      ...flag,
    ]);
    assert.equal(r.status, 3, flag[0]);
    assert.match(r.stderr, /unknown flag/i, flag[0]);
    for (const k of ['--pool', '--prices', '--snapshot', '--for', '--job'])
      assert.ok(r.stderr.includes(k), k);
  }
});

// Without --job: every hive job the dropped model is eligible for. Tokens mirror model-pick JOBS.
const JOB_TOKENS = {
  inventory: [150_000, 10_000],
  graph: [150_000, 15_000],
  digest: [180_000, 10_000],
  drift: [400_000, 30_000],
  review: [100_000, 15_000],
};
const sumUsd = (inM, outM, jobs) =>
  jobs.reduce((s, j) => s + (JOB_TOKENS[j][0] * inM + JOB_TOKENS[j][1] * outM) / 1e6, 0);

test('finding 1: without --job, cost is summed over every job the dropped model is eligible for', () => {
  const f = setup({ models: ALT_MODELS });
  const r = alt(f, ['--for', 'z-ai/glm-5.3']);
  assert.equal(r.status, 0, r.stderr);
  const out = json(r);
  assert.equal(out.job, null);
  assert.deepEqual([...out.jobs].sort(), Object.keys(JOB_TOKENS).sort());
  const want = sumUsd(0.1, 1.0, Object.keys(JOB_TOKENS));
  assert.ok(Math.abs(out.dropped.estUsd - want) < 1e-6, `${out.dropped.estUsd} vs ${want}`);
  assert.ok(Math.abs(out.maxUsd - want * 1.2) < 1e-6);
  const kimi = out.candidates.find((c) => c.id === 'moonshotai/kimi-k3');
  assert.ok(kimi);
  assert.ok(Math.abs(kimi.estUsd - sumUsd(0.1, 1.2, Object.keys(JOB_TOKENS))) < 1e-6);
});

test('finding 1: without --job, a candidate must pass every job the dropped model passes', () => {
  // Dropped model has 150k context: eligible for inventory + review (minContext 128k), not the 200k jobs.
  const models = [
    orModel('z-ai/glm-5.3', 0.1, 1.0, { context: 150_000 }),
    orModel('cheap/ctx-150k', 0.01, 0.1, { context: 150_000 }),
    orModel('cheap/ctx-130k-notools', 0.01, 0.1, { context: 130_000, tools: false }), // fails inventory
    orModel('cheap/ctx-100k', 0.01, 0.1, { context: 100_000 }), // fails both
  ];
  const f = setup({ models, pool: [POOL[0]], snap: null });
  const r = alt(f, ['--for', 'z-ai/glm-5.3']);
  assert.equal(r.status, 0, r.stderr);
  const out = json(r);
  assert.deepEqual([...out.jobs].sort(), ['inventory', 'review']);
  const ids = out.candidates.map((c) => c.id);
  assert.ok(ids.includes('cheap/ctx-150k'), ids.join());
  assert.ok(
    !ids.includes('cheap/ctx-130k-notools'),
    'must pass every job the dropped model passes',
  );
  assert.ok(!ids.includes('cheap/ctx-100k'));
  const rr = alt(f, ['--for', 'z-ai/glm-5.3', '--job', 'review']);
  assert.ok(
    json(rr)
      .candidates.map((c) => c.id)
      .includes('cheap/ctx-130k-notools'),
  );
});

test('finding 1: without --job, a pool candidate with no clink client is dropped when a tool job counts', () => {
  const pool = [
    POOL[0],
    { label: 'Kimi K3 (chat only)', pricingId: 'moonshotai/kimi-k3', palModel: 'kimi/kimi-k3' },
  ];
  const f = setup({ models: ALT_MODELS, pool });
  const r = alt(f, ['--for', 'z-ai/glm-5.3']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(json(r).jobs.includes('drift'));
  assert.ok(
    !json(r).candidates.some((c) => c.id === 'moonshotai/kimi-k3'),
    'no clink, tool job counts',
  );
  const rr = alt(f, ['--for', 'z-ai/glm-5.3', '--job', 'review']);
  assert.ok(
    json(rr).candidates.some((c) => c.id === 'moonshotai/kimi-k3'),
    'a no-tool job needs no clink',
  );
});

test('finding 1: without --job, a dropped model eligible for no hive job exits 3', () => {
  const small = setup({
    models: [...ALT_MODELS.slice(1), orModel('z-ai/glm-5.3', 0.1, 1.0, { context: 64_000 })],
  });
  let r = alt(small, ['--for', 'z-ai/glm-5.3']);
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stderr, /model eligible for no hive job; pass --job/);
  const noCtx = setup({
    models: ALT_MODELS.filter((m) => m.id !== 'z-ai/glm-5.3'),
    snap: { date: '2026-10-01', prices: { 'z-ai/glm-5.3': { inPerM: 0.1, outPerM: 1.0 } } },
  });
  r = alt(noCtx, ['--for', 'z-ai/glm-5.3']);
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stderr, /model eligible for no hive job; pass --job/);
  r = alt(noCtx, ['--for', 'z-ai/glm-5.3', '--job', 'review']);
  assert.equal(r.status, 0, r.stderr);
});
