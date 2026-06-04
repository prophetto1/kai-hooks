# Skills catalog

Consult this when choosing a skill. Each entry is enough to route on without opening the skill; once chosen, invoke it (its own description loads then). Tiers reflect how situation-dependent the skill is.

## Tier 1 — load by default, every response
- `using-superpowers` — at the start of any task: figure out which skills apply and load them before acting.
- `writing-clearly-and-concisely` — any prose a human will read: cut clutter, tighten sentences (Strunk rules).
- `waza-write` — polishing/editing prose: strip AI-tell phrasing, preserve meaning.

## Tier 2a — ideation / framing (new or creative work)
- `brainstorming` — explore goals, constraints, options, and tradeoffs before creative product or feature work.
- `waza-think` — before coding a new feature/design/decision: turn a rough idea into a validated, approved plan. Not for small edits.
- `initiating-a-new-task` — task given as a few sentences of intent: gather repo context, propose understanding + route + ≤3 questions.
- `environment-discovery` — unknown environment or repo context: scan structure, tools, constraints, and source-of-truth files before work starts.

## Tier 2b — process discipline (engage on the matching phase)

_Plan_
- `investigating-and-writing-plan` — multi-step task: investigate repo, lock the plan contract, write the tasks before touching code.
- `taking-over-investigation-and-plan` — inheriting a draft or partial work: verify, salvage, reconcile, or replace before continuing.
- `architecture` — choosing between technologies or recording a design decision with tradeoffs (ADR).
- `system-design` — designing services, APIs, data models, and service boundaries.
- `write-spec` — turning a vague idea into a structured spec/PRD: goals, non-goals, acceptance criteria.

_Evaluate / execute_
- `evaluating-plan-before-implementation` — go/no-go gate on a drafted plan: completeness + architecture quality before building.
- `evaluating-implemented-plan` — implementation looks done: audit it against the approved plan before merge/handoff.
- `executing-approved-plans` — execute a plan as a contract: track manifest, decisions, acceptance, drift.
- `address-evaluation-results` — disposition eval findings: three-way verification + mandatory plan-file recording.
- `blind-implementation-review` — independent cold review of built code, ignoring the plan: judge correctness/safety from the code itself.

_Debug_
- `systematic-debugging` — reproduce → isolate → one-change-at-a-time root-cause tracing before any fix.
- `build-and-compile` — build, dependency, package, or compile failure: diagnose across languages and toolchains.
- `chrome-devtools` — browser runtime debugging: inspect console, network, DOM, storage, and performance behavior.
- `waza-hunt` — terse variant: state the root cause of an error/crash/failing test before patching.

_Test_
- `test-driven-development` — before writing implementation code: red-green-refactor, test must fail first.
- `testing-strategy` — design test plans, coverage architecture, risk-based suites, and verification approach.
- `test-writer` — generate or extend tests for existing code when implementation already exists.

_Review_
- `code-review` — directly review a diff, PR, or changed files for security, correctness, performance, and maintainability.
- `requesting-code-review` — finished work: prepare the context, requirements, and evidence a reviewer needs.
- `receiving-code-review` — acting on review feedback: verify before agreeing or implementing, especially if it seems wrong.
- `waza-check` — after implementation / before merge: sweep the diff, auto-fix safe issues, escalate large diffs.

_Code quality / repo mechanics_
- `refactor` — direct refactoring workflow: improve structure without changing behavior.
- `performant-code` — performance-oriented implementation work for large data, hot paths, or tight resource constraints.
- `initialize-depcruiser-migrations` — initialize one current-version dependency-cruiser migration with donor trace, source manifest, state-backed arming, guarded target paths, and active closure verification.
- `git-workflow` — branches, commits, PRs, merges, conflicts, and repository hygiene.

_Verify / finish_
- `verification` — verify a complete user-facing flow end-to-end across browser, API, data, environment, and rendered response.
- `verification-before-completion` — before claiming done/fixed/passing: run commands, confirm output, evidence before assertions.
- `finishing-a-development-branch` — work complete and tests pass: decide merge / PR / cleanup / handoff.

## Tier 3 — situation-gated (load when the trigger applies)

_Frontend page / contract work_
- `frontend-foundation-audit` — an inconsistent FE foundation (shell, tokens, components) needs assessment before a canonical contract.
- `frontend-foundation-designer` — turn a reference web page into a foundational React page in a Vite/React/Tailwind app.
- `extracting-platform-page-contract` — extract one live page into a deterministic design package (shell, tokens, components).
- `designing-from-layout-contract` — turn a measured capture (report.json + screenshots) into a fixed reproduction contract.
- `measuring-layouts-with-playwright` — measure a live page's computed styles/layout for a parity spec.
- `writing-frontend-design-instruction` — approved plan has FE surface but no design direction: define page look, states, tokens, then build.

