#!/usr/bin/env node
/**
 * pre-write.js — PreToolUse hook pipeline for Write|Edit operations.
 *
 * Design Ref: bkit-v2110-integrated-enhancement.design.md §4.2
 * Plan SC: Sprint 1 파이프라인화 — 순수 함수 체인으로 재구성, silent catch 4회 → debugLog 의무화,
 *   CC regression attribution (ENH-262/263) 통합.
 *
 * Philosophy: Automation First — Guide, don't block (exception: permission=deny / explicit danger).
 *
 * @module scripts/pre-write
 * @version 2.1.15
 */

const {
  readStdinSync,
  parseHookInput,
  outputAllow,
  outputBlock,
  // ENH-398 (v2.1.33): scope denials block with a reason and alternatives.
  outputBlockWithContext,
  outputEmpty,
} = require('../lib/core/io');
const { debugLog } = require('../lib/core/debug');
const { isSourceFile, isCodeFile, isEnvFile, extractFeature } = require('../lib/core/file');
const { findDesignDoc, findPlanDoc } = require('../lib/pdca/phase');
const { updatePdcaStatus, getPdcaStatusFull } = require('../lib/pdca/status');
const { classifyTaskByLines, getPdcaLevel } = require('../lib/task/classification');
const { generateTaskGuidance } = require('../lib/task/creator');

// Optional Permission Manager (v1.4.2 FR-05).
let permissionManager = null;
try {
  permissionManager = require('../lib/permission-manager.js');
} catch (e) {
  debugLog('PreToolUse', 'permissionManager not available', { error: e.message });
}

// CC Regression facade (v2.1.10 ENH-262/263 attribution).
let ccRegression = null;
try {
  ccRegression = require('../lib/cc-regression');
} catch (e) {
  debugLog('PreToolUse', 'cc-regression not available', { error: e.message });
}

/**
 * ENH-471 (v2.1.37): the CC version SessionStart already detected, or null.
 * Optional by design — a missing checker or cache retires nothing, which is the
 * behaviour bkit had before guard lifecycles were applied at all.
 *
 * @returns {string|null}
 */
function readCachedCcVersion() {
  try {
    return require('../lib/infra/cc-version-checker').readCachedVersion();
  } catch (e) {
    debugLog('PreToolUse', 'cc-version cache unavailable', { error: e.message });
    return null;
  }
}

const PDCA_DOC_PATTERNS = [
  /docs\/01-plan\/.*\.plan\.md$/,
  /docs\/02-design\/.*\.design\.md$/,
  /docs\/03-analysis\/.*\.analysis\.md$/,
  /docs\/04-report\/.*\.report\.md$/,
  /docs\/05-qa\/.*\.qa-report\.md$/,
  /docs\/00-pm\/.*\.prd\.md$/,
];

// ============================================================
// Pipeline stages (pure functions — side-effects localized)
// ============================================================

/**
 * Stage 0: Permission Manager check. Returns { deny, denyReason, askContext }.
 */
function runPermissionCheck(ctx) {
  if (!permissionManager) return {};
  const toolName = ctx.input.tool_name || 'Write';
  const permission = permissionManager.checkPermission(toolName, ctx.filePath);
  if (permission === 'deny') {
    return { deny: true, denyReason: `${toolName} to ${ctx.filePath} is denied by permission policy.` };
  }
  if (permission === 'ask') {
    return { askContext: `${toolName} to ${ctx.filePath} requires confirmation.` };
  }
  return {};
}

/**
 * Stage 1: Task classification via line count.
 */
function runTaskClassification(ctx) {
  if (!ctx.content) return { classification: 'quick_fix', pdcaLevel: 'none', lineCount: 0 };
  const lineCount = ctx.content.split('\n').length;
  const classification = classifyTaskByLines(ctx.content);
  const pdcaLevel = getPdcaLevel(classification);
  return { classification, pdcaLevel, lineCount };
}

