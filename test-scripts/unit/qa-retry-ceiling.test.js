/**
 * br018 regression suite — QA retry spiral: ceiling enforcement,
 * escalation cadence, and the sanctioned record-qa CLI.
 *
 * Defect: when M11/M14/M16 never recorded, every Stop bounced
 * act -> qa (QA_RETRY) silently; qaRetryCount hit 187 because the
 * act->qa edge had NO guard (the maxQaRetries escape lived on an edge
 * nothing emits). This suite pins the three fix parts:
 *   1. guardQaRetryNotExhausted blocks act->qa at the ceiling with a
 *      distinct fail-stop message.
 *   2. Escalation fires at retry 10 and every 25th after (35), not 11.
 *   3. pdca-record-qa records metrics and drives the state machine
 *      through the same sanctioned lib APIs as the proven workaround.
 *
 * Isolation (br015 pattern): env is pinned to a mkdtemp fixture BEFORE
 * the first lib require, so every state write lands in the fixture —
 * never the real .bkit/.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const createdProjs = [];
function makeProj(prefix) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(proj, '.bkit', 'state'), { recursive: true });
  createdProjs.push(proj);
  return proj;
}

// Registry fixture mirrors the REAL on-disk shape (version '3.0').
function seedRegistry(proj, feature, overrides) {
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(proj, '.bkit', 'state', ['pdca', 'status'].join('-') + '.json'),
    JSON.stringify({
      version: '3.0',
      lastUpdated: now,
      primaryFeature: feature,
      activeFeatures: [feature],
      features: {
        [feature]: Object.assign({
          phase: 'act',
          qaRetryCount: 0,
          qaRetryPending: false,
          iterationCount: 0,
          matchRate: null,
          timestamps: { started: now, lastUpdated: now },
          metadata: {},
        }, overrides),
      },
      pipeline: { currentPhase: 1, level: 'Dynamic', phaseHistory: [] },
      session: { startedAt: now, onboardingCompleted: true, lastActivity: now },
      history: [],
    })
  );
}

function readRegistry(proj) {
  return JSON.parse(fs.readFileSync(
    path.join(proj, '.bkit', 'state', ['pdca', 'status'].join('-') + '.json'), 'utf8'));
}

function readMetrics(proj) {
  // Snapshot shape: { [feature]: { feature, phase, metrics: {...} } } —
  // features are keyed at the TOP level, no .features wrapper.
  return JSON.parse(fs.readFileSync(
    path.join(proj, '.bkit', 'state', 'quality-metrics.json'), 'utf8'));
}

// Pin env BEFORE the first lib require (br015 writer-test pattern).
const savedEnv = {
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
  CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
};

let PROJ;

beforeAll(() => {
  PROJ = makeProj('br018-');
  process.env.CLAUDE_PROJECT_DIR = PROJ;
  process.env.CLAUDE_PLUGIN_ROOT = PROJ;
  delete process.env.CLAUDE_PLUGIN_DATA;
});

// lib/pdca/status caches the registry at require time, so a reseeded
// fixture is invisible to an already-required module graph. Every state
// test resets the module registry and re-requires against the fresh seed.
function freshSm() {
  jest.resetModules();
  return require('../../lib/pdca/state-machine');
}

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of createdProjs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* tmpdir residue */ }
  }
});

