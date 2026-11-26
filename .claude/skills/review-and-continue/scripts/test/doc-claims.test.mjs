// Run: node <skill>/scripts/run-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KINDS, extractClaims, isDocPath, docClaims } from '../doc-claims.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(SKILL, 'scripts', 'doc-claims.mjs');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const put = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const README = [
  '# Demo', // 1
  'Run `npm install` then `npm run build`.', // 2
  'Config lives in `src/config.ts` and docs/setup/ explains it.', // 3
  'See https://example.com/docs/guide.md for more.', // 4
  'Call `computeTotal()` on `UserService`.', // 5
  'Set `DATABASE_URL` and API_TOKEN before starting.', // 6
  '- [x] ship the parser', // 7
  '- [ ] write the exporter', // 8
  'Requires Node 18.17.0 and react@18.3.1.', // 9
  'The server listens on port 3000; the admin UI on :8080.', // 10
  'Windows helper: src\\utils\\helper.ts', // 11
  'Same line twice: `src/config.ts` and `src/config.ts`.', // 12
  '```js', // 13
  'const x = "src/ignored.ts"; // `npm test` port 9999', // 14
  '```', // 15
  '```bash', // 16
  '# a comment, not a claim', // 17
  '$ npm ci', // 18
  'node scripts/build.mjs', // 19
  '```', // 20
  'plain words `install` and `README` are not symbols', // 21
].join('\n');

const PLAN = ['# Plan', '- [x] done item', '- [ ] todo item', 'Uses `gh pr list`.'].join('\n');

const rm = (p) => rmSync(p, { recursive: true, force: true });

function makeRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'rac doc claims '));
  t.after(() => rm(root));
  git(root, 'init', '-q', '-b', 'master');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'commit.gpgsign', 'false');
  put(root, 'README.md', README);
  put(root, 'docs/plan.md', PLAN);
  put(root, 'docs/continuity/HANDOVER.md', '- [ ] continuity todo `npm test`');
  put(root, 'node_modules/pkg/README.md', '- [ ] vendored');
  put(root, 'vendor/lib/docs/x.md', '- [ ] vendored');
  put(root, 'src/notes.md', '- [ ] not a doc location');
  put(root, 'docs/image.png', 'binary-ish');
  git(root, 'add', '-f', '.');
  git(root, 'commit', '-qm', 'init');
  put(root, 'docs/untracked.md', '- [ ] untracked todo');
  return root;
}

const has = (claims, line, kind, text) =>
  claims.some((c) => c.line === line && c.kind === kind && (text === undefined || c.text === text));

test('isDocPath picks docs/ and root README/CHANGELOG/HANDOVER and skips vendored and continuity output', () => {
  for (const p of [
    'README.md',
    'README',
    'readme.rst',
    'CHANGELOG.md',
    'HANDOVER.txt',
    'docs/plan.md',
    'docs/a/b.mdx',
    'docs/x.markdown',
  ])
    assert.equal(isDocPath(p), true, p);
  for (const p of [
    'src/notes.md',
    'docs/image.png',
    'docs/continuity/HANDOVER.md',
    'node_modules/x/README.md',
    'vendor/docs/x.md',
    'pkg/README.md',
    'NOTES.md',
  ])
    assert.equal(isDocPath(p), false, p);
});

test('extractClaims finds every kind in the README fixture', () => {
  const c = extractClaims(README, 'README.md');
  assert.ok(has(c, 2, 'command', 'npm install'));
  assert.ok(has(c, 2, 'command', 'npm run build'));
  assert.ok(has(c, 3, 'path', 'src/config.ts'));
  assert.ok(has(c, 3, 'path', 'docs/setup/'));
  assert.ok(has(c, 4, 'url', 'https://example.com/docs/guide.md'));
  assert.ok(has(c, 5, 'symbol', 'computeTotal()'));
  assert.ok(has(c, 5, 'symbol', 'UserService'));
  assert.ok(has(c, 6, 'env', 'DATABASE_URL'));
  assert.ok(has(c, 6, 'env', 'API_TOKEN'));
  assert.ok(has(c, 7, 'done', 'ship the parser'));
  assert.ok(has(c, 8, 'todo', 'write the exporter'));
  assert.ok(has(c, 9, 'version', 'Node 18.17.0'));
  assert.ok(has(c, 9, 'version', 'react@18.3.1'));
  assert.ok(has(c, 10, 'port', '3000'));
  assert.ok(has(c, 10, 'port', '8080'));
  assert.ok(has(c, 11, 'path', 'src\\utils\\helper.ts'));
  for (const k of KINDS)
    assert.ok(
      c.some((x) => x.kind === k),
      `kind ${k} missing`,
    );
});

