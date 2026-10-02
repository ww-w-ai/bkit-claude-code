#!/usr/bin/env node
/**
 * bkit Vibecoding Kit - SessionStart Hook (v2.1.40, uses BKIT_VERSION from lib/core/version)
 *
 * Thin orchestrator that delegates to startup modules:
 *   1. migration   - Legacy path migration (docs/ -> .bkit/)
 *   2. restore     - PLUGIN_DATA backup restoration
 *   3. contextInit - Context Hierarchy, Memory Store, Import Resolver, Fork cleanup, ensureBkitDirs
 *   4. onboarding  - Onboarding message generation, env vars, trigger table
 *   5. sessionCtx  - additionalContext string building for hook output
 *   6. dashboard   - PDCA progress bar rendering (prepended to additionalContext)
 *   7. workflowMap - v2.0.0 Workflow map rendering (PDCA phase visualization)
 *   8. controlPanel- v2.0.0 Control panel rendering (automation level display)
 *   9. staleDetect - v2.0.0 Stale feature detection (lifecycle.js)
 */

const { BKIT_PLATFORM } = require('../lib/core/platform');
const { debugLog } = require('../lib/core/debug');
const { readStdinSync } = require('../lib/core/io');

/*
 * v2.1.34: read the hook payload.
 *
 * This handler previously ignored stdin entirely, which cost it two things.
 *
 * First, `source` — Claude Code reports whether the session began via
 * `startup`, `resume`, `clear`, `compact` or `fork`. bkit had no way to tell
 * them apart, and the `once: true` flag it carried in hooks.json to approximate
 * "only on a fresh session" was never honoured there in the first place (it is
 * read only from skill frontmatter). Confirmed by resuming a session and
 * watching this hook fire a second time.
 *
 * Second, dispatch observability: reading through the shared reader stamps
 * `.bkit/runtime/hook-dispatch.ndjson`, which is how the host-integration test
 * proves from the outside that Claude Code really invokes this hook. A hook
 * nobody can observe is how eight bkit features stayed dead across releases.
 *
 * The reader is bounded (issue #139), so this cannot stall the session.
 */
const hookPayload = readStdinSync() || {};
const sessionSource = typeof hookPayload.source === 'string' ? hookPayload.source : null;

// Log session start
debugLog('SessionStart', 'Hook executed', {
  cwd: process.cwd(),
  platform: BKIT_PLATFORM,
  source: sessionSource,
});

// --- ENH-148: Defensive cleanup for env vars that should reset on /clear ---
// CC /clear resets conversation but env vars persist across sessions.
// Clean up bkit-specific runtime env vars to prevent stale state (#37729).
const BKIT_RUNTIME_ENV_VARS = [
  'BKIT_PDCA_PHASE',
  'BKIT_PRIMARY_FEATURE',
  'BKIT_AUTOMATION_LEVEL',
  'BKIT_SESSION_ID',
  'BKIT_AGENT_ACTIVE',
  'BKIT_CHECKPOINT_PENDING',
];

for (const envVar of BKIT_RUNTIME_ENV_VARS) {
  if (process.env[envVar]) {
    debugLog('SessionStart', 'Cleaning stale env var', { envVar, value: process.env[envVar] });
    delete process.env[envVar];
  }
}

// --- 1. Migration: Legacy path migration ---
const migration = require('./startup/migration');
try {
  migration.run();
} catch (e) {
  debugLog('SessionStart', 'Migration module failed', { error: e.message });
}

// --- 2. Restore: PLUGIN_DATA backup restoration ---
const restore = require('./startup/restore');
try {
  restore.run();
} catch (e) {
  debugLog('SessionStart', 'Restore module failed', { error: e.message });
}

// --- 3. Context Init: Hierarchy, Memory, Imports, Forks ---
const contextInit = require('./startup/context-init');
try {
  contextInit.run();
} catch (e) {
  debugLog('SessionStart', 'Context init module failed', { error: e.message });
}

// --- 4. Onboarding: Messages, env vars, trigger table ---
const onboarding = require('./startup/onboarding');
let onboardingContext = { onboardingData: { type: 'new_user', hasExistingWork: false }, triggerTable: '' };
try {
  onboardingContext = onboarding.run();
} catch (e) {
  debugLog('SessionStart', 'Onboarding module failed', { error: e.message });
}

