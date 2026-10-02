#!/usr/bin/env node
'use strict';
/**
 * destructive-detector.registry-lockdown.test.js — G-020 + G-019 redirect fix
 * (registry-lockdown FR-05/FR-06). Standalone node runner (issue-130 style).
 *
 * The registry-lockdown contract, as true tests:
 *   1. A Write/Edit whose TARGET is the phase registry is DENIED (G-020).
 *   2. A Write/Edit whose TARGET is a .md/.txt file NEVER trips a state-guard
 *      rule — even when the payload demonstrates state-path commands in prose.
 *      (The operator-reported FP class.)
 *   3. Bash writes to the registry are still denied (G-019 keeps its teeth).
 *   4. Descriptor redirects (2>, &>) are NOT write verbs — read-only commands
 *      with `2>/dev/null` near the state token pass. (Live-measured FP.)
 *   5. Plain stdout redirects to the state path still deny (fix narrows only).
 */

const { detect } = require('../../lib/control/destructive-detector');

let pass = 0, fail = 0;
const failures = [];
function tc(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`${name} :: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function ids(res) { return (res.rules || []).map((r) => r.id); }
function expectHit(tool, input, ruleId, label) {
  const got = ids(detect(tool, input));
  assert(got.includes(ruleId), `${label}: expected ${ruleId}, got [${got.join(',')}]`);
}
function expectMiss(tool, input, ruleId, label) {
  const got = ids(detect(tool, input));
  assert(!got.includes(ruleId), `${label}: ${ruleId} must not fire, got [${got.join(',')}]`);
}

// --- 1. Registry target writes are denied (G-020) -------------------------
tc('G-020 denies a Write targeting the phase registry', () => {
  expectHit('Write', { file_path: '.bkit/state/pdca-status.json', content: '{}' },
    'G-020', 'registry write');
});

tc('G-020 denies an Edit targeting the phase registry (filePath spelling)', () => {
  expectHit('Edit', { filePath: '/proj/.bkit/state/pdca-status.json', old_string: 'a', new_string: 'b' },
    'G-020', 'registry edit');
});

tc('G-020 denies a Write to any .bkit/state json, not just pdca-status', () => {
  expectHit('Write', { file_path: '.bkit/state/sprint-index.json', content: '{}' },
    'G-020', 'sprint state write');
});

tc('G-020 severity is critical and action is deny', () => {
  const r = detect('Write', { file_path: '.bkit/state/pdca-status.json' });
  const rule = (r.rules || []).find((x) => x.id === 'G-020');
  assert(rule, 'G-020 must match');
  assert(rule.severity === 'critical', `severity=${rule.severity}`);
  assert(rule.action === 'deny', `action=${rule.action}`);
});

// --- 2. Documentation targets are exempt from state-guard rules -----------
tc('a .md Write with a state-path command in its prose is NOT denied', () => {
  expectMiss('Write', {
    file_path: 'docs/02-design/features/registry-lockdown.design.md',
    content: 'Run `echo x > .bkit/state/pdca-status.json` to see the guard fire.',
  }, 'G-019', 'md prose');
  expectMiss('Write', {
    file_path: 'docs/02-design/features/registry-lockdown.design.md',
    content: 'Run `echo x > .bkit/state/pdca-status.json` to see the guard fire.',
  }, 'G-020', 'md prose');
});

tc('a .txt Write mentioning the registry is NOT denied', () => {
  expectMiss('Write', { file_path: 'NOTES.txt', content: 'see .bkit/state/pdca-status.json' },
    'G-019', 'txt content');
  expectMiss('Write', { file_path: 'NOTES.txt', content: 'see .bkit/state/pdca-status.json' },
    'G-020', 'txt content');
});

tc('an Edit to a .md doc whose new_string contains the state path is NOT denied', () => {
  expectMiss('Edit', {
    file_path: 'docs/03-analysis/x.analysis.md',
    old_string: 'before',
    new_string: 'after .bkit/state/pdca-status.json was written by the fire',
  }, 'G-019', 'md edit');
  expectMiss('Edit', {
    file_path: 'docs/03-analysis/x.analysis.md',
    old_string: 'before',
    new_string: 'after .bkit/state/pdca-status.json was written by the fire',
  }, 'G-020', 'md edit');
});

// Non-doc targets are NOT exempt: the same payload aimed at a .js file is judged.
tc('a non-doc Write with a registry-target command in content still trips G-019', () => {
  expectHit('Write', {
    file_path: 'scripts/run.sh',
    content: 'echo x > .bkit/state/pdca-status.json',
  }, 'G-019', 'sh content');
});

// --- 3. Bash registry writes still denied (G-019) --------------------------
tc('G-019 still denies a plain stdout redirect to the registry', () => {
  expectHit('Bash', { command: 'echo x > .bkit/state/pdca-status.json' }, 'G-019', 'redirect write');
});

tc('G-019 still denies cp/mv onto the registry', () => {
  expectHit('Bash', { command: 'cp /tmp/x.json .bkit/state/pdca-status.json' }, 'G-019', 'cp write');
});

// --- 4. Descriptor redirects are not write verbs (the live FP) -------------
tc('a read-only command with 2>/dev/null near the state token passes G-019', () => {
  expectMiss('Bash', { command: 'grep -c ZfeatA .bkit/state/pdca-status.json 2>/dev/null' },
    'G-019', 'stderr redirect read');
});

tc('a read-only command with &>/dev/null near the state token passes G-019', () => {
  expectMiss('Bash', { command: 'cat .bkit/state/pdca-status.json &>/dev/null || true' },
    'G-019', 'both-redirect read');
});

// --- 5. The fix narrows only: destructive redirects still deny -------------
tc('>> append to the registry still denies (narrowing check)', () => {
  expectHit('Bash', { command: 'echo x >> .bkit/state/pdca-status.json' }, 'G-019', 'append write');
});

tc('a >-redirect with space before it still denies (not a descriptor form)', () => {
  expectHit('Bash', { command: 'printf "{}" > .bkit/state/pdca-status.json' }, 'G-019', 'printf write');
});

console.log(`\ndestructive-detector.registry-lockdown.test.js: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.error('FAILURES:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
