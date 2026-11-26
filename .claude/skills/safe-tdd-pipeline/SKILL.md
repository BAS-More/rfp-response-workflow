---
name: safe-tdd-pipeline
description: >
  Guarded 4-stage build pipeline for a non-technical product owner who cannot review code:
  plain-English Given/When/Then spec -> owner approval -> tests locked -> fresh-subagent
  Single-Responsibility implementation that may not touch specs/ or tests/ -> automated gate
  (tests, typecheck, lint, secret scan, test-lock) -> fresh skeptical reviewer -> jargon-free
  release report with a manual preview checklist. Use when the user types /safe-tdd-pipeline,
  or asks to "build this safely", "add a feature with tests first", "TDD this", "spec it then
  build it", or wants a change they can trust without reading code. Not for autonomous
  no-pause runs (that is /TDD-loop-goal) or one-line fixes.
---

# safe-tdd-pipeline

Four stages, in order, no skipping. The owner sees plain English only: the spec at the end of
Stage 1 and the report in Stage 4. Every command runs from the **repo root**. `SKILL_DIR` means
the folder holding this file (user install: `~/.agents/skills/safe-tdd-pipeline`).

State lives in `.safe-tdd/` at the repo root (the scripts create it, and it ignores itself in git):
`test-lock.sha256`, `gate.log`, `gate-report.txt`, `active`.

## Stage 0: Preflight (silent, no questions unless blocked)
1. `git status --short` and `git rev-parse HEAD`. Record that SHA as **BASE**. If the tree is dirty with
   unrelated work, ask once whether to proceed. Never stash or reset it yourself.
2. Find the test runner and folder conventions: `package.json` scripts, `pyproject.toml`, `playwright.config.*`,
   `vitest/jest.config.*`, `conftest.py`. Use what the repo already has. Add a runner only if none exists, and say so.
3. If the repo keeps tests somewhere other than `tests/` (e.g. `__tests__/`, `test/`), set
   `SAFE_TDD_LOCK_DIRS="specs <that dir>"` for every script call in this run.
4. If a code-graph MCP is available (knowledge-graph / gitnexus), run its impact query on the area to be changed.

## Stage 1: Plain-English spec and locked tests
1. Write `specs/<slug>.feature` from [references/spec-template.md](references/spec-template.md).
2. Write tests in `tests/` with the repo's runner: **unit tests** for each rule, plus **end-to-end**
   (Playwright/Cypress for UI, HTTP-level for APIs) for each `@happy-path` and `@not-allowed` scenario.
   Each test names its scenario tag (e.g. `test('@S2 empty email shows error', …)`).
3. Run the tests and confirm they **fail for the right reason** (feature missing, not a syntax or import error).
   A test that passes before the code exists is broken. Fix it now.
4. **MANDATORY PAUSE.** Show the owner only: the plain-English summary, out-of-scope list, open questions
   and the scenarios, as plain text with no file paths or code. Ask: *"Is this exactly what you want built?
   Reply yes, or tell me what to change."* Stop the turn and wait.
5. On a clear yes: `bash "$SKILL_DIR/scripts/check_test_lock.sh" --lock`. Record the printed
   `LOCK_HASH` in the conversation (this is the approval fingerprint). Then `touch .safe-tdd/active`.
   On "change X": edit the spec and tests, re-run step 3, pause again.

## Stage 2: Isolated SRP implementation (fresh subagent)
Spawn a **fresh** implementation subagent (Claude Code: `Agent` tool; Codex: a new subagent/task) with only this brief:

> Implement the behaviour in `specs/<slug>.feature` so that the tests in `tests/` pass.
> HARD RULES: (1) Do not create, edit, rename or delete anything in `specs/` or `tests/`, or test config
> (runner config, coverage thresholds, the `test` script). If a test looks wrong, STOP and report why. Do not
> "fix" it. (2) Single Responsibility: UI, business rules, and data/API access live in separate files.
> Keep files under ~200 lines and functions under ~40. Business rules must be testable without UI or database.
> Follow the repo's existing folder layout and style. (3) No hardcoded secrets. Read config from env.
> (4) No special-casing of test values. (5) Run the test suite after each small step. Finish by running
> `bash "<SKILL_DIR>/scripts/check_test_lock.sh" --expect <LOCK_HASH>` and include its output.
> Report: files changed (one line each, with responsibility), test result, lock result, anything you could not do.

