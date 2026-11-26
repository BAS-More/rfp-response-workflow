// node:test reporter used by run-tests.mjs. Emits {"<file basename>": <tests executed>} as JSON.
// Skipped and todo tests and describe() suites do not count. A file that registers no tests is reported by node as one passing
// test named after the file (its path as given on the command line); that synthetic entry does not count either.
import { basename } from 'node:path';

export default async function* countReporter(source) {
  const counts = {};
  for await (const e of source) {
    if (e.type !== 'test:pass' && e.type !== 'test:fail') continue;
    const d = e.data;
    if (!d.file) continue;
    const file = basename(d.file);
    counts[file] ??= 0;
    if (
      d.skip ||
      d.todo ||
      d.details?.type === 'suite' ||
      (d.nesting === 0 && basename(d.name) === file)
    )
      continue;
    counts[file] += 1;
  }
  yield JSON.stringify(counts);
}
