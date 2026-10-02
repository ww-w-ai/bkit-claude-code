/**
 * PDCA Status — Core daily-use functions.
 *
 * Design Ref: bkit-v2110-integrated-enhancement.design.md §4.1
 * Plan SC: Sprint 1 status.js 872→3파일 분할 — 핵심 조회/변경 API.
 *
 * Split from `lib/pdca/status.js` (v2.1.9 baseline).
 *
 * @module lib/pdca/status-core
 *
 * @version 2.1.15
 */

const fs = require('fs');
const path = require('path');

// Lazy imports to avoid circular deps.
let _core = null;
function getCore() {
  if (!_core) _core = require('../core');
  return _core;
}
let _phase = null;
function getPhase() {
  if (!_phase) _phase = require('./phase');
  return _phase;
}
let _migration = null;
function getMigration() {
  if (!_migration) _migration = require('./status-migration');
  return _migration;
}

/** Project-scoped cache key (#48 project isolation). */
function _getCacheKey() {
  try {
    const { PROJECT_DIR } = require('../core/platform');
    return `pdca-status:${PROJECT_DIR}`;
  } catch {
    return 'pdca-status';
  }
}

/**
 * Get PDCA status file path
 * @returns {string}
 */
function getPdcaStatusPath() {
  const { STATE_PATHS } = require('../core/paths');
  return STATE_PATHS.pdcaStatus();
}

/**
 * Initialize PDCA status file if not exists
 */
function initPdcaStatusIfNotExists() {
  const { globalCache, debugLog, stateStore } = getCore();
  const { createInitialStatusV2 } = getMigration();
  const statusPath = getPdcaStatusPath();

  if (fs.existsSync(statusPath)) return;

  const docsDir = path.dirname(statusPath);
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  const initialStatus = createInitialStatusV2();
  // H1 fix (audit): atomic write so a SIGKILL mid-init can't leave a truncated
  // pdca-status.json that would then gate every subsequent phase transition.
  stateStore.write(statusPath, initialStatus);
  globalCache.set(_getCacheKey(), initialStatus);
  debugLog('PDCA', 'Status file initialized (v2.0)', { path: statusPath });
}

/**
 * Get current PDCA status with caching and auto-migration
 * @param {boolean} forceRefresh - Skip cache and read from file
 * @returns {Object|null}
 */
function getPdcaStatusFull(forceRefresh = false) {
  const { globalCache, debugLog } = getCore();
  const { migrateStatusToV2, migrateStatusV2toV3 } = getMigration();
  const statusPath = getPdcaStatusPath();

  try {
    if (!forceRefresh) {
      const cached = globalCache.get(_getCacheKey(), 3000);
      if (cached) return cached;
    }
    if (!fs.existsSync(statusPath)) return null;

    let status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));

    // Auto-migrate: v1.0 -> v2.0 -> v3.0
    if (!status.version || status.version === '1.0') {
      status = migrateStatusToV2(status);
      status = migrateStatusV2toV3(status);
      savePdcaStatus(status);
    } else if (status.version === '2.0') {
      status = migrateStatusV2toV3(status);
      savePdcaStatus(status);
    }

    globalCache.set(_getCacheKey(), status);
    return status;
  } catch (e) {
    debugLog('PDCA', 'Failed to read status', { error: e.message });
    return null;
  }
}

/**
 * Alias for getPdcaStatusFull
 * @returns {Object|null}
 */
function loadPdcaStatus() {
  return getPdcaStatusFull();
}

/**
 * Save PDCA status to file and update cache
 * @param {Object} status
 */
function savePdcaStatus(status) {
  const { globalCache, debugLog, stateStore } = getCore();
  const statusPath = getPdcaStatusPath();

  try {
    status.lastUpdated = new Date().toISOString();
    if (status.session) status.session.lastActivity = status.lastUpdated;

    const docsDir = path.dirname(statusPath);
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

    // H1 fix (audit): atomic write of the PDCA source-of-truth.
    stateStore.write(statusPath, status);
    globalCache.set(_getCacheKey(), status);
    debugLog('PDCA', 'Status saved', { version: status.version });

    // v1.6.2: Backup to ${CLAUDE_PLUGIN_DATA} (ENH-119)
    try {
      const { backupToPluginData } = require('../core/paths');
      backupToPluginData();
    } catch {
      /* non-critical */
    }
  } catch (e) {
    debugLog('PDCA', 'Failed to save status', { error: e.message });
  }
}

