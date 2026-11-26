#!/usr/bin/env node
// Usage: node canary.mjs make <job> --seed <s> --out <dir>
//        node canary.mjs grade <job> --expected <expected.json> --answer <answerfile>
// Known-answer items slipped into hive batches, so a cheap model's accuracy is measured, not assumed.
// <job> is one of inventory|drift|graph|digest|review. `make` writes the item a bee is handed under <dir>/item/
// (inventory/drift: a fixture repo folder; digest: item/session.md; graph: item/slice.md; review: item/artifact.md)
// and the hidden key to <dir>/expected.json, never inside item/. Names come from a hash of the seed, so a model
// cannot memorise them across runs. Every canary plants BOTH a defect the bee must report and a true claim it
// must not flag. It prints {job, itemPath, expectedPath}. It refuses to overwrite an existing <dir>/item.
// `grade` reads the bee's answer in the mandated line format, one finding per line:
//   CLAIM | <kind> | <ref> | <text>
// Kinds are case-insensitive; a leading list marker ("- ", "* ", "1. ") and backticks around the line are
// tolerated; other lines are ignored. It prints {pass, found, missed, falsePositives}; pass = nothing missed and
// no false positive. Every claim is checked against the forbid rules, even one that satisfies an expectation.
// Forbid rules match on <ref> only, so a correct claim whose text merely mentions the true claim is not penalised.
// Exit 0 = make done / grade passed; 2 = grade failed; 3 = bad arguments or input.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, isMain } from './lib.mjs';

export const JOBS = ['inventory', 'drift', 'graph', 'digest', 'review'];
export const KINDS = [
  'done',
  'promised',
  'unfinished',
  'decided',
  'goal',
  'command',
  'doc-stale',
  'code-missing',
  'code-diverged',
  'undocumented',
  'dead-ref',
  'orphan',
  'hotspot',
  'mismatch',
  'risk',
  'error',
];
const PROBLEM_KINDS = [
  'doc-stale',
  'code-missing',
  'code-diverged',
  'undocumented',
  'dead-ref',
  'orphan',
  'hotspot',
  'mismatch',
  'risk',
  'error',
];

// ---------- deterministic picks ----------
const hashInt = (job, seed, label) =>
  createHash('sha256').update(`${job}\0${seed}\0${label}`).digest().readUInt32BE(0);
function picker(job, seed) {
  const pick = (list, label) => list[hashInt(job, seed, label) % list.length];
  // Picks `n` distinct entries (a seeded shuffle of the list).
  const pickN = (list, n, label) =>
    list
      .map((v, i) => [hashInt(job, seed, `${label}#${i}`), v])
      .sort((a, b) => a[0] - b[0] || String(a[1]).localeCompare(String(b[1])))
      .slice(0, n)
      .map((x) => x[1]);
  const int = (lo, hi, label) => lo + (hashInt(job, seed, label) % (hi - lo + 1));
  return { pick, pickN, int };
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);

