---
name: review
description: Review staged or recent changes for bugs, security issues, and convention violations in the Soifer Backend.
allowed-tools: Bash(git diff *) Bash(git log *) Bash(git status *) Read Grep Glob
---

## Current changes

!`git diff --cached --stat`
!`git diff --stat`

## Instructions

Review all staged and unstaged changes in this Soifer Backend project:

1. Check for security issues (SQL injection, XSS, credential leaks, missing input validation)
2. Check TypeScript conventions: no `any`, strict mode compliance, proper error handling
3. Check WebSocket messages use `createNormalizedMessage()` from `server/shared/utils.ts`
4. Check new providers extend `abstract.provider.ts`
5. Check for missing test coverage on new services
6. Flag files over 400 LOC or functions with >4 positional args

Output a summary table: file | severity (P0-P3) | issue | suggested fix
