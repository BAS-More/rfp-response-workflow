// Run: node <skill>/scripts/run-tests.mjs   (passes each file by path; a glob through a path with a space finds 0 tests)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSlug, findRepos } from '../lib.mjs';
import { repoState } from '../repo-state.mjs';
import { listSessions } from '../sessions.mjs';
import { docRefs } from '../doc-refs.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'rac-'));
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

test('projectSlug matches Claude Code project folder naming', () => {
  assert.equal(projectSlug('C:\\Dev\\ComWatch'), 'C--Dev-ComWatch');
  assert.equal(projectSlug('/home/a/my.repo'), '-home-a-my-repo');
});

test('findRepos finds nested repos and skips node_modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'rac-root-'));
  const a = join(root, 'svc-a');
  mkdirSync(a);
  git(a, 'init', '-q');
  const hidden = join(root, 'node_modules', 'pkg');
  mkdirSync(hidden, { recursive: true });
  git(hidden, 'init', '-q');
  const found = findRepos([root], 3).map((p) => p.toLowerCase());
  assert.ok(found.includes(a.toLowerCase()));
  assert.ok(!found.some((p) => p.includes('node_modules')));
});

test('repoState reports dirty, untracked, stash, no-upstream branch and dirty worktree', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.txt'), 'changed');
  writeFileSync(join(dir, 'new.txt'), 'n');
  git(dir, 'branch', 'feat/x');
  const wt = join(mkdtempSync(join(tmpdir(), 'rac-wt-')), 'wt');
  git(dir, 'worktree', 'add', '-q', wt, 'feat/x');
  writeFileSync(join(wt, 'wip.txt'), 'w');
  const s = repoState(dir, { gh: false });
  assert.equal(s.branch, 'master');
  assert.ok(s.dirty.some((l) => l.includes('a.txt')));
  assert.equal(s.untracked, 1);
  assert.ok(s.unpushedBranches.some((b) => b.branch === 'feat/x' && b.status === 'no-upstream'));
  const w = s.worktrees.find((x) => x.branch === 'feat/x');
  assert.ok(w && w.dirtyCount === 1);
  assert.ok(s.attention.length >= 3);
});

test('repoState flags a stale knowledge-graph index', () => {
  const dir = makeRepo();
  const first = git(dir, 'rev-parse', 'HEAD');
  mkdirSync(join(dir, '.knowledge-graph'));
  writeFileSync(
    join(dir, '.knowledge-graph', 'meta.json'),
    JSON.stringify({ lastCommit: first, indexedAt: '2026-01-01' }),
  );
  writeFileSync(join(dir, 'b.txt'), 'b');
  git(dir, 'add', 'b.txt');
  git(dir, 'commit', '-qm', 'two');
  const s = repoState(dir, { gh: false });
  assert.equal(s.graph.stale, true);
  assert.equal(s.graph.commitsBehind, 1);
});

test('listSessions reads titles and prompts for the project and its worktrees only', () => {
  const home = mkdtempSync(join(tmpdir(), 'rac-home-'));
  const root = 'C:\\Dev\\Proj';
  const own = join(home, projectSlug(root));
  const wt = join(home, projectSlug(root) + '--claude-worktrees-x');
  const other = join(home, projectSlug('C:\\Dev\\Projector'));
  for (const d of [own, wt, other]) mkdirSync(d);
  const lines = (title, prompt) =>
    [
      {
        type: 'user',
        message: { content: prompt },
        cwd: root,
        gitBranch: 'master',
        timestamp: '2026-10-01T00:00:00Z',
      },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
      { type: 'user', message: { content: 'last ask' } },
      { type: 'custom-title', customTitle: title },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n');
  writeFileSync(join(own, 's1.jsonl'), lines('Own title', 'first ask'));
  writeFileSync(join(wt, 's2.jsonl'), lines('WT title', 'wt ask'));
  writeFileSync(join(other, 's3.jsonl'), lines('Other', 'nope'));
  const s = listSessions([root], {
    home,
    codexHome: join(home, 'missing-codex'),
    days: 3650,
    limit: 10,
  });
  assert.equal(s.length, 2);
  const one = s.find((x) => x.title === 'Own title');
  assert.equal(one.firstPrompt, 'first ask');
  assert.equal(one.lastPrompt, 'last ask');
  assert.equal(one.userTurns, 2);
  assert.equal(one.gitBranch, 'master');
});

test('docRefs reports missing paths and npm scripts, ignores URLs and placeholders', () => {
  const dir = makeRepo();
  mkdirSync(join(dir, 'docs'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'real.js'), '');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  writeFileSync(
    join(dir, 'docs', 'guide.md'),
    [
      'See `src/real.js` and `src/gone.js`.',
      'Link [here](../src/real.js) and [bad](./missing.md).',
      'Run `npm run test` then `npm run deploy`.',
      'Ignore `<your-path>/x.js`, `https://x.io/a.js`, `*.js`, `~/.claude/x.md`.',
    ].join('\n'),
  );
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'docs');
  const r = docRefs(dir);
  const missing = r.missing.map((m) => m.ref).sort();
  assert.deepEqual(missing, ['./missing.md', 'npm run deploy', 'src/gone.js']);
  assert.equal(r.missing.find((m) => m.ref === 'src/gone.js').line, 1);
  assert.equal(r.missing.find((m) => m.ref === 'src/gone.js').confidence, 'high');
  assert.ok(r.checked >= 5);
});

test('docRefs accepts suffix matches and skips branch prefixes and elisions', () => {
  const dir = makeRepo();
  mkdirSync(join(dir, 'app', 'platform'), { recursive: true });
  writeFileSync(join(dir, 'app', 'platform', 'win32.js'), '');
  writeFileSync(
    join(dir, 'README.md'),
    'Edit `platform/win32.js`; branch `chore/`; see `a/.../b.ts`; bare `real-nowhere.cfg`.',
  );
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'r');
  const r = docRefs(dir);
  assert.deepEqual(
    r.missing.map((m) => [m.ref, m.confidence]),
    [['real-nowhere.cfg', 'low']],
  );
});

test('CLIs emit valid JSON', () => {
  const dir = makeRepo();
  for (const [s, args] of [
    ['repo-state.mjs', [dir, '--no-gh']],
    ['doc-refs.mjs', [dir]],
    [
      'sessions.mjs',
      [
        dir,
        '--days',
        '1',
        '--home',
        join(dir, 'missing-claude'),
        '--codex-home',
        join(dir, 'missing-codex'),
      ],
    ],
  ]) {
    const out = execFileSync(process.execPath, [join(SCRIPTS, s), ...args], { encoding: 'utf8' });
    assert.doesNotThrow(() => JSON.parse(out), s);
  }
});
