---
name: build
description: "Fully automated spec-driven development pipeline. Subcommands: /build <brief>, /build resume, /build status, /build dry-run (new|adjust|remaining|fix), /build rollback <slug>, /build queue. Auto-branch, architect gate, LLM council, learning loop, build badges — all automatic."
allowed-tools: Agent, AskUserQuestion, Read, Write, Edit, Glob, Grep, Bash, Skill, ToolSearch, PushNotification
---

# /build — Fully Automated Spec-Driven Pipeline

Runs the complete Clarifier→Planner→Executor→Critic→Phase-Gate pipeline autonomously.
You only pause for user decisions. Everything else runs automatically.

## Subcommands

| Command | What it does |
|---------|-------------|
| `/build <brief>` | Start a new build from a feature description |
| `/build resume` | Pick up the most recent unfinished build |
| `/build resume <slug>` | Resume a specific build by slug |
| `/build status` | Dashboard of all active builds |
| `/build status <slug>` | Deep dive on one build |
| `/build dry-run <brief>` | Preview a new build — tasks, cost, files, without executing |
| `/build dry-run adjust <slug> <change>` | Impact analysis — what modifying an in-progress build would do |
| `/build dry-run remaining <slug>` | Preview remaining work on a paused/in-progress build |
| `/build dry-run fix <slug> <issue>` | Preview the fix path for a failed task or critic finding |
| `/build rollback <slug>` | Revert ALL commits from a build (asks confirmation first) |
| `/build queue <brief1> \| <brief2> \| ...` | Queue multiple features, builds them sequentially |

---

## The pipeline

```
PHASE 0: CLARIFY (if needed)
PHASE 1: PLAN (spec creation + LLM Council for arch decisions)
PHASE 1.5: DEPENDENCY VALIDATION + COST ESTIMATE
PHASE 2: APPROVE (user decision — ONLY mandatory pause)
PHASE 2.5: AUTO-BRANCH (create feat/<slug>)
PHASE 3: EXECUTE + ARCHITECT GATE + CRITIQUE (loop per task)
PHASE 4: PHASE-GATE (machine verification)
PHASE 5: DONE (build badge + learning loop + auto-PR)
```

---

## State persistence (`docs/<slug>/BUILD_STATE.json`)

After EVERY state change, write/update this file. This is what makes `/build resume` work.

```json
{
  "slug": "<slug>",
  "status": "planning|awaiting_approval|executing|blocked|gate_check|complete|rolled_back",
  "phase": 2,
  "total_phases": 4,
  "current_task": "P2-03",
  "tasks_done": 7,
  "tasks_total": 15,
  "last_critic": "PASS",
  "retries": 0,
  "blocked_reason": null,
  "started_at": "2026-05-16T10:00:00Z",
  "last_updated": "2026-05-16T10:45:00Z",
  "paused_reason": null,
  "branch": "feat/coupon-redemption",
  "commits": ["abc1234", "def5678"],
  "architect_reviews": 1,
  "council_decisions": ["chose JWT over session cookies — latency won"],
  "cost_estimate": {
    "estimated_minutes": 45,
    "estimated_input_tokens": 120000,
    "estimated_output_tokens": 40000
  },
  "actual_cost": {
    "elapsed_minutes": null,
    "actual_input_tokens": null,
    "actual_output_tokens": null
  }
}
```

---

## Execution rules

### Autonomy level

- **Run automatically:** clarifier, research, spec writing, architect gate, LLM council, dependency validation, branch creation, task execution, tests, lint, typecheck, critic review, phase-gate, build badge, learning loop
- **Pause for user ONLY when:**
  - Spec needs approval (PHASE 2 — mandatory)
  - Critic returns FAIL with ambiguous AC (needs judgment)
  - Executor returns BLOCKED (missing credential, missing infra)
  - Rollback requested (destructive — needs confirmation)
  - 3+ consecutive failures on same item

### Notification

When pausing, ALWAYS:
1. `PushNotification` — short alert to phone/desktop
2. `AskUserQuestion` — inline with concrete options
3. Wait — never proceed without response

### Critic cadence

Critic runs **after EVERY task** — catches drift immediately.

