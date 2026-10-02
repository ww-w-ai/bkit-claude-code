/**
 * Skill Invocation Effects (Issue #132 — v2.1.27)
 *
 * Shared orchestrator side-effect glue for BOTH skill invocation paths:
 *   - MODEL path:  PostToolUse(Skill) → scripts/skill-post.js  (source: 'skill-tool')
 *   - SLASH path:  UserPromptExpansion → scripts/user-prompt-expansion-handler.js
 *                                                              (source: 'slash-command')
 *
 * Before #132 the 4+1 orchestrator side-effects lived inline in skill-post.js
 * (lines 175-230). The native slash-command path silently bypassed all of them,
 * so bkit's advertised audit trail / decision trace / next-skill guidance was
 * empty for real users typing `/bkit:<skill>`. This module lifts that glue
 * VERBATIM (behavior-preserving for the Skill-tool path) and exposes it as a
 * single composition so both hook scripts fire the identical effects.
 *
 * Effects, in order:
 *   1. dedup guard (content-derived key, same-session) — I-10
 *   2. writeActiveSkill({skill})                        — repairs Stop dispatch (free win B, I-9)
 *   3. orchestrateSkillPost → suggestions
 *   4. writeAuditLog (action varies by source: skill_invoked | skill_executed) — I-7
 *   5. if pdca-phase: recordDecision(phase_transition) + updatePdcaStatus
 *
 * Pure composition of existing lib primitives (audit / decision / status /
 * core). Lives in lib/orchestrator (same tier as intent-router), not lib/domain,
 * so it may use fs directly — check-domain-purity only scans lib/domain/**.
 *
 * @module lib/orchestrator/skill-invocation-effects
 * @version 2.1.27
 * @since 2.1.27
 */

'use strict';

const fs = require('fs');
const path = require('path');

const orch = require('../skill-orchestrator');
const { writeActiveSkill } = require('../core/active-skill-marker');
const { getPdcaStatusFull, updatePdcaStatus } = require('../pdca/status');

/**
 * Resolve the `.bkit/runtime/last-invocation-key` marker path.
 * Mirrors the reachability-ping / active-skill-marker root resolution.
 * @param {string} [projectRoot]
 * @returns {string}
 */
function lastInvocationKeyPath(projectRoot) {
  const root = (typeof projectRoot === 'string' && projectRoot.length > 0)
    ? projectRoot
    : (process.env.CLAUDE_PROJECT_DIR || process.cwd());
  return path.join(root, '.bkit', 'runtime', 'last-invocation-key');
}

/**
 * Dedup guard (I-10). Content-derived key (session_id:skill:action:feature) is
 * comparable across BOTH payloads. Returns true when the key is identical to
 * the last processed key within the same session (→ caller should skip). When
 * the key is new (or dedup disabled), records it and returns false.
 *
 * Best-effort: any FS error falls through to "not a duplicate" so a marker
 * failure never suppresses the real effects.
 *
 * @param {string} dedupeKey
 * @param {string} [projectRoot]
 * @returns {boolean} true if this key was already processed (skip)
 */
function isDuplicateInvocation(dedupeKey, projectRoot) {
  if (!dedupeKey) return false;
  try {
    const p = lastInvocationKeyPath(projectRoot);
    let last = null;
    try {
      last = fs.readFileSync(p, 'utf8').trim();
    } catch (_e) { /* no prior marker */ }
    if (last === dedupeKey) return true;
    // Record the new key (atomic write).
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, dedupeKey);
    fs.renameSync(tmp, p);
    return false;
  } catch (_e) {
    // Non-fatal — proceed with effects rather than risk suppressing them.
    return false;
  }
}

/**
 * Router action tokens recognized for the session-recorded
 * lastSkillAction/lastSkillFeature pair (br018). Order-insensitive set;
 * superset of stop-binding's ACTION_TO_PHASE keys because read-like
 * actions (status/next/team/cleanup/archive) are still legitimate fires.
 * @constant
 */
const ROUTER_ACTION_TOKENS = new Set([
  'pm', 'plan', 'design', 'do', 'analyze', 'check', 'iterate', 'qa',
  'report', 'archive', 'cleanup', 'team', 'status', 'next',
]);

/**
 * Parse the invocation args into { action, feature } for session recording
 * (br018). Accepts BOTH caller shapes:
 *   - object form (both hook callers): { action, feature } — validated
 *     against the token set; an unrecognized action is ignored.
 *   - raw string form (defensive): 'report fix-x --scope y' — action is the
 *     first token matching the action set; feature is the next non-flag
 *     token after it.
 * @param {string|{action?: string, feature?: string}} args
 * @returns {{action: string, feature: (string|null)}|null} null when no
 *   recognizable action token exists (nothing gets recorded).
 */
