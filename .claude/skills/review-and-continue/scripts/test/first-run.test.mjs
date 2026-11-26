// Regression tests for the defects found by the first live run (BAS-More/MAH, 2026-10-15).
// Run from the skill dir: node scripts/run-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { projectSlug } from '../lib.mjs';
import { listSessions } from '../sessions.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoState } from '../repo-state.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'racr-'));
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
  git(b, 'init', '-q', '--bare', '-b', 'master');
  return b;
};
const commit = (dir, file) => {
  writeFileSync(join(dir, file), file);
  git(dir, 'add', file);
  git(dir, 'commit', '-qm', file);
  return git(dir, 'rev-parse', 'HEAD');
};

// Repo with origin, origin/HEAD set, and feature branch `name` pushed, PR-merged (squash), then deleted on the remote.
function squashMerged(name) {
  const dir = makeRepo();
  const origin = bare();
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'master');
  git(dir, 'remote', 'set-head', 'origin', 'master');
  git(dir, 'checkout', '-q', '-b', name);
  commit(dir, 'f1.txt');
  const head = commit(dir, 'f2.txt');
  git(dir, 'push', '-q', '-u', 'origin', name);
  git(dir, 'checkout', '-q', 'master');
  git(dir, 'merge', '-q', '--squash', name);
  git(dir, 'commit', '-qm', `squash ${name} (#7)`);
  git(dir, 'push', '-q', 'origin', 'master');
  git(dir, 'push', '-q', 'origin', '--delete', name);
  git(dir, 'fetch', '-q', '--prune');
  return {
    dir,
    head,
    merged: [
      {
        number: 7,
        headRefName: name,
        headRefOid: head,
        baseRefName: 'master',
        url: 'https://x/pull/7',
      },
    ],
  };
}

// Defect 1: an absolute glob through a path with a space finds 0 tests and exits 0.
test('run-tests fails when the test dir holds no tests', () => {
  const empty = mkdtempSync(join(tmpdir(), 'rac empty '));
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'run-tests.mjs'), empty], {
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
});

test('run-tests runs tests in a directory whose path contains a space', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rac space '));
  writeFileSync(
    join(dir, 'one.test.mjs'),
    "import { test } from 'node:test';\ntest('ok', () => {});\n",
  );
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'run-tests.mjs'), dir], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /✔ ok\b/);
  assert.match(r.stdout, /pass 1\b/);
});

// node --test reports a test file that registers nothing as one passing test named after the file.
test('run-tests fails when a test file registers no tests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rac noreg '));
  writeFileSync(
    join(dir, 'real.test.mjs'),
    "import { test } from 'node:test';\ntest('ok', () => {});\n",
  );
  writeFileSync(join(dir, 'empty.test.mjs'), '// registers nothing\n');
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'run-tests.mjs'), dir], {
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /empty\.test\.mjs/);
});

test('run-tests fails when every test is skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rac skip '));
  writeFileSync(
    join(dir, 's.test.mjs'),
    "import { test } from 'node:test';\ntest('x', { skip: true }, () => {});\n",
  );
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'run-tests.mjs'), dir], {
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
});

// Defect 2: `git branch -r --format=%(refname:short)` prints origin/HEAD as plain `origin`.
test('origin/HEAD symref is never reported as a pushed branch', () => {
  const dir = makeRepo();
  const origin = bare();
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'master');
  git(dir, 'remote', 'set-head', 'origin', 'master');
  // Local master behind origin/master is what made origin/HEAD look unmerged on MAH.
  commit(dir, 'b.txt');
  git(dir, 'push', '-q', 'origin', 'master');
  git(dir, 'reset', '-q', '--hard', 'HEAD~1');
  const s = repoState(dir, { gh: false, prs: [], merged: [] });
  assert.deepEqual(s.pushedNoPR, [], s.attention.join('\n'));
  assert.ok(!s.attention.some((a) => /branch origin:/.test(a)), s.attention.join('\n'));
});

// The case above is also covered by comparing against origin/master; this one needs the symref skip itself.
test('a second remote whose HEAD is ahead of the base is not reported by its bare name', () => {
  const dir = makeRepo();
  const origin = bare(),
    up = bare();
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'remote', 'add', 'upstream', up);
  git(dir, 'push', '-q', '-u', 'origin', 'master');
  git(dir, 'remote', 'set-head', 'origin', 'master');
  commit(dir, 'u.txt');
  git(dir, 'push', '-q', 'upstream', 'master');
  git(dir, 'remote', 'set-head', 'upstream', 'master');
  git(dir, 'reset', '-q', '--hard', 'HEAD~1');
  const s = repoState(dir, { gh: false, prs: [{ headRefName: 'master' }], merged: [] });
  assert.ok(!s.pushedNoPR.includes('upstream'), JSON.stringify(s.pushedNoPR));
});

