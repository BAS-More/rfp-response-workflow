# /TDD-loop-goal — Reference

Detail behind [SKILL.md](SKILL.md). Load when you need loop wiring, model routing, the
scientific-method debugging protocol, gate definitions, or the DECISIONS.md format.

## 1. Continuation driver (how the run keeps going without parking)

The run must not yield to the user between phases. **What forces continuation is harness-specific,
and was tested live 2026-09-02:**

- **Workflow tool — PRIMARY, PROVEN here.** Encode the phased build as a `Workflow` script that
  pipelines phases → per-phase gate → remediation, looping until the phase list is empty AND the
  completion-promise holds — all in ONE background execution. Verified: a 2-phase run completed
  non-stop, 0 parking. Within a phase, agents route the actual coding to cheap PAL workers via
  ToolSearch, so "Workflow drives, PAL does the cheap work" both hold. This is the default driver.
- **`/loop` — native fallback.** Harness-native recurring re-invocation (ScheduleWakeup). Use when
  the MAIN agent must drive across turns instead of a background workflow.
- **`ralph-loop` plugin — DO NOT rely on it in this harness.** Its Stop-hook emits
  `{"decision":"block","reason":<prompt>}` to re-feed on stop; **this harness IGNORED that**
  (tested 2026-09-02: iteration stuck at 1, the session waited for the user). It works in the vanilla
  `claude` CLI, not in this session's harness. Use only after re-verifying Stop-block re-feed here.

**Completion-promise template** (agree exact text with the user at Step 0, store in DECISIONS.md):
> "All to-do items are checked off, every phase gate is green, whole-repo E2E passes against the
> EARS acceptance criteria, and gap+drift analysis reports 0 open items."

Never emit the promise to escape a stuck loop. Stuck → scientific-method debugging (§3), and if
still blocked after a bounded number of hypotheses, write the blocker to DECISIONS.md and (if
crucial) flag Avi — do not fake completion.

## 2. Model routing

Snapshot: `C:/Dev/skill-router/layer2/models.json` (refresh with `pal listmodels`). `aoai=true`
means Anthropic/OpenAI — **workers must never use aoai models**; premium leverage points may.
Prefer the nominated model; if absent in the live `listmodels`, pick the highest-`score`
non-aoai model at the same or cheaper `costRank` for that role, and **log the swap to DECISIONS.md**.
**Route-liveness (mandatory):** `listmodels` says a model is *configured*, not *reachable* — a
provider account can be unfunded (HTTP 402) while listed. Build a `reachable` set by pinging each
distinct provider once (a 1-token `pal chat`); pass it as `cast(roster, models.json, {reachable})`
so dead routes are filtered BEFORE role assignment. If the whole premium tier is unreachable, a
leverage role downshifts to the best reachable non-aoai model, flagged `rerouted` (→ DECISIONS.md).

**Latency budget + output chunking (diagnosis 2026-09-02).** `reachable` must mean reachable AND
*fast enough for the intended output size* — a route can be live yet too slow. Verified root cause:
the Claude-Code / mcp-remote **client-side MCP call timeout** is far below the hub's 420s PAL budget
(`1mcp.config.json`: PAL `requestTimeout=420000`), so a slow cheap model (`kimi-k3` via OpenRouter)
generating a code-file-sized output is **aborted client-side** ("Request timed out"), and the abort
briefly drops the per-session `mcp-remote` transport → the next call reports "Server onemcp
unavailable" (self-heals). The hub does NOT crash. Therefore:
1. **Cap per-call worker output** — one function / module / ≤~150 lines per `pal chat`; assemble
   across calls. Keep each round-trip well under the client timeout.
2. **Route by size** — large or latency-sensitive generations go to a *fast* live route
   (Gemini-native, or a fast OpenRouter model); reserve slow cheap models for small chunks. Record
   each reachability ping's rough latency so the caster can honour a per-role latency budget.
