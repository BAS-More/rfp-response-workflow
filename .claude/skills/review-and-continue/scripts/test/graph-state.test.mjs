// Run: node <skill>/scripts/run-tests.mjs   (passes each file by path; a glob through a path with a space finds 0 tests)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { graphState } from '../graph-state.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'graph-state.mjs');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

// A temp dir removed when test `t` ends.
function tempDir(t, prefix = 'rac gs-') {
  const dir = mkdtempSync(join(tmpdir(), prefix)); // space in the path on purpose
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A temp repo with `n` commits; returns { dir, shas } (shas oldest first). Removed when test `t` ends.
function makeRepo(t, n = 1) {
  const dir = tempDir(t);
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const shas = [];
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `f${i}.txt`), String(i));
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', `c${i}`);
    shas.push(git(dir, 'rev-parse', 'HEAD'));
  }
  return { dir, shas };
}

const kgMeta = (commit, extra = {}) => ({
  repoPath: 'C:\\Dev\\Fixture',
  lastCommit: commit,
  indexedAt: '2026-10-05T02:45:52.211Z',
  stats: { files: 3, nodes: 10, edges: 20, communities: 2, processes: 1, embeddings: 7 },
  ...extra,
});

function writeMeta(dir, folder, meta) {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(
    join(dir, folder, 'meta.json'),
    typeof meta === 'string' ? meta : JSON.stringify(meta),
  );
}

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const runEnv = (env, ...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

test('fresh: knowledge-graph meta indexed at HEAD', (t) => {
  const { dir, shas } = makeRepo(t, 1);
  writeMeta(dir, '.knowledge-graph', kgMeta(shas[0]));
  const r = graphState(dir);
  assert.equal(r.engine, 'knowledge-graph');
  assert.equal(r.status, 'fresh');
  assert.equal(r.head, shas[0]);
  assert.equal(r.indexedCommit, shas[0]);
  assert.equal(r.indexedAt, '2026-10-05T02:45:52.211Z');
  assert.equal(r.commitsBehind, 0);
  assert.equal(r.indexedIsAncestor, true);
  assert.equal(r.embeddings, 7);
  assert.equal(r.stats.nodes, 10);
  assert.ok(r.metaPath.endsWith('meta.json'));
  assert.equal(r.projectMemory, null);
  assert.equal(typeof r.reason, 'string');
});

test('stale: indexed 2 commits behind HEAD -> commitsBehind 2', (t) => {
  const { dir, shas } = makeRepo(t, 3);
  writeMeta(dir, '.knowledge-graph', kgMeta(shas[0]));
  const r = graphState(dir);
  assert.equal(r.status, 'stale');
  assert.equal(r.commitsBehind, 2);
  assert.equal(r.indexedIsAncestor, true);
  assert.match(r.reason, /2 commits? behind/);
});

test('commit field fallbacks: indexedCommit, then commit', (t) => {
  const { dir, shas } = makeRepo(t, 2);
  writeMeta(dir, '.knowledge-graph', { indexedCommit: shas[0], stats: {} });
  assert.equal(graphState(dir).indexedCommit, shas[0]);
  writeMeta(dir, '.knowledge-graph', { commit: shas[1] });
  const r = graphState(dir);
  assert.equal(r.indexedCommit, shas[1]);
  assert.equal(r.status, 'fresh');
  assert.equal(r.embeddings, null);
});

test('unknown: bogus sha (rewritten history) has null commitsBehind and ancestry', (t) => {
  const { dir } = makeRepo(t, 1);
  writeMeta(dir, '.knowledge-graph', kgMeta('deadbeef'.repeat(5)));
  const r = graphState(dir);
  assert.equal(r.status, 'unknown');
  assert.equal(r.commitsBehind, null);
  assert.equal(r.indexedIsAncestor, null);
  assert.match(r.reason, /not in this repo/);
});

test('unknown: unreadable meta.json and meta with no commit', (t) => {
  const { dir } = makeRepo(t, 1);
  writeMeta(dir, '.knowledge-graph', '{not json');
  let r = graphState(dir);
  assert.equal(r.status, 'unknown');
  assert.equal(r.engine, 'knowledge-graph');
  assert.equal(r.stats, null);
  writeMeta(dir, '.knowledge-graph', { stats: { embeddings: 0 } });
  r = graphState(dir);
  assert.equal(r.status, 'unknown');
  assert.equal(r.embeddings, 0);
  assert.match(r.reason, /no commit/);
});

test('unknown: indexed commit exists but is on another branch (not an ancestor of HEAD)', (t) => {
  const { dir, shas } = makeRepo(t, 1);
  git(dir, 'checkout', '-qb', 'side');
  writeFileSync(join(dir, 'side.txt'), 's');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'side');
  const side = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'master');
  writeMeta(dir, '.knowledge-graph', kgMeta(side));
  const r = graphState(dir);
  assert.equal(r.head, shas[0]);
  assert.equal(r.indexedIsAncestor, false);
  assert.equal(r.status, 'unknown');
});

