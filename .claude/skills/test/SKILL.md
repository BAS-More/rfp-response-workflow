---
name: test
description: Run Soifer Backend tests with coverage, typecheck, and lint. Reports failures with context.
argument-hint: "[path|module|all]"
allowed-tools: Bash(npx vitest *) Bash(npx tsc *) Bash(npm test *) Bash(npm run *)
---

## Instructions

Run test suite for Soifer Backend. Target: $ARGUMENTS (default: all)

### Steps

1. **Typecheck**: `npx tsc --noEmit`
2. **Tests**: `npx vitest run $ARGUMENTS --reporter=verbose`
3. **Coverage** (if all): `npx vitest run --coverage`

### On failure

- Read failing test file and implementation
- Diagnose root cause
- Report: test name | expected vs actual | likely fix

Do NOT auto-fix. Present findings for review.