_A design / mockup exists_
- `accessibility-review` — audit a design/page for WCAG 2.1 AA: contrast, keyboard, targets, screen reader.
- `design-critique` — feedback on a mockup/screenshot: usability, hierarchy, consistency.
- `design-handoff` — a design is ready for eng: produce a dev spec (layout, tokens, props, states, breakpoints).
- `design-system` — audit/extend a design system: hardcoded values, naming drift, missing states.
- `waza-design` — building any UI/component/page: push a committed, non-generic aesthetic.
- `ux-copy` — write microcopy: errors, empty states, CTAs, onboarding, confirmations.

_Data or a database_
- `supabase-postgres-best-practices` — write/review Postgres queries, schema, config for performance and safety.

_Deploy / incident / change_
- `deploy-checklist` — before shipping: verify CI/migrations/flags/approvals, document rollback triggers.
- `incident-response` — during a production incident: severity, comms, mitigation, blameless postmortem.
- `runbook` — document an operational procedure for a recurring task (steps, troubleshooting, rollback).
- `change-request` — a change needs approval/CAB: impact analysis, rollback plan, stakeholder comms.

_Research input to digest_
- `competitive-brief` — analyze competitors / a feature area for strategy, battle cards, or board prep.
- `metrics-review` — review product metrics over a period: investigate spikes/drops vs targets → scorecard.
- `user-research` — plan/run/synthesize user research: questions, guides, surveys, usability tests.
- `synthesize-research` — distill interviews/surveys/tickets/feedback into ranked themes, segments, recommendations.

_External repo to assess / port_
- `repo-investigator` — general repo analysis: inspect structure, capabilities, dependencies, architecture, and evidence.
- `repo-compatibility-investigator` — analyze/compare a repo and assess fit through the lens of our own repo's needs, with file evidence.
- `oss-discovery` — find stack-compatible OSS for a desired feature: adopt/borrow/fork/avoid verdict.
- `extracting-capability` — lift/port a coherent capability or subsystem: cut-plan with take/cut/shim/replace, seams, license map.

_URL / PDF / learning source_
- `waza-read` — given a URL/web page/PDF: fetch it as clean Markdown (proxy cascade).
- `waza-learn` — deep dive into an unfamiliar domain or research article: collect → digest → outline → draft → publish.

_Producing a doc / process artifact_
- `doc-coauthoring` — write/maintain or co-author technical docs/specs (README, API, architecture, onboarding) through structured iteration.
- `process-doc` — document a business process (flowchart, RACI, SOP, exceptions).
- `process-optimization` — analyze a slow/overloaded workflow for bottlenecks and practical fixes.
- `proposal-writing` — funding/grant/pitch/investment proposals from source docs.
- `standup` — turn recent work into a daily standup update (yesterday/today/blockers).

_Building a specific thing_
- `cli-developer` — build CLI tools: argument parsing, interactive prompts, progress, completions.
- `mcp-builder` — build an MCP server for an external API/service (tool design, transport).
- `writing-skills` — create, edit, or test skills via TDD: structure, triggers, baseline test first, close loopholes.

_Agent-infra / security_
- `prompt-guard` — design/apply prompt-injection defenses (direct + indirect detection).
- `pm-protocol` — PM/director mode for stalled work, vague handoffs, runtime/config recovery, coordination.
- `waza-health` — Claude ignores instructions or hooks/MCP misbehave: audit the config stack by severity.
- `hook-development` — create, validate, and debug agent hooks for Claude Code, Codex, or compatible runtimes, including UserPromptSubmit, PreToolUse, PostToolUse, and Stop.
- `claude-automation-recommender` — recommend Claude Code automations across hooks, subagents, skills, plugins, and MCP servers.
- `context-mode` — process large logs or command output with context-mode tools instead of dumping bulky text into the chat.
- `ctx-doctor` — diagnose context-mode runtimes, hooks, FTS5, plugin registration, npm setup, and marketplace versions.
- `mcp-integration` — configure or integrate MCP servers into an existing plugin, repo, or agent-control setup.
- `plugin-settings` — design plugin configuration/state handling, including user-configurable settings and local config files.
- `plugin-structure` — structure Claude plugins, plugin manifests, commands, agents, hooks, MCP servers, and bundled skills.
- `command-development` — create or revise slash commands and command frontmatter for reusable agent workflows.
