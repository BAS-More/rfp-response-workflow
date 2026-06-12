---
name: llm-council
description: Convene a 3-5 agent parallel council with adversarial framing on non-trivial decisions (architecture, tech choice, plan approval, irreversible ops, "best X" trade-offs). Each agent gets the same brief + a unique angle. Synthesize majority view, minority view, risks, dissent, final call. Fires when user says "should I", "best approach", "which", "decide", or before any architecture/tech/irreversible action.
allowed-tools: Read, Glob, Grep
---

# LLM Council — adversarial multi-agent decision

When you face a non-trivial decision, single-agent reasoning misses blind spots and converges on the first plausible answer. The Council forces parallel angles + adversarial framing → exposes trade-offs.

## When to convene (trigger conditions)

**MUST convene** for:
- Architecture / system design choice
- Tech stack / library / framework selection
- Plan approval before Phase 1 of any non-trivial work (>200 LOC OR cross-cutting)
- Conflicting requirements / ambiguous trade-offs
- Risky / irreversible operations (migrations, deletions, deploys)
- Any "best X" / "should I" / "which" question with >1 viable answer

**SKIP** for:
- One-line fixes
- Lookups (read a file, run a command)
- Pure formatting / typo / style changes
- Decisions already made (don't re-litigate)

## Council size

| Decision class | Agents | Notes |
|---|---|---|
| Architecture / irreversible op | **5** | broadest coverage |
| Plan approval, tech pick | **3** | enough for dissent |
| Quick "should I" check | **3** | minimum quorum |

Never < 3 (need majority + minority).

## Default 3-agent council

| Agent | Angle |
|---|---|
| `Plan` | Solution architect — preferred path, alternatives, decision matrix |
| `general-purpose` (or domain agent) | Implementer — what breaks at runtime, dev-time pain, debug paths |
| `ezra-reviewer` or `ezra-guardian` | Adversarial — risks, what's wrong, what we're missing, security |

## Expanded 5-agent council

Add to default:
- `Explore` — codebase reality check (does the assumed pattern exist?)
- Domain specialist — `claude-code-guide` / `fullstack-dev-skills:*` per topic

## Protocol

1. **Spawn agents in parallel.** Single message, multiple `Agent` tool calls. NEVER serial.
2. **Same brief, same question, unique angle.** Quote the user's exact ask. Tell each agent which angle they own.
3. **Require structured output** from every agent:

```yaml
verdict:        "<one-line recommendation>"
reasoning:      "<2-4 bullets>"
risks:          ["<risk1>", "<risk2>"]
dissent:        "<what would change my mind / minority case I considered>"
confidence:     low | medium | high
```

   The `dissent` field is mandatory — without it, agents agree by default. Force adversarial framing in the prompt: "Find the strongest counter-argument even if you disagree with it."

4. **Synthesize:**

```yaml
council_synthesis:
  question:    "<verbatim>"
  agents:      [<agent1>, <agent2>, <agent3>]
  majority:    "<view>"     # what most agents recommend
  minority:    "<view>"     # what at least one dissented to
  shared_risks: ["<...>"]   # risks flagged by 2+ agents
  novel_risks:  ["<...>"]   # risks flagged by exactly one
  final_call:  "<recommendation>"
  confidence:  low | medium | high
  surface_to_user_if: <true if dissent OR irreversible OR confidence=low>
```

5. **Surface to user** when:
   - Any dissent ≥ medium confidence
   - Operation is irreversible (per destructive-ops rule)
   - Synthesis confidence is `low`
   - Council outputs disagree on confidence

## Anti-patterns

- **Solo deciding** when council fits — especially architecture
- **Spawning agents serially** when independent (waste of wall-clock)
- **Re-doing work in main context** that an agent already did
- **Council without dissent prompt** — agents will rubber-stamp
- **Council on trivial questions** — burns 3x tokens for nothing
- **Picking winners by vote count** without weighting confidence — high-confidence minority can outweigh lukewarm majority
- **Skipping the `surface_to_user_if` check** — dissent must reach the human

## Integration with plan-first workflow

- Council convenes BEFORE Planner finalizes `design.md` for non-trivial work
- Council output feeds the `## Decisions` section of `design.md`
- All decisions get logged to `mcp__avios-context-mcp__avios_add_decision`
- If council surfaces an irreversible op, route through `destructive-ops.md` rule before execution

## Example prompts (for the 3 agents in a default council)

```
Plan agent:
  "Question: <user's verbatim ask>.
   Your angle: solution architect. Lay out the preferred path AND
   2 alternatives with a decision matrix. Required output:
   verdict / reasoning / risks / dissent / confidence (yaml)."

general-purpose agent:
  "Question: <user's verbatim ask>.
   Your angle: implementer. What breaks at runtime? What's the dev
   experience? What debug paths are weak? Required output: same yaml."

ezra-reviewer agent:
  "Question: <user's verbatim ask>.
   Your angle: adversarial. Find the strongest counter-argument
   regardless of your prior. List security + ops risks. Required
   output: same yaml. Find dissent even if you have to invent it."
```
