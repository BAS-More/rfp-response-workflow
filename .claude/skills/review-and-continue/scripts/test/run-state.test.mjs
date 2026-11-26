// Run: node <skill>/scripts/run-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
  readdirSync,
  openSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(SKILL, 'scripts', 'run-state.mjs');

// A fresh STATE.json path inside a dir whose name contains a space, like the skill's own home.
// The dir is removed when the test ends.
const fresh = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rac state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'STATE.json');
};
// A pid that existed a moment ago and has exited.
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const runEnv = (file, env, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--file', file], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
};
const run = (file, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--file', file], { encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
};
const ok = (file, ...args) => {
  const r = run(file, ...args);
  assert.equal(r.code, 0, `${args.join(' ')} -> ${r.code}: ${r.stderr}`);
  return r.json;
};
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('init creates the documented shape and leaves no tmp or lock file behind', (t) => {
  const f = fresh(t);
  const s = ok(f, 'init', '--run', 'R1', '--cap-usd', '5');
  assert.equal(s.schema, 1);
  assert.equal(s.run, 'R1');
  assert.equal(typeof s.createdAt, 'string');
  assert.deepEqual(s.phases, {});
  assert.deepEqual(s.jobs, {});
  assert.deepEqual(s.models, {});
  assert.deepEqual(s.approvals, {});
  assert.deepEqual(s.spend, { estimateUsd: 0, actualUsd: 0 });
  assert.equal(s.capUsd, 5);
  assert.deepEqual(read(f), s);
  assert.equal(existsSync(`${f}.tmp`), false);
  assert.equal(existsSync(`${f}.lock`), false);
  assert.equal(ok(fresh(t), 'init', '--run', 'R2').capUsd, null);
});

test('init on an existing file: same run is kept as is, a different run is refused (exit 3) and not overwritten', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1');
  ok(f, 'phase', 'P0', 'done');
  const again = ok(f, 'init', '--run', 'R1');
  assert.equal(again.phases.P0.status, 'done');
  const before = readFileSync(f, 'utf8');
  const r = run(f, 'init', '--run', 'OTHER');
  assert.equal(r.code, 3);
  assert.match(r.stderr, /R1/);
  assert.equal(readFileSync(f, 'utf8'), before);
});

test('bad arguments and unreadable files exit 3', (t) => {
  const f = fresh(t);
  assert.equal(run(f, 'phase', 'P0', 'done').code, 3, 'no file yet');
  ok(f, 'init', '--run', 'R1');
  assert.equal(run(f, 'phase', 'P10', 'done').code, 3);
  assert.equal(run(f, 'phase', 'P1', 'maybe').code, 3);
  assert.equal(run(f, 'cap', '--usd', 'abc').code, 3);
  assert.equal(run(f, 'cap', '--usd', '-1').code, 3);
  assert.equal(run(f, 'approve', 'drift').code, 3);
  assert.equal(run(f, 'item', 'drift', 'a', 'glm', 'perhaps').code, 3);
  assert.equal(run(f, 'item', 'drift', 'nope', 'glm', 'ok').code, 3, 'item not planned');
  assert.equal(run(f, 'canary', 'glm', 'maybe').code, 3);
  assert.equal(run(f, 'drop', 'glm').code, 3, 'reason required');
  assert.equal(run(f, 'frobnicate').code, 3);
  const noFile = spawnSync(process.execPath, [SCRIPT, 'show'], { encoding: 'utf8' });
  assert.equal(noFile.status, 3);
  const bad = fresh(t);
  writeFileSync(bad, '{not json');
  assert.equal(run(bad, 'show').code, 3);
});

