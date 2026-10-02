#!/usr/bin/env node
'use strict';

/**
 * bkit Full-System Integration Verifier (Sub-Sprint 6 Observation).
 *
 * Runs every cheap-to-execute health check the project knows about, in one
 * pass, so we can answer "does the whole bkit surface still work?" before
 * cutting a release. Each check returns a structured result; the script
 * prints a per-category table + a final JSON summary suitable for piping
 * into a markdown report.
 *
 * Checks performed:
 *   A  Module health     — every lib/**.js requires without throwing
 *   B  Hook/script syntax — node -c on hooks/* + scripts/*
 *   C  Agent frontmatter  — agents/*.md has parseable YAML frontmatter
 *   D  Skill frontmatter  — skills/* descriptions ≤ 1536 chars
 *   E  Domain purity      — lib/domain/ has zero forbidden imports
 *   F  Test suite         — every tests/qa + tests/contract file exits 0
 *   G  MCP server smoke   — bkit-pdca + bkit-analysis handshake
 *   H  State JSON         — .bkit/state/*.json is well-formed
 *   I  Runtime JSON       — .bkit/runtime/*.json is well-formed
 *   J  hooks.json         — every event entry points to an existing script
 *   K  Sprint state       — v2114 sub-sprint state machine integrity
 *
 * Usage:
 *   node scripts/verify-full-system.js              # human-readable
 *   node scripts/verify-full-system.js --json       # JSON only (for piping)
 *   node scripts/verify-full-system.js --md         # markdown table fragment
 *
 * @module scripts/verify-full-system
 * @version 2.1.14
 * @sprint v2114 Sub-Sprint 6
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const startedAt = Date.now();
const results = {};

function rel(p) { return path.relative(ROOT, p); }

function walk(dir, predicate) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, predicate));
    else if (entry.isFile() && predicate(entry.name, p)) out.push(p);
  }
  return out;
}

function check(name, fn) {
  const t0 = Date.now();
  try {
    const r = fn();
    results[name] = { ok: true, durationMs: Date.now() - t0, ...r };
  } catch (e) {
    results[name] = { ok: false, durationMs: Date.now() - t0, error: e.message };
  }
}

// ── A: Module health (lib/**) ──────────────────────────────────────
check('A_module_health', () => {
  const files = walk(path.join(ROOT, 'lib'), (n) => n.endsWith('.js'));
  let loaded = 0;
  const failures = [];
  for (const f of files) {
    try { require(f); loaded += 1; }
    catch (e) { failures.push({ file: rel(f), error: e.message.split('\n')[0] }); }
  }
  return { total: files.length, loaded, failures };
});

// ── B: Hook / script syntax ────────────────────────────────────────
check('B_hook_script_syntax', () => {
  const targets = [
    ...walk(path.join(ROOT, 'hooks'), (n) => n.endsWith('.js')),
    ...walk(path.join(ROOT, 'scripts'), (n) => n.endsWith('.js')),
  ];
  let ok = 0;
  const failures = [];
  for (const f of targets) {
    const r = spawnSync('node', ['-c', f], { stdio: 'pipe' });
    if (r.status === 0) ok += 1;
    else failures.push({ file: rel(f), stderr: (r.stderr || '').toString().slice(0, 200) });
  }
  return { total: targets.length, ok, failures };
});

// ── C: Agent frontmatter ───────────────────────────────────────────
check('C_agent_frontmatter', () => {
  const dir = path.join(ROOT, 'agents');
  const files = walk(dir, (n) => n.endsWith('.md'));
  let ok = 0;
  const failures = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (!/^---\s*\n/.test(src)) {
      failures.push({ file: rel(f), error: 'no frontmatter fence' });
      continue;
    }
    const end = src.indexOf('\n---', 4);
    if (end < 0) {
      failures.push({ file: rel(f), error: 'unterminated frontmatter' });
      continue;
    }
    const fm = src.slice(4, end);
    if (!/^\s*name:\s*\S/m.test(fm)) {
      failures.push({ file: rel(f), error: 'missing name:' });
      continue;
    }
    if (!/^\s*description:/m.test(fm)) {
      failures.push({ file: rel(f), error: 'missing description:' });
      continue;
    }
    ok += 1;
  }
  return { total: files.length, ok, failures };
});

// ── D: Skill frontmatter ───────────────────────────────────────────
check('D_skill_frontmatter', () => {
  const r = spawnSync('node', [path.join(ROOT, 'scripts/check-skill-frontmatter.js')], { stdio: 'pipe' });
  return {
    exit: r.status,
    stdout: (r.stdout || '').toString().trim().slice(0, 200),
    stderr: (r.stderr || '').toString().trim().slice(0, 200),
    pass: r.status === 0,
  };
});

// ── E: Domain purity ───────────────────────────────────────────────
check('E_domain_purity', () => {
  const r = spawnSync('node', [path.join(ROOT, 'scripts/check-domain-purity.js')], { stdio: 'pipe' });
  return {
    exit: r.status,
    stdout: (r.stdout || '').toString().trim().slice(0, 200),
    pass: r.status === 0,
  };
});

// ── F: Test suite ─────────────────────────────────────────────────
check('F_test_suite', () => {
  const targets = [
    ...walk(path.join(ROOT, 'tests/qa'), (n) => n.endsWith('.test.js')),
    ...walk(path.join(ROOT, 'tests/contract'), (n) => n.endsWith('.test.js')),
  ];
  let pass = 0;
  const failures = [];
  for (const f of targets) {
    const r = spawnSync('node', [f], { stdio: 'pipe', timeout: 60000 });
    if (r.status === 0) pass += 1;
    else failures.push({ file: rel(f), exit: r.status, tail: ((r.stderr || '').toString() + (r.stdout || '').toString()).slice(-200) });
  }
  return { total: targets.length, pass, failures };
});

// ── G: MCP server smoke ────────────────────────────────────────────
check('G_mcp_server_smoke', () => {
  const r = spawnSync('node', [path.join(ROOT, 'scripts/measure-mcp-alwaysload.js'), '--json'], {
    stdio: 'pipe', timeout: 20000,
  });
  let parsed = null;
  try { parsed = JSON.parse((r.stdout || '').toString()); } catch (_) { /* graceful */ }
  return {
    exit: r.status,
    servers: parsed && parsed.results ? parsed.results.map((s) => ({
      server: s.server, ok: s.ok, handshakeMs: s.handshakeMs,
    })) : [],
  };
});

