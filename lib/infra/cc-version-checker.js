/**
 * cc-version-checker.js — Claude Code CLI version detection adapter (FR-α5)
 *
 * Reads the locally installed Claude Code CLI version via three strategies:
 *   0. Read the native-installer symlink `~/.local/bin/claude` (no subprocess)
 *   1. Spawn `claude --version` (subprocess, 500ms timeout)
 *   2. Fallback: read `~/.claude/claude/version.json`
 *
 * Strategy 0 was added in v2.1.32 (ENH-375) and is tried first because it costs
 * one `readlink` rather than a process spawn. Claude Code now ships as a ~264 MB
 * native binary, and starting it to print `--version` measured 302–327 ms on the
 * reference machine (5/5 runs) — enough to blow tight timeout budgets. The
 * native installer points `~/.local/bin/claude` at
 * `~/.local/share/claude/versions/<x.y.z>`, so the target's basename is the
 * active version. Absent on npm and Windows installs, hence a strategy rather
 * than a replacement.
 *
 * Compares against FEATURE_VERSION_MAP to surface inactive features so that
 * SessionStart hook can warn users when a feature requires a newer CC release.
 *
 * Fail-open by design: any error returns `null` and emits no warning, never
 * blocking the user's session.
 *
 * Security:
 *   - No shell escape required; argument list is fixed (`--version`).
 *   - File path is hardcoded under $HOME; no traversal.
 *   - No external network access.
 *
 * @module lib/infra/cc-version-checker
 * @version 2.1.11
 * @since 2.1.11
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SUBPROCESS_TIMEOUT_MS = 500;

/**
 * Minimum supported CC CLI version. Below this, bkit may misbehave.
 */
const MIN_VERSION = '2.1.78';

/**
 * Recommended CC CLI version — the current recommended runtime.
 *
 * Floor context: Claude 5 alias resolution (`sonnet` → Sonnet 5) needs CC ≥
 * 2.1.197. v2.1.218's `context: fork` background-by-default change is handled
 * (8 producer skills opt out via `background: false`; qa-phase left the fork
 * set). v2.1.32 raises this to 2.1.220 now that the two v2.1.219 exposures are
 * handled: nested subagent spawning at depth 3 by default (Stop-family cleanup
 * gated on `background_tasks`, roster keyed per instance, one-level dispatch
 * documented as bkit's own convention with `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`
 * offered for a deterministic bound) and the `opus` alias resolving to Opus 5.
 * v2.1.219 → 2.1.220 was verified as a no-op for every surface bkit integrates
 * against.
 *
 * Kept in sync with README (runtime recommendation) and at/above the hard
 * install floor (v2.1.143, strict plugin-manifest `displayName`).
 * NB: not added to FEATURE_VERSION_MAP — a changed default is not a feature to
 * enable, so it does not fit that map's inactive-warning semantics.
 */
const RECOMMENDED_VERSION = '2.1.220';

/**
 * Model floor for Fable-pinned agents — the CC version that introduced the
 * `fable` model alias. Below it, agents declaring `model: fable` hard-fail
 * at spawn (empirically reproduced 2026-07-02). bkit pins 6 agents to fable
 * (v2.1.26 cost retune moved the 3 high-frequency verifiers to opus);
 * session-context.js emits a SessionStart advisory when
 * 2.1.143 ≤ CC < this floor.
 */
const FABLE_MODEL_FLOOR = '2.1.170';

