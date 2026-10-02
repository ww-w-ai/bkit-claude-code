/**
 * @module pdca/state-transitions
 * @version 2.1.21
 */

'use strict';
/**
 * state-transitions.js — declarative PDCA state-machine DATA.
 *
 * Extracted verbatim from lib/pdca/state-machine.js (v2.1.22 S3a ENH-344 god-file
 * split): STATES + EVENTS + TRANSITIONS table + GUARDS + ACTIONS registries.
 * GUARDS/ACTIONS are self-contained (use only getCore/getStatus/getPhase + args,
 * no state-machine logic calls), so the 3 lazy getters are duplicated here
 * (identical '../core'/'./status'/'./phase' paths — same lib/pdca directory).
 * state-machine.js imports { STATES, EVENTS, TRANSITIONS, GUARDS, ACTIONS } and
 * re-exports them — public API unchanged.
 *
 * @module lib/pdca/state-transitions
 */

// v2.1.22 S5 regression fix: the GUARDS/ACTIONS extracted here use `fs` and
// `path` (saveResumePoint/restoreFromResume/checkpoint actions). These imports
// existed at the top of the original state-machine.js but were NOT carried over
// during the S3a god-file split, so the actions relied on a leaked global and
// threw "path is not defined" when loaded in a process without that leak
// (caught by transition()'s action loop → action silently dropped from
// executedActions, breaking pdca-lifecycle LC-16). Declare them explicitly.
const fs = require('fs');
const path = require('path');

// Lazy requires (duplicated from state-machine.js — same lib/pdca relative paths)
let _core = null;
function getCore() {
  if (!_core) { _core = require('../core'); }
  return _core;
}

let _status = null;
function getStatus() {
  if (!_status) { _status = require('./status'); }
  return _status;
}

let _phase = null;
function getPhase() {
  if (!_phase) { _phase = require('./phase'); }
  return _phase;
}

// ── Event Name Helper ───────────────────────────────────────────────

/**
 * Resolve an event identifier to its name.
 *
 * `transition()` accepts either a string or a `{event, target, guard}` object
 * and passes the caller's raw form through to actions, so an action that
 * branches on the event has to normalise it the same way the machine does.
 *
 * @param {string|{event:string}} event
 * @returns {string|null}
 * @private
 */
function _eventName(event) {
  if (typeof event === 'string') return event;
  if (event && typeof event === 'object' && typeof event.event === 'string') return event.event;
  return null;
}

// ── Chrome MCP Availability Helper ──────────────────────────────────

/**
 * Check Chrome MCP availability.
 *
 * This used to be a second, independent copy of the `MCP_SERVERS` check that
 * lib/qa/chrome-bridge.js also carried — two detectors that had to be fixed in
 * two places and could disagree. It now delegates to the bridge, which is the
 * module that owns the question. Lazy-required so a bridge load failure cannot
 * break the state machine at import time.
 *
 * @returns {boolean}
 */
function _checkChromeMcpAvailable() {
  try {
    return require('../qa/chrome-bridge').checkChromeAvailable().available;
  } catch (_) {
    return false;
  }
}

// ── Valid States & Events ───────────────────────────────────────────

/** @type {string[]} All valid PDCA states */
const STATES = [
  'idle', 'pm', 'plan', 'design', 'do',
  'check', 'act', 'qa', 'report', 'archived', 'error'
];

/** @type {string[]} All valid PDCA events */
const EVENTS = [
  'START', 'SKIP_PM',
  'PM_DONE', 'PLAN_DONE', 'DESIGN_DONE', 'DO_COMPLETE',
  'MATCH_PASS', 'ITERATE', 'ANALYZE_DONE',
  'QA_PASS', 'QA_FAIL', 'QA_SKIP', 'QA_RETRY',
  'REPORT_DONE', 'ARCHIVE',
  'REJECT',
  'ERROR', 'RECOVER', 'RESET', 'ROLLBACK',
  'TIMEOUT', 'ABANDON'
];

