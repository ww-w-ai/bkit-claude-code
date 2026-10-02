/**
 * skill-stop-envelope.test.js — br014 (fix-br013-014-wave, D2)
 *
 * pdca-skill-stop must derive its action from the transcript's most recent
 * pdca Skill tool_use (the envelope the skill actually fired with), with the
 * text regex and the registry phase as fallbacks. Before br014 a live
 * report-phase turn whose prose never contained the literal "pdca report"
 * produced action=null and missed the report→completed advance.
 *
 * Isolation: every fixture lives in an os.tmpdir() project; spawned runs get
 * CLAUDE_PROJECT_DIR/CLAUDE_PLUGIN_ROOT pointed at it and CLAUDE_PLUGIN_DATA
 * removed, so no write can reach the real .bkit/, docs/, or plugin data.
 * Helper-level tests require the script's bare-require branch, which exports
 * only pure helpers (no hook execution).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'pdca-skill-stop.js');
const HELPERS = require(SCRIPT);

const fixtures = [];
const savedEnv = {};

beforeAll(() => {
  for (const key of ['CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA']) {
    savedEnv[key] = process.env[key];
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* tmpdir residue is harmless */ }
  }
});

/** Fresh isolated fixture project directory. */
function makeProj(label) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), `br014-${label}-`));
  fixtures.push(proj);
  return proj;
}

/** Write a transcript JSONL of raw entry objects; returns its path. */
function writeTranscript(proj, entries) {
  const tp = path.join(proj, `transcript-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`);
  fs.writeFileSync(tp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return tp;
}

const assistantToolUse = (skill, args) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill, args } }] },
});

const assistantText = (text) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
});

/** Registry fixture at .bkit/state/pdca-status.json (v3, pre-migration-free). */
function writeRegistry(proj, { primaryFeature, features }) {
  const statusPath = path.join(proj, '.bkit', 'state', 'pdca-status.json');
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const now = new Date().toISOString();
  const status = {
    version: '3.0',
    lastUpdated: now,
    activeFeatures: Object.keys(features),
    primaryFeature: primaryFeature || null,
    features: Object.fromEntries(
      Object.entries(features).map(([name, f]) => [
        name,
        {
          phase: f.phase,
          phaseNumber: f.phaseNumber || null,
          matchRate: null,
          iterationCount: 0,
          requirements: [],
          documents: {},
          timestamps: { started: f.started || now, lastUpdated: now },
          ...f.extra,
        },
      ])
    ),
    pipeline: { currentPhase: 1, level: 'Dynamic', phaseHistory: [] },
    session: { startedAt: now, onboardingCompleted: true, lastActivity: now },
    history: [],
  };
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
  return statusPath;
}

function writeDoc(proj, relPath) {
  const abs = path.join(proj, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '# fixture doc\n');
  return abs;
}

function readRegistry(proj) {
  return JSON.parse(
    fs.readFileSync(path.join(proj, '.bkit', 'state', 'pdca-status.json'), 'utf8')
  );
}

/**
 * Spawn the hook the way Claude Code would: stdin payload JSON, isolated
 * fixture project via env. Returns { status, stdout, stderr }.
 */
function runHook(proj, payload) {
  return spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    cwd: proj,
    encoding: 'utf8',
    timeout: 20000,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_PLUGIN_DATA')
        .map(([k, v]) => [k, k === 'CLAUDE_PROJECT_DIR' || k === 'CLAUDE_PLUGIN_ROOT' ? proj : v])
        .concat([['CLAUDE_PROJECT_DIR', proj], ['CLAUDE_PLUGIN_ROOT', proj]])
    ),
  });
}

