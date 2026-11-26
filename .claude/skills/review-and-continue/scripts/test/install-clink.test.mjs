// Run: node <skill>/scripts/run-tests.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  palSupportsRunner,
  planInstall,
  renderClient,
  collectFlag,
  checkAddDir,
  readScopes,
} from '../install-clink.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(SKILL, 'scripts', 'install-clink.mjs');
const SOURCE = join(SKILL, 'pal', 'cli_clients');

// Every temp dir this file makes is created here and removed when the file's tests finish.
const made = [];
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function fakePal({ runner }) {
  const dir = tmp('rac-pal-');
  mkdirSync(join(dir, 'clink'));
  writeFileSync(
    join(dir, 'clink', 'models.py'),
    [
      'class CLIClientConfig(BaseModel):',
      '    name: str',
      runner ? '    runner: str | None = None' : '    command: str | None = None',
      '',
      'class ResolvedCLIClient(BaseModel):',
      '    runner: str | None = None',
      '',
    ].join('\n'),
  );
  return dir;
}
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('palSupportsRunner reads the raw config model, not the resolved one', () => {
  assert.equal(palSupportsRunner(fakePal({ runner: true })), true);
  // Stock PAL has `runner` only on ResolvedCLIClient; a config with runner would still be rejected there.
  assert.equal(palSupportsRunner(fakePal({ runner: false })), false);
  assert.equal(palSupportsRunner(join(tmpdir(), 'rac-no-pal-here')), false);
});

test('palSupportsRunner is not fooled by a docstring, a string or a later function that mentions runner', () => {
  const pal = (body) => {
    const dir = tmp('rac-pal-');
    mkdirSync(join(dir, 'clink'));
    writeFileSync(join(dir, 'clink', 'models.py'), body);
    return dir;
  };
  assert.equal(
    palSupportsRunner(
      pal(
        'class CLIClientConfig(BaseModel):\n    """Fields.\n    runner: not here yet\n    """\n    name: str\n',
      ),
    ),
    false,
  );
  assert.equal(
    palSupportsRunner(
      pal(
        'class CLIClientConfig(BaseModel):\n    name: str\n\ndef helper():\n    runner: str = "x"\n',
      ),
    ),
    false,
  );
  assert.equal(
    palSupportsRunner(
      pal(
        'class CLIClientConfig(BaseModel):\r\n    name: str\r\n    runner: str | None = Field(default=None)\r\n',
      ),
    ),
    true,
    'CRLF',
  );
});

test('palSupportsRunner accepts the BAS-More/PAL-MCP runner patch when a checkout of it is present', (t) => {
  const pr = process.env.RAC_PAL_PATCHED;
  if (!pr) {
    t.diagnostic('RAC_PAL_PATCHED not set; checked against fixtures only');
    return;
  }
  assert.equal(palSupportsRunner(pr), true);
});

test('every shipped client is read-only: only Read, Grep and Glob, dontAsk, no MCP servers, home and secret files denied', () => {
  const files = readdirSync(SOURCE).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 4);
  for (const f of files) {
    const cfg = JSON.parse(readFileSync(join(SOURCE, f), 'utf8'));
    const a = cfg.additional_args;
    const after = (flag) => a[a.indexOf(flag) + 1];
    assert.equal(cfg.runner, 'claude', f);
    const tools = a.slice(
      a.indexOf('--tools') + 1,
      a.findIndex((x, i) => i > a.indexOf('--tools') && x.startsWith('--')),
    );
    assert.deepEqual(tools, ['Read', 'Grep', 'Glob'], `${f} tools`);
    assert.equal(after('--permission-mode'), 'dontAsk', f);
    assert.ok(!a.includes('bypassPermissions'), f);
    assert.ok(a.includes('--strict-mcp-config'), f);
    assert.deepEqual(JSON.parse(after('--mcp-config')), { mcpServers: {} }, f);
    for (const rule of ['Read(~/**)', 'Read(**/.env)', 'Read(**/.env.*)', 'Read(**/.git/config)'])
      assert.ok(a.includes(rule), `${f} ${rule}`);
    // A child started from the Claude desktop app inherits CLAUDE_CODE_ENTRYPOINT=claude-desktop, which makes
    // claude -p wait for host-supplied auth and answer 'Not logged in' without calling 9router. Reset it, nothing else.
    assert.deepEqual(
      cfg.env,
      { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
      `${f} only resets the inherited entrypoint`,
    );
  }
});

