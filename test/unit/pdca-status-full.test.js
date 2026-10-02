#!/usr/bin/env node
'use strict';
/**
 * Unit Tests for lib/pdca/status.js — Full Export Coverage
 * 25 TC | All 19 previously untested exports
 *
 * @version bkit v2.1.0
 */

const path = require('path');
const fs = require('fs');
const { assert, skip, assertNoThrow, summary, reset } = require('../helpers/assert');
const { withTempDir, createBkitStateDir } = require('../helpers/temp-dir');
reset();

console.log('\n=== pdca-status-full.test.js (25 TC) ===\n');

// Load module
let status;
try {
  status = require('../../lib/pdca/status');
} catch (e) {
  status = null;
}

const moduleLoaded = status !== null;

// ============================================================
// Section 1: migrateStatusToV2 (PS-001 ~ PS-003)
// ============================================================
console.log('\n--- Section 1: migrateStatusToV2 ---');

// PS-001: migrateStatusToV2 is a function with arity 1
{
  assert('PS-001', moduleLoaded && typeof status.migrateStatusToV2 === 'function' && status.migrateStatusToV2.length === 1,
    'migrateStatusToV2 is exported function with arity 1');
}

// PS-002: migrateStatusToV2 migrates v1 features and sets version 2.0
{
  if (moduleLoaded) {
    const old = {
      features: { 'feat-a': { phase: 'plan', startedAt: '2025-01-01' } },
      currentFeature: 'feat-a',
      currentPhase: 2,
      history: [{ action: 'test' }]
    };
    const result = status.migrateStatusToV2(old);
    assert('PS-002',
      result.version === '2.0' &&
      result.primaryFeature === 'feat-a' &&
      result.pipeline.currentPhase === 2 &&
      result.history.length === 1 &&
      result.activeFeatures.includes('feat-a') &&
      result.features['feat-a'].requirements !== undefined &&
      result.features['feat-a'].documents !== undefined &&
      result.features['feat-a'].timestamps !== undefined,
      'migrateStatusToV2 correctly migrates v1 fields to v2');
  } else {
    skip('PS-002', 'Module not loaded');
  }
}

// PS-003: migrateStatusToV2 handles empty old status gracefully
{
  if (moduleLoaded) {
    const result = status.migrateStatusToV2({});
    assert('PS-003',
      result.version === '2.0' &&
      result.activeFeatures.length === 0 &&
      result.primaryFeature === null &&
      Object.keys(result.features).length === 0,
      'migrateStatusToV2 handles empty input');
  } else {
    skip('PS-003', 'Module not loaded');
  }
}

// ============================================================
// Section 2: migrateStatusV2toV3 (PS-004 ~ PS-006)
// ============================================================
console.log('\n--- Section 2: migrateStatusV2toV3 ---');

// PS-004: migrateStatusV2toV3 is a function with arity 1
{
  assert('PS-004', moduleLoaded && typeof status.migrateStatusV2toV3 === 'function' && status.migrateStatusV2toV3.length === 1,
    'migrateStatusV2toV3 is exported function with arity 1');
}

// PS-005: migrateStatusV2toV3 adds v3 fields (stateMachine, automation, team)
{
  if (moduleLoaded) {
    const v2 = status.createInitialStatusV2();
    v2.features['test-feat'] = { phase: 'plan' };
    const v3 = status.migrateStatusV2toV3(v2);
    assert('PS-005',
      v3.version === '3.0' &&
      v3.stateMachine !== undefined &&
      v3.automation !== undefined &&
      v3.team !== undefined &&
      v3.features['test-feat'].stateMachine !== undefined &&
      v3.features['test-feat'].metrics !== undefined &&
      v3.features['test-feat'].phaseTimestamps !== undefined &&
      v3.features['test-feat'].automationLevel === 2,
      'migrateStatusV2toV3 adds all v3 sections');
  } else {
    skip('PS-005', 'Module not loaded');
  }
}

