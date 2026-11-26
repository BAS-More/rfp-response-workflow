#!/usr/bin/env node
// Usage: node sessions.mjs <project-root>... [--days 30] [--limit 20] [--home DIR] [--codex-home DIR]
// Lists local Claude Code and Codex sessions for the project, its in-repo worktrees and any linked worktree
// elsewhere on disk, newest first: title, first/last human prompt, branch, cwd (first) and cwds (all). Read-only.
// Only sees sessions stored on THIS machine under THIS account.
import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { projectSlug, parseArgs, isMain, git, lines } from './lib.mjs';

const clip = (s, n = 400) => (s.length > n ? s.slice(0, n) + '…' : s);
const WRAPPERS =
  /<(system-reminder|task-notification|local-command-[\w-]+|command-message)>[\s\S]*?<\/\1>/g;

// Returns the human-authored text of a user record, or null when it is tool output / harness noise.
function humanText(o) {
  if (o.isMeta || o.isSidechain) return null;
  const c = o.message?.content;
  let text;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b?.type === 'tool_result')) return null;
    text = c
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('\n');
  } else return null;
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1].trim();
    return `${cmd[1].trim()}${args ? ' ' + args : ''}`;
  }
  text = text.replace(WRAPPERS, '').trim();
  if (
    !text ||
    /^<[\w-]+>/.test(text) ||
    text.startsWith('[Request interrupted') ||
    text.startsWith('# AGENTS.md instructions')
  )
    return null;
  return text;
}

function readSession(file) {
  let title = null,
    firstPrompt = null,
    lastPrompt = null,
    cwd = null,
    gitBranch = null,
    userTurns = 0,
    startedAt = null;
  const cwds = []; // every directory the session worked in (it can move into a worktree after the first prompt)
  let source = 'claude-code',
    id = null,
    lastCwd = null;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw) continue;
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (o.type === 'session_meta' || o.type === 'turn_context') {
      source = 'codex';
      const p = o.payload ?? {};
      if (p.cwd && !cwds.includes(p.cwd)) cwds.push(p.cwd);
      lastCwd = p.cwd ?? lastCwd;
      cwd ??= p.cwd ?? null;
      if (o.type === 'session_meta') {
        id = p.id ?? null;
        gitBranch = p.git?.branch ?? null;
        startedAt = p.timestamp ?? o.timestamp ?? null;
      }
    }
    // Codex writes both event_msg and response_item copies. Count response_item only.
    if (o.type === 'response_item' && o.payload?.type === 'message' && o.payload.role === 'user') {
      o = {
        type: 'user',
        message: {
          content: (o.payload.content ?? [])
            .filter((b) => b.type === 'input_text')
            .map((b) => ({ type: 'text', text: b.text })),
        },
      };
    }
    if (o.cwd && !cwds.includes(o.cwd)) cwds.push(o.cwd);
    if (o.type === 'custom-title' && o.customTitle) title = o.customTitle;
    else if (o.type === 'ai-title' && o.aiTitle && !title) title = o.aiTitle;
    else if (o.type === 'user') {
      const text = humanText(o);
      if (!text) continue;
      userTurns++;
      firstPrompt ??= clip(text);
      lastPrompt = clip(text);
      cwd ??= o.cwd ?? null;
      gitBranch ??= o.gitBranch ?? null;
      startedAt ??= o.timestamp ?? null;
    }
  }
  return {
    title,
    firstPrompt,
    lastPrompt,
    cwd,
    currentCwd: lastCwd ?? cwds.at(-1) ?? cwd,
    cwds,
    gitBranch,
    userTurns,
    startedAt,
    source,
    ...(id ? { id } : {}),
  };
}

const slugOf = (p) => {
  const s = projectSlug(p.replace(/[\\/]+$/, ''));
  return process.platform === 'win32' || /^[A-Za-z]:/.test(p) ? s.toLowerCase() : s;
};

export function listSessions(
  roots,
  {
    home = join(homedir(), '.claude', 'projects'),
    codexHome = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
    days = 30,
    limit = 20,
  } = {},
) {
  // Linked worktrees can live anywhere on disk; add them as roots so their sessions are found too.
  const all = new Set(roots);
  for (const r of roots) {
    if (!existsSync(r)) continue;
    for (const l of lines(git(r, ['worktree', 'list', '--porcelain'])))
      if (l.startsWith('worktree ')) all.add(l.slice(9));
  }
  const slugs = [...all].map(slugOf);
  const fold = (d) => (slugs.some((s) => s !== s.toLowerCase()) ? d : d.toLowerCase());
  // Exact slug, or its "<slug>--claude-worktrees-*" folders. Not a bare prefix: "Proj" must not match "Projector".
  const dirs = existsSync(home)
    ? readdirSync(home).filter((d) =>
        slugs.some((s) => fold(d) === s || fold(d).startsWith(s + '--')),
      )
    : [];
  const cutoff = Date.now() - days * 86400000;
  const out = [];
  for (const d of dirs) {
    for (const f of readdirSync(join(home, d)).filter((f) => f.endsWith('.jsonl'))) {
      const file = join(home, d, f);
      const mtime = statSync(file).mtimeMs;
      if (mtime < cutoff) continue;
      out.push({
        id: f.replace(/\.jsonl$/, ''),
        projectDir: d,
        file,
        lastActive: new Date(mtime).toISOString(),
        ...readSession(file),
      });
    }
  }
  const normalize = (p) => {
    if (existsSync(p)) p = realpathSync.native(p);
    const value = (/^[A-Za-z]:/.test(p) ? p : resolve(p)).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' || /^[A-Za-z]:/.test(p) ? value.toLowerCase() : value;
  };
  const paths = [...all].map(normalize);
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const mtime = statSync(file).mtimeMs;
        if (mtime < cutoff) continue;
        const session = readSession(file);
        if (
          !session.cwds.some((cwd) =>
            paths.some((root) => normalize(cwd) === root || normalize(cwd).startsWith(root + '/')),
          )
        )
          continue;
        out.push({
          id: entry.name.replace(/\.jsonl$/, ''),
          file,
          lastActive: new Date(mtime).toISOString(),
          ...session,
        });
      }
    }
  };
  visit(codexHome);
  return out
    .filter((s) => s.userTurns > 0)
    .sort((a, b) => b.lastActive.localeCompare(a.lastActive))
    .slice(0, limit);
}

if (isMain(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2), { days: '30', limit: '20' });
  if (!a._.length) {
    console.error(
      'usage: sessions.mjs <project-root>... [--days N] [--limit N] [--home DIR] [--codex-home DIR]',
    );
    process.exit(2);
  }
  const opts = { days: Number(a.days), limit: Number(a.limit) };
  if (a.home) opts.home = a.home;
  if (a['codex-home']) opts.codexHome = a['codex-home'];
  console.log(JSON.stringify(listSessions(a._, opts), null, 2));
}
