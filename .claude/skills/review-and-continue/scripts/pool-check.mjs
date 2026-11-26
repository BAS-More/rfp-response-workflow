#!/usr/bin/env node
// Usage: node pool-check.mjs [check] [--pool <file>] [--prices <file>] [--snapshot <file>]
//        node pool-check.mjs snapshot [--pool <file>] [--prices <file>] [--snapshot <file>]
//        node pool-check.mjs alternatives --for <pricingId> [--job <job>] [--pool <file>] [--prices <file>] [--snapshot <file>]
// Run at every P0. Compares the cheap-model pool (../model-pool.json) with OpenRouter's public model list (no key
// needed; --prices <file> holds the same JSON) and a price snapshot (../pool-snapshot.json).
//   check        -> {pricesSource, snapshotDate|null, changes, notes}. A change is a price move >= 10% vs the
//                   snapshot, a pool id missing from the list, or a newer model of a pool model's family (same
//                   vendor prefix and family stem; higher version, or the same version created later). Size and
//                   context tokens (8b, 70b, a22b, 1.5b, 128k) are ignored, so a bigger size is not "newer". A
//                   later-created lower version is never newer: it is an older line refreshed (e.g. glm-4.9 shipped
//                   after glm-5.3), not an upgrade, so the created date only breaks a tie between equal versions.
//                   A snapshot entry whose inPerM/outPerM is not a finite number is skipped with a note.
//   snapshot     -> writes {date, prices:{pricingId:{inPerM,outPerM,context}}} to the snapshot file. This is the
//                   only write the script does.
//   alternatives -> replacements for a model dropped after missing canaries. OpenRouter publishes no quality
//                   score, so candidates are tiered: other pool models, newer versions of a pool family, then the
//                   rest of the catalog (caliber UNVERIFIED). Kept only if eligible for the job (context, tools)
//                   and estimated job cost <= 1.2x the dropped model's. List prices are used for every model,
//                   flatRate is ignored: this compares models, not bills. Without --job, the jobs are every hive
//                   job the dropped model is eligible for (none -> exit 3, pass --job); a candidate must pass all
//                   of them (a pool candidate needs a clink client when any is a tool job), and estUsd is the sum.
// Exit codes: check 0 = no changes, 2 = changes found (raise them at P0); every command: 1 = prices unavailable,
// 3 = bad arguments or input (unknown command, flag or job, empty or unreadable pool or snapshot, --for id priced
// nowhere, no --job and the dropped model eligible for no job).
// snapshot and alternatives exit 0 on success (alternatives may print an empty list).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain } from './lib.mjs';
import { priceTable, JOBS } from './model-pick.mjs';

const PRICES_URL = 'https://openrouter.ai/api/v1/models';
const THRESHOLD_PCT = 10;
const COST_CAP = 1.2;
const CALIBER = {
  pool: 'pool-approved',
  'newer-family': 'newer-version-of-pool-family',
  catalog: 'UNVERIFIED: no benchmark in the OpenRouter list',
};
const TIER_ORDER = { pool: 0, 'newer-family': 1, catalog: 2 };

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const splitId = (id) => {
  const i = id.indexOf('/');
  return i < 0 ? ['', id] : [id.slice(0, i + 1), id.slice(i + 1)];
};
// A trailing -MMDD / -YYYYMMDD style suffix is a release date, not a version.
const stripDate = (s) => s.replace(/-\d{4,8}$/, '');
// Parameter-size (8b, 70b, 1.5b, a22b, 8x7b) and context (128k) tokens describe a variant, not a version.
const SIZE_TOKEN = /^(a?\d+(\.\d+)?b|\d+x\d+(\.\d+)?b|\d+k)$/i;
const core = (rest) =>
  stripDate(
    rest
      .split('-')
      .filter((t) => !SIZE_TOKEN.test(t))
      .join('-'),
  );

