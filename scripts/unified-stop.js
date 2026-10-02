#!/usr/bin/env node
/**
 * unified-stop.js - Unified Stop Event Handler (v2.0.0)
 *
 * GitHub Issue #9354 Workaround:
 * ${CLAUDE_PLUGIN_ROOT} doesn't expand in markdown files,
 * so all skill/agent stop hooks are consolidated here.
 *
 * v2.0.0: Wired workflow-engine, circuit-breaker, trust-engine,
 * explanation-generator for full PDCA lifecycle integration.
 */

const path = require('path');
const { readStdinBounded, outputAllow, hasInFlightBackgroundWork } = require('../lib/core/io');
const { STDIN_READ_TIMEOUT_MS } = require('../lib/core/constants');
const { debugLog } = require('../lib/core/debug');
const { getPdcaStatusFull } = require('../lib/pdca/status');
const { getActiveSkill, getActiveAgent, clearActiveContext } = require('../lib/task/context');
const { normalizeSkillName } = require('../lib/core/skill-name');

// v2.0.0 Lazy Module Loaders — S3a ENH-346: extracted to scripts/lib/unified-stop-deps.js
const {
  getStateMachine, getCheckpointManager, getAuditLogger, getGateManager, getMetricsCollector,
  getWorkflowEngine, getCircuitBreaker, getTrustEngine, getExplanationGenerator, getDecisionTracer,
} = require('./lib/unified-stop-deps');

// ============================================================
// Handler Registry
// ============================================================

/**
 * Skill Stop Handlers
 * Key: skill name (from SKILL.md frontmatter)
 * Value: handler module path (relative to scripts/)
 *
 * @deprecated v1.6.0 - Skill Stop handlers migrated to skill frontmatter hooks (ENH-86).
 * This registry is retained as fallback for backward compatibility.
 */
const SKILL_HANDLERS = {
  'pdca': './pdca-skill-stop.js',
  'pm-discovery': './pdca-skill-stop.js',  // v1.6.0: PM uses same PDCA stop handler
  'sprint': './sprint-skill-stop.js',  // v2.1.21 (Issue #113): Sprint Exec Summary + AskUserQuestion + sessionTitle
  'plan-plus': './plan-plus-stop.js',  // v1.5.9: Executive Summary + AskUserQuestion
  'code-review': './code-review-stop.js',
  'phase-8-review': './phase8-review-stop.js',
  'claude-code-learning': './learning-stop.js',
  'phase-9-deployment': './phase9-deploy-stop.js',
  'phase-6-ui-integration': './phase6-ui-stop.js',
  'phase-5-design-system': './phase5-design-stop.js',
  'phase-4-api': './phase4-api-stop.js',
  'zero-script-qa': './qa-stop.js',
  'qa-phase': './qa-phase-stop.js',  // v2.1.1: QA Phase stop handler
  'development-pipeline': null  // Special case: echo command
};

/**
 * Agent Stop Handlers
 * Key: agent name (from agent.md frontmatter)
 * Value: handler module path (relative to scripts/)
 *
 * @deprecated v1.6.0 - Agent Stop handlers migrated to agent frontmatter hooks (ENH-86).
 * This registry is retained as fallback for backward compatibility.
 */
const AGENT_HANDLERS = {
  'gap-detector': './gap-detector-stop.js',
  'pdca-iterator': './iterator-stop.js',
  'code-analyzer': './analysis-stop.js',
  'qa-monitor': './qa-stop.js',
  'team-coordinator': './team-stop.js',  // v1.5.1: Team cleanup on stop
  'cto-lead': './cto-stop.js',           // v1.5.1: CTO session cleanup
  'pm-lead': './pdca-skill-stop.js',    // v1.6.0: PM lead uses PDCA stop handler
  'qa-lead': './qa-phase-stop.js',     // v2.1.1: QA Lead agent stop handler
  // design-validator: PreToolUse only, no Stop handler
};

// ============================================================
// Context Detection
// ============================================================

/**
 * Detect active skill from hook context
 * @param {Object} hookContext - Hook input context
 * @returns {string|null} Skill name or null
 */
