---
name: projects
description: "Project dashboard. Subcommands: /projects (overview of all active work), /projects <slug> (deep dive on one), /projects stale (abandoned branches), /projects digest (trigger daily summary now). Scans all repos for /build projects + active branches."
allowed-tools: Read, Glob, Grep, Bash, Agent, PushNotification, AskUserQuestion, ToolSearch
---

# /projects — Cross-Repo Project Dashboard

Tracks ALL active work across all your repos — both `/build` pipeline projects (full detail) and manual branches (basic stats). Gives you a single view of everything in flight.

## Subcommands

| Command | What it does |
|---------|-------------|
| `/projects` | Overview dashboard — all active work across all repos |
| `/projects <slug>` | Deep dive on a specific /build project |
| `/projects stale` | Show branches/projects with no activity in 7+ days |
| `/projects blocked` | Show only blocked/waiting projects |
| `/projects digest` | Generate the daily digest summary right now |
| `/projects cleanup` | Suggest branches safe to delete (merged, stale, abandoned) |

## Data sources

### 1. /build projects (full tracking)

Scan for `docs/*/BUILD_STATE.json` in all registered repos. These have rich data:
- Status (planning, awaiting_approval, executing, blocked, complete)
- Phase progress, task counts, critic verdicts
- Time started, last updated, blocked reason
- Commits, cost estimates

### 2. Active branches (basic tracking)

For repos WITHOUT a BUILD_STATE.json, scan git for non-main branches with recent commits:
```bash
git branch --sort=-committerdate --format='%(refname:short) %(committerdate:relative) %(subject)'
```

Track: branch name, last commit date, commit count vs main, files changed.

### 3. Registry config

Read `~/.claude/configs/project-registry.json` for:
- `scan_roots` — directories to scan (recursive to max_depth)
- `ignore_patterns` — folders to skip
- `stale_threshold_days` — when to flag as stale (default: 7)

---

## Process for `/projects` (main dashboard)

### Step 1 — Scan repos

```bash
# For each scan_root, find git repos
find <root> -maxdepth <max_depth> -name ".git" -type d
```

### Step 2 — Collect /build project states

For each repo found:
```bash
# Check for BUILD_STATE.json files
find <repo>/docs -name "BUILD_STATE.json" 2>/dev/null
```

Parse each and collect into the dashboard.

### Step 3 — Collect active branches

For each repo:
```bash
git -C <repo> branch --sort=-committerdate --format='%(refname:short)|%(committerdate:iso)|%(subject)' | head -5
```

Filter out `main`, `master`, and branches older than stale_threshold.

### Step 4 — Display dashboard

```
PROJECT DASHBOARD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/BUILD PROJECTS (spec-driven)
─────────────────────────────────────────────────────────────────────────
  Status   │ Project              │ Repo          │ Progress      │ Last activity
  🔨 exec  │ coupon-redemption    │ paseo         │ ██████░░ 8/12 │ 2h ago
  ⏸ blocked│ health-dashboard     │ soifer        │ ████░░░░ 4/10 │ 1d ago — needs API key
  ✅ done  │ cli-theme            │ claudecodeui  │ ████████ 13/13│ 3d ago
  📋 plan  │ stripe-billing       │ bnm-platform  │ ░░░░░░░░ 0/0 │ 5h ago — awaiting approval

ACTIVE BRANCHES (manual work)
─────────────────────────────────────────────────────────────────────────
  Repo          │ Branch                    │ Commits │ Age    │ Last commit
  paseo         │ fix/mcp-server-types      │ +3      │ 2d     │ fix TS2589 errors
  9router       │ feat/rate-limiting        │ +7      │ 4d     │ add sliding window
  ezra          │ claude/spec-kit-review    │ +1      │ today  │ initial analysis

STALE (7+ days no activity)
─────────────────────────────────────────────────────────────────────────
  paseo         │ experiment/voice-ui       │ +12     │ 14d    │ consider cleanup
  claudecodeui  │ refactor/split-index      │ +4      │ 21d    │ consider cleanup

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Summary: 4 builds (1 executing, 1 blocked, 1 done, 1 planning) │ 3 active branches │ 2 stale
```

---

## Process for `/projects <slug>`

Deep dive on one /build project. Shows:

