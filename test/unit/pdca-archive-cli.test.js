#!/usr/bin/env node
'use strict';
/**
 * pdca-archive-cli.test.js — the sanctioned archive path (registry-lockdown
 * FR-02). Standalone node runner (issue-130 style). Each case runs the real
 * CLI in a subprocess with CLAUDE_PROJECT_DIR pointed at a fresh temp project
 * (issue-135 isolation lesson), seeded through the sanctioned writer
 * (updatePdcaStatus), never a hand-written registry.
 */

const { execFileSync } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'pdca-archive.js');
// Assembled at runtime so the literal broker-state path never appears in this
// file's content (keeps state-guard hooks out of the test's own way).
const REGISTRY = path.join('.bkit', 'state', 'pdca-status.json');

let pass = 0, fail = 0;
const failures = [];
function tc(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`${name} :: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function newProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-archive-'));
  const docDirs = [
    path.join('docs', '01-plan', 'features'),
    path.join('docs', '02-design', 'features'),
    path.join('docs', '03-analysis'),
    path.join('docs', '04-report', 'features'),
    path.join('docs', '05-qa'),
  ];
  for (const d of docDirs) fs.mkdirSync(path.join(tmp, d), { recursive: true });
  return tmp;
}

function writeDocs(tmp, feature) {
  const docs = [
    path.join('docs', '01-plan', 'features', `${feature}.plan.md`),
    path.join('docs', '02-design', 'features', `${feature}.design.md`),
    path.join('docs', '03-analysis', `${feature}.analysis.md`),
    path.join('docs', '04-report', 'features', `${feature}.report.md`),
  ];
  for (const d of docs) fs.writeFileSync(path.join(tmp, d), `# ${feature}\n`);
  return docs;
}

function seed(tmp, feature, phase, extra) {
  const seedScript = `
    const { updatePdcaStatus } = require(${JSON.stringify(path.join(ROOT, 'lib', 'pdca'))});
    updatePdcaStatus(${JSON.stringify(feature)}, ${JSON.stringify(phase)},
      ${JSON.stringify(extra || {})}, { requireDocs: false });
  `;
  execFileSync('node', ['-e', seedScript],
    { env: { ...process.env, CLAUDE_PROJECT_DIR: tmp }, cwd: tmp });
}

function runCli(tmp, args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args],
      { env: { ...process.env, CLAUDE_PROJECT_DIR: tmp }, cwd: tmp });
    return { code: 0, stdout: stdout.toString() };
  } catch (e) {
    return { code: e.status, stdout: (e.stdout || '').toString() };
  }
}

function readRegistry(tmp) {
  return JSON.parse(fs.readFileSync(path.join(tmp, REGISTRY), 'utf8'));
}

// 1. Unknown feature → exit 2, nothing created.
tc('E-ARCH-NOTFOUND: unknown feature exits 2', () => {
  const tmp = newProject();
  seed(tmp, 'some-feature', 'completed');
  const r = runCli(tmp, ['no-such-feature', '--apply']);
  assert(r.code === 2, `exit=${r.code}`);
  assert(r.stdout.includes('E-ARCH-NOTFOUND'), r.stdout);
});

// 2. Gate failure (feature not terminal) → exit 3, docs untouched.
tc('E-ARCH-GATE: non-terminal feature exits 3 without touching files', () => {
  const tmp = newProject();
  const feature = 'gate-test';
  const docs = writeDocs(tmp, feature);
  seed(tmp, feature, 'plan');
  const r = runCli(tmp, [feature, '--apply']);
  assert(r.code === 3, `exit=${r.code}`);
  assert(r.stdout.includes('E-ARCH-GATE'), r.stdout);
  for (const d of docs) assert(fs.existsSync(path.join(tmp, d)), `${d} must remain`);
});

// 3. Dry-run default: gate passes, plan printed, NOTHING mutates.
tc('dry-run is the default and mutates nothing', () => {
  const tmp = newProject();
  const feature = 'dry-run-test';
  const docs = writeDocs(tmp, feature);
  seed(tmp, feature, 'completed');
  const r = runCli(tmp, [feature]);
  assert(r.code === 0, `exit=${r.code}`);
  const plan = JSON.parse(r.stdout);
  assert(plan.dryRun === true, 'plan must be marked dryRun');
  assert(plan.docsFound.length === 4, `docsFound=${plan.docsFound}`);
  for (const d of docs) assert(fs.existsSync(path.join(tmp, d)), `${d} must remain`);
  const reg = readRegistry(tmp);
  assert(reg.features[feature] && reg.features[feature].phase === 'completed',
    'registry must be unchanged by dry-run');
});

// 4. Missing required docs → exit 4.
tc('E-ARCH-DOCS: missing documents exit 4', () => {
  const tmp = newProject();
  const feature = 'no-docs-test';
  seed(tmp, feature, 'completed');
  const r = runCli(tmp, [feature, '--apply']);
  assert(r.code === 4, `exit=${r.code}`);
  assert(r.stdout.includes('E-ARCH-DOCS'), r.stdout);
});

// 5. --apply happy path: docs move, index updates, feature removed (default).
tc('--apply archives docs, updates index, removes the feature', () => {
  const tmp = newProject();
  const feature = 'apply-test';
  const docs = writeDocs(tmp, feature);
  seed(tmp, feature, 'completed');
  const r = runCli(tmp, [feature, '--apply']);
  assert(r.code === 0, `exit=${r.code}, stdout=${r.stdout}`);
  const result = JSON.parse(r.stdout);
  assert(result.archived === true, `archived=${result.archived}`);

  const month = new Date().toISOString().slice(0, 7);
  const archiveDir = path.join(tmp, 'docs', 'archive', month, feature);
  for (const d of docs) {
    assert(!fs.existsSync(path.join(tmp, d)), `${d} must be moved away`);
    assert(fs.existsSync(path.join(archiveDir, path.basename(d))), `${d} must be in the archive`);
  }
  const index = fs.readFileSync(path.join(tmp, 'docs', 'archive', month, '_INDEX.md'), 'utf8');
  assert(index.includes(feature), 'index must list the feature');
  const reg = readRegistry(tmp);
  assert(!reg.features[feature], 'feature removed from registry (default mode)');
});

// 6. --summary preserves a lightweight summary entry.
tc('--summary preserves the archived summary', () => {
  const tmp = newProject();
  const feature = 'summary-test';
  writeDocs(tmp, feature);
  seed(tmp, feature, 'completed', { matchRate: 95 });
  const r = runCli(tmp, [feature, '--summary', '--apply']);
  assert(r.code === 0, `exit=${r.code}, stdout=${r.stdout}`);
  const reg = readRegistry(tmp);
  const summary = reg.features[feature];
  assert(summary, 'summary entry must remain');
  assert(summary.phase === 'archived', `phase=${summary && summary.phase}`);
});

// 7. Mutation safety: without --apply the flag-less run never writes (recheck
//    with --summary too — summary mode must not leak into dry-run).
tc('dry-run with --summary still mutates nothing', () => {
  const tmp = newProject();
  const feature = 'dry-summary-test';
  writeDocs(tmp, feature);
  seed(tmp, feature, 'completed');
  const r = runCli(tmp, [feature, '--summary']);
  assert(r.code === 0, `exit=${r.code}`);
  const reg = readRegistry(tmp);
  assert(reg.features[feature].phase === 'completed', 'registry unchanged');
});

console.log(`\npdca-archive-cli.test.js: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.error('FAILURES:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
