/**
 * stop-report-completion.test.js — br005a regression lock.
 *
 * Contract: after a Stop whose action is 'report', scripts/pdca-skill-stop.js
 * advances a feature stranded at phase=report to phase=completed through the
 * sanctioned writer (updatePdcaStatus), WITHOUT depending on the CC Task
 * system. Guards (fail closed):
 *   - the feature's current phase must be 'report',
 *   - the report doc must exist on disk (findDoc — the same check the archive
 *     CLI's docs arm makes).
 *
 * The spawn shape follows test/contract/v2122-stop-hook-output-schema.test.js:
 * the hook script is an entrypoint (require-guards + process.exit), so each
 * case runs it as a subprocess with a temp CLAUDE_PROJECT_DIR seeded with a
 * minimal registry. The seeded feature deliberately has NO plan/design docs so
 * the issue-#89 requireDocs gate blocks the script's main status update — the
 * br005a clause (requireDocs:false) is then the ONLY path that could advance
 * the phase. That makes each assertion a true test: a revert of the clause
 * turns TC1 RED (phase stays 'report'), and TC2 proves the doc-on-disk guard
 * is load-bearing rather than decorative.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const REPO = path.resolve(__dirname, '../..');
const HOOK = path.join(REPO, 'scripts', 'pdca-skill-stop.js');

const REPORT_DOC_REL = 'docs/04-report/features/stranded-report.report.md';

function makeProject(featureName, { withReportDoc }) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-stop-completion-'));
  const statusDir = path.join(projectDir, '.bkit', 'state');
  fs.mkdirSync(statusDir, { recursive: true });

  const status = {
    version: '2.0',
    lastUpdated: new Date().toISOString(),
    activeFeatures: [featureName],
    primaryFeature: featureName,
    features: {
      [featureName]: {
        phase: 'report',
        phaseNumber: 7,
        matchRate: null,
        iterationCount: 0,
        requirements: [],
        documents: {},
        timestamps: { started: new Date().toISOString() },
      },
    },
    pipeline: { currentPhase: 1, level: 'Dynamic', phaseHistory: [] },
    session: { startedAt: new Date().toISOString(), onboardingCompleted: true },
    history: [],
  };
  fs.writeFileSync(path.join(statusDir, 'pdca-status.json'), JSON.stringify(status, null, 2));

  if (withReportDoc) {
    const docPath = path.join(projectDir, REPORT_DOC_REL);
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, `# ${featureName} report\n`);
  }
  return projectDir;
}

function readFeaturePhase(projectDir, featureName) {
  const raw = JSON.parse(
    fs.readFileSync(path.join(projectDir, '.bkit', 'state', 'pdca-status.json'), 'utf8')
  );
  return raw.features?.[featureName]?.phase ?? null;
}

function runHook(projectDir, featureName) {
  // The payload text must carry the skill invocation ("pdca report ...") so
  // actionMatch resolves action='report' — the same signal a real skill fire
  // leaves in the Stop input.
  const payload = JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 'br005a-test',
    cwd: projectDir,
    agent_output: `Completed /pdca report ${featureName}. Report written to ${REPORT_DOC_REL}.`,
  });
  return spawnSync('node', [HOOK], {
    input: payload,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

test('br005a-TC1 — phase=report + report doc on disk → registry advances to completed', () => {
  const projectDir = makeProject('stranded-report', { withReportDoc: true });
  const r = runHook(projectDir, 'stranded-report');

  assert.equal(r.status, 0, `hook exit=${r.status}, stderr=${r.stderr}`);
  const phase = readFeaturePhase(projectDir, 'stranded-report');
  assert.equal(phase, 'completed',
    'report→completed must advance via updatePdcaStatus without the Task system '
    + '(was the br005 strand: phase frozen at report, E-ARCH-GATE forever)');
});

test('br005a-TC2 — phase=report + report doc MISSING → NO advance (fail closed)', () => {
  const projectDir = makeProject('no-report-doc', { withReportDoc: false });
  const r = runHook(projectDir, 'no-report-doc');

  assert.equal(r.status, 0, `hook exit=${r.status}, stderr=${r.stderr}`);
  const phase = readFeaturePhase(projectDir, 'no-report-doc');
  assert.equal(phase, 'report',
    'without the report doc on disk the completion clause must not fire '
    + '(a Stop that merely mentions "report" is not evidence the phase ran)');
});
