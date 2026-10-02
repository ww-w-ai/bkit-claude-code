/**
 * pdca-status-timestamps-merge.test.js — br003 regression lock.
 *
 * Contract: updatePdcaStatus(feature, phase, { timestamps: {...} }) MERGES the
 * caller's timestamps into the registry record instead of dropping them. Before
 * the fix (lib/pdca/status-core.js), the trailing `timestamps:` key of the
 * Object.assign rebuilt only from the existing record + lastUpdated, so any
 * caller-passed timestamps (e.g. lifecycle.archiveFeature's archivedAt) was
 * silently lost. lastUpdated must remain present and fresh (set LAST, so it
 * wins over anything the caller passes).
 *
 * Runs hermetically: CLAUDE_PROJECT_DIR points at a temp dir seeded with a
 * minimal pdca-status registry (same shape test/unit/pdca-archive-gate.test.js
 * uses). requireDocs:false keeps the issue-#89 doc gate out of the way.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-status-ts-merge-'));
process.env.CLAUDE_PROJECT_DIR = projectDir;

// Modules load AFTER CLAUDE_PROJECT_DIR is set (lib/core/platform.js reads the
// env at require time).
const { updatePdcaStatus, getPdcaStatusFull } = require('../../lib/pdca/status-core');
const { globalCache } = require('../../lib/core/cache');

const statusDir = path.join(projectDir, '.bkit', 'state');
fs.mkdirSync(statusDir, { recursive: true });

function writeRegistry(features) {
  const status = {
    version: '2.0',
    lastUpdated: new Date().toISOString(),
    activeFeatures: Object.keys(features),
    primaryFeature: Object.keys(features)[0] || null,
    features,
    pipeline: { currentPhase: 1, level: 'Dynamic', phaseHistory: [] },
    session: { startedAt: new Date().toISOString(), onboardingCompleted: true },
    history: [],
  };
  fs.writeFileSync(path.join(statusDir, 'pdca-status.json'), JSON.stringify(status, null, 2));
  // The lib caches parsed status per project (3s TTL) — drop it so reads see
  // the file just written.
  globalCache.invalidate(`pdca-status:${projectDir}`);
}

test('br003-TC1 — data.timestamps merges into the record (archivedAt lands)', () => {
  const started = new Date(Date.now() - 60000).toISOString();
  writeRegistry({
    'ts-merge-a': {
      phase: 'report',
      phaseNumber: 7,
      matchRate: null,
      iterationCount: 0,
      requirements: [],
      documents: {},
      timestamps: { started },
    },
  });

  const archivedAt = new Date().toISOString();
  updatePdcaStatus('ts-merge-a', 'archived', { timestamps: { archivedAt } }, { requireDocs: false });

  const feat = getPdcaStatusFull(true).features['ts-merge-a'];
  assert.equal(feat.timestamps.archivedAt, archivedAt,
    'caller-passed archivedAt must survive the merge (was silently dropped before br003 fix)');
  assert.equal(feat.timestamps.started, started,
    'pre-existing timestamps must be preserved, not replaced');
  assert.ok(feat.timestamps.lastUpdated,
    'lastUpdated must still be set by the writer');
});

test('br003-TC2 — lastUpdated stays LAST: writer freshness wins over caller data', () => {
  writeRegistry({
    'ts-merge-b': {
      phase: 'do',
      phaseNumber: 3,
      matchRate: null,
      iterationCount: 0,
      requirements: [],
      documents: {},
      timestamps: {},
    },
  });

  const stale = new Date(Date.now() - 3600000).toISOString(); // 1h ago
  updatePdcaStatus('ts-merge-b', 'check', { timestamps: { lastUpdated: stale } }, { requireDocs: false });

  const feat = getPdcaStatusFull(true).features['ts-merge-b'];
  assert.notEqual(feat.timestamps.lastUpdated, stale,
    'a stale caller lastUpdated must not clobber the writer timestamp');
  assert.ok(new Date(feat.timestamps.lastUpdated).getTime() > Date.now() - 60000,
    'lastUpdated must be fresh (writer sets it last)');
});

test('br003-TC3 — update without data.timestamps keeps lastUpdated behavior', () => {
  writeRegistry({
    'ts-merge-c': {
      phase: 'plan',
      phaseNumber: 1,
      matchRate: null,
      iterationCount: 0,
      requirements: [],
      documents: {},
      timestamps: { started: new Date().toISOString() },
    },
  });

  updatePdcaStatus('ts-merge-c', 'design', {}, { requireDocs: false });

  const feat = getPdcaStatusFull(true).features['ts-merge-c'];
  assert.ok(feat.timestamps.started, 'started survives');
  assert.ok(feat.timestamps.lastUpdated, 'lastUpdated present');
  assert.equal(feat.phase, 'design');
});
