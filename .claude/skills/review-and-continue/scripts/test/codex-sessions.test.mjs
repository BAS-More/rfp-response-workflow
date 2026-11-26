import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { listSessions } from '../sessions.mjs';

test('Codex inventory follows linked worktree cwd, ignores harness/duplicate records, preserves activity and excludes sibling roots', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rac-codex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo'),
    linked = join(dir, 'linked');
  mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'initial',
  );
  git('worktree', 'add', '--detach', linked);
  const codexHome = join(dir, 'sessions'),
    dated = join(codexHome, '2026', '10', '18');
  mkdirSync(dated, { recursive: true });
  const message = (text) => ({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
  const records = [
    {
      type: 'session_meta',
      payload: { id: 'codex-session', cwd: join(dir, 'elsewhere'), git: { branch: 'topic' } },
    },
    message('# AGENTS.md instructions for test'),
    message('<environment_context>injected</environment_context>'),
    { type: 'turn_context', payload: { cwd: linked } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Review changes' } },
    message('Review changes'),
    message('Continue safely'),
  ];
  const file = join(dated, 'rollout.jsonl');
  writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n{"partial":');
  const active = new Date();
  utimesSync(file, active, active);
  writeFileSync(
    join(dated, 'unrelated.jsonl'),
    [{ type: 'session_meta', payload: { cwd: root + '-other' } }, message('Unrelated')]
      .map(JSON.stringify)
      .join('\n'),
  );
  const result = listSessions([root], { home: join(dir, 'missing-claude'), codexHome });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'codex-session');
  assert.equal(result[0].source, 'codex');
  assert.equal(result[0].currentCwd, linked);
  assert.deepEqual(result[0].cwds, [join(dir, 'elsewhere'), linked]);
  assert.equal(result[0].userTurns, 2);
  assert.equal(result[0].firstPrompt, 'Review changes');
  assert.equal(result[0].lastPrompt, 'Continue safely');
  assert.ok(Math.abs(Date.parse(result[0].lastActive) - active.getTime()) < 1000);
  utimesSync(file, new Date(0), new Date(0));
  assert.equal(listSessions([root], { home: join(dir, 'missing-claude'), codexHome }).length, 0);
});
