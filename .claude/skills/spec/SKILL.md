---
name: spec
description: Kiro-style spec-driven development. Interview the user about a feature or project to produce requirements.md, design.md, and tasks.md under docs/<slug>/. Fires when the user says "I want to build X", "new project", "let's plan Y", "kick off", or similar project-scoping language. Do not use for bug fixes or trivial edits.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git status), Bash(ls *), Bash(mkdir *), Bash(touch *)
---

# /spec — Kiro-style spec-driven development

Produces three canonical project artefacts in `docs/<slug>/` before any code is written:

- `requirements.md` — EARS-notation user-facing requirements
- `design.md` — technical design, data model, API shape, sequence diagrams
- `tasks.md` — ordered phased task list with checkboxes

The **plan-gate** hook (PreToolUse) blocks all `Write`/`Edit` outside `docs/**` until a file named `docs/<slug>/APPROVED` exists. `/spec` is the canonical way to produce the spec so the gate can be unlocked.

## When to use this skill

- User introduces a new project or feature — "I want to build X", "let's add Y", "new project", "start a project for Z"
- User explicitly asks for a plan / spec / PRD
- There's no existing `docs/<slug>/` matching the request

## When NOT to use this skill

- Bug fix to existing code (use normal flow)
- Small refactor (use normal flow)
- Documentation edit (edit directly)
- User says "just do X" as a one-off (use normal flow)

## Process

### Step 1 — Derive `<slug>`

From the user's intent, pick a short kebab-case slug (2–4 words max). Examples:
- "add coupon code redemption" → `coupon-redemption`
- "build a health dashboard" → `health-dashboard`
- "bolt on Stripe billing" → `stripe-billing`

Confirm the slug with the user in one sentence before proceeding.

### Step 2 — Interview iteratively

Ask clarifying questions **one topic at a time** until each topic has enough detail to write a spec section. Cover:

1. **Goal** — what problem does this solve? Why now?
2. **Non-goals** — what is explicitly OUT of scope?
3. **Users** — who calls / clicks / triggers this?
4. **User stories** — 3–7 concrete user stories
5. **Acceptance criteria** — EARS notation: "When X happens, the system shall Y." One per story.
6. **Constraints** — deadlines, compliance, dep compatibility, performance targets
7. **Integrations** — external services touched (APIs, DBs, MCPs), auth models
8. **Data model** — entities, relationships, storage
9. **Open questions** — anything the user can't answer yet (record, don't block on)

Keep each question focused. Don't ask 6 questions in one turn.

### Step 2.5 — Research before design

Before writing `design.md`, do live-doc research. Inspired by Taskmaster AI's research phase ([eyaltoledano/claude-task-master](https://github.com/eyaltoledano/claude-task-master)) — this is the single biggest delta between a spec that ages well and one that breaks against reality:

1. **For every external library / framework** the design will touch, call `mcp__context7__resolve-library-id` then `mcp__context7__query-docs` to pull **version-pinned** current docs. Do NOT rely on training-data knowledge for library APIs.
2. **For complex architectural choices** (auth model, data sync, concurrency, caching), call `mcp__sequential-thinking__sequentialthinking` to think through trade-offs explicitly before committing to one.
3. **For prior art in this codebase** (does a similar pattern already exist?), call `mcp__serena__find_symbol` or `mcp__serena__find_referencing_symbols` to avoid reinventing.
4. **Record** the sources consulted at the top of `design.md` under a `## Research notes` heading. Include library+version, the query you asked, and the 1-line takeaway.

Skip this step only for truly trivial specs (single-file helpers, typo-fix patches). For anything crossing library / service / data boundaries, it's mandatory.

### Step 3 — Write `docs/<slug>/requirements.md`

Structure:
```markdown
# <Title> — Requirements

## Goal
<1–3 sentences>

## Non-goals
- ...

## Users
- <role>: <what they do>

## User stories & acceptance criteria (EARS)
### Story 1 — <short title>
As a <role>, I want to <action> so that <outcome>.

**Acceptance criteria**
- When <trigger>, the system shall <behaviour>.
- When <trigger>, the system shall <behaviour>.

### Story 2 ...

## Constraints
- ...

## Open questions
- [ ] <question> — blocker? y/n
```

### Step 4 — Write `docs/<slug>/design.md`

Structure:
```markdown
# <Title> — Design

## Architecture overview
<1-paragraph + Mermaid diagram if helpful>

## Data model
<tables / schemas / types>

## API / interface
<endpoints, method signatures, event shapes>

## Integrations
<external services: auth, rate limits, failure modes>

## Sequence
<Mermaid sequenceDiagram for the main flow>

## Risks & mitigations
- <risk>: <mitigation>
```

### Step 5 — Write `docs/<slug>/tasks.md`

Ordered, phase-structured task list. Each phase ends with a `.phase-done` marker (for the phase-loop hook). **Every task gets a complexity rating 1–5** (inspired by Taskmaster AI — [eyaltoledano/claude-task-master](https://github.com/eyaltoledano/claude-task-master)) — this makes phase-loop time estimates realistic and flags where `/ezra:plan` or deeper research is needed.

Complexity scale:
- **1** — Trivial (rename, literal string change, boilerplate). ≤ 5 min.
- **2** — Small (one function/class in an existing module; no new deps). ≤ 30 min.
- **3** — Medium (new module; touches 2–3 files; standard patterns). ≤ 2 hrs.
- **4** — Large (new service/subsystem; needs `/ezra:plan` or ADR; multi-file refactor). ≤ 1 day.
- **5** — Epic (architectural choice; may require splitting across phases). **→ Do NOT include at c=5 — split into smaller tasks first.**

Format:

```markdown
# <Title> — Tasks

## Phase 1 — <short name>
- [ ] **[c=2]** Task 1 — 1-line description
- [ ] **[c=3]** Task 2 — 1-line description
- [ ] **[c=1]** Task N — 1-line description
- [ ] Phase-gate: all tests + coverage + PRD criteria for Phase 1

## Phase 2 — <short name>
- [ ] **[c=2]** ...
```

If a phase has more than 2 c≥4 tasks, split it into two phases. If any task is c=5, run `/ezra:plan` on just that task to decompose further before writing it into tasks.md.

### Step 6 — Log decisions to avios-context

For each architecturally-significant choice that came out of the interview (framework pick, auth model, storage, etc.), call `mcp__avios-context-mcp__avios_add_decision` with project=<slug>.

### Step 7 — Stop and hand back

Say something like:

> Plan is ready in `docs/<slug>/{requirements,design,tasks}.md`.
> Review the 3 docs; when satisfied, run:
>
> ```
> touch docs/<slug>/APPROVED
> ```
>
> That unlocks code edits for this project. Until then I'll only edit files under `docs/**`.

**Do NOT start writing code.** The plan-gate hook will block edits outside `docs/**` without the APPROVED marker — respect that.

## Revising after plan is written

If the user wants to change the plan:
- Re-run `/spec` on the same slug — it regenerates the 3 files
- Do NOT hand-edit the 3 files directly; they should stay as artefacts of the `/spec` interview

## Gotchas

- **Slug collisions** — if `docs/<slug>/` already exists, confirm with the user: revise that project, or pick a different slug?
- **Over-long interviews** — cap at 20 questions. If you haven't got enough, record the gaps in "Open questions" and proceed. Perfect is the enemy of approved.
- **Skipping EARS** — don't. EARS ("When X, the system shall Y") is a contract; woolly acceptance criteria = endless gap loops later.
- **Plan bloat** — 3–7 user stories is the sweet spot. 15+ means the project should be split.