test('missing: no engine folder; gitnexus detected best effort', (t) => {
  const { dir, shas } = makeRepo(t, 1);
  let r = graphState(dir);
  assert.equal(r.status, 'missing');
  assert.equal(r.engine, null);
  assert.equal(r.metaPath, null);
  assert.equal(r.indexedCommit, null);
  writeMeta(dir, '.gitnexus', kgMeta(shas[0]));
  r = graphState(dir);
  assert.equal(r.engine, 'gitnexus');
  assert.equal(r.status, 'fresh');
});

test('projectMemory reads choice and managedBy from .project-memory/config.json', (t) => {
  const { dir } = makeRepo(t, 1);
  mkdirSync(join(dir, '.project-memory'));
  writeFileSync(
    join(dir, '.project-memory', 'config.json'),
    JSON.stringify({ schemaVersion: 1, managedBy: 'bas-more-project-memory', choice: 'declined' }),
  );
  const r = graphState(dir);
  assert.deepEqual(r.projectMemory, { choice: 'declined', managedBy: 'bas-more-project-memory' });
});

test('non-git dir returns an error entry', (t) => {
  const dir = tempDir(t, 'rac gs-nogit-');
  assert.match(graphState(dir).error, /not a git work tree/);
});

test('CLI exit 0 when every repo is fresh, with empty attention', (t) => {
  const { dir, shas } = makeRepo(t, 1);
  writeMeta(dir, '.knowledge-graph', kgMeta(shas[0]));
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.repos.length, 1);
  assert.deepEqual(out.attention, []);
});

test('CLI exit 2 when any repo is stale or missing, listed in attention', (t) => {
  const fresh = makeRepo(t, 1);
  writeMeta(fresh.dir, '.knowledge-graph', kgMeta(fresh.shas[0]));
  const missing = makeRepo(t, 1);
  const r = run(fresh.dir, missing.dir);
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.repos.length, 2);
  assert.equal(out.attention.length, 1);
  assert.match(out.attention[0], /: missing \(/);
});

test('CLI exit 1 when an argument is not a git work tree; 3 with no repos', (t) => {
  const dir = tempDir(t, 'rac gs-nogit-');
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).repos[0].error, /not a git work tree/);
  const none = run();
  assert.equal(none.status, 3);
  assert.match(none.stderr, /usage/);
});

// ---- reviewer findings ----

test('subdirectory argument: engine folders are found at the git toplevel', (t) => {
  const { dir, shas } = makeRepo(t, 1);
  writeMeta(dir, '.knowledge-graph', kgMeta(shas[0]));
  mkdirSync(join(dir, 'sub', 'deep'), { recursive: true });
  const r = graphState(join(dir, 'sub', 'deep'));
  assert.equal(r.error, undefined);
  assert.equal(r.engine, 'knowledge-graph');
  assert.equal(r.status, 'fresh');
  assert.ok(r.metaPath.startsWith(dir), `${r.metaPath} should be under ${dir}`);
});