// --- 5. Session Context: Build additionalContext string ---
const sessionContext = require('./startup/session-context');
let additionalContext = '';
try {
  additionalContext = sessionContext.build(null, onboardingContext);
} catch (e) {
  debugLog('SessionStart', 'Session context module failed', { error: e.message });
}

// --- v2.1.1 UI-02: Build dashboard sections in correct display order ---
// Order: Session Context → Progress Bar → Workflow Map → Impact View → Agent Panel → Control Panel
const dashboardSections = [];

// ENH-226 (Issue #77 Phase A): dashboard opt-out gate
// When ui.dashboard.enabled=false, skip rendering all 5 boxes
// (progress / workflow / impact / agent / control).
let _uiDashboardEnabled = true;
let _uiDashboardSections = ['progress', 'workflow', 'impact', 'agent', 'control', 'sqm'];
try {
  const { getUIConfig } = require('../lib/core/config');
  const _ui = getUIConfig();
  if (_ui && _ui.dashboard) {
    _uiDashboardEnabled = _ui.dashboard.enabled !== false;
    if (Array.isArray(_ui.dashboard.sections)) _uiDashboardSections = _ui.dashboard.sections;
  }
} catch (_e) {
  // keep default (true)
}

// Session Context is already in additionalContext (base content)
// It will be placed first in the final output

let pdcaStatus = null;
let agentState = null;

// Load shared state once
try {
  const { getPdcaStatusFull } = require('../lib/pdca/status');
  pdcaStatus = getPdcaStatusFull();
} catch (_) {}

try {
  const fs = require('fs');
  const agentStatePath = require('path').resolve(process.cwd(), '.bkit/runtime/agent-state.json');
  if (fs.existsSync(agentStatePath)) {
    agentState = JSON.parse(fs.readFileSync(agentStatePath, 'utf-8'));

    // v2.1.12 Sprint C-1 (#15 fix): reset stale agent-state when last update
    // is older than `staleFeatureTimeoutDays` (default 7 days from
    // control-state.json guardrails). Previous behaviour: agent-state kept
    // referencing a 13-days-idle feature ("cc-version-issue-response") with
    // an empty sessionId — every new session started by inheriting that
    // stale lifecycle. We now zero the lifecycle fields while preserving
    // the file shape so downstream code that reads it stays safe.
    try {
      const stalePath = require('path').resolve(process.cwd(), '.bkit/runtime/control-state.json');
      let staleDays = 7;
      if (fs.existsSync(stalePath)) {
        const cs = JSON.parse(fs.readFileSync(stalePath, 'utf8'));
        if (cs && cs.guardrails && Number.isFinite(cs.guardrails.staleFeatureTimeoutDays)) {
          staleDays = cs.guardrails.staleFeatureTimeoutDays;
        }
      }
      const lastUpdated = agentState.lastUpdated ? Date.parse(agentState.lastUpdated) : 0;
      const ageDays = lastUpdated > 0 ? (Date.now() - lastUpdated) / (24 * 60 * 60 * 1000) : Infinity;
      if (ageDays > staleDays && agentState.feature) {
        debugLog('SessionStart', 'Stale agent-state detected — resetting lifecycle', {
          feature: agentState.feature,
          ageDays: Math.round(ageDays),
          threshold: staleDays,
        });
        const resetState = {
          ...agentState,
          enabled: false,
          feature: '',
          pdcaPhase: 'idle',
          orchestrationPattern: 'leader',
          ctoAgent: agentState.ctoAgent || 'fable',
          startedAt: null,
          lastUpdated: new Date().toISOString(),
          teammates: [],
          progress: { totalTasks: 0, completedTasks: 0, inProgressTasks: 0, failedTasks: 0, pendingTasks: 0 },
          recentMessages: [],
          sessionId: '',
          // Trace why the reset happened so postmortem can audit
          _resetReason: `stale > ${staleDays} days (was: ${agentState.feature})`,
          _resetAt: new Date().toISOString(),
        };
        fs.writeFileSync(agentStatePath, JSON.stringify(resetState, null, 2) + '\n', 'utf8');
        agentState = resetState;
      }
    } catch (e) {
      debugLog('SessionStart', 'Stale agent-state reset failed', { error: e.message });
    }
  }
} catch (_) { /* non-critical */ }