/**
 * Get feature status
 * @param {string} feature
 * @returns {Object|null}
 */
function getFeatureStatus(feature) {
  const status = getPdcaStatusFull();
  return status?.features?.[feature] || null;
}

/**
 * v2.1.15 (Issue #89): L3 게이트 헬퍼 — feature가 plan/design 문서를 가지는지 검사.
 * Pure function (외부 fs/network 호출 캡슐화). 테스트 시 docCheckFn 주입 가능.
 *
 * @param {string} feature
 * @param {boolean} requireDocs - false면 항상 true 반환 (no-op)
 * @param {Function} [docCheckFn] - feature → boolean (테스트 주입용, default는 phase 모듈)
 * @returns {boolean} 등록 허용 여부
 */
function shouldUpdate(feature, requireDocs, docCheckFn) {
  if (!feature || typeof feature !== 'string') return false;
  if (!requireDocs) return true;
  const check =
    docCheckFn ||
    ((f) => {
      try {
        const { findPlanDoc, findDesignDoc } = require('./phase');
        return !!findPlanDoc(f) || !!findDesignDoc(f);
      } catch {
        return true; // 보수적 통과 (false-negative 방지)
      }
    });
  return check(feature);
}

/**
 * v2.1.15 (Issue #89): L5 history dedup + ring buffer 헬퍼.
 * Pure function. 마지막 entry와 feature/phase/action이 동일하면 timestamp만 갱신,
 * 다르면 push. 길이 100 초과 시 ring buffer.
 *
 * @param {Array} history - 기존 history 배열 (mutated in-place)
 * @param {Object} entry - 신규 entry {timestamp, feature, phase, action}
 * @param {number} [limit=100] - ring buffer size
 * @returns {Array} mutated history (chainable)
 */
function appendHistoryEntry(history, entry, limit = 100) {
  if (!Array.isArray(history)) {
    return [entry];
  }
  const last = history[history.length - 1];
  if (
    last &&
    last.feature === entry.feature &&
    last.phase === entry.phase &&
    last.action === entry.action
  ) {
    last.timestamp = entry.timestamp;
  } else {
    history.push(entry);
  }
  if (history.length > limit) {
    return history.slice(-limit);
  }
  return history;
}

/**
 * Update PDCA status for feature.
 *
 * v2.1.15 (Issue #89) 변경:
 *   - opts.requireDocs (default true): feature가 plan/design 문서를 가지지 않으면 silent no-op
 *     (`.pdca-status.json` 무한 오염 방지). 기존 16개 호출자 모두 default behavior 받음 —
 *     PDCA workflow가 plan 문서 작성 후 진입하므로 정당한 cycle은 모두 통과.
 *     의도적으로 우회 필요 시 opts.requireDocs=false 명시.
 *   - feature가 falsy/non-string이면 즉시 거부.
 *
 * @param {string} feature
 * @param {string} phase
 * @param {Object} [data]
 * @param {Object} [opts]
 * @param {boolean} [opts.requireDocs=true] - plan/design 문서 존재 게이트
 */
