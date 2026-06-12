---
name: knowledge-graph-debugging
description: "Use when the user is debugging a bug, tracing an error, or asking why something fails. Examples: \"Why is X failing?\", \"Where does this error come from?\", \"Trace this bug\""
---

# Debugging with Knowledge-Graph

## When to Use

- "Why is this function failing?"
- "Trace where this error comes from"
- "Who calls this method?"
- "This endpoint returns 500"
- Investigating bugs, errors, or unexpected behavior

## Workflow

```
1. knowledge-graph_query({query: "<error or symptom>"})            → Find related execution flows
2. knowledge-graph_context({name: "<suspect>"})                    → See callers/callees/processes
3. READ knowledge-graph://repo/{name}/process/{name}                → Trace execution flow
4. knowledge-graph_cypher({query: "MATCH path..."})                 → Custom traces if needed
```

> If "Index is stale" → run `npx knowledge-graph analyze` in terminal.

## Checklist

```
- [ ] Understand the symptom (error message, unexpected behavior)
- [ ] knowledge-graph_query for error text or related code
- [ ] Identify the suspect function from returned processes
- [ ] knowledge-graph_context to see callers and callees
- [ ] Trace execution flow via process resource if applicable
- [ ] knowledge-graph_cypher for custom call chain traces if needed
- [ ] Read source files to confirm root cause
```

## Debugging Patterns

| Symptom              | Knowledge-Graph Approach                                          |
| -------------------- | ---------------------------------------------------------- |
| Error message        | `knowledge-graph_query` for error text → `context` on throw sites |
| Wrong return value   | `context` on the function → trace callees for data flow    |
| Intermittent failure | `context` → look for external calls, async deps            |
| Performance issue    | `context` → find symbols with many callers (hot paths)     |
| Recent regression    | `detect_changes` to see what your changes affect           |

## Tools

**knowledge-graph_query** — find code related to error:

```
knowledge-graph_query({query: "payment validation error"})
→ Processes: CheckoutFlow, ErrorHandling
→ Symbols: validatePayment, handlePaymentError, PaymentException
```

**knowledge-graph_context** — full context for a suspect:

```
knowledge-graph_context({name: "validatePayment"})
→ Incoming calls: processCheckout, webhookHandler
→ Outgoing calls: verifyCard, fetchRates (external API!)
→ Processes: CheckoutFlow (step 3/7)
```

**knowledge-graph_cypher** — custom call chain traces:

```cypher
MATCH path = (a)-[:CodeRelation {type: 'CALLS'}*1..2]->(b:Function {name: "validatePayment"})
RETURN [n IN nodes(path) | n.name] AS chain
```

## Example: "Payment endpoint returns 500 intermittently"

```
1. knowledge-graph_query({query: "payment error handling"})
   → Processes: CheckoutFlow, ErrorHandling
   → Symbols: validatePayment, handlePaymentError

2. knowledge-graph_context({name: "validatePayment"})
   → Outgoing calls: verifyCard, fetchRates (external API!)

3. READ knowledge-graph://repo/my-app/process/CheckoutFlow
   → Step 3: validatePayment → calls fetchRates (external)

4. Root cause: fetchRates calls external API without proper timeout
```