test('the base is the remote default branch even when the only remote is not called origin', () => {
  const dir = makeRepo();
  const up = bare();
  git(dir, 'remote', 'add', 'upstream', up);
  git(dir, 'push', '-q', '-u', 'upstream', 'master');
  git(dir, 'remote', 'set-head', 'upstream', 'master');
  git(dir, 'checkout', '-q', '-b', 'feat/done');
  commit(dir, 'd.txt');
  git(dir, 'push', '-q', '-u', 'upstream', 'feat/done');
  git(dir, 'push', '-q', 'upstream', 'feat/done:master');
  git(dir, 'checkout', '-q', 'master');
  const s = repoState(dir, { gh: false, prs: [], merged: [] });
  assert.deepEqual(s.pushedNoPR, [], s.attention.join('\n'));
});

test('a pushed branch already merged into the remote default branch is not flagged when local default is behind', () => {
  const dir = makeRepo();
  const origin = bare();
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'master');
  git(dir, 'remote', 'set-head', 'origin', 'master');
  git(dir, 'checkout', '-q', '-b', 'feat/done');
  commit(dir, 'd.txt');
  git(dir, 'push', '-q', '-u', 'origin', 'feat/done');
  git(dir, 'push', '-q', 'origin', 'feat/done:master'); // merged on the remote (fast-forward)
  git(dir, 'checkout', '-q', 'master'); // local master is now behind origin/master
  const s = repoState(dir, { gh: false, prs: [], merged: [] });
  assert.deepEqual(s.pushedNoPR, [], s.attention.join('\n'));
});

// Defect 3: squash-merged branches were reported as unsaved work.
test('upstream-gone branch whose tip is the head of a merged PR is LANDED, not attention', () => {
  const { dir, merged } = squashMerged('feat/sq');
  const s = repoState(dir, { gh: false, prs: [], merged });
  assert.ok(
    !s.unpushedBranches.some((b) => b.branch === 'feat/sq'),
    JSON.stringify(s.unpushedBranches),
  );
  const l = s.landedBranches.find((b) => b.branch === 'feat/sq');
  assert.ok(l, JSON.stringify(s.landedBranches));
  assert.equal(l.classification, 'landed');
  assert.equal(l.pr, 7);
  assert.ok(!s.attention.some((a) => a.includes('feat/sq')), s.attention.join('\n'));
});

test('without merged-PR data the same branch stays at-risk (no silent pass)', () => {
  const { dir } = squashMerged('feat/sq');
  const s = repoState(dir, { gh: false, prs: [], merged: null });
  const b = s.unpushedBranches.find((x) => x.branch === 'feat/sq');
  assert.ok(b, JSON.stringify(s.unpushedBranches));
  assert.equal(b.classification, 'at-risk');
  assert.equal(b.unique, 2);
});

test('commits made after the merged PR head are reported as an AFTER-MERGE tail', () => {
  const { dir, merged } = squashMerged('feat/tail');
  git(dir, 'checkout', '-q', 'feat/tail');
  commit(dir, 'late.txt');
  git(dir, 'checkout', '-q', 'master');
  const s = repoState(dir, { gh: false, prs: [], merged });
  assert.ok(!s.unpushedBranches.some((b) => b.branch === 'feat/tail'));
  const t = s.afterMergeTails.find((x) => x.branch === 'feat/tail');
  assert.ok(t, JSON.stringify(s.afterMergeTails));
  assert.equal(t.pr, 7);
  assert.equal(t.tail, 1);
  assert.equal(t.unique, 1);
  assert.equal(t.prHead, merged[0].headRefOid);
  assert.deepEqual(t.tailCommits, [git(dir, 'rev-parse', 'feat/tail')]);
  assert.ok(
    s.attention.some((a) => a.includes('feat/tail') && /after merged PR #7/.test(a)),
    s.attention.join('\n'),
  );
});

test('a branch reusing a merged PR name with unrelated commits is still at-risk', () => {
  const { dir, merged } = squashMerged('feat/reuse');
  git(dir, 'checkout', '-q', '-b', 'tmp', 'master');
  git(dir, 'branch', '-q', '-D', 'feat/reuse');
  git(dir, 'checkout', '-q', '-b', 'feat/reuse');
  commit(dir, 'new.txt');
  git(dir, 'checkout', '-q', 'master');
  const s = repoState(dir, { gh: false, prs: [], merged });
  const b = s.unpushedBranches.find((x) => x.branch === 'feat/reuse');
  assert.ok(b, JSON.stringify(s));
  assert.equal(b.classification, 'at-risk');
  assert.equal(b.unique, 1);
});

test('no-upstream branch whose commits all exist on a remote is ON-REMOTE, not attention', () => {
  const dir = makeRepo();
  const origin = bare();
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'master');
  git(dir, 'branch', 'copy-of-master');
  const s = repoState(dir, { gh: false, prs: [], merged: [] });
  assert.ok(!s.unpushedBranches.some((b) => b.branch === 'copy-of-master'));
  assert.equal(
    s.landedBranches.find((b) => b.branch === 'copy-of-master')?.classification,
    'on-remote',
  );
  assert.ok(!s.attention.some((a) => a.includes('copy-of-master')), s.attention.join('\n'));
});

