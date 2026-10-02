# registry-lockdown Gap Analysis (Check Phase)

> **Feature**: registry-lockdown · **Phase**: Check (pass 2, post-Act) · **Date**: 2026-09-07
> **Method**: gap-detector agent (pass 1 + re-verification pass), live hook probes via
> `test/helpers/hook-runner.js`, suite execution. Full agent transcripts referenced in
> the session task log.

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | Did the implementation deliver the broker-only registry the design specifies? |
| **Finding (pass 1)** | 73.5% — one Critical: the Write/Edit hook path annotated G-020 detections but let the write proceed, with a false `destructive_blocked` audit entry |
| **Resolution (Act)** | Commit `9cfab07`: deny-action detections block (ENH-398 verdict pattern), audit honesty, sanctioned-path guidance, L2 hook test (RED→GREEN) |
| **Final verdict** | **95.0% ≥ 90% gate — PASS** (36/36 feature test cases; full battery 5,356 TC, 0 FAIL) |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | Hand-edited phase state enabled phase-skipping; the machine-level guard deadlocked sanctioned work |
| **WHO** | bkit users (agents and operators) on any install |
| **RISK** | Over-broad guard re-creating the doc-block deadlock; silent gating regressions |
| **SUCCESS** | Full cycle reaches `archived` with zero manual registry writes; guard blocks state while allowing docs; suite green |
| **SCOPE** | Advancement generalization · MCP disclosure · automated archive · guard port + exemptions |

---

## Pass 1 — Gap List (73.5%)

| # | Severity | Gap | Disposition |
|---|----------|-----|-------------|
| 1 | Critical | Write path: detector verdict advisory only — G-020 detected, write allowed (`pre-write.js` Stage 6 → contextParts → outputAllow) | **FIXED** `9cfab07`: deny-action rules return `{block:true}` verdict; main blocks with sanctioned-path guidance |
| 2 | Critical | False audit: `destructive_blocked`/`result:'blocked'` logged while the write executed (ENH-388 class) | **FIXED** `9cfab07`: `blocked` reserved for real blocks; advisory logs `destructive_detected`/`advisory` |
| 3 | Important | No CHANGELOG entry (FR-08) | **Deferred** to post-archive per operator directive |
| 4 | Important | No L2 synthetic-stdin hook test (the blind spot that hid gap 1) | **FIXED**: `test/integration/registry-lockdown.hooks.test.js` (4 TC, RED before the block wiring) |
| 5 | Important | Deny guidance absent — `alternativesFor()` had no G-019/G-020 entries | **FIXED**: entries name `/pdca <phase> <feature>`, the archive CLI, `bkit_pdca_status` |
| 6 | Minor | CLI JSON field drift (`archiveDir` vs design's `archivePath`; no `phase` in dry-run) | **FIXED**: aligned to design §4.1 |
| 7 | Minor | `git mv` not used for doc moves | **Accepted**: renameSync+EXDEV equivalent; git detects renames |
| 8 | Minor | Doc exemption only `.md`/`.txt`, plan said "any docs/ path" | **FIXED**: segment-boundary `docs/` path exemption |
| 9 | Minor | FR-03 sprint boundary not in skill text | **Accepted**: documented here — sprint archive flows through its own sanctioned writer (`lib/application/sprint-lifecycle/archive-sprint.usecase.js`); G-020 covers sprint state files |
| 10 | Minor | Stale rule-count comments (8/19 vs actual 21) | **FIXED** (+ carry: `session-context.js` startup string — fixed post-pass-2) |
| 11 | Minor | Test comment numbering (6–9 vs 6–10) | **Accepted**: cosmetic |

## Live Probe Evidence (pass 1)

- Write → registry via `pre-write.js`: annotation only, **no decision field** (confirmed Critical 1)
- Write → `.md` with registry-path prose: **allowed silently** (exemption works end-to-end)
- Bash registry write via `unified-bash-pre.js`: **blocked** (`decision:"block"`)
- Bash read with `2>/dev/null` near state token: **allowed** (G-019 redirect fix confirmed live)

## Pass 2 — Re-verification (95.0%)

| Axis | Rate |
|------|:----:|
| Structural | 98% |
| Functional | 95% |
| Contract | 96% |
| Intent | 92% |
| Behavioral | 93% |
| Runtime | 100% (36/36 feature cases; battery 5,356 TC, 0 FAIL) |

All Critical/Important gaps verified fixed with file:line evidence (pass-2 agent report);
no functional regressions introduced by the fixes.

## Decision Record Verification

| Decision | Followed | Outcome |
|----------|----------|---------|
| Option C (extend single detector engine) | ✅ | G-019/G-020 in one engine; no second rule engine |
| Archive via CLI wrapping lifecycle (not MCP write) | ✅ | `scripts/pdca-archive.js`; MCP remains read-only |
| Alias map reusing `PDCA_ACTION_PHASES` SSoT | ✅ | No duplicated phase tables |
| Exemption before matching | ✅ | `docTargetExempt` evaluated before state rules on both paths |
| requireDocs:false for router fires only | ✅ | Static-phase skills keep the #89 gate |

## Success Criteria Status

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Zero manual registry writes in a full cycle | ✅ | `registry-lockdown.e2e.test.js` (11 TC) |
| Guard blocks state, passes docs | ✅ | detector + hooks suites (18 TC) |
| Suite green | ✅ | run-all 5,356 TC, 0 FAIL |
| MCP-first reads | ✅ | SKILL.md status step + tool description |

## Carried Items

1. CHANGELOG entry (FR-08) — lands post-archive, before feature close.
2. ~~`session-context.js` startup count~~ — fixed in the Act commit follow-up.

---

## Strategic Alignment Check

| Question | Verdict |
|----------|---------|
| Does the implementation address the PRD/core problem (hand-edited phase state)? | ✅ All three write surfaces brokered: fires (router actions), the archive CLI, lifecycle writers; agent writes denied on Write/Edit AND Bash paths |
| Are Plan Success Criteria met? | ✅ 4/4 (table above) |
| Were key Design decisions followed? | ✅ Decision Record Verification table (no deviations) |

## Gap Analysis

See "Pass 1 — Gap List" (all dispositions) and "Pass 2 — Re-verification" above.

## Overall Score

**Match Rate: 95.0%** (pass 2) — ≥ 90% gate: **PASS**. Runtime 100%: 36/36 feature
cases, full battery 5,356 TC / 0 FAIL.

## Recommended Actions

1. Proceed to `/pdca qa registry-lockdown`
2. Then `/pdca report registry-lockdown`
3. Then `/pdca archive registry-lockdown` (dogfoods the new CLI)
4. Post-archive: CHANGELOG entry per CONTRIBUTING.md; file stray session artifacts into `work/`

## Next Steps

QA → Report → Archive → CHANGELOG → cleanup (operator directive 2026-09-07).

## Version History

| Version | Date | Change | Author |
|---------|------|--------|--------|
| 1.0 | 2026-09-07 | Pass-1 gap list (73.5%) + Act fixes + pass-2 re-verification (95.0%) | gap-detector agent ×2 / Claude Code |

