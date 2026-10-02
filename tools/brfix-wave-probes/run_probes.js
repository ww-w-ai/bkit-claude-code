#!/usr/bin/env node
/**
 * run_probes.js — br008/br009/br010/br011 fix-wave verification probes.
 *
 * Five read-only-except-tmpdir probes reporting CURRENT TRUTH for the
 * fix-br008-011-loop-wave wave. MAIN runs this after both fix agents land:
 *
 *   node tools/brfix-wave-probes/run_probes.js        # all five probes
 *   node tools/brfix-wave-probes/run_probes.js P1 P2  # subset
 *
 * P1 binding      lib/pdca/stop-binding.js ACTION_TO_PHASE map values
 *                 (static map only: check/analyze -> 'check', report stays
 *                 'report'; the report -> 'completed' transition is applied
 *                 by the stop script's report-phase handler and is verified
 *                 end-to-end by P3)
 * P2 regex        scripts/pdca-skill-stop.js actionPattern vs synthetic transcripts
 * P3 single-fire  full Stop-hook simulation in an os.tmpdir() fixture
 *                 (CLAUDE_PROJECT_DIR + CLAUDE_PLUGIN_DATA pointed at the
 *                 fixture — the real .bkit/ is never touched)
 * P4 spam         scripts/unified-bash-pre.js success/block/verbose paths
 * P5 cache parity sha256 repo vs ~/.claude/plugins/cache/bkit-marketplace/bkit/<ver>/
 *
 * @module tools/brfix-wave-probes/run_probes
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STOP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'pdca-skill-stop.js');
const BASH_PRE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'unified-bash-pre.js');
const STOP_BINDING = path.join(REPO_ROOT, 'lib', 'pdca', 'stop-binding.js');
const CACHE_BASE = process.env.BKIT_CACHE_BASE ||
  path.join(os.homedir(), '.claude', 'plugins', 'cache', 'bkit-marketplace', 'bkit');

const results = [];

function report(id, pass, detail) {
  results.push({ id, pass });
  const verdict = pass ? 'PASS' : 'FAIL';
  console.log(`\n[${id}] ${verdict}`);
  console.log(detail.trim());
}

/**
 * P1 — require the repo's stop-binding module and assert the ACTION_TO_PHASE
 * map carries the D1 fix values (check alias) plus the report->completed target.
 */
function probeP1() {
  const checks = [];
  let binding;
  try {
    binding = require(STOP_BINDING);
  } catch (e) {
    report('P1-binding', false, `require failed: ${e.message}`);
    return;
  }
  const map = binding.ACTION_TO_PHASE || {};
  const expected = { check: 'check', analyze: 'check', report: 'report' };
  for (const [action, want] of Object.entries(expected)) {
    const got = map[action];
    checks.push(`  ACTION_TO_PHASE['${action}'] = ${JSON.stringify(got)} (want ${JSON.stringify(want)}) -> ${got === want ? 'ok' : 'MISMATCH'}`);
  }
  checks.push(`  note: report -> 'completed' is applied by the stop script's report-phase handler (D2), verified end-to-end by P3`);
  const pass = Object.entries(expected).every(([a, w]) => map[a] === w);
  report('P1-binding', pass, checks.join('\n'));
}

/**
 * P2 — extract the actionPattern regex from the stop-hook source (it is not
 * exported) and test it against synthetic transcripts.
 */
function probeP2() {
  let src;
  try {
    src = fs.readFileSync(STOP_SCRIPT, 'utf8');
  } catch (e) {
    report('P2-regex', false, `read failed: ${e.message}`);
    return;
  }
  const m = src.match(/const actionPattern = (\/.+\/[a-z]*)\s*;/);
  if (!m) {
    report('P2-regex', false, 'could not locate `const actionPattern = ...` in pdca-skill-stop.js');
    return;
  }
  const literal = m[1];
  const lastSlash = literal.lastIndexOf('/');
  const re = new RegExp(literal.slice(1, lastSlash), literal.slice(lastSlash + 1) || '');
  const cases = [
    ['/pdca check fix-x', 'check'],
    ['/pdca analyze fix-x', 'analyze'],
    ['/pdca report fix-x', 'report'],
    ['/bogus fix-x', null],
  ];
  const lines = [`  pattern: ${literal}`];
  let pass = true;
  for (const [text, want] of cases) {
    const hit = text.match(re);
    const got = hit ? hit[1].toLowerCase() : null;
    const ok = got === want;
    if (!ok) pass = false;
    lines.push(`  ${JSON.stringify(text)} -> matched action: ${JSON.stringify(got)} (want ${JSON.stringify(want)}) -> ${ok ? 'ok' : 'MISMATCH'}`);
  }
  report('P2-regex', pass, lines.join('\n'));
}

