/**
 * Path Registry - Centralized state file path management
 * @module lib/core/paths
 * @version 2.1.10
 */
const path = require('path');
const fs = require('fs');
// v2.1.8 fix B12a: BKIT_VERSION dynamic lookup (ENH-167)
const { BKIT_VERSION } = require('./version');

// Lazy require to avoid circular dependency
let _platform = null;
function getPlatform() {
  if (!_platform) { _platform = require('./platform'); }
  return _platform;
}

// Helper accessors for directory paths
function getBkitRoot() { return path.join(getPlatform().PROJECT_DIR, '.bkit'); }
function getStateDir() { return path.join(getBkitRoot(), 'state'); }
function getRuntimeDir() { return path.join(getBkitRoot(), 'runtime'); }

const STATE_PATHS = {
  root:       () => getBkitRoot(),
  state:      () => getStateDir(),
  runtime:    () => getRuntimeDir(),
  snapshots:  () => path.join(getBkitRoot(), 'snapshots'),
  pdcaStatus: () => path.join(getStateDir(), 'pdca-status.json'),
  memory:     () => path.join(getStateDir(), 'memory.json'),
  agentState: () => path.join(getRuntimeDir(), 'agent-state.json'),
  // v1.6.2: ${CLAUDE_PLUGIN_DATA} persistent backup (ENH-119)
  pluginData: () => process.env.CLAUDE_PLUGIN_DATA || null,
  /*
   * ENH-402 (v2.1.33): namespace the backup by project.
   *
   * This returned `${CLAUDE_PLUGIN_DATA}/backup` with no project segment, while
   * CLAUDE_PLUGIN_DATA is namespaced per plugin INSTALL, not per project. Every
   * project sharing a marketplace slot therefore wrote its pdca-status into the
   * same file, and the last writer won. `backupToPluginData()` runs on every
   * `savePdcaStatus()`, so this happened continuously and silently.
   *
   * This is not theoretical. Observed on this machine during cycle #33:
   *   ~/.claude/plugins/data/bkit-bkit-marketplace/backup/meta.json
   *     -> projectDir: .../tene-studio   (6924 bytes)
   *   the bkit-inline slot held bkit-claude-code (29235 bytes)
   * Two unrelated projects, one slot. Whichever project had been overwritten
   * lost its backup permanently — `restoreFromPluginData()` guards only against
   * restoring the WRONG project's data, which cannot undo an overwrite that
   * already happened.
   *
   * The segment is a hash of the absolute project path rather than its name, so
   * two checkouts of the same repository in different directories do not
   * collide. A short prefix of the basename is kept for human legibility when
   * inspecting the directory by hand.
   */
  pluginDataBackup: () => {
    const pd = process.env.CLAUDE_PLUGIN_DATA;
    if (!pd) return null;
    const projectDir = getPlatform().PROJECT_DIR;
    const crypto = require('crypto');
    const digest = crypto.createHash('sha256').update(projectDir, 'utf8').digest('hex').slice(0, 12);
    const label = path.basename(projectDir).replace(/[^\w.-]/g, '_').slice(0, 32) || 'project';
    return path.join(pd, 'backup', `${label}-${digest}`);
  },
  /** Legacy un-namespaced location, kept for read-only migration (ENH-402). */
  pluginDataBackupLegacy: () => {
    const pd = process.env.CLAUDE_PLUGIN_DATA;
    return pd ? path.join(pd, 'backup') : null;
  },

  // v2.0.0 Quality
  qualityMetrics:  () => path.join(getStateDir(), 'quality-metrics.json'),
  qualityHistory:  () => path.join(getStateDir(), 'quality-history.json'),
  regressionRules: () => path.join(getStateDir(), 'regression-rules.json'),
  trustProfile:    () => path.join(getStateDir(), 'trust-profile.json'),

  // v2.0.0 Resume & Workflow State
  resumeDir:        () => path.join(getStateDir(), 'resume'),
  workflowStateDir: () => path.join(getStateDir(), 'workflows'),

  // v2.0.0 Runtime
  agentEvents:  () => path.join(getRuntimeDir(), 'agent-events.jsonl'),
  controlState: () => path.join(getRuntimeDir(), 'control-state.json'),

  // v2.0.0 Audit & Decisions
  auditDir:     () => path.join(getBkitRoot(), 'audit'),
  decisionsDir: () => path.join(getBkitRoot(), 'decisions'),

  // v2.0.0 Checkpoints
  checkpointsDir:   () => path.join(getBkitRoot(), 'checkpoints'),
  checkpointIndex:  () => path.join(getBkitRoot(), 'checkpoints', 'index.json'),

  // v3.0.0 Living Context
  contextDir:      () => path.join(getBkitRoot(), 'context'),
  invariants:      () => path.join(getBkitRoot(), 'invariants.yaml'),
  impactMap:       () => path.join(getBkitRoot(), 'impact-map.json'),
  incidentMemory:  () => path.join(getBkitRoot(), 'incident-memory.yaml'),
  scenariosDir:    () => path.join(getPlatform().PROJECT_DIR, 'docs', '02-design', 'scenarios'),

  // v2.0.0 Workflows
  workflowsDir: () => path.join(getBkitRoot(), 'workflows'),

  // v2.0.0 PLUGIN_DATA extended
  pluginDataLearnings:  () => { const pd = process.env.CLAUDE_PLUGIN_DATA; return pd ? path.join(pd, 'learnings') : null; },
  pluginDataProfiles:   () => { const pd = process.env.CLAUDE_PLUGIN_DATA; return pd ? path.join(pd, 'profiles') : null; },
  pluginDataRegression: () => { const pd = process.env.CLAUDE_PLUGIN_DATA; return pd ? path.join(pd, 'regression') : null; },
  pluginDataAudit:      () => { const pd = process.env.CLAUDE_PLUGIN_DATA; return pd ? path.join(pd, 'audit') : null; },
  pluginDataMeta:       () => { const pd = process.env.CLAUDE_PLUGIN_DATA; return pd ? path.join(pd, 'meta.json') : null; },
};

