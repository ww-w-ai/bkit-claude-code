---
template: design
version: 1.7
feature: registry-lockdown
date: 2026-09-07
author: dizzybeaver (operator directive) / Claude Code
project: bkit-claude-code
status: Draft
language: en (primary; Korean sibling: registry-lockdown.design.ko.md)
---

# registry-lockdown Design Document

> **Summary**: Fire-driven registry advancement for all router actions, a sanctioned
> archive CLI, MCP-first state disclosure, and a portable guard that never blocks docs.

**Project**: bkit-claude-code · **Version**: 2.1.38 · **Date**: 2026-09-07 · **Status**: Draft

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | Hand-edited phase state enabled phase-skipping and unverified work; the machine-level guard deadlocked sanctioned work instead of protecting it. |
| **WHO** | bkit users (agents and operators) running PDCA / Sprint / Pipeline cycles on any install, plus environments with local state guards. |
| **RISK** | An over-broad guard re-creates the original deadlock (blocking legitimate doc writes); silent regressions in phase gating (requireDocs, TaskCompleted auto-advance). |
| **SUCCESS** | A full PDCA cycle reaches `archived` with zero manual registry writes; the guard blocks real state writes while allowing `.txt`/`.md` creation; full suite green (0 FAIL). |
| **SCOPE** | Four modules: (1) advancement generalization, (2) MCP disclosure, (3) automated archive, (4) guard port + exemptions. |

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | Registry writes and reads happen by agent hand-edits and file reads; enforcement was machine-local and broken |
| **Solution** | Option C: extend the single detector engine (G-020 + G-019 fix), a sanctioned archive CLI on `lifecycle.archiveFeature`, MCP-first disclosure |
| **Function/UX Effect** | Fires advance phases; one command archives; docs never blocked; state read via `bkit_pdca_status` |
| **Core Value** | Trustworthy registry by construction, portable to every install |

---

## 1. Overview

### 1.1 Design Goals

1. Zero manual registry writes in any bkit workflow lifecycle (pdca, sprint, pipeline)
2. One rule engine judges state-file writes on every entry point (Bash, Write, Edit)
3. Documentation files (`.md`, `.txt`) can never be denied by state-guard rules
4. The MCP server is the agent-facing read surface for PDCA state

### 1.2 Design Principles

- **Broker-only writes**: the registry's only writers are lib functions invoked by hooks,
  the sanctioned archive CLI, or the lifecycle machinery — never an agent file edit.
- **Exemption before matching**: doc-path exemptions are evaluated BEFORE any state-token
  logic, so exemption correctness cannot be defeated by pattern ordering.