test('lifecycle: phases, plan, items and resume report what is left', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1', '--cap-usd', '10');
  ok(f, 'phase', 'P0', 'start');
  ok(f, 'phase', 'P0', 'done');
  ok(f, 'phase', 'P1', 'done');
  ok(f, 'phase', 'P2', 'start');
  ok(f, 'plan', 'drift', '--items', 'a,b,c');
  ok(f, 'item', 'drift', 'a', 'glm', 'ok', '--usd', '0.5', '--actual-usd', '0.25');
  ok(f, 'item', 'drift', 'a', 'kimi', 'ok', '--usd', '0.5');
  ok(f, 'item', 'drift', 'b', 'glm', 'fail', '--note', 'timeout');
  const r = ok(f, 'resume');
  assert.equal(r.run, 'R1');
  assert.equal(r.lastDonePhase, 'P1');
  assert.equal(r.nextPhase, 'P2');
  assert.deepEqual(r.pendingItems, {
    drift: [
      { item: 'b', missingBees: 2 },
      { item: 'c', missingBees: 2 },
    ],
  });
  assert.deepEqual(r.failedItems, { drift: [{ item: 'b', bees: ['glm'] }] });
  assert.deepEqual(r.droppedModels, []);
  assert.equal(r.spend.estimateUsd, 1);
  assert.equal(r.spend.actualUsd, 0.25);
  assert.equal(r.capUsd, 10);
  assert.equal(r.overCap, false);
  assert.deepEqual(ok(f, 'show'), r);
  const st = read(f);
  assert.equal(st.phases.P0.status, 'done');
  assert.equal(typeof st.phases.P0.startedAt, 'string');
  assert.equal(typeof st.phases.P0.doneAt, 'string');
  assert.equal(st.jobs.drift.items.b.results[0].note, 'timeout');
});

test('a fresh run resumes at P0 with nothing done', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1');
  const r = ok(f, 'show');
  assert.equal(r.lastDonePhase, null);
  assert.equal(r.nextPhase, 'P0');
  assert.equal(r.overCap, false);
});

test('plan is idempotent and never resets recorded results', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1');
  ok(f, 'plan', 'drift', '--items', 'a,b');
  ok(f, 'item', 'drift', 'a', 'glm', 'ok');
  ok(f, 'plan', 'drift', '--items', 'a, b ,c');
  const items = read(f).jobs.drift.items;
  assert.deepEqual(Object.keys(items).sort(), ['a', 'b', 'c']);
  assert.equal(items.a.results.length, 1);
  assert.equal(items.c.status, 'pending');
});

test('an item stays pending until 2 ok results from distinct bees', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1');
  ok(f, 'plan', 'graph', '--items', 'x');
  ok(f, 'item', 'graph', 'x', 'glm', 'ok');
  assert.deepEqual(ok(f, 'show').pendingItems, { graph: [{ item: 'x', missingBees: 1 }] });
  ok(f, 'item', 'graph', 'x', 'glm', 'ok');
  assert.deepEqual(
    ok(f, 'show').pendingItems,
    { graph: [{ item: 'x', missingBees: 1 }] },
    'same bee twice',
  );
  ok(f, 'item', 'graph', 'x', 'kimi', 'fail');
  assert.deepEqual(
    ok(f, 'show').pendingItems,
    { graph: [{ item: 'x', missingBees: 1 }] },
    'fail is not ok',
  );
  ok(f, 'item', 'graph', 'x', 'mimo', 'ok');
  const r = ok(f, 'show');
  assert.deepEqual(r.pendingItems, {});
  assert.deepEqual(r.failedItems, {}, 'a done item is not listed as failed');
  assert.equal(read(f).jobs.graph.items.x.status, 'done');
});

