#!/usr/bin/env node
// Usage: node repo-state.mjs <root>... [--depth 3] [--no-gh]
// Emits JSON: every git repo under the roots (one entry per repository, worktrees nested), with all
// uncommitted / unpushed / stashed / detached / unreviewed work, open PRs (gh) and knowledge-graph
// freshness. Read-only. Exits 1 with {error} when no repo is found.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, lines, findRepos, parseArgs, isMain } from './lib.mjs';

const norm = (p) => resolve(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const redact = (url) => url.replace(/\/\/[^@/\s]+@/, '//***@');

function graphState(dir, head) {
  const meta = join(dir, '.knowledge-graph', 'meta.json');
  if (!existsSync(meta)) return { present: false };
  try {
    const m = JSON.parse(readFileSync(meta, 'utf8'));
    const behind = m.lastCommit ? git(dir, ['rev-list', '--count', `${m.lastCommit}..HEAD`]) : null;
    return {
      present: true,
      indexedCommit: m.lastCommit ?? null,
      indexedAt: m.indexedAt ?? null,
      embeddings: m.stats?.embeddings ?? null,
      stale: m.lastCommit !== head,
      commitsBehind: behind === null ? null : Number(behind),
    };
  } catch (e) {
    return { present: true, error: `unreadable meta.json: ${e.message}` };
  }
}

function openPRs(dir) {
  try {
    const out = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'open',
        '--json',
        'number,title,headRefName,isDraft,url',
        '--limit',
        '100',
      ],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 },
    );
    return JSON.parse(out);
  } catch {
    return null; // gh missing, unauthenticated, or no GitHub remote
  }
}

// Merged PRs carry headRefOid, the last commit the PR had; squash and rebase merges never put it on the default branch.
const MERGED_LIMIT = 1000;
function mergedPRs(dir) {
  try {
    const out = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'merged',
        '--json',
        'number,headRefName,headRefOid,baseRefName,url',
        '--limit',
        String(MERGED_LIMIT),
      ],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 },
    );
    return JSON.parse(out);
  } catch {
    return null;
  }
}

const isAncestor = (dir, a, b) => git(dir, ['merge-base', '--is-ancestor', a, b]) !== null;
const toCount = (s) => (s === null || !/^\d+$/.test(s) ? null : Number(s));

// Never let a credential prompt, a GUI login or an ssh passphrase block an inventory run.
const NONINTERACTIVE = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
};

// Branch heads as the servers have them now. Local remote-tracking refs can outlive a branch deleted on the
// server (until a prune), so "on a remote" is checked against `git ls-remote`. Exclusions are the live SHAs we
// have locally plus the tracking refs of branches that still exist on the server (a clone that has not fetched
// lacks the newest server SHAs, but its tracking ref for a live branch was on that branch). An unreachable remote
// falls back to all its tracking refs and is listed in `unreachable`.
// `refs` holds `<remote>/<branch>` for every branch that exists on the server.
function liveRemoteHeads(dir, remotes) {
  const shas = new Set(),
    refs = new Set(),
    unreachable = [];
  for (const remote of remotes) {
    const tracking = lines(
      git(dir, [
        'for-each-ref',
        '--format=%(objectname) %(refname:short)',
        `refs/remotes/${remote}/`,
      ]),
    )
      .map((l) => l.split(' '))
      .filter(([, r]) => !r.endsWith('/HEAD') && r !== remote);
    const out = git(dir, ['ls-remote', '--heads', '--tags', remote], {
      timeout: 15000,
      env: NONINTERACTIVE,
    });
    if (out === null) {
      unreachable.push(remote);
      for (const [s, r] of tracking) {
        shas.add(s);
        refs.add(r);
      }
      continue;
    }
    for (const l of lines(out)) {
      const [s, r] = l.split(/\s+/);
      shas.add(s);
      if (r.startsWith('refs/heads/')) refs.add(`${remote}/${r.slice(11)}`);
    }
    for (const [s, r] of tracking) if (refs.has(r)) shas.add(s);
  }
  const check = git(dir, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    input: [...shas].join('\n') + '\n',
  });
  return {
    shas: lines(check)
      .filter((l) => / (commit|tag)$/.test(l))
      .map((l) => l.split(' ')[0]),
    refs,
    unreachable,
  };
}