// ── Transition Table (25 entries) ───────────────────────────────────

/**
 * Declarative transition table.
 * from:'*' matches any state.  to:'*' means dynamic (resolved by action).
 * @type {Array<{from:string, event:string, to:string, guard:string|null, actions:string[], description:string}>}
 */
const TRANSITIONS = [
  // ── Normal forward flow ──
  {
    from: 'idle', event: 'START', to: 'pm',
    guard: null,
    actions: ['initFeature', 'recordTimestamp'],
    description: 'New feature PDCA cycle begins'
  },
  {
    from: 'idle', event: 'SKIP_PM', to: 'plan',
    guard: null,
    actions: ['initFeature', 'recordTimestamp'],
    description: 'Skip PM phase, start directly with Plan'
  },
  {
    from: 'pm', event: 'PM_DONE', to: 'plan',
    guard: 'guardDeliverableExists',
    actions: ['recordTimestamp', 'notifyPhaseComplete'],
    description: 'PM analysis complete, proceed to Plan'
  },
  {
    from: 'plan', event: 'PLAN_DONE', to: 'design',
    guard: 'guardDeliverableExists',
    actions: ['recordTimestamp', 'notifyPhaseComplete'],
    description: 'Plan document complete, proceed to Design'
  },
  {
    from: 'design', event: 'DESIGN_DONE', to: 'do',
    guard: 'guardDesignApproved',
    actions: ['recordTimestamp', 'notifyPhaseComplete', 'createCheckpoint'],
    description: 'Design approved, proceed to implementation'
  },
  {
    from: 'do', event: 'DO_COMPLETE', to: 'check',
    guard: 'guardDoComplete',
    actions: ['recordTimestamp', 'notifyPhaseComplete'],
    description: 'Implementation complete, proceed to analysis'
  },
  {
    from: 'check', event: 'MATCH_PASS', to: 'qa',
    guard: 'guardMatchRatePass',
    actions: ['recordTimestamp', 'notifyPhaseComplete', 'recordMatchRate', 'initQaPhase'],
    description: 'Match rate >= threshold, proceed to QA testing'
  },
  {
    from: 'check', event: 'ITERATE', to: 'act',
    guard: 'guardCanIterate',
    actions: ['recordTimestamp', 'incrementIteration'],
    description: 'Match rate < threshold, iterate improvement'
  },
  {
    from: 'act', event: 'ANALYZE_DONE', to: 'check',
    guard: null,
    actions: ['recordTimestamp'],
    description: 'Act iteration done, re-analyze'
  },

  // ── QA Phase transitions (v2.1.1) ──
  {
    from: 'qa', event: 'QA_PASS', to: 'report',
    guard: 'guardQaPass',
    actions: ['recordTimestamp', 'notifyPhaseComplete', 'recordQaResult', 'generateQaReport'],
    description: 'QA tests passed, proceed to Report'
  },
  {
    from: 'qa', event: 'QA_FAIL', to: 'act',
    guard: null,
    actions: ['recordTimestamp', 'recordQaResult', 'markQaRetryPending'],
    description: 'QA tests failed, return to Act for fixes'
  },
  {
    from: 'qa', event: 'QA_SKIP', to: 'report',
    guard: null,
    actions: ['recordTimestamp', 'recordQaResult'],
    description: 'QA skipped (Chrome unavailable or user opt-out), proceed to Report'
  },
  {
    from: 'act', event: 'QA_RETRY', to: 'qa',
    // br018: this edge was unguarded, so the act<->qa loop could bounce
    // forever (qaRetryCount hit 187) — the ceiling escape
    // (qa -> report / REPORT_DONE / guardQaMaxRetryReached) exists in the
    // table but nothing emits it, leaving QA_RETRY as the only live edge
    // out of act. The guard makes the loop TERMINATE at maxQaRetries:
    // the transition fail-stops with a distinct blockedBy + message.
    guard: 'guardQaRetryNotExhausted',
    actions: ['recordTimestamp', 'initQaPhase'],
    description: 'After Act fixes, retry QA testing (blocked at maxQaRetries)'
  },

  {
    from: 'report', event: 'REPORT_DONE', to: 'archived',
    guard: null,
    actions: ['recordTimestamp', 'notifyPhaseComplete', 'archiveDocuments', 'cleanupFeature'],
    description: 'Report generation complete, archive feature'
  },
  {
    from: 'report', event: 'ARCHIVE', to: 'archived',
    guard: null,
    actions: ['recordTimestamp', 'archiveDocuments', 'cleanupFeature'],
    description: 'Archive completed feature'
  },

  // ── Special transitions ──
  {
    from: 'check', event: 'REPORT_DONE', to: 'report',
    guard: 'guardMaxIterReached',
    actions: ['recordTimestamp', 'forceReport'],
    description: 'Max iterations reached, force report generation'
  },
  {
    from: 'qa', event: 'REPORT_DONE', to: 'report',
    guard: 'guardQaMaxRetryReached',
    actions: ['recordTimestamp', 'forceReport', 'recordQaResult'],
    description: 'Max QA retries reached, force report generation'
  },
  {
    from: 'pm', event: 'REJECT', to: 'idle',
    guard: null,
    actions: ['recordTimestamp', 'cleanupFeature'],
    description: 'PM analysis rejected, return to idle'
  },
  {
    from: 'plan', event: 'REJECT', to: 'pm',
    guard: null,
    actions: ['recordTimestamp'],
    description: 'Plan rejected, return to PM'
  },

  // ── Error / Recovery ──
  {
    from: '*', event: 'ERROR', to: 'error',
    guard: null,
    actions: ['recordTimestamp', 'saveResumePoint', 'notifyError'],
    description: 'Error occurred, save state for recovery'
  },
  {
    from: 'error', event: 'RECOVER', to: '*',
    guard: 'guardResumeAvailable',
    actions: ['recordTimestamp', 'restoreFromResume'],
    description: 'Recover from error using saved resume point'
  },
  {
    from: '*', event: 'RESET', to: 'idle',
    guard: null,
    actions: ['recordTimestamp', 'cleanupFeature'],
    description: 'Reset feature to idle state'
  },
  {
    from: '*', event: 'ROLLBACK', to: '*',
    guard: 'guardCheckpointExists',
    actions: ['recordTimestamp', 'restoreCheckpoint'],
    description: 'Rollback to previous checkpoint'
  },

  // ── Timeout / Abandon ──
  {
    from: '*', event: 'TIMEOUT', to: 'archived',
    guard: 'guardStaleFeature',
    actions: ['recordTimestamp', 'archiveStale'],
    description: 'Stale feature auto-archived (7 days inactive)'
  },
  {
    from: '*', event: 'ABANDON', to: 'archived',
    guard: null,
    actions: ['recordTimestamp', 'archiveAbandoned'],
    description: 'Feature explicitly abandoned'
  },
];

