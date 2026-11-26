// Shared helpers. Zero dependencies; Node >= 18.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  'target',
]);

// Claude Code stores sessions under ~/.claude/projects/<slug>, slug = path with every non-alphanumeric char -> '-'.
// Already-absolute paths (either OS style) are kept as-is so a Windows path can be slugged on Linux and vice versa.
const isAbs = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\');
export const projectSlug = (p) => (isAbs(p) ? p : resolve(p)).replace(/[^A-Za-z0-9]/g, '-');

// Returns trimmed stdout, or null when git exits non-zero (missing upstream, no stash, etc).
// input: text for stdin (--stdin / --batch-check); timeout: ms, for commands that touch the network; env: child env.
export function git(cwd, args, { input, timeout, env } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      input,
      timeout,
      env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

export const lines = (s) => (s ? s.split(/\r?\n/).filter(Boolean) : []);

// Repos are dirs containing .git (dir, or file for worktrees/submodules). Does not descend into a found repo.
export function findRepos(roots, maxDepth = 3) {
  const found = [];
  const walk = (dir, depth) => {
    if (existsSync(join(dir, '.git'))) {
      found.push(resolve(dir));
      return;
    }
    if (depth >= maxDepth) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
        walk(join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) if (existsSync(r) && statSync(r).isDirectory()) walk(resolve(r), 0);
  return [...new Set(found)];
}

export function parseArgs(argv, flags = {}) {
  const out = { _: [], ...flags };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--no-')) out[a.slice(5)] = false;
    else if (a.startsWith('--'))
      out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else out._.push(a);
  }
  return out;
}

export const isMain = (metaUrl) =>
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(metaUrl).toLowerCase();
