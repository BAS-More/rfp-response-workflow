---
name: ezra
description: "EZRA (עזרא) — The Scribe Who Restores and Enforces Standards. A multi-agent codebase governance framework that enforces architectural decisions, detects drift, reviews code quality and security, and reconciles plans against implementation. Use when the user asks about architecture, governance, decisions, code review, or plan tracking. Trigger on: /ezra, architecture review, decision record, governance check, plan reconciliation, codebase analysis, drift detection, protected paths."
---

# EZRA (עזרא) — The Scribe Who Restores and Enforces Standards

EZRA is a codebase governance framework. It provides multi-agent, multi-phase analysis with no manual orchestration.

## What EZRA Does

1. **Knows your codebase** — Maintains codebase knowledge (`.ezra/knowledge.yaml`) documenting architecture, patterns, layers, and dependencies
2. **Enforces decisions** — Tracks Architectural Decision Records in `.ezra/decisions/` and verifies code compliance
3. **Guards integrity** — Protects critical paths from unintended changes, checks standards compliance
4. **Reviews deeply** — Dispatches parallel agents for architecture, security, and quality analysis
5. **Reconciles plans** — Compares what was planned against what was built, identifies gaps and drift

## State Directory

EZRA persists state in `.ezra/` at the project root:

```
.ezra/
├── decisions/          # Architectural Decision Records (YAML)
├── scans/              # Timestamped scan results
├── plans/              # Registered plans for reconciliation
├── governance.yaml     # Rules, protected paths, enforcement config
└── knowledge.yaml      # What EZRA knows about the codebase
```

## Commands

- `/ezra:init` — Initialize EZRA, scan codebase, create state directory
- `/ezra:scan` — Dynamic multi-agent codebase scan (interactive agent selection from 100 roles, presets, or classic 4-agent mode)
- `/ezra:guard` — Check staged/recent changes against rules
- `/ezra:reconcile` — Compare plan vs implementation
- `/ezra:decide` — Record an architectural decision (ADR) with rationale, enforcement rules, and affected paths
- `/ezra:decide-graph` — Visualise the dependency graph between ADRs — shows supersession chains, orphans, renders ASCII or Mermaid
- `/ezra:git-hooks` — Install, remove, or check status of EZRA git hooks (pre-commit, pre-push)
- `/ezra:report` — Generate a comprehensive governance health report (decisions, violations, drift, scan history, recommendations)
- `/ezra:token-shield` — Token Shield status — validate Context Mode MCP, handoff files, and hook configuration
- `/ezra:review` — Dynamic multi-agent code review (smart agent selection based on changed files)
- `/ezra:agents` — Agent management: list 100 roles, recommend agents for tasks, deploy preset teams, search by domain
- `/ezra:status` — Governance health dashboard
- `/ezra:help` — Show all commands
- `/ezra:doc` — Generate, manage, and track SDLC documentation (81 document types)
- `/ezra:dash` — Real-time governance dashboard with metrics across all pillars
- `/ezra:doc-check` — Verify documentation completeness and currency against project lifecycle
- `/ezra:doc-sync` — Synchronize documentation with current codebase state
- `/ezra:doc-approve` — Document review and approval workflow with sign-off tracking
- `/ezra:version` — Version control for all EZRA state with immutable changelog
- `/ezra:health` — 5-pillar health assessment (architecture, security, quality, documentation, governance)
- `/ezra:advisor` — Lifecycle-aware guidance, best practices, and forward-looking recommendations
- `/ezra:process` — Create, run, edit, and save reusable step-by-step workflows
- `/ezra:auto` — Autonomous process execution with guard rails and approval gates
- `/ezra:multi` — Multi-project portfolio orchestration across multiple codebases
- `/ezra:sync` — Sync EZRA governance state with avios-context MCP server
- `/ezra:claude-md` — Generate or update CLAUDE.md from `.ezra/` state
- `/ezra:bootstrap` — One-command project onboarding (init + configure + ADR + health + CLAUDE.md)
- `/ezra:oversight` — Real-time agent oversight — view status, set intervention level, review violations
- `/ezra:settings` — Unified settings management — view, set, init, add-rule, reset, export, diff
- `/ezra:compliance` — Compliance profiles: activate ISO 25010, OWASP, SOC2, HIPAA, PCI-DSS, GDPR, WCAG
- `/ezra:learn` — Self-learning intelligence: agent profiles, violation patterns, cost optimisation, recommendations
- `/ezra:pm` — Project management with milestones, deliverables, and tracking
- `/ezra:progress` — Track milestone progress and generate reports
- `/ezra:library` — Best practice library: browse, search, add, export across 14 categories
- `/ezra:research` — Research agent control: configure automated best practice discovery
- `/ezra:portfolio` — Cross-project portfolio health dashboard
- `/ezra:memory` — Persistent project knowledge base — key facts, red lines, briefings
- `/ezra:plan` — Holistic planning engine — decompose, assign, execute, verify, checkpoint
- `/ezra:license` — License management — activate, deactivate, check tier (Core/Pro/Team)
- `/ezra:install` — Install EZRA hooks and commands to local or global scope
- `/ezra:workflow` — Workflow template engine — create, run, list built-in workflows
- `/ezra:handoff` — Generate session handoff brief for continuity across conversations
- `/ezra:cost` — Cost tracking and budget management for AI agent usage
- `/ezra:assess` — Quiz2Build assessment integration — import readiness scores, gap heatmaps, generated documents
- `/ezra:interview` — Interactive gap interview — build project-definition.yaml from docs + answers