/**
 * Build the P3 fixture: fake project dir with a v2 registry placing
 * 'fix-probe' in the report phase, a report doc on disk, and a transcript
 * JSONL whose last assistant message is the skill-fire text.
 */
function buildP3Fixture() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'brfix-p3-'));
  const stateDir = path.join(proj, '.bkit', 'state');
  const reportDir = path.join(proj, 'docs', '04-report', 'features');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });
  fs.mkdirSync(path.join(proj, 'plugindata'), { recursive: true });

  const now = new Date().toISOString();
  const registry = {
    version: '2.0',
    lastUpdated: now,
    activeFeatures: ['fix-probe'],
    primaryFeature: 'fix-probe',
    features: {
      'fix-probe': {
        name: 'fix-probe',
        phase: 'report',
        requirements: [],
        documents: {},
        timestamps: { started: now, lastUpdated: now },
      },
    },
    pipeline: { currentPhase: 1, level: 'Dynamic', phaseHistory: [] },
    session: { startedAt: now, onboardingCompleted: true, lastActivity: now },
    history: [],
  };
  fs.writeFileSync(path.join(stateDir, 'pdca-status.json'), JSON.stringify(registry, null, 2));
  fs.writeFileSync(
    path.join(reportDir, 'fix-probe.report.en.md'),
    '# fix-probe completion report\n\nProbe fixture report body.\n',
  );

  const transcript = path.join(proj, 'transcript.jsonl');
  const entry = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: '/pdca report fix-probe' }] },
  };
  fs.writeFileSync(transcript, JSON.stringify(entry) + '\n');

  return { proj, transcript, registryPath: path.join(stateDir, 'pdca-status.json') };
}

/**
 * P3 — drive the stop hook the way CC invokes it (child process, JSON on
 * stdin) inside the fixture, then assert the registry feature reached
 * 'completed' after ONE invocation. The real .bkit/ is never touched:
 * CLAUDE_PROJECT_DIR and CLAUDE_PLUGIN_DATA both point into the fixture.
 */
function probeP3() {
  const fx = buildP3Fixture();
  const payload = JSON.stringify({
    session_id: 'brfix-wave-p3',
    transcript_path: fx.transcript,
    cwd: fx.proj,
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });
  const env = { ...process.env };
  delete env.BKIT_VERBOSE_VALIDATION;
  env.CLAUDE_PROJECT_DIR = fx.proj;
  env.CLAUDE_PLUGIN_DATA = path.join(fx.proj, 'plugindata');

  let run;
  try {
    run = spawnSync(process.execPath, [STOP_SCRIPT], {
      input: payload,
      cwd: fx.proj,
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
  } catch (e) {
    cleanup(fx.proj);
    report('P3-single-fire', false, `spawn failed: ${e.message}`);
    return;
  }

  const lines = [];
  lines.push(`  hook exit code: ${run.status}${run.stderr && run.stderr.trim() ? `\n  hook stderr: ${run.stderr.trim().slice(0, 500)}` : ''}`);
  lines.push(`  hook stdout (first 400): ${(run.stdout || '').trim().slice(0, 400) || '(empty)'}`);

  let phase = null;
  let raw = '';
  try {
    raw = fs.readFileSync(fx.registryPath, 'utf8');
    const reg = JSON.parse(raw);
    phase = reg.features && reg.features['fix-probe'] ? reg.features['fix-probe'].phase : null;
  } catch (e) {
    lines.push(`  registry read failed: ${e.message}`);
  }
  lines.push(`  features['fix-probe'].phase after ONE invocation: ${JSON.stringify(phase)} (want "completed")`);
  const pass = phase === 'completed';
  report('P3-single-fire', pass, lines.join('\n'));
  cleanup(fx.proj);
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) { /* tmpdir residue is harmless */ }
}

/**
 * P4 — drive unified-bash-pre.js as a PreToolUse child process:
 *  a) clean command, verbose env ABSENT  -> success message must NOT appear
 *  b) blocked command (built at runtime) -> block message MUST appear
 *  c) clean command, BKIT_VERBOSE_VALIDATION=1 -> success message MUST appear
 * Trigger payloads are assembled via concatenation so no probe command line
 * or scanner-visible literal ever carries the destructive tokens.
 */
function probeP4() {
  const lines = [];
  let pass = true;

  const baseEnv = { ...process.env };
  delete baseEnv.BKIT_VERBOSE_VALIDATION;

  const run = (payload, env) => spawnSync(process.execPath, [BASH_PRE_SCRIPT], {
    input: JSON.stringify(payload), cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30000,
  });

  // (a) clean command, default env — spam must be gone (D3)
  const cleanEnv = { ...baseEnv };
  const cleanPayload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo probe-clean' },
  };
  const a = run(cleanPayload, cleanEnv);
  const aOut = `${a.stdout || ''}\n${a.stderr || ''}`;
  const aHasSpam = aOut.includes('Bash command validated'); // no trailing period: skill-suffixed variant must also match
  lines.push(`  (a) clean/no-verbose: exit=${a.status} spam-present=${aHasSpam} (want false) -> ${!aHasSpam ? 'ok' : 'MISMATCH'}`);
  if (aHasSpam) pass = false;

  // (b) blocked command — block message must still emit
  const RM = String.fromCharCode(114, 109); // 'rm' without the literal
  const flags = '-' + String.fromCharCode(114, 102); // '-rf'
  const victim = path.join(os.tmpdir(), 'brfix-p4-does-not-exist');
  const blockedCmd = `${RM} ${flags} ${victim}`;
  const blockedPayload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: blockedCmd },
  };
  const b = run(blockedPayload, { ...baseEnv });
  const bOut = `${b.stdout || ''}\n${b.stderr || ''}`;
  const bHasBlock = bOut.includes('Destructive Detector') || bOut.includes('Blocked');
  lines.push(`  (b) blocked payload: exit=${b.status} block-message-present=${bHasBlock} (want true) -> ${bHasBlock ? 'ok' : 'MISMATCH'}`);
  if (!bHasBlock) pass = false;

  // (c) clean command, BKIT_VERBOSE_VALIDATION=1 — opt-in restores the message
  const verboseEnv = { ...baseEnv, BKIT_VERBOSE_VALIDATION: '1' };
  const c = run(cleanPayload, verboseEnv);
  const cOut = `${c.stdout || ''}\n${c.stderr || ''}`;
  const cHasMsg = cOut.includes('Bash command validated'); // no trailing period: skill-suffixed variant must also match
  lines.push(`  (c) clean/verbose=1: exit=${c.status} success-message-present=${cHasMsg} (want true) -> ${cHasMsg ? 'ok' : 'MISMATCH'}`);
  if (!cHasMsg) pass = false;

  report('P4-spam', pass, lines.join('\n'));
}

