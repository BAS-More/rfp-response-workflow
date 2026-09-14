<!-- bas-more-project-memory:v1:start -->
## Project memory
After the repository's mandatory entry and handover reads, read
.project-memory/config.json and .project-memory/POLICY.md from the repository root.
Setup is enabled by the owner. Continue incomplete setup within this repository
without asking again; preserve any working graph engine and its recorded pins.
Before coding, use the documented session/freshness, context and upstream-impact
workflow. After edits, refresh relevant graphs and record actual validation.
Graph readiness requires the policy's acceptance evidence; installed rules alone
do not establish that graphs, semantic retrieval, hooks or integrations work.
<!-- bas-more-project-memory:v1:end -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Engagement Details

- **Client**: [CLIENT_NAME]
- **Project**: [PROJECT_NAME]
- **Date Started**: [DATE]
- **Technology Stack**: [TECH_STACK]
- **Engagement Type**: [New Build / Migration / Redesign / Enhancement]

## Project Type

This is a **pre-sales estimation project**, not a codebase. The goal is to analyze a Terms of Reference (TOR) document, assess requirement clarity, draft clarifying questions, review customer responses, and produce/validate effort estimates with gap analysis.

## Directory Structure

- `tor/` — Upload the TOR/RFP/SOW document(s) here. This is the starting input for all analysis.
- `research/` — AI-generated customer and site research artefacts. Output of Phase 0.
  - `research/csv/` — CSV exports of all tabular research data (tech stack, content types, integrations, etc.)
- `initial_questions/` — AI-generated clarifying questions based on TOR analysis. Output of Phase 1.
- `responses_qna/` — Customer responses to clarifying questions. Uploaded manually after receiving answers.
- `estimates/` — Estimation documents (initial and revised). Can be uploaded or AI-generated.
- `claude-artefacts/` — All AI-generated analysis artefacts (requirement assessments, gap analysis, review reports).
- `templates/` — Output structure templates. Each phase artefact should follow the corresponding template.
- `benchmarks/` — Reference effort ranges for estimation calibration.
- `scripts/` — Utility scripts (e.g., Excel template population).
- `estimation_template/` — QED42 Excel estimation template (Backend/Frontend/Fixed Cost Items/AI tabs).

## Workflow Phases

### Phase 0: Customer & Site Research
**Trigger:** TOR document placed in `tor/` (runs before Phase 1)
**Agent Persona:** Senior Technical Architect conducting pre-engagement due diligence
**Tools:** WebSearch (customer research, tech discovery), WebFetch (site inspection, header analysis, PageSpeed API), sequential-thinking MCP (structured research decomposition), claude-mem smart_search (past engagements with similar customers/stacks)
**Output Template:** `templates/customer-research-template.md`
- Extract customer name, site URL, and project context from TOR
- Conduct web research: organization profile, industry, digital presence, recent news, strategic initiatives, regulatory environment
- If existing site URL is available (from TOR or discovered via research):
  - Detect technology stack (CMS, frameworks, server, hosting, CDN) from HTTP headers, HTML source, JS bundles
  - Map site structure and information architecture from navigation and URL patterns
  - Estimate page volume via sitemap.xml and Google site: operator
  - Gather traffic estimates from publicly available sources
  - Run performance baseline (Core Web Vitals via PageSpeed Insights)
  - Audit SEO health (meta tags, structured data, sitemaps, robots.txt, URL structure)
  - Inventory all third-party integrations (analytics, CRM, search, payments, auth, CDN, chat, etc.)
  - Assess accessibility snapshot (automated scan of key pages)
  - Check security headers and configuration
  - Evaluate mobile experience
- Align research findings with TOR requirements to identify hidden scope, risks, and estimation adjustments
- Output: `research/customer-research.md` + CSV exports in `research/csv/`
- **CSV exports (10 files):** tech-stack.csv, site-structure.csv, content-types.csv, content-volume.csv, performance-baseline.csv, seo-health.csv, third-party-integrations.csv, hidden-scope.csv, risk-register.csv, estimation-adjustments.csv

### Phase 1: TOR Analysis & Question Drafting
**Trigger:** Phase 0 complete (or TOR placed in `tor/` if skipping research)
**Agent Persona:** Senior Requirements Analyst
**Tools:** sequential-thinking MCP (structured TOR decomposition), CARL presales domain (coverage enforcement), claude-mem smart_search (past question patterns)
**Output Template:** `templates/tor-assessment-template.md` and `templates/questions-template.md`
- Read and parse the TOR document(s)
- Incorporate Phase 0 research findings (if available) to inform requirement assessment
- Assess each requirement for clarity, completeness, and estimability
- Identify ambiguities, missing details, implicit assumptions, and technical risks
- Cross-reference research-identified hidden scope items against TOR requirements
- Generate structured clarifying questions grouped by requirement area (informed by site audit findings)
- Output: `initial_questions/questions.md` and `claude-artefacts/tor-assessment.md`

