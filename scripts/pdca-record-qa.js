#!/usr/bin/env node
'use strict';
/**
 * pdca-record-qa.js — the sanctioned QA-results recording path (br018).
 *
 * For sessions where hook dispatch is dead (br015/br017 family) and the
 * QA gate metrics (M11/M14/M16) never record, every Stop bounces
 * act -> qa (QA_RETRY) silently. This CLI records the measurements
 * through the SAME sanctioned lib APIs the state machine uses —
 * lib/quality/metrics-collector.collectMetric + lib/pdca/state-machine
 * transition — never a direct write of .bkit/state/*.json.
 *
 * Usage:
 *   node scripts/pdca-record-qa.js <feature> --pass-rate N --critical N --runtime-errors N
 *
 * Flow: collect M11/M16/M14 -> (if phase 'act' with qaRetryPending:
 * transition act -> qa QA_RETRY, same as the workaround) -> transition
 * qa + QA_PASS when pass-rate >= 90 and critical == 0, else QA_FAIL.
 * Exit codes: 0 ok · 2 usage/feature-not-found · 3 transition blocked.
 *
 * @module scripts/pdca-record-qa
 * @version 2.1.39
 * @since 2.1.39
 */

const mc = require('../lib/quality/metrics-collector');
const sm = require('../lib/pdca/state-machine');
const { getFeatureStatus } = require('../lib/pdca');

const EXIT = { OK: 0, USAGE: 2, BLOCKED: 3 };

const USAGE = 'usage: node scripts/pdca-record-qa.js <feature> ' +
  '--pass-rate N --critical N --runtime-errors N';

/** Parse `--flag value` pairs plus one bare positional (the feature). */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pass-rate' || a === '--critical' || a === '--runtime-errors') {
      const v = parseFloat(argv[++i]);
      if (Number.isNaN(v)) return { error: `missing numeric value after ${a}` };
      out[a.slice(2)] = v;
    } else if (a.startsWith('--')) {
      return { error: `unknown flag: ${a}` };
    } else {
      out._.push(a);
    }
  }
  return out;
}

/**
 * Record QA metrics and drive the state machine for a feature.
 * Split from run() so unit tests can call it with explicit deps.
 * @param {string} feature
 * @param {{passRate:number, critical:number, runtimeErrors:number}} m
 * @returns {{result:Object, exitCode:number}} result is the final JSON body
 */
function recordQa(feature, m) {
  // 1. Record the three gate metrics (same collector the Stop hook uses).
  mc.collectMetric('M11', feature, m.passRate, 'pdca-record-qa');
  mc.collectMetric('M16', feature, m.critical, 'pdca-record-qa');
  mc.collectMetric('M14', feature, m.runtimeErrors, 'pdca-record-qa');

  // 2. Load context AFTER collecting so loadContext hydrates qaPassRate /
  //    qaCriticalCount from the metrics file we just wrote.
  const ctx = sm.loadContext(feature) || sm.createContext(feature);
  const phase = ctx.currentState;

  const steps = [];

  // 3. If the feature sits in act owing a QA retry (the spiral state), pay
  //    the debt first — the workaround path: transition('act','QA_RETRY').
  if (phase === 'act') {
    const retry = sm.transition('act', 'QA_RETRY', ctx);
    steps.push({ event: 'QA_RETRY', success: retry.success, blockedBy: retry.blockedBy });
    if (!retry.success) {
      return {
        result: {
          error: 'E-PDCA-QA-BLOCKED', feature, phase, steps,
          message: retry.message || 'act -> qa QA_RETRY transition blocked',
        },
        exitCode: EXIT.BLOCKED,
      };
    }
    // initQaPhase nulls ctx.qaPassRate/qaCriticalCount (fresh measurement
    // slot for the new QA run) — but our measurement is already recorded in
    // quality-metrics.json, so re-hydrate the context before the verdict.
    Object.assign(ctx, sm.loadContext(feature) || {});
  }

  // 4. Final QA verdict. The brief's contract: QA_PASS when pass-rate >= 90
  //    and critical == 0, else QA_FAIL. (guardQaPass itself enforces >= 95;
  //    a 90-94 pass-rate will be blocked by the guard and reported as such.)
  const event = (m.passRate >= 90 && m.critical === 0) ? 'QA_PASS' : 'QA_FAIL';
  const tr = sm.transition('qa', event, ctx);
  steps.push({ event, success: tr.success, blockedBy: tr.blockedBy });

  return {
    result: {
      recorded: { M11: m.passRate, M16: m.critical, M14: m.runtimeErrors },
      feature, phase, event,
      transitionedTo: tr.success ? tr.currentState : null,
      steps,
      blockedMessage: tr.message || null,
    },
    exitCode: tr.success ? EXIT.OK : EXIT.BLOCKED,
  };
}

/**
 * CLI entry.
 * @param {string[]} argv - args after the script name
 * @returns {number} exit code
 */
function run(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`${USAGE}\nerror: ${parsed.error}\n`);
    return EXIT.USAGE;
  }
  const feature = parsed._[0];
  if (!feature || parsed['pass-rate'] == null || parsed.critical == null ||
      parsed['runtime-errors'] == null) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT.USAGE;
  }
  if (!getFeatureStatus(feature)) {
    process.stdout.write(JSON.stringify({
      error: 'E-PDCA-NOTFOUND', feature,
    }) + '\n');
    return EXIT.USAGE;
  }
  const { result, exitCode } = recordQa(feature, {
    passRate: parsed['pass-rate'],
    critical: parsed.critical,
    runtimeErrors: parsed['runtime-errors'],
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return exitCode;
}

module.exports = { run, recordQa, parseArgs, EXIT, USAGE };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
