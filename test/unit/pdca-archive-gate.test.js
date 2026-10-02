#!/usr/bin/env node
'use strict';
/**
 * pdca-archive-gate.test.js — archive gate docs-on-disk clause (Fix 4) +
 * archiveFeature requireDocs:false (Fix 2), bugfix-wave-20260919.
 *
 * Contract:
 *   - Gate: a feature in phase 'report' whose phase docs all exist passes the
 *     gate via the docs-on-disk clause (E-ARCH-GATE never emitted, gate field
 *     reported). A feature in phase 'do' with docs on disk FAILS (fail closed).
 *     matchRate clause still passes; a low-phase low-rate feature fails.
 *   - Lifecycle: archiveFeature persists phase 'archived' + archivedTo even
 *     when the feature's plan/design docs are ABSENT (requireDocs:false) —
 *     previously the issue-#89 gate silently skipped the write.
 *
 * Runs hermetically: CLAUDE_PROJECT_DIR points at a temp dir seeded with a
 * minimal .bkit/state/pdca-status.json and docs tree.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-archive-gate-'));
process.env.CLAUDE_PROJECT_DIR = projectDir;

const statusDir = path.join(projectDir, '.bkit', 'state');
fs.mkdirSync(statusDir, { recursive: true });

function statusFor(features) {
  return {
    version: '2.0',
    lastUpdated: new Date().toISOString(),
    activeFeatures: Object.keys(features),
    primaryFeature: null,
    features,
    pipeline: { currentPhase: 1, level: 'Dynamic', phaseHistory: [] },
    session: { startedAt: new Date().toISOString(), onboardingCompleted: true },
  };
}

function seedFeature(name, patch) {
  const status = statusFor({
    [name]: Object.assign({
      phase: 'report',
      phaseNumber: 7,
      matchRate: null,
      iterationCount: 0,
      requirements: [],
      documents: {},
      timestamps: { started: new Date().toISOString() },
    }, patch),
  });
  fs.writeFileSync(path.join(statusDir, 'pdca-status.json'), JSON.stringify(status, null, 2));
  invalidateStatusCache();
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

// Modules are loaded AFTER CLAUDE_PROJECT_DIR is set (path SSoT reads env at
// require time via lib/core/platform.js).
const { run, discoverDocs, EXIT } = require('../../scripts/pdca-archive');
const { archiveFeature } = require('../../lib/pdca/lifecycle');
const { getPdcaStatusFull } = require('../../lib/pdca/status-core');
const { globalCache } = require('../../lib/core/cache');

// statusFor() rewrites the registry file per test; the lib caches the parsed
// status per project (3s TTL), so drop the cached copy before each read.
function invalidateStatusCache() {
  globalCache.invalidate(`pdca-status:${projectDir}`);
}

let pass = 0, fail = 0;
const failures = [];
function tc(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`${name} :: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// --- Gate: docs-on-disk clause ---------------------------------------------
tc('phase report + all docs on disk passes the gate (docs-on-disk clause)', () => {
  const f = seedFeature('gate-docs-ok');
  seedDocs(f, ['plan', 'design', 'analysis', 'report']);
  const buf = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { buf.push(s); return true; };
  let code;
  try { code = run([f]); } finally { process.stdout.write = orig; }
  assert(code === EXIT.OK, `exit=${code}`);
  const out = JSON.parse(buf.join(''));
  assert(out.dryRun === true, 'dry-run must not mutate');
  assert(out.gate === 'docs-on-disk', `gate=${out.gate}`);
});

tc('phase report + matchRate >= 90 still passes via matchRate clause', () => {
  const f = seedFeature('gate-rate-ok', { matchRate: 95 });
  seedDocs(f, ['plan', 'design', 'analysis', 'report']);
  const buf = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { buf.push(s); return true; };
  let code;
  try { code = run([f]); } finally { process.stdout.write = orig; }
  assert(code === EXIT.OK, `exit=${code}`);
  assert(JSON.parse(buf.join('')).gate === 'matchRate', 'expected matchRate clause');
});

tc('phase report + missing docs still fails the gate (fail closed)', () => {
  const f = seedFeature('gate-docs-missing');
  seedDocs(f, ['plan', 'design']); // analysis + report missing
  const buf = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { buf.push(s); return true; };
  let code;
  try { code = run([f]); } finally { process.stdout.write = orig; }
  assert(code === EXIT.GATE, `exit=${code}`);
  const out = JSON.parse(buf.join(''));
  assert(out.error === 'E-ARCH-GATE', `error=${out.error}`);
  assert(out.gate === null, `gate should be null, got ${out.gate}`);
});

tc('phase do + docs on disk FAILS the gate (docs clause is report+only)', () => {
  const f = seedFeature('gate-do-fails', { phase: 'do', phaseNumber: 3 });
  seedDocs(f, ['plan', 'design', 'analysis', 'report']);
  const buf = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { buf.push(s); return true; };
  let code;
  try { code = run([f]); } finally { process.stdout.write = orig; }
  assert(code === EXIT.GATE, `exit=${code}`);
  assert(JSON.parse(buf.join('')).error === 'E-ARCH-GATE', 'expected E-ARCH-GATE');
});

tc('phase do + matchRate >= 90 still passes (pre-existing clause intact)', () => {
  const f = seedFeature('gate-do-rate', { phase: 'do', phaseNumber: 3, matchRate: 92 });
  seedDocs(f, ['plan', 'design', 'analysis', 'report']); // pass the downstream docs check
  const buf = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { buf.push(s); return true; };
  let code;
  try { code = run([f]); } finally { process.stdout.write = orig; }
  assert(code === EXIT.OK, `exit=${code}`);
  assert(JSON.parse(buf.join('')).gate === 'matchRate', 'expected matchRate clause');
});

tc('discoverDocs reports missing phases', () => {
  const f = seedFeature('discover-check');
  seedDocs(f, ['plan']);
  const { found, missing } = discoverDocs(f);
  assert(found.some((d) => d.phase === 'plan'), 'plan should be found');
  // 'analysis' is OPTIONAL (bug-fix cycles legitimately skip Check) — it is
  // never reported missing; only the required phases are.
  assert(missing.includes('design') && missing.includes('report') && !missing.includes('analysis'),
    `missing=${missing.join(',')}`);
});

// --- Fix 2: archiveFeature persists archived with docs absent --------------
tc('archiveFeature persists archived + archivedTo when docs are absent', () => {
  const f = seedFeature('fix2-archived-write', { phase: 'completed', phaseNumber: 8 });
  // No docs seeded at all — the issue-#89 gate would have skipped the write.
  const result = archiveFeature(f);
  invalidateStatusCache();
  assert(result.archived === true, `archived=${result.archived}, reason=${result.reason}`);
  const status = getPdcaStatusFull(true);
  const feat = status.features[f];
  assert(feat, 'feature must remain in the registry');
  assert(feat.phase === 'archived', `phase=${feat.phase}`);
  assert(typeof feat.archivedTo === 'string' && feat.archivedTo.includes(f),
    `archivedTo=${feat.archivedTo}`);
  // NOTE: updatePdcaStatus's merge (status-core) rebuilds timestamps without
  // spreading data.timestamps, so archivedAt does not survive the write —
  // pre-existing behavior outside this fix's file scope (filed as a finding).
});

// eslint-disable-next-line no-console -- test output convention
console.log(`\npdca-archive-gate.test.js: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.error('FAILURES:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
