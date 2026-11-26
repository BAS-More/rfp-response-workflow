#!/usr/bin/env node
// Usage: node run-state.mjs <command> --file <STATE.json> [...]
//   init --run <RUN> [--cap-usd <n>]       create the file; same run -> printed unchanged, except that --cap-usd
//                                          sets the cap when none is set (a different existing cap -> exit 3: use
//                                          'cap'); other run -> exit 3
//   phase <P0..P9> start|done [--reopen]   'start' on a done phase -> exit 3 unless --reopen (then it is started
//                                          again: doneAt is dropped, reopenedAt recorded)
//   cap --usd <n>
//   approve <job> --calls <n>              bee calls the user approved for that job
//   plan <job> --items <id,id,...>         register items as pending (idempotent, never resets results)
//   item <job> <itemId> <bee> ok|fail [--usd <n>] [--actual-usd <n>] [--note <text> | --note=<text>]
//                                          (use --note=<text> when the text itself starts with --)
//   canary <model> pass|miss [--job <job>] the 2nd miss in the run drops the model
//   drop <model> --reason <text>
//   check <job> --calls <n> [--usd <n>]    gate before sending bees: approval (+20%) and spend cap
//   show | resume                          {run, lastDonePhase, nextPhase, pendingItems, failedItems,
//                                           droppedModels, spend, capUsd, overCap}
// Any id works as a job, item or model name, including constructor, toString or __proto__.
// The run's progress file, so a crash or restart resumes where it stopped. An item is done only once 2 distinct
// bees reported ok for it. Every command holds <file>.lock (created with 'wx' and holding {pid, at}; ~5s retry with
// backoff) and writes <file>.tmp then renames it over the file, so concurrent bees never lose each other's
// results. A lock whose pid is dead, or that is older than 30s, is stale: a waiter renames it aside under a
// unique name and only that one rename wins, so two waiters cannot both break it. Windows reports a lock that is
// being deleted as EPERM; that is waited out, but when the folder itself refuses new files (EACCES/EPERM on a
// probe file too) the command fails with that error after ~0.5s. RUN_STATE_LOCK_TIMEOUT_MS overrides the 5s
// wait (tests).
// Mutating commands print the whole state as JSON; show/resume print the summary; check prints {ok, ...}.
// Exit 0 = ok; 2 = check failed (no approval, over approval, over cap) with {ok:false, reason}; 3 = bad arguments,
// wrong run, lock timeout, or a missing/unreadable state file.
import {
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
  statSync,
  existsSync,
  mkdirSync,
  linkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, isMain } from './lib.mjs';

export const PHASES = Array.from({ length: 10 }, (_, i) => `P${i}`);
export const APPROVAL_SLACK = 1.2;
export const BEES_PER_ITEM = 2;
export const CANARY_MISSES_TO_DROP = 2;
const STALE_LOCK_MS = 30_000;
const PERM_RETRY_MS = 500;
const PERM_CODES = ['EPERM', 'EACCES'];

// Maps keyed by user-supplied ids are null-prototype objects, so 'constructor' or '__proto__' are plain keys.
const dict = (o) => Object.assign(Object.create(null), o ?? {});
const own = (o, k) =>
  o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined;
const entry = (map, k, make) => (Object.hasOwn(map, k) ? map[k] : (map[k] = make()));

class StateError extends Error {
  constructor(code, message, payload) {
    super(message);
    this.code = code;
    this.payload = payload;
  }
}
const bad = (msg) => new StateError(3, msg);
const round = (n) => Math.round(n * 1e9) / 1e9;
const now = () => new Date().toISOString();

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleeper, 0, 0, ms);

const num = (v, name, { required = false } = {}) => {
  if (v === undefined && !required) return undefined;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) throw bad(`--${name} needs a non-negative number`);
  return n;
};
const name = (v, what) => {
  if (typeof v !== 'string' || !v.trim()) throw bad(`missing ${what}`);
  return v.trim();
};
const text = (v, flag) => {
  if (typeof v !== 'string' || !v.trim()) throw bad(`--${flag} needs a value`);
  return v;
};

const unique = () => `${process.pid}-${randomBytes(6).toString('hex')}`;
const tryUnlink = (p) => {
  try {
    unlinkSync(p);
  } catch {
    /* already gone */
  }
};

// true = running, false = gone, null = no usable pid recorded.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH'; // EPERM: it exists but belongs to someone else
  }
}