/**
 * Stage 2: PDCA document check + phantom feature guard.
 */
function runPdcaDocCheck(ctx) {
  const out = { feature: '', designDoc: '', planDoc: '' };
  if (!isSourceFile(ctx.filePath)) return out;
  const feature = extractFeature(ctx.filePath);
  if (!feature) return out;

  out.feature = feature;
  out.designDoc = findDesignDoc(feature);
  out.planDoc = findPlanDoc(feature);

  /*
   * v2.1.7 (issue #79 P4) + v2.1.15 (issue #89): read `primaryFeature`.
   *
   * `currentFeature` does not exist on the v2/v3 schema — the migration
   * normalises it away (lib/pdca/status-migration.js:74). The old code
   * therefore always read undefined: the phantom-write block appeared to work
   * because a false condition happens to block, while `updatePdcaStatus` was
   * never called, which is a false negative in the other direction.
   *
   * This reads the real key, and the L3 gate (plan/design documents present)
   * backs it up.
   *
   * v2.1.34: three further sites were still reading `currentFeature` when this
   * note was written and are now fixed too — lib/orchestrator/
   * skill-invocation-effects.js (×2) and lib/orchestrator/runtime-guidance.js.
   * A note describing a defect is not a fix for the other places it lives.
   */
  try {
    const currentStatus = getPdcaStatusFull();
    const activeFeature = currentStatus?.primaryFeature;
    if (activeFeature && activeFeature === feature) {
      // L3 게이트가 plan/design 문서 부재 시 silent no-op 보장
      updatePdcaStatus(feature, 'do', { lastFile: ctx.filePath });
      debugLog('PreToolUse', 'PDCA status updated', {
        feature,
        phase: 'do',
        hasDesignDoc: !!out.designDoc,
      });
    } else {
      debugLog('PreToolUse', 'Skipped phantom feature registration', {
        extracted: feature,
        active: activeFeature || 'none',
      });
    }
  } catch (e) {
    debugLog('PreToolUse', 'PDCA update failed', { error: e.message });
  }
  return out;
}

/**
 * Stage 2.5: PDCA Skill bypass warning.
 */
function runPdcaBypassDetection(ctx) {
  if (!PDCA_DOC_PATTERNS.some((p) => p.test(ctx.filePath))) return null;
  if (process.env.CLAUDE_SKILL_NAME) return null; // invoked via skill → OK.
  debugLog('PreToolUse', 'PDCA skill bypass detected', { filePath: ctx.filePath });
  return (
    '[PDCA COMPLIANCE] This file is a PDCA document. ' +
    'Use /pdca command instead of direct Write/Edit. ' +
    'Direct writes bypass template injection, state tracking, and quality gates.'
  );
}

/**
 * Stage 3: PDCA guidance (no blocking).
 */
function runPdcaGuidance(ctx, pdcaCtx, taskCtx) {
  const { pdcaLevel, lineCount } = taskCtx;
  const { designDoc, planDoc, feature } = pdcaCtx;
  const parts = [];
  switch (pdcaLevel) {
    case 'none':
      break;
    case 'light':
      parts.push(`Minor change (${lineCount} lines). PDCA optional.`);
      break;
    case 'recommended':
      if (designDoc) parts.push(`Feature (${lineCount} lines). Design doc exists: ${designDoc}`);
      else if (feature)
        parts.push(
          `Feature (${lineCount} lines). Design doc recommended for '${feature}'. Consider /pdca-design ${feature}`
        );
      else parts.push(`Feature-level change (${lineCount} lines). Design doc recommended.`);
      break;
    case 'required':
      if (designDoc)
        parts.push(
          `Major feature (${lineCount} lines). Design doc exists: ${designDoc}. Refer during implementation.`
        );
      else if (feature)
        parts.push(
          `Major feature (${lineCount} lines) without design doc. Strongly recommend /pdca-design ${feature} first.`
        );
      else
        parts.push(
          `Major feature (${lineCount} lines). Design doc strongly recommended before implementation.`
        );
      break;
  }
  if (planDoc && !designDoc && pdcaLevel !== 'none' && pdcaLevel !== 'light') {
    parts.push(`Plan exists at ${planDoc}. Design doc not yet created.`);
  }
  return parts;
}