test('URLs are not counted as paths and env names are not counted twice', () => {
  const c = extractClaims(README, 'README.md');
  assert.equal(c.filter((x) => x.line === 4).length, 1);
  assert.equal(c.filter((x) => x.line === 6 && x.kind !== 'env').length, 0);
  assert.equal(c.filter((x) => x.line === 5).length, 2);
});

test('identical claims on one line are deduped', () => {
  const c = extractClaims(README, 'README.md');
  assert.equal(c.filter((x) => x.line === 12).length, 1);
});

test('non-shell fence content is ignored; shell fence non-comment lines are command claims', () => {
  const c = extractClaims(README, 'README.md');
  assert.equal(c.filter((x) => x.line >= 13 && x.line <= 15).length, 0);
  assert.equal(c.filter((x) => x.line === 16 || x.line === 17 || x.line === 20).length, 0);
  assert.ok(has(c, 18, 'command', 'npm ci'));
  assert.ok(has(c, 19, 'command', 'node scripts/build.mjs'));
  assert.equal(c.filter((x) => x.line === 18 || x.line === 19).length, 2);
});

test('plain lowercase words and all-caps words without an underscore are not symbols', () => {
  const c = extractClaims(README, 'README.md');
  assert.equal(c.filter((x) => x.line === 21).length, 0);
});

test('docClaims scans tracked docs only, skipping untracked, continuity and vendored files', (t) => {
  const root = makeRepo(t);
  const r = docClaims(root);
  assert.equal(r.docs, 2);
  assert.deepEqual(Object.keys(r.byDoc).sort(), ['README.md', 'docs/plan.md']);
  assert.equal(r.total, r.claims.length);
  assert.equal(
    r.total,
    Object.values(r.byKind).reduce((a, b) => a + b, 0),
  );
  for (const k of KINDS) assert.equal(typeof r.byKind[k], 'number');
  assert.equal(r.byDoc['docs/plan.md'], 3);
  assert.ok(r.claims.every((c) => !/untracked|continuity|vendored|not a doc/.test(c.text)));
});

test('CLI prints claims JSON with exit 0, works with --summary before the repo, and handles a path with spaces', (t) => {
  const root = makeRepo(t);
  const full = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  assert.equal(full.status, 0, full.stderr);
  const out = JSON.parse(full.stdout);
  assert.equal(out.repos.length, 1);
  assert.ok(Array.isArray(out.repos[0].claims));
  assert.ok(out.repos[0].total > 0);

  const sum = spawnSync(process.execPath, [SCRIPT, '--summary', root], { encoding: 'utf8' });
  assert.equal(sum.status, 0, sum.stderr);
  const s = JSON.parse(sum.stdout);
  assert.equal(s.repos.length, 1);
  assert.equal(s.repos[0].claims, undefined);
  assert.equal(s.repos[0].total, out.repos[0].total);
});

test('CLI exits 1 for a non-git directory and 3 for bad args', (t) => {
  const notRepo = mkdtempSync(join(tmpdir(), 'rac not a repo '));
  t.after(() => rm(notRepo));
  const r1 = spawnSync(process.execPath, [SCRIPT, notRepo], { encoding: 'utf8' });
  assert.equal(r1.status, 1);
  assert.match(JSON.parse(r1.stdout).repos[0].error, /not a git work tree/);
  const r3 = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r3.status, 3);
  assert.match(r3.stderr, /usage/);
  const r3b = spawnSync(process.execPath, [SCRIPT, '--bogus', notRepo], { encoding: 'utf8' });
  assert.equal(r3b.status, 3);
});

// --- reviewer findings ---

test('finding 1: a subdirectory argument resolves to the git toplevel and says so', (t) => {
  const root = makeRepo(t);
  const sub = join(root, 'docs');
  const top = docClaims(root);
  const r = docClaims(sub);
  assert.equal(r.error, undefined);
  assert.equal(top.resolvedFrom, undefined);
  assert.equal(r.resolvedFrom, sub);
  assert.match(r.note, /resolved from/);
  assert.notEqual(r.repo, sub);
  assert.equal(r.docs, 2);
  assert.equal(r.total, top.total);
  assert.ok(r.total > 0);
});

