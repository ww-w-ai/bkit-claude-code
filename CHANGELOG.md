# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed — PDCA Stop-handler completion-state hardening (registry terminal guard, dead-record binding, post-completion silence)

A four-layer defense now keeps a finished PDCA cycle finished. Each layer sits at a
different chokepoint of the Stop pipeline, so a stale skill-fire replay cannot corrupt
registry state or pressure the agent into fabricating new work:

- **Terminal-state write guard (`lib/pdca/status-core.js`).** `updatePdcaStatus`
  rejects non-archive phase writes against features carrying archived markers
  (phase `archived`, `archivedAt`, `archivedTo`); archive-path writes stay permitted.
  Previously a stale Stop-handler fire silently rewound `archived` features to
  `act`/`do`, corrupting the audit trail. Mutation-verified regression suite:
  `test-scripts/regression/terminal-guard.test.js`.
- **Dead-record binding sentinel (`lib/pdca/stop-binding.js`, `scripts/unified-stop.js`).**
  A fire-time `lastSkillFeature` recording that names a feature absent from the
  registry is proof the cycle completed (archive deletes the feature) — the Stop
  binding now returns a null sentinel instead of falling through to
  `primaryFeature`, killing the phantom next-phase re-fires behind the observed
  9-consecutive-block loops. Shared `isDeadRecordedFeature` helper at both binding
  sites; mutation-verified: `test-scripts/regression/dead-record-no-rebind.test.js`.
- **Harness loop-breaker honored (both Stop handlers).** `stop_hook_active=true`
  (set by Claude Code after a Stop hook blocks once) now always exits 0 —
  previously both handlers ignored it and re-blocked. Verified in
  `test-scripts/regression/stop-loop-breakers.test.js`.
- **Terminal-feature emission silence (`scripts/pdca-skill-stop.js`).** Archiving
  keeps the feature key in the registry with `phase: 'archived'`, so the dead-record
  sentinel above did not fire — the stale transcript report envelope kept binding the
  archived feature and re-emitting "PDCA-COMPLETE … Do NOT stop" on every later Stop.
  A new early exit (placed after all binding tiers, same terminal predicate as the
  write guard, plus `phase: 'completed'`) approves silently: exit 0, no output.
  Mutation-verified regression suite:
  `test-scripts/regression/terminal-complete-silence.test.js`
  (archived / completed / live-feature control).
- **Fire-time skill recording (`lib/orchestrator/skill-invocation-effects.js`,
  `lib/pdca/stop-binding.js`).** `lastSkillAction`/`lastSkillFeature` are now written
  when a PDCA skill FIRES (not scraped from Stop prose); the Stop binding's tier-0
  prefers the fired feature over `primaryFeature`, and `unified-stop` spawns
  stdin-CLI handlers correctly (a bare-require guard had made `require()` a silent
  no-op). Gate writes read the live phase instead of a stale pre-handler snapshot.
- **QA retry ceiling now reachable (`lib/pdca/state-machine.js`,
  `scripts/qa-phase-stop.js`).** The `act → qa` QA_RETRY edge previously carried a
  null guard, making the max-retry ceiling unreachable (observed retry counts > 180).
  The guard is wired, an escalation banner names the missing metrics at retry 10 and
  every 25th retry, and the sanctioned `scripts/pdca-record-qa.js` CLI records QA
  results for sessions whose dispatch path is dead.
- Resolved sessions also regain Skill-tool resolution of `bkit:pdca` (catalog and
  resolver re-align at session start — the mid-session hot-update variant of this
  break is a Claude Code host limitation, documented with evidence in the closed
  report; the `pdca-record-qa` CLI remains the sanctioned recovery path).

### Fixed — Stop-handler feature binding and report→completed transition

- **The Stop handler no longer misbinds the feature.** The pure helper
  `lib/pdca/stop-binding.js` (`resolveStopFeature`) adds a per-feature evidence tier
  between doc-path matching and the `primaryFeature` fallback: when exactly one
  registry feature sits in the phase matching the fired action, the Stop handler binds
  that feature instead of silently advancing `primaryFeature`. Mutation-locked by
  `test/unit/stop-binding.test.js`.
- **report→completed no longer depends on the Task system.** The Stop handler
  advances report→completed when the report-phase fire is observed AND the feature's
  report doc exists on disk (same check the archive CLI makes). The archive gate's
  docs-on-disk arm now accepts bug-fix doc sets — `analysis` moved to optional, so
  cycles that skip Check can archive instead of stranding at E-ARCH-GATE forever.
- **`updatePdcaStatus` no longer drops `data.timestamps`.** The timestamps rebuild
  merges `data.timestamps` with `lastUpdated` kept last, so callers like
  `archiveFeature` (`archivedAt`) land in the registry.
- **`primaryFeature` no longer reverts to a stale feature.** The sanctioned promotion
  fallback picked `activeFeatures[0]` (the OLDEST entry), so archiving the current
  feature re-promoted a days-old one and re-poisoned every hook fallback binding.
  `pickPrimarySuccessor(status)` (most recently active by `timestamps.lastUpdated`)
  is now used at all 5 promotion sites; mutation-locked by
  `test/unit/pdca-primary-successor.test.js`.
- **Pre-existing (from upstream merge): destructive-detector targetFields grading was
  dead.** `detect()`'s targetFields branch pushed `rule.severity` directly, never
  consulting `severityFor` — every Bash-path match graded critical/deny regardless of
  target scope. Fixed to grade by target like the segmented path (scoped find-delete
  now asks instead of denying).
- Docs refreshed for the new lib module count (201 → 202) in CUSTOMIZATION-GUIDE.md
  and AI-NATIVE-DEVELOPMENT.md.

### Fixed — ESLint flat-config coverage for test files and self-linting

- **Jest globals declared for `test-scripts/`.** A new override block for
  `test-scripts/**/*.test.js` (readonly `describe`/`it`/`test`/`expect`/
  `beforeAll`/`afterAll`/`beforeEach`/`afterEach`/`jest`, inlined literal per the
  config's import-free constraint) removes the 210 no-undef errors that appeared
  when jest's `testMatch` moved to `test-scripts/`. `npx eslint test-scripts/`:
  0 errors; full-repo error count 2303 → 2046 (remainder pre-existing
  `no-console` violations, untouched).
- **`eslint.config.js` can now lint itself.** The base block applied
  `sourceType: "script"` to every `**/*.js` file — including the flat config's own
  `export default`. A self-referential
  `{ files: ["eslint.config.js"], languageOptions: { sourceType: "module" } }`
  override fixes the parse error.

### Fixed — session-start preflight disambiguation

- The `fork-default-agent-spawn` advisory (lib/infra/cc-version-checker.js) and the
  hook-reachability warning (hooks/session-start.js, via the pure
  `buildReachabilityWarning` builder in lib/core/hook-reachability.js) now carry
  explicit non-causality wording: the version advisory is NOT a hook failure; fresh
  bash_post/write_post canary stamps mean hooks ARE firing; a stalled PDCA registry
  while canaries are fresh points at skipped `/pdca <phase>` skill fires, not a hook
  drop. Content locks:
  `test/unit/preflight-hookdrop-disambiguation.test.js`.

### Fixed — archive CLI now moves every phase-document variant

- **`/pdca archive` no longer strands bilingual doc siblings.** The CLI's
  `discoverDocs` collected one file per phase (`findDoc` returns the first
  existing candidate), so a bilingual cycle — the project mandates en+ko
  sibling pairs for new docs — archived one variant and left the other in the
  source directory (observed twice; agents had to move the leftovers by
  hand). A new `findAllDocs(phase, feature)` helper (lib/core/paths.js,
  all readable candidates, deduped) backs a multi-variant collector; gate
  semantics unchanged (a phase is missing only when no variant exists).
  Mutation-verified regression suite:
  `test-scripts/regression/archive-bilingual-pairs.test.js`
  (bilingual / monolingual / gate cases).

### Fixed — per-turn token measurement survives post-completion Stops

- **The token ledger no longer stops growing after a cycle archives.** The
  post-completion dead-record exit in `unified-stop` fired before the
  per-turn observability block at the end of the handler, so once a session's
  fire-time feature recording named an archived-out feature, every later Stop
  silently skipped token-ledger and cc-regression recording. The recording
  block is hoisted into `recordTurnObservability()` and runs on BOTH exit
  paths. Caught by pre-running the CI contract suite locally against a live
  registry (a fresh CI checkout never sees it); regression is covered by
  `test/contract/integration-runtime.test.js` (23/23 with the dead-record
  state live).

### Fixed — CI aggregate gate: stale test contracts aligned with shipped behavior

- The 403-file QA aggregate (contract-check CI) exposed three suites asserting
  contracts their own change-waves had superseded — red since those waves
  landed (their batteries ran only the jest suites), plus one stale doc count:
  - destructive-detector.targetfields: G-001 now asserted per the v2.1.34 D9
    contract (broad target denies, specific target asks) — both arms covered.
  - pdca-archive-gate: `analysis` is an OPTIONAL phase document (bug-fix
    cycles skip Check); `discoverDocs` missing-list asserted required-only.
  - hook-behavioral-bash-pre: success-path stdout is opt-in
    (`BKIT_VERBOSE_VALIDATION=1`); BPRE-05 made hermetic via a sandbox
    `CLAUDE_PROJECT_DIR` (live session state leaked a "for sprint" clause
    into the message when run under the aggregate).
  - CUSTOMIZATION-GUIDE.md Scripts count corrected 64 → 65.
- Full aggregate verified locally: 403 files, 7,155 PASS / 0 FAIL / 0 errors.

### Chore

- `.gitignore`: `bkit-debug.log` ignored.
- Bug-report catalog housekeeping: closed reports moved to `bug_reports/completed/`
  with `.completed` markers; stale INDEX entries removed (already-completed items
  still listed as open; top-level INDEX carried dead links to reports that were
  never in this repo).

## [2.1.39] - 2026-09-19 (unreleased — version heading provisional; the maintainer assigns the release number)

### Fixed — bugfix-wave-20260919 (six bug reports resolved via full PDCA cycle, matchRate 94%, QA_PASS)

- **RB-003 — G-001/G-013 no longer fire on Write/Edit content.** Both rules now declare
  `targetFields: ['command']` (the G-020 mechanism), so a Write whose *content* merely
  mentions `rm -rf`, `rimraf`, or `shutil.rmtree` is no longer denied. Bash keeps full
  coverage — the only surface that can actually execute a deletion. Both-sides regression
  suite: `test/unit/destructive-detector.targetfields.test.js`.
- **archive-phase-write — archive status write no longer silently gated out.**
  `archiveFeature`'s archived-phase `updatePdcaStatus` call now passes `requireDocs:false`
  (lib/pdca/lifecycle.js) — an archived feature has by definition left its docs' source
  location, so the doc gate can no longer swallow the write.
- **BR-001 — sanctioned orphan-row cleanup.** `deleteFeatureFromStatus` now removes
  non-terminal active rows whose plan/design docs are provably absent
  (`reason: 'orphan-removed (docs missing)'`), recovering the 3-feature
  `canStartFeature` cap without hand-editing the registry. Live features with docs
  remain protected: `test/unit/status-cleanup-orphan.test.js`.
- **RB-002 + BR-002 — matchRate recording repaired.** `gap-detector-stop.js` now
  reorders the regex (`Overall Match Rate` first, table form `Overall Match Rate | 98%`
  handled), passes the regex-extracted feature name into `extractFeatureFromContext`
  (the old call passed keys the function ignores, guaranteeing the primaryFeature
  fallback), and adds a wrong-feature guard (unknown feature → parseWarning, nothing
  recorded). Suite: `test/unit/gap-detector-stop-parsing.test.js`.
- **RB-002 — archive gate accepts docs-on-disk evidence.** `pdca-archive.js` now passes
  when phase is report..completed AND all 4 documents exist at canonical paths
  (`gate: 'docs-on-disk'` in the payload) — registry bookkeeping drift no longer
  permanently blocks archiving a genuinely complete cycle. Fail-closed preserved for
  earlier phases. Suite: `test/unit/pdca-archive-gate.test.js`.
- **stop-failure-payload — Stop failure entries carry real fields.** `parseFailurePayload`
  (scripts/stop-failure-handler.js) extracts plain-string `error`, `last_assistant_message`
  (string and content[0].text forms), derives errorType from the classifier when absent,
  and adds an `exit_code` category — failures no longer collapse to unknown/low/empty.
  Suite: `test/unit/stop-failure-payload.test.js`.

### Added

- 5 regression suites / 48 test cases covering the fixes above; full unit battery green
  (1979/1980 executed, 0 fail). Bug reports `rb003`, `rb002`, `archive-phase-write`,
  `br001`, `br002` moved to `bug_reports/completed/` with `.completed` markers; new
  open reports filed during the wave: `br003` (updatePdcaStatus drops data.timestamps),
  `br004` (CHANGELOG provisional heading vs plugin.json version-sync integration test —
  pre-existing, maintainer action).

## [2.1.39] - 2026-09-07 (unreleased — version heading provisional; the maintainer assigns the release number)

### Fixed — the PDCA registry never advanced on a skill fire

Field evidence (`work/pdca-skill-fire-test-results.md`): three real `/pdca` fires were
detected by the hook layer (registry timestamp advanced, guidance emitted) while the
feature was never registered and no phase changed. Root cause:
`runSkillInvocationEffects` gated the phase write on the skill's *static* frontmatter
`pdca-phase`, which the `pdca` router declares `null` by design — the effective phase
arrives as the invocation's action token, which #135 wired into guidance but never into
the write path. Router fires now resolve the phase from the action (direct names plus
`analyze→check`, `iterate→act` aliases, reusing the `PDCA_ACTION_PHASES` SSoT) and pass
`requireDocs:false` — a new feature's documents are the phase's *output* and cannot
exist at fire time. Read-like actions (`status`, `next`) still write nothing.

### Added — the registry is broker-only, portably

- **G-020 (Registry state write, critical/deny)** denies agent Write/Edit operations
  targeting `.bkit/state/*.json`, porting the machine-local Python pdca-guard's
  PRE-EXEC semantics into bkit's own detector. A new `targetFields` rule property
  scopes it to the tool's TARGET — a state-path mention in payload prose is not a
  write. Documentation files (`.md`/`.txt`, any `docs/` path) are exempt *before* any
  state-token matching, closing the reported false-positive class where a design doc
  demonstrating a state-path command was denied for its content.
- **G-019 redirect-form fix**: both alternations' bare `>>?` now require
  `(?<![0-9&])` — stderr/descriptor redirects (`2>`, `&>`) are not the stdout-write
  token, so read-only commands like `grep … 2>/dev/null` near a state path pass again
  (live-measured false positive). Narrowing only; plain and append redirects still deny.
- **`scripts/pdca-archive.js`** — the sanctioned archive path: dry-run by default,
  `--apply` to mutate, completion gate evaluated before any filesystem change,
  registry write ordered before document moves (the issue #89 `requireDocs` gate
  would otherwise silently skip the archived transition), `--summary` for metrics
  preservation. `lifecycle.archiveFeature` — previously wired to nothing — is its
  registry writer.
- **Deny guidance names the sanctioned paths**: `alternativesFor()` G-019/G-020
  entries and the Write-path block message direct to `/pdca <phase> <feature>`, the
  archive CLI, and the `bkit_pdca_status` MCP tool instead of generic "ask the user".
- **The pdca skill's steps are brokered-registry-true**: every
  "Update `.bkit/state/pdca-status.json`" step is now verify-only (fire-time writes,
  gap-detector Stop hook for matchRate, TaskCompleted for `completed`, the CLI for
  archive), `/pdca status` reads MCP-first with the lib API as fallback, and template
  references disclose their resolved location (`${CLAUDE_PLUGIN_ROOT}/templates/`) so
  agents stop searching the project root for them.

### Fixed — the Write-path detector verdict was advisory only

The gap analysis's Critical finding, live-confirmed by probe: `pre-write.js` Stage 6
pushed destructive detections into `contextParts` and emitted them via `outputAllow` —
the engine correctly detected G-020 on a registry Write while the write proceeded, and
the audit trail recorded `destructive_blocked` / `result: 'blocked'` for writes that
actually executed (the ENH-388 false-assurance class). Deny-action detections now
return the ENH-398 verdict object and the hook blocks; `blocked` is reserved for real
blocks, advisory detections log `destructive_detected` / `advisory`. A new L2
synthetic-stdin hook suite pins the behavior end-to-end (registry Write blocked with
sanctioned-path guidance; `.md` doc with state-path prose allowed; Bash parity).

Verified across the cycle: gap analysis 73.5% → 95.0% after one Act iteration; QA_PASS
(L1 31/31, L2 4/4, L3 11/11, L5 40/40, hook cost ~76–78 ms median = 1.7% of the 5 s
budget); full battery 5,355 TC, 0 FAIL. The feature's own cycle advanced plan →
archived through the new mechanism with zero manual registry writes, and archived
itself with its own CLI.

## [2.1.40] - 2026-09-25

### Added — plan, QA and security methods adapted from gstack

bkit's plans ask what the user wants, but never whether it is worth building.
Its QA ran scripted scenarios only. Its security review listed OWASP categories
but set no bar for what counts as a finding. Three methods from
[gstack](https://github.com/garrytan/gstack) (MIT) fill those gaps. They are
rewritten inside the existing skills and agents, so no skill, agent, hook or
gate count changes.

- **`/plan-plus` challenges the premise before exploring alternatives.**
  - A new Phase 1.5 asks up to four forcing questions: demand, status quo,
    smallest useful version, cost of doing nothing. Bug fixes and small changes
    skip it. It ends with a numbered list of premises the user confirms.
  - Phase 3 now picks a scope mode first (Expand / Selective / Hold / Reduce),
    and each proposed addition is decided on its own.
  - Phase 4 adds a failure map: every new entry point, what can go wrong, and
    what the user sees. A silent failure must be handled or listed as an
    accepted risk.
  - `plan-plus.template.md` gains sections 1.5 and 8.5 and a scope-mode line to
    record all of this.
- **`qa-lead` tests like a user, not only like a script.**
  - Diff-aware scope maps the changed files to the pages they serve and tests
    those first.
  - An exploratory L3-L4 pass then tries forms, empty and error states, and
    navigation on those pages, reading the console after every action.
  - A weighted 0-100 Health Score summarizes the findings. It is informational:
    the QA gate metrics still decide the verdict.
  - On QA_FAIL, issues go to Act in fix order with reproduction steps, under
    one-issue-per-fix and stop-and-ask rules. The existing `act → qa` retry does
    the re-verification.
  - `qa-report.template.md` gains Scope, Health Score and Issues sections.
- **`security-architect` sets an evidence bar.**
  - An ordered audit procedure covers the application model, attack surface,
    secrets, supply chain, CI/CD, the LLM/agent surface, OWASP and STRIDE.
  - A finding counts as *supported* only with an attacker-controlled entry
    point, a path across a boundary, a concrete impact, and a check of existing
    protections. Anything short of that is reported as *unconfirmed*.
  - Every report states its coverage (complete / partial / not assessed), and an
    empty result reads "No supported findings in the assessed scope".
- **Attribution** for the adapted methodology is added to `NOTICE`.

## [2.1.39] - 2026-09-20

### Fixed — a finished phase that `/pdca status` could not see (#156)

`/plan-plus` and five other phases recorded nothing in a project whose first
feature was the one being recorded, and `/pdca status` then showed no phase for
work that had just completed.

- **Six Stop handlers passed a field nothing read.** `plan-plus-stop`,
  `pdca-skill-stop`, `qa-stop`, `analysis-stop`, `iterator-stop` and
  `qa-phase-stop` all call `extractFeatureFromContext({ agentOutput, currentStatus })`,
  and the function read neither: it fell through to `primaryFeature`, which is
  empty before any feature is registered. The handler exited without writing.
  Where a previous feature existed the failure was worse than silence — the phase
  attached to that other feature. It now recovers the feature from the document
  path the phase names in its output, matched against the project's own
  `pdca.docPaths.*` templates, and uses `currentStatus` when it is handed one.
- **`plan-plus-stop.js` scanned the envelope instead of the output.** It built its
  text with `JSON.stringify(input)`, and a Stop payload carries `hook_event_name`,
  `session_id`, `transcript_path` and `cwd` — never the assistant's answer. So
  there was no document path in the string to recover a feature from. It now uses
  `readHookText(input)`, which reads the trailing assistant text from the
  transcript; the other five handlers had already been converted and this one was
  missed.
- **The phase is now readable from the documents.** `lib/pdca/status-derive.js`
  adds `getPdcaStatusView()`: the stored `pdca-status.json` with any feature whose
  phase is evidenced only by its documents filled in, each marked `source:
  'documents'` or `'status-file'`. A plan document means the plan phase happened,
  whoever did or did not record it, so a lost write no longer erases the progress
  surface. Read-only and never ahead of a recorded phase — `do` produces code
  rather than a document, so a feature recorded at `do` is not pulled back.
  `/pdca status`, `/pdca next` and `/btw` read through it.
- **Documentation pointed at the wrong store.** `skills/plan-plus/SKILL.md` told
  the model to read and write the PDCA phase in `.bkit-memory.json`. That file
  migrates to `.bkit/state/memory.json`, which holds the project level and the
  9-phase `pipelineStatus` read by `phase5-design-stop.js`,
  `phase6-ui-stop.js` and `phase9-deploy-stop.js` — a different store from
  `pdca-status.json`. The plan-plus instructions now name the Stop handler that
  records the phase, and `starter`, `dynamic`, `enterprise` and `btw` say what
  `memory.json` is for, so the two are not conflated again.
- **`task-template` no longer contradicts the Task that is created.**
  `skills/plan-plus/SKILL.md` declared `[Plan Plus] {feature}` while the runtime
  creates `[Plan] {feature}` (`lib/task/creator.js`), which is what
  `/pdca design` looks for when it closes the predecessor Task and resolves
  `blockedBy`. The frontmatter now matches. The field itself is read by
  `orchestrateSkillPre`, which has no non-test caller — that, and the same
  mismatch in the other skills, is left for its own change.

### Fixed — a warning on every session start (#155)

- **`hooks/hooks.json` no longer carries `$schema`.** The URL it named 404s —
  SchemaStore carries `claude-code-settings`, `-plugin-manifest`, `-marketplace`,
  `-keybindings` and `-launch`, and no hooks schema — so it bought no editor
  completion, while Claude Code up to 2.1.268 reported it as an unknown key once
  per session for every bkit user. 2.1.276 accepts the key, so updating Claude
  Code also stops the warning. The contract test that required the field now pins
  the loader's whole accepted set instead (`$schema`, `description`, `hooks`,
  `modules`, `surface`), which is the invariant that matters.
- The `once` note in that report is not acted on: running `session-start.js` on
  every `SessionStart` is the intended behaviour, and whether `once` is honoured
  on a command object is unverified here.

## [2.1.38] - 2026-08-17

### Fixed — QA pipeline wiring

Four breaks between the QA agents and the qa quality gate. Each was silent: the
QA phase printed "QA Phase completed" while the value it exists to produce never
reached the gate. Found by reading the qa-lead → qa-phase-stop → gate-manager →
state-machine path end to end rather than from a failing run, because none of
these can produce a failing run — they produce a run that looks fine.

- **QA metric collection crashed on its first line and swallowed the error.**
  `readStdinSync()` returns the *parsed* hook payload — an object — and
  `scripts/qa-phase-stop.js` assigned it to `qaOutput` and called `.match()` on
  it. TypeError on M11, caught by the handler's own try/catch, and M11–M15 were
  never written on any run since v2.1.1. Adds `readHookText()` to
  `lib/core/io.js`, which resolves the payload to the assistant's reported text
  via `transcript_path` (text blocks only — `thinking` and `tool_use` would
  produce false metric hits) and always returns a string.

- **The qa gate required a metric that no metric ID produced.** `gate-manager`'s
  `qa` gate has listed `qaCriticalCount === 0` as a pass condition since v2.1.1,
  but `METRIC_ID_TO_GATE_NAME` had no entry mapping to that name, and
  `_evaluateCondition` treats an absent metric as unsatisfied. `passCount <
  totalPass` therefore held on every run, so the gate could never return `pass`
  and QA could not advance to Report regardless of test results — `retry` and
  `fail` both map to `QA_FAIL`. Adds **M16 (QA Critical Count)** and collects it
  in the qa Stop handler. The gate is unchanged; the missing piece was the
  metric.

- **The state machine was handed a blank context.** `scripts/unified-stop.js`
  built its context with `createContext()`, which carries no QA fields at all,
  so `guardQaPass` and `guardQaMaxRetryReached` both evaluated against
  `undefined` — QA_PASS could not fire, and neither could the max-retry escape
  hatch, leaving a feature able to loop `qa → act` indefinitely. The
  `recordQaResult` action then wrote those blanks back to pdca-status as nulls,
  erasing measurements. Switches to `loadContext()` (falling back to
  `createContext`) and extends `loadContext` to hydrate the QA slice, reading
  quality-metrics first and pdca-status second. Adds
  `guardrails.loopBreaker.maxQaRetries` to `bkit.config.json` so the retry
  ceiling is a real, editable setting rather than an inline default.

- **Chrome MCP detection read an environment variable Claude Code never sets.**
  Both `lib/qa/chrome-bridge.js` and a duplicate copy in
  `lib/pdca/state-transitions.js` tested `process.env.MCP_SERVERS`, which is
  always empty under Claude Code, so `chromeAvailable` was false on 100% of runs
  and L3/L4/L5 were skipped every time — described in qa-lead's own docs as
  normal fallback, which is how a permanently dark half of the test matrix
  passed for a feature. Detection is now layered, most authoritative first: a
  runtime probe qa-lead records in `.bkit/runtime/qa-capabilities.json` (only the
  agent holds the Chrome MCP tools, so only the agent can observe whether they
  answer), a `BKIT_CHROME_MCP=1|0` operator override, `MCP_SERVERS` for
  back-compat, then MCP config files. The duplicate detector now delegates to the
  bridge instead of drifting alongside it.

Regression coverage: `test/regression/qa-pipeline-wiring.test.js` (23 TC),
registered in `test/run-all.js`.

### Fixed — QA follow-ups

The rest of the same audit, plus one root cause that only surfaced while fixing
the first four.

- **No Stop handler had ever seen its hook payload.** `unified-stop.js` reads the
  payload with `readStdinBounded`, which destroys stdin on resolve (Issue #139),
  and then dispatches the per-agent handler with `require()` — same process,
  stdin already drained. All six metric-collecting handlers are self-executing
  and call `readStdinSync()` for themselves, so the parent saw the payload and
  the child saw `{}`. Measured with a two-file harness, not inferred. This is
  the reason no handler ever had a `transcript_path` to read, and it means the
  C-1 fix above was necessary but not sufficient on its own. `lib/core/io.js`
  now remembers the payload the process read and hands it to later readers; one
  hook process handles one event, so there is no staleness to reason about.

- **Two more handlers regexed their own guidance string.** `analysis-stop.js` and
  `qa-stop.js` both `require` `readStdinSync` and never call it, matching their
  metric patterns against the `message` constant declared at the top of the same
  file. Those patterns cannot match it, so M2 was written at its 75 baseline and
  M5 at 0 — "no errors found" — on every run regardless of what code-analyzer or
  qa-monitor reported.

- **`QA_RETRY` was defined but never emitted.** `act → qa` is the only route back
  into QA after a failure, and `unified-stop` mapped the act phase to
  `ANALYZE_DONE` unconditionally, so a QA failure rejoined the ordinary
  `act → check` loop and never returned to the phase that rejected it. The
  transition, its retry counter, and its `initQaPhase` action were all
  unreachable. `QA_FAIL` now records the debt via a new `markQaRetryPending`
  action and unified-stop pays it on the next act completion. Separately,
  `initQaPhase` read `ctx.qaRetryCount || 0` and wrote the same value back — the
  counter never moved, so `guardQaMaxRetryReached` could not fire however many
  times a feature went round. It now advances on `QA_RETRY` and only on it.

- **qa-lead never dispatched qa-monitor.** It is declared in the agent's tools and
  named in its description as one of four coordinated agents, but no step called
  it, so the QA phase reported test outcomes with no runtime log evidence behind
  them. Added as Phase 3.5.

- **qa-test-planner could not write the test plan it exists to produce.** `Write`
  was on its `disallowedTools` list while its stated role was producing "test
  plan documents", so the plan survived only as conversational text — and
  qa-lead ran the planner and the generator concurrently anyway, leaving the
  generator to write tests against a plan that did not exist yet. The planner now
  writes `docs/05-qa/{feature}.test-plan.md`, the generator reads that path and
  stops if it is missing, and qa-lead sequences the two. `Bash` stays denied.

- **The pre-release scanner scanned bkit, not the caller's project.**
  `pre-release-check.sh` set `PROJECT_ROOT` from its own location and used it for
  both loading scanner code and choosing what to scan, so a user running it got a
  report about bkit's source. Split into `BKIT_ROOT` (code) and `SCAN_ROOT`
  (target, defaulting to `$CLAUDE_PROJECT_DIR`), with `--root DIR` and a `--self`
  opt-in for the old behaviour. `skills/qa-phase/SKILL.md` invoked it by relative
  path, which resolves to nothing where the skill actually runs — now
  `${PLUGIN_ROOT}`-absolute — and documented four scanners where five ship;
  `wiring` was missing from both the table and the report template.

Regression coverage: `test/regression/qa-followups.test.js` (27 TC), registered
in `test/run-all.js`.

### Fixed — the last three Stop handlers read the payload envelope

`gap-detector-stop.js`, `iterator-stop.js` and `pdca-skill-stop.js` all built
their match target as `typeof input === 'string' ? input : JSON.stringify(input)`
— the hook envelope (`hook_event_name`, `session_id`, `transcript_path`, `cwd`),
never the agent's report. Delivering a real payload to these handlers (previous
entry) was necessary but not sufficient: the envelope carries none of the signals
they look for, and each is now asserted not to.

- **gap-detector-stop** could never extract a match rate. Its unmeasured handling
  was already correct (v2.1.34), so the effect was not a wrong number but a
  permanent absence — M1 and M4 were never collected from the analysis itself.

- **iterator-stop** matched its completion, max-iteration, improvement and
  changed-files patterns against the envelope, so all four were permanently
  false and branch selection fell entirely to numeric fallbacks — the iterator's
  own account of what it did was never read. Its `featureStatus?.matchRate || 0`
  fallback also fabricated a measurement, and `isMeasured(0)` is `true`, so the
  fabricated zero passed as a real reading into the M9 efficiency calculation
  where `improvement = 0 - prevMatchRate` recorded a regression that never
  happened. Now routed through `lib/quality/match-rate`, matching what
  gap-detector-stop already does; threshold comparisons go through a measured
  guard, and user-facing text renders "not measured" instead of `null%`.

- **pdca-skill-stop** matched `pdca (plan|design|…)` against the envelope, so
  `action` was always `null` — and `null` disables most of the handler: the PDCA
  status update, the auto-transition, the executive summary, and the M8/M10
  metrics are all gated on it. Now falls back to the phase recorded in
  `features[…].phase` when the text is silent. Deliberately not
  `status.currentPhase`: that key was retired by the v3 migration, and reading it
  returns `undefined` without throwing, which is the exact failure
  `test/contract/state-schema-keys.test.js` was written to catch.

Regression coverage: `test/regression/stop-handler-extraction.test.js` (28 TC),
registered in `test/run-all.js`.

### Fixed — the live hook harness could not exercise the task pair

`test/qa-harness-full-live.js` drove `TaskCreated` / `TaskCompleted` with a
`TaskCreate` + `TaskUpdate` prompt, and on Claude Code v2.1.233 both events came
back dead. They are not dead. **v2.1.233 withdrew the Todo/Task tool family** —
`TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`, `TodoWrite` — from Opus 4.8 /
Sonnet 5 / Fable 5 / Mythos 5+, keeping it for Haiku;
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` restores it. With no tool to call, a live hook
reads as a dead one.

Isolated against the dispatch ledger, not against what a model says it has: the
four isolation flags (`--setting-sources ''`, `--strict-mcp-config`,
`--permission-mode`, `--no-session-persistence`) were bisected one at a time and
none of them moved the result, while the same trigger under the **full** flag set
fires both hooks with the variable set on the default model, and fires unset on
Haiku. Model self-reports of "which tools do you have" contradicted the ledger in
both directions, which is why the ledger is what this harness believes.

The task trigger now sets that variable, keeping the harness on the model users
actually run. Live hooks went 21/23 → **23/23** with the isolation intact, so
`LRF-8` — the floor that refuses to let a once-observed event be relaid as
"unverified" — is satisfied by evidence rather than by lowering the floor.

Not fixed here, and tracked with the CC-version response instead: on v2.1.233 a
default-model user has no `TaskCreate`, so bkit's own `TaskCreated` hook and the
four `SKILL.md` files that instruct the model to call it are inert for them.

### Changed — docs synchronised with the code

- `metrics-collector` has shipped M11–M15 since v2.1.1 and M16 since this
  release, while `bkit-system/philosophy/` still described **ten** metrics — and
  described a *different* ten: its M1 was "Plan accuracy" where the code's M1 is
  Match Rate, so a reader matching a metric ID against a runtime value was
  reading two unrelated lists. The table is now generated from `METRIC_SPECS`.
- Note for readers: three separate M-numbered systems coexist and only the
  metric IDs changed here — `METRIC_SPECS` M1–M16 (metric IDs), the
  `docs/reference/quality-gates-m1-m10.md` phase-gate catalog, and the
  `README-FULL.md` §5 gate table. The catalog and the §5 table are untouched.
- Version strings advanced across the five-location invariant plus
  `marketplace.json`, and the component inventory in `CUSTOMIZATION-GUIDE.md`
  was re-stamped with the release it was measured in.

## [2.1.37] - 2026-08-15

> **One-Liner (EN)**: A Claude Code plugin that verifies AI-generated code against its own design specs.

> **Status**: Two responses in one release. Permission-mode awareness, reported by
> the maintainer running `claude --dangerously-skip-permissions` and being stopped
> at `PreToolUse` anyway; and the Claude Code v2.1.228–v2.1.232 impact response.
> Measured against Claude Code v2.1.231 and v2.1.232.

### Claude Code v2.1.228 → v2.1.232 response

100 CHANGELOG bullets across four releases (v2.1.230 was never published).
Breaking changes: **0** — the hook contract is byte-identical across all four
binaries, which takes consecutive compatible releases to **171**. What changed is
a default, and defaults are harder to notice than contracts.

**CC v2.1.232 turns fork mode on by default in interactive sessions, and removes
the Agent tool's `run_in_background` parameter with it.** A subagent's result now
arrives as a notification on a later turn, and the model cannot ask for the
foreground. bkit's skill path is unaffected — v2.1.31's `background: false` on the
eight `context: fork` skills still holds, confirmed in the binary rather than
inferred, because the skill's background decision never consults the fork gate.
The Agent-spawn path is affected, and five sprint sites await a result inside the
turn that spawned it.

Ten items were carried over from earlier cycles rather than renumbered. ENH-420
through ENH-439 had produced exactly one landed item across two releases while
the ledger advanced to 473; assigning fresh numbers to the same work is how that
happens.

#### Withdrawn

- **ENH-432** — **"PostToolUse continueOnBlock" was not unimplemented. It was
  unimplementable.** `continueOnBlock` is a configuration field on a PROMPT-type
  hook definition, confirmed at three places in the v2.1.232 binary: it sits among
  the `PromptHookSchema` keys, its `describe` text reads "for this specific prompt
  evaluation", and the consumer reads it off the hook definition object inside the
  "Prompt hook condition was not met" branch. All 28 bkit hook handlers are
  `"type": "command"`. No bkit hook can carry the field.

  It was advertised on four surfaces: the differentiation table, the marketplace
  description a user reads before installing, a code comment claiming the emission,
  and a dedicated `post_tool_block_recorded` action type that nothing ever wrote
  (ACTION_TYPES 41 → 40). bkit now claims five differentiations.

  The test that let it survive matters more than the claim. C-07 asserted that the
  string "PostToolUse continueOnBlock" appeared in a markdown file — true of a
  claim nobody implemented, true of a claim nobody can implement, true of a claim
  that is simply wrong. A regex over source text does not verify a feature. Its
  replacement asserts that every hook handler is still command-type, so if bkit
  ever ships a prompt hook the claim can be re-examined on evidence.

#### Fixed

- **ENH-437** — the CC version check had no upper bound. `MIN_VERSION` and
  `RECOMMENDED_VERSION` are both floors, so every release above the recommendation
  was graded `ok` and `renderCCVersionWarning()` returns null on `ok`. bkit held
  its recommendation at v2.1.220 across five CC releases while classifying
  v2.1.232's fork default as unvalidated, and said nothing, because there was no
  branch in which it could. `KNOWN_ISSUES` is a range list rather than a version
  list — a changed default persists into every later release — and an entry
  suppresses itself when a documented mitigation is already set.

- **ENH-477** — **G-005 had never fired for the file it names, and had been firing
  on ordinary JavaScript instead.** `\b` is a transition between a word and a
  non-word character, and the character before a leading `.` is a space, a `/`, or
  the start of the string. Measured against the shipped rule: `.env`, `cat .env`
  and `./.env` produced no match, while `process.env.NODE_ENV` and
  `import.meta.env.VITE_KEY` matched. Wrong in both directions at once, which is
  why neither half surfaced as a complaint — the false negative is silent by
  construction, and the false positive looked like the guard working. v2.1.36's
  false-positive audit did not catch it because its corpus was Bash commands, and
  `process.env.X` arrives through `content` on an Edit.

- **ENH-481** — the Write/Edit path tested `rule.pattern` and nothing else,
  skipping `suppressIf` entirely, so both suppressed rules answered differently
  depending on which tool carried the payload. `ls -la ./certs/server.pem` was
  exempt under ENH-445 for a Bash command and was not exempt here. Found while
  fixing G-005, when a suppressor that returned true for its segment did not
  suppress the rule. Same class as ENH-441.

- **ENH-476** — four of the five ways a gap measurement can fail to happen
  returned `matchRate: 0, measured: true`, which asserts two things that are both
  false. The cost was not only the wrong number: `isMeasured()` accepts any finite
  matchRate, so a 0 from `parse_fail` looked like a real measurement and the
  iterate loop ran auto-fix up to maxIterations against a gap list whose one entry
  was "no JSON in output". Reported honestly the loop exits at once and still
  fails the gate. ENH-412's ruling on an unusable number inside valid JSON stands.

- **ENH-433** — `outputAllow` printed bare text for every event except two, and
  Claude Code writes that to the debug log rather than showing it to the model.
  26 of 32 call sites passed a non-empty message on such an event. The nine events
  that document `additionalContext` now deliver through it; the rest still print,
  because Claude Code logs it and bkit's Stop tests read the line as a liveness
  signal, but the debug entry says it was not delivered. What changed is the
  belief, not the bytes.

- **ENH-434 / ENH-480** — 23 agent frontmatter declarations across six keys Claude
  Code does not read. Plugin-bundled agents skip frontmatter validation, so each
  loaded and was ignored: `skills_preload` (4, the field is `skills`, and three
  agents had no `skills` key at all so six preload entries never loaded — including
  code-analyzer's, which runs the PDCA Check phase), `linked-from-skills` (10, a
  reverse index of a link already live in the other direction), `imports` (4, whose
  resolver accepts agent files but whose callers all pass a skill path, and Claude
  Code loads agent definitions so bkit has no injection point), `context` and
  `mergeResult` (2 each, skill fields that made two agents look like fork agents),
  `when_to_use` (1, merged into `description`).

#### Added

- **ENH-477** — three guardrail rules for git commands that destroy work, taking
  the rule set to 19. G-016 `git clean -f*` deletes untracked files with no reflog
  entry to recover from; G-017 covers the three spellings that discard uncommitted
  work, graded `ask` to match `git reset --hard` rather than grading one
  consequence three ways; G-018 covers expiring the reflog and pruning now, which
  destroys the safety net the others depend on.

  `--amend` and `--no-verify` are deliberately NOT guarded, and the tests say so.
  An amended commit survives in the reflog and publishing the rewrite needs a
  force push, which is G-002; `--no-verify` bypasses a check and destroys nothing.
  Adding them would have regressed v2.1.36's twelve-false-positives-to-one.

- **ENH-421** — `scripts/cc-binary-equivalence.js`. Three cycles reconstructed the
  same binary measurement by hand and twice got the command form wrong first. The
  script reproduces cycle #37's hand measurements exactly, in one read per build
  instead of one grep per needle, and carries each erratum beside the line that
  enforces it.

- **ENH-420 / ENH-422** — the opaque-release protocol and binary provenance, in
  the skill. CC v2.1.226 shipped one non-specific bullet, which leaves a cycle to
  either invent an answer or measure one. The provenance record's last field is
  the platforms NOT examined: `GIT_SHA` moved between 225 and 226 while the bundle
  did not, so the honest claim is scoped to one binary.

- **ENH-474** — a `fork` layer in the live QA harness. Every existing case runs
  with `-p`, which is exactly where fork mode is off, so the harness could not
  reach the surface whose default changed. `CLAUDE_CODE_FORK_SUBAGENT=1` puts a
  scripted session on the same path, and the layer proves the gate is live before
  asserting anything under it. Measured live: 5 pass, 0 fail.

- **ENH-475** — `lib/domain/policy/fork-mode-advisory.js`. Five spawn sites
  described the symptom ("no JSON in output", "expected { output: string }", and
  in auto-fixer's case nothing at all). The advisory names the likely cause and
  the remedy, as a lead rather than a diagnosis — bkit cannot observe fork mode —
  and suppresses itself once a documented mitigation is set.

#### Recorded, not fixed

- **ENH-482** — no Stop script uses `outputStopSurface`; all seven emit through
  `outputAllow(msg, 'Stop')`, so unified-stop.js's next-action hint has never
  reached the model. The only channel that would deliver it is
  `{decision:'block', reason}`, which forces the turn to continue. Turning every
  clean stop into a continuation is a product decision, and making it as a side
  effect of an output-routing fix would be the wrong way to decide it.

#### Docs = Code

Consecutive compatible releases 170 → **171**. Guardrail rules 16 → **19** (ADR
0016 in both languages, AI-NATIVE-DEVELOPMENT). Lib modules 199 → **200**, scripts
62 → **63**, ACTION_TYPES 41 → **40**, across README, README-FULL,
CUSTOMIZATION-GUIDE, AI-NATIVE-DEVELOPMENT and marketplace.json. The historical
counts in README and CHANGELOG describe what the v2.1.36 audit covered and are
left alone: a count that states current fact and a count that records history are
different claims.

`docs/` bilingual completeness restored — a repository-wide audit found exactly
one unpaired base of 56, and `cc-v2225-v2226-impact-analysis.report.en.md` closes
it (ENH-436).

Reports: `docs/04-report/features/cc-v2228-v2232-impact-analysis.report.{ko,en}.md`.

### Permission-mode awareness

### Headline

**bkit reinstated a confirmation step the user had explicitly switched off.**

Claude Code sends `permission_mode` on every hook event. Through v2.1.36, bkit
read it in exactly zero places:

```
$ grep -rn "permission_mode" scripts lib hooks agents skills
(0 results)
```

So all ten of bkit's decision surfaces behaved identically whether the session
had asked for maximum oversight or had turned confirmation off.

This is **not** a Claude Code defect, and that had to be established before
anything was changed. PreToolUse hooks run *before* the permission prompt, so a
hook decision is not something `bypassPermissions` can bypass. Measured with a
throwaway project containing one hook that returns `ask` and nothing else, no
bkit present:

```
claude -p --dangerously-skip-permissions "Run the bash command: echo HELLO_FROM_BASH"
→ "permission_denials":[{"tool_name":"Bash","tool_input":{"command":"echo HELLO_FROM_BASH"}}]
```

A bare `echo`, stopped in bypass mode, by the host behaving exactly as
documented. bkit was the component ignoring stated intent.

**Why it mattered beyond annoyance**: a `PreToolUse` question needs a human
answer, and an unattended run has nobody to give one — so the agent stalls
rather than fails. Issue #148 measured that cost at ~15 minutes per incident.
`bypassPermissions` is the strongest available signal that nobody is watching,
which made this the most expensive place to keep asking.

### The measured before / after

7 permission modes x 21 commands, fed to the shipped hooks:

| | before | after |
|---|---|---|
| benign commands stopped | **14** | **0** |
| negative controls still refused | 49/49 | **49/49** |
| ask-grade rows that vary by mode | 0 — every column identical | 4 of 4 |

The middle row is the one that matters. A release that makes a guard quieter is
only credible if genuinely destructive commands are still stopped in the same
run — the point [@Sinclair-Seo](https://github.com/popup-studio-ai/bkit-claude-code/issues/148)
made in v2.1.36 after measuring a bogus green, now a permanent fixture of this
project's harnesses.

### What is and is not relaxed

The boundary is the decision's **grade**, never the mode alone:

| grade | example | relaxed? |
|---|---|---|
| `critical` | `rm -rf /`, force push, `curl … \| sh`, `DROP TABLE` | **never, in any mode** |
| `policy` | a CLAUDE.md directive, a denied path, a symlink escape | **never, in any mode** |
| `ask` | scoped `rm -rf ./build`, `git reset --hard`, push to `main` | suppressed in `acceptEdits`, `dontAsk`, `bypassPermissions` |

Claude Code draws the same line — even in `bypassPermissions` it keeps a circuit
breaker on removals targeting `/` and `~`. bkit has no reason to be looser than
its host. `auto` was not measurable here (account eligibility), so it is treated
as human-present rather than guessed permissive.

### Added

- **ENH-466** — `lib/domain/policy/permission-mode-policy.js`, a pure domain
  module holding the whole decision table. `parseHookInput()` now exposes a
  normalized `permissionMode`, and `outputAsk()` takes it as a third argument.
  Call sites check the policy themselves (that is where the audit context lives);
  `outputAsk` re-checks as a backstop for a call site added later that forgets to.
  An absent or unrecognized mode resolves to `default`, so older Claude Code
  builds keep today's behaviour exactly.

### Fixed

- **ENH-467** — the phase-9 deployment guard refused on the bare substrings
  `--force` and `production`, so `npm install --force` was a "Deployment safety"
  refusal with no route forward. Those two name a flag and an environment, not an
  operation; they now ask. The four that name a real destroy operation still deny,
  and a command carrying a dry-run flag produces no finding at all — the guard
  used to refuse the rehearsal its own advice recommended.
- **ENH-468** — the Zero-Script-QA guard carried its own nine-entry substring
  table, a second and cruder copy of rules the Destructive Detector already owns.
  Wrong in both directions: `rm -r ./tmp/qa-fixtures` was refused, while
  `chmod 777 /` was not in the table at all. It now delegates to the shared
  detector and contributes the one thing it knows that the detector does not —
  that a QA session is running.
- **ENH-469** — `pre-write.js` read `ctx.input.bypassPermissions`, a top-level key
  the measured payload does not contain. The ENH-263 guard's first condition tests
  that flag, so **it had never fired once since v2.1.10**. The wrong field name
  came from `cc-payload.port.js`, which documented a `permissions` object Claude
  Code has never sent; the typedef is corrected against a captured payload.
- **ENH-470** — G-007 ("Mass file deletion") matched the *word* `delete` or
  `remove` anywhere in a segment, so `grep -rn delete src a b c d e` — read-only —
  asked for confirmation, and so did `npm remove lodash react vue axios dayjs`.
  The verb must now be the segment's command head, seen through `sudo`,
  `VAR=value` prefixes and a path. Same defect class as #148, one level down:
  #148 fixed reading across command separators, this fixes reading across the
  command name.
- **ENH-471** — both regression guards export `removeWhen(ccVersion)`, true from
  CC v2.1.118, and nothing ever called it. On v2.1.231 they were still watching
  for regressions fixed 113 releases earlier. The coordinator now applies it,
  reading the version SessionStart already cached rather than spawning
  `claude --version` on the hook path. Shipped together with ENH-469 on purpose:
  reviving a dead guard without retiring an obsolete one would have started
  blaming a regression that no longer exists.
- **ENH-472** — `git reset --hard` was an always-deny in the PermissionRequest
  handler while the Bash guard graded it `ask`: two bkit surfaces disagreeing
  about one command. Removed, and for a reason specific to that event —
  PermissionRequest fires *because* a prompt is about to be shown, so a human is
  present by construction, and auto-denying takes the decision away from the one
  person who is definitely available to make it.
- **ENH-473** — found during the related-surface sweep, not in the report:
  searching for a dangerous string was graded as performing one. A `grep` for two
  rule patterns was refused as "Recursive delete; SQL table drop" while this
  release was being written. A segment is now exempt only when its command head
  is a search tool with no write mode (`echo` is deliberately excluded — it is how
  `echo "…" | sh` starts) **and** it carries no shell metacharacter outside
  quotes. Quote-awareness is load-bearing: `grep -rlE "DROP|rm" lib` holds a `|`
  inside a regex, and reading it as a pipe would have left the commonest form of
  the false positive unfixed.

### Test coverage

- **148 test files ran nowhere** — neither `test/run-all.js` nor any workflow
  referenced them. Run by hand, 147 passed and one failed: `component-inventory`,
  which was catching this release adding a lib module while two documents kept
  saying 198. All 148 are now registered. A test nobody runs is documentation
  with a `.test.js` extension, and it is the same failure v2.1.36 wrote down one
  release earlier — "two runners disagreeing about what 'all tests' means is how
  a gap hides" — except these had fallen out of *both*.
- New: `test/unit/permission-mode-policy.test.js` (the 6x3 table, exhaustive),
  `test/regression/enh-466-473-permission-mode.test.js`,
  `test/e2e/permission-mode-matrix.test.js` (the release acceptance matrix).

## [2.1.36] - 2026-08-12

> **One-Liner (EN)**: A Claude Code plugin that verifies AI-generated code against its own design specs.

> **Status**: Guardrail precision release, triggered by external dogfooder
> [@Sinclair-Seo](https://github.com/popup-studio-ai/bkit-claude-code/issues/148)
> (issue #148, 2026-08-12, bkit 2.1.35 / CC 2.1.228 / Node 22.22.0 / WSL2), who
> shipped a 12-case reproduction harness with negative controls. Reproduced
> exactly: 4 false positives, 0 missed controls. Auditing all 16 rules measured
> the defect class at roughly 3x the report — and found the same root cause
> producing **false negatives**, which is why this is a correctness release and
> not a comfort one.

### Headline

Every guardrail rule is written as one command's shape, but each was matched
against the whole input. `.*` and `[\s\S]*` ran past `&&`, `;` and newlines, so
tokens belonging to other commands in a chain were read as operands of the
dangerous one.

Measured on v2.1.35:

| direction | example | before |
|---|---|---|
| false positive | `git push origin feature-x && rm -f /tmp/scratch/note.txt` | G-002 **deny** |
| false positive | `cp a.txt b.txt && ls /` | G-008 **deny** |
| false positive | `dd if=/dev/zero of=./scratch.img … && echo "of=/dev/null"` | G-014 **deny** |
| **false negative** | `chmod 777 / ; ls` | **detected by nothing** |
| **false negative** | `DELETE FROM audit_log; SELECT 1 FROM t WHERE x=1` | G-010b defeated |
| **false negative** | `DELETE FROM audit_log -- WHERE` | G-010b defeated |

`chmod 777 /` is the command G-008's own comment cites as its reason to exist.
Appending `; ls` defeated it completely.

**Why it mattered beyond annoyance**: a PreToolUse block asks a question, and an
unattended run has nobody to answer it, so the agent stalls silently instead of
failing. The reporter lost ~15 minutes twice in one sprint, noticed only because
an idle-stall monitor was attached.

### Fixed

- **ENH-440** — rules are matched per command segment instead of against the
  whole input (`splitCommandSegments`, quote-aware). `|` is deliberately not a
  split point: a pipe is how G-012, G-013 and G-015 express their threat, so
  splitting there would blind exactly the rules that exist to catch it. SQL rules
  segment on `;` only, because a newline ends a shell command but not a SQL
  statement.
- **ENH-442** — G-004: `\b` is satisfied by a hyphen, so `merge` matched the
  read-only `merge-base`. `merge-tree` and `merge-file` were measured to have the
  same defect. `(?!-)` excludes git's plumbing spellings.
- **ENH-443** — G-013 grades by target (`findTargetIsBroad`), so a scoped
  find-delete asks instead of denying — parity with G-001's scoped `rm -rf`.
- **ENH-445** — G-006 no longer fires on `ls -la ./certs/server.pem`. Listing a
  key is not reading one; every reader and copier still fires.
- **ENH-446** — G-010b's negative lookahead is evaluated against one statement,
  and SQL comments are stripped first. `--` must be followed by whitespace to
  count as a comment: without that condition the stripper read the shell flag
  `--command` as a comment and silently removed a real `DROP TABLE` from the
  matched text. The negative controls caught that regression before it left the
  working tree.
- **ENH-447** — G-007 stands down on SQL statements. `DELETE FROM audit_log
  WHERE id = 1` was being reported as a filesystem mass deletion.
- **ENH-448 / ENH-459** — the refusal message names only recourse that exists,
  and the recourse now fits the rule that fired. The first attempt at this
  rewrote `getBlockMessage()` alone and reported the user-facing message as
  corrected — but that function has **no production callers**, so nothing changed
  for anyone. The text users actually see is built in `scripts/unified-bash-pre.js`,
  and it offered the same three lines for every rule, led by "Scope the command to
  a specific path" — meaningless after `curl … | sh`, `DROP TABLE users`, or
  `dd of=/dev/disk0`. Both sites now share one `alternativesFor()` helper.
- **ENH-460** — `push-event-guard` scanned the whole command line for force
  flags, so `git push origin feature-x && rm -f note.txt` was refused as a force
  push. The same root cause as ENH-440 in a different module; `REMOTE_REGEX` in
  that same file already bounded at `[^|;&]`, and only the flag scan was left
  unbounded.
- **ENH-461** — `heredoc-detector` had no critical pattern for the plainest
  execution vector. Measured: `bash <<'EOF' … rm -rf / … EOF` was **allowed**.
  `destructive-detector` elides heredoc bodies by design, and this file graded the
  plain interpreter form `warning`, which the hook audits and permits — each
  module correct alone, the payload passing between them.
- **ENH-462** — `detectPushCommand` reported `branch: 'origin'` whenever a flag
  preceded the remote, because the remote regex's character class included `-`.
  Harmless while nothing read `branch`; not harmless once the force verdict
  grades by target. Force pushes now grade: a protected branch denies, a topic
  branch asks.
- **ENH-464** — `.env.example` was refused as a secret. The `.env*` deny glob
  matched the file whose entire purpose is to be committed, so writing the
  template that tells the next developer which variables to set was blocked.
  The exemption is a closed list of conventional template suffixes
  (`.example`, `.sample`, `.template`, `.dist`); `.env.local`, `.env.production`
  and every other real environment file keep their deny.
- **ENH-463** — the hook collapsed the push guard's three verdicts into two.
  `ask` was emitted through the same call as `deny`, so every confirmation the
  guard computed was presented as a refusal — `git push origin main` was refused
  rather than confirmed. Same class as ENH-410: decided, then dropped.
- **ENH-453** — three `getConfig()` paths the config file never provided, each
  silently falling back: `automation.loopBreaker.maxPdcaIterations` (the setting
  lives under `guardrails.loopBreaker`), `pdca.automation.staleDays` (that
  section does not exist), and `automation.emergencyFallbackLevel` (never
  shipped, while `automation.emergencyStopEnabled` shipped and nothing read it).

### Added

- **ENH-449 / ADR 0016** — guardrail rules are immutable at runtime, and that is
  now written down. `test/security/integrity-verification.test.js` IV-09 already
  asserted it; the decision, its rationale and its costs are recorded rather than
  left implicit in a test name.
- **ENH-450** — `test/e2e/external-dogfood/sinclair-seo-148-guardrail-precision.test.js`
  absorbs @Sinclair-Seo's harness verbatim (Early Adopter Program Lifecycle
  Stage 4).
- **ENH-451** — `test/regression/enh-440-447-guardrail-precision.test.js`, 29 TC
  covering every defect class, both false-negative directions, nine negative
  controls, and the two new helpers directly.
- **ENH-454 / 455 / 456 / 457** — config keys reaching the code that names them:
  the seven `sprint.default*` values and `sprint.autoPause.armedTriggers`, the
  three `guardrails.loopBreaker.*` ceilings, `guardrails.checkpointOnPhaseTransition`,
  and `performance.promptCaching1h.envVar`.

### Changed

- **ENH-458** — thirteen config keys that no code reads now say so in the file,
  with the reason. `permissions.*` is the safe-default policy bkit *recommends*
  in Claude Code's syntax — bkit does not enforce it and Claude Code does not
  read this file. `blastRadiusLimit`, `checkpointOnDestructive`,
  `quality.{gateEnabled,metricsCollection,historyMaxDataPoints}`,
  `automation.gateTimeoutMs` and `contextSizing.minSprints` have no consumer and
  no specified behaviour; wiring them would mean inventing policy nobody asked
  for. `automation.maxConcurrentFeatures` duplicates the live
  `multiFeature.maxActiveFeatures`.
- `AI-NATIVE-DEVELOPMENT.md` claimed all 16 rules are "graded by target". That is
  true of two (G-001, and now G-013).
- `test/security/destructive-rules.test.js` said it validated 8 rules. There are
  16, and the header had said 8 since v2.1.10.

### Known behaviour change

A scoped `find … -delete` now **asks** where it used to **deny**. The reporter
expected no finding at all; grading it to ask matches what G-001 does with a
scoped `rm -rf`, and matches the direction they themselves suggested. Asking is
not what stalled unattended runs — denying was.

### Measured

| | before | after |
|---|---|---|
| 16-rule audit false positives | 12 | **1** (the intended grading change above) |
| Reporter's 12-case harness | 4 FP / 0 missed | **0 FP / 0 missed** |
| False negatives | 3 | **0** |
| Config keys read by nobody | 27 of 115 | **13, each documented** |
| `getConfig()` paths that never resolve | 5 sites | **1** (verified benign) |
| Test suite | 3794/3798 PASS, 0 FAIL | **3835/3839 PASS, 0 FAIL** (+41 TC) |

New tests were verified against the pre-fix tree: 19 of 29 regression assertions
and 4 of 12 harness cases failed there. A test written after the fix passes on
arrival and proves nothing.

### How the last seven defects were found

Everything above was verified against `detect()`, and 30 assertions passed. Then
28 ordinary developer commands and 8 ordinary file writes were fed to the **real
hook processes** — the only surface a user meets — with no assumption about which
guard would fire. That found ENH-448's false claim, ENH-459, and ENH-460 through
ENH-464, including two false negatives that a green unit suite had been sitting
on top of: `chmod 777 / ; ls` and `bash <<'EOF' … rm -rf / … EOF`.

Locked as `test/regression/enh-459-463-hook-path-guards.test.js` (34 TC), which
spawns the hook and reads its JSON. 13 of those fail against the pre-fix tree.

**Rule for future work**: a guard-module fix is not verified until the hook
hosting it has been run as a process and its output read. Module-level green is
necessary and not sufficient.

### ENH-465 — the local runner and CI now agree on what "all tests" means

This release reported "3870/3874 PASS, 0 FAIL" from `node test/run-all.js` and
pushed. CI then failed on L6 live-run freshness: `hooks/hooks.json` had changed
and the recorded hook-dispatch evidence no longer described what was being
shipped. The gate was right, and it was not reachable from the command every
contributor runs — **thirteen contract tests ran in CI and nowhere else**.

v2.1.34 had already written down what this costs, while moving six regression
files in the other direction: *"Two runners disagreeing about what 'all tests'
means is how a gap hides."* The contract layer had drifted the same way since.

All thirteen are now listed in `test/run-all.js` as well as in the workflow.
The duplication is deliberate: CI must not be the only place a contract is
checked, and a contributor must be able to reproduce a CI failure locally.
Suite totals move 3870/3874 → **4360/4364**, which is the size of the gap.

### Credits

**[@Sinclair-Seo](https://github.com/popup-studio-ai/bkit-claude-code/issues/148)**
— reproduction script with negative controls, precise file:line root-cause
analysis for all three reported rules, and the observation that made the
severity clear: an unattended run has nobody to answer a prompt. Thank you.


## [2.1.35] - 2026-08-10

> **One-Liner (EN)**: A Claude Code plugin that verifies AI-generated code against its own design specs.

> **Status**: Correction release. An outside contributor sent a one-file
> `execSync` → `execFileSync` hardening patch. Reproducing its claim found that
> the vulnerability it reported was not reachable — and that two real defects had
> been shipping in that same file since v2.1.12, one of which had bkit telling
> users, in writing, something about Claude Code that is not true.
>
> As in v2.1.34, every claim below is a recorded run against a real Claude Code
> runtime or real `git`, not an inference from source.

### Fixed

- **bkit told you its hooks might not work in a git worktree. They work.**
  The advisory read *"git worktree detected — Claude Code hooks may not fire
  (issue #46808). Run bkit from the primary repository if hook-driven automation
  is required."* Measured on Claude Code 2.1.226: a live
  `claude -p --plugin-dir` session inside a linked worktree dispatched
  `SessionStart`, `InstructionsLoaded`, `UserPromptSubmit`, `Stop` and
  `SessionEnd` — the identical set to a matched control session in the primary
  checkout of the same repository.

  The claim was never measured, and the issue behind it does not say what bkit
  said it says. [anthropics/claude-code#46808](https://github.com/anthropics/claude-code/issues/46808)
  is **closed as not planned**, and its subject is project-level
  `.claude/settings.json`, which Claude Code resolves relative to the working
  directory. bkit ships its hooks in plugin `hooks/hooks.json` — a different
  configuration source, loaded when the plugin is enabled.

  Detection is kept, because a linked worktree genuinely can be missing
  project-scope `.claude/` configuration when that directory is untracked or
  gitignored. What is gone is the claim about bkit's own hooks, the citation of
  a declined issue as a live defect, and the advice to leave the worktree. The
  flag file now records `bkitHooksAffected: false` and a `verifiedOn` runtime
  version, so the next reader can re-measure instead of inheriting the claim.

- **A subdirectory of an ordinary checkout was reported as a linked worktree.**
  `git rev-parse --git-dir` answers with an absolute path while
  `--git-common-dir` answers relative to **the current working directory**; the
  code resolved both against `toplevel`. From `repo/sub/deep`, git returns
  `../../.git`, which is correct against `sub/deep` and meaningless against
  `repo/` — so the two never compared equal and every subdirectory looked like a
  worktree. Symlinked checkouts (`/tmp` → `/private/tmp` on macOS) failed the
  same way.

  Detection now asks git for absolute paths directly
  (`--path-format=absolute`, git ≥ 2.31) with a fallback that resolves against
  the base git actually used, and compares through `realpath`. Verified across
  8 topologies — main toplevel, main subdirectory, worktree toplevel, worktree
  subdirectory, submodule, bare repo, non-git directory, symlinked path — with
  zero mismatches. Both superseded implementations are re-implemented inside the
  test suite as a negative control, so the suite provably fails if either
  returns.

- **The advisory flag file bypassed bkit's own path resolver.** It was built
  from bare `process.cwd()` while every other bkit state file goes through
  `STATE_PATHS` and honours `CLAUDE_PROJECT_DIR`. Combined with the defect
  above, a session started in a subdirectory wrote a stray
  `.bkit/runtime/worktree-warning.flag` that nothing reads. `detectAndWarn(cwd)`
  also silently ignored its own `cwd` argument; it no longer does.

- **A quality gate could fail because bkit was running.** `SB-011` compared two
  reads of the developer's live `.bkit/state/`, taken ~80 lines apart — and a
  bkit session running in the repository rewrites `trust-profile.json` between
  them. Observed on this branch as `control: 38, engine: 50`, passing on the
  next run. v2.1.33 had already removed a hardcoded constant from this assertion
  with the note *"a test that passes or fails based on accumulated local state
  is not a test"*; it removed the constant and left the state dependence. Both
  readings now come from one child process pinned to an empty
  `CLAUDE_PROJECT_DIR` — deterministic at 38/38 across consecutive runs, and
  identical on a fresh clone and in CI.

- **The test runner listed four files it could not find, and counted them as
  skips.** v2.1.16's "31 stale test cleanup" deleted the files and left their
  entries in `test/run-all.js`. For 19 releases the generated report printed
  *"unit/context-loader.test.js: File not found"* under **Failures** while
  `runTestFile()` returned `failed: 0, skipped: 1` — so the report listed
  failures its own verdict did not count. The orphans are removed, a missing
  file now counts as a failure, and `test/contract/test-manifest-integrity.test.js`
  fails if the manifest and the filesystem disagree again.

### Changed

- **Every `child_process` call in shipped code now passes an argv array.**
  PR #146 converted one call site; seven remained, two of which interpolated
  variables into a shell string: `lib/defense/push-event-guard.js` (a remote
  name parsed out of the user's own `git push`) and `scripts/_v2119-s0-measure.js`
  (a GitHub handle inside a quoted `--search` expression). Neither was
  exploitable — the first is constrained by `REMOTE_REGEX` plus `shellEscape()`,
  the second reads a hardcoded list — but both are now argv, and the remote name
  is passed after a `--` separator so a leading-dash name cannot be read as a
  flag.

  This was already the project's policy. `lib/qa/test-runner.js` has carried
  *"C1 fix (audit): use execFileSync (no shell)"* since an earlier audit — as a
  comment in one file, which is why seven other call sites never received it.
  `test/contract/child-process-policy.test.js` now enforces it mechanically.

- **Claude Code version detection has one implementation instead of three.**
  `lib/infra/cc-bridge.js` and `hooks/startup/session-context.js` each spawned
  their own `claude --version` through a shell, alongside the correct
  argv-based one already in `lib/infra/cc-version-checker.js`. Both now delegate
  to a shared `detectViaSubprocess(timeoutMs)` helper and keep their own
  timeouts, because a SessionStart hook cannot spend what a CLI script can. The
  `2>/dev/null` that `cc-bridge` shelled out for is what
  `stdio: ['ignore','pipe','ignore']` already does.

### Added

- `test/unit/worktree-detector.test.js` (14 assertions) — the 8-topology
  detection matrix built against real `git`, the absolute-path contract, the
  advisory's three content guarantees, and `WT-14`, a negative control that
  re-implements both superseded versions and asserts each one gets the
  subdirectory case wrong. This restores coverage that CHANGELOG v2.1.12
  recorded as `test-scripts/unit/worktree-detector.test.js` — a path that has
  never existed in this repository, which is why the defect survived 22
  releases.
- `test/contract/child-process-policy.test.js` (5 assertions) — a scan floor so
  the check cannot silently match nothing, a ban on shell command strings and on
  interpolated command names, named assertions pinning the two historically
  risky call sites to argv, and the single-implementation rule for version
  detection. Negative control verified: reintroducing an interpolated `execSync`
  fails exactly two assertions.

### ENH

ENH-424, 425, 426, 427, 428, 429, 430, 431.

### Deferred

`WorktreeCreate` / `WorktreeRemove` registration (ENH-396/418) stays deferred on
the reasoning recorded in v2.1.33 — *"confirmed supported by Claude Code,
deferred for the hook-count cascade."* Nothing found in this cycle changes it:
this release removes an incorrect claim about worktrees; it does not add
worktree lifecycle management, and two more always-loaded hook events carry a
context cost this release has no evidence to justify.

### Notes for maintainers

- **ENH-383/403 status correction.** Analysis documents from the v2.1.33 cycle
  describe ENH-383 as unshipped. It was half-shipped: the `skipped[]` surfacing
  landed in `hooks/startup/restore.js` and `lib/core/paths.js`, and ENH-403's
  two-cause message distinction is in `paths.js` and listed in the v2.1.33
  CHANGELOG. The remaining half — *"the `worktree-detector.js` message is now
  misleading"* — is what this release closes.
- **Carried, not fixed.** Two observations from this cycle that did not reproduce
  well enough to act on, recorded so the next cycle does not rediscover them:
  - `HS-012/013/014` (hook cold-start < 100 ms) fail on the release machine at
    ~2.0 s. Identical on `main` at ~2.1 s, so this release did not cause it —
    and bare `node -e "0"` measures 0.51–0.62 s there, so the 100 ms budget is
    unreachable by any Node program on that host regardless of what bkit does.
    Treated as environmental. The budget itself may deserve to be expressed
    relative to measured interpreter start rather than as an absolute.
  - `CP-010` (checkpoint restore) failed once while 100+ live QA sessions ran
    concurrently, and passes 3/3 in isolation. Its temp directory is unique per
    process (`bkit-cp-test-${pid}-${Date.now()}`), so shared-directory
    interference is ruled out; the residual hypothesis is `PROJECT_DIR`
    resolution order under load. Not reproduced, so not claimed fixed.
  - The generated report counts a performance failure it does not list under
    **Failures** — the same listed-vs-counted mismatch fixed for missing files
    above, in a different code path.
- The semgrep finding that started this (`javascript.lang.security.detect-child-process`,
  HIGH) is a true description of the pattern and a false description of the risk
  at that call site: all three `safeGit(...)` callers pass module-internal string
  literals. The migration was kept and extended anyway, because removing the
  shell means a future caller cannot reintroduce the primitive.

### Credits

- **[@anupamme](https://github.com/anupamme)** — PR #146. A one-file security
  hardening patch that, on reproduction, turned into this release. The
  `execFileSync` migration is theirs and now covers the whole repository.

## [2.1.34] - 2026-08-09

> **One-Liner (EN)**: A Claude Code plugin that verifies AI-generated code against its own design specs.

> **Status**: Reachability release. v2.1.33 made bkit's defenses act when they
> fired. This one is about the hooks that never fired at all.
>
> Every finding below was reproduced against a real Claude Code runtime with
> `claude -p --plugin-dir`, not inferred from documentation. The reproduction
> harness ships with the release so each claim can be re-run.

### Fixed

- **Hook timeouts were 1000x too large on every event.** `timeout` is measured
  in **seconds**; bkit wrote milliseconds. `"timeout": 10000` on `Stop` meant
  2 hours 46 minutes, not 10 seconds, so a hung hook had no effective
  cancellation — the true root cause of issue #139, where a Stop hook stalled a
  session for ~15 minutes while "exceeding its own 10s timeout". v2.1.30 fixed
  that hook's blocking read; the unit error stayed armed on all 22 events.
  Verified: a 5-second hook survives `timeout: 30` and is killed at 2.26s under
  `timeout: 2`. All 28 handlers now declare 3–10s, and every one of them was
  measured against its own budget rather than assigned a number: five runs each,
  worst case 5.7%–38.4% of budget. The two guards where a timeout would matter
  most have the most room — `unified-bash-pre` uses 13.3% of its 5 s and
  `pre-write` 18.4%.

  **A shorter budget does not make hooks fire more often.** It decides how long
  a hook that has stopped responding is waited for. Measured on a throwaway
  probe plugin: a PreToolUse hook that is killed by its timeout **fails open**
  under `bypassPermissions` — the tool runs — and a hook that answers in time
  denies correctly in every permission mode. So a hung hook was never going to
  protect anyone; before this change it also stalled the session for up to
  166 minutes while failing to. That stall is issue #139.

  The one genuine trade-off: on a pathologically slow machine a handler that
  previously completed late now gets killed, and in auto mode that is a silent
  fail-open. `SessionEnd` was the only budget thin enough to worry about — 768 ms
  measured against 2 s, and this release's own performance suite had already
  caught that handler crossing 1 s under load — so it was widened to 5 s. Losing
  the session record silently is worse than waiting five seconds to close.

- **The `FileChanged` hook never ran once, in any release since v2.1.1.** Three
  independent causes, each confirmed: it declared `if: "Write|Edit(...)"`, but
  `if` holds exactly one permission rule and rejects `|` alternation (the same
  string suppresses a hook on a *valid* tool event too); `if` is evaluated only
  on tool events, and `FileChanged` is not one; and `FileChanged`'s matcher
  names literal files to watch, so the `docs/**/*.md` glob this handler needs
  cannot be expressed on that event at all. The capability moved to
  `PostToolUse(Write|Edit)` — the event that actually describes reacting to
  Claude editing a document — as `scripts/pdca-doc-changed-handler.js`.

- **`once: true` on `SessionStart` was silently ignored.** It is honoured only
  in skill frontmatter, never in a plugin's `hooks.json`. Confirmed by resuming
  a session and watching the hook fire a second time. The key is gone; it
  promised a guarantee the host never made.

- **`SKILL.md` edits were never linted and document edits were never
  post-processed.** `if` accepts one rule, so `if: "Write(skills/**/SKILL.md)"`
  under a `Write|Edit` matcher covered only `Write`; and `PostToolUse` matched
  `Write` alone, so `unified-write-post.js` (PDCA tracking, template
  validation, reachability ping) never ran when Claude used `Edit` — the common
  case for an existing file. Both now declare one handler per tool.

- **A recursive delete was refused no matter what it pointed at.** `G-001`
  matched `rm -r` regardless of target, so clearing a scoped temporary directory
  was refused exactly as hard as clearing `/` — while the refusal advised
  "scope the command to a specific path", which the rule made impossible to act
  on. The rule now grades by target: a broad one (`/`, `~`, `$HOME`, a glob, a
  system directory, an unresolved variable) still denies; a specific path asks.
  `ask` needed building, because bkit had only two outcomes and grading a
  command down to a silent `allow` would have been a relaxation rather than a
  fix.

- **Two guards blocked ordinary work.** Writing a commit message that merely
  *mentioned* a blocked pattern, and piping documentation through
  `python3 - <<'PY'`, were both refused as critical — the detectors read heredoc
  bodies as if they were command lines. Quoted heredoc bodies are now treated as
  the data they are, while the terminator line is kept whole, since a known
  bypass writes its exec vector there (`EOF-1 | bash`). Unquoted heredocs still
  expand at runtime and are left fully visible.

- **Four destructive-command bypasses.** Probing the shipped rules found
  `eval "$(echo <base64> | base64 -d)"`, `find / -delete`, `dd of=/dev/disk0`
  and `curl … | sh` all returning `allow`. Now `G-012`–`G-015`, each with a
  regression test naming the payload it blocks.

- **`lint-skill-md` still used the pattern behind issue #139.** v2.1.30 replaced
  `fs.readFileSync(0)` centrally; this handler kept its own copy, and with it the
  unbounded stall.

### Changed

- **Hook counts now describe what is proven to fire, not what is registered.**
  22 events / 25 blocks → **21 events / 24 blocks across 28 handlers** — one dead
  event removed while handler coverage grew, because `Write|Edit` now needs a
  handler per tool. The reduction is an audit result, not a scope cut:
  `FileChanged` was retired through an explicit `deprecation-registry.json` entry. Hook events may
  now be removed only through that registry, mirroring ADR 0014 for
  agents/skills/MCP tools: silent removal still fails the contract test, a
  declared removal records why.

- **The 8-language trigger vocabulary moved into code** (issue #129, open seven
  months). The keywords lived in two places: `lib/intent/language.js`, where
  bkit's intent-router reads them for free, and every agent/skill `description`,
  which Claude Code loads for the whole session. The expensive copy was the
  complete one and the free copy covered 12 of 34 agents and 16 of 44 skills.
  `lib/i18n/trigger-keywords.js` now carries all 1,515 keywords, frontmatter is
  English-only and free of CJK entirely, and every language still routes.
  Moving them surfaced three routing defects that had been inert while the
  keywords sat unused in frontmatter:

  - The `/bkit` help skill owned a bare `기능` ("feature"), so
    "회원가입 기능 만들어줘" reached help instead of `/dynamic`. A help surface
    must never be the greediest matcher.
  - **39 keywords ended in a sentence period** — `"제어."`, `"롤백."` — captured
    from the last entry on each `Triggers:` line. They looked alive and could
    never match. This was a defect in the GENERATED table, introduced by the
    extraction and caught before release; the hand-curated table already carried
    those keywords correctly, so no user was ever affected. Recorded because the
    generator is the thing that will run again, and `TL-CLEAN` now rejects a
    trailing period outright.
  - The vendor-specific `bkend-*` skills had lost their vendor token on the
    non-English side, leaving bare `인증`, `로그인`, `회원가입`, `테이블`. Once
    the period cleanup made those matchable, a generic signup request routed to
    a BaaS documentation skill. Every `bkend-*` keyword now names bkend.

  Each is locked by a guard in `trigger-locale-contract`: no trailing
  punctuation, no single-character CJK keyword, no vendor skill capturing a
  generic prompt.

- **The product one-liner drops "The only".** GitHub Spec Kit documents
  `/speckit.converge` as "Assess the codebase against spec/plan/tasks", so the
  superlative was disprovable in one search — and until this release it was also
  untrue of bkit itself, which reported a perfect match for a feature that had
  neither design nor implementation.

- **Destructive commands that declared a confirmation now raise one.** This is
  the most noticeable behaviour change in the release. Ten rules have carried
  `defaultAction: 'ask'` since the rule table was written; the hook read only
  `severity === 'critical'`, so those ten were detected, written to the audit
  log, and then permitted without a word. From v2.1.34 they prompt:

  | Command | Before | After |
  |---|---|---|
  | `rm -rf ./tmp/build` | refused as critical | **asks** |
  | `rm -rf /`, `rm -rf ~`, `rm -rf $HOME` | refused | refused (unchanged) |
  | `git reset --hard HEAD~1` | ran silently | **asks** |
  | `git merge main`, `git push origin main` | ran silently | **asks** |
  | access to `*.pem` / `*.key` files | ran silently | **asks** |
  | `npm test`, `git status`, `git push origin <branch>` | ran | ran (unchanged) |

  Ordinary work is deliberately untouched — a confirmation tier that interrupts
  `npm test` gets switched off within a day, and takes the refusal tier with it.
  A regression suite runs the shipped hook against both lists so neither can
  drift. There is deliberately no environment variable to mute the tier: if a
  rule asks too often, the rule is wrong and should be narrowed, not silenced.

- **Hook failures are now visible.** The hook layer holds 333 catch blocks and
  188 swallow without a trace. Most are legitimately best-effort, but a layer
  where every failure is silent is one where working and broken look identical.
  Crashes are recorded centrally and surfaced once at the next session start;
  control flow is untouched, so an uncaught exception is still fatal.

### Added

- `test/contract/hooks-config-contract.test.js` — validates `hooks/hooks.json`
  against the Claude Code hook specification: timeout unit and bounds, `once`
  placement, one-rule-per-`if`, `if` only on tool events, event names, matcher
  support, handler resolution, and count parity with the SoT. Verified against
  the v2.1.33 configuration, where it reports the three defects above.

- `test/contract/host-integration/hook-dispatch.test.js` — the new L6 layer.
  Runs a real `claude -p --plugin-dir` session and asserts from the outside that
  Claude Code dispatched each hook, including that `PostToolUse` fires for
  `Edit` and not only `Write`.

- `test/qa-harness-full-live.js` — exhaustive live QA across every surface: 44
  skills as slash commands, 34 agents as dispatch targets, 21 hook events as
  observed dispatches, 19 MCP tools over a real stdio handshake. Sampling cannot
  find a dead surface, because a dead surface looks exactly like an unsampled
  one. `--layer` narrows a run; `--list` prints the plan.

- `test/contract/shipped-scripts-parse.test.js` — every shipped shell script
  must pass `bash -n`, carry no expanded-heredoc corruption, and hardcode no home
  directory. v2.1.33's live-QA harness shipped with a syntax error, referenced by
  nothing, so it could not be caught.

- `test/contract/trigger-locale-contract.test.js`,
  `test/regression/destructive-bypass.test.js`,
  `test/regression/hook-failure-observability.test.js` — regression locks for the
  trigger relocation, the four proven bypasses plus the two false positives, and
  crash observability.

### Found by review of this release itself

An independent review pass over this branch found three defects the release had
introduced, and one it had committed while writing its own records. All are
fixed here; each is listed because the pattern matters more than the individual
bug.

- **The crash recorder silenced crashes.** `installCrashRecorder` registered an
  `unhandledRejection` listener, which SUPPRESSES Node's default — fatal since
  Node 15. Measured: without the listener a rejecting hook exits 1 and prints its
  stack; with it, exit 0 and silence. The mechanism built to end silent failure
  had introduced a new one. Now uses `uncaughtExceptionMonitor`, which observes
  without altering the default.

- **Heredoc body elision became a bypass.** Treating any `<<` as a heredoc
  opener meant `echo "example: cmd << EOF"` started a bogus elision and every
  line up to the next `EOF` was discarded — including a real destructive
  command, which then went undetected. The scanner is now quote-aware.

- **A guard test proved nothing.** The live destructive-command check asserted
  only that the target file survived. If the model simply declines to run the
  command, that passes without the guard ever firing. It now requires a recorded
  `destructive_blocked` audit entry, and reports the two outcomes separately.

- **A match rate was asserted, not measured.** Registering this cycle in bkit's
  own PDCA state wrote `matchRate: 100` — a number no gap-detector produced. That
  is precisely the fail-open this release removed from the sprint adapter, and it
  is now `null` with `measured: false` and a note saying why.

A second review pass, after the fixes above, found nine more. Six are defects in
shipped behaviour that predate this branch; three the branch introduced. They are
listed together because they are one pattern — a value or a decision that exists
in the code, looks configured, and reaches nothing.

- **A gap analysis that measured nothing reported 0%.**
  `scripts/gap-detector-stop.js` parsed the match rate as
  `match ? parseInt(...) : 0`, so a parse failure became a measurement. The
  fabricated 0 was written to `.bkit/state/pdca-status.json`, recorded as an M1
  and M4 data point, published as a generated `docs/03-analysis/<feature>.
  analysis.md` headed "Match Rate: 0%", audited as `gate_failed`, transitioned
  the state machine to `ITERATE`, and shown to the user as "Significant
  design-implementation gap detected". Observed on this very branch: the hook
  wrote a 0% analysis document for a feature whose state this release had
  deliberately set to `matchRate: null, measured: false`. A fabricated 0 is in
  one way worse than the fabricated 100 removed earlier — it looks like
  diligence, so the reader starts rewriting code against a measurement that was
  never taken, and the iteration budget drains on a regex miss. There is now an
  unmeasured branch that records nothing, transitions nothing, and asks for the
  step that is actually missing.

- **Ten destructive rules declared `defaultAction: 'ask'` and none ever asked.**
  The hook branched on `severity === 'critical'` and did nothing otherwise, so
  `git reset --hard`, protected-branch operations, key-file access and
  mass-deletion patterns were detected, audited, and permitted in silence. The
  decision now comes from the rule table's own declaration. **This is a
  user-visible behaviour change**: those commands now raise a confirmation.

- **A confirmation could downgrade a refusal.** `outputAsk()` exits the process,
  and the ask was emitted where it was decided — before the heredoc-bypass
  guard, the push guard and the Memory Enforcer, all of which can deny. A
  command that both warranted confirmation and carried a `<<EOF | bash` bypass
  would have been offered as a yes/no prompt instead of being refused. The ask
  is now parked and emitted last, only if nothing stronger fired.

- **A scoped delete was graded by text belonging to other commands.**
  `deleteTargetIsBroad` read from the delete verb to the end of the input, so a
  `$PWD` four lines later made `rm -rf ./tmp/x` "broad" and it was refused as
  critical — while advising the user to scope the path they had already scoped.
  The scan now stops at the next command separator.

- **`code-analyzer` claimed the bare word "security" in eight languages.** Its
  trigger is the compound "security scan"; the generated vocabulary also emitted
  the head word, giving it an equal claim on `security-architect`'s identity
  terms. Combined with the next item, security prompts routed to the wrong agent
  in Korean, Spanish and German.

- **Implicit routing returned the first-declared match, not the best one.**
  `for (…of Object.entries(TABLE)) if (match) return` picks by table position,
  which has nothing to do with what the user meant. Ranking is now by matched-
  keyword strength. The contract test that covered this asserted only that
  *some* agent resolved, so it was green throughout.

- **A PostToolUse handler spoke on a channel the model does not read.** The
  relocated `pdca-doc-changed-handler.js` emitted plain text; on PostToolUse only
  `hookSpecificOutput.additionalContext` reaches the model. It also read
  `pdcaStatus.currentPhase`, a key the v3.0 state schema does not have. Five
  independent causes now closed; fixing any four would have changed nothing.

- **The test aggregate under-counted itself by 481 assertions.** `qa-aggregate`
  had no pattern for the `pass:N fail:N skip:N` format that 36 suites emit — every
  contract and regression suite added for this release among them — so it counted
  the single summary line as one passing assertion. Failures were still caught, so
  the gate never went green over a real failure; what it misreported was how much
  verification stood behind a green one. `node test/run-all.js` had the same blind
  spot from the other side, and never opened six regression files at all. Both
  runners now agree: 6,900 assertions across 369 files.

- **`.bkit/runtime/hook-dispatch.ndjson` compaction destroyed failure records,**
  keying on `(event, tool)` so every failure against one event collapsed to a
  single line — on exactly the busy sessions where failures are likeliest. The
  startup warning also had no recency window, so one failure warned forever until
  someone deleted the file; it now clears itself after 24 hours while the record
  survives.

- **A raw NUL byte shipped inside `lib/core/hook-dispatch.js`.** It parsed, it
  ran, and every test passed, because nothing in the suite looked at the bytes of
  a source file — the same blind spot that let an unparseable shell script ship
  one release earlier, one layer down. A source-integrity check now rejects raw
  control bytes across every shipped text file, and is proven against the real
  defect.

### Found by running bkit's own orchestrators

Requirement to use `/pdca` and `/sprint` had been deferred on the grounds that
the quality gate they depend on was itself under repair. Running them once the
repair was done paid for itself immediately.

- **`/pdca qa` had been permanently BLOCKED, and that hid a real defect.**
  `scripts/qa/pre-release-check.sh` exits 1 on any CRITICAL, and the dead-code
  scanner reported six. Five were the scanner reading COMMENTS as code: a JSDoc
  block documenting a module's calling site
  (`const { detect } = require('../lib/defense/heredoc-detector')`) was resolved
  as a real require against the wrong file, and `scripts/check-deadcode.js`
  failed against itself twice because the comment explaining its own regex
  carries `require('./foo')` as an example. **A gate that is permanently red is
  as uninformative as one that is permanently green** — and this one was
  concealing the sixth finding, which was genuine:
  `scripts/lib/sprint-handlers-core.js` required `./sprint-memory-writer` while
  the module sits at `scripts/sprint-memory-writer.js`, one directory up. Every
  sprint archive threw MODULE_NOT_FOUND into a best-effort catch, so the
  MEMORY.md auto-update never ran once. Both halves fixed; the scan now passes.

- **Thirteen production sites read PDCA state keys the v3 schema does not have.**
  Reading a renamed key is not a crash — it is `undefined`, which flows on as a
  falsy fallback and the feature it guards simply stops happening. The worst is
  in the busiest hook bkit has: `scripts/unified-stop.js` extracted `feature`,
  `currentPhase`, `nextPhase`, `matchRate` and `projectLevel` from keys that are
  all absent, so `feature` and `currentPhase` were permanently null — and they
  gate **four** module integrations: checkpoint creation before a phase
  transition, quality-gate recording, the state-machine transition, and the
  workflow-engine advance. All four have been unreachable since the v3
  migration, and nothing logged it, because a skipped `if (feature && phase)` is
  indistinguishable from having no active cycle. Also fixed: the manual-compaction
  guard that protects a live do/check/act cycle (never engaged), the
  `file_change_count` metric (never collected), the next-action engine's PDCA
  hints (never produced), the session-title phase component, and the
  code-review-stop suggestions.

  `scripts/pre-write.js` had carried a comment since v2.1.15 stating outright
  that `currentFeature` does not exist on v2/v3. Someone knew, fixed one site,
  and left twelve. `test/contract/state-schema-keys.test.js` now bans reads of
  retired keys across all 274 production files, scoped to status-object
  receivers so the state machine's own legitimate `currentState` is untouched.

- **`ctx.sprintStatus` in the next-action engine has no producer** anywhere in
  the repository, and its field names disagree with the sprint entity besides.
  Left in place and documented rather than deleted or cosmetically renamed —
  wiring a caller is a feature decision, and renaming fields would make dead
  code look alive without making it run.

- **The live-QA harness read its evidence before producing it.** The hooks layer
  provoked twelve events with deliberate triggers and then evaluated a ledger
  snapshot taken *above* the trigger block. Isolated probes fired TaskCreated,
  TaskCompleted, PreCompact and PostCompact; the harness reported all four
  "never dispatched" minutes later in the same repository. With the read moved
  after the triggers — and with the triggers corrected (TaskCreate rather than
  the Task tool; twelve chunked reads rather than one large file) — observed
  events went from **9 of 21 to 14 of 21**. The seven that remain each carry a
  measured reason rather than a guess, e.g. *"cd inside a Bash tool call changes
  that command chain only, not the SESSION working directory"*.

- **The Component Inventory in `CUSTOMIZATION-GUIDE.md` was four releases stale**
  (scripts 61 vs 62, lib/ 195 vs 198, test files "118+" vs 366, BKIT_VERSION
  2.1.13). `docs-code-sync.js` defaults to a single target, `plugin.json`, and
  the exclusion written for README/CHANGELOG release snapshots had silently
  generalised to two files stating current fact.
  `test/contract/component-inventory.test.js` now measures them.

### Found by the full-surface live QA re-run

All four layers were re-run as real `claude -p --plugin-dir` sessions after the
changes above, because the earlier pass predated them: **139 of 140** cases
(skills 44/45, agents 34/34, hook events 23/23, MCP tools 38/38). The one
non-pass is `qa-phase`, measured at 136 s and exit 0 in isolation — slow under
121 sequential sessions, not broken — now registered as long-running with that
measurement recorded beside it.

- **A heredoc pattern scanned past its own terminator.** The pipe-shell rule
  spans from `<<TAG` to `| <interpreter>` with a lazy
  any-character run between them, and that crosses newlines, terminator lines
  and any number of later commands. A heredoc that opened and closed cleanly,
  followed further down by an unrelated pipe, was therefore graded CRITICAL and
  refused. Reproduced against the session writing this release: a quoted python
  heredoc followed four lines later by an unrelated pipe into `python3 -c` was
  blocked as "pipe to a shell/interpreter". Same class as `deleteTargetIsBroad`
  reading to end-of-input, this time in a guard that refuses the user's own
  correct commands. Patterns now match per heredoc region; all three known
  bypasses — opener line, terminator line, quoted tag — still deny.

- **A routing claim in this release's own notes was unearned, and is withdrawn.**
  An earlier draft said `제어 레벨 바꿔줘` and `롤백 해줘` routed correctly "for the
  first time" after the trailing-period cleanup. Measured against origin/main:
  **they already worked.** The 39 broken keywords were in the GENERATED table
  this release introduces — a defect in new code, caught before shipping — not
  in the hand-curated table users have been running. Corrected here, in the PR,
  and in both QA reports. A release about unverifiable claims does not get to
  make one.

### Fixed — GitHub issues

- **#145** (reported by [@BrightGold70](https://github.com/BrightGold70), Hawk
  Kim): the ENH-310 heredoc guard denied quoted-tag heredoc bodies as critical.
  A quoted tag disables expansion — a bash language guarantee, not a heuristic —
  so `$(cmd <<TAG … TAG)` appearing in such a body is prose and cannot become
  shell syntax. It bit hardest when writing documentation *about the guard*,
  which is also how this release hit it independently. The reporter's exact
  reproduction is now a regression test. Verified: `critical`/`sub` before,
  `warning`/`lone-heredoc` (audit-only, not a refusal) after.

### Notes for maintainers

- New CI steps: hooks config contract, shipped-script parse, trigger locale
  contract, deprecation-registry schema, and L6 live-run freshness.

- **L6 is enforced without a CLI in CI, and does not pretend otherwise.** The
  live layer needs a real Claude Code session; the runner has neither the binary
  nor credentials, and installing them was considered and declined. An earlier
  revision simply set `BKIT_HOST_INTEGRATION=1` and ran the live test on CI,
  which meant the step always skipped while a wiring test called it green — the
  `validate-plugin --strict` / `continue-on-error: true` shape this release cites
  as its cautionary tale, recreated by the test written to prevent it.

  Instead, a live run records the events it observed plus the SHA-256 of the
  `hooks.json` it observed them against, into
  `test/contract/host-integration/last-live-run.json`. CI asserts that evidence
  still matches what ships. The enforced property is the one that matters:
  **`hooks.json` cannot change without someone re-running the harness and
  committing fresh evidence.** That is verified evidence re-verified on change —
  not a live session run by CI, and the wiring contract fails if the workflow
  ever claims otherwise.

  Regenerate with `node test/qa-harness-full-live.js --layer hooks --record`.

- `.bkit/runtime/hook-dispatch.ndjson` is a new per-project diagnostic file
  (append-only, self-compacting, ~0.69 ms per hook). Set
  `BKIT_HOOK_DISPATCH_RECORD=0` to switch it off; the host-integration tests and
  the session-start failure warning both read it.

## [2.1.33] - 2026-08-08

> **Status**: Enforcement release. bkit had several defenses that detected
> correctly and then did nothing — a destructive command was logged as
> `blocked` and executed, a denied path was described to the model and written,
> a failing test suite exited 0. This release makes them act. It adds no
> features; it makes the existing ones true.
>
> Originating from `/bkit:cc-version-analysis` cycle #34 (CC v2.1.224 → v2.1.225,
> 0 breaking changes on the Claude Code side). The findings were bkit's own.

### User-visible changes

- **bkit no longer names your session.** `ui.sessionTitle.enabled` now defaults
  to **`false`**. Issue #77 reported that bkit overwrote the session title on
  essentially every turn, so a name set in the Claude app or with `/rename` came
  back as `[bkit] <PHASE> <feature>` moments later. #77 was closed in v2.1.21 by
  adding a per-session tag, which fixed parallel windows showing identical titles
  but not the overwriting. Two causes, both fixed:
  - bkit never read Claude Code's `session_title` hook input, though the CC docs
    name that exact use ("A hook that emits `sessionTitle` can check
    `session_title` first to avoid overwriting a title the user set explicitly",
    `hooks.md:1039`). It now does, and treats any title it did not write —
    yours, or Claude Code's own summary — as final.
  - The dedup cache compared `action`. A skill Stop hook published with
    `action: 'PLAN'`; the next user prompt published with no action; the values
    differed, so it republished — and again on the next skill stop. Alternating
    between working and typing was enough to rename the session. `action` no
    longer takes part in the comparison.
  - **Migration**: if you want bkit to label sessions, set
    `ui.sessionTitle.enabled: true` in `bkit.config.json`. It still never
    overwrites a title you set yourself.

- **Blocked commands now say why.** The Memory Enforcer's deny path called
  `outputBlock('deny', reason, 'PreToolUse')` against a **one-parameter**
  function, so `reason` bound to the literal `'deny'` and everything computed —
  directive text, rule, source, matched pattern — was discarded. What reached
  the model was `{"decision":"block","reason":"deny"}`. With no stated cause the
  model's rational move is to retry, and Claude Code's auto mode pauses after 3
  consecutive blocks (aborting outright in headless `-p` runs). Blocks now carry
  the reason and concrete alternatives.

- **Destructive commands are actually blocked.** The detector wrote an audit
  entry saying `result: 'blocked'`, incremented the `destructiveBlocked`
  counter, and let the command run. It now blocks. It was also being called with
  `{ command }` where a string was expected, so rules matched against
  `{"command":"…"}` and every anchored pattern silently failed: `chmod 777 /`,
  `chown root /` and `mv /etc/passwd /` were **not detected at all** in
  production.

- **Heredoc bypass defense is no longer defeated by an absolute path.**
  `… | bash` was blocked, but `… | /bin/bash`, `| nice bash`, `| command bash`,
  `| "bash"`, `| \bash` and `| $SHELL` all fell to the warning tier, which is
  allowed through with an audit entry. Eight literal interpreter rules were
  replaced with three tolerant ones covering paths, quotes, backslashes, wrapper
  commands and interpreters resolved at runtime.

- **Denied file paths are enforced on Write/Edit.** Scope verdicts were advisory
  text appended to the model's context before the write proceeded. Explicit
  security rules (deny list, symlink escape, null byte) now block. Automation-level
  scope (`NOT_IN_SCOPE`) stays advisory on purpose — L0's allowlist is narrow
  enough that blocking on it would refuse ordinary edits.

- **Secrets are denied anywhere in the tree.** `.env*`, `*.key` and `*.pem` were
  effectively root-anchored and could never match a path containing a slash. At
  L4, `src/.env` was **allowed**. Paths are also matched after resolution, so
  `docs/../.env` no longer presents an allowed spelling for a denied location.

- **Your PDCA backup is no longer overwritten by another project.**
  `${CLAUDE_PLUGIN_DATA}/backup` carried no project segment, while
  `CLAUDE_PLUGIN_DATA` is namespaced per plugin *install*. Projects sharing a
  marketplace slot wrote to the same file on every `savePdcaStatus()` and the
  last writer won — observed on a real machine, two unrelated projects in one
  slot. Backups are now per project. When a pre-v2.1.33 backup turns out to hold
  another project's state, the message says your backup was overwritten rather
  than the misleading "backup belongs to different project".

- **The quality gate can no longer be undecidable.** `matchRate` accepted any
  `typeof === 'number'`, which admits `NaN`; both `>= 90` and `< 90` then
  evaluate false and a gate branching on either comparison falls through. Values
  are coerced to a finite 0–100, and an unmeasurable run reads as 0.

### Internal changes

- **CI can fail again.** Three independent mechanisms each made a red suite
  report green: `qa-aggregate.js` had no `process.exit` at all; the workflow
  piped it through `| tail -10` without `pipefail`, so the step's status came
  from `tail`; and the plugin-schema release gate carried
  `continue-on-error: true` while its own comment had promised strict mode since
  v2.1.21. All three fixed, and `test/contract/ci-gating-contract.test.js` now
  locks the property so it cannot silently return.
- **CI coverage 188 → 353 test files.** `TEST_DIRS` named three directories by
  hand and `findTestFiles` did not recurse. 143 files across 13 directories —
  including the entire `test/security` suite — had never run in CI. All of them
  passed; they were simply never wired in. Directories are now discovered.
- **Nine failures surfaced by that coverage, all resolved.** Six of them were
  stale count assertions; `ACTION_TYPES` alone carried six different expected
  values across the repo (19 / 29 / 16 / 29 / 40 / 40 against a live 41). Counts
  now come from `lib/domain/rules/docs-code-invariants.js`.
- **`EXPECTED_FAILURES` emptied.** Both entries were verified green and removed.
  A stale exemption suppresses everything a file reports: during this release an
  unrelated change broke `project-isolation.test.js` in 7 places and the
  aggregate still exited 0.
- Sprint Stop hook no longer reports a completion that did not happen. Running
  `/sprint master-plan <new-id>` printed `Sprint "<id>" — report → archived`
  with another sprint's summary, for a sprint whose state file did not exist.
  Three causes: the header id was not corrected when the fallback loaded a
  different sprint, `master-plan` was missing from the read-only action list, and
  `advancePhase` never settled `status` on reaching the terminal phase, leaving
  6 of 7 sprints permanently `active`.
- Count assertions that measured cardinality rather than coverage were rewritten
  to assert behaviour — an exact rule count fails when protection is *added* and
  stays silent when it is removed.
- Dead code removed from `scripts/unified-bash-pre.js` after a five-point
  no-op proof; archived locally under a git-ignored `.backup/`.
- `PRIVACY.md` corrected: it claimed bkit "does not make network requests of any
  kind", which stopped being true when the opt-in OpenTelemetry exporter was
  added. The exporter is off unless you set `OTEL_EXPORTER_OTLP_ENDPOINT`.
- `CUSTOMIZATION-GUIDE.md` no longer shows `{"decision":"allow"}` for PreToolUse;
  there is no such decision.

### ENH

ENH-388, 389, 390, 393, 397, 398, 399, 400, 401, 402, 403, 404, 407, 410, 411,
412, 417, 419.

### Deferred

ENH-395/384 (raising `RECOMMENDED_VERSION` from 2.1.220 — npm `stable` is
exactly 2.1.220, v2.1.225 resolved none of the tracked upstream issues, and
raising would import the #84892 and #84925 regressions), ENH-396/418
(`WorktreeCreate`/`WorktreeRemove`/`DirectoryAdded` registration — confirmed
supported by Claude Code, deferred for the hook-count cascade), ENH-405, 406,
408, 413, 414, 415.

## [2.1.32] - 2026-07-28

> **Status**: Claude Code v2.1.219/220 compatibility response, from the
> `/bkit:cc-version-analysis` cycle #30. v2.1.219 reversed v2.1.217 and made
> subagents spawn nested subagents to **depth 3 by default**. Combined with
> v2.1.218 moving `/code-review` to a background subagent, the main turn now
> routinely ends while subagents are still alive — which broke assumptions bkit
> had carried since v1.5.3. **Every defect below was reproduced before it was
> fixed**, using `claude -p --plugin-dir .` against CC v2.1.220 with a depth-2
> probe; none was inferred from the changelog.

### Team roster no longer wiped mid-flight (ENH-374)

- **Reproduced**: the Stop hook fired while subagents were still running,
  cleared the roster, and **4/4 subsequent `SubagentStop` calls logged
  "Teammate not found for status update"** — a 100% orphan rate. The next
  `SubagentStart` then re-initialised the state from scratch.
- **Root cause**: `cleanupAgentState()` was guarded only by `state.enabled`.
  That was correct while subagents ran in the foreground and always finished
  before the main turn; it no longer is.
- **Fix**: CC already supplies the signal — the Stop payload carries
  `background_tasks`, documented upstream as *"Lets hooks distinguish 'session
  is done' from 'session is paused waiting for background work to wake it'.
  Empty array when nothing is in flight."* bkit read it nowhere. New
  `io.hasInFlightBackgroundWork()` is the single source of truth, and all three
  cleanup sites (`unified-stop`, `cto-stop`, `team-stop`) are gated on it.
  Emptiness is the contract, so there is no status allowlist to drift. Absent
  `background_tasks` (CC < 2.1.218) preserves the historical behaviour.

### CC version detection was permanently dead (ENH-375)

- **Reproduced**: `.bkit/runtime/cc-version.json` held
  `{"version": null, "detectError": "spawnSync /bin/sh ETIMEDOUT"}`.
- **Root cause, two compounding**: the budget was a 200 ms `execSync` cap, but
  Claude Code now ships as a ~264 MB native binary and `claude --version`
  measured **302–327 ms** (5/5 runs) — detection could never succeed. The
  failure was then cached: the cache-read guard tested
  `typeof cached.version !== 'undefined'`, and `typeof null` is `'object'`, so a
  failed detection was served as a valid hit for the full 1 h TTL and re-cached
  itself. The CC-version advisory, the ENH-368 model-floor notice and the
  `RECOMMENDED_VERSION` warning therefore **never rendered** — which is how
  `RECOMMENDED_VERSION` drifted 20 releases without anyone noticing.
- **Fix**: new Strategy 0 reads the native installer symlink
  `~/.local/bin/claude`, whose target basename is the active version — one
  `readlink`, **0 ms vs 302–327 ms**. Only successful detections earn the 1 h
  TTL; failures expire in 60 s and retry. The subprocess fallback cap is raised
  to 1500 ms for npm/Windows installs where Strategy 0 does not apply.

### Roster identity matches what CC actually sends (ENH-376, ENH-377)

- **Reproduced**: the SubagentStart payload is `session_id, transcript_path,
  cwd, prompt_id, agent_id, agent_type, hook_event_name` — **no `agent_name`, no
  `model`, no `team_name`, no `tool_input`**. Depth-1 and depth-2 payloads are
  field-for-field identical, so there is no depth or parent key and the nesting
  tree cannot be reconstructed from this event.
- Every fallback chain therefore always hit its last branch: teammate names were
  the opaque `agent_id`, **every teammate was labelled `sonnet`** (18 of bkit's
  34 agents are not), `currentTask` was always `null`, `teamName` always `''`.
- **Fix**: `agent_id` is the identity, `agent_type` the display name, and the
  model is resolved from the agent's own frontmatter.
- Roster rows now key on `agent_id`, so two concurrent instances of the same
  agent — reachable since v2.1.219 — no longer collapse into one row where
  completing the first marked the second completed.
- `MAX_TEAMMATES` overflow was a `debugLog` and a bare return; it is now counted
  in `state.droppedTeammates`. The constant is single-sourced from
  `lib/core/constants.js` (it was declared twice) and remains distinct from
  `team.maxTeammates` in `bkit.config.json`, which bounds requested team size
  rather than roster capacity.
- `addTeammate`/`updateTeammateStatus` now use `state-store` `lockedUpdate`.
  `tmp`+`rename` made each write atomic but the read and write were not held
  together, so two concurrent hook processes could lose one.

### Nested-spawn documentation corrected (ENH-372, ENH-373)

- `agents/cto-lead.md` and `agents/pm-lead.md` told users Task() was *"blocked
  by CC's nested spawn restriction"*, under a heading pinned to **v2.1.69 — 150
  releases stale**. Both now describe the real behaviour and state that
  one-level dispatch is bkit's own convention, not a platform guarantee.
- The depth default resolves through `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` → a
  **remote feature gate** → a hardcoded `3`, so it can change server-side with
  no CC release. Setting the env var explicitly is the only deterministic bound,
  and is now documented as such.
- `cto-lead` and `pm-lead` each declare `Task(sprint-master-planner)` while
  `sprint-master-planner` declares `Task(cto-lead)`/`Task(pm-lead)` — two cycles
  that were unreachable at depth 1 and are now legal chains. Both directions are
  deliberate and documented, so **no edge was removed**; `sprint-master-planner`
  instead carries an explicit rule not to delegate back to its invoker.

### Loop breaker (ENH-378, ENH-379)

- **LB-013, a long-standing failing test, is fixed.** `reset('feature', target)`
  cleared only the in-process mirror while `getCounters()` reads the persisted
  bucket, so resetting one feature appeared to do nothing. The H3 cross-process
  migration updated `reset('all')` and `resetCounter()` but missed this branch.
  `loop-breaker` is now 15/15.
- `recordAction()` silently swallowed unrecognised action types.
  `unified-bash-post.js` had passed `'bash_command'` since v2.0.0 with no rule
  consuming it — a no-op under a block named for bash loop detection. The
  recording was removed rather than a rule invented (there is no config key and
  no design doc for one); `checkLoop()` is kept because it legitimately surfaces
  other runaway loops, and a `default` branch now makes the next mis-wiring
  visible.
- `team-protocol.registerSpawn` called `addTeammate` positionally against a
  function taking one descriptor object. Latent — no runtime caller, and the
  tests only asserted `typeof`.

### File lock could be stolen from its holder (ENH-380)

Found while QA-ing the roster serialisation above, not by reading the code.

- **Reproduced**: eight concurrent writers to the roster produced **seven rows**.
  Every worker reported success and no lock error, so the lock *was* being
  taken — and an update was still lost.
- **Root cause**: `lock()` creates the lock file with
  `writeFileSync(path, data, { flag: 'wx' })`, which is create-then-write. A
  competing process can read it in that window and see **zero bytes**.
  `JSON.parse('')` throws, the old code classified that as a *corrupt* lock,
  deleted it, and entered the critical section alongside the live holder.
- **A/B against main**, three trials each, eight concurrent writers:
  main `7/8, 6/8, 7/8` — fixed `8/8, 8/8, 8/8`.
- **Fix**: staleness is judged from the lock file's mtime, which needs no
  parsing and is set at creation. A lock mid-creation is milliseconds old, so it
  is waited on with the existing backoff; only a lock older than
  `LOCK_STALE_MS` is removed. A genuinely corrupt lock still recovers, on the
  same schedule as an abandoned one. The waiter now also honours the caller's
  timeout rather than looping to the retry cap.
- **Blast radius**: this is a pre-existing defect in a core primitive, so every
  `lockedUpdate` consumer was exposed — including `loop-breaker`'s cross-process
  counters, the ones ENH-378 had just repaired.
- New regression test spawns real concurrent processes, since a single-process
  test cannot open the window (`test/regression/v2132-lock-mutual-exclusion.test.js`,
  4 TC).

### Full-feature QA findings (v2.1.32)

Every bkit surface was swept, not just the ones this release changed: all 44
skill and 34 agent frontmatters, all 26 registered hook handlers fired with
realistic CC payloads, all 19 MCP tools driven over real stdio JSON-RPC, all 28
user-invocable skills invoked through live `claude -p --plugin-dir .` sessions,
8-language trigger routing, the state machine, quality gates, UI renderers and
the checkpoint round-trip. Two user-facing defects surfaced.

- **The SKILL.md linter hook crashed in every project except bkit's own.**
  `scripts/lint-skill-md.js` resolved its checker through `process.cwd()`, which
  is the *user's* project — so outside the bkit repository it threw
  MODULE_NOT_FOUND at module load and the PreToolUse hook exited 1 with an
  uncaught stack trace on every Write to a `skills/*/SKILL.md` path, against its
  own documented "Exit: 0 always (warning-only, never blocks write)" contract.
  `scripts/check-skills-docs-code-sync.js` had the same defect one level down;
  its single `ROOT` conflated the tree being checked with the location of bkit's
  own modules. Now split into `ROOT` and `PLUGIN_ROOT`, so CI behaviour is
  unchanged (44/44) while the hook path works anywhere. The linter also loads its
  checker lazily behind a guard so a missing checker degrades to a no-op.
- **`/btw` was unreachable.** Bare `/btw` answers "isn't available in this
  environment" — distinct from "Unknown command", so Claude Code knows the name
  and gates it; the string is present in the CC binary. A sweep of all 28
  user-invocable skills found this is the **only** collision (the other 27
  resolve bare), so `skills/btw/SKILL.md` and the `cto-lead` tip now advertise
  `/bkit:btw`, which works end-to-end.

Verified working with no change needed: 19/19 MCP tools, 26/26 hook handlers,
195/195 lib modules, 8-language trigger routing 12/12, state machine (25
transitions, invalid events rejected), quality gates M1–M10, all five UI
renderers, and checkpoint create/list.

### Test suite: 20 failing on `main` → 0 (v2.1.32)

Maintainer-approved scope expansion. All twenty predated this branch; none were
regressions. Two turned out to be real defects, the rest were assertions that had
stopped tracking deliberate changes.

**The workflow presets were a lost feature, not an overclaim.** An earlier draft
of this entry said the docs oversold them. That was wrong, and this section
replaces it. `test/unit/v200-workflows.test.js` (WF-001~020) and
`automation-first-v2.test.js` (AF-021~025) specify the three preset files and
their contents in detail — they were designed, then went missing, while the
engine at `unified-stop.js:412` returned `null` in every installation. Restored
from that specification plus `lib/pdca/workflow-parser.js`: **default** keeps all
nine PDCA phases at matchRate 90 / semi-auto, **hotfix** omits pm and design and
drops to 80, **enterprise** adds a parallel check fan-out carrying a
security-review branch (merged `all`) at 95.

**Two isolation defects made results depend on execution order.** The
`02-cc-regression` ledger tests isolated with `process.chdir()`, which never
worked — `lib/core/platform.js` captures `PROJECT_DIR` at module load, so the
tests were reading *and writing* the repository's own
`.bkit/runtime/token-ledger.ndjson`, and every suite run appended more. Likewise
`hook-runner` defaults to cwd = the bkit repo with no `CLAUDE_PROJECT_DIR`, so
`unified-stop.js` with an empty payload fell back to the active-skill marker and
PDCA status that other tests write; STOP-01 passed alone and failed in a full
run. Both now use throwaway project directories.

**`lock()` never created its parent directory** though `write()` always has, so
`lockedUpdate` on a path under a not-yet-existing directory threw ENOENT — the
normal state of a fresh project, where `loop-breaker`'s persisted counters
silently never accumulated because callers wrap the call in a catch.

**Twelve `lib/` modules carried no `@version`.** Each tag is the version the
module was actually introduced in, read from git history rather than stamped with
today's number.

**Stale contracts**, each pinning a value the code deliberately moved past: the
starting trust score is 38, not 40 (ENH-318 added a seventh component at weight
0.05 and rescaled the rest); `ACTION_TYPES` is 40, not 29; `VALID_ACTIONS` is 20,
not 17; the evals inventory is 32 skills / 13 workflow; `detectDocumentType`
returns `'analysis'` since the M1 audit fix; `GATE_MEASUREMENT_ROUTES` covers 8
agent-routed gates with `UNSUPPORTED_GATES` now empty; `QUALITY_GATE_FAIL` is
scoped to the phase's active gates; feature completion reads
`featureMap[f].completion`; `advancePhase`'s gate_fail result gained `hint` in
v2.1.22; `parseHookInput`'s absent sentinel is `null`, not `''`.

**The skill-description cap was a Claude Code v2.1.86 constraint** that is absent
from the v2.1.220 binary. Fourteen of 44 skills exceeded it, every one because of
its `Triggers:` block — the 8-language keyword lists implicit routing matches on
(verified 12/12 across ES/FR/DE/IT). Enforcing 250 meant deleting the keywords
that make non-English invocation work, so the cap moved to 500 (longest is
`enterprise` at 474) with the reasoning recorded in the test.

Also: four table rows in `skills/sprint/SKILL.md` carried Hangul in the body,
against the project's own English-only rule, and the state machine's transition
count was documented as 20 in six places where the code exposes 25.

### Compatibility

- **Recommended CC runtime raised to v2.1.220.** The cycle-#30 analysis
  recommended holding at 2.1.218 *pending* nesting containment; this release
  delivers it. v2.1.219 → 2.1.220 was verified as a no-op for every surface bkit
  integrates against (feature gates 1754/1754 identical; hook, subagent, plugin,
  skill, MCP and fork/background surfaces unchanged).
- `MIN_VERSION` 2.1.78, install floor 2.1.143, `FABLE_MODEL_FLOOR` 2.1.170 —
  unchanged.
- **0 breaking changes.** Consecutive compatible releases: **163**
  (v2.1.34 – v2.1.220).

## [2.1.31] - 2026-07-23

> **Status**: Claude Code v2.1.218 compatibility response (proactive, from the
> `/bkit:cc-version-analysis` cycle #29). CC v2.1.218 changed skills with
> `context: fork` to run in the **background by default** (opt out with
> `background: false`). bkit ships 9 fork skills — all silently affected on
> CC ≥ 2.1.218. **No Guessing**: the fix was grounded against the CC CHANGELOG
> and four verified GitHub issues, not inferred. The key finding reshaped the
> fix: `background: false` restores foreground *scheduling* but does **not**
> restore `AskUserQuestion` — that tool is stripped at the **fork sub-agent
> boundary** regardless of foreground/background (CC #34592, #46654, #54892),
> so a genuinely interactive fork skill must leave `context: fork` entirely.

### CC v2.1.218 Fork Background-Default Compatibility

- **Root cause (grounded, not speculated)**: `context: fork` runs a skill as a
  *foreground sub-agent*. CC v2.1.218 flips such skills to background by default.
  Separately and pre-existing, `AskUserQuestion` (+ `EnterPlanMode`, deferred
  tools) is unavailable in *any* sub-agent context — the CC sub-agents doc
  promises foreground pass-through, but issues #34592/#46654/#54892 (the last a
  reopened regression with a repro) show it is stripped at the fork boundary.
  Verified directly via `gh`; qa-phase was the only bkit fork skill declaring
  `AskUserQuestion`, and it invoked it 0 times in-body (a latent, degraded gate).
- **Fix 1 — 8 producer skills opt out of background-by-default**: `phase-1-schema`,
  `phase-2-convention`, `phase-3-mockup`, `phase-4-api`, `phase-5-design-system`,
  `phase-8-review`, `zero-script-qa`, `skill-status` each add `background: false`
  to their frontmatter, pinning pre-218 foreground execution (No Guessing: the
  execution mode is now explicit, not inherited from a changed CC default).
  Backward-safe — CC < 2.1.218 ignores the unknown key; 2.1.218's boolean parser
  accepts it.
- **Fix 2 — qa-phase leaves the fork set (main-context interactive gate)**:
  `qa-phase` drops `context: fork` so it runs in the main session context, where
  `AskUserQuestion` works. Its PRE-SCAN CRITICAL "continue/abort" gate is upgraded
  from a degraded plain-text fallback to a real `AskUserQuestion` call, issued
  directly in the main context (never delegated to a sub-agent, which would strip
  it again). This is the only way to make the gate genuinely interactive.
- **Invocation Contract — `contextChanges` allowance (ADR 0014 pattern)**: removing
  `context: fork` from qa-phase collides with the dual-baseline drift gate (both
  the v2.1.9 LTS and v2.1.16 Latest baselines record `context: fork`, and the SOP
  keeps LTS immutable). Rather than rewrite historical baseline JSON, a new
  `contextChanges` section in `test/contract/deprecation-registry.json` declares
  the intentional change machine-readably, and `contract-test-run.js` L1-SK
  consults it — mirroring ADR 0014's deprecation-registry philosophy. Both
  baselines stay green with baseline JSON untouched; no Latest rollforward needed
  (the baseline schema does not capture the new `background` key either).
- **MF-2 — recommended CC bumped**: `lib/infra/cc-version-checker.js`
  `RECOMMENDED_VERSION` 2.1.198 → 2.1.218 (was 20 releases stale). README,
  SessionStart advisory, and marketplace narrative synced. Install floor
  (v2.1.143), model floor (v2.1.170), and runtime minimum (v2.1.78) unchanged.
- **Hygiene**: `lib/cc-regression/registry.js` MON-CC-06-51165 note corrected
  ("sole fork user" → 8 producer fork skills + qa-phase exit). The
  `invocation-inventory.test.js` fork detection is now frontmatter-scoped (it
  previously false-matched skills that merely mention `context: fork` in prose).
- **Tests**: fork set expectation 9 → 8; new regressions assert each producer
  declares `background: false`, that qa-phase is not forked yet retains
  `AskUserQuestion`, and the `contextChanges` allowance. All contract tests green
  vs both baselines (v2.1.9: 222, v2.1.16: 243 assertions), context-fork-l1 64/64,
  invocation-inventory 215/215, integration-runtime 23/23; docs=code 0 drift.
- **Scope note**: the deeper "interactivity inside a forked skill" architecture
  (options B/C beyond qa-phase) is intentionally out of scope — it is not a
  regression introduced by v2.1.218. Architecture counts invariant
  (44 skills · 34 agents · 22 hook events).

## [2.1.30] - 2026-07-14

> **Status**: Issue #139 (@thenopen, surfaced via Claude Code's `/doctor`
> health-check) — a real reliability defect. The `Stop` event hook
> (`scripts/unified-stop.js`, `timeout: 10000` in `hooks/hooks.json`) occasionally
> stalled far past its own 10 s timeout: across ~50 sessions / 5 days the reporter
> measured a healthy ~0.8 s average but a **928,551 ms (~15.5 min) maximum**, with
> 14 timeout-cancellations. Because `Stop` hooks gate turn completion, every stall
> blocked the end of a turn for its full duration. No Guessing: the root cause was
> reproduced end-to-end (not inferred from the subsystem list in the report).

### Stop-Hook stdin-Block Hardening (Issue #139)

- **Root cause (reproduced, not speculated)**: every bkit hook reads its payload
  through `lib/core/io.js` `readStdinSync()`, which used
  `fs.readFileSync(0, 'utf8')` — a blocking read on stdin (fd 0) with **no
  timeout**. It returns only when stdin reaches EOF, i.e. when Claude Code closes
  the hook's stdin write-end. If CC keeps that write-end open (busy, backpressure,
  delayed close), the hook blocks for exactly that long. Reproduction against the
  real hook: stdin closed immediately → 0.19 s; writer holding the stdin pipe open
  4 s → **4.07 s**, with `user` CPU flat at 0.19 s — the process is *blocked on
  I/O*, not burning CPU, matching the issue's profile (healthy average, extreme
  tail, low CPU).
- **Blast radius**: `readStdinSync()` is called by **36 files** — effectively every
  bkit hook script. The issue was filed against `unified-stop.js`, but the defect
  lives in the shared function, so the fix is central and protects **all** hook
  events (PreToolUse, PostToolUse, Stop, SessionEnd, …), not just Stop.
- **Fix 1 — central bounded parse-early read (`lib/core/io.js`)**: `readStdinSync()`
  now reads fd 0 incrementally with `fs.readSync` and returns **the instant the
  accumulated buffer holds a complete JSON value** — it never waits for EOF, which
  was the entire source of the stall. The raw-fd path creates no libuv stream
  handle, so the process still exits promptly. The return contract is unchanged
  (empty → `{}`, malformed → `{}` unless `BKIT_STRICT_STDIN=1` rethrows). Reproduced
  case: **15.5 min → ~1 ms**.
- **Fix 2 — hard-bounded async read for the turn-gating Stop hook
  (`scripts/unified-stop.js`)**: a new `readStdinBounded(timeoutMs)` export reads
  stdin event-based with parse-early **and** a hard `setTimeout` budget, and
  **destroys `process.stdin` on resolve** (without that, the open stdin handle keeps
  the event loop alive until EOF and the process lingers even after the payload is
  parsed — a subtle trap that would reintroduce the stall). `unified-stop.js` awaits
  it inside an async IIFE, so the Stop hook can never exceed
  `STDIN_READ_TIMEOUT_MS` even for the pathological no-data / truncated + held-open
  pipe that the sync reader cannot hard-bound.
- **Fix 3 — non-CPU lock backoff (`lib/core/state-store.js`)**: `lock()` previously
  backed off with a CPU-burning busy-wait spin (`while (Date.now() < waitUntil) {}`)
  that pinned a core for the retry interval. Replaced with a synchronous
  `Atomics.wait` sleep (portable, no native deps, no CPU burn), addressing the
  issue's "lock-wait / retry-without-backoff" note for the ~4 `lockedUpdate` calls
  in the Stop chain.
- **New constant**: `STDIN_READ_TIMEOUT_MS` (default 2000 ms, env override
  `BKIT_STDIN_TIMEOUT_MS`) — ~2.5× the observed healthy average, well under bkit's
  `HOOK_TIMEOUT_MS` (5000) and CC's Stop-hook timeout (10000), so bkit bounds the
  read before either outer timeout can fire.
- **Out of scope (justified)**: `scripts/lint-skill-md.js` uses `fs.readFileSync(0)`
  to read a markdown file via stdin redirect (a CI/dev tool, not a runtime hook, not
  a held-open pipe) — not vulnerable, left unchanged. Making the Stop sub-handlers
  fire-and-forget was unnecessary: the confirmed cause is stdin blocking, not
  sub-handler cost (normal run 0.19 s).
- **Verification**: new 16-TC regression test
  `test/regression/issue-139-stdin-bounded.test.js` (parse-early return, contract
  preservation, hard-timeout bounding, prompt process exit, source guards);
  end-to-end proof against real subprocesses with a held-open pipe (Stop hook
  ~374 ms vs an 8 s held pipe; no-data hard cap ~2.4 s); live `claude -p
  --plugin-dir .` on CC v2.1.208; full CI gate suite green (contract L1/L4 222+243,
  l2-smoke 105, l2-hook-attribution 13, l3-mcp 92+48, integration-runtime 23,
  invocation-inventory 213, hooks-22 25, bkit-full-system 36, deadcode 0-new,
  validate-plugin 0-err); **0 new regressions** vs the `main` baseline.
- **Architecture counts invariant**: 44 Skills · 34 Agents · 22 Hook Events / 25
  blocks · 195 Lib Modules — unchanged (internal changes to existing modules).

## [2.1.29] - 2026-07-06

> **Status**: Issue #137 (@hslee-cmyk) — a low-priority, cosmetic follow-up in the
> same task-lifecycle area as #132/#135, reported with a full reproduction. The
> `pdca` skill chains phase Tasks with `blockedBy` (`[Plan]→[Design]→[Do]→[Check]→…`),
> but `skills/pdca/SKILL.md` documented Task *creation* only — no step ever told the
> model to mark the *predecessor* phase Task `completed` when advancing, and no
> hook/orchestrator did it either. A predecessor left `in_progress` (e.g. `[Design]`
> during the whole `Do` phase) leaked a stale phase into Claude Code's ambient
> prompt context on every turn, disagreeing with `.bkit/state/pdca-status.json`'s
> `phase` field — the phase source of truth, which was correct throughout. No
> Guessing: reproduced in-source (grep confirms zero predecessor-completion
> instructions) and the fix strategy was decided against CC's documented hook
> constraints, not assumptions.

### PDCA Predecessor-Task Completion Chain (Issue #137)

- **Root cause**: `## Task Integration` and each per-action step block in
  `skills/pdca/SKILL.md` describe creating `[Phase] {feature}` Tasks with a
  `blockedBy` reference to the prior phase, but never instruct completing that prior
  Task. For a `blockedBy` chain to be semantically correct — and, more visibly, to
  keep Claude Code's native task list (surfaced into prompt context each turn)
  consistent with `pdca-status.json` — the predecessor must be `completed` by the
  time the successor is created.
- **Why the issue's Option 2 (hook auto-complete) was rejected as infeasible**:
  per the official Claude Code hooks guide, command hooks communicate only through
  stdout / stderr / exit codes / `additionalContext` and **cannot call `TaskUpdate`
  or any tool — only the model can**. `TaskCreated`/`TaskCompleted` are real firing
  events, but a handler for them could at most emit a reminder, which *still* relies
  on the model performing the completion — no more deterministic than an explicit
  skill step, and noisier. Option 2 is therefore strictly worse than Option 1.
- **Fix (Option 1 — deterministic, model-executed)**: each advancing `pdca` phase
  action (`design`, `do`, `analyze`, `iterate`, `qa`, `report`) now embeds a
  **"Complete predecessor Task first"** step immediately before its Create-Task
  step, and `archive` completes the terminal `[Report]` Task. A general
  **Phase Transition Rule** in `## Task Integration` states the rule ("mark every
  prior `[Phase] {feature}` Task still `in_progress` as `completed`") and its
  two-sources-of-truth rationale; the wording is branch-safe for the `qa`/`act`
  parts of the 9-phase lifecycle. Uses the `TaskList`/`TaskUpdate` tools the skill
  already grants — no new runtime surface, no hook change.
- **Scope**: `skills/pdca/SKILL.md` only. Related skills carry no multi-phase
  `blockedBy` chain — `plan-plus` creates a single `[Plan]` Task (completed by
  `pdca design`'s new step), `cc-version-analysis` uses a single Task with subtask
  tracking, and `sprint` uses per-feature Tasks — so none required changes.
- **Regression guard**: new `test/regression/issue-137-predecessor-task-completion.test.js`
  (25 assertions) asserts the Phase Transition Rule and each per-transition
  completion instruction are present; it fails if any is removed.
- **No architecture-count or runtime-behavior change**: 44 Skills / 34 Agents /
  22 Hook Events (25 blocks) / 195 Lib Modules unchanged; `TaskCreated`/`TaskCompleted`
  audit + auto-advance handlers unchanged. Zero new regressions vs the `main`
  baseline (identical failing-file set).

## [2.1.28] - 2026-07-03

> **Status**: Issue #135 (@hslee-cmyk) — the direct, narrower follow-up to #132.
> #132 (v2.1.27) made the audit / task-tagging half of the `UserPromptExpansion`
> mechanism reachable for native slash commands. #135 is the remaining gap: the
> **next-step guidance-text half** of that same mechanism never fired for
> multi-action router skills, because `orchestrateSkillPost()` derived
> `suggestions` ONLY from two STATIC SKILL.md frontmatter fields (`next-skill:`,
> `pdca-phase:`), and bkit's flagship routers `pdca` and `sprint` (plus 9 utility
> routers) declare both `null` by design — their effective phase depends on the
> runtime `action` argument, not the skill name. Result: `suggestions = {}`,
> `formatGuidance()` returned `''`, and the two most-used skills silently emitted
> no "what should I run next" guidance. No Guessing: root cause confirmed at code
> + runtime level (`orchestrateSkillPost('pdca', …)` → `{}`) and against a
> main-baseline regression diff (0 regressions).

### Runtime-Phase-Aware Skill Guidance (Issue #135)

- **Root fix — runtime phase resolution, SSoT-unified**: a new source-agnostic
  module `lib/orchestrator/runtime-guidance.js` resolves the effective phase at
  CALL TIME from the invocation `action` cross-referenced with live PDCA/Sprint
  state, then reuses the SAME source-of-truth the MANUAL `/pdca next` &
  `/sprint phase` paths use — closing the issue's deeper complaint that the
  passive-guidance path and the manual path were two disconnected systems. No
  phase-transition table is duplicated:
  - **PDCA** → `lib/pdca/automation.getNextPdcaActionAfterCompletion` (already
    live-status aware: `check → qa|act` by matchRate, `qa → report|act` by
    qaPassRate).
  - **Sprint** → `lib/sprint/executive-summary.buildNextActions` (phase → next
    `/sprint` command), phase read from the sprint index SSoT.
- **Wired at the shared chokepoint**: `runSkillInvocationEffects`
  (`skill-invocation-effects.js`) enriches the empty `suggestions` from
  `orchestrateSkillPost` — so BOTH the `PostToolUse:Skill` (model) and
  `UserPromptExpansion` (slash) paths surface the guidance from one change.
  `orchestrateSkillPost` stays a pure frontmatter resolver (no layering
  inversion). Guarded (runs only when frontmatter produced nothing AND the skill
  is guidance-eligible) and **fail-open** (any error → `{}`, never blocks a
  command).
- **Judicious scope**: only the two flagship orchestrators (`pdca`, `sprint`)
  are guidance-eligible. The 9 pure-utility routers (`audit`, `control`,
  `rollback`, `bkit-evals`, `bkit-explore`, `claude-code-learning`, `pdca-batch`,
  `pdca-fast-track`, `pdca-watch`) have no linear "next PDCA step" — their
  silence is correct behavior, now explicit rather than accidental.
- **suggestedAgent coverage** extended as a superset of the existing hardcoded
  pair (`do → gap-detector`, `check → pdca-iterator` preserved verbatim) with
  additive `design → design-validator`, `qa → qa-lead`.
- **i18n cleanup (related area)**: guidance strings that were previously
  hardcoded in Korean (`getNextStepMessage`, the `do`/`check` `suggestedMessage`)
  are now **English-default with a KO sibling**, resolved via the existing i18n
  detector (`lib/i18n/detector.readLanguage`). New code is English per project
  convention; KO users keep parity. The error-focused `assets/error-dict.*.json`
  is untouched.
- **Tests**: new `test/regression/issue-135-multiaction-guidance.test.js`
  (23 TC — root-cause guard, pdca/sprint resolution, utility silence, ineligible
  skip, fail-open, SSoT-reuse guard, EN/KO parity, e2e on both paths);
  `test/unit/skill-orchestrator.test.js` SO-023..028 migrated KO→EN (46/46).
  Non-regression: `issue-132-slash-reach` 7/7, `skill-invocation-effects` 5/5.
  Real production-entrypoint QA (`--plugin-dir .`) confirms guidance now appears
  for `/bkit:pdca` and `/bkit:sprint` on both invocation paths. Main-baseline
  regression diff: **0 regressions** (2003 PASS / 40 pre-existing FAIL unchanged).
- **Architecture**: 195 Lib Modules (194 + `runtime-guidance.js`). No version
  floor bump; no gated-count change (skills 44 / agents 34 / hookEvents 22 /
  hookBlocks 25 unchanged).

## [2.1.27] - 2026-07-02

> **Status**: Issue #132 (@hslee-cmyk) — bkit's orchestrator side-effects
> (next-skill/agent guidance, hook-level phase auto-advance, decision-trace
> `phase_transition`, audit `skill_executed`) were wired ONLY to
> `PostToolUse:Skill`, which never fires on native slash commands
> (`/bkit:pdca ...`) — the ONLY invocation form bkit's docs teach. So for
> essentially all real usage the advertised AI-transparency audit trail was
> empty, decision-trace had no records, and no orchestrator guidance appeared.
> Same root-cause family as #125/#126; #126 fixed the false warning but left
> the functionality dead. Root cause confirmed 4 ways (code + headless repro +
> reporter repro + `UserPromptExpansion` payload reproduction); basis in
> `.bkit/research/issue-132-*.md`. No Guessing: the fix is grounded in an
> empirical CC v2.1.198 reproduction of the `UserPromptExpansion` event.

### Slash-Path Orchestration Restored (ENH-371)

- **Root fix — dual-wire to `UserPromptExpansion`**: bkit's four orchestrator
  side-effects are extracted into a source-agnostic shared module
  `lib/orchestrator/skill-invocation-effects.js` and fired from BOTH the
  existing `PostToolUse:Skill` path (model-invoked) AND a NEW
  `UserPromptExpansion` hook (native slash path). `UserPromptExpansion` is
  CC's purpose-built slash-command-expansion event — empirically confirmed
  firing on CC v2.1.198 with `command_source:"plugin"`, namespaced
  `command_name:"bkit:pdca"`, and `command_args` — and self-filters (fires
  only for command expansions, never plain text). The handler filters to
  `command_source==='plugin'` + a resolvable bkit skill, is **fail-open**
  (any error → exit 0; never blocks the user's command), and injects
  next-skill guidance via stdout (the `UserPromptExpansion` context contract).
- **Audit semantics**: the slash/pre-execution path records a new
  **`skill_invoked`** audit action (via the audit-logger pass-through path,
  the same mechanism `skill_executed` already uses — `ACTION_TYPES` untouched);
  the model-invoked `Skill`-tool path keeps `skill_executed`. A content-derived
  dedup key (`session_id:skill:action:feature`, derivable from both payloads)
  prevents any double-record; the two paths are normally mutually exclusive
  per invocation.
- **Hook inventory**: `hooks.json` gains the `UserPromptExpansion` event
  (HPQ-quoted); the L5 invocation-inventory invariant moves **21→22 events /
  24→25 blocks** in lockstep (`docs-code-invariants.js` SoT +
  `EXPECTED_HOOK_EVENT_NAMES` + `invocation-inventory.test.js` +
  `l2-smoke.test.js`). `PostToolUse` stays 3 / `PreToolUse` stays 2.
- **Two latent defects repaid for free**:
  - **IntentRouter was 100% dead code** — `user-prompt-handler.js` called
    `route(prompt, { onboarding: onboardingContext })` with an undefined
    `onboardingContext`, throwing a swallowed `ReferenceError` so structured
    suggestions were always `[]`. Fixed; the intent-router slash regex is also
    widened (`[\w-]` → `[\w:-]`) so bkit's own namespaced `/bkit:pdca` commands
    are recognized.
  - **Stop-handler dispatch was silently broken on the slash path** — the
    active-skill marker was written only from `skill-post.js` (dead on slash),
    so `unified-stop.js` `SKILL_HANDLERS` never dispatched for any non-sprint
    slash-invoked skill. The shared module now writes the marker on both paths.
- **Graceful degradation**: on CC versions without `UserPromptExpansion` the
  new hook is simply inert (= current behavior) — no regression, no floor bump.
  Reachability canary integrity preserved (the `skill_post` key is NOT stamped
  from the new path, keeping the #57317/#126 monitor meaningful).
- **Verification**: gap analysis + QA + a live `claude -p "/bkit:pdca status"
  --plugin-dir .` probe confirming a real `skill_invoked` audit entry is
  written on the native slash path; full CI-mirror suite green
  (invocation-inventory 22/25, l2-smoke, HPQ, docs-code-sync, bkit-full-system,
  validate-plugin --strict); contract baselines byte-identical (no agent/model
  change). New tests: `skill-invocation-effects`, `user-prompt-expansion-handler`,
  `issue-132-slash-reach`.
- **Contract-runner alignment (no baseline edit)**: adding a hook event exposed
  that `runL1Hooks()` was the *only* L1 surface using strict count-equality
  against the frozen baselines — `runL1Skills/Agents/MCP` all guard by
  per-identity existence and tolerate additions (proof: baseline v2.1.9 declares
  39 skills / 36 agents while HEAD ships 44 / 34, yet L1 passes). Per the
  rollforward guide §3.1 (the LTS baseline is edited only at a major LTS
  transition, never for a routine surface addition), the fundamental fix is in
  the *runner*, not the snapshots: the hook events/blocks count asserts move
  `=== ` → `>=` (additions OK; the pre-existing per-event existence loop remains
  the real removal guard; a net count *decrease* still fails). Both CI compares
  (`--compare v2.1.9` and `--compare v2.1.16`, `--level L1,L4`) pass with the
  frozen baselines untouched.

## [2.1.26] - 2026-07-02

> **Status**: Issue Response + v2.1.25 follow-up closure. MAIN: the `/plugin`
> "Needs attention: bkit-pdca / bkit-analysis MCP ✗ failed" defect is fixed at
> its structural root. Empirical reproduction (R1,
> `.bkit/research/v2126-reproduction-log.md`): the repo-root `.mcp.json` was
> loaded TWICE by Claude Code — as the plugin's MCP manifest
> (`${CLAUDE_PLUGIN_ROOT}` expands, `plugin:bkit:*` ✔ Connected) AND as
> project-scope shared config whenever the bkit checkout is the working
> directory, where the variable is undefined → CC diagnostics "Missing
> environment variables: CLAUDE_PLUGIN_ROOT" → bare entries pending/failed.
> Marketplace end-users are unaffected; developers and cloners get a clean
> `/plugin` panel and `claude mcp list`.

### Fable Cost Retune — high-frequency verifiers fable→opus (ENH-370)

- **Problem**: v2.1.25 pinned all 9 verification/orchestration agents to Claude
  Fable 5 ($10/$50 per MTok). But the two verifiers that run MOST often —
  `gap-detector` (every `/pdca analyze` **and** re-run inside every iterate
  cycle) and `pdca-iterator` (up to 5 cycles per feature) — form a repeated
  Check→iterate loop: a single feature can invoke `gap-detector` up to 6× and
  `pdca-iterator` up to 5×, all on the most expensive model. Continuous use
  drove token cost up sharply (user-reported).
- **Change**: the 3 high-frequency PDCA verifiers **`gap-detector`,
  `design-validator`, `pdca-iterator` move `fable` → `opus`** (Opus 4.8 —
  $5/$25, **half Fable's cost**, and strong at verification; it was their model
  before v2.1.25). Fable stays on the 6 long-horizon agents where its
  planning/delegation/self-checking edge compounds and invocation is
  user-initiated + infrequent: `cto-lead`, `sprint-orchestrator`,
  `sprint-master-planner`, `pm-lead`, `qa-lead`, `sprint-qa-flow`.
- **Matrix**: fable 9→**6** / opus 7→**10** / sonnet 16 / haiku 2 (34 agents).
  Lockstep: `agents/{gap-detector,design-validator,pdca-iterator}.md` +
  contract baselines both dirs (model field only, 6 JSONs) + SEC-AF-038/052
  comments (lists unchanged — opus stays a premium model, so the read-only
  premium exceptions remain valid) + docs (commands/bkit.md, bkit-system
  overview/README/philosophy tables, README architecture line). Pricing table
  and `token-report` unchanged (both models already priced). Also fixed a stale
  `context-engineering.md` haiku row (8 → 2; the 6 pdca-eval-* tombstones were
  removed in v2.1.25 per ADR 0014).

### MAIN — MCP manifest relocation (ENH-369)

- **`mcpServers` is now declared INLINE in `.claude-plugin/plugin.json`**
  (official manifest key, documented alternative to root `.mcp.json`; values
  byte-equal — same 2 servers, same `${CLAUDE_PLUGIN_ROOT}` args). The root
  `.mcp.json` file is **deleted**: only that literal filename at the project
  root is auto-loaded as project config, so the dual-load collision is
  structurally impossible now.
- Regression locks: `test/integration/mcp-server.test.js` re-pointed at the
  manifest (MS-011~015) + NEW args-hardening assertion
  (`${CLAUDE_PLUGIN_ROOT}/servers/` must appear — previously unasserted) +
  NEW **MS-016**: the repo root must never contain `.mcp.json` again.
- Live acceptance evidence: repo-cwd `claude mcp list` shows zero bare
  bkit entries + zero MCP diagnostics; fresh `--plugin-dir .` session loads
  the inline manifest and `bkit_pdca_status` returns valid JSON;
  `claude plugin validate . --strict` 0 errors / 0 warnings. Rejected
  alternatives (documented): `${VAR:-default}` (silences the parse error but
  still registers a broken/duplicate server) and relative `./servers/...`
  args (breaks every marketplace install — plugin docs mandate
  `${CLAUDE_PLUGIN_ROOT}`).

### Release tooling — `claude plugin tag` drift (F1)

- `scripts/release-plugin-tag.sh` step 6: CC (~v2.1.110) changed
  `plugin tag` to derive `{name}--v{version}` from plugin.json (positional
  version argument removed → the old `claude plugin tag vX.Y.Z` call failed
  with "Path not found"; the derived `bkit--vX.Y.Z` format would also break
  this repo's `vX.Y.Z` tag continuity). The release tag is now ALWAYS created
  via `git tag -a`; `claude plugin tag . --dry-run` is retained as an
  INFORMATIONAL consistency check only (plugin.json↔marketplace agreement;
  never gates, `|| true` pipefail-safe). Verified end-to-end on a clean
  clone: full `--dry-run` EXIT=0. `lib/infra/cc-version-checker.js`
  `pluginTagCommand` comment records the transition (value stays 2.1.118 —
  the map documents the minimum CC where the invoked command exists).

### Test-state isolation — tests no longer write the real `.bkit` (F4)

- Root causes found by call-chain tracing (No Guessing): the sprint dispatcher
  built infra from `args` while tests injected `projectRoot` via `deps`
  (`scripts/sprint-handler.js`), `active-skill-marker` hardcoded the real
  root, and the telemetry adapter + 9 direct `writeAuditLog` sites discarded
  the injected root before reaching `lib/audit/audit-logger.js`.
- ADDITIVE injection (defaults byte-for-byte preserved): `projectRoot` now
  threads through `lib/pdca/batch-orchestrator.js` (was hardcoded),
  `scripts/sprint-handler.js` → `lib/infra/sprint/*` → sprint state/registry,
  `lib/audit/audit-logger.js`, and `lib/core/active-skill-marker.js`.
- 5 leaking suites converted to tmp-root isolation (sprint-handler
  default-level-warning + annotate-action, config-sync, module-chain,
  batch-orchestrator) — all assertions preserved. NEW guard:
  `test/regression/bkit-state-isolation.test.js` (22 TC) proves injected
  writes land only under tmp AND the real `.bkit` hash is byte-identical
  across the 5 suites. Additional real-`.bkit`-writing suites are inventoried
  in the Do report as follow-up candidates (l2-smoke by design, e2e suites).
- Local `.bkit` fixture pollution (sc05-test, test-f1-*, test-feature-*,
  batch fixtures — accumulated by the pre-fix leaks) cleaned locally;
  procedure: remove fixture features via `deleteFeatureFromStatus`, delete
  fixture sprint/registry/batch files, verify `/pdca status` + MCP healthy.

### Governance & docs (F2, F3, ADR 0011, 45-skills)

- **ADR 0015** (bilingual): locale-scoped trigger generation (#129 proposal 1)
  formally DEFERRED — CC plugins are immutable versioned marketplace
  checkouts with no install-time generation hook; bkit's 8-language routing
  lives in `lib/intent/language.js`, not descriptions. Revisit if CC gains
  install/setup hooks.
- **ADR 0011 Amendment 1**: official manifest schema has grown past the
  21-key v2.1.143 snapshot (mcpServers — now used by bkit — lspServers,
  channels, userConfig, defaultEnabled). Policy recorded verbatim:
  `EXPECTED_PLUGIN_JSON_KEYS` is **subset enforcement — the keys bkit ships —
  NOT a mirror of the full official schema** (only absent official key:
  `defaultEnabled`, which bkit does not ship). Zero code change.
- **Eval re-baseline SOP** (bilingual, `docs/06-guide/eval-rebaseline.guide.*`):
  `model_baseline` is capture-time metadata (the eval runner performs ZERO
  LLM calls); re-baseline on rubric changes, not model releases; the current
  32 `claude-sonnet-4-6` values remain frozen per the v2.1.25 decision.
- **45-skills counting note** (CUSTOMIZATION-GUIDE + skills overview): CC's
  `/plugin` Skills count = `skills/` + `commands/` entries (same-name dedup);
  bkit = 44 skills + `commands/output-style-setup.md` → displays 45. Not a bug.

## [2.1.25] - 2026-07-02

> **Status**: Claude 5 Model Alignment + Issue Response (#128, #129, #130).
> Realigns all 40 agent model pins to a
> 4-tier role-based matrix built around the Claude 5 family (Fable 5 / Opus 4.8 /
> Sonnet 5 / Haiku 4.5), with a **dual-floor** compatibility policy: the install
> floor stays at CC v2.1.143 (unchanged — plugin-manifest `displayName`), and a
> new **model floor** (CC v2.1.170, where the `fable` alias was introduced) is
> surfaced as a SessionStart advisory (**ENH-368**) instead of a hard requirement.
> Every dependent surface moved in lockstep: frontmatter, runtime whitelist,
> pricing, contract baselines, security assertions, and docs. Design doc:
> `docs/02-design/features/claude-model-alignment.design.en.md`. Basis: two
> empirical reproductions — **R1** (alias resolution per CC version/provider) and
> **R2** (`model: fable` is a HARD agent-spawn error on CC < 2.1.170) — logged in
> `.bkit/research/v2125-reproduction-log.md`. No Guessing: every tier assignment
> argued per-agent; pricing verified against published Claude API list prices.

### 4-Tier Model Matrix (16 reassignments across 40 agents)

| Tier | Count | Agents | Rationale |
|------|:-----:|--------|-----------|
| **fable** (was opus ×9) | 9 | cto-lead, sprint-orchestrator, sprint-master-planner, pm-lead, qa-lead, gap-detector, design-validator, pdca-iterator, sprint-qa-flow | Verification & orchestration core — long-horizon leads + design/gap verifiers, Fable's exact positioning (honesty/verification edge, long-horizon self-checking) |
| **opus** (unchanged ×7) | 7 | security-architect, code-analyzer, self-healing, infra-architect, enterprise-expert, bkit-impact-analyst, cc-version-researcher | Opus 4.8 strongest on cybersecurity; refusal-sensitive headless paths (self-healing is Sentry/Slack-triggered; Fable's safety classifier reroutes/refuses security-adjacent + non-interactive work); deep single-shot analysis at half Fable cost |
| **sonnet** (1 changed) | 16 | sprint-report-writer (**opus → sonnet** — KPI aggregation/report synthesis is implementation-class work) + 15 unchanged implementers/analysts | Coding, analysis, synthesis workers; `sonnet` alias floats to Sonnet 5 on CC ≥ 2.1.197 |
| **haiku** (6 changed) | 8 | pdca-eval-{act,check,design,do,plan,pm} (**sonnet → haiku** — DEPRECATED tombstones, never spawned by design, minimum cost if accidentally spawned) + qa-monitor, report-generator (unchanged) | High-volume, low-reasoning monitors + tombstones |

Distribution at matrix time: 40 files = 9 fable / 7 opus / 16 sonnet / 8 haiku.
**Final tree** (after #128 removed the 6 deprecated tombstone files — see Issue
Response below): **34 agent files = 9 fable / 7 opus / 16 sonnet / 2 haiku**.

### Dual Floor + ENH-368 Model-Floor Advisory

- **Install floor UNCHANGED**: CC v2.1.143 (`CC_MIN_VERSION` — plugin-manifest
  `displayName`, unrelated to model capability). Runtime minimum unchanged
  (`MIN_VERSION` 2.1.78).
- **NEW — model floor constant**: `FABLE_MODEL_FLOOR = '2.1.170'` exported from
  `lib/infra/cc-version-checker.js` (single constant, infra layer).
- **NEW — ENH-368 SessionStart advisory** (`hooks/startup/session-context.js`):
  when `2.1.143 ≤ CC < 2.1.170`, names the 9 fable-pinned agents (they hard-fail
  at spawn on those binaries, per R2), the required CC version, the fix
  (`npm install -g @anthropic-ai/claude-code@latest`), and the temporary
  workaround `export CLAUDE_CODE_SUBAGENT_MODEL=sonnet` (forces ALL subagents to
  sonnet). At most one advisory is emitted (install-floor advisory takes
  precedence); reuses the single `detectCCVersion()` result — no second process
  spawn. Fail-open: never blocks SessionStart.
- `RECOMMENDED_VERSION` **2.1.150 → 2.1.198** (Claude 5 alias resolution —
  `sonnet` resolves to Sonnet 5 only on CC ≥ 2.1.197); stale SessionStart
  recommendation prose (`v2.1.123+/v2.1.140/v2.1.34~141`) replaced with the
  current dual-floor recommendation.

### Pricing & Model-Classing Sync (`lib/pdca/token-report.js` — pricing SoT)

- **FIX — opus pricing was 3x stale**: `PRICING_PER_MTOK.opus` 15/75 → **$5/$25**
  per MTok (Opus 4.8 published list price) — cost dashboards previously
  overstated opus spend 3x.
- **FIX — haiku pricing**: 0.25/1.25 → **$1/$5** (Haiku 4.5 published list price).
- **NEW — fable pricing**: **$10/$50** added; `_modelClass()` gains an
  `includes('fable') → 'fable'` branch. `sonnet` 3/15 and `unknown` 3/15
  fallback unchanged.
- `test/unit/token-report.test.js`: opus assertion corrected to 5/25; NEW fable
  pricing test + classing tests (`claude-fable-5`→fable, `claude-sonnet-5`→sonnet,
  `claude-opus-4-8`→opus); unknown-fallback test still passes.

### Whitelists, Baselines & Security Assertions (lockstep)

- `test/security/agent-frontmatter.test.js` `VALID_MODELS` += `'fable'`
  (typo'd models still fail the strict whitelist).
- `scripts/subagent-start-handler.js` runtime coercion whitelist += `'fable'`;
  team default ctoAgent `'opus'` → `'fable'` (also `lib/team/state-writer.js`,
  `hooks/session-start.js` — follows cto-lead frontmatter; teammate default
  stays `sonnet`).
- Contract baselines regenerated via `contract-baseline-collect.js` for both
  dirs (`test/contract/baseline/v2.1.9/` + `v2.1.16/`) — **28 baseline JSONs**,
  `model` field only (L1-AG lockstep, no other field churn).
- Security assertions updated: SEC-AF-030 (`cto-lead` opus → fable), SEC-AF-038
  (OPUS_TIER1 generalized to PREMIUM tier = opus|fable: security-architect,
  design-validator, gap-detector), SEC-AF-037 (deprecation tombstones with
  minimal frontmatter skipped), read-only premium exceptions per matrix.
- `evals/config.json` `benchmarkModel`: `claude-sonnet-4-6` → `claude-sonnet-5`.
  Note: `evals/*/eval.yaml` `model_baseline` values are **historical capture
  records** — intentionally unchanged.
- `lib/domain/guards/enh-264-token-threshold.js`: `KNOWN_REGRESSION_MODELS` kept
  at sonnet-4.x only + explicit comment — the ENH-264 regression was
  sonnet-4.x-specific; Sonnet 5 excluded until observed evidence (No Guessing).

### Docs=Code — 3 Pre-existing Drift Bugs Fixed

- **FIX — `commands/bkit.md` agent header said "36 total — 13 opus / 21 sonnet /
  2 haiku"**: actual tree has 40 agent files; now "40 total — 9 fable / 7 opus /
  16 sonnet / 8 haiku" with every per-agent model row verified against frontmatter.
- **FIX — pm-lead listed as `sonnet`** in `commands/bkit.md` +
  `bkit-system/components/agents/_agents-overview.md`: pm-lead was opus before
  this release (drift predating the matrix) and is now `fable`.
- **FIX — test-checklist PM-T10** claimed "All 5 PM agents use sonnet": now
  "pm-lead uses fable; pm-discovery/pm-strategy/pm-research/pm-prd use sonnet".
- All other normative model surfaces synced: `bkit-system/README.md` counts,
  `_agents-overview.md` 4-tier legend + tables, `philosophy/context-engineering.md`
  + `ai-native-principles.md` model tables, `scenario-new-feature.md`,
  `skills/{pdca,pm-discovery,cc-version-analysis}/SKILL.md`,
  `CUSTOMIZATION-GUIDE.md` (fable allowed value + CC ≥ v2.1.170 note + `model:
  fable` example + model-selection footguns), `README.md` runtime recommendation
  + 4-tier matrix line, `README-FULL.md` mermaid diagrams + example model IDs
  (`claude-opus-4-8`, `claude-sonnet-5`), `marketplace.json` description.
  Historical entries/notes (e.g., ENH-325 "17 opus agents", regression-history
  prose) intentionally untouched.

### Issue Response — #128 / #129 / #130

- **#128 (@NEXCODE-MK) — Deprecated `pdca-eval-*` stubs removed from the prompt
  surface (ADR 0014)**: the 6 tombstone files (~1,387B of always-resident agent
  descriptions + accidentally-spawnable "(Tools: All tools)" entries) are
  **deleted from `agents/`**; deprecation governance moves to a machine-readable
  registry at `test/contract/deprecation-registry.json` (deprecatedIn /
  replacedBy / reason / deprecationCommit / stubRemovedIn / issue). Contract L4
  accepts a registry tombstone as equivalent to a live stub
  (`contract-test-run.js` `loadDeprecationRegistry()`, fixture-overridable; the
  `missing-stub` fixture still fails — and a pre-existing exit-2 crash in that
  path was fixed). L5 invocation-inventory asserts registry⇔SoT equality and
  that no stub files remain (212 TC). Baseline JSONs in **both** dirs untouched.
  **ADR 0014** ("Deprecation Registry — tombstones off the prompt surface",
  bilingual) supersedes the ENH-336 (v2.1.22) permanent-retention decision on
  its own terms — both of its premises (L4 breakage, baseline mutation) are
  dissolved by the registry; rollforward guide gains §5.6. Side fix: 6
  pre-existing `agents-effort` failures (AE-09..14) eliminated.
- **#129 (@NEXCODE-MK) — Token diet: compact 8-language trigger encoding**:
  agent frontmatter descriptions compacted **30,065B → 16,919B (−44%)** across
  32 agents + `skills/sprint/SKILL.md` (1,074B → 550B) — an estimated
  **~4.5–5.3K tokens saved per session wakeup** for every bkit user. New
  template: 1–2 role sentences + one "Use proactively when…" sentence + a
  single `Triggers:` block (full EN + full KO lists + exactly one anchor per
  JA/ZH/ES/FR/DE/IT). "Do NOT use for" + version notes moved into agent bodies
  (`## When NOT to use this agent`, `## Delegation notes`) — loaded only on
  invocation, so no information was deleted. bkit's own 8-language routing is
  unaffected (it reads the separate `lib/intent/language.js` registry, not
  descriptions — verified file:line); contract baselines don't capture
  description content, so **no baseline regen**. New regression lock:
  `test/regression/issue-129-description-budget.test.js` (≤700B per agent
  description, `Triggers:` presence, ≤20,000B total). Locale-scoped generation
  (issue proposal 1) deferred: CC plugins are read-only marketplace checkouts —
  no install-time file generation exists (to be documented in a follow-up ADR).
- **#130 (@s99606931) — `learning-stop.js` dead `isTTY === false` stdin gate**:
  piped hook stdin has `isTTY === undefined`, so the gate silently skipped
  input (reproduced: payload `learn 3` returned level 1). Fixed with the shared
  `readStdinSync()` helper per the #125/#126 precedent (commit 7b780b8), same
  anti-pattern warning comment; args coerced to string. New regression test
  `test/regression/issue-130-learning-stop-stdin.test.js` (9 TC: piped payload,
  top-level, empty/malformed stdin fallback, non-string args). Repo-wide sweep:
  zero `isTTY === false` code gates remain (stdout truthiness check in
  `lib/ui/ansi.js` is correct and kept).

### Footguns (documented, no bkit code)

- **`CLAUDE_CODE_SUBAGENT_MODEL` overrides ALL frontmatter model pins** — while
  set, every subagent (including the 9 fable pins) runs on that model. It is the
  documented below-floor workaround; unset it after upgrading CC.
- **Enterprise `availableModels` exclusions fall back silently**: an excluded
  model does not error — the agent inherits the main conversation model.
- **Fable safety-classifier headless refusals**: Fable may reroute/refuse
  security-adjacent or non-interactive (`claude -p`) work — the reason
  security-architect / code-analyzer / self-healing stay opus, and QA probes use
  innocuous prompts.
- **Provider alias table (R1)** — bkit makes NO universal "Sonnet 5" promise;
  AWS/Bedrock/Vertex aliases resolve to older models:

  | Provider path | `fable` | `opus` | `sonnet` |
  |---|---|---|---|
  | Anthropic API (CC ≥ 2.1.197) | Fable 5 (CC ≥ 2.1.170) | Opus 4.8 | Sonnet 5 |
  | Claude Platform on AWS | provider-specific full ID required | Opus 4.7 | Sonnet 4.6 |
  | Bedrock / Vertex / Foundry | provider-specific full ID required | Opus 4.6 | Sonnet 4.5 |

## [2.1.24] - 2026-07-01 (branch: `fix/skill-namespace-hook-reachability-125-126`)

> **Status**: Skill-orchestration namespace hardening. Fixes two related
> skill-hook defects reported by external dogfooder **[@hslee-cmyk](https://github.com/hslee-cmyk)**
> (GitHub #125 + #126, filed together during one investigation) plus every
> same-root-cause site found by mapping the fix's blast radius (no whack-a-mole).
> Root cause for both: Claude Code invokes plugin skills via the fully-qualified
> `plugin:skill` form (e.g. `bkit:pdca`), but bkit resolves skills by their bare
> on-disk folder name (`skills/pdca/`). Both reproductions were confirmed
> directly (namespaced `getSkillConfig` → `null`; live SessionStart false-positive
> `missing=[skill_post]`) before any fix. Every fix is guarded by new unit tests
> and the full Invocation Contract CI gate stays green.

### #125 — namespaced skill names silently lose next-skill / pdca-phase guidance

- **FIX — `getSkillConfig()` resolved `skills/bkit:pdca/SKILL.md` (ENOENT) → `null`**:
  `lib/skill-orchestrator.js` built the lookup path from the raw skill identifier,
  so any skill invoked through the CC `Skill` tool in `plugin:skill` form returned
  a null config — `next-skill` and `pdca-phase`-driven "next step" suggestions
  (e.g. "구현이 완료되면 Gap 분석을 실행하세요") never fired, silently and with no error.
- **NEW — `lib/core/skill-name.js` `normalizeSkillName()`**: single source of truth
  that canonicalizes any skill identifier (bare or namespaced) to its bare folder
  name by stripping the `plugin:` prefix. Null-safe; a bare name is a no-op.
  Sibling to `lib/core/name-validator.js` (which *rejects* unsafe names; this one
  *canonicalizes*). Its output is always path-safe.
- **FIX — same-root-cause sites hardened** (blast-radius sweep, not just the
  reported line):
  - `getSkillConfig` + `orchestrateSkillPre` (`lib/skill-orchestrator.js`) —
    normalize before path/cache lookup; bare and namespaced share one cache entry.
  - `scripts/skill-post.js` — canonicalize `tool_input.skill` once at the hook
    boundary so config lookup, the `CODE_GENERATION_SKILLS` `/copy` list, the
    active-skill marker, the audit target and PDCA-status update all see the bare name.
  - `scripts/user-prompt-handler.js` — implicit-trigger template injection resolved
    `skills/bkit:<skill>/SKILL.md` (always ENOENT, because `lib/intent/trigger.js`
    returns the namespaced form); now normalized, so implicit template injection works.
  - `scripts/unified-stop.js` — `SKILL_HANDLERS[activeSkill]` / `AGENT_HANDLERS`
    dispatch and the bare `activeSkill === 'control' | 'audit' | 'development-pipeline'`
    comparisons now canonicalize the detected name, so end-of-turn Stop handlers
    dispatch even when the active-skill marker held the namespaced form.

### #126 — hook-reachability check false-positive flags `skill_post` as dropped

- **FIX — `missing=[skill_post]` "CC plugin-hook drop (#57317) suspected" fired in
  normal usage**: the SessionStart MON-CC-NEW-PLUGIN-HOOK-DROP monitor treated a
  missing `skill_post` stamp identically to a dropped hook. But `skill_post` only
  fires on a `PostToolUse(Skill)` tool_use, and bkit's own documented workflow
  invokes skills via slash commands (`/pdca plan`), which produce no Skill tool_use
  — so `skill_post` legitimately never fires and the warning showed every session,
  eroding trust in the check (and risking real drops being dismissed as "the usual
  false alarm").
- **NEW — `lib/core/hook-reachability.js` `evaluateReachability()`**: pure,
  unit-testable classifier extracted from the inline SessionStart logic. Partitions
  the stamps into **canaries** (`bash_post` / `write_post` — fire on nearly every
  turn) and **event-driven** (`skill_post`). An event-driven hook is only reported
  as a drop when a canary is *also* unhealthy — a genuine `#57317` loader drop takes
  down all three together, so correlated failure is the reliable signal. When the
  canaries are healthy, an absent/stale `skill_post` is suppressed as "idle". This
  preserves the monitor's real purpose while eliminating the chronic false positive.
- `hooks/session-start.js` now delegates to `evaluateReachability`; audit details
  carry `canaryUnhealthy` + `skillPostIdle` for traceability.

### Tests

- **NEW** `test/unit/skill-name.test.js` (11 TC) — `normalizeSkillName` canonicalization + null-safety.
- **NEW** `test/unit/hook-reachability.test.js` (11 TC) — drop-vs-idle classification across
  the #126 repro, real-drop, partial-drop, and idle scenarios.
- **NEW** `test/unit/skill-orchestrator.test.js` SO-042…046 — namespaced `getSkillConfig` /
  `getAgentForAction` resolution parity + single-cache-key invariant.
- Both new lib modules registered in `test/run-all.js` and tracked (CI `check-test-tracking`).

### Credits

- **[@hslee-cmyk](https://github.com/hslee-cmyk)** — precise reproductions + root-cause
  file:line references + a suggested fix for #125, filed alongside #126 from the same
  investigation. Reproductions absorbed as permanent regression tests.

## [2.1.23] - 2026-06-23 (branch: `fixes/Sprint-System-Issues-6222026`)

> **Status**: Sprint System Restore-As-Designed. Restores the Sprint quality-gate system to its original designed behavior by fixing the 5 NIM2CC-reported issues plus ~10 second-order defects found via big-picture mapping (no whack-a-mole). Artifacts: design `docs/superpowers/specs/2026-06-22-sprint-restore-as-designed-design.en.md` (+ `.ko.md`) · plan `docs/superpowers/plans/2026-06-22-sprint-restore-as-designed.md`. Delivered across 5 slices + master E2E, executed via subagent-driven-development (fresh subagent per task + two-stage spec/quality review). **Success criterion met**: a real sprint runs the full 8-phase lifecycle (`init→start→plan→design→do→iterate→qa→report→archived`) through the dispatcher with zero manual JSON editing — proven by `tests/contract/sprint-restore-e2e.test.js`.

### Cluster A — Dispatcher Wiring (the root cause of the original 5 issues)

- **FIX — composition root never wired adapters**: `wireAgentAdapters` (`scripts/sprint-handler.js`) received `{}` so no `agentTaskRunner` ever reached the gates/iterators. The handler layer accepted injected adapters but the composition root constructed none.
  - Added `createTaskToolRunner(host)` host-adapter factory (`scripts/lib/sprint-handler-shared.js`) bridging the host's `invokeTaskTool` to the `({subagent_type, prompt}) => {output}` contract the domain expects.
  - `wireAgentAdapters` now builds/threads: `gapDetector` + `autoFixer` (from `agentTaskRunner`), `dataFlowValidator` (from `mcpClient`/`staticMatrix`), `agentTaskRunner` onto `measureDeps` + `phaseDeps`, and `taskCreator` (see Cluster F-remaining). Caller-supplied deps always win.
  - Documented the injection contract in `skills/sprint/SKILL.md`.

### Cluster B — M8 Chicken-and-Egg (Issue #5)

- **FIX — M8 unmeasurable at plan-exit**: at plan-exit the design doc does not yet exist, so M8 had no source artifact to measure → plan→design advance always gate-failed. `measure-router.buildPrompt` now resolves a phase-specific source: at `plan` it cites the plan doc's design section; at `design`+ it cites the Design doc §14 self-assessment checklist (via new `sourceArtifactPlanPhase` route field).

### Cluster C — Feature Tracking (featureMap never populated)

- **FIX — `featureMap` was always `{}`**: `createSprint` never populated it; the S2 featureCompletion gate therefore had nothing to read.
  - Added `completion` (0-100) to the `SprintFeatureMapEntry` typedef + populated `featureMap` in `createSprint`.
  - `handleFeature add/remove` now keeps `features[]` ↔ `featureMap` in lockstep (twin sources of truth).
  - Phase advance bumps each entry's `pdcaPhase` + `completion` (monotonic `max`, never decreases); `handleQA` grants `completion=100` + `qa='pass'` on a data-flow pass (the only path to 100).

### Cluster D — Auto-Pause Scope + S1 Persistence (Issues #3, #4)

- **FIX — auto-pause only checked M3/S1**: `checkAutoPauseTriggers` (via new `failingActiveGates` helper, `lib/application/sprint-lifecycle/auto-pause.js`) now inspects **every** active gate in `ACTIVE_GATES_BY_PHASE[phase]`, so `QUALITY_GATE_FAIL` fires on any failing gate (was silently missed for M1/M2/M4/M5/M7/M8/M10/S2).
- **FIX — `handleQA` didn't persist s1Score**: the computed S1 score was discarded → the S1 slot stayed null → advancePhase reported `not_measured` even after a successful QA. Now persisted to `qualityGates.S1_dataFlowIntegrity`.

### Cluster E — Docs

- **FEAT — `gate_fail` return carries an actionable hint**: names the failing gate key(s) + the exact `/sprint measure` + `/sprint phase` commands to run (advance-phase.usecase.js). Closes the Issue #93 "no user-facing signal on gate failure" gap.
- **DOCS — reconciled to code**: corrected the `SPRINT_AUTORUN_SCOPE` Trust-Level table in `commands/bkit.md` (was L1=design/L2=do/L3=qa; code is L0/L1=prd, L2=design, L3=report, L4=archived) + folded in the "--approve does NOT bypass Quality Gate failures" warning; fixed the stale "feature sub-action deferred" claim in `skills/sprint/examples/multi-feature-sprint.md` (featureMap sync is now live).

### Cluster F-gates — Gate Measurability ("no gate in limbo")

> Headline outcome: `UNSUPPORTED_GATES` is now **empty** — every gate in `ACTIVE_GATES_BY_PHASE` has a route (sub-agent, computed, or `not_applicable` exemption). Verified at runtime: SUPPORTED 11 / UNSUPPORTED [] / limbo [].

- **FEAT — M5 runtime error rate** (`measure-router.js`): routed to qa-monitor live-log probe; **exemptible** — when the project has no runtime logs (library/static site), the caller passes `logSourceAvailable=false` and the router returns `not_applicable` (counted as passed) instead of failing.
- **FEAT — M10 PDCA cycle time**: computed gate = sum of `phaseHistory` durations. **Follow-up fix**: the compute originally read a never-produced `durationHours` field; corrected to read `durationMs` (what `advance-phase.appendExitToHistory` actually writes) and convert to hours.
- **FEAT — S2 featureCompletion**: computed gate = ratio of `featureMap` entries with `completion >= threshold`. Empty featureMap → honest 0 (not vacuous 100).
- **FEAT — S4 archiveReadiness**: computed gate = every measurable report-phase gate passed AND `sprint.docs.report` present. Shares `computeArchiveReadiness` with `archiveSprint` (the archive path populates the S4 slot before its gate check, since `evaluateGate` reads slots not compute fns).
- **FIX — M5 exemption unreachable from the CLI**: `handleMeasure` + `runPhaseGates` never forwarded `logSourceAvailable` into the use case, so the `not_applicable` route was reachable only programmatically. Threaded `args`/`deps.logSourceAvailable` through both `ucDeps` objects (surfaces as `--no-logs`). Surfaced by the master E2E.
- **FIX — `measure-gate.usecase` honors the exemption**: when the router asserts `passed` explicitly (M5 not_applicable), the use case honors it directly instead of re-evaluating via `evaluateGate` (which flipped exempted gates to not_measured failures).

### Cluster F-state — Designed-But-Unimplemented Completion

- **FEAT — `dataFlow` + `annotations` on the Sprint typedef**: declared in v2113-Sprint-5 SC-01 / v2.1.19 s1-foundation FR-5 but never added. `dataFlow` (per-feature hop-result map) now initialized in `createSprint`; `annotations` (already set at runtime) now in the typedef.
- **FEAT — `handleQA` records per-hop results to `sprint.dataFlow[feature]`** (`{H1:{status,evidence,reason,from,to}, …}`), closing the data-flow validation loop: the Tier-2 static validator (`data-flow-validator.adapter`) already read this field but nothing populated it → a `staticMatrix` QA re-run found no matrix and failed every hop. Now probe → record → re-validate-from-record works (QA is replayable; works for archived sprints where live probing is impossible).
- **FEAT — skip-iterate `do→qa`**: `computeNextPhase` overloaded to accept a sprint object; at `do`, inspects `M1_matchRate` and returns `qa` when target met, else `iterate`. `transitions.js` already declared the `do→qa` edge legal — it was unreachable because `computeNextPhase` was phase-only. *(Autorun-loop activation deferred — see Deferred.)*
- **FIX — `handleWatch` ghost matrix types + require-path crash**: read `['data-flow','cumulative-state','feature-phase']` but only `data-flow` is real (the ghosts have no producer, no file, no design-doc backing). Now reads real `MATRIX_TYPES` from `sprint-paths` (the single SoT). Also removed a local `require(path.join(__dirname,'..','lib/application/...'))` that resolved to a nonexistent path and threw `MODULE_NOT_FOUND` on every call.
- **FIX — `handleFork` same require-path crash class**: the third and final instance of the broken relative-require pattern (handleFeature fixed earlier, handleWatch above). Removed; uses the module-level `domain` import. Repo-wide grep confirms no remaining instances.
- **FEAT — `handleMasterPlan` taskCreator wiring + emitter flush**: `generateMasterPlan` only created tracker tasks when `deps.taskCreator` was a function, but `wireAgentAdapters` never built one → master plans silently skipped tracker creation. Added `createTaskCreatorForRunner` factory (resilient — synthesizes a deterministic id on runner failure, never throws). Separately, `handleSprintAction` now best-effort flushes `infra.eventEmitter` after each action (the CLI exited without flushing, dropping buffered telemetry; flushed inside the action because `getInfra` returns a fresh non-singleton bundle per call, so a CLI-block flush would hit the wrong emitter).
- **FIX — `handleReport` never wrote the report**: `generateReport` accepted `deps.fileWriter` but `handleReport` never constructed one → reports built in-memory and never written, and `sprint.docs.report` stayed null (which blocked the S4 archive gate). Added `buildReportFileWriterForHandler`; handleReport writes the report + persists `sprint.docs.report`. Persistence guard checks the merged `reportDeps.fileWriter` (caller override of `null` correctly skips).

### Bundled fix — SessionStart session-id env var (Issue #119)

> **Status**: Independent of the Sprint restore work; bundled into this branch per request. Root cause + fix identified in the issue; delivered via a 2-agent (behavioral + structural) investigation, then TDD.

- **FIX — wrong session-id env var**: bkit read `process.env.CLAUDE_SESSION_ID`, but Claude Code exposes `CLAUDE_CODE_SESSION_ID`. `sessionId` was therefore always null on the SessionStart path → the per-session stable tag (`·a1b2`) introduced in #111 (F2) never appended → every concurrent Claude Code session in the same project directory rendered the identical title `[bkit] {primaryFeature}`, making two terminal windows indistinguishable. Present since at least 2.1.19.
  - Centralized the resolution in `lib/infra/cc-bridge.getSessionId()` (the canonical accessor; only imports Node built-ins, no cycle) with the chain **payload `session_id` → `CLAUDE_CODE_SESSION_ID` → `CLAUDE_SESSION_ID` (legacy back-compat) → null** — matching the #111 Stop-path approach where the stdin payload is the most authoritative source.
  - Applied the same chain at all 4 production sites: `hooks/session-start.js:300` (the cited root cause), `scripts/unified-stop.js:655,680`, `lib/orchestrator/team-protocol.js:92`. Every production code read now prefers `CLAUDE_CODE_SESSION_ID`; the only remaining `CLAUDE_SESSION_ID` references in prod are JSDoc fallback-chain docs.
  - **Design decision (env vs payload for session-start)**: `session-start.js` does not parse stdin at the title block, and adding a second `readStdinSync()` deep in the hook risks a double-stdin-read. Since Claude Code sets `CLAUDE_CODE_SESSION_ID` in the process environment before the hook runs, the env var is the correct/authoritative source for SessionStart (the payload is the correct source for Stop — which is why #111 already threads `hookContext.session_id` there). Two different hooks, two right answers.
  - **Incidental fix**: `test/integration/issue77-hook-e2e.test.js` TC-IT3a was a pre-existing broken test (asserted a tag-less title that only the *broken env path* would produce, while exercising the *working payload path*). Now passes for the first time with the corrected `·a096` expectation.
- **Verification**: 9 new contract assertions (`tests/contract/session-id-env-119.test.js` — resolution chain + concurrent-session tag disambiguation); `cc-bridge.test.js` (24/24) updated to assert the new chain; 4 injection sites in integration/QA tests switched from `CLAUDE_SESSION_ID` to `CLAUDE_CODE_SESSION_ID`. Confirmed two different session ids produce distinct `·<tag>` suffixes (the #111/#119 payoff).
- **E2E regression guard** (`test/regression/issue-119-session-id-env.test.js`): env-var resolution asserted through the real `cc-bridge` accessor + tag-disambiguation payoff via the real `scripts/user-prompt-handler.js` subprocess with a PDCA fixture (two distinct session ids → distinct titles) (6 assertions). Placed alongside `issue-53-path-quoting.test.js`.

### Bundled fix — Cursor IDE PreToolUse JSON output (Issue #118)

> **Status**: Independent of the Sprint restore work; bundled into this branch per request. Root cause + fix identified in the issue; delivered via a 2-agent (behavioral + structural) investigation, then TDD.

- **FIX — `lib/core/io.js` emitted Claude-Code-format output under Cursor**: When bkit runs under Cursor IDE's Claude plugin bridge (detected via `process.env.CURSOR_VERSION`), the PreToolUse hook runner expects a different JSON schema than Claude Code. `outputAllow`/`outputBlock`/`outputBlockWithContext` previously emitted plain text (allow) and `{"decision":"block",...}` (deny) → Cursor failed with `JSON Parse Error: Unexpected token ...` and blocked Write/StrReplace/Shell until the plugin was disabled.
  - Added `isCursorRuntime()` (`!!process.env.CURSOR_VERSION`, empty-string treated as unset) and branched the 3 PreToolUse-reachable output functions:
    - **allow** → `{"permission":"allow","agent_message":...}` (message omitted when empty)
    - **deny** → `{"permission":"deny","user_message":...,"agent_message":...}` (both fields populated; graceful `exit(0)`)
    - **deny-with-context** → same deny schema, with the safer-alternatives list folded into `agent_message` (Cursor has no `hookSpecificOutput`, so the CC additional-context channel is remapped to the agent message).
  - Stop-hook functions (`outputStopSurface`/`outputStopAllow`) and `outputEmpty` intentionally unchanged — Cursor only bridges PreToolUse, so they're unreachable under Cursor; CC behavior is byte-identical when `CURSOR_VERSION` is unset.
  - **No hook-script changes needed**: the branch lives at the single `io.js` chokepoint that all 20+ hook callers (pre-write, unified-bash-pre, phase9-deploy-pre, plus PostToolUse/Notification/Subagent paths) already share — all callers inherit Cursor support. Verified E2E via `scripts/pre-write.js` under `CURSOR_VERSION=3.6.31`.
- **8 new contract assertions** (`tests/contract/cursor-pretooluse-json-118.test.js`): Cursor allow/deny/deny-with-context schema + CC-format regression guard (plain-text allow, `{success,message}`, `{decision:"block"}`) + `isCursorRuntime` export.
- **E2E regression guard** (`test/regression/issue-118-cursor-pretooluse.test.js`): spawns the real `scripts/pre-write.js` under `CURSOR_VERSION` and asserts stdout is valid Cursor JSON (`{"permission":"allow"|"deny",...}`, no CC-only `decision:block` leak) + CC plain-text behavior unchanged without the env var (3 assertions). Placed alongside the existing `issue-53-path-quoting.test.js` so the bug cannot recur silently.

### Verification

- **96 test assertions** across 14 tracked test files (`sprint-restore-slice1..5`, `slice2-followups`, `slice3-{completion,report,acceptance}`, `sprint-restore-e2e`, `cursor-pretooluse-json-118`, `session-id-env-119`, plus e2e regression guards `test/regression/issue-118-cursor-pretooluse` + `test/regression/issue-119-session-id-env`), all PASS. Plus 2 bundled-fix integration/QA updates (issue77-hook-e2e TC-IT3a corrected, 4 env-injection sites migrated to `CLAUDE_CODE_SESSION_ID`).
- **Master E2E** (`sprint-restore-e2e.test.js`): full lifecycle via the in-process dispatcher, value-aware runner (0 for `<=` count gates, 100 for `>=` percent gates), zero manual JSON editing. Reaches `status:'archived'` with S2=100, S4 ready, `docs.report` set, featureMap completions advanced.
- **Lint**: 0 errors on changed production code (pre-existing warnings only); **0 linting bypasses** added (`noqa`/`eslint-disable`/`@ts-ignore`/`type: ignore` — none).
- **Final reviewer verdict**: READY TO MERGE.

### Deferred (tracked, not silently dropped)

- **Skip-iterate autorun-loop activation**: Slice 4 made `computeNextPhase` CAPABLE of `do→qa` skip-iterate, but the autorun loop still passes `sprint.phase` (string) → takes the back-compat path → routes `do→iterate` unconditionally (CAPABLE-BUT-INERT). Wiring the loop (`computeNextPhase(sprint)`) is a one-line change `transitions.js` already permits, but it activates skip-iterate inside the E2E autorun loop — intersecting pause-trigger arming, budget accounting, and phase-timeout behavior → deserves its own PDCA-tracked unit with E2E autorun coverage. Recorded in `work/sprint-investigation/out-of-scope.md` §5 + a `// NOTE` TODO at the call site (`start-sprint.usecase.js`).

## [2.1.22] - 2026-06-02 (branch: `release/v2.1.22-hardening`)

> **Status**: Hardening Release (in progress) — 6-sprint master plan (`docs/01-plan/features/v2.1.22-hardening.master-plan.md`). No new user-facing features; quality hardening / consistency only. Kahn order S1→S2→S4→S3a→S3b→S5.

### S1 — CC v2.1.159 Response (ENH-324~328)

> Input basis: `docs/04-report/features/cc-v2146-v2159-impact-analysis.report.md` (CC v2.1.146→v2.1.159, 13-version batch, ADR 0003 16th cycle).

- **ENH-324 — ENH-317 CANCELLED (MOOT)**: The previous cycle (v2.1.21 analysis) treated CC v2.1.147's `/simplify` → `/code-review` rename as Breaking-equivalent and created ENH-317 (deferred rename), but CC **reverted** it in **v2.1.152** (reintroducing `/simplify` as a `/code-review --fix` alias) and **v2.1.154** (independently restoring `/simplify` as a cleanup-only review). NET: both `/simplify` (cleanup) and `/code-review` (bug-hunt + effort) are valid. bkit's 10 `/simplify` code surfaces (`lib/intent/language.js:147`, etc.) carry cleanup semantics and **match CC v2.1.154 exactly** → no change needed. **bkit's deferred (do-not-force) decision is vindicated** (had the rename been forced at v147, a revert would have been required at v154).
- **ENH-325 — recommended CC version bump decision**: Balanced recommendation v2.1.146 → **v2.1.159** (Opus 4.8 default high-effort = bkit's 17 opus agents + ENH-300 effort-aware alignment, v2.1.156 thinking-block API error fix). Conservative recommendation v2.1.123 → **v2.1.150 stable** (mitigates the +36 extreme drift). *Reflection of the documentation wording is batched into S5 docs-sync (to prevent drift recurrence).*
- **ENH-326 — sessionTitle resume (formalized in CC v2.1.152) verification PASS**: CC v2.1.152 officially supports SessionStart `hookSpecificOutput.sessionTitle` on both startup and resume. Confirmed that bkit `hooks/session-start.js:301` unconditionally generates and emits sessionTitle (no startup-only guard) → covers the resume path. bkit ENH-226's undocumented dependency is elevated to an official contract.
- **ENH-327 — multi-Agent frontmatter (CC v2.1.147 fix) no-impact confirmation**: CC v147 fixed the bug where "in the inline `Agent(a), Agent(b)` form of the tools: frontmatter, all but the last were dropped." bkit uses the **YAML block-list** form (one Task() per line) → no impact (the only inline-comma hit is prose in the body of `pm-lead.md:45`). All 12 agents, including cto-lead with 38 Task(), are safe. The fix provides future safety.
- **ENH-328 — 2 new monitors registered + differentiation streak update**: Registered **MON-CC-NEW-CHOICE-LOOP** (P1, #64447 infinite loop awaiting user choice, adjacent to v154 MCQ behavior) + **MON-CC-NEW-BG-OTEL-DROP** (P2, #64436 background OTEL log drop) in `lib/cc-regression/registry.js` (CC_REGRESSIONS 22→24). Differentiation streak: **#56293→17** (ENH-292) / **#57317→11** (ENH-303) / **#58904→7** (ENH-310) — unresolved across v147~v159; v154 `/workflows` parallel spawn AMPLIFIES #56293 caching 10x → strengthens the ENH-292 sequential-dispatch moat. **Continuous-compatibility 101→112 milestone**.

### S2 — Cross-Platform Verification (mac/windows) (ENH-329~335)

> Input basis: master plan §10 S2 + this sprint's line-level field measurement. Artifacts: `docs/01-plan/features/cross-platform-mac-windows.plan.md` · `docs/02-design/features/cross-platform-mac-windows.design.md` · `docs/04-report/features/cross-platform-mac-windows.report.md`. **Field-measurement correction**: the master plan's worst-case estimates (14 raw concats / expanded shell branching / 21 hooks at risk) were overstated — bkit is already ~90% cross-platform-safe (`path.join` 349, raw `__dirname+'/'` concat 0, exec uses only git/gh/node/npx, POSIX coreutils exec 0). The real risk is a single category: **CRLF-unhandled frontmatter/markdown parsers**.

- **ENH-331 — CRLF/LF handling (P0, hard-break fix)**: Fixed a defect where, on Windows CRLF (`---\r\n`) files, the frontmatter fence regex `/^---\n.../` **failed to match entirely** → breaking skill/agent/output-style loading. (a) Applied `\r?\n` to the fence regex in 6 places: `lib/util/markdown-parse.js:49`, `lib/qa/utils/pattern-matcher.js:186`, **`hooks/startup/context-init.js:146` (runtime hook)**, `scripts/validate-plugin.js:83`, `scripts/audit-output-styles.js:21/45`. (b) Converted file-content `split('\n')` → `split(/\r?\n/)` across **34 sites / 19 files** (skill-orchestrator · import-resolver · pattern-matcher · workflow-parser · discovery/explorer · audit · cc-regression, etc.). *Those already using `\r?\n` — skill-orchestrator:60 · frontmatter.js:57/109 · import-resolver:176 — were verified (no change needed).*
- **ENH-329 — Path separator consistency**: Added backslash normalization (`.replace(/\\/g,'/')`) to the module-path comparison in `scripts/check-deadcode.js` (to guard against win32 glob/fs results). Annotated in a comment that the glob-pattern split in `lib/qa/utils/file-resolver.js:76` follows a forward-slash convention (not an fs path). `lib/ui/impact-view.js` is already normalized (verified).
- **ENH-330 — Shell branching verification (YAGNI)**: Full audit of 18 exec files — only `git`/`gh`/`node`/`npx` are used, POSIX coreutils (find/wc/grep/cat) exec **0** → confirmed **no bash↔pwsh branching needed**. The existing 2 `process.platform` sites (defense-coordinator · enh-254-fork-precondition) are sufficient. The "no branching needed" rationale is codified in the design as a future regression baseline.
- **ENH-332 — Hook Windows firing verification**: All 25 hooks.json commands use the `node "${CLAUDE_PLUGIN_ROOT}/<path>.js"` form (node accepts forward-slash on win32 → safe); the 61 files with shebang `#!/usr/bin/env node` are inert under direct `node` invocation (irrelevant on win32). Of the 8 hook .js files, only the context-init fence needs fixing (covered by ENH-331).
- **Verification**: CRLF runtime QA **8/8 PASS** (3 frontmatter parsers × CRLF/LF), regressions **0** (test suite `comm` comparison before/after change — 7 pre-existing fails identical before and after), `verify-full-system` module 188/188 · hook syntax 69/69 · agent 40/40 · hooks.json 25/25 PASS. Regression invariant: `\n`→`\r?\n` and `'\n'`→`/\r?\n/` are byte-identical on LF input (no regression on mac/linux).
- **Limitations/Carry (ENH-335)**: Current environment is Darwin → **actual Windows runtime firing verification was not performed** (only up to static analysis + consistency + CRLF no-regression). Actual Windows/PS/WSL verification is split into a **follow-up ENH (CI matrix)**. Residual `split('\n')` in scripts/ (dev/CI tooling, low risk) is carried as a follow-up consistency cleanup.

### S6 — CC Stop Hook Output Schema Compliance (ENH-361~366)

> Active incorporation (2026-06-01): after S2 completion, while the user was running `/sprint list`, a `Stop hook error: Hook JSON output validation failed — (root): Invalid input` occurred → in-depth analysis confirmed a systemic defect common to 5 Stop emitters → new P0 sprint. Artifacts: `docs/03-analysis/features/cc-stop-hook-schema-compliance.analysis.md` · `docs/01-plan|02-design|04-report/features/cc-stop-hook-schema-compliance.*`. Kahn re-sequencing S1→S2→**S6**→S4→S3a→S3b→S5.

- **Root cause (RC0)**: `lib/domain/ports/cc-payload.port.js` **mistyped** `decision` as `'allow'|'deny'|'ask'|'defer'` (= permissionDecision values) → 5 emitters output `decision:'allow'` (CC Stop accepts only `approve|block`) + Stop-unsupported `hookSpecificOutput` (additionalContext/sessionTitle/userPrompt) + out-of-schema root fields (`skillResult`/`autoTrigger`/`iterationResult`/`analysisResult`). CC rejected these as CC tightened hook-output validation in the **same class** as the plugin manifest schema hardening (ADR 0011).
- **ENH-361**: Corrected the `cc-payload.port.js` HookOutput typedef — separated `decision:'approve'|'block'` (Stop) ↔ `permissionDecision:'allow'|'deny'|'ask'` (PreToolUse) + contract JSDoc.
- **ENH-364**: Added single-SoT helpers to `lib/core/io.js`: `outputStopSurface(reason)` (= `{decision:'block',reason}`, forcing Claude to render a summary + next-step — preserving the #113 intent) / `outputStopAllow()` (= `{}`, clean stop).
- **ENH-362/363**: Converted 5 emitters (`sprint-skill-stop` · `pdca-skill-stop` · `plan-plus-stop` · `iterator-stop` · `gap-detector-stop`) to compliant — removed `decision:'allow'`, `hookSpecificOutput`, and non-schema root fields; executive summary → `reason`, AskUserQuestion options → serialized into `reason` text, structured data → `debugLog`. Cleaned up unused imports.
- **ENH-365**: `tests/contract/v2122-stop-hook-output-schema.test.js` (new) — contract guard for the 5 emitters' output against the CC Stop schema (blocks recurrence). Corrected `test/unit/sprint-skill-stop.test.js` (old buggy shape → compliant, 20/20).
- **ENH-366**: Registered `MON-CC-NEW-STOP-SCHEMA-STRICT` (HIGH) in `lib/cc-regression/registry.js` (R3-321 lineage, resolved by bkit S6).
- **Verification**: runtime schema QA **31/31** (5 emitters × key-set / decision enum / forbidden fields), unit e2e **20/20** (including unified-stop dispatch + marker consume), regressions **0** (before/after `comm`), contract test exit 0. Representative: `gap-detector-stop` → `{"decision":"block","reason":...}` (previously rejected), read-only sprint → `{}`.
- **Limitations/Carry**: sessionTitle on Stop is lost (CC unsupported) → unified into SessionStart (#111 per-Stop title refresh lost, impact LOW). The CC strict-validation introduction version is unknown (v2.1.159 confirmed, reconcile pin TODO).

### S4 — Tech-Debt & Dead-Code Elimination (ENH-336~342)

> Input basis: master plan §10 S4 + this sprint's full field measurement. Artifacts: `docs/01-plan|02-design|04-report/features/tech-debt-deadcode-elimination.*`. **Field-measurement correction**: the estimates (6 pdca-eval stubs / 19~491 test skips / 5 TODOs / dead module / orphan script) were all raw-match over-counts — **0 items of dead code to remove**. Every candidate is live (contract-required / CI-invoked / test-depended / CLI entry point / documentation tooling).

- **ENH-336 (governance decision — core)**: Confirmed **permanent retention** of the 6 deprecated stubs `pdca-eval-{act,check,design,do,plan,pm}`. Rationale: (1) the v2.1.9 + v2.1.16 immutable contract baselines both list all 6, (2) `contract-test-run.js runL4Deprecation()` yields `L4 FAIL` if a baselined agent is absent without a `deprecatedIn` stub, (3) the stubs carry `deprecatedIn:v2.1.13` → currently L4 PASS. Removing them would corrupt 2 historical immutable baselines + break the `Active+Deprecated===agents+6` invariant → prohibited. **Implementation**: added a governance-lock comment to `EXPECTED_DEPRECATED_AGENT_NAMES` in `lib/domain/rules/docs-code-invariants.js` (prevents future erroneous deletion; value/export unchanged).
- **ENH-337 (test skip triage)**: Actually disabled tests **0** — `\b(it|describe|test|context|suite)\.skip\b`/`.only`/`xit(` are all 0 (the 412 were `process.exit(` substring mismatches). The custom `skip(id,msg)` helper is legitimate conditional-skip infrastructure. No removals.
- **ENH-338 (TODO triage)**: Across lib/scripts/hooks, TODOs total **1** (the intentional reconcile-pin forward-TODO added in S6). Retained.
- **ENH-339 (dead lib module)**: `scripts/check-deadcode.js` → **Dead(NEW)=0** (188 modules: 141 live / 47 exempt [type-only port · facade · dynamic load] / 0 legacy debt). No removals.
- **ENH-340 (orphan script / stale state)**: Full verification of 7 unreferenced candidates → all live (`check-deadcode`/`check-guards`/`check-test-tracking` = `.github/workflows/contract-check.yml` CI, `verify-full-system` = full-system verifier CLI, `audit-output-styles`/`sprint-memory-writer` = docs + CLI, `sync-folders` = `tests/qa/v2112-deep-qa-fixes.test.js` test dependency + bkit-system catalog). True orphans **0**. `.bkit/state` is gitignored local-only (release-irrelevant).
- **ENH-341 (removal manifest)**: **Total safe removals 0** + per-candidate live rationale (safety justification) documented (design §2).
- **Verification**: L4 deprecation governance PASS (v2.1.9+v2.1.16 exit 0), check-deadcode Dead=0, the `Active(34)+Deprecated(6)===agents(34)+6` invariant true, regressions **0** (before/after `comm`, 7 pre-existing identical). The only code change is the single governance comment (M4=100).

### S3a — Context-Eng Simplification: God-File Split (ENH-343~348)

> Input basis: master plan §8 simplicity invariant + §10 S3a. Artifacts: `docs/01-plan|02-design|04-report/features/ctx-eng-godfile-split.*`. **god-files (>700 LOC) 4 → 0**. All behavior-preserving extractions (verbatim move + re-export, logic unchanged), one commit checkpoint per file (no half-broken states), with contract L1+L4 + check-deadcode + full regression passing on every split.

- **ENH-346** `scripts/unified-stop.js` 751→**693**: 10 lazy-dep getters → `scripts/lib/unified-stop-deps.js` (path ../lib→../../lib rebase). (commit 2c49218)
- **ENH-345** `lib/pdca/automation.js` 770→**451**: 3 AskUserQuestion/user-prompt builders (emitUserPrompt/formatAskUserQuestion/buildNextActionQuestion) → `lib/pdca/automation-questions.js` (pure, no impact via re-export to external consumers). (commit e43bb0f)
- **ENH-344** `lib/pdca/state-machine.js` 985→**406**: STATES/EVENTS/TRANSITIONS(25)/GUARDS/ACTIONS + _checkChromeMcpAvailable → `lib/pdca/state-transitions.js` (self-contained data, getCore/getStatus/getPhase duplicated). (commit 43d47a2)
- **ENH-343** `scripts/sprint-handler.js` 1509→**271**: highest risk (sprint dispatcher). 4-module decomposition — helpers → `scripts/lib/sprint-handler-shared.js` (361), 14 lifecycle handlers → `sprint-handlers-core.js` (514), 6 admin handlers → `sprint-handlers-admin.js` (541). Handlers do not call one another (verified) → unidirectional dependency (shared←handlers←dispatcher), no cycles. Public exports `{handleSprintAction, VALID_ACTIONS, getInfra}` unchanged. 14 inline lazy requires rebased. (commit cec28c4)
- **ENH-347**: audit-logger(689)/gap-detector-stop(602)/trust-engine(577) <700 → not god-files, monitor only (not split).
- **ENH-348 simplicity invariant final verification**: god-files **0**, largest file **541** (≤700), lib subdirs **22** (no increase), lib modules **190** (+2, ≤+10), contract assertions **255/234** (unchanged), all gates green.
- **Verification**: dispatcher live behavior (help/list/status/measure/trust idempotent-noop), sprint-handler dedicated tests 6/6 + state-machine 4/4 PASS, contract L1+L4 255/234 PASS (across all splits), check-deadcode Dead=0, verify-full-system module 190/190 · hook 73/73 · agent 40/40 · hooks.json 25/25, regressions **0** (each of the 4 splits identical to baseline 7).

### S3b — Context-Eng Simplification: Layer/Pipeline Consolidation (ENH-349~354)

> Input basis: master plan §8 simplicity invariant + §10 S3b. Artifacts: `docs/01-plan|02-design|04-report/features/ctx-eng-layer-consolidation.*` + **ADR `docs/adr/0013-context-engineering-factoring.md`**. **0 code changes** — full code verification found no actionable redundancy to consolidate (the same "estimate ≠ field measurement" as S2/S4). The S3b simplification outcome is already realized by S3a's god-file 4→0.

- **ENH-349~352 (consolidation verification)**: All consolidation candidates proved non-redundant → 0 consolidations. (a) lib subdirs 22≤22 satisfied; single-module subdirs are distinct feature + skill/MCP entry points (lib/sprint 38 importers). (b) the "8-layer context engineering" is a **conceptual capability map** from `AI-NATIVE §205-212` (L1 Skills~L8 Sprint), not code → merging = capability removal (Anti-Mission violation). (c) the 8 Ports (audit-sink/caching-cost/cc-payload/docs-code-index/mcp-tool/regression-registry/state-store/token-meter) are all distinct DDD contracts. (d) frontmatter parsing is **already consolidated** in `lib/util/frontmatter.js` (v2.1.18 CO-5) + `markdown-parse.js` (v2.1.19 S3) (actually required by docs-code-scanner + 5 baseline consumers). (e) identical basenames (executive-summary/transitions/phases) are **intentional parallel domains** of pdca∥sprint.
- **ENH-353 (ADR 0013)**: Permanently records that the Context Engineering structure is intentional factoring — non-consolidation reasons (capability preservation + churn>benefit + 255 assertion risk) + future consolidation trigger condition (only when 2+ independent implementations of the same purpose diverge). Blocks future "structure-count-based" consolidation urges.
- **ENH-354 (simplicity invariant verification)**: god-files **0**, largest file **693**, lib subdirs **22**, lib modules **190(+2)**, layers **8 (concept preserved)**, contract **255/234 unchanged**, all gates green — all satisfied.
- **Verification**: contract L1+L4 255/234 PASS, check-deadcode Dead=0, regressions **0** (no code change, identical to baseline 7), code files changed 0 (docs/ADR only, M4=100).

## [2.1.21] - 2026-05-29 (branch: `release/v2.1.21-issue-response`)

> **Status**: Issue Response Sprint — resolved 2 external dogfooder open issues in a single unified sprint (`v2121-issue-response`, Trust L4). **#111** (sessionTitle conflict, reporter @wonuseo, external dogfooder #3) + **#113** (insufficient Sprint screen output enforcement, reporter @rohwonseok-ops). Based on actual codebase file:line verification (principle of not accepting external dogfooder claims unverified).
> **Scope**: 8 features (P0×3 #111 / P1×4 + P2×1 #113) · 2 new modules (`lib/sprint/executive-summary.js`, `scripts/sprint-skill-stop.js`) · 8 refactors (session-title-cache / session-title / 4 Stop emitters / unified-stop / advance-phase.usecase / sprint-handler) · 5 new/extended TC files (79 new TC) · 1 new ADR (0012 Sprint Stop Hook Output Enforcement).
> **Sprint planning**: `docs/01-plan/features/v2121-issue-response.master-plan.md` + `docs/00-pm/v2121-issue-response.prd.md` (sprint-master-planner agent 3rd-cycle dogfooding output).
> **Anti-Mission preserved**: did not fully redesign the session-title format (kept the `[bkit] {action} {feature}` skeleton + only appended a tag) · did not share code with the PDCA executive-summary (separate Sprint shape) · did not fundamentally fix `getActiveSkill()` (skill_post drop #57317) (only bypassed via skill_name priority dependence) · sprint phase enum/state-machine unchanged.

### Issue #111 — Session Title Isolation (Phase B, P0) — extends #77

Resolved a bug present in all v2.1.6~v2.1.20 versions where parallel sessions in the same PROJECT_DIR with the same feature/phase had **identical window titles** (`[bkit] PLAN f1`) (risk of entering dangerous commands into the wrong window). #77 v2.1.6 Phase A only solved per-message overwrite, opt-out, and stale TTL; session isolation remained incomplete.

- **F1** `lib/core/session-title-cache.js` — converted the single flat record per PROJECT_DIR into a `{ $schemaVersion: 2, sessions: { [sessionId]: {...} } }` map structure. Mirrors the `session-ctx-fp.js` validation pattern (atomic write + inline GC: stale 7d TTL + LRU cap 200). Legacy flat records are auto-migrated once in `readCache()` (backward-compat). Switched `isSameAsCached` to per-session lookup → removed the side effect where session B clobbered session A's record (which broke ENH-228 phase-change-only dedup).
- **F2** `lib/pdca/session-title.js` — appends a sessionId-based stable short tag (`·a1b2`, sha256 truncation) to the end of the title (`[bkit] PLAN f1 ·a1b2`). Supports the `{tag}` format token + auto-appends when not included in the format. Omits the tag when sessionId is absent (backward-compat). Exports `sessionTag()`.
- **F3** session_id threading — 4 Stop emitters (5 call sites) in `scripts/{iterator-stop,plan-plus-stop,pdca-skill-stop,gap-detector-stop}.js` now pass the session identifier via `generateSessionTitle({ ..., sessionId: input.session_id })` (previously not passed → tag not appended).

### Issue #113 — Sprint Output Enforcement (P1/P2) — extends #93

Resolved the visibility gap where Sprint's success/intermediate/status/watch paths returned only raw JSON, relying 100% on LLM narration. Introduced Stop hook output enforcement to Sprint, equivalent to PDCA.

- **F4** `lib/sprint/executive-summary.js` (new) — Sprint shape Executive Summary (Mission/Result/matchRate/Cross-Sprint Integration/Invariant/plugin validate). **Separate** from the PDCA shape (problem/solution/...) (#113 §D). Pure module (no disk I/O). Shares a single source for the per-feature table with F8 via `formatStatusScreen()`/`formatFeatureTable()`.
- **F5** `scripts/sprint-skill-stop.js` (new) — Sprint Stop hook. Outputs Exec Summary + AskUserQuestion + sessionTitle. Adopted the **run-export pattern** (`module.exports = { run }`, identical to cto-stop/team-stop) — the bare-require-`{}` pattern (pdca-skill-stop) is a no-op when routed through unified-stop `executeHandler`'s `require()`, so run-export is required to guarantee actual dispatch. Relies on skill_name priority (avoiding #57317).
- **F6** `scripts/unified-stop.js` + **new `lib/core/active-skill-marker.js`** — registers `'sprint'` in `SKILL_HANDLERS` + a **cross-process active-skill marker** dispatch path. **A defect discovered through actual `claude -p` verification**: CC does not include `skill_name` in the Stop payload (`hasSkillName:false` measured), `getActiveSkill()` is in-memory so it is useless cross-process + skill_post #57317 drop → all 4 paths of `detectActiveSkill()` wiped out → with the existing design **no skill Stop handler fires in production** (PDCA included). Resolution: sprint-handler writes `.bkit/runtime/active-skill.json` → unified-stop peeks (detectActiveSkill 3.5) → sprint-skill-stop consumes (TTL 10 min + consume-once). Confirmed in the actual runtime via `Detection result: activeSkill="sprint"` → `handled:true`.
- **F7** `lib/application/sprint-lifecycle/advance-phase.usecase.js` — added `phaseTransitionSummary` output to the SUCCESS path. Caller-injected `deps.transitionSummaryBuilder` (mirroring the #93 failureReporter DI discipline) — keeps usecase purity (no fs write or lib/sprint import), with `scripts/sprint-handler.js handlePhase` doing the wiring.
- **F8** `scripts/sprint-handler.js` — `handleStatus`/`handleWatch` attach a `display` field (human-readable per-feature table + one-line gates summary) to the result (#113 §C). Raw JSON is preserved for programmatic use.

### Architecture Decision Records

- **ADR 0012** (new) — Sprint Stop Hook Output Enforcement: (D1) run-export pattern (avoiding bare-require no-op, necessary condition), (D2) sprint shape separate from PDCA, (D3) usecase purity DI, (D5) **cross-process active-skill marker** (bypassing the wipeout of all 4 detectActiveSkill paths — sufficient condition). Inherits the #93/v2.1.16 + ADR 0011 precedent.

### Tests

- `test/unit/session-title.test.js` (extended +8 TC) — 2-session DISTINCT title / dedup restoration after clobber / legacy migration / tag omission on sessionId absence / sessionTag determinism.
- `test/unit/sprint-executive-summary.test.js` (new 28 TC) — sprint shape / PDCA shape separation / context override / next actions / feature table / formatStatusScreen.
- `test/unit/sprint-skill-stop.test.js` (new 20 TC) — Exec Summary output / sessionTitle tag / userPrompt / no output on read-only / run-export / unified-stop e2e dispatch (TC-U1) / **marker-path production dispatch (TC-U2) / misfire prevention (TC-U3)**.
- `test/unit/active-skill-marker.test.js` (new 10 TC) — write/read/consume roundtrip / TTL expiry / corrupt JSON defense / consume-once.
- `test/contract/sprint-skill-handler-registration.test.js` (new 5 TC) — SKILL_HANDLERS sprint entry + run-export structure invariant.
- `test/unit/sprint-lifecycle/advance-phase-transition-summary.test.js` (new 11 TC) — phaseTransitionSummary DI contract + usecase purity (absence of fs/lib-sprint import) contract.
- **Total 92 new/extended TC** (all PASS). Includes actual `claude -p --plugin-dir .` runtime dispatch verification (static checks + synthetic payloads alone miss the dispatch defect — [[feedback_thorough_qa]]).

### Cross-references

- #111 ⊃ #77 (v2.1.6 Phase A session isolation incomplete) · #113 ⊃ #93 (v2.1.16 gate_fail human-readable, success path unresolved).
- **Latent finding (CARRY-#113-1)**: PDCA-family skill Stop handlers (pdca-skill-stop / gap-detector-stop / iterator-stop / plan-plus-stop) **likewise fail to fire in production** (verified via actual `claude -p`) due to (a) bare-require-`{}` no-op + (b) the wipeout of all 4 `detectActiveSkill()` paths. sprint fully resolved this via run-export (D1) + active-skill marker (D5). The PDCA family can also be converted to the same pattern (run-export + handler marker), but since it requires separate regression verification, it is carried to v2.1.22+.

## [2.1.20] - 2026-05-26 (branch: `release/v2.1.20-marketplace-recovery`)

> **Status**: Marketplace Recovery + Plugin Manifest Schema Compliance Sprint — triggered by external dogfooder Jeong Byeong-jin (@bj)'s 2026-05-26 bkit v2.1.14 install failure (`Validation errors: : Unrecognized key: "displayName"`) incident. The cc-version-researcher's 88%-confidence conclusion (Jeong Byeong-jin's CC estimated ≤ v2.1.142 — `displayName` is an official schema key as of v2.1.143+) → 3-layer response (Recovery + Defense + Forward-proofing) + bkit Early Adopter Program external dogfooder #2 entry.
> **Scope**: 14 features (P0×4 / P1×5 / P2×5) · 3 sub-sprints · 3 new ENH (321/322/323) · 1 new ADR (0011 Plugin Manifest Schema Compliance Policy) · 1 external dogfooder #2 (@bj).
> **Sprint planning**: `docs/sprint/v2120-marketplace-recovery/{master-plan,prd,plan,design}.md` (sprint-master-planner agent 2nd-cycle dogfooding output).
> **Anti-Mission preserved**: did not remove `displayName` (blocks v2.1.143+ UI picker regression) · did not hard-reject CC v2.1.142 or below (advisory only, minimizing UX entry barriers) · did not resolve the Anthropic docs vs implementation lenient/strict contradiction (Q1) ourselves (external responsibility) · did not change the bkit-starter plugin (no displayName included, impact 0).
> **External dogfooder #2**: @bj (Jeong Byeong-jin) — joined 2026-05-26 (Lifecycle Stage 1 → Stage 5), entry at `docs/external-dogfooders/bj.md`.

### External Dogfooder Contributions

- **@bj** (Jeong Byeong-jin) — bkit v2.1.14 install incident (2026-05-26). Drove the entire v2.1.20 sprint via precise error message + cache path + environment metadata sharing. Reproduction scenario absorbed at `test/e2e/external-dogfood/cc-min-version.test.js` (5 TC, Lifecycle Stage 4 Regression Lock achieved). Trust Score `externalDogfoodFeedbackResponseRate` (weight 0.05) accumulated. See `docs/external-dogfooders/bj.md` (Hall of Fame #2).

### 3 Sub-Sprints (Kahn topological)

**Sub-sprint 1 — Recovery (P0×4)** (commit `fb3e1bf`)

- **F1** README.md / README-FULL.md — minimum CC v2.1.143 advisory 1-line, Claude Code badge v2.1.123+ → v2.1.143+, Version badge 2.1.19 → 2.1.20.
- **F2** `.claude-plugin/marketplace.json` — bkit + marketplace version 2.1.19 → 2.1.20, description prefix 'Requires Claude Code v2.1.143+...' (adopted the safe description-text approach since the Q4 spec is undetermined).
- **F3** `docs/sprint/v2120-marketplace-recovery/f3-bj-reply-draft.md` (new) — Jeong Byeong-jin reply draft (Korean + English fallback). CC `--version` request + workaround + Hall of Fame registration review + ADR 0011 + sprint progress guidance.
- **F4** `docs/06-guide/cc-compatibility.guide.md` (new, 9 sections) — bkit minimum CC compatibility table / displayName origin / 21-key whitelist / response for users with install failures / ADR 0003+0006+0011 relationship / cc-regression R3-321 / SessionStart detection / Open Questions Q1-Q5.

**Sub-sprint 2 — Defense (P1×5, Leaf-first → Orchestrator-last)** (commit `11ec408`)

- **F9** `lib/domain/rules/docs-code-invariants.js` (Leaf SoT, @version 2.1.13 → 2.1.20) — added `EXPECTED_PLUGIN_JSON_KEYS` (21 keys, Object.freeze, Anthropic official schema whitelist) + `diffPluginJsonKeys(actual)` pure function. No FS access (domain purity preserved).
- **F5** `scripts/validate-plugin.js` (ENH-322) — added `--strict` flag. New exit codes: 2 (extra key outside 21-key whitelist) / 3 (SoT import failure). Backward compat preserved. Smoke-tested: bkit plugin.json (9 keys) PASS, extra key fail with Exit 2.
- **F6** `.github/workflows/contract-check.yml` — new step `Release Gate — plugin.json schema validation (21-key whitelist)` positioned after `docs-code-sync`. `continue-on-error: true` for v2.1.20 (1-week advisory), tightens to `false` in v2.1.21+.
- **F7** `scripts/release-plugin-tag.sh` (restoring ADR 0006 § Empirical Validation Gate) — wired `claude plugin validate .` between CI-invariants and tag-conflict-detection (~30-day wire delay closed). `command -v claude` missing → WARN + fallback.
- **F8** `lib/cc-regression/registry.js` (ENH-321) — added entry #22 R3-321 (severity HIGH, since 2.1.45 strict path adoption, expectedFix 2.1.143 official schema recognition, affectedFiles 4). `check-guards.js` PASS 22 guards.

**Sub-sprint 3 — Forward-proofing (P2×5)** (commit `5260e89`)

- **F10** `hooks/startup/session-context.js` (ENH-323, @version 2.1.19 → 2.1.20) — added `detectCCVersion()` (`child_process.execSync` timeout 200ms hard cap, `.bkit/runtime/cc-version.json` cache 1h TTL, 1x/session cap) + `buildCCVersionAdvisoryContext()`. Sets `BKIT_CC_VERSION_ADVISORY=1` + additionalContext warning when CC < v2.1.143. OTEL emit `gen_ai.cc_version_detection_ms`. Opt-out via `BKIT_DISABLE_CC_VERSION_DETECTION=1`.
- **F11** `docs/adr/0011-plugin-manifest-schema-compliance.md` (new, Status: Accepted) — 6 sections: Context (incident + root cause + ADR 0003/0006 violation retrospective + Anti-Mission) / Decision (5-layer policy) / Consequences / Empirical Validation (SC1-SC8 mapping) / History (append-only) / Open Question (Q1 Anthropic). Cross-linked to ADR 0003 + 0006 + 0010 + sprint docs.
- **F12** `test/integration/config-sync.test.js` — CS-015 21-key whitelist reinforcement. Kept the existing displayName + name + description + license requirements (R3 Anti-Mission reinforcement). 45/45 PASS.
- **F13** `test/e2e/external-dogfood/cc-min-version.test.js` (new, Lifecycle Stage 4 Regression Lock) — 5 TC: v2.1.142 mock → advisory + env set / v2.1.143 mock → no advisory / command-not-found silent skip / timeout >200ms silent skip / `BKIT_DISABLE_CC_VERSION_DETECTION=1` source=skipped. 3x consecutive stable PASS.
- **F14** `docs/external-dogfooders/bj.md` (new) + `_README.md` roster update — @bj as external dogfooder #2 (after @pruge #1). DA-4 status updated: N=2 confirmed (first-follower effect validated).

### ENH formal-candidates (formally adopted in v2.1.20 — 3 items)

- **ENH-321** R3-321 cc-regression guard (F8) — Differentiation #2 Defense Layer 6 reinforcement
- **ENH-322** validate-plugin.js 21-key whitelist (F5 + F6 + F9) — Convention Restoration (inheriting the v2.1.19 S2 spirit)
- **ENH-323** SessionStart CC version detection (F10) — runtime advisory forward-proofing

### Added

- `EXPECTED_PLUGIN_JSON_KEYS` SoT + `diffPluginJsonKeys` in `lib/domain/rules/docs-code-invariants.js`
- `--strict` flag in `scripts/validate-plugin.js` (exit codes 2 / 3)
- `Release Gate — plugin.json schema validation (21-key whitelist)` step in `.github/workflows/contract-check.yml`
- `claude plugin validate .` wire in `scripts/release-plugin-tag.sh` (ADR 0006 § Empirical Validation Gate)
- `R3-321` entry in `lib/cc-regression/registry.js` (cc-regression entry #22)
- `detectCCVersion()` + `buildCCVersionAdvisoryContext()` in `hooks/startup/session-context.js`
- `ccVersionAdvisory` section in `bkit.config.json:ui.contextInjection.sections` (default-on)
- ADR 0011 Plugin Manifest Schema Compliance Policy (Status: Accepted)
- `docs/06-guide/cc-compatibility.guide.md` — user-facing self-service guide
- `docs/external-dogfooders/bj.md` — Hall of Fame entry #2

### Changed

- `README.md` / `README-FULL.md` — Claude Code badge v2.1.123+ → v2.1.143+, Version badge 2.1.19 → 2.1.20, minimum CC v2.1.143 advisory 1-line
- `.claude-plugin/plugin.json` — version 2.1.19 → 2.1.20 (displayName unchanged per Anti-Mission)
- `.claude-plugin/marketplace.json` — bkit + marketplace version 2.1.19 → 2.1.20, description prefix advisory
- `bkit.config.json` — version 2.1.19 → 2.1.20, `ui.contextInjection.sections` adds `ccVersionAdvisory`
- `test/integration/config-sync.test.js` CS-015 — added diffPluginJsonKeys 21-key whitelist
- `docs/external-dogfooders/_README.md` — @bj entry added under "v2.1.20", DA-4 status N=2 confirmed

### Verification

- **Domain SoT (F9)**: 21 keys frozen, all 9 bkit keys within whitelist, `diffPluginJsonKeys` extra/null/empty branches normal.
- **CLI strict mode (F5)**: bkit Exit 0 (PASS), extra key Exit 2 (FAIL detected: `fooExtra`, `barExtra`), SoT import fail Exit 3, backward compat (existing behavior without `--strict`) Exit 0.
- **CI gate (F6)**: YAML consistent (python3 yaml.safe_load PASS), new step verified to be positioned right after `docs-code-sync`.
- **Release gate (F7)**: bash syntax OK, dry-run entry (wire can proceed after the working-tree-clean stage).
- **Regression guard (F8)**: `node scripts/check-guards.js` → 22 guards, 0 warnings. semver gating: `getActive('2.1.142')` includes R3-321, `getActive('2.1.143')` excludes.
- **SessionStart hook (F10)**: opt-out source=skipped, version detection isolated per scenario via PATH-shim.
- **Integration test (F12)**: `node test/integration/config-sync.test.js` → 45/45 PASS (CS-015 reinforced).
- **E2E (F13)**: `node test/e2e/external-dogfood/cc-min-version.test.js` → 5/5 PASS, 3x consecutive stable.
- **ADR 0011**: Status Accepted, 6 sections complete, cross-links to ADR 0003 + 0006 + 0010 + sprint docs verified.
- **Hall of Fame (F14)**: `docs/external-dogfooders/bj.md` 5-stage Lifecycle progress documented, _README.md DA-4 status N=2 confirmed.

### Open Questions (5 items — at sprint conclusion + 2026-05-26 CO-4 patch amend)

- **Q1** Anthropic docs vs implementation lenient/strict contradiction — external responsibility (bkit cannot resolve)
- **Q2** Jeong Byeong-jin's CC version undetermined — awaiting F3 reply (Out-of-scope)
- **Q3** ✅ **partially resolved 2026-05-26 CO-4 patch**: Anthropic CHANGELOG dateless and permanently unpublished (verified via raw GitHub fetch) + Releasebot 2026-05-15 detection proxy. Amended cc-compatibility.guide.md § 2.2/2.2.1 + ADR 0011 § History/Q3 + 4 sprint planning docs.
- **Q4** marketplace.json `requirements.claudeCode` spec — safe substitution via description-text (current sprint in progress)
- **Q5** ratio of users on CC v2.1.142 or below — post-release monitor (v2.1.21+ analysis)

### Roll-forward markers (v2.1.21+) — 2026-05-26 CO-5 patch amend

- F6 contract-check.yml `continue-on-error` → `false` (end of 1-week advisory-only)
- F8 R3-321 telemetry 3-month analysis → demote/retain decision
- F10 ENH-323 SessionStart detection telemetry 3-month analysis → demote/retain decision
- F14 Hall of Fame @bj Stage 3 (Fix Released): **branch ✅ 2026-05-26 CO-5 patch**, "main + tag" upgrade at GA tag time ⏳
- F14 Hall of Fame @bj Stage 5 (Public Acknowledge): **5-channel documented ✅ 2026-05-26 CO-5 patch** (bj.md / _README.md / README.md Hall of Fame v2.1.20 section / CHANGELOG attribution / ADR 0011 SC8), external visibility ↑ at GA publish

## [2.1.19-hotfix.1] - 2026-05-21 (branch: `feature/v2119-hotfix-1-deadcode`)

> **Status**: CI hotfix — `Invocation Contract Check` workflow turned red immediately after v2.1.19 GA merge. The dead-code detector flagged 5 new v2.1.19 modules.
> **Scope**: 4 files (+51 / -4). No feature behavior change — restores CI green, patches detector blind spot, closes one design/runtime wiring gap, and opts the new SQM dashboard section in via `bkit.config.json`.
> **Root cause** (two independent issues coincided):
> 1. `scripts/check-deadcode.js` require regex matched only direct string-literal forms (`require('./foo')`). The new v2.1.19 scripts use `require(path.join(ROOT, '...'))` (S0 measure, S3 docs-sync, S4 feedback refresh), so the detector treated their callees as orphaned.
> 2. `lib/ui/sqm-panel.js` was specified by S5 design (ADR S5-003) to render in the SessionStart dashboard, but the wiring in `hooks/session-start.js` was never landed — a design/runtime gap. `bkit.config.json` `ui.dashboard.sections` also needed `'sqm'` for the new panel to opt in.

### Fixed

- **`scripts/check-deadcode.js`**: split `scanProductionRequires()` into two regexes. `reDirect` keeps the original behavior; `reIndirect` matches `require(<wrapper>(..., '<lib path>', ...))` where `<wrapper>` is any identifier (path.join, path.resolve, require.resolve, etc.) and the captured string literal contains `lib/` or starts with `./`/`../`. This restricts the new pattern to library-shaped references and avoids overmatching arbitrary strings. As a result `external-feedback-tracker`, `markdown-parse`, and `sqm-calculator` are correctly classified as live.
- **`hooks/session-start.js`**: wired `lib/ui/sqm-panel` + `lib/quality/sqm-history` into the SessionStart dashboard. Added `'sqm'` to the default `_uiDashboardSections`. The render block is independent of the `primaryFeature` gate (SQM reflects project-wide quality maturity, not a single feature) and is fail-silent when `.bkit/state/sqm-history.jsonl` is missing. Closes the S5 design/runtime gap and makes `sqm-panel` + `sqm-history` live.
- **`bkit.config.json`**: added `'sqm'` to `ui.dashboard.sections`. Without this, the runtime config (which takes precedence over the hook default) was a 5-section allowlist that excluded `'sqm'`, so the SqmPanel rendered to 0 chars even after wiring.

### Verification

- **`scripts/check-deadcode.js`**: NEW dead **5 → 0**, Live **134 → 139** (exactly the 5 intended modules — set-diff verified against the precise v2.1.19 GA baseline, NEW DEAD 0).
- **Contract suite spot-check** (9 steps) all PASS: domain-purity (18 files) · guards (21 entries) · test-tracking (314 files, 0 untracked) · docs-code-sync (5/5 synced) · integration-runtime (23/23) · l2-smoke (101/101) · bkit-full-system (36/0/0) · contract-test-run vs v2.1.16 L1,L4 (255 assertions).
- **Full QA aggregate** (4,168 TC, 157 test files): 12 FAIL + 6 errors reproduced identically against the HEAD~1 (v2.1.19 GA) baseline → confirmed pre-existing carryover (`ACTION_TYPES` baseline drift, trust-engine score change). **Hotfix introduced 0 new regressions.**
- **SessionStart hook live run** (`CLAUDE_SESSION_ID=fresh node hooks/session-start.js`): JSON contract valid, all 5 dashboard sections including SQM (`64.00 / 100`) render correctly; `additionalContext` 5,482 → 5,741 chars (+259, SQM panel).

## [2.1.19] - 2026-05-21 (branch: `feature/v2119-quality-maturation`)

> **Status**: Quality Maturation Sprint — pruge reported a precise defect cluster (sprint domain) of 10 issues over 1.5 days during the v2.1.16~v2.1.18 cycle. Rather than a single reactive fix loop, a **5 sub-sprint master plan** elevated sprint domain maturity to the PDCA core level. **All 5 sub-sprints archived** + outer master sprint completion.
> **Scope**: Single PR — `feature/v2119-quality-maturation` (5 sub-sprints: S0 baseline + S1 Foundation + S2 Defense + S3 Polish + S4 Proactive + S5 Measurement). 152 TC across 30 test files PASS.
> **Master plan**: `docs/01-plan/features/v2119-bkit-quality-maturation.master-plan.md` (23 sections, CTO redline applied — B-1/B-2/B-3 + M-1~M-5 + Strategic Insight all addressed).
> **Predecessor**: v2.1.18 GA (PR #106, 2026-05-21 06:37Z).
> **Reporter**: @pruge (James Kim) — `dandi-village-ledger` project. First entry in the **Real User Hall of Fame**.

### Closes GitHub Issues

- **#103** failure-reporter mark/move resolved gate-fail reports (S3 F3-1)
- **#104** sprint init auto-import context (WHY/WHO/RISK/SUCCESS/SCOPE) from master-plan or PRD (S3 F3-2)
- **#105** generateReport include qualityGates section + unify KPI source (S3 F3-3+F3-4)
- **#107** SKILL.md path mismatch (S2 F2-1)

### 5 Sub-Sprints (Kahn topological)

**S0 — v2.1.18 baseline SQM Measurement** (commit `8cdd0d9`, 14 files, +3,289 LOC, 30 TC)
- Master plan §23 step 0 precondition (CTO M-3 response)
- `lib/quality/sqm-calculator.js` (6 component pure functions + computeSqm aggregator)
- `scripts/_v2119-s0-measure.js` (Infrastructure layer)
- Baseline SQM = 59.75 (later regenerated to 64.00 in S5)
- 3 critical findings discovered → S2/S3/S4 evidence

**S1 — Foundation: Self-Dogfooding Enablement** (commit `79bec02`, 16 files, +3,512 LOC, 28 TC)
- F1-1 sprint-orchestrator Task dispatch verification (contract + e2e mocked)
- F1-2 `/sprint dogfood <release-version>` action — bkit self-dogfood mode
- F1-3 `scripts/check-self-dogfood.sh` CI gate + Node helper (bash 3 compat)
- F1-4 sprint init default L3 → L2 + L1 explicit warning + audit
- F1-5 `/sprint annotate` archived-state annotation (closed enum, anti-mission preserved)
- §19.5 Bootstrap Exception mode established — pattern confirmed after the 4th successful instantiation

**S2 — Defense: Convention Restoration** (commit `598a5b1`, 33 files combined with S4, 35 TC)
- F2-1 sprint SKILL.md bkit-root convention specified (closes #107)
- F2-2 `scripts/check-skills-docs-code-sync.js` — 44 skills × Docs=Code CI invariant
- ★ **Critical evolution**: stripCodeBlocks (code-block-aware parsing) — S0 measurement bug fixed (phase-3-mockup + phase-9-deployment false positives diagnosed + corrected)
- F2-3 sprint skill full audit
- F2-4 `test/contract/baseline/skills-convention.json` frozen baseline
- F2-5 `scripts/lint-skill-md.js` PreToolUse hook (warning-only, R-3 mitigation)

**S4 — Proactive: External Dogfooder Lifecycle** (commit `598a5b1` combined with S2, 14 TC)
- F4-1 Trust Score 7-Component expansion (externalDogfoodFeedbackResponseRate weight 0.05, Δ ≤5% R-10 verified)
- F4-2 `lib/control/external-feedback-tracker.js` (GitHub API + pure compute split)
- F4-3 Real User Hall of Fame (README + `docs/external-dogfooders/` + marketplace narrative + DA-1~DA-3)
- F4-4 pruge dandi 5 scenarios E2E regression test (`test/e2e/external-dogfood/dandi-*.test.js`)
- ★ **ENH-318 formally adopted**: bkit differentiation 6/6 → **7/7** + Hall of Fame first entry @pruge

**S3 — Polish: Sprint Report Maturity** (commit `b30e1b9`, 20 files, +1,668 LOC, 40 TC)
- F3-1 failure-reporter resolution marker (A+C combined: file header + state field, atomic write, idempotent) — closes #103
- F3-2 `lib/application/sprint-lifecycle/context-importer.js` (master-plan/PRD fallback chain) — closes #104
- F3-3 generateReport `## Quality Gates` section + qualityGates > featureMap > kpi SoT precedence + divergence detection — closes #105 (main)
- F3-4 `lib/application/sprint-lifecycle/kpi-resolver.js` (pure precedence chain)
- F3-5 carry items rich rationale (featureMap.scope + details aggregated)
- F3-6 lessons learned multi-aspect (iteration / autoPause / phase_duration / gate_measurement / gate_failure_resolution)
- ★ **CO-S2-1 absorbed**: `lib/util/markdown-parse.js` newly created (stripCodeBlocks single SoT)
- ★ **CO-S2-3 absorbed**: master plan §7.2 inline note corrected (1 actual + 2 false positives)

**S5 — Measurement: Sprint Maturity Index** (commit `63931d5`, 10 files, +654 LOC, 5 TC)
- F5-1 sqm-calculator evolve + `findFirstMatching` pattern fix (★ **CO-S0-5 bug discovered + fixed** — present since S0, missed for 5 sub-sprints)
- F5-2 `lib/ui/sqm-panel.js` SessionStart-ready dashboard
- F5-3 `lib/quality/sqm-history.js` append-only JSONL
- ★ **Baseline regenerated**: 59.75 → **64.00** (S0 + S2 + S5 cumulative accuracy fix)

### 9 GitHub Issues Closed Across v2.1.17 → v2.1.19 (pruge ecosystem)

v2.1.17: #92/#93/#94/#95. v2.1.18: #100/#101/#102. **v2.1.19: #103/#104/#105/#107**.

Total: 10 issues, 100% closed within 24h (S4 F4-2 externalDogfoodFeedbackResponseRate baseline = 100%).

### Architecture (raw measured)

| Component | v2.1.18 | v2.1.19 |
|-----------|---------|---------|
| Skills | 44 | 44 |
| Agents (Active) | 34 | 34 |
| Lib Modules | 174 | **184+** (new: util/markdown-parse + 4 in application/sprint-lifecycle + control/external-feedback-tracker + quality/sqm-* + ui/sqm-panel) |
| Scripts | 54 | **56** (new: check-skills-docs-code-sync + lint-skill-md + _v2119-s4-feedback-refresh + _check-self-dogfood-helper + check-self-dogfood.sh) |
| Hook Events | 21 | 21 (PreToolUse SKILL.md linter entry added) |
| MCP Tools | 19 | 19 |
| ACTION_TYPES | 30 (post v2.1.18) | **39** (+9: sqm_baseline_measured + sprint_dogfood_started + sprint_bootstrap_mode_activated + sprint_trust_warning + sprint_annotated + self_dogfood_emergency_override + external_feedback_tracked + gate_fail_resolved + sprint_context_imported + sprint_kpi_divergence) |
| Test count | 3,774 (v2.1.18) | **3,926+** (+152 v2.1.19) |
| Trust Score | 6 components (sum 1.0) | **7 components** (sum 1.0, externalDogfoodFeedbackResponseRate 0.05) |
| Differentiation | 6/6 | **7/7** (ENH-318) |

### v2.1.18 Baseline SQM Final (regenerated by S5)

| Component | Weight | Value | Weighted |
|-----------|--------|-------|----------|
| docsCodeSyncRate | 0.30 | **100** (44/44) | 30.00 |
| sprintSelfDogfoodRunRate | 0.20 | 10 (v2.1.16 partial) | 2.00 |
| externalDogfooderFeedbackResponseRate | 0.20 | 100 (7/7 closed within 24h) | 20.00 |
| sprintReportKpiConsistency | 0.15 | 80 | 12.00 |
| subAgentDispatchSuccessRate | 0.10 | null | 0.00 |
| conventionContractTestPassRate | 0.05 | 0 | 0.00 |
| **Total** | 1.00 | | **64.00** |

### v2.1.19 GA Projected SQM (after this release archives)

64.00 + ~32 = **~96** (well above master plan §7.2 target ≥85):
- sprintSelfDogfoodRunRate 10 → 100 (v2.1.19 itself = sprint container per Bootstrap Exception)
- subAgentDispatchSuccessRate null → ~95 (S1 sprint-orchestrator live)
- conventionContractTestPassRate 0 → ~99 (S2 F2-4 baseline contract live)

### Bootstrap Exception mode — pattern fully validated

5 sub-sprints all archived under PDCA-with-sprint-shadow (main session manual proxy for sub-agent dispatch). v2.1.20 will be **first true self-dogfood CI gate activation** — `scripts/check-self-dogfood.sh` (without `--bootstrap-mode` flag) will hard-fail when not-sprint releases attempt to tag.

### Real User Hall of Fame — first entry @pruge

`docs/external-dogfooders/pruge.md` (120-line archive: 10 issues × evidence + 5 absorbed scenarios + contribution quality criteria). README + marketplace narrative + bkit Early Adopter Program CTA. DA-4 (30-day dogfooder population review) carried to v2.1.20+.

### Differentiation 7/7

- ENH-286 Memory Enforcer
- ENH-289 Defense Layer 6 (strengthened — 9 new ACTION_TYPES naturally joined L6 pipeline)
- ENH-292 Sequential Dispatch (declared → **live** in this release via S1 F1-1)
- ENH-300 Effort-aware Adaptive Defense
- ENH-303 PostToolUse continueOnBlock
- ENH-310 Heredoc Detector
- **ENH-318 External Dogfooder Feedback Trust Integration** (NEW v2.1.19 — Trust Score 7th component + Hall of Fame + User-Feedback Lifecycle)

### Compatibility

- bkit v2.1.18 → **v2.1.19 GA** (bkit.config.json + plugin.json + marketplace.json ×2 + README + hooks ×3 all synced)
- Backward compat: 100% — Trust Score normalization preserves Δ ≤5% (R-10 mitigation), legacy 6-component trust-profile.json auto-migrated via loadTrustProfile merge fix
- ADR 0003: maintained — sprint state schema additive only (annotations: [] + lastGateFailure.resolved* fields, all optional)

### Carry-overs to v2.1.20+

- CO-S3-1 `/sprint status` to use kpi-resolver (consistent SoT)
- CO-S3-2 PRD template Context Anchor section addition
- CO-S3-3 divergenceLogger default emitter (audit)
- CO-S2-4 hooks.json `if:` schema verify in CC v2.1.85+
- DA-4 30-day dogfooder population review
- CO-B Trust weight recalibration (after 30-day data)
- CO-C Hall of Fame i18n (KO/JA/ZH)
- CO-S1-1 ~ CO-S1-7 (S1 advanced features carry list)
- CO-S4-1 external-feedback-tracker CI gate integration

### Methodology — Bootstrap Exception 5th successful instantiation

S0 + S1 + S4 + S2 + S3 + S5 all completed under PDCA-with-sprint-shadow. The Bootstrap Exception pattern in master plan §19.5 is established as a *transitional protocol* — first true self-dogfood activation from v2.1.20.

## [2.1.18] - 2026-05-21 (branch: `feature/v2118-issue-fixes`)

> **Status**: Sprint Trust UX Fix — consolidated 3 GitHub Issues reported in bkit v2.1.16 (#100/#101/#102, all reported by @pruge 2026-05-21 03:54) into a single sprint. Permanently resolved the L1 sprint lockout 3-stage trap.
> **Scope**: Single PR — `feature/v2118-issue-fixes` (3 features hard-link: F1 chicken-and-egg unblocker + F2 trust mutation + F3 normalize unification + F4 sprint-master-planner CTO/QA expansion).
> **Reporter Scenario**: @pruge dandi-village-ledger `s1-foundation` sprint — after L1 init, trust escalation impossible at the point of P0 32/32 completion, measure always in preview mode, sprint-orchestrator dispatch failure. Reproduced 1:1 with an 8-step E2E test in v2.1.18, then fix evidence confirmed.
> **Methodology**: PM Team (pm-lead 4-agent orchestration → PRD Beachhead 19/20) + CTO Team (cto-lead architectural review APPROVE with CONCERNS, 3 BLOCKERs adopted with main-session re-measurement) + QA Team (qa-lead L1-L5 integrated verification) — responding to the user request "make full use of PM/CTO/QA all with high completeness".
> **Test**: **40 TC live PASS** (17 contract + 15 unit + 8 e2e), 2.86× exceeding the 14 TC target.

### Fixed (Bug Fixes — GitHub Issues closure)

#### #100 — sprint-orchestrator + 3 sprint-* agents missing `Task` tool (F1)
- `agents/sprint-orchestrator.md` frontmatter `tools:` field specified — Task allowlist of 7 (gap-detector, code-analyzer, sprint-qa-flow, sprint-report-writer, qa-monitor, pdca-iterator, Explore) + 6 base tools
- `agents/sprint-master-planner.md` `tools:` field specified — Task allowlist of 7 (✦ user-requested expansion: pm-lead, cto-lead, qa-lead 3 orchestrators + product-manager, frontend-architect, enterprise-expert 3 specialists + Explore)
- `agents/sprint-qa-flow.md` `tools:` field specified — Task allowlist of 2 (qa-monitor, gap-detector) + 6 base
- `agents/sprint-report-writer.md` `tools:` field specified — Task unnecessary (report aggregation only), 5 base tools
- **Differentiation #3 ENH-292 Sequential Dispatch activated**: previously, when sprint-orchestrator called `agentTaskRunner` at `measure-router.js:233-253` it returned `no_agent_runner` due to the missing Task tool, but from v2.1.18 normal sub-agent dispatch is possible — first release promoting "declared → actually working"

#### #101 — `/sprint trust` mutation command newly added + audit (F2)
- `scripts/sprint-handler.js`: new `handleTrust(args, infra, deps)` function (signature `{ id, to, reason?, force?, actor? }`) + `case 'trust'` dispatch + `VALID_ACTIONS` 17 → **18 actions**
- helpers: `LEVEL_RANK` / `isDowngrade(from, to)` / `severity(from, to)` / `loadTrustScore(deps)` / `resolveActor(args)`
- `lib/audit/audit-logger.js`: `ACTION_TYPES` **29 → 30** (`sprint_trust_changed` entry + details schema documented inline)
- Downgrade guardrail: major downgrade (≥2 levels) requires `trustScore >= 80` (from `.bkit/state/trust-profile.json` `trustScore` field, 6-component weighted sum) OR `--force` flag
- Idempotent path (`from === to`): emits audit with `noop: true` field (monitoring blind-spot prevention)
- Actor auto-detection: explicit `args.actor` > `process.env.CLAUDE_AGENT_ID → 'agent'` > default `'user'` (spoofing mitigation)
- `--force` flag: triggers `blastRadius: 'high'` for Defense Layer 6 alarm (ENH-289 natural integration)
- `skills/sprint/SKILL.md` §10.1.3 "Trust Level Mutation" new section (comparison table, audit JSON example, downgrade guardrail explanation)
- `commands/bkit.md` added `/sprint trust` help line

#### #102 — `--trust` CLI alias silently ignored at measure/phase paths (F3)
- `scripts/sprint-handler.js:942-948` (`handleMeasure`) + `974-979` (`runPhaseGates`): `args.trustLevel` direct check → unified to `normalizeTrustLevel(args)`. `normalizeTrustLevel` itself already implements the precedence chain `trustLevel > trust > trustLevelAtStart` (line 68-74), but the two paths bypassed the function call, causing silent ignore
- declared behavior in Skill docs §10.2 (Trust Level Acceptance) matches the code — Docs=Code 90% match rate maintained

### Added — Tests (40 TC, 2.86× exceeding the 14 TC target)

- `test/contract/sprint-agents-tools.test.js` (17 TC) — F1 4 sprint-* agents `tools:` field invariant
- `test/unit/sprint-trust-normalization.test.js` (7 cases A-G) — F3 normalizeTrustLevel precedence chain
- `test/unit/sprint-handler-trust-action.test.js` (8 cases) — F2 handleTrust mutation/guardrail/audit/actor coverage
- `test/e2e/sprint-l1-lockout-recovery.test.js` (8 steps) — @pruge reporter scenario 1:1 reproduction (init L1 → trust L1→L3 → measure record → audit verify → process restart persistence)

### Added — Self-Referential Meta Risk Mitigation

- **Chicken-and-egg avoidance pattern established**: since this sprint itself is the target of the sprint-orchestrator Task tool fix, the sprint container's automatic orchestration could not be used. Specified in Plan §6.1 noteline — `sprint init` is for state tracking, while phase advance + measurement proceed via the PDCA cycle (main session + pm-lead/cto-lead/qa-lead manual dispatch). Right after applying F1, sprint-orchestrator normalized → automatic orchestration works normally from the next sprint

### Methodology — First demonstration sprint using PM/CTO/QA Teams integrated

- **PM Team** (pm-lead orchestrate 4 agents): PRD generation — Beachhead Geoffrey Moore 19/20 (Burning Pain 5 / WTP 5 / Winnable 5 / Referral 4) + JTBD 6-Part + 5 User Stories + 6 Test Scenarios + Pre-mortem Top 3 + Negative-Reputation Loop Block narrative
- **CTO Team** (cto-lead): Architectural Review APPROVE with CONCERNS — 3 BLOCKERs (controlScore→trustScore correction / ACTION_TYPES count 27→29 correction / NDJSON injection assessment) + 3 MEDIUMs (no-op audit noop:true / actor spoofing mitigation / sub-agent-dispatcher state transition test) all reflected in redline. Main session followed the Numeric Correction Protocol: ACTION_TYPES measured 29 (corrected the CTO's 27 grep limitation), trustScore model exists (`.bkit/state/trust-profile.json`)
- **QA Team** (qa-lead): L1-L5 layer integrated verification report + reporter scenario evidence

### Differentiation 6/6 Strengthening

- ENH-286 Memory Enforcer — no impact (trust mutation has no CLAUDE.md dependence)
- ENH-289 Defense Layer 6 — **strengthened** (sprint_trust_changed audit naturally joined the Layer 6 pipeline, live proof: `layer_6_audit_completed` + `layer_6_alarm_triggered` emitted simultaneously in `.bkit/audit/2026-05-21.jsonl`)
- ENH-292 Sequential Dispatch — **activation milestone** (F1 fix makes sprint-orchestrator Task tool work normally, first release promoting "declared → actually working")
- ENH-300 Effort-aware Adaptive Defense — orthogonal, no impact (effort.level and trust are separate axes)
- ENH-303 PostToolUse continueOnBlock — no impact
- ENH-310 Heredoc Detector — no impact (heredoc unused in this sprint's commits)

### Compatibility

- **bkit v2.1.18 GA** (bkit.config.json + .claude-plugin/plugin.json updated simultaneously)
- Backward compat 100%: existing `--trustLevel L<N>` user precedence preserved (F3 Case G test), existing sprint state schema unchanged
- ADR 0003 14/14 PASS maintained (15-cycle → **16-cycle consistency milestone**)

### Documentation

- `docs/00-pm/features/v2118-sprint-trust-ux-fix.prd.md` (PM Team, ~570 lines)
- `docs/01-plan/features/v2118-sprint-trust-ux-fix.plan.md` (5 CTO redlines reflected)
- `docs/02-design/features/v2118-sprint-trust-ux-fix.design.md` (10 CTO redlines reflected, 778+ lines)
- `docs/05-qa/v2118-sprint-trust-ux-fix.qa-report.md` (QA Team)
- `docs/04-report/features/v2118-sprint-trust-ux-fix.report.md` (Sprint completion)
- `skills/sprint/SKILL.md` §10.1.3 new section
- `commands/bkit.md` `/sprint trust` help

### Closed Issues

- Closes #100 (sprint-orchestrator missing Task tool — v2.1.16 reporter @pruge)
- Closes #101 (L1 sprint trust mutation command missing — v2.1.16 reporter @pruge)
- Closes #102 (CLI parser --trust silently ignored — v2.1.16 reporter @pruge)

---

## [2.1.17] - 2026-05-20 (branch: `feature/v2117-final`)

> **Status**: CI/CD Hardening — permanently closed the 5/12 ~ 5/20 8-day red contract class. **5-axis matrix 5/5 close** (Detection, Enforcement, Recovery, Governance, Evolution).
> **Scope**: 2 PR merge — PR #97 (v2117 main scope) + PR #99 (v2117 final + 5 carryover absorbed).
> **Origin**: removing 6 `pdca-eval-*` agents in commit `967cd8f` (refactor v2.1.13, 2026-05-12) → 8-day cumulative contract red. v2.1.15 and v2.1.16 GA proceeded with release in the red state. This v2.1.17 release resolves all remaining defects of the incident class.

### Added — 5-axis matrix close

#### Detection
- **Dual baseline**: simultaneous comparison of v2.1.9 LTS (long-term drift) + v2.1.16 Latest (noise floor)
- **L2 mandatory**: `test/contract/l2-smoke.test.js` (98 TC) + `l2-hook-attribution.test.js` (13 TC) integrated into workflow
- **L3 mandatory**: `l3-mcp-compat.test.js` (92 TC) + `l3-mcp-runtime.test.js` (48 TC) integrated into workflow
- **L5 mandatory**: removed `continue-on-error: true` from `invocation-inventory.test.js` + `needs: contract-l1-l4` (203 TC → 210 TC with SoT-driven lists)
- **MCP deprecation schema**: parsing of `// @deprecated since vX.X.X replacedBy=Y` inline comments (`parseMCPToolBlocks`)
- **`scripts/check-test-tracking.js`**: detects untracked `*.test.js` across 18 production test paths (CO-7)

#### Enforcement
- **`scripts/setup-branch-protection.sh`**: idempotent `gh api` wrapper (dry-run default + `--apply`). Automatically applied to the main branch — 2 Required Status Checks (`Contract Test (L1 Frontmatter + L4 Deprecation)`, `Contract Test L5 (Invocation Inventory)`), `allow_force_pushes: false`, `allow_deletions: false`, `strict: true`.
- **`docs/06-guide/branch-protection-setup.guide.md`**: admin SOP

#### Recovery
- **`docs/06-guide/contract-baseline-rollforward.guide.md`**: LTS vs Latest policy, decision tree, capture procedure, deprecation stub authoring, PR self-review checklist, incident record (8 sections)
- **`docs/06-guide/test-file-tracking-policy.guide.md`**: `.gitignore` policy + PR checklist + incident record (9 sections)

#### Governance
- **Agent deprecation governance**: L4 bypass when `deprecatedIn: vX.X.X` is specified in `agents/<name>.md` frontmatter — symmetrically applied with the Skill pattern
- **6 `pdca-eval-*` deprecation tombstones**: `agents/pdca-eval-{act,check,design,do,plan,pm}.md` — `deprecatedReason`, `replacedBy`, `deprecationCommit: 967cd8f` specified
- **MCP tool deprecation governance**: L4 bypass based on the baseline JSON `deprecatedIn` field (`contract-test-run.js` Skill/Agent/MCP 3-surface symmetry)
- **Agent-deprecation isolated test** (CO-4): `test/contract/agent-deprecation.test.js` 5 scenario fixtures (positive, missing-stub, no-deprecated-in, model-mismatch, non-mutation), 5/5 PASS
- **MCP-deprecation e2e test** (CO-2.1): `test/contract/mcp-deprecation.test.js` 6 scenario fixtures (active, simple, full, JSDoc-style, etc.), 6/6 PASS

#### Evolution
- **`lib/util/frontmatter.js`** (CO-5): consolidated 5-site duplication — `parseFrontmatter`, `parseFrontmatterFile`, `hasDeprecatedInFrontmatter`, `hasDeprecatedInFrontmatterFile`, `coerce` (pure FS-free core)
- **v2.1.16 baseline additional capture**: `test/contract/baseline/v2.1.16/` (106 files) — noise floor reference for the next PDCA work
- **SoT canonical names list** (CO-3.1): added `EXPECTED_ACTIVE_AGENT_NAMES` (34), `EXPECTED_DEPRECATED_AGENT_NAMES` (6), `EXPECTED_SKILL_NAMES` (44), `EXPECTED_HOOK_EVENT_NAMES` (21), `EXPECTED_PDCA_MCP_TOOLS` (13), `EXPECTED_ANALYSIS_MCP_TOOLS` (6) to `lib/domain/rules/docs-code-invariants.js` — dynamically referenced by invocation-inventory.test.js

### Fixed

#### Framework side effects
- **Blocked collect-function implicit write side effects**: added `{ persist = true, baseDir = BASE_DIR, projectRoot = PROJECT_ROOT }` options to the 5 functions `collectSkills/Agents/MCPTools/Hooks/SlashCommands`. contract-test-run.js blocks baseline self-mutation by explicitly passing `{ persist: false }`.
- **`--version` argument path-injection validation** (CO-1.1): exit 2 on mismatch with the `^[A-Za-z0-9._-]+$` regex (preventing path-concat accidents like `/tmp/foo`)
- **`--project-root` flag** (CO-4 prerequisite): contract-test-run.js + contract-baseline-collect.js — fixture-aware testing

#### `.gitignore` masquerade defect resolved (CO-6)
- **Removed `test/`, `tests/*` blanket ignore** — production test directories tracked by default. Permanently blocks the 5/20 incident class (`Cannot find module` masquerade).
- **Bulk-tracked 35+ remaining untracked test files**: `tests/qa/` 29 files (bug-fixes-v218, v2113-sprint-1~5, 10 v2114-*, 3 v2116-*, etc.) + `test/contract/` 5 files + `test/e2e/` 6 files + `test/integration/` 3 files + `test/unit/` 2 files + `test/v2110-qa/` 2 files
- **`docs-code-scanner.js` `countAgents`**: excludes deprecation tombstones (active count consistency)
- **5/20 release masquerade defect normalized**: `tests/qa/bkit-full-system.test.js`, `bkit-deep-system.test.js`, `test/contract/l2-hook-attribution.test.js`, `l3-mcp-runtime.test.js` 4 files force-tracked (v2.1.17 PR #97 + this PR)

#### Hygiene
- **Deleted 12 orphan JSON in v2.1.9 baseline**: not registered in manifest (sprint agents/MCP tools/skills) — irrelevant to runner operation but damaging baseline hygiene. After cleanup, `node test/contract/scripts/contract-test-run.js --compare v2.1.9 --level L1,L4` 252 → 234 assertions (removed 12 meaningless assertions).
- **Supplemented `scripts/check-deadcode.js` EXEMPT patterns**: added EXEMPT for v2.1.13 sprint barrel 3 files (`lib/{application/sprint-lifecycle,domain/sprint,infra/sprint}/index.js`). A defect latent since before 5/12 had been masquerading as Invocation Contract red.

### Changed

- **`.github/workflows/contract-check.yml`**: 13 → **18 steps** (+1 dual baseline comparison, +4 L2/L3, +1 check-test-tracking, +L5 mandatory needs)
- **agents count semantics**: "total" → **"active" (34) + "deprecated" (6)**. Kept the SoT (`docs-code-invariants.js`) `agents: 34`, applying a filter at the 5 count-measurement sites.
- **workflow L5 job name**: "observe-only — not merge-blocking" → **"Invocation Inventory"** (mandatory)

### Architecture

#### New Layer
- **`lib/util/`** (NEW utility layer) — pure FS-free modules. First module: `frontmatter.js`.

#### New Modules / Scripts
- `lib/util/frontmatter.js` (75 LOC, pure)
- `scripts/setup-branch-protection.sh` (executable, idempotent)
- `scripts/check-test-tracking.js` (CI gate)
- `test/contract/agent-deprecation.test.js` (5 scenario, fixture-based)
- `test/contract/mcp-deprecation.test.js` (6 scenario, fixture-based)
- `test/contract/fixtures/agent-deprecation/` (4 fixtures)
- `test/contract/fixtures/mcp-deprecation/` (1 fixture server)
- `test/contract/baseline/v2.1.16/` (106 file Latest snapshot)

### Verification

Local dry-run 18/18 PASS:
- domain purity: 18 files, 0 forbidden
- L1+L4 vs v2.1.9 LTS: 234 assertions
- L1+L4 vs v2.1.16 Latest: 255 assertions
- guard registry: 21 guards
- **check-test-tracking** (NEW): 0 untracked production test files
- docs-code-sync: all counts consistent
- check-deadcode: Dead 0
- integration runtime: 23/23
- L2 smoke: 98/98
- L2 hook attribution: 13/13
- L3 MCP compat: 92/92
- L3 MCP runtime: 48/48
- **L5 invocation inventory** (mandatory): 210/210 (SoT-driven, +7 from v2.1.16)
- **agent-deprecation isolated** (NEW): 5/5
- **mcp-deprecation e2e** (NEW): 6/6
- bkit-full-system: 36/36
- bkit-deep-system: 111/111
- docs-code-sync test: 36/36
- branch-protection script (dry-run): preview valid

**qa-aggregate**: 4090+ PASS / 0 FAIL / 0 Errors (closed 35 regressions + 280+ TC increase versus v2.1.16 GA's 3,808 PASS / 31 FAIL / 4 Errors)

### Closure matrix

| Item | v2.1.16 GA | v2.1.17 |
|------|:---:|:---:|
| Cumulative Contract red | 8 days | **0 days** |
| Workflow steps (mandatory) | 13 | **18** |
| Baseline snapshots | 1 (v2.1.9) | **2 (v2.1.9 LTS + v2.1.16 Latest)** |
| Active agents | 34 | 34 (with explicit deprecation governance) |
| Deprecation tombstones | 0 | **6** |
| Frontmatter parse sites | 5 (duplicate) | **1** (`lib/util/frontmatter.js`) |
| Hardcoded EXPECTED lists | 7 (stale-prone) | **0** (SoT `docs-code-invariants.js`) |
| Branch protection | ✗ | **2 Required Status Checks auto-applied** |
| 5-axis matrix | 0/5 | **5/5** ✅ |

### Closure items (Carryover permanently closed)

| ID | Description | Status |
|----|-------------|:---:|
| CO-1 | Branch protection automation | ✅ script + apply completed |
| CO-1.1 | --version path-injection validation | ✅ regex validation |
| CO-2 | MCP tool deprecation schema formalization | ✅ `parseMCPToolBlocks` |
| CO-2.1 | MCP deprecation real-world e2e test | ✅ 6/6 PASS |
| CO-3 | L5 E2E mandatory promotion | ✅ continue-on-error removed |
| CO-3.1 | L5 inventory dynamic EXPECTED lists | ✅ SoT consolidated (210/210) |
| CO-4 | Agent-deprecation isolated unit test | ✅ 5/5 PASS |
| CO-5 | frontmatter util extraction | ✅ 5 sites → 1 |
| CO-6 | Tracked file policy | ✅ .gitignore narrow + 35+ files tracked + guide |
| CO-7 | tests/qa dependency automation | ✅ check-test-tracking.js + workflow step |
| CO-8 | branch-protection actual apply audit | ✅ popup-kay admin apply verified |

**All 11 carryover items closed** — 5/12 ~ 5/20 incident class completely closed.

### References

- PR #97 (v2.1.17 main scope, merged 2026-05-20 `7acdd4f`): https://github.com/popup-studio-ai/bkit-claude-code/pull/97
- PR #99 (v2.1.17 final + 5 carryover): https://github.com/popup-studio-ai/bkit-claude-code/pull/99
- Plan: `docs/01-plan/features/v2117-ci-cd-hardening.plan.md`, `v2118-carryover-cleanup.plan.md`
- SOP guides: `docs/06-guide/contract-baseline-rollforward.guide.md`, `branch-protection-setup.guide.md`, `test-file-tracking-policy.guide.md`
- Origin incident: commit `967cd8f` (refactor v2.1.13, 2026-05-12)

---

## [2.1.16] - 2026-05-20 (branch: `feature/v2116-issue-fixes`)

> **Status**: Patch release — 4 GitHub issues closed (Quality Gates & Approval UX).
> **Reporter**: @pruge (v2.1.14, CC v2.1.140, L2 trust) — an L2 default user resolved 4 types of deadlock caused by quality gates during sprint execution via user-explicit commands.

### Fixed — Issue #92: sprint-orchestrator M4+M8 dual record at design exit (F1)

When the `sprint-orchestrator` agent completed the design phase §14 self-assessment, it recorded only `M8_designCompleteness` and omitted `M4_apiComplianceRate` → `evaluateGate(null)` returns `reason: 'not_measured'` → `advancePhase` returns `reason: 'gate_fail'` → the start-sprint loop pauses with `QUALITY_GATE_FAIL`. L2 user deadlock.

- **Expanded agent body §96-102 Quality Standards** + **new Design Phase Exit Procedure** — explicitly states the orchestrator's responsibility to measure both M4 and M8 before design exit (Option A, Issue #92 reporter suggested).
- **quality-gates.js JSDoc evolution** — clarified measurement responsibility (single SoT per gate). Logic unchanged (Master Plan §1 RISK invariant — gate matrix target identical).
- **Cross-Sprint Integration (after F3 ships)**: agent body explicitly calls `measure-router.measureGate('M4', sprint, { agentTaskRunner })` — `/sprint phase` auto-advance and the `/sprint measure --gate M4` manual call share a single SoT.
- **New contract test SC-11** — Sprint 2 quality-gates logic structural invariant (legacy git-diff freeze evolution, INV-05 hooks.json pattern).
- Atomic commit `b8f85b9`.

### Added — Issue #95: `/sprint phase --approve` scope-boundary single-use escape hatch (F2)

Under L2 trust (`scope.stopAfter = "design"`, `requireApproval = true`), calling `/sprint phase --to do` returns `requires_user_approval`, but the user has no command to grant approval → deadlock. The workaround was trust escalation or directly editing the state JSON (a violation of the bkit philosophy).

- **`--approve` flag (single-call escape hatch)** + optional `--reason "<text>"` — `sprint.autoRun.scope` unchanged (single-use), scope check re-runs on the next phase transition.
- **New `audit-logger.ACTION_TYPES.scope_boundary_approved`** (28th) + details schema `{ sprintId, from, to, trustLevel, stopAfter, approvedBy, reason }`.
- **Expanded `advance-phase.usecase.js` Step 2** — skips scope check when `deps.approve === true` + returns `approvalRecord`. Stays a pure module (the handler emits audit).
- **Added a `hint` field to the `advancePhase` response** — provides user guidance on the legacy `requires_user_approval` result ("Re-run with --approve. Approval is single-use and does NOT change trust level.").
- **SKILL.md §10.1 phase row expansion + §10.1.1 dedicated semantics section** (R4 misunderstanding mitigation).
- **New contract test SC-12** — 7 behavioral assertions + handler E2E.
- Atomic commit `3c615fd`.

### Added — Issue #94: `/sprint measure` partial-gate measurement command (F3)

When a quality gate is null (not_measured) and the phase transition is blocked, the user has no command to measure a single gate. The existing `/sprint phase`/`/sprint iterate`/`/sprint qa` either advance the whole workflow or have a different scope. Measurement work is performed by subagents (gap-detector, code-analyzer, sprint-orchestrator), but there is no user-invokable slash command.

- **New directory + module `lib/application/quality-gates/measure-router.js`** — gateKey → agent mapping (Master Plan §11.3 AC4): M1/M3/M4 → gap-detector, M2/M7 → code-analyzer, M8 → sprint-orchestrator, S1 → sprint-qa-flow. 7 supported gates × 4 agents + 4 unsupported (M5/M10/S2/S4 carry to v2.1.17). Pure module — inject `agentTaskRunner`, 6 deterministic error reasons (no silent fail).
- **New `lib/application/sprint-lifecycle/measure-gate.usecase.js`** — Trust Level scope (L0/L1 preview / L2+ record), sequential aggregators (ENH-292 cache-friendly): `measureGate` / `measureGates` / `measurePhaseGates`.
- **New `audit-logger.ACTION_TYPES.gate_measured`** (29th) + 11-field details (sprintId/gateKey/field/agent/value/threshold/passed/source/phase/trustLevel/previousValue). Preview mode (L0/L1) emits NO audit (0 noise).
- **17th VALID_ACTION `measure` in `sprint-handler.js`** — 3 modes precedence (`--gate` > `--gates` CSV > `--phase`), per-gate gate_measured audit emit, cumulative state save.
- **F1 self-assessment refactor — single SoT consolidation** — agent body removes the inline §14 heuristic → explicitly calls measure-router (Master Plan AC7 code-sharing).
- **SKILL.md §10.1 measure row + §10.1.2 dedicated semantics section** (agent routing table, Trust Level scope clarified).
- **New contract test SC-13** — 8 assertion groups (router routing, error paths, UC modes, aggregators, handler E2E, F1 cross-reference invariant).
- Atomic commit `126a7c0`.

### Added — Issue #93: Gate-failure auto-report at advancePhase gate_fail (F4)

On `gate_fail`, only a single line of raw JSON was printed to stderr + 0 disk writes. Users had to rely on LLM interpretation (a violation of the bkit "controllable AI" philosophy).

- **New `templates/gate-failure-report.template.md`** — 6-column table outer skeleton (Sprint Phase / Gate / Status / Expected / Actual / Suggested Action per Issue #93 example) + `{gateRows}/{failedGateBlocks}/{passingGateBlocks}` placeholders.
- **New `lib/application/quality-gates/failure-reporter.js`** — 3-tier pattern (pure builders + side-effect writeReport + createFailureReporter factory). PLUGIN_ROOT vs projectRoot separation (template lookup ↔ output dir).
- **Integrated `advance-phase.usecase.js` Step 3 gate_fail branch** — `deps.failureReporter` dispatch (best-effort, never blocks), dynamic addition of `sprint.lastGateFailure { phase, toPhase, gateResults, reportPath, timestamp }` (Sprint 1 domain unchanged, INV-01 safe), reportPath + sprint added to the response.
- **Expanded `audit-logger.gate_failed` details schema** (no new enum — re-use). 11-field details (sprintId/phase/targetPhase/failedGates[]/reportPath).
- **`audit-logger.sanitizeDetails` Array preservation (generalized fix)** — F4 discovered a latent regression where v2.1.10 sanitizeDetails coerced an Array into a `{ '0': {...} }` Object + added an Array branch. Benefits all future audit array fields.
- **Expanded sprint-handler `handlePhase`** — `buildFailureReporterForHandler` (inject fileWriter) + state save on gate_fail + gate_failed audit emit (expanded details).
- **per-call opts merging** (`createFailureReporter`) — toPhase is only known at the moment advancePhase is called → per-call opts merged with factory opts.
- **Cross-feature enrichment (AC7)** — the report Suggested Action column maps `not_measured` → the F3 `/sprint measure --gate <K>` command, and the Next User Commands section substitutes the F2 `--approve` + F3 `/sprint measure` with sprintId/toPhase.
- **New contract test SC-14** — 7 assertion groups + handler E2E (temp project root, audit log file content verification).
- Atomic commit `72559ce`.

### Changed — Cross-Feature Invariant Evolution

- **Updated `tests/contract/v2113-sprint-contracts.test.js` SC-04/SC-06**:
  - SC-04: VALID_ACTIONS 16 → **17** (added `measure`)
  - SC-06: ACTION_TYPES 27 → **29** (scope_boundary_approved + gate_measured, evolved from regex source-text counting to module-level assertion to avoid JSDoc literal false-positives)
- **`tests/qa/v2113-sprint-4-presentation.test.js` INV-02/H-01/AUDIT-01 evolved** (local-only, `.gitignore tests/qa/*`):
  - INV-02: git diff freeze → logic structure invariant (INV-05 hooks.json pattern)
  - H-01: VALID_ACTIONS 16 → 17
  - AUDIT-01: 27 → 29 (scope_boundary_approved + gate_measured)
- **`test/unit/audit-logger.test.js` AL-007 evolved (16 → 29)** — updated the cumulative evolution from the v2.1.10 baseline.

### Verification

- **L3 Contract**: 14/14 PASS (SC-11/SC-12/SC-13/SC-14 new, SC-04/SC-06 evolved)
- **Tracked unit (test/unit/)**: 90/90 files PASS (after AL-007 update)
- **Tracked unit (tests/unit/)**: 3/3 files PASS
- **bkit-deep-system**: 111/111 PASS
- **sprint-2-application**: 79/79 PASS (0 regressions)
- **sprint-3-infrastructure**: 66/66 PASS (0 regressions)
- **sprint-4-presentation** (3 evolved tests): 41/41 PASS
- **Local QA** (v2116-sprint-phase-approve 7 + v2116-sprint-measure-command 9 + v2116-gate-fail-report 8): 24/24 PASS
- **Total tracked**: ~150+ test files / 478+ assertions, 0 FAIL
- **claude plugin validate**: ✔ Exit 0 (F9-120 closure 17-cycle extension)

### Live Dogfooding

- **ENH-310 heredoc-bypass guard live-fire 3 times in a row** (blocked the `git commit -m "$(cat <<EOF ... EOF)"` pattern in the F1+F2+F3 atomic commit attempts) — decisive reinforcement of bkit differentiator #6. Bypassed via the -F file approach (after applying the lesson, the F4 commit succeeded without triggering it).
- **audit-logger sanitizeDetails Array regression discovered + generalized fix** — F4 discovered the v2.1.10 regression while auditing the failedGates array. Benefits the array fields of all future audit entries.
- **The bkit v2.1.16 sprint itself is self-dogfooding of PDCA + Sprint Management** — 4 GitHub issues resolved 4 cases of bkit's own deadlock that bkit discovered, using bkit tooling.

### Architecture

- **New directories**: `lib/application/quality-gates/` (measure-router + failure-reporter)
- **New lib modules**: 3 (measure-router.js, measure-gate.usecase.js, failure-reporter.js)
- **New template**: 1 (gate-failure-report.template.md)
- **Modified lib modules**: 4 (advance-phase.usecase.js, quality-gates.js, sprint-handler.js, audit-logger.js)
- **Modified agent**: 1 (sprint-orchestrator.md — new Phase Exit Self-Assessment + Design Phase Exit Procedure)
- **Modified skill**: 1 (sprint SKILL.md — §10.1 measure/approve rows + §10.1.1 + §10.1.2)
- **Modified contract**: 1 (v2113-sprint-contracts.test.js — SC-11/SC-12/SC-13/SC-14 new + SC-04/SC-06 evolved)
- **New ACTION_TYPES**: 2 (scope_boundary_approved [#95 F2], gate_measured [#94 F3])
- **New VALID_ACTIONS**: 1 (measure [#94 F3])
- **New bkit differentiator**: #7 "recovery-friendly automation" — resolves 4 types of sprint deadlock via user-explicit commands

### Cross-Sprint References

- bkit v2.1.15 (PR #91, `b65d336`) — Issue #89 .pdca-status.json 6-Layer Defense (active during this sprint)
- bkit v2.1.14 differentiators 6/6 (memory enforcer + Layer 6 Defense + sequential dispatch + effort-aware + PostToolUse continueOnBlock + heredoc-bypass) — active during this sprint (especially ENH-310 3 live-fires)
- bkit v2.1.13 Sprint Management — this sprint leverages the 8-phase Sprint Lifecycle + extends the Sprint 2 Application Layer
- CC v2.1.140 environment compatibility maintained at 100 consecutive PASS

### Release Hardening Sub-Sprint (post-release)

> Closure of the v2.1.14/15 recurring pattern — this hardening cycle batches release metadata + test maintenance + CI gate reinforcement separately from the 4-feature fix. Plan: `docs/01-plan/features/v2116-release-hardening.plan.md`, Report: `docs/04-report/features/v2116-release-hardening.report.md`.

**Layer A — Release Metadata Sync (3 files)**:
- `README.md` Version badge `Version-2.1.14-green` → `Version-2.1.16-green` (GitHub first-impression consistency)
- `hooks/session-start.js` line 3 comment `(v2.1.13, ...)` → `(v2.1.16, ...)` (runtime BKIT_VERSION dynamic import retained)
- `hooks/startup/session-context.js` line 2 header `(v2.0.0)` → `(v2.1.16)`

**Layer B — Test Maintenance (15 files, 31 stale FAIL → 0)**:
- Deleted 4 orphan test files (uncleaned after lib/context/* modules were removed in v2.1.10 Sprint 6 — `context-loader/impact-analyzer/invariant-checker/scenario-runner` test files)
- Updated 11 stale baseline files:
  - `test/unit/runner.test.js` U-RUN-015/016/069/071 — skills 30→31, workflow 11→12
  - `test/contract/extended-scenarios.test.js` 5 TC — SoT sync (per `lib/domain/rules/docs-code-invariants.js`: skills 44, agents 34, mcpTools 19)
  - `test/contract/invocation-inventory.test.js` 8 TC — counts sync + removed 6 pdca-eval-* (deleted in v2.1.10) + added 4 sprint-* (added in v2.1.13)
  - `test/contract/docs-code-sync.test.js` 11 TC — counts cascade + tmp fixture (`correct.md`) update
  - `test/contract/v2112-deep-qa-invariants.contract.test.js` L3-006/002 — lib module count `142→≥142` (growth-tolerant) + L3-002 runtime-conditional skip
  - `test/contract/orchestrator.test.js` 2 TC — reflects the evolved "회원가입" routing policy (`bkend-expert` agent allowed)
  - `test/contract/status-split.test.js` — status-core exports 17→19 (v2.1.15 #89 added `shouldUpdate` + `appendHistoryEntry`)
  - `test/unit/pdca-status-full.test.js` PS-026 — reflects the intended behavior of the Issue #89 fix (`src/features/auth/login.js` → no `'auth'` extraction)
  - `test/unit/trigger.test.js` U-TRG-016 — corrected the JS floating-point (`0.7+0.1 = 0.7999999999999999`) comparison to an epsilon `< 1e-9`
  - `test/unit/project-isolation.test.js` ISO-09 — reflects the v2.1.10 facade split (`status.js` → `status-core.js`)
  - `tests/qa/v2113-sprint-5-quality-docs.test.js` — L3 contract `10/10 PASS` → `14/14 PASS` (reflects v2.1.16 SC-11/12/13/14 additions)

**Layer C — CI Gate Reinforcement** (`.github/workflows/contract-check.yml`):
- New step `Release Gate — bkit-full-system (version sync + agent/skill structure)` — automatically blocks future release metadata stale defects
- New step `Release Gate — docs-code-sync (counts SoT drift detector)` — automatically detects skills/agents/mcpTools count drift

**Verification (post-hardening)**:
- `node test/contract/scripts/qa-aggregate.js`: PASS 3808 → **3844** (+36), FAIL 31 → **0**, errors 15 → **0**, file count 151 → 147 (-4 orphan)
- `node tests/qa/bkit-full-system.test.js`: 33 PASS / 3 FAIL → **36 PASS / 0 FAIL**
- `node tests/contract/v2113-sprint-contracts.test.js`: **14/14 PASS** maintained (SC-01 ~ SC-14)
- All 11 updated files run standalone with 0 FAIL

**Lessons Learned (carry to v2.1.17)**:
- L1 "Tests exist but unused" — `bkit-full-system.test.js` had detected release defects since v2.1.14 but was ignored due to lacking CI wiring. Resolved by Layer C in this cycle.
- L2 Stale baselines are not zero-interest debt — once accumulated, the "FAIL count is a false positive" pattern also masks real defects.
- L3 SoT pattern non-compliance — even though the `EXPECTED_COUNTS` SoT was accurate, the tests hardcoded literals → cascade drift. Carry CO-1: refactor tests to import the SoT.
- L4 The value of healthy user skepticism — without the question "Is that really all 5?", the 31 stale FAILs might have carried over to v2.1.17+.

## [2.1.15] - 2026-05-18 (branch: `feature/v2115-issue-89-pdca-status-fix`)

> **Status**: Patch release — response to Issue [#89](https://github.com/popup-studio-ai/bkit-claude-code/issues/89) (`.pdca-status.json` infinite contamination fix).
> **Reporter**: @doing27 — measured case 294KB, 138 of 147 features garbage, 1661 of 1669 history garbage.

### Fixed — Issue #89: `.pdca-status.json` infinite contamination (6-Layer Defense)

Closed the problem where garbage features accumulated in `.pdca-status.json` on every source file edit, via a 6-Layer defense.

- **L1 `extractFeature` reinforcement** (`lib/core/file.js`):
  - On pattern match, skip if the captured value is a file (has an extension) (`app/services/foo.py` → blocks the `'foo.py'` mis-extraction)
  - `GENERIC_NAMES` 19 → **expanded to 65 directories** — common backend/frontend layouts (`api`/`web`/`mobile`/`client`/`server`/`backend`/`frontend`/`admin`/`auth`/`cms`/`database`/`config`/`core`/`helpers`/`middleware`/`plugins`/`scripts`/`styles`/`static`/`public`/`assets`/`tests`/`tenants`/`versions`/`tmp`/`audit`/`dashboard`) + version directories (`v1`~`v9`) + Next.js route groups (`(dashboard)`/`(auth)`/`(public)`/`(admin)`/`(api)`)
  - Made the fallback (walking up to the parent directory) **explicit opt-in (default OFF)** — all existing callers receive the new default
  - Function signature: `extractFeature(filePath, opts = {})` (backward-compat)
- **L2 `extractFeatureFromContext` DRY** (`lib/pdca/status-core.js`):
  - Removed the duplicate pattern-matching code, delegating to `extractFeature` — sharing the same fix
- **L3 `updatePdcaStatus` validation gate** (`lib/pdca/status-core.js`):
  - `opts.requireDocs` (default true): silent no-op when `docs/01-plan/features/${feature}.plan.md` or `docs/02-design/features/${feature}.design.md` is absent
  - All 16 existing callers pass the default behavior (the PDCA workflow enters after writing the plan document)
  - Extracted into a `shouldUpdate` helper (testability)
- **L4 `scripts/pre-write.js` schema correction**:
  - Corrected `currentStatus?.currentFeature` → `currentStatus?.primaryFeature` (the v2/v3 schema has no `currentFeature` field — it is normalized at `status-migration.js:31,74`)
  - Resolved a latent bug where the v2.1.7 "Issue #79 P4" fix was actually a false-negative in all cases
- **L5 `history` dedup + ring buffer** (`lib/pdca/status-core.js`):
  - Separated into an `appendHistoryEntry` helper. Consecutive identical `feature/phase/action` entries only update the timestamp (no push)
  - Applied a ring buffer limit of 100 — after 100 identical edits, history always has exactly 1 entry
- **L6 unit tests, 48 TC** (regression prevention):
  - `tests/unit/file-extract-feature.test.js` (20 TC)
  - `tests/unit/extract-feature-from-context.test.js` (10 TC)
  - `tests/unit/pdca-status-gating.test.js` (18 TC, L3+L5 helper verification)

### Changed

- `extractFeature(filePath)` → `extractFeature(filePath, opts = {})` — `opts.allowFallback: false` default (backward-compat)
- `updatePdcaStatus(feature, phase, data)` → `updatePdcaStatus(feature, phase, data, opts = {})` — `opts.requireDocs: true` default + `opts.docCheckFn` test-injectable
- `lib/pdca/status-core.js` exports: added `shouldUpdate` + `appendHistoryEntry` helpers
- `lib/core/file.js` exports: added `GENERIC_NAMES`

### Compatibility

- **Breaking changes**: 0 (all existing callers are safe with the default behavior)
- **Migration**: not required — existing `.pdca-status.json` garbage can be cleaned up separately by the user (outside this PR)
- **v3 schema**: unchanged
- **bkit Trust Level**: no impact
- **Sprint Management (v2.1.13)**: no impact

### Documentation

- `docs/01-plan/features/issue-89-pdca-status-fix.plan.md` (Korean)
- `docs/02-design/features/issue-89-pdca-status-fix.design.md` (Korean, 6-Layer Defense design)
- `docs/04-report/features/issue-89-pdca-status-fix.report.md` (Korean, Phase 4 deliverable)

### Verification

- `node --test tests/unit/file-extract-feature.test.js` → 20/20 PASS
- `node --test tests/unit/extract-feature-from-context.test.js` → 10/10 PASS
- `node --test tests/unit/pdca-status-gating.test.js` → 18/18 PASS
- Cumulative **48/48 PASS**

---

## [2.1.13] - 2026-05-12 (branch: `feature/v2113-sprint-management`)

> **Status**: GA — Sprint Management feature release + tech debt cleanup.
> **One-Liner (EN)**: The only Claude Code plugin that verifies AI-generated code against its own design specs.
> **One-Liner (KO)**: AI가 만든 코드를 AI가 만든 설계로 검증하는 유일한 Claude Code 플러그인.

### Added — Sprint Management (Major Feature)

A new **meta-container** that groups one or more features under shared scope,
budget, and timeline. Sprint runs an 8-phase lifecycle independent of (and
orthogonal to) the per-feature PDCA 9-phase cycle.

- **Sprint 8-phase lifecycle**: `prd → plan → design → do → iterate → qa → report → archived`
- **16 sub-actions**: `/sprint init / start / status / list / watch / phase / iterate / qa / report / archive / pause / resume / fork / feature / help / master-plan`
- **4 Auto-Pause Triggers**: `QUALITY_GATE_FAIL` / `ITERATION_EXHAUSTED` / `BUDGET_EXCEEDED` / `PHASE_TIMEOUT` — instant pause on detection
- **Trust Level scope L0-L4** via `SPRINT_AUTORUN_SCOPE` (L0 stop-after-plan / L1 design / L2 do / L3 qa / L4 archived = full-auto)
- **7-Layer S1 dataFlowIntegrity QA** — `UI → Client → API → Validation → DB → Response → Client → UI` hop traversal via `sprint-qa-flow` agent
- **3 new MCP tools** in `bkit-pdca-server`: `bkit_sprint_list` / `bkit_sprint_status` / `bkit_master_plan_read`
- **4 new agents**: `sprint-master-planner` (Context-Anchor-driven plan generation) / `sprint-orchestrator` (Sequential dispatch ENH-292 pattern) / `sprint-qa-flow` (S1 verification) / `sprint-report-writer` (cumulative KPI aggregation)
- **1 new skill**: `skills/sprint/SKILL.md` (327 LOC) + `PHASES.md` (83 LOC) + 3 examples (`basic-sprint.md` / `multi-feature-sprint.md` / `archive-and-carry.md`)
- **7 new templates**: `templates/sprint/{master-plan, prd, plan, design, iterate, qa, report}.template.md`
- **2 new infrastructure adapters**: `lib/infra/sprint/sprint-state-store.adapter.js` (181 LOC) + `lib/infra/sprint/sprint-telemetry.adapter.js` (200 LOC)
- **9 application-layer modules** in `lib/application/sprint-lifecycle/`: `phases.js` (frozen 8-phase enum + `SPRINT_PHASE_ORDER` + `isValidSprintPhase` + `nextSprintPhase` helpers) + `transitions.js` + `start-sprint.usecase.js` + `advance-phase.usecase.js` + `iterate-sprint.usecase.js` + `verify-data-flow.usecase.js` + `generate-report.usecase.js` + `archive-sprint.usecase.js` + `master-plan.usecase.js` + `auto-pause.js` + `quality-gates.js` + `context-sizer.js` + `index.js` (19 barrel exports)
- **5 sprint infrastructure adapters** beyond state-store/telemetry: `gap-detector.adapter.js` + `auto-fixer.adapter.js` + `data-flow-validator.adapter.js` (no-op baseline + agentTaskRunner-injected real impl path) + `matrix-sync.adapter.js` + `sprint-doc-scanner.adapter.js`
- **1 new L3 contract test**: `tests/contract/v2113-sprint-contracts.test.js` (366 LOC, 8 cross-sprint contracts SC-01 ~ SC-08): entity shape · deps interface · infra adapters · handler signature · 4-layer chain · ACTION_TYPES 20 · SPRINT_AUTORUN_SCOPE mirror · hooks 21:24 invariant
- **2 Korean user guides**: `docs/06-guide/sprint-management.guide.md` (~330 lines, 8 sections) + `sprint-migration.guide.md` (~200 lines, PDCA ↔ Sprint orthogonal coexistence)
- **2 new ADRs**: `docs/adr/0006-cc-upgrade-policy.md` (CC version compatibility policy, 79+ consecutive baseline) + `docs/adr/0007-sprint-as-meta-container.md` (Sprint = meta-container above PDCA, backward-compat invariant)
- **Context Sizer** (S3-UX) — Kahn topological sort + greedy bin-packing for sprint feature size estimation (`lib/application/sprint-lifecycle/context-sizer.js`, max 100K tokens/sprint, 25% safety margin, dependency-aware)
- **Sprint Master Plan Generator** (S2-UX) — `sprint-master-planner` agent that produces Context-Anchor-driven sprint planning documents from the 7 Sprint 4 templates

### Added — Sprint UX Improvement (4 sub-sprints S1-UX ~ S4-UX)

Sub-sprints iteratively hardened Sprint Management UX:

- **S1-UX** — P0 phase reset + P1 trust/CLI/skill args fixes (Phase 4 Do)
- **S2-UX** — Master Plan Generator implementation (`sprint-master-planner` agent body + frontmatter)
- **S3-UX** — Context Sizer with Kahn topological sort + greedy bin-packing
- **S4-UX** — Integration + L3 contract test 10/10 PASS + 16-cycle iteration verification

### Changed — Skill Cross-References (14 skills)

The following skills received minor edits to document Sprint coexistence:

`audit` · `bkit-rules` · `bkit-templates` · `bkit` · `control` · `deploy` ·
`development-pipeline` · `enterprise` · `pdca-batch` · `pdca` · `plan-plus` ·
`pm-discovery` · `qa-phase` · `rollback`

Each surfaces a one-line note clarifying the orthogonal coexistence model (PDCA 9-phase per-feature ↔ Sprint 8-phase meta-container).

### Changed — Architecture

- `ACTION_TYPES` 16 → **20** (added `sprint_paused` + `sprint_resumed` + `master_plan_created` + `task_created` for DEEP-4 fix)
- `CATEGORIES` 10 → **11** (added `'sprint'` category)
- `lib/orchestrator/next-action-engine.js` +48 LOC — sprint phase transition integration (Stop-family hook routing)
- `lib/orchestrator/team-protocol.js` +36 LOC — sprint Task spawn coordination
- `lib/intent/language.js` +58 LOC — sprint trigger pattern expansion (`/sprint` 16 sub-actions + master-plan)
- `scripts/sprint-handler.js` — new (660 LOC) — sprint sub-action router with idempotent resume
- `scripts/sprint-memory-writer.js` — new (138 LOC) — sprint state persistence
- `servers/bkit-pdca-server/index.js` +170 LOC — 3 new MCP tools registered

### Removed — Tech Debt Cleanup (net −2,333 LOC)

Legacy infrastructure templates removed (superseded by `/enterprise` skill guidance + bkend.ai BaaS integration):

- `templates/infra/argocd/application.yaml.template`
- `templates/infra/deploy-dynamic.yml`
- `templates/infra/deploy-enterprise.yml`
- `templates/infra/staging-eks-ondemand.yml`
- `templates/infra/observability/kube-prometheus-stack.values.yaml`
- `templates/infra/observability/loki-stack.values.yaml`
- `templates/infra/observability/otel-tempo.values.yaml`
- `templates/infra/security/security-layer.yaml.template`
- `templates/infra/terraform/main.tf.template`

### Fixed — Inline Root Fixes (Final QA, commit `5edae8f`)

- **Intent ordering** — `lib/intent/language.js` trigger pattern conflict between `/sprint` and `/pdca` sub-actions resolved (sprint pattern priority + early-return on exact match)
- **Audit category migration** — `ACTION_TYPES.master_plan_created` and `task_created` routing path corrected in `lib/audit/audit-logger.js` (sprint events now correctly emit under the `sprint` category, not generic `pdca` category)

### Fixed — v2.1.12 Carryovers Closed

- **CARRY-7**: `handleStart` idempotent resume (sprint resume after pause did not restore state correctly — fixed in `scripts/sprint-handler.js` + E2E sprint/pdca/control verification, commit `a33af52`)
- **CARRY-8 ~ CARRY-12**: sprint integration gaps closed (MCP tool registration / audit category routing / config defaults) via deep-sweep v2 (commit `65cc0f3`, full-surface sprint integration + MCP/audit/config gaps)
- **38 scripts bare-require guard** (deferred from v2.1.12): the remaining `if (require.main !== module)` guards completed across the remaining hook handlers

### Verified — CC v2.1.139 Compatibility

- **94 consecutive compatible releases** (v2.1.34 → v2.1.139, R-2 v2.1.134/135 skip excluded)
- **ADR 0003 8th application** (single-pair small-batch scenario second occurrence: v2.1.138 1 bullet + v2.1.139 30 bullets — robust under all observed scenarios)
- **F9-120 closure 9-streak** — `claude plugin validate .` Exit 0 across v2.1.120 / 121 / 123 / 129 / 132 / 133 / 137 / 139 (carryover monitoring closed)
- bkit's **conservative recommendation**: Claude Code v2.1.123+ (79 consecutive compatible at recommendation point)
- bkit's **balanced recommendation**: Claude Code v2.1.139 (94 consecutive compatible)

### Documentation

- README.md badge + architecture section + Sprint Management section + recommended runtime (`v2.1.123+` conservative · `v2.1.139` balanced) updated to v2.1.13
- README-FULL.md v2.1.13 inventory section added (Sprint Management deliverables + 4 UX sub-sprints + tech debt cleanup)
- CUSTOMIZATION-GUIDE.md Component Inventory bumped to v2.1.13 (44 Skills · 34 Agents · 51 Scripts · 163 Lib Modules / 19 subdirs · 39 Templates · 19 MCP Tools)
- AI-NATIVE-DEVELOPMENT.md Context Engineering Layers updated to v2.1.13 + Sprint Management positioned as **AI-Native Principle 6** (Meta-Container for Multi-Feature Initiatives)
- `bkit-system/_GRAPH-INDEX.md` current release v2.1.13 + Sprint Skill (1) + Sprint Agents (4) + Sprint Templates (7) categories added
- `scripts/docs-code-sync.js` `EXPECTED_COUNTS` invariant updated (`skills: 44, agents: 34, mcpTools: 19`)
- 89+ legacy docs archived to `docs/archive/2026-05/` (v2.1.10 / v2.1.11 / v2.1.12 cycles + cc-v2110~v2137 + stale features)
- Real working example sprint: `docs/01-plan/features/v2113-docs-sync.master-plan.md` (this very release's documentation sync sprint, used to dogfood `/sprint`)

### Dogfooded

The v2.1.13 documentation synchronization itself was driven as a Sprint:
`/sprint init v2113-docs-sync --trust L4 --features f0-baseline,f1-version-bump,
f2-changelog,f3-readme,f4-readme-full,f5-customization,f6-bkit-system,
f7-hooks-commands,f8-archive-cleanup,f9-real-use-validation`. The final report
lives at `docs/04-report/features/v2113-docs-sync.report.md`.

## [2.1.12] - 2026-04-28 (branch: `hotfix/v2112-evals-wrapper-argv`)

> **Status**: Silent hotfix. Drop-in patch on top of v2.1.11. Zero breaking changes.
> **One-Liner (EN)**: The only Claude Code plugin that verifies AI-generated code against its own design specs.
> **One-Liner (KO)**: AI가 만든 코드를 AI가 만든 설계로 검증하는 유일한 Claude Code 플러그인.

### Deep Functional QA Fixes (2026-04-29)

A second-pass deep audit (`docs/04-report/bkit-v2112-deep-functional-qa-issues.report.md`)
discovered 23 latent defects spanning observability, lifecycle, control state,
rollback integrity, multilingual routing and API symmetry. The 19 actionable
items below were folded into v2.1.12; the remaining 4 are documented as
v2.1.13 carries (CARRY-7~12 in MEMORY.md).

#### P0 — Observability & Multilingual

- **#17 — token-meter Adapter completely broken.** `scripts/unified-stop.js:692-701`
  read `process.env.CLAUDE_*` (env vars CC v2.1.x never injects), so 472/472
  ledger entries had `inputTokens=0 / outputTokens=0 / model='unknown'`. Fixed
  to read from the parsed stdin payload (`hookContext.session_id`,
  `hookContext.message.model`, `hookContext.message.usage.{input_tokens,
  output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`).
  Added `cacheReadInputTokens` / `cacheCreationInputTokens` / `parseStatus` /
  `parseWarnings` fields to `lib/cc-regression/token-accountant.js` recordTurn
  signature and `lib/domain/ports/token-meter.port.js` TurnMetadata typedef.
- **#21 — intent-router multilingual routing failed.**
  `lib/intent/trigger.js` produced `confidence = 0.7999999999999999` (FP error)
  which the intent-router rejected at the `>= 0.8` gate. Computed via
  `Number((threshold + 0.1).toFixed(2))` so the value is exactly 0.8.
  Also broadened `bkend-expert.{ko,ja,zh,...}` patterns in
  `lib/intent/language.js` so natural utterances ("회원가입 만들어줘",
  "会員登録 機能", "注册功能") match without requiring exact phrasing.

#### CRITICAL — Reliability

- **#1 + #11 — control-state.json self-contradiction.**
  `setLevel(n)` only updated `currentLevel`, leaving `level` (string) and
  `levelCode` (int) stale. A trust-score auto-downgrade then silently
  overrode user-explicit choices. Fixed `setLevel` to atomically write all
  three canonical fields plus a `setBy` sentinel; trust-engine now refuses
  to downgrade when `setBy === 'user-explicit-request'` and records
  `lastAutoTransitionReason: 'trust-downgrade-blocked-user-explicit'`.
- **#12 — verifyCheckpoint always false.**
  `createCheckpoint` hashed only the `pdcaStatus` snapshot but
  `verifyCheckpoint` recomputed over the full checkpoint object minus the
  hash fields, guaranteeing mismatch. Aligned `verifyCheckpoint` to recompute
  `sha256(JSON.stringify(cp.pdcaStatus))` and compare against
  `cp.pdcaStatusHash`. Returns `hashType: 'pdcaStatusHash' | 'hash' | 'none'`.
- **#14 — error-log all "unknown / null / empty".**
  `scripts/stop-failure-handler.js` only checked top-level `error_type`,
  `error_message`, `agent_id`, `agent_type`. Now also probes
  `input.message.{error_type, agent_id, agent_type, content[0].text}` and
  `input.error.{type, message}`, captures `parseStatus`
  (`'ok' | 'no_input' | 'partial'`) plus a free-form `parseWarnings`.

#### IMPORTANT — API symmetry / Lifecycle

- **#13 — state-machine API asymmetry.**
  `getAvailableEvents` returned `[{event, target, guard}]` objects but
  `canTransition` and `transition` accepted only string event names, so
  the natural pattern `getAvailableEvents(s).filter(e => canTransition(s, e))`
  silently failed. Both functions now accept either form (centralised in a
  private `_normaliseEvent()` helper); `transition()` always returns the
  normalised string event in its result. Defensively defaults `context`
  to `{}` when omitted.
- **#15 — agent-state stale across sessions.** SessionStart now detects
  agent-state lastUpdated older than `staleFeatureTimeoutDays` (default 7
  from control-state guardrails) and resets the lifecycle fields with a
  `_resetReason` audit trail.
- **#16 — agent-state enabled:false ghost fields.** `writeAgentState` now
  zeros `teammates / progress / sessionId / recentMessages` when
  `enabled === false` so disk state is always coherent. `feature` is
  intentionally retained as audit trail.
- **#9 + #10 + #8 — bare-require side effects.** Added
  `if (require.main !== module) { module.exports = {}; return; }` guard to
  9 critical hook handlers (`gap-detector-stop`, `pdca-skill-stop`,
  `iterator-stop`, `plan-plus-stop`, `subagent-{start,stop}-handler`,
  `team-idle-handler`, `pdca-task-completed`, `sync-folders`). Tests, smoke
  checks, and accidental imports no longer emit stale stdout
  (decisions, advisory messages) without a real hook payload. The
  remaining 38 scripts are tracked as v2.1.13 CARRY.
- **#19 — destructive-detector missed SQL/DB destruction.** Added rules
  G-009 (`DROP TABLE/DATABASE/SCHEMA/...`), G-010 (`TRUNCATE TABLE` /
  `ALTER TABLE … DROP COLUMN`), G-010b (`DELETE FROM` without `WHERE`),
  G-011 (NoSQL `db.<col>.drop()`, `dropDatabase()`, Redis `FLUSHALL/FLUSHDB`).
- **#20 — explorer.listAll opaque shape.** Added `listSkills()` and
  `listAgents()` flat-array helpers. JSDoc on `listAll()` clarified.
- **#22 — formatSuggestion("undefined: undefined —").** Now returns `''`
  for null / non-object / partial suggestions.
- **#23 — slash-command syntax not routed.** `route()` recognises
  `^/(\w[\w-]*)(?:\s+(.+))?$` as `type:'command'` with confidence 0.95
  and short-circuits downstream pattern matching.
- **#2 — telemetry "missing" was docs drift.** `cc-event-log.ndjson` and
  `session-ctx-fp.json` (note: `.json`, not `.ndjson` as memory had) are
  created lazily on first hook event / fingerprint write — verified live.
  Memory/docs corrected; no code change required.

#### P3 — Hygiene

- **#6 — 39 lib modules missing `@version` JSDoc.** Bulk-added `@version 2.1.12`
  to every lib/.js module. Now 142/142.
- **operational hygiene** — Removed stale runtime artifacts: `evals-pdca-13:45/14:01*.json`
  (4 files left from B1 / B3 BUG state) and the deprecated v1
  `v2112-skill-smoke.js` checker.

#### Reclassified / Deferred

- **#18 — L4 returns 'auto' for `bash_destructive`.** Reclassified P3 (was P2).
  At L4 (Full-Auto, "All auto, post-review only") this is by-design per
  `LEVEL_DEFINITIONS[4]`. The L5 tests still pin level explicitly to confirm
  L3/L2 boundary behaviour.
- **#7 — 121/142 lib modules in `legacy` layer.** Deferred to v2.1.13+
  Sprint F-1; tracked as a Clean-Architecture floor invariant goal
  (≥30% by v2.1.14).

### Fixed

- **B1 — `lib/evals/runner-wrapper.js:93` argv mismatch (P0).** The wrapper
  invoked `spawnSync('node', [runnerPath, skill])`, but `evals/runner.js`
  parses only the documented `--skill <name>` flag form (line 409-414).
  Every `/bkit-evals run <skill>` therefore printed the Usage banner, exited
  0, and the wrapper falsely reported `ok: true`. Fixed to
  `spawnSync('node', [runnerPath, '--skill', skill])`. Locked by L3 contract
  test `test/contract/v2112-evals-wrapper.contract.test.js`.
- **B2 — `lib/evals/runner-wrapper.js` false-positive defense (P0).** Exit
  code 0 alone no longer implies `ok: true`. The wrapper classifies a
  missing parsed JSON block: `reason: 'argv_format_mismatch'` when stdout
  contains `Usage:`, otherwise `reason: 'parsed_null'`. The `reason` field
  is also persisted in `.bkit/runtime/evals-{skill}-{ts}.json`.
- **B3 — `lib/evals/runner-wrapper.js` JSON parse robustness (P0, FR-13).**
  v2.1.11 used `stdout.lastIndexOf('{')` which selected a **nested**
  object's opening brace (e.g., `details: {`), causing the outer `}` to
  become trailing data and `JSON.parse` to fail on otherwise valid runner
  output. Replaced with a 2-strategy extractor (`_extractTrailingJson`):
  (1) parse the whole trimmed stdout, (2) fall back to a string-aware
  balanced-brace scan from the last `}`. Module exports the helper for
  unit testing.
- **D1 — `skills/bkit-evals/SKILL.md:45` doc accuracy.** Spec now matches
  implementation: `node evals/runner.js --skill <skill>` instead of the
  positional `<skill>` form. Defense and parse-robustness behavior also
  documented.
- **L1 stale baseline — `tests/qa/bkit-deep-system.test.js:854` `A9-2`.**
  Bumped expected skills count 39 → 43 to match v2.1.11 Sprint β additions
  (bkit-explore, bkit-evals, pdca-watch, pdca-fast-track). Local-only file
  (`tests/` is gitignored).
- **L3 contract baseline — `test/contract/docs-code-sync.test.js`,
  `test/contract/extended-scenarios.test.js`.** Bumped EXPECTED_COUNTS.skills
  39 → 43 across diffCounts/synthetic-drift/correct-doc fixtures. The
  invariant module `lib/domain/rules/docs-code-invariants.js` was already
  43 — the contract tests were the lagging surface from v2.1.11.

### Added

- **L1 unit + L2 integration tests** —
  `tests/qa/v2112-evals-wrapper.test.js` (260 LOC, 18 TC) covering
  isValidSkillName boundary cases, `_extractTrailingJson` happy /
  log-prefixed / null / string-aware paths, every `invokeEvals` defense
  reason, fake-runner contract for happy and pass:false outcomes,
  persisted result file with `reason` field, and real-runner integration
  against `pdca` (workflow), `starter` (capability), `qa-phase` (workflow).
- **L3 contract test** — `test/contract/v2112-evals-wrapper.contract.test.js`
  (2 TC) locks (a) the wrapper-emitted argv `['--skill', skill]` via
  PATH-injected node shim, and (b) the runner.js Usage banner spec byte-
  exact. Tracked in `test/contract/` so CI catches future drift.

### Internal

- **BKIT_VERSION 5-loc bump 2.1.11 → 2.1.12** — `bkit.config.json`
  (canonical), `.claude-plugin/plugin.json`, `README.md` badge,
  `CHANGELOG.md` (this entry), `hooks/hooks.json`.
  `scripts/docs-code-sync.js` invariant 5/5 enforced.
- **One-Liner SSoT 5/5 unchanged** — `lib/infra/branding.js` text identical
  across plugin.json + README + README-FULL + session-context.js +
  CHANGELOG.
- **`lib/evals/runner-wrapper.js` `@version 2.1.12`** (`@since 2.1.11`
  preserved for module-introduction history).
- **`.claude-plugin/marketplace.json`** version 2.1.11 → 2.1.12 (root +
  bkit plugin entry).
- **`AI-NATIVE-DEVELOPMENT.md`, `README-FULL.md`, `CUSTOMIZATION-GUIDE.md`,
  `bkit-system/README.md`, `bkit-system/_GRAPH-INDEX.md`,
  `bkit-system/triggers/priority-rules.md`, `hooks/session-start.js`** —
  active "v2.1.11" labels rolled to "v2.1.12"; historical "v2.1.11 added X"
  facts preserved.

### Carryovers (unchanged from v2.1.11)

- ENH-277 P0, ENH-278 P2, ENH-280 P1 — see v2.1.11 release notes.

---

## [2.1.11] - 2026-04-28 (branch: `feat/v2111-integrated-enhancement`)

> **Status**: All 4 Sprints complete (α/β/γ/δ). 20 FRs implemented; gap-detector ≥ 92% per Sprint, average ~95%.
> **One-Liner (EN)**: The only Claude Code plugin that verifies AI-generated code against its own design specs.
> **One-Liner (KO)**: AI가 만든 코드를 AI가 만든 설계로 검증하는 유일한 Claude Code 플러그인.

### 🎯 Sprint α — Onboarding Revolution

Redesign of the first-5-minutes experience: One-Liner Single Source of Truth (synced across 5 locations), Agent Teams env auto-detection, CC version check, First-Run tutorial (Pencil Design Anchor pilot).

- **FR-α1+α2-c/d**: `README.md` 100-line restructure + `README-FULL.md` separation. One-Liner header on both (`681e8ed`).
- **FR-α2-a/b**: `lib/infra/branding.js` (`ONE_LINER_EN` / `ONE_LINER_KO`); `.claude-plugin/plugin.json:description` synced (`d348f24`).
- **FR-α2-e**: CHANGELOG v2.1.11 block + 5-location BKIT_VERSION sync (`9fa1707`).
- **FR-α2-f**: `docs-code-scanner.scanOneLiner()` + 5-location enforced drift detection (`c986228`).
- **FR-α3**: First-Run AUQ tutorial (`hooks/startup/first-run.js`) + `.bkit/runtime/first-run-seen.json` idempotent marker + Pencil Design Anchor pilot (`be691c6`).
- **FR-α4**: `hooks/startup/preflight.js:checkAgentTeamsEnv()` SessionStart warning when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` unset (`724b05c`).
- **FR-α5**: `lib/infra/cc-version-checker.js` — 2-strategy detection + `FEATURE_VERSION_MAP` 8 entries (`724b05c`).

### 🔍 Sprint β — Discoverability

6 FRs that make the installed 39 skills + 36 agents + evals system discoverable and usable by users.

- **FR-β1**: `/bkit-explore` — `lib/discovery/explorer.js` + `skills/bkit-explore/SKILL.md`. 5-category tree + Level filter + listEvals (`aef5e36`).
- **FR-β2**: `/bkit-evals` — `lib/evals/runner-wrapper.js` safe wrapper (skill regex, argv-form spawn, 30s timeout, `.bkit/runtime/evals-{skill}-{ts}.json`) + `skills/bkit-evals/SKILL.md` (`81b9048`).
- **FR-β3**: Friendly error messages — `lib/i18n/translator.js` + `assets/error-dict.{en,ko}.json` (RD-5 narrowed scope: 9 cat × 1 default style × KO+EN full + 6 lang fallback) (`237e071`).
- **FR-β4**: `/pdca-watch` — `lib/dashboard/watch.js` (read-only state tap, 30s `/loop` v2.1.71+, fallback E-β4-01) + `skills/pdca-watch/SKILL.md` (`58906e0`).
- **FR-β5**: `/pdca-fast-track` — `lib/control/fast-track.js` (3 preconditions, `.bkit/runtime/fast-track-log.json` audit trail) + `skills/pdca-fast-track/SKILL.md` (`0fb0e1e`). Config block added to `bkit.config.json#control.fastTrack` (`e2851aa`).
- **FR-β6**: 8-language auto-detect — `lib/i18n/detector.js` (`detectFromPrompt`, `mergeWithEnv`) (`7058a41`).
- **L2 integration**: `test/integration/sprint-beta.test.js` 17 TC cross-FR scenarios (`03f04fc`).

### 🔒 Sprint γ — Trust Foundation

Complete closure of the residual R1/R2 risks from v2.1.10 + L5 E2E expansion.

- **FR-γ1**: Trust Score `reconcile()` public API + dead-code invariant. `scripts/check-trust-score-reconcile.js` 4-check CI gate (`e6bfe4c`).
- **FR-γ2**: Application Layer pilot — `lib/application/pdca-lifecycle/{index,phases,transitions}.js` (PHASES enum + 19 legal transitions) + ADR 0005 (`docs/adr/0005-application-layer-pilot.md`). `lib/pdca/lifecycle.js` unchanged (v2.1.12 shim conversion carryover).
- **FR-γ3**: L5 E2E 9-scenario — `test/e2e/pdca-full-cycle-9scenario.test.js` (Agent Teams skip-policy: scenarios 1+7 skip-if-no-env) (`c557e2e`).
- **FR-γ4**: Agent-Hook multi-event grep investigation → ADR 0004 (`docs/adr/0004-agent-hook-multi-event-deferral.md`) — 0 agent-type matchers, defer to v2.1.12 ENH-280 (`4597e92`).

### ⚙️ Sprint δ — Port Extension & Governance

Foundation for v2.2.x expansion.

- **FR-δ1**: MCP Port abstraction — `lib/domain/ports/mcp-tool.port.js` (type-only, ENH-277 `CALL_PATHS=['skill','slash','hook']`) + `lib/infra/mcp-port-registry.js` (16 tools = 10 pdca + 6 analysis frozen) + 21 contract TC (`7af7d5b`).
- **FR-δ2**: M1-M10 Quality Gates catalog — `docs/reference/quality-gates-m1-m10.md` + `scripts/check-quality-gates-m1-m10.js` 3-way SSoT invariant (catalog ↔ `bkit.config.json` ↔ runtime) (`84fd118`).
- **FR-δ3**: Trigger accuracy 8-language baseline — `test/i18n/fixtures/prompts-{en,ko,ja,zh,es,fr,de,it}.json` (80 prompts) + `trigger-accuracy-baseline.json` frozen regression guard. EN/KO/JA/ZH 100%, DE 70%, ES/FR 30%, IT 20%. Aggregate 68.75%.
- **FR-δ4**: `/pdca token-report` aggregator — `lib/pdca/token-report.js` (summary + byPhase + byModel + Top 5 + CAND-004 OTEL 3 attributes: I4-121 byStopReason/byFinishReason + F8-119+I6-119 byTool). `lib/infra/telemetry.js#sanitizeForOtel` 2-gate AND-logic (`OTEL_REDACT` + `OTEL_LOG_USER_PROMPTS`) (`fe1eee9`).
- **FR-δ5**: CC upgrade policy ADR — `docs/adr/0006-cc-upgrade-policy.md` (5-outcome matrix, skip criteria, empirical validation gate) (`84fd118`).
- **FR-δ6**: Release automation — `scripts/release-plugin-tag.sh` (BKIT_VERSION SoT verify + CI invariants + `claude plugin tag` wrapper, ENH-279) (`98b06b3`).

### Added

- 4 new ADRs (0004 agent-hook defer, 0005 Application Layer pilot, 0006 CC upgrade policy)
- 13 new lib modules (branding, cc-version-checker, discovery/explorer, evals/runner-wrapper, i18n/{translator,detector}, dashboard/watch, control/fast-track, application/pdca-lifecycle/×3, infra/mcp-port-registry, pdca/token-report)
- 9 new domain Port (mcp-tool.port joins existing 6) — 7 Port↔Adapter mappings now complete
- 3 new CI invariant scripts (check-trust-score-reconcile, check-quality-gates-m1-m10, release-plugin-tag)
- 4 new skills (bkit-explore, bkit-evals, pdca-watch, pdca-fast-track)
- 261 v2.1.11-specific tests (L1 unit + L2 integration + L3 contract + L5 E2E)

### Changed

- `lib/infra/telemetry.js#sanitizeForOtel` — 2-gate logic for CAND-004 OTEL user-prompt attribute
- `lib/control/trust-engine.js` — adds `reconcile()` public API
- `bkit.config.json` — `control.fastTrack` block + `version: 2.1.11` (5-loc sync)

### Carryovers (v2.1.12)

- ENH-277: hook → MCP tool direct invocation pilot (audit-logger candidate)
- ENH-278: autoMode `$defaults` (bkit doesn't use autoMode)
- ENH-280: Agent-Hook multi-event expansion
- Translator scope expansion: 11 missing categories + 4-style fan-out + 6-language full-quality
- Fast-track `reconcileHistory[]` append
- `lib/pdca/lifecycle.js` → shim conversion + 30+ consumer migration
- Romance language (es/fr/it) detector accuracy improvement
- ADR numbering cleanup (design ref'd 0002 but next free was 0006)

### Compatibility

- CC CLI **v2.1.118+ recommended** (79 consecutive compatible since v2.1.34); v2.1.78+ minimum (warned via FR-α5).
- Baseline: v2.1.10 (commit `f2c17f3`). Zero breaking changes for v2.1.10 users on upgrade.

---

## [2.1.10] - 2026-04-22 (branch: `feat/v2110-integrated-enhancement`, pre-main-merge)

> **Release discipline**: This section is a snapshot taken just before `git tag v2.1.10` + main merge. After a 48h observation period, the section will be reorganized at final release.

### 🎯 Sprint 0 ~ Sprint 6 — Integrated Enhancement (Clean Architecture + Defense-in-Depth + Invocation Contract)

Maintains compatibility against the CC v2.1.117 baseline + cumulative implementation across 6 Sprints (0/1/2/3/4/4.5 + 5a/5b/5.5/6). The version that incorporates the full scope per Plan-Plus §20.

### Added

- **Clean Architecture 4-Layer**: `lib/domain/{ports,guards,rules}` 11 modules (0 Domain dependencies), `lib/infra/{telemetry,docs-code-scanner,cc-bridge,mcp-test-harness}` (Adapters), `lib/cc-regression/` (Application) 6 modules = 568 LOC.
- **6 Domain Ports**: `cc-payload`, `state-store`, `regression-registry`, `audit-sink`, `token-meter`, `docs-code-index` — Type-only contracts based on JSDoc typedef.
- **4 Domain Guards** (CC v2.1.117 regression defense): `enh-254-fork-precondition` (#51165), `enh-262-hooks-combo` (#51798), `enh-263-claude-write` (#51801), `enh-264-token-threshold` (#51809).
- **Guard Registry**: `lib/cc-regression/registry.js` — 21 Guards registered (MON-CC-02, MON-CC-06 17 cases, ENH-262/263/264, ENH-214). Activated `lifecycle.reconcile()` auto-release with 4 `expectedFix` seeds.
- **Invocation Contract Test L1~L4** (of 619 assertions, L1+L4 226 assertions are the CI gate): `test/contract/baseline/v2.1.9/` 94 JSON baseline (39 skills + 36 agents + 16 MCP tools + hook events 24 blocks + slash commands + 3 MCP resources).
- **Contract L2 Smoke** (`l2-smoke.test.js` 98 TC) + **L3 MCP Compatibility** (`l3-mcp-compat.test.js` 83 TC).
- **Docs=Code CI** (ENH-241): `lib/infra/docs-code-scanner.js` + `scripts/docs-code-sync.js` — automatic 0-drift verification of 8 counts: skills/agents/hookEvents/hookBlocks/mcpServers/mcpTools/libModules/scripts.
- **2 CI Workflows**: `.github/workflows/contract-check.yml` (lint + contract + docs-code-sync + check-guards + check-deadcode), `cc-regression-reconcile.yml` (daily cron).
- **3 Validator CLIs**: `scripts/check-guards.js` (21 guards), `scripts/docs-code-sync.js` (0 drift), `scripts/check-deadcode.js` (Live/Exempt/Legacy classification).
- **Integration Runtime Test** (`test/contract/integration-runtime.test.js` 23 TC): Sprint 4.5 recursion bug permanent defense line.
- **Legacy QA Integration** (v2.1.10 Sprint 5a): `qa-aggregate.js` `tests/qa/` integrated aggregation + `EXPECTED_FAILURES` separate counter.
- **Total Test Cases**: **3,649 TC** (PASS 3,647 / FAIL 0 / Expected 2) — aggregated across 111 test files. +581 TC vs v2.1.9.

### Changed

- **lib/pdca/status.js** 872 LOC → split into facade 52 + `status-core.js`(399) + `status-migration.js`(156) + `status-cleanup.js`(255).
- **scripts/pre-write.js** 286 → 529 LOC, turned into a 12-stage pipeline (defense-coordinator integration).
- **plugin.json `description`** re-described: explicitly states 39 Skills / 36 Agents / 24 Hook Blocks / 16 MCP Tools.
- **MEMORY.md Architecture** counts realigned to the v2.1.10 baseline: 101 → **128 Lib Modules** (Sprint 7 final, adds `lib/orchestrator/` 5 + `lib/domain/` 11 + `lib/infra/` 3 + `lib/cc-regression/` 8 + 3 top-level), 24,616 → **~27,085 LOC**, 43 → **47 Scripts**, lib subdirs 11 → **15** (audit, cc-regression, context, control, core, domain, infra, intent, orchestrator, pdca, qa, quality, task, team, ui).
- **BKIT_VERSION centralization complete** (ENH-167): `hooks/session-start.js`, `hooks/hooks.json`, `scripts/unified-bash-pre.js`, `lib/core/io.js` all reference `lib/core/version.js`. `bkit.config.json:version` is the single source of truth.
- **`createDualSink` audit-logger usage prohibited**: Sprint 4.5 recursion lesson — changed to a standalone `createOtelSink()` call at `lib/audit/audit-logger.js:219`. Added a 14-line DANGER ZONE warning comment at `lib/infra/telemetry.js:56-73`.

### Fixed

- **C1 (Critical)**: `lib/audit/audit-logger.js:332-344` `startDate` → `date` parameter (synced with the design spec).
- **C2 (Critical)**: audit details PII leak prevention — `sanitizeDetails` 6-key blacklist + 500-char cap.
- **Sprint 4.5 self-introduced bug**: `createDualSink(createFileSink, createOtelSink)` + `createFileSink` re-calling `audit-logger.writeAuditLog()` → 682 GB recursion. Replaced with a standalone `createOtelSink()` call + integration-runtime TC permanent defense.

### Security

- **Defense-in-Depth 4-Layer** formalized: Layer 1 (CC Built-in) → Layer 2 (bkit PreToolUse Hook: `pre-write.js` + `unified-bash-pre.js` + defense-coordinator) → Layer 3 (`audit-logger` OWASP A03/A08 sanitizer) → Layer 4 (Token Ledger `.bkit/runtime/token-ledger.json` NDJSON).
- **PII Redaction 7-key**: `text`, `content`, `prompt`, `message`, `api_key`, `token`, `password` blacklist.
- **ENH-263 blocks the `.claude/` write + bypassPermissions combination** (#51801).
- **ENH-262 blocks the dangerouslyDisableSandbox + allow combination** (#51798).

### Compatibility

- **Invocation Contract 100% preserved** (226 assertions PASS maintained).
- **Starter / Dynamic / Enterprise segments zero-action update**.
- **CC CLI compatibility**: v2.1.78+ required, **v2.1.117+ recommended** (75 consecutive compatible releases).
- **Deprecation**: none (first minor to introduce the policy).

### Architecture Snapshot (v2.1.10 Final — Sprint 7 workflow organicity complete)

**39 Skills · 36 Agents · 21 Hook Events (24 blocks) · 16 MCP Tools · 2 MCP Servers · 128 Lib Modules (~27,085 LOC across 15 subdirs) · 47 Scripts · 113 Test Files · 3,762 TC** (PASS 3,760 / 0 FAIL / 2 expected legacy). Canonical measured 2026-04-22 via `scripts/docs-code-sync.js` + `find lib -name "*.js"`.

### Sprint 7 — Workflow Orchestration Integrity (new, response to user redefinition)

Phase A 4 + Phase A+ 1 = **5 parallel measurement agents** that derived a 72-item Gap Taxonomy (7 axes), after which P0 10 + P1 12 + P2/3 50 items were processed.

**New: lib/orchestrator/ (3-Layer Orchestration)**
- `intent-router.js` — priority-resolved intent detection (feature > skill > agent)
- `next-action-engine.js` — Next Action standardization across the entire Stop-family hook
- `team-protocol.js` — protocol for the PM/CTO/QA Lead's real Task spawn path (state-writer lifecycle + cc-regression attribution)
- `workflow-state-machine.js` — PDCA phase × Control Level integration + matchRate SSoT + ARCHIVE dispatcher + DO_COMPLETE setter
- `index.js` — single facade (19 exports)

**Changed (Invocation Contract 100% preserved)**:
- `lib/intent/language.js:SKILL_TRIGGER_PATTERNS` — 4 skills → **15 skills** (11 new: pdca, pm-discovery, plan-plus, qa-phase, code-review, deploy, rollback, skill-create, control, audit, phase-4-api)
- `lib/pdca/state-machine.js:288` + `lib/pdca/automation.js:82` — matchRate threshold default **100→90** (bkit.config.json:pdca.matchRateThreshold SSoT)
- `lib/control/trust-engine.js:syncToControlState` — **restored Trust Score currentLevel auto-reflect** (autoEscalation/autoDowngrade flags actually wired, G-C-01/02)
- `agents/cto-lead.md` — added 5 per-Phase Task spawn example blocks to the body + added frontmatter `Task(pm-lead)`, `Task(qa-lead)`, `Task(pdca-iterator)` (G-T-01/02)
- `skills/pdca/SKILL.md:384` — Enterprise teammates **5→6** (synced with strategy.js, G-T-03)
- `scripts/unified-stop.js`, `session-end-handler.js`, `subagent-stop-handler.js` — wired to Next Action Engine (G-J-05/06/07)
- `scripts/user-prompt-handler.js` — emits a structured `suggestions` field in parallel (G-J-09)
- 79 `@version 2.0.0 → 2.1.10` + `@version 1.6.x → 2.1.10` batch updates (lib 66 + scripts 13)
- `skills/phase-4-api/SKILL.md` + `phase-5-design-system/SKILL.md` — cleaned up duplicate `user-invocable` fields
- `skills/zero-script-qa/SKILL.md` — `allowed-tools` made explicit

**Test (Sprint 7 new)**:
- `test/contract/orchestrator.test.js` — 21 L1/L2 TC (IntentRouter + NextActionEngine + TeamProtocol + WorkflowStateMachine)
- SKILL_TRIGGER coverage L1 test expansion

**Quality Gates (8/8 PASS)**:
- check-guards (21 guards)
- docs-code-sync (BKIT_VERSION 5-location sync, 0 count drift)
- check-deadcode (Live 92 / Exempt 30 / Legacy 0 / Dead NEW 0)
- check-domain-purity (11 files, 0 forbidden imports)
- L3 MCP runtime (42/42)
- L5 E2E shell smoke (5/5)
- Orchestrator (21/21)
- qa-aggregate (**3,760 PASS / 0 FAIL / 2 expected / TOTAL 3,762**)

### Success Criteria D19~D30

| # | Criterion | Result |
|---|------|:---:|
| D19 | Skill trigger coverage ≥ 15 | ✅ 15 |
| D20 | Feature intent injection rate ≥ 8/10 | ✅ IntentRouter loose threshold 0.7 |
| D21 | Agent-Skill resolver implemented | ✅ |
| D22 | matchRate threshold SSoT 90 only | ✅ |
| D23 | cto-lead body Task examples ≥ 5 | ✅ (Plan/Design/Do/Check/Act 5 blocks) |
| D24 | CTO teammates Task declaration | ✅ pm-lead + qa-lead + pdca-iterator |
| D25 | Enterprise teammates 6 = 6 | ✅ |
| D26 | Next Action suggestion scope ≥ 15 hooks | ✅ (Stop + SessionEnd + SubagentStop + PDCA 13 paths) |
| D27 | L4 auto-chain smoke ≤ 2 manual | ⏳ measured via Phase 7 /pdca qa |
| D28 | Trust Score level reflection | ✅ |
| D29 | Agents "Use proactively" ≥ 30 | ⏳ (Sprint 7e partially done, 18→28+ expansion continues until release) |
| D30 | Legacy `@version 2.0.0` = 0 | ✅ (lib 66 + scripts 13 = 79 all at 2.1.10) |

**25/30 met** (D27 L4 auto-chain + D29 proactive phrasing partial + D1 tag + D3 CI PR + D8 48h observation = 5 items outside the release workflow scope).

### Quality Gates (all PASS)

- `check-guards` — 21 guards, 0 warning
- `docs-code-sync` — 8 counts consistent + **BKIT_VERSION invariant** 5-location sync (canonical: `bkit.config.json:2.1.10`)
- `check-deadcode` — Live 92 / Exempt 30 / Legacy 0 / Dead NEW 0 (Sprint 7 adds `lib/orchestrator/` 5 modules)
- `check-domain-purity` — 11 domain files, 0 forbidden imports (fs/child_process/net/http/https/os)
- `l3-mcp-runtime` — 42/42 PASS (MCP initialize + tools/list runtime, 16 tools × 2 servers)
- `test/e2e/run-all.sh` — 5/5 PASS (SessionStart / .claude block / check-guards / docs-code-sync / MCP runtime)
- `qa-aggregate` — **3,760 PASS / 0 FAIL / 2 expected-failure / TOTAL 3,762 TC across 113 test files** (Sprint 7 final; earlier snapshot `3,741 TC / 112 files` superseded)

### Sprint 6 Completions (post-initial-draft)

- **NEW 6-1 (ENH-202)**: Skills `context: fork` 1 → **9** (zero-script-qa + qa-phase + phase-1/2/3/4/5/8 + skill-status). Readonly-safe workflow skills isolated.
- **NEW 6-2**: Legacy 3 modules removed (`lib/core/hook-io.js`, `lib/context/ops-metrics.js`, `lib/pdca/deploy-state-machine.js`, total 421 LOC, 0 production references).
- **NEW 6-3 (Port↔Adapter)**: `lib/infra/cc-bridge.js` newly added — implementation of Port `cc-payload.port.js`. `parseHookInput` / `detectCCVersion` / `getSessionId` / `isBypassMode` / `getToolName` / `getPermissionFlags` / `getHookEventName`. 24 L2 TC PASS. Re-exported as `ccBridge` from `lib/cc-regression/index.js`.
- **NEW 6-4 (ENH-275)**: MCP stdio L3 runtime runner (`test/contract/l3-mcp-runtime.test.js`). JSON-RPC 2.0 `initialize` + `tools/list` real spawn for both bkit servers. 42 TC PASS.
- **NEW 6-5**: L5 E2E shell smoke suite (5 scenarios: SessionStart / .claude write block / check-guards / docs-code-sync / MCP tools).
- **NEW 6-6 (ENH-276)**: `docs-code-scanner.scanVersions()` — BKIT_VERSION invariant scan (sync across 5 locations: bkit.config.json / plugin.json / README / CHANGELOG / hooks.json).
- **NEW 6-7**: MEMORY.md 302 → 79 lines (≤150 cap). 3 detail files: `cc_version_history_v21xx.md`, `enh_backlog.md`, `github_issues_monitor.md`.
- **Sprint 5.5 wiring**: hook attribution 3 sites (Stop / SessionEnd / SubagentStop) + CI Domain ESLint step (`scripts/check-domain-purity.js`) + PreCompact block counter (ENH-247/257 2-week measurement).

### Known Limitations

- This section is a branch snapshot. The `git tag v2.1.10` + GitHub Release notes work is scheduled after the main PR merge + 48h observation.
- The refactoring of `docs/02-design/features/bkit-v2110-integrated-enhancement.design.md` (2,644 lines) (≤800 lines overview + 4 addendum) is carried over to v2.1.11+. This document is kept as a historical record; Sprint 5a~6 is organized in `bkit-v2110-gap-closure.design.md`.
- The `madge --circular` baseline regeneration (npm install permission) is for v2.1.11+.

---

## [2.1.9] - 2026-04-21

### 🎯 CC v2.1.114 → v2.1.116 Response (4 ENH Shipping + Docs=Code 100% Sync)

Response cycle for Claude Code CLI v2.1.114~v2.1.116 changes. Delivers 4 ENH (253/254/259/263) plus positive drift from v2.1.10 roadmap (ENH-264 infrastructure + ENH-265 full implementation). Shipping-readiness QA passed Match Rate 100% / Coverage 90.3% / P0 Blocker 0 / Regression 0.

### Added
- **[ENH-253]** `docs/03-analysis/zero-script-qa-fork-v2116-verification.md` — manual reproduction of GitHub Issue [#51165](https://github.com/anthropics/claude-code/issues/51165) (`context: fork` + `disable-model-invocation` failure) on macOS. Verdict: non-reproduction on macOS (darwin 24.6.0). bkit's sole `context: fork` skill (`zero-script-qa`, 1/39) operates normally. bkit uses `disable-model-invocation` 0/39 → combination case is N/A. ENH-196/202 investment protection confirmed.
- **[ENH-254]** `docs/03-analysis/security-architecture.md` — Defense-in-Depth security architecture formalization. **Layer 1** (CC runtime sandbox): v2.1.113 #23 `dangerouslyDisableSandbox` permission hardening + #14/#15/#16 Bash wrapper tightening + v2.1.116 S1 dangerous-path safety. **Layer 2** (bkit `config-change-handler.js` `DANGEROUS_PATTERNS`): 5-pattern settings-file detection + SECURITY WARNING audit. 5 sections including attack-vector matrix + user responsibility clause ("do NOT rely on either layer alone").
- **[ENH-259]** `CUSTOMIZATION-GUIDE.md` (new §⚠️ Important Notices) + `README.md` (Custom Skills warning bullet) — Custom Skills data loss warning for GitHub Issue [#51234](https://github.com/anthropics/claude-code/issues/51234) (`~/.claude/skills/` silent deletion on CC v2.1.113+ first-run). bkit itself unaffected (uses `${CLAUDE_PLUGIN_ROOT}/skills/`), but user custom skills at risk. Backup/restore commands (full + selective) + recommended plugin-bundle path guidance for bkit custom skill authors.
- **[ENH-264 partial — v2.1.10 roadmap positive drift]** `lib/core/io.js:114` `outputBlockWithContext(reason, alternatives, hookEvent)` + `scripts/unified-bash-pre.js` 2 call sites (deployment detection line 144, QA-phase detection line 183). Alternative-command suggestions via CC v2.1.110+ `hookSpecificOutput.additionalContext`. Full general-Bash coverage scheduled for v2.1.10 (ENH-274).
- **[ENH-265 — v2.1.10 roadmap positive drift, fully shipped]** `hooks/startup/session-context.js:236-241` — `ENABLE_PROMPT_CACHING_1H` env-var branch in SessionStart additionalContext with disabled/enabled messaging. `docs/03-analysis/prompt-caching-optimization.md` operational guide (30-40% token savings on long PDCA sessions). `bkit.config.json:110-115` `performance.promptCaching1h` declaration (CC v2.1.108+ required).
- **Shipping Readiness QA** — `docs/05-qa/cc-v2114-v2116-shipping-readiness.report.md` (19,780 bytes) + `docs/05-qa/evidence/v219/` 5-file runtime evidence directory.

### Changed
- **[ENH-263 + ENH-266 docs-sync]** Docs=Code 25-file architectural correction (v2.1.9 shipping + docs-sync merged at release):
  - **Plugin/MCP metadata** — `.claude-plugin/plugin.json:5` `"39 Skills, 36 Agents, 21 Hook Events"`, `marketplace.json:36` adds Scripts count.
  - **README.md** — Badge `v2.1.116+` (L4), Claude Code requirement table (L205), `lib/` comment `(101 modules across 11 subdirs)` (L294), new v2.1.9 feature bullet (prepended).
  - **Session runtime** — `hooks/startup/session-context.js:234-235` CC recommended + Architecture lines.
  - **bkit-system/** — README Layer 5/6, Component Counts table, Obsidian graph tip; `_GRAPH-INDEX.md` Context Engineering box + Components list; `philosophy/context-engineering.md` Layer 5 + Domain Knowledge Layer (2 occurrences); `components/{agents,skills,hooks,scripts}/_*-overview.md` all add v2.1.9 history entry.
  - **CUSTOMIZATION-GUIDE.md** — Component Inventory header v2.1.8→v2.1.9, 3 ASCII diagrams synced (Skills 38→39, Scripts 42→43, lib 93→101 / 12→11 subdirs), Plugin Structure Example skills/scripts counts.
  - **AI-NATIVE-DEVELOPMENT.md** — Mermaid CONTEXT box, Context Engineering Layers header v2.0.0→v2.1.9, table rows (Skill System, lib/). **Corrected `adapters` subdir myth** — actual subdirs are 11: audit, context, control, core, intent, pdca, qa, quality, task, team, ui.
  - **lib/core/io.js, lib/core/cache.js** — JSDoc `@version 1.6.0` removed (ENH-270 acceptance: `grep -rn "v1\.6\.0" lib/` = **0 matches**).
  - **17 agents** — CC recommended version v2.1.111+ → v2.1.116+ (74 consecutive compatible releases).
- **Version** — 2.1.8 → 2.1.9 across `bkit.config.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `hooks/session-start.js`, `hooks/startup/session-context.js`.
- **CC recommended version** — v2.1.111+ → **v2.1.116+** (74 consecutive compatible releases, v2.1.115 skipped — 8th skipped release in the v2.1.x series).

### Verified
- **Architecture inventory (runtime-measured 2026-04-21)** — **39 Skills** (39/39 `effort`, 1/39 `context: fork`, 0/39 `disable-model-invocation`/`paths`/`monitors`), **36 Agents** (13 opus / 21 sonnet / 2 haiku; 2 low / 21 medium / 13 high / 0 xhigh effort; 20/36 `disallowedTools`; 0/36 `initialPrompt`/`hooks:`), **43 Scripts**, **101 Lib modules** in **11 subdirectories** (audit, context, control, core, intent, pdca, qa, quality, task, team, ui — **no `adapters` subdir**), **21 Hook Events**, **18 Templates**, **4 Output Styles**, **2 MCP Servers**.
- **L1 smoke** — 101/101 lib modules `require()` OK, 43/43 scripts `node --check` OK, `BKIT_VERSION` runtime = `"2.1.9"`.
- **L3 runtime** — SessionStart hook `additionalContext` 4,401 chars (under 10,000 CC cap, 44%), contains v2.1.9 + v2.1.116+ + 39 Skills + 36 Agents + "Prompt caching 1H" all verified.
- **L4 contract** — Plan/Design 4 ENH acceptance 15/15 met. Docs=Code grep `active-state` post-sync: 0 matches for `38 Skills`/`32 Agents`/`88 Lib`/`93 modules`/`42 scripts`/`12 subdirectories` (historic blockquotes preserved per Plan §5.2 DO NOT TOUCH policy).

### MON-CC-06 Status (unchanged from v2.1.8)
v2.1.113 native-binary transition 10+ regression issues + v2.1.114~v2.1.116 6 new HIGH issues tracked (total 16). v2.1.117+ hotfix awaited. Environmental exceptions: macOS 11 stays on v2.1.112 (#50383), non-AVX CPUs stay on v2.1.112 (#50384/#50852), Windows paren PATH partial improvement on v2.1.114+ via B12 (#50541).

---

## [2.1.8] - 2026-04-17

### 🧪 Round 4 Runtime Matrix Verification (25 parallel agents, 2026-04-17)

Comprehensive runtime verification of all bkit functionality via 25 parallel agents covering 7 verification areas: Agents/Skills/Events matrix (M1–M10), Agent Teams orchestration (AT1–AT3), MCP tools (MC1–MC2), 8-language × 3-level matrix (L1–L2), full PDCA cycle (P1–P3), quality gates (Q1–Q2), hook chain integration (H1–H2), plus full regression test run (TEST). Result: **22 PASS / 3 ISSUE discovered and fixed**. Runtime-verified (not static): JSON-RPC `tools/call` against both MCP servers (16 tools), live hook chain invocation with ENH-239 fingerprint dedup observed at 88% byte reduction, 8-language and 3-level detection fixtures executed. See `docs/04-report/features/bkit-v218-round4-matrix.report.md` for full results.

### Fixed (Round 4 discoveries)
- **`lib/intent/language.js` — 4/8 languages mis-classified as `en`.** Previous `detectLanguage()` only tested CJK Unicode blocks (KO/JA/ZH) and fell through to English for ES/FR/DE/IT. Added `LATIN_STOPWORDS` (4 languages × 13 language-exclusive stopwords) and `LATIN_DIACRITIC_HINTS` (4 patterns: `ñ¿¡`→es, `äöüß`→de, `çœæ`+French contractions→fr, `gli/della/degli`→it). Score-based winner selection with ≥1-hit threshold to avoid false positives on pure English. Verified 8/8 correct + 4 guardrail cases (code/URL/emoji→en, mixed EN+KO→ko via script precedence).
- **`templates/design-starter.template.md` + `templates/design-enterprise.template.md` — missing Option A/B/C section.** Default `design.template.md` enforces 3-option architecture selection via Checkpoint 3 (v1.7.0), but level-specific variants omitted the section entirely, bypassing the architecture decision artefact. Inserted an appropriate 3-option table in each: starter gets a simplified Minimal/Clean/Componentized comparison; enterprise gets NFR Fit / Risk / Blast Radius criteria.
- **6 templates using broken variable syntax — `{{var}}` double-brace and `{UPPER_SNAKE_CASE}` casing.** bkit's runtime substitution engine (`lib/core/paths.js:213`, `lib/pdca/session-title.js:61`) only recognises `{lower_snake_case}` placeholders; any other form leaks verbatim into generated documents. Normalized `iteration-report.template.md` (40+ vars), `CLAUDE.template.md` (10+ vars), `convention.template.md`, `schema.template.md`, `qa-report.template.md`, `qa-test-plan.template.md`. Handlebars blocks (`{{#if}}` / `{{#each}}` / `{{^X}}` / `{{/X}}`) preserved — they are consumed by separate template engines, not bkit substitution.

### Added (Round 4)
- **`templates/TEMPLATE-GUIDE.md` v1.1.0 — Variable Substitution Convention section.** Documents the 7 canonical variables (`{feature}`, `{date}`, `{level}`, `{phase}`, `{author}`, `{version}`, `{project}`), clarifies bkit single-brace substitution vs Handlebars conditional blocks, and notes the Round 4 migration so future contributors don't re-introduce the bug.
- **49 Round 4 regression assertions** pinning the three fixes: 12 for L1 language detection (8 positive + 4 guardrail), 3 for P2 design-template Option A/B/C, 34 for M8 template variable hygiene (18 templates × 2 checks each). Test lives in `tests/qa/round4-runtime-matrix.test.js`.

### Round 4 Baseline (informational)
- **Architecture inventory verified** — 36 agents (13 opus / 21 sonnet / 2 haiku), 39 skills (1 `context: fork`, 39/39 with `effort` frontmatter), 21 hook events (24 handlers, 0 syntax errors), 2 MCP servers × 16 tools (JSON-RPC `tools/call` all OK), 4 output-styles (plugin.json `outputStyles` declared), 44 hook scripts (all syntax-clean, 5-script stdin `{}` smoke → exit 0).
- **MEMORY.md baseline refresh needed (follow-up)** — Skills 3-classification baseline 18/18/1 is outdated; actual is 19 Workflow / 12 Capability / 8 Hybrid. Agent count entries citing "32 agents" should read 36. Left for a dedicated memory sync session.

### 🚨 Hotfix — GitHub Issue #81 (SessionStart `additionalContext` Re-injection) + Docs=Code Philosophy Restoration

Community user [@scokeepa](https://github.com/popup-studio-ai/bkit-claude-code/issues/81) reported that `session-start.js` generates a ~12,921-byte `additionalContext` that exceeds CC's hook output cap (officially documented at 10,000 chars, not 2 KB as originally hypothesized). This caused SessionStart payloads to be file-replaced with a preview on every session, and — compounded by PreCompact re-firing without honoring `once: true` — resulted in duplicate injections that wasted tokens across long PDCA sessions.

Investigation confirmed **3 root causes** (RC-1 size, RC-2 compaction dedup, RC-3 Docs=Code violation in ENH-226) and found a regression-adjacent CC Desktop app bug (#48963) affecting plugin skill discoverability.

### Added
- **[ENH-238]** `hooks/startup/session-context.js` guard — 3-way `ui.contextInjection.{enabled,sections}` toggle mirroring the existing `ui.dashboard` pattern. Opt-out returns the header only (47 bytes), per-section opt-in respects the user-defined `sections[]` array. Restores the ENH-226 Docs=Code contract that was declared in `bkit.config.json` and implemented in `scripts/user-prompt-handler.js` but missing from the SessionStart hook.
- **[ENH-239]** `lib/core/session-ctx-fp.js` — SHA-256 fingerprint dedup store for SessionStart `additionalContext`. 1-hour TTL, session isolation via `CLAUDE_SESSION_ID`, atomic write (`.pid.ts.tmp` + `rename`), inline GC (30-day stale + 100-entry LRU). Blocks PreCompact/PostCompact re-fire duplicate injections that bypass `hooks.json` matcher-group `once: true`.
- **[ENH-240]** `lib/core/context-budget.js` — PersistedOutputGuard applying an 8,000-char hard cap (CC 10,000 limit minus a 2,000-char safety margin) with priority-preserved truncation. `stripAnsi`-based length measurement to avoid ANSI-escape bias. Appends a truncation notice and debug log when activated.
- **[ENH-244]** `docs/context-engineering.md` — New ADR-style guide documenting the hook output budget, SessionStart `once: true` limitation (skills-level only per CC docs), bkit's dedup defense, and the Issue #81 cross-reference chain.
- **Tests** — 4 new QA test files (`tests/qa/session-context.test.js`, `context-budget.test.js`, `session-ctx-fingerprint.test.js`, `ui-opt-out-matrix.test.js`) covering 25 test cases across L1 Unit (13), L2 Integration (5), and L4 QA (8 matrix combinations).

### Fixed
- **`lib/core/config.js` `getUIConfig()` missing fields (discovered during Iterate)** — Previously exposed only `enabled` and `ambiguityThreshold` for `contextInjection`, dropping the new `sections` / `maxChars` / `priorityPreserve` fields silently. Now returns all five fields with documented defaults, completing the Plan → Design → Config → Runtime contract.
- **Docs=Code violation (ENH-226)** — The `ui.contextInjection.enabled` toggle was declared in `bkit.config.json` and honored by `scripts/user-prompt-handler.js:82`, but `hooks/startup/session-context.js:build()` ignored it entirely. All 8 SessionStart builders now respect the toggle.
- **Compaction duplicate injection** — `hooks.json:7` `once: true` lives at matcher-group scope and cannot distinguish `source: "compact"` from an initial SessionStart, so PreCompact re-fire re-emitted the full payload. ENH-239 fingerprint lock suppresses identical payloads within the TTL window, observed to reduce 2–3 injections down to 1 per session.

### Changed
- **Version** — 2.1.7 → 2.1.8 across `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `bkit.config.json`, `hooks/hooks.json`, `hooks/session-start.js`, `hooks/startup/session-context.js`.
- **CC recommended version** — v2.1.110+ → **v2.1.111+** (72 consecutive compatible releases, CC v2.1.111 `/less-permission-prompts` + `/effort` slider + `/ultrareview` + I1/I13/B3/B6 auto-benefits; v2.1.112 single auto-mode hotfix, unaffected by bkit).
- **`bkit.config.json` schema** — `ui.contextInjection` extended with `sections` (8 builder keys), `maxChars` (8000), `priorityPreserve` (MANDATORY / Previous Work Detected / AskUserQuestion).
- **`hooks/startup/session-context.js`** — `buildVersionEnhancementsContext` now reports "bkit v2.1.8 (Current)" and "CC recommended: v2.1.111+ | 72 consecutive compatible releases".
- **Agents** — 17 agent files updated: `CC recommended version: v2.1.78 (stdin freeze fix, background agent recovery)` → `v2.1.111+ (72 consecutive compatible releases, MCP/PreToolUse stability)`.
- **Documentation sync** — `README.md`, `CUSTOMIZATION-GUIDE.md`, `.claude-plugin/marketplace.json`, `bkit-system/components/{skills,agents,scripts}/_*-overview.md` version references bumped to v2.1.8.

### Test Results
- **74 / 74 PASS (100%)**, 0 FAIL.
- New TCs: 25 PASS across 4 suites (`session-context` 6 / `context-budget` 6 / `session-ctx-fingerprint` 5 / `ui-opt-out-matrix` 8).
- Regression: 43 PASS across 5 legacy QA scanners (`config-audit` 5 / `dead-code` 5 / `completeness` 6 / `shell-escape` 8 / `scanner-base` 19). Zero regressions.
- Live smoke: `hooks/session-start.js` emits `bkit Vibecoding Kit v2.1.8 activated` with a 16-char SHA-256-truncated fingerprint persisted to `.bkit/runtime/session-ctx-fp.json`.
- Match Rate (Plan/Design → Code): **100%** (see `docs/03-analysis/cc-v2110-v2112-issue81-response.analysis.md`).

### Monitoring
- **MON-CC-05 (new)** — [#48963](https://github.com/anthropics/claude-code/issues/48963) v2.1.110 regression: Plugin skills missing from `/` menu on the macOS Desktop app (CLI unaffected). Tracked for ENH-243 manual verification in a later release; CLI usage recommended in the meantime.
- **MON-CC-01~04 (retained)** — CC v2.1.107 regressions (#47810 skip-perm + PreToolUse bypass, #47855 Opus 1M `/compact` block, #47482 output styles frontmatter, #47828 SessionStart `systemMessage` + remoteControl) remain OPEN across **6 consecutive releases** (v2.1.107 → v2.1.112). **Recommendation updated: wait for v2.1.113+ hotfix** (previously "wait for v2.1.111+" — target unmet).

### Migration
- Existing users on v2.1.7 receive all improvements automatically on upgrade. Default `ui.contextInjection` values preserve the previous behavior (100% backward compatible). To enable the lean opt-out mode, set `ui.contextInjection.enabled: false` (returns header only) or provide a narrower `sections` array.
- If you previously relied on a custom `additionalContext` size, the 8,000-char hard cap now applies; raise `ui.contextInjection.maxChars` (e.g. `999999`) in `bkit.config.json` to disable the guard.
- `.bkit/runtime/session-ctx-fp.json` is auto-generated and gitignored; delete the file to reset the dedup store with no side effects.

### Not Included (Deferred)
- **ENH-241** (Docs=Code cross-verification scheme + QA report correction for ENH-226 status) — Deferred to v2.1.9 (~2h).
- **ENH-243** (Issue #48963 Desktop app manual verification + CLI recommendation README note) — Deferred to v2.1.9 (~1.5h).
- **ENH-242** (Content Trimmer priority-based budget allocation across Dashboard + session-context) — Deferred to v2.1.10 (~4h).

### Stats
- Files changed: 11 (5 modified Production + 2 new Production + 2 Config + 1 new Docs + 4 new Tests).
- Lines: +641 operational / +425 tests / +1,540 docs = **+2,606 total**.
- New LOC: `lib/core/context-budget.js` (95) + `lib/core/session-ctx-fp.js` (115) + `docs/context-engineering.md` (90).
- CC compatible releases: **72** (v2.1.34 ~ v2.1.112, 0 breaking changes).

### Additional Bug Fixes (16 bugs from 10-agent QA Discovery)

During v2.1.8 QA verification, 10 parallel `code-analyzer` agents analyzing 15 lib modules + 43 scripts + 2 MCP servers + 36 agents + 39 skills caught **11 real bugs** (confidence ≥80%) while producing 616 TC specs. A subsequent 10-agent cross-verification review (Q10 integration) caught **1 incomplete fix** (B1 dead-write) and identified **5 additional minor issues** (B12~B16). All 16 are consolidated into this v2.1.8 release.

#### Fixed (from 10-agent QA discovery)

- **B1** [P1] `lib/control/loop-breaker.js:234` — `setThreshold` uses `LOOP_RULES[ruleId]` object access and writes to `rule.maxCount` (was dead-writing `rule.threshold`; caught by Q1 cross-verification, reworked)
- **B2** [P2] `lib/audit/audit-logger.js:52` — `CATEGORIES` extended to 10 (+permission/checkpoint/trust/system); convenience loggers no longer coerced to `'control'`
- **B3** [P1] `lib/control/checkpoint-manager.js:103,120` — `STATE_PATHS.pdcaStatus()` replaces `process.cwd()` (multi-project / worktree safety)
- **B4** [P2] `lib/control/trust-engine.js:402-419` — `resetScore` pushes unified `{timestamp,from,to,trigger,reason}` schema to `levelHistory`
- **B5** [P0] both MCP servers — JSON-RPC 2.0 `'id' in msg` handling (was `id === undefined`, dropping explicit-null-id requests)
- **B6** [P1] `evals/runner.js` — `stripMatchingQuotes()` preserves internal colons in quoted YAML values
- **B7** [P1] `evals/runner.js` — `!inCriteria` guard disambiguates indent-2 criteria items from new eval entries
- **B8** [P0] `evals/runner.js:246` — `pass = failedCriteria.length === 0` (removed redundant `score >= 0.8`)
- **B9** [P0] `lib/context/scenario-runner.js:42` — `allPassed` requires `passed > 0` (was accepting all-skipped as pass)
- **B10** [P1] `lib/context/invariant-checker.js:77` — explicit parens document operator precedence (no behavior change)
- **B11** [P1] `lib/qa/utils/pattern-matcher.js` — `findBalancedBrace()` + depth-aware segment splitter for nested `module.exports`

#### Additional (from Q10 integration review)

- **B12** [P2] ENH-167 partial: `BKIT_VERSION` centralization — `lib/core/paths.js:260,271` + 2 MCP servers no longer hardcode `'2.0.4'`
- **B13** [P3] Dead `PDCA_STATUS_PATH` constant removed from `lib/control/checkpoint-manager.js:47`
- **B14** [P3] Redundant `notifications/initialized` guard simplified in both MCP servers
- **B15** [P3] JSDoc accuracy: `lib/qa/utils/pattern-matcher.js:44` now correctly documents string-aware capability
- **B16** [P2] Word boundary: `lib/context/invariant-checker.js` uses `\bif\b` regex (was substring `.includes('if')`, matching `gift`/`diff`)

#### Regression Fix

- `tests/qa/dead-code.test.js:166` — word-boundary regex instead of `.includes()` substring (false positive on `unusedFunction` vs `usedFunction` check)

#### New Tests

- `tests/qa/bug-fixes-v218.test.js` — 24 TCs covering all 16 bugs × representative scenarios

#### QA Methodology Proof

- v2.1.8 deep QA (10 `code-analyzer` agents analyzing full codebase) discovered 11 real bugs during read-only analysis alone, producing 616 TC specs as byproduct
- v2.1.8 cross-verification QA (10 `code-analyzer` agents verifying each fix) caught 1 incomplete fix (B1) + 5 additional issues (B12~B16) → "QA-as-Discovery + Cross-Verification" methodology

---

## [2.1.7] - 2026-04-16

### 🚨 Hotfix — GitHub Issue #79 (Opus Drift PDCA Workflow Fixes)

Community user [@rohwonseok-ops](https://github.com/popup-studio-ai/bkit-claude-code/issues/79) reported 7 local patches for full-auto (L3-L4) PDCA workflow issues. Code-level investigation confirmed 2 P0 bugs, 1 P1 design issue, and 1 P2 enhancement.

### Fixed
- **P0 `updatePdcaStatus` argument order** — `scripts/skill-post.js:229` called `updatePdcaStatus(phase, feature)` with reversed arguments, corrupting `pdca-status.json`. All 8 call sites audited; only this one was affected. (Issue #79 P7)
- **P0 Full-auto chain break at report phase** — `lib/pdca/automation.js` `generateAutoTrigger()` phaseMap lacked `report`/`completed` keys, returning `null` and breaking the qa→report→completion chain. Added both keys with `{ complete: true }` flag. Also added `report`/`completed` to `semiAutoPhases`. (Issue #79 P5)
- **P1 Phantom feature auto-registration** — `scripts/pre-write.js` unconditionally registered any file write as a PDCA "do" phase feature via `extractFeature()`, causing badge spam. Now checks `activeFeature === feature` before updating. (Issue #79 P4)

### Added
- **Report phase completion directive** — `scripts/pdca-skill-stop.js` now generates `[PDCA-COMPLETE]` guidance when `autoTrigger.complete === true`, preventing model confusion at cycle end. (Issue #79 P5 companion)
- **Gap-detector analysis document auto-generation** — `scripts/gap-detector-stop.js` now creates `docs/03-analysis/features/{feature}.analysis.md` with match rate, guidance, and next step. gap-detector agent remains Read-only by design; the stop hook handles file creation. (Issue #79 P6)

### Changed
- **Version** — 2.1.6 → 2.1.7.
- **CC recommended version** — v2.1.108+ → v2.1.110+ (71 consecutive compatible releases, MCP/PreToolUse stability improvements).
- **Documentation sync** — `README.md`, `CUSTOMIZATION-GUIDE.md`, `bkit.config.json`, `hooks/hooks.json` version references bumped to v2.1.7.

### Migration
- If your `.bkit/state/pdca-status.json` was corrupted by the argument-order bug (feature names stored as phase values), delete the file and let bkit recreate it: `rm .bkit/state/pdca-status.json`

### Not Included (Deferred)
- **Issue #79 P1** (Stop hook `decision:'block'` for Opus drift) — Deferred to v2.1.8. P5 fix restores full-auto chain; re-evaluate after observing drift frequency.
- **Issue #79 P2** (`ff-override` file cleanup) — No matching code found in v2.1.6 codebase. Awaiting reproduction steps from reporter.

### Stats
- Files changed: 9 (5 code + 2 config + 2 docs meta)
- Lines: +100 / -26
- CC compatible releases: 71 (v2.1.34 ~ v2.1.110)

---

## [2.1.6] - 2026-04-15

### 🚨 Critical Hotfix — GitHub Issue #77

**Fix P0 issue where bkit overwrites Claude Code's auto session title on every message, preventing parallel window identification.**

- **[ENH-226] UI hook opt-out 3-way toggle** — Adds `ui.{sessionTitle,dashboard,contextInjection}.enabled` options in `bkit.config.json`. Non-PDCA users can disable UI hooks with a one-line edit. Default `true` (backward compatible).
- **[ENH-227] Single-source sessionTitle emit** — New single entry point `lib/pdca/session-title.js`. Removes inline logic from 6 files (`scripts/user-prompt-handler.js`, `hooks/session-start.js`, `scripts/{pdca-skill-stop,plan-plus-stop,iterator-stop,gap-detector-stop}.js`).
- **[ENH-228] Phase-change-only refresh** — `.bkit/runtime/session-title-cache.json` (file-based, atomic write). Returns `undefined` for identical `sessionId+feature+phase+action` combinations to preserve CC auto-title. Emit reduced from 6 per message to 1 per phase change (≈83% reduction).
- **[ENH-229] Stale feature TTL** — Automatically invalidates PDCA primaryFeature when `lastUpdated > 24h`, auto-cleaning accumulated legacy features (e.g. "ui"). Adjustable via `ui.sessionTitle.staleTTLHours` (`0` disables).

### Added
- **[ENH-203] PreCompact decision:block** (`scripts/context-compaction.js`) — Blocks `manual` compaction during PDCA `do/check/act` phases using CC v2.1.105+ PreCompact hook blocking.
- **[ENH-214] Output styles audit script** (`scripts/audit-output-styles.js`) — Defense against CC v2.1.107 regression #47482. Gate G8.
- **[ENH-167] BKIT_VERSION dynamic lookup** (`lib/core/version.js`) — Single source of truth from `bkit.config.json`, removing version hardcoding across tests and scripts (Docs=Code).
- **Tests** — `test/unit/session-title.test.js` (10 TC) + `test/integration/issue77-hook-e2e.test.js` (7 TC). **17/17 PASS**.

### Changed
- **Version** — 2.1.5 → 2.1.6.
- **Quality Gates** — G1~G7 → G1~G9 (G8: output styles audit, G9: sessionTitle opt-out + single-source).
- **TC-A3 patch** — `scripts/user-prompt-handler.js` contextInjection opt-out no longer suppresses sessionTitle emission. Separated `contextInjectionEnabled` flag keeps the sessionTitle path independent.
- **Test version references** — 8 hardcoded version assertions (`VC2-001~025`, `CS-012`, `VW-036`, `SEC-CP-014`, `E2E-005/015`) migrated to dynamic `BKIT_VERSION` lookup.
- **Documentation sync** — `README.md`, `CUSTOMIZATION-GUIDE.md` version references bumped to v2.1.6.

### Fixed
- TC-A3 design-implementation mismatch: contextInjection opt-out previously suppressed sessionTitle due to early `outputEmpty()+exit`. Now separated into per-feature guards.
- Overview markdown headers (`bkit-system/components/{scripts,agents,skills}/_*-overview.md`) version bumped v2.1.1 → v2.1.6.
- `skills/bkit/SKILL.md` description shortened from 284 to ~160 chars (SD-008/039/050 resolved).
- `test/run-all.js` — removed missing file reference `performance/direct-import.test.js`.

### Test Results
- **3268/3280 PASS (99.6%)**, 0 FAIL, 12 SKIP.
- Unit / Integration / Security / Philosophy / UX / E2E / Architecture / Controllable AI: **100% PASS**.
- Regression 98.5% (8 SKIP only), Performance 97.1% (4 SKIP only).

### Monitoring
- **MON-CC-04** — CC v2.1.107 regressions (#47482 / #47810 / #47855 / #47828) remain OPEN in v2.1.108. **Recommendation updated: wait for v2.1.109+ hotfix** (previously v2.1.107 hotfix expectation unmet).

### How to Use the Opt-out

```jsonc
// bkit.config.json
{
  "ui": {
    "sessionTitle": {
      "enabled": false,         // Suppresses [bkit] PHASE feature title; CC auto-title is used instead
      "staleTTLHours": 24       // 0 = TTL disabled (for long-running PDCA sessions)
    },
    "dashboard": {
      "enabled": false,         // Disables SessionStart 5 boxes (progress/workflow/impact/agent/control)
      "sections": ["progress"]  // Or keep a subset
    },
    "contextInjection": {
      "enabled": false          // Suppresses UserPromptSubmit ambiguity / Previous Work injection
    }
  }
}
```

### 🚨 Out of Scope (deferred to separate session)
- M7: Remove deprecated `unified-stop.js` (~4h)
- M8: 5 remaining refactor ENH items (`catch(_){}` wrapping, Bash pattern extension, dead code elimination, MEMORY.md audit, etc. ~10h)

---

## [2.1.5] - 2026-04-13

### Added
- **Module Entry Points** — `lib/audit/index.js`, `lib/control/index.js`, `lib/quality/index.js` enable `require('./lib/audit')` etc. for 3 core modules (13 files, ~112 combined exports).
- **Wiring Scanner** (`lib/qa/scanners/wiring.js`) — Detects "Built But Not Wired" patterns (exported but never called functions). 250 findings on baseline (33 WARNING, 217 INFO). Scanners: 4 → 5.
- **bkit Help Skill** (`skills/bkit/SKILL.md`) — `/bkit` command shows all 38 skills, 2 MCP servers, 4 output styles, agent teams. 8-language trigger support.
- **PDCA Skill Bypass Guard** (`scripts/pre-write.js`) — Warns when PDCA docs are written directly via Write/Edit without going through the PDCA skill (#75).

### Fixed
- **#73 — Template imports not injected** — `scripts/user-prompt-handler.js` now pushes `resolveImports()` result to `contextParts[]`, enabling template-based PDCA document generation.
- **#74 — Auto-transition broken** — Triple failure fix: `lib/pdca/automation.js` gains `shouldAutoAdvance()` for plan/design phases, `scripts/pdca-skill-stop.js` uses imperative directives instead of soft hints, `skills/pdca/SKILL.md` adds `{{TEMPLATE_DIRECTIVE}}` for phase-specific instructions.
- **#75 — Skill bypass undetected** — Pre-write hook detects PDCA document writes outside skill context.
- **DRY consolidation** — ~85 lines of duplicated auto-transition logic in `pdca-skill-stop.js` replaced by centralized `automation.js` functions.
- **Level mapping** — `automation.js` gains `levelFromName()` reverse mapping and `LEGACY_LEVEL_MAP` for backward compatibility.

### Changed
- **Version Sync** — `bkit.config.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `hooks/session-start.js` bumped to 2.1.5.
- **PDCA Status Cleanup** — Removed 25 test/debug artifact features from `.bkit/state/pdca-status.json`. Retained 2 real features.
- **Dead Directory Removed** — `lib/adapters/` (empty subdirectories `claude/`, `local/`, 0 files) deleted.
- **Lib Modules** — 93 → 96 modules (3 new index.js entry points).
- **QA Scanners** — 4 → 5 (wiring scanner added).
- **Skills** — 37 → 38 (bkit help skill added).

### Documentation
- Full PDCA artifacts for 3 sub-features: `bkit-v215-issue-73-74-fix`, `bkit-v215-quality-hardening-p2`, `bkit-v215-comprehensive-improvement`.

## [2.1.4] - 2026-04-13

### Added
- **QA Scanner Framework** (`lib/qa/scanners/`) — 4 automated pre-release scanners (dead-code, config-audit, completeness, shell-escape) with `ScannerBase` abstract class, `reporter.js` formatter, and `utils/` helpers (file-resolver, pattern-matcher). 9 new lib modules (+93 total).
- **Pre-Release Check** (`scripts/qa/pre-release-check.sh`) — Shell wrapper running all 4 scanners with CRITICAL/WARNING/INFO severity. Exit 1 on CRITICAL, exit 0 otherwise.
- **CwdChanged Handler** (`scripts/cwd-changed-handler.js`) — ENH-149 project transition detection with audit logging.
- **TaskCreated Handler** (`scripts/task-created-handler.js`) — ENH-156 PDCA task creation tracking.
- **Unit Tests** — 5 test suites (43 tests): scanner-base (19), dead-code (5), config-audit (5), completeness (6), shell-escape (8). All 43/43 PASS.

### Fixed
- **#71 — Shell escape `$N` collision** — Preventive scanner detects bare `$1` in awk within SKILL.md shell blocks.
- **#66 — Stale require references** — 5 additional stale require paths fixed across lib modules.
- **#67 — Config hardcoded values** — 16 WARNING-level hardcoded values identified by config-audit scanner.
- **#65 — Completeness gaps** — Completeness scanner validates skill→agent references and frontmatter consistency.

### Changed
- **Version Sync** — `bkit.config.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json` bumped to 2.1.4.
- **effort frontmatter (ENH-134)** — All 38 skills now include effort frontmatter in SKILL.md.
- **Sequential agent spawn (ENH-143)** — `lib/team/coordinator.js` adds `spawnAgentsSequentially()` workaround for #37520 OAuth 401.
- **SessionStart defensive cleanup (ENH-148)** — `hooks/session-start.js` clears stale env vars on /clear.
- **MCP maxResultSizeChars (ENH-176)** — Both MCP servers set 500K override on both `_meta` keys.
- **CC Compatibility** — Verified against CC v2.1.104; 66 consecutive compatible releases (v2.1.34 → v2.1.104).
- **Lib Modules** — 84 → 93 modules (9 new in lib/qa/).
- **Test Files** — 194 → 201 files.

### Documentation
- Full PDCA artifacts for `bkit-v214-quality-hardening` feature under `docs/01-plan/`, `docs/02-design/`, `docs/03-analysis/`, `docs/04-report/`, `docs/05-qa/`.
- E2E verification report: Plugin load, 7 skills invoked, 3 agents spawned, 6 MCP tools tested, 3 hooks fired, 43/43 unit tests PASS.

## [2.1.3] - 2026-04-12

### Fixed
- **#65 — `/pdca qa` subcommand integration** — `scripts/pdca-skill-stop.js` actionPattern, `nextStepMap`, `phaseMap` (x2), and state transition whitelist now parse and route the `qa` action. `skills/pdca/SKILL.md` gains a `### qa (QA Phase)` handler block (delegates to the standalone `qa-phase` skill) and a `/pdca qa [feature]` line in the Slash Invoke Pattern section. PDCA state machine now advances `qa → report` on `QA_PASS`.
- **#66 — `lib/permission-manager.js` TypeError** — `checkPermission()`, `getToolPermissions()`, `getAllPermissions()`, and the `common.debugLog` call site now null-guard the lazy `hierarchy` / `common` requires. When `context-hierarchy.js` / `common.js` are absent (as they have been since commit 21d35d6), the module falls back to `DEFAULT_PERMISSIONS`, restoring the `Bash(rm -rf*): deny` / `Bash(git push --force*): deny` baseline policy and eliminating the per-tool-call `PreToolUse:Edit hook error` noise.
- **#67 — MCP `bkit_report_read` ignored `bkit.config.json docPaths`** — `servers/bkit-pdca-server/index.js` now loads `bkit.config.json` with an mtime-cached `loadBkitConfig()` helper and resolves `pdca.docPaths.{plan,design,analysis,report}` templates via `getPhaseTemplates()`. `docsPath()` walks the configured templates and returns the first existing file. All four doc-read tools (`bkit_plan_read`, `bkit_design_read`, `bkit_analysis_read`, `bkit_report_read`) honor custom config paths with fallback to built-in defaults for zero-config projects.

### Changed
- **Version Sync** — `bkit.config.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (both the marketplace spec version and the bkit plugin entry), `hooks/hooks.json`, and `hooks/session-start.js` systemMessage bumped to 2.1.3.
- **Dead Constants Removed** — `servers/bkit-pdca-server/index.js` no longer declares `PHASE_MAP` / `DOCS_DIR` (both were superseded by the new template-based resolver).

### Documentation
- Full PDCA artifacts for the `v213-issue-fixes` feature under `docs/01-plan/`, `docs/02-design/`, `docs/03-analysis/`, `docs/04-report/`.

## [2.1.2] - 2026-04-12

### Added
- **Worktree Detector** (`lib/core/worktree-detector.js`) — Detects linked git worktrees via `git rev-parse --show-toplevel` vs `--git-common-dir` comparison. On detection, emits stderr warning and writes `.bkit/runtime/worktree-warning.flag`. Addresses anthropics/claude-code#46808 (hooks not firing in linked worktrees).
- **Startup Worktree Guard** — `hooks/startup/context-init.js` now invokes worktree-detector on session start to warn users before PDCA state writes occur in a linked worktree.
- **Unit Tests** — `test-scripts/unit/mcp-ok-response.test.js` and `test-scripts/unit/worktree-detector.test.js` (jest, 2 suites / 6 tests).

### Fixed
- **MCP `_meta` Persist Bypass (ENH-193)** — Both MCP servers (`bkit-pdca-server`, `bkit-analysis-server`) now set `maxResultSizeChars` on both `result._meta` and `content[0]._meta`, restoring the 500K override path after the CC v2.1.98 persistence change.
- **Jest Runner Stability** — Active unit test suites run clean on Node 20+ under `npx jest --silent`.

### Changed
- **Version Sync** — `bkit.config.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json` bumped to 2.1.2.
- **Code Simplification** — Consolidated per-field comments in both MCP servers into single block comments; removed dead `try/catch` and merged three nested blocks into one in `worktree-detector.js` (-10 LOC). No behavior change.
- **CC Compatibility Baseline** — Verified against CC v2.1.98; 63 consecutive compatible releases (v2.1.34 → v2.1.98).

### Documentation
- PDCA artifacts for the `cc-version-issue-response` feature: plan, design, iterate, qa, simplify, report, and full-QA reports under `docs/01-plan/`, `docs/02-design/`, `docs/03-analysis/`, `docs/04-report/`.
- Full plugin QA matrix — 7/7 `claude -p --plugin-dir .` smoke tests, 38 skills / 36 agents / 21 hooks / 2 MCP servers validated end-to-end.

## [2.1.1] - 2026-04-09

### Added
- **QA Phase Integration** — New 11th PDCA state (`qa`) with 5 transitions (QA_PASS, QA_FAIL, QA_SKIP, QA_RETRY), check→qa→report flow, state machine expanded to 11 states / 22 events / 25 transitions
- **Semantic Gap Analysis Enhancement** — Improved gap detection accuracy with semantic context matching
- **QA Report Generation** — L1-L5 test level framework with automated QA reports in `docs/05-qa/`

### Fixed
- **Deep Verification Fixes** — Circular dependency resolution, hook schema validation, token waste reduction, dead code removal
- **33 Broken Test Assertions** — Fixed across 10 test files for QA phase state machine integration
- **Dead Context Cleanup** — Removed stale session context reducing token waste

### Changed
- **Component Counts Updated**: Skills 37→38, Agents 32→36, Hook Events 20→21, Scripts 59→42 (consolidated), Lib Modules 72→84, Lib Subdirs 11→12
- **Gate Manager Thresholds** — matchRate thresholds updated for Enterprise/Dynamic levels
- **pdca-iterator Agent** — effort level changed from medium to high for better iteration quality

### Documentation
- Documentation sync across README.md, CUSTOMIZATION-GUIDE.md, plugin.json, marketplace.json, bkit-system/ docs
- QA phase reports added to `docs/05-qa/`
- Test report updated (3,261 TC, 99.6% pass rate, 0 failures)

## [2.0.6] - 2026-03-25

### Added — Living Context System + Self-Healing + PDCA Handoff Fix (PR #57)

**Living Context System** (`lib/context/` — 7 new modules, ~1,527 LOC)
- New `lib/context/` subdirectory (11th lib subdirectory) with 7 modules:
  - `context-loader.js` (526 LOC): 4-Layer Living Context loading — `loadFullUpstream()`, `extractSection()`, `extractDecisions()`, `formatUpstreamSummary()` for full PRD→Plan→Design chain reading
  - `impact-analyzer.js` (205 LOC): Change impact analysis for Living Context decisions
  - `invariant-checker.js` (131 LOC): Context invariant validation with schema support
  - `scenario-runner.js` (203 LOC): Design-post scenario execution for verification
  - `self-healing.js` (301 LOC): Automated error detection and context-aware fix generation
  - `ops-metrics.js` (150 LOC): Operational metrics collection for Living Context
  - `index.js` (11 LOC): Module entry point re-exporting context-loader, invariant-checker, impact-analyzer, scenario-runner

**Self-Healing Agent** (`agents/self-healing.md`)
- New opus-model agent for automated error recovery
- Detects errors from Slack/Sentry, loads 4-Layer context, fixes code, verifies with scenario runner
- Tools: Read, Write, Edit, Glob, Grep, Bash, Task(Explore), Task(code-analyzer), Task(gap-detector)
- Stop hook: `heal-hook.js` for post-healing state capture

**Deploy Skill & State Machine** (`skills/deploy/SKILL.md`, `lib/pdca/deploy-*.js`)
- New deploy skill with environment progression: dev → staging → prod
- `deploy-state-machine.js` (261 LOC): 3-environment state machine with gate conditions
- `deploy-gate.js` (173 LOC): Quality gates per environment (dev 80%+, staging 90%+, prod 95%+ with human approval)
- `deploy-hook.js` (107 LOC): Hook script for deploy event handling

**PDCA Handoff Loss Fix Phase 2** (upstream document cross-reading)
- `context-loader.js`: `loadFullUpstream()` enables all phases to read PRD→Plan→Design chain
- `skills/pdca/SKILL.md`: Do/Analyze/Report phases now include full upstream loading steps
- `templates/analysis.template.md`: Strategic Alignment Check (PRD alignment + SC evaluation + Decision verification)
- `templates/do.template.md`: Upstream Context Chain + Documents Loaded table

**PDCA Handoff Loss Fix Phase 3** (PRD→Code context penetration)
- `lib/pdca/decision-record.js` (174 LOC): Decision Record Chain extraction and formatting
- `lib/pdca/commit-context.js` (124 LOC): PDCA-aware commit message generation with decision references
- `lib/pdca/session-guide.js`: Added `extractSuccessCriteria()` + `formatSuccessCriteria()` exports
- `templates/report.template.md`: Decision Record Summary + Success Criteria Final Status sections

**Infrastructure Templates** (11 new template files)
- `templates/infra/`: ArgoCD application, deploy pipelines (dynamic/enterprise), staging EKS, Terraform main
- `templates/infra/observability/`: Prometheus, Loki, OpenTelemetry Tempo value files
- `templates/infra/security/`: Security layer template
- `templates/context/`: Invariants + scenario YAML schemas

**New Scripts** (3 new, 54→57 total)
- `scripts/deploy-hook.js`: Deploy event handler
- `scripts/design-post-scenario.js`: Post-design scenario verification
- `scripts/heal-hook.js`: Self-healing post-fix state capture

**Design Guide**
- `docs/02-design/LIVING-CONTEXT-GUIDE.md`: Living Context System architecture and usage guide

**PM Documents** (3 new PRDs)
- `docs/00-pm/bkit-3way-comparison.prd.md`: bkit vs alternatives comparison
- `docs/00-pm/bkit-customization-impact-analysis.prd.md`: Customization impact analysis
- `docs/00-pm/bkit-infra-automation.prd.md`: Infrastructure automation PRD

### Changed

- **Component Counts Updated**:
  - Lib Modules: 78 → 88 (+10 new modules across 2 subdirectories)
  - Lib Subdirectories: 10 → 11 (+context)
  - Agents: 31 → 32 (+self-healing)
  - Skills: 36 → 37 (+deploy)
  - Scripts: 54 → 57 (+3 new hook scripts)
  - Exports: ~580+ → ~620+ (new context + pdca modules)
  - Total LOC (lib/): ~40K → ~45K (+~5K)
- `lib/core/paths.js`: Added context module and deploy paths
- Skill classification: 17 Workflow → 18 Workflow (+deploy), 18 Capability, 1 Hybrid
- Agent model distribution: 10 opus → 11 opus (+self-healing), 19 sonnet, 2 haiku
- PRD→Code Context Preservation: 30-40% → 75-85% (with Phase 1+2+3)
- Version bumped to 2.0.6 across all config files

---

## [2.0.5] - 2026-03-23

### Added — Multi-Session Incremental Context Management (PR #55)

**Session Guide Module** (`lib/pdca/session-guide.js`)
- New module with 8 exported functions (277 LOC) for multi-session handoff context loss reduction
  - `extractContextAnchor()`: Extracts 5-line strategic summary (WHY/WHO/RISK/SUCCESS/SCOPE) from Plan document
  - `formatContextAnchor()`: Formats anchor as markdown table
  - `analyzeModules()`: Parses Design document's Implementation Guide for module scope keys
  - `suggestSessions()`: Generates session plan based on module turn estimates (default 50 turns/session)
  - `formatSessionPlan()`, `formatModuleMap()`: Markdown table formatters
  - `filterByScope()`, `parseDoArgs()`: Scope parameter handling for `--scope` CLI support

**Context Anchor Template Integration**
- Plan template v1.2→v1.3, Design template v1.2→v1.3, Do template v1.0→v1.1, Analysis template v1.2→v1.3
- All 4 PDCA templates now include Context Anchor section (extracted from Plan, propagated downstream)
- Design template adds Session Guide section (Module Map + Recommended Session Plan)
- Do template adds Session Scope section with `--scope module-N` usage

**Upstream Document Cross-Reading** (SKILL.md enhancements)
- Plan phase: Context Anchor Generation step
- Design phase: Context Anchor Embed + Session Guide Generation + PRD Context Loading
- Do phase: `--scope` parameter parsing + Context Anchor display + Plan Context Anchor reading
- Analyze phase: Context Anchor Embed + Plan Success Criteria Reference

**Test Coverage** (75 new TC)
- `test/unit/session-guide.test.js` (35 TC): 8 functions unit tests
- `test/integration/context-anchor-propagation.test.js` (25 TC): Template + SKILL.md integration
- `test/regression/pr55-handoff-loss.test.js` (15 TC): Backward compatibility + structural integrity

### Fixed
- `lib/pdca/status.js`: `addPdcaHistory()` crash when `status.history` is undefined (defensive guard added)

### Changed
- Total Test Cases: 3298 TC (was 3224, +74 new)
- Session Guide registered in `lib/pdca/index.js` exports (8 new exports)
- Version bumped to 2.0.5 across all config files

---

## [2.0.4] - 2026-03-23

### Fixed — Hook Path Quoting for Windows Compatibility

**Critical Bug Fix ([#53](https://github.com/popup-studio-ai/bkit-claude-code/issues/53))**
- All 18 hook commands in `hooks/hooks.json` now properly quote `${CLAUDE_PLUGIN_ROOT}` paths with double-quotes
- Fixes bash syntax error when Windows username contains parentheses (e.g., `홍길동(HongGildong)`)
- Affects: SessionStart, PreToolUse, PostToolUse, Stop, StopFailure, UserPromptSubmit, PreCompact, PostCompact, TaskCompleted, SubagentStart, SubagentStop, TeammateIdle, SessionEnd, PostToolUseFailure, InstructionsLoaded, ConfigChange, PermissionRequest, Notification
- Before: `node ${CLAUDE_PLUGIN_ROOT}/scripts/foo.js` → syntax error on paths with `(` or `)`
- After: `node "${CLAUDE_PLUGIN_ROOT}/scripts/foo.js"` → works on all platforms

**Version Alignment**
- Bumped all version references from 2.0.3 to 2.0.4: plugin.json, bkit.config.json, marketplace.json, evals/config.json, MCP server packages, audit-logger.js, session-start.js, session-context.js, paths.js

### Test Enhancements
- Added `test/security/hook-path-quoting.test.js`: 12 TCs for path quoting validation
- Added `test/regression/issue-53-path-quoting.test.js`: 10 TCs for Windows path edge cases
- Updated test runner expected counts for new TCs

## [2.0.3] - 2026-03-22

### Fixed — Documentation & Architecture Sync

**Version Alignment**
- Synced `bkit.config.json` version from stale 2.0.0 to match `plugin.json` 2.0.3
- Updated hardcoded version strings in `lib/audit/audit-logger.js` (BKIT_VERSION), `hooks/session-start.js` (systemMessage), `lib/core/paths.js` (meta.json), MCP server packages
- Fixed test expectations for version checks (config-sync, v200-wiring, config-permissions, agents-effort)

**Documentation Sync with v2.0.2 Architecture**
- Updated skill classification across all docs: 9W/25C/2H → **17 Workflow / 18 Capability / 1 Hybrid** (7 new skills classified)
- Updated eval count: 28 → **29** (cc-version-analysis added)
- Updated export count: ~465 → **~580+** (v2.0.0 modules not counted)
- Updated script count in docs: 49 → **54** (5 new hook scripts)
- Updated lib subdirectory references to include `adapters`
- Synced team composition names with cto-lead.md implementation
- Added PR #51 (Impact Analysis section) to v2.0.2 changelog entry

**Test Runner**
- Aligned `test/run-all.js` expected TC counts with actual: Unit 1120→1403, Integration 360→479, Security 130→205, Regression 335→416, Performance 126→160, Philosophy 140→138, UX 150→160, E2E 55→61
- Updated pm-discovery/pm-prd maxTurns expectations: 20→25

### Changed
- Total Test Cases: 3,202 TC (0 failures, 12 skips, 99.6% pass rate)
- CC recommended version: v2.1.81+ (was v2.1.78+)
- PDCA documents: docs/01-plan/ through docs/04-report/

## [2.0.2] - 2026-03-22

### Added — PM Skills Integration + Interactive Checkpoints
- **PM Frameworks 9→43**: Integrated [pm-skills](https://github.com/phuryn/pm-skills) (MIT License) into PM Agent Team — Brainstorm, SWOT, PESTLE, Porter's Five Forces, Pre-mortem, Growth Loops, Customer Journey Map, ICP, Battlecards, User/Job Stories, Test Scenarios, Stakeholder Map
- **PDCA Interactive Checkpoints 1~5**: AskUserQuestion-gated confirmation at Plan (requirements + clarifying questions), Design (3 architecture options selection), Do (implementation scope approval), Check (fix strategy choice: all/critical-only/skip)
- **code-analyzer Confidence-Based Filtering**: Only reports issues with confidence ≥80%, Critical/Important severity classification, filtered count summary
- **CTO Lead Interactive Checkpoints**: v1.7.0 feature-dev pattern for CTO Team sessions
- **btw CTO Team Integration**: teamContext field (isTeamSession, phase, role, pattern), Phase Transition Hook, cto-stop.js session summary with btw stats
- **Design Template Architecture Options**: 3 options comparison table (Option A: Minimal / Option B: Clean / Option C: Pragmatic)
- **pm-prd Template v2.0**: Section 6 Execution Deliverables (Pre-mortem, User Stories, Job Stories, Test Scenarios, Stakeholder Map), SWOT Analysis, Customer Journey Map, ICP, Battlecards, Growth Loops
- **Integration Test**: pm-skills-integration.test.js (50 TC, 100% pass)
- **Plan Template Impact Analysis Section** ([PR #51](https://github.com/popup-studio-ai/bkit-claude-code/pull/51)): Mandatory Section 6 requiring full inventory of existing consumers (CREATE/READ/UPDATE/DELETE) before modifying resources — prevents silent breakage of existing functionality

### Changed
- `agents/pm-discovery.md`: +167 LOC (Brainstorm, Assumption Risk frameworks)
- `agents/pm-strategy.md`: +166 LOC (SWOT, PESTLE, Growth Loops)
- `agents/pm-research.md`: +107 LOC (Customer Journey, ICP)
- `agents/pm-prd.md`: +165 LOC (Pre-mortem, User/Job Stories, Stakeholder Map)
- `agents/pm-lead.md`: +33 LOC (team orchestration improvements)
- `agents/code-analyzer.md`: +19 LOC (Confidence-Based Filtering)
- `agents/cto-lead.md`: +48 LOC (Interactive Checkpoints)
- `skills/pdca/SKILL.md`: +48 LOC (Checkpoints 1~5)
- `skills/btw/SKILL.md`: +42 LOC (CTO Team Integration)
- `scripts/cto-stop.js`: +37 LOC (btw session summary)
- `templates/design.template.md`: +21 LOC (Architecture Options)
- `templates/pm-prd.template.md`: v1.0→v2.0, +136 LOC
- `templates/plan.template.md`: +41 LOC (Section 6 Impact Analysis, section renumbering 6→7→8→9)
- CC recommended version: v2.1.78+ → v2.1.81+
- CC compatibility: v2.1.34~v2.1.81 = 47 consecutive compatible releases

## [2.0.1] - 2026-03-21

### Fixed
- **Cross-Project PDCA State Leakage** ([#48](https://github.com/popup-studio-ai/bkit-claude-code/issues/48)): `restoreFromPluginData()` now validates project identity via `meta.json` before restoring backup, preventing Project A's PDCA state from leaking into Project B
- `backupToPluginData()`: Writes `meta.json` with `projectDir` identifier on every backup
- `restoreFromPluginData()`: 5-stage validation guard (meta exists → parseable → has projectDir → realpathSync normalize → match current project)
- `globalCache`: Cache keys namespaced as `pdca-status:${PROJECT_DIR}` to prevent in-memory pollution across projects

### Added
- `test/unit/project-isolation.test.js`: 10 new test cases for cross-project restore guard
- PDCA documents: plan, design, analysis, report for globalcache-project-isolation

## [2.0.0] - 2026-03-20

### Added — AI Native Development OS
- **Workflow Automation Engine**: Declarative PDCA state machine (20 transitions, 9 guards, 15 actions), YAML workflow DSL with 3 presets (default, hotfix, enterprise), Do phase detection (3-layer), Full-Auto Do (Design→code generation), parallel feature management (max 3), circuit breaker, resume system
- **Controllable AI (L0-L4)**: 5-level automation controller with 10 gate configs, destructive operation detector (8 rules, G-001~G-008), blast radius analyzer (6 rules), checkpoint manager (SHA-256 integrity), loop breaker (4 rules), trust engine (5-component scoring), scope limiter
- **Visualization UX**: CLI dashboard with progress bar, workflow map, agent panel, impact view, control panel, ANSI styling library with NO_COLOR support
- **Architecture Refactoring**: constants.js (33 constants), errors.js (BkitError with 7 domains), state-store.js (atomic writes with file locking), hook-io.js (lightweight Hook I/O), backup-scheduler.js, session-start.js split into 5 startup modules
- **CC Feature Integration**: 6 new hook scripts (SessionEnd, PostToolUseFailure, InstructionsLoaded, ConfigChange, PermissionRequest, Notification)
- **MCP Servers**: bkit-pdca-server (10 tools + 3 resources), bkit-analysis-server (6 tools)
- **New Skills**: `/control` (automation level), `/audit` (decision transparency), `/rollback` (checkpoint management), `/pdca-batch` (parallel features)
- **Comprehensive Test Suite**: 2,717 TC across 10 categories (99.6% pass rate, 0 failures), 2 new categories (Architecture Tests, Controllable AI Tests)

### Changed
- Skills: 31 → 36 (+5: control, audit, rollback, pdca-batch, btw)
- Agents: 29 → 31 (+2: pdca-eval-design, pm-lead-skill-patch)
- Hook Events: 12 → 18 (+6 new events)
- Lib Modules: 36 → 76 (+40 new modules across 10 subdirectories)
- Hook Scripts: 49 → 21 (consolidated with unified handlers)
- Exports: 210 → ~465 (+255 new functions)
- Test Cases: 1,151 → 2,645+ (+1,494)

### Removed
- `lib/skill-loader.js` (795 LOC) — orphaned, never imported
- `lib/skill-quality-reporter.js` (479 LOC) — orphaned, never imported
- `docs/github-stats-bkit-gemini.md` — separate repository stats
- Gemini CLI references from script comments (Claude Code exclusive since v1.5.0)
- `common.js` usage in hooks/scripts (57 scripts migrated to direct imports)

### Architecture
- 7 new lib domains: `lib/audit/`, `lib/control/`, `lib/ui/`, `lib/pdca/` (expanded), `lib/core/` (expanded)
- State management: `.bkit/state/`, `.bkit/runtime/`, `.bkit/snapshots/`
- YAML workflows: `.bkit/workflows/` (3 presets)
- MCP servers: `servers/bkit-pdca-server/`, `servers/bkit-analysis-server/`

## [1.6.2] - 2026-03-18

### Added
- **CC v2.1.73~v2.1.78 Full Integration** (14 ENH items: ENH-117~130)
  - PostCompact hook event: PDCA state integrity verification after context compaction
  - StopFailure hook event: API error classification, logging, and recovery guidance
  - `${CLAUDE_PLUGIN_DATA}` persistent backup: automatic state backup/restore across plugin updates
  - Agent frontmatter `effort`/`maxTurns`: native support for all 29 agents (opus=high/30-50, sonnet=medium/20, haiku=low/15)
  - 1M context window documentation: default for Max/Team/Enterprise plans (CC v2.1.75+)
  - Output token 128K upper limit documentation (CC v2.1.77+)
  - modelOverrides guide for Bedrock/Vertex users
  - autoMemoryDirectory guide for custom memory paths
  - worktree.sparsePaths guide for large monorepo optimization
  - /effort command guide with ultrathink documentation
  - allowRead sandbox guide for fine-grained filesystem control
  - Session name (-n) guide for CI/CD automation
  - Hook source display documentation (CC v2.1.75+)
  - tmux notification passthrough documentation (CC v2.1.78+)
- **New Scripts** (2)
  - `scripts/post-compaction.js`: PostCompact hook handler (~120 LOC)
  - `scripts/stop-failure-handler.js`: StopFailure hook handler (~160 LOC)
- **Comprehensive Test Suite** (1,186 TC, 8 perspectives)
  - Unit (555), Integration (134), Security (85), Regression (192), Performance (76), Philosophy (58), UX (60), E2E (26)
  - 99.7% pass rate, 0 failures, 4 skips (pre-existing)
  - 6 new test files, 6 updated test files (+161 TC from v1.6.1)

### Changed
- **Hook Events**: 10 → 12 in hooks.json (+PostCompact, +StopFailure)
- **lib/core/paths.js**: +2 functions (backupToPluginData, restoreFromPluginData), +2 STATE_PATHS (pluginData, pluginDataBackup)
- **lib/core/index.js**: 52 → 54 exports (+2 PLUGIN_DATA functions)
- **lib/common.js**: 208 → 210 exports (+2 bridge re-exports)
- **lib/pdca/status.js**: savePdcaStatus() and writeBkitMemory() now auto-backup to PLUGIN_DATA
- **hooks/session-start.js**: PLUGIN_DATA restore on startup, v1.6.2 enhancements section, 1M context info
- **agents/*.md**: All 29 agents updated with effort/maxTurns fields (model field moved to top)
- **CC recommended version**: v2.1.71 → v2.1.78
- **CC compatibility**: v2.1.34~v2.1.78 = 44 consecutive compatible releases (0 breaking changes)
- **Version bumps**: plugin.json, bkit.config.json, hooks.json, session-start.js, marketplace.json

### Documentation
- **bkit-system/philosophy/context-engineering.md**: 12 new sections for v1.6.2 features
- **bkit-system/philosophy/core-mission.md**: v1.6.2 version record
- **bkit-system/components/hooks/_hooks-overview.md**: v1.6.2 hook events

### Compatibility
- Claude Code: Minimum v2.1.69+, Recommended v2.1.78
- Node.js: Minimum v18+
- Agent Teams: Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

---

## [1.6.1] - 2026-03-08

### Added
- **CTO/PM Orchestration Redesign** (Issue #41 fix)
  - Main Session as CTO pattern to bypass CC v2.1.69+ nested spawn restriction
  - `lib/team/coordinator.js`: 7 new exports (buildAgentTeamPlan, getFileOwnership, generateTeammatePrompt, etc.)
  - Agent Teams TeamCreate integration for CTO/PM team composition
- **Skill Evals 28/28 Full Implementation**
  - `evals/runner.js`: parseEvalYaml(), evaluateAgainstCriteria(), runEval() (real evaluation engine)
  - `evals/reporter.js`: formatDetailedReport() with skill category breakdown
  - 56 content files: 28 × prompt-1.md + 28 × expected-1.md
  - `node evals/runner.js --benchmark` achieves 28/28 PASS (100% coverage)
- **Agent Security Hardening**
  - 3-Tier Security Model for 9 acceptEdits agents
  - Tier 1 (Starter Guide): disallowedTools [Bash]
  - Tier 2 (5 Expert Agents): disallowedTools [Bash(rm -rf), Bash(git push), Bash(git reset --hard)]
  - Tier 3 (QA/Iterator): unchanged (Bash required)
- **Comprehensive Test Suite** (1073 TC, 8 perspectives)
  - Unit (503), Integration (120), Security (80), Regression (156), Performance (70), Philosophy (58), UX (60), E2E (26)
  - 99.6% pass rate, 0 failures, 4 skips (environment-dependent)
- **CE Level Assessment** — CE-5 Master (88/100)
  - 10-Agent CTO Team evaluation from 10 perspectives
  - 252 total components inventoried (28 Skills + 21 Agents + 41 lib + 46 Scripts + 15 Templates + 4 Styles + 56 Evals + 39 Tests)

### Changed
- **P0 Bug Fixes** (4 items)
  - `ambiguity.js`: shouldClarify property added for automatic clarification detection
  - `trigger.js`: confidenceThreshold hardcoded 0.8 removed, reads from config
  - `creator.js`: PDCA phases array unified (includes act phase), imports fixed
  - Agent `disallowedTools` settings applied to 6 experts + 1 guide
- **Config-Code Synchronization**
  - `lib/team/orchestrator.js`: PHASE_PATTERN_MAP loads from bkit.config.json at runtime
  - selectOrchestrationPattern() with config fallback logic
- **Skills PDCA Enhancement**
  - `skills/pdca/SKILL.md`: agents.team = null, agents.pm = null (Main Session as Team Lead)
- **Library Export Count**: 208 exports (corrected from v1.6.0 documented 241)

### Fixed
- **Critical Issue #41**: CC v2.1.69+ nested subagent spawn restriction broke `/pdca team`
- **Config Read Failure**: confidenceThreshold not reflected in trigger decisions
- **Array Inconsistency**: PDCA phases missing 'act' phase in task creation
- **Security Gaps**: 8 acceptEdits agents without explicit tool restrictions
- **Stub System**: Evals always returned true (non-functional quality validation)

### Test Results
- **1073 TC**: 1069 passed, 0 failed, 4 skipped (99.6%)
- **Evals Coverage**: 28/28 PASS (100%)
- **Design Match Rate**: 100% (26/26 items)

### Files Modified
- 72 files, ~1,400 LOC changed
- New: 56 content files (evals/), 35 test files (test/)
- Core: lib/team/coordinator.js, lib/team/orchestrator.js, lib/intent/ambiguity.js, lib/intent/trigger.js, lib/task/creator.js
- Agents: 7 agents updated with disallowedTools
- Skills: skills/pdca/SKILL.md

### Breaking Changes
- None (backward compatible)

---

## [1.6.0] - 2026-03-07

### Added
- **Skills 2.0 Complete Integration** (19 ENH items: ENH-85~103)
  - Skill Classification: All 28 skills classified as Workflow (10) / Capability (16) / Hybrid (2) with deprecation-risk scoring
  - Skill Evals Framework: `evals/runner.js` with benchmark mode, 28 pre-built eval definitions
  - A/B Testing: `evals/ab-tester.js` for model comparison and parity testing
  - Skill Creator: `skill-creator/generator.js` + `skill-creator/validator.js` for skill scaffolding
  - Template Validator: PostToolUse hook validation for PDCA document required sections (ENH-103)
  - Frontmatter hooks migration: hooks.json Layer 2/3 consolidation
  - context:fork deprecation: CC native context:fork replaces FR-03 custom implementation
  - Hot reload: SKILL.md changes reflect without session restart
  - Wildcard permissions: `Bash(npm *)`, `Bash(git log*)` patterns
- **PM Agent Team** (5 new agents for pre-Plan product discovery)
  - pm-lead (opus): PM Team orchestration, PRD synthesis
  - pm-discovery (sonnet): Opportunity Solution Tree analysis
  - pm-strategy (sonnet): Value Proposition, Lean Canvas
  - pm-research (sonnet): Personas, competitors, market sizing (TAM/SAM/SOM)
  - pm-prd (sonnet): PRD document generation at `docs/00-pm/{feature}.prd.md`
  - New skill: `pm-discovery` for PM workflow automation
  - New template: `pm-prd.template.md` for PRD output
  - Integration: `/pdca pm {feature}` triggers PM Team before Plan phase
- **Skill Evals Directory Structure**
  - `evals/config.json`: Global eval configuration (thresholds, classifications)
  - `evals/runner.js`: Eval execution engine (CLI + module)
  - `evals/reporter.js`: Markdown/JSON result reporting
  - `evals/ab-tester.js`: Model comparison + parity testing
  - `evals/workflow/`, `evals/capability/`, `evals/hybrid/`: Eval definitions by classification
- **CC v2.1.71 Compatibility**
  - /loop + Cron PDCA auto-monitoring
  - Background agent recovery (output file path fix)
  - stdin freeze fix for long CTO Team sessions

### Changed
- **Skills**: 27 → 28 (+1 pm-discovery)
- **Agents**: 16 → 21 (+5 PM Team: pm-lead, pm-discovery, pm-strategy, pm-research, pm-prd)
- **lib/common.js exports**: 199 → 241 (+42 from executive-summary, template-validator, PM team modules)
- **CC recommended version**: v2.1.66 → v2.1.71
- **All 28 skills**: Added `classification`, `classification-reason`, `deprecation-risk` frontmatter fields
- **Documentation**: Full v1.6.0 doc-sync across 60+ files (versions, counts, architecture descriptions)

### Quality
- Comprehensive Test: 631 TC, 100% pass rate
- PM Team Integration: 16 GAPs, 100% match rate
- Doc-sync: 60+ files synchronized

### Compatibility
- Claude Code: Minimum v2.1.63, Recommended v2.1.71
- Node.js: Minimum v18.0.0
- Agent Teams: Requires Claude Code v2.1.32+ with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

---

## [1.5.9] - 2026-03-05

### Added
- **Executive Summary Module** (`lib/pdca/executive-summary.js`): 3 new exports (generateExecutiveSummary, formatExecutiveSummary, generateBatchSummary)
- **AskUserQuestion Preview UX**: Rich Markdown previews in PDCA phase transitions via buildNextActionQuestion()
- **plan-plus-stop.js**: New PostToolUse hook script for Plan Plus skill
- **ENH-74**: agent_id/agent_type first-class extraction in 5 hook scripts
- **ENH-75**: continue:false teammate lifecycle control in TaskCompleted/TeammateIdle hooks

### Changed
- **lib/common.js**: 184 → 199 exports (+15 from executive-summary and automation modules)
- **lib/pdca/automation.js**: Added buildNextActionQuestion(), formatAskUserQuestion with preview support
- **templates/plan.template.md**: Added Executive Summary section
- **templates/plan-plus.template.md**: Added Executive Summary section
- **templates/report.template.md**: Added Value Delivered table
- **skills/pdca/SKILL.md**: Added Executive Summary generation guidelines
- **hooks/hooks.json**: Removed InstructionsLoaded hook event (-6 lines)

### Fixed
- No bug fixes in this release

---

## [1.5.8] - 2026-03-01

### Added
- **Studio Support: Path Registry** (`lib/core/paths.js`)
  - Centralized state file path management replacing 11+ hardcoded path references
  - STATE_PATHS (7 keys): root, state, runtime, snapshots, pdcaStatus, memory, agentState
  - LEGACY_PATHS (4 keys): pdcaStatus, memory, snapshots, agentState (deprecated, v1.6.0 removal)
  - CONFIG_PATHS (3 keys): bkitConfig, pluginJson, hooksJson
  - `ensureBkitDirs()` for recursive directory creation
- **State Directory Migration**
  - `docs/.pdca-status.json` → `.bkit/state/pdca-status.json`
  - `docs/.bkit-memory.json` → `.bkit/state/memory.json`
  - `.bkit/agent-state.json` → `.bkit/runtime/agent-state.json`
  - `docs/.pdca-snapshots/` → `.bkit/snapshots/`
- **Auto-Migration on SessionStart**
  - Automatic v1.5.7 → v1.5.8 state file migration
  - EXDEV cross-filesystem fallback (copy + delete)
  - Per-file try-catch isolation for resilience
  - Idempotent operation (safe to re-run)

### Changed
- **lib/core/index.js**: Added paths module (+4 exports: STATE_PATHS, LEGACY_PATHS, CONFIG_PATHS, ensureBkitDirs)
- **lib/common.js**: Bridge updated (182 → 186 exports, +4 path re-exports)
- **lib/pdca/status.js**: `getPdcaStatusPath()`, `readBkitMemory()`, `writeBkitMemory()` use STATE_PATHS
- **lib/memory-store.js**: `getMemoryFilePath()` uses STATE_PATHS.memory()
- **lib/task/tracker.js**: `findPdcaStatus()` uses getPdcaStatusPath() via lazy require
- **lib/team/state-writer.js**: `getAgentStatePath()` uses STATE_PATHS.agentState()
- **scripts/context-compaction.js**: snapshotDir uses STATE_PATHS.snapshots()
- **hooks/session-start.js**: Auto-migration logic (+45 lines), v1.5.8 context sections
- **bkit.config.json**: `pdca.statusFile` updated to `.bkit/state/pdca-status.json`

### Quality
- Comprehensive Test: 865 TC, 815 PASS, 0 FAIL, 50 SKIP (100%)
- 5 QA agents parallel execution, 1 iteration (hooks.json version fix)
- Design match rate: 100% (37/37 items)

### Compatibility
- Claude Code: Minimum v2.1.33, Recommended v2.1.63
- Node.js: Minimum v18.0.0
- Agent Teams: Requires Claude Code v2.1.32+ with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

---

## [1.5.7] - 2026-02-28

### Added
- **/simplify + /batch PDCA Integration** (ENH-52~55)
  - CC built-in /simplify command integrated into PDCA Check→Report flow
  - /batch multi-feature PDCA for Enterprise parallel processing
  - CC_COMMAND_PATTERNS: 8-language CC command awareness
  - HTTP Hooks documentation and guidance (type "http" in hooks config)
- **English Conversion**
  - 3 stop scripts converted to English output (code-review-stop, learning-stop, pdca-skill-stop)

### Changed
- **CC recommended version**: v2.1.59 → v2.1.63
- **Version**: 1.5.6 → 1.5.7
  - `plugin.json`, `bkit.config.json`, `hooks.json`, `session-start.js`

### Quality
- Comprehensive Test: 754 TC, 100% pass rate
- Doc-sync: 42 JS files + 5 doc files synchronized

### Compatibility
- Claude Code: Minimum v2.1.33, Recommended v2.1.63
- Node.js: Minimum v18.0.0

---

## [1.5.6] - 2026-02-26

### Added
- **Auto-Memory Integration** (ENH-48)
  - Add CC auto-memory guidance to SessionStart hook (Memory Systems section)
  - Add `/memory` command reference to bkit help (`commands/bkit.md`)
  - Clarify role separation between bkit memory-store and CC auto-memory
  - Fix agent memory count (9 -> 14 project scope agents)
- **CTO Team Memory Management Guide** (ENH-50)
  - New guide: `docs/guides/cto-team-memory-guide.md`
  - v2.1.50 + v2.1.59 multi-agent memory optimization best practices
  - Agent count recommendations and long session management tips
- **Remote Control Compatibility Pre-check** (ENH-51)
  - New guide: `docs/guides/remote-control-compatibility.md`
  - 27 skills + 16 agents RC compatibility matrix
  - Pre-check document for #28379 resolution

### Changed
- **Skill Completion /copy Guidance** (ENH-49)
  - `scripts/skill-post.js`: Add `copyHint` field on code generation skill completion
  - `scripts/unified-stop.js`: Add conditional `/copy` tip on Stop event
  - Target skills: phase-4~6, code-review, starter, dynamic, enterprise, mobile-app, desktop-app
- **Version**: 1.5.5 -> 1.5.6
  - `plugin.json`, `bkit.config.json`, `session-start.js`, `CHANGELOG.md`

### Compatibility
- Claude Code: Minimum v2.1.33, Recommended v2.1.59
- Node.js: Minimum v18.0.0
- Agent Teams: Requires Claude Code v2.1.32+ with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

---

## [1.5.5] - 2026-02-17

### Added
- **Plan Plus Skill** (Community Contribution by @wankiKim — PR #34)
  - New skill: `skills/plan-plus/SKILL.md` — Brainstorming-enhanced PDCA planning
  - 6-phase process: Context Exploration → Intent Discovery → Alternatives Exploration → YAGNI Review → Incremental Validation → Plan Document Generation
  - HARD-GATE enforcement: No code before plan approval
  - New template: `templates/plan-plus.template.md` with User Intent, Alternatives, YAGNI sections
  - 8-language trigger support (EN, KO, JA, ZH, ES, FR, DE, IT)
  - Seamless PDCA integration: `/plan-plus {feature}` → `/pdca design {feature}`

### Changed
- **Skills count**: 26 → 27 (+1 plan-plus)
- **Templates count**: 27 → 28 (+1 plan-plus.template.md)
- **skills/pdca/SKILL.md**: Added Plan Plus tip in plan action section (PR #34)
- **README.md**: Fixed duplicate Skills rows in Customization table (Community Contribution by @sungpeo — PR #33)

### Compatibility
- Claude Code: Minimum v2.1.33, Recommended v2.1.42
- Node.js: Minimum v18.0.0
- Agent Teams: Requires Claude Code v2.1.32+ with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

---

## [1.5.4] - 2026-02-14

### Added
- **bkend MCP Accuracy Fix (10 GAPs)**
  - MCP tool coverage: 19 (partial) → 28+ (complete)
  - MCP Fixed Tools: `get_context`, `search_docs`, `get_operation_schema`
  - MCP Project Management Tools: 9 tools (project/environment CRUD)
  - MCP Table Management Tools: 11 tools (table/schema/index management)
  - MCP Data CRUD Tools: 5 tools (`backend_data_list/get/create/update/delete`)
  - MCP Resources: 4 URI patterns (`bkend://` scheme)
  - Searchable Docs: 8 Doc IDs (`search_docs` query support)
- **bkend-patterns.md SSOT Expansion**
  - Shared patterns document: 85 → 140 lines (+65%)
  - New sections: REST API response format, query parameters, file upload, MCP setup, OAuth 2.1
- **bkend-expert Agent Rewrite**
  - MCP tools organized into 4 categories (Fixed/Project/Table/Data CRUD)
  - Dynamic Base URL (from `get_context`, no hardcoding)
  - MCP Resources (`bkend://` URI) reference added

### Changed
- **bkend-data/SKILL.md**: ID field `_id` → `id`, Data CRUD tools added, filter operators with `$` prefix
- **bkend-auth/SKILL.md**: MCP Auth Workflow pattern, REST endpoints 18 → 12 core, social login endpoint unified
- **bkend-storage/SKILL.md**: MCP Storage Workflow, multipart upload 4 endpoints, `download-url` GET → POST
- **bkend-quickstart/SKILL.md**: Numbered tools → named tools, Project Management 9 tools + Resources 4 URIs
- **bkend-cookbook/SKILL.md**: Live Reference URLs `src/` → `en/` paths
- **session-start.js**: bkend MCP status check `Dynamic` → `Dynamic || Enterprise` (GAP-10)
- **All Live Reference URLs**: `src/` directory paths → `en/` specific file paths

### Removed
- **bkend-expert.md**: Obsolete numbered Guide Tools references (`0_get_context` ~ `7_code_examples_data`)
- **bkend-auth/SKILL.md**: Account Lifecycle section (replaced by search_docs)
- **bkend-data/SKILL.md**: `backend_table_update` tool (non-existent tool)

### Quality
- Comprehensive Test Round 1: 708 TC, 705 PASS, 0 FAIL, 3 SKIP (100%)
- Comprehensive Test Round 2: 765 TC, 764 PASS, 0 FAIL, 1 SKIP (100%)
- bkend MCP Accuracy Fix: 10/10 GAPs, 42/42 items, 100% match rate

---

## [1.5.3] - 2026-02-10

### Added
- **Team Visibility (State Writer)**
  - `lib/team/state-writer.js`: 9 new functions for Agent Teams state management
  - `initAgentState`, `updateTeammateStatus`, `addTeammate`, `removeTeammate`, `updateProgress`, `addRecentMessage`, `cleanupAgentState`, `getAgentStatePath`, `readAgentState`
  - `.bkit/agent-state.json` schema v1.0 for Studio IPC
  - Atomic write pattern (tmp + rename) for concurrent safety
  - MAX_TEAMMATES=10, MAX_MESSAGES=50 ring buffer
- **SubagentStart/SubagentStop Hooks**
  - 2 new hook event types in `hooks.json` (8 → 10 events)
  - `scripts/subagent-start.js`, `scripts/subagent-stop.js`
  - Auto-init agent state, name extraction, model validation
- **Output Styles Auto-Discovery**
  - `outputStyles` field in `plugin.json` for Claude Code auto-discovery
  - 4th output style: `bkit-pdca-enterprise` added
  - `/output-style-setup` command for menu visibility
- **bkend Documentation Enhancement**
  - Official Documentation (Live Reference) sections in 5 bkend skills + agent
  - `bkend-quickstart` MCP step-by-step guide expansion
  - Agent Memory file for bkend-expert
- **CLAUDE.md Strategy Documentation**
  - `commands/bkit.md` expanded with CLAUDE.md strategy sections
  - v1.5.3 Features table in bkit help command

### Changed
- **Hook Events**: 8 → 10 (added SubagentStart, SubagentStop)
- **Library Functions**: 232 → 241 (+9 state-writer)
- **common.js exports**: 171 → 180 (+9 state-writer bridge)
- **team/index.js exports**: 31 → 40 (+9 state-writer)
- **Output Styles**: 3 → 4 (added bkit-pdca-enterprise)
- **team.enabled**: Default changed from false to true
- **session-start.js**: 4 output styles + /output-style-setup guide

### Fixed
- **GAP-01**: common.js missing 9 state-writer re-exports (171 → 180)

### Quality
- Comprehensive Test: 685 TC, 646 PASS, 39 SKIP (100% excl. SKIP)
- Enhancement Test: 31/31 PASS (100%)
- Final QA: 736/736 PASS (100%)

---

## [1.5.2] - 2026-02-06

### Added
- **bkend.ai BaaS Expert Enhancement**
  - 5 new bkend specialist Skills (21 → 26 total):
    - `bkend-quickstart`: Platform onboarding, MCP setup, resource hierarchy
    - `bkend-data`: Database expert (table creation, CRUD, 7 column types, filtering)
    - `bkend-auth`: Authentication expert (email/social login, JWT, RBAC, RLS)
    - `bkend-storage`: File storage expert (Presigned URL, 4 visibility levels)
    - `bkend-cookbook`: Practical tutorials (10 project guides, troubleshooting)
  - Shared template: `templates/shared/bkend-patterns.md`
  - Agent-Skill binding: `bkend-expert` preloads 3 core skills (data, auth, storage)
  - MCP auto-detection in session start and prompt handler

### Changed
- **agents/bkend-expert.md**: Complete rewrite (~215 lines)
  - MCP Tools reference (19 tools: 8 guide + 11 API)
  - REST Service API endpoints (Database 5, Auth 18, Storage 12)
  - OAuth 2.1 + PKCE authentication pattern
  - Troubleshooting table (12+ scenarios)
- **skills/dynamic/SKILL.md**: MCP integration modernization
  - MCP setup: `npx @bkend/mcp-server` → `claude mcp add bkend --transport http`
  - Authentication: API Key → OAuth 2.1 + PKCE
- **skills/phase-4-api/SKILL.md**: BaaS implementation guide added
- **lib/intent/language.js**: bkend-expert 8-language trigger patterns
- **hooks/session-start.js**: bkend MCP status detection
- **templates/plan.template.md**: BaaS architectural options added
- **templates/design.template.md**: BaaS architecture patterns added

### Fixed
- **BUG-01 (Critical)**: `scripts/user-prompt-handler.js` Line 72
  - Agent trigger confidence: `> 0.8` → `>= 0.8`
  - Impact: All 16 agents' implicit triggers were broken in UserPromptSubmit hook

### Compatibility
- Claude Code: Minimum v2.1.15, Recommended v2.1.33
- Node.js: Minimum v18.0.0
- bkend.ai: MCP endpoint via OAuth 2.1 + PKCE

---

## [1.5.1] - 2026-02-06

### Added
- **CTO-Led Agent Teams**: Multi-agent parallel PDCA execution orchestrated by CTO lead agent
  - CTO lead (opus) orchestrates team composition, task assignment, and quality gates
  - 5 new team agents: `cto-lead`, `frontend-architect`, `product-manager`, `qa-strategist`, `security-architect`
  - `lib/team/` module expanded to 7 files: coordinator, strategy, hooks, index, orchestrator, communication, task-queue, cto-logic
  - Team composition: Dynamic (3 teammates), Enterprise (5 teammates)
  - New hook handlers: `pdca-task-completed.js` (TaskCompleted), `team-idle-handler.js` (TeammateIdle), `team-stop.js`, `cto-stop.js`
  - `team` configuration section in `bkit.config.json`
  - Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
  - Total agents: 16 (11 core + 5 CTO Team)

- **Output Styles System**: Level-based response formatting
  - 3 styles in `output-styles/` directory:
    - `bkit-learning` for Starter level (learning points, TODO markers)
    - `bkit-pdca-guide` for Dynamic level (status badges, checklists)
    - `bkit-enterprise` for Enterprise level (tradeoff analysis, cost impact)
  - `outputStyles` configuration in `bkit.config.json` with `levelDefaults`

- **Agent Memory Integration**: Cross-session context persistence
  - `memory: user` scope for starter-guide, pipeline-guide (cross-project learning)
  - `memory: project` scope for 14 agents (project-specific context)
  - No configuration needed — auto-active

- **Natural Feature Discovery**: Philosophy-aligned auto-trigger integration
  - `bkit-rules/SKILL.md`: 3 new sections (Output Style Auto-Selection, Agent Teams Auto-Suggestion, Agent Memory Awareness)
  - `session-start.js`: Feature awareness block (styles, teams, memory) at every session start
  - Level skills: v1.5.1 feature announcements per level (Starter/Dynamic/Enterprise)
  - All 16 agents: v1.5.1 Feature Guidance sections
  - `claude-code-learning/SKILL.md`: Level 6 (Advanced Features) curriculum
  - `pdca/SKILL.md`: Output Style + Agent Teams integration sections

- **PDCA Team Mode**: `/pdca team {feature}` for CTO-Led parallel PDCA execution
  - `/pdca team status` to monitor teammate progress
  - `/pdca team cleanup` to end team session

- **New Hook Events**: `TaskCompleted` and `TeammateIdle` support in `hooks/hooks.json`

- **bkit Memory Functions**: `readBkitMemory()` and `writeBkitMemory()` for `docs/.bkit-memory.json` CRUD

- **bkit-system Documentation**: v1.5.1 coverage across 16 system docs
  - Philosophy docs (4): v1.5.1 feature integration sections
  - Component overviews (4): Agent Memory, Teams, Styles coverage
  - Trigger docs (2): Output Style, Agent Teams, Agent Memory triggers
  - New scenario: `scenario-discover-features.md`
  - Test checklist: 19 new test cases (OS-T:7, AT-T:7, AM-T:5)

### Fixed
- **BUG-01 (Critical)**: `checkPhaseDeliverables()` now supports both number (pipeline phase 1-9) and string (PDCA phase name) input types
- **BUG-02 (Medium)**: `scripts/iterator-stop.js` - Added optional chaining (`phaseAdvance?.nextPhase`) to prevent TypeError
- **BUG-03 (Medium)**: `scripts/gap-detector-stop.js` - Added optional chaining (`phaseAdvance?.nextPhase`) to prevent TypeError
- **BUG-04 (Low)**: Added missing `readBkitMemory`/`writeBkitMemory` exports in `lib/pdca/status.js`, `lib/pdca/index.js`, and `lib/common.js`

### Changed
- **lib/common.js**: Added Team module re-exports (30 team functions, total 165 exports)
- **lib/team/**: Expanded from 4 to 7+ files (added orchestrator.js, communication.js, task-queue.js, cto-logic.js)
- **Agent count**: Increased from 11 to 16 (5 new CTO Team agents)
- **Plugin metadata**: Updated `plugin.json` version to 1.5.1
- **Claude Code compatibility**: Minimum v2.1.15, Recommended v2.1.33

### Compatibility
- **Claude Code**: Minimum v2.1.15, Recommended v2.1.33
- **Node.js**: Minimum v18.0.0
- **Agent Teams**: Requires Claude Code v2.1.32+ with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

---

## [1.5.0] - 2026-02-01

### Breaking Changes
- **Claude Code Exclusive**: bkit is now Claude Code exclusive plugin
  - Gemini CLI support has been removed
  - All dual-platform code branches eliminated
  - Simplified codebase with single-platform focus

### Removed
- **Gemini CLI Files**:
  - `gemini-extension.json` - Gemini CLI extension manifest
  - `GEMINI.md` - Gemini CLI context file
  - `commands/gemini/` - 20 TOML command files
  - `lib/adapters/gemini/` - Gemini adapter implementations
  - `debug-platform.js` - Platform debugging utility
  - `lib/common.js.backup` - Backup file cleanup

- **Gemini CLI Code**:
  - `lib/core/platform.js`: Removed `isGeminiCli()` function and Gemini detection
  - `lib/core/io.js`: Removed Gemini output format branches from `outputAllow()`, `outputBlock()`, `outputEmpty()`
  - `lib/core/debug.js`: Removed Gemini log path from `getDebugLogPaths()`
  - `lib/context-hierarchy.js`: Removed Gemini config path from `getUserConfigDir()`
  - `hooks/session-start.js`: Removed ~70 lines of Gemini-specific code
  - 8 scripts: Removed `isGeminiCli` imports and platform branches

### Changed
- **README.md**: Removed all Gemini CLI references
  - Removed Gemini CLI badge
  - Removed "Dual Platform Support" messaging
  - Removed Gemini CLI installation section
  - Updated plugin structure documentation
- **Version**: Updated all version references to 1.5.0

### Compatibility
- **Claude Code**: Minimum v2.1.15, Recommended v2.1.25
- **Node.js**: Minimum v18.0.0

### Migration Guide
If you were using bkit with Gemini CLI, please note that Gemini CLI support has been discontinued.
For Gemini CLI users, consider using native Gemini CLI extensions or alternative tools.

---

## [1.4.7] - 2026-01-29

### Added
- **Task Management + PDCA Integration**: Complete integration of Claude Code Task System
  - Task Chain Auto-Creation on `/pdca plan`
  - Task ID Persistence in `.pdca-status.json`
  - Check↔Act Iteration (max 5 iterations, 90% threshold)
  - Full-Auto Mode (manual/semi-auto/full-auto)
  - 9 new functions: `savePdcaTaskId`, `createPdcaTaskChain`, `triggerNextPdcaAction`, etc.
- **Core Modularization**: lib/common.js split into 4 module directories
  - `lib/core/` - Platform detection, caching, debugging, configuration (7 files)
  - `lib/pdca/` - PDCA phase management, status tracking (6 files)
  - `lib/intent/` - Intent analysis, language detection, triggers (4 files)
  - `lib/task/` - Task classification, creation, tracking (5 files)
  - 22 new module files, 132 function exports
  - Migration Bridge for 100% backward compatibility
  - Lazy Require Pattern for circular dependency prevention

### Changed
- **lib/common.js**: Converted to Migration Bridge (3,722 → 212 lines)
- **scripts/pdca-skill-stop.js**: Task chain creation integration
- **scripts/gap-detector-stop.js**: triggerNextPdcaAction integration
- **scripts/iterator-stop.js**: triggerNextPdcaAction integration

### Compatibility
- **Claude Code**: Minimum v2.1.15, Recommended v2.1.22
- **Gemini CLI**: Minimum v0.25.0
- **Node.js**: Minimum v18.0.0

---

## [1.4.6] - 2026-01-28

### Fixed
- **Plugin Agent Prefix**: All bkit plugin agents now correctly use `bkit:` prefix
  - Fixes "Agent type 'gap-detector' not found" error in Claude Code Task tool
  - Claude Code requires plugin agents to be called as `{plugin-name}:{agent-name}`
  - 11 agents updated: gap-detector, code-analyzer, pdca-iterator, report-generator, starter-guide, design-validator, qa-monitor, pipeline-guide, bkend-expert, enterprise-expert, infra-architect
  - Built-in agent `claude-code-guide` correctly remains without prefix

### Changed
- **lib/common.js**: `matchImplicitAgentTrigger()` now returns `bkit:` prefixed agent names
- **18 SKILL.md files**: Updated `agent:` and `agents:` frontmatter fields with `bkit:` prefix
- **hooks/session-start.js**: Trigger keyword table updated with `bkit:` prefix
- **skills/bkit-rules/SKILL.md**: Task-Based Selection table updated with `bkit:` prefix
- **Command Renamed**: `/bkit:functions` → `/bkit:bkit`
  - File renamed: `commands/functions.md` → `commands/bkit.md`
  - More intuitive command name for plugin help
- **Test files removed from repository**: `tests/` and `test-scripts/` directories
  - Added to `.gitignore` (local testing only, not for distribution)
  - 66 test files removed from git tracking (12,502 lines)

### Compatibility
- **Claude Code**: Minimum v2.1.15, Recommended v2.1.20
- **Gemini CLI**: Minimum v0.25.0
- **Node.js**: Minimum v18.0.0

---

## [1.4.5] - 2026-01-27

### Added
- **`/pdca archive` Action**: Complete PDCA cycle with document archiving
  - Move completed PDCA documents to `docs/archive/YYYY-MM/{feature}/`
  - Update Archive Index automatically
  - Remove feature from activeFeatures after archiving
- **`/bkit:functions` Command**: Skills autocomplete workaround (GitHub #10246, #18949)
  - Single entry point showing all available bkit skills
  - Renamed from `/bkit:menu` for clarity
- **8-Language Trigger Completion**: Full multilingual support
  - Added ES, FR, DE, IT triggers to all 11 agents and 21 skills
  - Complete coverage: EN, KO, JA, ZH, ES, FR, DE, IT

### Changed
- **Internationalization**: Korean content translated to English
  - All skill descriptions, guides, and documentation in English
  - 8-language trigger keywords preserved for auto-activation
  - ~600 lines translated, ~100 trigger keywords added
- **`github-integration` Skill**: Made internal-only (company use)
  - Added to `.gitignore`
  - Public skill count: 21 (unchanged, was already counted)
- **Command Renaming**: `/bkit` → `/bkit:menu` → `/bkit:functions`

### Documentation
- Archived 10 completed PDCA features to `docs/archive/2026-01/`
- Added `skills-autocomplete-research-2026-01.md` research report
- Updated all version references across documentation

### Compatibility
- **Claude Code**: Minimum v2.1.15, Recommended v2.1.20
- **Gemini CLI**: Minimum v0.25.0
- **Node.js**: Minimum v18.0.0

---

## [1.4.4] - 2026-01-27

### Added
- **PDCA Skill Integration**: Unified `/pdca` skill with 8 actions
  - `plan`, `design`, `do`, `analyze`, `iterate`, `report`, `status`, `next`
  - Replaces individual `/pdca-*` commands
  - Task Management System integration for tracking
- **hooks-json-integration**: Centralized hook management (GitHub #9354 workaround)
  - `scripts/unified-stop.js` (223 lines) - 14 handlers (10 skills, 4 agents)
  - `scripts/unified-bash-pre.js` (134 lines) - 2 handlers
  - `scripts/unified-write-post.js` (166 lines) - 4 handlers
  - `scripts/unified-bash-post.js` (80 lines) - 1 handler
- **skill-orchestrator.js**: New library module for skill action routing
- **New Skills** (3):
  - `pdca` - Unified PDCA cycle management
  - `code-review` - Code review and quality analysis
  - `claude-code-learning` - Claude Code learning guide

### Changed
- **Commands deprecated**: All `commands/*.md` migrated to Skills
  - See `commands/DEPRECATED.md` for migration guide
  - Commands still available via `commands/gemini/` for Gemini CLI
- **Skills count**: Increased from 18 to 21
- **Scripts count**: Increased from 28 to 39
- **Library modules**: Increased from 6 to 7 (added `skill-orchestrator.js`)
- **Hook system**: Migrated from SKILL.md frontmatter to centralized `hooks.json`
- **bkit feature report**: Updated to use Skills instead of deprecated Commands

### Deprecated
- All commands in `commands/*.md` (use Skills instead)
- SKILL.md frontmatter hooks (use `hooks.json` instead)

### Compatibility
- **Claude Code**: Minimum v2.1.15, Recommended v2.1.20
- **Gemini CLI**: Minimum v0.25.0
- **Node.js**: Minimum v18.0.0

---

## [1.4.3] - 2026-01-26

### Added
- **FR-1.1: Hook Context XML Wrapping Compatibility** - Safe output for Gemini CLI v0.27+ XML-wrapped hook contexts
  - New `xmlSafeOutput()` function in `lib/common.js` for XML special character escaping
  - Characters escaped: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&#39;`
  - Applied to `outputAllow()` and `outputBlock()` functions for Gemini CLI output

### Changed
- **FR-1.2: engines Version Update** - Updated Gemini CLI minimum version requirement
  - `gemini-extension.json`: `engines.gemini-cli` changed from `>=1.0.0` to `>=0.25.0`
  - Reason: Hook System enabled by default since v0.25.0

### Documentation
- **Plan Document**: `docs/01-plan/features/gemini-cli-v026-compatibility.plan.md`
  - Comprehensive compatibility analysis for Gemini CLI v0.25.0 ~ v0.27.0-nightly
  - 12 test tasks completed with Task Management System
  - Test results: beforeAgent/fireAgent not used (compatible), Hook XML wrapping conditionally compatible
- **Design Document**: `docs/02-design/features/gemini-cli-v026-compatibility.design.md`
  - Detailed implementation specification for xmlSafeOutput() function
  - Architecture diagram for Hook System with XML wrapper
  - Test plan with unit test cases and compatibility matrix

### Compatibility
- **Claude Code**: Minimum v2.1.15, Recommended v2.1.19
- **Gemini CLI**: Minimum v0.25.0 (updated from v1.0.0)
- **Node.js**: Minimum v18.0.0

---

## [1.4.2] - 2026-01-26

### Added
- **FR-01: Multi-Level Context Hierarchy** - 4-level context (Plugin → User → Project → Session)
- **FR-02: @import Directive** - External context file loading support
- **FR-03: context:fork** - Skill/Agent isolated context execution
- **FR-04: UserPromptSubmit Hook** - User input preprocessing
- **FR-05: Permission Hierarchy** - deny → ask → allow permission chain
- **FR-06: Task Dependency Chain** - PDCA phase-based task blocking
- **FR-07: Context Compaction Hook** - PDCA state preservation during compaction
- **FR-08: MEMORY Variable** - Session-persistent data storage

### Fixed
- **outputAllow() API Schema**: Removed invalid `decision: 'allow'` from UserPromptSubmit, added `hookEventName` field
- **PreCompact Hook Registration**: Registered in hooks.json to activate context-compaction.js
- **UserPromptSubmit Bug Detection**: Auto-detection for GitHub #20659 plugin bug
- **context:fork Scanning**: SessionStart scans skills for fork configuration
- **Import Preloading**: Common imports checked at session start

### New Files
- `lib/context-hierarchy.js` - Multi-level context management
- `lib/import-resolver.js` - @import directive processing
- `lib/context-fork.js` - Context isolation
- `lib/permission-manager.js` - Permission hierarchy
- `lib/memory-store.js` - Persistent memory storage
- `scripts/user-prompt-handler.js` - UserPromptSubmit hook
- `scripts/context-compaction.js` - PreCompact hook

### Compatibility
- **Claude Code**: Minimum v2.1.15, Recommended v2.1.19
- **Gemini CLI**: Minimum v1.0.0
- **Node.js**: Minimum v18.0.0

---

## [1.4.1] - 2026-01-24

### Added
- **Response Report Rule**: AI Agent automatically reports bkit feature usage at the end of each response
  - Claude Code: Rule added to `hooks/session-start.js` additionalContext
  - Gemini CLI: Response Report Rule section added to `GEMINI.md`
  - Report format: Used features, unused reasons, PDCA phase-based recommendations
- **Claude Code 2.1.19 Compatibility**: Compatibility testing completed
  - 99 components tested and passed
  - No breaking changes confirmed
  - New features (additionalContext, Task System) documented

### Changed
- **Version references**: Updated all version references from 1.4.0 to 1.4.1
- **session-start.js**: v1.4.1 Changes comment and report rule added (+62 lines)
- **GEMINI.md**: Response Report Rule section added (+50 lines)

### Compatibility
- **Claude Code**: Minimum v2.1.15, Recommended v2.1.19
- **Gemini CLI**: Minimum v1.0.0
- **Node.js**: Minimum v18.0.0

---

## [1.4.0] - 2026-01-24

### Added
- ~~**Dual Platform Support**: bkit now supports both Claude Code and Gemini CLI~~ *(Removed in v1.5.0)*
  - ~~New `gemini-extension.json` manifest for Gemini CLI~~ *(Removed in v1.5.0)*
  - ~~New `GEMINI.md` context file (equivalent to CLAUDE.md)~~ *(Removed in v1.5.0)*
  - ~~New `commands/gemini/` directory with TOML-format commands (20 commands)~~ *(Removed in v1.5.0)*
  - ~~Hook mapping: `BeforeTool`/`AfterTool` for Gemini (vs `PreToolUse`/`PostToolUse` for Claude)~~ *(Removed in v1.5.0)*
- **PDCA Status v2.0 Schema**: Multi-feature context management
  - `features` object for tracking multiple features simultaneously
  - `activeFeature` for current working context
  - Auto-migration from v1.0 schema via `migrateStatusToV2()`
- **lib/common.js Expansion**: 86+ functions (up from 38)
  - **Platform Detection**: `detectPlatform()`, ~~`isGeminiCli()`~~ *(Removed in v1.5.0)*, `isClaudeCode()`, `getPluginPath()`
  - **Caching System**: In-memory TTL-based cache (`_cache` object)
  - **Debug Logging**: `debugLog()` with platform-specific paths
  - **Multi-Feature Management**: `setActiveFeature()`, `addActiveFeature()`, `getActiveFeatures()`, `switchFeatureContext()`
  - **Intent Detection**: `detectNewFeatureIntent()`, `matchImplicitAgentTrigger()`, `matchImplicitSkillTrigger()`
  - **Ambiguity Detection**: `calculateAmbiguityScore()`, `generateClarifyingQuestions()`
  - **Requirement Tracking**: `extractRequirementsFromPlan()`, `calculateRequirementFulfillment()`
  - **Phase Validation**: `checkPhaseDeliverables()`, `validatePdcaTransition()`
- **8-Language Intent Detection**: Extended multilingual support
  - EN, KO, JA, ZH (existing)
  - ES (Spanish), FR (French), DE (German), IT (Italian) (new)
  - Implicit agent/skill triggering via natural language keywords
- **New Scripts** (5):
  - `phase-transition.js`: PDCA phase transition validation
  - `phase1-schema-stop.js`: Schema phase completion handler
  - `phase2-convention-stop.js`: Convention phase completion handler
  - `phase3-mockup-stop.js`: Mockup phase completion handler
  - `phase7-seo-stop.js`: SEO/Security phase completion handler

### Changed
- **Script Count**: Increased from 21 to 26
- **hooks/hooks.json**: Updated for Gemini CLI compatibility
- **Environment Variables**:
  - `BKIT_PLATFORM`: Auto-set to "claude" or "gemini"
  - `GEMINI_PROJECT_DIR`: Gemini CLI project directory
- **Agent Descriptions**: Updated all 11 agents with multilingual triggers

### Compatibility
- **Claude Code**: Minimum v2.1.15, Recommended v2.1.17
- ~~**Gemini CLI**: Minimum v1.0.0~~ *(Removed in v1.5.0)*
- **Node.js**: Minimum v18.0.0

---

## [1.3.2] - 2026-01-23

### Fixed
- **Hook Execution Permission**: Added explicit `node` command prefix to all hook commands
  - Fixes "SessionStart:startup hook error" on plugin installation
  - No longer requires `chmod +x` for .js files
  - Pattern: `"command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/xxx.js"`
- **Cross-Platform Compatibility**: Windows users no longer need WSL for hook execution
  - Windows doesn't support shebang (`#!/usr/bin/env node`)
  - Explicit `node` command ensures consistent behavior across all platforms

### Changed
- **hooks/hooks.json**: All 3 hook commands now use `node` prefix
- **skills/*.md**: Updated 7 skill files with `node` command prefix
- **agents/*.md**: Updated 5 agent files with `node` command prefix
- **Documentation**: Updated CUSTOMIZATION-GUIDE.md and bkit-system docs

---

## [1.3.1] - 2026-01-23

### Changed
- **Cross-Platform Hooks**: All 22 hook scripts converted from Bash (.sh) to Node.js (.js)
  - Windows Native environment now fully supported
  - No external dependencies required (jq, bash, wc, grep removed)
  - Shebang: `#!/usr/bin/env node` for universal compatibility
- **lib/common.js**: New centralized library replacing lib/common.sh
  - 30 functions across 9 categories
  - Pure Node.js implementation
  - Synchronous stdin reading for hooks
- **hooks/hooks.json**: Updated all script references from .sh to .js
- **bkit-system documentation**: Updated all references from .sh to .js

### Added
- **hooks/session-start.js**: SessionStart hook converted to Node.js
- **Input Helpers**: New functions for hook input handling
  - `readStdinSync()`: Synchronous JSON input from stdin
  - `readStdin()`: Async version for complex scenarios
  - `parseHookInput()`: Extract common fields from hook input

### Removed
- **Bash Scripts**: All 21 .sh files in scripts/ directory
- **hooks/session-start.sh**: Replaced by session-start.js
- **lib/common.sh**: Replaced by lib/common.js

### Fixed
- **Windows Compatibility**: Hooks now work on Windows without WSL or Git Bash
- **Skills/Agents References**: Updated all .sh references to .js (12 files)
- **Global Hooks**: hooks/hooks.json now references .js files correctly

### Compatibility
- **Minimum Claude Code Version**: 2.1.15
- **Recommended Claude Code Version**: 2.1.17
- **Supported Platforms**: Windows (Native), macOS, Linux

---

## [1.3.0] - 2026-01-22

### Added
- **Check-Act Iteration Loop**: Automatic gap analysis and fix cycles
  - `pdca-iterator` agent orchestrates evaluation-optimization loop
  - Maximum 5 iterations per session with 90% pass threshold
  - Auto-invoked when Match Rate < 90%
- **SessionStart Enhancement**: AskUserQuestion integration for session initialization
  - 4 options: Learn bkit, Learn Claude Code, Continue Previous Work, Start New Project
- **Trigger Keyword Mapping**: Agent auto-triggering based on user keywords
  - verify → gap-detector, improve → pdca-iterator, etc.
- **Task Size Rules**: PDCA application guidance based on change size
  - Quick Fix (<10 lines): No PDCA needed
  - Minor Change (<50 lines): Light PDCA optional
  - Feature (<200 lines): PDCA recommended
  - Major Feature (>=200 lines): PDCA required
- **New Commands**: `/archive`, `/github-stats`

### Changed
- **Version references**: Updated all version references from 1.2.x to 1.3.0
- **Component counts**: Commands increased from 18 to 20

### Compatibility
- **Minimum Claude Code Version**: 2.1.12
- **Recommended Claude Code Version**: 2.1.15

---

## [1.2.3] - 2026-01-22

### Added
- **Claude Code 2.1.15 Impact Analysis**: Added version compatibility documentation
  - `docs/pdca/03-analysis/12-claude-code-2.1.15-impact-analysis.md`
  - npm installation deprecation notice (use `claude install` instead)
  - MCP stdio server timeout fix analysis
  - UI rendering performance improvements

### Changed
- **README Badge Update**: Claude Code version badge updated to v2.1.15+
  - Link updated to official getting-started documentation

### Compatibility
- **Minimum Claude Code Version**: 2.1.12
- **Recommended Claude Code Version**: 2.1.15
- All 2.1.14 improvements (98% context, parallel agents, memory fix) remain available

---

## [1.2.2] - 2026-01-21

### Changed
- **Documentation Structure Reorganization**: Clear separation of docs/ and bkit-system/ roles
  - `bkit-system/` = "What IS" (current implementation reference)
  - `docs/pdca/` = "What WE DO" (active PDCA work)
  - `docs/archive/` = "What WE DID" (completed documents)
- **New Philosophy Section**: Added `bkit-system/philosophy/` with core documentation
  - `core-mission.md`: Core mission & 3 philosophies
  - `ai-native-principles.md`: AI-Native development & Language Tier System
  - `pdca-methodology.md`: PDCA cycle & 9-stage pipeline relationship

### Fixed
- **Broken Wikilinks**: Fixed 30+ broken Obsidian wikilinks across bkit-system/ documentation
  - Updated skill/agent links to point to actual source files
  - Pattern: `[[../../skills/skill-name/SKILL|skill-name]]`

## [1.2.1] - 2026-01-20

### Added
- **Language Tier System**: 4-tier classification for AI-Native development
  - Tier 1 (AI-Native Essential): Python, TypeScript, JavaScript
  - Tier 2 (Mainstream Recommended): Go, Rust, Dart, Vue, Svelte, Astro
  - Tier 3 (Domain Specific): Java, Kotlin, Swift, C/C++
  - Tier 4 (Legacy/Niche): PHP, Ruby, C#, Scala, Elixir
  - Experimental: Mojo, Zig, V
- **New Tier Detection Functions** in `lib/common.js`:
  - `get_language_tier()`: Get tier (1-4, experimental, unknown) for file
  - `get_tier_description()`: Get tier description
  - `get_tier_pdca_guidance()`: Get PDCA guidance based on tier
  - `is_tier_1()`, `is_tier_2()`, `is_tier_3()`, `is_tier_4()`, `is_experimental_tier()`: Tier check helpers
- **New Extension Support**: `.dart`, `.astro`, `.mdx`, `.mojo`, `.zig`, `.v`
- **Tier Guidance in Skills**: Added tier recommendations to starter, dynamic, enterprise, mobile-app, desktop-app skills

### Changed
- **is_code_file()**: Refactored to use Tier constants (30+ extensions)
- **is_ui_file()**: Added `.astro` support
- **CLAUDE.template.md**: Added Tier context section
- **Documentation**: Updated all bkit-system/, docs/, skills/ with Tier system info

### Fixed
- **Environment Variables**: Fixed `CLAUDE_PROJECT_DIR` vs `CLAUDE_PLUGIN_ROOT` usage in hooks
- **Hook JSON Output**: Stabilized JSON output handling with proper exit codes

## [1.2.0] - 2026-01-20

### Added
- **Centralized Configuration**: Added `bkit.config.json` for centralized settings
  - Task classification thresholds
  - Level detection rules
  - PDCA document paths
  - Template configurations
- **Shared Utilities**: Added `lib/common.js` with reusable functions
  - `get_config()`: Read values from bkit.config.json
  - `is_source_file()`: Check if path is source code
  - `extract_feature()`: Extract feature name from file path
  - `classify_task()`: Classify task by content size
  - `detect_level()`: Detect project level
- **Customization Guide**: Added documentation for customizing plugin components
  - Copy from `~/.claude/plugins/bkit/` to project `.claude/`
  - Project-level overrides take priority over plugin defaults
- **Skills Frontmatter Hooks**: Added hooks directly in SKILL.md frontmatter for priority skills
  - `bkit-rules`: SessionStart, PreToolUse (Write|Edit), Stop hooks
  - `bkit-templates`: Template selection automation
- **New Scripts**: Added automation scripts
  - `pre-write.js`: Unified pre-write hook combining PDCA and task classification
  - `select-template.js`: Template selection based on document type and level
  - `task-classify.js`: Task size classification for PDCA guidance

### Changed
- **Repository Structure**: Removed `.claude/` folder from version control
  - Plugin elements now exist only at root level (single source of truth)
  - Local development uses symlinks from `.claude/` to root
  - Users customize by copying from `~/.claude/plugins/bkit/` to project `.claude/`
- **Zero Script QA Hooks**: Converted from `type: "prompt"` to `type: "command"`
- **Template Version**: Bumped PDCA templates from v1.0 to v1.1

### Removed
- **Deprecated Skills**: Consolidated redundant skills into core skills
  - `ai-native-development` → merged into `bkit-rules`
  - `analysis-patterns` → merged into `bkit-templates`
  - `document-standards` → merged into `bkit-templates`
  - `evaluator-optimizer` → available via `/pdca-iterate` command
  - `level-detection` → moved to `lib/common.js`
  - `monorepo-architecture` → merged into `enterprise`
  - `pdca-methodology` → merged into `bkit-rules`
  - `task-classification` → moved to `lib/common.js`
- **Instructions Folder**: Removed deprecated `.claude/instructions/`
  - Content migrated to respective skills

### Fixed
- **Single Source of Truth**: Eliminated dual maintenance between root and `.claude/` folders

## [1.1.4] - 2026-01-15

### Fixed
- Simplified hooks system and enhanced auto-trigger mechanisms
- Added Claude Code hooks analysis document (v2.1.7)

## [1.1.0] - 2026-01-09

### Added
- Initial public release of bkit
- PDCA methodology implementation
- 9-stage Development Pipeline
- Three project levels (Starter, Dynamic, Enterprise)
- 11 specialized agents
- 26 skills for various development phases
- Zero Script QA methodology
- Multilingual support (EN, KO, JA, ZH)
