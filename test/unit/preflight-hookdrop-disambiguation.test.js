#!/usr/bin/env node
'use strict';

/**
 * Unit tests for fix-preflight-hookdrop-mislead — content locks on the two
 * session-start preflight warnings so neither can be read as
 * "newer CC version ⇒ hook drop" again (root cause of invalid br004):
 *
 *   T-01  KNOWN_ISSUES fork-default-agent-spawn carries the non-causality
 *         clause in summary AND detail (lib/infra/cc-version-checker.js)
 *   T-02  renderCCVersionWarning known-issues branch renders the clause
 *         (hooks/startup/preflight.js)
 *   T-03  behind-recommended branch unchanged (upgrade advice, no clause)
 *   T-04  buildReachabilityWarning carries evidence path + canary rule +
 *         skill-fires pointer (lib/core/hook-reachability.js; session-start.js
 *         delegates to it — that script is main-guard-less and process.exits,
 *         so the builder lives in the pure module instead of the hook file)
 */

const assert = require('assert');

let passed = 0, failed = 0, total = 0;
function test(id, description, fn) {
  total++;
  try { fn(); passed++; }
  catch (err) { failed++; console.error(`  FAIL ${id}: ${description}\n    ${err.message}`); }
}

console.log('\n=== Preflight Hook-Drop Disambiguation Tests ===\n');

const { KNOWN_ISSUES } = require('../../lib/infra/cc-version-checker');
const { renderCCVersionWarning } = require('../../hooks/startup/preflight');
const { buildReachabilityWarning } = require('../../lib/core/hook-reachability');

const forkEntry = KNOWN_ISSUES.find((i) => i.id === 'fork-default-agent-spawn');

test('T-01', 'fork-default-agent-spawn summary/detail carry non-causality clauses', () => {
  assert.ok(forkEntry, 'fork-default-agent-spawn entry exists');
  assert.match(forkEntry.summary, /NOT a hook failure/i);
  assert.match(forkEntry.detail, /NOT a plugin-hook drop/);
  assert.match(forkEntry.detail, /hook-reachability\.json/);
});

test('T-02', 'renderCCVersionWarning known-issues branch renders the clause', () => {
  const out = renderCCVersionWarning({
    current: '2.1.278', recommended: '2.1.220', severity: 'warn',
    inactive: [], knownIssues: [forkEntry],
  });
  assert.ok(out, 'renders a warning');
  assert.match(out, /NOT a hook failure/i);
  assert.match(out, /recommends/);
});

test('T-03', 'behind-recommended branch intact — upgrade advice, no hook clause', () => {
  const out = renderCCVersionWarning({
    current: '2.1.100', recommended: '2.1.220', severity: 'warn',
    inactive: [], knownIssues: [],
  });
  assert.ok(out, 'renders a warning');
  assert.match(out, /recommended/);
  assert.ok(!/NOT a hook failure/i.test(out), 'behind-recommended path stays clause-free');
});

test('T-04', 'buildReachabilityWarning carries evidence path + skill-fires pointer', () => {
  const out = buildReachabilityWarning(
    ['bash_post'], ['write_post'],
    '/proj/.bkit/runtime/hook-reachability.json',
  );
  assert.match(out, /hook-reachability\.json/);
  assert.match(out, /skill fires/);
  assert.match(out, /FRESH canary stamps/);
  assert.match(out, /missing=\[bash_post\]/);
  assert.match(out, /stale=\[write_post\]/);
});

console.log(`\n--- Results: ${passed}/${total} passed, ${failed} failed ---`);
if (failed > 0) process.exit(1);
