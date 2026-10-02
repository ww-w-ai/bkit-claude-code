#!/usr/bin/env node
'use strict';

/**
 * bkit-pdca-server: PDCA status, documents, and metrics MCP server.
 *
 * Lightweight JSON-RPC 2.0 over stdio — no external dependencies.
 * Reads .bkit/ state files and docs/ markdown files.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
// v2.1.8 fix B12b: BKIT_VERSION dynamic lookup (ENH-167)
const { BKIT_VERSION } = require('../../lib/core/version');
// C4 fix (audit): validate `feature` before it is substituted into path templates.
// A feature like "../../../../etc/passwd" previously read arbitrary files because
// docsPath() does path.join(ROOT, template.replace('{feature}', feature)) with no
// traversal filtering. validateName rejects anything outside [A-Za-z0-9_-].
const { validateName } = require('../../lib/core/name-validator');

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const ROOT = process.env.BKIT_ROOT || process.cwd();
const BKIT_DIR = path.join(ROOT, '.bkit');
const CONFIG_PATH = path.join(ROOT, 'bkit.config.json');

// v2.1.3 (#67): Fallback doc path templates used only when bkit.config.json is
// missing or has no `pdca.docPaths.{phase}` entry. Mirrors the defaults from
// lib/core/paths.js so single-source-of-truth is still possible later.
// M2/M3/M4 fix (audit): analysis is canonicalized to the features/ subfolder
// first (matching plan/design/report and bkit.config.json), and qa + pm/prd
// fallbacks are added so config-less resolution can discover those phases too.
const FALLBACK_DOC_PATHS = {
  plan:     ['docs/01-plan/features/{feature}.plan.md'],
  design:   ['docs/02-design/features/{feature}.design.md'],
  analysis: [
    'docs/03-analysis/features/{feature}.analysis.md',
    'docs/03-analysis/{feature}.analysis.md',
  ],
  report:   ['docs/04-report/features/{feature}.report.md'],
  qa:       ['docs/05-qa/features/{feature}.qa-report.md', 'docs/05-qa/{feature}.qa-report.md'],
  pm:       ['docs/00-pm/features/{feature}.prd.md', 'docs/00-pm/{feature}.prd.md'],
};

let _cachedConfig = null;
let _cachedConfigMtime = 0;

function loadBkitConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const stat = fs.statSync(CONFIG_PATH);
    if (_cachedConfig && stat.mtimeMs === _cachedConfigMtime) return _cachedConfig;
    _cachedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    _cachedConfigMtime = stat.mtimeMs;
    return _cachedConfig;
  } catch {
    return null;
  }
}

function getPhaseTemplates(phase) {
  const cfg = loadBkitConfig();
  const configured = cfg && cfg.pdca && cfg.pdca.docPaths && cfg.pdca.docPaths[phase];
  if (Array.isArray(configured) && configured.length > 0) return configured;
  if (typeof configured === 'string' && configured) return [configured];
  return FALLBACK_DOC_PATHS[phase] || null;
}

function statePath(filename) {
  return path.join(BKIT_DIR, 'state', filename);
}

function auditPath(filename) {
  return path.join(BKIT_DIR, 'audit', filename);
}

// v2.1.3 (#67): Honor bkit.config.json `pdca.docPaths.{phase}` templates. Returns
// the first existing resolved path, or the first candidate when none exist so
// callers can surface an informative NOT_FOUND error.
function docsPath(phase, feature) {
  const templates = getPhaseTemplates(phase);
  if (!templates) return null;
  // C4 fix: reject traversal before substitution. feature is user-derived and is
  // spliced into a path template, so a "../" or "/" sequence escapes ROOT.
  // validateName fails closed (throws) for anything outside [A-Za-z0-9_-].
  validateName(feature, 'feature');
  const resolved = templates.map(t =>
    path.join(ROOT, t.replace(/\{feature\}/g, feature))
  );
  for (const p of resolved) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch { /* continue */ }
  }
  return resolved[0];
}

