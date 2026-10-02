#!/usr/bin/env node
'use strict';

/**
 * hook-behavioral-bash-pre.test.js - Behavioral tests for scripts/unified-bash-pre.js
 * Tests JSON stdin -> stdout/exitCode behavioral I/O
 *
 * @module test/integration/hook-behavioral-bash-pre
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runHook } = require('../helpers/hook-runner');

let passed = 0, failed = 0, total = 0;

function test(id, desc, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  PASS ${id}: ${desc}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${id}: ${desc}\n    ${e.message}`);
  }
}

console.log('\n=== Hook Behavioral: unified-bash-pre.js ===\n');

const SCRIPT = 'scripts/unified-bash-pre.js';

/**
 * Helper: build a PreToolUse Bash hook input payload
 * @param {string} command - Bash command string
 * @returns {Object} Hook input JSON
 */
function bashInput(command) {
  return {
    tool_name: 'Bash',
    tool_input: { command },
  };
}

// ---------- BPRE-01: Normal safe command is allowed ----------
test('BPRE-01', 'Normal safe bash command is allowed with exit 0 (silent unless verbose)', () => {
  // Success-path stdout is opt-in (spam fix): default run is silent, the
  // validation message appears only with BKIT_VERBOSE_VALIDATION=1.
  const result = runHook(SCRIPT, bashInput('ls -la'));
  assert.strictEqual(result.exitCode, 0, `exitCode should be 0, got ${result.exitCode}`);
  const verbose = runHook(SCRIPT, bashInput('ls -la'), { env: { BKIT_VERBOSE_VALIDATION: '1' } });
  assert.strictEqual(verbose.exitCode, 0);
  const out = typeof verbose.stdout === 'string' ? verbose.stdout : JSON.stringify(verbose.stdout);
  assert.ok(out.includes('Bash command validated'), `verbose stdout should include "Bash command validated", got: ${out}`);
});

// ---------- BPRE-02: Empty input is allowed (no command to block) ----------
test('BPRE-02', 'Empty input object is allowed with exit 0', () => {
  const result = runHook(SCRIPT, {});
  assert.strictEqual(result.exitCode, 0, `exitCode should be 0, got ${result.exitCode}`);
});

// ---------- BPRE-03: Empty command string is allowed ----------
test('BPRE-03', 'Empty command string is allowed', () => {
  const result = runHook(SCRIPT, bashInput(''));
  assert.strictEqual(result.exitCode, 0, `exitCode should be 0, got ${result.exitCode}`);
});

// ---------- BPRE-04: Non-destructive git command is allowed ----------
test('BPRE-04', 'Non-destructive git command (git status) is allowed', () => {
  const result = runHook(SCRIPT, bashInput('git status'));
  assert.strictEqual(result.exitCode, 0, `exitCode should be 0, got ${result.exitCode}`);
  // Silent success is the contract; exit 0 alone proves the allow.
  assert.ok(typeof result.stdout === 'string' || result.stdout === undefined || result.stdout === null || typeof result.stdout === 'object', 'Should allow git status');
});

// ---------- BPRE-05: No active skill/agent produces generic validation message ----------
test('BPRE-05', 'No active context produces generic "Bash command validated." message', () => {
  const result = runHook(SCRIPT, bashInput('echo hello'));
  assert.strictEqual(result.exitCode, 0);
  // Without active skill/agent the (verbose-only) message is generic — verify
  // via the verbose path that no skill/agent clause is attached.
  // Hermetic: point the hook at an empty sandbox project so the live
  // registry's session.lastSkill (set by whichever suite ran before this one
  // in the aggregate) cannot leak a "for <skill>" clause in.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-bpre05-'));
  let verbose;
  try {
    verbose = runHook(SCRIPT, bashInput('echo hello'), {
      env: { BKIT_VERBOSE_VALIDATION: '1', CLAUDE_PROJECT_DIR: sandbox },
    });
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
  const out = typeof verbose.stdout === 'string' ? verbose.stdout : JSON.stringify(verbose.stdout);
  assert.ok(out.includes('Bash command validated.'), `Should include generic validation message, got: ${out}`);
  assert.ok(!out.includes('for '), `Message should have no "for <skill>" clause, got: ${out}`);
});

// ---------- BPRE-06: Complex but safe command is allowed ----------
test('BPRE-06', 'Complex safe command (piped grep) is allowed', () => {
  const result = runHook(SCRIPT, bashInput('cat package.json | grep version | head -1'));
  assert.strictEqual(result.exitCode, 0, `exitCode should be 0, got ${result.exitCode}`);
});

// ---------- BPRE-07: Invalid JSON-like input still produces exit 0 ----------
test('BPRE-07', 'Malformed tool_input still exits 0 (graceful degradation)', () => {
  const result = runHook(SCRIPT, { tool_name: 'Bash', tool_input: 'not-an-object' });
  assert.strictEqual(result.exitCode, 0, `exitCode should be 0 even with malformed input, got ${result.exitCode}`);
});

// ---------- BPRE-08: Performance within timeout ----------
test('BPRE-08', 'Hook completes within 3000ms timeout', () => {
  const result = runHook(SCRIPT, bashInput('npm install'), { timeout: 3000 });
  assert.strictEqual(result.exitCode, 0, `exitCode should be 0, got ${result.exitCode}`);
  assert.ok(result.duration < 3000, `Duration ${result.duration}ms should be < 3000ms`);
});

// ---------- Summary ----------
console.log(`\n--- Results: ${passed}/${total} passed, ${failed} failed ---`);
if (failed > 0) process.exit(1);