function parseSessionSkillArgs(args) {
  if (typeof args === 'string') {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const idx = tokens.findIndex((t) => ROUTER_ACTION_TOKENS.has(t.toLowerCase()));
    if (idx === -1) return null;
    const action = tokens[idx].toLowerCase();
    const feature = tokens.slice(idx + 1).find((t) => !t.startsWith('-')) || null;
    return { action, feature };
  }
  if (args && typeof args === 'object') {
    const action = typeof args.action === 'string' && ROUTER_ACTION_TOKENS.has(args.action.toLowerCase())
      ? args.action.toLowerCase()
      : null;
    if (!action) return null;
    const feature = typeof args.feature === 'string' && args.feature && !args.feature.startsWith('-')
      ? args.feature
      : null;
    return { action, feature };
  }
  return null;
}

/**
 * Run the shared skill-invocation side-effects.
 *
 * @param {string} skillName - Canonical (bare) skill name — callers normalize
 *   the `plugin:skill` form before passing.
 * @param {{action?: string, feature?: string}} args - Parsed invocation args.
 * @param {{source: 'slash-command'|'skill-tool', dedupeKey?: string, projectRoot?: string}} opts
 * @returns {Promise<{suggestions: Object, deduped?: boolean}>}
 */
async function runSkillInvocationEffects(skillName, args, opts) {
  const options = opts || {};
  const source = options.source;
  const invocationArgs = args || {};

  // 1. Dedup guard (I-10). Skip everything if the identical key was already
  //    processed this session (defensive: slash & Skill-tool are normally
  //    mutually exclusive per logical invocation).
  if (isDuplicateInvocation(options.dedupeKey, options.projectRoot)) {
    return { suggestions: {}, deduped: true };
  }

  // 2. Active-skill marker (free win B, I-9): written on BOTH paths → repairs
  //    the Stop SKILL_HANDLERS dispatch for non-sprint slash skills.
  writeActiveSkill({ skill: skillName });

  // 3. Orchestration → next-step suggestions (STATIC frontmatter resolution).
  const result = await orch.orchestrateSkillPost(skillName, {}, { args: invocationArgs });
  let suggestions = (result && result.suggestions) || {};

  // 3b. #135 — runtime-phase-aware guidance for multi-action router skills.
  //     orchestrateSkillPost resolves ONLY the static frontmatter fields
  //     (next-skill/pdca-phase); the flagship routers pdca/sprint declare both
  //     null by design, so `suggestions` is empty here and no guidance ever
  //     reaches the user. Enrich from LIVE PDCA/Sprint state, reusing the same
  //     SSoT the manual /pdca next & /sprint phase paths use (no duplicated
  //     phase table). Guarded: only when frontmatter produced nothing, so
  //     single-purpose skills (deploy/code-review/plan-plus/...) are untouched.
  //     Fail-open: any error leaves `suggestions` as-is.
  if (!suggestions || Object.keys(suggestions).length === 0) {
    try {
      const { resolveRuntimeGuidance } = require('./runtime-guidance');
      const runtime = resolveRuntimeGuidance(skillName, invocationArgs);
      if (runtime && Object.keys(runtime).length > 0) {
        suggestions = runtime;
      }
    } catch (_) { /* fail-open — never block a slash command */ }
  }

  // 4. Audit logging. Action string varies by invocation source (I-7):
  //    slash-command → 'skill_invoked'; skill-tool → 'skill_executed'.
  //    Both flow through the audit-logger pass-through path (neither is in
  //    ACTION_TYPES; category 'skill' normalizes to 'control'). Rest of the
  //    fields match skill-post.js verbatim.
  try {
    const audit = require('../audit/audit-logger');
    audit.writeAuditLog({
      actor: 'system', actorId: 'skill-post',
      action: source === 'slash-command' ? 'skill_invoked' : 'skill_executed',
      category: 'skill',
      target: skillName, targetType: 'skill',
      result: 'success', destructiveOperation: false
    });
  } catch (_) { /* non-critical — best-effort write, failure is tolerated */ }

  // 5. PDCA phase effects (gated on a resolvable phase).
  try {
    const skillCfg = orch.getSkillConfig(skillName);
    let phase = skillCfg && skillCfg['pdca-phase'];
    /*
     * Router action phases (2026-09-07, from work/pdca-skill-fire-test-results.md).
     *
     * The flagship `pdca` skill is a multi-action router that declares
     * `pdca-phase: null` BY DESIGN — the effective phase is the invocation's
     * ACTION token (`Skill(bkit:pdca, "design <feature>")`), which #135 already
     * resolves for GUIDANCE but which this step never consulted. Net effect:
     * every `/pdca <phase> <feature>` fire was detected (audit line, guidance,
     * lastUpdated) while the phase write was structurally unreachable — new
     * features never registered and phases never advanced via the hook path.
     *
     * Reuse PDCA_ACTION_PHASES — the same SSoT set runtime-guidance uses — so
     * ONLY explicit phase-advancing actions write; read-like actions
     * (next/status/iterate/analyze) still resolve to the live phase and must
     * not stamp a no-op transition back into history.
     */
    let routerPhase = null;
    if (!phase && skillName === 'pdca' && invocationArgs.action) {
      const { PDCA_ACTION_PHASES } = require('./runtime-guidance');
      /*
       * Action tokens that are phase names map directly (plan → plan).
       * Two router actions name a DIFFERENT phase than their token
       * (`/pdca analyze` runs the CHECK phase; `/pdca iterate` runs ACT).
       * `archive` is deliberately absent: flipping to `archived` at fire
       * time would precede the report-completion verification the archive
       * flow performs first, so archive keeps its explicit registry write.
       */
      const ROUTER_ACTION_PHASE_ALIASES = { analyze: 'check', iterate: 'act' };
      if (PDCA_ACTION_PHASES.has(invocationArgs.action)) {
        routerPhase = invocationArgs.action;
        phase = routerPhase;
      } else if (ROUTER_ACTION_PHASE_ALIASES[invocationArgs.action]) {
        routerPhase = ROUTER_ACTION_PHASE_ALIASES[invocationArgs.action];
        phase = routerPhase;
      }
    }
    if (phase) {

      // 5a. Decision trace — phase transition.
      try {
        const dt = require('../audit/decision-tracer');
      /*
       * v2.1.34: `primaryFeature`, not `currentFeature`.
       *
       * `currentFeature` is a v1 schema key. The v3 migration renamed it
       * (lib/pdca/status-migration.js:74), so reading it on a live status object
       * always yields undefined — the fallback silently resolved to nothing and
       * the orchestrator lost its feature context. `scripts/pre-write.js:100`
       * already carried a note saying exactly this; three other call sites were
       * never updated.
       */
        const feature = invocationArgs.feature || getPdcaStatusFull()?.primaryFeature || '';
        dt.recordDecision({
          feature,
          phase,
          decisionType: 'phase_transition',
          question: `Skill ${skillName} completed - advance PDCA phase?`,
          chosenOption: `Advance to ${phase}`,
          rationale: routerPhase
            ? `Router action '${routerPhase}' advances the phase (skill declares pdca-phase: null)`
            : `Skill ${skillName} maps to pdca-phase ${phase}`,
          confidence: 0.9,
          impact: 'medium',
          affectedFiles: [],
          reversible: true
        });
      } catch (_) { /* non-critical — best-effort write, failure is tolerated */ }

      // 5b. PDCA status update. Static-phase skills keep the requireDocs gate
      // (issue #89 — no phase jumps without evidence). Router fires pass
      // requireDocs:false: the phase's docs are its OUTPUT and cannot exist at
      // fire time for a new feature, and the explicit phase-action fire IS the
      // authorization — this mirrors the unconditional registry update the
      // skill's own steps prescribe, now routed through the sanctioned writer
      // instead of a hand edit agents were told to make.
      // Same v1-schema key as above — see the note there.
      const feature = invocationArgs.feature || getPdcaStatusFull()?.primaryFeature;
      if (feature) {
        updatePdcaStatus(feature, phase, {}, routerPhase ? { requireDocs: false } : {});
      }
    }
  } catch (_) { /* non-critical — best-effort write, failure is tolerated */ }

  // 6. Session block (br015): record lastSkill/lastAgent so the Stop hook's
  // legacy fallback (unified-stop getActiveSkill → session.lastSkill) resolves
  // the most recent fire. Sanctioned lib/pdca write path (load → mutate →
  // save, same shape as the lastActivity stamp in status-migration) — raw
  // state-file edits are blocked by G-019/G-020.
  //
  // br018: also record lastSkillAction/lastSkillFeature from the invocation
  // args. The Stop handler's tier-2 binding needs the ACTION (to map
  // ACTION_TO_PHASE) and the FEATURE (to bind the transition to the fired
  // feature, not a foreign primaryFeature) — neither was recorded, so router
  // fires like `Skill(bkit:pdca, "report fix-x")` never advanced. The parse
  // helper accepts the object form both hook callers pass and the raw string
  // form; only recognized action tokens record (action-only fires record
  // lastSkillAction alone).
  try {
    const { savePdcaStatus } = require('../pdca/status');
    const { normalizeSkillName } = require('../core/skill-name');
    const current = getPdcaStatusFull(true);
    if (current) {
      if (!current.session) current.session = {};
      current.session.lastSkill = normalizeSkillName(skillName);
      const agentName = invocationArgs.agent || invocationArgs.subagent_type;
      if (agentName) current.session.lastAgent = agentName;
      const parsedSkillArgs = parseSessionSkillArgs(invocationArgs);
      if (parsedSkillArgs) {
        current.session.lastSkillAction = parsedSkillArgs.action;
        if (parsedSkillArgs.feature) {
          current.session.lastSkillFeature = parsedSkillArgs.feature;
        }
      }
      current.session.lastActivity = new Date().toISOString();
      savePdcaStatus(current);
    }
  } catch (_) { /* non-critical — best-effort write, failure is tolerated */ }

  return { suggestions };
}

module.exports = {
  runSkillInvocationEffects,
  // Exported for tests / white-box inspection.
  lastInvocationKeyPath,
  isDuplicateInvocation,
  parseSessionSkillArgs,
};
