#!/usr/bin/env node
/**
 * v2.1.12 deep-functional-QA fixes — L1+L2 test suite covering 23 defects.
 *
 * Coverage map:
 *   L1 Unit (18 TC) — module-level invariants for #6/#8/#11/#13/#16/B3
 *   L2 Integration (10 TC) — script + state interaction for #1/#9/#10/#12/#15
 *
 * Test framework: hand-rolled tc() helper with fs/spawnSync; no external deps.
 *
 * @module tests/qa/v2112-deep-qa-fixes
 * @version 2.1.12
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
let pass = 0;
let fail = 0;
const failures = [];

function tc(id, label, fn) {
  try {
    fn();
    console.log(`  ✓ ${id}  ${label}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${id}  ${label}\n      ${e.message}`);
    fail++;
    failures.push({ id, label, message: e.message });
  }
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertTrue(cond, msg) { if (!cond) throw new Error(msg || 'expected true'); }
function assertFalse(cond, msg) { if (cond) throw new Error(msg || 'expected false'); }

// ── L1 Unit (18) ────────────────────────────────────────────────────────
console.log('\n=== L1 Unit Tests ===');

const ctrl = require(path.join(ROOT, 'lib/control/automation-controller'));
tc('L1-001', 'setLevel(0) updates currentLevel to 0', () => {
  // Save current setBy to restore later
  const before = JSON.parse(fs.readFileSync(path.join(ROOT, '.bkit/runtime/control-state.json'), 'utf8'));
  ctrl.setLevel(0, { reason: 'L1-001 test', setBy: 'test' });
  assertEq(ctrl.getCurrentLevel(), 0, 'getCurrentLevel must return 0 after setLevel(0)');
  // restore
  ctrl.setLevel(before.currentLevel, { reason: 'L1-001 restore', setBy: before.setBy || 'runtime' });
});
tc('L1-002', 'setLevel(0) writes levelCode AND currentLevel atomically', () => {
  const before = JSON.parse(fs.readFileSync(path.join(ROOT, '.bkit/runtime/control-state.json'), 'utf8'));
  ctrl.setLevel(0, { reason: 'L1-002 test', setBy: 'test' });
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, '.bkit/runtime/control-state.json'), 'utf8'));
  assertEq(j.currentLevel, 0);
  assertEq(j.levelCode, 0, '#11 fix: levelCode must equal currentLevel');
  assertEq(j.level, 'manual', '#11 fix: level (string) must reflect numLevel');
  ctrl.setLevel(before.currentLevel, { reason: 'L1-002 restore', setBy: before.setBy || 'runtime' });
});
tc('L1-003', 'setLevel roundtrip across all 5 levels', () => {
  const before = JSON.parse(fs.readFileSync(path.join(ROOT, '.bkit/runtime/control-state.json'), 'utf8'));
  for (let n = 0; n <= 4; n++) {
    ctrl.setLevel(n, { reason: 'L1-003 test', setBy: 'test' });
    assertEq(ctrl.getCurrentLevel(), n, `setLevel(${n}) roundtrip`);
  }
  ctrl.setLevel(before.currentLevel, { reason: 'L1-003 restore', setBy: before.setBy || 'runtime' });
});
tc('L1-004', 'resolveAction(bash_destructive) at L4 returns auto/allow', () => {
  const before = JSON.parse(fs.readFileSync(path.join(ROOT, '.bkit/runtime/control-state.json'), 'utf8'));
  ctrl.setLevel(4, { reason: 'L1-004 test', setBy: 'test' });
  const r = ctrl.resolveAction('bash_destructive');
  assertTrue(['auto', 'allow'].includes(r), `expected auto/allow at L4, got ${r}`);
  ctrl.setLevel(before.currentLevel, { reason: 'L1-004 restore', setBy: before.setBy || 'runtime' });
});

const runnerWrapper = require(path.join(ROOT, 'lib/evals/runner-wrapper'));
tc('L1-007', '_extractTrailingJson — pure JSON', () => {
  const r = runnerWrapper._extractTrailingJson('{"ok":true,"score":1}');
  assertEq(r && r.ok, true);
});
tc('L1-008', '_extractTrailingJson — log prefix + JSON', () => {
  const r = runnerWrapper._extractTrailingJson('[INFO] starting\n{"ok":true}');
  assertEq(r && r.ok, true);
});
tc('L1-009', '_extractTrailingJson — nested object trap', () => {
  const r = runnerWrapper._extractTrailingJson('{"outer":{"inner":1},"pass":true}');
  assertEq(r && r.pass, true, 'must extract OUTER object, not the nested inner one');
});
tc('L1-010', '_extractTrailingJson — Usage banner only', () => {
  const r = runnerWrapper._extractTrailingJson('Usage: node runner.js --skill <name>');
  assertEq(r, null);
});
tc('L1-011', '_extractTrailingJson — empty string', () => {
  assertEq(runnerWrapper._extractTrailingJson(''), null);
});
tc('L1-012', 'isValidSkillName — regex boundary', () => {
  assertEq(runnerWrapper.isValidSkillName('a'), true);
  assertEq(runnerWrapper.isValidSkillName('abc-123'), true);
  assertEq(runnerWrapper.isValidSkillName('abc 123'), false);
  assertEq(runnerWrapper.isValidSkillName('abc/def'), false);
  assertEq(runnerWrapper.isValidSkillName(''), false);
  assertEq(runnerWrapper.isValidSkillName('A'), false);
  assertEq(runnerWrapper.isValidSkillName('a'.repeat(65)), false);
});

const sm = require(path.join(ROOT, 'lib/pdca/state-machine'));
tc('L1-013', 'getAvailableEvents returns object array', () => {
  const ev = sm.getAvailableEvents('idle');
  assertTrue(Array.isArray(ev), 'must be array');
  assertTrue(ev.length > 0);
  assertTrue(typeof ev[0].event === 'string', 'each entry must have .event string');
});
tc('L1-014', 'canTransition accepts both string and object form (#13)', () => {
  const ev = sm.getAvailableEvents('idle');
  for (const e of ev) {
    assertTrue(sm.canTransition('idle', e), 'object form must work');
    assertTrue(sm.canTransition('idle', e.event), 'string form must work');
  }
});
tc('L1-015', 'transition() returns normalised string event', () => {
  const tStr = sm.transition('idle', 'START');
  const tObj = sm.transition('idle', { event: 'START', target: 'pm', guard: null });
  assertEq(tStr.event, 'START');
  assertEq(tObj.event, 'START', '#13 fix: object input must yield string event in result');
});

tc('L1-016', '@version JSDoc present on all 142 lib modules (#6)', () => {
  function walk(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
    }
    return out;
  }
  const files = walk(path.join(ROOT, 'lib'));
  const missing = files.filter(f => !/@version\s+[0-9]/.test(fs.readFileSync(f, 'utf8')));
  assertEq(missing.length, 0, `#6 fix: ${missing.length} files missing @version: ${missing.slice(0, 3).join(',')}`);
});

tc('L1-017', '9 critical scripts have require.main guard (#9/#10/#8)', () => {
  const guarded = ['gap-detector-stop', 'pdca-skill-stop', 'iterator-stop', 'plan-plus-stop',
    'subagent-start-handler', 'subagent-stop-handler', 'team-idle-handler',
    'pdca-task-completed', 'sync-folders'];
  for (const s of guarded) {
    const text = fs.readFileSync(path.join(ROOT, 'scripts', s + '.js'), 'utf8');
    assertTrue(/require\.main\s*!==?\s*module/.test(text), `${s} missing require.main guard`);
  }
});

tc('L1-018', 'agent-state enabled:false zeroes lifecycle fields (#16)', () => {
  const tw = require(path.join(ROOT, 'lib/team/state-writer'));
  tw.initAgentState('L1-018', 'L1-018-feature', { ctoAgent: 'opus' });
  tw.cleanupAgentState();
  const s = tw.readAgentState();
  assertEq(s.enabled, false);
  assertEq(s.teammates.length, 0, '#16 fix: teammates must be 0 when enabled:false');
  assertEq(s.progress.totalTasks, 0, '#16 fix: progress must be zero when enabled:false');
});

const det = require(path.join(ROOT, 'lib/control/destructive-detector'));
tc('L1-019', 'destructive-detector — DROP TABLE detected (#19)', () => {
  assertTrue(det.isDestructive('DROP TABLE users'));
  assertTrue(det.isDestructive('drop table users'));
  assertTrue(det.isDestructive('DROP DATABASE prod'));
});
tc('L1-020', 'destructive-detector — TRUNCATE/DELETE without WHERE (#19)', () => {
  assertTrue(det.isDestructive('TRUNCATE TABLE users'));
  assertTrue(det.isDestructive('DELETE FROM users;'));
  assertTrue(det.isDestructive('DELETE FROM users'));
  assertFalse(det.isDestructive('DELETE FROM users WHERE id=1'));
  assertFalse(det.isDestructive('SELECT * FROM users'));
});

// ── L2 Integration (10) ─────────────────────────────────────────────────
console.log('\n=== L2 Integration Tests ===');

tc('L2-001', 'control-state.json field consistency invariant (#1+#11)', () => {
  const before = JSON.parse(fs.readFileSync(path.join(ROOT, '.bkit/runtime/control-state.json'), 'utf8'));
  for (const target of [0, 1, 2, 3, 4]) {
    ctrl.setLevel(target, { reason: 'L2-001 test', setBy: 'test' });
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, '.bkit/runtime/control-state.json'), 'utf8'));
    assertEq(j.currentLevel, target);
    assertEq(j.levelCode, target);
    assertEq(j.level, ctrl.getLevelName(target));
  }
  ctrl.setLevel(before.currentLevel, { reason: 'L2-001 restore', setBy: before.setBy || 'runtime' });
});

tc('L2-004', 'gap-detector-stop bare-require emits no stdout (#9)', () => {
  const r = cp.spawnSync('node', ['-e', "const m = require('./scripts/gap-detector-stop'); console.log(JSON.stringify(m));"], {
    cwd: ROOT, encoding: 'utf8', timeout: 5000,
  });
  // Dual-mode contract (v2.1.40, rb002): bare-require exports the shared
  // helpers and prints NOTHING at require time — stdout must parse as exactly
  // that one JSON object. (The old `=== '{}'` expectation encoded the
  // pre-dual-mode contract and went stale when matchRatePattern was exported.)
  let parsed = null;
  try { parsed = JSON.parse(r.stdout.trim()); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    assertEq('(clean JSON exports)', r.stdout.slice(0, 80), 'bare-require emitted stdout noise');
  }
  // JSON.stringify drops function exports; matchRatePattern (RegExp → {}) is
  // the one JSON-visible key proving the dual-mode export surface is live.
  assertEq('matchRatePattern' in parsed, true);
});
tc('L2-006', 'pdca-skill-stop bare-require emits no stdout (#10)', () => {
  const r = cp.spawnSync('node', ['-e', "const m = require('./scripts/pdca-skill-stop'); console.log(JSON.stringify(m));"], {
    cwd: ROOT, encoding: 'utf8', timeout: 5000,
  });
  // Dual-mode contract (br014): bare-require exports the envelope helpers and
  // prints NOTHING at require time — stdout must parse as exactly that one
  // JSON object. (Old `=== '{}'` encoded the pre-dual-mode contract.)
  let parsed = null;
  try { parsed = JSON.parse(r.stdout.trim()); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    assertEq('(clean JSON exports)', r.stdout.slice(0, 80), 'bare-require emitted stdout noise');
  }
  assertEq(Array.isArray(parsed.ENVELOPE_ACTIONS), true);
});

tc('L2-008', 'createCheckpoint → verifyCheckpoint roundtrip (#12)', () => {
  const cm = require(path.join(ROOT, 'lib/control/checkpoint-manager'));
  const created = cm.createCheckpoint('L2-008-test', 'check', 'manual', 'verify-roundtrip');
  const v = cm.verifyCheckpoint(created.id);
  assertEq(v.valid, true, `#12 fix: must be valid:true (got ${JSON.stringify(v)})`);
  assertEq(v.hashType, 'pdcaStatusHash');
  cm.deleteCheckpoint(created.id);
});

tc('L2-009', 'verifyCheckpoint identical SHA on re-run (determinism)', () => {
  const cm = require(path.join(ROOT, 'lib/control/checkpoint-manager'));
  const created = cm.createCheckpoint('L2-009-test', 'check', 'manual', 'determinism-test');
  const v1 = cm.verifyCheckpoint(created.id);
  const v2 = cm.verifyCheckpoint(created.id);
  assertEq(v1.actual, v2.actual);
  cm.deleteCheckpoint(created.id);
});

tc('L2-011', 'token-meter records non-zero from full payload (#17)', () => {
  const ta = require(path.join(ROOT, 'lib/cc-regression/token-accountant'));
  ta.recordTurn({
    sessionId: 'L2-011-session',
    agent: 'main',
    model: 'claude-opus-4-7',
    ccVersion: '2.1.121',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 1000,
    cacheCreationInputTokens: 25,
    parseStatus: 'ok',
  });
  const lines = fs.readFileSync(path.join(ROOT, '.bkit/runtime/token-ledger.ndjson'), 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assertEq(last.inputTokens, 100, '#17 fix: inputTokens must record actual value');
  assertEq(last.outputTokens, 50);
  assertEq(last.cacheReadInputTokens, 1000, '#17 fix: cacheReadInputTokens must record');
  assertEq(last.model, 'claude-opus-4-7');
  assertEq(last.parseStatus, 'ok');
});

tc('L2-014', 'error-log enriched context — full payload (#14)', () => {
  const r = cp.spawnSync('node', ['scripts/stop-failure-handler.js'], {
    cwd: ROOT,
    input: JSON.stringify({
      session_id: 'L2-014-sess',
      error_type: 'rate_limit',
      error_message: 'L2-014 test rate limit message',
      agent_id: 'L2-014-agent',
      agent_type: 'main',
    }),
    encoding: 'utf8', timeout: 5000,
  });
  const log = JSON.parse(fs.readFileSync(path.join(ROOT, '.bkit/runtime/error-log.json'), 'utf8'));
  const last = log[log.length - 1];
  assertEq(last.errorType, 'rate_limit');
  assertEq(last.message, 'L2-014 test rate limit message');
  assertEq(last.agentId, 'L2-014-agent');
  assertEq(last.parseStatus, 'ok', '#14 fix: parseStatus must be ok');
});
tc('L2-015', 'error-log parseStatus=no_input on empty (#14)', () => {
  cp.spawnSync('node', ['scripts/stop-failure-handler.js'], {
    cwd: ROOT, input: '{}', encoding: 'utf8', timeout: 5000,
  });
  const log = JSON.parse(fs.readFileSync(path.join(ROOT, '.bkit/runtime/error-log.json'), 'utf8'));
  const last = log[log.length - 1];
  assertEq(last.parseStatus, 'no_input', '#14 fix: empty payload → no_input');
});

tc('L2-021', 'intent-router multilingual — Korean natural utterance (#21)', () => {
  const ir = require(path.join(ROOT, 'lib/orchestrator/intent-router'));
  const r = ir.route('회원가입 만들어줘');
  assertTrue(r.primary != null, '#21 fix: 회원가입 must yield non-null primary');
  assertTrue(r.primary.confidence >= 0.8, `#21 fix: confidence must be ≥0.8, got ${r.primary.confidence}`);
});
tc('L2-022', 'intent-router multilingual — Chinese (#21)', () => {
  const ir = require(path.join(ROOT, 'lib/orchestrator/intent-router'));
  const r = ir.route('安全检查');
  assertTrue(r.primary != null, '#21 fix: 安全检查 must yield non-null primary');
});

// ── Summary ──────────────────────────────────────────────────────────────
console.log('');
console.log(`v2.1.12 deep-qa-fixes: ${pass} passed / ${fail} failed`);
console.log('═'.repeat(60));

if (fail > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ${f.id}: ${f.message}`);
  process.exit(1);
}
process.exit(0);