function updatePdcaStatus(feature, phase, data = {}, opts = {}) {
  const { debugLog } = getCore();
  const { getPhaseNumber } = getPhase();
  const { createInitialStatusV2 } = getMigration();

  // v2.1.15 (Issue #89): L3 게이트 — shouldUpdate 헬퍼로 위임 (testability)
  const requireDocs = opts.requireDocs !== false;
  if (!shouldUpdate(feature, requireDocs, opts.docCheckFn)) {
    debugLog('PDCA', 'updatePdcaStatus skipped by gate', {
      feature,
      phase,
      requireDocs,
    });
    return;
  }

  let status = getPdcaStatusFull(true) || createInitialStatusV2();

  // br288: terminal-state guard — an archived feature must never drift back to
  // an active phase. Stale skill-fire replay (e.g. unified-stop phase advance on
  // a resumed session) used to overwrite the archived phase silently. Only an
  // explicit archive write (phase 'archived', or the archive CLI itself) may
  // touch a terminal feature.
  const existing = status.features[feature];
  if (
    existing &&
    (existing.phase === 'archived' ||
      existing.archivedAt !== undefined ||
      existing.archivedTo !== undefined ||
      (existing.timestamps && existing.timestamps.archivedAt !== undefined)) &&
    phase !== 'archived'
  ) {
    debugLog('PDCA', 'updatePdcaStatus blocked: feature is terminal (archived)', {
      feature,
      requestedPhase: phase,
      storedPhase: existing.phase,
    });
    return;
  }

  if (!status.features[feature]) {
    status.features[feature] = {
      phase: phase,
      phaseNumber: getPhaseNumber(phase),
      matchRate: null,
      iterationCount: 0,
      requirements: [],
      documents: {},
      timestamps: { started: new Date().toISOString() },
    };
  }

  Object.assign(status.features[feature], {
    phase,
    phaseNumber: getPhaseNumber(phase),
    ...data,
    // br003: merge the caller's data.timestamps — previously any timestamps
    // passed via `data` (e.g. lifecycle.archiveFeature's archivedAt) was
    // silently dropped here because this trailing key overrode the ...data
    // spread. lastUpdated stays LAST so its freshness guarantee holds.
    timestamps: {
      ...status.features[feature].timestamps,
      ...(data.timestamps || {}),
      lastUpdated: new Date().toISOString(),
    },
  });

  // v2.0.5: Sync quality metrics from metrics-collector → pdca-status.metrics
  try {
    const mc = require('../quality/metrics-collector');
    const metricsData = mc.toPdcaStatusFormat(feature);
    if (metricsData) {
      status.features[feature].metrics = {
        ...(status.features[feature].metrics || {}),
        ...metricsData,
      };
    }
  } catch {
    /* metrics-collector may not be available */
  }

  if (!status.activeFeatures.includes(feature)) status.activeFeatures.push(feature);
  if (!status.primaryFeature) status.primaryFeature = feature;

  // v2.1.15 (Issue #89): L5 history dedup + ring buffer — appendHistoryEntry 헬퍼 위임
  if (!Array.isArray(status.history)) status.history = [];
  const newEntry = {
    timestamp: new Date().toISOString(),
    feature,
    phase,
    action: 'updated',
  };
  status.history = appendHistoryEntry(status.history, newEntry, 100);

  savePdcaStatus(status);
  debugLog('PDCA', `Updated ${feature} to ${phase}`, data);
}

/**
 * Add history entry
 * @param {Object} entry
 */
function addPdcaHistory(entry) {
  const status = getPdcaStatusFull(true);
  if (!status) return;
  if (!Array.isArray(status.history)) status.history = [];

  status.history.push({ timestamp: new Date().toISOString(), ...entry });
  if (status.history.length > 100) status.history = status.history.slice(-100);

  savePdcaStatus(status);
}

/**
 * Mark feature as completed
 * @param {string} feature
 */
function completePdcaFeature(feature) {
  updatePdcaStatus(feature, 'completed', {
    timestamps: { completed: new Date().toISOString() },
  });
}

/**
 * Set primary active feature
 * @param {string} feature
 */
function setActiveFeature(feature) {
  const { debugLog } = getCore();
  const status = getPdcaStatusFull(true);
  if (!status) return;

  status.primaryFeature = feature;
  if (!status.activeFeatures.includes(feature)) status.activeFeatures.push(feature);

  savePdcaStatus(status);
  debugLog('PDCA', 'Set active feature', { feature });
}

/**
 * Add feature to active list
 * @param {string} feature
 * @param {boolean} setAsPrimary
 */
function addActiveFeature(feature, setAsPrimary = false) {
  const status = getPdcaStatusFull(true);
  if (!status) return;
  if (!status.activeFeatures.includes(feature)) status.activeFeatures.push(feature);
  if (setAsPrimary) status.primaryFeature = feature;
  savePdcaStatus(status);
}