// PS-006: migrateStatusV2toV3 is idempotent for v3.0 input
{
  if (moduleLoaded) {
    const v2 = status.createInitialStatusV2();
    const v3a = status.migrateStatusV2toV3(v2);
    const v3b = status.migrateStatusV2toV3(v3a);
    assert('PS-006', v3a === v3b,
      'migrateStatusV2toV3 returns same object if already v3.0');
  } else {
    skip('PS-006', 'Module not loaded');
  }
}

// ============================================================
// Section 3: initPdcaStatusIfNotExists (PS-007)
// ============================================================
console.log('\n--- Section 3: initPdcaStatusIfNotExists ---');

// PS-007: initPdcaStatusIfNotExists is a function with arity 0
{
  assert('PS-007', moduleLoaded && typeof status.initPdcaStatusIfNotExists === 'function' && status.initPdcaStatusIfNotExists.length === 0,
    'initPdcaStatusIfNotExists is exported function with arity 0');
}

// ============================================================
// Section 4: loadPdcaStatus (PS-008)
// ============================================================
console.log('\n--- Section 4: loadPdcaStatus ---');

// PS-008: loadPdcaStatus returns object with version field
{
  if (moduleLoaded) {
    const result = status.loadPdcaStatus();
    assert('PS-008',
      result !== null && typeof result === 'object' && typeof result.version === 'string',
      'loadPdcaStatus returns status object with version');
  } else {
    skip('PS-008', 'Module not loaded');
  }
}

// ============================================================
// Section 5: savePdcaStatus (PS-009)
// ============================================================
console.log('\n--- Section 5: savePdcaStatus ---');

// PS-009: savePdcaStatus is a function with arity 1
{
  assert('PS-009', moduleLoaded && typeof status.savePdcaStatus === 'function' && status.savePdcaStatus.length === 1,
    'savePdcaStatus is exported function with arity 1');
}

// ============================================================
// Section 6: getFeatureStatus (PS-010 ~ PS-011)
// ============================================================
console.log('\n--- Section 6: getFeatureStatus ---');

// PS-010: getFeatureStatus returns null for nonexistent feature
{
  if (moduleLoaded) {
    const result = status.getFeatureStatus('__nonexistent_test_feature__');
    assert('PS-010', result === null,
      'getFeatureStatus returns null for nonexistent feature');
  } else {
    skip('PS-010', 'Module not loaded');
  }
}

// PS-011: getFeatureStatus returns object for existing feature (if any)
{
  if (moduleLoaded) {
    const fullStatus = status.loadPdcaStatus();
    const featureNames = Object.keys(fullStatus?.features || {});
    if (featureNames.length > 0) {
      const result = status.getFeatureStatus(featureNames[0]);
      assert('PS-011', result !== null && typeof result === 'object',
        'getFeatureStatus returns object for existing feature');
    } else {
      skip('PS-011', 'No features in current status to test');
    }
  } else {
    skip('PS-011', 'Module not loaded');
  }
}

// ============================================================
// Section 7: updatePdcaStatus (PS-012)
// ============================================================
console.log('\n--- Section 7: updatePdcaStatus ---');

// PS-012: updatePdcaStatus is a function with arity 2+ (3rd param has default)
{
  assert('PS-012', moduleLoaded && typeof status.updatePdcaStatus === 'function' && status.updatePdcaStatus.length >= 2,
    'updatePdcaStatus is exported function with arity >= 2');
}

// ============================================================
// Section 8: addPdcaHistory (PS-013)
// ============================================================
console.log('\n--- Section 8: addPdcaHistory ---');

// PS-013: addPdcaHistory is a function with arity 1
{
  assert('PS-013', moduleLoaded && typeof status.addPdcaHistory === 'function' && status.addPdcaHistory.length === 1,
    'addPdcaHistory is exported function with arity 1');
}

// ============================================================
// Section 9: completePdcaFeature (PS-014)
// ============================================================
console.log('\n--- Section 9: completePdcaFeature ---');

