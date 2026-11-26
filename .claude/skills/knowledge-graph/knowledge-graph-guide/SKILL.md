---
name: knowledge-graph-guide
description: "Use when the user asks about Knowledge-Graph itself — available tools, how to query the knowledge graph, MCP resources, graph schema, or workflow reference. Examples: \"What Knowledge-Graph tools are available?\", \"How do I use Knowledge-Graph?\""
---

# Knowledge-Graph Guide

Quick reference for all Knowledge-Graph MCP tools, resources, and the knowledge graph schema.

## Always Start Here

For any task involving code understanding, debugging, impact analysis, or refactoring:

1. **Read `knowledge-graph://repo/{name}/context`** — codebase overview + check index freshness
2. **Match your task to a skill below** and **read that skill file**
3. **Follow the skill's workflow and checklist**

> If step 1 warns the index is stale, run `knowledge-graph analyze` in the terminal first.

## Skills

| Task                                         | Skill to read       |
| -------------------------------------------- | ------------------- |
| Understand architecture / "How does X work?" | `knowledge-graph-exploring`         |
| Blast radius / "What breaks if I change X?"  | `knowledge-graph-impact-analysis`   |
| Trace bugs / "Why is X failing?"             | `knowledge-graph-debugging`         |
| Rename / extract / split / refactor          | `knowledge-graph-refactoring`       |
| Tools, resources, schema reference           | `knowledge-graph-guide` (this file) |
| Index, status, clean, wiki CLI commands      | `knowledge-graph-cli`               |
| Review a pull request / "Is this PR safe?"  | `knowledge-graph-pr-review` (installed by `setup` or the plugin, not by `analyze`) |

## Tools Reference

| Tool             | What it gives you                                                        |
| ---------------- | ------------------------------------------------------------------------ |
| `query`          | Process-grouped code intelligence — execution flows related to a concept |
| `context`        | 360-degree symbol view — categorized refs, processes it participates in  |
| `impact`         | Symbol blast radius — what breaks at depth 1/2/3 with confidence         |
| `detect_changes` | Git-diff impact — what do your current changes affect                    |
| `rename`         | Multi-file coordinated rename with confidence-tagged edits               |
| `cypher`         | Raw graph queries (read `knowledge-graph://repo/{name}/schema` first)           |
| `list_repos`     | Discover indexed repos                                                   |
| `route_map`      | API routes: which consumers fetch which endpoints, and their handlers    |
| `tool_map`       | MCP/RPC tool definitions and where they are handled                      |
| `shape_check`    | API route response shapes vs. the properties consumers access            |
| `api_impact`     | Pre-change impact report for an API route handler                        |
| `group_list`     | List configured repository groups, or one group's config                 |
| `group_sync`     | Rebuild a group's Contract Registry (`contracts.json`)                   |
| `group_contracts`| Inspect a group's contracts and cross-links                              |
| `group_query`    | Run `query` across every repo in a group and merge the results           |
| `group_status`   | Index and Contract Registry staleness for each repo in a group           |

## Resources Reference

Lightweight reads (~100-500 tokens) for navigation:

| Resource                                       | Content                                   |
| ---------------------------------------------- | ----------------------------------------- |
| `knowledge-graph://repo/{name}/context`               | Stats, staleness check                    |
| `knowledge-graph://repo/{name}/clusters`              | All functional areas with cohesion scores |
| `knowledge-graph://repo/{name}/cluster/{clusterName}` | Area members                              |
| `knowledge-graph://repo/{name}/processes`             | All execution flows                       |
| `knowledge-graph://repo/{name}/process/{processName}` | Step-by-step trace                        |
| `knowledge-graph://repo/{name}/schema`                | Graph schema for Cypher                   |

## Graph Schema

**Common nodes:** File, Folder, Function, Class, Interface, Method, Community, Process (language-specific labels such as Struct, Enum, Const, Property, Record, Module, CodeElement, Route and Tool also exist)
**Common edges (via CodeRelation.type):** CONTAINS, DEFINES, CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, ACCESSES, MEMBER_OF, STEP_IN_PROCESS (plus route, tool and override edges)

These lists are partial. Read `knowledge-graph://repo/{name}/schema` for the full set before writing Cypher.

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "myFunc"})
RETURN caller.name, caller.filePath
```
