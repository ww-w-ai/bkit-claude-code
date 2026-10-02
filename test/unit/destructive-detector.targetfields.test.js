#!/usr/bin/env node
'use strict';
/**
 * destructive-detector.targetfields.test.js — G-001/G-013 targetFields fix
 * (bugfix-wave-20260919 Fix 1, RB-003). Standalone node runner, sibling of
 * destructive-detector.registry-lockdown.test.js.
 *
 * Contract:
 *   1. A Write whose CONTENT mentions a recursive-delete command is NOT
 *      denied — content executes nothing. (The RB-003 false-positive class.)
 *   2. The same token as a Bash command IS still denied (G-001 keeps teeth).
 *   3. find-based deletion as Bash is still denied (G-013 keeps teeth).
 *   4. Prose about find -delete in file content is not a deletion (G-013).
 *   5. The narrowing is G-001/G-013-scoped only: unrelated rules are untouched.
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
function expectMiss(tool, input, ruleId, label) {
  const got = ids(detect(tool, input));
  assert(!got.includes(ruleId), `${label}: ${ruleId} must not fire, got [${got.join(',')}]`);
}

// --- 1. Write content mentioning delete commands is not a deletion --------
tc('RB-003: Write with shutil.rmtree in content is not denied by G-001', () => {
  expectMiss('Write',
    { file_path: 'tests/x.py', content: 'import shutil\nshutil.rmtree(p)' },
    'G-001', 'rmtree prose in content');
});

tc('RB-003: Write with rimraf mention in content is not denied by G-001', () => {
  expectMiss('Write',
    { file_path: 'README.md', content: 'run `rimraf dist/` to clean the build' },
    'G-001', 'rimraf prose in content');
});

tc('RB-003: Edit payload with rm -rf in new_string is not denied by G-001', () => {
  expectMiss('Edit',
    { file_path: 'cleanup.sh', old_string: 'a', new_string: 'rm -rf /tmp/build' },
    'G-001', 'rm -rf in edit payload');
});

// --- 2. Bash delete commands still deny (G-001 keeps teeth) ----------------
tc('Bash rm -rf on a BROAD target is denied as G-001 (v2.1.34 D9: dangerous target still denies)', () => {
  const res = detect('Bash', { command: 'rm -rf /' });
  assert(ids(res).includes('G-001'), `expected G-001, got [${ids(res).join(',')}]`);
  const rule = res.rules.find((r) => r.id === 'G-001');
  assert(rule.action === 'deny', `action=${rule.action}`);
});

tc('Bash rm -rf on a SPECIFIC target asks (v2.1.34 D9: a specific one asks)', () => {
  const res = detect('Bash', { command: 'rm -rf /tmp/x' });
  assert(ids(res).includes('G-001'), `expected G-001, got [${ids(res).join(',')}]`);
  const rule = res.rules.find((r) => r.id === 'G-001');
  assert(rule.action === 'ask', `action=${rule.action}`);
});

// --- 3. find-based deletion as Bash still denies (G-013) -------------------
tc('Bash find -exec rm is still denied as G-013', () => {
  const res = detect('Bash', { command: 'find . -name "*" -exec rm {} \;' });
  assert(ids(res).includes('G-013'), `expected G-013, got [${ids(res).join(',')}]`);
});

tc('Bash find -delete is still denied as G-013', () => {
  const res = detect('Bash', { command: 'find / -name "*.tmp" -delete' });
  assert(ids(res).includes('G-013'), `expected G-013, got [${ids(res).join(',')}]`);
});

// --- 4. G-013 narrowing: prose is not a deletion ---------------------------
tc('Write whose content documents find -delete is not denied by G-013', () => {
  expectMiss('Write',
    { file_path: 'a.md', content: 'docs about find -delete usage' },
    'G-013', 'find -delete prose');
});

// --- 5. Legacy string-input form (whole-input) still works ----------------
tc('Bash string form rm -rf still denies (legacy detect signature)', () => {
  const res = detect('Bash', 'rm -rf /tmp/legacy');
  assert(ids(res).includes('G-001'), `expected G-001, got [${ids(res).join(',')}]`);
});

// eslint-disable-next-line no-console -- test output convention
console.log(`\ndestructive-detector.targetfields.test.js: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.error('FAILURES:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
