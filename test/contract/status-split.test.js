/*
 * PDCA Status split verification — Sprint 1 status.js 872→3파일 분할 회귀 방지.
 *
 * Design Ref: bkit-v2110-integrated-enhancement.design.md §4.1
 * Plan SC: facade maintains 25 exports; no Invocation Contract regression.
 */

const assert = require('node:assert');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}: ${e.message}`); }
}

// ==================== Facade ====================
const facade = require('../../lib/pdca/status');
test('facade exports 28 items', () => assert.strictEqual(Object.keys(facade).length, 28));

// Core daily-use API
const CORE_API = [
  'getPdcaStatusPath', 'initPdcaStatusIfNotExists', 'getPdcaStatusFull',
  'loadPdcaStatus', 'savePdcaStatus', 'getFeatureStatus', 'updatePdcaStatus',
  'addPdcaHistory', 'completePdcaFeature', 'setActiveFeature',
  'addActiveFeature', 'removeActiveFeature', 'getActiveFeatures',
  'switchFeatureContext', 'extractFeatureFromContext',
  'readBkitMemory', 'writeBkitMemory',
];
CORE_API.forEach((fn) => {
  test(`facade.${fn} is function`, () => assert.strictEqual(typeof facade[fn], 'function'));
});

// Migration (cold path)
const MIGRATION_API = ['createInitialStatusV2', 'migrateStatusToV2', 'migrateStatusV2toV3'];
MIGRATION_API.forEach((fn) => {
  test(`facade.${fn} is function (migration)`, () => assert.strictEqual(typeof facade[fn], 'function'));
});

// Cleanup
const CLEANUP_API = [
  'deleteFeatureFromStatus', 'enforceFeatureLimit',
  'getArchivedFeatures', 'cleanupArchivedFeatures', 'archiveFeatureToSummary',
];
CLEANUP_API.forEach((fn) => {
  test(`facade.${fn} is function (cleanup)`, () => assert.strictEqual(typeof facade[fn], 'function'));
});

// ==================== Direct split modules ====================
const core = require('../../lib/pdca/status-core');
const migration = require('../../lib/pdca/status-migration');
const cleanup = require('../../lib/pdca/status-cleanup');

// v2.1.16 hardening: status-core exports grew 17 → 19 (added shouldUpdate +
// appendHistoryEntry helpers as part of v2.1.15 #89 6-Layer Defense refactor).
// br007 fix added pickPrimarySuccessor (sanctioned promotion fallback) → 21.
test('status-core exports 21 functions', () => assert.strictEqual(Object.keys(core).length, 21));
test('status-migration exports 3 functions', () => assert.strictEqual(Object.keys(migration).length, 3));
test('status-cleanup exports 5 functions', () => assert.strictEqual(Object.keys(cleanup).length, 5));

// ==================== createInitialStatusV2 ====================
test('createInitialStatusV2 returns v2.0 version', () => {
  const s = migration.createInitialStatusV2();
  assert.strictEqual(s.version, '2.0');
});
test('createInitialStatusV2 has activeFeatures array', () => {
  const s = migration.createInitialStatusV2();
  assert.ok(Array.isArray(s.activeFeatures));
  assert.strictEqual(s.activeFeatures.length, 0);
});
test('createInitialStatusV2 has pipeline', () => {
  const s = migration.createInitialStatusV2();
  assert.strictEqual(s.pipeline.currentPhase, 1);
  assert.strictEqual(s.pipeline.level, 'Dynamic');
});
test('createInitialStatusV2 lastUpdated is ISO string', () => {
  const s = migration.createInitialStatusV2();
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(s.lastUpdated));
});

// ==================== migrateStatusToV2 ====================
test('migrateStatusToV2 empty input', () => {
  const out = migration.migrateStatusToV2({});
  assert.strictEqual(out.version, '2.0');
});
test('migrateStatusToV2 preserves features', () => {
  const out = migration.migrateStatusToV2({ features: { x: { phase: 'plan' } } });
  assert.ok(out.features.x);
  assert.strictEqual(out.features.x.phase, 'plan');
});
test('migrateStatusToV2 currentFeature → primaryFeature', () => {
  const out = migration.migrateStatusToV2({ currentFeature: 'auth' });
  assert.strictEqual(out.primaryFeature, 'auth');
});

// ==================== migrateStatusV2toV3 ====================
test('migrateStatusV2toV3 idempotent on v3', () => {
  const v3 = { version: '3.0', features: {} };
  const out = migration.migrateStatusV2toV3(v3);
  assert.strictEqual(out.version, '3.0');
});
test('migrateStatusV2toV3 upgrades v2', () => {
  const v2 = migration.createInitialStatusV2();
  const v3 = migration.migrateStatusV2toV3(v2);
  assert.strictEqual(v3.version, '3.0');
  assert.ok(v3.stateMachine);
  assert.ok(v3.automation);
  assert.ok(v3.team);
});
test('migrateStatusV2toV3 adds feature.stateMachine', () => {
  const v2 = { version: '2.0', features: { x: { phase: 'plan' } } };
  const v3 = migration.migrateStatusV2toV3(v2);
  assert.ok(v3.features.x.stateMachine);
  assert.strictEqual(v3.features.x.stateMachine.currentState, 'plan');
});
test('migrateStatusV2toV3 adds feature.metrics', () => {
  const v2 = { version: '2.0', features: { x: {} } };
  const v3 = migration.migrateStatusV2toV3(v2);
  assert.ok(v3.features.x.metrics);
});
test('migrateStatusV2toV3 default automationLevel=2', () => {
  const v2 = { version: '2.0', features: { x: {} } };
  const v3 = migration.migrateStatusV2toV3(v2);
  assert.strictEqual(v3.features.x.automationLevel, 2);
});

// ==================== Invocation Contract (facade === split-module shape) ====================
CORE_API.forEach((fn) => {
  test(`facade.${fn} === status-core.${fn}`, () => assert.strictEqual(facade[fn], core[fn]));
});
MIGRATION_API.forEach((fn) => {
  test(`facade.${fn} === status-migration.${fn}`, () =>
    assert.strictEqual(facade[fn], migration[fn]));
});
CLEANUP_API.forEach((fn) => {
  test(`facade.${fn} === status-cleanup.${fn}`, () =>
    assert.strictEqual(facade[fn], cleanup[fn]));
});

console.log(`\nstatus-split.test.js: ${pass}/${pass + fail} PASS, ${fail} FAIL, 0 SKIP`);
if (fail > 0) process.exit(1);
