#!/usr/bin/env node
// Usage: node model-pick.mjs [--pool <file>] [--prices <file>] [--reachable <file>] [--jobs inventory,graph,digest,drift,review]
// Ranks the cheap-model pool (../model-pool.json) by estimated USD per job and picks the cheapest eligible
// model for each, plus the two cheapest as the job's hive bees (`bees`, `pairable`, `hiveUsdPerItem`). Prices come from OpenRouter's public model list (no key needed), or --prices <file> holding
// the same JSON. That list is a comparable yardstick, not a bill: a route billed by subscription is marked
// `flatRate: true` in the pool and ranks at zero marginal cost.
// --reachable <file> holds {"chat": [palModel...], "clink": [clink client...]}: the names that answered the
// P0 probe on each channel. A text job needs its palModel in `chat`; a tool job needs its client in `clink`.
// Exit 0 = ranking printed; 1 = prices unavailable (mark the ranking UNVERIFIED); 3 = bad arguments or input.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain } from './lib.mjs';

const PRICES_URL = 'https://openrouter.ai/api/v1/models';

// Token budgets per job are rough, but the same for every model, so they rank fairly.
// Text jobs go through PAL chat; `inventory` and `drift` read the repo themselves through a read-only clink client.
// Budgets are per hive item (one doc cluster, one session, one graph slice), not per whole phase. A chat job sends
// the whole item in one call, so its minContext must hold inTokens + outTokens; clink jobs read incrementally.
export const JOBS = {
  inventory: {
    inTokens: 150_000,
    outTokens: 10_000,
    tools: true,
    minContext: 128_000,
    phases: 'P1 inventory reading',
  },
  graph: {
    inTokens: 150_000,
    outTokens: 15_000,
    tools: false,
    minContext: 200_000,
    phases: 'P4 graph analysis',
  },
  digest: {
    inTokens: 180_000,
    outTokens: 10_000,
    tools: false,
    minContext: 200_000,
    phases: 'P3 session digest',
  },
  drift: {
    inTokens: 400_000,
    outTokens: 30_000,
    tools: true,
    minContext: 200_000,
    phases: 'P5 drift first pass',
  },
  review: {
    inTokens: 100_000,
    outTokens: 15_000,
    tools: false,
    minContext: 128_000,
    phases: 'P8 neutral reviewer',
  },
};

// OpenRouter prices are USD per token as decimal strings; "-1" means variable pricing. Anything that is not a
// plain non-negative number (blank, null, "-1", "free") is dropped, so an unknown price can never rank as free.
const PRICE = /^\d+(\.\d+)?(e-?\d+)?$/i;
const price = (v) =>
  typeof v === 'number' && v >= 0
    ? v
    : typeof v === 'string' && PRICE.test(v.trim())
      ? Number(v)
      : null;

export function priceTable(json) {
  if (!Array.isArray(json?.data)) throw new Error('no data array in the prices payload');
  const table = new Map();
  for (const m of json.data) {
    const inTok = price(m?.pricing?.prompt);
    const outTok = price(m?.pricing?.completion);
    if (!m?.id || inTok === null || outTok === null) continue;
    table.set(m.id, {
      inPerM: inTok * 1e6,
      outPerM: outTok * 1e6,
      context: Number(m.context_length) || 0,
      tools: (m.supported_parameters ?? []).includes('tools'),
    });
  }
  return table;
}

