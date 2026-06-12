---
name: phase-gate
description: Explicitly trigger the 100% gate check at the end of a phase. Runs gap analysis, full test suite, typecheck, coverage, security scans, and PRD acceptance. Produces a go/no-go for advancing to the next phase. Use when wrapping up a phase and preparing to drop a `.phase-done` marker, or when the user says "check the phase", "is phase N done", "run the gate".
allowed-tools: Bash(npm test *), Bash(npx tsc *), Bash(npx c8 *), Bash(gitleaks protect *), Bash(semgrep ci *), Bash(touch *.phase-done), Bash(rm *.phase-done), Read, Grep, Glob
---

# /phase-gate — explicit 100% gate invocation

Runs the complete gate and reports pass/fail per-check. On all-green, drops a `.phase-done` marker (which the `phase-loop` Stop-hook will see and allow the session to close cleanly).

This skill is the *explicit* way to invoke the gate; the `phase-loop` hook runs the same checks automatically on Stop if the marker is present.

## When to use this skill

- At the end of a phase, as the final step before advancing
- When the user asks "is phase N done?" / "check the gate" / "can we move on?"
- After Claude self-repairs a gate failure and wants to re-check
- As the last action before declaring a project complete

## Process

### Step 1 — Detect the current phase

Find the project slug from `cwd`. Read `docs/<slug>/tasks.md`. Identify the current phase — it's the one with the most recent `- [x]` items but at least one `- [ ]`. If all phases show 100% checked, the project is complete.

### Step 2 — Run the gap analysis

Invoke the `ezra-reconciler` agent (via the Agent tool, subagent_type=`ezra-reconciler`) with prompt:
> Compare the current codebase against the unchecked items in `docs/<slug>/tasks.md` Phase <N>. Report any gaps: items listed in tasks.md but not implemented, or items implemented but not listed.

### Step 3 — Run the 100% gate checks

In order, with short timeouts:

1. `npm test --silent` (≤5 min)
2. `npx tsc --noEmit` (≤2 min)
3. `npx c8 check-coverage --lines=98 --functions=98 --branches=98` (≤1 min)
4. `gitleaks protect --staged --no-banner` (≤30s)
5. `semgrep ci --config auto` (≤3 min)

### Step 4 — Behavioural check (if Playwright is configured)

If `playwright.config.ts` exists in the repo:
```
npx playwright test --project=smoke
```

The PRD acceptance criteria should have been compiled into a smoke-test suite. If no smoke tests exist, flag it as a gap.

### Step 5 — PRD acceptance criteria verification

For each EARS statement in `docs/<slug>/requirements.md`:
- Find the implementing code (via serena `find_references`)
- Find the covering test
- If either missing → gap

### Step 6 — Decide + report

**If ALL green:**
```
✓ Phase <N> gate PASSED — all 5 machine checks + Playwright + PRD acceptance clean.
Ready to advance to Phase <N+1>.

Dropping .phase-done marker now.
```
Then `touch .phase-done`.

**If ANY red:** report the first failure using this template:
```
✗ Phase <N> gate FAILED at check <name>:
  <concrete error summary>

Fix it, then re-run /phase-gate.
```
Do NOT drop the marker. Do not advance.

## Integration with phase-loop Stop hook

The `.phase-done` marker this skill drops is what the `phase-loop` Stop hook looks for. If the marker is present AND Claude Stops, the hook re-runs the same checks as a belt-and-braces safety net. If anything is red at Stop time, the hook exits 2 (prevent-stop) and forces iteration.

So: this skill proactively checks; the Stop hook reactively enforces.

## Gotchas

- **Don't run this mid-phase.** Running with no unchecked items will report an empty gap — fine but useless. Running with lots of unchecked items will report cascading failures — confusing.
- **Don't bypass reds.** If a check fails, fix it — don't just drop the marker anyway. The Stop hook will catch and block at session end, but by then Claude has context on the wrong thing.
- **Timeouts are intentional.** A check that hangs is a check that fails. Don't raise the timeouts; fix the slow command.
- **Coverage on NEW code only.** c8's check-coverage as configured compares against the current file; if legacy code is at 40%, that's deferred (not in scope for this phase).