### Auto-triggered dry-runs

These dry-run modes fire automatically at key decision points — no manual invocation needed:

| Trigger | Dry-run mode | Why |
|---------|-------------|-----|
| `/build resume` on any build paused >2h | `remaining` | Shows you what's left before committing to restart |
| Critic returns FAIL | `fix` | Shows the fix plan before auto-fix attempts it |
| Build enters Phase 2 (approval) | `remaining` summary | Quick cost/scope recap embedded in the approval prompt |
| 3+ retries on same task (escalation) | `fix` + `adjust` option | "Here's what I tried — want to adjust the plan instead?" |

The preview is **inline** — it shows within the normal flow, not as a separate command. You still get the full output as if you typed the command, but you didn't have to.

### Retry logic

- Executor `BLOCKED` → pause, ask user, resume
- Executor `NEEDS_PLAN_REVISION` → auto-invoke planner, retry
- Critic `FAIL` (clear gaps) → show `dry-run fix` preview, then auto-fix (max 2 retries per AC)
- Critic `FAIL` 3× same AC → show `dry-run fix` + offer `dry-run adjust`, pause, escalate
- Phase-gate fail → auto-fix (max 2), then pause

---

## Process (step by step)

### PHASE 0 — Clarify (conditional)

- If brief < 200 words OR missing ACs/integrations: spawn `clarifier` agent
- If already detailed: skip to Phase 1

Update BUILD_STATE: `status: "planning"`

### PHASE 1 — Plan + LLM Council

Spawn `planner` agent. It produces requirements.md, design.md, tasks.md.

#### Automatic LLM Council trigger (Enhancement #5)

If the planner encounters an architecture decision with 2+ viable options (framework choice, auth model, data storage pattern, API style):

1. Auto-invoke `/llm-council` skill with the decision context
2. Council runs 3 personas: "Pragmatist", "Security-first", "Scalability-first"
3. Each argues their preferred option with trade-offs
4. Council produces a ranked recommendation with confidence score
5. Planner uses the top recommendation (if confidence > 70%)
6. If confidence < 70%: flag for user decision in Phase 2

Record council decisions in BUILD_STATE: `council_decisions[]`

Wait for `PLANNER → COMPLETE`.

### PHASE 1.5 — Dependency Validation + Cost Estimate

#### Dependency ordering check (Enhancement #7)

After tasks.md is written, validate task ordering:

1. Parse all tasks — extract file paths each task will create/modify
2. For each task T[n], check: does it import/reference files that T[m] (where m > n) creates?
3. If dependency violation found: auto-reorder tasks.md (swap the dependent tasks)
4. If circular dependency: flag to planner for decomposition

```
Dependency check:
  P1-03 "Create auth middleware" → creates src/middleware/auth.ts
  P1-02 "Add protected route" → imports from src/middleware/auth.ts
  ⚠️ P1-02 depends on P1-03 — reordering: P1-03 before P1-02
```

#### Cost estimation (Enhancement #6 — calibrated)

Calculate time and cost, CALIBRATED against past builds:

1. Parse tasks.md complexity ratings
2. Base rates: c1=5min, c2=20min, c3=60min, c4=180min + 30% overhead
3. Check `~/.claude/state/build-retrospectives.json` for calibration multiplier
4. If 3+ past builds exist: multiply by actual/estimated ratio from history
5. Display calibrated estimate

```
COST ESTIMATE (calibrated from 5 past builds)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tasks:       c1×4  c2×5  c3×3  c4×1
Est. time:   ~3.2 hours (1.3x calibration factor)
Est. tokens: ~234k input / ~72k output
Est. cost:   ~$1.10 (at Sonnet rates)
Confidence:  HIGH (based on 5 similar builds)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Update BUILD_STATE: `status: "awaiting_approval"`

### PHASE 2 — Approve (USER DECISION)

Present spec summary + cost estimate. Ask:
- A: "Approve and start building"
- B: "Review docs first"
- C: "Revise"

On approval: `touch docs/<slug>/APPROVED`, proceed.

### PHASE 2.5 — Auto-Branch (Enhancement #8)

Automatically create and switch to a feature branch:

```bash
git checkout -b feat/<slug>
```

Rules:
- If already on a non-main branch that matches the slug: stay on it
- If on main: create `feat/<slug>` from HEAD
- If on an unrelated branch: warn user, ask if they want to stash and switch
- Record branch name in BUILD_STATE: `branch: "feat/<slug>"`

This ensures ALL build work is isolated from main. No risk of polluting the default branch.

Update BUILD_STATE: `status: "executing"`

### PHASE 3 — Execute + Architect Gate + Critique (loop)

For each unchecked task in `tasks.md`:

```
3a. Update BUILD_STATE: current_task = <task-id>