const SCRIPT_VERBS = [
  'sync',
  'reindex',
  'export',
  'audit',
  'compact',
  'migrate',
  'snapshot',
  'verify',
];
const SCRIPT_VERBS_B = [
  'prune',
  'bundle',
  'render',
  'publish',
  'backfill',
  'warm',
  'replay',
  'rotate',
];
const SCRIPT_NOUNS = [
  'ledger',
  'catalog',
  'roster',
  'tariffs',
  'manifest',
  'payouts',
  'schedule',
  'quotas',
];
const SCRIPT_NOUNS_B = [
  'receipts',
  'vouchers',
  'parcels',
  'rebates',
  'fixtures',
  'webhooks',
  'glossary',
  'mirrors',
];
const FN_VERBS = [
  'compute',
  'resolve',
  'normalize',
  'collect',
  'tally',
  'apportion',
  'estimate',
  'derive',
];
const OTHER_VERBS = [
  'backfill',
  'throttle',
  'dedupe',
  'paginate',
  'debounce',
  'replay',
  'expire',
  'reshard',
];
const FN_NOUNS = [
  'Rebate',
  'Shipment',
  'Voucher',
  'Tariff',
  'Coupon',
  'Allowance',
  'Surcharge',
  'Refund',
  'Deposit',
  'Penalty',
  'Discount',
  'Levy',
];
const FILES = [
  'billing',
  'shipping',
  'pricing',
  'orders',
  'payouts',
  'accounts',
  'returns',
  'settlement',
];
const PROJECT_A = [
  'harbor',
  'copper',
  'tidal',
  'granite',
  'saffron',
  'meridian',
  'juniper',
  'basalt',
];
const PROJECT_B = ['ledger', 'works', 'desk', 'relay', 'forge', 'yard', 'post', 'mill'];
const GRAPH_VERBS = [
  'load',
  'save',
  'build',
  'apply',
  'check',
  'emit',
  'split',
  'queue',
  'lookup',
  'merge',
  'flush',
  'bind',
];
const GRAPH_NOUNS = [
  'Order',
  'Invoice',
  'Cart',
  'Session',
  'Token',
  'Report',
  'Batch',
  'Profile',
  'Quote',
  'Credit',
  'Route',
  'Bucket',
];
const MODULES = [
  'checkout',
  'fulfilment',
  'statements',
  'onboarding',
  'reconciliation',
  'notifications',
];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// ---------- inventory / drift: a fixture repo ----------
function repoCanary(job, seed, itemDir) {
  const { pick, pickN, int } = picker(job, seed);
  const project = `${pick(PROJECT_A, 'projA')}-${pick(PROJECT_B, 'projB')}`;
  const realScript = `${pick(SCRIPT_VERBS, 'realV')}:${pick(SCRIPT_NOUNS, 'realN')}`;
  const missingScript = `${pick(SCRIPT_VERBS_B, 'missV')}:${pick(SCRIPT_NOUNS_B, 'missN')}`;
  const [fnNoun, helperNoun, otherNoun] = pickN(FN_NOUNS, 3, 'fnNouns');
  const [fnVerb, helperVerb] = pickN(FN_VERBS, 2, 'fnVerbs');
  const fn = `${fnVerb}${fnNoun}`;
  const helper = `${helperVerb}${helperNoun}`;
  const fmt = `format${otherNoun}`;
  const [file, file2] = pickN(FILES, 2, 'files');
  const rate = int(3, 19, 'rate');
  const port = int(3100, 3999, 'port');

  mkdirSync(join(itemDir, 'src'), { recursive: true });
  mkdirSync(join(itemDir, 'docs'), { recursive: true });
  mkdirSync(join(itemDir, 'test'), { recursive: true });
  writeFileSync(
    join(itemDir, 'test', `${file}.test.js`),
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ${fn}, ${helper} } from '../src/${file}.js';

test('${fn} sums amounts and rounds to cents', () => {
  assert.equal(${fn}([{ amount: 1.25 }, { amount: '2.10' }, {}]), 3.35);
});

test('${helper} applies the ${rate}% rate', () => {
  assert.equal(${helper}({ id: 'a', amount: 100 }).amount, ${100 + rate});
});
`,
  );
  writeFileSync(
    join(itemDir, 'package.json'),
    JSON.stringify(
      {
        name: project,
        version: `0.${int(1, 9, 'minor')}.${int(0, 9, 'patch')}`,
        private: true,
        type: 'module',
        main: 'src/index.js',
        scripts: {
          start: 'node src/index.js',
          test: 'node --test',
          [realScript]: `node src/index.js --${realScript.replace(':', '-')}`,
        },
        engines: { node: '>=18' },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(itemDir, 'README.md'),
    `# ${project}

Small service that turns ${file} records into totals for the finance team. It listens on port ${port}
and is deployed as a single Node process.

## Setup

\`\`\`sh
npm install
npm start
\`\`\`

Run the unit tests with \`npm test\`; they live in \`test/\`.

## Maintenance scripts

- \`npm run ${realScript}\` refreshes the local ${realScript.split(':')[1]} cache before a month-end close.
- \`npm run ${missingScript}\` clears stale ${missingScript.split(':')[1]} older than 90 days.

## Code map

- \`${fn}(lines)\` in \`src/${file}.js\` returns the total of \`amount\` across the given lines, rounded to cents.
- \`${helper}(record)\` in \`src/${file}.js\` applies the ${rate}% ${helperNoun.toLowerCase()} rate to one record.
- \`src/${file2}.js\` holds the ${file2} adapters; \`src/util.js\` has shared helpers such as \`${fmt}\`.

See \`docs/operations.md\` for the month-end checklist.
`,
  );
  writeFileSync(
    join(itemDir, 'src', `${file}.js`),
    `// ${cap(file)} totals.
import { roundCents } from './util.js';

export const ${helperNoun.toUpperCase()}_RATE = ${rate / 100};

export function ${fn}(lines) {
  const total = lines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
  return roundCents(total);
}

export function ${helper}(record) {
  return { ...record, amount: roundCents(record.amount * (1 + ${helperNoun.toUpperCase()}_RATE)) };
}

export function splitByCustomer(lines) {
  const out = new Map();
  for (const line of lines) {
    const list = out.get(line.customerId) ?? [];
    list.push(line);
    out.set(line.customerId, list);
  }
  return out;
}
`,
  );
  writeFileSync(
    join(itemDir, 'src', `${file2}.js`),
    `// ${cap(file2)} adapters: map raw rows from the upstream export into line records.
export function fromRow(row) {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    amount: Number(row.amount_cents) / 100,
    postedAt: new Date(row.posted_at),
  };
}

export function isPosted(line) {
  return line.postedAt instanceof Date && !Number.isNaN(line.postedAt.getTime());
}
`,
  );
  writeFileSync(
    join(itemDir, 'src', 'util.js'),
    `export const roundCents = (n) => Math.round(n * 100) / 100;

export function ${fmt}(n, currency = 'AUD') {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(n);
}
`,
  );
  writeFileSync(
    join(itemDir, 'src', 'index.js'),
    `import { createServer } from 'node:http';
import { ${fn} } from './${file}.js';
import { fromRow, isPosted } from './${file2}.js';

const PORT = Number(process.env.PORT) || ${port};

if (process.argv.includes('--${realScript.replace(':', '-')}')) {
  console.log('refreshing ${realScript.split(':')[1]} cache');
  process.exit(0);
}

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const rows = body ? JSON.parse(body) : [];
    const lines = rows.map(fromRow).filter(isPosted);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ total: ${fn}(lines) }));
  });
}).listen(PORT);
`,
  );
  writeFileSync(
    join(itemDir, 'docs', 'operations.md'),
    `# Month-end operations

1. Confirm the upstream ${file2} export finished (the job posts to the #finance channel).
2. Run \`npm run ${realScript}\` on the ops box.
3. POST the export rows to \`http://localhost:${port}/\` and keep the returned total for the close pack.
4. Compare the total with the bank statement; differences over $1.00 go to the finance lead.

Totals are rounded to cents by \`roundCents\` in \`src/util.js\`.
`,
  );

  const facts = { project, realScript, missingScript, fn, file };
  // Forbids match the claim's ref only: a correct claim about something else may mention these names in its text.
  const forbid = [
    {
      id: 'true-function',
      kinds: ['code-missing', 'dead-ref', 'code-diverged'],
      needles: [fn],
      where: 'ref',
    },
    { id: 'real-script', kinds: ['code-missing', 'dead-ref'], needles: [realScript], where: 'ref' },
    {
      id: 'missing-script-not-command',
      kinds: ['command'],
      needles: [missingScript],
      where: 'ref',
    },
  ];
  const expect =
    job === 'drift'
      ? [
          {
            id: 'dead-script',
            kinds: ['dead-ref', 'code-missing'],
            needles: [missingScript],
            where: 'ref',
          },
        ]
      : [
          { id: 'real-command', kinds: ['command'], needles: [realScript], where: 'any' },
          {
            id: 'missing-script',
            kinds: [...PROBLEM_KINDS, 'promised'],
            needles: [missingScript],
            where: 'any',
          },
        ];
  return { itemPath: itemDir, facts, expect, forbid };
}