// 'z-ai/glm-5.3' -> 'z-ai/glm-', 'qwen/qwen3.8-max-0902' -> 'qwen/qwen-max', 'meta-llama/llama-3.1-70b' ->
// 'meta-llama/llama-'.
export function familyStem(id) {
  const [vendor, rest] = splitId(id);
  return (
    vendor +
    core(rest)
      .replace(/[\d.]+/g, '')
      .replace(/-{2,}/g, '-')
  );
}

// Every number in the id after the vendor, size/context tokens and date suffix: 'qwen/qwen3.8-max-0902' -> [3, 8].
export function versionOf(id) {
  return (core(splitId(id)[1]).match(/\d+/g) ?? []).map(Number);
}

const cmpVersion = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
};

// cand / base: {id, created?}. Same family is the caller's check. Higher version wins; a later-created lower
// version is never newer (an older line refreshed is not an upgrade); on a tie, a later created date is newer.
export function isNewer(cand, base) {
  if (cand.id === base.id) return false;
  const v = cmpVersion(versionOf(cand.id), versionOf(base.id));
  if (v) return v > 0;
  return Number(cand.created) > 0 && Number(base.created) > 0 && cand.created > base.created;
}

// id -> {id, name, created} for every model in the payload, priced or not.
function metaTable(json) {
  const meta = new Map();
  for (const m of json.data) {
    if (typeof m?.id !== 'string' || !m.id) continue;
    meta.set(m.id, { id: m.id, name: m.name ?? m.id, created: Number(m.created) || null });
  }
  return meta;
}

const poolIds = (pool) => new Set(pool.map((e) => e.pricingId));

// Newer family members of one pool id, best first. Pool ids themselves are never candidates.
function newerFor(pricingId, meta, inPool) {
  const stem = familyStem(pricingId);
  const base = meta.get(pricingId) ?? { id: pricingId, created: null };
  return [...meta.values()]
    .filter((m) => !inPool.has(m.id) && familyStem(m.id) === stem && isNewer(m, base))
    .sort(
      (a, b) =>
        cmpVersion(versionOf(b.id), versionOf(a.id)) ||
        (b.created ?? 0) - (a.created ?? 0) ||
        a.id.localeCompare(b.id),
    );
}

// A usable snapshot price: an object whose inPerM and outPerM are finite numbers.
const validSnap = (s) =>
  Boolean(s) && typeof s === 'object' && Number.isFinite(s.inPerM) && Number.isFinite(s.outPerM);

const pctMove = (was, now) => {
  if (was === now) return 0;
  if (!was) return null; // from free/zero: no finite percentage, but it is a change
  return Math.round(((now - was) / was) * 100 * 1e6) / 1e6;
};

export function checkPool({ pool, prices, meta, snapshot }) {
  const changes = [];
  const notes = [];
  const inPool = poolIds(pool);
  if (!snapshot)
    notes.push('no snapshot: price changes cannot be computed (run `pool-check.mjs snapshot`)');
  for (const e of pool) {
    const p = prices.get(e.pricingId);
    if (!p) {
      changes.push({ type: 'missing', label: e.label, pricingId: e.pricingId });
    } else if (snapshot) {
      const was = snapshot.prices[e.pricingId];
      if (was === undefined)
        notes.push(`no snapshot price for ${e.pricingId}; its price change cannot be computed`);
      else if (!validSnap(was))
        notes.push(
          `malformed snapshot entry for ${e.pricingId} (inPerM/outPerM must be finite numbers); skipped`,
        );
      else {
        const now = { inPerM: round6(p.inPerM), outPerM: round6(p.outPerM) };
        const moves = [pctMove(was.inPerM, now.inPerM), pctMove(was.outPerM, now.outPerM)];
        const hit = moves.some((m) => m === null || Math.abs(m) >= THRESHOLD_PCT);
        if (hit) {
          // The larger move of the two, signed; null when a price moved off zero (no finite percentage).
          const pct = moves.includes(null)
            ? null
            : Math.round((Math.abs(moves[1]) > Math.abs(moves[0]) ? moves[1] : moves[0]) * 10) / 10;
          changes.push({
            type: 'price',
            label: e.label,
            pricingId: e.pricingId,
            inPerM: { was: was.inPerM, now: now.inPerM },
            outPerM: { was: was.outPerM, now: now.outPerM },
            pct,
          });
        }
      }
    }
    for (const m of newerFor(e.pricingId, meta, inPool)) {
      const q = prices.get(m.id);
      changes.push({
        type: 'newer',
        label: e.label,
        pricingId: e.pricingId,
        candidate: {
          id: m.id,
          name: m.name,
          created: m.created,
          inPerM: q ? round6(q.inPerM) : null,
          outPerM: q ? round6(q.outPerM) : null,
          context: q ? q.context : null,
          tools: q ? q.tools : null,
        },
      });
    }
  }
  return { changes, notes };
}