// `up/stream/feat/x` → { remote: 'up/stream', name: 'feat/x' }: remote names may contain a slash.
function splitRemoteRef(ref, remotes) {
  const remote = remotes
    .filter((r) => ref.startsWith(r + '/'))
    .sort((a, b) => b.length - a.length)[0];
  return remote ? { remote, name: ref.slice(remote.length + 1) } : { remote: null, name: ref };
}

// Commits reachable from `revs` (and the extra args) but from no live remote head. null when git fails: callers
// must treat that as unknown, never as 0.
const offRemoteInput = (ctx, revs) =>
  [...revs, ...ctx.live.shas.map((s) => `^${s}`)].join('\n') + '\n';
const countOffRemote = (ctx, revs, extra = []) =>
  toCount(
    git(ctx.dir, ['rev-list', '--count', ...extra, '--stdin'], {
      input: offRemoteInput(ctx, revs),
    }),
  );
const listOffRemote = (ctx, revs, extra = []) => {
  const out = git(ctx.dir, ['rev-list', ...extra, '--stdin'], { input: offRemoteInput(ctx, revs) });
  return out === null ? null : lines(out);
};

// A merge whose tree is exactly what git produces by re-merging its two parents carries no edits of its own.
// Octopus merges, conflicts, or a git without `merge-tree --write-tree` (< 2.38) count as not clean.
function isCleanMerge(dir, sha) {
  const parents = (git(dir, ['rev-list', '--parents', '-n', '1', sha]) ?? '').split(' ').slice(1);
  if (parents.length !== 2) return false;
  const tree = git(dir, ['rev-parse', `${sha}^{tree}`]);
  const merged = git(dir, ['merge-tree', '--write-tree', parents[0], parents[1]]);
  return Boolean(tree) && merged !== null && lines(merged)[0] === tree;
}

