/**
 * stop-binding.test.js — br006 regression lock.
 *
 * Contract: resolveStopFeature binds the feature the Stop event actually fired
 * for, in evidence order: (1) doc path in the input text, (2) exactly one
 * feature in the registry sitting in the action's target phase, (3)
 * primaryFeature as last resort, (4) '' when nothing matches.
 *
 * The br006 failure mode is tier 2's absence: a registry with a foreign
 * primaryFeature and hook input carrying no doc path made the old
 * extractFeatureFromContext path record the phase against primaryFeature.
 * A revert of the binding order (primaryFeature before per-feature evidence)
 * must turn TC1 RED — that is the mutation this suite guards.
 *
 * Pure-module test: the registry is a plain object, no fs writes. TC3 seeds a
 * real doc under a temp CLAUDE_PROJECT_DIR because tier 1 existence-checks
 * candidate paths (true-test discipline: a doc path that doesn't exist on
 * disk must NOT bind).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Env BEFORE lib requires (lib/core/platform.js reads it at require time).
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-stop-binding-'));
process.env.CLAUDE_PROJECT_DIR = projectDir;

const { resolveStopFeature } = require('../../lib/pdca/stop-binding');

function twoFeatureStatus() {
  return {
    version: '3.0',
    primaryFeature: 'feat-primary-do',
    activeFeatures: ['feat-primary-do', 'feat-fired-report'],
    features: {
      'feat-primary-do': { phase: 'do', phaseNumber: 3 },
      'feat-fired-report': { phase: 'report', phaseNumber: 7 },
    },
  };
}

test('br006-TC1 — no doc path in input: binds the single feature in the action phase, NOT primaryFeature', () => {
  const status = twoFeatureStatus();
  const bound = resolveStopFeature({
    inputText: 'Completed the report phase work for the current cycle.',
    currentStatus: status,
    activeSkill: 'report',
  });
  assert.equal(bound, 'feat-fired-report',
    'must bind the feature in phase=report (br006 misbind wrote to feat-primary-do)');
});

test('br006-TC2 — binding is per-action: do fire binds the do feature, not the report one', () => {
  const status = twoFeatureStatus();
  const bound = resolveStopFeature({
    inputText: 'Implementation finished.',
    currentStatus: status,
    activeSkill: 'do',
  });
  assert.equal(bound, 'feat-primary-do');
});

test('br006-TC3 — doc path in input wins over tier 2 (existence-checked)', () => {
  // Seed a REAL doc so tier 1's fs.existsSync guard passes.
  const docDir = path.join(projectDir, 'docs', '02-design', 'features');
  fs.mkdirSync(docDir, { recursive: true });
  fs.writeFileSync(path.join(docDir, 'feat-doc-named.design.md'), '# design\n');

  const status = twoFeatureStatus(); // feat-fired-report is the single report-phase feature
  const bound = resolveStopFeature({
    inputText: 'Wrote docs/02-design/features/feat-doc-named.design.md for review.',
    currentStatus: status,
    activeSkill: 'report',
  });
  assert.equal(bound, 'feat-doc-named',
    'an existing doc path in the text must outrank the phase-count heuristic');
});

test('br006-TC4 — a doc path MENTIONED but not on disk does not bind (fail closed)', () => {
  const status = twoFeatureStatus();
  const bound = resolveStopFeature({
    inputText: 'Plan to write docs/02-design/features/ghost-feature.design.md next.',
    currentStatus: status,
    activeSkill: 'report',
  });
  assert.equal(bound, 'feat-fired-report',
    'nonexistent doc path must fall through to tier 2, not register a ghost feature');
});

test('br006-TC5 — no evidence at all → primaryFeature (last resort, old behavior preserved)', () => {
  const status = {
    primaryFeature: 'only-feature',
    features: { 'only-feature': { phase: 'plan' } },
  };
  const bound = resolveStopFeature({
    inputText: 'Done with this step.',
    currentStatus: status,
    activeSkill: 'qa', // no feature in qa phase
  });
  assert.equal(bound, 'only-feature');
});

test('br006-TC6 — nothing matches and no primaryFeature → empty string', () => {
  assert.equal(resolveStopFeature({
    inputText: 'nothing here',
    currentStatus: { primaryFeature: null, features: {} },
    activeSkill: 'report',
  }), '');
});

test('br006-TC7 — never throws on garbage/absent args', () => {
  assert.doesNotThrow(() => resolveStopFeature());
  assert.doesNotThrow(() => resolveStopFeature({ inputText: null, currentStatus: null, activeSkill: null }));
  assert.doesNotThrow(() => resolveStopFeature({ inputText: 42, currentStatus: 'junk', activeSkill: {} }));
  assert.equal(typeof resolveStopFeature({ currentStatus: undefined }), 'string');
});

test('br006-TC8 — ambiguous tier 2 (two features in the same phase) falls back, does not guess', () => {
  const status = {
    primaryFeature: 'a-first',
    features: {
      'a-first': { phase: 'report' },
      'b-second': { phase: 'report' },
    },
  };
  const bound = resolveStopFeature({
    inputText: 'report phase finished.',
    currentStatus: status,
    activeSkill: 'report',
  });
  assert.equal(bound, 'a-first',
    'two candidates give no per-feature evidence; primaryFeature tiebreak applies');
});