/**
 * Known CC releases whose behaviour degrades something bkit relies on.
 *
 * ENH-437 (v2.1.37). MIN_VERSION and RECOMMENDED_VERSION are both *floors*, so
 * the check had no way to say anything about a release ABOVE the recommendation.
 * A user on the newest CC was graded `ok` no matter what bkit had measured about
 * it — which is the wrong signal precisely when bkit has decided to hold the
 * recommendation back. Holding a recommendation the user never hears about is
 * not a decision, it is an omission.
 *
 * Entries are ranges, not single versions: a changed default persists into every
 * later release until CC changes it back, and an entry per release would rot
 * within a week. `until` is null while the issue is open and becomes the first
 * FIXED version when CC resolves it — at which point the entry stops matching on
 * its own, with no second edit needed.
 *
 * Rules for adding an entry:
 *   - Only a MEASURED effect on bkit. A CC bug with no bkit surface does not
 *     belong here; bkit is not an unofficial CC issue tracker.
 *   - `suppressedByEnv` lists env settings that genuinely remove the effect, each
 *     one traceable to a documented CC behaviour (not a guess). When one is set,
 *     the entry does not surface — the user has already mitigated it.
 *   - `addedCycle` records the /bkit:cc-version-analysis cycle that measured it,
 *     so a later reader can find the evidence.
 *
 * This never raises severity to `error` and never blocks a session. It promotes
 * `ok` to `warn` so the advisory has somewhere to appear.
 *
 * @type {ReadonlyArray<{
 *   id: string, from: string, until: string|null, scope: 'all'|'interactive'|'headless',
 *   summary: string, detail: string,
 *   suppressedByEnv: ReadonlyArray<{name: string, values: ReadonlyArray<string>}>,
 *   addedCycle: number
 * }>}
 */
