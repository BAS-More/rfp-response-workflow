---
name: fanout
description: Ultracode-style multi-agent fan-out on demand. Runs N diverse-lens agents in parallel, adversarially critiques each, then synthesizes one answer. Use when the user types /fanout, or asks to "fan out", "run a council on", "get multiple angles on", or wants ultracode-style multi-agent treatment of a question, decision, or task.
argument-hint: <task / question to fan out on>
disable-model-invocation: true
---

# Fan-out (ultracode-lite)

A portable, on-demand version of ultracode's core pattern: **diverse-lens fan-out → adversarial verification → synthesis**. It runs as a real `Workflow`, so the orchestration is deterministic and shows live progress in `/workflows`.

## How to run it

When the user invokes `/fanout <task>` (or asks for multi-agent / council treatment of something), call the **Workflow** tool with:

- `scriptPath`: `C:\Dev\tools\fanout-toolkit\workflows\ultracode-fanout.js`
- `args`: the user's task/question as a **plain string** (everything after `/fanout`).
  - To customize the panel, pass an object instead: `{ "task": "<task>", "lenses": ["<angle 1>", "<angle 2>", ...] }`. One agent runs per lens.

The workflow runs in the background and notifies you when done. When it completes, read `finalAnswer` from the result and present it to the user, then add a one-line footer noting how many agents/lenses ran (`agents`, `lensesUsed`).

## What it does (so you can explain it)

1. **Fan-out** — one independent agent per lens (default 5: correctness/risk, simplest-path, edge-cases, contrarian, pragmatic-synthesis), all in parallel.
2. **Verify** — each draft gets its own adversarial critique agent (pipeline, no barrier — critiques start as soon as each draft lands).
3. **Synthesize** — a final agent judges the critiqued proposals into one decisive answer (majority + minority + risks + recommendation).

Total agents ≈ `lenses × 2 + 1` (default 11).

## Notes

- It spends real tokens across ~11 agents — only run it on explicit invocation (`disable-model-invocation: true` keeps it from auto-firing). Skip it for trivial questions; use it for decisions, design choices, reviews, or "give me the best answer" requests.
- Invoking this skill is itself an explicit opt-in to multi-agent orchestration, so the `Workflow` call is authorized regardless of whether the ultracode toggle is on.
- To tune the default panel permanently, edit the `DEFAULT_LENSES` array in the engine (`workflows/ultracode-fanout.js`).
- Result fields: `finalAnswer` (present this), `proposalCount`, `panel`, `source` (`'lenses'`/`'panel'`/`'default'`), `agents`. The full per-lens drafts+critiques are **omitted by default** to keep the payload small — pass `includeProposals: true` in args if you need them.
- If the result has an `error` field instead (e.g. `no-task`), surface that to the user and stop — don't fabricate a `finalAnswer`.
