// Run: node <skill>/scripts/run-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOBS, priceTable, pickModels } from '../model-pick.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(SKILL, 'scripts', 'model-pick.mjs');

// Prices in OpenRouter's shape: USD per token, as strings.
const perM = (usd) => String(usd / 1e6);
const orModel = (id, inM, outM, { context = 1_000_000, tools = true } = {}) => ({
  id,
  context_length: context,
  pricing: { prompt: perM(inM), completion: perM(outM) },
  supported_parameters: tools ? ['tools', 'temperature'] : ['temperature'],
});
const OPENROUTER = {
  data: [
    orModel('z-ai/glm-5.3', 0.08, 1.4),
    orModel('moonshotai/kimi-k3', 0.24, 11.94),
    orModel('xiaomi/mimo-v2.6-pro', 0.43, 0.87),
    orModel('qwen/qwen3.8-max-0902', 2.0, 6.0),
    orModel('small/no-tools', 0.01, 0.01, { context: 32_000, tools: false }),
  ],
};
const POOL = [
  { label: 'GLM 5.3', pricingId: 'z-ai/glm-5.3', palModel: 'glm/glm-5.3', clink: 'claude-glm' },
  {
    label: 'Kimi K3',
    pricingId: 'moonshotai/kimi-k3',
    palModel: 'kimi/kimi-k3',
    clink: 'claude-kimi',
  },
  {
    label: 'MiMo V2.6 Pro',
    pricingId: 'xiaomi/mimo-v2.6-pro',
    palModel: 'openrouter/xiaomi/mimo-v2.6-pro',
    clink: 'claude-mimo',
  },
  {
    label: 'Qwen3.8 Max',
    pricingId: 'qwen/qwen3.8-max-0902',
    palModel: 'tokenrouter/qwen/qwen3.8-max',
    clink: 'claude-qwen',
  },
];

test('priceTable converts OpenRouter per-token strings to USD per million and reads tool support', () => {
  const t = priceTable(OPENROUTER);
  const glm = t.get('z-ai/glm-5.3');
  assert.ok(Math.abs(glm.inPerM - 0.08) < 1e-9);
  assert.ok(Math.abs(glm.outPerM - 1.4) < 1e-9);
  assert.equal(glm.tools, true);
  assert.equal(t.get('small/no-tools').tools, false);
  assert.equal(t.get('small/no-tools').context, 32_000);
});

test('priceTable drops entries with missing or negative prices instead of ranking them as free', () => {
  const t = priceTable({
    data: [
      { id: 'a/variable', pricing: { prompt: '-1', completion: '-1' } },
      { id: 'b/missing' },
      { id: 'd/blank', pricing: { prompt: '', completion: '' } },
      { id: 'e/null', pricing: { prompt: null, completion: null } },
      { id: 'f/space', pricing: { prompt: '  ', completion: '0.000001' } },
      orModel('c/ok', 1, 1),
    ],
  });
  for (const id of ['a/variable', 'b/missing', 'd/blank', 'e/null', 'f/space'])
    assert.equal(t.has(id), false, id);
  assert.equal(t.has('c/ok'), true);
});

test('priceTable rejects a payload with no data array, so an error body is never read as "no prices"', () => {
  assert.throws(() => priceTable({ error: 'rate limited' }), /data array/);
  assert.throws(() => priceTable(null), /data array/);
});

test('pickModels ranks the pool by estimated cost per job, cheapest first', () => {
  const out = pickModels({ pool: POOL, prices: priceTable(OPENROUTER), jobs: ['digest'] });
  const ranked = out.digest.ranked.map((r) => r.label);
  assert.equal(out.digest.pick.label, 'GLM 5.3');
  assert.deepEqual(ranked, ['GLM 5.3', 'MiMo V2.6 Pro', 'Kimi K3', 'Qwen3.8 Max']);
  const est = out.digest.ranked[0].estUsd;
  const want = (JOBS.digest.inTokens * 0.08 + JOBS.digest.outTokens * 1.4) / 1e6;
  assert.ok(Math.abs(est - want) < 1e-9);
});

test('an output-heavy job can change the winner', () => {
  const pool = [
    { label: 'cheap-in', pricingId: 'x/cheap-in', palModel: 'x', clink: 'claude-x' },
    { label: 'cheap-out', pricingId: 'y/cheap-out', palModel: 'y', clink: 'claude-y' },
  ];
  const prices = priceTable({
    data: [orModel('x/cheap-in', 0.01, 50), orModel('y/cheap-out', 1, 1)],
  });
  const jobs = {
    inputHeavy: { inTokens: 1_000_000, outTokens: 1_000, tools: false, minContext: 0 },
    outputHeavy: { inTokens: 1_000, outTokens: 1_000_000, tools: false, minContext: 0 },
  };
  const out = pickModels({ pool, prices, jobs: Object.keys(jobs), profiles: jobs });
  assert.equal(out.inputHeavy.pick.label, 'cheap-in');
  assert.equal(out.outputHeavy.pick.label, 'cheap-out');
});

