/**
 * br293 regression: the archive CLI must move EVERY doc variant per phase,
 * not just findDoc's first hit. Bilingual cycles (en+ko sibling pairs —
 * mandated by the project CLAUDE.md for new docs/) used to archive one
 * sibling and strand the other in the source directory; agents had to move
 * the leftovers by hand to keep the cycle's archive set together.
 *
 *   T1  bilingual en+ko pairs for plan/design/report (+ optional analysis
 *       en+ko) -> --apply moves ALL of them; nothing left in source dirs;
 *       docsMoved lists every file.
 *   T2  monolingual feature (plain .md only) still archives — the multi
 *       collector did not break the single-doc case.
 *   T3  gate semantics unchanged: a phase with NO variant still counts as
 *       missing (report absent -> E-ARCH-DOCS, nothing moved).
 *
 * Registry writes and doc moves happen in a throwaway os.tmpdir() sandbox
 * via CLAUDE_PROJECT_DIR isolation — the project's own registry is never
 * touched. Registry fixtures carry version '3.0' (migrator pitfall, see
 * br290b test header).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'pdca-archive.js');

const DOC_FILES = {
  plan: 'docs/01-plan/features',
  design: 'docs/02-design/features',
  analysis: 'docs/03-analysis',
  report: 'docs/04-report/features',
};

function seedRegistry(tmp, feature) {
  const stateDir = path.join(tmp, '.bkit', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'pdca-status.json'), JSON.stringify({
    version: '3.0',
    session: {
      startedAt: new Date().toISOString(), onboardingCompleted: true,
      lastActivity: new Date().toISOString(),
    },
    features: { [feature]: { phase: 'completed' } },
    primaryFeature: feature,
    activeFeatures: [feature],
  }));
}

function seedDoc(tmp, feature, phase, suffix) {
  const dir = path.join(tmp, DOC_FILES[phase]);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${feature}.${phase}${suffix}`);
  fs.writeFileSync(file, `# ${feature} ${phase}${suffix}\n`);
  return file;
}

function runCli(feature, tmp) {
  try {
    return {
      status: 0,
      out: execFileSync('node', [CLI, feature, '--apply'], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmp }, cwd: tmp, encoding: 'utf8',
      }),
    };
  } catch (err) {
    return { status: err.status, out: err.stdout || '', err: err.stderr || '' };
  }
}

describe('br293: archive CLI moves every doc variant per phase', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkit-br293-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  test('T1 bilingual en+ko pairs all moved, nothing stranded', () => {
    const feature = 'bi-feature';
    seedRegistry(tmp, feature);
    const seeded = [];
    for (const phase of ['plan', 'design', 'analysis', 'report']) {
      seeded.push(seedDoc(tmp, feature, phase, '.en.md'));
      seeded.push(seedDoc(tmp, feature, phase, '.ko.md'));
    }
    const r = runCli(feature, tmp);
    expect(r.status).toBe(0);
    const result = JSON.parse(r.out.slice(r.out.indexOf('{')));
    expect(result.archived).toBe(true);
    expect(result.docsMoved.sort()).toEqual(seeded.map((f) => path.basename(f)).sort());
    // Nothing stranded in the source directories.
    for (const f of seeded) expect(fs.existsSync(f)).toBe(false);
    // Everything landed in the archive dir.
    for (const base of seeded.map((f) => path.basename(f))) {
      expect(fs.existsSync(path.join(result.archivePath, base))).toBe(true);
    }
  });

  test('T2 monolingual feature (plain .md) still archives', () => {
    const feature = 'mono-feature';
    seedRegistry(tmp, feature);
    for (const phase of ['plan', 'design', 'report']) {
      seedDoc(tmp, feature, phase, '.md');
    }
    const r = runCli(feature, tmp);
    expect(r.status).toBe(0);
    const result = JSON.parse(r.out.slice(r.out.indexOf('{')));
    expect(result.archived).toBe(true);
    expect(result.docsMoved).toHaveLength(3);
  });

  test('T3 phase with no variant still gates (E-ARCH-DOCS, nothing moved)', () => {
    const feature = 'gated-feature';
    seedRegistry(tmp, feature);
    const plan = seedDoc(tmp, feature, 'plan', '.en.md');
    const design = seedDoc(tmp, feature, 'design', '.en.md');
    // report intentionally absent
    const r = runCli(feature, tmp);
    expect(r.status).toBe(4); // EXIT.DOCS
    expect(r.out).toContain('E-ARCH-DOCS');
    expect(fs.existsSync(plan)).toBe(true);
    expect(fs.existsSync(design)).toBe(true);
  });
});
