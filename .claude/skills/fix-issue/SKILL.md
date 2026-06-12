---
name: fix-issue
description: Fix a GitHub issue by number. Reads the issue, implements the fix, writes tests, and prepares a commit.
argument-hint: "[issue-number]"
allowed-tools: Bash(gh issue view *) Bash(gh pr create *) Bash(npm test *) Bash(npx vitest *) Bash(npx tsc *) Bash(git *)
---

## Issue context

!`gh issue view $ARGUMENTS --json title,body,labels,assignees 2>/dev/null || echo "No issue number provided or gh not authenticated"`

## Instructions

Fix GitHub issue $ARGUMENTS for the Soifer Backend:

1. Read and understand the issue
2. Explore relevant code to find the root cause
3. Write a failing test first (RED)
4. Implement the fix (GREEN)
5. Run `npx tsc --noEmit` — must pass
6. Run `npx vitest run` — must pass
7. Stage changed files and prepare a commit message referencing the issue: `fix: <description> (closes #$ARGUMENTS)`

Do NOT commit automatically — present the diff for review first.