/**
 * Stage 4: Convention hints.
 */
function runConventionHints(ctx, taskCtx) {
  const { pdcaLevel } = taskCtx;
  if (isCodeFile(ctx.filePath)) {
    if (pdcaLevel === 'recommended' || pdcaLevel === 'required') {
      return 'Conventions: Components=PascalCase, Functions=camelCase, Constants=UPPER_SNAKE_CASE';
    }
  } else if (isEnvFile(ctx.filePath)) {
    return 'Env naming: NEXT_PUBLIC_* (client), DB_* (database), API_* (external), AUTH_* (auth)';
  }
  return null;
}

/**
 * Stage 5: Task system guidance (v1.3.1 FR-02).
 */
function runTaskSystemGuidance(ctx, pdcaCtx, taskCtx) {
  const { pdcaLevel } = taskCtx;
  const { feature } = pdcaCtx;
  if (feature && (pdcaLevel === 'recommended' || pdcaLevel === 'required')) {
    return generateTaskGuidance('do', feature, 'design');
  }
  return null;
}

/**
 * Stage 6: Destructive detector (v2.0.0 control module).
 *
 * registry-lockdown (2026-09-07): deny-action rules now BLOCK. Before this,
 * every detection was pushed into `contextParts` and emitted via
 * `outputAllow` — the engine correctly detected G-020 on a registry Write
 * while the write proceeded, and the audit trail recorded
 * `destructive_blocked` / `result: 'blocked'` for writes that were actually
 * allowed (the ENH-388 false-assurance class, live-confirmed by probe). The
 * verdict-object pattern is ENH-398's scope block, 20 lines below.
 */
function runDestructiveDetector(ctx) {
  try {
    const dd = require('../lib/control/destructive-detector');
    const toolInput = { file_path: ctx.filePath, content: ctx.content };
    const result = dd.detect('Write', toolInput);
    if (result.detected) {
      const denying = (result.rules || []).filter((r) => r.action === 'deny');
      if (denying.length > 0) {
        try {
          const audit = require('../lib/audit/audit-logger');
          audit.writeAuditLog({
            actor: 'hook',
            actorId: 'pre-write',
            action: 'destructive_blocked',
            category: 'control',
            target: toolInput.file_path || '',
            targetType: 'file',
            details: { rules: result.rules },
            result: 'blocked',
            destructiveOperation: true,
            blastRadius: 'medium',
          });
        } catch (e) {
          debugLog('PreToolUse', 'audit write failed (destructive)', { error: e.message });
        }
        return {
          block: true,
          rule: denying[0].id,
          reason: `Destructive operation denied: ${denying.map((r) => `${r.id} (${r.name})`).join('; ')}.`,
          alternatives: [
            'The PDCA registry (.bkit/state/) is broker-only-writable — phases advance ONLY by firing the skill: /pdca <phase> <feature>',
            'To archive a completed feature, run: node scripts/pdca-archive.js <feature> (dry-run first, --apply to mutate)',
            'To READ state, use the bkit_pdca_status MCP tool instead of writing or opening the registry',
          ],
        };
      }
      // Advisory detections (ask-grade rules) stay annotations — with an
      // honest audit entry. 'blocked' is reserved for actual blocks now.
      try {
        const audit = require('../lib/audit/audit-logger');
        audit.writeAuditLog({
          actor: 'hook',
          actorId: 'pre-write',
          action: 'destructive_detected',
          category: 'control',
          target: toolInput.file_path || '',
          targetType: 'file',
          details: { rules: result.rules },
          result: 'advisory',
          destructiveOperation: false,
          blastRadius: 'medium',
        });
      } catch (e) {
        debugLog('PreToolUse', 'audit write failed (destructive advisory)', { error: e.message });
      }
      return `Destructive operation detected: ${result.rules.map((r) => r.id || r.reason).join(', ')}`;
    }
  } catch (e) {
    debugLog('PreToolUse', 'destructive detector failed', { error: e.message });
  }
  return null;
}