/**
 * Pick the feature that should become primaryFeature when the current one
 * leaves the active list (archived, deleted, summarized).
 *
 * br007: every promotion site used `activeFeatures[0]` — the OLDEST entry of
 * the list. On a long-lived registry (44 features in the wild) that silently
 * handed primaryFeature to a feature touched days ago, and every hook that
 * falls back to primaryFeature then bound the WRONG feature — the observed
 * "switchFeatureContext reverted by next turn" (it was not a revert; the
 * archive of the switched-to feature re-promoted the stale head).
 *
 * The right successor is the most recently ACTIVE one: features[].timestamps.
 * lastUpdated (set by every updatePdcaStatus), falling back to `started`.
 * A feature with no stamps at all loses to any stamped one; among unstamped
 * ones the LAST array position wins, because addActiveFeature appends — the
 * tail is the newest registration, the head the oldest.
 *
 * @param {Object} status - status object; activeFeatures must already exclude
 *   the departing feature
 * @returns {string|null} successor feature name, or null when none remain
 */
function pickPrimarySuccessor(status) {
  const active = Array.isArray(status?.activeFeatures)
    ? status.activeFeatures.filter(Boolean)
    : [];
  if (active.length === 0) return null;
  const features = status?.features || {};
  const stamp = (name) => {
    const t = features[name]?.timestamps || {};
    const v = Date.parse(t.lastUpdated || t.started || '');
    return Number.isNaN(v) ? -1 : v;
  };
  let best = active[active.length - 1];
  for (const name of active) {
    if (stamp(name) > stamp(best)) best = name;
  }
  return best;
}

/**
 * Remove feature from active list
 * @param {string} feature
 */
function removeActiveFeature(feature) {
  const status = getPdcaStatusFull(true);
  if (!status) return;
  status.activeFeatures = status.activeFeatures.filter((f) => f !== feature);
  if (status.primaryFeature === feature) {
    status.primaryFeature = pickPrimarySuccessor(status);
  }
  savePdcaStatus(status);
}

/**
 * Get active features list
 * @returns {string[]}
 */
function getActiveFeatures() {
  const status = getPdcaStatusFull();
  return status?.activeFeatures || [];
}

/**
 * Switch to a different feature context
 * @param {string} feature
 * @returns {boolean}
 */
function switchFeatureContext(feature) {
  const status = getPdcaStatusFull(true);
  if (!status) return false;
  if (!status.features[feature]) return false;

  status.primaryFeature = feature;
  if (!status.activeFeatures.includes(feature)) status.activeFeatures.push(feature);

  savePdcaStatus(status);
  return true;
}

/**
 * Extract feature from context sources
 *
 * v2.1.39 (Issue #156): `sources.agentOutput` is read. Six Stop handlers
 * (`plan-plus-stop`, `pdca-skill-stop`, `qa-stop`, `analysis-stop`,
 * `iterator-stop`, `qa-phase-stop`) pass it and nothing looked at it, so every
 * one of them fell through to `primaryFeature` — which is empty in a project
 * whose first feature is the one being recorded. The handler then exited without
 * writing, and `/pdca status` had nothing to show for a run that had just
 * finished. Where a previous feature existed it was worse: the phase attached to
 * THAT feature.
 *
 * The output of a phase names the document it produced, so the feature is
 * recoverable from the doc path in it. Read the LAST match rather than the first:
 * output that mentions an earlier feature before writing this one's document
 * would otherwise resolve to the earlier one.
 *
 * @param {Object} sources
 * @param {string} [sources.feature] - already known, and then nothing else is read
 * @param {string} [sources.filePath] - a path to recover the feature from
 * @param {string} [sources.agentOutput] - the phase's own output, scanned for a doc path
 * @param {Object} [sources.currentStatus] - the loaded status, to avoid re-reading it
 * @returns {string}
 */
function extractFeatureFromContext(sources = {}) {
  if (sources.feature) return sources.feature;

  if (typeof sources.agentOutput === 'string' && sources.agentOutput) {
    const recorded = (sources.currentStatus || getPdcaStatusFull())?.primaryFeature || '';
    const fromOutput = featureFromDocPaths(sources.agentOutput, recorded);
    if (fromOutput) return fromOutput;
  }

  if (sources.filePath) {
    // v2.1.15 (Issue #89): extractFeature로 위임 (DRY + L1 fix 공유)
    // — 기존 inline 패턴 매칭은 파일명 오추출 + generic 디렉토리 등록 버그가 있었음.
    const { extractFeature } = require('../core/file');
    const extracted = extractFeature(sources.filePath);
    if (extracted) return extracted;
  }

  const status = sources.currentStatus || getPdcaStatusFull();
  return status?.primaryFeature || '';
}