const KNOWN_ISSUES = Object.freeze([
  Object.freeze({
    id: 'fork-default-agent-spawn',
    from: '2.1.232',
    until: null,
    scope: 'interactive',
    // fix-preflight-hookdrop-mislead: the summary/detail carry an explicit
    // non-causality clause — a consuming session (br004 forensics) fused this
    // subagent-semantics advisory with the #57317 hook-reachability warning into
    // "newer CC version ⇒ hooks are dropping". It is not a hook failure; for
    // hook health read .bkit/runtime/hook-reachability.json.
    summary:
      'fork mode is on by default and the Agent tool loses its `run_in_background` parameter '
      + '(subagent-spawn semantics ONLY — this is NOT a hook failure; hooks and /pdca skill fires are unaffected)',
    detail:
      "Claude Code v2.1.232 turns fork mode on by default in interactive sessions and removes the Agent " +
      "tool's `run_in_background` parameter, so a subagent's result arrives as a notification in a later " +
      "turn instead of within the turn that spawned it. bkit's sprint gate measurement and master-plan " +
      "generation await that result in the same turn, so they report an unmeasured gate rather than a " +
      "measurement. Nothing is lost or corrupted; the measurement simply does not happen. " +
      'Set CLAUDE_CODE_FORK_SUBAGENT=0 (or CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1) to run subagents in ' +
      'the foreground. '
      + 'NOTE: this measured issue concerns subagent spawn semantics alone. It is NOT a plugin-hook drop '
      + '(#57317) and NOT evidence that bkit hooks stopped firing. A CC version newer than '
      + 'RECOMMENDED_VERSION is a tested-floor statement, not a defect signal — for hook health read '
      + '.bkit/runtime/hook-reachability.json (fresh bash_post/write_post canary stamps = hooks firing).',
    suppressedByEnv: Object.freeze([
      // sub-agents.md:798 — with fork mode off, Claude runs a subagent in the
      // foreground when it needs the result before continuing.
      Object.freeze({ name: 'CLAUDE_CODE_FORK_SUBAGENT', values: Object.freeze(['0', 'false']) }),
      // sub-agents.md:795 — foreground "in every kind of session and whether or
      // not fork mode is on". Strictly stronger than the flag above.
      Object.freeze({ name: 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', values: Object.freeze(['1', 'true']) }),
    ]),
    addedCycle: 37,
  }),
]);

/**
 * Feature → minimum required CC version. Inactive when current < required.
 * Maintained in sync with Design 3.3 (sprint α) and v2.1.118 ENH-277/279/280.
 */
const FEATURE_VERSION_MAP = Object.freeze({
  agentTeams: '2.1.117',          // CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  loopCommand: '2.1.71',          // /loop
  promptCaching1h: '2.1.108',     // 1-hour prompt cache
  contextFork: '2.1.113',         // context: fork in session
  opus1MCompact: '2.1.113',       // Opus 1M /compact fix (tentative)
  hookMcpToolDirect: '2.1.118',   // hooks.json type: "mcp_tool" (ENH-277)
  // claude plugin tag (ENH-279). NOTE: CC changed `plugin tag` to derive
  // `{name}--v{version}` from plugin.json (~v2.1.110; the positional
  // version argument was removed, so `claude plugin tag v<x.y.z>` fails
  // with "Path not found"). bkit's scripts/release-plugin-tag.sh now
  // creates the release tag via `git tag -a` directly and uses
  // `claude plugin tag . --dry-run` only as an informational consistency
  // check. Value stays 2.1.118 per this map's semantics (minimum CC
  // version at which the invoked command exists).
  pluginTagCommand: '2.1.118',
  agentHookMultiEvent: '2.1.118', // agent-hook multi-event fix (ENH-280)
});

/**
 * Parse a semver-ish version string into a numeric tuple `[major, minor, patch]`.
 * Returns `null` on malformed input so callers can short-circuit.
 *
 * @param {string} v
 * @returns {[number, number, number] | null}
 */
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Compare two version strings.
 *   1  → a > b
 *   0  → a == b
 *  -1  → a < b
 *
 * Unparsable inputs compare as equal (fail-open).
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
function compareVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

// Module-level cache: CC CLI version is immutable for the duration of a Node
// process, so detecting once is correct. Repeat callers (e.g. preflight +
// markFirstRunSeen + reconcile in the same session) thus pay subprocess cost
// only on the first call. Tests that need to defeat the cache call _resetCache().
let _cache = { set: false, value: null };

function _resetCache() { _cache = { set: false, value: null }; }

/**
 * Strategy 0 (ENH-375) — resolve the active CC version from the native
 * installer's symlink, without spawning anything.
 *
 * The native installer keeps every downloaded build under
 * `~/.local/share/claude/versions/<x.y.z>` and points `~/.local/bin/claude` at
 * whichever one is active, so the link target's basename is the version. One
 * `readlink` replaces a ~300 ms process spawn.
 *
 * Only the basename is trusted, and only when it parses as a semver triple — a
 * symlink pointing somewhere unexpected yields `null` and the caller falls
 * through to the subprocess strategy. Fail-open throughout: this must never
 * throw into a hook.
 *
 * @returns {string | null} e.g. "2.1.220", or null when unavailable/unparseable
 */
function readVersionFromInstallerSymlink() {
  try {
    // Resolve the `claude` that PATH would actually run. Reading
    // ~/.local/bin/claude directly would be wrong whenever something else
    // shadows it — a wrapper, a version manager, or a test's PATH shim — because
    // the symlink would then describe a binary that is not the one executing.
    const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    let resolved = null;
    for (const dir of pathDirs) {
      const candidate = path.join(dir, 'claude');
      if (fs.existsSync(candidate)) { resolved = candidate; break; }
    }
    if (!resolved) return null;

    // Only the native installer's layout is self-describing:
    // ~/.local/share/claude/versions/<x.y.z>. Anything else — npm, a wrapper
    // script, a shim — has to be asked directly, so fall through.
    const real = fs.realpathSync(resolved);
    const versionsDir = path.join(os.homedir(), '.local', 'share', 'claude', 'versions') + path.sep;
    if (!real.startsWith(versionsDir)) return null;

    const parsed = parseVersion(path.basename(real));
    return parsed ? `${parsed[0]}.${parsed[1]}.${parsed[2]}` : null;
  } catch {
    return null;
  }
}

/**
 * Run `claude --version` and parse the result. No shell — argv is passed
 * through, so nothing here can be interpreted as a command.
 *
 * ENH-428 (v2.1.35): this used to exist three times — here, in
 * `lib/infra/cc-bridge.js`, and in `hooks/startup/session-context.js` — two of
 * them via `execSync` with a shell. Callers keep their own timeout because
 * their budgets differ (a SessionStart hook cannot spend what a CLI script can).
 *
 * @param {number} [timeoutMs]
 * @returns {string | null} normalized "x.y.z", or null on any failure
 */
function detectViaSubprocess(timeoutMs = SUBPROCESS_TIMEOUT_MS) {
  try {
    const result = spawnSync('claude', ['--version'], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0 && typeof result.stdout === 'string') {
      const parsed = parseVersion(result.stdout);
      if (parsed) return `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
    }
  } catch {
    // fall through — caller treats null as "unknown"
  }
  return null;
}

/**
 * Detect the current Claude Code CLI version.
 *
 * Strategy (executed once per process — see module cache):
 *   0. Read the `~/.local/bin/claude` native-installer symlink (no subprocess)
 *   1. spawnSync('claude', ['--version'], { timeout: 500 })
 *   2. Fallback to reading ~/.claude/claude/version.json
 *
 * Returns `null` on any failure — caller MUST treat null as "unknown" and
 * skip warnings (fail-open).
 *
 * @returns {string | null} e.g. "2.1.121" or null
 */
function getCurrent() {
  if (_cache.set) return _cache.value;

  let detected = null;

  // Strategy 0: native-installer symlink (ENH-375) — no subprocess.
  detected = readVersionFromInstallerSymlink();

  // Strategy 1: subprocess
  if (detected === null) detected = detectViaSubprocess(SUBPROCESS_TIMEOUT_MS);

  // Strategy 2: version.json
  if (detected === null) {
    try {
      const versionFile = path.join(os.homedir(), '.claude', 'claude', 'version.json');
      if (fs.existsSync(versionFile)) {
        const raw = fs.readFileSync(versionFile, 'utf-8');
        const json = JSON.parse(raw);
        if (json && typeof json.version === 'string') {
          const parsed = parseVersion(json.version);
          if (parsed) detected = `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
        }
      }
    } catch {
      // fall through
    }
  }

  _cache = { set: true, value: detected };
  return detected;
}

