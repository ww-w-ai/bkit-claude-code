#!/usr/bin/env node
'use strict';
/**
 * skill-invocation-effects.test.js — unit tests for the shared effects module
 * (Issue #132, I-1/I-9/I-10). Standalone node runner (issue-130 style).
 *
 * Verifies all 5 effects, skill_invoked vs skill_executed selection by source,
 * dedup suppression of an identical same-session key, and pdca-phase gating.
 *
 * Isolation: CLAUDE_PROJECT_DIR is pointed at a fresh temp dir BEFORE any
 * require, so every side-effect (audit / decisions / .bkit/runtime markers)
 * lands under the temp dir. CLAUDE_PLUGIN_ROOT is left unset so the real
 * skills/ directory resolves for orchestration/config lookups.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-effects-'));
process.env.CLAUDE_PROJECT_DIR = TMP;
delete process.env.CLAUDE_PLUGIN_ROOT; // ensure real skills/ resolves

const { runSkillInvocationEffects } = require('../../lib/orchestrator/skill-invocation-effects');
const { readActiveSkill } = require('../../lib/core/active-skill-marker');

let pass = 0, fail = 0;
const failures = [];
async function tc(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; failures.push(`${name} :: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function readAllLines(subdir) {
  const dir = path.join(TMP, '.bkit', subdir);
  if (!fs.existsSync(dir)) return [];
  const lines = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (l.trim()) { try { lines.push(JSON.parse(l)); } catch (_e) { /* skip */ } }
    }
  }
  return lines;
}
const auditLines = () => readAllLines('audit');
const decisionLines = () => readAllLines('decisions');

