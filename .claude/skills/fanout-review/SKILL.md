---
name: fanout-review
description: Multi-agent code review on demand. Fans out 5 specialized reviewers (correctness, security, design, tests, performance) in parallel over a diff, adversarially checks each finding, then synthesizes a severity-ranked review. Use when the user types /fanout-review, or asks for a thorough / multi-angle code review of a diff, PR, branch, or set of files.
argument-hint: "[staged | <git range> | <PR#> | <files>]  (defaults to staged changes)"
disable-model-invocation: true
---

# Fan-out code review

Runs the shared fan-out engine with the built-in **review** panel — correctness · security · design/maintainability · tests · performance — then adversarially checks each finding and synthesizes a severity-ranked report.

## Steps

1. **Resolve the review target** from the argument (default: staged changes), and capture the diff yourself in the main thread:
   - none / `staged` → `git diff --staged`
   - a range like `main...HEAD` or `HEAD~3..HEAD` → `git diff <range>`
   - a PR (e.g. `#123` / `123`) → `gh pr diff <n>`
   - file paths → `git diff -- <files>` (read them directly if untracked)
   If the diff is empty, tell the user and stop.

2. **Build the task string.** Small/medium diff → `Review this code change.\n\n<diff>`. Large diff (> ~600 lines) → pass a short summary + the changed-file list + the diff range, and tell the reviewers to read the hunks/files themselves with their tools (workflow agents have Read/Grep/Bash).

3. **Call the Workflow tool:**
   - `scriptPath`: `C:\Dev\tools\fanout-toolkit\workflows\ultracode-fanout.js`
   - `args`: `{ "task": "<the review task>", "panel": "review" }`

4. When it returns, present `finalAnswer` (the severity-ranked review) and a one-line footer (`panel`, `agents`). If the result has an `error` field instead, surface that and stop.

## Notes
- ~11 agents; explicit invocation only. After the review, offer to apply fixes if the user wants — this skill reviews, it does not edit.
- Override the panel by passing `lenses: [...]` instead of `panel`. Add `dryRun: true` to confirm the panel resolves without spawning agents.