// null when the lock is gone; else {body, stale}. body is null when the lock cannot be read (never stale then).
function inspectLock(lock) {
  let body;
  try {
    body = readFileSync(lock, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? null : { body: null, stale: false };
  }
  let info = {};
  try {
    info = JSON.parse(body) ?? {};
  } catch {
    /* half-written or foreign lock: judged by its mtime */
  }
  if (pidAlive(Number(info.pid)) === false) return { body, stale: true };
  let age = Date.now() - Number(info.at);
  if (!Number.isFinite(age)) {
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      return null;
    }
  }
  return { body, stale: age > STALE_LOCK_MS };
}

// Breaks a lock judged stale while it held `body`. Renames it to a unique name first: of several waiters only one
// rename can succeed, and only that one returns true. If the renamed file is not the lock that was judged stale
// (a new holder took the lock in between), it is linked back and false is returned.
export function breakStaleLock(lock, body) {
  const aside = `${lock}.stale-${unique()}`;
  try {
    renameSync(lock, aside);
  } catch {
    return false; // another waiter broke it first, or it was released
  }
  let got = null;
  try {
    got = readFileSync(aside, 'utf8');
  } catch {
    /* treated as changed */
  }
  if (got !== body) {
    try {
      linkSync(aside, lock); // fails if yet another writer already holds the lock
    } catch {
      /* nothing safe left to do */
    }
    tryUnlink(aside);
    return false;
  }
  tryUnlink(aside);
  return true;
}

// Can a new file be created in dir? A probe that fails with EACCES/EPERM means the folder refuses writes.
function probeDir(dir) {
  const p = join(dir, `.run-state-probe-${unique()}`);
  closeSync(openSync(p, 'wx'));
  tryUnlink(p);
}
const folderRefuses = (probe, dir) => {
  try {
    probe(dir);
    return false;
  } catch (e) {
    return PERM_CODES.includes(e.code);
  }
};

// deps (tests): open (openSync-like), probe (dir -> throws when no file can be created), timeoutMs.
export function withLock(file, fn, { open = openSync, probe = probeDir, timeoutMs } = {}) {
  const lock = `${file}.lock`;
  const timeout = timeoutMs ?? (Number(process.env.RUN_STATE_LOCK_TIMEOUT_MS) || 5000);
  const deadline = Date.now() + timeout;
  let wait = 5;
  let permSince;
  let fd;
  for (;;) {
    try {
      fd = open(lock, 'wx');
      break;
    } catch (e) {
      if (PERM_CODES.includes(e.code)) {
        // Windows: a lock being deleted (delete pending) also fails with EPERM; wait that out like a held lock.
        if (folderRefuses(probe, dirname(lock))) {
          permSince ??= Date.now();
          if (Date.now() - permSince >= PERM_RETRY_MS)
            throw bad(`cannot create lock ${lock}: ${e.message}`);
        } else permSince = undefined;
      } else if (e.code === 'EEXIST') {
        permSince = undefined;
        const held = inspectLock(lock);
        if (held === null) continue; // released just now: try again at once
        if (held.stale && held.body !== null && breakStaleLock(lock, held.body)) continue;
      } else throw bad(`cannot create lock ${lock}: ${e.message}`);
    }
    if (Date.now() >= deadline) throw bad(`lock ${lock} still held after ${timeout}ms`);
    sleep(Math.min(wait, Math.max(1, deadline - Date.now())));
    wait = Math.min(wait * 2, 200);
  }
  const token = JSON.stringify({
    pid: process.pid,
    at: Date.now(),
    id: randomBytes(6).toString('hex'),
  });
  try {
    writeSync(fd, token);
    closeSync(fd);
    fd = undefined;
    return fn();
  } finally {
    if (fd !== undefined) closeSync(fd);
    // Remove only our own lock: if it was broken as stale meanwhile, the file now belongs to another writer.
    let body = null;
    try {
      body = readFileSync(lock, 'utf8');
    } catch {
      /* already gone */
    }
    if (body === token) tryUnlink(lock);
  }
}

export function readState(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    throw bad(
      e.code === 'ENOENT'
        ? `no state file at ${file}; run init first`
        : `cannot read ${file}: ${e.message}`,
    );
  }
  let s;
  try {
    s = JSON.parse(raw);
  } catch (e) {
    throw bad(`unreadable state file ${file}: ${e.message}`);
  }
  if (!s || typeof s !== 'object' || s.schema !== 1 || typeof s.run !== 'string')
    throw bad(`${file} is not a schema-1 run state`);
  return hydrate(s);
}

// Rebuilds every id-keyed map as a null-prototype object.
function hydrate(s) {
  s.phases = dict(s.phases);
  s.approvals = dict(s.approvals);
  s.models = dict(s.models);
  s.jobs = dict(s.jobs);
  for (const k of Object.keys(s.jobs)) s.jobs[k] = { ...s.jobs[k], items: dict(s.jobs[k]?.items) };
  s.spend ??= { estimateUsd: 0, actualUsd: 0 };
  return s;
}