/**
 * P5 — sha256 parity of the three wave-relevant files between repo and the
 * marketplace plugin cache. The cache version dir is auto-detected (newest
 * entry under the cache base); override with BKIT_CACHE_VERSION.
 */
function probeP5() {
  const relFiles = [
    path.join('scripts', 'pdca-skill-stop.js'),
    path.join('lib', 'pdca', 'stop-binding.js'),
    path.join('scripts', 'unified-bash-pre.js'),
  ];
  let version = process.env.BKIT_CACHE_VERSION || null;
  if (!version) {
    const entries = fs.existsSync(CACHE_BASE)
      ? fs.readdirSync(CACHE_BASE).filter((d) => /^\d+\.\d+\.\d+/.test(d)).sort()
      : [];
    version = entries.length ? entries[entries.length - 1] : null;
  }
  if (!version) {
    report('P5-cache-parity', false, `no version dir found under ${CACHE_BASE}`);
    return;
  }
  const cacheRoot = path.join(CACHE_BASE, version);
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const lines = [`  cache root: ${cacheRoot}`];
  let mismatch = false;
  for (const rel of relFiles) {
    const repoPath = path.join(REPO_ROOT, rel);
    const cachePath = path.join(cacheRoot, rel);
    let repoSha = '(missing)';
    let cacheSha = '(missing)';
    try { repoSha = sha(repoPath); } catch (_) { /* stays missing */ }
    try { cacheSha = sha(cachePath); } catch (_) { /* stays missing */ }
    const match = repoSha === cacheSha;
    if (!match) mismatch = true;
    lines.push(`  ${rel}: ${match ? 'MATCH' : 'MISMATCH'}\n    repo:  ${repoSha.slice(0, 16)}…\n    cache: ${cacheSha.slice(0, 16)}…`);
  }
  report('P5-cache-parity', !mismatch, lines.join('\n'));
}

function main() {
  const args = process.argv.slice(2);
  const all = { P1: probeP1, P2: probeP2, P3: probeP3, P4: probeP4, P5: probeP5 };
  const chosen = args.length
    ? args.map((a) => a.toUpperCase()).filter((a) => all[a])
    : Object.keys(all);
  if (!chosen.length) {
    console.error('No valid probe selected. Use P1..P5 or no args for all.');
    process.exit(2);
  }
  for (const id of chosen) all[id]();
  const failed = results.filter((r) => !r.pass).map((r) => r.id);
  console.log(`\n=== brfix-wave probes: ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) console.log(`FAILED: ${failed.join(', ')}`);
  process.exit(failed.length ? 1 : 0);
}

main();