### Phase 1A: Optimistic Estimation (No-Response Path)
**Trigger:** Customer Q&A responses not received / submission deadline approaching
**Agent Persona:** Senior [TECH_STACK] Architect optimizing for competitive positioning
**Tools:** CARL presales domain (coverage enforcement), claude-mem smart_search (effort benchmarks from past engagements), benchmarks/ reference ranges
**Output Template:** `templates/optimistic-estimate-template.md` and `templates/technical-proposal-template.md`
**Slash Commands:** `/optimistic-estimate`, `/tech-proposal`
- Alternative path when Phase 2 (customer responses) is not available
- Convert all Phase 1 clarifying questions into assumptions (select lowest-effort option)
- Generate optimistic estimates using lower end of benchmark ranges
- Prefer platform-native/contrib solutions over custom development
- Every assumption phrased as a change-request boundary to protect against scope creep
- Estimates organized into tabs matching the QED42 Excel template:
  - **Backend**: CMS/server-side work needing PM+QA overhead (auto-calculated in sheet)
  - **Frontend**: Component-level UI estimates with visual reference links and exclusions (PM+QA auto-calculated)
  - **Fixed Cost Items**: Operational items NOT needing QA/PM (deployment, docs, training, onboarding, etc.)
  - **AI**: AI-powered features (if applicable)
- Frontend estimates at component level (Header, Footer, Hero, Card, etc.) — never grouped as "theming: X hours"
- Design system creation or reuse is always included in Frontend tab
- When designs are unavailable, visual reference links to similar components on comparable sites are mandatory
- Conf (1-6) assigned per line item reflecting requirement clarity and solution confidence
- Conf buffer formula computes Low Hrs / High Hrs per line item (Conf 6=0%, 5=+25%, 4=+50%, 3=+50%, 2=+75%, 1=+100%)
- Risk Register generated for all Conf ≤ 4 items with open questions and de-risk actions
- Integration tiers (T1/T2/T3) classify integrations by complexity with standardized effort ranges
- Always-include Backend tasks validated (Discovery, Environment, Install, CMI, Roles, Media, Deployment, QA)
- State file written for iterative refinement when clarification answers arrive
- Populate QED42 Excel template all tabs via `scripts/populate-estimate-xlsx.py`
- Generate client-facing Technical Proposal Document
- Output: `estimates/optimistic-estimate.md`, `estimates/[CLIENT]-estimate-state.md`, `claude-artefacts/technical-proposal.md`, populated Excel template
- After Phase 1A, can optionally flow to Phase 3 (estimate review) for validation
- State file can be resumed: fill in PENDING answers, re-run `/optimistic-estimate [state-file-path]`

### Phase 2: Response Integration
**Trigger:** Customer responses placed in `responses_qna/`
**Agent Persona:** Senior [TECH_STACK] Architect (deep expertise in platform capabilities, ecosystem, architecture patterns, migrations, integrations, performance, and enterprise architecture)
**Tools:** claude-mem smart_search (similar integration patterns from past engagements)
- Read customer responses alongside original TOR
- Map responses back to original questions and requirements
- Identify any still-unresolved ambiguities
- Produce updated requirement clarity assessment
- Output: `claude-artefacts/response-analysis.md`

### Phase 3: Estimate Review
**Trigger:** Estimates document placed in `estimates/`
**Agent Persona:** Senior [TECH_STACK] Architect + Estimation Specialist
**Tools:** ralph-loop (iterative validation — 3 passes: coverage, effort reasonableness, assumption consistency), claude-mem smart_search (effort benchmarks), CARL presales domain (gap detection)
**Output Template:** `templates/estimate-review-template.md`
- Cross-reference estimates against TOR requirements and customer responses
- Validate: Are all TOR requirements covered by estimate line items?
- Validate: Are effort figures reasonable for the scope described?
- Validate: Are assumptions in the estimate consistent with customer responses?
- Flag misalignments between requirements and estimates (missing items, over/under-estimated areas)
- Output: `claude-artefacts/estimate-review.md`

### Phase 4: Updated Estimates & Gap Analysis
**Trigger:** Completion of Phase 3
**Tools:** CARL presales domain (requirement-to-estimate mapping enforcement), claude-mem (calibrate against historical data)
**Output Template:** `templates/gap-analysis-template.md`
- Produce a gap analysis document mapping every TOR requirement to its estimate line item (or flagging it as missing)
- Suggest revised estimates where gaps or misalignments were found
- Highlight risks and assumptions that affect estimation confidence
- Output: `claude-artefacts/gap-analysis.md` and `claude-artefacts/revised-estimates.md`