test('canary: one miss is counted, the second miss drops the model; drop records a reason', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1');
  ok(f, 'canary', 'glm', 'pass', '--job', 'drift');
  ok(f, 'canary', 'glm', 'miss', '--job', 'drift');
  let m = read(f).models.glm;
  assert.equal(m.canaryPass, 1);
  assert.equal(m.canaryMiss, 1);
  assert.notEqual(m.dropped, true);
  assert.deepEqual(ok(f, 'show').droppedModels, []);
  ok(f, 'canary', 'glm', 'miss', '--job', 'graph');
  m = read(f).models.glm;
  assert.equal(m.canaryMiss, 2);
  assert.equal(m.dropped, true);
  assert.equal(m.reason, 'missed 2 canaries');
  ok(f, 'drop', 'kimi', '--reason', 'price spike');
  assert.equal(read(f).models.kimi.reason, 'price spike');
  assert.deepEqual(
    ok(f, 'show')
      .droppedModels.map((d) => d.model)
      .sort(),
    ['glm', 'kimi'],
  );
});

test('check: calls within approval +20% pass, one more fails with exit 2; no approval fails', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1');
  let r = run(f, 'check', 'drift', '--calls', '1');
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /approv/i);
  ok(f, 'approve', 'drift', '--calls', '10');
  assert.equal(read(f).approvals.drift.calls, 10);
  assert.equal(run(f, 'check', 'drift', '--calls', '12').code, 0);
  r = run(f, 'check', 'drift', '--calls', '13');
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.approvedCalls, 10);
  assert.equal(run(f, 'check', 'graph', '--calls', '1').code, 2, 'approval is per job');
});

test('check: estimate or actual spend over the cap fails with exit 2 and show reports overCap', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1', '--cap-usd', '1');
  ok(f, 'approve', 'drift', '--calls', '100');
  ok(f, 'plan', 'drift', '--items', 'a');
  ok(f, 'item', 'drift', 'a', 'glm', 'ok', '--usd', '0.6');
  assert.equal(run(f, 'check', 'drift', '--calls', '1', '--usd', '0.4').code, 0, 'exactly at cap');
  let r = run(f, 'check', 'drift', '--calls', '1', '--usd', '0.5');
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /cap/i);
  assert.equal(ok(f, 'show').overCap, false);
  ok(f, 'item', 'drift', 'a', 'kimi', 'ok', '--usd', '0.1', '--actual-usd', '1.5');
  r = run(f, 'check', 'drift', '--calls', '1');
  assert.equal(r.code, 2, 'actual spend alone over the cap');
  assert.equal(ok(f, 'show').overCap, true);
  ok(f, 'cap', '--usd', '5');
  assert.equal(run(f, 'check', 'drift', '--calls', '1', '--usd', '1').code, 0, 'raised cap');
  const nocap = fresh(t);
  ok(nocap, 'init', '--run', 'R2');
  ok(nocap, 'approve', 'drift', '--calls', '1');
  assert.equal(run(nocap, 'check', 'drift', '--calls', '1', '--usd', '999').code, 0, 'no cap set');
});

test('concurrent writers: 8 processes recording items at once all land', async (t) => {
  const f = fresh(t);
  const ids = Array.from({ length: 8 }, (_, i) => `i${i}`);
  ok(f, 'init', '--run', 'R1');
  ok(f, 'plan', 'drift', '--items', ids.join(','));
  const one = (id) =>
    new Promise((res) => {
      const p = spawn(
        process.execPath,
        [SCRIPT, 'item', 'drift', id, 'glm', 'ok', '--usd', '0.125', '--file', f],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => res({ code, err }));
    });
  const results = await Promise.all(ids.map(one));
  for (const r of results) assert.equal(r.code, 0, r.err);
  const st = read(f);
  for (const id of ids) assert.equal(st.jobs.drift.items[id].results.length, 1, id);
  assert.equal(st.spend.estimateUsd, 1);
  assert.equal(existsSync(`${f}.lock`), false);
});

test('a stale lock older than 30s is broken; a fresh one held by another writer times out with exit 3', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1');
  writeFileSync(`${f}.lock`, JSON.stringify({ pid: 0, at: Date.now() - 60_000 }));
  ok(f, 'phase', 'P0', 'done');
  assert.equal(existsSync(`${f}.lock`), false);
  writeFileSync(`${f}.lock`, JSON.stringify({ pid: 0, at: Date.now() }));
  const r = spawnSync(process.execPath, [SCRIPT, 'phase', 'P1', 'done', '--file', f], {
    encoding: 'utf8',
    env: { ...process.env, RUN_STATE_LOCK_TIMEOUT_MS: '300' },
  });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /lock/i);
  assert.equal(read(f).phases.P1, undefined);
});