// PS-014: completePdcaFeature is a function with arity 1
{
  assert('PS-014', moduleLoaded && typeof status.completePdcaFeature === 'function' && status.completePdcaFeature.length === 1,
    'completePdcaFeature is exported function with arity 1');
}

// ============================================================
// Section 10: setActiveFeature (PS-015)
// ============================================================
console.log('\n--- Section 10: setActiveFeature ---');

// PS-015: setActiveFeature is a function with arity 1
{
  assert('PS-015', moduleLoaded && typeof status.setActiveFeature === 'function' && status.setActiveFeature.length === 1,
    'setActiveFeature is exported function with arity 1');
}

// ============================================================
// Section 11: addActiveFeature (PS-016)
// ============================================================
console.log('\n--- Section 11: addActiveFeature ---');

// PS-016: addActiveFeature is a function with arity 1+ (2nd param has default)
{
  assert('PS-016', moduleLoaded && typeof status.addActiveFeature === 'function' && status.addActiveFeature.length >= 1,
    'addActiveFeature is exported function with arity >= 1');
}

// ============================================================
// Section 12: removeActiveFeature (PS-017)
// ============================================================
console.log('\n--- Section 12: removeActiveFeature ---');

// PS-017: removeActiveFeature is a function with arity 1
{
  assert('PS-017', moduleLoaded && typeof status.removeActiveFeature === 'function' && status.removeActiveFeature.length === 1,
    'removeActiveFeature is exported function with arity 1');
}

// ============================================================
// Section 13: deleteFeatureFromStatus (PS-018 ~ PS-019)
// ============================================================
console.log('\n--- Section 13: deleteFeatureFromStatus ---');

// PS-018: deleteFeatureFromStatus returns failure for nonexistent feature
{
  if (moduleLoaded) {
    const result = status.deleteFeatureFromStatus('__nonexistent_test_feature__');
    assert('PS-018',
      result.success === false && result.reason === 'Feature not found',
      'deleteFeatureFromStatus returns {success:false} for nonexistent feature');
  } else {
    skip('PS-018', 'Module not loaded');
  }
}

// PS-019: deleteFeatureFromStatus rejects LIVE active non-archived feature.
// Bugfix wave 20260919 §3 Fix 3: an active feature whose plan/design docs are
// both gone is a sanctioned ORPHAN and is now deletable (covered by
// status-cleanup-orphan.test.js). Refusal is only contracted for features
// that still have docs on disk, so PS-019 selects doc-backed features only.
{
  if (moduleLoaded) {
    const fullStatus = status.loadPdcaStatus();
    const { findPlanDoc, findDesignDoc } = require('../../lib/pdca/phase');
    const activeFeats = (fullStatus?.activeFeatures || []).filter(f => {
      const feat = fullStatus.features[f];
      return feat && feat.phase !== 'archived' && feat.phase !== 'completed' &&
        (!!findPlanDoc(f) || !!findDesignDoc(f));
    });
    if (activeFeats.length > 0) {
      const result = status.deleteFeatureFromStatus(activeFeats[0]);
      assert('PS-019',
        result.success === false && result.reason === 'Cannot delete active feature',
        'deleteFeatureFromStatus rejects live (doc-backed) active non-archived feature');
    } else {
      skip('PS-019', 'No live doc-backed non-archived features to test');
    }
  } else {
    skip('PS-019', 'Module not loaded');
  }
}

// ============================================================
// Section 14: enforceFeatureLimit (PS-020)
// ============================================================
console.log('\n--- Section 14: enforceFeatureLimit ---');

// PS-020: enforceFeatureLimit with high limit returns success with no deletions
{
  if (moduleLoaded) {
    const result = status.enforceFeatureLimit(9999);
    assert('PS-020',
      result.success === true && result.deletedCount === 0 && result.remaining > 0,
      'enforceFeatureLimit(9999) returns success with no deletions');
  } else {
    skip('PS-020', 'Module not loaded');
  }
}