(async () => {
  // 1. skill-tool path → skill_executed + active-skill marker + suggestions.
  await tc('skill-tool source records skill_executed + marker + suggestions', async () => {
    const before = auditLines().length;
    const { suggestions } = await runSkillInvocationEffects(
      'phase-1-schema', { action: 'plan', feature: 'login' },
      { source: 'skill-tool', dedupeKey: 's1' }
    );
    const after = auditLines();
    assert(after.length === before + 1, `expected +1 audit line, got ${after.length - before}`);
    const entry = after[after.length - 1];
    assert(entry.action === 'skill_executed', `action=${entry.action}`);
    assert(entry.target === 'phase-1-schema', `target=${entry.target}`);
    // Effect 2: active-skill marker written.
    const marker = readActiveSkill();
    assert(marker && marker.skill === 'phase-1-schema', `marker=${JSON.stringify(marker)}`);
    // Effect 3: suggestions include the next skill (phase-1-schema → phase-2-convention).
    assert(suggestions && suggestions.nextSkill && suggestions.nextSkill.name === 'phase-2-convention',
      `suggestions=${JSON.stringify(suggestions)}`);
  });

  // 2. slash-command path → skill_invoked (distinct action string).
  await tc('slash-command source records skill_invoked', async () => {
    const before = auditLines().length;
    await runSkillInvocationEffects(
      'phase-1-schema', { action: 'plan', feature: 'signup' },
      { source: 'slash-command', dedupeKey: 's2' }
    );
    const after = auditLines();
    assert(after.length === before + 1, `expected +1 audit line`);
    const entry = after[after.length - 1];
    assert(entry.action === 'skill_invoked', `action=${entry.action}`);
  });

  // 3. Effect 5: pdca-phase skill records a phase_transition decision.
  await tc('pdca-phase skill records phase_transition decision', async () => {
    const before = decisionLines().length;
    await runSkillInvocationEffects(
      'phase-1-schema', { action: 'plan', feature: 'checkout' },
      { source: 'skill-tool', dedupeKey: 's3' }
    );
    const after = decisionLines();
    assert(after.length === before + 1, `expected +1 decision line, got ${after.length - before}`);
    const d = after[after.length - 1];
    assert(d.decisionType === 'phase_transition', `decisionType=${d.decisionType}`);
    assert(d.phase === 'plan', `phase=${d.phase}`);
  });

  // 4. pdca-phase GATING: a skill without pdca-phase records NO decision.
  await tc('non-pdca-phase skill records no decision (gating)', async () => {
    const before = decisionLines().length;
    await runSkillInvocationEffects(
      'bkit', {}, { source: 'skill-tool', dedupeKey: 's4' }
    );
    const after = decisionLines();
    assert(after.length === before, `expected no new decision, got +${after.length - before}`);
  });

  // 5. Dedup: an identical same-session key is suppressed (no 2nd audit line).
  await tc('dedup suppresses identical same-session key', async () => {
    const KEY = 'sess-A:phase-1-schema:plan:dedupe-feat';
    const args = { action: 'plan', feature: 'dedupe-feat' };
    const first = await runSkillInvocationEffects('phase-1-schema', args, { source: 'skill-tool', dedupeKey: KEY });
    assert(!first.deduped, 'first call must not be deduped');
    const before = auditLines().length;
    const second = await runSkillInvocationEffects('phase-1-schema', args, { source: 'skill-tool', dedupeKey: KEY });
    assert(second.deduped === true, 'second identical call must be deduped');
    const after = auditLines().length;
    assert(after === before, `dedup must not add an audit line (before=${before} after=${after})`);
  });

  // 6. Router action writes (the work/pdca-skill-fire-test-results.md defect):
  //    `/pdca design <feature>` fires skill `pdca`, whose frontmatter declares
  //    `pdca-phase: null` BY DESIGN. The phase lives in the ACTION token. The
  //    fire must register a brand-new feature (no docs exist yet — they are the
  //    phase's OUTPUT) and set its phase.
  const readStatus = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(TMP, '.bkit', 'state', 'pdca-status.json'), 'utf8'));
    } catch (_e) { return null; }
  };
  await tc('pdca router phase-action fire registers the feature and writes the phase', async () => {
    await runSkillInvocationEffects(
      'pdca', { action: 'design', feature: 'catalog-cli-integration' },
      { source: 'skill-tool', dedupeKey: 's6' }
    );
    const status = readStatus();
    const f = status && status.features && status.features['catalog-cli-integration'];
    assert(f, 'feature catalog-cli-integration must be registered by the fire');
    assert(f.phase === 'design', `phase=${f.phase}, expected design`);
    assert(status.activeFeatures.includes('catalog-cli-integration'),
      'feature must be in activeFeatures');
  });

  // 7. Router non-phase actions (status/next/…) must NOT write a phase —
  //    resolvePdcaPhase falls back to the LIVE phase for those; writing it
  //    back would stamp a no-op transition into history.
  await tc('pdca router non-phase action does not write the registry', async () => {
    await runSkillInvocationEffects(
      'pdca', { action: 'status', feature: 'should-not-register' },
      { source: 'skill-tool', dedupeKey: 's7' }
    );
    const status = readStatus();
    assert(!status || !status.features || !status.features['should-not-register'],
      'non-phase action must not register a feature');
  });

  // 8. Aliased router actions: the action token names a DIFFERENT phase than
  //    itself (`analyze` → check, `iterate` → act). Both must register and
  //    write the ALIASED phase, not the action token.
  await tc('pdca analyze fire writes the check phase', async () => {
    await runSkillInvocationEffects(
      'pdca', { action: 'analyze', feature: 'alias-check-feat' },
      { source: 'skill-tool', dedupeKey: 's8' }
    );
    const f = readStatus().features['alias-check-feat'];
    assert(f, 'feature must be registered by the analyze fire');
    assert(f.phase === 'check', `phase=${f.phase}, expected check (aliased from analyze)`);
  });

  await tc('pdca iterate fire writes the act phase', async () => {
    await runSkillInvocationEffects(
      'pdca', { action: 'iterate', feature: 'alias-act-feat' },
      { source: 'skill-tool', dedupeKey: 's9' }
    );
    const f = readStatus().features['alias-act-feat'];
    assert(f, 'feature must be registered by the iterate fire');
    assert(f.phase === 'act', `phase=${f.phase}, expected act (aliased from iterate)`);
  });

  // 9. archive is deliberately NOT aliased: flipping to `archived` at fire
  //    time would precede the report-completion verification.
  await tc('pdca archive fire does not write the registry', async () => {
    await runSkillInvocationEffects(
      'pdca', { action: 'archive', feature: 'no-premature-archive' },
      { source: 'skill-tool', dedupeKey: 's10' }
    );
    const status = readStatus();
    assert(!status || !status.features || !status.features['no-premature-archive'],
      'archive fire must not write a phase before verification');
  });

  console.log(`\nskill-invocation-effects.test.js: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.error('FAILURES:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
})();