test('--add-dir is written into every client, and planInstall compares the rendered file', () => {
  const target = tmp('rac-target-');
  const plan = planInstall(SOURCE, target, { addDir: 'C:\\Dev' });
  for (const p of plan) {
    const a = JSON.parse(p.content).additional_args;
    assert.deepEqual(a.slice(-2), ['--add-dir', 'C:\\Dev']);
    writeFileSync(p.dst, p.content);
  }
  assert.ok(planInstall(SOURCE, target, { addDir: 'C:\\Dev' }).every((p) => p.action === 'same'));
  assert.ok(planInstall(SOURCE, target).every((p) => p.action === 'conflict'));
});

test('a flag given without its value is an error, never a silent default', () => {
  for (const args of [
    ['--apply', '--target'],
    ['--target', '--apply', '--pal', 'x'],
    ['--pal'],
    ['--add-dir'],
  ]) {
    const r = run(...args);
    assert.equal(r.status, 3, args.join(' '));
    assert.match(r.stderr, /needs a value/);
  }
});

test('planInstall copies new files, skips identical ones and refuses to overwrite different ones', () => {
  const target = tmp('rac-target-');
  const names = readdirSync(SOURCE).filter((f) => f.endsWith('.json'));
  writeFileSync(join(target, names[0]), readFileSync(join(SOURCE, names[0])));
  writeFileSync(join(target, names[1]), '{"name":"edited by hand"}');
  const plan = planInstall(SOURCE, target);
  const by = Object.fromEntries(plan.map((p) => [p.file, p.action]));
  assert.equal(by[names[0]], 'same');
  assert.equal(by[names[1]], 'conflict');
  assert.equal(by[names[2]], 'copy');
  assert.equal(
    planInstall(SOURCE, target, { force: true }).find((p) => p.file === names[1]).action,
    'overwrite',
  );
});