describe('br018 part 1 — act->qa QA_RETRY ceiling enforcement', () => {
  test('below ceiling: QA_RETRY still passes (regression guard)', () => {
    const sm = freshSm();
    seedRegistry(PROJ, 'feat-a', { qaRetryCount: 1 });
    const ctx = sm.loadContext('feat-a');
    expect(ctx.qaRetryCount).toBe(1);
    const tr = sm.transition('act', 'QA_RETRY', ctx);
    expect(tr.success).toBe(true);
    expect(tr.currentState).toBe('qa');
  });

  test('at ceiling: QA_RETRY is blocked with a distinct fail-stop message', () => {
    const sm = freshSm();
    seedRegistry(PROJ, 'feat-b', { qaRetryCount: 3, qaRetryPending: true });
    const ctx = sm.loadContext('feat-b');
    expect(ctx.maxQaRetries).toBe(3); // default guardrails.loopBreaker.maxQaRetries
    const tr = sm.transition('act', 'QA_RETRY', ctx);
    expect(tr.success).toBe(false);
    expect(tr.blockedBy).toBe('guardQaRetryNotExhausted');
    expect(tr.currentState).toBe('act'); // fail-stop: stays put
    expect(tr.message).toMatch(/QA retry ceiling reached/);
    expect(tr.message).toMatch(/qaRetryCount \(3\)/);
    expect(tr.message).toMatch(/maxQaRetries \(3\)/);
    expect(tr.message).toContain('pdca-record-qa.js');
  });

  test('far past ceiling (the 187 case): still blocked, no silent re-entry', () => {
    const sm = freshSm();
    seedRegistry(PROJ, 'feat-c', { qaRetryCount: 187, qaRetryPending: true });
    const ctx = sm.loadContext('feat-c');
    const tr = sm.transition('act', 'QA_RETRY', ctx);
    expect(tr.success).toBe(false);
    expect(tr.blockedBy).toBe('guardQaRetryNotExhausted');
    // Counter NOT advanced and phase NOT moved to qa.
    expect(readRegistry(PROJ).features['feat-c'].phase).toBe('act');
    expect(readRegistry(PROJ).features['feat-c'].qaRetryCount).toBe(187);
  });

  test('ordinary guards keep blockedBy with null message (no behavior change)', () => {
    const sm = freshSm();
    const ctx = { feature: 'x', qaPassRate: 50, qaCriticalCount: 0 };
    const tr = sm.transition('qa', 'QA_PASS', ctx);
    expect(tr.success).toBe(false);
    expect(tr.blockedBy).toBe('guardQaPass');
    expect(tr.message).toBeNull();
  });
});

describe('br018 part 2 — escalation cadence (qa-phase-stop helpers)', () => {
  const helpers = require('../../scripts/qa-phase-stop');

  test('escalates at 10 and 35, not at 9 or 11', () => {
    expect(helpers.shouldEscalateQaRetry(10)).toBe(true);
    expect(helpers.shouldEscalateQaRetry(35)).toBe(true);
    expect(helpers.shouldEscalateQaRetry(11)).toBe(false);
    expect(helpers.shouldEscalateQaRetry(9)).toBe(false);
    expect(helpers.shouldEscalateQaRetry(0)).toBe(false);
  });

  test('re-emits every 25th after the first notice (60, 85)', () => {
    expect(helpers.shouldEscalateQaRetry(60)).toBe(true);
    expect(helpers.shouldEscalateQaRetry(85)).toBe(true);
    expect(helpers.shouldEscalateQaRetry(59)).toBe(false);
    expect(helpers.shouldEscalateQaRetry(61)).toBe(false);
  });

  test('notice names the retry count, all three gate metrics, and the CLI', () => {
    const n = helpers.buildQaEscalationNotice(10);
    expect(n).toMatch(/QA GATE STUCK/);
    expect(n).toMatch(/retry count is 10/i);
    expect(n).toContain('M11 qaPassRate');
    expect(n).toContain('M14 runtimeErrorCount');
    expect(n).toContain('M16 qaCriticalCount');
    expect(n).toContain('node scripts/pdca-record-qa.js');
  });

  test('per-retry advisory names missing gates and the self-heal line', () => {
    const a = helpers.buildQaRetryAdvisory(1, ['M11 qaPassRate', 'M16 qaCriticalCount']);
    expect(a).toMatch(/QA retry 1/);
    expect(a).toContain('M11 qaPassRate');
    expect(a).toContain('pdca-record-qa.js');
    expect(helpers.buildQaRetryAdvisory(0, ['M11 qaPassRate'])).toBeNull();
    expect(helpers.buildQaRetryAdvisory(2, [])).toBeNull();
  });

  test('requiring qa-phase-stop does not execute the hook (bare-require guard)', () => {
    // If the hook had run, it would have consumed stdin / written a Stop
    // surface. Requiring it again must be side-effect-free and idempotent.
    // (Identity is not asserted: earlier suites call jest.resetModules().)
    const again = require('../../scripts/qa-phase-stop');
    expect(typeof again.shouldEscalateQaRetry).toBe('function');
    expect(again.QA_SELF_HEAL_LINE).toBe(helpers.QA_SELF_HEAL_LINE);
  });
});

