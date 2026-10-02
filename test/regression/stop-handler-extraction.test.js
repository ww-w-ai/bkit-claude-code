'use strict';
/**
 * Regression tests for the last three Stop handlers reading the wrong text.
 * 20 TC | console.assert based | no external dependencies
 *
 * Completes the sweep started in qa-pipeline-wiring and qa-followups. Those two
 * gave the handlers a payload to read; these three were still regexing
 * `JSON.stringify(input)` — the hook ENVELOPE (hook_event_name, session_id,
 * transcript_path, cwd) rather than what the agent reported.
 *
 *   G-1  gap-detector-stop: match rate could never be extracted.
 *   G-2  iterator-stop: every completion/max-iteration/improvement pattern was
 *        permanently false, so branch selection fell to numeric fallbacks only.
 *        Its `|| 0` fallback also fabricated a measurement that isMeasured()
 *        accepts, feeding a false regression into M9.
 *   G-3  pdca-skill-stop: `action` was always null, which disables the status
 *        update, the auto-transition, the executive summary, and M8/M10.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '../..');
const io = require('../../lib/core/io');
const matchRateRules = require('../../lib/quality/match-rate');

let passed = 0, failed = 0, total = 0, skipped = 0;
const failures = [];

function assert(id, condition, message) {
  total++;
  if (condition) { passed++; console.log(`  PASS: ${id} - ${message}`); }
  else { failed++; failures.push({ id, message }); console.error(`  FAIL: ${id} - ${message}`); }
}

function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

console.log('\n=== stop-handler-extraction.test.js ===\n');

const HANDLERS = [
  'scripts/gap-detector-stop.js',
  'scripts/iterator-stop.js',
  'scripts/pdca-skill-stop.js',
];

// --- Shared: none of the three regexes the envelope any more ---

HANDLERS.forEach((rel, i) => {
  const src = read(rel);
  const n = String(i + 1).padStart(3, '0');
  assert(`SE-${n}`, !/inputText\s*=\s*typeof input === 'string' \? input : JSON\.stringify\(input\)/.test(src),
    `${path.basename(rel)} no longer stringifies the payload envelope as its match target`);
});

HANDLERS.forEach((rel, i) => {
  const src = read(rel);
  const n = String(i + 4).padStart(3, '0');
  assert(`SE-${n}`, /inputText\s*=\s*readHookText\(input\)/.test(src) &&
    /readStdinSync,\s*readHookText/.test(src),
    `${path.basename(rel)} resolves the agent's reported text`);
});

// --- The envelope genuinely carries none of the signals ---
// This is what made all three silent: the patterns are fine, the input was not.

const ENVELOPE = {
  hook_event_name: 'Stop',
  session_id: 'ab12cd34',
  transcript_path: '/home/u/.claude/projects/-home-u/ab12cd34.jsonl',
  cwd: '/home/u/project',
};
const envelopeText = JSON.stringify(ENVELOPE);

const matchRatePattern = /(Overall|Match Rate|매치율|일치율|Design Match)[^0-9]*(\d+)/i;
const completionPattern = /(완료|Complete|Completed|>= 90%|매치율.*9[0-9]%|Match Rate.*9[0-9]%|passed|성공|Successfully)/i;
const actionPattern = /pdca\s+(pm|plan|design|do|analyze|iterate|qa|report|status|next)/i;

assert('SE-007', !matchRatePattern.test(envelopeText),
  'Match rate cannot be found in the envelope (the G-1 defect)');
assert('SE-008', !completionPattern.test(envelopeText),
  'Completion cannot be detected in the envelope (the G-2 defect)');
assert('SE-009', !actionPattern.test(envelopeText),
  'PDCA action cannot be found in the envelope (the G-3 defect)');

// --- readHookText on a real transcript surfaces exactly those signals ---

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-extract-'));
const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
fs.writeFileSync(transcriptPath, [
  JSON.stringify({ type: 'user', message: { content: '/pdca analyze checkout-flow' } }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [
      { type: 'thinking', thinking: 'Overall Match Rate: 3%' },
      { type: 'text', text: 'Gap analysis for pdca analyze checkout-flow — Overall Match Rate: 87%. 4 files modified. Completed.' },
    ] },
  }),
  '',
].join('\n'));

const resolved = io.readHookText({ ...ENVELOPE, transcript_path: transcriptPath });

assert('SE-010', matchRatePattern.test(resolved) && resolved.match(matchRatePattern)[2] === '87',
  'Match rate is extractable from the resolved text, and reads 87 not 3');
assert('SE-011', completionPattern.test(resolved),
  'Completion is detectable from the resolved text');
assert('SE-012', actionPattern.test(resolved) &&
  resolved.match(actionPattern)[1].toLowerCase() === 'analyze',
  'PDCA action is extractable from the resolved text');
assert('SE-013', !/Match Rate: 3%/.test(resolved),
  'The thinking block cannot supply a competing match rate');

fs.rmSync(tmpDir, { recursive: true, force: true });

// --- G-2: unmeasured stays unmeasured through the iterator ---

const iterSrc = read('scripts/iterator-stop.js');
assert('SE-014', !/featureStatus\?\.matchRate \|\| 0/.test(iterSrc),
  'iterator-stop no longer fabricates 0 from an unmeasured stored rate');
assert('SE-015', /matchRateRules\.isMeasured\(featureStatus\?\.matchRate\)/.test(iterSrc),
  'iterator-stop routes the stored rate through isMeasured');
assert('SE-016', !/matchRate >= threshold\b/.test(iterSrc.replace(/const matchRateReached[^\n]*\n/, '')),
  'Threshold comparisons go through the measured guard, not the raw value');
assert('SE-017', !/\$\{matchRate\}%/.test(iterSrc),
  'User-facing text renders "not measured" rather than "null%"');

// isMeasured(0) is true — which is precisely why the fabricated zero was
// dangerous: it passed every downstream "did we measure this?" check.
assert('SE-018', matchRateRules.isMeasured(0) === true,
  'isMeasured(0) is true, so a fabricated 0 would have read as a real measurement');
assert('SE-019', matchRateRules.isMeasured(null) === false,
  'null is the honest representation of unmeasured');
assert('SE-020', matchRateRules.format(null) === 'not measured',
  'format() states the absence instead of inventing a number');

// --- G-3: action falls back to recorded phase ---

const skillSrc = read('scripts/pdca-skill-stop.js');
assert('SE-021', /PHASE_TO_ACTION/.test(skillSrc) && /actionFromPhase\(\)/.test(skillSrc),
  'pdca-skill-stop derives the action from recorded phase when the text is silent');
assert('SE-022', /check:\s*'analyze'/.test(skillSrc) && /act:\s*'iterate'/.test(skillSrc),
  'Phase names map to their action names, not to themselves');

// --- All three still parse and still refuse to run as bare requires ---

HANDLERS.forEach((rel, i) => {
  const n = String(i + 23).padStart(3, '0');
  let ok = true;
  try {
    execFileSync('node', ['--check', path.join(REPO, rel)], { timeout: 15000 });
  } catch (_) {
    ok = false;
  }
  assert(`SE-${n}`, ok, `${path.basename(rel)} parses`);
});

HANDLERS.forEach((rel, i) => {
  const src = read(rel);
  const n = String(i + 26).padStart(3, '0');
  /*
   * SE-026 amendment (fix-br-report-strand-wave): gap-detector-stop.js no
   * longer uses the literal `{ module.exports = {}; return; }` form. Since
   * bugfix-wave-20260919 §3 Fix 4 (d2f5fa5) it exports its PURE HELPERS on
   * the require path (`module.exports = { parseMatchRate, ... }`) and runs
   * the hook body in an else-branch — that is why test/unit/
   * gap-detector-stop-parsing.test.js can require it at all. The guard's
   * contract is "require() must not execute the hook body", and both forms
   * satisfy it; what the regression must never let drift away is the
   * `require.main !== module` fork itself.
   */
  assert(`SE-${n}`, /if \(require\.main !== module\)/.test(src),
    `${path.basename(rel)} keeps its bare-require guard`);
});

// --- Summary ---
console.log(`\nResults: ${passed}/${total} passed, ${failed} failed, ${skipped} skipped`);
if (failures.length > 0) {
  console.log('Failures:');
  failures.forEach(f => console.log(`  - ${f.id}: ${f.message}`));
}

module.exports = { passed, failed, total, skipped, failures };