3b. ARCHITECT GATE (Enhancement #2) — for c≥4 tasks ONLY:
    - Spawn `ezra-architect` agent with:
      - The task description
      - The relevant section of design.md
      - The files that will be touched
    - Architect returns: PROCEED / CONCERN / REDESIGN
    - PROCEED → continue to 3c
    - CONCERN → log the concern, continue (non-blocking advisory)
    - REDESIGN → spawn planner to revise the task, then retry

3c. Spawn EXECUTOR agent for the task

3d. Handle executor status:
    - COMPLETE → proceed to 3e
    - BLOCKED → pause, notify user, wait
    - NEEDS_PLAN_REVISION → planner fixes, retry

3e. Spawn CRITIC agent on the latest commit

3f. Handle critic verdict:
    - PASS → update BUILD_STATE (tasks_done++, add commit), go to 3a
    - FAIL → auto-fix (max 2 retries), then escalate

3g. Display progress block
```

#### Parallel execution

Tasks marked `[parallel]` or in a `<!-- parallel: ... -->` directive:
- Spawn each in a separate worktree
- Architect gate STILL runs per-task (parallel tasks can each be complex)
- Critic runs on EACH after completion
- Merge worktrees back

### PHASE 4 — Phase-Gate

1. Invoke `/phase-gate` skill
2. PASSED → `.phase-done` marker, advance to next phase
3. FAILED → auto-fix (max 2), then pause

### PHASE 5 — Done + Badge + Learning Loop

When all phases complete:

#### 5a. Final verification

1. Run final critic on full diff (`main...HEAD`) with `mode=adversarial`
2. Run `/phase-gate` one last time

#### 5b. Build Badge (Enhancement #9)

Auto-generate `docs/<slug>/BUILD_REPORT.md`:

```markdown
# Build Report: <slug>

## Summary
- **Status:** COMPLETE
- **Duration:** 2h 45m (estimated: 3.2h)
- **Tasks:** 15/15 done
- **Commits:** 12
- **Tests added:** 23 (all green)
- **Coverage on new code:** 97%
- **Branch:** feat/<slug>

## Critic Reports
| Task | Verdict | Gaps found | Retries |
|------|---------|-----------|---------|
| P1-01 | PASS | 0 | 0 |
| P1-02 | PASS | 1 (fixed) | 1 |
| ... | ... | ... | ... |

## Architect Reviews
- P2-04 (c=4): PROCEED — "clean separation of concerns"

## LLM Council Decisions
- Auth model: JWT over session cookies (3/3 consensus, latency argument won)

## Phase-Gate Results
| Phase | Tests | Typecheck | Coverage | Security | Playwright |
|-------|-------|-----------|----------|----------|-----------|
| 1 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 2 | ✅ | ✅ | ✅ | ✅ | ✅ |

## Cost
- Estimated: ~234k input / ~72k output (~$1.10)
- Actual: ~198k input / ~61k output (~$0.92)
- Efficiency: 16% under estimate
```

#### 5c. Learning Loop (Enhancement #4)

Auto-append to `~/.claude/state/build-retrospectives.json`:

```json
{
  "slug": "<slug>",
  "completed_at": "2026-05-16T12:45:00Z",
  "tasks_total": 15,
  "tasks_retried": 2,
  "tasks_blocked": 1,
  "blocked_reasons": ["missing STRIPE_KEY"],
  "architect_reviews": 1,
  "council_decisions": 1,
  "estimated_minutes": 192,
  "actual_minutes": 165,
  "calibration_ratio": 0.86,
  "estimated_tokens": { "input": 234000, "output": 72000 },
  "actual_tokens": { "input": 198000, "output": 61000 },
  "critic_pass_rate": 0.87,
  "lessons": [
    "c=3 tasks averaging 45min not 60min in this codebase",
    "auth-related tasks always need vault lookup — add to checklist"
  ]
}
```

This data feeds back into:
- Cost calibration (Enhancement #6) — future estimates use the average ratio
- Task complexity accuracy — over time, c=3 might calibrate to 45min not 60min
- Common block patterns — if "missing vault key" appears 3+ times, surface a pre-check

#### 5d. Summary + Auto-PR offer

```
BUILD COMPLETE: <slug>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tasks:       15/15 done
Commits:     12
Tests:       23 new, all green
Coverage:    97% on new code
Critic:      PASS (adversarial clean)
Phase-gate:  ALL GREEN
Time:        2h 45m (est: 3.2h — 14% faster)
Cost:        ~$0.92 (est: $1.10 — 16% under)
Branch:      feat/<slug>
Badge:       docs/<slug>/BUILD_REPORT.md
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Auto-PR offer:
- A: "Create PR now" → `gh pr create --title "feat(<slug>): <goal>" --body <from requirements.md>`
- B: "Push and PR manually"
- C: "Not yet"

---

## `/build dry-run` — Preview & Impact Analysis (Enhancement #1)

Dry-run has multiple modes. **All are read-only** — no files written, no branches, no state changes.

### Mode A: New build preview

```
/build dry-run <brief>
```

Preview what a NEW build would produce:

1. Run clarifier (if needed) — show the clarified brief, don't write
2. Run planner in "preview mode" — generate tasks in memory, don't write files
3. Show:

```
DRY RUN PREVIEW: <slug>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Would create:
  docs/<slug>/requirements.md  (~5 user stories, ~12 ACs)
  docs/<slug>/design.md        (~3 integrations, 1 sequence diagram)
  docs/<slug>/tasks.md         (~14 tasks across 3 phases)

Task breakdown:
  Phase 1 — Setup:        c1×2, c2×3        (~1.5h)
  Phase 2 — Core:         c2×2, c3×3, c4×1  (~5h)
  Phase 3 — Polish:       c1×1, c2×2        (~45m)

Files likely touched:
  src/services/coupon.ts (new)
  src/routes/redeem.ts (new)
  src/middleware/validation.ts (modify)
  tests/coupon.test.ts (new)
  ... (~8 files total)

Estimated:
  Time:    ~7h autonomous
  Tokens:  ~350k input / ~110k output
  Cost:    ~$1.65

Architect gate would fire: 1 time (the c=4 task)
LLM council might fire: if auth model decision arises

Proceed with /build <brief> to execute.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Mode B: Adjust an existing build

```
/build dry-run adjust <slug> <what-to-change>
```

Preview the impact of modifying a build that's in-progress or complete:

1. Read existing `docs/<slug>/BUILD_STATE.json`, `requirements.md`, `design.md`, `tasks.md`
2. Analyze the proposed change against current state
3. Show impact analysis:

```
DRY RUN — ADJUST: coupon-redemption
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Proposed change: "Add rate limiting to the redemption endpoint"

CURRENT STATE:
  Status:     executing (8/15 tasks done)
  Branch:     feat/coupon-redemption
  Phase:      2 of 3

IMPACT ANALYSIS:
  Tasks affected:     2 existing + 1 new
  ├── P2-04 "redemption endpoint" — needs modification (rate limit middleware)
  ├── P2-06 "integration tests"  — needs additional test cases
  └── NEW   "add rate limit config + tests" [c=2, ~20min]

  Files to change:    3
  ├── src/routes/redeem.ts (add middleware import)
  ├── src/config/limits.ts (new)
  └── tests/redeem.rate-limit.test.ts (new)

  Ripple effects:
  ├── design.md needs "Rate limiting" section
  ├── P2-04 AC needs new criterion: "rejects >10 req/min per user"
  └── No dependency ordering change needed

  Cost delta:     +~35min, +~45k tokens
  Risk:           LOW (additive change, no existing tests break)

WHAT WOULD HAPPEN:
  1. Planner revises tasks.md (insert task, update 2 ACs)
  2. Executor picks up revised plan after current task completes
  3. Critic re-validates affected tasks with new ACs

PROCEED OPTIONS:
  /build adjust coupon-redemption "Add rate limiting to redemption endpoint"
  → applies the change and resumes execution
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Mode C: Preview remaining work

```
/build dry-run remaining <slug>
```

For paused or in-progress builds — "what's left?":

1. Read BUILD_STATE.json + tasks.md
2. Calculate remaining work from current position
3. Show:

```
DRY RUN — REMAINING: health-dashboard
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CURRENT STATE:
  Status:     blocked (missing STRIPE_SECRET_KEY)
  Progress:   4/10 tasks done
  Paused at:  P2-03 "Wire Stripe webhook handler"

REMAINING WORK:
  P2-03  Wire Stripe webhook handler       [c=3] ~60min  ← BLOCKED
  P2-04  Add payment event processing      [c=3] ~60min
  P2-05  Dashboard aggregation service     [c=2] ~20min
  P3-01  E2E tests for payment flow        [c=2] ~20min
  P3-02  Error handling + retry logic      [c=2] ~20min
  P3-03  Documentation                     [c=1] ~5min
  ──────────────────────────────────────────────────────
  TOTAL:   6 tasks, ~3h, ~$0.95

BLOCKERS TO RESOLVE:
  ⚠️  STRIPE_SECRET_KEY — vault.py set stripe STRIPE_SECRET_KEY

AFTER UNBLOCK:
  Architect gate: 0 fires (no c≥4 remaining)
  Critic runs:    6 (one per task)
  Phase-gate:     1 final run

RESUME: /build resume health-dashboard
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Mode D: Preview a fix

```
/build dry-run fix <slug> <what-to-fix>
```

For when a task failed or the critic found issues — preview the fix path:

1. Read BUILD_STATE (find failed/retried tasks)
2. Analyze the proposed fix
3. Show what execution would look like:

```
DRY RUN — FIX: coupon-redemption
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Issue: "P2-02 critic FAIL — missing edge case for expired coupons"

FIX ANALYSIS:
  Root cause:     AC 2.3 requires expired coupon returns 410 Gone,
                  but handler only checks `isValid` (misses expiry)

  Files to modify: 2
  ├── src/services/coupon.ts:47 — add expiry check in validateCoupon()
  └── tests/coupon.test.ts — add "expired coupon returns 410" case

  Approach:
  1. Executor adds `if (coupon.expiresAt < Date.now())` guard
  2. Returns { valid: false, reason: "expired" }
  3. Route handler maps "expired" → 410 response
  4. Test asserts 410 for expired coupon fixture

  Estimated:      ~10min, ~15k tokens
  Risk:           NONE (additive fix, existing tests unaffected)
  Critic re-run:  will re-check AC 2.3 specifically

PROCEED: /build resume coupon-redemption
  → executor will apply this fix as its next action
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Dry-run rules (all modes)

- **NEVER write files** — all analysis is in-memory or via git/grep
- **NEVER create branches** — this is pure preview
- **NEVER update BUILD_STATE.json** — read-only
- **CAN read existing specs, code, and state** — needs file access to analyze impact
- **CAN run planner in "preview" mode** — ask it to think without writing
- **Show the `/build` or `/build resume` command** to execute when user is ready

---

## `/build rollback <slug>` (Enhancement #3)

Reverts all commits from a build. **Always asks confirmation** (destructive).

Process:
1. Read `docs/<slug>/BUILD_STATE.json` → get commit list
2. Show what will be reverted:

```
ROLLBACK PREVIEW: <slug>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Will revert 12 commits:
  abc1234 — P1-01: scaffold auth module (AC1.1)
  def5678 — P1-02: add JWT validation (AC1.2)
  ...

Files that will be restored to pre-build state:
  src/services/coupon.ts (delete — was new)
  src/middleware/validation.ts (revert changes)
  ...

This is IRREVERSIBLE after push. Proceed?
```

3. On user confirmation:
```bash
git revert --no-commit <sha1> <sha2> ... <shaN>
git commit -m "revert: rollback build '<slug>' (12 commits)"
```

4. Update BUILD_STATE: `status: "rolled_back"`
5. Keep docs/<slug>/ intact (the spec is still valid — just the implementation is reverted)

---

## `/build queue` (Enhancement #10)

Multi-build orchestration — processes multiple features sequentially:

```
/build queue Add coupon redemption | Implement health dashboard | Wire Stripe billing
```

Process:
1. Parse the pipe-separated briefs
2. For each, run a quick dry-run estimate (total cost/time)
3. Present the queue:

```
BUILD QUEUE — 3 features
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Feature                    Est. time  Est. cost
1  coupon-redemption           ~3h        ~$1.10
2  health-dashboard            ~5h        ~$1.85
3  stripe-billing              ~4h        ~$1.50
─────────────────────────────────────────────────
   TOTAL                       ~12h       ~$4.45
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Each build pauses for spec approval. Approve all 3 now, or one at a time?
```

Options:
- A: "Approve all specs at once" — plans all 3, presents all specs together, one approval unlocks all
- B: "One at a time" — standard flow, pauses between each build
- C: "Revise the queue" — remove/reorder items

After approval, builds run sequentially:
- Build 1 → complete → Build 2 → complete → Build 3 → complete
- If any build blocks: notification, skip to next, come back to blocked one
- Final summary shows all 3 results together

---

## Architect Gate detail (Enhancement #2)

Fires AUTOMATICALLY before any task with complexity ≥ 4.

**Trigger:** Task has `[c=4]` in tasks.md.
**Agent:** `ezra-architect` (already exists in your agent roster)

Prompt to architect:
```
Review this task before implementation:
  Task: <task description>
  Design context: <relevant section from design.md>
  Files to touch: <inferred from task>
  AC: <the acceptance criterion>

Answer: PROCEED, CONCERN (with note), or REDESIGN (with alternative approach).
Focus on: separation of concerns, coupling, testability, reversibility.
```

Outcomes:
- **PROCEED** → executor runs the task normally
- **CONCERN** → log it in BUILD_STATE, proceed anyway (non-blocking advisory). Concern shows up in BUILD_REPORT.md
- **REDESIGN** → auto-spawn planner to revise just this task (decompose, different approach). Then re-run architect gate on the revised task.

---

## Batch-task optimization

If the next 3-5 tasks are ALL complexity ≤ 2 AND sequential:
- Use executor batch mode
- Architect gate SKIPPED for c≤2 (not worth the overhead)
- Critic still runs after EACH task

---

## Anti-patterns (refuse)

- Skipping Phase 2 (approval) — NEVER auto-approve a spec
- Running executor without APPROVED marker
- Ignoring critic FAIL — always address gaps
- Pushing to remote without user permission
- Continuing past 3 consecutive failures without user input
- Modifying requirements.md or design.md during execution (planner-only)
- Running /build for a bug fix or trivial task (overkill)
- Forgetting to update BUILD_STATE.json — this breaks resume
- Rolling back without explicit user confirmation
- Skipping architect gate on c=4 tasks
- Auto-approving LLM council decision with confidence < 70%

---

## Edge cases

- **User interrupts mid-pipeline:** Save BUILD_STATE with `paused_reason`, ready for `/build resume`
- **Context window pressure:** Save state, compact. Resume reads state file.
- **Multiple phases:** Each phase = mini-pipeline (execute → gate → advance)
- **Parallel tasks:** Spawn in worktrees, architect gate per-task, critic per-task
- **Resume after >2h gap:** Auto-show `dry-run remaining` before executing (gives you the lay of the land)
- **Stale build (>24h):** Warn user, ask if they want to re-assess
- **Rollback after push:** Warn that remote will need force-push (blocked by destructive-ops rule — user must push manually)
- **Queue with one blocked build:** Skip to next, notification about the blocked one, come back after queue completes
- **Architect says REDESIGN but planner already approved:** The architect gate is a REFINEMENT of the plan, not an override. It can decompose a task or suggest an alternative approach, but cannot change acceptance criteria (those are user-approved).