function detectActiveSkill(hookContext) {
  // 1. Direct skill_name in context
  if (hookContext.skill_name) {
    return hookContext.skill_name;
  }

  // 2. From tool_input (if Stop follows Skill tool)
  if (hookContext.tool_input?.skill) {
    return hookContext.tool_input.skill;
  }

  // 3. From session context (stored by skill-post.js)
  const sessionSkill = getActiveSkill();
  if (sessionSkill) {
    return sessionSkill;
  }

  // 3.5 v2.1.21 (Issue #113): cross-process active-skill marker.
  // skill-post (#3 path) is in-memory only + dropped by CC #57317, and CC omits
  // skill_name (#1) / tool_input (#2) from the Stop payload — so none of the
  // above resolve a /sprint skill in production. The sprint handler writes a
  // file marker that survives across processes; peek it here (no consume — the
  // dispatched handler consumes it after emitting, so re-fire is prevented).
  try {
    const { readActiveSkill } = require('../lib/core/active-skill-marker');
    const marker = readActiveSkill();
    if (marker && marker.skill) {
      return marker.skill;
    }
  } catch (_e) { /* non-critical */ }

  // 4. From PDCA status (legacy fallback)
  const pdcaStatus = getPdcaStatusFull();
  if (pdcaStatus?.session?.lastSkill) {
    // br015: session.lastSkill may hold the plugin-qualified fire name
    // ('bkit:pdca'); SKILL_HANDLERS is keyed by bare folder name. Canonicalize
    // with the same #125 normalizer the detection path above uses.
    return normalizeSkillName(pdcaStatus.session.lastSkill);
  }

  return null;
}

/**
 * Detect active agent from hook context
 * @param {Object} hookContext - Hook input context
 * @returns {string|null} Agent name or null
 */
function detectActiveAgent(hookContext) {
  // 1. Direct agent_name in context
  if (hookContext.agent_name) {
    return hookContext.agent_name;
  }

  // 2. From Task tool invocation
  if (hookContext.tool_input?.subagent_type) {
    return hookContext.tool_input.subagent_type;
  }

  // v1.5.9: ENH-74 use agent_id as detection source
  if (hookContext.agent_id) {
    return hookContext.agent_id;
  }

  // 3. From session context
  const sessionAgent = getActiveAgent();
  if (sessionAgent) {
    return sessionAgent;
  }

  // 4. From PDCA status (legacy fallback)
  const pdcaStatus = getPdcaStatusFull();
  if (pdcaStatus?.session?.lastAgent) {
    return pdcaStatus.session.lastAgent;
  }

  return null;
}

// ============================================================
// Handler Execution
// ============================================================

/**
 * Execute handler if exists
 * @param {string} handlerPath - Relative path to handler
 * @param {Object} context - Hook context to pass
 * @returns {boolean} True if handler executed successfully
 */
function executeHandler(handlerPath, context) {
  if (!handlerPath) return false;

  try {
    const fullPath = path.join(__dirname, handlerPath);

    // v1.4.4 pattern first: a handler that exports run() executes in-process.
    const handler = require(fullPath);
    if (typeof handler.run === 'function') {
      handler.run(context);
      return true;
    }

    /*
     * br015b: stdin-CLI handlers carry a bare-require guard (v2.1.12 Sprint
     * C-2) — require()-ing them exports only pure helpers and the whole hook
     * body (feature binding, updatePdcaStatus, guidance output) is skipped.
     * Requiring one and assuming "self-executing" silently no-ops. Spawn it
     * as a real child process instead: the entrypoint branch runs, reads the
     * hook payload from its own stdin, and its stdout decisions flow back
     * through this hook's stdout to Claude Code.
     */
    const { spawnSync } = require('child_process');
    const result = spawnSync(process.execPath, [fullPath], {
      input: JSON.stringify(context || {}),
      timeout: 8000,
    });
    if (result.status === 0) {
      if (result.stdout && result.stdout.length) {
        process.stdout.write(result.stdout);
      }
      return true;
    }
    debugLog('UnifiedStop', 'Handler subprocess failed', {
      handler: handlerPath,
      status: result.status,
      error: result.stderr ? String(result.stderr).slice(0, 200) : null,
    });
    return false;
  } catch (e) {
    debugLog('UnifiedStop', 'Handler execution failed', {
      handler: handlerPath,
      error: e.message
    });
    return false;
  }
}

// ============================================================
// Main Execution
// ============================================================