// ---------- digest: a session transcript ----------
function digestCanary(job, seed, itemDir) {
  const { pick, int } = picker(job, seed);
  const noun = pick(FN_NOUNS, 'noun');
  const symbol = `${pick(FN_VERBS, 'verb')}${noun}s`;
  const other = `${pick(OTHER_VERBS, 'other')}${pick(FN_NOUNS, 'otherNoun')}Job`;
  const file = pick(FILES, 'file');
  const tests = int(9, 40, 'tests');
  const path = join(itemDir, 'session.md');
  writeFileSync(
    path,
    `## User
Can you remind me how the ${file} module rounds amounts? I keep seeing one-cent differences in the close pack.

## Assistant
\`src/${file}.js\` rounds each total once, at the end, with \`roundCents\` from \`src/util.js\`. The one-cent
differences come from the upstream export, which rounds per line. Rounding per line here as well would match it,
but it would also change every historical total, so I left it as is.

## User
Fine, leave it. Next: add a \`${symbol}\` function to \`src/${file}.js\` that groups lines by customer and returns
the ${noun.toLowerCase()} total for each one. Also write the \`${other}\` so the old records get re-processed overnight.

## Assistant
Added \`${symbol}\` to \`src/${file}.js\`. It reuses \`splitByCustomer\` and returns a Map of customer id to the
rounded ${noun.toLowerCase()} total. I added three unit tests for it; the suite passes (${tests}/${tests}).

I did not get to \`${other}\`: it needs the scheduler credentials and a decision on how far back to re-process,
so it is still open.

## User
ok. what's the lint status?

## Assistant
\`npm run lint\` reports no errors. There are two warnings about unused imports in \`src/index.js\`; they predate this
session and I have not touched them.
`,
  );
  return {
    itemPath: path,
    facts: { symbol, other, file },
    expect: [
      { id: 'done-symbol', kinds: ['done'], needles: [symbol], where: 'ref' },
      { id: 'unfinished-other', kinds: ['unfinished'], needles: [other], where: 'any' },
    ],
    forbid: [
      { id: 'symbol-not-unfinished', kinds: ['unfinished'], needles: [symbol], where: 'ref' },
      { id: 'other-not-done', kinds: ['done'], needles: [other], where: 'ref' },
    ],
  };
}

