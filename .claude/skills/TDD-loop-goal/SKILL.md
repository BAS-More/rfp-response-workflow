---
name: TDD-loop-goal
description: >
  Autonomous Ralph-loop TDD build to shipped, production-quality, tested, hardened
  software. Sibling of /goal — adds a Ralph continuous-loop driver and scientific-method
  debugging (Halloway). Workers are cheap non-Anthropic/OpenAI models (Kimi/GLM/Qwen/DeepSeek
  tier) chosen by a deterministic, route-liveness-aware caster. Invoke ONLY
  when the user types /TDD-loop-goal (or pastes their /goal spec asking for a Ralph run).
  Runs premium (Anthropic/OpenAI) models ONLY at consensus + final validation; all coding,
  testing and review go to cheap non-Anthropic/OpenAI models via PAL. Builds every phase
  non-stop, gap+drift remediation to 100% after each phase, whole-repo E2E in cleanup.
  Never auto-commit, push, or deploy. Do not infer invocation from requests that never name it.
disable-model-invocation: true
user-invocable: true
argument-hint: "[dry-run] <mission | path to to-do list / docs>"
allowed-tools: Agent, AskUserQuestion, Skill, ToolSearch, Workflow, Bash, Read, Write, Edit, Glob, Grep, PushNotification
---

# /TDD-loop-goal — Ralph-loop TDD Autonomous Build

Take a mission (or a to-do/docs folder) from plan to shipped software, running a **Ralph loop**
until the to-do list is empty and every quality gate is green. Quality is a **gate-enforced
floor**; cost is what varies. Never trades quality for cost, never emits a false completion.

## Execution model (load-bearing — read first)

- **Orchestrator = this Claude Code session** (the harness). Plans, casts, dispatches, judges.
  Not a "worker", so its Anthropic model does not violate the no-Anthropic/OpenAI-workers rule.
- **Workers = PAL calls to cheap non-aoai models** (`pal chat/thinkdeep/codereview/debug/testgen`,
  each with an explicit `model`). Coder ≠ tester ≠ reviewer. Scope each worker to code/docs/test
  tools only — never push/deploy/rm.
- **Premium (Anthropic/OpenAI) only at 2 leverage points:** consensus (Step 0) and final
  validation (Step 5, `pal precommit`).
- **Continuation driver = the Workflow tool (PROVEN here), NOT the ralph-loop stop-hook.** A plain
  skill invocation does NOT self-continue — when a turn ends the session yields and the run PARKS
  ("next steps whenever you want"); that parking is the #1 way past runs died. The `ralph-loop`
  plugin's Stop-hook re-feed was tested **live 2026-09-02 and this harness IGNORED it** (its stop
  `decision:block` did not re-feed — the run just waited for the user). So drive continuation with
  the **Workflow tool**: encode the phases as a workflow script that runs every phase to completion
  in ONE background execution and returns only when the completion-promise holds — proven to run
  multi-phase non-stop here. Native fallback: `/loop` (ScheduleWakeup). Use `ralph-loop` ONLY after
  you verify this harness honors Stop-block re-feed (it did not). See [REFERENCE.md](REFERENCE.md) §1.
- **No park-and-ask (non-negotiable).** A finished phase → immediately start the next phase in the
  SAME turn. NEVER end a turn with "parked in review" / "tell me to continue" / a question at a phase
  boundary. The ONLY sanctioned stops: (1) completion-promise truthfully emitted, (2) a CRUCIAL flag
  (PushNotification, then continue the other threads), (3) the INCOMPLETE terminal. Everything else →
  DECISIONS.md and keep going.

## Start contract

The invocation authorizes the mission. `/TDD-loop-goal dry-run <mission>` plans + casts + estimates
cost and STOPS (no code). Resolve every undefined knob **once, up front, in a single
AskUserQuestion** — including `tdd_school` (london | detroit | hybrid) and the completion-promise
text. After approval, the build runs non-stop.

## Pipeline