test('default run is a dry run and writes nothing', () => {
  const target = join(tmp('rac-target-'), 'cli_clients');
  const r = run('--target', target, '--pal', fakePal({ runner: true }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run/);
  assert.equal(existsSync(target), false);
});

test('--apply refuses when PAL does not support the runner field, because it would break every clink call', () => {
  const target = join(tmp('rac-target-'), 'cli_clients');
  const r = run('--apply', '--target', target, '--pal', fakePal({ runner: false }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /runner/);
  assert.equal(existsSync(target), false);
});

test('--apply without --pal refuses rather than guessing which PAL is live', () => {
  const target = join(tmp('rac-target-'), 'cli_clients');
  const r = run('--apply', '--target', target);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--pal/);
});

test('--apply on a patched PAL copies every client and leaves conflicts alone', () => {
  const target = join(tmp('rac-target-'), 'cli_clients');
  mkdirSync(target);
  writeFileSync(join(target, 'claude-glm.json'), '{"name":"claude-glm","mine":true}');
  const r = run('--apply', '--target', target, '--pal', fakePal({ runner: true }));
  assert.equal(r.status, 2, 'a skipped conflict is reported with exit 2');
  assert.match(r.stdout, /conflict.*claude-glm/);
  assert.deepEqual(JSON.parse(readFileSync(join(target, 'claude-glm.json'), 'utf8')), {
    name: 'claude-glm',
    mine: true,
  });
  for (const f of ['claude-kimi.json', 'claude-mimo.json', 'claude-qwen.json'])
    assert.ok(existsSync(join(target, f)), f);
  assert.match(r.stdout, /restart/i);
});

// ---- per-run scopes: repeated --add-dir, --add-dirs-file, --only ----

const CLIENTS = ['claude-glm', 'claude-kimi', 'claude-mimo', 'claude-qwen'];
// Real folders with a space in the path, like the skill's own home under "C:/Users/Avi Bendetsky".
const realDir = (name) => {
  const d = join(tmp('rac scope '), name);
  mkdirSync(d);
  return d;
};
const addDirsOf = (content) => {
  const a = JSON.parse(content).additional_args;
  const dirs = [];
  for (let i = 0; i < a.length; i++) if (a[i] === '--add-dir') dirs.push(a[i + 1]);
  return dirs;
};
const shipped = (client) => readFileSync(join(SOURCE, `${client}.json`), 'utf8');
const writeScopes = (obj) => {
  const f = join(tmp('rac scopes '), 'scopes.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
};
const scopeLine = /scope: Restart PAL if it caches clients, then run a scope probe/;

test('collectFlag keeps every occurrence in order and flags a missing value', () => {
  assert.deepEqual(collectFlag(['--add-dir', 'a', '--apply', '--add-dir', 'b'], 'add-dir'), {
    values: ['a', 'b'],
    missing: false,
  });
  assert.deepEqual(collectFlag(['--apply'], 'add-dir'), { values: [], missing: false });
  assert.equal(collectFlag(['--add-dir', '--apply'], 'add-dir').missing, true);
  assert.equal(collectFlag(['--add-dir'], 'add-dir').missing, true);
});

test('renderClient with several dirs appends one --add-dir pair per dir, in order; an empty list adds none', () => {
  const text = shipped('claude-glm');
  const a = JSON.parse(renderClient(text, ['A dir', 'B'])).additional_args;
  assert.deepEqual(a.slice(-4), ['--add-dir', 'A dir', '--add-dir', 'B']);
  assert.equal(renderClient(text, []), text);
  assert.equal(renderClient(text, 'C:\\Dev'), renderClient(text, ['C:\\Dev']));
});

test('planInstall: per-client scopes, "*" for clients without an entry, an empty list means cwd only', () => {
  const target = tmp('rac-target-');
  const plan = planInstall(SOURCE, target, {
    scopes: { 'claude-glm': ['G1', 'G2'], 'claude-kimi': [], '*': ['STAR'] },
  });
  const by = Object.fromEntries(plan.map((p) => [p.client, p]));
  assert.deepEqual(addDirsOf(by['claude-glm'].content), ['G1', 'G2']);
  assert.deepEqual(by['claude-glm'].addDirs, ['G1', 'G2']);
  assert.equal(by['claude-kimi'].content, shipped('claude-kimi'), 'empty list: file unchanged');
  assert.deepEqual(by['claude-kimi'].addDirs, []);
  assert.deepEqual(addDirsOf(by['claude-mimo'].content), ['STAR']);
  assert.deepEqual(addDirsOf(by['claude-qwen'].content), ['STAR']);
});

test('planInstall: without "*", a client with no entry falls back to the --add-dir list; --only limits the set', () => {
  const target = tmp('rac-target-');
  const plan = planInstall(SOURCE, target, {
    addDir: ['X', 'Y'],
    scopes: { 'claude-glm': ['G'] },
    only: ['claude-glm', 'claude-qwen'],
  });
  assert.deepEqual(
    plan.map((p) => p.client),
    ['claude-glm', 'claude-qwen'],
  );
  assert.deepEqual(addDirsOf(plan[0].content), ['G']);
  assert.deepEqual(addDirsOf(plan[1].content), ['X', 'Y']);
});

test("CLI: repeated --add-dir writes repeated pairs in order, and the dry run lists each client's add-dirs", () => {
  const d1 = realDir('repo one');
  const d2 = realDir('repo-two');
  const target = join(tmp('rac-target-'), 'cli_clients');
  const dry = run('--target', target, '--add-dir', d1, '--add-dir', d2);
  assert.equal(dry.status, 0, dry.stderr);
  for (const c of CLIENTS)
    assert.ok(
      dry.stdout
        .split('\n')
        .some((l) => l.includes(`${c}.json`) && l.includes(d1) && l.includes(d2)),
      `${c} line lists both dirs:\n${dry.stdout}`,
    );
  assert.match(dry.stdout, scopeLine);
  assert.equal(existsSync(target), false);
  const r = run(
    '--apply',
    '--target',
    target,
    '--pal',
    fakePal({ runner: true }),
    '--add-dir',
    d1,
    '--add-dir',
    d2,
  );
  assert.equal(r.status, 0, r.stderr);
  for (const c of CLIENTS)
    assert.deepEqual(addDirsOf(readFileSync(join(target, `${c}.json`), 'utf8')), [d1, d2], c);
  assert.match(r.stdout, scopeLine);
});

test('CLI: --add-dirs-file gives each client its own scope, "*" for the rest, [] for cwd only', () => {
  const g = realDir('glm repo');
  const s = realDir('shared repo');
  const file = writeScopes({ 'claude-glm': [g], 'claude-kimi': [], '*': [s] });
  const target = join(tmp('rac-target-'), 'cli_clients');
  const r = run(
    '--apply',
    '--target',
    target,
    '--pal',
    fakePal({ runner: true }),
    '--add-dirs-file',
    file,
  );
  assert.equal(r.status, 0, r.stderr);
  const got = (c) => readFileSync(join(target, `${c}.json`), 'utf8');
  assert.deepEqual(addDirsOf(got('claude-glm')), [g]);
  assert.equal(got('claude-kimi'), shipped('claude-kimi'));
  assert.deepEqual(addDirsOf(got('claude-mimo')), [s]);
  assert.deepEqual(addDirsOf(got('claude-qwen')), [s]);
  assert.match(r.stdout, /claude-kimi\.json.*\(none, cwd only\)/);
});

test('CLI: --only installs just the named clients', () => {
  const target = join(tmp('rac-target-'), 'cli_clients');
  const r = run(
    '--apply',
    '--target',
    target,
    '--pal',
    fakePal({ runner: true }),
    '--only',
    'claude-glm,claude-mimo',
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(target).sort(), ['claude-glm.json', 'claude-mimo.json']);
  assert.doesNotMatch(r.stdout, /claude-kimi/);
});

test('CLI: an unknown client in --only or in the scopes file is a bad argument (exit 3)', () => {
  assert.equal(run('--only', 'claude-nope').status, 3);
  assert.equal(run('--add-dirs-file', writeScopes({ 'claude-nope': [] })).status, 3);
});

test('CLI: a malformed or missing scopes file, or a flag without its value, is exit 3', () => {
  const bad = join(tmp('rac scopes '), 'bad.json');
  writeFileSync(bad, '{not json');
  for (const args of [
    ['--add-dirs-file', bad],
    ['--add-dirs-file', join(tmpdir(), 'rac-no-such-scopes.json')],
    ['--add-dirs-file', writeScopes({ 'claude-glm': 'C:\\Dev' })],
    ['--add-dirs-file', writeScopes(['x'])],
    ['--add-dirs-file'],
    ['--only'],
    ['--add-dir', realDir('ok'), '--add-dir'],
  ]) {
    const r = run(...args);
    assert.equal(r.status, 3, `${args.join(' ')}\n${r.stderr}`);
    assert.match(r.stderr, /install-clink:/);
  }
});

test('CLI: refuses (exit 3) an add-dir that does not exist, is a filesystem root or is the home folder, and writes nothing', () => {
  const pal = fakePal({ runner: true });
  const ok = realDir('fine');
  const root = parse(tmpdir()).root;
  const home = homedir();
  for (const [bad, why] of [
    [join(tmpdir(), 'rac-does-not-exist-xyz'), /does not exist/],
    [root, /root/],
    [home, /home/],
    [`${home}/`, /home/],
  ]) {
    const target = join(tmp('rac-target-'), 'cli_clients');
    const r = run('--apply', '--target', target, '--pal', pal, '--add-dir', ok, '--add-dir', bad);
    assert.equal(r.status, 3, `${bad}\n${r.stderr}`);
    assert.match(r.stderr, why);
    assert.equal(existsSync(target), false, bad);
    const viaFile = run(
      '--apply',
      '--target',
      target,
      '--pal',
      pal,
      '--add-dirs-file',
      writeScopes({ '*': [bad] }),
    );
    assert.equal(viaFile.status, 3, `file ${bad}`);
    assert.equal(existsSync(target), false);
  }
});

test('CLI: a refused dir only matters for a client that would get it (--only drops the others)', () => {
  const ok = realDir('fine');
  const file = writeScopes({ 'claude-glm': [ok], 'claude-kimi': [homedir()] });
  assert.equal(run('--add-dirs-file', file, '--only', 'claude-glm').status, 0);
  assert.equal(run('--add-dirs-file', file).status, 3);
});

test('CLI: one --add-dir and no --add-dir behave as before', () => {
  const d = realDir('single');
  const t1 = join(tmp('rac-target-'), 'cli_clients');
  assert.equal(
    run('--apply', '--target', t1, '--pal', fakePal({ runner: true }), '--add-dir', d).status,
    0,
  );
  const t2 = join(tmp('rac-target-'), 'cli_clients');
  assert.equal(run('--apply', '--target', t2, '--pal', fakePal({ runner: true })).status, 0);
  for (const c of CLIENTS) {
    assert.equal(readFileSync(join(t1, `${c}.json`), 'utf8'), renderClient(shipped(c), d), c);
    assert.equal(readFileSync(join(t2, `${c}.json`), 'utf8'), shipped(c), c);
  }
});

// ---- review fixes: ancestor of home, not-a-folder, "*" + --add-dir, BOM, relative scopes, --only, de-dup ----

test('checkAddDir refuses an ancestor of the home folder, also through a junction, but not a sibling', () => {
  const base = tmp('rac anc ');
  const users = join(base, 'Users');
  const home = join(users, 'me');
  const sibling = join(users, 'me2');
  mkdirSync(home, { recursive: true });
  mkdirSync(sibling);
  assert.match(checkAddDir(users, home), /ancestor of the home folder/);
  assert.match(checkAddDir(base, home), /ancestor of the home folder/);
  assert.match(checkAddDir(`${users}/`, home), /ancestor of the home folder/);
  assert.equal(checkAddDir(sibling, home), null, 'a sibling sharing a name prefix is fine');
  const link = join(tmp('rac link '), 'to-users');
  symlinkSync(users, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(checkAddDir(link, home), /ancestor of the home folder/, 'junction resolved');
  const homeLink = join(tmp('rac link '), 'to-home');
  symlinkSync(home, homeLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(checkAddDir(homeLink, home), /is the home folder/, 'junction to home resolved');
});

test('CLI: refuses (exit 3) the real parent of the home folder, e.g. C:/Users', () => {
  const r = run('--add-dir', dirname(homedir()));
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /ancestor of the home folder/);
});

test("CLI: refuses (exit 3) an add-dir that is a file, with 'is not a folder'", () => {
  const f = join(tmp('rac file '), 'a.txt');
  writeFileSync(f, 'x');
  const r = run('--add-dir', f);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /is not a folder/);
});

test('CLI: "*" in --add-dirs-file together with --add-dir is a bad argument (exit 3)', () => {
  const d = realDir('star');
  const r = run('--add-dirs-file', writeScopes({ '*': [d] }), '--add-dir', d);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /not both/);
});

test('--add-dirs-file with a UTF-8 BOM (as PowerShell writes it) is read', () => {
  const d = realDir('bom repo');
  const f = join(tmp('rac scopes '), 'scopes.json');
  writeFileSync(f, `\uFEFF${JSON.stringify({ '*': [d] })}`, 'utf8');
  assert.deepEqual(readScopes(f, CLIENTS), { '*': [d] });
  const r = run('--add-dirs-file', f);
  assert.equal(r.status, 0, r.stderr);
});

test("relative dirs in --add-dirs-file resolve against the scopes file's own folder, not the cwd", () => {
  const folder = tmp('rac rel ');
  mkdirSync(join(folder, 'sub repo'));
  const f = join(folder, 'scopes.json');
  writeFileSync(f, JSON.stringify({ 'claude-glm': ['sub repo'], '*': ['.'] }));
  assert.deepEqual(readScopes(f, CLIENTS), {
    'claude-glm': [join(folder, 'sub repo')],
    '*': [folder],
  });
  const target = join(tmp('rac-target-'), 'cli_clients');
  const r = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--apply',
      '--target',
      target,
      '--pal',
      fakePal({ runner: true }),
      '--add-dirs-file',
      f,
    ],
    { encoding: 'utf8', cwd: tmp('rac other cwd ') },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(addDirsOf(readFileSync(join(target, 'claude-glm.json'), 'utf8')), [
    join(folder, 'sub repo'),
  ]);
});

