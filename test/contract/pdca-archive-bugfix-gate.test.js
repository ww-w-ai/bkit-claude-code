/**
 * pdca-archive-bugfix-gate.test.js — br005b regression lock.
 *
 * Contract: a bug-fix cycle (feature at phase=report, plan/design/report docs
 * on disk, NO analysis doc — Check/Analyze legitimately skipped) passes the
 * archive gate via the docs-on-disk arm in dry-run. Before the fix
 * (scripts/pdca-archive.js), REQUIRED_PHASES included 'analysis', so
 * discoverDocs().missing was never empty and the gate returned E-ARCH-GATE
 * forever — the exact strand br005 records.
 *
 * Full-cycle shape (analysis doc present) must still pass, and the fail-closed
 * rule must hold: a feature below phase=report never passes on the docs arm.
 *
 * Runs hermetically: CLAUDE_PROJECT_DIR points at a temp dir seeded with a
 * minimal pdca-status registry and docs tree (same shape
 * test/unit/pdca-archive-gate.test.js uses).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-archive-bugfix-'));
process.env.CLAUDE_PROJECT_DIR = projectDir;

// Modules load AFTER CLAUDE_PROJECT_DIR is set (lib/core/platform.js reads env
// at require time).
const { run, EXIT } = require('../../scripts/pdca-archive');
const { globalCache } = require('../../lib/core/cache');

const statusDir = path.join(projectDir, '.bkit', 'state');
fs.mkdirSync(statusDir, { recursive: true });

function seedFeature(name, patch) {
  const features = {
    [name]: Object.assign({
      phase: 'report',
      phaseNumber: 7,
      matchRate: null,
      iterationCount: 0,
      requirements: [],
      documents: {},
      timestamps: { started: new Date().toISOString() },
    }, patch),
  };
  const status = {
    version: '2.0',
    lastUpdated: new Date().toISOString(),
    activeFeatures: Object.keys(features),
    primaryFeature: name,
    features,
    pipeline: { currentPhase: 1, level: 'Dynamic', phaseHistory: [] },
    session: { startedAt: new Date().toISOString(), onboardingCompleted: true },
  };
  fs.writeFileSync(path.join(statusDir, 'pdca-status.json'), JSON.stringify(status, null, 2));
  globalCache.invalidate(`pdca-status:${projectDir}`);
  return name;
}

function seedDocs(feature, phases) {
  const layout = {
    plan: `docs/01-plan/features/${feature}.plan.md`,
    design: `docs/02-design/features/${feature}.design.md`,
    analysis: `docs/03-analysis/features/${feature}.analysis.md`,
    report: `docs/04-report/features/${feature}.report.md`,
  };
  for (const ph of phases) {
    const p = path.join(projectDir, layout[ph]);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `# ${feature} ${ph}\n`);
  }
}

function dryRun(feature) {
  const buf = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { buf.push(s); return true; };
  let code;
  try { code = run([feature]); } finally { process.stdout.write = orig; }
  return { code, out: JSON.parse(buf.join('')) };
}

test('br005b-TC1 — bug-fix doc set (plan/design/report, NO analysis) passes the gate', () => {
  const f = seedFeature('bugfix-gate-ok');
  seedDocs(f, ['plan', 'design', 'report']); // analysis intentionally absent

  const { code, out } = dryRun(f);
  assert.equal(code, EXIT.OK, `dry-run exit=${code}, out=${JSON.stringify(out)}`);
  assert.equal(out.error, undefined, 'E-ARCH-GATE must not be emitted (was the br005b strand)');
  assert.equal(out.gate, 'docs-on-disk', `gate=${out.gate}`);
  assert.equal(out.dryRun, true, 'dry-run must not mutate');
  assert.deepEqual(out.docsFound.sort(), ['design', 'plan', 'report'],
    'docs arm discovers exactly the bug-fix doc set');
});

test('br005b-TC2 — full-cycle doc set (analysis present) still passes', () => {
  const f = seedFeature('fullcycle-gate-ok');
  seedDocs(f, ['plan', 'design', 'analysis', 'report']);

  const { code, out } = dryRun(f);
  assert.equal(code, EXIT.OK, `exit=${code}`);
  assert.equal(out.gate, 'docs-on-disk', `gate=${out.gate}`);
  assert.ok(out.docsFound.includes('analysis'),
    'present analysis doc is still discovered (via OPTIONAL_PHASES) and archived when applying');
});

test('br005b-TC3 — fail closed: phase below report never passes on the docs arm', () => {
  const f = seedFeature('tooyoung-gate', { phase: 'do', phaseNumber: 3 });
  seedDocs(f, ['plan', 'design', 'report']);

  const { code, out } = dryRun(f);
  assert.equal(code, EXIT.GATE, `exit=${code}`);
  assert.equal(out.error, 'E-ARCH-GATE');
  assert.equal(out.gate, null);
});
