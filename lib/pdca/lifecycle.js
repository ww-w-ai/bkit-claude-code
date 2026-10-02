/**
 * PDCA Feature Lifecycle Management
 * @module lib/pdca/lifecycle
 * @version 2.1.10
 *
 * Manages PDCA feature lifecycle including:
 * - Feature initialization with metadata
 * - Phase metadata updates with timestamps
 * - Auto-archive detection (normal, timeout, abandoned, forced)
 * - Stale feature detection and cleanup
 * - Feature timeline tracking
 */


// Lazy requires
let _core = null;
function getCore() {
  if (!_core) { _core = require('../core'); }
  return _core;
}

let _status = null;
function getStatus() {
  if (!_status) { _status = require('./status'); }
  return _status;
}

/** @type {number} Default stale timeout in days */
const DEFAULT_STALE_DAYS = 7;

/** @type {number} Default match rate threshold for normal completion */
const DEFAULT_MATCH_RATE_THRESHOLD = 90;

/**
 * Initialize a new feature in PDCA status
 * @param {string} feature - Feature name
 * @param {Object} [options] - Initialization options
 * @param {string} [options.phase='pm'] - Starting phase
 * @param {boolean} [options.setAsPrimary=true] - Set as primary feature
 * @param {Object} [options.metadata] - Additional metadata
 * @returns {void}
 */
function initializeFeature(feature, options = {}) {
  const { debugLog } = getCore();
  const { updatePdcaStatus, addActiveFeature } = getStatus();

  const phase = options.phase || 'pm';
  const now = new Date().toISOString();

  updatePdcaStatus(feature, phase, {
    matchRate: null,
    iterationCount: 0,
    requirements: [],
    documents: {},
    timestamps: {
      started: now,
      lastUpdated: now,
      phaseHistory: [{ phase, enteredAt: now }],
    },
    metadata: options.metadata || {},
  });

  if (options.setAsPrimary !== false) {
    addActiveFeature(feature, true);
  }

  debugLog('PDCA', `Feature initialized: ${feature}`, { phase });
}

/**
 * Update phase metadata for a feature
 * @param {string} feature - Feature name
 * @param {string} phase - Current phase
 * @param {Object} [metadata] - Phase-specific metadata
 * @returns {void}
 */
function updatePhaseMetadata(feature, phase, metadata = {}) {
  const { debugLog } = getCore();
  const { getFeatureStatus, updatePdcaStatus } = getStatus();

  const existing = getFeatureStatus(feature);
  if (!existing) {
    debugLog('PDCA', `Cannot update metadata: feature ${feature} not found`);
    return;
  }

  const now = new Date().toISOString();
  const phaseHistory = existing.timestamps?.phaseHistory || [];

  // Add phase entry if transitioning
  if (existing.phase !== phase) {
    phaseHistory.push({ phase, enteredAt: now });
  }

  updatePdcaStatus(feature, phase, {
    timestamps: {
      ...existing.timestamps,
      lastUpdated: now,
      phaseHistory,
    },
    metadata: {
      ...existing.metadata,
      ...metadata,
    },
  });
}

/**
 * Check if a feature should be auto-archived
 * @param {string} feature - Feature name
 * @returns {boolean} True if feature qualifies for auto-archive
 */
function shouldAutoArchive(feature) {
  const { getFeatureStatus } = getStatus();
  const feat = getFeatureStatus(feature);
  if (!feat) return false;

  // Condition 1: Normal completion (report phase + matchRate >= threshold)
  if (feat.phase === 'report' && feat.matchRate >= DEFAULT_MATCH_RATE_THRESHOLD) {
    return true;
  }

  // Condition 2: Already completed
  if (feat.phase === 'completed') {
    return true;
  }

  return false;
}

/**
 * Archive a feature with metadata
 * @param {string} feature - Feature name
 * @returns {{ archived: boolean, archivePath: string, reason: string }}
 */
