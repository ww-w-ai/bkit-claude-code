/**
 * PDCA Status — Cleanup functions (delete, enforce limit, archive summary).
 *
 * Design Ref: bkit-v2110-integrated-enhancement.design.md §4.1
 * Plan SC: Sprint 1 status.js 872→3파일 분할 — cleanup 로직 별도 모듈.
 *
 * Split from `lib/pdca/status.js` (v2.1.9 baseline).
 *
 * @module lib/pdca/status-cleanup
 *
 * @version 2.1.12
 */

// Lazy imports to avoid circular deps.
let _core = null;
function getCore() {
  if (!_core) _core = require('../core');
  return _core;
}
let _coreStatus = null;
function getStatusCore() {
  if (!_coreStatus) _coreStatus = require('./status-core');
  return _coreStatus;
}

/**
 * Delete feature completely from PDCA status
 * @param {string} feature - Feature name to delete
 * @returns {{ success: boolean, reason?: string, deletedFeature?: string }}
 */
function deleteFeatureFromStatus(feature) {
  const { debugLog } = getCore();
  const { getPdcaStatusFull, savePdcaStatus } = getStatusCore();
  const status = getPdcaStatusFull(true);

  if (!status) return { success: false, reason: 'Status not found' };
  if (!status.features[feature]) return { success: false, reason: 'Feature not found' };

  const featureStatus = status.features[feature];
  // Design Ref: §3 Fix 3 (BR-001) — sanctioned orphan path. An active-feature
  // row with a NON-terminal phase whose plan/design docs are both gone is an
  // orphan; it must be removable. Live features with docs on disk stay refused.
  const isTerminal = featureStatus.phase === 'archived' || featureStatus.phase === 'completed';
  const isOrphan = !isTerminal && !hasPlanOrDesignDoc(feature);
  if (status.activeFeatures.includes(feature) && !isTerminal && !isOrphan) {
    return { success: false, reason: 'Cannot delete active feature' };
  }

  delete status.features[feature];
  status.activeFeatures = status.activeFeatures.filter((f) => f !== feature);
  if (status.primaryFeature === feature) {
    status.primaryFeature = getStatusCore().pickPrimarySuccessor(status);
  }

  status.history.push({
    timestamp: new Date().toISOString(),
    action: isOrphan ? 'orphan_feature_deleted' : 'feature_deleted',
    feature: feature,
  });
  if (status.history.length > 100) status.history = status.history.slice(-100);

  savePdcaStatus(status);
  debugLog('PDCA', `Feature deleted: ${feature}${isOrphan ? ' (orphan-removed)' : ''}`);
  return {
    success: true,
    deletedFeature: feature,
    ...(isOrphan ? { reason: 'orphan-removed (docs missing)' } : {}),
  };
}

/**
 * Design Ref: §3 Fix 3 — does the feature have a plan or design doc on disk?
 * Reuses the phase module's findPlanDoc/findDesignDoc (same doc resolution the
 * shouldUpdate gate uses) instead of hardcoding paths.
 * @param {string} feature
 * @returns {boolean}
 */
function hasPlanOrDesignDoc(feature) {
  try {
    const { findPlanDoc, findDesignDoc } = require('./phase');
    return !!findPlanDoc(feature) || !!findDesignDoc(feature);
  } catch {
    return true; // conservative: refuse deletion when doc lookup fails
  }
}

/**
 * Enforce maximum feature count, delete oldest archived features
 * @param {number} maxFeatures - Maximum features to keep (default: 50)
 * @returns {{ success: boolean, deletedCount: number, deleted: string[], remaining: number }}
 */
function enforceFeatureLimit(maxFeatures = 50) {
  const { debugLog } = getCore();
  const { getPdcaStatusFull, savePdcaStatus } = getStatusCore();
  const status = getPdcaStatusFull(true);

  if (!status) return { success: false, deletedCount: 0, deleted: [], remaining: 0 };

  const featureNames = Object.keys(status.features);
  const featureCount = featureNames.length;
  if (featureCount <= maxFeatures) {
    return { success: true, deletedCount: 0, deleted: [], remaining: featureCount };
  }

  const archived = Object.entries(status.features)
    .filter(([, f]) => f.phase === 'archived' || f.phase === 'completed')
    .sort((a, b) => {
      const dateA = new Date(a[1].timestamps?.archivedAt || a[1].timestamps?.lastUpdated || 0);
      const dateB = new Date(b[1].timestamps?.archivedAt || b[1].timestamps?.lastUpdated || 0);
      return dateA - dateB;
    });

  const toDeleteCount = featureCount - maxFeatures;
  const deleted = [];

  for (let i = 0; i < Math.min(toDeleteCount, archived.length); i++) {
    const featureName = archived[i][0];
    delete status.features[featureName];
    status.activeFeatures = status.activeFeatures.filter((f) => f !== featureName);
    deleted.push(featureName);
  }

  if (deleted.length === 0) {
    debugLog('PDCA', 'Feature limit exceeded but no archived features to delete');
    return {
      success: true,
      deletedCount: 0,
      deleted: [],
      remaining: Object.keys(status.features).length,
    };
  }

  status.history.push({
    timestamp: new Date().toISOString(),
    action: 'auto_cleanup',
    deletedCount: deleted.length,
    deleted: deleted,
  });
  if (status.history.length > 100) status.history = status.history.slice(-100);

  if (deleted.includes(status.primaryFeature)) {
    status.primaryFeature = getStatusCore().pickPrimarySuccessor(status);
  }

  savePdcaStatus(status);
  debugLog('PDCA', `Auto cleanup: deleted ${deleted.length} features`, { deleted });
  return {
    success: true,
    deletedCount: deleted.length,
    deleted,
    remaining: Object.keys(status.features).length,
  };
}