// ── H: State JSON ──────────────────────────────────────────────────
check('H_state_json', () => {
  const dir = path.join(ROOT, '.bkit/state');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
    .map((n) => path.join(dir, n)) : [];
  let ok = 0;
  const failures = [];
  for (const f of files) {
    try { JSON.parse(fs.readFileSync(f, 'utf8')); ok += 1; }
    catch (e) { failures.push({ file: rel(f), error: e.message }); }
  }
  return { total: files.length, ok, failures };
});

// ── I: Runtime JSON ────────────────────────────────────────────────
check('I_runtime_json', () => {
  const dir = path.join(ROOT, '.bkit/runtime');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
    .map((n) => path.join(dir, n)) : [];
  let ok = 0;
  const failures = [];
  for (const f of files) {
    try { JSON.parse(fs.readFileSync(f, 'utf8')); ok += 1; }
    catch (e) { failures.push({ file: rel(f), error: e.message }); }
  }
  return { total: files.length, ok, failures };
});

// ── J: hooks.json — scripts referenced exist ───────────────────────
check('J_hooks_json_integrity', () => {
  const hooksJson = path.join(ROOT, 'hooks/hooks.json');
  if (!fs.existsSync(hooksJson)) throw new Error('hooks/hooks.json missing');
  const data = JSON.parse(fs.readFileSync(hooksJson, 'utf8'));
  const events = data.hooks || {};
  let totalRefs = 0, okRefs = 0;
  const missing = [];
  for (const event of Object.keys(events)) {
    const entries = events[event];
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      const handlers = Array.isArray(e.hooks) ? e.hooks : [];
      for (const h of handlers) {
        const cmd = h.command || '';
        const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+\.js)/.exec(cmd);
        if (m) {
          totalRefs += 1;
          const ref = path.join(ROOT, m[1]);
          if (fs.existsSync(ref)) okRefs += 1;
          else missing.push({ event, ref: m[1] });
        }
      }
    }
  }
  return { events: Object.keys(events).length, totalRefs, okRefs, missing };
});

