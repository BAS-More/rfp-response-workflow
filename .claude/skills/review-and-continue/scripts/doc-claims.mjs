#!/usr/bin/env node
// Usage: node doc-claims.mjs [--summary] <repo>...
// Counts the checkable claims in a repo's docs, so drift coverage "N of M claims" is counted, not estimated.
// Docs = tracked files (git ls-files; untracked files are ignored) with extension .md/.mdx/.markdown/.rst/.txt
// under docs/, plus root README*/CHANGELOG*/HANDOVER*. Skips node_modules/, vendor/ and docs/continuity/** (this
// skill's own output). A claim is {doc, line, kind, text}; kinds: path, command, symbol, env, url, done, todo,
// version, port. Fenced code is ignored except shell fences (bash/sh/shell/console/powershell/ps1/pwsh), whose
// non-comment lines are command claims (fences may be indented, e.g. inside list items). A dotted file name
// with a known extension (package.json) is a path; checkbox lines yield done/todo plus the other kinds in them.
// Identical (doc, line, kind, text) claims are counted once. A subdirectory argument is counted as its git
// toplevel, reported as repo with resolvedFrom/note naming the argument.
// It counts claims; it does not check them. Checking is doc-refs.mjs (dead paths) and the drift review.
// Output: {repos:[{repo, docs, total, byKind:{<kind>:n}, byDoc:{<doc>:n}, claims:[...]}]}; --summary omits claims.
// A repo that is not a git work tree is reported as {repo, error}.
// Exit 0 = counted; 1 = an argument is not a git work tree (its count is NOT zero, it is unknown); 3 = bad args.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, parseArgs, isMain } from './lib.mjs';

export const KINDS = ['path', 'command', 'symbol', 'env', 'url', 'done', 'todo', 'version', 'port'];

const DOC_EXT = /\.(md|mdx|markdown|rst|txt)$/i;
const ROOT_DOC = /^(readme|changelog|handover)([.-][^/]*)?$/i;
const SHELL_FENCES = new Set(['bash', 'sh', 'shell', 'console', 'powershell', 'ps1', 'pwsh']);
const COMMANDS = new Set(
  'npm pnpm yarn npx node python pip make docker git gh cargo go dotnet pwsh bash'.split(' '),
);
// Words that sit before a version number but are not a package or tool ("upgrade to 1.2.3").
const NOT_A_NAME = new Set(
  'to from at version v is be and or of the in on with than since until as by for was'.split(' '),
);

export function isDocPath(p) {
  const parts = p.split('/');
  if (parts.some((s) => s === 'node_modules' || s === 'vendor')) return false;
  if (parts.length === 1) return ROOT_DOC.test(p) && (DOC_EXT.test(p) || !p.includes('.'));
  if (parts[0] !== 'docs' || !DOC_EXT.test(p)) return false;
  return parts[1] !== 'continuity';
}

