#!/usr/bin/env node
// Usage: node install-clink.mjs --pal <PAL install dir> [--add-dir <dir>]... [--add-dirs-file <scopes.json>]
//                               [--only <client>[,<client>...]] [--target <dir>] [--apply] [--force]
// Copies the cheap-model clink clients (../pal/cli_clients/*.json) into PAL's user override folder,
// default ~/.pal/cli_clients. Without --apply it only prints the plan (text, not JSON), including each
// client's resulting add-dirs.
// Scope: a client's readable scope is fixed in its file, so install it per run with exactly the in-scope repo
// folders (or their P4 baseline worktrees) whose consent covers that client's route, never a parent folder.
//   --add-dir <dir>         repeatable; each occurrence appends one `--add-dir <dir>` pair, in order, to every
//                           client without an entry of its own. No path-delimiter splitting (drive letters).
//   --add-dirs-file <json>  {"<client name>": ["dir", ...], "*": ["dir", ...]}: per-client scopes; "*" applies
//                           to clients without their own entry (not combinable with --add-dir). An empty
//                           list means no --add-dir at all: the client sees its cwd only. Relative dirs in
//                           the file resolve against the file's own folder (not the cwd); a UTF-8 BOM is fine.
//   --only <a,b>            install only these clients (names as in the files, e.g. claude-glm); repeatable,
//                           occurrences are merged.
// Every add-dir a selected client would get must exist, be a folder, and be neither a filesystem root, the
// user's home folder, nor an ancestor of it (e.g. C:/Users), judged after resolving junctions and symlinks;
// otherwise nothing is written. Dirs are written resolved to absolute paths, each at most once per client
// (first-seen order kept).
// Stock PAL accepts only clients named claude, codex or gemini, and one rejected file stops the whole clink
// registry from loading, so --apply first checks that <PAL>/clink/models.py gives CLIClientConfig a `runner`
// field (the BAS-More/PAL-MCP patch). PAL reads these files at start-up: restart it after installing.
// Exit 0 = done (or dry run); 1 = refused; 2 = installed, but some files were left alone as conflicts;
// 3 = bad arguments (a flag without its value, unknown client, bad scopes file, or a refused add-dir).
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, resolve, parse, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain } from './lib.mjs';