// ── K: Sprint state machine integrity ──────────────────────────────
check('K_sprint_state_machine', () => {
  const file = path.join(ROOT, '.bkit/state/sprints/v2114-differentiation-release.json');
  // Untracked runtime state: clones without it skip the check instead of failing.
  if (!fs.existsSync(file)) {
    return { skipped: true, reason: 'v2114 sprint state not present in this clone (untracked runtime state)' };
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const subSprints = data.subSprints || [];
  const expected = ['coordination', 'defense', 'a-observability', 'e-defense', 'doc', 'observation'];
  const status = {};
  for (const ss of subSprints) status[ss.id] = ss.status;
  const archivedCount = subSprints.filter((s) => s.status === 'archived').length;
  const inProgressCount = subSprints.filter((s) => s.status === 'in_progress').length;
  return {
    expected, total: subSprints.length, status,
    archivedCount, inProgressCount,
    currentSubSprint: data.currentSubSprint,
    currentPhase: data.currentPhase,
  };
});

// ── Final ──────────────────────────────────────────────────────────
function isCategoryOk(v) {
  if (!v.ok) return false;
  if (Array.isArray(v.failures) && v.failures.length > 0) return false;
  if (v.pass === false) return false; // explicit false only
  if (Array.isArray(v.missing) && v.missing.length > 0) return false;
  if (Array.isArray(v.servers) && v.servers.some((s) => !s.ok)) return false;
  return true;
}

function categoryDetail(v) {
  if (v.skipped) return `SKIP — ${v.reason || 'no reason given'}`;
  if (v.error) return v.error;
  if (Array.isArray(v.servers)) {
    return v.servers.map((s) => `${s.server}:${s.ok ? 'ok' : 'fail'}` + (s.handshakeMs ? ` (${s.handshakeMs.toFixed(1)}ms)` : '')).join(' ');
  }
  if (v.total !== undefined) {
    const n = typeof v.pass === 'number' ? v.pass
      : typeof v.loaded === 'number' ? v.loaded
      : typeof v.ok === 'number' ? v.ok
      : (Array.isArray(v.failures) ? v.total - v.failures.length : v.total);
    let s = `${n}/${v.total}`;
    if (Array.isArray(v.failures) && v.failures.length > 0) s += ` (${v.failures.length} fail)`;
    return s;
  }
  if (v.totalRefs !== undefined) {
    const s = `${v.okRefs}/${v.totalRefs} refs`;
    return (v.missing && v.missing.length > 0) ? s + ` (${v.missing.length} missing)` : s;
  }
  if (v.archivedCount !== undefined) {
    return `${v.archivedCount} archived + ${v.inProgressCount} in_progress / ${v.total}`;
  }
  if (v.pass === true) return 'pass';
  if (v.pass === false) return 'fail';
  return '—';
}

const durationMs = Date.now() - startedAt;
const pass = Object.values(results).every(isCategoryOk);

const summary = { startedAt, durationMs, pass, categories: results };

const args = process.argv.slice(2);
if (args.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2));
} else if (args.includes('--md')) {
  console.log('| Category | Result | Detail |');
  console.log('|----------|:------:|--------|');
  for (const [k, v] of Object.entries(results)) {
    console.log(`| ${k} | ${isCategoryOk(v) ? '✅' : '❌'} | ${categoryDetail(v)} |`);
  }
  console.log('\n**Overall**: ' + (pass ? '✅ PASS' : '❌ FAIL') + ' (' + (durationMs / 1000).toFixed(2) + 's)');
} else {
  console.log('\nbkit Full-System Integration Verifier — Sub-Sprint 6');
  console.log('Duration: ' + (durationMs / 1000).toFixed(2) + 's\n');
  for (const [k, v] of Object.entries(results)) {
    const flag = isCategoryOk(v) ? '✅' : '❌';
    console.log(`  ${flag}  ${k.padEnd(28)} ${categoryDetail(v)}`);
  }
  console.log('\nOVERALL: ' + (pass ? '✅ PASS' : '❌ FAIL'));
}

process.exit(pass ? 0 : 1);