test('a pushed branch kept on the remote after its squash merge is not "no open PR"', () => {
  const dir = makeRepo();
  const origin = bare();
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'master');
  git(dir, 'remote', 'set-head', 'origin', 'master');
  git(dir, 'checkout', '-q', '-b', 'feat/kept');
  const head = commit(dir, 'k.txt');
  git(dir, 'push', '-q', '-u', 'origin', 'feat/kept');
  git(dir, 'checkout', '-q', 'master');
  git(dir, 'merge', '-q', '--squash', 'feat/kept');
  git(dir, 'commit', '-qm', 'squash');
  git(dir, 'push', '-q', 'origin', 'master');
  const merged = [{ number: 9, headRefName: 'feat/kept', headRefOid: head, baseRefName: 'master' }];
  const s = repoState(dir, { gh: false, prs: [], merged });
  assert.deepEqual(s.pushedNoPR, [], s.attention.join('\n'));
  assert.ok(
    s.landedBranches.some((b) => b.branch === 'origin/feat/kept' && b.pr === 9),
    JSON.stringify(s.landedBranches),
  );
});

test('merged PR whose head commit is not local is reported as unverified, not landed', () => {
  const { dir } = squashMerged('feat/far');
  const merged = [
    { number: 11, headRefName: 'feat/far', headRefOid: 'f'.repeat(40), baseRefName: 'master' },
  ];
  const s = repoState(dir, { gh: false, prs: [], merged });
  const b = s.unpushedBranches.find((x) => x.branch === 'feat/far');
  assert.ok(b);
  assert.equal(b.classification, 'at-risk');
  assert.equal(b.unverifiedPr, 11);
  assert.ok(
    s.attention.some((a) => a.includes('feat/far') && /#11/.test(a)),
    s.attention.join('\n'),
  );
});

// Findings of the adversarial review of the first fix.
test('a failed commit count is at-risk, never on-remote', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'x');
  const lost = commit(dir, 'x1.txt');
  commit(dir, 'x2.txt');
  git(dir, 'checkout', '-q', 'master');
  renameSync(
    join(dir, '.git', 'objects', lost.slice(0, 2), lost.slice(2)),
    join(dir, 'lost-object'),
  );
  const s = repoState(dir, { gh: false, prs: [], merged: [] });
  const b = s.unpushedBranches.find((x) => x.branch === 'x');
  assert.ok(b, JSON.stringify(s));
  assert.equal(b.classification, 'at-risk');
  assert.ok(b.error);
  assert.ok(!s.landedBranches.some((x) => x.branch === 'x'));
});

test('a stale remote-tracking ref (branch deleted on the server, not pruned) does not count as on a remote', () => {
  const dir = makeRepo();
  const origin = bare();
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'master');
  git(dir, 'checkout', '-q', '-b', 'foo');
  commit(dir, 'w.txt');
  git(dir, 'push', '-q', 'origin', 'foo:bar');
  git(origin, 'branch', '-D', 'bar'); // deleted on the server; local origin/bar survives
  git(dir, 'checkout', '-q', 'master');
  assert.ok(git(dir, 'branch', '-r').includes('origin/bar'));
  const s = repoState(dir, { gh: false, prs: [], merged: [] });
  const b = s.unpushedBranches.find((x) => x.branch === 'foo');
  assert.ok(b, JSON.stringify(s.landedBranches));
  assert.equal(b.unique, 1);
});

