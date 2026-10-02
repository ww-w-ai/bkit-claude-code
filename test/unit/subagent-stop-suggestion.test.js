#!/usr/bin/env node
'use strict';
/**
 * subagent-stop-suggestion.test.js — the suggestion must reach the
 * orchestrator, never the subagent (field report 2026-09-08).
 *
 * The gap-detector (a read-only agent: no Skill tool) was re-prompted six
 * times with an identical "Next: /pdca …" hook suggestion it could not act
 * on. The hint belongs on systemMessage (orchestrator/user surface); the
 * additionalContext payload (injected into the stopping subagent's own
 * context) must not carry skill-fire imperatives.
 */

const { execFileSync } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function tc(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`${name} :: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-substop-'));
// Seed a live phase so generateSubagentStop produces a next-action hint.
const seed = `
  const { updatePdcaStatus } = require(${JSON.stringify(path.join(ROOT, 'lib', 'pdca'))});
  updatePdcaStatus('substop-test', 'check', { matchRate: 80 }, { requireDocs: false });
`;
execFileSync('node', ['-e', seed],
  { env: { ...process.env, CLAUDE_PROJECT_DIR: tmp }, cwd: tmp });

function runHandler(agentName) {
  const payload = JSON.stringify({
    hook_event_name: 'SubagentStop',
    session_id: 'substop-test',
    cwd: tmp,
    agent: { agentId: 'a1', agentName, agentType: agentName, status: 'completed' },
  });
  const out = execFileSync('node',
    [path.join(ROOT, 'scripts', 'subagent-stop-handler.js')],
    { input: payload, env: { ...process.env, CLAUDE_PROJECT_DIR: tmp } }).toString();
  return JSON.parse(out);
}

tc('hint reaches the orchestrator via systemMessage', () => {
  const r = runHandler('gap-detector');
  assert(typeof r.systemMessage === 'string' && /pdca/i.test(r.systemMessage),
    `systemMessage should carry the next-action hint: ${r.systemMessage}`);
});

tc('subagent-facing payload carries NO skill-fire imperative (the 6x loop)', () => {
  const r = runHandler('gap-detector');
  const ctx = JSON.stringify(r.hookSpecificOutput || {});
  assert(!('additionalContext' in (r.hookSpecificOutput || {})),
    `additionalContext must not be injected into the subagent: ${ctx}`);
  assert(!/\/pdca|skill/i.test(ctx),
    `subagent payload must not mention skills: ${ctx}`);
});

tc('failed subagents still get the hint on systemMessage only', () => {
  const r = runHandler('gap-detector');
  assert(r.hookSpecificOutput.status === 'completed', 'payload shape intact');
});

console.log(`\nsubagent-stop-suggestion.test.js: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.error('FAILURES:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