// ============================================================
// Section 15: getArchivedFeatures (PS-021)
// ============================================================
console.log('\n--- Section 15: getArchivedFeatures ---');

// PS-021: getArchivedFeatures returns array
{
  if (moduleLoaded) {
    const result = status.getArchivedFeatures();
    assert('PS-021', Array.isArray(result),
      'getArchivedFeatures returns array');
  } else {
    skip('PS-021', 'Module not loaded');
  }
}

// ============================================================
// Section 16: cleanupArchivedFeatures (PS-022)
// ============================================================
console.log('\n--- Section 16: cleanupArchivedFeatures ---');

// PS-022: cleanupArchivedFeatures with empty array returns success with no deletions
{
  if (moduleLoaded) {
    const result = status.cleanupArchivedFeatures([]);
    assert('PS-022',
      result.success === true && result.deletedCount === 0,
      'cleanupArchivedFeatures([]) returns success with no deletions');
  } else {
    skip('PS-022', 'Module not loaded');
  }
}

// ============================================================
// Section 17: archiveFeatureToSummary (PS-023)
// ============================================================
console.log('\n--- Section 17: archiveFeatureToSummary ---');

// PS-023: archiveFeatureToSummary returns failure for nonexistent feature
{
  if (moduleLoaded) {
    const result = status.archiveFeatureToSummary('__nonexistent_test_feature__');
    assert('PS-023',
      result.success === false && result.reason === 'Feature not found',
      'archiveFeatureToSummary returns {success:false} for nonexistent feature');
  } else {
    skip('PS-023', 'Module not loaded');
  }
}

// ============================================================
// Section 18: switchFeatureContext (PS-024)
// ============================================================
console.log('\n--- Section 18: switchFeatureContext ---');

// PS-024: switchFeatureContext returns false for nonexistent feature
{
  if (moduleLoaded) {
    const result = status.switchFeatureContext('__nonexistent_test_feature__');
    assert('PS-024', result === false,
      'switchFeatureContext returns false for nonexistent feature');
  } else {
    skip('PS-024', 'Module not loaded');
  }
}

// ============================================================
// Section 19: extractFeatureFromContext (PS-025 ~ PS-027)
// ============================================================
console.log('\n--- Section 19: extractFeatureFromContext ---');

// PS-025: extractFeatureFromContext returns explicit feature when provided
{
  if (moduleLoaded) {
    const result = status.extractFeatureFromContext({ feature: 'my-feature' });
    assert('PS-025', result === 'my-feature',
      'extractFeatureFromContext returns explicit feature');
  } else {
    skip('PS-025', 'Module not loaded');
  }
}

// PS-026 (Issue #89, v2.1.15+): extractFeatureFromContext does NOT extract
// arbitrary path segments as feature names. This prevents the .pdca-status.json
// garbage accumulation bug where every Edit/Write under src/features/,
// app/services/, packages/, etc. registered a fake feature.
// Expected: function returns either a string fallback (primaryFeature) or
// empty string, but NOT 'auth' extracted from the path.
{
  if (moduleLoaded) {
    const result = status.extractFeatureFromContext({ filePath: 'src/features/auth/login.js' });
    assert('PS-026', typeof result === 'string' && result !== 'auth',
      'extractFeatureFromContext does NOT extract "auth" from arbitrary filePath (Issue #89 fix)');
  } else {
    skip('PS-026', 'Module not loaded');
  }
}

// PS-027: extractFeatureFromContext falls back to primaryFeature
{
  if (moduleLoaded) {
    const result = status.extractFeatureFromContext({});
    assert('PS-027', typeof result === 'string',
      'extractFeatureFromContext returns string fallback from primaryFeature');
  } else {
    skip('PS-027', 'Module not loaded');
  }
}

// ============================================================
// Summary
// ============================================================
const { failed } = summary('pdca-status-full.test.js');
if (failed > 0) process.exit(1);