const PROTO_IDS = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];

test('prototype-named ids work as job, item and model ids in every command', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1', '--cap-usd', '100');
  for (const id of PROTO_IDS) {
    const c = run(f, 'check', id, '--calls', '1');
    assert.equal(c.code, 2, `check ${id} before approve`);
    assert.match(c.json.reason, /no approval/);
    assert.equal(c.json.approvedCalls, null, id);
    const miss = run(f, 'item', id, id, 'glm', 'ok');
    assert.equal(miss.code, 3, `item ${id} before plan`);
    assert.match(miss.stderr, /not planned/, id);
  }
  for (const id of PROTO_IDS) {
    ok(f, 'approve', id, '--calls', '3');
    assert.equal(ok(f, 'check', id, '--calls', '3').approvedCalls, 3, id);
    ok(f, 'plan', id, '--items', PROTO_IDS.join(','));
    ok(f, 'plan', id, '--items', PROTO_IDS.join(','));
    for (const item of PROTO_IDS) {
      ok(f, 'item', id, item, 'glm', 'ok', '--usd', '0.25');
      if (item !== 'hasOwnProperty') ok(f, 'item', id, item, 'kimi', 'ok');
    }
    ok(f, 'canary', id, 'miss', '--job', id);
    ok(f, 'canary', id, 'pass');
    ok(f, 'drop', id, '--reason', `drop ${id}`);
  }
  const st = read(f);
  for (const id of PROTO_IDS) {
    assert.ok(Object.hasOwn(st.approvals, id), `approval ${id}`);
    assert.equal(st.approvals[id].calls, 3);
    assert.ok(Object.hasOwn(st.jobs, id), `job ${id}`);
    assert.deepEqual(Object.keys(st.jobs[id].items).sort(), [...PROTO_IDS].sort());
    for (const item of PROTO_IDS) {
      assert.ok(Object.hasOwn(st.jobs[id].items, item), `${id}/${item}`);
      assert.equal(st.jobs[id].items[item].results.length, item === 'hasOwnProperty' ? 1 : 2);
    }
    assert.ok(Object.hasOwn(st.models, id), `model ${id}`);
    assert.equal(st.models[id].canaryMiss, 1);
    assert.equal(st.models[id].canaryPass, 1);
    assert.equal(st.models[id].reason, `drop ${id}`);
  }
  const r = ok(f, 'show');
  assert.equal(r.spend.estimateUsd, 4);
  for (const id of PROTO_IDS) {
    assert.ok(Object.hasOwn(r.pendingItems, id), `pending ${id}`);
    assert.deepEqual(r.pendingItems[id], [{ item: 'hasOwnProperty', missingBees: 1 }]);
  }
  assert.deepEqual(r.droppedModels.map((d) => d.model).sort(), [...PROTO_IDS].sort());
  assert.deepEqual(r.failedItems, {});
});

test('a lock whose pid is dead is broken at once, even if it is fresh', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1');
  writeFileSync(`${f}.lock`, JSON.stringify({ pid: deadPid(), at: Date.now() }));
  const r = runEnv(f, { RUN_STATE_LOCK_TIMEOUT_MS: '2000' }, 'phase', 'P0', 'done');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(read(f).phases.P0.status, 'done');
  assert.equal(existsSync(`${f}.lock`), false);
  assert.deepEqual(
    readdirSync(dirname(f)).filter((n) => n !== 'STATE.json'),
    [],
    'the broken lock leaves no renamed file behind',
  );
});

