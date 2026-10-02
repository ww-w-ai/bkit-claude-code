#!/usr/bin/env node
/**
 * qa-phase-stop.js - QA Phase Stop Event Handler
 *
 * Collects M11-M16 metrics from QA execution results
 * and triggers appropriate state machine event (QA_PASS/QA_FAIL/QA_SKIP).
 *
 * br018: also surfaces the QA retry spiral. When a feature's QA metrics
 * never record (dead hook dispatch — br015/br017 family), every Stop
 * bounces act -> qa (QA_RETRY) silently; qaRetryCount climbed to 187
 * (~10M tokens) before anyone noticed. This handler now (a) names the
 * missing gate metrics on every retry, and (b) escalates loudly at
 * retry 10 and every 25th retry after that.
 */

'use strict';

const path = require('path');

// ============================================================
// br018 pure helpers — exported via the bare-require branch so unit
// tests can exercise the escalation cadence without running the hook.
// ============================================================

/**
 * The gate metrics the QA_PASS guard requires (M11/M14/M16), with the
 * recording mechanism that produces each. Note the metric IDs follow
 * lib/quality/metrics-collector.js METRIC_SPECS: M14 is RUNTIME ERRORS,
 * M16 is CRITICAL COUNT.
 * @type {Array<{id:string, gate:string, description:string, recordedBy:string}>}
 */
const QA_GATE_METRICS = [
  {
    id: 'M11', gate: 'qaPassRate',
    description: 'QA pass rate (%)',
    recordedBy: 'qa-phase-stop parsing "pass rate ... N%" from the QA turn text',
  },
  {
    id: 'M14', gate: 'runtimeErrorCount',
    description: 'runtime error count',
    recordedBy: 'qa-phase-stop parsing "runtime error ... N" from the QA turn text',
  },
  {
    id: 'M16', gate: 'qaCriticalCount',
    description: 'QA critical count',
    recordedBy: 'qa-phase-stop parsing "critical ... N" from the QA turn text',
  },
];

/** Self-heal line naming the sanctioned CLI fallback (br018 fix part 3). */
const QA_SELF_HEAL_LINE =
  'If measurements cannot run in this session (dead hook dispatch), use: ' +
  'node scripts/pdca-record-qa.js <feature> --pass-rate N --critical N --runtime-errors N';

/**
 * Escalation cadence (br018 fix part 2): the FIRST prominent notice fires
 * when the retry count reaches 10; after that, every 25th retry re-emits
 * (35, 60, 85, ...). Counts below 10 never escalate.
 * @param {number} qaRetryCount
 * @returns {boolean}
 */
function shouldEscalateQaRetry(qaRetryCount) {
  const n = Number(qaRetryCount) || 0;
  if (n < 10) return false;
  return n === 10 || (n - 10) % 25 === 0;
}

/**
 * Build the prominent one-time escalation notice (br018 fix part 2).
 * Names the retry count, the exact missing gate metrics, and the
 * recording mechanism for each.
 * @param {number} qaRetryCount
 * @returns {string}
 */
function buildQaEscalationNotice(qaRetryCount) {
  const lines = [
    '*** QA GATE STUCK — ACTION REQUIRED ***',
    `QA retry count is ${qaRetryCount} and the gate metrics are still not being recorded.`,
    'The act -> qa QA_RETRY loop will keep re-prompting until these exist:',
  ];
  for (const m of QA_GATE_METRICS) {
    lines.push(`  - ${m.id} ${m.gate} (${m.description}) — recorded by: ${m.recordedBy}`);
  }
  lines.push(QA_SELF_HEAL_LINE);
  lines.push('Or force the phase forward with the qa -> report REPORT_DONE escape (guardQaMaxRetryReached).');
  return lines.join('\n');
}

/**
 * Build the short per-retry advisory appended to the normal message once a
 * feature has retries behind it (br018 fix part 3): names the missing
 * metrics so any session can break the loop on the FIRST retry.
 * @param {number} qaRetryCount
 * @param {string[]} missingGates - gate names still unmeasured (e.g. ['qaPassRate'])
 * @returns {string|null} null when there is nothing to advise
 */