/**
 * Stage 7: Blast radius.
 */
function runBlastRadius(ctx) {
  try {
    const br = require('../lib/control/blast-radius');
    const check = br.checkSingleFile(ctx.filePath, ctx.content?.length || 0);
    if (check.warning) return `Blast radius warning: ${check.warning}`;
  } catch (e) {
    debugLog('PreToolUse', 'blast radius failed', { error: e.message });
  }
  return null;
}

/**
 * Stage 8: Scope limiter.
 */
function runScopeLimiter(ctx) {
  try {
    const sl = require('../lib/control/scope-limiter');
    const ac = require('../lib/control/automation-controller');
    const level = ac.getCurrentLevel();
    const scopeCheck = sl.checkPathScope(ctx.filePath, level);
    if (!scopeCheck.allowed) {
      /*
       * ENH-398 (v2.1.33): distinguish a security rule from a level policy.
       *
       * Every scope refusal used to come back as advisory text that main()
       * pushed into `contextParts` and then emitted through `outputAllow` — the
       * write went ahead regardless. Wiring all of them to block is not right
       * either: NOT_IN_SCOPE means "outside the allowlist for this automation
       * level", and L0's allowlist is narrow enough that blocking on it would
       * refuse ordinary edits (measured: lib/core/io.js is NOT_IN_SCOPE at L0).
       * That is a policy signal, and it stays advisory.
       *
       * These three are unambiguous security decisions, so they block:
       *   DENIED_PATH     — the path matches the deny list (.env, keys, .git…)
       *   SYMLINK_ESCAPE  — a symlink resolves outside the project root
       *   NULL_BYTE       — path truncation attempt
       *
       * PATH_TRAVERSAL is deliberately NOT in this list. As implemented it
       * fires whenever the resolved path sits outside `process.cwd()`, which
       * covers ordinary work — writing to a scratch directory, /tmp, or another
       * checkout — not just `../` escapes. Hard-blocking it made the hook
       * refuse legitimate absolute paths the moment it was wired up (caught
       * while writing this change: the hook blocked a write to the session
       * scratchpad). Distinguishing a relative path that escapes from an
       * absolute path that simply points elsewhere needs a rule change in
       * lib/control/scope-limiter.js, so until then it stays advisory rather
       * than blocking ordinary use.
       */
      const HARD_DENY_RULES = ['DENIED_PATH', 'SYMLINK_ESCAPE', 'NULL_BYTE'];
      const reason = `Scope limit: ${scopeCheck.reason || 'Path not allowed at current automation level'}`;
      if (HARD_DENY_RULES.includes(scopeCheck.rule)) {
        return {
          block: true,
          rule: scopeCheck.rule,
          reason,
          alternatives: [
            'Write to a path outside the denied list — secrets, keys and VCS internals are never writable through bkit',
            'If this file genuinely must change, edit it directly outside the agent session',
            'Ask the user to confirm and adjust the scope policy if the deny rule is wrong',
          ],
        };
      }
      return reason;
    }
  } catch (e) {
    debugLog('PreToolUse', 'scope limiter failed', { error: e.message });
  }
  return null;
}

