/**
 * Unit tests — gap-detector-stop.js pure parse helpers
 *
 * Bugfix wave 20260919, §3 Fix 4 (matchRate regex ordering + feature
 * resolution + wrong-feature guard).
 *
 * Design Ref: docs/02-design/features/bugfix-wave-20260919.design.md §3
 *
 * @module test/unit/gap-detector-stop-parsing
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMatchRate,
  extractFeatureFromText,
  isKnownFeature,
} = require('../../scripts/gap-detector-stop');

// ============================================================
// Fix 4a — matchRate parsing
// ============================================================

test('Fix4a-TC01 — "Overall Match Rate: 98%" → 98', () => {
  assert.equal(parseMatchRate('Overall Match Rate: 98%'), 98);
});

test('Fix4a-TC02 — table form "Overall Match Rate | 98%" → 98', () => {
  assert.equal(parseMatchRate('Overall Match Rate | 98%'), 98);
});

test('Fix4a-TC03 — "Match Rate: 85%" → 85', () => {
  assert.equal(parseMatchRate('Match Rate: 85%'), 85);
});

test('Fix4a-TC04 — markdown table row "| Overall Match Rate | 92% |" → 92', () => {
  assert.equal(parseMatchRate('| Overall Match Rate | 92% |'), 92);
});

test('Fix4a-TC05 — multilingual "매치율: 77%" → 77', () => {
  assert.equal(parseMatchRate('매치율: 77%'), 77);
});

test('Fix4a-TC06 — multilingual "일치율 66" → 66', () => {
  assert.equal(parseMatchRate('일치율 66'), 66);
});

test('Fix4a-TC07 — "Design Match: 88%" → 88', () => {
  assert.equal(parseMatchRate('Design Match: 88%'), 88);
});

test('Fix4a-TC08 — no rate → null (unmeasured, not fabricated 0)', () => {
  assert.equal(parseMatchRate('The analysis completed with no percentage.'), null);
});

// ============================================================
// Fix 4b — feature resolution from agent text
// ============================================================

test('Fix4b-TC01 — "feature: my-feature" → my-feature', () => {
  assert.equal(extractFeatureFromText('Gap analysis for feature: my-feature done'), 'my-feature');
});

test('Fix4b-TC02 — quoted form feature: "kebab-name" resolves', () => {
  assert.equal(extractFeatureFromText('feature: "kebab-name"'), 'kebab-name');
});

test('Fix4b-TC03 — "analyzing some-feat" fallback pattern', () => {
  assert.equal(extractFeatureFromText('Analyzing "some-feat" results'), 'some-feat');
});

test('Fix4b-TC04 — no feature in text → null', () => {
  assert.equal(extractFeatureFromText('Nothing useful here'), null);
});

test('Fix4b-TC05 — regex-extracted name beats primaryFeature (resolution contract)', () => {
  // The stop hook passes the extracted name explicitly via
  // extractFeatureFromContext({ feature: featureFromText }), which
  // status-core returns verbatim — the primaryFeature fallback must not
  // shadow an explicit match. Simulate the resolution contract.
  const { extractFeatureFromContext } = require('../../lib/pdca/status');
  const resolved = extractFeatureFromContext({
    feature: extractFeatureFromText('feature: real-feature'),
    filePath: undefined,
  });
  assert.equal(resolved, 'real-feature');
});

// ============================================================
// Fix 4c — wrong-feature guard
// ============================================================

test('Fix4c-TC01 — feature === primaryFeature → known', () => {
  assert.equal(isKnownFeature('f1', { primaryFeature: 'f1', activeFeatures: [] }), true);
});

test('Fix4c-TC02 — feature in activeFeatures → known', () => {
  assert.equal(isKnownFeature('f2', { primaryFeature: 'f1', activeFeatures: ['f2'] }), true);
});

test('Fix4c-TC03 — unknown feature → not known (must not record)', () => {
  assert.equal(isKnownFeature('ghost', { primaryFeature: 'f1', activeFeatures: ['f2'] }), false);
});

test('Fix4c-TC04 — null status → not known', () => {
  assert.equal(isKnownFeature('f1', null), false);
});