test('finding 2: --summary between repos does not reorder them', (t) => {
  const a = makeRepo(t);
  const b = makeRepo(t);
  put(b, 'docs/extra.md', '- [ ] extra');
  git(b, 'add', 'docs/extra.md');
  git(b, 'commit', '-qm', 'extra');
  for (const args of [
    [a, '--summary', b],
    [a, b, '--summary'],
    ['--summary', a, b],
  ]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout).repos;
    assert.deepEqual(
      out.map((x) => x.docs),
      [2, 3],
      args.join(' '),
    );
    assert.ok(out.every((x) => x.claims === undefined));
  }
});

test('finding 3: dotted plain file names are paths; dotted members without a file extension are symbols', () => {
  const c = extractClaims(
    'Edit `package.json`, `README.md`, `index.ts` and `docs.md`; call `obj.method()` or `foo.bar`.',
    'x.md',
  );
  for (const f of ['package.json', 'README.md', 'index.ts', 'docs.md'])
    assert.ok(has(c, 1, 'path', f), `${f} should be a path`);
  assert.equal(c.filter((x) => x.kind === 'symbol' && /\.(json|md|ts)$/.test(x.text)).length, 0);
  assert.ok(has(c, 1, 'symbol', 'obj.method()'));
  assert.ok(has(c, 1, 'symbol', 'foo.bar'));
});

test('finding 4: checkbox lines emit done/todo and also the other kinds on the line', () => {
  const c = extractClaims(
    ['- [x] wired `src/a.ts` via `npm test`', '- [ ] set `API_KEY` see https://x.io/a'].join('\n'),
    'x.md',
  );
  assert.ok(has(c, 1, 'done'));
  assert.ok(has(c, 1, 'path', 'src/a.ts'));
  assert.ok(has(c, 1, 'command', 'npm test'));
  assert.ok(has(c, 2, 'todo'));
  assert.ok(has(c, 2, 'env', 'API_KEY'));
  assert.ok(has(c, 2, 'url', 'https://x.io/a'));
});

test('finding 5: paths in emphasis and with #anchors are paths; fractions are not', () => {
  const c = extractClaims(
    [
      'See **src/a.ts** and _docs/b.md_ and *lib/c.js*.',
      'Read docs/a.md#section and [guide](docs/g.md#top).',
      'Half is 1/2, three quarters 3/4, and 1.5/2.5 is a ratio.',
    ].join('\n'),
    'x.md',
  );
  assert.ok(has(c, 1, 'path', 'src/a.ts'));
  assert.ok(has(c, 1, 'path', 'docs/b.md'));
  assert.ok(has(c, 1, 'path', 'lib/c.js'));
  assert.ok(has(c, 2, 'path', 'docs/a.md'));
  assert.ok(has(c, 2, 'path', 'docs/g.md'));
  assert.equal(c.filter((x) => x.line === 3 && x.kind === 'path').length, 0);
});

test('finding 6: fences indented inside a list item are recognised', () => {
  const c = extractClaims(
    [
      '1. Install:',
      '',
      '    ```bash',
      '    npm ci',
      '    ```',
      '- Code:',
      '      ```js',
      '      const p = "src/ignored.ts"; // `npm test`',
      '      ```',
      'After `npm run lint`.',
    ].join('\n'),
    'x.md',
  );
  assert.ok(has(c, 4, 'command', 'npm ci'));
  assert.equal(c.filter((x) => [3, 5, 7, 8, 9].includes(x.line)).length, 0);
  assert.ok(has(c, 10, 'command', 'npm run lint'));
});

test('finding 7: single-dash args such as -h exit 3 with usage', (t) => {
  const root = makeRepo(t);
  for (const args of [['-h'], ['-h', root], [root, '-x']]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 3, args.join(' '));
    assert.match(r.stderr, /usage/);
  }
});

test('finding 8: docClaims per-doc and per-kind counts on the fixture repo', (t) => {
  const root = makeRepo(t);
  const r = docClaims(root);
  assert.equal(r.byDoc['README.md'], 19);
  assert.equal(r.byDoc['docs/plan.md'], 3);
  assert.deepEqual(r.byKind, {
    path: 4,
    command: 5,
    symbol: 2,
    env: 2,
    url: 1,
    done: 2,
    todo: 2,
    version: 2,
    port: 2,
  });
  assert.equal(r.total, 22);
});