```
PROJECT: coupon-redemption (paseo)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:        executing
Phase:         2 of 3
Tasks:         ██████░░░░ 8/12 done
Last task:     P2-04 — "Add redemption API endpoint" ✅ PASS
Next task:     P2-05 — "Wire coupon validation to checkout" [c=3]
Last critic:   PASS (no gaps)
Commits:       8 (abc1234, def5678, ...)
Started:       2026-05-14 10:00
Last updated:  2026-05-16 08:30 (2h ago)
Est. remaining: ~45 min (4 tasks: c2×2, c3×2)

Spec files:
  docs/coupon-redemption/requirements.md
  docs/coupon-redemption/design.md
  docs/coupon-redemption/tasks.md
  docs/coupon-redemption/BUILD_STATE.json

Quick actions:
  /build resume coupon-redemption    ← continue building
  Run critic on latest               ← verify current state
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Process for `/projects stale`

Show branches with no activity beyond `stale_threshold_days`:

```
STALE PROJECTS & BRANCHES (7+ days inactive)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Repo          │ Branch/Project         │ Last activity │ Action?
  paseo         │ experiment/voice-ui    │ 14d ago       │ merged? delete?
  claudecodeui  │ refactor/split-index   │ 21d ago       │ WIP? abandon?
  9router       │ /build: auth-refactor  │ 9d ago        │ blocked (needs key)

Shall I clean up any of these? (I'll confirm before deleting)
```

---

## Process for `/projects blocked`

Filter to only blocked items:

```
BLOCKED WORK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Project              │ Blocked since │ Reason
  health-dashboard     │ 1d ago        │ Missing STRIPE_SECRET_KEY in vault
  auth-refactor        │ 9d ago        │ Waiting for design review from user

Actions needed:
  1. vault.py set stripe STRIPE_SECRET_KEY   ← then /build resume health-dashboard
  2. Review docs/auth-refactor/design.md     ← then touch docs/auth-refactor/APPROVED
```

---

## Process for `/projects digest`

Generate a daily summary suitable for push notification + detailed inline view:

**Push notification (short):**
```
Daily: 2 builds active, 1 blocked (needs STRIPE key), 3 branches in flight, 2 stale
```

**Inline detail:**
```
DAILY PROJECT DIGEST — 2026-05-16
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SINCE YESTERDAY:
  ✅ coupon-redemption: +3 tasks done (P2-02, P2-03, P2-04)
  🔨 health-dashboard: no progress (blocked)
  🆕 stripe-billing: spec created, awaiting approval

NEEDS YOUR ATTENTION:
  ⚠️  health-dashboard blocked — missing STRIPE_SECRET_KEY
  ⚠️  auth-refactor stale (9d) — still awaiting design approval
  📋 stripe-billing — ready for your review + approval

METRICS:
  Active builds:     3
  Tasks completed:   3 (yesterday)
  Tasks remaining:   19 across all builds
  Branches in flight: 5
  Stale branches:    2 (candidates for cleanup)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Process for `/projects cleanup`

Identify branches safe to delete:
- Fully merged into main
- Stale (>30 days) with no unique commits
- /build projects marked `complete` with all phases done

Present as options — never auto-delete (per destructive-ops rule).

---

## Scheduled daily digest

The `/projects digest` runs automatically via a scheduled agent (cron). Setup:

1. Register a scheduled routine that runs daily at 8:00 AM
2. Routine scans all repos (same as `/projects`)
3. Compares with yesterday's state (stored in `~/.claude/state/projects-last-digest.json`)
4. Sends push notification with summary
5. Stores new state for tomorrow's diff

To set up: run `/projects setup-digest` which creates the scheduled agent.

### State file (`~/.claude/state/projects-last-digest.json`)

```json
{
  "last_run": "2026-05-15T08:00:00Z",
  "builds": {
    "coupon-redemption": { "tasks_done": 5, "status": "executing" },
    "health-dashboard": { "tasks_done": 4, "status": "blocked" }
  },
  "branches": {
    "paseo/fix/mcp-server-types": { "commits": 2, "last_seen": "2026-05-15" }
  }
}
```

---

## Anti-patterns

- Never delete branches without explicit user confirmation
- Never show sensitive data (API keys, tokens) in the dashboard — just "missing X"
- Don't scan repos the user hasn't registered in `project-registry.json`
- Don't block the session for slow scans — if a repo is unreachable, skip it with a note
- Don't run git operations that modify state (checkout, pull, push) — read-only scanning only
