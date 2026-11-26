---
name: goal
description: >
  Cheapest-but-best autonomous build. Invoke ONLY when the user types /goal (or says
  "run goal" / pastes their /goal spec) to take a mission from plan to shipped,
  production-quality, tested software using PAL multi-model orchestration — premium models
  only at consensus + final validation, cheap non-Anthropic/OpenAI models (tool-augmented)
  for all the work, quality enforced by gates and a per-build memory graph. Do not infer
  invocation from requests that never name goal. Never auto-commit, push, or deploy.
disable-model-invocation: true
user-invocable: true
argument-hint: "[dry-run] <mission | your /goal spec>"
allowed-tools: Agent, AskUserQuestion, Skill, ToolSearch, Workflow, Bash, Read, Write, Edit, Glob, Grep, TodoWrite, PushNotification
---

# /goal — Cheapest-but-Best Autonomous Build

Layer 2 of the killer tool. Quality is a **gate-enforced floor**; cost is what varies (cheaper models = more loop passes). Never trades quality for cost.

## Execution model (read first — it's the load-bearing design)

- **Orchestrator = this Claude Code session** (the harness). It plans, casts, dispatches, and judges. It is NOT a "worker", so its Anthropic model does not violate the no-Anthropic/OpenAI-workers rule.
- **Workers = the direct-HTTP swarm to cheap models** (`layer2/dispatch.py` over `pal_swarm.py`, built+tested 2026-09-02). Do NOT delegate codegen by having a Claude/Workflow agent call the PAL MCP tool: in-session PAL calls serialize at concurrency 1 (measured 2026-08-12) and prose-only delegation makes the agent code itself in Anthropic tokens (the exact cost failure). `dispatch.py` fans role-cast prompts to cheap models over independent HTTP sessions (concurrency-capped), strips PAL's `AGENT'S TURN` trailer + code fences + trailing fenced prose (`clean_generated_code`), retries-with-shrink→reroute, reads the large-output sidecar, logs `provenance.json`, and **refuses any aoai model** (`assert_non_aoai`) — contract enforced in code. Token cap = top-level `max_output_tokens`.
- **Premium (Anthropic/OpenAI) only at the 2 leverage points:** consensus and final validation.

## Start contract

The invocation authorizes the mission. If `<mission>` is Avi's standing `/goal` spec, treat that as the mission template. `/goal dry-run <mission>` plans + casts + estimates cost and STOPS (no code). Resolve any undefined knob once, up front, in a single AskUserQuestion.

## Pipeline

### Step 0 — Consensus (leverage point 1, premium)
JIT-load PAL: `ToolSearch({query:"select:mcp__onemcp__pal_1mcp_consensus,mcp__onemcp__pal_1mcp_precommit,mcp__onemcp__pal_1mcp_chat,mcp__onemcp__pal_1mcp_codereview", max_results:4})`.
Run `pal consensus` with the cross-vendor pair `anthropic/claude-fable-5` (stance: for) + `openai/gpt-5.6-sol` (stance: against/neutral) on the mission → agree the plan, the phase breakdown, and the roles required. This is the only place premium reasoning is spent up front.

### Step 1 — Cast roles (deterministic)
`node "C:/Dev/skill-router/layer2/casting.js"` logic (or require it): `cast(defaultRoster(), models.json)` → role→model map. Workers are cheap/local non-A/OAI; coder ≠ tester ≠ reviewer. Record the cast in the GATELOG. Retune via `layer2/models.json` + `defaultRoster()`.

### Step 2 — Pre-code rigor gate (HARD stop, once)
Nothing may be broken by accident. Before ANY code:
1. Objectives + EARS acceptance criteria set and validated (use `/spec`).
2. **Full code-overview + dependency graph built from the real repo** — `knowledge-graph` (+ `gitnexus` taint/PDG). Query `impact()` to know blast radius.
3. All dependencies accounted for. Present the plan + cast + cost estimate → **one approval pause** (AskUserQuestion) — the ONE sanctioned pause of the run. On approval, **arm a continuation driver this harness actually honors** — drive the phases with the **Workflow tool** (or `/loop`), proven to run multi-phase non-stop here. Do NOT rely on `ralph-loop`'s Stop-hook: tested live 2026-09-02, this harness ignored its re-feed and the run parked. A bare, unlooped invocation PARKS at the first phase boundary (the #1 past failure). Then coding runs non-stop, phase→phase→cleanup.

### Step 3 — Non-stop phased build
For each phase, dispatch codegen to the cast via `python C:/Dev/skill-router/layer2/dispatch.py job.json` (never a whole file per call — cap to ≤~150 lines and assemble; a worker timeout is a route/size problem, the swarm shrinks/reroutes):
- **coder** (cheap, via dispatch): strict TDD — write a failing test, confirm RED, minimal code to GREEN, refactor. `tdd_school = london|detroit|hybrid` per mission.
- **tester** (distinct cheap model): run the real oracle test against the diff.
- **reviewer** (distinct cheap model): match every claim to file:line.
- **Before every change:** `impact()` on the code-graph. **After every change:** regression on touched + dependents (no green→red).
- Per phase: comprehensive tests + gap (`ezra-reconciler` plan-vs-impl) + drift (`detect_changes` + Graphiti) → **remediation loop until clean** (100%).
- **Phase gate verdict = `goal-gates`** (the reified Step-2/3 gate, built 2026-09-02): collect the phase signals into a GateInput `{tests:{passed,failed,total}, patchCoverage?, mutation?:{killed,survived}, gapOpen?, driftOpen?, spend?, budget?, quarantined?:[{test,reason}], policy?}` and run `node C:/Dev/skill-router/goal-gates/gate.cjs <gateinput.json>` (or `- ` for stdin). **A phase is "done" ONLY when it exits 0 (ship===true).** R0 is enforced in code: a policy-required-but-absent signal FAILS — never a vacuous pass. Default policy requires coverage/gap/drift/budget; relax per mission via the input's `policy`. (`goal-gates` lives at `C:/Dev/skill-router/goal-gates`; `tsc -p tsconfig.cli.json` rebuilds `dist/` if edited.)

### Step 4 — Per-build memory graph (validate every session)
- **Code graph** = `knowledge-graph` (refreshed each session from ground truth; never trusted stale).
- **Build graph** = `Graphiti` (bi-temporal): objectives, decisions, invariants, per-session state. Each session validates against it — drifted? invariant violated? state matches reality? A failed check blocks session close → remediation.
- Persist decisions to `avios-context` (ADRs) + `total-recall` (crystallized digest). Deferred decisions → `DECISIONS.md` at the run's governance root (outside the target repo).

### Step 5 — Cleanup + validation (leverage point 2, premium)
Fix residuals → **whole-repo E2E against real acceptance criteria** + granular gap/drift → `pal precommit` (external premium model, min 3 steps) → **final ship gate = `goal-gates` at whole-repo level**: the completion-promise may be emitted ONLY when `gate.cjs` returns ship===true with EVERY signal present (tests all green, coverage ≥ policy min, mutation within max, gap 0, drift 0, spend ≤ budget, quarantines justified) — R0 means a missing signal blocks the promise. → build badge. PR **offered, never pushed**.

## Safety (non-negotiable)
- **Budget breaker + killswitch** — a hard $ ceiling on PAL/OpenRouter spend; stop when hit and report. "Non-stop" never means "unbounded spend."
- **Flag Avi only on crucial** — irreversible / real money / credentials only he holds / product direction. Everything else → `DECISIONS.md`, resolved in cleanup.
- **No park-and-ask** — a finished phase → immediately start the next in the SAME turn; never end with "tell me to continue" or a phase-boundary question. The only stops are the completion-promise (true), a crucial flag, or an INCOMPLETE report. Parking mid-mission is the exact defect this skill exists to prevent.
- **Never** commit, push, deploy, force-push, reset --hard, or delete user data without explicit same-turn OK.
- **Scoped tools** — workers get code/docs/test tools; destructive tools stay with the human.
- **Honest bar:** "100% / bug-free" is a target the gates + adversarial GOAL-CHECK enforce, not a guarantee.

## How to run
- `/goal <mission>` — full run. `/goal dry-run <mission>` — plan + cast + cost, no code.
- Credentials via `claude-vault` only. Model routing via 9Router/OpenRouter through PAL.

## Build status (honest)
- **Built + tested:** the model-casting engine (`C:/Dev/skill-router/layer2/casting.js`) — Step 1;
  the direct-HTTP cheap-worker path (`layer2/pal_swarm.py` + `dispatch.py`, 44+25 tests, metered
  spend ledger + `max_spend_total` budget breaker) — Step 3; the **reified gate library `goal-gates`
  (`C:/Dev/skill-router/goal-gates`, 31 tests, CLI `gate.cjs`) — Step 2/3 contract, wired above** (first
  built BY this skill, 2026-09-02).
- **Pending increments:** the memory-graph session validators (Step 4), and full precommit wiring
  (Step 5, currently degraded when premium routes are unreachable). Proven end-to-end at scale:
  cronparse (178 tests) and goal-gates (31 tests) were both cheap-tier-authored and green.