test('a PR merged into a branch other than the default does not make a branch landed', () => {
  const { dir, merged } = squashMerged('feat/stg');
  merged[0].baseRefName = 'staging';
  const s = repoState(dir, { gh: false, prs: [], merged });
  const b = s.unpushedBranches.find((x) => x.branch === 'feat/stg');
  assert.ok(b, JSON.stringify(s.landedBranches));
  assert.deepEqual(b.mergedIntoOtherBase, { pr: 7, base: 'staging' });
});

test('tail after a merge-commit PR on a reused branch name excludes default-branch and merge commits', () => {
  const dir = makeRepo();
  const origin = bare();
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'master');
  git(dir, 'remote', 'set-head', 'origin', 'master');
  git(dir, 'checkout', '-q', '-b', 'fix');
  const head = commit(dir, 'f.txt');
  git(dir, 'checkout', '-q', 'master');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge PR #1', 'fix');
  commit(dir, 'm1.txt');
  commit(dir, 'm2.txt');
  git(dir, 'push', '-q', 'origin', 'master');
  git(dir, 'branch', '-q', '-D', 'fix');
  git(dir, 'checkout', '-q', '-b', 'fix');
  const mine = commit(dir, 'new.txt');
  git(dir, 'checkout', '-q', 'master');
  const s = repoState(dir, {
    gh: false,
    prs: [],
    merged: [{ number: 1, headRefName: 'fix', headRefOid: head, baseRefName: 'master' }],
  });
  const t = s.afterMergeTails.find((x) => x.branch === 'fix');
  assert.ok(t, JSON.stringify(s));
  assert.deepEqual(t.tailCommits, [mine]);
  assert.equal(t.tail, 1);
});

test('tail excludes commits brought in by merging the default branch after a squash merge', () => {
  const { dir, merged } = squashMerged('feat/mm');
  commit(dir, 'm2.txt');
  git(dir, 'push', '-q', 'origin', 'master');
  git(dir, 'checkout', '-q', 'feat/mm');
  git(dir, 'merge', '-q', '-m', 'merge master', 'master');
  const real = commit(dir, 'real.txt');
  git(dir, 'checkout', '-q', 'master');
  const s = repoState(dir, { gh: false, prs: [], merged });
  const t = s.afterMergeTails.find((x) => x.branch === 'feat/mm');
  assert.ok(t, JSON.stringify(s));
  assert.deepEqual(t.tailCommits, [real]);
});

test('a branch still tracking its squash-merged remote branch and ahead of it is an after-merge tail', () => {
  const dir = makeRepo();
  const origin = bare();
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'master');
  git(dir, 'remote', 'set-head', 'origin', 'master');
  git(dir, 'checkout', '-q', '-b', 'feat');
  const head = commit(dir, 'f.txt');
  git(dir, 'push', '-q', '-u', 'origin', 'feat');
  git(dir, 'checkout', '-q', 'master');
  git(dir, 'merge', '-q', '--squash', 'feat');
  git(dir, 'commit', '-qm', 'squash');
  git(dir, 'push', '-q', 'origin', 'master');
  git(dir, 'checkout', '-q', 'feat');
  commit(dir, 'late.txt');
  git(dir, 'checkout', '-q', 'master');
  const s = repoState(dir, {
    gh: false,
    prs: [],
    merged: [{ number: 5, headRefName: 'feat', headRefOid: head, baseRefName: 'master' }],
  });
  assert.ok(
    !s.unpushedBranches.some((b) => b.branch === 'feat'),
    JSON.stringify(s.unpushedBranches),
  );
  assert.ok(
    s.afterMergeTails.some((t) => t.branch === 'feat' && t.tail === 1),
    JSON.stringify(s.afterMergeTails),
  );
});

test('landed entries say whether they are local or remote refs', () => {
  const { dir, merged } = squashMerged('feat/k');
  const s = repoState(dir, { gh: false, prs: [], merged });
  assert.equal(s.landedBranches.find((b) => b.branch === 'feat/k').kind, 'local');
});

test('without merged-PR data an attention item says so, also under --no-gh', () => {
  const dir = makeRepo();
  const s = repoState(dir, { gh: false });
  assert.ok(
    s.attention.some((a) => /merged PRs not checked/.test(a)),
    s.attention.join('\n'),
  );
});