**Step 0 — Consensus (premium, leverage point 1).** JIT-load PAL
(`ToolSearch select:mcp__onemcp__pal_1mcp_consensus,...precommit,...chat,...debug,...codereview`).
If PAL is down, bring it up before proceeding (never silently fall back to premium workers). If
PAL is UP but the premium route returns HTTP 402 (unfunded account) or is otherwise unreachable,
that is a **CRUCIAL blocker → flag Avi** — Step 0 cannot run on a dead premium route (optionally
downshift consensus to the best *reachable* non-aoai models and mark it DEGRADED in DECISIONS.md).
Run `pal consensus` with `anthropic/claude-fable-5` (for) + `openai/gpt-5.6-sol` (against/neutral)
on the mission → agree the plan, phase breakdown, and the full role roster. The two consensus
models become **orchestrator** (winner) and **tester/validator** (runner-up).

**Step 1 — Cast roles (deterministic + route-liveness-aware).** Run `pal listmodels`, build a
**reachability set** (a cheap 1-call ping per distinct provider — see REFERENCE §2), reconcile
against `C:/Dev/skill-router/layer2/models.json`, then `cast(defaultRoster(), models.json,
{reachable})` so a dead route is NEVER nominated. Reality to keep honest: `defaultRoster()` casts
ONE generic `coder` by cheapest-clears-the-bar — it is **not** a frontend/backend split. To pin
Kimi for FE and GLM for BE, add explicit `frontend-coder`/`backend-coder` roles to the roster.
`z-ai/glm-5.3` does not exist → use `z-ai/glm-5.2` (or `ollama/glm-5.2`). Record the cast + any
reroute in DECISIONS.md.

**Step 2 — Pre-code rigor gate (HARD stop, once).** Before ANY code: (1) a **Phase-0 executable
completion manifest** — objectives + EARS acceptance criteria (via `/spec`), a threat model,
API/event contracts, deployment profiles, and explicit non-goals; completion is later checked
against THIS manifest, not prose; (2) full code-overview + dependency graph from the real repo
(`knowledge-graph` + `gitnexus` PDG/taint), query `impact()` for blast radius; (3) present plan +
cast + cost estimate → **one approval pause** (the ONE sanctioned pause of the whole run). On approval:
(a) **arm a continuation driver this harness actually honors** — build the phased plan as a **Workflow**
script (REFERENCE §1) that runs every phase to completion in one background execution and returns only
when the completion-promise holds; this is the driver proven to run non-stop here. Do NOT rely on
`ralph-loop`'s Stop-hook (this harness ignored its re-feed, 2026-09-02); `/loop` is the native fallback.
A bare, unlooped invocation WILL park at the first phase boundary — the #1 past failure. (b) create the
fail-closed sentinel `~/.claude/.ralph-goal-active`
(arms the `ralph-goal-fail-closed.js` PreToolUse guard that gates push/deploy/publish/live-payment/
secrets); **remove it at completion or the INCOMPLETE terminal**. Then build non-stop,
phase→phase→cleanup, yielding only at the completion-promise, a crucial flag, or the INCOMPLETE terminal.