// ---------- graph: a slice with caller counts ----------
function graphCanary(job, seed, itemDir) {
  const { pick, pickN, int } = picker(job, seed);
  const verbs = pickN(GRAPH_VERBS, 10, 'verbs');
  const nouns = pickN(GRAPH_NOUNS, 10, 'nouns');
  const syms = verbs.map((v, i) => `${v}${nouns[i]}`);
  const [hub, orphan, missing, documentedPresent, ...rest] = syms;
  const module = pick(MODULES, 'module');
  const files = [
    `src/${module}/index.js`,
    `src/${module}/store.js`,
    `src/${module}/rules.js`,
    `src/${module}/api.js`,
  ];
  const sha = createHash('sha1').update(`${seed}`).digest('hex').slice(0, 7);
  const rows = [
    [hub, 'function', files[1], int(14, 31, 'hubCalls')],
    [documentedPresent, 'function', files[2], int(2, 6, 'docCalls')],
    ...rest.map((s, i) => [
      s,
      i % 3 === 0 ? 'method' : 'function',
      files[i % files.length],
      int(1, 9, `c${i}`),
    ]),
    [orphan, 'function', files[2], 0],
  ];
  // Seeded order so the orphan is not always last.
  const order = pickN(
    rows.map((_, i) => i),
    rows.length,
    'order',
  );
  const lineNo = (s) => int(5, 240, `ln-${s}`);
  const table = order
    .map((i) => rows[i])
    .map(([s, k, f, c]) => `| ${s} | ${k} | ${f}:${lineNo(s)} | ${c} |`)
    .join('\n');
  const edges = [
    ...rest.map((s) => `- ${s} -> ${hub}`),
    `- ${documentedPresent} -> ${hub}`,
    `- ${rest[0]} -> ${documentedPresent}`,
    `- ${rest[1]} -> ${rest[2]}`,
    `- ${rest[3]} -> ${rest[4]}`,
  ].join('\n');
  const path = join(itemDir, 'slice.md');
  writeFileSync(
    path,
    `# Graph slice: ${module}

Engine: knowledge-graph. Built at commit ${sha}. Callers = distinct call sites across the repo, tests excluded.

| Symbol | Kind | Location | Callers |
|---|---|---|---|
${table}

## Call edges (caller -> callee, sample)

${edges}

## Symbols named in docs

- \`${documentedPresent}\` (docs/${module}.md:${int(10, 40, 'd1')}): "validates the rules before an order is accepted"
- \`${hub}\` (docs/${module}.md:${int(41, 70, 'd2')}): "single entry point for persistence"
- \`${missing}\` (docs/${module}.md:${int(71, 99, 'd3')}): "called after every successful ${module} step"
`,
  );
  return {
    itemPath: path,
    facts: { module, hub, orphan, missing, documentedPresent },
    expect: [
      { id: 'orphan', kinds: ['orphan'], needles: [orphan], where: 'any' },
      { id: 'doc-only-symbol', kinds: ['mismatch'], needles: [missing], where: 'any' },
    ],
    forbid: [
      { id: 'hub-not-orphan', kinds: ['orphan'], needles: [hub], where: 'ref' },
      { id: 'documented-present', kinds: ['mismatch'], needles: [documentedPresent], where: 'ref' },
    ],
  };
}

