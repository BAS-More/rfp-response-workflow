#!/usr/bin/env node
// Usage: node run-tests.mjs [test-dir]   (default: the test/ folder next to this file)
// Runs every *.test.mjs in test-dir by explicit path. `node --test "<abs path>/*.test.mjs"` through a path
// that contains a space matches nothing and still exits 0, so a broken self-test looked green. Here the run
// fails unless every file executed at least one test that was not skipped or todo.
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(process.argv[2] ?? join(here, 'test'));
const files = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => f.endsWith('.test.mjs'))
      .sort()
      .map((f) => join(dir, f))
  : [];
if (!files.length) {
  console.error(`run-tests: no *.test.mjs files in ${dir}`);
  process.exit(1);
}
// NODE_TEST_CONTEXT is set when this runs under another node --test; inherited, it turns the child into a
// subtest stream that never reaches the reporters below.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const counts = join(mkdtempSync(join(tmpdir(), 'rac-count-')), 'counts.json');
const r = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    `--test-reporter=${pathToFileURL(join(here, 'count-reporter.mjs')).href}`,
    `--test-reporter-destination=${counts}`,
    ...files,
  ],
  { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'inherit'] },
);
process.stdout.write(r.stdout ?? '');
if (r.status !== 0) process.exit(r.status ?? 1);
let ran = {};
try {
  ran = JSON.parse(readFileSync(counts, 'utf8'));
} catch {
  /* no report: every file counts as 0 */
}
const empty = files.filter((f) => !ran[basename(f)]);
if (empty.length) {
  console.error(
    `run-tests: no test executed in ${empty.map((f) => basename(f)).join(', ')}; treat the self-test as FAILED`,
  );
  process.exit(1);
}