const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/g;
const trimUrl = (u) => u.replace(/[.,;:!?]+$/, '');
const isUrl = (s) => /^https?:\/\//i.test(s);
// File extensions that make a dotted name a file reference (`package.json`), not member access (`foo.bar`).
const FILE_EXT = new Set(
  (
    'md mdx markdown rst txt json jsonc json5 yaml yml toml ini cfg conf env lock xml csv tsv sql ' +
    'js mjs cjs jsx ts mts cts tsx vue svelte py rb go rs java kt cs fs c h cc cpp hpp swift php ' +
    'sh bash zsh ps1 psm1 bat cmd html htm css scss sass less svg png jpg jpeg gif webp ico pdf ' +
    'graphql gql proto prisma tf hcl dockerfile gradle sln csproj log'
  ).split(' '),
);
const extOf = (s) => (s.match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase();
const looksPath = (s) =>
  !isUrl(s) &&
  /[/\\]/.test(s) &&
  !/^[\d./\\]+$/.test(s) && // 1/2, 3/4, 1.5/2.5 are numbers, not paths
  /^(\.{1,2}[/\\])?[\w@.-]+([/\\][\w@.-]+)*[/\\]?$/.test(s) &&
  (/[/\\]$/.test(s) || /\.[A-Za-z0-9]{1,6}$/.test(s));
// A plain file name with a known extension and no directory part: package.json, README.md, index.ts.
const isFileName = (s) => /^[\w@.-]*\w\.[A-Za-z0-9]+$/.test(s) && FILE_EXT.has(extOf(s));
const isEnv = (s) => s.length >= 4 && /^[A-Z][A-Z0-9]*_[A-Z0-9_]*$/.test(s);
const isCommand = (s) => COMMANDS.has(s.split(/\s+/)[0]);
// Identifier (optionally dotted member access, without a known file extension) with an optional (), that is
// shaped like code: a call, mixed case, dotted, or snake_case.
const isSymbol = (s) =>
  /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*(\(\))?$/.test(s) &&
  !isFileName(s) &&
  (s.endsWith('()') || s.includes('.') || s.includes('_') || (/[a-z]/.test(s) && /[A-Z]/.test(s)));
const stripAnchor = (s) => s.replace(/#[\w.-]*$/, '');
// **src/a.ts**, _docs/b.md_, *lib/c.js* -> the inner text (a matched run of * or _ on both sides).
const stripEmphasis = (s) => {
  const m = s.match(/^([*_]{1,3})(.+?)\1$/);
  return m ? m[2] : s;
};

function codeSpanKind(s) {
  if (isUrl(s)) return null; // counted by the url pass
  if (isCommand(s)) return 'command';
  const bare = s.replace(/^\$/, '');
  if (isEnv(bare)) return 'env';
  if (looksPath(stripAnchor(s)) || isFileName(stripAnchor(s))) return 'path';
  if (isSymbol(s)) return 'symbol';
  return null;
}

function lineClaims(text, add) {
  const box = text.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (box) {
    add(box[1] === ' ' ? 'todo' : 'done', box[2].trim());
    text = box[2]; // the item text can still carry paths, commands, env names, ...
  }
  for (const m of text.matchAll(URL_RE)) add('url', trimUrl(m[0]));
  const noUrls = text.replace(URL_RE, ' ');
  // Inline code, then bare tokens of the text left once code spans are removed (so nothing counts twice).
  for (const m of noUrls.matchAll(/`([^`]+)`/g)) {
    const s = m[1].trim();
    const kind = codeSpanKind(s);
    if (kind)
      add(kind, kind === 'env' ? s.replace(/^\$/, '') : kind === 'path' ? stripAnchor(s) : s);
  }
  const prose = noUrls.replace(/`[^`]*`/g, ' ');
  for (const m of prose.matchAll(/[^\s()[\]<>"',;]+/g)) {
    const tok = stripAnchor(stripEmphasis(m[0].replace(/[.:!?]+$/, '')).replace(/[.:!?]+$/, ''));
    if (looksPath(tok)) add('path', tok);
  }
  for (const m of prose.matchAll(/(?<![\w./\\-])[A-Z][A-Z0-9]*_[A-Z0-9_]*(?![\w/\\-])(?!\.\w)/g))
    if (isEnv(m[0])) add('env', m[0]);
  // Version and port read the code-span text too (`react@18.3.1`, `localhost:3000`).
  for (const m of noUrls.matchAll(
    /(?<![\w.@/-])([A-Za-z@][\w@/.-]*?)(@|\s+)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?!\w)(?!\.\d)/g,
  )) {
    if (NOT_A_NAME.has(m[1].toLowerCase())) continue;
    add('version', m[2] === '@' ? `${m[1]}@${m[3]}` : `${m[1]} ${m[3]}`);
  }
  const ports = [
    ...[...noUrls.matchAll(/\bport\s+(\d{2,5})(?!\d)/gi)].map((m) => m[1]),
    ...[...noUrls.matchAll(/(?<![\d.:]):(\d{2,5})(?![\d:])/g)].map((m) => m[1]),
  ];
  for (const p of ports) if (+p > 0 && +p <= 65535) add('port', String(+p));
}

export function extractClaims(content, doc) {
  const claims = [];
  const seen = new Set();
  let fence = null; // {marker, shell}
  content.split(/\r?\n/).forEach((text, i) => {
    const line = i + 1;
    const add = (kind, t) => {
      if (!t) return;
      const key = `${kind}\0${t}`;
      if (seen.has(`${line}\0${key}`)) return;
      seen.add(`${line}\0${key}`);
      claims.push({ doc, line, kind, text: t });
    };
    // Any indentation: a fence nested in a list item sits at the item's content indent (4+ spaces).
    const f = text.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)/);
    if (fence) {
      if (f && f[1][0] === fence.marker[0] && f[1].length >= fence.marker.length && !f[2])
        fence = null;
      else if (fence.shell) {
        const cmd = text
          .trim()
          .replace(/^(\$|>|PS[^>]*>)\s+/, '')
          .trim();
        if (cmd && !cmd.startsWith('#') && !/^rem\s/i.test(cmd)) add('command', cmd);
      }
      return;
    }
    if (f) {
      fence = { marker: f[1], shell: SHELL_FENCES.has(f[2].toLowerCase()) };
      return;
    }
    lineClaims(text, add);
  });
  return claims;
}

export function docClaims(repo, { summary = false } = {}) {
  repo = resolve(repo);
  if (!existsSync(repo) || git(repo, ['rev-parse', '--is-inside-work-tree']) !== 'true')
    return { repo, error: 'not a git work tree; claims were NOT counted' };
  // A subdirectory would match no docs (paths are toplevel-relative): count the whole repo and say so.
  let resolvedFrom;
  if (git(repo, ['rev-parse', '--show-prefix'])) {
    const top = git(repo, ['rev-parse', '--show-toplevel']);
    if (!top) return { repo, error: 'git toplevel not found; claims were NOT counted' };
    resolvedFrom = repo;
    repo = resolve(top);
  }
  const listed = git(repo, ['-c', 'core.quotepath=off', 'ls-files', '-z']) ?? '';
  const docs = listed.split('\0').filter((f) => f && isDocPath(f));
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const byDoc = {};
  const claims = [];
  let scanned = 0;
  for (const doc of docs) {
    let content;
    try {
      content = readFileSync(join(repo, doc), 'utf8'); // tracked but deleted in the work tree: skip
    } catch {
      continue;
    }
    scanned++;
    const found = extractClaims(content, doc);
    byDoc[doc] = found.length;
    for (const c of found) byKind[c.kind]++;
    claims.push(...found);
  }
  const out = { repo };
  if (resolvedFrom) Object.assign(out, { resolvedFrom, note: `resolved from ${resolvedFrom}` });
  Object.assign(out, { docs: scanned, total: claims.length, byKind, byDoc });
  if (!summary) out.claims = claims;
  return out;
}

if (isMain(import.meta.url)) {
  // --summary takes no value: pull it out before parseArgs, which would swallow the next repo as its value.
  const argv = process.argv.slice(2);
  const summary = argv.includes('--summary');
  const a = parseArgs(argv.filter((x) => x !== '--summary'));
  const unknown = Object.keys(a).filter((k) => k !== '_');
  const dashed = a._.find((x) => /^-./.test(x)); // -h, -x: single-dash options are not supported
  if (!a._.length || unknown.length || dashed) {
    if (unknown.length) console.error(`doc-claims: unknown option --${unknown[0]}`);
    else if (dashed) console.error(`doc-claims: unknown option ${dashed}`);
    console.error('usage: doc-claims.mjs [--summary] <repo>...');
    process.exit(3);
  }
  const repos = a._.map((r) => docClaims(r, { summary }));
  console.log(JSON.stringify({ repos }, null, 2));
  process.exit(repos.some((r) => r.error) ? 1 : 0);
}