if (pdcaStatus && pdcaStatus.primaryFeature && _uiDashboardEnabled) {
  // ENH-226: per-section opt-in control via _uiDashboardSections array
  // 6. Progress Bar
  if (_uiDashboardSections.includes('progress')) try {
    const { renderPdcaProgressBar } = require('../lib/ui/progress-bar');
    const dashboardBar = renderPdcaProgressBar(pdcaStatus, { compact: false });
    if (dashboardBar) dashboardSections.push(dashboardBar);
  } catch (e) {
    debugLog('SessionStart', 'PDCA dashboard rendering failed', { error: e.message });
  }

  // 7. Workflow Map
  if (_uiDashboardSections.includes('workflow')) try {
    const { renderWorkflowMap } = require('../lib/ui/workflow-map');
    const workflowMap = renderWorkflowMap(pdcaStatus, agentState, {
      feature: pdcaStatus.primaryFeature,
      showIteration: false,
      showBranch: false
    });
    if (workflowMap) dashboardSections.push(workflowMap);
  } catch (e) {
    debugLog('SessionStart', 'v2.0.0 workflow map rendering failed', { error: e.message });
  }

  // 7.1 v2.1.1 UI-01: Impact View
  if (_uiDashboardSections.includes('impact')) try {
    const { renderImpactView } = require('../lib/ui/impact-view');
    const impactView = renderImpactView(pdcaStatus, null, {});
    if (impactView) dashboardSections.push(impactView);
  } catch (e) {
    debugLog('SessionStart', 'v2.1.1 impact view rendering failed', { error: e.message });
  }

  // 7.2 v2.1.1 UI-01: Agent Panel (skip when inactive to save ~300 tokens)
  if (_uiDashboardSections.includes('agent') && agentState && agentState.enabled) {
    try {
      const { renderAgentPanel } = require('../lib/ui/agent-panel');
      const agentPanel = renderAgentPanel(agentState, {});
      if (agentPanel) dashboardSections.push(agentPanel);
    } catch (e) {
      debugLog('SessionStart', 'v2.1.1 agent panel rendering failed', { error: e.message });
    }
  }

  // 8. Control Panel (last in dashboard)
  if (_uiDashboardSections.includes('control')) try {
    const { renderControlPanel } = require('../lib/ui/control-panel');
    let controlState = null;
    try {
      const fs = require('fs');
      const controlStatePath = require('path').resolve(process.cwd(), '.bkit/runtime/control-state.json');
      if (fs.existsSync(controlStatePath)) {
        controlState = JSON.parse(fs.readFileSync(controlStatePath, 'utf-8'));
      }
    } catch (_) { /* non-critical */ }

    const controlPanel = renderControlPanel(controlState, null, {
      showShortcuts: false,
      showApprovals: true
    });
    if (controlPanel) dashboardSections.push(controlPanel);
  } catch (e) {
    debugLog('SessionStart', 'v2.0.0 control panel rendering failed', { error: e.message });
  }
}

// 9. v2.1.19 S5 F5-2: SQM (Sprint Quality Maturity) panel
// Rendered independently of primaryFeature gate — SQM reflects project-wide
// quality maturity, not a single feature lifecycle. Fail-silent: when no
// baseline measurement exists (.bkit/state/sqm-history.jsonl missing), the
// panel renderer returns an empty string and is skipped.
if (_uiDashboardEnabled && _uiDashboardSections.includes('sqm')) {
  try {
    const sqmHistory = require('../lib/quality/sqm-history');
    const { renderSqmPanel } = require('../lib/ui/sqm-panel');
    const baseline = sqmHistory.latest();
    if (baseline) {
      const sqmPanel = renderSqmPanel({ baseline });
      if (sqmPanel) dashboardSections.push(sqmPanel);
    }
  } catch (e) {
    debugLog('SessionStart', 'v2.1.19 SQM panel rendering failed', { error: e.message });
  }
}

