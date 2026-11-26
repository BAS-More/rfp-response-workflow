---
name: knowledge-graph-cli
description: "Use when the user needs to run Knowledge-Graph CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: \"Index this repo\", \"Reanalyze the codebase\", \"Generate a wiki\""
---

# Knowledge-Graph CLI Commands

Commands use the `knowledge-graph` binary built and linked from the Knowledge-Graph repository. The npm name `knowledge-graph` belongs to an unrelated package, so do not use `npx` or `npm install -g`. One-time setup, from the Knowledge-Graph repo root:

```bash
cd knowledge-graph-shared && npm install && cd ../knowledge-graph && npm install && npm run build && npm link
```

Alternative without linking: `node <knowledge-graph-repo>/knowledge-graph/dist/cli/index.js <cmd>`.

## Commands

### analyze — Build or refresh the index

```bash
knowledge-graph analyze
```

Run from the project root. This parses all source files, builds the knowledge graph, writes it to `.knowledge-graph/`, and generates CLAUDE.md / AGENTS.md context files.

| Flag               | Effect                                                              |
| ------------------ | ------------------------------------------------------------------- |
| `--force`          | Force full re-index even if up to date                              |
| `--embeddings`     | Enable embedding generation for semantic search (off by default)    |
| `--skip-agents-md` | Do not write the Knowledge-Graph section into AGENTS.md / CLAUDE.md |

**When to run:** First time in a project, after major code changes, or when `knowledge-graph://repo/{name}/context` reports the index is stale. In Claude Code with the Knowledge-Graph hook installed (by the Claude plugin or `knowledge-graph setup`), a PostToolUse hook checks the index after `git commit`, `git merge`, `git rebase`, `git cherry-pick` and `git pull`. It does not run `analyze`: it only warns that the index is stale. Run `analyze` yourself (add `--embeddings` if the index had embeddings).

### status — Check index freshness

```bash
knowledge-graph status
```

Shows whether the current repo has a Knowledge-Graph index, when it was last updated, and symbol/relationship counts. Use this to check if re-indexing is needed.

### clean — Delete the index

```bash
knowledge-graph clean
```

Deletes the `.knowledge-graph/` directory and unregisters the repo from the global registry. Use before re-indexing if the index is corrupt or after removing Knowledge-Graph from a project.

| Flag      | Effect                                            |
| --------- | ------------------------------------------------- |
| `--force` | Skip confirmation prompt                          |
| `--all`   | Clean all indexed repos, not just the current one |

### wiki — Generate documentation from the graph

```bash
knowledge-graph wiki
```

Generates repository documentation from the knowledge graph using an LLM. Requires an API key (saved to `~/.knowledge-graph/config.json` on first use).

| Flag                | Effect                                    |
| ------------------- | ----------------------------------------- |
| `--force`           | Force full regeneration                   |
| `--model <model>`   | LLM model (default: minimax/minimax-m2.5) |
| `--base-url <url>`  | LLM API base URL                          |
| `--api-key <key>`   | LLM API key                               |
| `--concurrency <n>` | Parallel LLM calls (default: 3)           |
| `--gist`            | Publish wiki as a public GitHub Gist      |

### list — Show all indexed repos

```bash
knowledge-graph list
```

Lists all repositories registered in `~/.knowledge-graph/registry.json`. The MCP `list_repos` tool provides the same information.

## After Indexing

1. **Read `knowledge-graph://repo/{name}/context`** to verify the index loaded
2. Use the other Knowledge-Graph skills (`exploring`, `debugging`, `impact-analysis`, `refactoring`) for your task

## Troubleshooting

- **"Not inside a git repository"**: Run from a directory inside a git repo
- **Index is stale after re-analyzing**: Restart Claude Code to reload the MCP server
- **Embeddings slow**: Omit `--embeddings` (it's off by default) or set `KNOWLEDGE_GRAPH_EMBEDDING_URL` and `KNOWLEDGE_GRAPH_EMBEDDING_MODEL` (plus `KNOWLEDGE_GRAPH_EMBEDDING_API_KEY` if the endpoint needs one) to use an OpenAI-compatible embedding API instead of the local model. `OPENAI_API_KEY` is read only by `wiki`, not by embeddings
