#!/usr/bin/env node
// Usage: node graph-state.mjs <repo>...
// Graph freshness check: for each repo, which graph engine it uses (.knowledge-graph/meta.json or, best effort,
// .gitnexus/meta.json), the commit the graph was built on vs HEAD, how many commits behind it is, whether
// embeddings exist, and the repo's .project-memory choice. Turns "Knowledge-Graph is mandatory" into a check
// that can fail. Read-only: runs git queries only, never builds or refreshes a graph.
// status: fresh = indexed commit is HEAD; stale = indexed commit is an ancestor of HEAD; missing = no engine
// folder; unknown = meta unreadable, no commit in it, commit not in this repo, or not an ancestor of HEAD.
// A subdirectory argument is checked at its work-tree root (reported as root). When both engine folders exist,
// the first one with a usable meta.json (readable object with a commit) is checked and the other is named in
// reason. commitsBehind is null unless the indexed commit is an ancestor of HEAD. Inherited GIT_DIR,
// GIT_WORK_TREE and GIT_INDEX_FILE are ignored.
// Prints {repos:[...], attention:["<repo>: <status> (<reason>)" for every non-fresh repo, and
// "<repo>: error (<error>)" for every argument that is not a git work tree]}.
// Exit 0 = every repo fresh; 2 = at least one stale/missing/unknown; 1 = an argument is not a git work tree
// (its entry carries {repo, error}; 1 wins over 2); 3 = bad arguments (no repos).
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, parseArgs, isMain } from './lib.mjs';

// Order is preference when a repo has both; the first engine whose meta.json is usable wins.
const ENGINES = [
  ['knowledge-graph', '.knowledge-graph'],
  ['gitnexus', '.gitnexus'],
];
const CHOICES = new Set(['enabled', 'deferred', 'declined']);

// An inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (e.g. when run from a git hook) would make every query
// answer for that other repo instead of the one passed in.
const GIT_ENV = { ...process.env };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete GIT_ENV[k];
const g = (cwd, args) => git(cwd, args, { env: GIT_ENV });

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
};
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const plainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const commitOf = (meta) => str(meta.lastCommit) ?? str(meta.indexedCommit) ?? str(meta.commit);

function projectMemory(root) {
  const cfg = plainObject(readJson(join(root, '.project-memory', 'config.json')));
  if (!cfg) return null;
  const choice = str(cfg.choice);
  return { choice: choice && CHOICES.has(choice) ? choice : null, managedBy: str(cfg.managedBy) };
}

export function graphState(repo) {
  repo = resolve(repo);
  if (!existsSync(repo) || g(repo, ['rev-parse', '--is-inside-work-tree']) !== 'true')
    return { repo, error: 'not a git work tree; graph freshness was NOT checked' };
  // A subdirectory argument: engine folders and .project-memory live at the work-tree root.
  // --show-cdup is relative, so the root keeps the caller's path form (no 8.3-name or slash rewriting).
  const cdup = g(repo, ['rev-parse', '--show-cdup']);
  const root = cdup ? resolve(repo, cdup) : repo;

  const out = {
    repo,
    root,
    head: g(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']) || null,
    engine: null,
    metaPath: null,
    indexedCommit: null,
    indexedAt: null,
    commitsBehind: null,
    indexedIsAncestor: null,
    embeddings: null,
    stats: null,
    projectMemory: projectMemory(root),
    status: 'missing',
    reason: 'no .knowledge-graph or .gitnexus folder',
  };
  const present = ENGINES.filter(([, folder]) => isDir(join(root, folder))).map(
    ([name, folder]) => {
      const metaPath = join(root, folder, 'meta.json');
      const meta = plainObject(readJson(metaPath));
      return { name, metaPath, meta, usable: Boolean(meta && commitOf(meta)) };
    },
  );
  if (!present.length) return out;
  const chosen = present.find((e) => e.usable) ?? present[0];
  const others = present
    .filter((e) => e !== chosen)
    .map(
      (e) =>
        `${e.name} also present${e.usable ? '' : ' but its meta.json is unusable'}; not checked`,
    );
  out.engine = chosen.name;
  out.metaPath = chosen.metaPath;
  const finish = (fields) => {
    Object.assign(out, fields);
    if (others.length) out.reason += `; ${others.join('; ')}`;
    return out;
  };
  const unknown = (reason) => finish({ status: 'unknown', reason });

  const meta = chosen.meta;
  if (!meta)
    return unknown(existsSync(out.metaPath) ? 'meta.json is unreadable' : 'meta.json is missing');
  out.indexedAt = str(meta.indexedAt);
  out.stats = plainObject(meta.stats);
  out.embeddings = typeof out.stats?.embeddings === 'number' ? out.stats.embeddings : null;
  out.indexedCommit = commitOf(meta);
  if (!out.indexedCommit) return unknown('meta.json records no commit');
  if (!out.head) return unknown('repo has no HEAD commit');

  // Resolve to a full sha; a bogus or rewritten-away commit does not resolve.
  const sha = /^[0-9a-f]{4,64}$/i.test(out.indexedCommit)
    ? g(repo, ['rev-parse', '--verify', '--quiet', `${out.indexedCommit}^{commit}`])
    : null;
  if (!sha)
    return unknown(
      `indexed commit ${out.indexedCommit.slice(0, 12)} is not in this repo (history rewritten?)`,
    );

  // git() returns '' on exit 0 and null on non-zero; the commit is known to exist, so null means "not an ancestor".
  out.indexedIsAncestor = g(repo, ['merge-base', '--is-ancestor', sha, 'HEAD']) !== null;
  if (!out.indexedIsAncestor)
    return unknown(
      `indexed commit ${sha.slice(0, 12)} is not an ancestor of HEAD (built on another branch?)`,
    );
  // Only meaningful for an ancestor; for any other case commitsBehind stays null (unknown).
  const count = g(repo, ['rev-list', '--count', `${sha}..HEAD`]);
  out.commitsBehind = count !== null && /^\d+$/.test(count) ? Number(count) : null;

  if (sha === out.head) return finish({ status: 'fresh', reason: 'indexed at HEAD' });
  const n = out.commitsBehind;
  return finish({
    status: 'stale',
    reason: n === null ? 'indexed behind HEAD' : `${n} commit${n === 1 ? '' : 's'} behind HEAD`,
  });
}

if (isMain(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (!a._.length) {
    console.error('graph-state: usage: graph-state.mjs <repo>...');
    process.exit(3);
  }
  const repos = a._.map(graphState);
  const attention = repos
    .filter((r) => r.error || r.status !== 'fresh')
    .map((r) =>
      r.error ? `${r.repo}: error (${r.error})` : `${r.repo}: ${r.status} (${r.reason})`,
    );
  console.log(JSON.stringify({ repos, attention }, null, 2));
  process.exit(repos.some((r) => r.error) ? 1 : attention.length ? 2 : 0);
}