// Round 2 of the adversarial review.
function deletedOnServer() {
  const dir = makeRepo();
  const origin = bare();
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'master');
  git(dir, 'remote', 'set-head', 'origin', 'master');
  git(dir, 'checkout', '-q', '-b', 'feat');
  const c = commit(dir, 'b.txt');
  git(dir, 'push', '-q', '-u', 'origin', 'feat');
  git(dir, 'checkout', '-q', 'master');
  git(origin, 'update-ref', '-d', 'refs/heads/feat'); // no prune locally: origin/feat survives, track looks in sync
  return { dir, origin, c };
}

test('a tracked branch whose server branch was deleted (not pruned) is at-risk', () => {
  const { dir } = deletedOnServer();
  const s = repoState(dir, { gh: false, prs: [], merged: [] });
  const b = s.unpushedBranches.find((x) => x.branch === 'feat');
  assert.ok(b, JSON.stringify(s));
  assert.equal(b.unique, 1);
  assert.match(b.status, /deleted on server/);
});

test('a stale tracking ref is never reported as pushed', () => {
  const { dir } = deletedOnServer();
  git(dir, 'branch', '-q', '-D', 'feat');
  const s = repoState(dir, { gh: false, prs: [], merged: [] });
  assert.ok(!s.pushedNoPR.includes('origin/feat'), JSON.stringify(s.pushedNoPR));
  const b = s.unpushedBranches.find((x) => x.branch === 'origin/feat');
  assert.ok(b, JSON.stringify(s));
  assert.equal(b.unique, 1);
});

test('detached worktree commits reachable only from a stale tracking ref are orphans', () => {
  const { dir } = deletedOnServer();
  const wt = join(mkdtempSync(join(tmpdir(), 'racw-')), 'wt');
  git(dir, 'worktree', 'add', '-q', '--detach', wt, 'feat');
  git(dir, 'branch', '-q', '-D', 'feat');
  const s = repoState(dir, { gh: false, prs: [], merged: [] });
  const w = s.worktrees.find((x) => x.detached);
  assert.equal(w.orphanCommits, 1, JSON.stringify(s.worktrees));
  assert.ok(
    s.attention.some((a) => /detached with 1 commit/.test(a)),
    s.attention.join('\n'),
  );
});

test('a merge commit with unpushed content after a squash-merged PR is not landed', () => {
  const { dir, merged } = squashMerged('feat/mc');
  commit(dir, 'm2.txt');
  git(dir, 'push', '-q', 'origin', 'master');
  git(dir, 'checkout', '-q', 'feat/mc');
  git(dir, 'merge', '-q', '--no-commit', 'master');
  writeFileSync(join(dir, 'precious.txt'), 'local only');
  git(dir, 'add', 'precious.txt');
  git(dir, 'commit', '-qm', 'merge with local edits');
  git(dir, 'checkout', '-q', 'master');
  const s = repoState(dir, { gh: false, prs: [], merged });
  assert.ok(
    !s.landedBranches.some((b) => b.branch === 'feat/mc'),
    JSON.stringify(s.landedBranches),
  );
  const b = s.unpushedBranches.find((x) => x.branch === 'feat/mc');
  assert.ok(b, JSON.stringify(s));
  assert.equal(b.mergeTailAfterPr, 7);
});

test('run-tests does not count describe() suites as executed tests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rac suite '));
  writeFileSync(
    join(dir, 'a.test.mjs'),
    "import { describe, it } from 'node:test';\ndescribe('s', () => { it.skip('x', () => {}); it.todo('t'); });\n",
  );
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'run-tests.mjs'), dir], {
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
});