// ── Guard Functions ─────────────────────────────────────────────────

/**
 * Guard registry. Each guard receives context and returns boolean.
 * @type {Object<string, function(Object): boolean>}
 */
const GUARDS = {
  /**
   * Check that the current phase deliverable (document) exists
   * @param {Object} ctx - StateMachineContext
   * @returns {boolean}
   */
  guardDeliverableExists(ctx) {
    const { checkPhaseDeliverables } = getPhase();
    const result = checkPhaseDeliverables(ctx.currentState, ctx.feature);
    return result.exists === true;
  },

  /**
   * Check design doc is approved (auto-pass in semi-auto/full-auto)
   * @param {Object} ctx
   * @returns {boolean}
   */
  guardDesignApproved(ctx) {
    const level = ctx.automationLevel || 0;
    // L2+ auto-approve if design doc exists
    if (level >= 2) {
      const { checkPhaseDeliverables } = getPhase();
      return checkPhaseDeliverables('design', ctx.feature).exists === true;
    }
    // L0-L1: require explicit approval flag
    return ctx.metadata?.designApproved === true;
  },

  /**
   * Check Do completion (3-layer detection result in metadata)
   * @param {Object} ctx
   * @returns {boolean}
   */
  guardDoComplete(ctx) {
    return ctx.metadata?.doCompletionResult?.complete === true;
  },

  /**
   * Match rate meets threshold (default 100% with QA phase, override via config)
   * @param {Object} ctx
   * @returns {boolean}
   */
  guardMatchRatePass(ctx) {
    const { getConfig } = getCore();
    // v2.1.10 Sprint 7b (G-P-01): SSoT → bkit.config.json:pdca.matchRateThreshold (default 90)
    const threshold = getConfig('pdca.matchRateThreshold', 90);
    // v2.1.34: an unmeasured rate never satisfies the guard. Previously `|| 0`
    // produced the same answer by accident; stating it makes the intent
    // survive the next edit, and routes through the one module that owns
    // the three-state semantics.
    return require('../quality/match-rate').allowsAdvance(ctx.matchRate, threshold);
  },

  /**
   * More iterations are allowed
   * @param {Object} ctx
   * @returns {boolean}
   */
  guardCanIterate(ctx) {
    return (ctx.iterationCount || 0) < (ctx.maxIterations || 5);
  },

  /**
   * Max iteration count reached
   * @param {Object} ctx
   * @returns {boolean}
   */
  guardMaxIterReached(ctx) {
    return (ctx.iterationCount || 0) >= (ctx.maxIterations || 5);
  },

  /**
   * Resume data exists for error recovery
   * @param {Object} ctx
   * @returns {boolean}
   */
  guardResumeAvailable(ctx) {
    const core = getCore();
    // M8 fix (audit): validate ctx.feature before it reaches path.join.
    core.validateFeatureName(ctx.feature);
    const { PROJECT_DIR } = core;
    const resumePath = path.join(
      PROJECT_DIR, '.bkit', 'state', 'resume', `${ctx.feature}.resume.json`
    );
    return fs.existsSync(resumePath);
  },

  /**
   * Checkpoint exists for rollback
   * @param {Object} ctx
   * @returns {boolean}
   */
  guardCheckpointExists(ctx) {
    const { PROJECT_DIR } = getCore();
    const cpDir = path.join(PROJECT_DIR, '.bkit', 'checkpoints');
    if (!fs.existsSync(cpDir)) return false;
    try {
      const files = fs.readdirSync(cpDir);
      return files.some(f => f.includes(ctx.feature));
    } catch (_) {
      return false;
    }
  },

  /**
   * Feature inactive for 7+ days
   * @param {Object} ctx
   * @returns {boolean}
   */
  guardStaleFeature(ctx) {
    const lastUpdated = ctx.timestamps?.lastUpdated;
    if (!lastUpdated) return false;
    const elapsed = Date.now() - new Date(lastUpdated).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    return elapsed >= sevenDays;
  },

  /**
   * QA pass rate meets threshold and no critical failures
   * @param {Object} ctx
   * @returns {boolean}
   */
  guardQaPass(ctx) {
    const passRate = ctx.qaPassRate || 0;
    const criticalCount = ctx.qaCriticalCount || 0;
    return passRate >= 95 && criticalCount === 0;
  },

  /**
   * Max QA retry attempts reached
   * @param {Object} ctx
   * @returns {boolean}
   */
  guardQaMaxRetryReached(ctx) {
    return (ctx.qaRetryCount || 0) >= (ctx.maxQaRetries || 3);
  },

  /**
   * QA retry budget NOT yet exhausted (br018).
   *
   * Guards the act -> qa QA_RETRY edge. Inverse of guardQaMaxRetryReached:
   * while retries remain the loop may continue; once qaRetryCount reaches
   * maxQaRetries the transition is blocked and the machine fail-stops in
   * act instead of silently re-entering qa.
   * @param {Object} ctx
   * @returns {boolean}
   */
  guardQaRetryNotExhausted(ctx) {
    return (ctx.qaRetryCount || 0) < (ctx.maxQaRetries || 3);
  },
};

