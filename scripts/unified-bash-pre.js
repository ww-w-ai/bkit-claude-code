#!/usr/bin/env node
/**
 * unified-bash-pre.js - Unified Bash PreToolUse Handler (v2.0.0)
 *
 * GitHub Issue #9354 Workaround:
 * Consolidates Bash PreToolUse hooks from:
 * - phase-9-deployment: phase9-deploy-pre.js
 * - zero-script-qa: qa-pre-bash.js
 * - qa-monitor: qa-pre-bash.js (same as zero-script-qa)
 *
 * v2.0.0 Changes:
 * - Added destructive detector integration (control module)
 * - Added scope limiter check (control module)
 * - Added audit logging for destructive commands
 *
 * bkit v2.1.10 (ENH-264):
 * - Leverages CC v2.1.110+ PreToolUse `hookSpecificOutput.additionalContext`
 *   to surface safer alternatives instead of bare "blocked" reasons.
 *   Claude receives actionable recovery suggestions and can propose a
 *   reformulated command automatically (agent resilience boost).
 */

const { readStdinSync, parseHookInput, outputAllow, outputBlockWithContext, outputAsk } = require('../lib/core/io');
const { debugLog } = require('../lib/core/debug');
const { getActiveSkill, getActiveAgent } = require('../lib/task/context');
// v2.1.37 (ENH-466): the host's permission mode decides whether an `ask` reaches
// anyone. See lib/domain/policy/permission-mode-policy.js for what is and is not
// relaxed — `critical` never is.
const { isAskSuppressed } = require('../lib/domain/policy/permission-mode-policy');

// ============================================================
// ENH-264: Alternative suggestions for blocked commands (CC v2.1.110+)
// ============================================================

/**
 * Maps a matched danger pattern to concrete safer alternatives.
 * Used by all block paths in this hook to populate
 * `hookSpecificOutput.additionalContext`.
 *
 * Keep keys lowercase-free (match raw pattern substring).
 */
const ALTERNATIVES_BY_PATTERN = {
  'rm -rf': [
    'git clean -fdx  # clean tracked + untracked, respects .gitignore',
    'rm -rf ./dist ./build ./node_modules  # only the directories you actually need to remove',
    'trash ~/path  # if `trash` CLI is available (macOS/Linux), allows recovery',
  ],
  'rm -r': [
    'rm -ri path  # interactive per-file confirmation',
    'git clean -fd  # clean untracked files inside a git repo',
  ],
  'DROP TABLE': [
    'Back up first: `pg_dump -t table_name db > backup.sql`',
    'Run under a migration tool (Prisma/Alembic/Knex) so the change is versioned and reversible',
    'Ask the user to confirm the target environment before issuing DDL',
  ],
  'DROP DATABASE': [
    'Create a dump first: `pg_dump db > backup.sql` / `mysqldump db > backup.sql`',
    'Rename instead of dropping so the data can be restored if needed',
  ],
  'DELETE FROM': [
    'Add a narrowing WHERE clause and wrap in a transaction: `BEGIN; DELETE FROM ... WHERE ... LIMIT 10; -- inspect; COMMIT;`',
    'Soft-delete instead: add a `deleted_at` column and update rows',
  ],
  'TRUNCATE': [
    'Back up first: `pg_dump -t table_name db > backup.sql`',
    'Use a migration tool so the operation is recorded and reversible',
  ],
  '> /dev/': [
    'Write to a file path you control instead of a device',
    'If you need to clear output, append to `/dev/null` only for *discarding* output, not for writing data',
  ],
  'mkfs': [
    'Verify the target device with `lsblk` / `diskutil list` before any filesystem operation',
    'Abort unless the user has explicitly named the device in the current turn',
  ],
  'dd if=': [
    'Verify destination with `lsblk` / `diskutil list`',
    'Use tools like `rsync` or `cp` when copying regular files (dd is rarely the right choice)',
  ],
  'kubectl delete': [
    'Preview with `kubectl get ...` or `--dry-run=client` first',
    'Scale to 0 instead of deleting: `kubectl scale deployment NAME --replicas=0`',
  ],
  'terraform destroy': [
    'Use `terraform plan -destroy` to preview',
    'Target a specific resource: `terraform destroy -target=RESOURCE`',
  ],
  'aws ec2 terminate': [
    'Stop first instead of terminating: `aws ec2 stop-instances --instance-ids ...`',
    'Snapshot the EBS volume before terminating',
  ],
  'helm uninstall': [
    'Use `helm rollback RELEASE 0` to restore a previous revision instead',
    'Run `helm list` and confirm the release/namespace before uninstalling',
  ],
  '--force': [
    'Prefer `--force-with-lease` (git) which aborts if the remote moved',
    'Remove `--force` and address the underlying cause reported by the tool',
  ],
  'production': [
    'Target a staging environment first to rehearse the change',
    'Request an explicit confirmation from the user before touching production',
  ],
};