3. **A worker timeout is a route/size failure, not a code failure** — retry the same smaller unit
   once (transport self-heals), then reroute to a faster model; never run scientific-method debugging
   on it. (Optionally raise the client MCP tool-call timeout so the client matches the hub's 420s.)

| Role | Stage | Nominated | Verified fallback (snapshot) |
|---|---|---|---|
| Consensus A / orchestrator | 0 (premium) | `anthropic/claude-fable-5` | present |
| Consensus B / tester-validator | 0 (premium) | `openai/gpt-5.6-sol` | present (`-sol-pro` alt) |
| Frontend coder | 3 (cheap) | `moonshotai/kimi-k3` | present (score 95) |
| Backend coder | 3 (cheap) | `z-ai/glm-5.3` | **not in snapshot** → `z-ai/glm-5.2` (90) or `ollama/glm-5.2` ($0) |
| Tester (≠ coder) | 3 (cheap) | — | `qwen/qwen3.8-max` / `deepseek/deepseek-v4-pro-0813` |
| Reviewer (≠ coder, ≠ tester) | 3 (cheap) | — | `x-ai/grok-4.6` / `qwen/qwen3-max-thinking` |
| Final validation | 5 (premium) | `pal precommit` w/ `openai/gpt-5.6-sol` | `anthropic/claude-fable-5` |

Casting is deterministic: `require("C:/Dev/skill-router/layer2/casting.js")` →
`cast(defaultRoster(), models.json, {reachable})`. `defaultRoster()` casts ONE generic `coder`
(cheapest-clears-the-bar) — there is **no** frontend/backend split by default, and kimi/glm are
**not** pinned; the live cheapest cast puts Kimi-K3 on the *tester*, not the coder. To get the
"Kimi FE / GLM BE" split, add pinned `frontend-coder`/`backend-coder` (and a `debugger`) role to
`defaultRoster()`. **Independence (consensus 2026-09-01):** for each task keep test-author ≠
implementer ≠ reviewer — ideally split the single `coder` into a `test-author` (writes the failing
test) and a distinct `implementer` (makes it pass), so tests and code never come from one model. Retune via `models.json` + `defaultRoster()`. **`defaultRoster()` now casts pinned
`frontend-coder` (kimi-k3) + `backend-coder` (z-ai/glm-5.2) per Avi's force-cheapest policy
(2026-09-02); `models.json` carries measured `p50s` latency and the caster honors a per-role
`maxLatency`.**

**Worker execution path (built + tested 2026-09-02): `layer2/dispatch.py` over
`layer2/pal_swarm.py`.** Do NOT delegate codegen by having a Workflow/Anthropic agent call the PAL
MCP tool — measured 2026-08-12, in-session PAL calls serialize at concurrency 1, and prose-only
"delegate to PAL" just makes the agent code itself in Anthropic tokens (the exact cost failure).
`dispatch.py job.json` fans role-cast prompts to cheap models over independent HTTP sessions
(concurrency-capped: Ollama=1 / per-provider 3 / global 6), strips PAL's `AGENT'S TURN` continuation
trailer + code fences, retries-on-timeout-with-shrink→reroute, writes files, logs `provenance.json`,
and **refuses any aoai model** (`assert_non_aoai`) so the contract is code-enforced. Token cap = the
top-level `max_output_tokens`. The **spend ledger is LIVE**: `digest_probe.py` computes each model's
`route_revision_digest` via PAL's own code → `route_digests.json`; gated calls return
`capability_gate_attestation` with `settled_spend`/tokens, summed per-file by `dispatch` with a
`max_spend_total` budget breaker (DECISIONS D5 resolved). **Large-output sidecar (fix #8):** PAL
offloads a big code reply to `pal_generated.code` and returns a handoff message; `dispatch` detects
it (`is_sidecar_handoff`) and reads the `<NEWFILE: out_file>` block (`extract_newfile`), else fails
loudly. Keep large single-file generations at concurrency 1 (one shared sidecar per cwd). Chunk to
≤~130 lines/call so outputs return inline in the normal case. Tests: `test_pal_swarm.py` (44),
`casting.test.js` (19), `test_dispatch.py` (25) = 88, + deterministic fix-#8 e2e on PAL's real sidecar.

**9Router note:** PAL's slug IDs route to PAID upstreams (OpenRouter /
Ollama-Cloud); 9Router's own live pools (`ag/*`, `My-pool`) are reached by name at
`POST localhost:20128/v1/chat/completions` — target those (or Google-native) when OpenRouter is 402.

## 3. Scientific-method debugging (Halloway)

On ANY test failure, crash, or unexpected behavior, do NOT guess-and-patch. Run the loop
(`superpowers:systematic-debugging` for structure + `pal debug` for a cheap external mind).
**Every `pal debug`/`chat`/`codereview`/`testgen` call MUST pass `working_directory_absolute_path`
(target repo or governance root) — it is required at runtime although the JSON schema marks it
optional; omitting it errors the call.** The `pal debug` model must be a route-live non-orchestrator
model (an independent H2 mind); if none is reachable, STOP — do not let the orchestrator supply both
hypotheses. Then:

1. **Observe** — capture the exact failure: input, expected, actual, stack, env. Reproduce it.
2. **Hypothesize** — write **≥2 competing hypotheses**, each explaining ALL observations. Argue
   the second with equal rigor to the first (never skip H2).
3. **Predict** — for each hypothesis, state a distinguishing observation it predicts.
4. **Experiment** — run the smallest test that discriminates between hypotheses. Change ONE thing.
5. **Conclude** — accept/reject on evidence. If none survive, gather more observations (step 1).
   Only after a hypothesis is confirmed do you write the fix — then re-run the oracle + regression.

Record the confirmed root cause (not just the fix) in the phase log + Graphiti.

## 4. Gate + remediation spec

Each phase and the final cleanup pass the same gate; a phase is not "done" until it is 100% clean.
**The gate verdict is computed by the reified `goal-gates` engine** (`C:/Dev/skill-router/goal-gates`,
built + wired 2026-09-02): assemble the phase signals into a GateInput and run
`node C:/Dev/skill-router/goal-gates/gate.cjs <input.json>`; a phase is "done" ONLY on exit 0
(ship===true). R0 is enforced in code — a policy-required-but-absent signal fails, never vacuously
passes. The signals below map to GateInput fields:

- **Tests** — full suite green; new code covered (patch-coverage, not project-coverage) → `tests`,
  `patchCoverage`. RED→GREEN proven per feature (`superpowers:test-driven-development` / `tdd` skill).
- **Immutable-test policy (anti-gaming).** Only the test-author role writes/edits tests; an
  implementer diff that touches a test file is **mechanically rejected**. Gate the diff on coverage
  + mutation-testing (e.g. Stryker) thresholds — a cheap worker can turn a suite green by weakening
  assertions or skipping tests, so plain-green is not proof. (Consensus 2026-09-01, both premium models.)
- **Invariant harness for security-critical slices.** For any multi-tenant / auth / isolation slice,
  a premium model authors an adversarial invariant harness ONCE, early (e.g. a two-tenant cross-access
  fuzz that MUST fail), and it runs at EVERY phase gate — such holes pass happy-path TDD invisibly.
- **Gap analysis** — `ezra-reconciler` plan-vs-impl: every EARS criterion has a citing test; no
  unplanned changes. Missing → back to Step 3 for that item.
- **Drift analysis** — `knowledge-graph detect_changes` + Graphiti invariant check: code graph
  matches ground truth; no invariant violated; session state matches reality.
- **Remediation loop** — any gate item open → fix → re-run the whole gate. Repeat until 0 open,
  bounded by `--max-iterations` (the enforced bound), not by "looks done". **Per-task attempt cap:**
  after N failed cheap-worker attempts (~5), escalate to a premium model for spec CLARIFICATION —
  not more cheap retries ("$0.50 of premium reasoning beats $20 of cheap flailing"); if still
  unresolved → the INCOMPLETE terminal, never a false promise.
- **Cleanup (Step 5)** runs this gate at whole-repo, granular E2E level, plus `pal precommit`.
- **Verifier reports are necessary, not sufficient.** gap (`ezra-reconciler`, an LLM judge) and
  drift (`detect_changes` over a possibly-stale graph) can both report "clean" on an incomplete
  build. Gate the promise primarily on the real oracle — whole-repo E2E vs EARS — require a
  verified-fresh KG re-index timestamp before trusting `detect_changes=0`, and probe
  `knowledge-graph` + `Graphiti` liveness first: a check that could not run is UNVERIFIED, not clean.
- **Flaky-test contract.** A test that flaps is quarantined only after N in-iteration retries still
  flake; each quarantined test gets a justified DECISIONS.md row. The promise reads "all
  non-quarantined E2E green AND every quarantined test justified" — so a genuinely-flaky external
  E2E cannot make the only honest exit permanently unreachable.

## 5. DECISIONS.md format

Lives at the run's governance root **outside the target repo** (so it never ships). One row per
deferred question; resolve every OPEN row in cleanup before the completion-promise.

```md
# DECISIONS — <mission> — <run-id>
| # | Phase | Question | Options considered | Default taken | Status | Resolved-by |
|---|-------|----------|--------------------|--------------|--------|-------------|
| 1 | 2 | Rate-limit store: Redis vs in-proc? | Redis / in-proc LRU | in-proc LRU (no infra dep yet) | OPEN | |
```

- **Crucial** (irreversible, real money, credentials only Avi holds, product direction) → do NOT
  defer: `PushNotification` to flag Avi and pause that thread (other phases continue).
- **Everything else** → default taken now, logged OPEN, revisited in cleanup.
- Model substitutions from §2 are logged here too (Status = INFO).

## 6. Honest build-status note (keep current)

`TDD-loop-goal` composes existing, verified pieces: PAL (consensus/precommit/debug/listmodels),
the casting engine (`C:/Dev/skill-router/layer2/`, has tests), `ralph-loop` plugin,
`superpowers` TDD + debugging skills, `knowledge-graph`/`gitnexus`/`Graphiti`, `ezra-reconciler`,
`avios-context`, `total-recall`, `claude-vault`. **Route-liveness** is now a caster feature
(`cast(..., {reachable})`, added 2026-09-01 after a dry-run found every OpenRouter route 402 with
no fallback). Still NOT reified as code: the **$-ceiling budget breaker** (no per-call cost source
wired — only `--max-iterations` is enforced), the **fail-CLOSED PreToolUse hook** for
push/deploy/live-payment/secret patterns (currently honor-system prose — the highest-risk gap), and
the **memory-graph session validators** (Step 4). Run `/TDD-loop-goal dry-run` to exercise Steps 0–1;
harden these into scripts as they earn their place (timing > complexity). Do NOT run autonomously
against real money until the fail-closed side-effect hook exists.