test('CLI: repeated --only flags are merged', () => {
  const target = join(tmp('rac-target-'), 'cli_clients');
  const r = run(
    '--apply',
    '--target',
    target,
    '--pal',
    fakePal({ runner: true }),
    '--only',
    'claude-glm',
    '--only',
    'claude-mimo,claude-qwen',
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(target).sort(), [
    'claude-glm.json',
    'claude-mimo.json',
    'claude-qwen.json',
  ]);
  assert.equal(run('--only', 'claude-glm', '--only', 'claude-nope').status, 3);
});

test('identical dirs are written once per client, first-seen order kept', () => {
  const target = tmp('rac-target-');
  const plan = planInstall(SOURCE, target, {
    scopes: { 'claude-glm': ['G', 'H', 'G'], '*': ['S', 'S'] },
  });
  const by = Object.fromEntries(plan.map((p) => [p.client, p]));
  assert.deepEqual(by['claude-glm'].addDirs, ['G', 'H']);
  assert.deepEqual(addDirsOf(by['claude-glm'].content), ['G', 'H']);
  assert.deepEqual(by['claude-mimo'].addDirs, ['S']);
  const d1 = realDir('dup one');
  const d2 = realDir('dup two');
  const t = join(tmp('rac-target-'), 'cli_clients');
  const r = run(
    '--apply',
    '--target',
    t,
    '--pal',
    fakePal({ runner: true }),
    '--add-dir',
    d1,
    '--add-dir',
    d2,
    '--add-dir',
    `${d1}/`,
    '--add-dir',
    d1,
  );
  assert.equal(r.status, 0, r.stderr);
  for (const c of CLIENTS)
    assert.deepEqual(addDirsOf(readFileSync(join(t, `${c}.json`), 'utf8')), [d1, d2], c);
});