/**
 * Returns safer alternatives for the first matching danger pattern, or [] if none.
 * @param {string} command
 * @returns {string[]}
 */
function getAlternativesForCommand(command) {
  if (!command) return [];
  for (const key of Object.keys(ALTERNATIVES_BY_PATTERN)) {
    if (command.includes(key)) {
      return ALTERNATIVES_BY_PATTERN[key];
    }
  }
  return [];
}

// ============================================================
// Handler: phase9-deploy-pre
// ============================================================

/**
 * Flags that make a deployment command a preview rather than a change.
 *
 * ENH-467 (v2.1.37). Every tool this guard watches has a rehearsal mode, and the
 * guard's own advice recommends using it — "Preview with `kubectl get ...` or
 * `--dry-run=client` first", "Use `terraform plan -destroy` to preview". A guard
 * that refuses the command it just told you to run is the failure v2.1.34 wrote
 * onto G-001: advice the rule makes impossible to act on.
 */
const DEPLOY_PREVIEW_FLAGS = [
  '--dry-run',
  '-o yaml',
  '-o json',
  '--output=yaml',
  '--output=json',
  '--server-dry-run',
];

/**
 * Phase 9 deployment safety checks.
 *
 * ENH-467 (v2.1.37) — graded, not a flat refusal.
 *
 * This guard used to refuse on a bare substring match, so `npm install --force`
 * and `echo "deploying to production"` were both "Deployment safety" refusals
 * with no route forward, while `phase-9-deployment` was the active skill. Two of
 * its six patterns — `--force` and `production` — describe a flag and a word, not
 * an operation, and neither can be graded by target because neither names one.
 * They ask. The four that name an actual destroy operation still deny.
 *
 * @param {Object} input - Hook input
 * @returns {{action: 'deny'|'ask', reason: string, alternatives: string[]}|null}
 *   null when nothing matched
 */
function handlePhase9DeployPre(input) {
  const { command } = parseHookInput(input);
  if (!command) return null;

  const lowered = command.toLowerCase();

  // A previewed destroy is not a destroy.
  if (DEPLOY_PREVIEW_FLAGS.some((f) => lowered.includes(f))) return null;
  if (/\bterraform\s+plan\b/.test(lowered)) return null;

  const patterns = [
    { pattern: 'kubectl delete', reason: 'Kubernetes resource deletion', action: 'deny' },
    { pattern: 'terraform destroy', reason: 'Infrastructure destruction', action: 'deny' },
    { pattern: 'aws ec2 terminate', reason: 'EC2 instance termination', action: 'deny' },
    { pattern: 'helm uninstall', reason: 'Helm release removal', action: 'deny' },
    { pattern: '--force', reason: 'Force flag detected', action: 'ask' },
    { pattern: 'production', reason: 'Production environment detected', action: 'ask' },
  ];

  for (const { pattern, reason, action } of patterns) {
    if (lowered.includes(pattern.toLowerCase())) {
      return {
        action,
        reason: action === 'deny'
          ? `Deployment safety: ${reason}. Command '${pattern}' is refused during the deployment phase.`
          : `Deployment safety: ${reason} in '${pattern}'. This is a confirmation, not a refusal — `
            + 'the pattern describes a flag or an environment name, not a destructive operation.',
        // ENH-264: alternatives travel with the decision via additionalContext.
        alternatives: getAlternativesForCommand(command).length
          ? getAlternativesForCommand(command)
          : getAlternativesForCommand(pattern),
      };
    }
  }

  return null;
}

// ============================================================
// Handler: qa-pre-bash (shared by zero-script-qa and qa-monitor)
// ============================================================

/**
 * QA destructive command prevention.
 *
 * ENH-468 (v2.1.37) — delegates to the shared Destructive Detector.
 *
 * This handler carried its own nine-entry substring table: a second, cruder copy
 * of rules the detector already owns, with none of the grading the detector spent
 * v2.1.34 and v2.1.36 acquiring. The consequences were both directions of wrong.
 * `rm -r ./tmp/qa-fixtures` — clearing a scratch directory, which is ordinary QA
 * work — was refused outright, while `chmod 777 /` was not in the table at all
 * and passed. Two tables for one concept is also how they drift: every precision
 * fix landed on one of them.
 *
 * The detector is now the single source, so this handler contributes the one
 * thing it actually knows that the detector does not — that a QA session is in
 * progress — by treating any finding as reaching the user rather than passing
 * silently. Critical findings still deny; everything else asks.
 *
 * @param {Object} input - Hook input
 * @returns {{action: 'deny'|'ask', reason: string, alternatives: string[]}|null}
 *   null when nothing matched
 */
