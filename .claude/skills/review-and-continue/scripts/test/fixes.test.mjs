// Regression tests for the adversarial-review findings (2026-10-15).
// Run: node <skill>/scripts/run-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../lib.mjs';
import { repoState, scanRoots } from '../repo-state.mjs';
import { listSessions } from '../sessions.mjs';
import { docRefs } from '../doc-refs.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'racf-'));
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}
const bare = () => {
  const b = mkdtempSync(join(tmpdir(), 'racb-'));
  git(b, 'init', '-q', '--bare');
  return b;
};

test('remote URLs have credentials redacted', () => {
  const dir = makeRepo();
  git(dir, 'remote', 'add', 'origin', 'https://bob:ghp_SECRET123@github.com/o/r.git');
  const s = repoState(dir, { gh: false });
  assert.ok(s.remotes.every((r) => !r.includes('SECRET')));
  assert.ok(s.remotes[0].includes('***@github.com'));
});

test('branch whose upstream is gone and holds unique commits is flagged', () => {
  const dir = makeRepo();
  const origin = bare();
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'master');
  git(dir, 'checkout', '-q', '-b', 'feat/g');
  writeFileSync(join(dir, 'g.txt'), 'g');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'g');
  git(dir, 'push', '-q', '-u', 'origin', 'feat/g');
  writeFileSync(join(dir, 'g2.txt'), 'g2');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'g2');
  git(dir, 'push', '-q', 'origin', '--delete', 'feat/g');
  git(dir, 'fetch', '-q', '--prune');
  const s = repoState(dir, { gh: false });
  const b = s.unpushedBranches.find((x) => x.branch === 'feat/g');
  assert.ok(b, 'gone branch reported');
  assert.match(b.status, /gone/);
  assert.equal(b.unique, 2);
});

test('detached worktree with commits on no branch is flagged', () => {
  const dir = makeRepo();
  const wt = join(mkdtempSync(join(tmpdir(), 'racw-')), 'wt');
  git(dir, 'worktree', 'add', '-q', '--detach', wt);
  writeFileSync(join(wt, 'd.txt'), 'd');
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', 'detached work');
  const s = repoState(dir, { gh: false });
  assert.ok(
    s.attention.some((a) => /detached/.test(a) && /1 commit/.test(a)),
    s.attention.join('\n'),
  );
});

test('scanning from a linked worktree still flags a dirty main checkout', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'side');
  const wt = join(mkdtempSync(join(tmpdir(), 'racw-')), 'wt');
  git(dir, 'worktree', 'add', '-q', wt, 'side');
  writeFileSync(join(dir, 'a.txt'), 'dirty main');
  const s = repoState(wt, { gh: false });
  assert.ok(
    s.attention.some((a) => a.includes('worktree') && /1 uncommitted/.test(a)),
    s.attention.join('\n'),
  );
});

test('pushed, unmerged branch with no open PR is flagged when PR data is available', () => {
  const dir = makeRepo();
  const origin = bare();
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'master');
  git(dir, 'checkout', '-q', '-b', 'feat/nopr');
  writeFileSync(join(dir, 'n.txt'), 'n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'n');
  git(dir, 'push', '-q', '-u', 'origin', 'feat/nopr');
  git(dir, 'checkout', '-q', 'master');
  const s = repoState(dir, { gh: false, prs: [] });
  assert.ok(
    s.attention.some((a) => a.includes('feat/nopr') && /no open PR/.test(a)),
    s.attention.join('\n'),
  );
});

test('stashes carry their commit SHA', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.txt'), 'stashme');
  git(dir, 'stash', 'push', '-q', '-m', 'tagged');
  const s = repoState(dir, { gh: false });
  assert.match(s.stashes[0].sha, /^[0-9a-f]{40}$/);
});

test('scanRoots dedupes worktrees of one repo and reports roots without repos', () => {
  const parent = mkdtempSync(join(tmpdir(), 'racp-'));
  const main = join(parent, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'master');
  git(main, 'config', 'user.email', 't@t');
  git(main, 'config', 'user.name', 't');
  writeFileSync(join(main, 'x'), 'x');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'i');
  git(main, 'branch', 'b2');
  git(main, 'worktree', 'add', '-q', join(parent, 'wt2'), 'b2');
  const empty = mkdtempSync(join(tmpdir(), 'race-'));
  const r = scanRoots([parent, empty], { depth: 2, gh: false });
  assert.equal(r.repos.length, 1);
  assert.equal(r.rootsWithoutRepos.length, 1);
  assert.ok(r.discovered, 'a non-repo root is marked as discovered, needing explicit inclusion');
});

test('repo-state CLI exits non-zero when no repo is found', () => {
  const empty = mkdtempSync(join(tmpdir(), 'race-'));
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'repo-state.mjs'), empty, '--no-gh'], {
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.ok(JSON.parse(r.stdout).error);
});

test('doc-refs errors on a non-git folder instead of reporting zero drift', () => {
  const empty = mkdtempSync(join(tmpdir(), 'race-'));
  assert.ok(docRefs(empty).error);
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'doc-refs.mjs'), empty], {
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
});

test('doc-refs: npm punctuation, link titles, reference links, deleted files', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
  writeFileSync(join(dir, 'gone.js'), '');
  writeFileSync(
    join(dir, 'README.md'),
    [
      'Run npm run build.',
      'See [t](./nope.md "Title").',
      '[ref]: ./nope2.md',
      'Old `src/gone.js` and `gone.js`.',
    ].join('\n'),
  );
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'r');
  rmSync(join(dir, 'gone.js'));
  const r = docRefs(dir);
  const refs = r.missing.map((m) => m.ref).sort();
  assert.deepEqual(refs, ['./nope.md', './nope2.md', 'gone.js', 'src/gone.js']);
  assert.ok(r.missing.every((m) => m.confidence));
});

test('sessions: array prompts, reminders stripped, meta and notifications skipped, command args kept', () => {
  const home = mkdtempSync(join(tmpdir(), 'rach-'));
  const root = 'C:\\Dev\\Arr';
  const d = join(home, projectSlug(root));
  mkdirSync(d);
  const rows = [
    { type: 'user', isMeta: true, message: { content: 'meta noise' } },
    {
      type: 'user',
      message: {
        content: '<system-reminder>ctx</system-reminder>\n<task-notification>x</task-notification>',
      },
    },
    {
      type: 'user',
      message: {
        content: [
          { type: 'text', text: '<system-reminder>r</system-reminder>' },
          { type: 'text', text: 'real ask in array' },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: '<command-name>/goal</command-name><command-args>ship it</command-args>',
      },
    },
  ];
  writeFileSync(join(d, 's.jsonl'), rows.map((o) => JSON.stringify(o)).join('\n'));
  const [s] = listSessions([root], { home, codexHome: join(home, 'missing-codex'), days: 3650 });
  assert.equal(s.firstPrompt, 'real ask in array');
  assert.equal(s.lastPrompt, '/goal ship it');
  assert.equal(s.userTurns, 2);
});

test('sessions: trailing separator and case differences still match', () => {
  const home = mkdtempSync(join(tmpdir(), 'rach-'));
  mkdirSync(join(home, projectSlug('C:\\Dev\\Case')));
  writeFileSync(
    join(home, projectSlug('C:\\Dev\\Case'), 's.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
  );
  assert.equal(
    listSessions(['c:\\dev\\case\\'], { home, codexHome: join(home, 'missing-codex'), days: 3650 })
      .length,
    1,
  );
});