/**
 * List feature keys whose required version exceeds the supplied current version.
 * Order is determined by FEATURE_VERSION_MAP insertion order.
 *
 * @param {string} current
 * @returns {string[]}
 */
function listInactiveFeatures(current) {
  if (!parseVersion(current)) return [];
  const inactive = [];
  for (const [feature, required] of Object.entries(FEATURE_VERSION_MAP)) {
    if (compareVersion(current, required) < 0) {
      inactive.push(feature);
    }
  }
  return inactive;
}

/**
 * List KNOWN_ISSUES entries that apply to the supplied version.
 *
 * An entry applies when `from <= current` and (`until` is null or
 * `current < until`), and when none of its `suppressedByEnv` settings is
 * already in effect.
 *
 * Scope is deliberately NOT filtered here. bkit cannot tell an interactive
 * session from a headless one: no hook payload field carries it (see
 * lib/domain/ports/cc-payload.port.js for the measured key set), and the flag CC
 * itself uses is internal. Guessing would suppress a real advisory as often as
 * it removed a spurious one, so an `interactive`-scoped entry surfaces in both —
 * one extra line in a headless log is the cheaper error. Scope is retained on
 * the entry because it is true and belongs in the message.
 *
 * Fail-open: a malformed `current` matches nothing.
 *
 * @param {string} current - detected CC version
 * @param {Record<string, string|undefined>} [env] - defaults to process.env
 * @returns {Array<object>} matching entries (possibly empty), declaration order
 */