function handleQaPreBash(input) {
  const { command } = parseHookInput(input);
  if (!command) return null;

  let result;
  let dd;
  try {
    dd = require('../lib/control/destructive-detector');
    result = dd.detect('Bash', command);
  } catch (e) {
    debugLog('UnifiedBashPre', 'qa guard: detector unavailable', { error: e.message });
    return null;
  }

  if (!result || !result.detected || !Array.isArray(result.rules) || result.rules.length === 0) {
    return null;
  }

  const critical = result.rules.filter((r) => r.severity === 'critical');
  const relevant = critical.length ? critical : result.rules;
  const ids = relevant.map((r) => r.id);
  const names = relevant.map((r) => r.name).join('; ');

  return {
    action: critical.length ? 'deny' : 'ask',
    reason: critical.length
      ? `QA safety: this command matches ${ids.length > 1 ? 'rules' : 'rule'} ${ids.join(', ')} `
        + `(${names}) and is refused while a QA session is running.`
      : `QA safety: this command matches ${ids.length > 1 ? 'rules' : 'rule'} ${ids.join(', ')} `
        + `(${names}). A QA session is running, so it is confirmed rather than passed silently.`,
    alternatives: dd.alternativesFor(relevant),
  };
}

// ============================================================
// Main Execution
// ============================================================

debugLog('UnifiedBashPre', 'Hook started');

// Read hook context
let input = {};
try {
  input = readStdinSync();
  if (typeof input === 'string') {
    input = JSON.parse(input);
  }
} catch (e) {
  debugLog('UnifiedBashPre', 'Failed to parse input', { error: e.message });
}

// Get current context
const activeSkill = getActiveSkill();
const activeAgent = getActiveAgent();

/*
 * v2.1.37 — the permission mode the host is running in.
 *
 * Read once here and threaded to every ask decision below. Before this, bkit read
 * `permission_mode` in no place at all, so a session started with
 * `--dangerously-skip-permissions` was interrupted exactly as often as one that
 * had asked to be. See lib/domain/policy/permission-mode-policy.js.
 */
const { permissionMode } = parseHookInput(input);
const askSuppressed = isAskSuppressed(permissionMode);

debugLog('UnifiedBashPre', 'Context', {
  activeSkill, activeAgent, permissionMode, askSuppressed,
});

/**
 * Record an ask that the permission mode stood down, then let the command run.
 *
 * Suppression must leave a trail. A guard that goes quiet without one is
 * indistinguishable from a guard that is broken, and this file already carries
 * the scars of that class: ENH-388 wrote `result: 'blocked'` for a command it
 * then executed, and ENH-393 had to go back and make the audit entry name what
 * actually happened. The same standard applies to going quiet on purpose.
 *
 * @param {{ids: string[], reason: string, command: string}} ask
 * @param {string} source - which guard raised it
 */
function auditSuppressedAsk(ask, source) {
  try {
    const audit = require('../lib/audit/audit-logger');
    audit.writeAuditLog({
      actor: 'hook', actorId: 'unified-bash-pre',
      action: 'confirmation_suppressed_by_permission_mode', category: 'control',
      target: String(ask.command || '').substring(0, 100), targetType: 'file',
      details: { rules: ask.ids, permissionMode, source },
      result: 'success', destructiveOperation: true,
      reason: `${ask.reason} — not raised: permission_mode is "${permissionMode}".`,
    });
  } catch (_) { /* graceful — auditing must never change the decision */ }
}

let blocked = false;

/*
 * A pending confirmation request, if one was raised.
 *
 * An `ask` must NOT be emitted where it is decided. `outputAsk()` exits the
 * process, so emitting inline would skip every guard that runs after the
 * destructive detector — heredoc bypass, the push guard and the Memory
 * Enforcer, all of which can DENY. A command that both warrants confirmation
 * and contains a `<<EOF | bash` bypass would have been offered to the user as a
 * yes/no prompt instead of being refused outright, turning a block into a
 * click-through. So the ask is parked here and emitted at the very end, only if
 * nothing stronger fired.
 */
let pendingAsk = null;

/**
 * Apply a graded verdict from one of the context guards.
 *
 * ENH-467/468 (v2.1.37). Both guards used to emit their own refusal inline, which
 * is the pattern the pendingAsk comment above exists to forbid: an inline emit
 * exits the process and skips every deny-capable guard below it. Now they return
 * a verdict and this routes it — deny immediately, park an ask.
 *
 * @param {{action: 'deny'|'ask', reason: string, alternatives: string[]}|null} verdict
 * @param {string} source
 * @returns {boolean} true when the command was denied
 */
