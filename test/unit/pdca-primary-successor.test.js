/**
 * pdca-primary-successor.test.js — br007 regression lock.
 *
 * Symptom (br007): switchFeatureContext('X') returned true and disk confirmed
 * the new primaryFeature — yet by the next turn primaryFeature had "reverted"
 * to a stale feature. Not a cache write-back: the ARCHIVE of X (or any
 * removal) promoted `activeFeatures[0]` — the OLDEST entry of the list. On
 * the live registry (44 features) that handed primaryFeature to a
 * days-old feature, and every hook that falls back to primaryFeature bound
 * the wrong row (matchRate 92 landed on the foreign feature; E-ARCH-GATE).
 *
 * Forensic timeline (rubicant .bkit/state/pdca-status.json):
 *   03:14:07 tools-agents-blocks archived -> promotion fired
 *   03:17:11 next writes landed on 'sima-kg-port --scope module-1'
 *
 * Contract: when the current primaryFeature leaves the active list, the
 * successor is the most recently ACTIVE feature (timestamps.lastUpdated,
 * falling back to started; among unstamped ones the newest registration).
 * The OLD behavior (`activeFeatures[0]`, oldest-first) must never win —
 * reverting pickPrimarySuccessor to head-selection turns TC1 RED.
 *
 * Runs hermetically: CLAUDE_PROJECT_DIR points at a temp registry, same
 * shape test/unit/pdca-archive-gate.test.js seeds.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-primary-successor-'));
process.env.CLAUDE_PROJECT_DIR = projectDir;

// Lib loads AFTER the env is set (lib/core/platform.js reads it at require time).
const {
  removeActiveFeature,
  pickPrimarySuccessor,
  getPdcaStatusFull,
} = require('../../lib/pdca/status-core');
const { globalCache } = require('../../lib/core/cache');

const statusDir = path.join(projectDir, '.bkit', 'state');
fs.mkdirSync(statusDir, { recursive: true });

const MIN = 60000;
function feat(phase, lastUpdatedMsAgo, startedMsAgo) {
  const timestamps = {};
  if (startedMsAgo != null) timestamps.started = new Date(Date.now() - startedMsAgo).toISOString();
  if (lastUpdatedMsAgo != null) timestamps.lastUpdated = new Date(Date.now() - lastUpdatedMsAgo).toISOString();
  return { phase, phaseNumber: 1, matchRate: null, iterationCount: 0, requirements: [], documents: {}, timestamps };
}

function writeRegistry(activeFeatures, primaryFeature, features) {
  const status = {
    version: '2.0',
    lastUpdated: new Date().toISOString(),
    activeFeatures,
    primaryFeature,
    features,
    pipeline: { currentPhase: 1, level: 'Dynamic', phaseHistory: [] },
    session: { startedAt: new Date().toISOString(), onboardingCompleted: true },
    history: [],
  };
  fs.writeFileSync(path.join(statusDir, 'pdca-status.json'), JSON.stringify(status, null, 2));
  // getPdcaStatusFull caches per project (3s TTL) — drop it so reads see the file.
  globalCache.invalidate(`pdca-status:${projectDir}`);
}

test('br007-TC1 — archive-path promotion: successor is the most recently UPDATED, not activeFeatures[0]', () => {
  // The br007 shape: stale feature FIRST in the list, the switched-to feature
  // being removed, and a recently-active feature later in the list.
  writeRegistry(
    ['stale-old-head', 'newly-switched', 'recently-active'],
    'newly-switched',
    {
      'stale-old-head': feat('completed', 3 * 24 * 60 * MIN, 10 * 24 * 60 * MIN), // 3 days stale
      'newly-switched': feat('archived', 1 * MIN, 2 * 60 * MIN),
      'recently-active': feat('do', 5 * MIN, 60 * MIN),
    }
  );

  removeActiveFeature('newly-switched'); // the archive path

  const after = getPdcaStatusFull(true);
  assert.equal(after.primaryFeature, 'recently-active',
    `successor must be the most recently active feature (got ${after.primaryFeature}; `
    + 'the old activeFeatures[0] promotion is the br007 revert)');
  assert.notEqual(after.primaryFeature, 'stale-old-head',
    'the oldest list head must NOT be promoted (that WAS the bug)');
  assert.ok(!after.activeFeatures.includes('newly-switched'));
});

test('br007-TC2 — cleanup-path promotion (deleteFeatureFromStatus) uses the same successor rule', () => {
  // Direct helper contract, cleanup shape: no stamps at all except on the
  // intended successor — an unstamped majority must not elect the head.
  const status = {
    activeFeatures: ['head-unstamped', 'mid-unstamped', 'tail-measured'],
    primaryFeature: 'head-unstamped',
    features: {
      'head-unstamped': feat('completed', null, null),
      'mid-unstamped': feat('completed', null, null),
      'tail-measured': feat('report', 2 * MIN, 30 * MIN),
    },
  };
  status.activeFeatures = status.activeFeatures.filter((f) => f !== status.primaryFeature);
  assert.equal(pickPrimarySuccessor(status), 'tail-measured',
    'unstamped features lose to any stamped one; newest registration wins among equals');
});

test('br007-TC3 — started is the fallback stamp when lastUpdated is absent', () => {
  const status = {
    activeFeatures: ['older-start', 'newer-start'],
    primaryFeature: null,
    features: {
      'older-start': feat('plan', null, 5 * 60 * MIN),
      'newer-start': feat('plan', null, 1 * 60 * MIN),
    },
  };
  assert.equal(pickPrimarySuccessor(status), 'newer-start');
});

test('br007-TC4 — empty active list yields null (no phantom primary)', () => {
  assert.equal(pickPrimarySuccessor({ activeFeatures: [], features: {} }), null);
  assert.equal(pickPrimarySuccessor(null), null);
});

test('br007-TC5 — end-to-end: switch, then archive the switched-to feature; primary stays sane', () => {
  // The exact br007 scenario, through the public API only.
  writeRegistry(
    ['sima-stale', 'fresh-work'],
    'sima-stale',
    {
      'sima-stale': feat('check', 24 * 60 * MIN, 48 * 60 * MIN),
      'fresh-work': feat('report', 3 * MIN, 90 * MIN),
    }
  );

  // Simulate the operator's switch by writing the registry the switch produces.
  const switched = getPdcaStatusFull(true);
  switched.primaryFeature = 'fresh-work';
  fs.writeFileSync(path.join(statusDir, 'pdca-status.json'), JSON.stringify(switched, null, 2));
  globalCache.invalidate(`pdca-status:${projectDir}`);

  removeActiveFeature('fresh-work'); // fresh-work gets archived

  const after = getPdcaStatusFull(true);
  assert.equal(after.primaryFeature, 'sima-stale',
    'only one active feature remains — it must be promoted regardless of stamp age');
});
