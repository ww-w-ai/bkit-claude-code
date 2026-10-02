---
template: plan
version: 1.3
feature: registry-lockdown
date: 2026-09-07
author: dizzybeaver (operator directive) / Claude Code
project: bkit-claude-code
version: 2.1.38
status: Draft
language: en (primary; Korean sibling: registry-lockdown.plan.ko.md — kept
  unsuffixed so findPlanDoc's default docPaths resolve; see Impact Analysis 6.1)
---

# registry-lockdown Planning Document

> **Summary**: Brokered PDCA registry — skill-fire-driven phase advancement for every
> bkit workflow, MCP-only disclosure, automated archive, and a portable JS state guard
> that never blocks documentation files.
>
> **Project**: bkit-claude-code
> **Version**: 2.1.38
> **Author**: dizzybeaver (operator directive 2026-09-07 22:13 EDT) / Claude Code
> **Date**: 2026-09-07
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | Agents hand-edit `.bkit/state/pdca-status.json` (or attempt to), then skip phases and ignore skill steps. The only enforcement was a machine-local Python guard pointing at a broker binary removed with a deprecated plugin — a deadlock, not a control. The registry can lie about phase state, and no portable sanctioned path exists to advance or read it. |
| **Solution** | Complete the brokered write path inside bkit itself: fire-driven advancement for every router action including archive (wiring the existing `lib/pdca/lifecycle.js` `archiveFeature`), make the MCP server the disclosure surface for state reads, and ship a JS port of the pdca-guard as a bkit hook with explicit `.txt`/`.md` exemptions. |
| **Function/UX Effect** | Phase state advances only through skill fires; agents query status through the `bkit_pdca_status` MCP tool instead of reading the file; archive is a single command with zero hand edits; creating documentation never trips the guard. |
| **Core Value** | The PDCA registry becomes trustworthy by construction — single writer, verified readers, no agent hand edits, no environment-specific deadlocks. |

---

## Context Anchor

> Auto-generated from Executive Summary. Propagates to Design/Do documents for context continuity.

| Key | Value |
|-----|-------|
| **WHY** | Hand-edited phase state enabled phase-skipping and unverified work; the machine-level guard deadlocked sanctioned work instead of protecting it. |
| **WHO** | bkit users (agents and operators) running PDCA / Sprint / Pipeline cycles on any install, plus environments with local state guards. |
| **RISK** | An over-broad guard re-creates the original deadlock (blocking legitimate doc writes); silent regressions in phase gating (requireDocs, TaskCompleted auto-advance). |
| **SUCCESS** | A full PDCA cycle reaches `archived` with zero manual registry writes; the guard blocks real state writes while allowing `.txt`/`.md` creation; full suite green (0 FAIL). |
| **SCOPE** | Four modules: (1) advancement generalization, (2) MCP disclosure, (3) automated archive, (4) guard port + exemptions. |

---

## 1. Overview

### 1.1 Purpose

Make `.bkit/state/pdca-status.json` a true broker-owned registry: agents advance it only
by firing skills, read it only through the MCP server, and cannot hand-edit it — while
documentation work (`.md`, `.txt`) remains untouched by enforcement.

### 1.2 Background

Field evidence (`work/pdca-skill-fire-test-results.md`, 2026-09-07): three real skill
fires were detected by the hook layer yet persisted nothing, because
`runSkillInvocationEffects` gated the phase write on static frontmatter the `pdca`
router declares `null` by design. Fixed for `pm|plan|design|do|qa|report` + aliases
(`analyze→check`, `iterate→act`) in commits `ef8e30c` and the follow-up alias extension
(working tree). The operator additionally reports the inverse failure mode in other
sessions: agents hand-update the registry and then skip phases — hence this feature
locks the registry down portably, inside bkit, instead of relying on machine-local
guards that reference removed brokers.

### 1.3 Related Documents

- Field report: `work/pdca-skill-fire-test-results.md`
- Korean sibling: `docs/01-plan/features/registry-lockdown.plan.ko.md`
- Reference guard (Python, machine-local): `~/.claude/hooks/pdca-guard`
- Prior art in-repo: `lib/control/destructive-detector.js` (G-019), `scripts/gap-detector-stop.js`, `scripts/pdca-task-completed.js`

---

## 2. Scope

### 2.1 In Scope

- [ ] FR-01 Router phase advancement generalized to all bkit workflows (pdca complete; sprint/pipeline mapped or explicitly bounded)
- [ ] FR-02 Automated archive: `/pdca archive` performs its registry write via `lifecycle.archiveFeature` through a sanctioned invocation path — no hand edit
- [ ] FR-03 Archive parity for sprint (and pipeline where applicable) or a documented boundary
- [ ] FR-04 MCP disclosure: PDCA state reads via the `bkit_pdca_status` MCP tool; skill text instructs MCP-first reads
- [ ] FR-05 Guard port: JS port of the Python pdca-guard wired into bkit's hooks, blocking agent writes to `.bkit/state/pdca-status.json`
- [ ] FR-06 Guard exemptions: `.txt`/`.md` targets never blocked; fix the bare-`>` false-positive class (stderr `2>` redirects) found in G-019 live testing
- [ ] FR-07 True tests for every FR (each fails when its feature is broken)
- [ ] FR-08 CHANGELOG entry per CONTRIBUTING.md (version number left to maintainer)

### 2.2 Out of Scope

- Making the MCP server writable (phase writes stay hook-driven by design)
- Retrofitting legacy `.bkit-memory.json` paths (deprecated since v1.6.0)
- Removing the machine-local `~/.claude/hooks` enforcement layer (operator's domain)
- Translating existing single-language docs (new-files-only bilingual rule)

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-01 | Every phase-advancing action of every bkit router skill (pdca, sprint, pipeline) writes the registry at fire time via `runSkillInvocationEffects`; no router action requires a manual registry write | High | Partial (pdca: pm/plan/design/do/qa/report + analyze/iterate aliases landed) |
| FR-02 | `/pdca archive {feature}` completes verification, then invokes `lib/pdca/lifecycle.js` `archiveFeature` (or `archiveFeatureToSummary` with `--summary`) through a sanctioned script/tool path; steps 7–8 of the archive action become verification-only | High | Pending |
| FR-03 | Sprint archive reaches the same no-hand-edit bar, or the boundary is documented in the skill with rationale | Medium | Pending |
| FR-04 | Agents read PDCA state via the `bkit_pdca_status` MCP tool; `/pdca status` skill steps instruct MCP-first reads with file-read as fallback when MCP is unavailable | High | Pending (tool exists; skill text still says read the file) |
| FR-05 | A JS guard hook (PreToolUse on Write/Edit/Bash) denies agent-originated writes to `.bkit/state/pdca-status.json` with a message directing to the skill-fire path; bkit-internal writers (`state-store`, lib modules) are unaffected | High | Pending |
| FR-06 | The guard never denies Write/Edit whose target ends in `.txt` or `.md` (or any docs/ path), and Bash rule patterns do not match stderr/stdout redirection forms (`2>`, `&>`) as write verbs | High | Pending |
| FR-07 | Unit + integration tests per FR, mutation-verified (RED on breakage, GREEN after) | High | Pending |
| FR-08 | CHANGELOG.md entry follows CONTRIBUTING.md; no version bump (maintainer-owned) | Medium | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement Method |
|----------|----------|-------------------|
| Performance | New/changed hooks stay within the 5s PreToolUse timeout budget | Hook timing in integration tests |
| Security | Guard is fail-closed for state-file writes, fail-open for everything else; `critical` severity never suppressed by permission mode | Unit tests + v2.1.37 permission-mode policy tests |
| Compatibility | No public API changes to `updatePdcaStatus`/`archiveFeature`; hooks.json additions only, no removals | Existing suite (5,355 TC) green |
| Portability | Guard ships inside bkit (works on any install); no reference to machine-local paths | Code review + grep for `~/.claude` in shipped files |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] All functional requirements implemented
- [ ] Unit tests written and passing
- [ ] Full suite green (`node test/run-all.js`, 0 FAIL)
- [ ] Documentation updated (SKILL.md steps, MCP tool docs, CHANGELOG)

### 4.2 Quality Criteria

- [ ] A complete simulated cycle (fire plan → … → fire archive) advances the registry with zero manual writes, verified by test
- [ ] Guard test proves a `.md` Write to a docs path is allowed while a state-file Write is denied in the same suite
- [ ] Zero lint errors; no new linting suppressions

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Guard overreach re-creates the doc-block deadlock | High | Medium | Exemption list (`txt`, `md`, `docs/` paths) is checked FIRST, before any state-token matching; dedicated tests assert doc writes pass |
| Redirect-form false positives (G-019 `>>?` matching `2>`) silence legitimate commands | Medium | High (observed live) | Require `>` to be a stdout-redirect form not preceded by a digit or `&`; mutation test with `grep … .bkit/state … 2>/dev/null` |
| Sprint state store differs (separate index files) — aliasing breaks | Medium | Medium | Sprint writes route through the sprint SSoT adapter, not the pdca map; FR-03 allows a documented boundary if parity is out of reach |
| Archive automation moves docs irreversibly before verification | High | Low | Script refuses unless phase gate passes (completed/matchRate ≥ 90); verification precedes any file move; `--dry-run` default |
| Double-write when both slash and Skill-tool paths fire | Low | Medium | Existing I-10 dedupe key already covers cross-path duplication (verified by unit test 5) |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change Description |
|----------|------|--------------------|
| `lib/orchestrator/skill-invocation-effects.js` | Lib module | Router alias map + archive orchestration hook point |
| `lib/pdca/lifecycle.js` | Lib module | `archiveFeature` gains a CLI-reachable wrapper (no signature change) |
| `scripts/` (new adapter) | Hook script | Archive invocation path + guard adapter |
| `hooks/hooks.json` | Config | Additional PreToolUse entries for the guard |
| `servers/bkit-pdca-server/index.js` | MCP server | Docs-only for `bkit_pdca_status` (tool exists; no new write tools) |
| `skills/pdca/SKILL.md` | Skill contract | Registry steps become verify-only (8 steps already rewritten in tree); archive + status sections updated |
| `lib/control/destructive-detector.js` | Lib module | G-019 pattern fix: redirect forms excluded from `>>?` alternation |

### 6.2 Current Consumers

| Resource | Operation | Code Path | Impact |
|----------|-----------|-----------|--------|
| `runSkillInvocationEffects` | EXECUTE | `scripts/skill-post.js`, `scripts/user-prompt-expansion-handler.js` | Additive (new alias branch); existing paths unchanged |
| `updatePdcaStatus` | CALL | gap-detector-stop, iterator-stop, pre-write, lifecycle, batch-orchestrator, full-auto-do | None (no signature change) |
| `archiveFeature` | CALL | none today (unwired) | New single consumer (sanctioned archive path) |
| `hooks.json` PreToolUse | LOAD | CC host (all sessions) | Additive entries; contract test asserts timeout/matcher invariants |
| `bkit_pdca_status` | READ | MCP clients | None (read tool unchanged) |
| SKILL.md | PARSE | `check-skills-docs-code-sync.test.js`, `lint-skill-md.js` | Needs verification — sync tests must stay green |

### 6.3 Verification

- [ ] All consumers listed above verified to work with the proposed changes
- [ ] No auth/permission changes break existing operations
- [ ] No field additions/removals break existing queries or mutations

---

## 7. Architecture Considerations

### 7.1 Project Level Selection

| Level | Characteristics | Recommended For | Selected |
|-------|-----------------|-----------------|:--------:|
| Starter | Simple structure | Static sites | ☐ |
| Dynamic | Feature modules, BaaS | Web apps | ☐ |
| **Enterprise (plugin lib)** | Strict layer separation (scripts → lib), 200-module lib tree, contract tests | This repository | ☑ |

### 7.2 Key Architectural Decisions

| Decision | Options | Selected | Rationale |
|----------|---------|----------|-----------|
| Guard placement | New hook script / extend destructive-detector (G-0xx rule) / lib-only check in state-store | Extend destructive-detector + write-path exemption | One rule engine already serves all entry points (Bash + Write/Edit); a separate script duplicates matching logic |
| Archive invocation | New CLI script wrapping lifecycle / MCP write tool / hook on TaskCompleted | CLI script (`--dry-run` default) | Matches repo adapter pattern; MCP stays read-only by design; TaskCompleted cannot carry `--summary` semantics |
| Phase source of truth for routers | Static frontmatter / action-alias map / runtime-guidance SSoT | Alias map reusing `PDCA_ACTION_PHASES` + small alias table | #135 precedent; no duplicated phase tables |
| MCP disclosure | New tools / document existing `bkit_pdca_status` | Document + skill-text guidance | Read tool already exists; agents need instruction, not a second tool |
| Registry read path for `/pdca status` | Direct file read via lib API (current) / MCP-first | MCP-first with lib fallback | Operator directive; lib API remains the fallback and remains the hook-internal path |

### 7.3 Clean Architecture Approach

```
Selected Level: Enterprise (plugin lib tree)

scripts/        → hook adapters (I/O only: stdin → lib → stdout decision)
lib/control/    → guard rules (destructive-detector + new state-guard rule)
lib/pdca/       → registry writers (status-core, lifecycle) — sole writers
lib/orchestrator/ → fire-effect composition (advancement, aliases, archive hook point)
servers/        → read-only MCP disclosure surface
skills/         → contracts (verify-only registry steps, MCP-first reads)
```

---

## 8. Convention Prerequisites

### 8.1 Existing Project Conventions

- [x] `CLAUDE.md` has coding conventions section (project + user-level)
- [x] ESLint configuration (`eslint.config.js`)
- [x] Node-only test runner convention (`node test/<file>` standalone, issue-130 style)
- [ ] Prettier configuration (not used; repo relies on ESLint)

### 8.2 Conventions to Define/Verify

| Category | Current State | To Define | Priority |
|----------|---------------|-----------|:--------:|
| Naming | exists | none | — |
| Folder structure | exists (scripts/lib/servers/skills) | none | — |
| Import order | exists (lib/core/io first pattern) | none | — |
| Error handling | exists (fail-open hooks, fail-closed guards) | Guard follows fail-closed-state / fail-open-docs | High |
| Bilingual docs | exists (new docs/ files paired) | Plan/Design/Analysis/Report as `.md` + `.ko.md` siblings | High |

### 8.3 Environment Variables Needed

None. (No new env vars; guard reads hook stdin only.)

### 8.4 Pipeline Integration

Not applicable — this is a bkit-plugin feature, not a 9-phase pipeline project.

---

## 9. Success Criteria Traceability

| Criterion | FRs | Verification |
|-----------|-----|--------------|
| Zero manual registry writes in a full cycle | FR-01, FR-02, FR-03 | Integration test simulating fire sequence through archive |
| MCP-first reads | FR-04 | Skill-text sync test + MCP tool doc check |
| Guard blocks state, passes docs | FR-05, FR-06 | Unit tests (state write denied; `.md`/`.txt`/docs writes allowed; `2>` command not flagged) |
| Suite green | FR-07 | `node test/run-all.js` → 0 FAIL |
| CHANGELOG per contributing guide | FR-08 | Review vs CONTRIBUTING.md format |

---

## Next Steps

1. `/pdca design registry-lockdown` — select architecture options (guard placement, archive invocation path)
2. `/pdca do registry-lockdown` — implement FR-02…FR-08 (FR-01 pdca side already landed)
3. `/pdca analyze registry-lockdown` — gap analysis against this plan and the design doc
4. `/pdca qa registry-lockdown` — L1–L5 verification
5. `/pdca report registry-lockdown` — completion report
6. `/pdca archive registry-lockdown` — first archive executed by the new automated path (dogfood)

---

## Version History

| Version | Date | Change | Author |
|---------|------|--------|--------|
| 1.0 | 2026-09-07 | Initial plan from operator directive (L4 autonomous run) | Claude Code / dizzybeaver |