// v2.1.1 UI-02: Combine in correct order (dashboard above session context)
if (dashboardSections.length > 0) {
  additionalContext = dashboardSections.join('\n\n') + '\n\n' + additionalContext;
}

// --- v2.1.11 Sprint α (FR-α4 + FR-α5): Preflight checks ---
// Surface Agent Teams env + CC version warnings near the top of context so the
// user sees them before deeper PDCA detail. Fail-open via the module itself.
try {
  const preflight = require('./startup/preflight');
  const preflightSection = preflight.run();
  if (preflightSection) {
    additionalContext = preflightSection + '\n' + additionalContext;
  }
} catch (e) {
  debugLog('SessionStart', 'Preflight module failed', { error: e.message });
}

// --- 9. v2.0.0 Stale Feature Detection: Warn about idle features ---
try {
  const { detectStaleFeatures } = require('../lib/pdca/lifecycle');
  const staleFeatures = detectStaleFeatures();
  if (staleFeatures.length > 0) {
    let staleWarning = '\n## Stale Feature Warning\n\n';
    staleWarning += 'The following features have been idle and may need attention:\n\n';
    for (const stale of staleFeatures) {
      staleWarning += `- **${stale.feature}**: idle ${stale.daysIdle} days (phase: ${stale.phase}, last activity: ${stale.lastActivity})\n`;
    }
    staleWarning += '\nConsider resuming, archiving, or cleaning up stale features with `/pdca status`.\n';
    additionalContext += staleWarning;
  }
} catch (e) {
  debugLog('SessionStart', 'v2.0.0 stale feature detection failed', { error: e.message });
}

// --- Output Response ---
// ENH-227 (Issue #77 Phase A): single-source generator with opt-out + phase-change-only + stale TTL
const { generateSessionTitle } = require('../lib/pdca/session-title');
const primaryFeature = onboardingContext.onboardingData.primaryFeature || pdcaStatus?.primaryFeature || null;
/*
 * v2.1.34: `pdcaStatus?.currentPhase` — a key the v3 schema does not have. The
 * line directly above already reads `primaryFeature` correctly, so one fallback
 * worked and the next silently did not: the phase component of the session
 * title was null unless onboarding happened to supply it. The phase lives on
 * the feature entry, which is where it is now read from.
 */
const currentPhase = onboardingContext.onboardingData.phase
  || (primaryFeature ? pdcaStatus?.features?.[primaryFeature]?.phase : null)
  || null;
// GitHub #119: Claude Code exposes CLAUDE_CODE_SESSION_ID (not CLAUDE_SESSION_ID).
// Reading the legacy name made sessionId null on SessionStart → the per-session
// `·a1b2` title tag from #111 never applied → concurrent same-repo sessions
// rendered identical titles. Prefer the CC var, keep legacy as back-compat fallback.
const sessionIdForFp = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || 'default';
const sessionTitle = generateSessionTitle({
  feature: primaryFeature,
  phase: currentPhase,
  sessionId: sessionIdForFp === 'default' ? null : sessionIdForFp,
  // ENH-419 (v2.1.33), Issue #77: SessionStart receives the title already in
  // effect — from `--name`, `/rename`, or a resumed session — and bkit must not
  // replace one the user chose. Documented at code.claude.com/docs/en/hooks.md:1039.
  currentTitle: (typeof input === 'object' && input) ? input.session_title : undefined,
});

// ENH-239 (Issue #81 Phase B): SHA-256 fingerprint dedup lock
// Prevents duplicate injection of identical payloads caused by
// PreCompact/PostCompact re-fires. 1-hour TTL, multi-session
// isolation, fail-open design.
try {
  const { computeFingerprint, shouldDedup, record } = require('../lib/core/session-ctx-fp');
  const fp = computeFingerprint(additionalContext);
  if (shouldDedup(sessionIdForFp, fp)) {
    debugLog('SessionStart', 'ENH-239 dedup hit', { sessionId: sessionIdForFp, fp });
    additionalContext = '';
  } else {
    record(sessionIdForFp, fp);
  }
} catch (e) {
  debugLog('SessionStart', 'ENH-239 fingerprint failed', { error: e.message });
  // fail-open: keep prior behavior
}