function readJsonOrNull(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTextOrNull(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function okResponse(data) {
  // Dual _meta keys: v2.1.88 `_meta` persist-bypass fix strips unexpected
  // keys, so we set both the pre-v2.1.81 legacy key and the v2.1.81+
  // namespaced key (ENH-176, ENH-193).
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    _meta: {
      maxResultSizeChars: 500000,
      'claudecode/maxResultSizeChars': 500000,
    },
  };
}

function errResponse(code, message, details) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message, details: details || null } }, null, 2) }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'bkit_pdca_status',
    // registry-lockdown: this tool is the SANCTIONED read surface for PDCA
    // phase state — agents read state here rather than opening the registry
    // file (writes are broker-only: skill fires + the archive CLI).
    // Field report 2026-09-08: an agent given a `/pdca plan` prompt called
    // THIS tool instead of firing the skill, then waited on a registry that
    // could never move — MCP is read-only by design. The description now
    // teaches the write path so a confused agent self-routes to the fire.
    description: 'Read current PDCA status (the sanctioned read surface — prefer this over opening the registry file). READ-ONLY: this tool cannot advance phases or write state; to advance a phase or archive, invoke the bkit:pdca skill (/pdca <phase> <feature>). Optionally filter by feature name for detail.',
    inputSchema: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'Feature name to query. Omit for full summary.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bkit_pdca_history',
    description: 'Read PDCA history events with optional limit and since filters.',
    inputSchema: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'Filter by feature name.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Max items to return.' },
        since: { type: 'string', description: 'ISO datetime — return events after this time.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bkit_feature_list',
    description: 'List active, completed, or archived features.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'completed', 'archived', 'all'], default: 'all' },
        phase: { type: 'string', enum: ['pm', 'plan', 'design', 'do', 'check', 'act', 'report', 'completed', 'archived'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bkit_feature_detail',
    description: 'Get detailed info for a single feature (phase, metrics, timestamps, documents).',
    inputSchema: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'Feature name.', pattern: '^[A-Za-z0-9_-]+$' },
      },
      required: ['feature'],
      additionalProperties: false,
    },
  },
  {
    name: 'bkit_plan_read',
    description: 'Read the Plan document (docs/01-plan/features/{feature}.plan.md).',
    inputSchema: {
      type: 'object',
      properties: { feature: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' } },
      required: ['feature'],
      additionalProperties: false,
    },
  },
  {
    name: 'bkit_design_read',
    description: 'Read the Design document (docs/02-design/features/{feature}.design.md).',
    inputSchema: {
      type: 'object',
      properties: { feature: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' } },
      required: ['feature'],
      additionalProperties: false,
    },
  },
  {
    name: 'bkit_analysis_read',
    description: 'Read the Analysis document (docs/03-analysis/{feature}.analysis.md).',
    inputSchema: {
      type: 'object',
      properties: { feature: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' } },
      required: ['feature'],
      additionalProperties: false,
    },
  },
  {
    name: 'bkit_report_read',
    description: 'Read the Report document (docs/04-report/features/{feature}.report.md).',
    inputSchema: {
      type: 'object',
      properties: { feature: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' } },
      required: ['feature'],
      additionalProperties: false,
    },
  },
  {
    name: 'bkit_metrics_get',
    description: 'Get latest quality metrics (M1-M10). Optionally filter by feature.',
    inputSchema: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'Filter metrics for a specific feature.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bkit_metrics_history',
    description: 'Get quality metrics history as a time series.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          enum: ['matchRate', 'codeQualityScore', 'criticalIssueCount', 'apiComplianceRate',
                 'runtimeErrorRate', 'p95ResponseTime', 'conventionCompliance',
                 'designCompleteness', 'iterationEfficiency', 'pdcaCycleTimeHours'],
          description: 'Filter to a single metric. Omit for all.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
      },
      additionalProperties: false,
    },
  },
  // v2.1.13 Sprint Management (관점 1-1 DEEP-6): expose Sprint state to MCP
  // clients so the LLM can read sprint lifecycle without shell or file access.
  {
    name: 'bkit_sprint_status',
    description: 'Read current Sprint status. Optionally filter by sprint id for detail.',
    inputSchema: {
      type: 'object',
      properties: {
        sprintId: { type: 'string', description: 'Sprint id (kebab-case). Omit for full summary.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bkit_sprint_list',
    description: 'List sprints with optional status filter (active|paused|archived).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'paused', 'archived', 'all'], default: 'all' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bkit_master_plan_read',
    description: 'Read sprint master plan JSON state (schemaVersion, features, sprints, dependencyGraph).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Sprint master plan project id (kebab-case).' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Resource definitions
// ---------------------------------------------------------------------------

const RESOURCES = [
  {
    uri: 'bkit://pdca/status',
    name: 'PDCA Current Status',
    description: 'Current PDCA status from pdca-status.json.',
    mimeType: 'application/json',
  },
  {
    uri: 'bkit://quality/metrics',
    name: 'Latest Quality Metrics',
    description: 'Latest quality metrics (M1-M10).',
    mimeType: 'application/json',
  },
  {
    uri: 'bkit://audit/latest',
    name: 'Latest Audit Log',
    description: 'Today\'s audit log entries (last 20).',
    mimeType: 'application/json',
  },
  // v2.1.13 Sprint Management (관점 1-1 DEEP-6)
  {
    uri: 'bkit://sprint/status',
    name: 'Sprint Current Status',
    description: 'Current Sprint status from sprint-status.json.',
    mimeType: 'application/json',
  },
  {
    uri: 'bkit://sprint/master-plans',
    name: 'Sprint Master Plans Index',
    description: 'Directory listing of .bkit/state/master-plans/ (sprint master plan JSON files).',
    mimeType: 'application/json',
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

const ACTIVE_PHASES = new Set(['pm', 'plan', 'design', 'do', 'check', 'act', 'report']);

function handleBkitPdcaStatus(args) {
  const { feature } = args || {};
  const status = readJsonOrNull(statePath('pdca-status.json'));
  if (!status) return okResponse({ version: null, lastUpdated: null, primaryFeature: null, activeFeatures: [], summary: { total: 0, byPhase: {} } });

  if (feature) {
    const f = (status.features || {})[feature];
    if (!f) return errResponse('NOT_FOUND', `Feature not found: ${feature}`);
    return okResponse({
      version: status.version,
      lastUpdated: status.lastUpdated,
      primaryFeature: status.primaryFeature,
      activeFeatures: status.activeFeatures || [],
      feature: { name: feature, ...f },
    });
  }

  const features = status.features || {};
  const byPhase = {};
  for (const f of Object.values(features)) {
    byPhase[f.phase] = (byPhase[f.phase] || 0) + 1;
  }
  return okResponse({
    version: status.version,
    lastUpdated: status.lastUpdated,
    primaryFeature: status.primaryFeature,
    activeFeatures: status.activeFeatures || [],
    summary: { total: Object.keys(features).length, byPhase },
  });
}

function handleBkitPdcaHistory(args) {
  const { feature, limit = 50, since } = args || {};
  const status = readJsonOrNull(statePath('pdca-status.json'));
  if (!status) return okResponse({ total: 0, filtered: 0, items: [] });

  let history = status.history || [];
  if (feature) history = history.filter(h => h.feature === feature);
  if (since) {
    const sinceMs = new Date(since).getTime();
    history = history.filter(h => new Date(h.timestamp).getTime() >= sinceMs);
  }
  const total = (status.history || []).length;
  const filtered = history.length;
  return okResponse({ total, filtered, items: history.slice(-limit) });
}

function handleBkitFeatureList(args) {
  const { status = 'all', phase } = args || {};
  const data = readJsonOrNull(statePath('pdca-status.json'));
  if (!data) return okResponse({ total: 0, features: [] });

  const features = data.features || {};
  let list = Object.entries(features).map(([name, f]) => ({
    name,
    phase: f.phase,
    matchRate: f.matchRate != null ? f.matchRate : null,
    iterationCount: f.iterationCount || 0,
    startedAt: (f.timestamps && f.timestamps.started) || null,
    lastUpdatedAt: (f.timestamps && f.timestamps.lastUpdated) || null,
  }));

  if (status === 'active') list = list.filter(f => ACTIVE_PHASES.has(f.phase));
  else if (status === 'completed') list = list.filter(f => f.phase === 'completed');
  else if (status === 'archived') list = list.filter(f => f.phase === 'archived');

  if (phase) list = list.filter(f => f.phase === phase);
  return okResponse({ total: list.length, features: list });
}

function handleBkitFeatureDetail(args) {
  const { feature } = args || {};
  if (!feature) return errResponse('INVALID_ARGS', 'feature is required');

  const data = readJsonOrNull(statePath('pdca-status.json'));
  if (!data) return errResponse('NOT_FOUND', 'pdca-status.json not found');

  const f = (data.features || {})[feature];
  if (!f) return errResponse('NOT_FOUND', `Feature not found: ${feature}`);

  return okResponse({
    name: feature,
    phase: f.phase,
    phaseNumber: f.phaseNumber != null ? f.phaseNumber : null,
    matchRate: f.matchRate != null ? f.matchRate : null,
    iterationCount: f.iterationCount || 0,
    requirements: f.requirements || [],
    documents: f.documents || {},
    timestamps: f.timestamps || {},
    metrics: f.metrics || null,
  });
}

function handleDocRead(phase, args) {
  const { feature } = args || {};
  if (!feature) return errResponse('INVALID_ARGS', 'feature is required');

  let filePath;
  try {
    // C4 fix: docsPath validates `feature` via validateName; surface a bad feature
    // as INVALID_ARGS (matching the existing pre-validation guard) rather than the
    // dispatcher's generic IO_ERROR.
    filePath = docsPath(phase, feature);
  } catch (validationErr) {
    return errResponse('INVALID_ARGS', validationErr.message);
  }
  if (!filePath) return errResponse('INVALID_ARGS', `Unknown phase: ${phase}`);

  const content = readTextOrNull(filePath);
  if (content === null) return errResponse('NOT_FOUND', `Document not found: ${filePath}`);

  return okResponse({
    feature,
    phase,
    filePath,
    content,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
  });
}

function handleBkitMetricsGet(args) {
  const { feature } = args || {};
  const data = readJsonOrNull(statePath('quality-metrics.json'));
  if (!data) {
    return okResponse({
      version: '2.0',
      collectedAt: null,
      metrics: {},
      thresholds: {
        matchRate: 90, codeQualityScore: 70, criticalIssueCount: 0,
        apiComplianceRate: 95, runtimeErrorRate: 1, p95ResponseTime: 1000,
        conventionCompliance: 90, designCompleteness: 85,
      },
    });
  }

  if (feature && data.byFeature) {
    const fm = data.byFeature[feature];
    if (!fm) return errResponse('NOT_FOUND', `No metrics for feature: ${feature}`);
    const result = Object.assign({}, data, { metrics: fm });
    delete result.byFeature;
    return okResponse(result);
  }

  return okResponse(data);
}

function handleBkitMetricsHistory(args) {
  const { metric, limit = 30 } = args || {};
  const data = readJsonOrNull(statePath('quality-history.json'));
  if (!data) return okResponse({ metric: metric || null, total: 0, items: [] });

  let items = data.history || [];
  if (metric) {
    items = items.map(entry => ({
      timestamp: entry.timestamp,
      feature: entry.feature,
      values: { [metric]: (entry.values && entry.values[metric]) != null ? entry.values[metric] : null },
    }));
  }
  return okResponse({ metric: metric || null, total: (data.history || []).length, items: items.slice(-limit) });
}

// ---------------------------------------------------------------------------
// v2.1.13 Sprint Management tool handlers (관점 1-1 DEEP-6)
// ---------------------------------------------------------------------------

function handleBkitSprintStatus(args) {
  const { sprintId } = args || {};
  const state = readJsonOrNull(statePath('sprint-status.json'));
  if (!state) {
    return okResponse({ version: null, entries: {}, total: 0 });
  }
  const entries = state.entries || {};
  if (sprintId) {
    const s = entries[sprintId];
    if (!s) return errResponse('NOT_FOUND', `Sprint not found: ${sprintId}`);
    return okResponse({ version: state.version, sprint: { id: sprintId, ...s } });
  }
  const list = Object.entries(entries).map(([id, s]) => ({
    id,
    name: s.name,
    phase: s.phase,
    status: s.status,
    trustLevelAtStart: s.trustLevelAtStart,
    updatedAt: s.updatedAt,
  }));
  return okResponse({
    version: state.version,
    total: list.length,
    summary: {
      active: list.filter(s => s.status === 'active').length,
      paused: list.filter(s => s.status === 'paused').length,
      archived: list.filter(s => s.status === 'archived').length,
    },
    entries: list,
  });
}

function handleBkitSprintList(args) {
  const { status = 'all', limit = 50 } = args || {};
  const state = readJsonOrNull(statePath('sprint-status.json'));
  const entries = (state && state.entries) || {};
  let list = Object.entries(entries).map(([id, s]) => ({
    id,
    name: s.name,
    phase: s.phase,
    status: s.status,
    trustLevelAtStart: s.trustLevelAtStart,
    updatedAt: s.updatedAt,
    pauseHistoryCount: (s.autoPause && Array.isArray(s.autoPause.pauseHistory)) ? s.autoPause.pauseHistory.length : 0,
  }));
  if (status !== 'all') {
    list = list.filter(s => s.status === status);
  }
  list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return okResponse({ status, total: list.length, items: list.slice(0, limit) });
}

function handleBkitMasterPlanRead(args) {
  const { projectId } = args || {};
  if (!projectId || typeof projectId !== 'string') {
    return errResponse('INVALID_PARAMS', 'projectId is required (kebab-case string)');
  }
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(projectId)) {
    return errResponse('INVALID_PARAMS', `projectId must be kebab-case: ${projectId}`);
  }
  const file = statePath(path.join('master-plans', `${projectId}.json`));
  const plan = readJsonOrNull(file);
  if (!plan) {
    return errResponse('NOT_FOUND', `Master plan not found: ${projectId}.json`);
  }
  return okResponse({ projectId, plan });
}

// ---------------------------------------------------------------------------
// Resource handlers
// ---------------------------------------------------------------------------

function handleResourcePdcaStatus() {
  const data = readJsonOrNull(statePath('pdca-status.json')) || {};
  return {
    contents: [{
      uri: 'bkit://pdca/status',
      mimeType: 'application/json',
      text: JSON.stringify(data, null, 2),
    }],
  };
}

function handleResourceQualityMetrics() {
  const data = readJsonOrNull(statePath('quality-metrics.json')) || { metrics: {} };
  return {
    contents: [{
      uri: 'bkit://quality/metrics',
      mimeType: 'application/json',
      text: JSON.stringify(data, null, 2),
    }],
  };
}

function handleResourceAuditLatest() {
  const today = new Date().toISOString().slice(0, 10);
  const filePath = auditPath(`${today}.jsonl`);
  let entries = [];

  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    entries = lines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  return {
    contents: [{
      uri: 'bkit://audit/latest',
      mimeType: 'application/json',
      text: JSON.stringify({ date: today, total: entries.length, entries: entries.slice(-20) }, null, 2),
    }],
  };
}

// v2.1.13 Sprint Management resource handlers (관점 1-1 DEEP-6)
function handleResourceSprintStatus() {
  const data = readJsonOrNull(statePath('sprint-status.json')) || { version: null, entries: {} };
  return {
    contents: [{
      uri: 'bkit://sprint/status',
      mimeType: 'application/json',
      text: JSON.stringify(data, null, 2),
    }],
  };
}

function handleResourceSprintMasterPlans() {
  const dir = statePath('master-plans');
  let files = [];
  if (fs.existsSync(dir)) {
    files = fs.readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const projectId = name.replace(/\.json$/, '');
        const plan = readJsonOrNull(path.join(dir, name)) || {};
        return {
          projectId,
          schemaVersion: plan.schemaVersion || null,
          projectName: plan.projectName || null,
          featureCount: Array.isArray(plan.features) ? plan.features.length : 0,
          sprintCount: Array.isArray(plan.sprints) ? plan.sprints.length : 0,
          generatedAt: plan.generatedAt || null,
          updatedAt: plan.updatedAt || null,
        };
      });
  }
  return {
    contents: [{
      uri: 'bkit://sprint/master-plans',
      mimeType: 'application/json',
      text: JSON.stringify({ total: files.length, masterPlans: files }, null, 2),
    }],
  };
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

const TOOL_HANDLERS = {
  bkit_pdca_status: handleBkitPdcaStatus,
  bkit_pdca_history: handleBkitPdcaHistory,
  bkit_feature_list: handleBkitFeatureList,
  bkit_feature_detail: handleBkitFeatureDetail,
  bkit_plan_read: (args) => handleDocRead('plan', args),
  bkit_design_read: (args) => handleDocRead('design', args),
  bkit_analysis_read: (args) => handleDocRead('analysis', args),
  bkit_report_read: (args) => handleDocRead('report', args),
  bkit_metrics_get: handleBkitMetricsGet,
  bkit_metrics_history: handleBkitMetricsHistory,
  // v2.1.13 Sprint Management (관점 1-1 DEEP-6)
  bkit_sprint_status: handleBkitSprintStatus,
  bkit_sprint_list: handleBkitSprintList,
  bkit_master_plan_read: handleBkitMasterPlanRead,
};

const RESOURCE_HANDLERS = {
  'bkit://pdca/status': handleResourcePdcaStatus,
  'bkit://quality/metrics': handleResourceQualityMetrics,
  'bkit://audit/latest': handleResourceAuditLatest,
  // v2.1.13 Sprint Management (관점 1-1 DEEP-6)
  'bkit://sprint/status': handleResourceSprintStatus,
  'bkit://sprint/master-plans': handleResourceSprintMasterPlans,
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 message handling
// ---------------------------------------------------------------------------

function jsonRpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) — ignore
  // v2.1.8 fix B5: use "id" in msg to correctly handle explicit null id per JSON-RPC 2.0
  // v2.1.8 fix B14: any keyless message is a notification per JSON-RPC 2.0 (was duplicate check)
  if (!('id' in msg)) return null;

  switch (method) {
    case 'initialize':
      return jsonRpcOk(id, {
        protocolVersion: '2024-11-05',
        // v2.1.8 fix B12b: BKIT_VERSION dynamic lookup (ENH-167)
        serverInfo: { name: 'bkit-pdca-server', version: BKIT_VERSION },
        capabilities: { tools: {}, resources: {} },
      });

    case 'tools/list':
      return jsonRpcOk(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      const handler = TOOL_HANDLERS[name];
      if (!handler) {
        return jsonRpcOk(id, errResponse('NOT_FOUND', `Unknown tool: ${name}`));
      }
      try {
        return jsonRpcOk(id, handler(args || {}));
      } catch (err) {
        return jsonRpcOk(id, errResponse('IO_ERROR', err.message));
      }
    }

    case 'resources/list':
      return jsonRpcOk(id, { resources: RESOURCES });

    case 'resources/read': {
      const { uri } = params || {};
      const handler = RESOURCE_HANDLERS[uri];
      if (!handler) {
        return jsonRpcError(id, -32602, `Unknown resource: ${uri}`);
      }
      try {
        return jsonRpcOk(id, handler());
      } catch (err) {
        return jsonRpcError(id, -32603, err.message);
      }
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    const response = handleMessage(msg);
    if (response) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  } catch {
    // Ignore malformed JSON input
  }
});

rl.on('close', () => {
  process.exit(0);
});

process.stderr.write('[bkit-pdca-server] Started (pid=' + process.pid + ')\n');
