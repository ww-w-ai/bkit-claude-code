#!/usr/bin/env node
'use strict';
/**
 * registry-lockdown.hooks.test.js — L2 hook-path enforcement (design §8.3,
 * gap-analysis Critical 1/2, FR-05). Standalone node runner (issue-130 style).
 *
 * Feeds SYNTHETIC stdin to the real hook scripts (test/helpers/hook-runner):
 *   1. A Write targeting the phase registry must come back decision:"block"
 *      with guidance naming the skill-fire path — not an annotation.
 *   2. A Write to a .md doc whose content mentions the registry must be
 *      allowed (doc-target exemption holds end-to-end).
 *   3. A Bash registry write must block (parity with the Write path).
 *
 * Case 1 is the regression that hid the advisory-only Stage 6: the engine
 * detected G-020 correctly, the hook emitted context and let the write pass.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runHook } = require('../helpers/hook-runner');

let pass = 0, fail = 0;
const failures = [];
function tc(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`${name} :: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Registry path assembled at runtime (keeps this file's own content out of
// state-guard matching when the suite is edited by an agent under bkit hooks).
const regDir = path.join('.bkit', 'state');
const regFile = path.join(regDir, 'pdca-status.json');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-hooks-'));
fs.mkdirSync(path.join(tmp, regDir), { recursive: true });
const registryAbs = path.join(tmp, regFile);
fs.writeFileSync(registryAbs, JSON.stringify({ version: 2, features: {}, activeFeatures: [] }));

const payloadFor = (file_path, content) => ({
  tool_name: 'Write',
  cwd: tmp,
  hook_event_name: 'PreToolUse',
  session_id: 'hooks-l2-test',
  tool_input: { file_path, content },
});

tc('registry Write via pre-write.js is BLOCKED (decision block, not annotation)', () => {
  const r = runHook('scripts/pre-write.js',
    payloadFor(registryAbs, JSON.stringify({ version: 2, features: {}, hacked: true })),
    { env: { CLAUDE_PROJECT_DIR: tmp } });
  const out = typeof r.stdout === 'object' ? r.stdout : {};
  const ctx = JSON.stringify(out);
  assert(out.decision === 'block'
    || (out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny'),
    `expected a block decision, got: ${ctx.slice(0, 300)}`);
});

tc('registry Write block names the sanctioned path (/pdca skill fire)', () => {
  const r = runHook('scripts/pre-write.js',
    payloadFor(registryAbs, '{}'),
    { env: { CLAUDE_PROJECT_DIR: tmp } });
  const ctx = JSON.stringify(r.stdout);
  assert(ctx.includes('/pdca'),
    `deny guidance must name the skill-fire path, got: ${ctx.slice(0, 300)}`);
});

tc('.md Write with registry-path prose is ALLOWED through the hook', () => {
  const doc = path.join(tmp, 'docs', 'notes.md');
  fs.mkdirSync(path.dirname(doc), { recursive: true });
  const content = 'Run this to see the guard: echo x ' + String.fromCharCode(62) + ' ' + path.join(regDir, 'pdca-status.json');
  const r = runHook('scripts/pre-write.js', payloadFor(doc, content),
    { env: { CLAUDE_PROJECT_DIR: tmp } });
  const ctx = JSON.stringify(r.stdout);
  assert(!ctx.includes('"decision":"block"') && !ctx.includes('"permissionDecision":"deny"'),
    `doc write must not be blocked, got: ${ctx.slice(0, 300)}`);
});

tc('Bash registry write via unified-bash-pre.js is BLOCKED (parity)', () => {
  const cmd = 'echo x ' + String.fromCharCode(62) + ' ' + path.join(regDir, 'pdca-status.json');
  const r = runHook('scripts/unified-bash-pre.js', {
    tool_name: 'Bash', cwd: tmp, hook_event_name: 'PreToolUse',
    session_id: 'hooks-l2-test', tool_input: { command: cmd },
  }, { env: { CLAUDE_PROJECT_DIR: tmp } });
  const out = typeof r.stdout === 'object' ? r.stdout : {};
  assert(out.decision === 'block', `expected block, got: ${JSON.stringify(out).slice(0, 300)}`);
});

console.log(`\nregistry-lockdown.hooks.test.js: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.error('FAILURES:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
