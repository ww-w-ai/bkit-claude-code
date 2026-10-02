/**
 * br290 regression: a fire-time recording (session.lastSkillFeature) naming a
 * feature ABSENT from the registry is proof the cycle completed (archive
 * deletes the feature). The Stop binding must bind to NOTHING — never fall
 * through to primaryFeature (the phantom-rebind defect behind the ZfeatA
 * "execute /pdca design" Stop blocks).
 *
 * Pure-resolver assertions on lib/pdca/stop-binding (no fs); the registry
 * shape mirrors the live v3 schema. The real registry is never touched.
 */
const {
  resolveStopFeature,
  isDeadRecordedFeature,
} = require('../../lib/pdca/stop-binding');

const registry = (lastSkillFeature, features, primaryFeature) => ({
  session: { lastSkillFeature: lastSkillFeature },
  features,
  primaryFeature,
});

describe('br290 dead-record no-rebind guard', () => {
  test('T1: dead recording + phantom primary binds to NOTHING (null sentinel)', () => {
    // Live br290 failure shape: br288 feature archived out (dead record),
    // ZfeatA fixture left as primaryFeature (phase=plan, no docs).
    const status = registry('fix-br288-terminal-guard', { ZfeatA: { phase: 'plan' } }, 'ZfeatA');
    expect(resolveStopFeature({ currentStatus: status, activeSkill: 'design' })).toBeNull();
  });

  test('T2: live recording still binds tier-0 (br015b intact)', () => {
    const status = registry('fix-br290-stop-fallthrough', {
      'fix-br290-stop-fallthrough': { phase: 'do' },
      ZfeatA: { phase: 'plan' },
    }, 'ZfeatA');
    expect(resolveStopFeature({ currentStatus: status, activeSkill: 'do' }))
      .toBe('fix-br290-stop-fallthrough');
  });

  test('T3: no recording + primary exists → primary fallback intact (br006)', () => {
    const status = registry('', { otherFeature: { phase: 'plan' } }, 'otherFeature');
    expect(resolveStopFeature({ currentStatus: status, activeSkill: 'plan' }))
      .toBe('otherFeature');
  });

  test('isDeadRecordedFeature edge cases', () => {
    expect(isDeadRecordedFeature('gone', {})).toBe(true);
    expect(isDeadRecordedFeature('gone', null)).toBe(true);
    expect(isDeadRecordedFeature('alive', { alive: {} })).toBe(false);
    expect(isDeadRecordedFeature('', { a: 1 })).toBe(false);
    expect(isDeadRecordedFeature(undefined, {})).toBe(false);
  });
});