function applyContextVerdict(verdict, source) {
  if (!verdict) return false;
  if (verdict.action === 'deny') {
    outputBlockWithContext(verdict.reason, verdict.alternatives, 'PreToolUse');
    return true;
  }
  if (!pendingAsk) {
    pendingAsk = {
      ids: [source],
      confidence: 1,
      alternatives: verdict.alternatives,
      command: parseHookInput(input).command || '',
      reason: verdict.reason,
    };
  }
  return false;
}

// Phase 9 deployment checks
if (activeSkill === 'phase-9-deployment') {
  blocked = applyContextVerdict(handlePhase9DeployPre(input), 'phase-9-deployment');
}

// QA checks (zero-script-qa skill or qa-monitor agent)
if (!blocked && (activeSkill === 'zero-script-qa' || activeAgent === 'qa-monitor')) {
  blocked = applyContextVerdict(handleQaPreBash(input), 'zero-script-qa');
}

// ============================================================
// v2.0.0: Destructive Detector (Control Module)
// ============================================================
if (!blocked) {
  try {
    const dd = require('../lib/control/destructive-detector');
    const toolInput = parseHookInput(input);
    // ENH-389 (v2.1.33): pass the command STRING, not `{ command }`.
    //
    // `detect(toolName, toolInput)` documents `@param {string} toolInput`
    // (lib/control/destructive-detector.js:131) and falls back to
    // `JSON.stringify(toolInput)` for anything else (:135). Passing an object
    // therefore matched the rules against `{"command":"..."}` rather than the
    // command, which silently defeats every anchored pattern. Measured:
    //   detect('Bash', 'chmod 777 /')             -> G-008 critical
    //   detect('Bash', { command: 'chmod 777 /' }) -> not detected
    // because G-008 ends with `\/\s*$` and the JSON form ends with `"}`. The
    // same held for `chown root /` and `mv /etc/passwd /` — commands aimed at
    // the filesystem root were invisible to the detector in production.
    const result = dd.detect('Bash', toolInput.command || '');
    const criticalRules = (result.rules || []).filter((r) => r.severity === 'critical');
    if (result.detected && criticalRules.length > 0) {
      // ENH-388 (v2.1.33): actually block.
      //
      // This branch previously wrote an audit entry saying `result: 'blocked'`,
      // incremented the `destructiveBlocked` counter, and then let the command
      // run. Nothing here called an output helper or set `blocked`, so a
      // critical destructive command was recorded as blocked and executed
      // anyway — the audit trail and the session stats both asserted a
      // protection that did not exist.
      const ruleIds = criticalRules.map((r) => r.id);
      const reason = `bkit Destructive Detector: this command matches ${ruleIds.length > 1 ? 'rules' : 'rule'} `
        + `${ruleIds.join(', ')} (${criticalRules.map((r) => r.name).join('; ')}) and is blocked as critical.`;
      /*
       * ENH-459 (v2.1.36): advice that fits the rule that fired.
       *
       * This list was fixed for every rule and led with "Scope the command to a
       * specific path". Followable for a recursive delete; meaningless for
       * `curl … | sh`, `DROP TABLE users`, or `dd of=/dev/disk0`, none of which
       * have a path to scope. Most refusals therefore ended in advice the user
       * could not act on — the failure the G-001 comment warns about and issue
       * #148 quoted back. dd.alternativesFor() is shared with the detector's own
       * getBlockMessage() so the two cannot offer different remedies.
       */
      const alternatives = dd.alternativesFor(criticalRules);

      // ENH-393 (v2.1.33): record the decision that was actually made.
      // `result` was hardcoded to 'blocked' regardless of outcome; now the
      // audit entry is written on the path that genuinely blocks, and the
      // session counter increments only alongside a real block.
      try {
        const audit = require('../lib/audit/audit-logger');
        audit.writeAuditLog({
          actor: 'hook', actorId: 'unified-bash-pre',
          action: 'destructive_blocked', category: 'control',
          target: toolInput.command?.substring(0, 100) || '', targetType: 'file',
          details: { rules: ruleIds, confidence: result.confidence },
          result: 'blocked', destructiveOperation: true,
          reason,
        });
      } catch (_) { /* graceful — auditing must never prevent the block */ }
      // v2.1.1 TC-02: Track destructive blocks in session stats
      try {
        const ac = require('../lib/control/automation-controller');
        ac.incrementStat('destructiveBlocked');
      } catch (_) {}

      blocked = true;
      outputBlockWithContext(reason, alternatives, 'PreToolUse');
    }

    /*
     * v2.1.34 (D9) — high-severity findings ask instead of passing silently.
     *
     * Before this, only `critical` did anything, so a rule was either an
     * absolute refusal or invisible. That is why G-001 refused `rm -rf` on any
     * target at all: making it proportionate would have meant making it
     * toothless. With a grading step (see `severityFor` on G-001) a scoped
     * recursive delete lands on `high`, and `high` must reach the user rather
     * than slip past — grading it down to a silent allow would be a relaxation
     * dressed up as a fix.
     */
    if (!blocked && result.detected) {
      // Driven by the rule's own declared action, not by severity. Ten rules
      // have carried `defaultAction: 'ask'` since the table was written and not
      // one of them ever asked, because this hook only ever branched on
      // `critical`. Reading `action` is what makes the declaration true.
      const askRules = (result.rules || []).filter((r) => r.action === 'ask');
      if (askRules.length > 0) {
        const ids = askRules.map((r) => r.id);
        pendingAsk = {
          ids,
          confidence: result.confidence,
          // ENH-459 (v2.1.36): advice that fits the rule, shared with the deny
          // path and with the detector's own getBlockMessage().
          alternatives: dd.alternativesFor(askRules),
          command: toolInput.command || '',
          reason:
            `bkit Destructive Detector: this command matches ${ids.length > 1 ? 'rules' : 'rule'} `
            + `${ids.join(', ')} (${askRules.map((r) => r.name).join('; ')}). `
            + 'This is a confirmation, not a refusal — the operation is reversible or narrowly '
            + 'scoped enough that refusing it outright would be the wrong call.',
        };
      }
    }
  } catch (_) {}
}