When it returns, run the lock check yourself. Never trust the subagent's word:
`bash "$SKILL_DIR/scripts/check_test_lock.sh" --expect <LOCK_HASH>`
- **FAIL** means the tests were tampered with. Restore those paths to BASE (`git checkout <BASE> -- <paths>`; new
  files: remove them) after showing the owner the list, then re-run Stage 2. If a test really is wrong, go back
  to **Stage 1** and get the owner's re-approval and a new lock. Never re-lock silently.

## Stage 3: Gate and skeptical audit (loop until clean)
1. `SAFE_TDD_EXPECT_LOCK=<LOCK_HASH> bash "$SKILL_DIR/scripts/verify_gate.sh"`. Exit 0 means every check passed.
   It runs: test-lock, typecheck, lint, full tests, e2e (if a script exists), secret scan. It FAILS when no
   test runner is found or no lock exists. SKIP is never reported as PASS.
2. Gate FAIL: send the failing section of `.safe-tdd/gate.log` to a fresh implementation subagent (same Stage 2
   rules), then repeat step 1. Cap at **5 loops**. After that, stop and report "not finished" in Stage 4 format.
3. Gate PASS: spawn a **separate fresh reviewer subagent** with [references/auditor-prompt.md](references/auditor-prompt.md),
   filled in with BASE, LOCK_HASH, the spec path and `SKILL_DIR`. Give it nothing else from this conversation.
4. Verdict `FIX FIRST`/`BLOCK`: send the findings to an implementation subagent, then go back to step 1 (gate),
   then step 3 (review again). Findings that need the spec to change go back to Stage 1 for owner approval.
5. Done when the gate passes AND the reviewer says `SHIP`. Then `rm .safe-tdd/active`.

## Stage 4: Plain-English release report
Use exactly this shape. No code, no file paths, no jargon. Translate every check into a plain sentence.

```
What changed
- <business-language bullet per scenario, e.g. "Clients now get a clear message if they leave the email blank.">

Automated checks
- Tests: <N> passed, 0 failed          ✅
- Code checks (types, style): passed   ✅ / not set up in this project ⚠️
- Secret scan: no passwords or keys in the code ✅
- Approved tests untouched: verified   ✅
- Independent review: approved         ✅ (<n> issues found and fixed)

Please check these yourself in the preview (about 5 minutes)
1. <Open … and click …. You should see ….>
2. <Try … with a blank/wrong value. You should see the message "…".>
3. <Sign in as … (no permission) and try …. It should be blocked.>
(3–5 items, each one click-path and one expected result)

Not done / needs you
- <anything SKIPped, any open question, or "Nothing.">
```
Nothing is committed, pushed, or deployed by this skill. Offer a commit, and do it only on the owner's yes.

## Gotchas (found while building and testing this skill)
- **The gate fails in Stage 1 by design.** Tests are RED until Stage 2. Never run the gate, or any hook that
  runs it, before `.safe-tdd/active` exists.
- **Always pass `--expect <LOCK_HASH>`.** Without it, an agent that re-runs `--lock` after weakening a test gets
  a clean PASS. Tested: re-lock gives PASS without `--expect` and FAIL with it.
- The lock covers only `specs/` and `tests/` (or `SAFE_TDD_LOCK_DIRS`). Runner config and the `test` script are
  outside it, so the auditor checks them by hand (checklist item 5).
- `node --test tests/` fails on Node 24 (it treats the folder as a file). Use `node --test` or a glob.
- If `gitleaks` is installed the gate uses it. Otherwise it uses a built-in grep scanner that prints only
  `file:line [type]`, never the value. Force the built-in one with `SAFE_TDD_BUILTIN_SCAN=1`. Silence a
  known-safe line with a trailing `safe-tdd: allow-secret` comment. Generic `password = "..."` matches that look
  like placeholders (`example`, `dummy`, `process.env`) are ignored.
- Skip a check only with `SAFE_TDD_SKIP=lint,e2e`, and list it under "Not done" in Stage 4.
- The repo root comes from `git rev-parse --show-toplevel`. Run inside the project, not in a parent folder
  that is itself a git repo (e.g. a home folder under version control), or the gate scans the wrong tree.