// ── Action Functions ────────────────────────────────────────────────

/**
 * Action registry. Each action executes side-effects.
 * @type {Object<string, function(Object, string): void>}
 */
const ACTIONS = {
  /** Initialize feature in pdca-status.json */
  initFeature(ctx, _event) {
    const { updatePdcaStatus } = getStatus();
    updatePdcaStatus(ctx.feature, ctx.currentState, {
      iterationCount: 0,
      matchRate: null,
    });
  },

  /** Record timestamp for current phase */
  recordTimestamp(ctx, _event) {
    ctx.timestamps = ctx.timestamps || {};
    ctx.timestamps[ctx.currentState] = new Date().toISOString();
    ctx.timestamps.lastUpdated = new Date().toISOString();
  },

  /** Notify phase completion (logs) */
  notifyPhaseComplete(ctx, _event) {
    const { debugLog } = getCore();
    debugLog('PDCA-SM', `Phase complete: ${ctx.currentState}`, {
      feature: ctx.feature,
    });
  },

  /** Create checkpoint before Do phase */
  createCheckpoint(ctx, _event) {
    const core = getCore();
    // M8 fix (audit): validate ctx.feature before it reaches path.join.
    core.validateFeatureName(ctx.feature);
    const { debugLog, PROJECT_DIR } = core;
    const cpDir = path.join(PROJECT_DIR, '.bkit', 'checkpoints');
    try {
      if (!fs.existsSync(cpDir)) {
        fs.mkdirSync(cpDir, { recursive: true });
      }
      const cpFile = path.join(cpDir, `cp-${ctx.feature}-${Date.now()}.json`);
      // H1 fix (audit): atomic checkpoint write.
      core.stateStore.write(cpFile, {
        feature: ctx.feature,
        state: ctx.currentState,
        timestamp: new Date().toISOString(),
        context: { matchRate: ctx.matchRate, iterationCount: ctx.iterationCount },
      });
      debugLog('PDCA-SM', 'Checkpoint created', { file: cpFile });
    } catch (_) { /* non-critical */ }
  },

  /** Record match rate in context */
  recordMatchRate(ctx, _event) {
    const { updatePdcaStatus } = getStatus();
    updatePdcaStatus(ctx.feature, ctx.currentState, {
      matchRate: ctx.matchRate,
    });
  },

  /** Increment iteration counter */
  incrementIteration(ctx, _event) {
    ctx.iterationCount = (ctx.iterationCount || 0) + 1;
    const { updatePdcaStatus } = getStatus();
    updatePdcaStatus(ctx.feature, ctx.currentState, {
      iterationCount: ctx.iterationCount,
    });
  },

  /** Archive PDCA documents */
  archiveDocuments(ctx, _event) {
    const { debugLog } = getCore();
    debugLog('PDCA-SM', 'Archiving documents', { feature: ctx.feature });
    // Actual file archival delegated to existing archive skill
  },

  /** Remove feature from active list */
  cleanupFeature(ctx, _event) {
    const { removeActiveFeature } = getStatus();
    removeActiveFeature(ctx.feature);
  },

  /** Force report generation when max iterations reached */
  forceReport(ctx, _event) {
    const { debugLog } = getCore();
    debugLog('PDCA-SM', 'Max iterations reached, forcing report', {
      feature: ctx.feature,
      iterations: ctx.iterationCount,
    });
  },

  /** Save resume point for error recovery */
  saveResumePoint(ctx, _event) {
    const core = getCore();
    // M8 fix (audit): validate ctx.feature before it reaches path.join.
    core.validateFeatureName(ctx.feature);
    const { PROJECT_DIR, debugLog } = core;
    const resumeDir = path.join(PROJECT_DIR, '.bkit', 'state', 'resume');
    try {
      if (!fs.existsSync(resumeDir)) {
        fs.mkdirSync(resumeDir, { recursive: true });
      }
      const resumeFile = path.join(resumeDir, `${ctx.feature}.resume.json`);
      // H1 fix (audit): atomic resume-point write (gates error-recovery).
      core.stateStore.write(resumeFile, {
        feature: ctx.feature,
        previousState: ctx.currentState,
        timestamp: new Date().toISOString(),
        context: {
          matchRate: ctx.matchRate,
          iterationCount: ctx.iterationCount,
        },
      });
      debugLog('PDCA-SM', 'Resume point saved', { feature: ctx.feature });
    } catch (_) { /* non-critical */ }
  },

  /** Log error notification */
  notifyError(ctx, _event) {
    const { debugLog } = getCore();
    debugLog('PDCA-SM', 'Error in PDCA cycle', {
      feature: ctx.feature,
      state: ctx.currentState,
      error: ctx.metadata?.error,
    });
  },

  /** Restore from resume data */
  restoreFromResume(ctx, _event) {
    const core = getCore();
    // M8 fix (audit): validate ctx.feature before it reaches path.join.
    core.validateFeatureName(ctx.feature);
    const { PROJECT_DIR, debugLog } = core;
    const resumeFile = path.join(
      PROJECT_DIR, '.bkit', 'state', 'resume', `${ctx.feature}.resume.json`
    );
    try {
      if (fs.existsSync(resumeFile)) {
        const data = JSON.parse(fs.readFileSync(resumeFile, 'utf8'));
        ctx.currentState = data.previousState || 'idle';
        ctx.matchRate = data.context?.matchRate || ctx.matchRate;
        ctx.iterationCount = data.context?.iterationCount || ctx.iterationCount;
        fs.unlinkSync(resumeFile);
        debugLog('PDCA-SM', 'Restored from resume', { feature: ctx.feature, state: ctx.currentState });
      }
    } catch (_) { /* non-critical */ }
  },

  /** Restore from checkpoint */
  restoreCheckpoint(ctx, _event) {
    const { PROJECT_DIR, debugLog } = getCore();
    const cpDir = path.join(PROJECT_DIR, '.bkit', 'checkpoints');
    try {
      const files = fs.readdirSync(cpDir)
        .filter(f => f.includes(ctx.feature))
        .sort()
        .reverse();
      if (files.length > 0) {
        const cpData = JSON.parse(fs.readFileSync(path.join(cpDir, files[0]), 'utf8'));
        ctx.currentState = cpData.state || 'idle';
        // v2.1.34: a checkpoint taken before any measurement restores as
        // unmeasured, not as 0%.
        ctx.matchRate = require('../quality/match-rate').isMeasured(cpData.context?.matchRate)
          ? cpData.context.matchRate
          : null;
        ctx.iterationCount = cpData.context?.iterationCount || 0;
        debugLog('PDCA-SM', 'Restored from checkpoint', { feature: ctx.feature, state: ctx.currentState });
      }
    } catch (_) { /* non-critical */ }
  },

  /** Archive stale (timed-out) feature */
  archiveStale(ctx, _event) {
    const { debugLog } = getCore();
    const { updatePdcaStatus } = getStatus();
    updatePdcaStatus(ctx.feature, 'archived', {
      timestamps: { archivedAt: new Date().toISOString() },
      archivedReason: 'timeout',
    });
    debugLog('PDCA-SM', 'Stale feature archived', { feature: ctx.feature });
  },

  /** Archive abandoned feature */
  archiveAbandoned(ctx, _event) {
    const { debugLog } = getCore();
    const { updatePdcaStatus } = getStatus();
    updatePdcaStatus(ctx.feature, 'archived', {
      timestamps: { archivedAt: new Date().toISOString() },
      archivedReason: 'abandoned',
    });
    debugLog('PDCA-SM', 'Abandoned feature archived', { feature: ctx.feature });
  },

  // ── QA Phase Actions (v2.1.1) ──

  /**
   * Flag that this feature owes a QA retry.
   *
   * `act -> qa` (QA_RETRY) is the only route back into QA after a failure, and
   * nothing emitted the event: unified-stop maps the act phase to ANALYZE_DONE
   * unconditionally, so a QA failure went to act and then rejoined the ordinary
   * act -> check loop, never returning to the phase that rejected it. The
   * transition, its retry counter, and its `initQaPhase` action were all
   * unreachable. This marks the debt on the status entry so unified-stop can
   * pay it on the next act completion.
   */
  markQaRetryPending(ctx, _event) {
    const { updatePdcaStatus } = getStatus();
    updatePdcaStatus(ctx.feature, ctx.currentState, { qaRetryPending: true });
  },

  /**
   * Initialize QA phase state
   * Sets up QA context: test plan reference, Chrome availability, retry count
   *
   * Runs on both entries into qa — `check -> qa` (first attempt) and
   * `act -> qa` (QA_RETRY) — so the retry counter advances on the retry event
   * only. It previously read `ctx.qaRetryCount || 0` and wrote the same value
   * straight back, which meant the counter never moved and
   * `guardQaMaxRetryReached` could not fire no matter how many times a feature
   * went round.
   */
  initQaPhase(ctx, event) {
    const { debugLog } = getCore();
    const { updatePdcaStatus } = getStatus();

    const isRetry = _eventName(event) === 'QA_RETRY';

    ctx.qaPassRate = null;
    ctx.qaCriticalCount = null;
    ctx.qaRetryCount = (ctx.qaRetryCount || 0) + (isRetry ? 1 : 0);
    ctx.qaStartTime = new Date().toISOString();

    // Chrome MCP availability check
    ctx.chromeAvailable = _checkChromeMcpAvailable();

    updatePdcaStatus(ctx.feature, 'qa', {
      qaRetryCount: ctx.qaRetryCount,
      chromeAvailable: ctx.chromeAvailable,
      qaStartTime: ctx.qaStartTime,
      // Consumed by unified-stop to choose QA_RETRY over ANALYZE_DONE; cleared
      // here because the retry it was requesting has now happened.
      qaRetryPending: false,
    });

    debugLog('PDCA-SM', 'QA phase initialized', {
      feature: ctx.feature,
      chromeAvailable: ctx.chromeAvailable,
      retryCount: ctx.qaRetryCount,
    });
  },

  /**
   * Record QA test results in context and status
   */
  recordQaResult(ctx, _event) {
    const { updatePdcaStatus } = getStatus();
    updatePdcaStatus(ctx.feature, ctx.currentState, {
      qaPassRate: ctx.qaPassRate,
      qaCriticalCount: ctx.qaCriticalCount,
      qaTestCount: ctx.qaTestCount || 0,
      qaFailedTests: ctx.qaFailedTests || [],
      qaDuration: ctx.qaStartTime
        ? Date.now() - new Date(ctx.qaStartTime).getTime()
        : null,
    });
  },

  /**
   * Auto-generate QA report document
   */
  generateQaReport(ctx, _event) {
    const { debugLog } = getCore();
    debugLog('PDCA-SM', 'QA report generation triggered', {
      feature: ctx.feature,
      passRate: ctx.qaPassRate,
    });
    // Actual report generation delegated to qa-lead agent or lib/qa/report-generator
  },
};

module.exports = {
  STATES,
  EVENTS,
  TRANSITIONS,
  GUARDS,
  ACTIONS,
};