/** @deprecated v1.6.0에서 제거 예정 */
const LEGACY_PATHS = {
  pdcaStatus: () => path.join(getPlatform().PROJECT_DIR, 'docs', '.pdca-status.json'),
  memory:     () => path.join(getPlatform().PROJECT_DIR, 'docs', '.bkit-memory.json'),
  snapshots:  () => path.join(getPlatform().PROJECT_DIR, 'docs', '.pdca-snapshots'),
  agentState: () => path.join(getPlatform().PROJECT_DIR, '.bkit', 'agent-state.json'),
};

const CONFIG_PATHS = {
  bkitConfig: () => path.join(getPlatform().PROJECT_DIR, 'bkit.config.json'),
  pluginJson: () => path.join(getPlatform().PLUGIN_ROOT, '.claude-plugin', 'plugin.json'),
  hooksJson:  () => path.join(getPlatform().PLUGIN_ROOT, 'hooks', 'hooks.json'),
};

function ensureBkitDirs() {
  const dirs = [
    STATE_PATHS.root(), STATE_PATHS.state(), STATE_PATHS.runtime(),
    // v2.0.0: new directories
    STATE_PATHS.resumeDir(), STATE_PATHS.workflowStateDir(),
    STATE_PATHS.auditDir(), STATE_PATHS.decisionsDir(),
    STATE_PATHS.checkpointsDir(), STATE_PATHS.workflowsDir(),
  ];
  // snapshots는 제외 -- context-compaction.js에서 최초 사용 시 생성
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// Lazy require config to avoid circular dependency
let _config = null;
function getConfigModule() {
  if (!_config) { _config = require('./config'); }
  return _config;
}

/**
 * Default PDCA doc path templates (fallback when config has no docPaths).
 *
 * Bilingual variants (br009/br011): projects following the bilingual docs
 * convention write `{feature}.<phase>.en.md` + `.ko.md` pairs, not the legacy
 * single-file name. Legacy entries stay first (canonical); the `.en.md`/`.ko.md`
 * mirrors follow, using the same suffix placement as bkit.config.json's
 * docPaths (fd852b4), so findDoc resolves bilingual docs even when no config
 * supplies docPaths — without this, the report→completed Stop clause fails
 * closed and the cycle strands at phase=report.
 */
const DEFAULT_DOC_PATHS = {
  pm: [
    'docs/00-pm/features/{feature}.prd.md',
    'docs/00-pm/{feature}.prd.md',
    'docs/00-pm/features/{feature}.prd.en.md',
    'docs/00-pm/features/{feature}.prd.ko.md',
    'docs/00-pm/{feature}.prd.en.md',
    'docs/00-pm/{feature}.prd.ko.md',
  ],
  plan: [
    'docs/01-plan/features/{feature}.plan.md',
    'docs/01-plan/{feature}.plan.md',
    'docs/plan/{feature}.md',
    'docs/01-plan/features/{feature}.plan.en.md',
    'docs/01-plan/features/{feature}.plan.ko.md',
    'docs/01-plan/{feature}.plan.en.md',
    'docs/01-plan/{feature}.plan.ko.md',
    'docs/plan/{feature}.en.md',
    'docs/plan/{feature}.ko.md',
  ],
  design: [
    'docs/02-design/features/{feature}.design.md',
    'docs/02-design/{feature}.design.md',
    'docs/design/{feature}.md',
    'docs/02-design/features/{feature}.design.en.md',
    'docs/02-design/features/{feature}.design.ko.md',
    'docs/02-design/{feature}.design.en.md',
    'docs/02-design/{feature}.design.ko.md',
    'docs/design/{feature}.en.md',
    'docs/design/{feature}.ko.md',
  ],
  analysis: [
    'docs/03-analysis/{feature}.analysis.md',
    'docs/03-analysis/features/{feature}.analysis.md',
    'docs/03-analysis/{feature}.gap-analysis.md',
    'docs/03-analysis/{feature}.analysis.en.md',
    'docs/03-analysis/{feature}.analysis.ko.md',
    'docs/03-analysis/features/{feature}.analysis.en.md',
    'docs/03-analysis/features/{feature}.analysis.ko.md',
    'docs/03-analysis/{feature}.en.gap-analysis.md',
    'docs/03-analysis/{feature}.ko.gap-analysis.md',
  ],
  qa: [
    'docs/05-qa/{feature}.qa-report.md',
    'docs/05-qa/{feature}.test-plan.md',
    'docs/05-qa/features/{feature}.qa-report.en.md',
    'docs/05-qa/features/{feature}.qa-report.ko.md',
    'docs/05-qa/{feature}.qa-report.en.md',
    'docs/05-qa/{feature}.qa-report.ko.md',
    'docs/05-qa/features/{feature}.test-plan.en.md',
    'docs/05-qa/features/{feature}.test-plan.ko.md',
    'docs/05-qa/{feature}.test-plan.en.md',
    'docs/05-qa/{feature}.test-plan.ko.md',
  ],
  report: [
    'docs/04-report/features/{feature}.report.md',
    'docs/04-report/{feature}.report.md',
    'docs/04-report/{feature}.completion-report.md',
    'docs/04-report/features/{feature}.report.en.md',
    'docs/04-report/features/{feature}.report.ko.md',
    'docs/04-report/{feature}.report.en.md',
    'docs/04-report/{feature}.report.ko.md',
    'docs/04-report/{feature}.en.completion-report.md',
    'docs/04-report/{feature}.ko.completion-report.md',
  ],
  archive: 'docs/archive/{date}/{feature}',
};

/**
 * Get PDCA doc path templates from config (with hardcoded fallbacks)
 * @returns {Object} docPaths keyed by phase (plan/design/analysis/report/archive)
 */
function getDocPaths() {
  const { getConfig } = getConfigModule();
  return {
    pm: getConfig('pdca.docPaths.pm', DEFAULT_DOC_PATHS.pm),
    plan: getConfig('pdca.docPaths.plan', DEFAULT_DOC_PATHS.plan),
    design: getConfig('pdca.docPaths.design', DEFAULT_DOC_PATHS.design),
    analysis: getConfig('pdca.docPaths.analysis', DEFAULT_DOC_PATHS.analysis),
    qa: getConfig('pdca.docPaths.qa', DEFAULT_DOC_PATHS.qa),
    report: getConfig('pdca.docPaths.report', DEFAULT_DOC_PATHS.report),
    archive: getConfig('pdca.docPaths.archive', DEFAULT_DOC_PATHS.archive),
  };
}

/**
 * Resolve doc path templates to absolute paths for a given phase/feature
 * @param {string} phase - PDCA phase (plan/design/analysis/report)
 * @param {string} feature - Feature name
 * @returns {string[]} Array of absolute paths
 */
function resolveDocPaths(phase, feature) {
  if (!feature) return [];
  const docPaths = getDocPaths();
  const templates = docPaths[phase];
  if (!templates || typeof templates === 'string') return [];
  const projectDir = getPlatform().PROJECT_DIR;
  return templates.map(t =>
    path.join(projectDir, t.replace(/\{feature\}/g, feature))
  );
}

/**
 * Find first existing doc for a given phase/feature
 * @param {string} phase - PDCA phase (plan/design/analysis/report)
 * @param {string} feature - Feature name
 * @returns {string} Absolute path to found doc, or empty string
 */
function findDoc(phase, feature) {
  const candidates = resolveDocPaths(phase, feature);
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch (e) {
      continue;
    }
  }
  return '';
}