// ---------- review: a plan artifact ----------
function reviewCanary(job, seed, itemDir) {
  const { pick, int } = picker(job, seed);
  const pfx = pick([...LETTERS], 'p1') + pick([...LETTERS], 'p2');
  const id = (n) => `${pfx}-${String(n).padStart(2, '0')}`;
  const noun = pick(GRAPH_NOUNS, 'noun');
  const variant = hashInt(job, seed, 'variant') % 2 ? 'contradiction' : 'forward-dependency';
  const tasks = [
    {
      t: `Schema for ${noun.toLowerCase()} export records`,
      deps: [],
      ac: `migration adds the export_jobs table; rollback drops it cleanly`,
    },
    {
      t: `Repository reads ${noun.toLowerCase()} rows in pages`,
      deps: [1],
      ac: `reads 50k rows in pages of 1,000 without loading all rows into memory`,
    },
    {
      t: `CSV serializer`,
      deps: [2],
      ac: `output is RFC 4180 CSV with a header row; UTF-8 without BOM`,
    },
    {
      t: `Export endpoint`,
      deps: [3],
      ac: `GET /exports/${noun.toLowerCase()}s returns text/csv for up to 10k rows`,
    },
    {
      t: `Background job for large exports`,
      deps: [4],
      ac: `exports over 10k rows run as a job and email a CSV download link`,
    },
    {
      t: `Audit log entries`,
      deps: [4],
      ac: `every export writes who, when and the row count to the audit log`,
    },
    {
      t: `Docs and runbook`,
      deps: [5, 6],
      ac: `README and runbook describe both export paths and the 10k threshold`,
    },
  ];
  let defect,
    related = null,
    defectNote;
  if (variant === 'forward-dependency') {
    defect = int(2, 4, 'defect');
    related = int(defect + 2, 7, 'later');
    tasks[defect - 1].deps = [defect - 1, related];
    defectNote = `depends on ${id(related)}, which comes later`;
  } else {
    defect = int(3, 5, 'defect');
    tasks[defect - 1].ac = {
      3: 'output is an .xlsx workbook with one sheet and a header row',
      4: `GET /exports/${noun.toLowerCase()}s returns an .xlsx workbook for up to 10k rows`,
      5: 'exports over 10k rows run as a job and email an .xlsx download link',
    }[defect];
    defectNote = 'acceptance asks for XLSX but the summary says CSV only';
  }
  const cleanPool = [1, 2, 6, 7].filter((n) => n !== defect && n !== related);
  const clean = cleanPool[hashInt(job, seed, 'clean') % cleanPool.length];
  const body = tasks
    .map(
      (x, i) => `### ${id(i + 1)}: ${x.t}

- Depends on: ${x.deps.length ? x.deps.map(id).join(', ') : 'none'}
- Estimate: ${int(1, 5, `est${i}`)}d
- Acceptance: ${x.ac}
`,
    )
    .join('\n');
  const path = join(itemDir, 'artifact.md');
  writeFileSync(
    path,
    `# Plan: ${noun} export

## Summary

Finance needs to pull ${noun.toLowerCase()} data out of the app without asking engineering. This release ships a
CSV export only; XLSX is out of scope until the reporting rewrite. Small exports are served inline; large ones
run as a background job.

Tasks run in the order listed, and a task may depend only on tasks above it.

## Tasks

${body}
## Out of scope

- XLSX and PDF output
- Scheduled (recurring) exports
`,
  );
  return {
    itemPath: path,
    facts: {
      prefix: pfx,
      variant,
      defectTask: id(defect),
      relatedTask: related ? id(related) : null,
      cleanTask: id(clean),
      defectNote,
    },
    expect: [
      {
        id: 'defect-task',
        kinds: ['error', 'risk'],
        needles: related ? [id(defect), id(related)] : [id(defect)],
        where: 'ref',
      },
    ],
    forbid: [{ id: 'clean-task', kinds: ['error', 'risk'], needles: [id(clean)], where: 'ref' }],
  };
}