/**
 * Stage 8.5 (v2.1.10 NEW): CC regression attribution — ENH-262/263.
 * bkit does NOT block — only provides user attribution when CC will surface a prompt.
 *
 * ENH-469 (v2.1.37) — `bypassPermissions` now comes from the field Claude Code
 * actually sends.
 *
 * It used to read `ctx.input.bypassPermissions`, a top-level key that does not
 * exist. The measured PreToolUse payload is exactly: cwd, effort,
 * hook_event_name, permission_mode, prompt_id, session_id, tool_input, tool_name,
 * tool_use_id, transcript_path. So the flag was always `undefined` → `false`, and
 * the ENH-263 guard, whose first condition is `if (!ctx.bypassPermissions)`, has
 * never fired in production since it shipped in v2.1.10. The wrong field name
 * came from lib/domain/ports/cc-payload.port.js, which documented a `permissions`
 * object CC has never sent; that typedef is corrected in the same change.
 *
 * `permissionDecision` is deliberately left absent rather than defaulted. It is a
 * hook OUTPUT field, not an input one, and inventing a value for it here would
 * make the ENH-262 guard fire on a condition nobody measured.
 */
function runCCRegressionCheck(ctx) {
  if (!ccRegression) return null;
  try {
    const result = ccRegression.checkCCRegression({
      tool: ctx.input.tool_name || 'Write',
      filePath: ctx.filePath,
      bypassPermissions: ctx.permissionMode === 'bypassPermissions',
      permissionDecision: ctx.input.permissionDecision,
      envOverrides: ctx.input.envOverrides || {},
      // ENH-471 (v2.1.37): lets the coordinator retire guards whose regression CC
      // has already fixed. Read from SessionStart's cache — never re-detected, so
      // no subprocess runs on the hook path.
      ccVersion: readCachedCcVersion(),
    });
    if (result.attributions && result.attributions.length > 0) {
      return result.attributions.join(' | ');
    }
  } catch (e) {
    debugLog('PreToolUse', 'cc-regression check failed', { error: e.message });
  }
  return null;
}

/**
 * Stage 9: Audit log (file_modified).
 */
function runAuditLog(ctx, opts = {}) {
  // H8/H9 fix (audit): every exit path now records an audit entry. Previously the
  // permission-deny path (process.exit(2)) ran before this function, so security-
  // relevant denials vanished from the audit trail. opts lets the deny path log
  // result='denied' + the deny reason instead of the default 'success'.
  try {
    const audit = require('../lib/audit/audit-logger');
    audit.writeAuditLog({
      actor: 'hook',
      actorId: 'pre-write',
      action: 'file_modified',
      category: 'file',
      target: ctx.filePath || '',
      targetType: 'file',
      result: opts.result || 'success',
      destructiveOperation: opts.destructiveOperation || false,
      denyReason: opts.denyReason || undefined,
    });
  } catch (e) {
    debugLog('PreToolUse', 'audit log failed', { error: e.message });
  }
}

// ============================================================
// Main orchestrator
// ============================================================