// Sprint 4.5 Integration: cc-regression lifecycle reconcile.
// Marks Guards as resolved when CC version ≥ expectedFix. Fire-and-forget.
try {
  const ccRegression = require('../lib/cc-regression');
  const ccVersion = ccRegression.detectCCVersion();
  if (ccVersion) {
    const result = ccRegression.reconcile(ccRegression.CC_REGRESSIONS, ccVersion);
    const newlyResolved = (result.resolved || []).filter((g) => g.resolvedBy === ccVersion);
    if (newlyResolved.length > 0) {
      debugLog('SessionStart', 'cc-regression auto-deactivated', {
        ccVersion,
        resolved: newlyResolved.map((g) => g.id),
      });
    }
  }
} catch (e) {
  debugLog('SessionStart', 'cc-regression reconcile failed', { error: e.message });
  // fail-open
}

const { BKIT_VERSION } = require('../lib/core/version');

// --- v2.1.11 Sprint α (FR-α3-b/c): First-Run AUQ tutorial ---
// On the very first session in a project, show a 3-option AUQ that introduces
// bkit. The marker `.bkit/runtime/first-run-seen.json` is created on exposure
// (idempotent). When this prompt is active it takes priority over the existing
// onboarding userPrompt — first impression > resume.
let firstRunPayload = null;
try {
  const firstRun = require('./startup/first-run');
  firstRunPayload = firstRun.run();
} catch (e) {
  debugLog('SessionStart', 'first-run module failed', { error: e.message });
}

// ============================================================
// v2.1.14 Sub-Sprint 2 (MON-CC-NEW-PLUGIN-HOOK-DROP): Hook reachability sanity
// ============================================================
// CC #57317 5-streak: plugin-bundled PostToolUse hooks may be silently dropped
// by CC even though they appear in hooks.json. We detect this drop indirectly:
// each PostToolUse hook (Bash/Write/Skill) writes its timestamp to
// .bkit/runtime/hook-reachability.json on every fire. On SessionStart we read
// the file and verify all three hooks fired within a recency window. A missing
// or stale stamp signals an unhealthy hook configuration; we emit an audit
// entry + warn the user via additionalContext. All file IO is fail-silent.
//
// Acceptance: the absence of evidence is itself signal — if hook-reachability
// has never been written, we treat that as "first run after install" and skip.
// ============================================================
try {
  const fs = require('fs');
  const path = require('path');
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const reachFile = path.join(root, '.bkit', 'runtime', 'hook-reachability.json');
  if (fs.existsSync(reachFile)) {
    const STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
    let state = {};
    try { state = JSON.parse(fs.readFileSync(reachFile, 'utf8')); } catch (_) { state = {}; }
    // #126: classify drop vs. idle via the pure evaluator. skill_post is
    // event-driven (only fires on PostToolUse(Skill), which slash-command skill
    // invocation never produces), so a missing/stale skill_post is suppressed
    // unless a canary (bash_post/write_post) corroborates a real loader drop
    // (#57317). See lib/core/hook-reachability.js for the full rationale.
    const { evaluateReachability, buildReachabilityWarning } = require('../lib/core/hook-reachability');
    const { missing, stale, expected, canaryUnhealthy, skillPostIdle, shouldWarn } =
      evaluateReachability(state, { now: Date.now(), staleThresholdMs: STALE_THRESHOLD_MS });
    if (skillPostIdle) {
      debugLog('SessionStart', 'skill_post idle (event-driven; no Skill tool_use this session) — suppressed from reachability warning, canaries healthy');
    }
    if (shouldWarn) {
      try {
        const audit = require('../lib/audit/audit-logger');
        audit.writeAuditLog({
          actor: 'hook', actorId: 'session-start',
          action: 'hook_reachability_lost', category: 'system',
          target: 'PostToolUse', targetType: 'config',
          details: { missing, stale, expected, canaryUnhealthy, skillPostIdle, file: reachFile },
          result: 'blocked',
          reason: `bkit MON-CC-NEW-PLUGIN-HOOK-DROP: PostToolUse hook reachability lost. missing=[${missing.join(',')}] stale=[${stale.join(',')}]`,
        });
      } catch (_) { /* graceful */ }
      // fix-preflight-hookdrop-mislead: warning text lives in the pure builder
      // (lib/core/hook-reachability.js) so it is unit-testable without running
      // this script (session-start.js is main-guard-less and process.exits).
      const warnMsg = buildReachabilityWarning(missing, stale, reachFile);
      additionalContext = warnMsg + (additionalContext ? '\n' + additionalContext : '');
    }
  }
} catch (_) { /* reachability check unavailable — fail-open */ }

