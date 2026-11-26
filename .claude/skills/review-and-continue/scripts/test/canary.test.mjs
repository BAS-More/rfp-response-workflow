// Run: node <skill>/scripts/run-tests.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOBS, makeCanary, gradeAnswer, parseClaims } from '../canary.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(SKILL, 'scripts', 'canary.mjs');

// A temp dir whose path contains a space, like the skill's own home under "C:/Users/Avi Bendetsky".
// Every temp dir is recorded and removed once the file's tests finish.
const TEMPS = [];
after(() => {
  for (const d of TEMPS) rmSync(d, { recursive: true, force: true });
});
const tmp = (p = 'rac canary-') => {
  const d = mkdtempSync(join(tmpdir(), p));
  TEMPS.push(d);
  return d;
};
const tmpFile = (name, body) => {
  const f = join(tmp(), name);
  writeFileSync(f, body);
  return f;
};
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const itemText = (itemPath) =>
  (statSync(itemPath).isDirectory() ? walk(itemPath) : [itemPath])
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

// Answers a perfect bee would give, built from the facts the key records.
// everything: ONE line that flags the defect and the true claim together (must fail as a false positive).
// crossMention: correct lines whose text merely mentions the true claim (must still pass).
const ANSWERS = {
  drift: (f) => ({
    defect: `CLAIM | DEAD-REF | npm run ${f.missingScript} | README documents a script package.json does not define`,
    rest: [`CLAIM | command | npm run ${f.realScript} | defined in package.json`],
    falsePositive: `CLAIM | CODE-MISSING | src/${f.file}.js:${f.fn} | ${f.fn} is not defined`,
    everything: `CLAIM | dead-ref | npm run ${f.missingScript}, npm run ${f.realScript}, ${f.fn} | none of these exist`,
    crossMention: [
      `CLAIM | dead-ref | npm run ${f.missingScript} | listed next to npm run ${f.realScript} and ${f.fn}, which do exist`,
      `CLAIM | command | npm run ${f.realScript} | defined in package.json`,
    ],
  }),
  inventory: (f) => ({
    defect: `CLAIM | promised | npm run ${f.missingScript} | README documents it, package.json lacks it`,
    rest: [`CLAIM | command | npm run ${f.realScript} | runs the ${f.realScript} script`],
    falsePositive: `CLAIM | DEAD-REF | ${f.fn} | README names ${f.fn} but src/${f.file}.js lacks it`,
    everything: `CLAIM | dead-ref | npm run ${f.missingScript}, npm run ${f.realScript}, ${f.fn} | none of these exist`,
    crossMention: [
      `CLAIM | promised | npm run ${f.missingScript} | promised beside npm run ${f.realScript}; only that one and ${f.fn} exist`,
      `CLAIM | command | npm run ${f.realScript} | runs the ${f.realScript} script`,
    ],
  }),
  digest: (f) => ({
    defect: `CLAIM | unfinished | ${f.other} | the assistant said ${f.other} was not done`,
    rest: [`CLAIM | done | src/${f.file}.js:${f.symbol} | added ${f.symbol}`],
    falsePositive: `CLAIM | unfinished | ${f.symbol} | ${f.symbol} still to do`,
    everything: `CLAIM | unfinished | ${f.other}, ${f.symbol} | both still open`,
    crossMention: [
      `CLAIM | done | ${f.symbol} | added; ${f.other} was not`,
      `CLAIM | unfinished | ${f.other} | not started, unlike ${f.symbol}`,
    ],
  }),
  graph: (f) => ({
    defect: `CLAIM | mismatch | ${f.missing} | named in docs, absent from the graph`,
    rest: [`CLAIM | orphan | ${f.orphan} | 0 callers`],
    falsePositive: `CLAIM | orphan | ${f.hub} | looks unused`,
    everything: `CLAIM | orphan | ${f.orphan}, ${f.hub} | both unused`,
    crossMention: [
      `CLAIM | orphan | ${f.orphan} | 0 callers, unlike ${f.hub}`,
      `CLAIM | mismatch | ${f.missing} | docs name it beside ${f.documentedPresent}, which the graph has`,
    ],
  }),
  review: (f) => ({
    defect: `CLAIM | error | ${f.defectTask} | ${f.defectNote}`,
    rest: [`CLAIM | decided | Summary | this release ships CSV only; XLSX is out of scope`],
    falsePositive: `CLAIM | risk | ${f.cleanTask} | under-specified`,
    everything: `CLAIM | error | ${f.defectTask}, ${f.cleanTask} | both broken`,
    crossMention: [`CLAIM | error | ${f.defectTask} | ${f.defectNote}; ${f.cleanTask} is fine`],
  }),
};