// Issue #139: the Stop hook gates turn completion, so it must never block on
// stdin. readStdinBounded reads the payload with parse-early + a hard timeout
// (STDIN_READ_TIMEOUT_MS) and destroys stdin on resolve, so this hook can never
// exceed that wall-clock budget even if Claude Code holds the stdin write-end
// open. The whole body runs inside an async IIFE so the event loop stays free
// for the timeout to fire while the payload is being read (the read is the very
// first operation; everything after it remains synchronous).
(async () => {
debugLog('UnifiedStop', 'Hook started');

// Read hook context (bounded — see Issue #139 note above)
let hookContext = {};
try {
  const input = await readStdinBounded(STDIN_READ_TIMEOUT_MS);
  hookContext = (input && typeof input === 'object') ? input : {};
} catch (e) {
  debugLog('UnifiedStop', 'Failed to parse context', { error: e.message });
}

// br290b: honor the harness Stop-loop breaker (stop_hook_active=true on the
// retry after a block) — return success while it is true. Ignoring this let
// any blocking handler loop 9 consecutive times.
if (hookContext.stop_hook_active === true) {
  debugLog('UnifiedStop', 'stop_hook_active=true — allowing turn end');
  process.exit(0);
}

// v1.5.9: ENH-74 agent_id/agent_type extraction
const agentId = hookContext.agent_id || null;
const agentType = hookContext.agent_type || null;

debugLog('UnifiedStop', 'Context received', {
  hasSkillName: !!hookContext.skill_name,
  hasAgentName: !!hookContext.agent_name,
  hasToolInput: !!hookContext.tool_input,
  agentId,
  agentType
});

// Detect active skill/agent.
// #125: the detection sources (tool_input.skill, the active-skill marker) may
// carry the `plugin:skill` form, but SKILL_HANDLERS / AGENT_HANDLERS and the
// bare comparisons below (`activeSkill === 'control'`, …) are keyed by folder
// name. Canonicalize once so Stop-handler dispatch survives the namespaced form.
// normalizeSkillName is null-safe, so a null detection stays null.
const activeSkill = normalizeSkillName(detectActiveSkill(hookContext));
const activeAgent = normalizeSkillName(detectActiveAgent(hookContext));

debugLog('UnifiedStop', 'Detection result', {
  activeSkill,
  activeAgent
});

// Execute appropriate handler
let handled = false;

// Priority: Agent handlers first (more specific)
if (activeAgent && AGENT_HANDLERS[activeAgent]) {
  debugLog('UnifiedStop', 'Executing agent handler', { agent: activeAgent });
  handled = executeHandler(AGENT_HANDLERS[activeAgent], hookContext);
}

// Then skill handlers
if (!handled && activeSkill && SKILL_HANDLERS[activeSkill]) {
  debugLog('UnifiedStop', 'Executing skill handler', { skill: activeSkill });

  // Special case: development-pipeline uses simple echo
  if (activeSkill === 'development-pipeline') {
    console.log(JSON.stringify({ continue: false }));
    handled = true;
  } else {
    handled = executeHandler(SKILL_HANDLERS[activeSkill], hookContext);
  }
}

// ============================================================
// v2.0.0 Module Integrations
// ============================================================

/*
 * Extract PDCA context for the v2.0.0 module integrations below.
 *
 * v2.1.34 — every one of these read a key the v3 schema does not have, and the
 * damage was proportional to what they gate. Measured against the live status
 * object:
 *
 *   pdcaStatus.feature                → undefined  (it is `primaryFeature`)
 *   pdcaStatus.session.feature        → undefined  (session holds only
 *                                        startedAt / onboardingCompleted /
 *                                        lastActivity)
 *   pdcaStatus.currentPhase           → undefined  (v1 key; the phase lives on
 *                                        the feature entry)
 *   pdcaStatus.session.currentPhase   → undefined
 *   pdcaStatus.session.nextPhase      → undefined
 *   pdcaStatus.session.matchRate      → undefined
 *   pdcaStatus.projectLevel           → undefined  (it is `pipeline.level`)
 *
 * `feature` and `currentPhase` were therefore always null, and they guard FOUR
 * module integrations in this file — checkpoint creation before a phase
 * transition, quality-gate recording, the state-machine transition, and the
 * workflow-engine advance. All four were unreachable, in bkit's busiest hook,
 * for as long as the v3 schema has existed. Nothing logged it, because
 * `if (feature && currentPhase)` skipping is indistinguishable from there being
 * no active cycle.
 *
 * `nextPhase` has no home in the schema at all; it is derived, so it is derived
 * here rather than read from a field that was never written.
 */
const pdcaStatus = getPdcaStatusFull();
// br015b: bind the transition to the feature the fired skill targeted
// (session.lastSkillFeature, written at fire time by skill-invocation-effects
// step-6). Falls back to primaryFeature when no fire recorded a feature —
// the old behavior that misbound every Stop to ZfeatA (foreign primary).
// br290: a recording naming a DEAD feature (archived out of the registry) is
// proof the cycle completed — bind to NOTHING, never fall through to
// primaryFeature (the phantom-rebind defect behind the ZfeatA design-demand
// Stop blocks).
const { isDeadRecordedFeature } = require('../lib/pdca/stop-binding');
const recordedFeature = pdcaStatus?.session?.lastSkillFeature;
const recordedDead = isDeadRecordedFeature(recordedFeature, pdcaStatus?.features);

/*
 * Per-turn observability (token ledger + cc-regression events) must run on
 * EVERY Stop, including early exits. The dead-record exit below used to fire
 * before the accountant block at the end of the async body, so after a cycle
 * archived (lastSkillFeature dead) every subsequent Stop silently stopped
 * recording turns — caught by test/contract/integration-runtime.test.js
 * locally (ledger stopped growing). Defined here, called at both exits.
 * Best-effort — never blocks Stop flow.
 */
function recordTurnObservability() {
  try {
    const ccRegression = require('../lib/cc-regression');
    const usage = (hookContext && hookContext.message && hookContext.message.usage) || {};
    const ccVersionResolved = ccRegression.detectCCVersion() || process.env.CLAUDE_CODE_VERSION || 'unknown';
    ccRegression.recordTurn({
      // From stdin payload — env fallback prefers CLAUDE_CODE_SESSION_ID (#119)
      sessionId: hookContext.session_id || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '',
      agent: activeAgent || 'main',
      model: (hookContext.message && hookContext.message.model)
        || process.env.CLAUDE_MODEL
        || 'unknown',
      ccVersion: ccVersionResolved,
      turnIndex: Number.isFinite(hookContext.turn_index)
        ? hookContext.turn_index
        : parseInt(process.env.CLAUDE_TURN_INDEX || '0', 10),
      inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
      outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
      cacheReadInputTokens: Number.isFinite(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0,
      cacheCreationInputTokens: Number.isFinite(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : 0,
      overheadDelta: parseInt(process.env.CLAUDE_OVERHEAD_DELTA || '0', 10),
      parseStatus: (hookContext && hookContext.message) ? 'ok' : 'no_payload',
      parseWarnings: (hookContext && hookContext.message)
        ? null
        : 'no message field in hookContext (env-fallback)',
    });

    // v2.1.10 Sprint 5.5: cc-regression attribution (NDJSON event log)
    if (ccVersionResolved && ccVersionResolved !== 'unknown') {
      ccRegression.recordEvent({
        hookEvent: 'Stop',
        ccVersion: ccVersionResolved,
        sessionId: hookContext.session_id || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null,
        timestamp: new Date().toISOString(),
        context: { agent: activeAgent || 'main', skill: activeSkill || null },
      });
    }
  } catch (e) {
    debugLog('UnifiedStop', 'token-accountant recordTurn failed', { error: e.message });
  }
}

if (recordedDead) {
  // br290b: post-completion Stop — approve silently, nothing to advance.
  recordTurnObservability();
  process.exit(0);
}
const feature = recordedDead
  ? null
  : ((recordedFeature && pdcaStatus?.features?.[recordedFeature] && recordedFeature) ||
     pdcaStatus?.primaryFeature ||
     null);
const featureEntry = feature ? pdcaStatus?.features?.[feature] : null;
const currentPhase = featureEntry?.phase || null;
const nextPhase = (() => {
  if (!currentPhase) return null;
  try {
    return require('../lib/pdca/phase').getNextPdcaPhase(currentPhase) || null;
  } catch (_) { return null; }
})();
const matchRate = require('../lib/quality/match-rate').isMeasured(featureEntry?.matchRate)
  ? featureEntry.matchRate
  : null;
const level = pdcaStatus?.pipeline?.level || null;
const agentName = activeAgent || activeSkill || null;

/*
 * v2.0.0: Checkpoint creation before phase transitions.
 *
 * ENH-457 (v2.1.36): `guardrails.checkpointOnPhaseTransition` shipped in
 * bkit.config.json and nothing read it — checkpoints were created
 * unconditionally, so turning the setting off changed nothing and nothing said
 * so. Defaults to true, which is the behaviour every existing install already
 * has.
 */
let _checkpointOnPhaseTransition = true;
try {
  _checkpointOnPhaseTransition =
    require('../lib/core/config').getConfig('guardrails.checkpointOnPhaseTransition', true) !== false;
} catch (_) { /* config unavailable — keep checkpointing */ }

if (feature && currentPhase && nextPhase && _checkpointOnPhaseTransition) {
  try {
    const cp = getCheckpointManager();
    if (cp) {
      cp.createCheckpoint(feature, currentPhase, 'phase_transition', `${currentPhase} → ${nextPhase}`);
      // v2.1.1 TC-02: Track checkpoint creation in session stats
      try {
        const { incrementStat } = require('../lib/control/automation-controller');
        incrementStat('checkpointsCreated');
      } catch (_) {}
      debugLog('UnifiedStop', 'v2.0.0 checkpoint created', { feature, currentPhase, nextPhase });
    }
  } catch (_) {}
}

// v2.0.5: Quality gate check with schema bridge + result persistence + transition control
let gateVerdict = null;
if (feature && currentPhase) {
  try {
    const gates = getGateManager();
    const metrics = getMetricsCollector();
    if (gates && metrics) {
      // Use schema bridge: convert M1-M10 → gate-friendly names
      const gateMetrics = metrics.toGateFormat(feature);
      if (gateMetrics) {
        const phase = currentPhase.toLowerCase();
        const gateResult = gates.checkGate(phase, {
          feature,
          projectLevel: level || 'Dynamic',
          metrics: gateMetrics
        });
        gateVerdict = gateResult.verdict;

        // Persist gate result for audit trail
        gates.recordGateResult(phase, gateResult, feature);

        // Write gate result to pdca-status for visibility
        const { updatePdcaStatus: updateStatus } = require('../lib/pdca/status');
        // br015b: the skill handler (spawned above) may have already advanced
        // the phase (e.g. report -> completed) by the time this gate write
        // runs. currentPhase is a pre-handler snapshot — writing it back
        // regressed the freshly-written phase (observed: completed at .367Z
        // reverted to report at .378Z). Read the live phase instead.
        const liveStatus = getPdcaStatusFull(true);
        const livePhase = liveStatus?.features?.[feature]?.phase || currentPhase;
        updateStatus(feature, livePhase, {
          lastGateResult: {
            verdict: gateResult.verdict,
            score: gateResult.score,
            blockers: gateResult.blockers,
            timestamp: new Date().toISOString()
          }
        });

        debugLog('UnifiedStop', 'v2.0.5 quality gate evaluated', {
          feature, phase, verdict: gateResult.verdict,
          score: gateResult.score, blockers: gateResult.blockers.length
        });
      }
    }
  } catch (e) {
    debugLog('UnifiedStop', 'Quality gate check failed', { error: e.message });
  }
}

// v2.0.5: State machine transition — gate verdict controls the event
let transitionSuccess = false;
if (feature && currentPhase) {
  try {
    const sm = getStateMachine();
    if (sm) {
      /*
       * loadContext, not createContext.
       *
       * createContext returns a blank context — matchRate 0, no qa fields at
       * all — so every guard downstream evaluated against values this session
       * had never measured. guardQaPass could not pass, guardQaMaxRetryReached
       * could not release the qa -> act loop, and the recordQaResult action
       * wrote the blanks back over real measurements. loadContext hydrates from
       * pdca-status and quality-metrics; createContext stays as the fallback
       * for a feature with no status entry yet.
       */
      const ctx = sm.loadContext(feature) || sm.createContext(feature);

      // Determine FSM event based on gate verdict + phase
      let event = null;
      const phase = currentPhase.toLowerCase();

      if (phase === 'check' && gateVerdict) {
        // Gate verdict drives check→qa or check→act
        if (gateVerdict === 'pass') {
          event = 'MATCH_PASS';  // Now goes to 'qa' instead of 'report'
        } else if (gateVerdict === 'retry') {
          event = 'ITERATE';
        }
        // 'fail' = blocked, no transition
      } else if (phase === 'qa' && gateVerdict) {
        // v2.1.1: QA phase gate evaluation
        if (gateVerdict === 'pass') {
          event = 'QA_PASS';
        } else if (gateVerdict === 'retry' || gateVerdict === 'fail') {
          event = 'QA_FAIL';
        }
      } else if (phase === 'qa' && !gateVerdict) {
        // No gate metrics available — check if QA was skipped
        const pdcaStatus = getPdcaStatusFull();
        const featureData = pdcaStatus?.features?.[feature];
        if (featureData?.chromeAvailable === false && featureData?.qaPassRate == null) {
          event = 'QA_SKIP';
        }
      } else if (phase === 'pm') {
        event = 'PM_DONE';
      } else if (phase === 'plan') {
        event = 'PLAN_DONE';
      } else if (phase === 'design') {
        event = 'DESIGN_DONE';
      } else if (phase === 'do') {
        event = 'DO_COMPLETE';
      } else if (phase === 'act') {
        /*
         * A feature that arrived in act because QA rejected it owes QA another
         * look. Mapping act to ANALYZE_DONE unconditionally sent it back into
         * the act -> check loop instead, so `act -> qa` (QA_RETRY) — and the
         * retry counter and initQaPhase hanging off it — were unreachable.
         */
        const actStatus = getPdcaStatusFull();
        event = actStatus?.features?.[feature]?.qaRetryPending
          ? 'QA_RETRY'
          : 'ANALYZE_DONE';
      } else if (phase === 'report') {
        event = 'REPORT_DONE';
      }

      if (event) {
        sm.transition(phase, event, ctx);
        transitionSuccess = true;
        debugLog('UnifiedStop', 'v2.0.5 state machine transition', { feature, phase, event, gateVerdict });
      } else if (gateVerdict === 'fail') {
        debugLog('UnifiedStop', 'v2.0.5 transition BLOCKED by gate', { feature, phase, gateVerdict });
      }
    }
  } catch (e) {
    debugLog('UnifiedStop', 'State machine transition failed', { error: e.message });
  }
}

// v2.0.0: Workflow-engine advancement after state transitions
if (feature && currentPhase && transitionSuccess) {
  try {
    const wfe = getWorkflowEngine();
    if (wfe) {
      const execution = wfe.loadWorkflowState(feature);
      if (execution && execution.status === 'running') {
        // Update workflow context with current match rate
        if (matchRate != null) {
          execution.context.matchRate = matchRate;
        }
        // Load workflow definition to advance
        const workflowDef = wfe.selectWorkflow(feature, level);
        if (workflowDef) {
          const result = wfe.advanceWorkflow(execution, workflowDef);
          debugLog('UnifiedStop', 'v2.0.0 workflow advanced', {
            feature,
            nextPhase: result.nextPhase,
            action: result.action,
            completed: result.completed
          });
        }
      }
    }
  } catch (_) { /* non-critical */ }
}

// v2.0.0: Circuit breaker recording based on transition result
if (feature) {
  try {
    const cb = getCircuitBreaker();
    if (cb) {
      if (transitionSuccess) {
        cb.recordSuccess(feature);
      } else if (currentPhase) {
        // Only record failure if a transition was attempted but failed
        cb.recordFailure(feature, 'State machine transition failed');
      }
      debugLog('UnifiedStop', 'v2.0.0 circuit breaker updated', {
        feature,
        success: transitionSuccess
      });
    }
  } catch (_) { /* non-critical */ }
}

// v2.0.0: Trust engine event recording for completed transitions
if (feature && transitionSuccess) {
  try {
    const te = getTrustEngine();
    if (te) {
      // Record PDCA cycle completion when transitioning to report/completed
      if (nextPhase === 'report' || nextPhase === 'completed' || nextPhase === 'archived') {
        te.recordEvent('pdca_complete', { feature, from: currentPhase, to: nextPhase });
      }
      // Record gate pass/fail based on quality gate results.
      //
      // v2.1.34: an UNMEASURED rate records neither. This read
      // `matchRate >= 90 ? 'gate_pass' : 'gate_fail'`, and with matchRate now
      // legitimately null it filed a trust-lowering `gate_fail` for a
      // measurement that never ran — the user permanently paying for work bkit
      // did not do. Nothing was found wanting, so nothing is recorded.
      if (currentPhase && currentPhase.toLowerCase() === 'check') {
        const { classify } = require('../lib/quality/match-rate');
        const verdict = classify(matchRate, 90);
        if (verdict !== 'unmeasured') {
          te.recordEvent(verdict === 'pass' ? 'gate_pass' : 'gate_fail', { feature, matchRate });
        }
      }
      // v2.1.1 TC-01: Sync trust score to control-state.json
      te.syncToControlState();
      debugLog('UnifiedStop', 'v2.1.1 trust synced to control-state', { feature, currentPhase, nextPhase });
    }
  } catch (_) { /* non-critical */ }
}

// v2.1.1 TC-02: Increment session stats on phase completion
if (feature && transitionSuccess) {
  try {
    const { incrementStat } = require('../lib/control/automation-controller');
    incrementStat('phaseComplete');
    debugLog('UnifiedStop', 'v2.1.1 session stat incremented', { stat: 'phaseComplete' });
  } catch (_) { /* non-critical */ }
}

// v2.1.1 QM-02: Append quality history on every phase transition
if (feature && currentPhase && transitionSuccess) {
  try {
    const metrics = getMetricsCollector();
    if (metrics) {
      const snapshot = metrics.readCurrentMetrics(feature);
      if (snapshot && snapshot.metrics) {
        const values = {};
        for (const [mid, entry] of Object.entries(snapshot.metrics)) {
          if (entry && entry.value != null) values[mid] = entry.value;
        }
        metrics.appendHistory({
          feature,
          phase: currentPhase,
          cycle: pdcaStatus?.session?.iteration || 0,
          timestamp: new Date().toISOString(),
          values,
        });
        debugLog('UnifiedStop', 'v2.1.1 quality history appended', { feature, phase: currentPhase });
      }
    }
  } catch (_) { /* non-critical */ }
}

// v2.1.1 QM-01: Regression detection during check phase
if (feature && currentPhase && currentPhase.toLowerCase() === 'check') {
  try {
    const regression = require('../lib/quality/regression-guard');
    const metrics = getMetricsCollector();
    if (metrics) {
      const snapshot = metrics.readCurrentMetrics(feature);
      if (snapshot && snapshot.metrics) {
        const metricValues = {};
        for (const [mid, entry] of Object.entries(snapshot.metrics)) {
          if (entry && entry.value != null) metricValues[mid] = entry.value;
        }
        const result = regression.detectRegressions(metricValues, feature);
        if (result.detected) {
          const audit = getAuditLogger();
          if (audit) {
            audit.writeAuditLog({
              actor: 'system', actorId: 'unified-stop',
              action: 'regression_detected', category: 'quality',
              target: feature, targetType: 'feature',
              details: { count: result.regressions.length, rules: result.regressions.map(r => r.ruleId) },
              result: 'warning', destructiveOperation: false,
            });
          }
          debugLog('UnifiedStop', 'v2.1.1 regression detected', { feature, count: result.regressions.length });
        }
      }

      // v2.1.1 QM-02: Trend analysis in check phase
      const trendResult = metrics.analyzeTrend(feature);
      if (trendResult.alarms.length > 0) {
        const audit = getAuditLogger();
        if (audit) {
          audit.writeAuditLog({
            actor: 'system', actorId: 'unified-stop',
            action: 'trend_alarm', category: 'quality',
            target: feature, targetType: 'feature',
            details: { alarms: trendResult.alarms.map(a => a.type), trend: trendResult.trend },
            result: 'warning', destructiveOperation: false,
          });
        }
        debugLog('UnifiedStop', 'v2.1.1 trend alarms', { feature, count: trendResult.alarms.length });
      }
    }
  } catch (_) { /* non-critical */ }
}

// v2.0.0: Audit logging for stop events (with explanation-generator for decision traces)
if (handled || feature) {
  try {
    const audit = getAuditLogger();
    if (audit) {
      audit.writeAuditLog({
        actor: 'system',
        actorId: agentName || 'unified-stop',
        action: feature && nextPhase ? 'phase_transition' : 'stop_event',
        category: 'pdca',
        target: feature || activeSkill || activeAgent || 'unknown',
        targetType: 'feature',
        details: {
          from: currentPhase,
          to: nextPhase,
          matchRate,
          activeSkill,
          activeAgent,
          handled
        },
        result: 'success',
        destructiveOperation: false
      });
      debugLog('UnifiedStop', 'v2.0.0 audit log written', { action: feature && nextPhase ? 'phase_transition' : 'stop_event' });
    }
  } catch (_) {}

  // v2.0.0: Generate human-readable explanation from recent decision traces
  try {
    const eg = getExplanationGenerator();
    const dt = getDecisionTracer();
    if (eg && dt && feature) {
      const recentTraces = dt.readDecisions({ feature, limit: 5 });
      if (recentTraces.length > 0) {
        const latestTrace = recentTraces[recentTraces.length - 1];
        const explanation = eg.generateExplanation(latestTrace, 'brief');
        if (explanation) {
          debugLog('UnifiedStop', 'v2.0.0 decision explanation generated', { explanation });
        }
      }
    }
  } catch (_) { /* non-critical */ }
}

// Clear active context after stop
clearActiveContext();

// Fallback: agent state cleanup if no handler did it (v1.5.3 Team Visibility)
//
// ENH-374: gated on `background_tasks` being empty. This Stop fires when the
// MAIN turn ends, which since CC v2.1.218/219 (background `/code-review`,
// nested subagents to depth 3 by default) regularly happens while subagents are
// still running. Wiping the roster there orphaned every later SubagentStop —
// reproduced at 4/4 on CC v2.1.220. Deferring cleanup to the Stop that fires
// once nothing is in flight costs nothing: the roster is cleared either way,
// just not while it is still being written to.
if (!handled) {
  try {
    const teamModule = require('../lib/team');
    const state = teamModule.readAgentState ? teamModule.readAgentState() : null;
    if (state && state.enabled) {
      if (hasInFlightBackgroundWork(hookContext)) {
        debugLog('UnifiedStop', 'Fallback agent state cleanup deferred (background work in flight)', {
          backgroundTaskCount: hookContext.background_tasks.length,
        });
      } else {
        teamModule.cleanupAgentState();
        debugLog('UnifiedStop', 'Fallback agent state cleanup executed');
      }
    }
  } catch (e) {
    // Silent - not all stops need agent state cleanup
  }
}

// Default output if no handler matched
if (!handled) {
  debugLog('UnifiedStop', 'No handler matched, using default output');

  // v2.0.0: Include trust score in stop output when control skill is active
  let trustInfo = '';
  if (activeSkill === 'control') {
    try {
      const te = getTrustEngine();
      if (te) {
        const profile = te.loadTrustProfile();
        const score = te.calculateScore(profile);
        trustInfo = `\nTrust Score: ${score}/100 (L${profile.currentLevel})`;
      }
    } catch (_) { /* non-critical */ }
  }

  // v2.0.0: Include decision summary in stop output when audit skill is active
  let auditInfo = '';
  if (activeSkill === 'audit' && feature) {
    try {
      const eg = getExplanationGenerator();
      const dt = getDecisionTracer();
      if (eg && dt) {
        const recentTraces = dt.readDecisions({ feature, limit: 10 });
        if (recentTraces.length > 0) {
          auditInfo = '\n' + eg.summarizeDecisionHistory(recentTraces);
        }
      }
    } catch (_) { /* non-critical */ }
  }

  // v1.5.6: Conditionally add /copy tip (when session was a code generation skill)
  const copyTip = activeSkill ? '\nTip: Use /copy to copy code blocks from this session.' : '';

  // v2.1.10 Sprint 7c (G-J-05): Next Action suggestion on default path
  let nextActionHint = '';
  try {
    const { generateGeneric } = require('../lib/orchestrator/next-action-engine');
    const { getPdcaStatusFull: psf } = require('../lib/pdca/status');
    const pdcaStatus = (typeof psf === 'function') ? psf() : null;
    const hint = generateGeneric({ activeSkill, activeAgent, pdcaStatus });
    if (hint) nextActionHint = '\n' + hint;
  } catch (_e) { /* fail-silent */ }

  outputAllow(`Stop event processed.${trustInfo}${auditInfo}${copyTip}${nextActionHint}`, 'Stop');
}

// v2.1.12 Sprint A-1 (defect #17 fix): per-turn observability — see
// recordTurnObservability() above (hoisted so early exits also record).
recordTurnObservability();

debugLog('UnifiedStop', 'Hook completed', {
  handled,
  activeSkill,
  activeAgent
});
})().catch((e) => {
  // Last-resort guard: the Stop hook must never throw out of the async body.
  try { debugLog('UnifiedStop', 'Unhandled error in async body', { error: e && e.message }); } catch (_) { /* ignore */ }
});