export function snapshotOf(pool, prices, date = new Date().toISOString().slice(0, 10)) {
  const out = { date, prices: {} };
  const missing = [];
  for (const e of pool) {
    const p = prices.get(e.pricingId);
    if (!p) missing.push(e.pricingId);
    else
      out.prices[e.pricingId] = {
        inPerM: round6(p.inPerM),
        outPerM: round6(p.outPerM),
        context: p.context,
      };
  }
  return { snapshot: out, missing };
}

const eligible = (p, prof) => p.context >= prof.minContext && (!prof.tools || p.tools);
const jobUsd = (p, prof) => (prof.inTokens * p.inPerM + prof.outTokens * p.outPerM) / 1e6;

export function alternatives({ pool, prices, meta, snapshot, forId, job }) {
  const entry = pool.find((e) => e.pricingId === forId);
  let dp = prices.get(forId);
  let priceSource = 'list';
  if (!dp && validSnap(snapshot?.prices?.[forId])) {
    const s = snapshot.prices[forId];
    dp = {
      inPerM: s.inPerM,
      outPerM: s.outPerM,
      context: Number(s.context) || 0,
      tools: Boolean(entry?.clink),
    };
    priceSource = 'snapshot';
  }
  if (!dp) throw new Error(`no price for ${forId} in the list or the snapshot`);
  const jobs = job ? [job] : Object.keys(JOBS).filter((j) => eligible(dp, JOBS[j]));
  if (!jobs.length) throw new Error(`${forId}: model eligible for no hive job; pass --job`);
  const droppedUsd = jobs.reduce((s, j) => s + jobUsd(dp, JOBS[j]), 0);
  const maxUsd = droppedUsd * COST_CAP;

  const inPool = poolIds(pool);
  const tiers = new Map(); // id -> tier, first (best) tier wins
  for (const e of pool) if (e.pricingId !== forId) tiers.set(e.pricingId, 'pool');
  for (const e of pool)
    for (const m of newerFor(e.pricingId, meta, inPool))
      if (!tiers.has(m.id)) tiers.set(m.id, 'newer-family');
  for (const id of prices.keys()) if (!tiers.has(id)) tiers.set(id, 'catalog');
  tiers.delete(forId);

  const candidates = [];
  for (const [id, tier] of tiers) {
    const p = prices.get(id);
    if (!p) continue;
    if (
      tier === 'pool' &&
      jobs.some((j) => JOBS[j].tools) &&
      !pool.find((e) => e.pricingId === id).clink
    )
      continue; // a pool model with no clink client cannot run a tool job
    if (!jobs.every((j) => eligible(p, JOBS[j]))) continue;
    const estUsd = jobs.reduce((s, j) => s + jobUsd(p, JOBS[j]), 0);
    if (estUsd > maxUsd + 1e-12) continue;
    candidates.push({
      id,
      name: meta.get(id)?.name ?? id,
      tier,
      estUsd: round6(estUsd),
      context: p.context,
      tools: p.tools,
      caliber: CALIBER[tier],
    });
  }
  candidates.sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.estUsd - b.estUsd || a.id.localeCompare(b.id),
  );
  return {
    for: forId,
    job: job ?? null,
    jobs,
    dropped: {
      pricingId: forId,
      label: entry?.label ?? null,
      estUsd: round6(droppedUsd),
      priceSource,
    },
    maxUsd: round6(maxUsd),
    candidates,
  };
}