**Step 3 — Non-stop phased Ralph-TDD build.** For each phase, drive the cast via the **direct-HTTP
swarm**, NOT by having a Workflow/Anthropic agent call the PAL MCP tool (that path serializes at
concurrency 1 and, because delegation is only prose, the agent ends up coding itself in Anthropic
tokens — the exact 2026-09-02 failure). Instead:
- **Dispatch codegen via `python C:/Dev/skill-router/layer2/dispatch.py job.json`** (built + tested
  2026-09-02). It fans role-cast prompts to the cheap non-aoai models over independent HTTP sessions
  (concurrency-capped: Ollama=1, per-provider 3, global 6), strips PAL's continuation/`AGENT'S TURN`
  trailer + code fences + trailing fenced prose (`clean_generated_code`, fix #9), retries-on-timeout-with-shrink
  then reroutes, reads the large-output sidecar (fix #8), writes each file, and logs
  `provenance.json`. It **REFUSES any Anthropic/OpenAI model** in a worker task (`assert_non_aoai`) —
  the no-aoai contract is enforced in code, not honor-system. The token cap is the top-level
  `max_output_tokens` (the heavier capability-gate spend-ledger needs a PAL route-digest handshake —
  deferred, see REFERENCE §2 / DECISIONS D5). Orchestrator spends ~0 coding tokens.
- **Worker-call limits (route stability, diagnosis 2026-09-02):** never request a whole file in one
  call — cap output to one function / module / ≤~150 lines and assemble across calls. The probe's
  8/10 timeouts were concurrency contention, not dead models: at concurrency 1 the forced
  cheap tier (Kimi-K3, GLM-5.2, Qwen-3.8-max, DeepSeek-V4) answered in 0.6–13s and compiled clean.
  A worker **timeout is a route/size problem, not a code bug** — the swarm shrinks/reroutes; do not
  run scientific-method debugging on it. See [REFERENCE.md](REFERENCE.md) §2.
- **coder** — strict TDD per `tdd_school`: failing test → confirm RED → minimal GREEN → refactor.
- **tester** (distinct model) runs the real oracle test; **reviewer** (distinct model) matches every
  claim to file:line.
- **Before every change:** `impact()` on the code-graph. **After every change:** regression on
  touched + dependents (no green→red).
- **Any failure or surprise → scientific-method debugging** (`superpowers:systematic-debugging`
  + `pal debug`): observe → ≥2 competing hypotheses → predict → experiment → conclude. No
  guess-and-check. See [REFERENCE.md](REFERENCE.md).
- **Per phase:** comprehensive tests + gap (`ezra-reconciler` plan-vs-impl) + drift
  (`detect_changes` + Graphiti) → **remediation loop until 100% clean.**

**Step 4 — Per-build memory graph (validate every session).** Probe `knowledge-graph` + `Graphiti`
liveness first (as with PAL in Step 0); if a gate backend is down, mark its check **UNVERIFIED** —
an unverified gate may NOT satisfy the completion-promise (distinguish "ran and found 0" from
"could not run"). Code graph = `knowledge-graph`
(refreshed from ground truth, never trusted stale). Build graph = `Graphiti` (bi-temporal):
objectives, decisions, invariants, per-session state — a failed check blocks session close →
remediation. Persist decisions to `avios-context` (ADRs) + `total-recall`. Deferred questions →
`DECISIONS.md` at the governance root (outside the target repo).

**Step 5 — Cleanup + validation (premium, leverage point 2).** Fix all residuals + resolve
`DECISIONS.md` → **whole-repo granular E2E against real acceptance criteria** + granular gap/drift
→ `pal precommit` (external premium model, ≥3 steps) as the ship gate → build badge. Only now may
the completion-promise be emitted. PR is **offered, never pushed.**

## Safety (non-negotiable)

- **Loop bound** — the ENFORCED bound is `--max-iterations` plus the INCOMPLETE terminal below. A
  true $-ceiling budget breaker is **not yet implemented** (no per-call cost source is wired), so
  do not claim a spend ceiling; cap the loop, report spend qualitatively, and wire a token ledger
  (models.json $/1k fields + orchestrator tokens) before trusting "non-stop" against a funded account.
- **Flag Avi only on crucial** — irreversible / real money / credentials only he holds / product
  direction. Everything else → `DECISIONS.md`, resolved in cleanup.
- **Never** commit, push, deploy, force-push, `reset --hard`, or delete user data without explicit
  same-turn OK. Credentials via `claude-vault` only.
- **Completion-promise integrity** — never emit it to escape the loop; only when all to-dos are
  done AND all gates green AND E2E passes AND gap/drift is 100% clean, cross-verified against the
  real oracle (whole-repo E2E), not merely a verifier's self-report.
- **INCOMPLETE terminal (second exit)** — on max-iterations, an unresolvable OPEN row, or a dead
  required route, emit a structured INCOMPLETE report (open to-dos, failing gates + reasons, OPEN
  rows) and `PushNotification` Avi. "Ran out" is an honest outcome; the promise is NOT emitted.
- **Honest bar** — "100% / bug-free" is a target the gates + adversarial checks enforce, not a guarantee.

## How to run
- `/TDD-loop-goal <mission>` — full Ralph run. `/TDD-loop-goal dry-run <mission>` — plan + cast + cost, no code.
- Details (loop wiring, model table, scientific-method protocol, gate + DECISIONS formats): [REFERENCE.md](REFERENCE.md).