test('a tool-use job excludes models without tool support or without a clink client', () => {
  const pool = [
    ...POOL.slice(0, 1).map((p) => ({ ...p, clink: undefined })),
    POOL[2],
    { label: 'tiny', pricingId: 'small/no-tools', palModel: 'tiny', clink: 'claude-tiny' },
  ];
  const out = pickModels({ pool, prices: priceTable(OPENROUTER), jobs: ['drift'] });
  assert.equal(out.drift.pick.label, 'MiMo V2.6 Pro');
  assert.equal(out.drift.channel, 'clink');
  const reasons = Object.fromEntries(out.drift.excluded.map((e) => [e.label, e.reason]));
  assert.match(reasons['GLM 5.3'], /no clink client/);
  assert.match(reasons.tiny, /no tool support|context/);
});

test('reachability is checked per channel: chat answers do not qualify a model for a clink job, nor the reverse', () => {
  const reachable = { chat: ['glm/glm-5.3', 'kimi/kimi-k3'], clink: ['claude-mimo'] };
  const out = pickModels({
    pool: POOL,
    prices: priceTable(OPENROUTER),
    jobs: ['digest', 'drift'],
    reachable,
  });
  assert.deepEqual(
    out.digest.ranked.map((r) => r.label),
    ['GLM 5.3', 'Kimi K3'],
  );
  assert.deepEqual(
    out.drift.ranked.map((r) => r.label),
    ['MiMo V2.6 Pro'],
  );
  assert.match(
    out.drift.excluded.find((e) => e.label === 'GLM 5.3').reason,
    /not reachable on clink/,
  );
  assert.match(
    out.digest.excluded.find((e) => e.label === 'MiMo V2.6 Pro').reason,
    /not reachable on chat/,
  );
});

test('reachable must be the {chat, clink} object; a flat list or a string is rejected, not misread', () => {
  const run = (reachable) => () =>
    pickModels({ pool: POOL, prices: priceTable(OPENROUTER), jobs: ['digest'], reachable });
  assert.throws(run(['glm/glm-5.3']), /reachable must be/);
  assert.throws(run('glm/glm-5.3'), /reachable must be/);
  assert.throws(run({ chat: 'glm/glm-5.3' }), /reachable must be/);
  assert.throws(run(null), /reachable must be/);
});

test('a pool model with no published price is excluded, never treated as free', () => {
  const pool = [
    ...POOL,
    { label: 'Unlisted', pricingId: 'nobody/unlisted', palModel: 'u', clink: 'claude-u' },
  ];
  const out = pickModels({ pool, prices: priceTable(OPENROUTER), jobs: ['digest'] });
  assert.equal(out.digest.pick.label, 'GLM 5.3');
  assert.match(out.digest.excluded.find((e) => e.label === 'Unlisted').reason, /no price/);
});

test('flatRate entries rank first at zero marginal cost and say so', () => {
  const pool = POOL.map((p) => (p.label === 'Qwen3.8 Max' ? { ...p, flatRate: true } : p));
  const out = pickModels({ pool, prices: priceTable(OPENROUTER), jobs: ['review'] });
  assert.equal(out.review.pick.label, 'Qwen3.8 Max');
  assert.equal(out.review.pick.estUsd, 0);
  assert.equal(out.review.pick.flatRate, true);
});

test('no eligible model gives pick null rather than a silent fallback', () => {
  const out = pickModels({
    pool: POOL,
    prices: priceTable(OPENROUTER),
    jobs: ['digest'],
    reachable: { chat: [], clink: [] },
  });
  assert.equal(out.digest.pick, null);
  assert.equal(out.digest.excluded.length, POOL.length);
});

test('every read-only hive job is defined: inventory and drift on clink, digest, graph and review on chat', () => {
  assert.deepEqual(Object.keys(JOBS).sort(), ['digest', 'drift', 'graph', 'inventory', 'review']);
  assert.equal(JOBS.inventory.tools, true);
  assert.equal(JOBS.graph.tools, false);
  const out = pickModels({ pool: POOL, prices: priceTable(OPENROUTER) });
  assert.equal(out.inventory.channel, 'clink');
  assert.equal(out.graph.channel, 'chat');
});

test('a chat job only admits models whose context holds a whole item (input + output budget)', () => {
  for (const [name, job] of Object.entries(JOBS))
    if (!job.tools)
      assert.ok(
        job.minContext >= job.inTokens + job.outTokens,
        `${name}: minContext ${job.minContext} < ${job.inTokens + job.outTokens}`,
      );
});

