#!/usr/bin/env node
/**
 * gap-detector-stop.js - Parse gap analysis result and guide next steps (v1.4.0)
 *
 * Purpose: Parse match rate and provide guidance for Check-Act iteration
 * Hook: Stop for gap-detector agent
 * Core component of Check-Act iteration loop
 *
 * v1.4.0 Changes:
 * - Added debug logging for hook verification
 * - Added PDCA status update with match rate
 * - Added dynamic feature extraction from multiple sources
 *
 * Converted from: scripts/gap-detector-stop.sh
 */


// ============================================================
// Pure helpers (bugfix-wave-20260919 §3 Fix 4) — factored out of the
// main flow so unit tests can require them without executing the hook.
// Design Ref: §3 Fix 4a/4b
// ============================================================

// Fix 4a: 'Overall' bare alternative used to win first, so 'Overall Match
// Rate: 98%' matched via the fragile Overall branch. Put the full phrase
// first and exclude '%' from the filler run so table form can't overrun.
const matchRatePattern = /(Overall\s+Match Rate|Match Rate|매치율|일치율|Design Match)[^0-9%]*(\d+)/i;

/**
 * Parse the match rate from gap-detector output text.
 * @param {string} text
 * @returns {number|null} integer percent, or null when unmeasured
 */
function parseMatchRate(text) {
  const m = (text || '').match(matchRatePattern);
  return m ? parseInt(m[2], 10) : null;
}

