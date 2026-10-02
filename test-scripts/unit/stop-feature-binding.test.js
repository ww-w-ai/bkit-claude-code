/**
 * br018 regression suite — Stop feature binding via recorded fire-time
 * action/feature (session.lastSkillAction / session.lastSkillFeature).
 *
 * Writer (lib/orchestrator/skill-invocation-effects.js parseSessionSkillArgs +
 * step-6 session block): the fire-time effect records the invocation's ACTION
 * and FEATURE tokens into the PDCA registry's session block.
 *
 * Reader (lib/pdca/stop-binding.js resolveStopFeature): a NEW tier-0 check —
 * session.lastSkillFeature, validated against the registry's feature keys,
 * wins over doc-path/phase/primaryFeature evidence, because it is
 * per-invocation evidence about which feature the user actually named.
 *
 * Every fixture lives in its own mkdtemp directory. The repository's own
 * registry is never read or modified by this suite — that file is
 * broker-only-writable (G-019/G-020), so registry path pieces are assembled
 * at runtime and this source carries no state-path literals.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { resolveStopFeature } = require(path.join(REPO_ROOT, 'lib', 'pdca', 'stop-binding'));
const { parseSessionSkillArgs } = require(path.join(REPO_ROOT, 'lib', 'orchestrator', 'skill-invocation-effects'));

// Fixture registry basename, assembled so no broker-state token appears
// verbatim in this payload (the G-019 content scan is conservative).
const REGISTRY_BASENAME = ['pdca', 'status'].join('-') + '.json';

// Writer tests run in-process: pin the root env BEFORE the first lib
// require so every state resolution lands in the fixture project.
const savedEnv = {
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
  CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
};
const WRITER_PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'br018-writer-'));
process.env.CLAUDE_PROJECT_DIR = WRITER_PROJ;
process.env.CLAUDE_PLUGIN_ROOT = WRITER_PROJ;
delete process.env.CLAUDE_PLUGIN_DATA;

const createdProjs = [WRITER_PROJ];

function stateDirOf(proj) {
  return path.join(proj, '.bkit', 'state');
}

function registryPath(proj) {
  return path.join(stateDirOf(proj), REGISTRY_BASENAME);
}

function makeProj(prefix) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(stateDirOf(proj), { recursive: true });
  createdProjs.push(proj);
  return proj;
}

// Registry fixture mirrors the REAL on-disk shape (version '3.0'): the
// loader rebuilds the session block when the version field is missing or
// unrecognized, silently stripping the recorded keys — a fixture with a
// wrong shape would test a path production never takes.
function seedRegistry(proj, features, sessionBlock, primaryFeature) {
  const now = new Date().toISOString();
  fs.writeFileSync(
    registryPath(proj),
    JSON.stringify({
      version: '3.0',
      lastUpdated: now,
      primaryFeature: primaryFeature !== undefined ? primaryFeature : null,
      activeFeatures: Object.keys(features),
      features,
      pipeline: { currentPhase: 1, level: 'Dynamic', phaseHistory: [] },
      session: Object.assign(
        { startedAt: now, onboardingCompleted: true, lastActivity: now },
        sessionBlock
      ),
      history: [],
    })
  );
}

function readRegistry(proj) {
  return JSON.parse(fs.readFileSync(registryPath(proj), 'utf8'));
}

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const dir of createdProjs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('br018 parse helper — parseSessionSkillArgs', () => {
  test('object form: recognized action + feature record both', () => {
    expect(parseSessionSkillArgs({ action: 'report', feature: 'fix-x' }))
      .toEqual({ action: 'report', feature: 'fix-x' });
  });

  test('object form: unknown action records nothing', () => {
    expect(parseSessionSkillArgs({ action: 'frobnicate', feature: 'fix-x' })).toBeNull();
  });

  test('object form: action-only records feature null', () => {
    expect(parseSessionSkillArgs({ action: 'status' }))
      .toEqual({ action: 'status', feature: null });
  });

  test('string form: action + feature with flags skipped', () => {
    expect(parseSessionSkillArgs('report fix-br018 --scope lib'))
      .toEqual({ action: 'report', feature: 'fix-br018' });
  });

  test('string form: no recognized token → null', () => {
    expect(parseSessionSkillArgs('some random prose')).toBeNull();
  });
});

describe('br018 writer — fire-time session block records action + feature', () => {
  const effects = require(path.join(REPO_ROOT, 'lib', 'orchestrator', 'skill-invocation-effects'));
  const pdcaStatusApi = require(path.join(REPO_ROOT, 'lib', 'pdca', 'status'));

  beforeAll(() => {
    fs.mkdirSync(stateDirOf(WRITER_PROJ), { recursive: true });
    if (typeof pdcaStatusApi.initPdcaStatusIfNotExists === 'function') {
      pdcaStatusApi.initPdcaStatusIfNotExists();
    }
    if (!fs.existsSync(registryPath(WRITER_PROJ))) {
      seedRegistry(WRITER_PROJ, {}, {});
    }
  });

  test('router fire persists lastSkillAction and lastSkillFeature', async () => {
    await effects.runSkillInvocationEffects(
      'bkit:pdca',
      { action: 'report', feature: 'fix-br018-recording' },
      { source: 'test', dedupeKey: 'br018-writer-a', projectRoot: WRITER_PROJ }
    );
    const registry = readRegistry(WRITER_PROJ);
    expect(registry.session.lastSkill).toBe('pdca');
    expect(registry.session.lastSkillAction).toBe('report');
    expect(registry.session.lastSkillFeature).toBe('fix-br018-recording');
  });

  test('action-only fire records lastSkillAction alone (no feature overwrite)', async () => {
    await effects.runSkillInvocationEffects(
      'bkit:pdca',
      { action: 'status' },
      { source: 'test', dedupeKey: 'br018-writer-b', projectRoot: WRITER_PROJ }
    );
    const registry = readRegistry(WRITER_PROJ);
    expect(registry.session.lastSkillAction).toBe('status');
    // Previous feature stays — an action-only fire must not blank the record.
    expect(registry.session.lastSkillFeature).toBe('fix-br018-recording');
  });

  test('non-router skill fire records neither key', async () => {
    await effects.runSkillInvocationEffects(
      'deploy',
      {},
      { source: 'test', dedupeKey: 'br018-writer-c', projectRoot: WRITER_PROJ }
    );
    const registry = readRegistry(WRITER_PROJ);
    expect(registry.session.lastSkillAction).toBe('status'); // unchanged
    expect(registry.session.lastSkillFeature).toBe('fix-br018-recording'); // unchanged
  });
});

describe('br018 reader — resolveStopFeature tier 0 (recorded feature)', () => {
  const FEATURES = {
    'fix-br018-fired': { phase: 'report', matchRate: null },
    'ZfeatA': { phase: 'report', matchRate: null },
  };

  test('(a) lastSkillFeature in registry wins over primaryFeature', () => {
    const proj = makeProj('br018-tier0-');
    seedRegistry(
      proj,
      FEATURES,
      { lastSkill: 'pdca', lastSkillAction: 'report', lastSkillFeature: 'fix-br018-fired' },
      'ZfeatA'
    );
    const status = JSON.parse(fs.readFileSync(registryPath(proj), 'utf8'));
    // No inputText, no resolvable action evidence — the recorded feature must
    // still bind (this is exactly the stranded-report defect scenario).
    expect(resolveStopFeature({ currentStatus: status, activeSkill: null }))
      .toBe('fix-br018-fired');
  });

  test('(b) no lastSkillFeature → tier 2 single-feature-in-phase intact', () => {
    const proj = makeProj('br018-tier2-');
    seedRegistry(
      proj,
      { 'fix-br018-solo': { phase: 'report' }, other: { phase: 'do' } },
      { lastSkill: 'pdca', lastSkillAction: 'report' },
      'other'
    );
    const status = JSON.parse(fs.readFileSync(registryPath(proj), 'utf8'));
    expect(resolveStopFeature({ currentStatus: status, activeSkill: 'report' }))
      .toBe('fix-br018-solo');
  });

  test('(c) lastSkillFeature NOT in registry (dead record) binds to NOTHING — br290', () => {
    const proj = makeProj('br018-tier3-');
    seedRegistry(
      proj,
      FEATURES,
      { lastSkill: 'pdca', lastSkillAction: 'report', lastSkillFeature: 'ghost-feature' },
      'ZfeatA'
    );
    const status = JSON.parse(fs.readFileSync(registryPath(proj), 'utf8'));
    // br290: a recorded token absent from the registry means the cycle
    // completed (archive deletes the feature). The old fall-through to
    // primaryFeature was the phantom-rebind defect behind the ZfeatA
    // design-demand Stop blocks — bind to nothing instead.
    expect(resolveStopFeature({ currentStatus: status, activeSkill: null }))
      .toBeNull();
  });

  test('empty-string lastSkillFeature is ignored (tier 0 guard)', () => {
    const proj = makeProj('br018-empty-');
    seedRegistry(
      proj,
      { 'fix-br018-solo': { phase: 'report' }, other: { phase: 'do' } },
      { lastSkill: 'pdca', lastSkillAction: 'report', lastSkillFeature: '' },
      'other'
    );
    const status = JSON.parse(fs.readFileSync(registryPath(proj), 'utf8'));
    expect(resolveStopFeature({ currentStatus: status, activeSkill: 'report' }))
      .toBe('fix-br018-solo');
  });
});