function archiveFeature(feature) {
  const { debugLog } = getCore();
  const { getFeatureStatus, updatePdcaStatus, removeActiveFeature, addPdcaHistory } = getStatus();
  const { getArchivePath } = require('../core/paths');

  const feat = getFeatureStatus(feature);
  if (!feat) {
    return { archived: false, archivePath: '', reason: 'Feature not found' };
  }

  const archivePath = getArchivePath(feature);
  const now = new Date().toISOString();

  // Design Ref: §3 Fix 2 — requireDocs:false on the archived transition only.
  // An archived feature has by definition left its docs' source location
  // (they live in docs/archive/), so the plan/design existence gate would
  // silently skip the write on re-archive.
  updatePdcaStatus(feature, 'archived', {
    timestamps: {
      ...feat.timestamps,
      archivedAt: now,
    },
    archivedTo: archivePath,
  }, { requireDocs: false });

  removeActiveFeature(feature);

  addPdcaHistory({
    feature,
    action: 'archived',
    phase: feat.phase,
    matchRate: feat.matchRate,
    archivePath,
  });

  debugLog('PDCA', `Feature archived: ${feature}`, { archivePath });

  return { archived: true, archivePath, reason: 'Successfully archived' };
}

/**
 * Detect stale features that have been inactive beyond threshold
 * @param {number} [maxIdleDays] - Maximum idle days (default: 7)
 * @returns {Array<{ feature: string, lastActivity: string, daysIdle: number, phase: string }>}
 */
function detectStaleFeatures(maxIdleDays) {
  const { getConfig } = getCore();
  const { getPdcaStatusFull } = getStatus();

  // ENH-453 (v2.1.36): read `pdca.staleDays`. The previous path
  // `pdca.automation.staleDays` addressed a section bkit.config.json does not
  // have (there is a top-level `automation`, but no `pdca.automation`), so this
  // always fell back to the built-in default and the shipped config could not
  // influence it.
  const threshold = maxIdleDays || getConfig('pdca.staleDays', DEFAULT_STALE_DAYS);
  const status = getPdcaStatusFull();
  if (!status) return [];

  const now = Date.now();
  const thresholdMs = threshold * 24 * 60 * 60 * 1000;
  const stale = [];

  for (const featureName of (status.activeFeatures || [])) {
    const feat = status.features[featureName];
    if (!feat) continue;

    // Exclude features in Do phase (may be actively implementing)
    if (feat.phase === 'do') continue;

    const lastUpdated = feat.timestamps?.lastUpdated || feat.timestamps?.started;
    if (!lastUpdated) continue;

    const idleMs = now - new Date(lastUpdated).getTime();
    if (idleMs >= thresholdMs) {
      stale.push({
        feature: featureName,
        lastActivity: lastUpdated,
        daysIdle: Math.floor(idleMs / (24 * 60 * 60 * 1000)),
        phase: feat.phase,
      });
    }
  }

  return stale;
}

/**
 * Clean up stale features (archive or report)
 * @param {number} [maxIdleDays] - Maximum idle days threshold
 * @param {boolean} [dryRun=false] - If true, only report without taking action
 * @returns {{ cleaned: string[], skipped: string[] }}
 */
function cleanupStaleFeatures(maxIdleDays, dryRun = false) {
  const { debugLog } = getCore();
  const stale = detectStaleFeatures(maxIdleDays);

  const cleaned = [];
  const skipped = [];

  for (const entry of stale) {
    if (dryRun) {
      skipped.push(entry.feature);
      continue;
    }

    const result = archiveFeature(entry.feature);
    if (result.archived) {
      cleaned.push(entry.feature);
    } else {
      skipped.push(entry.feature);
    }
  }

  if (cleaned.length > 0) {
    debugLog('PDCA', `Stale cleanup: archived ${cleaned.length} features`, { cleaned });
  }

  return { cleaned, skipped };
}

/**
 * Get the full timeline of phase transitions for a feature
 * @param {string} feature - Feature name
 * @returns {Array<{ phase: string, enteredAt: string, duration: number|null }>}
 */
function getFeatureTimeline(feature) {
  const { getFeatureStatus } = getStatus();
  const feat = getFeatureStatus(feature);
  if (!feat) return [];

  const phaseHistory = feat.timestamps?.phaseHistory || [];
  if (!phaseHistory.length) {
    // Fallback: construct minimal timeline from available timestamps
    const entries = [];
    if (feat.timestamps?.started) {
      entries.push({ phase: feat.phase, enteredAt: feat.timestamps.started, duration: null });
    }
    return entries;
  }

  return phaseHistory.map((entry, i) => {
    const nextEntry = phaseHistory[i + 1];
    let duration = null;

    if (nextEntry) {
      duration = new Date(nextEntry.enteredAt).getTime() - new Date(entry.enteredAt).getTime();
    }

    return {
      phase: entry.phase,
      enteredAt: entry.enteredAt,
      duration,
    };
  });
}

