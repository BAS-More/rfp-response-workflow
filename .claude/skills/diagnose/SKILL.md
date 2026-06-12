---
name: diagnose
description: Incident response flow. Given a Sentry issue ID or a production error description, fetch the error details, diagnose the root cause, propose a fix branch, and open a draft PR. Fires when user says "diagnose <error>", "Sentry issue <id>", "prod is broken", "investigate bug", or similar incident-response language.
allowed-tools: mcp__sentry__*, mcp__github-mcp-server__*, mcp__serena__*, Read, Glob, Grep, Bash(git *), Bash(gh *)
---

# /diagnose — prod → fix-branch → draft PR

Structured recipe for "something broke in prod, fix it." Produces a fix branch and a draft PR; does NOT merge.

## Inputs

One of:
- Sentry issue ID (`PROJ-123`, URL, or internal ID)
- Error message + rough stack trace
- "Check <service>" — open-ended diagnosis

## Process

### Step 1 — Pull signals from prod

If a Sentry ID is given, call `mcp__sentry__get_issue_details` (or the equivalent MCP tool). Extract:
- Error message
- Stack trace (top 10 frames)
- Breadcrumbs (last 20 events)
- Release / tag / commit SHA where it first appeared
- Affected user count + frequency

If no Sentry ID, ask the user for one OR ask for enough context to search Sentry by error message.

**Never invent data.** If the MCP returns nothing, say so and ask what's available.

### Step 2 — Locate the code

Use `serena` MCP (`find_symbol` / `find_references`) to jump from the stack trace frame to the actual source file. Serena's symbol-level navigation is faster and more accurate than grep.

Read the file. Understand:
- The function that threw
- Its callers
- Any recent changes (via `git log -p -- <file>` for the last 10 commits)

### Step 3 — Form the hypothesis

State clearly:
- **Symptom:** what the user/system experienced
- **Root cause:** what the code did wrong
- **Evidence:** specific log line / breadcrumb / commit that supports the hypothesis

If confidence is low ("this *might* be the issue because…"), say so. Don't overclaim.

### Step 4 — Create the fix branch

```
git checkout -b fix/<short-slug>
```

Slug examples:
- `fix/null-user-in-billing-webhook`
- `fix/redis-timeout-on-health-check`

### Step 5 — Write the fix + test

**Test first.** Write a failing test that reproduces the Sentry error (or closest possible). Use `mcp__serena__find_references` to locate the nearest relevant test file.

Then write the minimum fix to make the test pass. Keep the diff surgical — this is not the moment for refactor.

### Step 6 — Verify locally

```
npm test
npx tsc --noEmit
```

Both must pass before pushing.

### Step 7 — Commit + push

Commit with a conventional-commit message:
```
fix(<scope>): <short description> — resolves <sentry-id>
```

Push:
```
git push -u origin fix/<short-slug>
```

### Step 8 — Open draft PR

Via `mcp__github-mcp-server__create_pull_request` (or `gh pr create --draft`):

```markdown
# Fix: <short description>

## Incident
- Sentry: <issue-url>
- First seen: <date>
- Affected users: <count>

## Root cause
<1-paragraph hypothesis>

## Fix
<1-paragraph describing the code change>

## Test coverage
- Added test: `<path>` — reproduces the error without the fix, passes with it

## Verification
- [ ] `npm test` passes
- [ ] `npx tsc --noEmit` passes
- [ ] Sentry issue auto-closes on next deploy (pending release)
```

### Step 9 — Link the PR in avios-context

Call `mcp__avios-context-mcp__avios_add_decision` with:
- Type: "incident-fix"
- Project: current repo slug
- Content: "Fixed <sentry-id>: <root cause>. See PR #<number>."

### Step 10 — Hand back

```
[diagnose] Fix branch + draft PR ready.
  Sentry:   <issue-url>
  Branch:   fix/<short-slug>
  PR:       <pr-url>
  Root cause: <1-line>

Review the PR; merge when CI is green. The Sentry issue should auto-close on next deploy.
```

## When NOT to use this skill

- No Sentry access configured (guide user to set up Sentry MCP OAuth first)
- Issue is data-only (not a code bug) — e.g., bad config, expired cert, DNS issue
- User wants a feature request, not a bug fix (use `/spec` instead)

## Gotchas

- **Seer can invent plausible-but-wrong causes** when telemetry is thin. Always cite specific log lines or spans from the fetched Sentry data. Don't fabricate.
- **Don't skip the failing test.** A fix without a reproducing test is a fix that can regress silently.
- **Draft PR, not ready-for-review.** Always open as draft so Claude's work has a final human review step.
- **One issue per PR.** If the diagnosis reveals two distinct bugs, open two branches / two PRs.