const made = new Map();
function make(job, seed) {
  const key = `${job}:${seed}`;
  if (!made.has(key)) made.set(key, makeCanary(job, { seed, out: tmp() }));
  return made.get(key);
}
const keyOf = (m) => JSON.parse(readFileSync(m.expectedPath, 'utf8'));

test('JOBS lists exactly the five hive jobs', () => {
  assert.deepEqual([...JOBS].sort(), ['digest', 'drift', 'graph', 'inventory', 'review']);
});

for (const job of ['inventory', 'drift', 'graph', 'digest', 'review']) {
  test(`${job}: two seeds give different names; the same seed gives the same canary`, () => {
    const a = keyOf(make(job, 'alpha-1'));
    const b = keyOf(make(job, 'bravo-2'));
    assert.notDeepEqual(a.facts, b.facts);
    const again = makeCanary(job, { seed: 'alpha-1', out: tmp() });
    assert.deepEqual(keyOf(again).facts, a.facts);
    assert.equal(itemText(again.itemPath), itemText(make(job, 'alpha-1').itemPath));
  });

  test(`${job}: the key is outside the item and the item never gives the game away`, () => {
    const m = make(job, 'alpha-1');
    const rel = relative(resolve(m.itemPath), resolve(m.expectedPath));
    assert.ok(rel.startsWith('..') || isAbsolute(rel), `expected.json inside item: ${rel}`);
    assert.ok(existsSync(m.expectedPath));
    const text = itemText(m.itemPath);
    assert.doesNotMatch(text, /canary|planted|expected\.json|known answer/i);
    assert.ok(text.length > 1200, `item is too thin to be realistic (${text.length} chars)`);
    const key = keyOf(m);
    assert.equal(key.job, job);
    assert.ok(key.expect.length >= 1 && key.forbid.length >= 1, 'needs a defect AND a true claim');
  });

  for (const seed of ['alpha-1', 'bravo-2']) {
    test(`${job} seed ${seed}: correct answer passes, missing defect fails, flagged truth fails, junk fails`, () => {
      const m = make(job, seed);
      const key = keyOf(m);
      const a = ANSWERS[job](key.facts);
      const good = ['Here are my findings.', a.defect, ...a.rest, 'Done.'].join('\n');

      const ok = gradeAnswer(key, good);
      assert.equal(ok.pass, true, JSON.stringify(ok, null, 1));
      assert.equal(ok.missed.length, 0);
      assert.equal(ok.falsePositives.length, 0);
      assert.ok(ok.found.length >= 1);

      // A real answer that misses the defect, never an empty string.
      assert.ok(a.rest.length >= 1, 'missing-defect answer must be a real answer');
      const missing = gradeAnswer(key, a.rest.join('\n'));
      assert.equal(missing.pass, false);
      assert.ok(missing.missed.length >= 1);

      const fp = gradeAnswer(key, [good, a.falsePositive].join('\n'));
      assert.equal(fp.pass, false);
      assert.equal(fp.missed.length, 0);
      assert.equal(fp.falsePositives.length, 1);

      const junk = gradeAnswer(key, 'I looked at everything and it all seems fine to me!\n42');
      assert.equal(junk.pass, false);
      assert.ok(junk.missed.length >= 1);
    });

    test(`${job} seed ${seed}: one line flagging the defect AND the true claim is a false positive`, () => {
      const key = keyOf(make(job, seed));
      const a = ANSWERS[job](key.facts);
      const r = gradeAnswer(key, [a.everything, ...a.rest].join('\n'));
      assert.ok(r.found.length >= 1, `the line should satisfy the defect: ${JSON.stringify(r)}`);
      assert.equal(r.pass, false, JSON.stringify(r, null, 1));
      assert.ok(r.falsePositives.length >= 1);
    });

    test(`${job} seed ${seed}: correct claims that merely mention the true claim in text are not false positives`, () => {
      const key = keyOf(make(job, seed));
      const a = ANSWERS[job](key.facts);
      const r = gradeAnswer(key, a.crossMention.join('\n'));
      assert.equal(r.pass, true, JSON.stringify(r, null, 1));
      assert.equal(r.falsePositives.length, 0);
    });
  }
}