describe('parsePdcaSkillArgs (pure)', () => {
  test('action + feature', () => {
    expect(HELPERS.parsePdcaSkillArgs('report fix-x')).toEqual({ action: 'report', feature: 'fix-x' });
  });

  test('action only, feature null', () => {
    expect(HELPERS.parsePdcaSkillArgs('status')).toEqual({ action: 'status', feature: null });
  });

  test('case-insensitive action', () => {
    expect(HELPERS.parsePdcaSkillArgs('REPORT fix-x')).toEqual({ action: 'report', feature: 'fix-x' });
  });

  test('flags skipped, first non-flag token is the feature candidate', () => {
    expect(HELPERS.parsePdcaSkillArgs('plan --scope fix-y')).toEqual({ action: 'plan', feature: 'fix-y' });
  });

  test('unknown first token rejected', () => {
    expect(HELPERS.parsePdcaSkillArgs('bogus fix-x')).toBeNull();
    expect(HELPERS.parsePdcaSkillArgs('')).toBeNull();
    expect(HELPERS.parsePdcaSkillArgs(null)).toBeNull();
  });
});

describe('isPdcaSkillName (pure)', () => {
  test('accepts pdca and bkit:pdca, rejects others', () => {
    expect(HELPERS.isPdcaSkillName('pdca')).toBe(true);
    expect(HELPERS.isPdcaSkillName('bkit:pdca')).toBe(true);
    expect(HELPERS.isPdcaSkillName('pdca-report')).toBe(false);
    expect(HELPERS.isPdcaSkillName('bkit:sprint')).toBe(false);
    expect(HELPERS.isPdcaSkillName(undefined)).toBe(false);
  });
});

describe('deriveEnvelopeAction (fs, tmpdir transcripts)', () => {
  test('(a) Skill tool_use bkit:pdca "report fix-x" is derived', () => {
    const proj = makeProj('env-a');
    const tp = writeTranscript(proj, [
      assistantToolUse('bkit:pdca', 'report fix-x'),
      assistantText('The completion report has been generated and filed.'),
    ]);
    expect(HELPERS.deriveEnvelopeAction({ transcript_path: tp })).toEqual({
      action: 'report',
      feature: 'fix-x',
    });
  });

  test('most recent pdca tool_use wins over an older one', () => {
    const proj = makeProj('env-recent');
    const tp = writeTranscript(proj, [
      assistantToolUse('pdca', 'plan fix-old'),
      assistantToolUse('bkit:pdca', 'report fix-new'),
      assistantText('Report done.'),
    ]);
    expect(HELPERS.deriveEnvelopeAction({ transcript_path: tp })).toEqual({
      action: 'report',
      feature: 'fix-new',
    });
  });

  test('(d) non-pdca Skill tool_use (bkit:sprint) is ignored', () => {
    const proj = makeProj('env-d');
    const tp = writeTranscript(proj, [
      assistantToolUse('bkit:sprint', 'start sp1'),
      assistantText('Sprint started.'),
    ]);
    expect(HELPERS.deriveEnvelopeAction({ transcript_path: tp })).toBeNull();
  });

  test('non-JSON / partial lines are skipped, not fatal', () => {
    const proj = makeProj('env-garbage');
    const tp = path.join(proj, 't.jsonl');
    fs.writeFileSync(
      tp,
      '{"type":"assistant","message":{"content":[{"type":"tool_u' + '\n' +
      JSON.stringify(assistantToolUse('bkit:pdca', 'qa fix-x')) + '\n' +
      '\n' +
      'not json at all\n'
    );
    expect(HELPERS.deriveEnvelopeAction({ transcript_path: tp })).toEqual({
      action: 'qa',
      feature: 'fix-x',
    });
  });

  test('no transcript_path (CLI/subprocess use) → null, tier 1 skipped silently', () => {
    expect(HELPERS.deriveEnvelopeAction({})).toBeNull();
    expect(HELPERS.deriveEnvelopeAction(null)).toBeNull();
  });

  test('missing transcript file → null, never throws', () => {
    expect(HELPERS.deriveEnvelopeAction({ transcript_path: '/nonexistent/br014/nope.jsonl' })).toBeNull();
  });
});