/**
 * Find ALL existing docs for a given phase/feature — br293.
 *
 * `findDoc` above returns the first existing candidate, which is the right
 * contract for single-path consumers (e.g. the report-completion clause's
 * existence check) but wrong as the archive CLI's collector: the candidate
 * lists enumerate the plain name AND the bilingual .en.md/.ko.md variants
 * (the project mandates en+ko sibling pairs for new docs/), so a
 * single-path archive strands every sibling in the source directory. This
 * helper returns every readable candidate, deduped by resolved path.
 * @param {string} phase - PDCA phase (pm/plan/design/analysis/qa/report)
 * @param {string} feature - Feature name
 * @returns {string[]} existing candidate paths (may be empty)
 */
function findAllDocs(phase, feature) {
  if (!feature) return [];
  const seen = new Set();
  const found = [];
  for (const p of resolveDocPaths(phase, feature)) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
    } catch (e) {
      continue;
    }
    if (!seen.has(p)) {
      seen.add(p);
      found.push(p);
    }
  }
  return found;
}

/**
 * Compute archive directory path for a feature
 * @param {string} feature - Feature name
 * @param {Date} [date] - Date to use (defaults to now)
 * @returns {string} Absolute path to archive directory
 */
function getArchivePath(feature, date) {
  const d = date || new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const docPaths = getDocPaths();
  const template = docPaths.archive || DEFAULT_DOC_PATHS.archive;
  const relPath = template
    .replace(/\{date\}/g, dateStr)
    .replace(/\{feature\}/g, feature);
  return path.join(getPlatform().PROJECT_DIR, relPath);
}