- **Reuse the SSoT**: phase tables come from `PDCA_ACTION_PHASES` + one small alias map;
  no duplicated phase lists (the #135 lesson).
- **Fail-closed where it matters, fail-open everywhere else**: state-file writes deny on
  error; everything else allows (the v2.1.37 philosophy; `critical` never suppressed).

---

## 2. Architecture Options (v1.7.0)

### 2.0 Architecture Comparison

| | Option A — Minimal | Option B — Clean Service Layer | Option C — Pragmatic Balance |
|---|---|---|---|
| Guard | Patch G-019 regex only | New `lib/control/state-guard.js` module + own hook script | Extend destructive-detector (G-020 rule) + write-path exemption in the existing engine |
| Archive | Keep manual step, reword skill | `ArchiveService` + MCP write tool | CLI wrapper `scripts/pdca-archive.js` around `lifecycle.archiveFeature` |
| Disclosure | Skill text only | New MCP resource subscription | Skill text + tool description enrichment (tool exists) |
| Complexity | Low | High (new layer, new wiring, double engine) | Medium-low |
| Maintainability | Poor (regex-only, no test seam) | Best in isolation, worst in aggregate (two rule engines drift) | Good — one engine, existing contract tests |
| Effort | ~0.5 day | ~3 days | ~1 day |
| Risk | FPs remain; no Write/Edit coverage | Integration risk across all hooks | Low — additive rule + one script |

**Selected: Option C — Pragmatic Balance.** Matches the plan's §7.2 decisions. Option A
leaves the Write/Edit path uncovered (the exact path agents use to hand-edit the registry).
Option B duplicates the rule engine — two matching engines will drift, the anti-pattern
the single-detector design exists to prevent.

### 2.1 Component Diagram

```
Skill fire (Skill tool / slash)
   │
   ├─ PostToolUse(Skill) ─→ scripts/skill-post.js ──┐
   ├─ UserPromptExpansion ─→ user-prompt-…js ───────┤
   │                                                ▼
   │                        lib/orchestrator/skill-invocation-effects.js
   │                          (router aliases; archive hook point)
   │                                                │
   │                                                ▼
   │                        lib/pdca/status-core.js · lifecycle.js   [sole writers]
   │                                                │
   │   /pdca archive ─→ scripts/pdca-archive.js ────┘  (--dry-run default,
   │                                                    gate: completed / ≥90%)
   │
   ├─ PreToolUse(Bash) ─→ unified-bash-pre.js ─┐
   ├─ PreToolUse(Write|Edit) ─→ pre-write.js ──┤
   │                                           ▼
   │                     lib/control/destructive-detector.js
   │                       G-020 registry-state write (deny, critical)
   │                       + doc-path exemption (.md/.txt evaluated FIRST)
   │                       + G-019 redirect-form fix ((?<![0-9&])>>?)
   │
   └─ MCP client ─→ servers/bkit-pdca-server · bkit_pdca_status   [read-only surface]
```

### 2.2 Data Flow

1. Agent fires a router action → effects module resolves phase (set ∪ alias map) →
   `updatePdcaStatus(feature, phase, {}, {requireDocs:false})` (router fires only).
2. Agent attempts `Write`/`Edit` on the registry → pre-write → detector G-020 → deny
   with guidance ("phases advance through a skill fire; read via `bkit_pdca_status`").
3. Agent runs a Bash command touching state paths → unified-bash-pre → G-019 (fixed
   redirect forms) → deny unless the token appears read-only (no write-verb form).
4. Archive: agent runs the CLI (dry-run first) → gate check → `archiveFeature` writes
   `archived` + `archivedTo`, moves docs, updates index.

### 2.3 Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| Node.js | ≥20 (repo baseline) | lookbehind regex support for the G-019 fix |
| `lib/core/state-store.js` | existing | atomic locked writes (unchanged) |
| `lib/pdca/lifecycle.js` | existing | `archiveFeature` / `archiveFeatureToSummary` |
| `lib/orchestrator/runtime-guidance.js` | existing | `PDCA_ACTION_PHASES` SSoT export |

---

## 3. Data Model

No schema changes. Registry feature entries gain nothing new; archive uses the existing
`archivedTo` / `timestamps.archivedAt` fields. The G-020 rule reads hook input only.

### 3.1 Guard Rule Object (additive)

```js
{
  id: 'G-020',
  name: 'Registry state write',
  scope: 'write-path',            // matched on Write/Edit file_path, and Bash
  target: /\.(md|txt)$/i,          // EXEMPT — evaluated before any state logic
  deny: /\.bkit[\\/]state[\\/].+\.(json|jsonl)$/i,  // precise target, not substring
  severity: 'critical',
  defaultAction: 'deny',
}
```

(The final shape follows the engine's rule schema; semantics above are binding.)

---

## 4. API Specification

### 4.1 New CLI: `scripts/pdca-archive.js`

`POST`-shaped invocation (side-effecting CLI, HTTP analogy):

| Aspect | Value |
|--------|-------|
| Command | `node scripts/pdca-archive.js <feature> [--summary] [--dry-run] [--apply]` |
| Description | Sanctioned archive path: verifies gates, moves docs, writes registry |
| Parameters | `feature` (string, required) · `--summary` (flag) · `--dry-run` (default ON) · `--apply` (required to mutate) |
| Success (dry-run) | exit 0, JSON plan `{feature, phase, gatePassed, docsFound[], archivePath}` |
| Success (apply) | exit 0, JSON result `{archived:true, archivePath, summaryMode}` |
| Errors | 2 feature-not-found · 3 gate-failed (not completed / <90%) · 4 docs-missing |

### 4.2 Guard decision contract (unchanged shape)

`{"decision":"block","reason":{...}}` for state writes; `allow` otherwise; exemption
returns `allow` before any token scan. Hook timeouts unchanged (5s budget, measured).

---

## 5. UI/UX Design

Not applicable (no UI). Dashboard reads the same registry via existing lib APIs.

---

## 6. Error Handling

### 6.1 Error Code Definition

| Code | Source | Meaning | Action |
|------|--------|---------|--------|
| E-GUARD-REGISTRY | G-020 deny | Agent attempted registry write | Deny; message directs to skill fire / `bkit_pdca_status` |
| E-ARCH-NOTFOUND | archive CLI 2 | Feature not in registry | Fail closed; no filesystem change |
| E-ARCH-GATE | archive CLI 3 | Not `completed` and matchRate < 90 | Fail closed; no filesystem change |
| E-ARCH-DOCS | archive CLI 4 | Expected documents missing | Fail closed; report which |

### 6.2 Error Response Format

Guard: existing detector block format (used by G-019 today). CLI: JSON on stdout +
non-zero exit. Dry-run performs NO mutation — gate evaluation and doc discovery only.

---

## 7. Security Considerations

- G-020 is `critical`: v2.1.37 permission-mode policy never suppresses critical denies.
- Exemption is target-extension based (`.md`, `.txt`), evaluated first; it cannot be
  bypassed to reach state files (a `.md` path is never a registry path).
- G-019 fix tightens (never loosens): stdout-redirect forms only, `2>`/`&>` excluded.
- Archive CLI refuses mutation without `--apply` (irreversible doc moves).

---

## 8. Test Plan (v2.3.0)

### 8.1 Test Scope

| Layer | What | Files |
|-------|------|-------|
| L1 | Guard rules, aliases, archive CLI, MCP doc | `test/unit/*` (new + extended) |
| L2 | Hook pipeline with synthetic payloads | `test/integration/control-pipeline*` (extended) |
| L3 | Simulated full lifecycle fire→archive | new `test/integration/registry-lockdown.e2e.test.js` |

### 8.2 L1 Scenarios

1. Write to registry path → denied (G-020), message names skill-fire path
2. Write/Edit to `docs/**.md`, `NOTES.txt`, any `.md`/`.txt` → allowed even when content mentions `pdca-status.json`
3. Bash `echo x > .bkit/state/pdca-status.json` → denied; `node -e … 2>/dev/null` read-only near the token → allowed (redirect fix)
4. Router fires: `plan/design/do/qa/report` direct, `analyze→check`, `iterate→act` register (already landed + alias)
5. Archive CLI: dry-run default (no fs change), gate refusal (exit 3), `--apply` happy path on tmp state, `--summary` mode

### 8.3 L2 Scenarios

`pre-write.js` / `unified-bash-pre.js` fed synthetic stdin: registry Write denied
end-to-end; doc Write allowed end-to-end; decision JSON schema intact.

### 8.4 L3 Scenario

Seed a feature at `report`-completed in a tmp project; fire effects for `archive`;
assert registry `archived` + docs moved + index updated — zero manual writes.
(Uses the same effects runner the hook uses — full path minus the CC process.)

### 8.5 Seed Data Requirements

Tmp project dirs via `mkdtempSync` + `CLAUDE_PROJECT_DIR` override (issue-130 style;
the issue-135 isolation gap is the cautionary precedent — every new test isolates).

---

## Detailed Design

### G-019 redirect-form fix

Both alternations of the G-019 pattern currently use `>>?` as a write-verb form. A bare
`>` matches the stderr redirect in `… .bkit/state/pdca-status.json 2>/dev/null`, denying
read-only commands (observed live 2026-09-07). Replace with `(?<![0-9&])>>?` in both
alternations: a `>` immediately preceded by a digit or `&` (`2>`, `1>`, `&>`, `>&`) is a
descriptor redirect form, not the plain stdout-write token the rule means. Strictly a
narrowing change — no previously-denied write becomes allowed (mutation test asserts
`echo x > .bkit/state/…` still denies and `… 2>/dev/null` reads pass).

### G-020 registry-state write (write-path rule)

Matched on Write/Edit `file_path` (and the Bash redirect forms via G-019's engine path):

1. **Exempt first**: target matches `/\.(md|txt)$/i` → `allow` before any state check.
2. **Deny**: target resolves to `/.bkit/state/*.json(onl)?/` (registry and runtime state)
   → `deny`, severity `critical`, message: phases advance through a skill fire
   (`/pdca <phase> <feature>`); read state via the `bkit_pdca_status` MCP tool.
3. Everything else: no opinion (other rules apply as today).

The Python source guard (`~/.claude/hooks/pdca-guard`) is ported by SEMANTICS — exact
target match replacing its substring/content matching, which is what made it trip on
documentation files. No machine-local paths appear in the shipped rule.

### Archive CLI (`scripts/pdca-archive.js`)

```
usage: node scripts/pdca-archive.js <feature> [--summary] [--apply]
       (dry-run is the default; --apply is required to mutate)
flow:  resolve registry entry → gate (phase==='completed' || matchRate>=90)
       → discover docs (plan/design/analysis[+qa]/report paths via findDoc)
       → dry-run: print plan, exit 0
       → apply:   move docs to docs/archive/YYYY-MM/<feature>/ (git mv when in a
                  repo), update _INDEX.md, archiveFeature(--summary variant),
                  print JSON result
```

Registry writes flow exclusively through `lib/pdca/lifecycle.js` — the CLI adds no new
writer. Task completion for `[Report] {feature}` precedes invocation (skill step).

### Disclosure (skill text + MCP)

- `/pdca status` step 1 becomes: query the `bkit_pdca_status` MCP tool first; fall back
  to the `lib/pdca/status-core.js` API when MCP is unavailable (never a raw file read).
- `servers/bkit-pdca-server/index.js`: `bkit_pdca_status` description gains one sentence:
  "Sanctioned read surface for PDCA phase state — agents should read state here rather
  than opening `.bkit/state/pdca-status.json`."

## Implementation Order

Design §11.2 is authoritative (guard fix → G-020 → archive CLI → disclosure → boundary
sweep → L3 test → battery).

---

## 10. Coding Convention Reference

Repo conventions apply (ESLint, module docstrings, `__all__`-style exports, stdlib →
third-party → local import order). This feature's additions:

### 10.4 This Feature's Conventions

- Guard rules carry a prose comment block citing evidence (G-019 precedent style)
- CLI scripts follow the repo adapter pattern: parse → lib call → JSON stdout → exit code
- No new env vars; no config keys (guard scope is fixed, not configurable-by-design)

---

## 11. Implementation Guide

### 11.1 File Structure

```
scripts/pdca-archive.js                          (new — sanctioned archive CLI)
lib/orchestrator/skill-invocation-effects.js     (mod — alias map landed; archive hook point)
lib/control/destructive-detector.js              (mod — G-020 rule + G-019 redirect fix)
hooks/hooks.json                                 (mod — only if Write/Edit matcher needs the
                                                  detector path confirmed; no new blocks
                                                  expected — pre-write already routes)
servers/bkit-pdca-server/index.js                (mod — bkit_pdca_status description)
skills/pdca/SKILL.md                             (mod — archive steps; status MCP-first)
test/unit/destructive-detector.registry-lockdown.test.js   (new)
test/unit/pdca-archive-cli.test.js               (new)
test/integration/registry-lockdown.e2e.test.js   (new)
```

### 11.2 Implementation Order

1. G-019 redirect fix + tests (unblocks our own tooling immediately)
2. G-020 rule + exemption + unit tests
3. Archive CLI + unit tests
4. Skill-text updates (archive steps, status MCP-first) + MCP tool description
5. Sprint/pipeline boundary verification (FR-01/FR-03 sweep)
6. L3 simulated-lifecycle test
7. Full battery + commit sequence

### 11.3 Session Guide

#### Module Map

| Module | Contents | FRs |
|--------|----------|-----|
| module-1 | Guard: G-019 fix, G-020, exemptions, unit tests | FR-05, FR-06 |
| module-2 | Archive CLI + lifecycle wiring + unit tests | FR-02 |
| module-3 | Disclosure: skill text, MCP description, boundary sweep | FR-01, FR-03, FR-04 |
| module-4 | L3 lifecycle test + battery + CHANGELOG prep | FR-07, FR-08 |

#### Recommended Session Plan

Single session (≈1 day total effort; modules 1–2 are the critical path, 3–4 follow).

---

## Version History

| Version | Date | Change | Author |
|---------|------|--------|--------|
| 1.0 | 2026-09-07 | Initial design; Option C selected | Claude Code / dizzybeaver |
