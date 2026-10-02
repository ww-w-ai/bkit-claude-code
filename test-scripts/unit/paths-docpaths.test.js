/**
 * paths-docpaths.test.js — br009/br011 (fix-br008-011-loop-wave, D2)
 *
 * DEFAULT_DOC_PATHS must resolve bilingual (.en.md/.ko.md) phase docs as a
 * FALLBACK, so findDoc('report', feature) succeeds in projects that carry no
 * bkit.config.json docPaths of their own. Before this fix the defaults listed
 * only legacy single-file names, findDoc returned '' for bilingual reports,
 * and the br005a report→completed Stop clause failed closed — stranding the
 * cycle at phase=report (E-ARCH-GATE on archive, operator re-fires).
 *
 * Isolation: every test builds its own os.tmpdir() fixture and points BOTH
 * CLAUDE_PROJECT_DIR and CLAUDE_PLUGIN_ROOT at it, so config loading finds
 * no bkit.config.json anywhere and DEFAULT_DOC_PATHS is the effective list.
 * The real .bkit/ and the real docs/ tree are never touched. platform.js and
 * cache.js capture state at module load, so each fixture re-requires the
 * modules fresh via jest.resetModules().
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PATHS_MODULE = path.join(REPO_ROOT, 'lib', 'core', 'paths');
const PHASE_MODULE = path.join(REPO_ROOT, 'lib', 'pdca', 'phase');

const fixtures = [];
const savedEnv = {};

beforeAll(() => {
  for (const key of ['CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT']) {
    savedEnv[key] = process.env[key];
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* tmpdir residue is harmless */ }
  }
});

/**
 * Build an isolated fixture project with NO bkit.config.json (defaults active)
 * and return { proj, paths, phase } with freshly-required modules bound to it.
 */
function makeFixture() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'br009-paths-'));
  fixtures.push(proj);
  process.env.CLAUDE_PROJECT_DIR = proj;
  process.env.CLAUDE_PLUGIN_ROOT = proj; // no config here either -> DEFAULT_DOC_PATHS
  jest.resetModules();
  const paths = require(PATHS_MODULE);
  const phase = require(PHASE_MODULE);
  return { proj, paths, phase };
}

function writeDoc(proj, relPath) {
  const abs = path.join(proj, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '# fixture doc\n');
  return abs;
}

describe('DEFAULT_DOC_PATHS bilingual fallback (br009/br011)', () => {
  test('findDoc resolves docs/04-report/features/X.report.en.md with no config and no legacy file', () => {
    const { proj, paths } = makeFixture();
    const expected = writeDoc(proj, 'docs/04-report/features/fix-x.report.en.md');
    expect(paths.findDoc('report', 'fix-x')).toBe(expected);
  });

  test('findDoc resolves the .ko.md sibling when only it exists', () => {
    const { proj, paths } = makeFixture();
    const expected = writeDoc(proj, 'docs/04-report/features/fix-x.report.ko.md');
    expect(paths.findDoc('report', 'fix-x')).toBe(expected);
  });

  test('findDoc resolves flat-dir report variants (docs/04-report/X.report.en.md)', () => {
    const { proj, paths } = makeFixture();
    const expected = writeDoc(proj, 'docs/04-report/fix-x.report.ko.md');
    expect(paths.findDoc('report', 'fix-x')).toBe(expected);
  });

  test('findPlanDoc resolves .plan.en.md through lib/pdca/phase (shouldUpdate gate path)', () => {
    const { proj, phase } = makeFixture();
    const expected = writeDoc(proj, 'docs/01-plan/features/fix-x.plan.en.md');
    expect(phase.findPlanDoc('fix-x')).toBe(expected);
  });

  test('findDesignDoc resolves .design.ko.md through lib/pdca/phase (shouldUpdate gate path)', () => {
    const { proj, phase } = makeFixture();
    const expected = writeDoc(proj, 'docs/02-design/features/fix-x.design.ko.md');
    expect(phase.findDesignDoc('fix-x')).toBe(expected);
  });

  test('findDoc resolves flat pm .prd.en.md (this repo docs/00-pm shape)', () => {
    const { proj, paths } = makeFixture();
    const expected = writeDoc(proj, 'docs/00-pm/fix-x.prd.en.md');
    expect(paths.findDoc('pm', 'fix-x')).toBe(expected);
  });
});

describe('DEFAULT_DOC_PATHS legacy regression (legacy names stay canonical)', () => {
  // The pre-br009 arrays, verbatim. Legacy entries must remain, unchanged and
  // first, in the same order — bilingual variants are appended after only.
  const LEGACY = {
    pm: [
      'docs/00-pm/features/{feature}.prd.md',
      'docs/00-pm/{feature}.prd.md',
    ],
    plan: [
      'docs/01-plan/features/{feature}.plan.md',
      'docs/01-plan/{feature}.plan.md',
      'docs/plan/{feature}.md',
    ],
    design: [
      'docs/02-design/features/{feature}.design.md',
      'docs/02-design/{feature}.design.md',
      'docs/design/{feature}.md',
    ],
    analysis: [
      'docs/03-analysis/{feature}.analysis.md',
      'docs/03-analysis/features/{feature}.analysis.md',
      'docs/03-analysis/{feature}.gap-analysis.md',
    ],
    qa: [
      'docs/05-qa/{feature}.qa-report.md',
      'docs/05-qa/{feature}.test-plan.md',
    ],
    report: [
      'docs/04-report/features/{feature}.report.md',
      'docs/04-report/{feature}.report.md',
      'docs/04-report/{feature}.completion-report.md',
    ],
  };

  test.each(Object.entries(LEGACY))('%s: legacy entries unchanged and first', (phaseKey, legacy) => {
    const { paths } = makeFixture();
    const effective = paths.getDocPaths()[phaseKey];
    expect(Array.isArray(effective)).toBe(true);
    expect(effective.slice(0, legacy.length)).toEqual(legacy);
  });

  test('legacy-named report fixture still resolves', () => {
    const { proj, paths } = makeFixture();
    const expected = writeDoc(proj, 'docs/04-report/features/old-school.report.md');
    expect(paths.findDoc('report', 'old-school')).toBe(expected);
  });

  test('legacy name wins over bilingual sibling when both exist (canonical order)', () => {
    const { proj, paths } = makeFixture();
    const legacy = writeDoc(proj, 'docs/01-plan/features/both-worlds.plan.md');
    writeDoc(proj, 'docs/01-plan/features/both-worlds.plan.en.md');
    expect(paths.findDoc('plan', 'both-worlds')).toBe(legacy);
  });
});