/**
 * Backup critical state files to ${CLAUDE_PLUGIN_DATA}
 * Called after every savePdcaStatus() and saveMemory()
 * @returns {{ backed: string[], skipped: string[] }}
 */
function backupToPluginData() {
  const backupDir = STATE_PATHS.pluginDataBackup();
  if (!backupDir) return { backed: [], skipped: ['no CLAUDE_PLUGIN_DATA'] };

  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
  } catch (e) {
    return { backed: [], skipped: [e.message] };
  }

  const targets = [
    { src: STATE_PATHS.pdcaStatus, name: 'pdca-status.backup.json' },
    { src: STATE_PATHS.memory, name: 'memory.backup.json' },
  ];

  const backed = [];
  const skipped = [];

  for (const t of targets) {
    try {
      const srcPath = t.src();
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, path.join(backupDir, t.name));
        backed.push(t.name);
      }
    } catch (e) {
      skipped.push(`${t.name}: ${e.message}`);
    }
  }

  // Track backup timestamps
  try {
    const historyPath = path.join(backupDir, 'version-history.json');
    let history = [];
    if (fs.existsSync(historyPath)) {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    }
    history.push({ timestamp: new Date().toISOString(), bkitVersion: BKIT_VERSION, backed });
    if (history.length > 50) history = history.slice(-50);
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  } catch (e) { /* version-history is non-critical */ }

  // v2.0.1: Write project identity for cross-project restore guard (#48)
  try {
    const metaPath = path.join(backupDir, 'meta.json');
    const meta = {
      projectDir: getPlatform().PROJECT_DIR,
      timestamp: new Date().toISOString(),
      bkitVersion: BKIT_VERSION,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch (_) { /* meta.json is non-critical */ }

  return { backed, skipped };
}

/**
 * Restore state files from ${CLAUDE_PLUGIN_DATA} backup
 * Called during SessionStart when primary state files are missing
 * @returns {{ restored: string[], skipped: string[] }}
 */
function restoreFromPluginData() {
  let backupDir = STATE_PATHS.pluginDataBackup();
  if (!backupDir) {
    return { restored: [], skipped: ['no backup directory'] };
  }
  /*
   * ENH-402/403 (v2.1.33): fall back to the pre-namespacing location once.
   *
   * Backups written before v2.1.33 live in the shared `${CLAUDE_PLUGIN_DATA}/backup`
   * directory. Reading them is safe only when their meta.json names THIS project
   * — if a different project won the last write, the data belongs to that
   * project and must be left alone. The identity check below enforces that, so
   * pointing at the legacy directory here cannot restore someone else's state;
   * it can only recover our own.
   */
  if (!fs.existsSync(backupDir)) {
    const legacyDir = STATE_PATHS.pluginDataBackupLegacy();
    if (legacyDir && fs.existsSync(path.join(legacyDir, 'meta.json'))) {
      backupDir = legacyDir;
    } else {
      return { restored: [], skipped: ['no backup directory'] };
    }
  }

  // v2.0.1: Project identity guard — prevent cross-project restore (#48)
  const metaPath = path.join(backupDir, 'meta.json');
  try {
    if (!fs.existsSync(metaPath)) {
      return { restored: [], skipped: ['no meta.json — legacy backup, skipping for safety'] };
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!meta.projectDir) {
      return { restored: [], skipped: ['meta.json missing projectDir'] };
    }
    const currentDir = getPlatform().PROJECT_DIR;

    // Normalize paths to handle symlinks
    let metaResolved = meta.projectDir;
    let currentResolved = currentDir;
    try {
      metaResolved = fs.realpathSync(meta.projectDir);
      currentResolved = fs.realpathSync(currentDir);
    } catch (_) { /* realpathSync fails if path doesn't exist */ }

    if (metaResolved !== currentResolved) {
      /*
       * ENH-403 (v2.1.33): say which situation this is.
       *
       * The old message — "backup belongs to different project: X" — described
       * the guard from the guard's point of view and misled anyone reading it.
       * Before v2.1.33 all projects shared one backup directory, so seeing this
       * meant something worse than "we declined to restore": it meant another
       * project had already OVERWRITTEN this project's backup, and ours was
       * gone. The guard blocks a bad restore; it cannot undo a bad write.
       *
       * Reaching this from the namespaced directory would require a hash
       * collision or a moved project, so it is now genuinely rare — but when it
       * does happen from the legacy path, the reader needs to know their backup
       * is lost, not merely skipped.
       */
      const fromLegacy = backupDir === STATE_PATHS.pluginDataBackupLegacy();
      return {
        restored: [],
        skipped: [
          fromLegacy
            ? `legacy shared backup now holds another project's state (${meta.projectDir}); this project's pre-v2.1.33 backup was overwritten and cannot be recovered. New backups are written per project.`
            : `backup belongs to different project: ${meta.projectDir}`,
        ],
      };
    }
  } catch (e) {
    return { restored: [], skipped: [`meta.json parse error: ${e.message}`] };
  }

  const targets = [
    { backup: 'pdca-status.backup.json', dest: STATE_PATHS.pdcaStatus, name: 'pdca-status' },
    { backup: 'memory.backup.json', dest: STATE_PATHS.memory, name: 'memory' },
  ];

  const restored = [];
  const skipped = [];

  for (const t of targets) {
    const destPath = t.dest();
    const backupPath = path.join(backupDir, t.backup);

    if (!fs.existsSync(destPath) && fs.existsSync(backupPath)) {
      try {
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        fs.copyFileSync(backupPath, destPath);
        restored.push(t.name);
      } catch (e) {
        skipped.push(`${t.name}: ${e.message}`);
      }
    }
  }

  return { restored, skipped };
}

module.exports = {
  STATE_PATHS, LEGACY_PATHS, CONFIG_PATHS, ensureBkitDirs,
  getDocPaths, resolveDocPaths, findDoc, findAllDocs, getArchivePath,
  // v1.6.2: ${CLAUDE_PLUGIN_DATA} backup/restore (ENH-119)
  backupToPluginData, restoreFromPluginData,
};