/**
 * The feature named by a document path in a block of text, or ''.
 *
 * Matching uses the project's own doc-path templates (`pdca.docPaths.*`), so a
 * project that moved its docs is read correctly.
 *
 * Two guards, because this function decides which feature a phase is recorded
 * against and a wrong answer is worse than none:
 *
 *   - **the file has to exist.** A template like `docs/plan/{feature}.md`
 *     otherwise matches `docs/plan/README.md` and registers `README` as a
 *     feature, and a path the output merely PROPOSED would count as one produced.
 *   - **an ambiguous text defers to the recorded feature.** Output that names two
 *     features' documents (a design that cites the plan of another) gives no
 *     reason to prefer either, so `primaryFeature` wins where it is one of them.
 *     That keeps this from MOVING a phase off the feature a run was already on —
 *     the fix is for the case where there was nothing to move.
 *
 * @param {string} text
 * @param {string} [primaryFeature] - the recorded feature, used only to break a tie
 * @returns {string}
 */
function featureFromDocPaths(text, primaryFeature = '') {
  const found = [];
  try {
    const { getDocPaths } = require('../core/paths');
    const { PROJECT_DIR } = require('../core/platform');
    const docPaths = getDocPaths();

    for (const templates of Object.values(docPaths)) {
      if (!Array.isArray(templates)) continue;
      for (const template of templates) {
        if (typeof template !== 'string' || !template.includes('{feature}')) continue;
        // `{feature}` is a single path segment, so it must not swallow a `/`.
        const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{feature\\\}/g, '([^/\\\\\\s]+)');
        const re = new RegExp(escaped, 'g');
        let hit;
        while ((hit = re.exec(text)) !== null) {
          const rel = template.replace('{feature}', hit[1]);
          if (!fs.existsSync(path.join(PROJECT_DIR, rel))) continue;
          found.push(hit[1]);
        }
      }
    }
  } catch {
    return '';
  }

  const unique = [...new Set(found)];
  if (unique.length === 0) return '';
  if (unique.length === 1) return unique[0];
  if (primaryFeature && unique.includes(primaryFeature)) return primaryFeature;
  return found[found.length - 1];
}

/**
 * Read bkit memory state from .bkit/state/memory.json
 * @returns {Object|null}
 */
function readBkitMemory() {
  const { safeJsonParse } = getCore();
  const { STATE_PATHS } = require('../core/paths');
  const memoryPath = STATE_PATHS.memory();
  try {
    if (fs.existsSync(memoryPath)) {
      const content = fs.readFileSync(memoryPath, 'utf8');
      return safeJsonParse(content);
    }
  } catch {
    /* silent */
  }
  return null;
}

/**
 * Write bkit memory state
 * @param {Object} memory
 * @returns {boolean}
 */
function writeBkitMemory(memory) {
  const { STATE_PATHS } = require('../core/paths');
  const { stateStore } = getCore();
  const memoryPath = STATE_PATHS.memory();
  try {
    // H1 fix (audit): atomic tmp+rename (trailing '\n' dropped — not load-bearing;
    // JSON parsers ignore trailing whitespace). Same JSON object payload, atomic.
    stateStore.write(memoryPath, memory);
    try {
      const { backupToPluginData } = require('../core/paths');
      backupToPluginData();
    } catch {
      /* non-critical */
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getPdcaStatusPath,
  initPdcaStatusIfNotExists,
  getPdcaStatusFull,
  loadPdcaStatus,
  savePdcaStatus,
  getFeatureStatus,
  updatePdcaStatus,
  addPdcaHistory,
  completePdcaFeature,
  setActiveFeature,
  addActiveFeature,
  removeActiveFeature,
  getActiveFeatures,
  switchFeatureContext,
  extractFeatureFromContext,
  featureFromDocPaths,
  readBkitMemory,
  writeBkitMemory,
  // v2.1.15 (Issue #89): Layer 3 + Layer 5 helpers (testability + 외부 도구 참조용)
  shouldUpdate,
  appendHistoryEntry,
  // br007: primaryFeature successor selection (testability + cleanup reuse)
  pickPrimarySuccessor,
};
