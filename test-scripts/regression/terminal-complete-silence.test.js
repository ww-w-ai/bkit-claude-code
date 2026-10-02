/**
 * br287 regression: a Stop bound to a TERMINAL feature must not re-emit the
 * stale report/PDCA-COMPLETE block. Unlike br290 (dead record — feature key
 * absent from the registry), archiveFeature KEEPS the key with
 * phase 'archived', so the binder still resolves it and the emitter re-fires
 * the acknowledgement on every later stop.
 *
 *   T1  archived feature key present + stale report envelope -> silent exit 0
 *   T2  completed (not yet archived) feature + same envelope -> silent exit 0
 *   T3  control: a LIVE feature in phase 'report' still emits — the guard
 *       silences terminal features only, the handler is not neutered.
 *
 * Fixture detail (probe-proven via br290b): the registry MUST carry version
 * '3.0'. Without it the status migrator rebuilds the session block, stripping
 * lastSkill* — which silently invalidates the whole scenario.
 *
 * Registry writes happen in a throwaway os.tmpdir() sandbox via
 * CLAUDE_PROJECT_DIR isolation — the project's own registry is never touched.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const HANDLER = path.join(ROOT, 'scripts', 'pdca-skill-stop.js');

/**
 * Seed a sandbox registry whose recorded lastSkillFeature names a feature
 * that is still a registry key but terminal (phase archived / completed).
 */
function seedTerminal(tmp, phase) {
  const stateDir = path.join(tmp, '.bkit', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(stateDir, 'pdca-status.json'), JSON.stringify({
    version: '3.0',
    session: {
      startedAt: now, onboardingCompleted: true, lastActivity: now,
      lastSkill: 'pdca', lastSkillAction: 'report', lastSkillFeature: 'done-feature',
    },
    features: {
      'done-feature': { phase },
      'ZfeatA': { phase: 'plan' },
    },
    primaryFeature: 'ZfeatA',
  }));
  // Stale envelope: the most recent pdca Skill tool_use in the transcript is
  // the report fire from BEFORE the feature completed/archived.
  fs.writeFileSync(path.join(tmp, 'transcript.jsonl'), JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Skill',
      input: { skill: 'bkit:pdca', args: 'report done-feature' } }] },
  }) + '\n');
}

function seedLive(tmp) {
  const stateDir = path.join(tmp, '.bkit', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(stateDir, 'pdca-status.json'), JSON.stringify({
    version: '3.0',
    session: {
      startedAt: now, onboardingCompleted: true, lastActivity: now,
      lastSkill: 'pdca', lastSkillAction: 'report', lastSkillFeature: 'live-feature',
    },
    features: {
      'live-feature': { phase: 'report' },
      'ZfeatA': { phase: 'plan' },
    },
    primaryFeature: 'ZfeatA',
  }));
  fs.writeFileSync(path.join(tmp, 'transcript.jsonl'), JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Skill',
      input: { skill: 'bkit:pdca', args: 'report live-feature' } }] },
  }) + '\n');
}

function runHandler(tmp) {
  const input = JSON.stringify({
    hook_event_name: 'Stop', session_id: 'probe',
    transcript_path: path.join(tmp, 'transcript.jsonl'),
    cwd: tmp, stop_hook_active: false,
  });
  try {
    return { status: 0, out: execFileSync('node', [HANDLER], {
      input, env: { ...process.env, CLAUDE_PROJECT_DIR: tmp }, cwd: tmp, encoding: 'utf8',
    }) };
  } catch (err) {
    return { status: err.status, out: err.stdout || '' };
  }
}

describe('br287: terminal-feature Stop must stay silent', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-br287-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  test('T1 archived feature key present + stale report envelope -> silent exit 0', () => {
    seedTerminal(tmp, 'archived');
    const r = runHandler(tmp);
    expect(r.status).toBe(0);
    expect(r.out).toBe('');
  });

  test('T2 completed (not yet archived) feature -> silent exit 0', () => {
    seedTerminal(tmp, 'completed');
    const r = runHandler(tmp);
    expect(r.status).toBe(0);
    expect(r.out).toBe('');
  });

  test('T3 control: live feature in report phase still emits', () => {
    seedLive(tmp);
    const r = runHandler(tmp);
    expect(r.out.length).toBeGreaterThan(0);
  });
});
