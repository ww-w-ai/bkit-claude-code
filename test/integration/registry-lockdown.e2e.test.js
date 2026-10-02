#!/usr/bin/env node
'use strict';
/**
 * registry-lockdown.e2e.test.js — L3 simulated lifecycle (registry-lockdown
 * success criterion 4.2-1). Standalone node runner (issue-130 style).
 *
 * Proves the full cycle advances the registry with ZERO manual registry
 * writes: every phase transition happens through the same effects module the
 * Skill-fire hooks run, and the terminal archive happens through the
 * sanctioned CLI. Runs in an isolated temp project (issue-135 lesson).
 */

const { execFileSync } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'pdca-archive.js');
const REGISTRY = path.join('.bkit', 'state', 'pdca-status.json');

let pass = 0, fail = 0;
const failures = [];
function tc(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`${name} :: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const feature = 'lifecycle-e2e';

/** Fire a router action through the SAME effects module the hooks run. */
function fire(tmp, action) {
  const script = `
    require(${JSON.stringify(path.join(ROOT, 'lib', 'orchestrator', 'skill-invocation-effects'))})
      .runSkillInvocationEffects('pdca',
        { action: ${JSON.stringify(action)}, feature: ${JSON.stringify(feature)} },
        { source: 'skill-tool' })
      .then(() => process.exit(0))
      .catch((e) => { console.error(e.message); process.exit(1); });
  `;
  execFileSync('node', ['-e', script],
    { env: { ...process.env, CLAUDE_PROJECT_DIR: tmp }, cwd: tmp });
}

function phaseOf(tmp) {
  const reg = JSON.parse(fs.readFileSync(path.join(tmp, REGISTRY), 'utf8'));
  return reg.features[feature] ? reg.features[feature].phase : 'NOT_FOUND';
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-lifecycle-'));

// Phase documents (created as the phases "complete" — the registry writes
// themselves must never depend on them existing first: router fires pass
// requireDocs:false).
const docs = [
  path.join('docs', '01-plan', 'features', `${feature}.plan.md`),
  path.join('docs', '02-design', 'features', `${feature}.design.md`),
  path.join('docs', '03-analysis', `${feature}.analysis.md`),
  path.join('docs', '04-report', 'features', `${feature}.report.md`),
];
for (const d of docs) {
  fs.mkdirSync(path.dirname(path.join(tmp, d)), { recursive: true });
  fs.writeFileSync(path.join(tmp, d), `# ${feature}\n`);
}

tc('fire plan registers the feature at plan', () => {
  fire(tmp, 'plan');
  assert(phaseOf(tmp) === 'plan', `phase=${phaseOf(tmp)}`);
});

tc('fire design advances to design', () => {
  fire(tmp, 'design');
  assert(phaseOf(tmp) === 'design', `phase=${phaseOf(tmp)}`);
});

tc('fire do advances to do', () => {
  fire(tmp, 'do');
  assert(phaseOf(tmp) === 'do', `phase=${phaseOf(tmp)}`);
});

tc('fire analyze advances to check (aliased action)', () => {
  fire(tmp, 'analyze');
  assert(phaseOf(tmp) === 'check', `phase=${phaseOf(tmp)}`);
});

tc('fire iterate advances to act (aliased action)', () => {
  fire(tmp, 'iterate');
  assert(phaseOf(tmp) === 'act', `phase=${phaseOf(tmp)}`);
});

tc('fire qa advances to qa', () => {
  fire(tmp, 'qa');
  assert(phaseOf(tmp) === 'qa', `phase=${phaseOf(tmp)}`);
});

tc('fire report advances to report', () => {
  fire(tmp, 'report');
  assert(phaseOf(tmp) === 'report', `phase=${phaseOf(tmp)}`);
});

tc('completion transition (normally the TaskCompleted hook) uses the sanctioned writer', () => {
  const script = `
    const { updatePdcaStatus } = require(${JSON.stringify(path.join(ROOT, 'lib', 'pdca'))});
    updatePdcaStatus(${JSON.stringify(feature)}, 'completed', { matchRate: 95 },
      { requireDocs: false });
  `;
  execFileSync('node', ['-e', script],
    { env: { ...process.env, CLAUDE_PROJECT_DIR: tmp }, cwd: tmp });
  assert(phaseOf(tmp) === 'completed', `phase=${phaseOf(tmp)}`);
});

tc('archive CLI dry-run reports the plan without mutating', () => {
  const out = execFileSync('node', [CLI, feature],
    { env: { ...process.env, CLAUDE_PROJECT_DIR: tmp }, cwd: tmp }).toString();
  const plan = JSON.parse(out);
  assert(plan.dryRun === true && plan.gatePassed === true, out);
  assert(phaseOf(tmp) === 'completed', 'dry-run must not change the registry');
});

tc('archive CLI --apply completes the cycle to archived with zero hand writes', () => {
  const out = execFileSync('node', [CLI, feature, '--apply'],
    { env: { ...process.env, CLAUDE_PROJECT_DIR: tmp }, cwd: tmp }).toString();
  const result = JSON.parse(out);
  assert(result.archived === true, out);

  const month = new Date().toISOString().slice(0, 7);
  for (const d of docs) {
    assert(!fs.existsSync(path.join(tmp, d)), `${d} moved`);
    assert(fs.existsSync(path.join(tmp, 'docs', 'archive', month, feature, path.basename(d))),
      `${d} in archive`);
  }
  const reg = JSON.parse(fs.readFileSync(path.join(tmp, REGISTRY), 'utf8'));
  assert(!reg.features[feature], 'feature removed after default archive');
});

tc('MCP disclosure marker present on bkit_pdca_status (sanctioned read surface)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'servers', 'bkit-pdca-server', 'index.js'), 'utf8');
  assert(src.includes('sanctioned read surface'),
    'tool description must disclose the sanctioned read surface');
});

console.log(`\nregistry-lockdown.e2e.test.js: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.error('FAILURES:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