function buildQaRetryAdvisory(qaRetryCount, missingGates) {
  const n = Number(qaRetryCount) || 0;
  if (n <= 0 || !Array.isArray(missingGates) || missingGates.length === 0) return null;
  const lines = [
    `QA retry ${n}: the gate still requires ${missingGates.join(', ')} ` +
      '(M11 qaPassRate, M14 runtimeErrorCount, M16 qaCriticalCount).',
    'Report them in the QA output text ("pass rate 100%", "runtime errors 0", "critical 0") so the Stop hook can record them.',
    QA_SELF_HEAL_LINE,
  ];
  return lines.join('\n');
}

module.exports = {
  QA_GATE_METRICS,
  QA_SELF_HEAL_LINE,
  shouldEscalateQaRetry,
  buildQaEscalationNotice,
  buildQaRetryAdvisory,
};

// ============================================================
// Hook entrypoint (bare-require guard: tests require this file for the
// helpers above without executing the hook).
// ============================================================
if (require.main === module) {
  const { readStdinSync, readHookText, outputAllow } = require('../lib/core/io');
  const { debugLog } = require('../lib/core/debug');
  // C7/C8/L2 (audit): atomic+locked reachability ping + single BKIT_VERSION source.
  // L2: this hook was the only Stop/Post handler without a reachability stamp.
  // It is not in today's SessionStart monitored set, so the impact is limited — but
  // stamping here keeps every Stop/Post hook symmetric and future-proofs against
  // qa_phase_stop being added to the monitored set (a silent drop would otherwise
  // look like a real CC plugin-hook drop, per MON-CC-NEW-PLUGIN-HOOK-DROP).
  const { lockedUpdate } = require('../lib/core/state-store');
  const { BKIT_VERSION } = require('../lib/core/version');

  try {
    const mc = require('../lib/quality/metrics-collector');
    const { extractFeatureFromContext, getPdcaStatusFull } = require('../lib/pdca/status');
    const currentStatus = getPdcaStatusFull();
    const feature = extractFeatureFromContext({ currentStatus }) || 'unknown';

    /*
     * Read the QA output as TEXT.
     *
     * `readStdinSync()` returns the parsed hook payload — an object. The previous
     * code assigned it straight to `qaOutput` and called `.match()` on it, which
     * throws TypeError on the very first pattern below. The outer catch swallowed
     * it, so none of M11-M15 was ever collected while the handler still reported
     * success. readHookText normalizes the payload to the assistant's actual
     * reported text (via transcript_path) and always returns a string.
     */
    let qaOutput = '';
    try { qaOutput = readHookText(readStdinSync()); } catch (_) { qaOutput = ''; }

    // M11: QA Pass Rate
    const passRateMatch = qaOutput.match(/pass\s*rate[^0-9]*(\d+\.?\d*)\s*%/i);
    const qaPassRate = passRateMatch ? parseFloat(passRateMatch[1]) : 0;
    mc.collectMetric('M11', feature, qaPassRate, 'qa-lead');

    // M12: Test Coverage L1
    const coverageMatch = qaOutput.match(/coverage[^0-9]*(\d+\.?\d*)\s*%/i);
    const testCoverage = coverageMatch ? parseFloat(coverageMatch[1]) : 0;
    mc.collectMetric('M12', feature, testCoverage, 'qa-test-generator');

    // M13: E2E Scenario Coverage
    const e2eMatch = qaOutput.match(/e2e[^0-9]*coverage[^0-9]*(\d+\.?\d*)\s*%/i);
    const e2eCoverage = e2eMatch ? parseFloat(e2eMatch[1]) : 0;
    mc.collectMetric('M13', feature, e2eCoverage, 'qa-lead');

    // M14: Runtime Error Count
    const errorCountMatch = qaOutput.match(/runtime\s*error[^0-9]*(\d+)/i);
    const runtimeErrors = errorCountMatch ? parseInt(errorCountMatch[1]) : 0;
    mc.collectMetric('M14', feature, runtimeErrors, 'qa-debug-analyst');

    // M15: Data Flow Integrity
    const integrityMatch = qaOutput.match(/data\s*flow\s*integrity[^0-9]*(\d+\.?\d*)\s*%/i);
    const dataFlowIntegrity = integrityMatch ? parseFloat(integrityMatch[1]) : 100;
    mc.collectMetric('M15', feature, dataFlowIntegrity, 'qa-lead');

    /*
     * M16: QA Critical Count — the gate has required this since v2.1.1 but
     * nothing ever produced it (see METRIC_SPECS.M16). qa-lead's Phase 4 reports
     * it alongside passRate, so it is parsed from the same text.
     *
     * Absent means zero, matching M14's existing convention: "no criticals
     * reported" is the normal shape of a clean run. This is safe because a run
     * whose output cannot be parsed at all also yields qaPassRate 0, which fails
     * the gate on its own — M16 defaulting to 0 cannot turn a broken run green.
     */
    const criticalMatch = qaOutput.match(/critical[^0-9]{0,20}(\d+)/i);
    const qaCriticalCount = criticalMatch ? parseInt(criticalMatch[1], 10) : 0;
    mc.collectMetric('M16', feature, qaCriticalCount, 'qa-lead');

    debugLog('QA-Phase-Stop', 'Metrics collected', {
      feature, qaPassRate, testCoverage, e2eCoverage, runtimeErrors, dataFlowIntegrity,
      qaCriticalCount
    });
  } catch (e) {
    debugLog('QA-Phase-Stop', 'Metric collection failed', { error: e.message });
  }

  // L2 fix (audit): reachability ping — unconditional + atomic, fired AFTER metric
  // collection so a collection failure can't skip it. Symmetric with the other
  // Stop/Post hooks (skill-post, unified-*-post, pre-write).
  try {
    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const file = path.join(root, '.bkit', 'runtime', 'hook-reachability.json');
    lockedUpdate(file, (state) => {
      const next = state && typeof state === 'object' ? state : {};
      next.qa_phase_stop = { ts: new Date().toISOString(), version: BKIT_VERSION };
      return next;
    });
  } catch (_) { /* graceful — reachability ping is best-effort */ }

  // br018: retry-spiral surfacing. Read the feature's retry state and append
  // the advisory / escalation notice to the Stop message. Best-effort: a
  // missing registry just means no advisory.
  let qaNotice = null;
  try {
    const { getPdcaStatusFull, extractFeatureFromContext } = require('../lib/pdca/status');
    const mc = require('../lib/quality/metrics-collector');
    const status = getPdcaStatusFull();
    const feature = extractFeatureFromContext({ currentStatus: status }) || 'unknown';
    const featureData = status?.features?.[feature];
    const qaRetryCount = featureData?.qaRetryCount || 0;

    if (shouldEscalateQaRetry(qaRetryCount)) {
      qaNotice = buildQaEscalationNotice(qaRetryCount);
    } else if (qaRetryCount > 0) {
      // Name whichever gate metrics are still unmeasured for this feature.
      let gateMetrics = null;
      try { gateMetrics = mc.toGateFormat(feature); } catch (_) { /* no metrics file */ }
      const missing = QA_GATE_METRICS
        .filter((m) => gateMetrics == null || gateMetrics[m.gate] == null)
        .map((m) => `${m.id} ${m.gate}`);
      qaNotice = buildQaRetryAdvisory(qaRetryCount, missing);
    }
  } catch (e) {
    const { debugLog } = require('../lib/core/debug');
    debugLog('QA-Phase-Stop', 'Retry advisory skipped', { error: e.message });
  }

  let message = `QA Phase completed.

Next steps:
1. Review QA report in docs/05-qa/
2. If QA PASS: proceed to /pdca report
3. If QA FAIL: review failures and /pdca iterate`;

  if (qaNotice) {
    message += `\n\n${qaNotice}`;
  }

  outputAllow(message, 'Stop');
}
