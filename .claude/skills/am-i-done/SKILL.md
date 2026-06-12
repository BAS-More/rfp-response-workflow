---
name: am-i-done
description: Final verification checklist before declaring a phase or project complete. Walks through tests, typecheck, coverage, security scans, PRD acceptance criteria, CLAUDE.md state, and PR description. Fires when user says "am I done", "is this complete", "done with this phase", "ship it", or similar completion-check language. Also runs as a final pass before dropping a .phase-done marker.
allowed-tools: Bash(npm test *), Bash(npx tsc *), Bash(npx c8 *), Bash(gitleaks protect *), Bash(semgrep ci *), Bash(gh pr view *), Bash(git status *), Bash(git diff *), Read, Grep, Glob
---

# /am-i-done — final-gate checklist

Walks through 9 checks in strict order. Responds ONLY with:
- `✓ all green — ready to advance` (if every check passes)
- `✗ first gap: <what + how to fix>` (if any check fails)

Do not list multiple failures — surface the first one; fixing it may reveal the next.

## The 9 checks

### 1. Tests pass
```
npm test --silent
```
Must exit 0. If a workspace-specific test command exists (`npm test --workspace=<app>`), prefer it.

**Gap template:** "Tests failing in `<workspace>` — run `npm test` to see failures."

### 2. Typecheck clean
```
npx tsc --noEmit
```
Must exit 0.

**Gap template:** "TypeScript errors in `<file>:<line>` — see `npx tsc --noEmit` output."

### 3. Coverage on new code ≥ 98%
```
npx c8 check-coverage --lines=98 --functions=98 --branches=98
```
Must exit 0.

**Gap template:** "Coverage below 98% on lines in `<file>`. Need tests for `<uncovered function>`."

### 4. No new gitleaks findings
```
gitleaks protect --staged --no-banner
```
Must exit 0.

**Gap template:** "Secret pattern `<rule>` detected in `<file>:<line>`. Redact or move to env var."

### 5. No new semgrep findings
```
semgrep ci --config auto
```
Must exit 0.

**Gap template:** "Semgrep finding `<rule-id>` in `<file>:<line>`. See https://semgrep.dev/r/<rule-id>."

### 6. PRD acceptance criteria all checked
Read `docs/<slug>/requirements.md`. Every EARS statement in "Acceptance criteria" sections must have a corresponding `[x]` in `docs/<slug>/tasks.md` OR a passing test that asserts the behaviour.

**Gap template:** "Acceptance criterion '<EARS text>' from requirements.md not yet satisfied — no matching task checked and no test found."

### 7. Architecturally-significant decisions logged in avios-context
For any non-trivial choice made during this phase (new dependency, schema change, API design, auth model, new integration), confirm an entry exists via `mcp__avios-context-mcp__avios_get_decisions` for the current project.

**Gap template:** "Decision about `<choice>` made this phase but not logged in avios-context. Call `avios_add_decision`."

### 8. CLAUDE.md has "last state" block
Read project `CLAUDE.md`. Must contain a `<!-- LAST-STATE -->` block updated within the last hour.

**Gap template:** "CLAUDE.md missing/stale `<!-- LAST-STATE -->` block — session-close hook didn't fire yet."

### 9. Draft PR description reflects plan.md
Run `gh pr view` in the current branch. The PR description must include:
- Link to `docs/<slug>/requirements.md`
- Checklist mirroring `docs/<slug>/tasks.md` phase checkboxes

**Gap template:** "Draft PR description missing plan.md mirror — update with `gh pr edit --body`."

## Output format

Respond with exactly ONE of:

**All green:**
```
✓ all green — ready to advance
```

**First gap:**
```
✗ first gap: <gap_template text>

Next step: <concrete command or edit>
```

## When NOT to use this skill

- Mid-phase — only meaningful at phase boundaries
- If `docs/<slug>/` doesn't exist (nothing to check against)
- For projects explicitly marked "skip-gate" in `.phase-gate.json`

## Gotchas

- **Ordering matters** — check in order. Tests first because they're the cheapest signal.
- **Don't self-repair** — this skill is a *gate*, not a fixer. It reports; Claude fixes.
- **Timeouts** — each command is run with the phase-loop hook's timeout policy. If a check hangs, reliably report it as "failed: timeout" rather than reporting fake success.