test('each job names two bees: the two cheapest eligible models, and their summed cost per item', () => {
  const out = pickModels({ pool: POOL, prices: priceTable(OPENROUTER), jobs: ['digest'] });
  assert.deepEqual(
    out.digest.bees.map((b) => b.label),
    ['GLM 5.3', 'MiMo V2.6 Pro'],
  );
  assert.equal(out.digest.pairable, true);
  const sum = out.digest.ranked[0].estUsd + out.digest.ranked[1].estUsd;
  assert.ok(Math.abs(out.digest.hiveUsdPerItem - sum) < 1e-12);
});

test('with one eligible model the job is not pairable and says why, so the second bee falls to Claude', () => {
  const out = pickModels({
    pool: POOL,
    prices: priceTable(OPENROUTER),
    jobs: ['drift'],
    reachable: { chat: [], clink: ['claude-kimi'] },
  });
  assert.deepEqual(
    out.drift.bees.map((b) => b.label),
    ['Kimi K3'],
  );
  assert.equal(out.drift.pairable, false);
  assert.match(out.drift.pairReason, /1 eligible model/);
});

test('with no eligible model there are no bees and the job is not pairable', () => {
  const out = pickModels({
    pool: POOL,
    prices: priceTable(OPENROUTER),
    jobs: ['graph'],
    reachable: { chat: [], clink: [] },
  });
  assert.deepEqual(out.graph.bees, []);
  assert.equal(out.graph.pairable, false);
  assert.equal(out.graph.hiveUsdPerItem, null);
});

test('an unknown job name is an error, not an empty result', () => {
  assert.throws(
    () => pickModels({ pool: POOL, prices: priceTable(OPENROUTER), jobs: ['nope'] }),
    /unknown job/,
  );
});

test('the shipped model-pool.json is valid: unique labels, a clink client per entry, matching config files', () => {
  const pool = JSON.parse(readFileSync(join(SKILL, 'model-pool.json'), 'utf8')).pool;
  assert.ok(pool.length >= 4);
  assert.equal(new Set(pool.map((p) => p.label)).size, pool.length);
  for (const p of pool) {
    assert.ok(p.pricingId && p.palModel && p.clink && p.route, `incomplete entry ${p.label}`);
    const cfg = JSON.parse(
      readFileSync(join(SKILL, 'pal', 'cli_clients', `${p.clink}.json`), 'utf8'),
    );
    assert.equal(cfg.name, p.clink);
    const i = cfg.additional_args.indexOf('--model');
    assert.equal(
      cfg.additional_args[i + 1],
      p.palModel,
      `${p.clink} runs a different model than the pool says`,
    );
  }
});

test('CLI ranks from a prices file and reports where the prices came from', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rac-pick-'));
  const prices = join(dir, 'prices.json');
  writeFileSync(prices, JSON.stringify(OPENROUTER));
  const pool = join(dir, 'pool.json');
  writeFileSync(pool, JSON.stringify({ pool: POOL }));
  const out = JSON.parse(
    execFileSync(
      process.execPath,
      [SCRIPT, '--pool', pool, '--prices', prices, '--jobs', 'digest,drift'],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(out.pricesSource, prices);
  assert.equal(out.jobs.digest.pick.label, 'GLM 5.3');
  assert.ok(out.jobs.drift.pick);
});

const tmpFile = (name, body) => {
  const f = join(mkdtempSync(join(tmpdir(), 'rac-pick-')), name);
  writeFileSync(f, body);
  return f;
};

test('CLI exits 1 when prices are unavailable, unreadable or unusable, so the caller marks the ranking UNVERIFIED', () => {
  for (const prices of [
    join(tmpdir(), 'rac-does-not-exist.json'),
    tmpFile('err.json', '{"error":"x"}'),
    tmpFile('null.json', 'null'),
    tmpFile('empty.json', '{"data":[]}'),
  ]) {
    const r = spawnSync(process.execPath, [SCRIPT, '--prices', prices], { encoding: 'utf8' });
    assert.equal(r.status, 1, prices);
    assert.match(r.stderr, /prices unavailable/);
  }
});

test('CLI exits 3 on bad arguments or input, never 1, so they are not mistaken for missing prices', () => {
  const prices = tmpFile('p.json', JSON.stringify(OPENROUTER));
  const cases = [
    ['--prices', prices, '--jobs', 'nope'],
    ['--prices', prices, '--pool', join(tmpdir(), 'rac-no-pool.json')],
    ['--prices', prices, '--reachable', tmpFile('r.json', '["glm/glm-5.3"]')],
    ['--prices', prices, '--reachable'],
    ['--prices'],
  ];
  for (const args of cases) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 3, args.join(' '));
    assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/, 'no stack trace');
  }
});