// ============================================================
// v2.1.14 Sub-Sprint 2: Heredoc Bypass Defense (ENH-310, 차별화 #6)
// Catches `cat <<EOF | bash`-style permission bypass (CC #58904 regression).
// Runs after destructive-detector so destructive patterns in plain commands
// take precedence; heredoc-detector then catches the heredoc-encapsulated
// case that destructive-detector cannot see (heredoc body is invisible to
// substring match). All IO is best-effort, never throws.
// ============================================================
if (!blocked) {
  try {
    const { detect: detectHeredoc } = require('../lib/defense/heredoc-detector');
    const toolInput = parseHookInput(input);
    const verdict = detectHeredoc(toolInput.command || '');
    if (verdict.matched && verdict.severity === 'critical') {
      // Audit before block — fail-silent so block path still fires
      try {
        const audit = require('../lib/audit/audit-logger');
        audit.writeAuditLog({
          actor: 'hook', actorId: 'unified-bash-pre',
          action: 'heredoc_bypass_blocked', category: 'control',
          target: (toolInput.command || '').substring(0, 200), targetType: 'file',
          details: { pattern: verdict.pattern, vector: verdict.vector },
          result: 'blocked', destructiveOperation: true, blastRadius: 'critical',
          reason: verdict.reason,
        });
      } catch (_) { /* audit failure non-fatal */ }
      outputBlockWithContext(verdict.reason, verdict.alternatives, 'PreToolUse');
      blocked = true;
    }
    // warning severity → allow with audit-only (no block, no additionalContext spam)
    if (!blocked && verdict.matched && verdict.severity === 'warning') {
      try {
        const audit = require('../lib/audit/audit-logger');
        audit.writeAuditLog({
          actor: 'hook', actorId: 'unified-bash-pre',
          // ENH-393 class (v2.1.33): this said `heredoc_bypass_blocked` on the
          // path that deliberately ALLOWS the command. Reading the audit trail,
          // an observed-but-permitted heredoc was indistinguishable from a
          // blocked one — the same false-assurance pattern as the destructive
          // detector's hardcoded `result: 'blocked'`. The action now names what
          // actually happened; `result: 'success'` below was already correct.
          action: 'heredoc_bypass_observed', category: 'control',
          target: (toolInput.command || '').substring(0, 200), targetType: 'file',
          details: { pattern: verdict.pattern, vector: verdict.vector, severity: 'warning' },
          result: 'success',
          reason: verdict.reason,
        });
      } catch (_) { /* graceful */ }
    }
  } catch (_) { /* heredoc-detector unavailable — fail-open */ }
}