test('sessions record every cwd a session worked in, not only the first', () => {
  const home = mkdtempSync(join(tmpdir(), 'rac-home-'));
  const root = 'C://Dev//Proj';
  const d = join(home, projectSlug(root));
  mkdirSync(d);
  writeFileSync(
    join(d, 's.jsonl'),
    [
      { type: 'user', message: { content: 'start' }, cwd: root },
      { type: 'assistant', message: { content: [] }, cwd: root + '\.claude\worktrees\foo' },
      { type: 'user', message: { content: 'more' }, cwd: root + '\.claude\worktrees\foo' },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n'),
  );
  const [s] = listSessions([root], { home, codexHome: join(home, 'missing-codex'), days: 3650 });
  assert.equal(s.cwd, root);
  assert.deepEqual(s.cwds, [root, root + '\.claude\worktrees\foo']);
});

// Round 3 of the adversarial review.
test('an unpushed merge commit in an after-merge tail is not reported as 0 on no remote', () => {
  const { dir, merged } = squashMerged('feat/mix');
  git(dir, 'checkout', '-q', 'feat/mix');
  commit(dir, 'c1.txt');
  git(dir, 'push', '-q', 'origin', 'feat/mix');
  git(dir, 'checkout', '-q', 'master');
  commit(dir, 'm2.txt');
  git(dir, 'push', '-q', 'origin', 'master');
  git(dir, 'checkout', '-q', 'feat/mix');
  git(dir, 'merge', '-q', '--no-commit', '--no-ff', 'master');
  writeFileSync(join(dir, 'edit.txt'), 'only here');
  git(dir, 'add', 'edit.txt');
  git(dir, 'commit', '-qm', 'merge with edit');
  git(dir, 'checkout', '-q', 'master');
  const s = repoState(dir, { gh: false, prs: [], merged });
  const b = s.unpushedBranches.find((x) => x.branch === 'feat/mix');
  assert.ok(b, JSON.stringify(s));
  assert.equal(b.mergeTailAfterPr, 7);
});

test('a clone that has not fetched new server commits gets no false at-risk branches', () => {
  const dir = makeRepo();
  const origin = bare();
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'master');
  git(dir, 'remote', 'set-head', 'origin', 'master');
  git(dir, 'checkout', '-q', '-b', 'feat/one');
  commit(dir, 'o.txt');
  git(dir, 'push', '-q', '-u', 'origin', 'feat/one');
  git(dir, 'checkout', '-q', 'master');
  const other = mkdtempSync(join(tmpdir(), 'raco-'));
  execFileSync('git', ['clone', '-q', origin, other]);
  git(other, 'config', 'user.email', 't@t');
  git(other, 'config', 'user.name', 't');
  git(other, 'checkout', '-q', 'feat/one');
  commit(other, 'theirs.txt');
  git(other, 'push', '-q', 'origin', 'feat/one');
  const s = repoState(dir, { gh: false, prs: [], merged: [] });
  assert.deepEqual(s.unpushedBranches, [], JSON.stringify(s.unpushedBranches));
});

test('a branch tracking a local branch is not called deleted on server', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'topic', '--track', 'master');
  git(dir, 'checkout', '-q', 'master');
  const s = repoState(dir, { gh: false, prs: [], merged: [] });
  const all = [...s.unpushedBranches, ...s.landedBranches];
  assert.ok(!all.some((b) => /deleted on server/.test(b.status)), JSON.stringify(all));
});

test('remote names containing a slash are split correctly', () => {
  const dir = makeRepo();
  const origin = bare();
  git(dir, 'remote', 'add', 'up/stream', origin);
  git(dir, 'push', '-q', '-u', 'up/stream', 'master');
  git(dir, 'remote', 'set-head', 'up/stream', 'master');
  git(dir, 'checkout', '-q', '-b', 'feat/one');
  commit(dir, 'o.txt');
  git(dir, 'push', '-q', '-u', 'up/stream', 'feat/one');
  git(dir, 'checkout', '-q', 'master');
  const s = repoState(dir, { gh: false, prs: [{ headRefName: 'feat/one' }], merged: [] });
  assert.deepEqual(s.pushedNoPR, [], s.attention.join('\n'));
  assert.deepEqual(s.unpushedBranches, [], JSON.stringify(s.unpushedBranches));
});

test('a worktree whose status cannot be read but whose folder exists is reported', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'side');
  const wt = join(mkdtempSync(join(tmpdir(), 'racw-')), 'wt');
  git(dir, 'worktree', 'add', '-q', wt, 'side');
  writeFileSync(join(wt, 'wip.txt'), 'w');
  renameSync(join(wt, '.git'), join(wt, 'gitfile.moved'));
  const s = repoState(dir, { gh: false, prs: [], merged: [] });
  assert.ok(
    s.attention.some((a) => a.includes('wt') && /could not be read/.test(a)),
    s.attention.join('\n'),
  );
});

test('commits reachable only from a local tag are reported', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'tmp');
  commit(dir, 't.txt');
  git(dir, 'tag', 'keep');
  git(dir, 'checkout', '-q', 'master');
  git(dir, 'branch', '-q', '-D', 'tmp');
  const s = repoState(dir, { gh: false, prs: [], merged: [] });
  assert.ok(
    s.attention.some((a) => /local tag/.test(a) && /keep/.test(a)),
    s.attention.join('\n'),
  );
});