### Phase 5: Knowledge Capture (Post-Engagement)
**Trigger:** After engagement concludes or estimate is accepted
**Tools:** claude-mem (store observations)
- Record actual vs estimated variances (if available)
- Capture client-specific patterns (industry, complexity factors)
- Store reusable question patterns that uncovered hidden scope
- Update `benchmarks/` directory with new data points
- Output: claude-mem observations + updated benchmarks/

## Agent Guidelines

### TOR Analysis (Phase 1)
- Categorize requirements by domain: content architecture, integrations, migrations, frontend/theming, DevOps/hosting, SEO, accessibility, performance, security
- For each requirement, rate clarity as: Clear / Needs Clarification / Ambiguous / Missing Detail
- Questions should be specific and actionable — avoid generic "can you elaborate?" questions
- Group questions logically (by module, feature area, or integration point)
- Call out any requirements that are technically infeasible or contradictory

### Technology Assessment
- Evaluate requirements through the lens of [TECH_STACK] platform capabilities
- Identify where existing ecosystem solutions (plugins, modules, packages) vs. custom development is needed
- Flag integration complexity (SSO, CRM, ERP, payment gateways, third-party APIs)
- Assess migration complexity if migrating from an existing system
- Consider architecture implications (monolith, decoupled, microservices) if applicable
- Note hosting/infrastructure requirements and their impact on estimates
- See `.carl/` for tech-specific assessment rules loaded via CARL overlay

### Estimate Validation
- Verify estimates are organized into correct tabs (Backend/Frontend/Fixed Cost Items/AI)
- Verify Backend/Frontend items are development tasks needing QA+PM (auto-calculated in sheet)
- Verify Fixed Cost Items are operational/admin tasks NOT needing QA or PM (deployment, docs, training, onboarding)
- Verify Frontend estimates are at component level with visual reference links and Exclusions column
- Verify a Design System line item exists in Frontend tab
- Verify Conf (1-6) is assigned to every line item
- Verify Low Hrs / High Hrs computed using Conf buffer formula (Conf 6=0%, 5=+25%, 4=+50%, 3=+50%, 2=+75%, 1=+100%)
- Verify all Conf ≤ 4 items appear in Risk Register with open questions and de-risk actions
- Verify always-include Backend tasks present: Discovery, Environment Setup, Base Config, CMI, Roles & Permissions, Media Library, Deployment Pipeline, QA/Stabilisation
- Verify integrations classified by tier (T1/T2/T3) per `benchmarks/drupal-effort-ranges.md`
- Verify assumptions include impact-if-wrong alongside TOR/Q&A references
- Check for common estimation gaps: deployment/DevOps, content migration, training, documentation, UAT support, warranty/hypercare (in Fixed Cost Items)
- Verify estimates account for platform-specific complexity
- Flag any requirement covered by the TOR but missing from the estimate
- Flag any estimate line item not traceable to a TOR requirement
- Compare effort figures against `benchmarks/` reference ranges when available (use `benchmarks/frontend-effort-ranges.md` for Frontend tab)

## Tool Integration

### Cross-Phase Tools
- **claude-mem**: Store and retrieve estimation patterns across engagements. After each engagement, record key learnings (actual vs estimated, question patterns that revealed scope, integration gotchas). Use `smart_search` to find relevant past data.
- **CARL presales domain**: Automatically enforces estimation checklist and quality rules every session.
- **sequential-thinking MCP**: Available for structured decomposition of complex documents.

### Memory Commands
- After Phase 4 completion, run: "Store estimation learnings from [CLIENT_NAME] engagement"
- Before Phase 1 of new engagement, run: "Retrieve estimation patterns for [TECH_STACK] projects"

### Star-Commands (via CARL)
- `*checklist` — Run full estimation gap checklist against current artefacts
- `*recap` — Summarize engagement state across all phases
- `*benchmark <query>` — Look up effort benchmarks from claude-mem + benchmarks/
- `*optimistic` — Generate optimistic estimate (no-response path)
- `*proposal` — Generate Technical Proposal Document

## File Naming Conventions

All AI-generated files should use kebab-case with descriptive names. Include dates in filenames when producing revisions (e.g., `gap-analysis-2026-03-25.md`).

## How to Run Each Phase

Phase transitions are manual. The operator uploads documents and instructs Claude which phase to execute. Example prompts:

- **Phase 0:** "Research the customer and audit their existing site based on the TOR in `tor/`"
- **Phase 1:** "Analyze the TOR in `tor/` and generate clarifying questions"
- **Phase 1A (no-response path):** "/optimistic-estimate" followed by "/tech-proposal" — generates assumption-heavy estimates and a client-facing proposal without waiting for customer Q&A responses
- **Phase 2:** "Customer responses are in `responses_qna/`. Analyze them against the TOR and original questions"
- **Phase 3:** "Estimates are in `estimates/`. Review them against requirements and responses"
- **Phase 4:** "Generate the gap analysis and revised estimates"
- **Phase 5:** "Capture learnings from this engagement for future reference"