function rankJob(job, profile, pool, prices, reachable) {
  const ranked = [];
  const excluded = [];
  for (const entry of pool) {
    const skip = (reason) =>
      excluded.push({ label: entry.label, pricingId: entry.pricingId, reason });
    if (profile.tools && !entry.clink) {
      skip('no clink client, so no tool use');
      continue;
    }
    if (reachable) {
      const [channel, name] = profile.tools ? ['clink', entry.clink] : ['chat', entry.palModel];
      if (!reachable[channel].has(name)) {
        skip(`not reachable on ${channel} (${name} failed or missed the P0 probe)`);
        continue;
      }
    }
    const p = prices.get(entry.pricingId);
    if (!p) {
      skip(`no price for ${entry.pricingId}`);
      continue;
    }
    if (profile.tools && !p.tools) {
      skip('no tool support');
      continue;
    }
    if (p.context < profile.minContext) {
      skip(`context ${p.context} < ${profile.minContext}`);
      continue;
    }
    const estUsd = entry.flatRate
      ? 0
      : (profile.inTokens * p.inPerM + profile.outTokens * p.outPerM) / 1e6;
    ranked.push({
      label: entry.label,
      pricingId: entry.pricingId,
      palModel: entry.palModel,
      clink: entry.clink ?? null,
      route: entry.route ?? null,
      flatRate: Boolean(entry.flatRate),
      inPerM: p.inPerM,
      outPerM: p.outPerM,
      estUsd,
    });
  }
  ranked.sort(
    (a, b) => a.estUsd - b.estUsd || a.inPerM - b.inPerM || a.label.localeCompare(b.label),
  );
  // The hive sends every item to two different models (MODELS.md, Beehive), so name the two cheapest.
  const bees = ranked.slice(0, 2);
  return {
    job,
    channel: profile.tools ? 'clink' : 'chat',
    phases: profile.phases ?? '',
    pick: ranked[0] ?? null,
    bees,
    pairable: bees.length === 2,
    pairReason:
      bees.length === 2
        ? null
        : `${bees.length} eligible model${bees.length === 1 ? '' : 's'}; need 2`,
    hiveUsdPerItem: bees.length ? bees.reduce((s, b) => s + b.estUsd, 0) : null,
    ranked,
    excluded,
  };
}

// reachable: undefined (no probe yet, nothing filtered) or { chat: string[], clink: string[] }.
export function pickModels({ pool, prices, jobs = Object.keys(JOBS), reachable, profiles = JOBS }) {
  if (!Array.isArray(pool)) throw new TypeError('pool must be an array');
  let reach = null;
  if (reachable !== undefined) {
    const ok = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
    if (
      !reachable ||
      typeof reachable !== 'object' ||
      Array.isArray(reachable) ||
      !ok(reachable.chat ?? []) ||
      !ok(reachable.clink ?? [])
    ) {
      throw new TypeError('reachable must be {"chat": [names], "clink": [names]}');
    }
    reach = { chat: new Set(reachable.chat ?? []), clink: new Set(reachable.clink ?? []) };
  }
  const out = {};
  for (const job of jobs) {
    if (!profiles[job])
      throw new Error(`unknown job "${job}"; known: ${Object.keys(profiles).join(', ')}`);
    out[job] = rankJob(job, profiles[job], pool, prices, reach);
  }
  return out;
}

async function loadPrices(file) {
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  const res = await fetch(PRICES_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const fail = (code, msg) => {
  console.error(`model-pick: ${msg}`);
  process.exit(code);
};

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  for (const k of ['pool', 'prices', 'reachable', 'jobs'])
    if (args[k] === true) fail(3, `--${k} needs a value`);
  const here = dirname(fileURLToPath(import.meta.url));
  const poolFile = args.pool ?? join(here, '..', 'model-pool.json');
  let pool, reachable, jobs;
  try {
    pool = JSON.parse(readFileSync(poolFile, 'utf8')).pool;
    reachable = args.reachable ? JSON.parse(readFileSync(args.reachable, 'utf8')) : undefined;
    jobs = args.jobs
      ? args.jobs
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  } catch (e) {
    fail(3, `bad input: ${e.message}`);
  }
  let table;
  try {
    table = priceTable(await loadPrices(args.prices));
    if (!table.size) throw new Error('no usable prices in the payload');
  } catch (e) {
    fail(1, `prices unavailable (${e.message}); ranking is UNVERIFIED`);
  }
  let result;
  try {
    result = pickModels({ pool, prices: table, jobs, reachable });
  } catch (e) {
    fail(3, `bad input: ${e.message}`);
  }
  console.log(
    JSON.stringify(
      { pricesSource: args.prices ?? PRICES_URL, pool: poolFile, jobs: result },
      null,
      2,
    ),
  );
}
