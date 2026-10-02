/**
 * br288 regression: an archived feature must never drift back to an active
 * phase. The terminal guard in updatePdcaStatus (lib/pdca/status-core.js)
 * rejects any non-archive phase write against a feature carrying archived
 * markers (phase 'archived', archivedAt, or archivedTo).
 *
 * True test: with the guard removed, the stale write lands and the phase
 * regresses (verified via mutation — see br288 Verification field).
 * The registry writes below happen in a throwaway os.tmpdir() sandbox via
 * CLAUDE_PROJECT_DIR isolation — the project's own registry is never touched.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

/** Run updatePdcaStatus in a subprocess isolated to `tmp` via CLAUDE_PROJECT_DIR. */
function write(tmp, feature, phase, data) {
  const script = `
    const { updatePdcaStatus } = require(${JSON.stringify(path.join(ROOT, 'lib', 'pdca'))});
    updatePdcaStatus(${JSON.stringify(feature)}, ${JSON.stringify(phase)},
      ${JSON.stringify(data)}, { requireDocs: false });
    process.stdout.write('ok');
  `;
  execFileSync('node', ['-e', script], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
    cwd: tmp,
  });
}

function readRegistry(tmp) {
  const registryPath = path.join(tmp, '.bkit', 'state', 'pdca-status.json');
  return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
}

describe('br288 terminal guard in updatePdcaStatus', () => {
  let tmp;
  const feature = 'br288-e2e';

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-br288-'));
    // Drive a feature to archived state via the same lib the archive CLI uses.
    write(tmp, feature, 'completed', { matchRate: 95 });
    write(tmp, feature, 'archived', { archivedTo: 'docs/archive/2026-10/x/' });
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('feature is archived before the stale write', () => {
    const reg = readRegistry(tmp);
    expect(reg.features[feature].phase).toBe('archived');
  });

  test('stale phase write does not drift an archived feature backward', () => {
    // Replay a stale phase write — the br288 failure shape (stale skill-fire
    // replay tries to set the feature back to an active phase).
    write(tmp, feature, 'do', {});

    const reg = readRegistry(tmp);
    const after = reg.features[feature];
    expect(after.phase).toBe('archived');
    expect(after.archivedTo).toBeTruthy();
  });

  test('archive-path write is still permitted on terminal features', () => {
    write(tmp, feature, 'archived', { archivedTo: 'docs/archive/2026-10/y/' });
    const reg = readRegistry(tmp);
    expect(reg.features[feature].phase).toBe('archived');
    expect(reg.features[feature].archivedTo).toBe('docs/archive/2026-10/y/');
  });
});