function listKnownIssues(current, env) {
  if (!parseVersion(current)) return [];
  const source = env || process.env;
  return KNOWN_ISSUES.filter((issue) => {
    if (compareVersion(current, issue.from) < 0) return false;
    if (issue.until && compareVersion(current, issue.until) >= 0) return false;
    for (const gate of issue.suppressedByEnv || []) {
      const actual = source[gate.name];
      if (actual !== undefined && gate.values.includes(String(actual).trim().toLowerCase())) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Compose a structured version-check report. Pure — no I/O beyond getCurrent().
 *
 * Honors `DISABLE_UPDATES=1` (CC v2.1.118+ env gate, F5 mitigation):
 * if set, returns `{ skipped: true }` so the caller can suppress all warnings.
 *
 * Result shape:
 *   { skipped: true, reason }                               — opted out
 *   { current: null }                                       — undetectable, no warning
 *   { current, severity: 'ok'   }                           — ≥ recommended, nothing known against it
 *   { current, severity: 'warn', inactive: [...] }          — current < recommended, ≥ min
 *   { current, severity: 'warn', knownIssues: [...] }       — ≥ recommended, but see KNOWN_ISSUES
 *   { current, severity: 'error', inactive: [...] }         — current < min
 *
 * `knownIssues` is always present (possibly empty) whenever `current` is known,
 * so a caller can render it without probing for the key. Severity precedence is
 * error > warn > ok: a version below MIN_VERSION stays `error` even when it also
 * matches a KNOWN_ISSUES range, because "too old to support" is the more
 * actionable statement and adding a second one would only dilute it.
 *
 * @returns {object}
 */
function checkCCVersion() {
  if (process.env.DISABLE_UPDATES === '1') {
    return { skipped: true, reason: 'DISABLE_UPDATES env' };
  }

  const current = getCurrent();
  if (!current) return { current: null };

  const inactive = listInactiveFeatures(current);
  const knownIssues = listKnownIssues(current);
  const base = { current, inactive, knownIssues, recommended: RECOMMENDED_VERSION, min: MIN_VERSION };

  if (compareVersion(current, MIN_VERSION) < 0) {
    return { ...base, severity: 'error' };
  }
  if (compareVersion(current, RECOMMENDED_VERSION) < 0) {
    return { ...base, severity: 'warn' };
  }
  // At or above the recommendation. A known issue is the only thing left that
  // can still warrant a warning — without this branch the advisory has nowhere
  // to surface, because renderCCVersionWarning() returns null on 'ok'.
  return { ...base, severity: knownIssues.length > 0 ? 'warn' : 'ok' };
}

/**
 * Read the CC version SessionStart already detected, without spawning anything.
 *
 * ENH-471 (v2.1.37). `getCurrent()` runs `claude --version` with a 500 ms
 * timeout. That is fine once at SessionStart; it is not fine inside a PreToolUse
 * hook, whose entire budget is 5 s and which fires on every Bash command. This
 * reads the cache that SessionStart writes (`.bkit/runtime/cc-version.json`) and
 * returns null if there is nothing usable.
 *
 * The TTL is deliberately NOT enforced here. This value is used to decide whether
 * a regression guard has been retired, and a stale entry can only be OLDER than
 * the running CLI — which keeps a guard active that might have been retired. The
 * error is in the conservative direction, and re-detecting to avoid it would cost
 * the subprocess this function exists to avoid.
 *
 * @param {string} [cwd] - project root; defaults to CLAUDE_PROJECT_DIR or cwd
 * @returns {string|null} semver string, or null when unavailable
 */
function readCachedVersion(cwd) {
  try {
    const root = cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const cachePath = path.join(root, '.bkit', 'runtime', 'cc-version.json');
    if (!fs.existsSync(cachePath)) return null;
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached && typeof cached.version === 'string' && cached.version.length > 0) {
      return cached.version;
    }
  } catch (_) {
    /* fail-open: an unreadable cache means "unknown", never an error */
  }
  return null;
}

module.exports = {
  MIN_VERSION,
  RECOMMENDED_VERSION,
  FABLE_MODEL_FLOOR,
  FEATURE_VERSION_MAP,
  KNOWN_ISSUES,
  parseVersion,
  compareVersion,
  getCurrent,
  readCachedVersion,
  detectViaSubprocess,
  readVersionFromInstallerSymlink,
  listInactiveFeatures,
  listKnownIssues,
  checkCCVersion,
  _resetCache, // test-only — flush in-process getCurrent cache
};