test('a lock held by a live pid is respected until it is older than 30s', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1');
  writeFileSync(`${f}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const r = runEnv(f, { RUN_STATE_LOCK_TIMEOUT_MS: '300' }, 'phase', 'P0', 'done');
  assert.equal(r.code, 3);
  assert.match(r.stderr, /still held/);
  writeFileSync(`${f}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
  assert.equal(runEnv(f, { RUN_STATE_LOCK_TIMEOUT_MS: '2000' }, 'phase', 'P0', 'done').code, 0);
});

test('breakStaleLock: of two waiters on one stale lock only the first rename wins', async (t) => {
  const { breakStaleLock } = await import(pathToFileURL(SCRIPT).href);
  const f = fresh(t);
  const lock = `${f}.lock`;
  const body = JSON.stringify({ pid: deadPid(), at: Date.now() - 60_000 });
  writeFileSync(lock, body);
  assert.equal(breakStaleLock(lock, body), true, 'first waiter breaks it');
  assert.equal(breakStaleLock(lock, body), false, 'second waiter finds nothing to break');
  // The second waiter judged the old lock stale, but a new holder took the lock in between:
  // it must not steal the new holder's lock.
  const held = JSON.stringify({ pid: process.pid, at: Date.now() });
  writeFileSync(lock, held);
  assert.equal(
    breakStaleLock(lock, body),
    false,
    'a lock that changed since it was judged stale is kept',
  );
  assert.equal(readFileSync(lock, 'utf8'), held);
  assert.deepEqual(readdirSync(dirname(f)), ['STATE.json.lock'], 'no renamed files left');
});

test('many waiters on one stale lock all get the lock in turn and every write lands', async (t) => {
  const f = fresh(t);
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  ok(f, 'init', '--run', 'R1');
  ok(f, 'plan', 'drift', '--items', ids.join(','));
  for (const at of [Date.now() - 60_000, Date.now()]) {
    writeFileSync(`${f}.lock`, JSON.stringify({ pid: deadPid(), at }));
    const one = (id) =>
      new Promise((res) => {
        const p = spawn(
          process.execPath,
          [SCRIPT, 'item', 'drift', id, `bee${at}`, 'ok', '--usd', '0.5', '--file', f],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let err = '';
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => res({ code, err }));
      });
    const results = await Promise.all(ids.map(one));
    for (const r of results) assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(`${f}.lock`), false);
  }
  const st = read(f);
  for (const id of ids) assert.equal(st.jobs.drift.items[id].results.length, 2, id);
  assert.equal(st.spend.estimateUsd, 6);
  assert.deepEqual(readdirSync(dirname(f)), ['STATE.json']);
});

test('withLock: a real permission error fails with that error after a short retry, not "still held"', async (t) => {
  const { withLock } = await import(pathToFileURL(SCRIPT).href);
  const f = fresh(t);
  for (const code of ['EACCES', 'EPERM']) {
    const denied = () => {
      const e = new Error(`${code}: permission denied, open '${f}.lock'`);
      e.code = code;
      throw e;
    };
    const started = Date.now();
    let calls = 0;
    assert.throws(
      () =>
        withLock(f, () => assert.fail('must not run'), {
          open: () => {
            calls++;
            denied();
          },
          probe: denied,
          timeoutMs: 5000,
        }),
      (e) => {
        assert.match(e.message, new RegExp(code));
        assert.doesNotMatch(e.message, /still held/);
        assert.equal(e.code, 3);
        return true;
      },
    );
    assert.ok(calls > 1, 'retried at least once');
    assert.ok(Date.now() - started < 3000, `failed fast (${Date.now() - started}ms)`);
  }
});

test('withLock: a delete-pending lock (EPERM while the folder is writable) is waited out', async (t) => {
  const { withLock } = await import(pathToFileURL(SCRIPT).href);
  const f = fresh(t);
  let calls = 0;
  const out = withLock(f, () => 'ran', {
    open: (p, flags) => {
      if (++calls <= 3) {
        const e = new Error('EPERM: operation not permitted');
        e.code = 'EPERM';
        throw e;
      }
      return openSync(p, flags);
    },
    probe: () => {},
    timeoutMs: 5000,
  });
  assert.equal(out, 'ran');
  assert.equal(calls, 4);
  assert.equal(existsSync(`${f}.lock`), false);
});