for (const job of ['inventory', 'drift']) {
  test(`${job}: a command claim presenting the missing script as runnable is a false positive`, () => {
    const key = keyOf(make(job, 'alpha-1'));
    const f = key.facts;
    const a = ANSWERS[job](f);
    const r = gradeAnswer(
      key,
      [
        a.defect,
        ...a.rest,
        `CLAIM | command | npm run ${f.missingScript} | clears stale data`,
      ].join('\n'),
    );
    assert.equal(r.pass, false, JSON.stringify(r, null, 1));
    assert.equal(r.falsePositives.length, 1);
  });
}

test('drift/inventory fixture has no unplanned defect: every package.json script target exists and runs', () => {
  for (const job of ['drift', 'inventory']) {
    const m = make(job, 'alpha-1');
    const f = keyOf(m).facts;
    const pkg = JSON.parse(readFileSync(join(m.itemPath, 'package.json'), 'utf8'));
    const readme = readFileSync(join(m.itemPath, 'README.md'), 'utf8');
    // Only the planted script may be documented without being defined.
    const documented = [...readme.matchAll(/npm (?:run )?([\w:-]+)/g)].map((x) => x[1]);
    for (const s of documented) {
      if (s === f.missingScript || s === 'install' || s === 'start' || s === 'test') continue;
      assert.ok(pkg.scripts[s], `README documents "npm run ${s}" but package.json lacks it`);
    }
    assert.ok(
      !pkg.devDependencies && !pkg.dependencies,
      'no dependency the fixture never installs',
    );
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      assert.match(cmd, /^node /, `script ${name} needs a tool the fixture lacks: ${cmd}`);
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const t = spawnSync(process.execPath, ['--test'], { cwd: m.itemPath, encoding: 'utf8', env });
    assert.equal(t.status, 0, `npm test fails in the fixture:\n${t.stdout}\n${t.stderr}`);
    assert.match(t.stdout, /(#|ℹ) pass [1-9]/);
    assert.match(t.stdout, /(#|ℹ) fail 0/);
    const flag = `--${f.realScript.replace(':', '-')}`;
    const s = spawnSync(process.execPath, ['src/index.js', flag], {
      cwd: m.itemPath,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(s.status, 0, s.stderr);
  }
});

test('review: an answer whose ref holds only the related task id is accepted (forward-dependency)', () => {
  let checked = 0;
  for (let i = 0; i < 12 && checked < 2; i++) {
    const key = keyOf(makeCanary('review', { seed: `rel${i}`, out: tmp() }));
    const f = key.facts;
    if (f.variant !== 'forward-dependency') continue;
    const r = gradeAnswer(
      key,
      `CLAIM | error | ${f.relatedTask} | is depended on by an earlier task`,
    );
    assert.equal(r.pass, true, JSON.stringify(r, null, 1));
    checked++;
  }
  assert.ok(checked >= 1, 'no forward-dependency seed found');
});

test('drift/inventory fixture: the missing script is in README only, the true function really exists', () => {
  for (const job of ['drift', 'inventory']) {
    const m = make(job, 'bravo-2');
    const f = keyOf(m).facts;
    const readme = readFileSync(join(m.itemPath, 'README.md'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(m.itemPath, 'package.json'), 'utf8'));
    assert.match(readme, new RegExp(`npm run ${f.missingScript}\\b`));
    assert.match(readme, new RegExp(`npm run ${f.realScript}\\b`));
    assert.equal(pkg.scripts[f.missingScript], undefined);
    assert.ok(pkg.scripts[f.realScript]);
    assert.match(readme, new RegExp(`src/${f.file}\\.js`));
    const src = readFileSync(join(m.itemPath, 'src', `${f.file}.js`), 'utf8');
    assert.match(src, new RegExp(`function ${f.fn}\\(`));
    assert.ok(readdirSync(join(m.itemPath, 'src')).filter((x) => x.endsWith('.js')).length >= 3);
    assert.ok(readdirSync(join(m.itemPath, 'docs')).length >= 1);
  }
});

test('graph slice: orphan has 0 callers, hub is well connected, the doc-named symbol is absent', () => {
  const m = make('graph', 'alpha-1');
  const f = keyOf(m).facts;
  const slice = readFileSync(m.itemPath, 'utf8');
  assert.match(slice, new RegExp(`\\b${f.orphan}\\b[^\\n]*\\|\\s*0\\s*\\|`));
  const hubRow = slice
    .split('\n')
    .find((l) => new RegExp(`\\b${f.hub}\\b`).test(l) && l.includes('|'));
  assert.ok(Number(hubRow.split('|').at(-2).trim()) >= 5, hubRow);
  const tableRows = slice.split('\n').filter((l) => l.startsWith('|'));
  assert.ok(!tableRows.some((l) => new RegExp(`\\b${f.missing}\\b`).test(l)));
  assert.match(slice, new RegExp(`\\b${f.missing}\\b`), 'docs section names it');
});

test('digest transcript holds the request, the done claim and the unfinished item', () => {
  const m = make('digest', 'alpha-1');
  const f = keyOf(m).facts;
  const s = readFileSync(m.itemPath, 'utf8');
  assert.match(s, /## User/);
  assert.match(s, /## Assistant/);
  assert.match(s, new RegExp(`${f.symbol}`));
  assert.match(s, new RegExp(`${f.other}`));
});

test('review: both defect variants occur across seeds and each names its task', () => {
  const variants = new Set();
  for (let i = 0; i < 12; i++) {
    const m = makeCanary('review', { seed: `v${i}`, out: tmp() });
    const f = keyOf(m).facts;
    variants.add(f.variant);
    const art = readFileSync(m.itemPath, 'utf8');
    assert.match(art, new RegExp(f.defectTask));
    assert.match(art, new RegExp(f.cleanTask));
    assert.notEqual(f.defectTask, f.cleanTask);
  }
  assert.deepEqual([...variants].sort(), ['contradiction', 'forward-dependency']);
});

test('parseClaims is case-insensitive on kinds, tolerant of spaces, and ignores other lines', () => {
  const claims = parseClaims(
    [
      'preamble',
      '  claim|dead-ref|  npm run x  |   text with | a pipe  ',
      'CLAIM | Orphan | foo | bar',
      'CLAIM | nonsense-kind | foo | bar',
      'CLAIM | done',
      'not a CLAIM | done | a | b',
    ].join('\r\n'),
  );
  assert.deepEqual(claims, [
    { kind: 'dead-ref', ref: 'npm run x', text: 'text with | a pipe' },
    { kind: 'orphan', ref: 'foo', text: 'bar' },
  ]);
});

test('parseClaims tolerates a leading list marker and surrounding backticks', () => {
  const claims = parseClaims(
    [
      '- CLAIM | done | a | b',
      '* CLAIM | done | c | d',
      '1. CLAIM | done | e | f',
      '`CLAIM | orphan | g | h`',
      '- `CLAIM | orphan | i | uses `x` inside`',
      '  12) ``CLAIM | error | j | k``',
    ].join('\n'),
  );
  assert.deepEqual(claims, [
    { kind: 'done', ref: 'a', text: 'b' },
    { kind: 'done', ref: 'c', text: 'd' },
    { kind: 'done', ref: 'e', text: 'f' },
    { kind: 'orphan', ref: 'g', text: 'h' },
    { kind: 'orphan', ref: 'i', text: 'uses `x` inside' },
    { kind: 'error', ref: 'j', text: 'k' },
  ]);
});

test('grading uses whole-name matching, so a longer name containing the needle does not count', () => {
  const key = keyOf(make('graph', 'alpha-1'));
  const f = key.facts;
  const r = gradeAnswer(
    key,
    [`CLAIM | orphan | ${f.orphan}Legacy | x`, `CLAIM | mismatch | ${f.missing} | y`].join('\n'),
  );
  assert.equal(r.pass, false);
  assert.equal(r.missed.length, 1);
});

test('CLI make prints {job, itemPath, expectedPath} and writes item/ and expected.json under --out', () => {
  const out = tmp();
  const r = run('make', 'drift', '--seed', 's 1', '--out', out);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.job, 'drift');
  assert.equal(resolve(j.itemPath), resolve(join(out, 'item')));
  assert.equal(resolve(j.expectedPath), resolve(join(out, 'expected.json')));
  assert.ok(existsSync(join(out, 'item', 'README.md')));
});

test('CLI make refuses to overwrite an existing item (exit 3)', () => {
  const out = tmp();
  assert.equal(run('make', 'graph', '--seed', 'a', '--out', out).status, 0);
  const r = run('make', 'graph', '--seed', 'a', '--out', out);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /exists/);
});

test('CLI grade exits 0 on pass and 2 on fail, with the result JSON on stdout', () => {
  const out = tmp();
  const made = JSON.parse(run('make', 'graph', '--seed', 'cli', '--out', out).stdout);
  const f = keyOf(made).facts;
  const a = ANSWERS.graph(f);
  const good = tmpFile('good.txt', [a.defect, ...a.rest].join('\n'));
  const bad = tmpFile('bad.txt', [a.defect, ...a.rest, a.falsePositive].join('\n'));
  const r0 = run('grade', 'graph', '--expected', made.expectedPath, '--answer', good);
  assert.equal(r0.status, 0, r0.stderr);
  assert.equal(JSON.parse(r0.stdout).pass, true);
  const r2 = run('grade', 'graph', '--expected', made.expectedPath, '--answer', bad);
  assert.equal(r2.status, 2);
  const j = JSON.parse(r2.stdout);
  assert.equal(j.pass, false);
  assert.equal(j.falsePositives.length, 1);
});

test('CLI exits 3 on bad arguments or input, without a stack trace', () => {
  const out = tmp();
  const made = JSON.parse(run('make', 'review', '--seed', 'x', '--out', out).stdout);
  const ans = tmpFile('a.txt', 'CLAIM | error | X | y');
  const cases = [
    [],
    ['bogus'],
    ['make'],
    ['make', 'nope', '--seed', 'a', '--out', tmp()],
    ['make', 'drift', '--out', tmp()],
    ['make', 'drift', '--seed', 'a'],
    ['make', 'drift', '--seed', '--out', tmp()],
    ['grade', 'review', '--answer', ans],
    ['grade', 'review', '--expected', made.expectedPath],
    ['grade', 'review', '--expected', join(out, 'missing.json'), '--answer', ans],
    ['grade', 'review', '--expected', ans, '--answer', ans],
    ['grade', 'graph', '--expected', made.expectedPath, '--answer', ans],
    ['grade', 'review', '--expected', made.expectedPath, '--answer', join(out, 'none.txt')],
  ];
  for (const args of cases) {
    const r = run(...args);
    assert.equal(r.status, 3, args.join(' '));
    assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/, 'no stack trace');
  }
});

test('CLI rejects --flag=value and extra positional arguments with exit 3 and a clear message', () => {
  const out = tmp();
  const made = JSON.parse(run('make', 'review', '--seed', 'x', '--out', out).stdout);
  const ans = tmpFile('a.txt', 'CLAIM | error | X | y');
  const cases = [
    [['make', 'drift', '--seed=abc', '--out', join(out, 'n1')], /--seed=abc.*--seed <value>/],
    [['make', 'drift', '--seed', 'a', `--out=${join(out, 'n2')}`], /--out=.*--out <value>/],
    [
      ['make', 'drift', 'extra', '--seed', 'a', '--out', join(out, 'n3')],
      /unexpected argument "extra"/,
    ],
    [['make', 'drift', '--seed', 'a', 'b', '--out', join(out, 'n4')], /unexpected argument "b"/],
    [
      ['grade', 'review', '--expected', made.expectedPath, '--answer', ans, 'more'],
      /unexpected argument "more"/,
    ],
  ];
  for (const [args, msg] of cases) {
    const r = run(...args);
    assert.equal(r.status, 3, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, msg);
    assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/, 'no stack trace');
  }
  for (const n of ['n1', 'n2', 'n3', 'n4'])
    assert.ok(!existsSync(join(out, n)), `${n} was created`);
});