/**
 * Get list of archived or completed features
 * @returns {string[]} Feature names
 */
function getArchivedFeatures() {
  const { getPdcaStatusFull } = getStatusCore();
  const status = getPdcaStatusFull();
  if (!status) return [];
  return Object.entries(status.features)
    .filter(([, f]) => f.phase === 'archived' || f.phase === 'completed')
    .map(([name]) => name);
}

/**
 * Cleanup specific archived features or all archived
 * @param {string[]|null} features - Feature names to delete (optional, all if not specified)
 * @returns {{ success: boolean, deletedCount: number, deleted: string[], remaining: number }}
 */
function cleanupArchivedFeatures(features = null) {
  const { debugLog } = getCore();
  const { getPdcaStatusFull, savePdcaStatus } = getStatusCore();
  const status = getPdcaStatusFull(true);

  if (!status) return { success: false, deletedCount: 0, deleted: [], remaining: 0 };

  const targets = features || getArchivedFeatures();
  const deleted = [];

  for (const feature of targets) {
    const featureStatus = status.features[feature];
    if (
      !featureStatus ||
      (featureStatus.phase !== 'archived' && featureStatus.phase !== 'completed')
    ) {
      continue;
    }
    delete status.features[feature];
    status.activeFeatures = status.activeFeatures.filter((f) => f !== feature);
    deleted.push(feature);
  }

  if (deleted.length === 0) {
    return {
      success: true,
      deletedCount: 0,
      deleted: [],
      remaining: Object.keys(status.features).length,
    };
  }

  status.history.push({
    timestamp: new Date().toISOString(),
    action: 'feature_deleted',
    deletedCount: deleted.length,
    deleted: deleted,
  });
  if (status.history.length > 100) status.history = status.history.slice(-100);

  if (deleted.includes(status.primaryFeature)) {
    status.primaryFeature = getStatusCore().pickPrimarySuccessor(status);
  }

  savePdcaStatus(status);
  debugLog('PDCA', `Manual cleanup: deleted ${deleted.length} features`);
  return {
    success: true,
    deletedCount: deleted.length,
    deleted,
    remaining: Object.keys(status.features).length,
  };
}

/**
 * FR-04: Archive feature to summary (preserve minimal info).
 *
 * @param {string} feature - Feature name to convert
 * @returns {{ success: boolean, reason?: string, summarizedFeature?: string }}
 */
function archiveFeatureToSummary(feature) {
  const { debugLog } = getCore();
  const { getPdcaStatusFull, savePdcaStatus } = getStatusCore();
  const status = getPdcaStatusFull(true);

  if (!status) return { success: false, reason: 'Status not found' };
  if (!status.features[feature]) return { success: false, reason: 'Feature not found' };

  const full = status.features[feature];
  if (full.phase !== 'archived' && full.phase !== 'completed') {
    return { success: false, reason: 'Feature must be archived or completed' };
  }

  status.features[feature] = {
    phase: 'archived',
    matchRate: full.matchRate,
    iterationCount: full.iterationCount || 0,
    startedAt: full.timestamps?.started || null,
    archivedAt: full.timestamps?.archivedAt || new Date().toISOString(),
    archivedTo: full.archivedTo || null,
  };

  status.activeFeatures = status.activeFeatures.filter((f) => f !== feature);
  if (status.primaryFeature === feature) {
    status.primaryFeature = getStatusCore().pickPrimarySuccessor(status);
  }

  status.history.push({
    timestamp: new Date().toISOString(),
    action: 'feature_summarized',
    feature: feature,
  });
  if (status.history.length > 100) status.history = status.history.slice(-100);

  savePdcaStatus(status);
  debugLog('PDCA', `Feature summarized: ${feature}`);
  return { success: true, summarizedFeature: feature };
}

module.exports = {
  deleteFeatureFromStatus,
  enforceFeatureLimit,
  getArchivedFeatures,
  cleanupArchivedFeatures,
  archiveFeatureToSummary,
};