// ============================================================
// v2.1.14 Sub-Sprint 2: Push Event Guard (ENH-298)
// Distinguishes fork-push (allowed at L0-L3) from upstream-push (always asks),
// and denies force pushes regardless. Runs after heredoc-detector; the two
// guards are independent (a heredoc-wrapped git push would already have been
// blocked at the heredoc stage).
// ============================================================
if (!blocked) {
  try {
    const guard = require('../lib/defense/push-event-guard');
    const toolInput = parseHookInput(input);
    const parsed = guard.detectPushCommand(toolInput.command || '');
    if (parsed.isPush) {
      const ac2 = require('../lib/control/automation-controller');
      const trustLevel = (() => {
        try { const lv = ac2.getCurrentLevel(); return typeof lv === 'string' ? lv : `L${lv}`; }
        catch (_) { return 'L2'; }
      })();
      const classified = guard.classifyRemote(parsed.remote || 'origin');
      const verdict = guard.shouldGuard(parsed, classified, trustLevel);
      try {
        const audit = require('../lib/audit/audit-logger');
        audit.writeAuditLog({
          actor: 'hook', actorId: 'unified-bash-pre',
          action: 'git_push_intercepted', category: 'control',
          target: parsed.remote || 'origin', targetType: 'config',
          details: {
            force: parsed.force, branch: parsed.branch,
            kind: classified.kind, isFork: classified.isFork,
            trustLevel, action: verdict.action,
          },
          result: verdict.action === 'allow' ? 'success' : 'blocked',
          destructiveOperation: parsed.force === true,
          blastRadius: parsed.force ? 'high' : null,
          reason: verdict.reason,
        });
      } catch (_) { /* graceful */ }
      /*
       * ENH-463 (v2.1.36) — honour the guard's three verdicts instead of two.
       *
       * `ask` was emitted through outputBlockWithContext, the same call as
       * `deny`, so every confirmation this guard computed was presented as a
       * refusal. shouldGuard() has always returned `ask` for an upstream push —
       * meaning `git push origin main` was refused outright rather than
       * confirmed — and the distinction it took the trouble to make was
       * discarded one line later. Same class as ENH-410: decided, then dropped.
       *
       * An `ask` is parked in pendingAsk rather than emitted here, per the
       * contract documented at the top of this file: outputAsk() exits, so
       * emitting inline would skip the Memory Enforcer and turn a later DENY
       * into a click-through.
       */
      if (verdict.action === 'deny') {
        outputBlockWithContext(verdict.reason, verdict.alternatives, 'PreToolUse');
        blocked = true;
      } else if (verdict.action === 'ask' && !pendingAsk) {
        pendingAsk = {
          ids: ['ENH-298'],
          confidence: 1,
          alternatives: verdict.alternatives,
          command: toolInput.command || '',
          reason: verdict.reason,
        };
      }
    }
  } catch (_) { /* push-event-guard unavailable — fail-open */ }
}

// ============================================================
// v2.1.14 Sub-Sprint 4 Stage 4 (ENH-300, differentiation #4): effort-aware
// ------------------------------------------------------------
// CC v2.1.133+ exposes the model's effort/reasoning budget as `effort.level`
// on the tool_input (when present) and as $CLAUDE_EFFORT in the hook env.
// We don't gate on it (the model's self-report is advisory) but we DO use it
// to adjust defense verbosity and audit detail: 'low' → terse, 'high' →
// verbose. The value is normalized through the domain invariant-10 guard so
// out-of-range strings degrade safely to 'medium' instead of disabling
// downstream defenses.
// ============================================================
let effortLevel = 'medium';
if (!blocked) {
  try {
    const inv10 = require('../lib/domain/guards/invariant-10-effort-aware');
    const fromPayload = input && input.tool_input && typeof input.tool_input.effort === 'object'
      ? input.tool_input.effort.level
      : undefined;
    const fromEnv = process.env.CLAUDE_EFFORT;
    const raw = (typeof fromPayload === 'string' && fromPayload.length > 0) ? fromPayload : fromEnv;
    const guardResult = inv10.check({
      effortLevel: raw,
      source: fromPayload !== undefined ? 'payload' : (fromEnv ? 'env' : 'default'),
      scope: 'unified-bash-pre',
    });
    if (guardResult.hit) {
      debugLog('UnifiedBashPre', 'invariant-10 effort-aware guard hit', guardResult.meta);
    }
    effortLevel = inv10.normalize(raw);
    debugLog('UnifiedBashPre', 'effort-aware intensity resolved', { effortLevel });
  } catch (_) { /* effort-aware unavailable — fail-open with default 'medium' */ }
}

