---
name: jit-load
description: Load common MCP tool bundles in one shot via ToolSearch. Reference card for the typical "load secrets stack" / "load db stack" patterns so you don't type long select: queries each session.
---

# JIT MCP Loader Reference

Per Avi's policy: total-recall always-on, everything else JIT. This skill is a copy-paste reference for typical bundles. Pick the bundle that matches the task and fire ONE ToolSearch call.

## Bundles

### Secrets / credentials
```
ToolSearch({
  query: "select:mcp__claude-vault__get_credential,mcp__claude-vault__list_credentials,mcp__claude-vault__get_totp,mcp__claude-vault__list_recipes",
  max_results: 4
})
```

### Database (Supabase)
```
ToolSearch({
  query: "select:mcp__f71455e8-2555-40ef-bb41-a380a1325f71__list_projects,mcp__f71455e8-2555-40ef-bb41-a380a1325f71__execute_sql,mcp__f71455e8-2555-40ef-bb41-a380a1325f71__list_tables,mcp__f71455e8-2555-40ef-bb41-a380a1325f71__apply_migration,mcp__f71455e8-2555-40ef-bb41-a380a1325f71__get_logs,mcp__f71455e8-2555-40ef-bb41-a380a1325f71__get_advisors",
  max_results: 6
})
```

### Browser automation (Playwright — use over Chrome MCP for headless / CI)
```
ToolSearch({
  query: "select:mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_fill_form,mcp__playwright__browser_take_screenshot,mcp__playwright__browser_evaluate,mcp__playwright__browser_close",
  max_results: 8
})
```

### Browser (Chrome extension — use when working with Avi's open tabs)
```
ToolSearch({ query: "claude-in-chrome", max_results: 25 })
```

### Filesystem (when not using native Read/Write/Glob/Grep)
```
ToolSearch({
  query: "select:mcp__filesystem__read_text_file,mcp__filesystem__write_file,mcp__filesystem__list_directory,mcp__filesystem__directory_tree,mcp__filesystem__edit_file,mcp__filesystem__search_files",
  max_results: 6
})
```

### Docs lookup (Context7)
```
ToolSearch({
  query: "select:mcp__context7__resolve-library-id,mcp__context7__query-docs",
  max_results: 2
})
```

### Memory (total-recall — should already be active, just in case)
```
ToolSearch({
  query: "select:mcp__total-recall__remember,mcp__total-recall__recall,mcp__total-recall__recall_semantic,mcp__total-recall__correct,mcp__total-recall__session_start,mcp__total-recall__session_close,mcp__total-recall__session_state_read,mcp__total-recall__session_state_write,mcp__total-recall__task_create,mcp__total-recall__task_update,mcp__total-recall__verify_claim,mcp__total-recall__verify_file",
  max_results: 12
})
```

### Code knowledge graph (refactoring / impact analysis)
```
ToolSearch({
  query: "select:mcp__knowledge-graph__query,mcp__knowledge-graph__context,mcp__knowledge-graph__impact,mcp__knowledge-graph__detect_changes,mcp__knowledge-graph__rename,mcp__knowledge-graph__route_map,mcp__knowledge-graph__cypher",
  max_results: 7
})
```

### ClickUp (auth required first — call clickup__authenticate)
```
ToolSearch({
  query: "select:mcp__plugin_productivity_clickup__authenticate",
  max_results: 1
})
```

### Sentry (already registered, may need OAuth)
```
ToolSearch({
  query: "select:mcp__sentry__authenticate,mcp__sentry__complete_authentication",
  max_results: 2
})
```

## Anti-patterns

- ❌ `ToolSearch({ query: "browser", max_results: 50 })` — pulls dozens of irrelevant tools, burns context
- ❌ Loading all bundles at session start "just in case" — Avi reversed that policy 2026-04-26
- ❌ Loading filesystem MCP for short reads — native `Read` tool is cheaper

## Pattern

`select:` query > keyword query. Specific names beat keyword sweeps every time.
