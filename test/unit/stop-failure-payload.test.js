#!/usr/bin/env node
'use strict';
/**
 * Unit Tests — stop-failure-handler.js parseFailurePayload (Fix 5)
 * Bugfix wave 20260919 §4: string `error` + last_assistant_message sources,
 * derived errorType, parseStatus semantics.
 *
 * The pure helper is exported via the bare-require guard (require.main check),
 * matching the sibling scripts/gap-detector-stop.js pattern.
 *
 * Design Ref: docs/02-design/features/bugfix-wave-20260919.design.md §4
 *
 * @module test/unit/stop-failure-payload
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseFailurePayload, classifyError } = require('../../scripts/stop-failure-handler');

// ============================================================
// Fix 5 — string `error` source
// ============================================================

test('F5-TC01 — {error:"Exit code 2"} → non-empty message + non-unknown classification', () => {
  const p = parseFailurePayload({ error: 'Exit code 2', session_id: 'x' });
  assert.equal(p.errorMessage, 'Exit code 2');
  assert.notEqual(p.errorType, 'unknown');
  assert.equal(p.errorType, 'exit_code');
  assert.equal(p.parseStatus, 'ok');
});

test('F5-TC02 — rate-limit message string derives rate_limit', () => {
  const p = parseFailurePayload({ error: '429 rate limit exceeded' });
  assert.equal(p.errorType, 'rate_limit');
});

// ============================================================
// Fix 5 — last_assistant_message source
// ============================================================

test('F5-TC03 — last_assistant_message as plain string used directly', () => {
  const p = parseFailurePayload({ last_assistant_message: 'timeout waiting for response' });
  assert.equal(p.errorMessage, 'timeout waiting for response');
  assert.equal(p.errorType, 'timeout');
});

test('F5-TC04 — last_assistant_message content[0].text object form', () => {
  const p = parseFailurePayload({
    last_assistant_message: { content: [{ text: 'API key invalid' }] },
  });
  assert.equal(p.errorMessage, 'API key invalid');
  assert.equal(p.errorType, 'auth_failure');
});

test('F5-TC05 — message.content[0].text (existing path) still works', () => {
  const p = parseFailurePayload({ message: { content: [{ text: 'server error 500' }] } });
  assert.equal(p.errorMessage, 'server error 500');
  assert.equal(p.errorType, 'server_error');
});

// ============================================================
// Fix 5 — explicit error fields still take precedence
// ============================================================

test('F5-TC06 — explicit error_message beats string error', () => {
  const p = parseFailurePayload({ error: 'Exit code 2', error_message: 'explicit message' });
  assert.equal(p.errorMessage, 'explicit message');
});

test('F5-TC07 — explicit errorType not overwritten by derivation', () => {
  const p = parseFailurePayload({ error: 'rate limit hit', error_type: 'custom_type' });
  assert.equal(p.errorType, 'custom_type');
});

// ============================================================
// parseStatus semantics
// ============================================================

test('F5-TC08 — payload with no message-bearing field → partial', () => {
  const p = parseFailurePayload({ session_id: 'x', cwd: '/tmp', effort: 'high' });
  assert.equal(p.parseStatus, 'partial');
  assert.match(p.parseWarnings, /missing useful fields/);
});

test('F5-TC09 — empty payload → no_input', () => {
  const p = parseFailurePayload({});
  assert.equal(p.parseStatus, 'no_input');
});

test('F5-TC10 — null payload → no_input (no throw)', () => {
  const p = parseFailurePayload(null);
  assert.equal(p.parseStatus, 'no_input');
});

// ============================================================
// classifyError exit_code branch
// ============================================================

test('F5-TC11 — classifyError "exit code 137" → exit_code category', () => {
  const c = classifyError('unknown', 'Exit code 137');
  assert.equal(c.category, 'exit_code');
  assert.equal(c.severity, 'low');
});