describe('end-to-end hook spawn (isolated fixture project)', () => {
  test('(a) envelope beats absent prose: report-phase turn with NO "pdca" literal advances report→completed', () => {
    const proj = makeProj('e2e-a');
    writeRegistry(proj, {
      primaryFeature: 'other-feature',
      features: {
        'other-feature': { phase: 'design' },
        'fix-x': { phase: 'report' },
      },
    });
    // plan doc so the main update gate (findPlanDoc||findDesignDoc) passes;
    // report doc so the br005a completion clause's findDoc succeeds.
    writeDoc(proj, 'docs/01-plan/features/fix-x.plan.en.md');
    writeDoc(proj, 'docs/04-report/features/fix-x.report.en.md');
    const tp = writeTranscript(proj, [
      assistantToolUse('bkit:pdca', 'report fix-x'),
      assistantText('Completion report written and filed for the cycle.'),
    ]);

    const res = runHook(proj, { hook_event_name: 'Stop', session_id: 'br014-test-a', cwd: proj, transcript_path: tp });
    expect(res.status).toBe(0);

    const status = readRegistry(proj);
    expect(status.features['fix-x'].phase).toBe('completed');
  });

  test('(a2) envelope feature wins over the primaryFeature fallback when tier 2 is ambiguous', () => {
    const proj = makeProj('e2e-a2');
    // Two features sit at phase 'report' → resolveStopFeature tier 2 is
    // ambiguous → pre-br014 it fell through to primaryFeature ('other'),
    // binding the report against the WRONG feature. The envelope feature
    // must override that fallback.
    writeRegistry(proj, {
      primaryFeature: 'other-feature',
      features: {
        'other-feature': { phase: 'qa' },
        'fix-x': { phase: 'report' },
        'fix-w': { phase: 'report' },
      },
    });
    writeDoc(proj, 'docs/01-plan/features/fix-x.plan.en.md');
    writeDoc(proj, 'docs/04-report/features/fix-x.report.en.md');
    const tp = writeTranscript(proj, [
      assistantToolUse('bkit:pdca', 'report fix-x'),
      assistantText('Report generated and filed; nothing further to run.'),
    ]);

    const res = runHook(proj, { hook_event_name: 'Stop', session_id: 'br014-test-a2', cwd: proj, transcript_path: tp });
    expect(res.status).toBe(0);

    const status = readRegistry(proj);
    expect(status.features['fix-x'].phase).toBe('completed');
    // The foreign primaryFeature must NOT have been recorded as the report.
    expect(status.features['other-feature'].phase).toBe('qa');
  });

  test('(b) no envelope entry + text "/pdca plan fix-y" → text path still works', () => {
    const proj = makeProj('e2e-b');
    writeRegistry(proj, {
      primaryFeature: 'fix-y',
      features: { 'fix-y': { phase: 'design' } },
    });
    writeDoc(proj, 'docs/01-plan/features/fix-y.plan.en.md');
    const tp = writeTranscript(proj, [
      assistantText('Proceeding to run /pdca plan fix-y for the next cycle.'),
    ]);

    const res = runHook(proj, { hook_event_name: 'Stop', session_id: 'br014-test-b', cwd: proj, transcript_path: tp });
    expect(res.status).toBe(0);

    const status = readRegistry(proj);
    expect(status.features['fix-y'].phase).toBe('plan');
  });

  test('(c) neither envelope nor text → phase fallback advances report→completed', () => {
    const proj = makeProj('e2e-c');
    writeRegistry(proj, {
      primaryFeature: 'fix-z',
      features: { 'fix-z': { phase: 'report' } },
    });
    writeDoc(proj, 'docs/01-plan/features/fix-z.plan.en.md');
    writeDoc(proj, 'docs/04-report/features/fix-z.report.en.md');

    // No transcript_path at all: readHookText degrades to JSON.stringify of
    // the payload (no "pdca <action>" literal), envelope tier skipped.
    const res = runHook(proj, { hook_event_name: 'Stop', session_id: 'br014-test-c', cwd: proj });
    expect(res.status).toBe(0);

    const status = readRegistry(proj);
    expect(status.features['fix-z'].phase).toBe('completed');
  });
});