## Agent System

EZRA uses a **scalable agent registry** with 100 specialized roles across 12 domains, powered by 4 core agent engines.

### Core Engines (4)

- `ezra-architect` — Architecture analysis, layer mapping, dependency tracing, pattern detection
- `ezra-reviewer` — OWASP-aligned security review + code quality analysis with confidence scores
- `ezra-guardian` — Decision enforcement, protected path integrity, standards compliance
- `ezra-reconciler` — Plan vs implementation comparison, gap detection, constraint verification

### Domains (12) — 100 Specialized Roles

| Domain | Roles | Core Engine | Focus |
|---|---|---|---|
| Architecture | 10 | ezra-architect | Layers, patterns, API design, DDD, cloud-native |
| Security | 12 | ezra-reviewer | OWASP, auth, crypto, injection, supply chain, privacy |
| Quality | 10 | ezra-reviewer | Types, complexity, SOLID, clean code, refactoring |
| Testing | 8 | ezra-reviewer | Unit, integration, E2E, coverage, mocking, TDD |
| Governance | 8 | ezra-guardian | Compliance, standards, ADR, licensing, drift |
| DevOps | 10 | ezra-architect | CI/CD, Docker, Kubernetes, Terraform, monitoring |
| Documentation | 8 | ezra-reviewer | API docs, README, code docs, runbooks, SDLC |
| Performance | 8 | ezra-reviewer | Backend, frontend, database, caching, scalability |
| Accessibility | 6 | ezra-reviewer | WCAG, ARIA, keyboard, screen reader, contrast |
| Data | 6 | mixed | Schema, migration, validation, modeling, integrity |
| Frontend | 8 | mixed | React, state, CSS, components, routing, UX |
| Reconciliation | 6 | ezra-reconciler | Sprint, requirements, scope, timeline, budget |

### Agent Registry

All 100 roles are defined in `agents/registry.yaml` with:
- Role ID, name, domain, and base engine mapping
- Specialty description and best-for task matching
- Tags for search and recommendation algorithm

### Presets (14 pre-configured teams)

| Preset | Agents | Use Case |
|---|---|---|
| quick-review | 3 | Fast PR review |
| full-scan | 4 | Classic comprehensive scan |
| security-deep | 6 | Deep security audit |
| quality-deep | 6 | Quality & tech debt analysis |
| frontend-review | 6 | Frontend-focused review |
| backend-review | 6 | Backend-focused review |
| devops-audit | 6 | Infrastructure & DevOps review |
| pre-release | 8 | Pre-release validation |
| new-project | 5 | New project setup review |
| api-focused | 6 | API design & security review |
| database-focused | 5 | Database & schema review |
| testing-deep | 6 | Testing strategy review |
| accessibility-full | 6 | WCAG accessibility audit |
| documentation-full | 6 | Documentation completeness |
| maximum-coverage | 12 | All domains represented |

### Usage

```
/ezra:agents                          — Interactive agent menu
/ezra:agents list                     — All 100 roles by domain
/ezra:agents recommend <task>         — Get agent recommendation for a task
/ezra:agents deploy <preset>          — Deploy a preset team
/ezra:agents deploy <count> <task>    — Deploy N agents for a task
/ezra:agents info <role-id>           — Role details
/ezra:agents domains                  — Domain overview
/ezra:agents presets                  — List all presets
/ezra:agents search <keyword>         — Search by tag/specialty

/ezra:scan                            — Interactive scan with agent selection
/ezra:scan --preset security-deep     — Scan with preset team
/ezra:scan --agents 8                 — Scan with 8 recommended agents
/ezra:scan --classic                  — Original 4-agent scan

/ezra:review                          — Smart review (auto-detects from changed files)
/ezra:review --preset frontend-review — Review with preset team
/ezra:review --agents 6               — Review with 6 recommended agents
/ezra:review --classic                — Original 3-agent review
```

## Workflow

```
/ezra:init → /ezra:decide → /ezra:scan → ... work ... → /ezra:guard → /ezra:review → /ezra:reconcile
```

## Integration with Hooks

EZRA can be integrated with Claude Code hooks for automatic enforcement:

- **PreToolUse** hook on Write/Edit: Automatically runs guard check on file changes
- **Stop** hook: Logs session activity for reconciliation tracking
- **PostToolUse** hook: Validates changes against governance after each edit

See `.claude/hooks/ezra-guard.js` for the hook implementation.

## Decision Record Format

Each decision in `.ezra/decisions/ADR-NNN.yaml`:

```yaml
id: ADR-NNN
status: ACTIVE | SUPERSEDED | DEPRECATED
date: <ISO>
category: ARCHITECTURE | DATABASE | SECURITY | API | TESTING | INFRASTRUCTURE | DEPENDENCY | CONVENTION
decision: <one clear sentence>
context: <why>
rationale: <why this choice>
consequences:
  positive: [...]
  negative: [...]
enforcement:
  affected_paths: [<glob patterns>]
  check_description: <what compliance looks like>
  auto_enforced: <true|false>
```