export function writeState(file, state) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  // Windows can refuse a rename for a moment while another process has the target open; retry briefly.
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleep(10 * (i + 1));
    }
  }
}

export const newState = (run, capUsd = null) => ({
  schema: 1,
  run,
  createdAt: now(),
  phases: dict(),
  jobs: dict(),
  models: dict(),
  spend: { estimateUsd: 0, actualUsd: 0 },
  capUsd,
  approvals: dict(),
});

const okBees = (it) => new Set(it.results.filter((r) => r.status === 'ok').map((r) => r.bee));
const overCap = (s) =>
  s.capUsd !== null &&
  s.capUsd !== undefined &&
  (s.spend.estimateUsd > s.capUsd || s.spend.actualUsd > s.capUsd);

export function summary(s) {
  const done = PHASES.filter((p) => own(s.phases, p)?.status === 'done');
  const pendingItems = dict();
  const failedItems = dict();
  for (const [job, j] of Object.entries(s.jobs)) {
    for (const [item, it] of Object.entries(j.items)) {
      const have = okBees(it).size;
      if (have >= BEES_PER_ITEM) continue;
      entry(pendingItems, job, () => []).push({ item, missingBees: BEES_PER_ITEM - have });
      const failed = [...new Set(it.results.filter((r) => r.status === 'fail').map((r) => r.bee))];
      if (failed.length) entry(failedItems, job, () => []).push({ item, bees: failed });
    }
  }
  return {
    run: s.run,
    lastDonePhase: done.length ? done[done.length - 1] : null,
    nextPhase: PHASES.find((p) => own(s.phases, p)?.status !== 'done') ?? null,
    pendingItems,
    failedItems,
    droppedModels: Object.entries(s.models)
      .filter(([, m]) => m.dropped)
      .map(([model, m]) => ({ model, reason: m.reason })),
    spend: s.spend,
    capUsd: s.capUsd,
    overCap: overCap(s),
  };
}

export function check(s, job, calls, usd = 0) {
  const approved = own(s.approvals, job)?.calls;
  const capUsd = s.capUsd ?? null;
  const projectedEstimateUsd = round(s.spend.estimateUsd + usd);
  const out = {
    job,
    calls,
    approvedCalls: approved ?? null,
    maxCalls: approved === undefined ? null : round(approved * APPROVAL_SLACK),
    projectedEstimateUsd,
    actualUsd: s.spend.actualUsd,
    capUsd,
  };
  let reason;
  if (approved === undefined) reason = `no approval recorded for job ${job}`;
  else if (calls > out.maxCalls)
    reason = `${calls} calls exceed the approved ${approved} (+20% = ${out.maxCalls})`;
  else if (capUsd !== null && projectedEstimateUsd > capUsd)
    reason = `estimate $${projectedEstimateUsd} would exceed the cap $${capUsd}`;
  else if (capUsd !== null && s.spend.actualUsd > capUsd)
    reason = `actual spend $${s.spend.actualUsd} already exceeds the cap $${capUsd}`;
  return reason ? { ok: false, ...out, reason } : { ok: true, ...out };
}