const BUILDERS = {
  inventory: repoCanary,
  drift: repoCanary,
  digest: digestCanary,
  graph: graphCanary,
  review: reviewCanary,
};

export function makeCanary(job, { seed, out }) {
  if (!JOBS.includes(job)) throw new Error(`unknown job "${job}" (expected ${JOBS.join('|')})`);
  if (typeof seed !== 'string' || !seed) throw new Error('--seed needs a value');
  if (typeof out !== 'string' || !out) throw new Error('--out needs a value');
  out = resolve(out);
  const itemDir = join(out, 'item');
  if (existsSync(itemDir)) throw new Error(`${itemDir} already exists; use a fresh --out`);
  mkdirSync(itemDir, { recursive: true });
  const built = BUILDERS[job](job, seed, itemDir);
  const expectedPath = join(out, 'expected.json');
  const key = {
    version: 1,
    job,
    seed,
    facts: built.facts,
    expect: built.expect,
    forbid: built.forbid,
  };
  writeFileSync(expectedPath, JSON.stringify(key, null, 2) + '\n');
  return { job, itemPath: built.itemPath, expectedPath };
}

// ---------- grading ----------
const KIND_SET = new Set(KINDS);
const LINE = /^\s*CLAIM\s*\|(.*)$/i;
// Optional list marker ("- ", "* ", "+ ", "1. ", "1) ") before the line.
const MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
// Backticks wrapping the whole line (same count on both sides): `CLAIM | ... |`.
const FENCE = /^(`+)\s*(CLAIM\b.*?)\s*\1$/i;

export function parseClaims(text) {
  const claims = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.trim().replace(MARKER, '');
    const f = FENCE.exec(line);
    if (f) line = f[2];
    const m = LINE.exec(line);
    if (!m) continue;
    const parts = m[1].split('|');
    if (parts.length < 3) continue;
    const kind = parts[0].trim().toLowerCase();
    if (!KIND_SET.has(kind)) continue;
    claims.push({ kind, ref: parts[1].trim(), text: parts.slice(2).join('|').trim() });
  }
  return claims;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-name match: the needle may not be glued to a longer identifier on either side.
const mentions = (hay, needle) =>
  new RegExp(`(^|[^A-Za-z0-9_])${esc(needle)}(?![A-Za-z0-9_])`, 'i').test(hay);
const hits = (claim, rule) =>
  rule.kinds.map((k) => k.toLowerCase()).includes(claim.kind) &&
  rule.needles.some((n) =>
    mentions(rule.where === 'ref' ? claim.ref : `${claim.ref} ${claim.text}`, n),
  );
const show = (c) => `CLAIM | ${c.kind} | ${c.ref} | ${c.text}`;

export function gradeAnswer(key, answerText) {
  if (!key || !Array.isArray(key.expect) || !Array.isArray(key.forbid))
    throw new Error('expected file has no expect/forbid arrays');
  const claims = parseClaims(answerText);
  const found = [];
  const missed = [];
  for (const rule of key.expect) {
    const match = claims.filter((c) => hits(c, rule));
    if (match.length) found.push({ id: rule.id, claim: show(match[0]) });
    else missed.push({ id: rule.id, kinds: rule.kinds, needles: rule.needles });
  }
  // Every claim is checked against the forbid rules, including one that also satisfies an expectation:
  // a line that flags the defect AND the true claim together is still a false positive.
  const falsePositives = [];
  for (const c of claims) {
    const rule = key.forbid.find((r) => hits(c, r));
    if (rule) falsePositives.push({ id: rule.id, claim: show(c) });
  }
  return { pass: !missed.length && !falsePositives.length, found, missed, falsePositives };
}

// ---------- CLI ----------
const fail = (code, msg) => {
  console.error(`canary: ${msg}`);
  process.exit(code);
};

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const glued = argv.find((a) => /^--[^=]+=/.test(a));
  if (glued) {
    const name = glued.slice(2, glued.indexOf('='));
    fail(
      3,
      `"${glued.length > 60 ? glued.slice(0, 60) + '...' : glued}" is not supported; pass --${name} <value> as two arguments`,
    );
  }
  const args = parseArgs(argv);
  const [cmd, job, ...extra] = args._;
  if (extra.length)
    fail(
      3,
      `unexpected argument "${extra[0]}" (usage: canary.mjs make|grade <job> --flag <value> ...)`,
    );
  for (const k of ['seed', 'out', 'expected', 'answer'])
    if (args[k] === true) fail(3, `--${k} needs a value`);
  if (!['make', 'grade'].includes(cmd)) fail(3, 'usage: canary.mjs make|grade <job> ...');
  if (!JOBS.includes(job)) fail(3, `job must be one of ${JOBS.join('|')}`);
  if (cmd === 'make') {
    if (!args.seed) fail(3, '--seed is required');
    if (!args.out) fail(3, '--out is required');
    let res;
    try {
      res = makeCanary(job, { seed: String(args.seed), out: String(args.out) });
    } catch (e) {
      fail(3, e.message);
    }
    console.log(JSON.stringify(res, null, 2));
  } else {
    if (!args.expected) fail(3, '--expected is required');
    if (!args.answer) fail(3, '--answer is required');
    let key, answer, result;
    try {
      key = JSON.parse(readFileSync(args.expected, 'utf8'));
      answer = readFileSync(args.answer, 'utf8');
      if (key?.job !== job) throw new Error(`expected file is for job "${key?.job}", not "${job}"`);
      result = gradeAnswer(key, answer);
    } catch (e) {
      fail(3, `bad input: ${e.message}`);
    }
    console.log(JSON.stringify({ job, ...result }, null, 2));
    process.exit(result.pass ? 0 : 2);
  }
}