async function loadPrices(file) {
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  const res = await fetch(PRICES_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const fail = (code, msg) => {
  console.error(`pool-check: ${msg}`);
  process.exit(code);
};

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const FLAGS = ['pool', 'prices', 'snapshot', 'for', 'job'];
  const unknown = Object.keys(args).filter((k) => k !== '_' && !FLAGS.includes(k));
  if (unknown.length)
    fail(
      3,
      `unknown flag ${unknown.map((k) => `--${k}`).join(', ')}; allowed: ${FLAGS.map((k) => `--${k}`).join(', ')}`,
    );
  for (const k of FLAGS) if (args[k] === true || args[k] === false) fail(3, `--${k} needs a value`);
  const cmd = args._[0] ?? 'check';
  if (!['check', 'snapshot', 'alternatives'].includes(cmd) || args._.length > 1)
    fail(3, `unknown command "${args._.join(' ')}"; use check, snapshot or alternatives`);
  if (cmd === 'alternatives') {
    if (!args.for) fail(3, 'alternatives needs --for <pricingId>');
    if (args.job && !JOBS[args.job])
      fail(3, `unknown job "${args.job}"; known: ${Object.keys(JOBS).join(', ')}`);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const poolFile = args.pool ?? join(here, '..', 'model-pool.json');
  const snapFile = args.snapshot ?? join(here, '..', 'pool-snapshot.json');
  let pool;
  let snapshot = null;
  try {
    pool = JSON.parse(readFileSync(poolFile, 'utf8')).pool;
    if (!Array.isArray(pool) || !pool.every((e) => typeof e?.pricingId === 'string'))
      throw new Error('pool must be {"pool": [{label, pricingId, ...}]}');
    if (!pool.length) throw new Error(`pool is empty (${poolFile})`);
    if (cmd !== 'snapshot' && existsSync(snapFile)) {
      snapshot = JSON.parse(readFileSync(snapFile, 'utf8'));
      if (!snapshot || typeof snapshot.prices !== 'object' || snapshot.prices === null)
        throw new Error(`snapshot ${snapFile} has no prices object`);
    }
  } catch (e) {
    fail(3, `bad input: ${e.message}`);
  }
  let raw, prices;
  try {
    raw = await loadPrices(args.prices);
    prices = priceTable(raw);
    if (!prices.size) throw new Error('no usable prices in the payload');
  } catch (e) {
    fail(1, `prices unavailable (${e.message}); pool check is UNVERIFIED`);
  }
  const pricesSource = args.prices ?? PRICES_URL;
  const meta = metaTable(raw);

  if (cmd === 'snapshot') {
    const { snapshot: snap, missing } = snapshotOf(pool, prices);
    try {
      mkdirSync(dirname(snapFile), { recursive: true });
      writeFileSync(snapFile, JSON.stringify(snap, null, 2) + '\n');
    } catch (e) {
      fail(3, `cannot write snapshot ${snapFile}: ${e.message}`);
    }
    console.log(
      JSON.stringify(
        {
          pricesSource,
          snapshot: snapFile,
          date: snap.date,
          written: Object.keys(snap.prices).length,
          missing,
        },
        null,
        2,
      ),
    );
  } else if (cmd === 'alternatives') {
    let result;
    try {
      result = alternatives({ pool, prices, meta, snapshot, forId: args.for, job: args.job });
    } catch (e) {
      fail(3, `bad input: ${e.message}`);
    }
    console.log(JSON.stringify({ pricesSource, ...result }, null, 2));
  } else {
    const { changes, notes } = checkPool({ pool, prices, meta, snapshot });
    console.log(
      JSON.stringify(
        { pricesSource, snapshotDate: snapshot?.date ?? null, changes, notes },
        null,
        2,
      ),
    );
    process.exitCode = changes.length ? 2 : 0;
  }
}
