#!/usr/bin/env node
// Usage: node doc-refs.mjs <repo>...
// Deterministic drift pre-pass: every path or `npm run <x>` that a tracked .md file references,
// checked against the working tree and package.json scripts. Reports what does NOT exist, ranked by
// confidence. It finds dead references only; semantic drift (docs say X, code does Y) is the model's job.
// Exits 1 with {error} for a path that is not a git work tree (zero findings would look like zero drift).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { git, lines, parseArgs, isMain } from './lib.mjs';

const PATHISH = /^(\.{1,2}\/)?[\w@.-]+(\/[\w@.-]+)*\/?$/;
const HAS_EXT = (s) => /\.[a-z0-9]{1,5}$/i.test(s);
const HAS_SHAPE = (s) => s.includes('/') || HAS_EXT(s);
const SKIP = (s) =>
  /^[a-z]+:\/\//i.test(s) ||
  /[<>*{}$~]/.test(s) ||
  s.includes('...') ||
  s.startsWith('#') ||
  s.startsWith('/') ||
  /^[A-Za-z]:[\\/]/.test(s) ||
  /^[\w-]+\/$/.test(s); // single-segment "chore/" is a branch prefix far more often than a dir

// high: has a directory AND an extension, so it is unambiguously a file path; npm scripts are exact names.
// medium: markdown link target. low: bare filename or extension-less "a/b" (owner/repo, branch, artifact).
const confidence = (ref, link) =>
  link ? 'medium' : ref.includes('/') && HAS_EXT(ref) ? 'high' : 'low';

function npmScripts(repo, files) {
  const names = new Set();
  for (const f of files.filter((f) => /(^|\/)package\.json$/.test(f))) {
    try {
      Object.keys(JSON.parse(readFileSync(join(repo, f), 'utf8')).scripts ?? {}).forEach((k) =>
        names.add(k),
      );
    } catch {
      /* skip */
    }
  }
  return names;
}

export function docRefs(repo) {
  repo = resolve(repo);
  if (!existsSync(repo) || git(repo, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return { repo, error: 'not a git work tree; doc drift was NOT checked' };
  }
  // Files deleted in the working tree are still in the index; they must count as missing.
  const deleted = new Set(lines(git(repo, ['ls-files', '--deleted'])));
  const files = lines(git(repo, ['ls-files'])).filter((f) => !deleted.has(f));
  const scripts = npmScripts(repo, files);
  // Every "/"-joined tail of every tracked path (files and their parent dirs): O(files x depth) once, O(1) per ref.
  const suffixes = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let end = parts.length; end > 0; end--)
      for (let i = 0; i < end; i++) suffixes.add(parts.slice(i, end).join('/'));
  }
  const exists = (p) => existsSync(p) && !deleted.has(p.slice(repo.length + 1).replace(/\\/g, '/'));
  const trackedSomewhere = (ref) =>
    suffixes.has(ref.replace(/^(\.{1,2}\/)+/, '').replace(/\/$/, ''));

  const missing = [];
  let checked = 0;
  for (const doc of files.filter((f) => f.toLowerCase().endsWith('.md'))) {
    const docDir = dirname(join(repo, doc));
    readFileSync(join(repo, doc), 'utf8')
      .split(/\r?\n/)
      .forEach((text, i) => {
        const refs = [];
        for (const m of text.matchAll(/`([^`\s]+)`/g)) refs.push({ ref: m[1], link: false });
        for (const m of text.matchAll(/\]\(\s*<?([^)\s#>]+)>?(?:#[^)\s]*)?(?:\s+["'(][^)]*)?\)/g))
          refs.push({ ref: m[1], link: true });
        const def = text.match(/^\s{0,3}\[[^\]]+\]:\s*<?([^\s>#]+)/);
        if (def) refs.push({ ref: def[1], link: true });
        for (const m of text.matchAll(/npm run ([\w:-]+(?:\.[\w:-]+)*)/g)) {
          checked++;
          if (scripts.size && !scripts.has(m[1]))
            missing.push({
              doc,
              line: i + 1,
              ref: `npm run ${m[1]}`,
              kind: 'npm-script',
              confidence: 'high',
            });
        }
        for (const { ref, link } of refs) {
          if (SKIP(ref) || !PATHISH.test(ref) || !HAS_SHAPE(ref)) continue;
          checked++;
          // Links resolve relative to the doc; bare code spans may be repo-relative, doc-relative, or a path tail.
          const ok =
            exists(join(docDir, ref)) ||
            (!link && (exists(join(repo, ref)) || trackedSomewhere(ref)));
          if (!ok)
            missing.push({
              doc,
              line: i + 1,
              ref,
              kind: link ? 'link' : 'path',
              confidence: confidence(ref, link),
            });
        }
      });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  missing.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
  const byConfidence = missing.reduce(
    (acc, m) => ((acc[m.confidence] = (acc[m.confidence] ?? 0) + 1), acc),
    {},
  );
  return { repo, checked, missingCount: missing.length, byConfidence, missing };
}

if (isMain(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (!a._.length) {
    console.error('usage: doc-refs.mjs <repo>...');
    process.exit(2);
  }
  const out = a._.map(docRefs);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.some((r) => r.error) ? 1 : 0);
}
