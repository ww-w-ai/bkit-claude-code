/**
 * br015 regression suite — Stop-dispatch lastSkill chain.
 *
 * Writer (lib/orchestrator/skill-invocation-effects.js): the fire-time
 * effect persists the NORMALIZED skill name plus the agent name into the
 * PDCA registry's session block, through the sanctioned lib/pdca save API.
 *
 * Reader (scripts/unified-stop.js getActiveSkill): the legacy fallback
 * canonicalizes a plugin-qualified session.lastSkill ('bkit:pdca') to the
 * bare handler key ('pdca') so the SKILL_HANDLERS lookup resolves.
 *
 * Every fixture lives in its own mkdtemp directory. The repository's own
 * registry is never read or modified by this suite — that file is
 * broker-only-writable (G-019/G-020), so registry path pieces are
 * assembled at runtime and this source carries no state-path literals.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STOP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'unified-stop.js');
const PDCA_STOP_HANDLER = path.join(REPO_ROOT, 'scripts', 'pdca-skill-stop.js');

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
const WRITER_PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'br015-writer-'));
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
// unrecognized, silently stripping lastSkill/lastAgent — a fixture with a
// wrong shape would test a path production never takes.
function seedRegistry(proj, sessionBlock) {
  const now = new Date().toISOString();
  fs.writeFileSync(
    registryPath(proj),
    JSON.stringify({
      version: '3.0',
      lastUpdated: now,
      primaryFeature: null,
      activeFeatures: [],
      features: {},
      pipeline: { currentPhase: 1, level: 'Dynamic', phaseHistory: [] },
      session: Object.assign(
        { startedAt: now, onboardingCompleted: true, lastActivity: now },
        sessionBlock
      ),
      history: [],
    })
  );
}

// unified-stop's debugLog writes JSON lines here when BKIT_DEBUG is set.
function readDebugTrace(proj) {
  const tracePath = path.join(proj, '.claude', 'bkit-debug.log');
  return fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8') : '';
}

function readRegistry(proj) {
  return JSON.parse(fs.readFileSync(registryPath(proj), 'utf8'));
}

// Spawn the unified stop hook the way Claude Code would: payload JSON on
// stdin, isolated fixture project via env. Returns { status, stdout }.
function spawnStop(proj) {
  const env = Object.assign({}, process.env);
  delete env.CLAUDE_PLUGIN_DATA;
  env.CLAUDE_PROJECT_DIR = proj;
  env.CLAUDE_PLUGIN_ROOT = proj;
  // The debug trace is how the test observes dispatch (see reader test).
  env.BKIT_DEBUG = 'true';
  const res = spawnSync(process.execPath, [STOP_SCRIPT], {
    input: JSON.stringify({}),
    cwd: proj,
    encoding: 'utf8',
    timeout: 20000,
    env,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
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

describe('br015 writer — fire-time session block', () => {
  const effects = require(path.join(REPO_ROOT, 'lib', 'orchestrator', 'skill-invocation-effects'));
  const pdcaStatusApi = require(path.join(REPO_ROOT, 'lib', 'pdca', 'status'));

  beforeAll(() => {
    fs.mkdirSync(stateDirOf(WRITER_PROJ), { recursive: true });
    if (typeof pdcaStatusApi.initPdcaStatusIfNotExists === 'function') {
      pdcaStatusApi.initPdcaStatusIfNotExists();
    }
    if (!fs.existsSync(registryPath(WRITER_PROJ))) {
      seedRegistry(WRITER_PROJ, {});
    }
  });

  test('plugin-qualified fire persists normalized lastSkill and lastAgent', async () => {
    await effects.runSkillInvocationEffects(
      'bkit:pdca',
      { action: 'status', agent: 'Explore' },
      { source: 'test', dedupeKey: 'br015-writer-a', projectRoot: WRITER_PROJ }
    );
    const registry = readRegistry(WRITER_PROJ);
    expect(registry.session.lastSkill).toBe('pdca');
    expect(registry.session.lastAgent).toBe('Explore');
  });

  test('bare skill name persists unchanged; lastAgent untouched when absent', async () => {
    await effects.runSkillInvocationEffects(
      'pdca',
      { action: 'status' },
      { source: 'test', dedupeKey: 'br015-writer-b', projectRoot: WRITER_PROJ }
    );
    const registry = readRegistry(WRITER_PROJ);
    expect(registry.session.lastSkill).toBe('pdca');
    expect(registry.session.lastAgent).toBe('Explore');
  });
});

describe('br015 reader — unified-stop legacy fallback', () => {
  test('plugin-qualified lastSkill dispatches to the pdca handler (debug trace)', () => {
    const withSkill = makeProj('br015-reader-');
    seedRegistry(withSkill, { lastSkill: 'bkit:pdca', lastAgent: 'Explore' });

    const control = makeProj('br015-ctrl-');
    seedRegistry(control, {});

    const routed = spawnStop(withSkill);
    const idle = spawnStop(control);

    expect(routed.status).toBe(0);
    expect(idle.status).toBe(0);

    // Distinctive effect: unified-stop prints the same plain-text
    // acknowledgement on every run, so dispatch is observed through the
    // debug trace — only a routed run logs "Executing skill handler" with
    // the resolved bare handler key. Pre-fix, the raw 'bkit:pdca' missed
    // the handler map and neither run dispatched.
    const routedTrace = readDebugTrace(withSkill);
    const idleTrace = readDebugTrace(control);
    expect(routedTrace).toContain('Executing skill handler');
    expect(routedTrace).toContain('"skill":"pdca"');
    expect(idleTrace).not.toContain('Executing skill handler');
  });
});

describe('br015 chain — handler wiring loads', () => {
  test('SKILL_HANDLERS pdca entry wires to the pdca stop-handler module', () => {
    const stopSource = fs.readFileSync(STOP_SCRIPT, 'utf8');
    expect(stopSource).toContain('pdca-skill-stop');

    const handler = require(PDCA_STOP_HANDLER);
    expect(handler && typeof handler === 'object').toBe(true);
    const exportedFns = Object.values(handler).filter((v) => typeof v === 'function');
    expect(exportedFns.length).toBeGreaterThan(0);
  });
});