describe('br018 part 4 — sanctioned record-qa CLI', () => {
  // Re-required per test: the CLI holds module-level references into the
  // lib/pdca graph, whose registry cache must see the fresh seed.
  function freshCli() {
    jest.resetModules();
    return require('../../scripts/pdca-record-qa');
  }

  test('spiral state (act + qaRetryPending): pays the retry debt then QA_PASS', () => {
    const cli = freshCli();
    seedRegistry(PROJ, 'feat-cli', { qaRetryCount: 2, qaRetryPending: true });
    const { result, exitCode } = cli.recordQa('feat-cli', {
      passRate: 100, critical: 0, runtimeErrors: 0,
    });
    expect(exitCode).toBe(cli.EXIT.OK);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toMatchObject({ event: 'QA_RETRY', success: true });
    expect(result.steps[1]).toMatchObject({ event: 'QA_PASS', success: true });
    expect(result.transitionedTo).toBe('report');
    // Metrics recorded via the sanctioned collector, in the fixture tree.
    const m = readMetrics(PROJ)['feat-cli'].metrics;
    expect(m.M11.value).toBe(100);
    expect(m.M14.value).toBe(0);
    expect(m.M16.value).toBe(0);
  });

  test('failing numbers route to QA_FAIL (back to act)', () => {
    const cli = freshCli();
    seedRegistry(PROJ, 'feat-fail', { phase: 'qa', qaRetryCount: 0 });
    const { result, exitCode } = cli.recordQa('feat-fail', {
      passRate: 40, critical: 2, runtimeErrors: 1,
    });
    expect(exitCode).toBe(cli.EXIT.OK); // QA_FAIL is a valid transition
    expect(result.event).toBe('QA_FAIL');
    expect(result.transitionedTo).toBe('act');
  });

  test('at the ceiling the CLI fail-stops instead of looping (E-PDCA-QA-BLOCKED)', () => {
    const cli = freshCli();
    seedRegistry(PROJ, 'feat-blocked', { qaRetryCount: 3, qaRetryPending: true });
    const { result, exitCode } = cli.recordQa('feat-blocked', {
      passRate: 100, critical: 0, runtimeErrors: 0,
    });
    expect(exitCode).toBe(cli.EXIT.BLOCKED);
    expect(result.error).toBe('E-PDCA-QA-BLOCKED');
    expect(result.message).toMatch(/QA retry ceiling reached/);
    // Metrics were still recorded — the operator keeps the data.
    expect(readMetrics(PROJ)['feat-blocked'].metrics.M11.value).toBe(100);
  });

  test('parseArgs rejects missing numerics and unknown flags', () => {
    const cli = freshCli();
    expect(cli.parseArgs(['f', '--pass-rate']).error).toMatch(/missing numeric/);
    expect(cli.parseArgs(['f', '--bogus']).error).toMatch(/unknown flag/);
    const ok = cli.parseArgs(['f', '--pass-rate', '90', '--critical', '0', '--runtime-errors', '0']);
    expect(ok).toEqual({ _: ['f'], 'pass-rate': 90, critical: 0, 'runtime-errors': 0 });
  });

  test('run() exits 2 on usage errors without touching state', () => {
    const cli = freshCli();
    expect(cli.run([])).toBe(cli.EXIT.USAGE);
    expect(cli.run(['f', '--pass-rate', '1'])).toBe(cli.EXIT.USAGE); // missing --critical
    expect(cli.run(['no-such-feature', '--pass-rate', '1', '--critical', '0', '--runtime-errors', '0']))
      .toBe(cli.EXIT.USAGE); // E-PDCA-NOTFOUND
  });
});