// Ancestry calls a squash-merged branch "unmerged" although its work landed. Classifies one branch ref:
//   landed       a merged PR into the default branch, for the same branch name, has a head that contains the tip
//   after-merge  such a PR head is an ancestor of the tip; tailCommits are the non-merge commits past it that are
//                not on the default branch either (oldest first, ready for `git cherry-pick`)
//   on-remote    no PR proves it, but every commit exists on a live remote head
//   at-risk      commits on no remote, or the check failed (error set): the only case that is never safe
// ctx.merged = null (no PR data) skips the PR checks, so nothing is called landed without evidence.
export function classifyBranch(ctx, ref, name) {
  const { dir, merged, def, base } = ctx;
  const tip = git(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  if (!tip) return { classification: 'at-risk', unique: null, error: `cannot resolve ${ref}` };
  const unique = countOffRemote(ctx, [tip]);
  if (unique === null)
    return {
      classification: 'at-risk',
      unique: null,
      error: 'rev-list failed (corrupt or shallow repo?)',
    };
  const sameName = (merged ?? []).filter((p) => p.headRefName === name && p.headRefOid);
  const same = sameName.filter((p) => def && p.baseRefName === def);
  const local = same.filter(
    (p) => git(dir, ['cat-file', '-e', `${p.headRefOid}^{commit}`]) !== null,
  );
  const landed = local.find((p) => p.headRefOid === tip || isAncestor(dir, tip, p.headRefOid));
  if (landed) return { classification: 'landed', pr: landed.number, unique };
  let after = null;
  for (const p of local.filter((x) => isAncestor(dir, x.headRefOid, tip))) {
    const out = git(dir, [
      'rev-list',
      '--reverse',
      '--no-merges',
      tip,
      `^${p.headRefOid}`,
      ...(base ? [`^${base}`] : []),
    ]);
    if (out === null)
      return {
        classification: 'at-risk',
        unique,
        error: `rev-list failed for the tail after PR #${p.number}`,
      };
    const tailCommits = lines(out);
    if (!after || tailCommits.length < after.tailCommits.length)
      after = { pr: p.number, prHead: p.headRefOid, tailCommits };
  }
  if (after) {
    // A merge commit past the PR can carry its own edits or a conflict resolution, which cherry-picking the
    // non-merge tail would drop. Any such merge on no live remote makes the whole branch at-risk instead.
    const range = [tip, `^${after.prHead}`, ...(base ? [`^${base}`] : [])];
    const offMerges = listOffRemote(ctx, range, ['--merges']);
    if (offMerges === null)
      return {
        classification: 'at-risk',
        unique,
        error: 'rev-list failed for merges after the PR',
      };
    if (offMerges.some((m) => !isCleanMerge(dir, m)))
      return {
        classification: 'at-risk',
        unique,
        mergeTailAfterPr: after.pr,
        prHead: after.prHead,
      };
    if (!after.tailCommits.length) return { classification: 'landed', pr: after.pr, unique }; // only pushed merges or default-branch commits past the PR
    const tailUnique = countOffRemote(ctx, range, ['--no-merges']);
    return {
      classification: 'after-merge',
      ...after,
      tail: after.tailCommits.length,
      unique: tailUnique ?? after.tailCommits.length,
    };
  }
  if (unique === 0) return { classification: 'on-remote', unique };
  const unverified = same.find((p) => !local.includes(p));
  const otherBase = sameName.find((p) => !same.includes(p));
  return {
    classification: 'at-risk',
    unique,
    ...(unverified && { unverifiedPr: unverified.number }),
    ...(otherBase && {
      mergedIntoOtherBase: { pr: otherBase.number, base: otherBase.baseRefName ?? null },
    }),
  };
}

// origin when it exists, else the first remote: some clones name their only remote `upstream`.
function primaryRemote(dir) {
  const rs = lines(git(dir, ['remote']));
  return rs.includes('origin') ? 'origin' : (rs[0] ?? null);
}

function defaultBranch(dir, remote) {
  const ref = remote ? git(dir, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]) : null;
  if (ref) return ref.slice(remote.length + 1);
  for (const b of ['main', 'master'])
    if (git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${b}`])) return b;
  return null;
}

// prs: pass an array to inject PR data (tests); otherwise fetched via gh when gh=true.
// merged: the same for merged PRs; null means unknown, so no branch can be proven landed.
export function repoState(dir, { gh = true, prs, merged } = {}) {
  dir = resolve(dir);
  const top = git(dir, ['rev-parse', '--show-toplevel']) ?? dir;
  const head = git(dir, ['rev-parse', 'HEAD']);
  const branch = git(dir, ['branch', '--show-current']) || '(detached)';
  const status = lines(git(dir, ['status', '--porcelain=v1']));
  const dirty = status.filter((l) => !l.startsWith('??'));
  const untrackedFiles = status.filter((l) => l.startsWith('??')).map((l) => l.slice(3));
  const upstream = git(dir, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  let ahead = null,
    behind = null;
  if (upstream) {
    const lr = git(dir, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
    if (lr) [behind, ahead] = lr.split(/\s+/).map(Number);
  }
  // SHA is the stable handle: the stash stack is shared by every worktree and session, indexes shift.
  const stashes = lines(git(dir, ['stash', 'list', '--format=%H|%gd|%cr|%gs'])).map((l) => {
    const [sha, ref, age, ...msg] = l.split('|');
    return { sha, ref, age, message: msg.join('|') };
  });

  const mergedPr = merged !== undefined ? merged : gh ? mergedPRs(dir) : null;
  const remote = primaryRemote(dir);
  const def = defaultBranch(dir, remote);
  // The remote's default branch when it exists, so a local default that is behind does not hide merged work.
  const base =
    def && remote && git(dir, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${def}`])
      ? `${remote}/${def}`
      : def;
  const remoteNames = lines(git(dir, ['remote']));
  const live = liveRemoteHeads(dir, remoteNames);
  const ctx = { dir, merged: mergedPr, def, base, live };
  const unpushedBranches = [],
    afterMergeTails = [],
    landedBranches = [];
  const place = (branch, status, c, kind) => {
    if (c.classification === 'at-risk') unpushedBranches.push({ branch, status, ...c });
    else if (c.classification === 'after-merge')
      afterMergeTails.push({ branch, kind, status, ...c });
    else landedBranches.push({ branch, kind, status, ...c });
  };
  // Every local branch is classified. %(upstream:track) comes from local tracking refs, which can claim "in sync"
  // with a branch the server deleted, so the upstream is also checked against the live branch list.
  // A branch in sync with (or only behind) a branch that is live on the server is skipped: it is on the remote by
  // definition, and classifying it costs two git spawns per branch.
  for (const l of lines(
    git(dir, [
      'for-each-ref',
      '--format=%(refname:short)|%(upstream:short)|%(upstream)|%(upstream:track)',
      'refs/heads',
    ]),
  )) {
    const [b, up, upFull, track] = l.split('|');
    const remoteUp = upFull.startsWith('refs/remotes/');
    if (remoteUp && live.refs.has(up) && (!track || /^\[behind \d+\]$/.test(track))) continue;
    const status = !up
      ? 'no-upstream'
      : !remoteUp
        ? `tracks local branch ${up}`
        : track === '[gone]'
          ? 'upstream gone'
          : !live.refs.has(up)
            ? `upstream ${up} deleted on server (stale tracking ref)`
            : track.replace(/[[\]]/g, '');
    const c = classifyBranch(ctx, b, b);
    if (c.classification === 'after-merge' || c.classification === 'landed')
      place(b, status, c, 'local');
    // Commits ahead of a live upstream are unpushed even when another remote has them.
    else if (/ahead/.test(status))
      unpushedBranches.push({ branch: b, status, ...c, classification: 'at-risk' });
    else place(b, status, c, 'local'); // at-risk, or on-remote without a live upstream
  }

  const worktrees = [];
  let cur = null;
  for (const l of lines(git(dir, ['worktree', 'list', '--porcelain']))) {
    if (l.startsWith('worktree ')) {
      cur = { path: l.slice(9), branch: null, head: null, detached: false };
      worktrees.push(cur);
    } else if (!cur) continue;
    else if (l.startsWith('HEAD ')) cur.head = l.slice(5);
    else if (l.startsWith('branch ')) cur.branch = l.slice(7).replace('refs/heads/', '');
    else if (l === 'detached') cur.detached = true;
    else if (l.startsWith('prunable')) cur.prunable = true;
  }
  const localHeads = lines(git(dir, ['for-each-ref', '--format=%(objectname)', 'refs/heads']));
  for (const w of worktrees) {
    w.current = norm(w.path) === norm(top);
    const st = existsSync(w.path) ? git(w.path, ['status', '--porcelain=v1']) : null;
    w.dirtyCount = st === null ? null : lines(st).length;
    w.unreadable = st === null && existsSync(w.path); // folder present but git cannot read it (moved .git file, corrupt)
    // On no local branch and no live remote head; null = the check failed, reported, never read as 0.
    if (w.detached && w.head)
      w.orphanCommits = countOffRemote(ctx, [w.head, ...localHeads.map((s) => `^${s}`)]);
  }

  const remotes = lines(git(dir, ['remote', '-v']))
    .filter((l) => l.endsWith('(push)'))
    .map((l) => redact(l.split(/\s+/).slice(0, 2).join(' ')));
  const pr = prs !== undefined ? prs : gh ? openPRs(dir) : null;

  // Pushed branches that are neither merged into the default branch nor under an open PR. Needs PR data.
  // Symrefs are skipped: `<remote>/HEAD`'s short name is the bare remote name (`origin`).
  // A tracking ref whose branch is gone from a reachable server is not "pushed": its commits may now exist only here.
  const isStale = (r) => {
    const { remote } = splitRemoteRef(r, remoteNames);
    return Boolean(remote) && !live.refs.has(r) && !live.unreachable.includes(remote);
  };
  for (const l of lines(
    git(dir, ['for-each-ref', '--format=%(refname:short)|%(symref)', 'refs/remotes']),
  )) {
    const [r, symref] = l.split('|');
    const { name } = splitRemoteRef(r, remoteNames);
    if (symref || name === 'HEAD' || !isStale(r)) continue;
    const c = classifyBranch(ctx, r, name);
    if (c.classification !== 'on-remote')
      place(r, 'tracking ref only, branch deleted on server', c, 'remote');
  }

  const pushedNoPR = [];
  if (pr && def) {
    const prHeads = new Set(pr.map((p) => p.headRefName));
    for (const l of lines(
      git(dir, ['branch', '-r', '--no-merged', base, '--format=%(refname:short)|%(symref)']),
    )) {
      const [r, symref] = l.split('|');
      const { name } = splitRemoteRef(r, remoteNames);
      if (symref || name === 'HEAD' || name === def || prHeads.has(name) || isStale(r)) continue;
      const c = classifyBranch(ctx, r, name);
      if (c.classification === 'landed' || c.classification === 'after-merge')
        place(r, 'pushed', c, 'remote');
      else pushedNoPR.push(r);
    }
  }

  // Tags not on any server that hold commits on no branch and no live remote (e.g. a deleted branch's tip, tagged).
  const liveSet = new Set(live.shas);
  const localOnlyTags = [];
  for (const l of lines(
    git(dir, ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/tags']),
  )) {
    const [sha, tag] = l.split(' ');
    if (liveSet.has(sha)) continue;
    const n = countOffRemote(ctx, [sha, ...localHeads.map((s) => `^${s}`)]);
    if (n !== 0) localOnlyTags.push({ tag, commits: n });
  }

  const graph = graphState(top, head);
  let projectMemory = null;
  try {
    projectMemory =
      JSON.parse(readFileSync(join(top, '.project-memory', 'config.json'), 'utf8')).choice ??
      'unknown';
  } catch {
    /* absent */
  }

  const attention = [];
  if (dirty.length) attention.push(`${dirty.length} modified/staged file(s) on ${branch}`);
  if (untrackedFiles.length)
    attention.push(`${untrackedFiles.length} untracked file(s) on ${branch}`);
  if (ahead) attention.push(`${branch} is ${ahead} commit(s) ahead of ${upstream}`);
  if (behind) attention.push(`${branch} is ${behind} commit(s) behind ${upstream}`);
  if (stashes.length) attention.push(`${stashes.length} stash entr(y/ies)`);
  for (const b of unpushedBranches) {
    attention.push(
      `branch ${b.branch}: ${b.status}${b.unique ? ` (${b.unique} commit(s) on no remote)` : ''}` +
        (b.error ? `; check failed, treated as at-risk: ${b.error}` : '') +
        (b.unverifiedPr
          ? `; merged PR #${b.unverifiedPr} has this name but its head is not local (fetch pull/${b.unverifiedPr}/head to check)`
          : '') +
        (b.mergeTailAfterPr
          ? `; after merged PR #${b.mergeTailAfterPr} it holds unpushed merge commits, which may carry their own edits`
          : '') +
        (b.mergedIntoOtherBase
          ? `; PR #${b.mergedIntoOtherBase.pr} with this name merged into ${b.mergedIntoOtherBase.base ?? '?'}, not ${def}`
          : ''),
    );
  }
  for (const t of afterMergeTails)
    attention.push(
      `branch ${t.branch}: ${t.tail} commit(s) after merged PR #${t.pr} (${t.unique} on no remote)`,
    );
  for (const r of live.unreachable)
    attention.push(
      `remote ${r} unreachable: "on remote" used its local tracking refs, which may be stale`,
    );
  for (const r of pushedNoPR)
    attention.push(`branch ${r}: pushed, not merged into ${def}, no open PR`);
  for (const w of worktrees) {
    if (!w.current && w.dirtyCount)
      attention.push(
        `worktree ${w.path} (${w.branch ?? 'detached'}) has ${w.dirtyCount} uncommitted change(s)`,
      );
    if (w.orphanCommits)
      attention.push(
        `worktree ${w.path} is detached with ${w.orphanCommits} commit(s) on no branch`,
      );
    if (w.detached && w.head && w.orphanCommits === null)
      attention.push(
        `worktree ${w.path} is detached and its orphan check failed: treat its commits as unsaved`,
      );
    if (w.unreadable)
      attention.push(
        `worktree ${w.path} (${w.branch ?? 'detached'}): status could not be read but the folder exists; inspect it before any prune`,
      );
  }
  for (const t of localOnlyTags)
    attention.push(`local tag ${t.tag}: ${t.commits ?? '?'} commit(s) on no branch and no remote`);
  if (graph.stale)
    attention.push(`knowledge-graph index is ${graph.commitsBehind ?? '?'} commit(s) behind HEAD`);
  if (!remotes.length) attention.push('no push remote configured');
  if (pr === null && gh) attention.push('open PRs unknown (gh unavailable or not a GitHub remote)');
  if (mergedPr === null)
    attention.push(
      `merged PRs not checked (${gh ? 'gh unavailable or not a GitHub remote' : '--no-gh'}): no branch can be shown as landed, so squash-merged branches appear as at-risk`,
    );
  if (mergedPr && mergedPr.length >= MERGED_LIMIT)
    attention.push(
      `merged PR list hit the ${MERGED_LIMIT} limit: older squash-merged branches may show as at-risk`,
    );

  return {
    path: top,
    branch,
    head,
    defaultBranch: def,
    upstream,
    ahead,
    behind,
    dirty,
    untracked: untrackedFiles.length,
    untrackedFiles,
    stashes,
    unpushedBranches,
    afterMergeTails,
    landedBranches,
    pushedNoPR,
    localOnlyTags,
    worktrees,
    remotes,
    openPRs: pr,
    mergedPRCount: mergedPr ? mergedPr.length : null,
    graph,
    projectMemory,
    attention,
  };
}