test(
  'a read-only folder fails with the permission error, not "lock still held"',
  {
    skip:
      process.platform === 'win32' || process.getuid?.() === 0
        ? 'needs POSIX permissions, non-root'
        : false,
  },
  (t) => {
    const f = fresh(t);
    ok(f, 'init', '--run', 'R1');
    chmodSync(dirname(f), 0o555);
    t.after(() => chmodSync(dirname(f), 0o755));
    const r = runEnv(f, { RUN_STATE_LOCK_TIMEOUT_MS: '5000' }, 'phase', 'P0', 'done');
    assert.equal(r.code, 3);
    assert.match(r.stderr, /EACCES|EPERM/);
    assert.doesNotMatch(r.stderr, /still held/);
  },
);

test('init on an existing run with --cap-usd: sets a missing cap, refuses to change one (exit 3, use cap)', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1');
  ok(f, 'phase', 'P0', 'done');
  const s = ok(f, 'init', '--run', 'R1', '--cap-usd', '7');
  assert.equal(s.capUsd, 7);
  assert.equal(s.phases.P0.status, 'done', 'the rest of the state is kept');
  assert.equal(read(f).capUsd, 7);
  assert.equal(
    ok(f, 'init', '--run', 'R1', '--cap-usd', '7').capUsd,
    7,
    'same cap again is a no-op',
  );
  const before = readFileSync(f, 'utf8');
  const r = run(f, 'init', '--run', 'R1', '--cap-usd', '9');
  assert.equal(r.code, 3);
  assert.match(r.stderr, /\bcap --usd\b/);
  assert.equal(readFileSync(f, 'utf8'), before);
  assert.equal(ok(f, 'init', '--run', 'R1').capUsd, 7, 'init without --cap-usd leaves the cap');
});

test('phase start after done is refused (exit 3) unless --reopen', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1');
  ok(f, 'phase', 'P0', 'start');
  ok(f, 'phase', 'P0', 'start');
  ok(f, 'phase', 'P0', 'done');
  const before = readFileSync(f, 'utf8');
  const r = run(f, 'phase', 'P0', 'start');
  assert.equal(r.code, 3);
  assert.match(r.stderr, /--reopen/);
  assert.equal(readFileSync(f, 'utf8'), before);
  assert.equal(ok(f, 'show').lastDonePhase, 'P0');
  const s = ok(f, 'phase', 'P0', 'start', '--reopen');
  assert.equal(s.phases.P0.status, 'started');
  assert.equal(typeof s.phases.P0.reopenedAt, 'string');
  assert.equal(ok(f, 'show').nextPhase, 'P0');
});

test('--note=<text> carries a note that starts with --', (t) => {
  const f = fresh(t);
  ok(f, 'init', '--run', 'R1');
  ok(f, 'plan', 'drift', '--items', 'a');
  ok(f, 'item', 'drift', 'a', 'glm', 'fail', '--note=--timeout after 30s', '--usd', '0.5');
  ok(f, 'item', 'drift', 'a', 'kimi', 'fail', '--note=a=b --c');
  const res = read(f).jobs.drift.items.a.results;
  assert.equal(res[0].note, '--timeout after 30s');
  assert.equal(res[0].usd, 0.5);
  assert.equal(res[1].note, 'a=b --c');
  const bare = run(f, 'item', 'drift', 'a', 'glm', 'fail', '--note', '--x');
  assert.equal(bare.code, 3);
  assert.match(bare.stderr, /--note=/);
  assert.equal(run(f, 'item', 'drift', 'a', 'glm', 'fail', '--note=').code, 3);
});
