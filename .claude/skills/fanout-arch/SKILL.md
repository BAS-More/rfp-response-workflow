---
name: fanout-arch
description: Multi-agent architecture / decision analysis on demand. Fans out 5 angles (solution architecture, failure modes & ops, adversarial/contrarian, cost & evolvability, implementation reality) in parallel, adversarially checks each, then synthesizes a decision with a trade-off matrix. Use when the user types /fanout-arch, or asks to decide an architecture/tech/design question, "which approach", "should we", or weigh trade-offs.
argument-hint: "<the architecture or design decision / question>"
disable-model-invocation: true
---

# Fan-out architecture decision

Runs the shared fan-out engine with the built-in **arch** panel — solution architecture · failure modes & ops · adversarial/contrarian · cost & evolvability · implementation reality — then adversarially checks each angle and synthesizes a decision.

## Steps

1. **Frame the decision** from the user's question. Quote their ask verbatim. If it concerns existing code, gather brief relevant context first (key files/modules, constraints, current stack) and include it in the task so the agents reason about the real system, not a generic one.

2. **Call the Workflow tool:**
   - `scriptPath`: `C:\Dev\tools\fanout-toolkit\workflows\ultracode-fanout.js`
   - `args`: `{ "task": "<the decision + any context>", "panel": "arch" }`

3. When it returns, present `finalAnswer` (recommendation → decision matrix → minority view → risks → first steps) and a one-line footer (`panel`, `agents`). If the minority/contrarian view carries real weight, surface it explicitly — don't let the majority bury it. If the result has an `error` field instead, surface that and stop.

## Notes
- ~11 agents; explicit invocation only. Best for non-trivial, hard-to-reverse choices (architecture, tech/library selection, migrations) — skip it for one-liners.
- Override the panel by passing `lenses: [...]` instead of `panel`. Add `dryRun: true` to confirm the panel resolves without spawning agents.
