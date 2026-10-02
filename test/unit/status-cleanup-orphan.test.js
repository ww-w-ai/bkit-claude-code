#!/usr/bin/env node
'use strict';
/**
 * Unit Tests — deleteFeatureFromStatus orphan-row cleanup (BR-001)
 * Bugfix wave 20260919 §3 Fix 3.
 *
 * An active feature with a NON-terminal phase whose plan/design docs are both
 * missing is an orphan and must be deletable (orphan-removed). A live feature
 * with docs on disk must still be refused.
 *
 * Isolation: CLAUDE_PROJECT_DIR=TMP_ROOT before any lib/ require (lib/core/
 * platform captures the env at first import), so writes land in a throwaway
 * tmp root — never the repo's real .bkit.
 *
 * Design Ref: docs/02-design/features/bugfix-wave-20260919.design.md §3
 *
 * @module test/unit/status-cleanup-orphan
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-status-orphan-'));
process.env.CLAUDE_PROJECT_DIR = TMP_ROOT;
process.on('exit', () => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const { assert, skip, summary, reset } = require('../helpers/assert');
reset();

// eslint-disable-next-line no-console -- test output convention
console.log('\n=== status-cleanup-orphan.test.js ===\n');

let cleanup, migration;
try {
  cleanup = require('../../lib/pdca/status-cleanup');
  migration = require('../../lib/pdca/status-migration');
} catch {
  cleanup = null;
  migration = null;
}
const moduleLoaded = cleanup !== null;

// Feature dirs per DEFAULT_DOC_PATHS
function seedStatus(features) {
  const { STATE_PATHS } = require('../../lib/core/paths');
  const statusPath = STATE_PATHS.pdcaStatus();
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const status = migration.createInitialStatusV2();
  status.features = features;
  for (const name of Object.keys(features)) {
    status.activeFeatures.push(name);
  }
  status.primaryFeature = Object.keys(features)[0] || null;
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
}

function createPlanDoc(feature) {
  const dir = path.join(TMP_ROOT, 'docs', '01-plan', 'features');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${feature}.plan.md`), `# Plan: ${feature}\n`);
}

function createDesignDoc(feature) {
  const dir = path.join(TMP_ROOT, 'docs', '02-design', 'features');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${feature}.design.md`), `# Design: ${feature}\n`);
}

// ============================================================
// TC-ORPHAN-01: active feature, phase 'do', NO docs → deleted, orphan-removed
// ============================================================
{
  if (moduleLoaded) {
    seedStatus({
      'orphan-feat': { phase: 'do', phaseNumber: 4, matchRate: null, iterationCount: 0, requirements: [], documents: {}, timestamps: { started: new Date().toISOString() } },
    });
    const result = cleanup.deleteFeatureFromStatus('orphan-feat');
    assert('ORPHAN-01',
      result.success === true &&
      result.deletedFeature === 'orphan-feat' &&
      /orphan-removed/.test(result.reason || ''),
      'orphan (phase do, no docs) deleted with orphan-removed reason');
  } else {
    skip('ORPHAN-01', 'Module not loaded');
  }
}

// ============================================================
// TC-ORPHAN-02: live feature, phase 'do', plan doc present → refused
// ============================================================
{
  if (moduleLoaded) {
    seedStatus({
      'live-feat': { phase: 'do', phaseNumber: 4, matchRate: null, iterationCount: 0, requirements: [], documents: {}, timestamps: { started: new Date().toISOString() } },
    });
    createPlanDoc('live-feat');
    const result = cleanup.deleteFeatureFromStatus('live-feat');
    assert('ORPHAN-02',
      result.success === false && result.reason === 'Cannot delete active feature',
      'live feature (plan doc on disk) still refused');
  } else {
    skip('ORPHAN-02', 'Module not loaded');
  }
}

// ============================================================
// TC-ORPHAN-03: live feature with only design doc → refused
// ============================================================
{
  if (moduleLoaded) {
    seedStatus({
      'live-design': { phase: 'check', phaseNumber: 5, matchRate: 90, iterationCount: 1, requirements: [], documents: {}, timestamps: { started: new Date().toISOString() } },
    });
    createDesignDoc('live-design');
    const result = cleanup.deleteFeatureFromStatus('live-design');
    assert('ORPHAN-03',
      result.success === false && result.reason === 'Cannot delete active feature',
      'live feature (design doc only) still refused');
  } else {
    skip('ORPHAN-03', 'Module not loaded');
  }
}

// ============================================================
// TC-ORPHAN-04: orphan removal cleans activeFeatures + primaryFeature
// ============================================================
{
  if (moduleLoaded) {
    seedStatus({
      'a-live': { phase: 'do', phaseNumber: 4, matchRate: null, iterationCount: 0, requirements: [], documents: {}, timestamps: { started: new Date().toISOString() } },
      'b-orphan': { phase: 'do', phaseNumber: 4, matchRate: null, iterationCount: 0, requirements: [], documents: {}, timestamps: { started: new Date().toISOString() } },
    });
    createPlanDoc('a-live');
    cleanup.deleteFeatureFromStatus('b-orphan');
    const { STATE_PATHS } = require('../../lib/core/paths');
    const status = JSON.parse(fs.readFileSync(STATE_PATHS.pdcaStatus(), 'utf8'));
    assert('ORPHAN-04',
      !status.features['b-orphan'] &&
      status.activeFeatures.includes('a-live') &&
      !status.activeFeatures.includes('b-orphan') &&
      status.primaryFeature === 'a-live' &&
      status.history.some((h) => h.action === 'orphan_feature_deleted'),
      'orphan removal cleans activeFeatures/primaryFeature and logs orphan_feature_deleted');
  } else {
    skip('ORPHAN-04', 'Module not loaded');
  }
}

// ============================================================
// TC-ORPHAN-05: terminal-phase (archived) active feature still deletable
// ============================================================
{
  if (moduleLoaded) {
    seedStatus({
      'archived-feat': { phase: 'archived', phaseNumber: 9, matchRate: 95, iterationCount: 2, requirements: [], documents: {}, timestamps: { started: new Date().toISOString() } },
    });
    const result = cleanup.deleteFeatureFromStatus('archived-feat');
    assert('ORPHAN-05',
      result.success === true && result.deletedFeature === 'archived-feat' && !result.reason,
      'archived feature deleted via original path (no orphan reason)');
  } else {
    skip('ORPHAN-05', 'Module not loaded');
  }
}

// eslint-disable-next-line no-console -- test output convention
console.log('');
summary();
process.exit(0);