/**
 * Complete a feature normally (match rate threshold met)
 * @param {string} feature - Feature name
 * @param {Object} [options] - Completion options
 * @param {number} [options.matchRate] - Final match rate
 * @returns {{ success: boolean, archived: boolean }}
 */
function completeFeature(feature, options = {}) {
  const { debugLog } = getCore();
  const { getFeatureStatus, updatePdcaStatus, completePdcaFeature } = getStatus();

  const existing = getFeatureStatus(feature);
  if (!existing) {
    return { success: false, archived: false };
  }

  const now = new Date().toISOString();
  updatePdcaStatus(feature, 'report', {
    matchRate: options.matchRate || existing.matchRate,
    completedAt: now,
    completionType: 'normal',
  });

  completePdcaFeature(feature);

  const archived = shouldAutoArchive(feature);
  if (archived) {
    archiveFeature(feature);
  }

  debugLog('PDCA', `Feature completed: ${feature}`, { matchRate: options.matchRate, archived });
  return { success: true, archived };
}

/**
 * Abandon a feature (user decided to stop)
 * @param {string} feature - Feature name
 * @param {string} [reason] - Abandonment reason
 * @returns {{ success: boolean }}
 */
function abandonFeature(feature, reason = 'user_abandoned') {
  const { debugLog } = getCore();
  const { getFeatureStatus, updatePdcaStatus } = getStatus();

  const existing = getFeatureStatus(feature);
  if (!existing) {
    return { success: false };
  }

  const now = new Date().toISOString();
  updatePdcaStatus(feature, existing.phase || 'idle', {
    completedAt: now,
    completionType: 'abandoned',
    abandonReason: reason,
  });

  debugLog('PDCA', `Feature abandoned: ${feature}`, { reason });
  return { success: true };
}

/**
 * Run full cleanup: stale features, expired resume points, enforce limits
 * @param {Object} [options] - Cleanup options
 * @param {number} [options.maxFeatures] - Maximum active features
 * @param {number} [options.staleDays] - Days before stale detection
 * @returns {{ staleCleanedUp: number, limitEnforced: number }}
 */
function runCleanup(options = {}) {
  const staleDays = options.staleDays || DEFAULT_STALE_DAYS;
  const maxFeatures = options.maxFeatures || 5;

  // 1. Clean up stale features
  const staleCleanedUp = cleanupStaleFeatures(staleDays);

  // 2. Enforce feature limit
  const limitEnforced = enforceLimit(maxFeatures);

  // 3. Clean up expired resume points
  try {
    const resume = require('./resume');
    resume.cleanupExpired();
  } catch { /* non-critical */ }

  return { staleCleanedUp, limitEnforced };
}

/**
 * Enforce maximum active feature limit by archiving oldest completed features
 * @param {number} [maxFeatures=5] - Maximum active features allowed
 * @returns {number} Number of features archived to enforce limit
 */
function enforceLimit(maxFeatures = 5) {
  const { getPdcaStatusFull } = getStatus();
  const pdcaStatus = getPdcaStatusFull();

  const features = pdcaStatus?.features || {};
  const activeFeatureNames = Object.keys(features).filter(f => {
    const s = features[f];
    return s && s.phase !== 'archived' && s.completionType !== 'archived';
  });

  if (activeFeatureNames.length <= maxFeatures) {
    return 0;
  }

  // Sort by lastUpdated ascending (oldest first)
  const sorted = activeFeatureNames
    .map(f => ({ name: f, lastUpdated: features[f].timestamps?.lastUpdated || '1970-01-01' }))
    .sort((a, b) => a.lastUpdated.localeCompare(b.lastUpdated));

  let archived = 0;
  const excess = sorted.length - maxFeatures;

  for (let i = 0; i < excess && i < sorted.length; i++) {
    const f = sorted[i].name;
    // Only enforce on completed features
    if (features[f].completionType) {
      archiveFeature(f);
      archived++;
    }
  }

  return archived;
}

module.exports = {
  initializeFeature,
  updatePhaseMetadata,
  shouldAutoArchive,
  archiveFeature,
  detectStaleFeatures,
  cleanupStaleFeatures,
  getFeatureTimeline,
  completeFeature,
  abandonFeature,
  runCleanup,
  enforceLimit,
};