function main() {
  const input = readStdinSync();
  // v2.1.37: `permissionMode` is normalized by parseHookInput — absent or
  // unrecognized becomes 'default', which changes nothing.
  const { filePath, content, permissionMode } = parseHookInput(input);
  debugLog('PreToolUse', 'Hook started', { filePath: filePath || 'none', permissionMode });

  if (!filePath) {
    debugLog('PreToolUse', 'Skipped - no file path');
    outputEmpty();
    process.exit(0);
  }

  /*
   * Every decision this pipeline can make is `critical` or `policy` grade — a
   * denied path (secrets, keys, VCS internals), a symlink escape, a null byte,
   * or the permission policy itself. None of those relax under any permission
   * mode, so the mode is carried for attribution (ENH-469) rather than gating.
   * See lib/domain/policy/permission-mode-policy.js §"WHAT IS AND IS NOT RELAXED".
   */
  const ctx = { input, filePath, content, permissionMode };
  const contextParts = [];

  // Stage 0: Permission
  const perm = runPermissionCheck(ctx);
  if (perm.deny) {
    debugLog('PreToolUse', 'Permission denied', { filePath });
    // H8/H9 fix (audit): record the denial BEFORE exiting — otherwise security-
    // relevant permission denials never reach the audit trail.
    runAuditLog(ctx, { result: 'denied', denyReason: perm.denyReason });
    outputBlock(perm.denyReason);
    process.exit(2);
  }
  if (perm.askContext) contextParts.push(perm.askContext);

  // Stages 1-2
  const taskCtx = runTaskClassification(ctx);
  const pdcaCtx = runPdcaDocCheck(ctx);

  // Stage 2.5: PDCA bypass
  const bypass = runPdcaBypassDetection(ctx);
  if (bypass) contextParts.push(bypass);

  // Stage 3-5
  contextParts.push(...runPdcaGuidance(ctx, pdcaCtx, taskCtx));
  const conv = runConventionHints(ctx, taskCtx);
  if (conv) contextParts.push(conv);
  const taskGuide = runTaskSystemGuidance(ctx, pdcaCtx, taskCtx);
  if (taskGuide) contextParts.push(taskGuide);

  // Stage 6-8
  const dest = runDestructiveDetector(ctx);
  /*
   * registry-lockdown: a deny-action detection must stop the write. Same
   * verdict-object contract as the scope block below — advisory strings
   * still flow into contextParts.
   */
  if (dest && typeof dest === 'object' && dest.block) {
    debugLog('PreToolUse', 'Destructive denied', { filePath, rule: dest.rule });
    outputBlockWithContext(dest.reason, dest.alternatives, 'PreToolUse');
    return;
  }
  if (dest) contextParts.push(dest);
  const blast = runBlastRadius(ctx);
  if (blast) contextParts.push(blast);
  const scope = runScopeLimiter(ctx);
  /*
   * ENH-398 (v2.1.33): a hard scope denial must stop the write.
   *
   * Before this, every stage below Permission returned advisory text that was
   * collected into `contextParts` and emitted via `outputAllow` at the end of
   * this function — so a path on the deny list was described to the model and
   * then written anyway. The only real block on this path was the Permission
   * Manager at the top. `runScopeLimiter` now returns a verdict object for the
   * security rules (deny list, traversal, symlink escape, null byte) and plain
   * text for the level-policy case, which stays advisory on purpose.
   */
  if (scope && typeof scope === 'object' && scope.block) {
    debugLog('PreToolUse', 'Scope denied', { filePath, rule: scope.rule });
    runAuditLog(ctx, { result: 'denied', denyReason: scope.reason });
    outputBlockWithContext(scope.reason, scope.alternatives, 'PreToolUse');
    return;
  }
  if (scope) contextParts.push(typeof scope === 'string' ? scope : scope.reason);

  // Stage 8.5 (v2.1.10): CC regression attribution
  const ccAttr = runCCRegressionCheck(ctx);
  if (ccAttr) contextParts.push(ccAttr);

  // Stage 9: Audit log (non-blocking)
  runAuditLog(ctx);

  debugLog('PreToolUse', 'Hook completed', {
    classification: taskCtx.classification,
    pdcaLevel: taskCtx.pdcaLevel,
    feature: pdcaCtx.feature || 'none',
    contextCount: contextParts.length,
  });

  if (contextParts.length > 0) {
    outputAllow(contextParts.join(' | '), 'PreToolUse');
  } else {
    outputEmpty();
  }
}

// Export pipeline stages for unit testing (v2.1.10).
module.exports = {
  runPermissionCheck,
  runTaskClassification,
  runPdcaDocCheck,
  runPdcaBypassDetection,
  runPdcaGuidance,
  runConventionHints,
  runTaskSystemGuidance,
  runDestructiveDetector,
  runBlastRadius,
  runScopeLimiter,
  runCCRegressionCheck,
  runAuditLog,
  PDCA_DOC_PATTERNS,
};

if (require.main === module) main();
