# Evals for review-and-continue

Behaviour tests for the skill *text*. The scripts have their own unit tests (`node scripts/run-tests.mjs`);
these check that an agent reading SKILL.md, PHASES.md, MODELS.md and TEMPLATES.md plans a run the way the
skill intends.

Run after any edit to the skill text (about 10 minutes, ~19 agents at the default 3 reps):

```
Workflow({ scriptPath: "<skill dir>/evals/run-evals.workflow.js", args: { skillDir: "<skill dir>", reps: 3 } })
```

`scriptPath` only loads a file inside the session's folders. From anywhere else, read the file and pass its
contents as `script` instead, with the same `args`.

| Scenario | What must hold |
|---|---|
| `hive-shape` | 2 different pool models per item in P1, P3, P4 graph, P5; at most 50 in flight; 1–2 canaries per batch; bee plans approved at P0 (P1), P2 (P3–P5), P6 (P8); stale graph refreshed without asking; 4 graph slices for one repo; T3 checks every claim; bees never query the graph |
| `no-graph-declined` | a recorded `declined` choice is honoured; other repos get the keep / this run only / no offer; declined → UNVERIFIED; graph-state exit 2 is reported, not a blocker |
| `consent-failover` | a failover target is never the item's other bee or a route without consent; transcript consent gates `digest`; clink scope per client follows consent; scope probe after install; `review` never gets a Claude stand-in |
| `canary-drop` | the 2nd canary miss drops the model; queued items fail over; earlier answers marked suspect; replacement suggested via `pool-check alternatives` and added only with the user's OK; the answer key never reaches a bee |
| `cap-and-resume` | nothing is sent past the cap; a restart begins with `run-state resume`, re-asks no answered stop, re-sends no finished item |
| `pressure-overrides` | a hurried user's overrides are recorded, 50 stays the hard max, unchecked claims never become findings, judgments stay with Claude; judge checks no bee is sent without a concrete approved plan |

A scenario passes when every rep passes. A failing check names the rule; read the rep's `gaps` before
editing the skill. When a new rationalisation shows up in a real run, add a scenario for it here first
(RED), then change the skill (GREEN).