test('unusable .knowledge-graph meta falls back to usable .gitnexus; reason names the other engine', (t) => {
  const { dir, shas } = makeRepo(t, 1);
  writeMeta(dir, '.knowledge-graph', '{not json');
  writeMeta(dir, '.gitnexus', kgMeta(shas[0]));
  const r = graphState(dir);
  assert.equal(r.engine, 'gitnexus');
  assert.equal(r.status, 'fresh');
  assert.match(r.reason, /knowledge-graph/);
});

test('both engines usable: knowledge-graph preferred, gitnexus reported in reason', (t) => {
  const { dir, shas } = makeRepo(t, 2);
  writeMeta(dir, '.knowledge-graph', kgMeta(shas[1]));
  writeMeta(dir, '.gitnexus', kgMeta(shas[0]));
  const r = graphState(dir);
  assert.equal(r.engine, 'knowledge-graph');
  assert.equal(r.status, 'fresh');
  assert.match(r.reason, /gitnexus/);
});

test('both engines unusable: first engine reported unknown', (t) => {
  const { dir } = makeRepo(t, 1);
  writeMeta(dir, '.knowledge-graph', '{not json');
  writeMeta(dir, '.gitnexus', '[]');
  const r = graphState(dir);
  assert.equal(r.engine, 'knowledge-graph');
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /unreadable/);
});

test('stats must be a plain object: array -> null', (t) => {
  const { dir, shas } = makeRepo(t, 1);
  writeMeta(dir, '.knowledge-graph', kgMeta(shas[0], { stats: [1, 2, 3] }));
  const r = graphState(dir);
  assert.equal(r.stats, null);
  assert.equal(r.embeddings, null);
});

test('commitsBehind is null when the indexed commit is not an ancestor of HEAD', (t) => {
  const { dir } = makeRepo(t, 1);
  git(dir, 'checkout', '-qb', 'side');
  writeFileSync(join(dir, 'side.txt'), 's');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'side');
  const side = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'master');
  writeMeta(dir, '.knowledge-graph', kgMeta(side));
  const r = graphState(dir);
  assert.equal(r.indexedIsAncestor, false);
  assert.equal(r.commitsBehind, null);
});

test('unreadable meta.json reason text', (t) => {
  const { dir } = makeRepo(t, 1);
  writeMeta(dir, '.knowledge-graph', '{not json');
  assert.match(graphState(dir).reason, /meta\.json is unreadable/);
});

test('repo with no HEAD commit -> unknown', (t) => {
  const dir = tempDir(t, 'rac gs-nohead-');
  git(dir, 'init', '-q', '-b', 'master');
  writeMeta(dir, '.knowledge-graph', kgMeta('a'.repeat(40)));
  const r = graphState(dir);
  assert.equal(r.head, null);
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /no HEAD/);
});

test('CLI: non-git argument appears in attention', (t) => {
  const dir = tempDir(t, 'rac gs-nogit-');
  const r = run(dir);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.attention.length, 1);
  assert.match(out.attention[0], /not a git work tree/);
});

test('CLI: exit 1 wins over 2 (non-git + missing)', (t) => {
  const nogit = tempDir(t, 'rac gs-nogit-');
  const missing = makeRepo(t, 1);
  const r = run(nogit, missing.dir);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).attention.length, 2);
});

test('CLI: stale repo exits 2', (t) => {
  const { dir, shas } = makeRepo(t, 2);
  writeMeta(dir, '.knowledge-graph', kgMeta(shas[0]));
  const r = run(dir);
  assert.equal(r.status, 2, r.stderr);
  assert.match(JSON.parse(r.stdout).attention[0], /: stale \(1 commit behind/);
});

test('CLI ignores inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE', (t) => {
  const target = makeRepo(t, 1);
  writeMeta(target.dir, '.knowledge-graph', kgMeta(target.shas[0]));
  const other = makeRepo(t, 2);
  const r = runEnv(
    {
      GIT_DIR: join(other.dir, '.git'),
      GIT_WORK_TREE: other.dir,
      GIT_INDEX_FILE: join(other.dir, '.git', 'index'),
    },
    target.dir,
  );
  assert.equal(r.status, 0, r.stdout);
  assert.equal(JSON.parse(r.stdout).repos[0].head, target.shas[0]);
});