// ============================================================
// v2.1.14 Sub-Sprint 4 Stage 5 (ENH-286, differentiation #1): Memory Enforcer
// ------------------------------------------------------------
// CC treats CLAUDE.md as advisory (issues #56865, #57485, #58887 show the
// model overriding directives via R-3 evolved forms). bkit hard-enforces by
// extracting "Do NOT", "NEVER", "FORBIDDEN", "MUST NOT" directives at
// SessionStart, caching them to .bkit/runtime/memory-directives.json, and
// matching tool_input here on every Bash PreToolUse. A deny match short-
// circuits the hook with audit `memory_directive_enforced`. Verbosity scales
// with effortLevel ('low' → bare reason, 'high' → full directive context).
// ============================================================
if (!blocked) {
  try {
    const fs = require('fs');
    const path = require('path');
    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const cacheFile = path.join(root, '.bkit', 'runtime', 'memory-directives.json');
    let directives = [];
    if (fs.existsSync(cacheFile)) {
      try {
        const payload = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        const { deserializeMemoryDirectives } = require('../lib/defense');
        directives = deserializeMemoryDirectives(payload);
      } catch (e) {
        debugLog('UnifiedBashPre', 'memory-directives cache parse failed', { error: e.message });
      }
    }
    if (directives.length > 0) {
      const { enforceMemoryDirectives } = require('../lib/defense');
      const toolCall = {
        tool: 'Bash',
        command: (input && input.tool_input && input.tool_input.command) || '',
      };
      const verdict = enforceMemoryDirectives(toolCall, directives);
      if (!verdict.allowed && verdict.deniedBy) {
        const d = verdict.deniedBy;
        const verbose = effortLevel === 'high';
        const baseReason = `bkit Memory Enforcer: directive "${d.text.slice(0, 80)}" denied this command (rule: ${d.rule}, source: ${d.source}).`;
        const reason = verbose
          ? baseReason + ` Matched pattern: /${d.pattern.slice(0, 60)}/i.`
          : baseReason;
        // ENH-410 (v2.1.33): give the model something to do instead of a dead end.
        // Every other block site in this file already passes alternatives; this
        // one did not, and its recovery hint was buried in a prose sentence that
        // never reached the model at all (see the outputBlockWithContext call
        // below for why).
        const alternatives = [
          `Narrow the command so it no longer matches /${d.pattern.slice(0, 60)}/i`,
          `Edit the directive in ${d.source} if this command should be allowed`,
          'Ask the user for explicit confirmation before retrying',
        ];
        try {
          const audit = require('../lib/audit/audit-logger');
          audit.writeAuditLog({
            actor: 'hook', actorId: 'unified-bash-pre',
            action: 'memory_directive_enforced', category: 'control',
            target: toolCall.command.slice(0, 240) || 'unknown', targetType: 'tool_call',
            details: {
              tool: 'Bash',
              rule: d.rule,
              source: d.source,
              pattern: d.pattern.slice(0, 80),
              effortLevel,
              warnings: verdict.warnings.length,
            },
            result: 'blocked',
            destructiveOperation: false,
            reason,
          });
        } catch (_) { /* graceful */ }
        // ENH-410 (v2.1.33): was `outputBlock('deny', reason, 'PreToolUse')`.
        //
        // `outputBlock(reason)` takes ONE parameter (lib/core/io.js:346), so
        // `reason` bound to the literal 'deny' and the other two arguments were
        // dropped on the floor. Everything computed above — the directive text,
        // rule, source, matched pattern — was discarded, and the model received
        // exactly `{"decision":"block","reason":"deny"}`. Verified by execution.
        //
        // That mattered beyond cosmetics: with no stated cause, the model's
        // rational move is to retry the same command, and CC's auto mode pauses
        // after 3 consecutive blocks (aborting outright in headless `-p` runs,
        // per code.claude.com/docs/en/permission-modes.md:332-334).
        //
        // This is the Memory Enforcer path — bkit differentiation #1 — and the
        // four other block sites in this file already called the right helper.
        outputBlockWithContext(reason, alternatives, 'PreToolUse');
        blocked = true;
      } else if (verdict.warnings.length > 0 && effortLevel === 'high') {
        // High-effort mode surfaces soft warnings to the user via debug log.
        debugLog('UnifiedBashPre', 'memory-directive warn matched', {
          count: verdict.warnings.length, first: verdict.warnings[0].rule,
        });
      }
    }
  } catch (_) { /* memory-enforcer unavailable — fail-open */ }
}

// v2.1.33 (D4): the v2.0.0 "Scope Limiter" placeholder block was removed here.
// It required scope-limiter and automation-controller, called getCurrentLevel(),
// discarded both results, and swallowed any error — a provable no-op, verified
// on five points before removal (unused symbols, no module-load side effects, a
// redundant require already satisfied at lines 248/314, a read-only
// getCurrentLevel, and zero write primitives in automation-controller).
// Archived with that reasoning at .backup/v2.1.33/ (git-ignored).
// The genuine Bash-path scope enforcement gap it appeared to cover is tracked
// as ENH-388 / ENH-398, which restore real blocking rather than a placeholder.