// Fix 4b (BR-002): the agent's own text, not status.primaryFeature, is the
// authoritative source for which feature this analysis is about.
const featurePattern = /feature[:\s]+['"]?([a-z0-9][a-z0-9-]*)['"]?/i;
const analysisPattern = /analyzing\s+['"]?([a-z0-9][a-z0-9-]*)['"]?/i;

/**
 * Extract the feature name the gap-detector reported.
 * @param {string} text
 * @returns {string|null} kebab-case feature name, or null
 */
function extractFeatureFromText(text) {
  const t = text || '';
  const m = t.match(featurePattern) || t.match(analysisPattern);
  return m ? m[1] : null;
}

/**
 * Fix 4c: wrong-feature guard — a resolved feature is recordable only if it
 * already exists in the PDCA status (primaryFeature or activeFeatures).
 * @param {string|null} feature
 * @param {{ primaryFeature?: string|null, activeFeatures?: string[] }} status
 * @returns {boolean}
 */
function isKnownFeature(feature, status) {
  if (!feature || !status) return false;
  return feature === status.primaryFeature ||
    (Array.isArray(status.activeFeatures) && status.activeFeatures.includes(feature));
}

// v2.1.12 Sprint C-2 (#9/#10/#8): bare-require guard — when this script
// is require()-d instead of executed as a hook entrypoint, export only the
// pure helpers so no stale stdout (decisions, advisory messages) is emitted
// without a real hook payload. CommonJS module body is implicitly an IIFE,
// so top-level return is valid.
if (require.main !== module) {
  module.exports = { parseMatchRate, extractFeatureFromText, isKnownFeature, matchRatePattern };
} else {

const { readStdinSync, readHookText, outputStopSurface } = require('../lib/core/io');
const { debugLog } = require('../lib/core/debug');
const { getBkitConfig } = require('../lib/core/config');
const {
  updatePdcaStatus,
  extractFeatureFromContext,
  getPdcaStatusFull,
} = require('../lib/pdca/status');
const {
  emitUserPrompt,
  autoAdvancePdcaPhase,
} = require('../lib/pdca/automation');
// v1.4.0 P2: Requirement Fulfillment Integration (stub - not yet implemented)
const calculateRequirementFulfillment = () => null;
const { generateTaskGuidance } = require('../lib/task/creator');
const {
  updatePdcaTaskStatus,
  triggerNextPdcaAction,
} = require('../lib/task/tracker');

// Log execution start
debugLog('Agent:gap-detector:Stop', 'Hook started');

/*
 * Read the agent's REPORT, not the envelope it arrived in.
 *
 * `JSON.stringify(input)` turns the hook payload into text — hook_event_name,
 * session_id, transcript_path, cwd — and every pattern below was then matched
 * against that. None of them can appear there, so the match rate this hook
 * exists to record has never been extractable. readHookText resolves the
 * payload to the assistant's reported text via transcript_path, which is where
 * "Overall Match Rate: 87%" actually is.
 */
const input = readStdinSync();
const inputText = readHookText(input);

debugLog('Agent:gap-detector:Stop', 'Input received', {
  inputLength: inputText.length,
  inputPreview: inputText.substring(0, 200)
});

// Try to extract match rate from the agent's output
// Patterns: "Overall Match Rate: XX%", "매치율: XX%", "Match Rate: XX%", "일치율: XX%"
const matchRate = parseMatchRate(inputText);
/*
 * v2.1.34 — a gap analysis that stated no rate is UNMEASURED, not 0%.
 *
 * `match ? parseInt(...) : 0` fabricated a measurement out of a parse failure,
 * and that 0 then travelled: into `.bkit/state/pdca-status.json`, into the M1
 * and M4 metric series, and into a generated `docs/03-analysis/<feature>.
 * analysis.md` headed "Match Rate: 0%". Observed during v2.1.34 work — this
 * hook wrote a 0% report for a feature whose state had been deliberately set to
 * `matchRate: null, measured: false`, contradicting the release's own record.
 *
 * A fabricated 0 is worse than a fabricated 100 in one respect: it looks like
 * diligence. Someone reading "0%" concludes the comparison ran and found
 * nothing matching, and starts fixing code against a measurement that was never
 * taken.
 */
const measured = matchRate !== null;

// Extract feature name from the agent's own text first (Fix 4b); fall back to
// the previous context-resolution path only when the text names nothing.
const featureFromText = extractFeatureFromText(inputText);
const currentStatus = getPdcaStatusFull();

// Design Ref: §3 Fix 4b/4c — extractFeatureFromContext ignores agentOutput
// (it only reads sources.feature/filePath), so pass the regex-extracted name
// explicitly; then guard against attributing the rate to an unknown feature.
let feature;
let parseStatus = 'ok';
let parseWarning = null;
if (featureFromText) {
  feature = extractFeatureFromContext({ feature: featureFromText, filePath: undefined });
  if (!isKnownFeature(feature, currentStatus)) {
    parseStatus = 'partial';
    parseWarning = `Reported feature '${featureFromText}' not found in PDCA status (primaryFeature: ${currentStatus?.primaryFeature || 'none'}); match rate not recorded`;
    feature = null;
  }
} else {
  feature = extractFeatureFromContext({ feature: undefined, filePath: undefined });
  if (!feature) {
    parseStatus = 'partial';
    parseWarning = 'No feature name found in output and no primaryFeature in status';
  }
}

debugLog('Agent:gap-detector:Stop', 'Data extracted', {
  matchRate,
  feature: feature || 'unknown',
  hadFeatureInOutput: !!featureFromText,
  parseStatus,
  parseWarning,
});

// v1.4.0 P2: Calculate requirement fulfillment if plan exists
let fulfillmentResult = null;
const planDocPath = `docs/01-plan/features/${feature}.plan.md`;
const fs = require('fs');
if (feature && fs.existsSync(planDocPath)) {
  try {
    fulfillmentResult = calculateRequirementFulfillment(planDocPath, {
      matchRate,
      analysisDoc: `docs/03-analysis/${feature}.analysis.md`
    });
    debugLog('Agent:gap-detector:Stop', 'Requirement fulfillment calculated', {
      score: fulfillmentResult.score,
      fulfilled: fulfillmentResult.fulfilled,
      total: fulfillmentResult.total
    });
  } catch (e) {
    debugLog('Agent:gap-detector:Stop', 'Fulfillment calculation failed', { error: e.message });
  }
}

// Update PDCA status with match rate and fulfillment
if (feature) {
  updatePdcaStatus(feature, 'check', {
    matchRate,
    measured,
    analysisDoc: `docs/03-analysis/${feature}.analysis.md`,
    fulfillment: fulfillmentResult ? {
      score: fulfillmentResult.score,
      fulfilled: fulfillmentResult.fulfilled,
      total: fulfillmentResult.total
    } : null
  });
}

// v2.0.5: Collect quality metrics (M1, M4)
try {
  const mc = require('../lib/quality/metrics-collector');
  const f = feature || 'unknown';
  // M1: Match Rate (primary metric from gap analysis). A metric series with a
  // gap in it is honest; one padded with fabricated zeroes is not, and the
  // padding is indistinguishable from real data once it is written.
  if (measured) {
    mc.collectMetric('M1', f, matchRate, 'gap-detector');
  }

  // M4: API Compliance Rate — extract from output if present
  const apiPattern = /(API|api)\s*(Compliance|compliance|일치율|준수율)[^0-9]*(\d+)/i;
  const apiMatch = inputText.match(apiPattern);
  if (apiMatch) {
    mc.collectMetric('M4', f, parseInt(apiMatch[3], 10), 'gap-detector');
  } else if (measured) {
    // Estimate: use matchRate as proxy when no explicit API compliance data
    mc.collectMetric('M4', f, matchRate, 'gap-detector');
  }
  debugLog('Agent:gap-detector:Stop', 'Quality metrics collected', { M1: matchRate, measured });
} catch (e) {
  debugLog('Agent:gap-detector:Stop', 'Metrics collection failed', { error: e.message });
}

// v1.4.0: Get configuration and check iteration limits
const config = getBkitConfig();
const threshold = config.pdca?.matchRateThreshold || 90;
const maxIterations = config.pdca?.maxIterations || 5;
// v2.1.8 fix B17 (QR11 runtime catch): guard currentStatus itself — null in pre-PDCA-init projects
const featureStatus = currentStatus?.features?.[feature];
const iterCount = featureStatus?.iterationCount || 0;

// Generate guidance based on match rate thresholds
let guidance = '';
let nextStep = '';
let userPrompt = null;

if (!measured) {
  /*
   * v2.1.34 — the unmeasured branch, which did not exist.
   *
   * With `matchRate` fabricated as 0, an analysis that reported no rate at all
   * fell through every threshold and landed in the "below 70%" branch. The user
   * was told a significant design-implementation gap had been detected and
   * pushed toward auto-improvement — from a comparison that never produced a
   * number. Iterations would then be spent closing a gap nobody had measured,
   * and the iteration counter would climb toward its limit on the strength of
   * a parse failure.
   *
   * The missing step is the measurement, so that is what this asks for.
   */
  nextStep = 'pdca-check';
  guidance = `⚪ Gap Analysis produced no match rate.

The analysis ran but reported no percentage, so nothing was measured. That is
not a low score — it is the absence of a score, and the cycle cannot advance on
it. No metric was recorded and the phase was left where it is.

Recommended actions:
1. Re-run the gap analysis and make sure it reports a rate, e.g. "Match Rate: 87%"
2. Check that the design documents the analysis compares against actually exist
3. Run with BKIT_DEBUG=1 to see what the agent's output contained

📊 Iterations: ${iterCount}/${maxIterations} (unchanged — an unmeasured run does not consume one)`;
} else if (matchRate >= threshold) {
  // >= threshold: Suggest completion
  nextStep = 'pdca-report';
  guidance = `✅ Gap Analysis complete: ${matchRate}% match

Design-implementation alignment is good.

Next steps:
1. Generate completion report with /pdca-report ${feature || ''}
2. Archive available (move to docs/archive/)

🎉 PDCA Check phase passed!`;

  // v1.4.0: Generate AskUserQuestion prompt for completion
  userPrompt = emitUserPrompt({
    questions: [{
      question: `Match rate ${matchRate}%. Generate completion report?`,
      header: 'Complete',
      options: [
        {
          label: 'Generate report (Recommended)',
          description: `Run /pdca-report ${feature || ''}`,
          preview: [
            '## Completion Report',
            '',
            `**Command**: \`/pdca report ${feature || ''}\``,
            `**Current Match Rate**: ${matchRate}%`,
            '',
            '**Output**: report.md (Plan/Design/Implementation/Analysis integrated)'
          ].join('\n')
        },
        {
          label: '/simplify code cleanup',
          description: 'Improve code quality then generate report',
          preview: [
            '## /simplify Code Cleanup',
            '',
            '**Command**: `/simplify`',
            '',
            'Improve code quality then proceed to report generation'
          ].join('\n')
        },
        {
          label: 'Continue improving',
          description: `Run /pdca-iterate ${feature || ''}`,
          preview: [
            '## Continue Improvement',
            '',
            `**Command**: \`/pdca iterate ${feature || ''}\``,
            '',
            'Start new iteration (re-analyze gaps after fixes)'
          ].join('\n')
        },
        {
          label: 'Later',
          description: 'Keep current state',
          preview: [
            '## Defer',
            '',
            `Current state (${matchRate}%) saved to .pdca-status.json`,
            'Resume with `/pdca status` later'
          ].join('\n')
        }
      ],
      multiSelect: false
    }]
  });

} else if (iterCount >= maxIterations) {
  // v1.4.0: Max iterations reached
  nextStep = 'manual';
  guidance = `⚠️ Gap Analysis complete: ${matchRate}% match

Maximum iterations (${maxIterations}) reached.
Manual review required.

Current state:
- Iterations: ${iterCount}/${maxIterations}
- Match rate: ${matchRate}%

Recommended actions:
1. Manually review and fix code
2. Review design document updates
3. Document intentional differences`;

  userPrompt = emitUserPrompt({
    questions: [{
      question: `Maximum iterations reached. How to proceed?`,
      header: 'Max Iterations',
      options: [
        {
          label: 'Manual fix',
          description: 'Review and fix code manually',
          preview: [
            '## Manual Review',
            '',
            `**Max iterations reached**: ${iterCount}/${maxIterations}`,
            `**Current Match Rate**: ${matchRate}%`,
            '',
            'Review gaps manually and apply targeted fixes before re-analyzing'
          ].join('\n')
        },
        {
          label: 'Complete as-is',
          description: 'Generate report with warning',
          preview: [
            '## Complete with Warning',
            '',
            `**Command**: \`/pdca report ${feature || ''}\``,
            `**Match Rate**: ${matchRate}% (below ${threshold}% threshold)`,
            '',
            'Generate completion report documenting unresolved gaps'
          ].join('\n')
        },
        {
          label: 'Update design',
          description: 'Update design to match implementation',
          preview: [
            '## Update Design Document',
            '',
            `**Target**: docs/02-design/features/${feature || 'feature'}.design.md`,
            '',
            'Align design spec with current implementation to reflect intentional differences'
          ].join('\n')
        }
      ],
      multiSelect: false
    }]
  });

} else if (matchRate >= 70) {
  // 70-89%: Suggest auto-improvement
  nextStep = 'pdca-iterate';
  guidance = `⚠️ Gap Analysis complete: ${matchRate}% match

Some differences found.

Options:
1. Auto-improve (Recommended): /pdca-iterate ${feature || ''}
2. Manual fix: Fix differences manually
3. Update design: Update design document to match implementation

💡 Completion report available when reaching ${threshold}%+
📊 Iterations: ${iterCount}/${maxIterations}`;

  userPrompt = emitUserPrompt({
    questions: [{
      question: `Match rate ${matchRate}%. Auto-improve?`,
      header: 'Auto-Fix',
      options: [
        {
          label: 'Auto-improve (Recommended)',
          description: `Run /pdca-iterate (${iterCount + 1}/${maxIterations})`,
          preview: [
            '## Auto-Fix Iteration',
            '',
            `**Command**: \`/pdca iterate ${feature || ''}\``,
            `**Iteration**: ${iterCount + 1}/${maxIterations}`,
            `**Current Match Rate**: ${matchRate}% → target ${threshold}%`,
            '',
            'Automatically detect and fix implementation gaps against design'
          ].join('\n')
        },
        {
          label: 'Manual fix',
          description: 'Fix code manually then re-analyze',
          preview: [
            '## Manual Fix',
            '',
            `**Current Match Rate**: ${matchRate}%`,
            '',
            'Apply targeted fixes manually, then run `/pdca check` to re-analyze'
          ].join('\n')
        },
        {
          label: 'Complete as-is',
          description: 'Proceed with warning',
          preview: [
            '## Complete with Warning',
            '',
            `**Command**: \`/pdca report ${feature || ''}\``,
            `**Match Rate**: ${matchRate}% (below ${threshold}% threshold)`,
            '',
            'Generate report with gap warning — recommended only if gaps are intentional'
          ].join('\n')
        }
      ],
      multiSelect: false
    }]
  });

} else {
  // Below 70%: Strongly recommend improvement
  nextStep = 'pdca-iterate';
  guidance = `🔴 Gap Analysis complete: ${matchRate}% match

Significant design-implementation gap detected.

Recommended actions:
1. Run /pdca-iterate ${feature || ''} for auto-improvement (Strongly recommended)
2. Or fully update design document to match current implementation

⚠️ Check-Act iteration required. Repeat until reaching ${threshold}%+.
📊 Iterations: ${iterCount}/${maxIterations}`;

  userPrompt = emitUserPrompt({
    questions: [{
      question: `Match rate ${matchRate}% is low. Proceed with auto-improvement?`,
      header: 'Low Match',
      options: [
        {
          label: 'Auto-improve (Strongly recommended)',
          description: `Run /pdca-iterate (${iterCount + 1}/${maxIterations})`,
          preview: [
            '## Auto-Fix Iteration',
            '',
            `**Command**: \`/pdca iterate ${feature || ''}\``,
            `**Iteration**: ${iterCount + 1}/${maxIterations}`,
            `**Current Match Rate**: ${matchRate}% — significant gaps detected`,
            '',
            'Automatically resolve major implementation gaps against design spec'
          ].join('\n')
        },
        {
          label: 'Full design update',
          description: 'Rewrite design to match implementation',
          preview: [
            '## Full Design Rewrite',
            '',
            `**Target**: docs/02-design/features/${feature || 'feature'}.design.md`,
            `**Current Match Rate**: ${matchRate}%`,
            '',
            'Rewrite design document to align with current implementation (significant effort)'
          ].join('\n')
        },
        {
          label: 'Manual fix',
          description: 'Fix code manually',
          preview: [
            '## Manual Intervention',
            '',
            `**Current Match Rate**: ${matchRate}% — manual review strongly recommended`,
            '',
            'Review gap analysis report and apply targeted fixes before re-running check'
          ].join('\n')
        }
      ],
      multiSelect: false
    }]
  });
}

// v1.4.0: Get auto phase advance suggestion
// An unmeasured run must not drive a phase transition in either direction.
const phaseAdvance = measured ? autoAdvancePdcaPhase(feature, 'check', { matchRate }) : null;

// v1.4.4 FR-06/FR-07: Auto-create PDCA Tasks and Update Task Status
let autoCreatedTasks = [];
try {
  const { autoCreatePdcaTask } = require('../lib/task/creator');

  // v1.4.4 FR-07: Update Check Task status
  if (feature) {
    updatePdcaTaskStatus('check', feature, {
      matchRate,
      // Unmeasured stays in_progress: the check task has not finished, because
      // the thing it exists to produce was never produced.
      status: measured && matchRate >= threshold ? 'completed' : 'in_progress',
      fulfillment: fulfillmentResult
    });
    debugLog('Agent:gap-detector:Stop', 'Check Task status updated', {
      feature, matchRate, threshold
    });
  }

  // Auto-create [Check] Task
  const checkTask = autoCreatePdcaTask({
    phase: 'check',
    feature: feature || 'unknown',
    metadata: {
      matchRate,
      fulfillment: fulfillmentResult,
      analysisDoc: `docs/03-analysis/${feature}.analysis.md`
    }
  });
  if (checkTask) {
    autoCreatedTasks.push(checkTask);
    debugLog('Agent:gap-detector:Stop', 'Check Task auto-created', { taskId: checkTask.taskId });
  }

  // v1.4.4 FR-07: Auto-create [Report] Task if matchRate >= threshold
  if (matchRate >= threshold) {
    const reportTask = autoCreatePdcaTask({
      phase: 'report',
      feature: feature || 'unknown',
      metadata: {
        finalMatchRate: matchRate,
        completedAt: new Date().toISOString(),
        blockedBy: checkTask?.taskId
      }
    });
    if (reportTask) {
      autoCreatedTasks.push(reportTask);
      debugLog('Agent:gap-detector:Stop', 'Report Task auto-created', { taskId: reportTask.taskId });
    }
  }
  // Auto-create [Act] Task if matchRate < threshold
  else if (iterCount < maxIterations) {
    const actTask = autoCreatePdcaTask({
      phase: 'act',
      feature: feature || 'unknown',
      iteration: iterCount + 1,
      metadata: {
        matchRateBefore: matchRate,
        requiredMatchRate: threshold,
        blockedBy: checkTask?.taskId
      }
    });
    if (actTask) {
      autoCreatedTasks.push(actTask);
      debugLog('Agent:gap-detector:Stop', 'Act Task auto-created', { taskId: actTask.taskId });
    }
  }
} catch (e) {
  debugLog('Agent:gap-detector:Stop', 'Auto-task creation skipped', { error: e.message });
}

// v1.4.7 FR-04, FR-05, FR-06: Get autoTrigger for Check↔Act iteration
let autoTrigger = null;
try {
  const triggerResult = triggerNextPdcaAction(feature, 'check', {
    matchRate,
    iterationCount: iterCount,
    maxIterations,
    threshold
  });
  if (triggerResult) {
    autoTrigger = triggerResult.autoTrigger;
    debugLog('Agent:gap-detector:Stop', 'AutoTrigger generated', {
      nextAction: triggerResult.nextAction,
      autoTrigger
    });
  }
} catch (e) {
  debugLog('Agent:gap-detector:Stop', 'AutoTrigger generation failed', { error: e.message });
}

// Add Task System guidance for PDCA workflow (v1.3.1 - FR-04)
const taskGuidance = matchRate >= 90
  ? generateTaskGuidance('check', feature || 'feature', 'do')
  : generateTaskGuidance('act', feature || 'feature', 'check');

// Log completion
debugLog('Agent:gap-detector:Stop', 'Hook completed', {
  matchRate,
  feature: feature || 'unknown',
  nextStep,
  iterCount,
  phaseAdvance: phaseAdvance?.nextPhase
});

// v2.1.7 REQ-05: Generate analysis document (Issue #79 P6)
// gap-detector agent is Read-only by design (disallowedTools: Write, Edit)
// The stop hook handles analysis document generation instead
try {
  if (feature && feature !== 'unknown' && matchRate !== undefined) {
    const path = require('path');
    const analysisDir = path.join(process.cwd(), 'docs', '03-analysis', 'features');
    if (!fs.existsSync(analysisDir)) {
      fs.mkdirSync(analysisDir, { recursive: true });
    }
    const analysisPath = path.join(analysisDir, `${feature}.analysis.md`);
    const timestamp = new Date().toISOString();
    const analysisContent = [
      `# Gap Analysis: ${feature}`,
      '',
      // `${null}%` renders as "null%", which is a worse claim than no claim at
      // all — it reads as a corrupt measurement rather than an absent one.
      `> **Match Rate**: ${require('../lib/quality/match-rate').format(matchRate)}`,
      `> **Threshold**: ${threshold}%`,
      `> **Iteration**: ${iterCount}`,
      `> **Date**: ${timestamp}`,
      `> **Generated by**: gap-detector-stop hook (v2.1.7)`,
      '',
      '---',
      '',
      '## Result',
      '',
      !measured
        ? `Not measured - the analysis reported no match rate, so this is neither a `
          + `pass nor a fail against the ${threshold}% threshold`
        : (matchRate >= threshold
          ? `Pass - match rate ${matchRate}% meets threshold ${threshold}%`
          : `Fail - match rate ${matchRate}% below threshold ${threshold}%`),
      '',
      '## Guidance',
      '',
      guidance || 'No specific guidance generated.',
      '',
      '## Next Step',
      '',
      nextStep ? nextStep.message : 'N/A',
      '',
    ].join('\n');
    fs.writeFileSync(analysisPath, analysisContent, 'utf-8');
    debugLog('Agent:gap-detector:Stop', 'Analysis doc generated', {
      path: analysisPath, matchRate, iteration: iterCount
    });
  }
} catch (e) {
  debugLog('Agent:gap-detector:Stop', 'Analysis doc generation failed', {
    error: e.message, feature
  });
}

// ENH-227 (Issue #77 Phase A): single-source generator
// Issue #111 Phase B (v2.1.21): thread session_id for per-session title isolation
const { generateSessionTitle } = require('../lib/pdca/session-title');
const sessionTitle = generateSessionTitle({ action: 'CHECK', feature, sessionId: input && input.session_id });

// S6 ENH-362: CC-compliant Stop surface. decision:'block'+reason; drop
// hookSpecificOutput/sessionTitle/userPrompt/analysisResult/autoTrigger. Diagnostics → debugLog.
void sessionTitle; void userPrompt;
const reason = [
  measured
    ? `Gap Analysis complete. Match rate: ${matchRate}%`
    : 'Gap Analysis complete. No match rate was measured.',
  '',
  guidance,
  '',
  taskGuidance || '',
].filter(Boolean).join('\n');
debugLog('Agent:gap-detector:Stop', 'surface', { matchRate, feature: feature || 'unknown', iterationCount: iterCount, maxIterations, threshold, nextStep, phaseAdvance, autoCreatedTasks: autoCreatedTasks.map(t => t.taskId), autoTrigger });

// v2.0.0: State machine integration
try {
  const sm = require('../lib/pdca/state-machine');
  const smCtx = sm.loadContext(feature) || sm.createContext(feature || 'unknown');
  if (!measured) {
    // Neither MATCH_PASS nor ITERATE. Iterating on an unmeasured result spends
    // the iteration budget closing a gap nobody measured, and the counter
    // reaches its limit on the strength of a parse failure.
    debugLog('Agent:pdca-iterator:Stop', 'no state transition — nothing measured', { feature });
  } else if (matchRate >= threshold) {
    sm.transition('check', 'MATCH_PASS', { ...smCtx, matchRate });
  } else {
    sm.transition('check', 'ITERATE', { ...smCtx, matchRate });
  }
} catch { /* non-critical */ }

// v2.0.0: Metrics collection
try {
  const mc = require('../lib/quality/metrics-collector');
  if (measured) mc.collectMetric('M1', feature || 'unknown', matchRate, 'gap-detector');
} catch { /* non-critical */ }

// v2.0.0: Audit logging
try {
  const audit = require('../lib/audit/audit-logger');
  audit.writeAuditLog({
    actor: 'agent', actorId: 'gap-detector',
    // `gate_failed` would say the gate was evaluated and lost. It was not
    // evaluated at all, and an audit trail that cannot tell those apart is the
    // same false assurance as the hardcoded `result: 'blocked'` in
    // unified-bash-pre (ENH-393).
    action: !measured ? 'gate_unmeasured' : (matchRate >= threshold ? 'gate_passed' : 'gate_failed'),
    category: 'quality',
    target: feature || 'unknown', targetType: 'feature',
    details: { matchRate, threshold, measured },
    result: !measured ? 'blocked' : (matchRate >= threshold ? 'success' : 'failure')
  });
} catch { /* non-critical */ }

outputStopSurface(reason);
process.exit(0);
}