// True only when the raw config model (what a JSON file is validated against) declares `runner` as a field.
// The resolved model has had `runner` all along, so a plain search of the file would give a false yes.
// The class body ends at the first non-blank line that is not indented; strings are removed first so a
// docstring or a multi-line string that mentions `runner:` does not count.
export function palSupportsRunner(palDir) {
  let src;
  try {
    src = readFileSync(join(palDir, 'clink', 'models.py'), 'utf8');
  } catch {
    return false;
  }
  src = src.replace(/\r\n/g, '\n').replace(/("""|''')[\s\S]*?\1/g, '');
  const head = src.match(/^class CLIClientConfig\b[^\n]*\n/m);
  if (!head) return false;
  const rest = src.slice(head.index + head[0].length);
  const end = rest.search(/^\S/m);
  const body = end < 0 ? rest : rest.slice(0, end);
  const indent = body.match(/^([ \t]+)\S/m)?.[1];
  if (!indent) return false;
  return new RegExp(`^${indent}runner\\s*:`, 'm').test(body);
}

// Every value of a repeatable flag, in order (lib.mjs parseArgs keeps only the last one).
// missing = some occurrence had no value (end of argv, or followed by another --flag).
export function collectFlag(argv, name) {
  const values = [];
  let missing = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== `--${name}`) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) missing = true;
    else values.push(argv[++i]);
  }
  return { values, missing };
}

const asList = (d) => (d === undefined || d === null ? [] : Array.isArray(d) ? d : [d]);

// The file content that would be written: the shipped client, plus one `--add-dir <dir>` pair per dir.
// addDir may be one dir (older callers) or a list; an empty list leaves the file byte-identical.
export function renderClient(text, addDir) {
  const dirs = asList(addDir);
  if (!dirs.length) return text;
  const cfg = JSON.parse(text);
  cfg.additional_args = [...cfg.additional_args, ...dirs.flatMap((d) => ['--add-dir', d])];
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

export const clientNames = (sourceDir) =>
  readdirSync(sourceDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => f.slice(0, -5));

// Drops repeats of the same dir (compared resolved, case-folded on Windows), keeping first-seen order.
const dedupe = (dirs) => {
  const seen = new Set();
  return dirs.filter((d) => {
    const r = resolve(d);
    const k = process.platform === 'win32' ? r.toLowerCase() : r;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// A client's dirs: its own entry in scopes, else scopes['*'], else the --add-dir list; each dir once.
export function scopeFor(client, { addDir, scopes } = {}) {
  if (scopes && Object.hasOwn(scopes, client)) return dedupe(scopes[client]);
  if (scopes && Object.hasOwn(scopes, '*')) return dedupe(scopes['*']);
  return dedupe(asList(addDir));
}

export function planInstall(sourceDir, targetDir, { force = false, addDir, scopes, only } = {}) {
  return clientNames(sourceDir)
    .filter((client) => !only || only.includes(client))
    .map((client) => {
      const file = `${client}.json`;
      const addDirs = scopeFor(client, { addDir, scopes });
      const content = renderClient(readFileSync(join(sourceDir, file), 'utf8'), addDirs);
      const dst = join(targetDir, file);
      const base = { client, file, dst, content, addDirs };
      if (!existsSync(dst)) return { ...base, action: 'copy' };
      if (readFileSync(dst, 'utf8') === content) return { ...base, action: 'same' };
      return { ...base, action: force ? 'overwrite' : 'conflict' };
    });
}

// Comparable form of a path: real path when it exists, no trailing separator, case-folded on Windows.
const canon = (p) => {
  let r = resolve(p);
  try {
    r = realpathSync.native(r);
  } catch {
    // keep the resolved form
  }
  if (r.length > parse(r).root.length && r.endsWith(sep)) r = r.slice(0, -1);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

// null when dir is an acceptable scope, else the reason it is refused.
export function checkAddDir(dir, home = homedir()) {
  const abs = resolve(dir);
  if (!existsSync(abs)) return `${dir} does not exist`;
  if (!statSync(abs).isDirectory()) return `${dir} is not a folder`;
  const c = canon(abs);
  if (c === canon(parse(abs).root) || c === canon(parse(c).root))
    return `${dir} is a filesystem root; scope a client to the in-scope repo folders only`;
  const h = canon(home);
  if (c === h) return `${dir} is the home folder; scope a client to the in-scope repo folders only`;
  if (h.startsWith(c.endsWith(sep) ? c : c + sep))
    return `${dir} is an ancestor of the home folder; scope a client to the in-scope repo folders only`;
  return null;
}

// Reads and validates an --add-dirs-file; returns {client|'*': [absolute dirs]} or throws with the reason.
export function readScopes(file, clients) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`cannot read --add-dirs-file ${file}: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`--add-dirs-file ${file} must hold an object of client name -> list of dirs`);
  const out = {};
  const base = dirname(resolve(file));
  for (const [k, v] of Object.entries(raw)) {
    if (k !== '*' && !clients.includes(k))
      throw new Error(`--add-dirs-file names unknown client ${k} (known: ${clients.join(', ')})`);
    if (!Array.isArray(v) || v.some((d) => typeof d !== 'string' || !d))
      throw new Error(`--add-dirs-file entry ${k} must be a list of folder paths`);
    out[k] = v.map((d) => resolve(base, d));
  }
  return out;
}

const fail = (code, msg) => {
  console.error(`install-clink: ${msg}`);
  process.exit(code);
};

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  for (const k of ['pal', 'target', 'add-dir', 'add-dirs-file', 'only'])
    if (args[k] === true) fail(3, `--${k} needs a value`);
  const repeated = collectFlag(argv, 'add-dir');
  if (repeated.missing) fail(3, '--add-dir needs a value');
  const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'pal', 'cli_clients');
  const target = args.target ?? join(homedir(), '.pal', 'cli_clients');
  const clients = clientNames(source);

  const onlyFlags = collectFlag(argv, 'only');
  if (onlyFlags.missing) fail(3, '--only needs a value');
  let only;
  if (onlyFlags.values.length) {
    only = onlyFlags.values
      .flatMap((v) => v.split(','))
      .map((c) => c.trim().replace(/\.json$/, ''))
      .filter(Boolean);
    const unknown = only.filter((c) => !clients.includes(c));
    if (!only.length || unknown.length)
      fail(
        3,
        `--only names unknown client(s) ${unknown.join(', ')} (known: ${clients.join(', ')})`,
      );
  }
  let scopes;
  if (args['add-dirs-file'] !== undefined) {
    try {
      scopes = readScopes(args['add-dirs-file'], clients);
    } catch (e) {
      fail(3, e.message);
    }
    if (Object.hasOwn(scopes, '*') && repeated.values.length)
      fail(3, 'give the default scope as --add-dir or as "*" in --add-dirs-file, not both');
  }
  const addDir = repeated.values.map((d) => resolve(d));

  const plan = planInstall(source, target, { force: Boolean(args.force), addDir, scopes, only });
  const refused = [...new Set(plan.flatMap((p) => p.addDirs))]
    .map((d) => checkAddDir(d))
    .filter(Boolean);
  if (refused.length) fail(3, `refused add-dir: ${refused.join('; ')}`);

  if (args.apply) {
    if (!args.pal)
      fail(1, '--apply needs --pal <PAL install dir> so it can check runner support first');
    if (!palSupportsRunner(args.pal)) {
      fail(
        1,
        `${args.pal} has no runner field on CLIClientConfig. Installing would make clink reject these files and stop loading every client. Merge and deploy the PAL runner patch first.`,
      );
    }
    mkdirSync(target, { recursive: true });
    for (const p of plan)
      if (p.action === 'copy' || p.action === 'overwrite') writeFileSync(p.dst, p.content);
  }
  console.log(
    args.apply
      ? `install-clink: target ${target}`
      : `install-clink: dry run (add --apply to write), target ${target}`,
  );
  for (const p of plan)
    console.log(
      `  ${p.action.padEnd(9)} ${p.file}  add-dirs: ${p.addDirs.length ? p.addDirs.join(' | ') : '(none, cwd only)'}`,
    );
  const conflicts = plan.filter((p) => p.action === 'conflict');
  if (conflicts.length)
    console.log(
      `  ${conflicts.length} conflict(s) left untouched; compare them, then rerun with --force to replace`,
    );
  if (args.apply)
    console.log(
      '  Restart PAL (its hub backend) so clink loads the new clients, then probe each one (PHASES.md P0).',
    );
  console.log('  scope: Restart PAL if it caches clients, then run a scope probe');
  process.exit(args.apply && conflicts.length ? 2 : 0);
}