// Applies one mutating command to a state object in place.
function mutate(s, cmd, a) {
  const [, x, y, z, w] = a._;
  switch (cmd) {
    case 'phase': {
      if (!PHASES.includes(x)) throw bad(`phase must be one of P0..P9, got ${x}`);
      if (y !== 'start' && y !== 'done') throw bad('phase needs start|done');
      const p = entry(s.phases, x, () => ({}));
      if (y === 'start') {
        if (p.status === 'done') {
          if (a.reopen === undefined || a.reopen === false)
            throw bad(`phase ${x} is already done; pass --reopen to start it again`);
          delete p.doneAt;
          p.reopenedAt = now();
        }
        Object.assign(p, { status: 'started', startedAt: now() });
      } else Object.assign(p, { status: 'done', doneAt: now() });
      return;
    }
    case 'cap':
      s.capUsd = num(a.usd, 'usd', { required: true });
      return;
    case 'approve': {
      const calls = num(a.calls, 'calls', { required: true });
      s.approvals[name(x, 'job')] = { calls, at: now() };
      return;
    }
    case 'plan': {
      const ids = text(a.items, 'items')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      if (!ids.length) throw bad('--items lists no ids');
      const j = entry(s.jobs, name(x, 'job'), () => ({ items: dict() }));
      for (const id of ids) entry(j.items, id, () => ({ status: 'pending', results: [] }));
      return;
    }
    case 'item': {
      const job = name(x, 'job');
      const id = name(y, 'itemId');
      const bee = name(z, 'bee');
      if (w !== 'ok' && w !== 'fail') throw bad('item needs ok|fail');
      const it = own(own(s.jobs, job)?.items, id);
      if (!it) throw bad(`item ${id} is not planned for job ${job}; run plan first`);
      const usd = num(a.usd, 'usd');
      const actual = num(a['actual-usd'], 'actual-usd');
      const r = { bee, status: w, at: now() };
      if (usd !== undefined) r.usd = usd;
      if (actual !== undefined) r.actualUsd = actual;
      if (a.note !== undefined) {
        if (typeof a.note !== 'string' || !a.note.trim())
          throw bad('--note needs a value (use --note=<text> when the text starts with --)');
        r.note = a.note;
      }
      it.results.push(r);
      it.status = okBees(it).size >= BEES_PER_ITEM ? 'done' : 'pending';
      s.spend.estimateUsd = round(s.spend.estimateUsd + (usd ?? 0));
      s.spend.actualUsd = round(s.spend.actualUsd + (actual ?? 0));
      return;
    }
    case 'canary': {
      const model = name(x, 'model');
      if (y !== 'pass' && y !== 'miss') throw bad('canary needs pass|miss');
      const m = entry(s.models, model, () => ({ canaryPass: 0, canaryMiss: 0 }));
      m.canaryPass ??= 0;
      m.canaryMiss ??= 0;
      if (y === 'pass') m.canaryPass++;
      else m.canaryMiss++;
      (m.canaries ??= []).push({
        result: y,
        ...(typeof a.job === 'string' ? { job: a.job } : {}),
        at: now(),
      });
      if (m.canaryMiss >= CANARY_MISSES_TO_DROP && !m.dropped)
        Object.assign(m, { dropped: true, reason: `missed ${CANARY_MISSES_TO_DROP} canaries` });
      return;
    }
    case 'drop': {
      const reason = text(a.reason, 'reason');
      Object.assign(
        entry(s.models, name(x, 'model'), () => ({})),
        {
          dropped: true,
          reason,
          droppedAt: now(),
        },
      );
      return;
    }
    default:
      throw bad(`unknown command ${cmd}`);
  }
}

export function runCommand(argv) {
  // --note=<text> is taken here, so a note that starts with -- is not read as a flag.
  let note;
  const rest = argv.filter((t) => {
    if (!t.startsWith('--note=')) return true;
    note = t.slice('--note='.length);
    return false;
  });
  const a = parseArgs(rest);
  if (note !== undefined) a.note = note;
  const cmd = a._[0];
  if (!cmd) throw bad('missing command');
  if (typeof a.file !== 'string' || !a.file.trim()) throw bad('--file <STATE.json> is required');
  const file = resolve(a.file);

  if (cmd === 'init') {
    const run = text(a.run, 'run');
    const cap = num(a['cap-usd'], 'cap-usd');
    mkdirSync(dirname(file), { recursive: true });
    return withLock(file, () => {
      if (existsSync(file)) {
        const s = readState(file);
        if (s.run !== run)
          throw bad(`${file} belongs to run ${s.run}, not ${run}; refusing to overwrite`);
        if (cap !== undefined && s.capUsd !== cap) {
          if (s.capUsd !== null && s.capUsd !== undefined)
            throw bad(
              `run ${run} already has a cap of $${s.capUsd}; use 'cap --usd ${cap}' to change it`,
            );
          s.capUsd = cap;
          writeState(file, s);
        }
        return { out: s };
      }
      const s = newState(run, cap ?? null);
      writeState(file, s);
      return { out: s };
    });
  }
  if (cmd === 'show' || cmd === 'resume')
    return withLock(file, () => ({ out: summary(readState(file)) }));
  if (cmd === 'check') {
    const job = name(a._[1], 'job');
    const calls = num(a.calls, 'calls', { required: true });
    const usd = num(a.usd, 'usd') ?? 0;
    return withLock(file, () => {
      const r = check(readState(file), job, calls, usd);
      return { out: r, code: r.ok ? 0 : 2 };
    });
  }
  return withLock(file, () => {
    const s = readState(file);
    mutate(s, cmd, a);
    writeState(file, s);
    return { out: s };
  });
}

if (isMain(import.meta.url)) {
  try {
    const { out, code = 0 } = runCommand(process.argv.slice(2));
    console.log(JSON.stringify(out, null, 2));
    if (code) {
      console.error(`run-state: ${out.reason}`);
      process.exit(code);
    }
  } catch (e) {
    console.error(`run-state: ${e.message}`);
    process.exit(e instanceof StateError ? e.code : 3);
  }
}