// ============================================================
// Sprint 4.5 Integration: CC regression attribution (ENH-262 / #51798)
// Best-effort — attribution only, never blocks. bkit does NOT fix the CC
// regression; it surfaces "not a bkit failure" context when the combo hits.
// ============================================================
let ccRegressionAttr = '';
if (!blocked) {
  try {
    const ccRegression = require('../lib/cc-regression');
    const toolInput = parseHookInput(input);
    const envOverrides = {
      dangerouslyDisableSandbox:
        process.env.CLAUDE_CODE_DANGEROUSLY_DISABLE_SANDBOX === '1' ||
        process.env.CLAUDE_DANGEROUSLY_DISABLE_SANDBOX === '1',
    };
    const result = ccRegression.checkCCRegression({
      tool: 'Bash',
      command: toolInput.command,
      envOverrides,
      permissionDecision: input.permissionDecision || 'allow',
      // ENH-469 (v2.1.37): from the field CC actually sends. The old
      // `input.bypassPermissions` read a top-level key that is not in the
      // measured payload, so it was always false.
      bypassPermissions: permissionMode === 'bypassPermissions',
      // ENH-471 (v2.1.37): retire guards whose regression CC has already fixed.
      // Read from SessionStart's cache — no subprocess on the hook path.
      ccVersion: (() => {
        try {
          return require('../lib/infra/cc-version-checker').readCachedVersion();
        } catch (_) { return null; }
      })(),
    });
    if (result && Array.isArray(result.attributions) && result.attributions.length > 0) {
      ccRegressionAttr = ' | ' + result.attributions.join(' | ');
      debugLog('UnifiedBashPre', 'CC regression attribution', {
        attr: ccRegressionAttr.slice(0, 80),
      });
    }
  } catch (e) {
    debugLog('UnifiedBashPre', 'cc-regression unavailable', { error: e.message });
  }
}

// A parked confirmation is emitted only here, once every deny-capable guard
// above has run and declined to fire. Audited at the point of emission so the
// trail records the decision that was actually taken — an `ask` entry written
// where the ask was merely *considered* would be the same false-assurance the
// hardcoded `result: 'blocked'` used to produce (ENH-393).
if (!blocked && pendingAsk && askSuppressed) {
  /*
   * ENH-466 (v2.1.37) — the first of the two checks described in the design.
   *
   * It lives here rather than only inside outputAsk() because this is where the
   * audit context is: the rule ids, the confidence, the command. outputAsk()
   * re-checks as a backstop for a call site added later that forgets this one.
   */
  auditSuppressedAsk(pendingAsk, 'destructive-detector');
  debugLog('UnifiedBashPre', 'Ask suppressed by permission mode', {
    permissionMode, ask: pendingAsk.ids,
  });
  pendingAsk = null;
}

if (!blocked && pendingAsk) {
  try {
    const audit = require('../lib/audit/audit-logger');
    audit.writeAuditLog({
      actor: 'hook', actorId: 'unified-bash-pre',
      action: 'destructive_confirmation_requested', category: 'control',
      target: pendingAsk.command.substring(0, 100), targetType: 'file',
      details: { rules: pendingAsk.ids, confidence: pendingAsk.confidence, permissionMode },
      result: 'ask', destructiveOperation: true,
      reason: pendingAsk.reason,
    });
  } catch (_) { /* graceful — auditing must never prevent the prompt */ }
  debugLog('UnifiedBashPre', 'Hook completed', { blocked, ask: pendingAsk.ids });
  // ENH-459 (v2.1.36): the parked advice, which fits the rule that asked. This
  // was a fixed pair of lines, so a push-guard confirmation and a scoped-delete
  // confirmation offered identical, generic suggestions.
  outputAsk(
    pendingAsk.reason,
    pendingAsk.alternatives && pendingAsk.alternatives.length
      ? pendingAsk.alternatives
      : [
        'Confirm the exact target is the one you mean',
        'Run the operation on a copy, or dry-run it first, to confirm the blast radius',
      ],
    permissionMode
  );
}

// Allow if neither blocked nor awaiting confirmation
if (!blocked) {
  // br008: silent on success — per-call "validated." context lines were parked
  // and re-injected between turns (~KBs/turn of hook spam). Allow is the
  // default; speak only when something needs attention (block/ask paths above).
  if (process.env.BKIT_VERBOSE_VALIDATION === '1') {
    const contextMsg = activeSkill || activeAgent
      ? `Bash command validated for ${activeSkill || activeAgent}.`
      : 'Bash command validated.';
    outputAllow(contextMsg + ccRegressionAttr, 'PreToolUse');
  }
}

debugLog('UnifiedBashPre', 'Hook completed', { blocked, ask: null });
