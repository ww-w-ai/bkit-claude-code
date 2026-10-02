/**
 * Hook Reachability Evaluator (Issue #126 — v2.1.24)
 *
 * Pure classifier for `.bkit/runtime/hook-reachability.json`, extracted from the
 * SessionStart MON-CC-NEW-PLUGIN-HOOK-DROP monitor so the drop-vs-idle decision
 * is unit-testable in isolation (session-start.js does IO; this does not).
 *
 * ## The monitor and its false positive
 * Each PostToolUse hook stamps its timestamp here on every fire. SessionStart
 * reads the file to catch CC silently dropping the plugin PostToolUse loader
 * (#57317). But the three stamps are not equal in meaning:
 *
 *   - CANARY hooks (bash_post, write_post) fire on nearly every turn — Bash and
 *     Write are ubiquitous. A missing/stale canary during an active session is
 *     real evidence of a dropped loader.
 *   - EVENT-DRIVEN hooks (skill_post) fire ONLY on a `PostToolUse(Skill)`
 *     tool_use. bkit's own documented workflow invokes skills via slash commands
 *     (`/pdca plan`), which never produce a Skill tool_use — so skill_post
 *     legitimately never fires, and a missing/stale stamp means "idle", not
 *     "dropped" (#126).
 *
 * ## Rule
 * Report an event-driven hook only when a canary is ALSO unhealthy — a genuine
 * loader drop (#57317) takes down all three together, so correlated failure is
 * the reliable signal. When the canaries are healthy, an absent skill_post is
 * suppressed. This keeps the monitor's real purpose intact while eliminating the
 * chronic per-session false positive that eroded trust in the warning.
 *
 * @module lib/core/hook-reachability
 * @version 2.1.24
 * @since 2.1.24
 */

'use strict';

/** Hooks that fire on nearly every turn — reliable drop canaries. */
const CANARY_KEYS = ['bash_post', 'write_post'];
/** Hooks that fire only on their specific tool_use — may legitimately never fire. */
const EVENT_DRIVEN_KEYS = ['skill_post'];
/** Default recency window: a stamp older than this is "stale". */
const DEFAULT_STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Classify a hook-reachability state into drop vs. idle findings.
 *
 * @param {Object} state - Parsed hook-reachability.json (key → { ts }).
 * @param {Object} [opts]
 * @param {number} [opts.now] - Reference epoch ms (defaults to Date.now()).
 * @param {number} [opts.staleThresholdMs] - Recency window (defaults to 14 days).
 * @returns {{
 *   expected: string[],
 *   missing: string[],
 *   stale: string[],
 *   canaryUnhealthy: boolean,
 *   skillPostIdle: boolean,
 *   shouldWarn: boolean
 * }} `missing`/`stale` are the EFFECTIVE (post-suppression) findings the caller
 *   should surface; `shouldWarn` is true iff either is non-empty.
 */
function evaluateReachability(state, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const staleMs = Number.isFinite(opts.staleThresholdMs)
    ? opts.staleThresholdMs
    : DEFAULT_STALE_THRESHOLD_MS;
  const src = state && typeof state === 'object' ? state : {};
  const expected = [...CANARY_KEYS, ...EVENT_DRIVEN_KEYS];

  let missing = [];
  let stale = [];
  for (const key of expected) {
    const entry = src[key];
    if (!entry || typeof entry.ts !== 'string') { missing.push(key); continue; }
    const t = Date.parse(entry.ts);
    if (Number.isNaN(t) || (now - t) > staleMs) stale.push(key);
  }

  // #126: only trust an event-driven finding when a canary corroborates a drop.
  const canaryUnhealthy = [...missing, ...stale].some((k) => CANARY_KEYS.includes(k));
  let skillPostIdle = false;
  if (!canaryUnhealthy) {
    const before = missing.length + stale.length;
    missing = missing.filter((k) => !EVENT_DRIVEN_KEYS.includes(k));
    stale = stale.filter((k) => !EVENT_DRIVEN_KEYS.includes(k));
    skillPostIdle = missing.length + stale.length < before;
  }

  return {
    expected,
    missing,
    stale,
    canaryUnhealthy,
    skillPostIdle,
    shouldWarn: missing.length > 0 || stale.length > 0,
  };
}

/**
 * Build the SessionStart hook-reachability warning text.
 *
 * fix-preflight-hookdrop-mislead (2026-09-19): the original short form was fused
 * by a consuming session with the CC-version known-issue advisory into
 * "newer CC version ⇒ hook drop ⇒ registry stall" (invalid br004). The text now
 * names its own evidence file and the canary rule: FRESH bash_post/write_post
 * stamps mean hooks ARE firing, so a stalled PDCA registry while canaries are
 * fresh points at skipped `/pdca <phase>` skill fires, not a hook drop.
 * Pure string builder — no IO — so it is unit-testable without spawning CC.
 *
 * @param {string[]} missing
 * @param {string[]} stale
 * @param {string} reachFile - absolute path of hook-reachability.json (evidence)
 * @returns {string}
 */
function buildReachabilityWarning(missing, stale, reachFile) {
  return '\n⚠️  bkit hook reachability check: missing=[' + missing.join(',') + '] stale=['
    + stale.join(',') + ']. CC plugin-hook drop (#57317) suspected — evidence: '
    + reachFile + ' (a real drop takes the bash_post/write_post canaries down too; FRESH canary '
    + 'stamps mean hooks ARE firing — if a PDCA registry is stalled while canaries are fresh, '
    + 'suspect skipped /pdca <phase> skill fires, not a hook drop). '
    + 'See docs/sprint/v2114 MON-CC-NEW-PLUGIN-HOOK-DROP.';
}

module.exports = {
  evaluateReachability,
  buildReachabilityWarning,
  CANARY_KEYS,
  EVENT_DRIVEN_KEYS,
  DEFAULT_STALE_THRESHOLD_MS,
};
