# Claude Code Plugin Customization Guide

A comprehensive guide to customizing Claude Code plugins for your organization, using bkit as a reference implementation.

---

## Table of Contents

**Part I: Understanding bkit**
1. [bkit Design Philosophy](#1-bkit-design-philosophy)
2. [Why bkit is Well-Designed](#2-why-bkit-is-well-designed)
3. [Supported Languages & Frameworks](#3-supported-languages--frameworks)
4. [Enterprise AI-Native Architecture](#4-enterprise-ai-native-architecture)

**Part II: Plugin Architecture**

5. [Understanding Plugin Architecture](#5-understanding-plugin-architecture)
6. [Configuration Paths by Platform](#6-configuration-paths-by-platform)
7. [Plugin Components Overview](#7-plugin-components-overview)

**Part III: Customization Guide**

8. [Customizing Agents](#8-customizing-agents)
9. [Customizing Skills](#9-customizing-skills)
10. [Customizing Commands](#10-customizing-commands)
11. [Customizing Hooks](#11-customizing-hooks)
12. [Creating Templates](#12-creating-templates)
13. [Organization-Specific Customization](#13-organization-specific-customization)

**Part IV: Reference**

14. [Best Practices](#14-best-practices)
15. [License & Attribution](#15-license--attribution)

---

## ⚠️ Important Notices

### Custom Skills Data Loss Warning (CC v2.1.113+ Users)

**Symptom**: On CC CLI v2.1.113+ (especially v2.1.116), the `~/.claude/skills/` directory may be **silently deleted** on first-run ([#51234](https://github.com/anthropics/claude-code/issues/51234)).

**Impact on bkit**:
- ✅ **bkit plugin itself is unaffected** — bkit's 44 skills live under `${CLAUDE_PLUGIN_ROOT}/skills/` (plugin bundle path).
- ⚠️ **User custom skills affected** — if you keep personal skills under `~/.claude/skills/`, **data loss is possible**.

#### Recommended Backup (run immediately)

```bash
# Full backup with date tag
cp -R ~/.claude/skills ~/.claude/skills.backup.$(date +%Y%m%d)

# Backup to an external safe location
mkdir -p ~/Documents/claude-skills-backup
cp -R ~/.claude/skills/* ~/Documents/claude-skills-backup/
```

#### Restore (if deletion occurs)

```bash
# Restore from backup
cp -R ~/.claude/skills.backup.YYYYMMDD ~/.claude/skills
```

#### Recommended Paths for bkit Custom Skill Authors

bkit stores skills under the **plugin bundle path** (`${CLAUDE_PLUGIN_ROOT}/skills/`), so it is unaffected. To author your own skill:

1. **Recommended**: Fork the bkit plugin and create `skills/{skill-name}/SKILL.md` (see §9 of this guide).
2. **Alternative**: Create a separate plugin (follow bkit's `.claude-plugin/plugin.json` + `skills/` structure).
3. **Avoid**: Using `~/.claude/skills/` — risk of loss on CC upgrades.

#### Monitoring Status

This issue is tracked under **MON-CC-06** (16 regressions from CC v2.1.113 native-binary transition, consolidated). Related issues:
- [#50274](https://github.com/anthropics/claude-code/issues/50274) session termination
- [#50383](https://github.com/anthropics/claude-code/issues/50383) macOS 11 dyld
- [#50974](https://github.com/anthropics/claude-code/issues/50974) postinstall failure
- [#51165](https://github.com/anthropics/claude-code/issues/51165) `context: fork` failure
- [#51234](https://github.com/anthropics/claude-code/issues/51234) custom skills deletion

This warning is monitored under CC v2.1.118+ ongoing observation; bkit's plugin-bundle path keeps the plugin itself safe regardless.

---

## 1. bkit Design Philosophy

Before customizing bkit, understanding its design intent helps you make better decisions about what to adapt and what to keep.

### Core Mission

> **"Enable all developers using Claude Code to naturally adopt 'document-driven development' and 'continuous improvement' even without knowing commands or PDCA methodology"**

In essence: **AI guides humans toward good development practices**.

### Three Core Philosophies

| Philosophy | Description | Implementation |
|------------|-------------|----------------|
| **Automation First** | Claude automatically applies PDCA even if user doesn't know commands | `bkit-rules` skill + PreToolUse hooks |
| **No Guessing** | If unsure, check docs → If not in docs, ask user (never guess) | Design-first workflow, `gap-detector` agent |
| **Docs = Code** | Design first, implement later (maintain design-implementation sync) | PDCA workflow + `/pdca-analyze` command |

### Well-Designed Aspects Worth Preserving

When customizing bkit, consider keeping these architectural patterns:

#### 1. Layered Trigger System

```
Layer 1: hooks.json          → SessionStart, PreToolUse, PostToolUse hooks
Layer 2: Skill Frontmatter   → hooks: PreToolUse, PostToolUse, Stop
Layer 3: Agent Frontmatter   → hooks: PreToolUse, PostToolUse
Layer 4: Description Triggers → "Triggers:" keyword matching
Layer 5: Scripts             → Actual Node.js logic execution (65 scripts)
```

This separation allows fine-grained control over when and how automation triggers.

#### 2. Level-Based Adaptation

bkit automatically adjusts its behavior based on detected project complexity:

| Level | Detection | Behavior |
|-------|-----------|----------|
| **Starter** | Simple HTML/CSS structure | Friendly explanations, simplified PDCA |
| **Dynamic** | Next.js + BaaS indicators | Technical but clear, full PDCA |
| **Enterprise** | K8s/Terraform/microservices | Concise, architecture-focused |

#### 3. PDCA Within Each Phase

```
Pipeline Phase (e.g., API Implementation)
├── Plan: Define requirements
├── Design: Write spec
├── Do: Implement
├── Check: Gap analysis
└── Act: Document learnings
```

Each of the 9 pipeline phases runs its own PDCA cycle—not one PDCA for the whole project.

#### 4. Zero Script QA

Instead of writing test scripts, bkit uses:
- Structured JSON logging
- Request ID flow tracking
- AI-powered real-time log analysis
- Automatic issue documentation

### What to Customize vs. Keep

| Keep As-Is | Safe to Customize |
|------------|-------------------|
| PDCA workflow structure | Trigger keywords (add your language) |
| Level detection logic | Agent communication style |
| Hook event architecture | Template content and structure |
| Gap analysis methodology | Skill domain knowledge |

### Design Documentation

For deeper understanding, explore the `bkit-system/` folder:

| Document | Purpose |
|----------|---------|
| [bkit-system/README.md](bkit-system/README.md) | System architecture overview |
| [Core Mission](bkit-system/philosophy/core-mission.md) | 3 philosophies explained |
| [AI-Native Principles](bkit-system/philosophy/ai-native-principles.md) | AI-Native development model |
| [PDCA Methodology](bkit-system/philosophy/pdca-methodology.md) | PDCA + 9-stage pipeline |
| [Graph Index](bkit-system/_GRAPH-INDEX.md) | Obsidian visualization hub |

> **Tip**: Open `bkit-system/` as an [Obsidian](https://obsidian.md/) vault and press `Ctrl/Cmd + G` to visualize all component relationships.

---

## 2. Why bkit is Well-Designed

bkit is not just a collection of prompts—it's a **production-grade plugin architecture** with carefully designed components that work together as a cohesive system.

### Component Inventory (v2.1.40 — runtime-measured 2026-09-25)

> Measured by `lib/infra/docs-code-scanner.js`, not typed by hand, and locked by
> `test/contract/component-inventory.test.js`. This table went four releases
> stale (scripts 61 vs 62, lib/ 195 vs 198, BKIT_VERSION 2.1.13 vs 2.1.34)
> because `docs-code-sync.js` checks only `plugin.json` by default.

| Component | Count | Purpose |
|-----------|-------|---------|
| **Agents** | 34 | Specialized AI subagents (memory persistence). v2.1.13 added 4 sprint agents (`sprint-master-planner` · `sprint-orchestrator` · `sprint-qa-flow` · `sprint-report-writer`). |
| **Skills** | 44 | Domain knowledge and slash commands (v2.1.13 added `sprint` skill; v2.1.11 added bkit-evals, bkit-explore, pdca-watch, pdca-fast-track) |
| **Commands** | DEPRECATED | Migrated to Skills in v1.4.4+ |
| **Scripts** | 65 | Hook execution scripts (v2.1.13 added `sprint-handler.js` 660 LOC + `sprint-memory-writer.js` 138 LOC; v2.1.11 adds check-trust-score-reconcile, check-quality-gates-m1-m10, release-plugin-tag.sh) |
| **Templates** | 40 | Document templates (PDCA + 9 phases + shared + **7 sprint templates** v2.1.13: master-plan/prd/plan/design/iterate/qa/report) |
| **Hooks** | 21 events / 24 blocks | Event-driven automation (centralized in hooks.json, invariant maintained, 3 attribution sites: Stop/SessionEnd/SubagentStop) |
| **lib/** | 202 modules across 22 subdirs | **Clean Architecture 4-Layer with 7 Port↔Adapter pairs**: Domain (ports 7 + guards 4 + rules + **policy** v2.1.37) / Application (cc-regression + pdca + pdca-lifecycle + **sprint-lifecycle** v2.1.13 + team) / Infrastructure (cc-bridge + telemetry + docs-code-scanner + mcp-port-registry + mcp-test-harness + cc-version-checker + branding + **sprint** v2.1.13 with 9 adapters) / Presentation (hooks + scripts). Subdirs: application, audit, cc-regression, control, core, dashboard, defense, discovery, domain, evals, i18n, infra, intent, orchestrator, pdca, qa, quality, sprint, task, team, ui, util. |
| **Output Styles** | 4 | Level-based response formatting (bkit-learning, bkit-pdca-guide, bkit-enterprise, bkit-pdca-enterprise) |
| **MCP Servers** | 2 | `bkit-pdca-server` (13 tools — v2.1.13 added `bkit_sprint_list` · `bkit_sprint_status` · `bkit_master_plan_read`), `bkit-analysis-server` (6 tools). **19 tools total**, registered via `lib/infra/mcp-port-registry.js` per FR-δ1. |
| **ACTION_TYPES** | 20 | v2.1.13 added `sprint_paused` + `sprint_resumed` + `master_plan_created` + `task_created`. Categories also expanded 10→11 (`sprint` added). |
| **Test Files** | 376 (qa-aggregate scope) | 4,364 assertions via `node test/run-all.js` and ~7,000 via qa-aggregate, 0 failures (v2.1.36 measured; +3 files in v2.1.38 — the QA pipeline wiring, QA follow-up, and Stop-handler extraction regression suites) |
| **BKIT_VERSION** | 2.1.40 | `bkit.config.json` single source of truth; 5-location invariant enforced by `scripts/docs-code-sync.js` (PASS 9-streak: v2.1.120/121/123/129/132/133/137/139, F9-120 closure carryover monitoring complete) |

**Total: 730+ components** working in harmony across **Clean Architecture 4-Layer + Defense-in-Depth 4-Layer + Invocation Contract L1~L6 + 3-Layer Orchestration + Application Layer pilot (v2.1.11 γ2 introduction; v2.1.12 hardens the evals path; v2.1.13 GA introduces Sprint Management as the first non-PDCA workflow primitive: +1 skill + 4 agents + 7 templates + 3 MCP tools + 2 core infrastructure adapters + 9 application-layer modules + 8 contract test cases = 27+ new components, plus −2,333 LOC tech debt cleanup)**.

### v2.1.11 Integrated Enhancement Features (4 Sprints × 20 FRs)

| Sprint | Highlights |
|---|---|
| **α Onboarding Revolution** | One-Liner SSoT 5/5 enforced; README split (≤100 lines + README-FULL); first-run AskUserQuestion tutorial with design anchor lock; Agent Teams env preflight; `cc-version-checker.js` subprocess + version.json fallback + module cache |
| **β Discoverability** | `/bkit explore` 5-category tree; `/bkit evals run` skill regex + spawnSync wrapper; `/pdca watch` read-only NDJSON state tap; `/pdca fast-track` Daniel-mode auto-approve (DEFAULT_FAST_TRACK frozen); error-friendly i18n via `lib/i18n/translator.js` + `detector.js` (KO/EN full + 6-lang fallback) |
| **γ Trust Foundation** | `trust-engine.reconcile()` public API + `syncToControlState()`; Application Layer pilot (`lib/application/pdca-lifecycle/{index,phases,transitions}.js`); ADR 0004 (agent-hook multi-event deferral) + ADR 0005 (Application Layer pilot) |
| **δ Port + Governance** | `mcp-tool.port.js` + 16-tool registry (7th Port↔Adapter pair); Quality Gates M1-M10 catalog + `check-quality-gates-m1-m10.js` invariant; `token-report.js` aggregate + markdown render with CAND-004 OTEL 3-attr (I4-121 + F8-119 + I6-119); ADR 0006 CC Upgrade Policy; `release-plugin-tag.sh` automation |

| Feature | Location | Purpose |
|---------|----------|---------|
| **Clean Architecture 4-Layer** | `lib/domain/` (ports 7 + guards 4 + rules 1) + `lib/infra/` adapters + `lib/application/pdca-lifecycle/` pilot + `lib/cc-regression/` + hooks/scripts | 0 forbidden imports CI-enforced via `scripts/check-domain-purity.js` |
| **Defense-in-Depth 4-Layer** | Layer 1 (CC Built-in sandbox) → Layer 2 (`pre-write.js` + `unified-bash-pre.js` + defense-coordinator) → Layer 3 (audit-logger OWASP A03/A08 sanitizer, 7-key PII) → Layer 4 (Token Ledger NDJSON) | Formalized in `docs/03-analysis/security-architecture.md` |
| **Invocation Contract L1~L6** | `test/contract/baseline/` (44 skills + 40 agents + 21 hook events per snapshot) + L2 smoke + L3 MCP stdio + L5 E2E shell + L6 host integration | 202 L1+L4 assertions CI-gated via `.github/workflows/contract-check.yml`, plus L6 live-run freshness — a recorded `claude -p --plugin-dir` run whose observed events CI checks against the shipped `hooks.json` hash |
| **Guard Registry** | `lib/cc-regression/registry.js` — 21 guards + `expectedFix` seed | Daily cron `cc-regression-reconcile.yml` auto-releases guards via `lifecycle.reconcile()` |
| **3-Layer Orchestration** | `lib/orchestrator/` 5 modules (intent-router + next-action-engine + team-protocol + workflow-state-machine + index) | Feature > skill > agent priority, SKILL_TRIGGER_PATTERNS 15, matchRate SSoT 90 |
| **BKIT_VERSION 5-location Invariant** | `bkit.config.json` (canonical) → `plugin.json` + `hooks.json` + `session-start.js` + `README.md` + `CHANGELOG.md` | `scripts/docs-code-sync.js scanVersions()` enforces 0 drift |
| **One-Liner SSoT 5/5** | `lib/infra/branding.js` (canonical) → `plugin.json` + `README.md` + `README-FULL.md` + `hooks/startup/session-context.js` + `CHANGELOG.md` | `scripts/docs-code-sync.js scanOneLiner()` enforces 0 drift |
| **Docs=Code CI** | `scripts/docs-code-sync.js` + `lib/infra/docs-code-scanner.js` | Counts (skills/agents/hookEvents/hookBlocks/mcpServers/mcpTools) + version invariant + One-Liner invariant, 0 drift required |
| **Quality Gates M1-M10** | `docs/reference/quality-gates-m1-m10.md` (catalog) + `scripts/check-quality-gates-m1-m10.js` (invariant) | I4-121 stop_reason / OTEL telemetry alignment with PDCA phase gates |

### Library Module Structure (v2.1.11 — Clean Architecture 4-Layer with 7 Port↔Adapter pairs)

```
lib/
├── import-resolver.js     # Top-level: bkit: prefix resolver
├── permission-manager.js  # Top-level: permission mode enforcement
├── skill-orchestrator.js  # Top-level: skill dispatch
│
├── domain/                # Domain Layer — 0 forbidden imports CI-enforced
│   ├── ports/             # 7 ports (JSDoc typedef contracts)
│   │   ├── cc-payload.port.js
│   │   ├── state-store.port.js
│   │   ├── regression-registry.port.js
│   │   ├── audit-sink.port.js
│   │   ├── token-meter.port.js
│   │   ├── docs-code-index.port.js
│   │   └── mcp-tool.port.js   # v2.1.11 FR-δ1
│   ├── guards/            # 4 CC regression guards (ENH-254/262/263/264)
│   └── rules/             # Invariants (e.g., docs-code-invariants.js EXPECTED_COUNTS)
│
├── application/           # Application Layer (v2.1.11 γ2 pilot)
│   └── pdca-lifecycle/    # index.js + phases.js + transitions.js
│
├── infra/                 # Infrastructure Layer (adapter implementations)
│   ├── cc-bridge.js       # Port: cc-payload (parseHookInput, detectCCVersion, etc.)
│   ├── telemetry.js       # Port: audit-sink (createOtelSink — sanitizeForOtel 2-gate AND-logic)
│   ├── docs-code-scanner.js  # Port: docs-code-index (measure + crossCheck + scanVersions + scanOneLiner)
│   ├── mcp-port-registry.js  # v2.1.11 FR-δ1: 16-tool registry per mcp-tool port
│   ├── cc-version-checker.js # v2.1.11 FR-α5: subprocess + version.json fallback + module-level cache
│   ├── branding.js           # v2.1.11 FR-α2-a: One-Liner SSoT canonical
│   └── mcp-test-harness.js   # L3 MCP stdio runtime test runner
│
├── cc-regression/         # Application Layer (8 modules)
│   ├── registry.js        # 21 guards registry + expectedFix auto-release
│   ├── lifecycle.js       # reconcile() loop
│   ├── event-recorder.js  # hook attribution recordEvent
│   ├── precompact-counter.js  # ENH-247/257 2-week counter
│   └── index.js           # Re-exports + ccBridge
│
├── orchestrator/          # Sprint 7 — 3-Layer Orchestration (5 modules, 19 exports)
│   ├── intent-router.js          # Feature > skill > agent priority
│   ├── next-action-engine.js     # Stop-family hook next-action standardization
│   ├── team-protocol.js          # PM/CTO/QA Lead Task spawn protocol
│   ├── workflow-state-machine.js # PDCA phase × Control Level + matchRate SSoT
│   └── index.js
│
├── core/                  # Core utilities (16 modules)
│   ├── platform.js, cache.js, debug.js, config.js, io.js, file.js,
│   ├── paths.js, version.js (BKIT_VERSION lookup), state-store.js, ...
│
├── pdca/                  # PDCA management (22 modules)
│   ├── status-core.js, status-migration.js, status-cleanup.js (status.js was 872 LOC → facade)
│   ├── automation.js, state-machine.js (matchRate threshold SSoT 90), ...
│
├── intent/                # Intent analysis (4 modules)
│   ├── language.js (SKILL_TRIGGER_PATTERNS 15 per Sprint 7), trigger.js, ambiguity.js
│
├── task/                  # Task management (5 modules)
├── team/                  # CTO-Led Agent Teams (9 modules)
│   └── strategy.js        # Enterprise teammates 6 per Sprint 7 G-T-03
├── control/               # Control/Trust (8 modules)
│   └── trust-engine.js    # syncToControlState — level auto-reflect restored Sprint 7
├── audit/                 # Audit logger (4 modules)
├── context/               # Living Context (5 modules)
├── dashboard/             # v2.1.11 β4: /pdca watch read-only NDJSON state tap
├── discovery/             # v2.1.11 β1: /bkit explore 5-category tree
├── evals/                 # v2.1.11 β2: /bkit evals run wrapper
├── i18n/                  # v2.1.11 β3/β6: detector + translator (KO/EN full + 6-lang fallback)
├── pdca/
│   └── token-report.js    # v2.1.11 δ4: aggregate + markdown render with CAND-004 OTEL 3-attr
├── qa/                    # QA infrastructure (14 modules)
├── quality/               # Quality gates (4 modules)
└── ui/                    # CLI dashboard (7 modules)

Total: 190 files across 22 subdirectories + 3 top-level
```

**Import Options**:
```javascript
// Recommended: Import from specific modules
const { debugLog, getConfig } = require('./lib/core');
const { getPdcaStatusFull } = require('./lib/pdca');
const { matchImplicitAgentTrigger } = require('./lib/intent');
const { classifyTask } = require('./lib/task');

// Legacy: Still supported via Migration Bridge
const { debugLog, getConfig } = require('./lib/common');  // 210 exports
```

> **v1.6.2**: CC v2.1.78 Integration (14 ENH), PostCompact/StopFailure hooks, ${CLAUDE_PLUGIN_DATA} backup, agent effort/maxTurns, 1M context default, 12 hook events, 49 scripts, 210 exports, 1186 TC (99.7%), CC v2.1.78 recommended
>
> **v1.6.1**: CTO Orchestration Redesign (Main Session as CTO), 3-Tier Agent Security Model, Config-Code Sync, P0 Bug Fixes (4), Skill Evals 28/28, CE-5 Master (88/100), 1073 TC (99.6%), 28 skills, 21 agents, 208 exports, CC v2.1.69+ required
>
> **v1.6.0**: Skills 2.0 Complete Integration (19 ENH items), PM Agent Team (5 agents), Skill Evals Framework, Skill Classification (9 Workflow / 18 Capability / 1 Hybrid), A/B Testing, Skill Creator, template-validator, 28 skills, 21 agents, 208 exports, CC v2.1.71 recommended

> **v1.5.9**: Executive Summary module (3 exports), AskUserQuestion Preview UX, ENH-74~81 (agent_id/agent_type, continue:false), 199 exports

> **v1.5.8**: Claude Code Exclusive with CTO-Led Agent Teams (16 agents), Plan Plus skill, bkend MCP Accuracy Fix (28+ tools), Output Styles, Agent Memory, Team Visibility, /simplify + /batch PDCA integration, auto-memory support, HTTP hooks awareness, Studio Support (Path Registry, state directory migration)

### Context Engineering Architecture (v1.5.3)

bkit is a **practical implementation of Context Engineering**—the art of curating optimal tokens for LLM inference. Unlike traditional prompt engineering that focuses on single prompts, Context Engineering designs an entire system of context delivery.

```
┌─────────────────────────────────────────────────────────────────┐
│              bkit Context Engineering Architecture              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │ Domain Knowledge │  │ Behavioral Rules │  │ State Mgmt   │  │
│  │    (44 Skills)   │  │   (34 Agents)    │  │(lib/common)  │  │
│  │                  │  │                  │  │              │  │
│  │ • 9-Phase Guide  │  │ • Role Def.      │  │ • PDCA v2.0  │  │
│  │ • 3 Levels       │  │ • Constraints    │  │ • Multi-Feat │  │
│  │ • 8 Languages    │  │ • Few-shot       │  │ • Caching    │  │
│  └────────┬─────────┘  └────────┬─────────┘  └──────┬───────┘  │
│           │                     │                    │          │
│           └─────────────────────┼────────────────────┘          │
│                                 ▼                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                6-Layer Hook System                        │  │
│  │  L1: hooks.json (21 events)                              │  │
│  │  L2: Skill Frontmatter (PreToolUse/PostToolUse/Stop)     │  │
│  │  L3: Agent Frontmatter (PreToolUse/PostToolUse)          │  │
│  │  L4: Description Triggers (keyword matching)             │  │
│  │  L5: Scripts (43 Node.js modules)                        │  │
│  │  L6: Plugin Data Backup (${CLAUDE_PLUGIN_DATA})          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                 │                               │
│                                 ▼                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         Dynamic Context Injection                         │  │
│  │  • Task Size → PDCA Level                                │  │
│  │  • User Intent → Agent/Skill Auto-Trigger                │  │
│  │  • Ambiguity Score → Clarifying Questions                │  │
│  │  • Match Rate → Check-Act Iteration                      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### Context Engineering Patterns in bkit

| Pattern | Implementation | Purpose |
|---------|----------------|---------|
| **Role Definition** | Agent frontmatter | Expert role, responsibilities, level (CTO/Entry) |
| **Structured Instructions** | Skill SKILL.md | Checklists, tables, ASCII diagrams |
| **Few-shot Examples** | Agent/Skill prompts | Code patterns, output templates |
| **Constraint Specification** | Hook + Permission Mode | Tool restrictions, score thresholds |
| **State Injection** | SessionStart + Scripts | PDCA status, feature context, iteration counters |
| **Adaptive Guidance** | lib/common.js | Level-based branching, 8-language triggers, ambiguity detection |

> **Key Insight**: bkit doesn't just prompt the AI—it constructs an entire **context ecosystem** that guides AI behavior consistently across sessions.

For detailed Context Engineering documentation, see [bkit-system/philosophy/context-engineering.md](bkit-system/philosophy/context-engineering.md).

### Architectural Excellence

#### 1. Separation of Concerns

```
┌─────────────────────────────────────────────────────────────────┐
│               bkit Component Architecture (v2.1.11)              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Knowledge Layer    │ Skills (43)      │ Domain expertise       │
│  ─────────────────────────────────────────────────────────────  │
│  Execution Layer    │ Agents (36)      │ Autonomous task work   │
│  ─────────────────────────────────────────────────────────────  │
│  Interface Layer    │ Commands (DEPRECATED) │ User interaction  │
│  ─────────────────────────────────────────────────────────────  │
│  Automation Layer   │ Hooks + Scripts (49) │ Event-driven triggers│
│  ─────────────────────────────────────────────────────────────  │
│  Template Layer     │ Templates (18)   │ Document standards     │
│  ─────────────────────────────────────────────────────────────  │
│  Shared Library     │ lib/ (195 modules, 22 subdirs) │ Clean Architecture 4-Layer + 7 Port↔Adapter pairs │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Each layer has a single responsibility, making the system:
- **Maintainable**: Change one layer without affecting others
- **Testable**: Verify each component independently
- **Extensible**: Add new components to any layer

#### 2. Skill-Agent-Command Triad

Every major workflow has three coordinated components:

| Workflow | Skill (Knowledge) | Agent (Execution) | Command (Interface) |
|----------|-------------------|-------------------|---------------------|
| Beginner Help | `starter` | `starter-guide` | `/init-starter` |
| Fullstack Dev | `dynamic` | `bkend-expert` | `/init-dynamic` |
| Enterprise | `enterprise` | `enterprise-expert` | `/init-enterprise` |
| Gap Analysis | `bkit-rules` | `gap-detector` | `/pdca-analyze` |
| QA Testing | `zero-script-qa` | `qa-monitor` | `/zero-script-qa` |
| Code Review | `phase-8-review` | `code-analyzer` | `/pdca-iterate` |

This triad pattern ensures:
- **Consistent UX**: Same workflow, different entry points
- **Context Sharing**: Skill knowledge informs agent behavior
- **Flexibility**: Users can invoke via command or natural language

#### 3. Comprehensive Hook Coverage

bkit implements hooks at **5 different layers**:

```
Layer 1: hooks.json (Plugin-level)
   └─ SessionStart → Welcome message + level detection

Layer 2: Skill Frontmatter
   └─ PreToolUse  → Design doc check before Write/Edit
   └─ PostToolUse → Gap analysis suggestion after Write
   └─ Stop        → Next step guidance

Layer 3: Agent Frontmatter
   └─ PreToolUse  → Validation before actions
   └─ PostToolUse → Result processing

Layer 4: Description Triggers
   └─ "Triggers:" keywords for auto-activation

Layer 5: Scripts (43 Node.js scripts)
   └─ Actual logic execution
```

#### 4. Template Completeness

bkit provides templates for the **entire development lifecycle**:

**PDCA Templates (6):**
- `plan.template.md` - Feature planning
- `plan-plus.template.md` - Brainstorming-enhanced planning (v1.5.5)
- `design.template.md` - Technical design
- `design-starter.template.md` - Simplified for beginners
- `design-enterprise.template.md` - MSA architecture
- `analysis.template.md` - Gap analysis reports
- `report.template.md` - Completion reports

**Pipeline Phase Templates (10):**
- Phase 1-9 templates + Zero Script QA template

**Configuration Templates (2):**
- `CLAUDE.template.md` - Project instructions
- `_INDEX.template.md` - Document index

### Why This Matters for Customization

When you customize bkit, you inherit:

| Benefit | How bkit Provides It |
|---------|---------------------|
| **Proven Architecture** | 600+ components tested together |
| **Complete Workflows** | PDCA + 9-phase pipeline ready |
| **Multilingual Support** | 8 languages in trigger keywords |
| **Level Adaptation** | Auto-adjusts to Starter/Dynamic/Enterprise |
| **Documentation Standards** | 29 templates for consistency |
| **Automation Foundation** | 6-layer hook system |

### Quality Indicators

| Metric | bkit Value | Industry Typical |
|--------|------------|------------------|
| Component Count | 600+ | 10-20 |
| Hook Layers | 6 | 1-2 |
| Template Coverage | 100% PDCA | Partial |
| Language Support | 8 | 1-2 |
| Project Levels | 3 | 1 |
| Documentation | System architecture docs | README only |

---

## 3. Supported Languages & Frameworks

bkit implements a **4-tier language classification system** optimized for AI-Native development.

### Tier Classification System

```
┌─────────────────────────────────────────────────────────────────────────┐
│  TIER 1: AI-Native Essential (Full PDCA Support)                        │
├─────────────────────────────────────────────────────────────────────────┤
│  Languages:   Python, TypeScript, JavaScript ,java                           │
│  Extensions:  .py, .pyx, .pyi, .ts, .tsx, .js, .jsx, .mjs, .cjs        │
│  Frameworks:  React, Next.js, Svelte, SvelteKit, FastAPI , JAVA                │
│  AI Support:  Copilot ✓, Claude ✓, Cursor ✓, Vibe Coding optimized     │
├─────────────────────────────────────────────────────────────────────────┤
│  TIER 2: Mainstream Recommended                                          │
├─────────────────────────────────────────────────────────────────────────┤
│  Languages:   Go, Rust, Dart                                            │
│  Extensions:  .go, .rs, .dart, .astro, .vue, .svelte, .mdx             │
│  Frameworks:  Vue/Nuxt, Astro, Flutter, Tauri, React Native            │
│  AI Support:  Good ecosystem support, PDCA recommended                  │
├─────────────────────────────────────────────────────────────────────────┤
│  TIER 3: Domain Specific                                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  Languages:   Java, Kotlin, Swift, C, C++                               │
│  Extensions:  .java, .kt, .swift, .c, .cpp, .h, .sh, .bash             │
│  Frameworks:  Angular, Electron, Native iOS/Android                     │
│  AI Support:  Platform-specific, moderate AI tool support               │
├─────────────────────────────────────────────────────────────────────────┤
│  TIER 4: Legacy/Niche (Migration Recommended)                            │
├─────────────────────────────────────────────────────────────────────────┤
│  Languages:   PHP, Ruby, C#, Scala, Elixir                              │
│  Extensions:  .php, .rb, .cs, .scala, .ex, .exs                        │
│  AI Support:  Limited, migration paths provided                         │
├─────────────────────────────────────────────────────────────────────────┤
│  EXPERIMENTAL: Future Consideration                                      │
├─────────────────────────────────────────────────────────────────────────┤
│  Languages:   Mojo, Zig, V                                              │
│  Status:      Monitoring for mainstream adoption                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### Project Level × Language Tier Matrix

| Project Level | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---------------|--------|--------|--------|--------|
| **Starter** | ✅ Full | ⚠️ Limited | ❌ No | ❌ No |
| **Dynamic** | ✅ Full | ✅ Yes | ⚠️ Platform only | ❌ No |
| **Enterprise** | ✅ Primary | ✅ System/Cloud | ✅ Native apps | ⚠️ Migration required |

### Framework Recommendations by Use Case

#### Web Development

| Use Case | Recommended | Tier | Notes |
|----------|-------------|------|-------|
| Static Site | Next.js / HTML+CSS | 1 | Simplest, AI-native |
| SPA | React + Next.js | 1 | Full ecosystem |
| Content Heavy | Astro | 2 | Optimized for content |
| Enterprise Web | Next.js monorepo | 1 | Scalable, DDD patterns |

#### Mobile Development

| Use Case | Recommended | Tier | Notes |
|----------|-------------|------|-------|
| Quick MVP | React Native + Expo | 1 | Fastest to market |
| Cross-platform (6 OS) | Flutter | 2 | Single codebase |
| Native Modules | React Native CLI | 1 | Direct platform access |

#### Backend Services

| Use Case | Recommended | Tier | Notes |
|----------|-------------|------|-------|
| Fullstack BaaS | Next.js + bkend.ai | 1 | Quick prototyping |
| Microservices | Python FastAPI | 1 | Clean architecture |
| System Services | Go / Rust | 2 | K8s native |

#### Desktop Applications

| Use Case | Recommended | Tier | Notes |
|----------|-------------|------|-------|
| Lightweight (3-5MB) | Tauri | 2 | Rust backend |
| Rich Ecosystem | Electron | 3 | Proven (VS Code, Slack) |

### Extension Detection

bkit automatically detects language tier via file extensions:

```bash
# Detected in lib/common.js getLanguageTier()
Tier 1: .py .pyx .pyi .ts .tsx .js .jsx .mjs .cjs
Tier 2: .go .rs .dart .astro .vue .svelte .mdx
Tier 3: .java .kt .kts .swift .c .cpp .cc .h .hpp .sh .bash
Tier 4: .php .rb .erb .cs .scala .ex .exs
```

### Migration Paths for Tier 4 Languages

| From | To | Strategy |
|------|-----|----------|
| PHP | TypeScript | Next.js API routes |
| Ruby | Python | FastAPI microservices |
| Java | Kotlin or Go | Gradual module replacement |
| C# | TypeScript or Go | Service-by-service migration |

---

## 4. Enterprise AI-Native Architecture

bkit is designed to support **Enterprise-grade systems** through AI-Native development, maintenance, operations, and legacy modernization.

### What is AI-Native Development?

```
AI-Native = Claude Code + PDCA Methodology + 9-Stage Pipeline + Zero Script QA
```

AI is not just a code generator—it's a **development partner** that guides the entire software lifecycle.

### Enterprise Capabilities

#### 1. New System Development

Build enterprise systems from scratch with AI guidance:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Enterprise Development Flow                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Phase 1: Schema        → Domain modeling with AI validation            │
│  Phase 2: Convention    → Team coding standards (AI-enforced)           │
│  Phase 3: Mockup        → UI/UX prototypes with AI feedback             │
│  Phase 4: API           → RESTful design + Zero Script QA               │
│  Phase 5: Design System → Platform-agnostic component library           │
│  Phase 6: UI Integration→ Frontend-backend connection                   │
│  Phase 7: SEO/Security  → Automated vulnerability scanning              │
│  Phase 8: Review        → AI-powered code review + gap analysis         │
│  Phase 9: Deployment    → Infrastructure as Code (Terraform/K8s)        │
│                                                                         │
│  Each phase runs its own PDCA cycle for continuous improvement          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 2. Legacy System Modernization

Refactor existing systems to AI-Native architecture:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Legacy Modernization Strategy                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Step 1: Analysis                                                       │
│    └─ code-analyzer agent scans existing codebase                       │
│    └─ gap-detector identifies design-implementation drift               │
│    └─ Language tier assessment (migration priority)                     │
│                                                                         │
│  Step 2: Documentation Recovery                                         │
│    └─ AI generates missing design documents from code                   │
│    └─ PDCA templates standardize documentation                          │
│    └─ CLAUDE.md captures institutional knowledge                        │
│                                                                         │
│  Step 3: Incremental Refactoring                                        │
│    └─ pdca-iterator automates improvement cycles                        │
│    └─ Module-by-module migration (Tier 4 → Tier 1-2)                   │
│    └─ Zero Script QA validates each change                              │
│                                                                         │
│  Step 4: Architecture Evolution                                         │
│    └─ Monolith → Microservices (enterprise skill guidance)              │
│    └─ infra-architect designs K8s/Terraform setup                       │
│    └─ Clean Architecture (4-layer) implementation                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 3. Continuous Operations

Maintain and operate enterprise systems with AI assistance:

| Operation | bkit Support |
|-----------|--------------|
| **Incident Response** | qa-monitor agent analyzes logs in real-time |
| **Code Review** | code-analyzer enforces quality standards |
| **Documentation Sync** | gap-detector keeps docs and code aligned |
| **Knowledge Transfer** | CLAUDE.md + PDCA docs preserve context |
| **Team Onboarding** | Systematic training via /learn-claude-code |

### Enterprise Tech Stack (Recommended)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Enterprise Reference Architecture                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Frontend (Turborepo Monorepo)                                          │
│  ├─ Next.js 14+ (App Router)                                            │
│  ├─ TypeScript (Tier 1)                                                 │
│  ├─ Tailwind CSS + shadcn/ui                                            │
│  ├─ TanStack Query (server state)                                       │
│  └─ Zustand (client state)                                              │
│                                                                         │
│  Backend (Microservices)                                                │
│  ├─ Python FastAPI (Tier 1, primary)                                    │
│  ├─ Clean Architecture (4-layer)                                        │
│  │   ├─ API Layer (routers, DTOs)                                       │
│  │   ├─ Application Layer (services, use cases)                         │
│  │   ├─ Domain Layer (entities, business rules)                         │
│  │   └─ Infrastructure Layer (repositories, external APIs)              │
│  ├─ PostgreSQL (primary database)                                       │
│  ├─ Redis (cache, pub/sub)                                              │
│  └─ RabbitMQ / SQS (messaging)                                          │
│                                                                         │
│  Infrastructure                                                         │
│  ├─ AWS (EKS, RDS, S3, CloudFront)                                      │
│  ├─ Kubernetes (Kustomize overlays)                                     │
│  ├─ Terraform (Infrastructure as Code)                                  │
│  ├─ ArgoCD (GitOps deployment)                                          │
│  └─ GitHub Actions (CI/CD)                                              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### AI-Native Development Benefits

| Metric | Traditional | AI-Native (bkit) | Improvement |
|--------|-------------|------------------|-------------|
| **Simple CRUD** | 2-3 days | 2-4 hours | 80% faster |
| **Medium Feature** | 1-2 weeks | 2-3 days | 70% faster |
| **Complex Feature** | 3-4 weeks | 1-2 weeks | 50% faster |
| **Full MVP** | 3-6 months | 1-2 months | 60% faster |
| **Design-Code Gap** | 30-50% | Under 5% | 90% reduction |
| **Onboarding Time** | 2-4 weeks | Under 1 week | 75% faster |

### Team Transformation

| Role | Traditional | AI-Native | Change |
|------|-------------|-----------|--------|
| PM | 1.0 | 0.5 | PDCA auto-tracking |
| Senior Dev | 2.0 | 1.0 | AI guides architecture |
| Junior Dev | 4.0 | 2.0 | 3x productivity with AI |
| QA | 2.0 | 0.5 | Zero Script QA |
| Tech Writer | 1.0 | 0.0 | Auto-generated docs |
| **Total** | **10** | **4** | **60% reduction** |

### Key Message

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   "It's not about reducing developers—                                  │
│    it's about letting developers focus on more valuable work."          │
│                                                                         │
│   • Repetitive tasks      → AI handles                                  │
│   • Creative design       → Developers focus                            │
│   • Documentation, QA     → Automated                                   │
│   • Direction & Verification → Human's unique role                      │
│                                                                         │
│   Result: Same team creates 3x more value                               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why Build Your .claude on bkit?

| Reason | Explanation |
|--------|-------------|
| **Proven Foundation** | 100+ components tested in production |
| **Enterprise-Ready** | Clean Architecture + Microservices support |
| **Future-Proof** | AI-Native methodology adapts to new AI capabilities |
| **Team Scalable** | Works for solo developers and large teams |
| **Knowledge Persistent** | PDCA docs + CLAUDE.md preserve institutional knowledge |
| **Continuous Improvement** | Evaluator-Optimizer pattern automates quality |

---

## 5. Understanding Plugin Architecture

### How Plugins Work

When you install a Claude Code plugin, components are deployed to the global configuration directory (`~/.claude/`). To customize these for your specific projects, you can copy and modify them in your project's `.claude/` directory.

### Configuration Hierarchy (Precedence Order)

```
1. Managed Settings    → Enterprise/IT-controlled (highest priority)
2. Command Line Args   → Temporary session overrides
3. Project Local       → .claude/settings.local.json (personal, gitignored)
4. Project Shared      → .claude/settings.json (team-shared)
5. User Global         → ~/.claude/settings.json (lowest priority)
```

**Key Insight**: Project-level configurations override global configurations with the same name.

---

## 6. Configuration Paths by Platform

### Claude Code User Configuration (Global)

| Platform | Path |
|----------|------|
| **macOS** | `~/.claude/` |
| **Linux** | `~/.claude/` |
| **Windows (PowerShell)** | `%USERPROFILE%\.claude\` or `C:\Users\<username>\.claude\` |
| **Windows (WSL)** | `/home/<username>/.claude/` (Linux filesystem, NOT `/mnt/c/...`) |

> **Note (v1.5.3)**: bkit is Claude Code exclusive. Gemini CLI support was removed in v1.5.0.

### Managed Settings (Enterprise/Admin - Claude Code Only)

| Platform | Path |
|----------|------|
| **macOS** | `/Library/Application Support/ClaudeCode/` |
| **Linux/WSL** | `/etc/claude-code/` |
| **Windows** | `C:\Program Files\ClaudeCode\` |

> **Note**: Managed settings require administrator privileges and cannot be overridden by users.

### Directory Structure

```
~/.claude/                          # Global user configuration
├── settings.json                   # User settings, permissions, plugins
├── .claude.json                    # OAuth, MCP servers, preferences
├── CLAUDE.md                       # Global instructions for all projects
├── agents/                         # Global custom subagents
├── skills/                         # Global custom skills
├── commands/                       # Global custom commands (legacy)
└── plans/                          # Plan files storage

.claude/                            # Project-level configuration
├── settings.json                   # Team-shared project settings
├── settings.local.json             # Personal project settings (gitignored)
├── CLAUDE.md                       # Project-level instructions
├── CLAUDE.local.md                 # Personal project instructions (gitignored)
├── agents/                         # Project-specific subagents
├── skills/                         # Project-specific skills
└── commands/                       # Project-specific commands
```

---

## 7. Plugin Components Overview

A Claude Code plugin like bkit consists of these components:

| Component | Purpose | Location |
|-----------|---------|----------|
| **Agents** | Specialized AI subagents for task delegation | `agents/` |
| **Skills** | Knowledge and instructions Claude follows | `skills/<name>/SKILL.md` |
| **Commands** | User-invocable slash commands | `commands/` |
| **Hooks** | Event-triggered scripts/prompts | `hooks/` |
| **Templates** | Document templates for standardization | `templates/` |
| **Scripts** | Helper scripts for automation | `scripts/` |

### bkit Plugin Structure Example (v2.1.1 - Claude Code Exclusive)

```
bkit-claude-code/
├── .claude-plugin/
│   ├── plugin.json                 # Claude Code plugin metadata
│   └── marketplace.json            # Marketplace registration
├── agents/                         # AI subagents (34 total, with memory)
│   ├── starter-guide.md            # Beginner-friendly agent
│   ├── enterprise-expert.md        # Enterprise architecture agent
│   ├── code-analyzer.md            # Code review agent
│   ├── cto-lead.md                 # CTO Team lead (orchestrator)
│   ├── frontend-architect.md       # Frontend architecture expert
│   ├── product-manager.md          # Requirements & feature prioritization
│   ├── qa-strategist.md            # QA strategy coordinator
│   ├── security-architect.md       # Security & vulnerability expert
│   └── ... (34 total, including CTO/PM/QA/Sprint Team agents; 6 deprecated pdca-eval-* registry-tombstoned per ADR 0014)
├── skills/                         # Domain knowledge (44 skills)
│   ├── bkit-rules/SKILL.md         # Core PDCA rules
│   ├── plan-plus/SKILL.md          # Brainstorming-enhanced planning (v1.5.5)
│   ├── development-pipeline/SKILL.md
│   └── phase-*/SKILL.md            # 9-phase pipeline skills
├── commands/
│   └── *.md                        # Claude Code commands
├── hooks/
│   ├── hooks.json                  # Claude Code hook configuration (21 events)
│   └── session-start.js            # Session initialization (Node.js)
├── scripts/                        # Hook execution scripts (64 scripts — v2.1.11 additions: check-trust-score-reconcile, check-quality-gates-m1-m10, release-plugin-tag.sh)
│   └── *.js
├── output-styles/                  # Level-based response formatting (v1.5.3)
│   ├── bkit-learning.md            # Starter level style
│   ├── bkit-pdca-guide.md          # Dynamic level style
│   ├── bkit-enterprise.md          # Enterprise level style
│   └── bkit-pdca-enterprise.md     # Enterprise PDCA style (v1.5.3)
├── lib/
│   ├── common.js                   # Migration Bridge (v1.5.3)
│   ├── core/                       # Core utilities (7 files)
│   ├── pdca/                       # PDCA management (6 files)
│   ├── intent/                     # Intent analysis (4 files)
│   ├── task/                       # Task management (5 files)
│   └── team/                       # CTO-Led Agent Teams (9 files, v1.5.3)
└── templates/                      # Document templates (28 templates)
    ├── plan.template.md
    ├── plan-plus.template.md       # Brainstorming-enhanced plan (v1.5.5)
    └── design.template.md
```

> **v1.5.3**: All plugin components (skills, agents, scripts, lib, templates, output-styles) work exclusively with Claude Code.

> **Note — `/plugin` Skills count**: Claude Code's `/plugin` details pane counts Skills as `skills/` + `commands/` entries (same-name entries dedup). bkit ships 44 skills + `commands/output-style-setup.md` → the pane displays **45** — expected, not a drift.

---

## 8. Customizing Agents

Agents are specialized AI subagents that Claude spawns to delegate specific tasks.

### Agent File Format

Create a markdown file with YAML frontmatter in `agents/` or `.claude/agents/`:

```markdown
---
name: your-agent-name
description: |
  Brief description of what this agent does.

  Use proactively when [trigger conditions].

  Triggers: keyword1, keyword2, 한국어, 日本語

  Do NOT use for: [exclusion conditions]
permissionMode: acceptEdits  # or bypassPermissions, default
model: sonnet                # or opus, haiku, fable
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - WebSearch
skills:
  - skill-name               # Skills this agent can access
---

# Agent Title

## Role

Describe the agent's primary role and responsibilities.

## Communication Style

Define how the agent should communicate.

## Task Guidelines

Provide specific instructions for handling tasks.
```

### Key Frontmatter Fields

| Field | Description |
|-------|-------------|
| `name` | Unique identifier (kebab-case) |
| `description` | Multi-line description with triggers and exclusions |
| `permissionMode` | `default`, `acceptEdits`, `bypassPermissions` |
| `model` | `sonnet` (default), `opus`, `haiku`, `fable` (requires Claude Code ≥ v2.1.170) |
| `tools` | List of allowed tools |
| `skills` | List of skills the agent can reference |

> **Model selection footguns**:
> - The `CLAUDE_CODE_SUBAGENT_MODEL` environment variable overrides ALL frontmatter `model:` pins — every subagent runs on that model while it is set.
> - Enterprise `availableModels` policy exclusions do not error: an excluded model silently falls back to inherit (the agent runs on the main conversation model).

### Customization Example: Creating an Organization-Specific Agent

**Original bkit agent** (`agents/starter-guide.md`):
```markdown
---
name: starter-guide
description: |
  Friendly guide agent for non-developers and beginners.
  ...
---
```

**Customized for your organization** (`.claude/agents/onboarding-guide.md`):
```markdown
---
name: onboarding-guide
description: |
  ACME Corp onboarding guide for new developers.
  Explains company-specific conventions, tools, and workflows.

  Use proactively when user mentions "new hire", "onboarding",
  "how do we", "company standards", or asks about internal tools.

  Triggers: onboarding, new hire, company policy, internal tools

  Do NOT use for: general programming questions, external projects
permissionMode: acceptEdits
model: sonnet
tools:
  - Read
  - Glob
  - Grep
  - WebFetch
skills:
  - company-conventions
  - internal-apis
---

# ACME Corp Onboarding Guide

## Role

Help new developers understand ACME Corp's development practices.

## Key Topics

### 1. Repository Structure
- All projects use monorepo structure
- Frontend code lives in `packages/web/`
- Backend code lives in `packages/api/`

### 2. Code Review Process
- All PRs require 2 approvals
- Use conventional commits
- Run `npm run lint` before pushing

### 3. Internal Tools
- Deployment: Use `/deploy staging` or `/deploy production`
- Monitoring: Access Grafana at internal.acme.com/grafana
```

---

## 9. Customizing Skills

Skills are knowledge bases that Claude automatically loads when relevant.

### Skill File Structure

```
skills/
└── your-skill/
    ├── SKILL.md                # Required: Main skill definition
    ├── reference.md            # Optional: Additional documentation
    ├── examples/               # Optional: Example files
    └── scripts/                # Optional: Helper scripts
```

### SKILL.md Format

```markdown
---
name: your-skill
description: |
  What this skill does and when Claude should use it.
  Be specific about trigger conditions.

  Triggers: keyword1, keyword2

  Do NOT use for: exclusion conditions
user-invocable: true           # Show in /slash menu
disable-model-invocation: false # Allow Claude to auto-invoke
allowed-tools: Read, Grep, Glob # Restrict available tools
hooks:                         # Skill-specific hooks
  PreToolUse:
    - matcher: "Write"
      hooks:
        - type: command
          command: "node \"${CLAUDE_PLUGIN_ROOT}/scripts/validate.js\""
---

# Skill Content

Detailed instructions Claude follows when this skill is active.
```

### Frontmatter Reference

| Field | Default | Description |
|-------|---------|-------------|
| `name` | Directory name | Display name and /command |
| `description` | First paragraph | When to use (Claude reads this) |
| `user-invocable` | `true` | Show in /slash menu |
| `disable-model-invocation` | `false` | Prevent auto-loading |
| `allowed-tools` | All | Comma-separated tool list |
| `context` | - | Set to `fork` for subagent |
| `agent` | - | `Explore`, `Plan`, `general-purpose` |
| `model` | - | Override model for this skill |

### Invocation Control Matrix

| Configuration | User Can Invoke | Claude Can Invoke | Use Case |
|---------------|-----------------|-------------------|----------|
| Default | Yes | Yes | Knowledge, guidelines |
| `disable-model-invocation: true` | Yes | No | Workflows with side effects |
| `user-invocable: false` | No | Yes | Background context |

### Customization Example: Company Coding Standards

**Create** `.claude/skills/company-standards/SKILL.md`:

```markdown
---
name: company-standards
description: |
  ACME Corp coding standards and conventions.
  Applied automatically when writing or reviewing code.

  Triggers: code style, naming convention, lint, formatting
---

# ACME Corp Coding Standards

## Naming Conventions

### Files
- React components: PascalCase (`UserProfile.tsx`)
- Utilities: camelCase (`formatDate.ts`)
- Constants: SCREAMING_SNAKE_CASE in `.constants.ts` files

### Variables
- Boolean: prefix with `is`, `has`, `should`
- Arrays: use plural nouns (`users`, `items`)
- Functions: use verbs (`getUser`, `handleSubmit`)

## Code Structure

### React Components
```tsx
// 1. Imports (external → internal → types → styles)
import React from 'react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui';
import { formatDate } from '@/utils';

import type { User } from '@/types';
import styles from './UserProfile.module.css';

// 2. Types/Interfaces
interface UserProfileProps {
  userId: string;
}

// 3. Component
export function UserProfile({ userId }: UserProfileProps) {
  // hooks first
  // handlers second
  // render last
}
```

## Error Handling

Always use our custom error classes:
```typescript
import { ApiError, ValidationError } from '@/errors';

throw new ApiError('User not found', 404);
throw new ValidationError('Invalid email format');
```

## Git Commit Messages

Follow Conventional Commits:
```
<type>(<scope>): <description>

Types: feat, fix, docs, style, refactor, test, chore
Scope: component name or feature area

Example: feat(auth): add OAuth2 login support
```
```

---

## 10. Customizing Commands

Commands are user-invoked slash commands (e.g., `/deploy`, `/review`).

### Command File Format

Create `.md` files in `commands/` or `.claude/commands/`:

```markdown
---
description: Short description shown in /slash menu
allowed-tools: ["Read", "Write", "Bash"]
argument-hint: [environment] [options]
---

# Command Instructions

Detailed instructions for Claude when this command is invoked.

## Arguments

- `$ARGUMENTS`: All arguments passed to the command
- `$1`, `$2`: Individual arguments

## Tasks Performed

1. Step one
2. Step two
3. Step three

## Usage Examples

```
/your-command staging
/your-command production --force
```
```

### Dynamic Context with Shell Commands

Use `` !`command` `` syntax to inject dynamic content:

```markdown
---
description: Create PR with context
allowed-tools: ["Bash"]
---

## Current Context
- Branch: !`git branch --show-current`
- Changes: !`git diff --stat`
- Recent commits: !`git log -3 --oneline`

Create a pull request based on the above context.
```

### Customization Example: Deployment Command

**Create** `.claude/commands/deploy.md`:

```markdown
---
description: Deploy application to specified environment
allowed-tools: ["Bash", "Read"]
argument-hint: [staging|production]
disable-model-invocation: true
---

# Deployment Command

Deploy the application to the specified environment.

## Environment Validation

Valid environments: `staging`, `production`

If `$ARGUMENTS` is empty or invalid, ask the user to specify.

## Pre-deployment Checks

Before deploying, verify:
1. All tests pass: `npm run test`
2. Build succeeds: `npm run build`
3. No uncommitted changes: `git status`

## Deployment Steps

### For Staging
```bash
npm run deploy:staging
```

### For Production
```bash
# Require explicit confirmation
npm run deploy:production
```

## Post-deployment

1. Verify deployment: `curl https://$ARGUMENTS.acme.com/health`
2. Notify team in Slack (if configured)
3. Update deployment log

## Output Format

```
🚀 Deployment Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Environment: $ARGUMENTS
Version: [version]
Time: [timestamp]
Status: ✅ Success

📋 Checklist:
☑ Tests passed
☑ Build completed
☑ Deployed successfully
☑ Health check passed

🔗 URL: https://$ARGUMENTS.acme.com
```
```

---

## 11. Customizing Hooks

Hooks are event-triggered callbacks that run at specific points in Claude's lifecycle.

### Hook Events

| Event | When It Fires |
|-------|---------------|
| `PreToolUse` | Before a tool is called |
| `PostToolUse` | After a tool completes |
| `Stop` | When Claude finishes responding |
| `SubagentStop` | When a subagent completes |
| `SessionStart` | When a new session begins |
| `SessionEnd` | When a session ends |
| `UserPromptSubmit` | Before user prompt is processed |
| `PreCompact` | Before context compaction |
| `Notification` | When a notification is shown |

### hooks.json Format

Create `hooks/hooks.json`. Every event maps to an **array of blocks**; each block
carries an optional `matcher` and a list of handlers.

```json
{
  "$schema": "https://json.schemastore.org/claude-code-hooks.json",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/validate-bash.js\"",
            "timeout": 5
          }
        ]
      },
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/lint.js\"",
            "timeout": 5,
            "if": "Write(src/**/*.ts)"
          },
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/lint.js\"",
            "timeout": 5,
            "if": "Edit(src/**/*.ts)"
          }
        ]
      }
    ]
  }
}
```

### Four rules that silently break hooks

Each of these cost bkit a shipped release. They fail quietly — the hook is
registered, counted, and never runs — so they are worth knowing before you write
your own.

| Rule | Why |
|---|---|
| **`timeout` is in SECONDS** | Not milliseconds. `"timeout": 5000` is 83 minutes, so a hung hook has no effective cancellation. Claude Code's default is 600. Verified: a 5-second hook survives `"timeout": 30` and is killed at 2.26s under `"timeout": 2`. |
| **`if` holds exactly ONE permission rule** | There is no `\|` alternation, no `&&`, no list. `"if": "Write\|Edit(src/**)"` matches nothing and the handler never runs. Declare one handler per tool, as above. |
| **`if` only works on tool events** | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`. On any other event, a handler that declares `if` never runs at all. |
| **`once` is ignored here** | It is honoured only for hooks declared in skill frontmatter. In a plugin's `hooks.json` it promises a guarantee the host never makes — confirmed by resuming a session and watching the hook fire again. |

Also worth knowing: `matcher` means different things per event. On tool events it
filters by tool name; on `FileChanged` it names literal files to watch (letters,
digits, `_`, `|` only — no path globs); on `PreCompact` it is `auto|manual`.
Several events accept no matcher at all.

### Hook Types

#### Command Hooks
Execute scripts (Node.js recommended for cross-platform):
```json
{
  "type": "command",
  "command": "node /path/to/script.js",
  "timeout": 5
}
```

#### Prompt Hooks
Inject instructions into Claude's context:
```json
{
  "type": "prompt",
  "prompt": "Remember to follow our security guidelines when handling user data."
}
```

### Environment Variables in Hooks

| Variable | Description |
|----------|-------------|
| `${CLAUDE_PLUGIN_ROOT}` | Plugin installation directory |
| `${CLAUDE_PROJECT_DIR}` | The user's project directory, even when the hook process starts elsewhere |
| `$CLAUDE_CODE_SESSION_ID` | Current session ID. Note the `CODE_` — bkit read `$CLAUDE_SESSION_ID` for several releases, which Claude Code never sets, so the feature depending on it never applied (issue #119). |

Hook input arrives as **JSON on stdin**, not as environment variables. Read it
with a bounded reader: `fs.readFileSync(0)` blocks until EOF with no timeout, and
Claude Code can hold the write-end open well past your hook's own deadline
(issue #139). bkit's `lib/core/io.js` `readStdinSync` is a worked example.

### Verifying your hook actually fires

A hook that is registered but never dispatched looks identical to one that
works. bkit records every dispatch it receives into
`.bkit/runtime/hook-dispatch.ndjson`, so you can check directly:

```bash
cat .bkit/runtime/hook-dispatch.ndjson | jq -r '.event' | sort | uniq -c
```

Set `BKIT_HOOK_DISPATCH_RECORD=0` to disable the recording (roughly 0.7 ms per
hook fire). If a bkit hook crashes, the next session start reports it in the
Preflight section rather than staying silent.

### Customization Example: Pre-commit Validation

**Create** `.claude/hooks/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/pre-commit.js",
            "timeout": 10,
            "if": "Bash(git commit *)"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/format.js",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**Create** `.claude/hooks/pre-commit.js`:

```javascript
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Validate before committing
console.error("Running pre-commit checks...");

// Helper to check file contents
function checkFiles(pattern, extensions) {
  const srcDir = path.join(process.cwd(), 'src');
  if (!fs.existsSync(srcDir)) return false;

  function walk(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        if (walk(filePath)) return true;
      } else if (extensions.some(ext => file.endsWith(ext))) {
        const content = fs.readFileSync(filePath, 'utf8');
        if (pattern.test(content)) return true;
      }
    }
    return false;
  }
  return walk(srcDir);
}

// Check for sensitive data
if (checkFiles(/API_KEY|SECRET|PASSWORD/, ['.ts', '.js'])) {
  console.log(JSON.stringify({
    decision: "block",
    reason: "Potential sensitive data detected. Please review before committing."
  }));
  process.exit(0);
}

// Check for console.log
if (checkFiles(/console\.log/, ['.ts', '.tsx'])) {
  console.log(JSON.stringify({
    decision: "block",
    reason: "console.log statements found. Remove before committing."
  }));
  process.exit(0);
}

// All checks passed — say nothing and let the tool proceed.
//
// v2.1.33 (ENH-397): this example previously printed `{"decision":"allow"}`.
// PreToolUse has no `"allow"` decision; only `"block"` is meaningful, and an
// unrecognized value is ignored. Copying that line gave the impression of an
// explicit approval that never existed. To permit a call, emit nothing (or an
// empty object) and exit 0. See code.claude.com/docs/en/hooks.md.
process.exit(0);
```

---

## 12. Creating Templates

Templates standardize document creation across your organization.

### Template Location

```
templates/
├── plan.template.md
├── design.template.md
├── analysis.template.md
└── report.template.md
```

### Template Variables

| Variable | Description |
|----------|-------------|
| `{feature}` | Feature name from arguments |
| `{date}` | Current date |
| `{author}` | Author name |
| `{project}` | Project name |

### Template Example

**Create** `templates/feature-spec.template.md`:

```markdown
# Feature Specification: {feature}

**Author**: {author}
**Date**: {date}
**Status**: Draft

---

## 1. Overview

### 1.1 Problem Statement
<!-- What problem does this feature solve? -->

### 1.2 Proposed Solution
<!-- High-level description of the solution -->

### 1.3 Success Criteria
<!-- How do we measure success? -->

---

## 2. Requirements

### 2.1 Functional Requirements
| ID | Requirement | Priority |
|----|-------------|----------|
| FR-001 | | High |
| FR-002 | | Medium |

### 2.2 Non-Functional Requirements
| ID | Requirement | Target |
|----|-------------|--------|
| NFR-001 | Performance | < 200ms response |
| NFR-002 | Availability | 99.9% uptime |

---

## 3. Technical Design

### 3.1 Architecture
<!-- Describe the architecture -->

### 3.2 API Design
<!-- API endpoints, request/response formats -->

### 3.3 Data Model
<!-- Database schema, data structures -->

---

## 4. Implementation Plan

### 4.1 Phases
| Phase | Description | Duration |
|-------|-------------|----------|
| 1 | | |
| 2 | | |

### 4.2 Dependencies
<!-- External dependencies, blockers -->

---

## 5. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| | High | Medium | |

---

## Appendix

### A. References
<!-- Links to related documents -->

### B. Glossary
<!-- Technical terms and definitions -->
```

---

## 13. Organization-Specific Customization

### Step-by-Step: Forking bkit for Your Organization

#### Step 1: Create Your Plugin Structure

```bash
# Create your organization's plugin directory
mkdir -p my-org-plugin/{agents,skills,commands,hooks,templates,scripts}
cd my-org-plugin

# Initialize plugin.json
cat > .claude-plugin/plugin.json << 'EOF'
{
  "name": "my-org-kit",
  "version": "1.0.0",
  "description": "My Organization's Claude Code Plugin",
  "author": {
    "name": "My Organization",
    "email": "dev@myorg.com"
  }
}
EOF
```

#### Step 2: Copy and Customize Components

```bash
# Copy bkit components you want to customize
cp -r ~/.claude/plugins/bkit/agents/starter-guide.md agents/team-guide.md
cp -r ~/.claude/plugins/bkit/skills/bkit-rules skills/org-rules

# Edit to match your organization's needs
```

#### Step 3: Create Organization-Specific Components

**agents/team-lead.md**:
```markdown
---
name: team-lead
description: |
  Senior developer guidance for architecture decisions.
  Use when discussing system design, code reviews, or mentoring.
permissionMode: acceptEdits
model: fable  # verification/orchestration tier — requires Claude Code >= v2.1.170
tools: [Read, Grep, Glob, WebSearch]
---

# Team Lead Agent

## Role
Provide senior-level guidance on architecture and best practices.

## Responsibilities
1. Review architectural decisions
2. Suggest design patterns
3. Identify potential issues early
4. Mentor on best practices
```

#### Step 4: Configure hooks.json

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/init.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Ensure TypeScript strict mode compliance.",
            "if": "Write(src/**/*.ts)"
          },
          {
            "type": "prompt",
            "prompt": "Ensure TypeScript strict mode compliance.",
            "if": "Edit(src/**/*.ts)"
          }
        ]
      }
    ]
  }
}
```

#### Step 5: Register as Private Marketplace

In your project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "my-org": {
      "source": {
        "source": "github",
        "repo": "my-org/claude-plugins"
      }
    }
  },
  "enabledPlugins": {
    "my-org-kit@my-org": true
  }
}
```

> **Key aliases (Claude Code v2.1.232+)**: `additionalMarketplaces` is accepted as
> an alias for `extraKnownMarketplaces`, and `allowedMarketplaces` for
> `strictKnownMarketplaces`. The canonical names above work on every supported
> version and are what this guide uses. Do not set both spellings of the same key
> in one file — Claude Code's own note on the alias says so explicitly, and two
> names for one setting is how a value gets edited in the place that is not being
> read.

### Enterprise Deployment via Managed Settings

For organization-wide deployment, IT administrators can use managed settings:

**macOS**: `/Library/Application Support/ClaudeCode/managed-settings.json`
**Linux**: `/etc/claude-code/managed-settings.json`
**Windows**: `C:\Program Files\ClaudeCode\managed-settings.json`

```json
{
  "strictKnownMarketplaces": ["my-org"],
  "enabledPlugins": {
    "my-org-kit@my-org": true
  },
  "extraKnownMarketplaces": {
    "my-org": {
      "source": {
        "source": "github",
        "repo": "my-org/claude-plugins"
      }
    }
  }
}
```

---

## 14. Best Practices

### Agent Design

1. **Single Responsibility**: Each agent should have one clear purpose
2. **Clear Triggers**: Define explicit trigger conditions in descriptions
3. **Tool Restrictions**: Only include tools the agent actually needs
4. **Multilingual Support**: Include trigger keywords in multiple languages

### Skill Design

1. **Keep SKILL.md Under 500 Lines**: Use supporting files for details
2. **Specific Descriptions**: Help Claude understand when to apply
3. **Use Hooks Sparingly**: Only for critical validation/enforcement

### Command Design

1. **Clear Naming**: Use verbs (`deploy`, `review`, `create`)
2. **Argument Hints**: Provide helpful autocomplete hints
3. **Safe Defaults**: Require confirmation for destructive operations
4. **Informative Output**: Show clear success/failure feedback

### Hook Design

1. **Fast Execution**: Keep hooks under 5 seconds
2. **Silent Success**: Only output on failure/warning
3. **Graceful Degradation**: Don't block if hook fails unexpectedly

### Security Considerations

1. **Never Commit Secrets**: Use environment variables
2. **Validate External Input**: Sanitize command arguments
3. **Restrict Permissions**: Use minimal required tool access
4. **Audit Hooks**: Review all hook scripts for security

---

## Quick Reference

### File Locations Cheatsheet

| Component | Global | Project |
|-----------|--------|---------|
| Settings | `~/.claude/settings.json` | `.claude/settings.json` |
| Instructions | `~/.claude/CLAUDE.md` | `CLAUDE.md` or `.claude/CLAUDE.md` |
| Agents | `~/.claude/agents/` | `.claude/agents/` |
| Skills | `~/.claude/skills/` | `.claude/skills/` |
| Commands | `~/.claude/commands/` | `.claude/commands/` |
| Hooks | Via plugins | `.claude/hooks/hooks.json` |

### Windows-Specific Notes

```powershell
# Access global settings
Get-Content "$env:USERPROFILE\.claude\settings.json"

# Create project config
New-Item -ItemType Directory -Path ".claude\agents" -Force
New-Item -ItemType Directory -Path ".claude\skills" -Force
```

### Useful Commands

```bash
# List available skills
claude /skills

# Check context usage
claude /context

# View installed plugins
claude /plugins

# Debug hooks
CLAUDE_CODE_DEBUG=hooks claude
```

---

## Resources

- [Claude Code Official Documentation](https://code.claude.com/docs/en/settings)
- [Claude Code Skills Guide](https://code.claude.com/docs/en/skills)
- [Agent Skills Open Standard](https://agentskills.io)
- [bkit GitHub Repository](https://github.com/ww-w-ai/bkit-claude-code)

---

## License & Attribution

### bkit License

bkit is licensed under the **Apache License 2.0**. This means you can:

- **Use** bkit freely in personal and commercial projects
- **Modify** bkit to fit your organization's needs
- **Distribute** your customized versions
- **Sublicense** derivative works under different terms

### Attribution Requirements

When creating derivative works based on bkit, you **must**:

1. **Include the original LICENSE file** or reference to Apache 2.0
2. **Include the NOTICE file** with original attribution
3. **Mark modified files** with prominent notices stating you changed them
4. **Retain copyright notices** from the original source

### NOTICE File Content

When redistributing bkit or derivative works, include:

```
bkit - Vibecoding Kit
Copyright 2024-2026 DubDubDub Corp.

This product includes software developed by DubDubDub Corp.
https://github.com/ww-w-ai/bkit-claude-code

Licensed under the Apache License, Version 2.0
```

### Example Attribution for Derivative Plugins

If you create a plugin based on bkit (e.g., "acme-dev-kit"), add to your `plugin.json`:

```json
{
  "name": "acme-dev-kit",
  "version": "1.0.0",
  "description": "ACME Corp's development kit based on bkit",
  "author": {
    "name": "ACME Corporation",
    "email": "dev@acme.com"
  },
  "license": "Apache-2.0",
  "attribution": {
    "basedOn": "bkit Vibecoding Kit",
    "originalAuthor": "DubDubDub Corp.",
    "originalRepository": "https://github.com/ww-w-ai/bkit-claude-code"
  }
}
```

And include a `NOTICE` file in your plugin root:

```
ACME Dev Kit
Copyright 2026 ACME Corporation

This product is based on bkit Vibecoding Kit.
Original work Copyright 2024-2026 DubDubDub Corp.
https://github.com/ww-w-ai/bkit-claude-code

Licensed under the Apache License, Version 2.0
http://www.apache.org/licenses/LICENSE-2.0
```

### What You Don't Need to Do

- You don't need to open-source your modifications
- You don't need to use the same license for your additions
- You don't need permission to use bkit commercially

For full license terms, see the [LICENSE](LICENSE) file.

---

## Resources

- [Claude Code Official Documentation](https://code.claude.com/docs/en/settings)
- [Claude Code Skills Guide](https://code.claude.com/docs/en/skills)
- [Agent Skills Open Standard](https://agentskills.io)
- [bkit GitHub Repository](https://github.com/ww-w-ai/bkit-claude-code)

---

*This guide is part of the bkit Vibecoding Kit. For questions or contributions, visit our [GitHub repository](https://github.com/ww-w-ai/bkit-claude-code).*