// ============================================================
// v2.1.14 Sub-Sprint 3 (ENH-293, CARRY-5 closure): OTEL env capture
// ============================================================
// CC plugin-hook subprocesses inherit only a minimal env from the CC parent.
// User-configured OTEL_* variables (set in their shell before launching
// `claude`) are visible in SessionStart but lost when PostToolUse/PreToolUse
// hooks spawn — telemetry.js then sees no endpoint and emits zero entries
// (root cause of CARRY-5 #17 token-meter Adapter zero entries). We snapshot
// the OTEL_* vars to .bkit/runtime/otel-env.json here so hook subprocesses
// can hydrate them on entry. Fail-silent; if capture fails, telemetry keeps
// its prior process.env-only behavior (graceful degrade, zero overhead).
// ============================================================
try {
  const capturer = require('../lib/infra/otel-env-capturer');
  const result = capturer.captureEnv(process.env, { version: BKIT_VERSION });
  if (result && result.ok && result.count > 0) {
    debugLog('SessionStart', 'OTEL env captured for hook subprocesses', {
      count: result.count, captured: result.captured, file: result.file,
    });
  }
} catch (_) { /* capture unavailable — telemetry falls back to process.env */ }

// ============================================================
// v2.1.14 Sub-Sprint 4 (ENH-286, differentiation #1): Memory Enforcer cache
// ============================================================
// CC reads CLAUDE.md but treats its directives as advisory — the model can
// silently override them (#56865/#57485/#58887 evolved-form sightings).
// bkit hard-enforces by extracting "Do NOT/NEVER/FORBIDDEN/MUST NOT" lines
// at SessionStart and caching them to .bkit/runtime/memory-directives.json.
// PreToolUse hooks (Bash) then short-circuit on a deny match. Fail-silent;
// if extraction fails or no CLAUDE.md exists, enforcement skips and CC's
// native advisory behavior stands unchanged.
// ============================================================
try {
  const fs = require('fs');
  const path = require('path');
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const candidates = [
    path.join(root, '.claude', 'CLAUDE.md'),
    path.join(root, 'CLAUDE.md'),
  ];
  let combined = '';
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try { combined += fs.readFileSync(file, 'utf8') + '\n'; } catch (_) { /* graceful */ }
    }
  }
  if (combined.length > 0) {
    const { extractMemoryDirectives, serializeMemoryDirectives } = require('../lib/defense');
    const directives = extractMemoryDirectives(combined, { source: 'CLAUDE.md' });
    if (directives.length > 0) {
      const payload = serializeMemoryDirectives(directives);
      const dir = path.join(root, '.bkit', 'runtime');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'memory-directives.json');
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      debugLog('SessionStart', 'Memory Enforcer directives cached', { count: payload.count });
    }
  }
} catch (_) { /* directive extraction unavailable — CC advisory behavior stands */ }

const response = {
  systemMessage: `bkit Vibecoding Kit v${BKIT_VERSION} activated (Claude Code)`,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    onboardingType: onboardingContext.onboardingData.type,
    hasExistingWork: onboardingContext.onboardingData.hasExistingWork,
    primaryFeature: primaryFeature,
    currentPhase: currentPhase,
    matchRate: onboardingContext.onboardingData.matchRate || null,
    additionalContext: additionalContext,
    sessionTitle,
    // v2.1.11 FR-α3 takes priority on first run; otherwise v2.1.1 H-01 onboarding prompt
    userPrompt: (firstRunPayload && firstRunPayload.userPrompt)
      || onboardingContext.onboardingData.userPrompt
      || undefined,
  }
};

console.log(JSON.stringify(response));
process.exit(0);
