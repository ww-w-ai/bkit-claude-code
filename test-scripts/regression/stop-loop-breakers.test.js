/**
 * br290b regression: after a PDCA cycle completes and archives (feature
 * deleted from the registry), the Stop handler must NOT re-emit the
 * envelope's next-step block. Two layers, both probe-proven:
 *
 *   T1  dead fire-time record + report envelope  -> silent exit 0
 *       (previously re-fired "Completion report has been generated." on
 *       every stop after archive — the observed 9-consecutive-block loop)
 *   T2  stop_hook_active=true (harness loop breaker) -> always silent
 *   T3  control: a LIVE feature's report envelope still emits, proving the
 *       handler is not neutered — the guards fire only on dead records.
 *
 * Fixture detail (probe-proven): the registry MUST carry version '3.0'.
 * Without it the status migrator rebuilds the session block, stripping
 * lastSkill* — which silently invalidates the whole scenario.
 *
 * The registry writes below happen in a throwaway os.tmpdir() sandbox via
 * CLAUDE_PROJECT_DIR isolation — the project's own registry is never touched.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const HANDLER = path.join(ROOT, 'scripts', 'pdca-skill-stop.js');

function seed(tmp, { deadFeature, liveFeature, phantomPrimary }) {
  const stateDir = path.join(tmp, '.bkit', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const now = new Date().toISOString();
  const recorded = deadFeature || liveFeature;
  const features = { [phantomPrimary]: { phase: 'plan' } };
  if (liveFeature) features[liveFeature] = { phase: 'report' };
  fs.writeFileSync(path.join(stateDir, 'pdca-status.json'), JSON.stringify({
    version: '3.0',
    session: {
      startedAt: now, onboardingCompleted: true, lastActivity: now,
      lastSkill: 'pdca', lastSkillAction: 'report', lastSkillFeature: recorded,
    },
    features,
    primaryFeature: phantomPrimary,
  }));
  fs.writeFileSync(path.join(tmp, 'transcript.jsonl'), JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Skill',
      input: { skill: 'bkit:pdca', args: `report ${recorded}` } }] },
  }) + '\n');
}

function runHandler(tmp, stopHookActive) {
  const input = JSON.stringify({
    hook_event_name: 'Stop', session_id: 'probe',
    transcript_path: path.join(tmp, 'transcript.jsonl'),
    cwd: tmp, stop_hook_active: stopHookActive,
  });
  try {
    return { status: 0, out: execFileSync('node', [HANDLER], {
      input, env: { ...process.env, CLAUDE_PROJECT_DIR: tmp }, cwd: tmp, encoding: 'utf8',
    }) };
  } catch (err) {
    return { status: err.status, out: err.stdout || '' };
  }
}

describe('br290b: post-completion Stop must not re-block', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-br290b-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  test('T1 dead fire-time record + report envelope -> silent exit 0', () => {
    seed(tmp, { deadFeature: 'done-feature', phantomPrimary: 'ZfeatA' });
    const r = runHandler(tmp, false);
    expect(r.status).toBe(0);
    expect(r.out).toBe('');
  });

  test('T2 stop_hook_active=true -> always silent (harness loop breaker)', () => {
    seed(tmp, { deadFeature: 'done-feature', phantomPrimary: 'ZfeatA' });
    const r = runHandler(tmp, true);
    expect(r.status).toBe(0);
    expect(r.out).toBe('');
  });

  test('T3 control: live feature report envelope still emits', () => {
    seed(tmp, { liveFeature: 'live-feature', phantomPrimary: 'ZfeatA' });
    const r = runHandler(tmp, false);
    expect(r.out.length).toBeGreaterThan(0);
  });
});