export function scanRoots(roots, { depth = 3, gh = true } = {}) {
  const seen = new Map();
  const rootsWithoutRepos = [];
  let discovered = false;
  for (const root of roots) {
    const found = findRepos([root], depth);
    if (!found.length) {
      rootsWithoutRepos.push(root);
      continue;
    }
    if (!found.some((f) => norm(f) === norm(root))) discovered = true; // root is a parent folder, repos were found by walking
    for (const f of found) {
      const common = git(f, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const key = common ? norm(common) : norm(f);
      if (!seen.has(key)) seen.set(key, f); // one entry per repository; its worktrees are nested in the entry
    }
  }
  const repos = [...seen.values()].map((d) => repoState(d, { gh }));
  return {
    roots,
    discovered,
    rootsWithoutRepos,
    repoCount: repos.length,
    needsAttention: repos.filter((r) => r.attention.length).length,
    repos,
  };
}

if (isMain(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2), { depth: '3', gh: true });
  if (!a._.length) {
    console.error('usage: repo-state.mjs <root>... [--depth N] [--no-gh]');
    process.exit(2);
  }
  const missing = a._.filter((r) => !existsSync(r));
  const out = scanRoots(
    a._.filter((r) => existsSync(r)),
    { depth: Number(a.depth), gh: a.gh },
  );
  if (missing.length) out.missingRoots = missing;
  if (!out.repoCount) out.error = 'no git repository found under the given roots';
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.repoCount ? 0 : 1);
}
