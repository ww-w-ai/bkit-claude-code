/**
 * bkit Vibecoding Kit - SessionStart: Session Context Builder Module (v2.1.40)
 *
 * Builds the additionalContext string for the SessionStart hook response.
 * Includes PDCA status injection, Feature Usage rules, Executive Summary rules,
 * Agent Teams info, Output Styles info, bkend MCP info.
 *
 * v2.1.20 (F10 + ENH-323): adds detectCCVersion() + buildCCVersionAdvisoryContext()
 * to surface a Claude Code v2.1.143+ minimum-version advisory at SessionStart
 * (once-per-session cap, .bkit/runtime/cc-version.json cache 1h TTL, opt-out via
 * BKIT_DISABLE_CC_VERSION_DETECTION=1, OTEL emit via gen_ai.cc_version_detection_ms).
 * Trigger: external dogfooder @bj 2026-05-26 install incident. See ADR 0011.
 *
 * ENH-368 (v2.1.25): adds a model-floor advisory — when 2.1.143 ≤ CC < 2.1.170,
 * the 6 Fable-pinned agents hard-fail at spawn (`fable` alias introduced in
 * CC v2.1.170). Reuses the same detection plumbing (no second process spawn).
 */

const fs = require('fs');
const path = require('path');
// v2.1.35 (ENH-428): CC version detection no longer spawns its own shell here —
// it delegates to lib/infra/cc-version-checker's shared, argv-based helper.
const { detectLevel } = require('../../lib/pdca/level');
const { debugLog } = require('../../lib/core/debug');
const { getPdcaStatusFull } = require('../../lib/pdca/status');
const { getUIConfig } = require('../../lib/core/config');
const { applyBudget } = require('../../lib/core/context-budget');
// v2.1.10 (ENH-167 final): removed hard-coded "v2.1.9" — uses centralized BKIT_VERSION
const { BKIT_VERSION } = require('../../lib/core/version');
// v2.1.11 (FR-α2-c): One-Liner SSoT — surfaces bkit identity in SessionStart intro
const { ONE_LINER_EN } = require('../../lib/infra/branding');
// ENH-368 (v2.1.25): model-floor advisory — single floor constant lives in infra layer
const { FABLE_MODEL_FLOOR } = require('../../lib/infra/cc-version-checker');

// ─────────────────────────────────────────────────────────────────────────────
// v2.1.20 (F10 + ENH-323): Claude Code version detection at SessionStart
// ─────────────────────────────────────────────────────────────────────────────
// Trigger: external dogfooder @bj 2026-05-26 install incident — the
// strict plugin-manifest path in CC ≤ v2.1.142 rejects bkit's displayName
// field. SessionStart-time detection forward-proofs users who upgrade bkit
// before upgrading CC.
//
// Performance budget:
//   - Strategy 0 (ENH-375): `~/.local/bin/claude` symlink read — no subprocess
//   - shared argv-based subprocess helper, 1000ms hard cap (fallback only)
//   - .bkit/runtime/cc-version.json cache 1h TTL on success
//   - failed detections cached for 60s only, so a transient failure retries
//     instead of pinning "unknown" for an hour (ENH-375)
//   - once-per-session cap (identical session reuses cache mtime)
//   - opt-out via BKIT_DISABLE_CC_VERSION_DETECTION=1
//   - OTEL emit: gen_ai.cc_version_detection_ms (3-month telemetry → v2.1.21+
//     decision to keep/demote)
//
// Reference: docs/sprint/v2120-marketplace-recovery/design.md §3.4
// Reference: docs/adr/0011-plugin-manifest-schema-compliance.md § Decision

const CC_MIN_VERSION = '2.1.143';
const CC_VERSION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (successful detection)

// ENH-375: a failed detection gets its own, much shorter TTL. Caching a failure
// for the full hour is what turned one timeout into a permanently dead
// advisory — the cache read below accepts `version: null` as a hit, so every
// later session short-circuited to "unknown" without retrying.
const CC_VERSION_FAILURE_CACHE_TTL_MS = 60 * 1000; // 1 minute

// ENH-375: raised from 200ms. Claude Code ships as a ~264 MB native binary and
// `claude --version` measured 302–327 ms on the reference machine (5/5 runs),
// so the old cap could never succeed — detection failed 100% of the time and
// the CC-version advisory never rendered. 1000 ms leaves roughly 3x headroom for
// a slower machine while still aborting well before a hung binary becomes
// noticeable at session start. This path is only a fallback anyway: Strategy 0
// resolves the version for free on a native install.
const CC_VERSION_DETECT_TIMEOUT_MS = 1000;

/**
 * Compare two semver-ish strings (returns true if a < b).
 * Local helper to avoid extra deps; matches lib/cc-regression/registry.js
 * semverLt pattern.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function ccVersionLt(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true;
    if (pa[i] > pb[i]) return false;
  }
  return false;
}

/**
 * Detect installed Claude Code version + emit advisory if < v2.1.143.
 *
 * Once-per-session cap + cache 1h TTL on success (.bkit/runtime/cc-version.json);
 * failed detections expire after 60s so they retry (ENH-375).
 * Opt-out: BKIT_DISABLE_CC_VERSION_DETECTION=1.
 * Performance: installer-symlink read first (no subprocess); the
 * `claude --version` fallback carries a 1000ms hard cap.
 *
 * @returns {{
 *   version: string | null,
 *   isOldVersion: boolean,
 *   advisory: string | null,
 *   source: 'cache' | 'fresh' | 'skipped'
 * }}
 */
function detectCCVersion() {
  // 1. Opt-out env check
  if (process.env.BKIT_DISABLE_CC_VERSION_DETECTION === '1') {
    debugLog('SessionStart', 'CC version detection skipped (BKIT_DISABLE_CC_VERSION_DETECTION=1)', {});
    return { version: null, isOldVersion: false, advisory: null, source: 'skipped' };
  }

  const cwd = process.cwd();
  const cacheDir = path.join(cwd, '.bkit', 'runtime');
  const cachePath = path.join(cacheDir, 'cc-version.json');

  // 2. Cache check (mtime within TTL)
  //
  // ENH-375: a cached entry with `version: null` records a FAILED detection, not
  // a valid answer. The previous guard (`typeof cached.version !== 'undefined'`)
  // accepted it — `typeof null` is `'object'` — so one timeout pinned "unknown"
  // for the full hour and the next session re-cached the same failure, making
  // the advisory permanently dead. Failures now expire in a minute and only a
  // successful detection earns the long TTL.
  try {
    if (fs.existsSync(cachePath)) {
      const stat = fs.statSync(cachePath);
      const ageMs = Date.now() - stat.mtimeMs;
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached && typeof cached === 'object') {
        const isSuccess = typeof cached.version === 'string' && cached.version.length > 0;
        const ttl = isSuccess ? CC_VERSION_CACHE_TTL_MS : CC_VERSION_FAILURE_CACHE_TTL_MS;
        if (ageMs < ttl) {
          // A cached failure is still honoured, but only for a minute — long
          // enough to stop back-to-back sessions each paying the fallback
          // subprocess timeout, short enough that detection recovers on its own.
          return {
            version: isSuccess ? cached.version : null,
            isOldVersion: isSuccess ? !!cached.isOldVersion : false,
            advisory: isSuccess && cached.isOldVersion ? buildCCAdvisoryText(cached.version) : null,
            source: 'cache',
          };
        }
      }
    }
  } catch (_e) {
    // fail-open: continue to fresh detection
  }

  // 3. Fresh detection
  const startTime = Date.now();
  let version = null;
  let detectError = null;

  // Strategy 0 (ENH-375): native-installer symlink — no subprocess, no timeout.
  // Tried first because the subprocess path below cannot beat its own budget on
  // a native-binary install.
  try {
    const { readVersionFromInstallerSymlink } = require('../../lib/infra/cc-version-checker');
    version = readVersionFromInstallerSymlink();
  } catch (_e) {
    // fail-open: fall through to the subprocess strategy
  }

  // Strategy 1: subprocess fallback (npm installs, Windows, non-standard layouts)
  // ENH-427/428 (v2.1.35): shared, shell-free implementation. This budget stays
  // local — a SessionStart hook cannot afford the checker's default.
  if (version === null) {
    try {
      const { detectViaSubprocess } = require('../../lib/infra/cc-version-checker');
      version = detectViaSubprocess(CC_VERSION_DETECT_TIMEOUT_MS);
      if (version === null) {
        detectError = 'claude --version produced no parsable version';
        debugLog('SessionStart', 'CC version detection failed', { error: detectError });
      }
    } catch (e) {
      detectError = e.message || String(e);
      debugLog('SessionStart', 'CC version detection failed', { error: detectError });
    }
  }
  const durationMs = Date.now() - startTime;

  // 4. Semver compare
  const isOldVersion = version !== null && ccVersionLt(version, CC_MIN_VERSION);

  // 5. OTEL emit (best-effort; silent on failure)
  try {
    const telemetry = require('../../lib/infra/telemetry');
    if (telemetry && typeof telemetry.emit === 'function') {
      telemetry.emit({
        name: 'gen_ai.cc_version_detection_ms',
        value: durationMs,
        attributes: { version, isOldVersion, source: 'fresh', hasError: detectError !== null },
      });
    }
  } catch (_e) {
    // fail-open
  }

  // 6. Env set for downstream consumers
  if (isOldVersion) {
    process.env.BKIT_CC_VERSION_ADVISORY = '1';
  }

  // 7. Cache update (best-effort)
  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(cachePath, JSON.stringify({
      version,
      isOldVersion,
      detectedAt: new Date().toISOString(),
      ttlSeconds: CC_VERSION_CACHE_TTL_MS / 1000,
      detectError,
    }, null, 2));
  } catch (_e) {
    // fail-open
  }

  return {
    version,
    isOldVersion,
    advisory: isOldVersion ? buildCCAdvisoryText(version) : null,
    source: 'fresh',
  };
}

/**
 * Build the human-readable advisory text shown in additionalContext when
 * the installed CC < v2.1.143.
 *
 * @param {string|null} version
 * @returns {string}
 */
function buildCCAdvisoryText(version) {
  const v = version || 'unknown';
  return [
    `## ⚠️ bkit Compatibility Notice — Claude Code v${v} detected (< v${CC_MIN_VERSION})`,
    '',
    `bkit v${BKIT_VERSION} requires **Claude Code v${CC_MIN_VERSION} or later** because the`,
    'strict plugin-manifest path in Claude Code ≤ v2.1.142 rejects the official',
    '`displayName` field (incident: external dogfooder 정병진 @bj 2026-05-26).',
    '',
    'Recommended fix:',
    '',
    '    npm install -g @anthropic-ai/claude-code@latest',
    '',
    'See [`docs/06-guide/cc-compatibility.guide.md`](docs/06-guide/cc-compatibility.guide.md)',
    'for the full workaround + ADR 0011 policy.',
    '',
    'To suppress this advisory, set `BKIT_DISABLE_CC_VERSION_DETECTION=1`.',
    '',
  ].join('\n');
}

/**
 * ENH-368 (v2.1.25): model-floor advisory — build the advisory text shown
 * when 2.1.143 ≤ installed CC < 2.1.170. The `fable` model alias only exists
 * from CC v2.1.170; below it, `model: fable` agents hard-fail at spawn
 * (empirically reproduced 2026-07-02).
 *
 * @param {string} version detected CC version (within the advisory band)
 * @returns {string}
 */
function buildModelFloorAdvisoryText(version) {
  return [
    `## ⚠️ bkit Model-Floor Notice — Claude Code v${version} detected (< v${FABLE_MODEL_FLOOR})`,
    '',
    `bkit v${BKIT_VERSION} pins 6 agents to Claude Fable 5 (\`model: fable\`), which`,
    `requires **Claude Code v${FABLE_MODEL_FLOOR} or later**: cto-lead, sprint-orchestrator,`,
    'sprint-master-planner, pm-lead, qa-lead, sprint-qa-flow.',
    'On this Claude Code version those agents fail to spawn.',
    '',
    'Fix: `npm install -g @anthropic-ai/claude-code@latest`',
    'Temporary workaround: `export CLAUDE_CODE_SUBAGENT_MODEL=sonnet` (forces ALL subagents to sonnet).',
    '',
  ].join('\n');
}

/**
 * Build the SessionStart CC version advisory context section.
 *
 * Precedence (at most ONE advisory is emitted):
 *   1. CC < 2.1.143             → install-floor advisory (displayName schema)
 *   2. 2.1.143 ≤ CC < 2.1.170   → model-floor advisory (ENH-368, fable agents)
 *   3. CC ≥ 2.1.170 / unknown   → empty string
 *
 * Reuses the single detectCCVersion() result — no second version-detection
 * process is spawned for the model-floor check.
 *
 * @returns {string}
 */
function buildCCVersionAdvisoryContext() {
  try {
    const result = detectCCVersion();
    if (result.isOldVersion && result.advisory) {
      return result.advisory + '\n';
    }
    // ENH-368 (v2.1.25): model-floor advisory (install floor met, model floor not)
    if (result.version && !result.isOldVersion && ccVersionLt(result.version, FABLE_MODEL_FLOOR)) {
      return buildModelFloorAdvisoryText(result.version) + '\n';
    }
  } catch (_e) {
    // fail-open: never block SessionStart on advisory failure
  }
  return '';
}

/**
 * Build onboarding context section.
 * @param {object} onboardingData - Onboarding data from onboarding module
 * @returns {string} Context string
 */
function buildOnboardingContext(onboardingData) {
  let ctx = '';

  if (onboardingData.hasExistingWork) {
    ctx += `## 🔄 Previous Work Detected\n\n`;
    ctx += `- **Feature**: ${onboardingData.primaryFeature}\n`;
    ctx += `- **Current Phase**: ${onboardingData.phase}\n`;
    if (onboardingData.matchRate) {
      ctx += `- **Match Rate**: ${onboardingData.matchRate}%\n`;
    }
    ctx += `\n### 🚨 MANDATORY: Call AskUserQuestion on user's first message\n\n`;
    ctx += `### Actions by selection:\n`;
    ctx += `- **Continue ${onboardingData.primaryFeature}** → Run /pdca status then guide to next phase\n`;
    ctx += `- **Start new task** → Ask for new feature name then run /pdca plan\n`;
    ctx += `- **Check status** → Run /pdca status\n\n`;
  } else {
    ctx += `## 🚨 MANDATORY: Session Start Action\n\n`;
    ctx += `**AskUserQuestion tool** call required on user's first message.\n\n`;
    ctx += `### Actions by selection:\n`;
    ctx += `- **Learn bkit** → Run /development-pipeline\n`;
    ctx += `- **Learn Claude Code** → Run /claude-code-learning\n`;
    ctx += `- **Start new project** → Select level then run /starter, /dynamic, or /enterprise\n`;
    ctx += `- **Start freely** → General conversation mode\n\n`;
  }

  return ctx;
}

/**
 * Build Agent Teams context section.
 * @param {string} detectedLevel - Current detected level
 * @returns {string} Context string
 */
function buildAgentTeamsContext(detectedLevel) {
  let ctx = '';

  try {
    const { isTeamModeAvailable, getTeamConfig } = require('../../lib/team');
    if (isTeamModeAvailable()) {
      const teamConfig = getTeamConfig();
      ctx += `## CTO-Led Agent Teams (Active)\n`;
      ctx += `- CTO Lead: cto-lead (fable) orchestrates PDCA workflow\n`;
      ctx += `- Start: \`/pdca team {feature}\`\n`;
      ctx += `- Display mode: ${teamConfig.displayMode}\n`;
      if (detectedLevel === 'Enterprise') {
        ctx += `- Enterprise: 5 teammates (architect, developer, qa, reviewer, security)\n`;
        ctx += `- Patterns: leader → council → swarm → council → watchdog\n`;
      } else if (detectedLevel === 'Dynamic') {
        ctx += `- Dynamic: 3 teammates (developer, frontend, qa)\n`;
        ctx += `- Patterns: leader → leader → swarm → council → leader\n`;
      }
      ctx += `### CTO Team Stability (v1.5.9)`;
      ctx += `\n- CC v2.1.64+ resolved 4 memory leaks in Agent Teams`;
      ctx += `\n- Long sessions (>2hr) benefit from periodic /clear`;
      ctx += `\n- Use ctrl+f to bulk-stop background agents when done\n`;
      ctx += `\n`;
    } else if (detectedLevel !== 'Starter') {
      ctx += `## CTO-Led Agent Teams (Not Enabled)\n`;
      ctx += `- Your ${detectedLevel} project supports CTO-Led Agent Teams\n`;
      ctx += `- CTO Lead (fable) orchestrates specialized teammates for parallel PDCA\n`;
      ctx += `- To enable: set \`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\` environment variable\n`;
      ctx += `- Then use: \`/pdca team {feature}\`\n\n`;
    }
  } catch (e) {
    debugLog('SessionStart', 'Agent Teams detection skipped', { error: e.message });
  }

  return ctx;
}

/**
 * Build Output Styles and Memory Systems context section.
 * @param {string} detectedLevel - Current detected level
 * @returns {string} Context string
 */
function buildOutputStylesAndMemoryContext(detectedLevel) {
  let ctx = '';

  // Output Styles
  const levelStyleMap = {
    'Starter': 'bkit-learning',
    'Dynamic': 'bkit-pdca-guide',
    'Enterprise': 'bkit-enterprise'
  };
  const suggestedStyle = levelStyleMap[detectedLevel] || 'bkit-pdca-guide';
  ctx += `## Output Styles (v1.5.9)\n`;
  ctx += `- Recommended for ${detectedLevel} level: \`${suggestedStyle}\`\n`;
  ctx += `- Change anytime with \`/output-style\`\n`;
  ctx += `- Available: bkit-learning, bkit-pdca-guide, bkit-enterprise, bkit-pdca-enterprise\n`;
  ctx += `- If styles not visible in /output-style menu, run \`/output-style-setup\`\n\n`;

  // Memory Systems
  ctx += `## Memory Systems (v1.5.9)\n`;
  ctx += `### bkit Agent Memory (Auto-Active)\n`;
  ctx += `- 19 agents use project scope, 2 agents (starter-guide, pipeline-guide) use user scope\n`;
  ctx += `- No configuration needed\n`;
  ctx += `### Claude Code Auto-Memory\n`;
  ctx += `- Claude automatically saves useful context to \`~/.claude/projects/*/memory/MEMORY.md\`\n`;
  ctx += `- Manage with \`/memory\` command (view, edit, delete entries)\n`;
  ctx += `- bkit memory (\`.bkit/state/memory.json\`) and CC auto-memory are separate systems with no collision\n`;
  ctx += `- Tip: After PDCA completion, use \`/memory\` to save key learnings for future sessions\n\n`;

  return ctx;
}

/**
 * Build bkend MCP status context section.
 * @param {string} detectedLevel - Current detected level
 * @returns {string} Context string
 */
function buildBkendMcpContext(detectedLevel) {
  let ctx = '';

  if (detectedLevel !== 'Dynamic' && detectedLevel !== 'Enterprise') {
    return ctx;
  }

  try {
    const mcpJsonPath = path.join(process.cwd(), '.mcp.json');
    let bkendMcpConnected = false;
    if (fs.existsSync(mcpJsonPath)) {
      const mcpContent = fs.readFileSync(mcpJsonPath, 'utf-8');
      if (mcpContent.includes('bkend') || mcpContent.includes('api.bkend.ai')) {
        bkendMcpConnected = true;
      }
    }
    if (bkendMcpConnected) {
      ctx += `## bkend.ai MCP Status\n`;
      ctx += `- Status: Connected\n`;
      ctx += `- Use natural language to manage backend (DB, Auth, Storage)\n\n`;
    } else {
      ctx += `## bkend.ai MCP Status\n`;
      ctx += `- Status: Not configured\n`;
      ctx += `- Setup: \`claude mcp add bkend --transport http https://api.bkend.ai/mcp\`\n`;
      ctx += `- bkend.ai provides Database, Auth, Storage as BaaS\n\n`;
    }
  } catch (e) {
    debugLog('SessionStart', 'bkend MCP check skipped', { error: e.message });
  }

  return ctx;
}

/**
 * Build Enterprise batch workflow context section.
 * @param {string} detectedLevel - Current detected level
 * @returns {string} Context string
 */
function buildEnterpriseBatchContext(detectedLevel) {
  let ctx = '';

  if (detectedLevel !== 'Enterprise') return ctx;

  try {
    const pdcaStatusForBatch = getPdcaStatusFull();
    const activeFeatures = pdcaStatusForBatch?.activeFeatures || [];
    if (activeFeatures.length >= 2) {
      ctx += `## Multi-Feature PDCA (v1.5.9)\n`;
      ctx += `- Active features: ${activeFeatures.join(', ')}\n`;
      ctx += `- Use \`/batch\` for parallel processing of multiple features\n`;
      ctx += `- Enterprise batch supports concurrent Check/Act iterations\n\n`;
    }
  } catch (e) {
    debugLog('SessionStart', 'Batch suggestion skipped', { error: e.message });
  }

  return ctx;
}

/**
 * Build PDCA core rules context section.
 * @returns {string} Context string
 */
function buildPdcaCoreRules() {
  let ctx = '';

  ctx += `## PDCA Core Rules (Always Apply)\n`;
  ctx += `- New feature request → Check/create Plan/Design documents first\n`;
  ctx += `- After implementation → Suggest Gap analysis\n`;
  ctx += `- Gap Analysis < 90% → Auto-improvement with pdca-iterator\n`;
  ctx += `- Gap Analysis >= 90% → Suggest /simplify for code cleanup, then completion report\n`;
  ctx += `- After /simplify → Completion report with report-generator\n\n`;

  return ctx;
}

/**
 * Build automation features context section.
 * @param {string} triggerTable - Trigger keyword table from onboarding module
 * @returns {string} Context string
 */
function buildAutomationContext(_triggerTable) {
  // v2.1.1: Trigger table removed from context (available in skill definitions)
  // Saves ~800 tokens per session
  let ctx = '';
  ctx += `## Automation\n`;
  ctx += `- 8-language auto-detection (EN, KO, JA, ZH, ES, FR, DE, IT)\n`;
  ctx += `- Implicit Agent/Skill triggers + ambiguity detection\n`;
  ctx += `- Automatic PDCA phase progression\n\n`;
  return ctx;
}

/**
 * Build version enhancements context section.
 * @param {string} detectedLevel - Current detected level
 * @returns {string} Context string
 */
function buildVersionEnhancementsContext(detectedLevel) {
  let ctx = '';

  // v2.1.1: Consolidated version summary (reduced from 4 blocks to 1)
  // v2.1.10 (ENH-167): removed hard-coded strings, uses BKIT_VERSION
  ctx += `\n## bkit v${BKIT_VERSION} (Current)\n`;
  ctx += `- CC recommended: v2.1.220 (fork background-default handled; Claude 5 alias resolution) | verified against v2.1.232 | model floor: v2.1.170+ for Fable-pinned agents | install floor: v2.1.143 (displayName schema)\n`;
  ctx += `- Architecture: 44 Skills, 34 Agents, 21 Hook Events (24 blocks / 28 handlers), 200 Lib Modules (22 subdirs, 8 Port↔Adapter pairs), 2 MCP Servers (19 tools), 21 guardrail rules, Sprint Management (v2.1.13 GA)\n`;
  ctx += `- v2.1.38: the QA phase now reports what it measured. Stop handlers receive the hook payload and read the agent's own report, so M1-M16 carry real readings instead of defaults; the \`qa\` gate can reach \`pass\`; L3-L5 browser tests run when Chrome MCP is actually connected; and an unmeasured rate reads "not measured", never 0%\n`;
  ctx += `- v2.1.38: a QA failure returns to QA. \`act → qa\` (QA_RETRY) is emitted and its counter advances, so \`guardrails.loopBreaker.maxQaRetries\` (default 3) is a real ceiling on the qa ↔ act loop\n`;
  ctx += `- v2.1.37: bkit reads the host's permission mode. Under \`--dangerously-skip-permissions\`, \`dontAsk\` or \`acceptEdits\` it no longer asks for confirmation — but \`rm -rf /\`, force pushes, \`curl … | sh\` and SQL drops stay refused in every mode\n`;
  // ENH-265: ENABLE_PROMPT_CACHING_1H hint (CC v2.1.108+, 30-40% token savings on long sessions)
  // ENH-456 (v2.1.36): `performance.promptCaching1h.envVar` shipped in
  // bkit.config.json duplicating this variable name, and nothing read it. The
  // name now comes from the config so the two cannot drift apart; the shipped
  // value is the same, so behaviour is unchanged.
  let _cachingVar = 'ENABLE_PROMPT_CACHING_1H';
  try {
    const configured = require('../../lib/core/config').getConfig('performance.promptCaching1h.envVar', _cachingVar);
    if (typeof configured === 'string' && /^[A-Z][A-Z0-9_]*$/.test(configured)) _cachingVar = configured;
  } catch (_) { /* keep the built-in name */ }
  const _caching1hRaw = process.env[_cachingVar];
  const _caching1h = _caching1hRaw === '1' || _caching1hRaw === 'true';
  if (_caching1h) {
    ctx += `- Prompt caching 1H: ✅ enabled (30-40% token savings on long PDCA sessions)\n`;
  } else {
    ctx += `- Prompt caching 1H: ⚠️ disabled — set ${_cachingVar}=1 before launching CC for 30-40% token savings on long sessions (see docs/03-analysis/prompt-caching-optimization.md)\n`;
  }
  ctx += `- PDCA: state machine (20 transitions), L0-L4 automation, quality gates (M1-M10)\n`;
  ctx += `- Dashboard: progress-bar, workflow-map, impact-view, agent-panel, control-panel\n`;
  if (detectedLevel === 'Enterprise') {
    ctx += `- Enterprise: /batch multi-feature, CTO Team (5 teammates), /pdca team\n`;
  }
  ctx += `\n`;

  return ctx;
}

/**
 * Build Executive Summary output rule section.
 * @returns {string} Context string
 */
function buildExecutiveSummaryRule() {
  return `

## Executive Summary Output Rule (v1.6.0 - Required after PDCA document work)

**Rule: After completing PDCA document work (/pdca plan, /pdca design, /pdca report, /plan-plus), you MUST output the Executive Summary table in your response.**

### When to output:
- After /pdca plan completes (Plan document created/updated)
- After /pdca design completes (Design document created/updated)
- After /pdca report completes (Report document created/updated)
- After /plan-plus completes (Plan Plus document created)
- After any PDCA document update that includes an Executive Summary section

### What to output:
Extract and display the Executive Summary section from the document, including:
1. **Project overview table** (Feature, dates, duration)
2. **Results summary** (Match Rate, items, files, lines)
3. **Value Delivered 4-perspective table** (Problem / Solution / Function UX Effect / Core Value)

### Why:
Users should see the summary immediately in the response without having to open the file. This is the same principle as bkit Feature Usage — mandatory inline output for key information.

### Position:
- Output Executive Summary BEFORE the bkit Feature Usage report
- Both are required: Executive Summary (after document work) + Feature Usage (always)
`;
}

/**
 * Build Feature Usage report rule section.
 * @returns {string} Context string
 */
function buildFeatureUsageRule() {
  return `

## 📊 bkit Feature Usage Report (v1.5.9 - Required for all responses)

**Rule: Include the following format at the end of every response to report bkit feature usage.**

\`\`\`
─────────────────────────────────────────────────
📊 bkit Feature Usage
─────────────────────────────────────────────────
✅ Used: [bkit features used in this response]
⏭️ Not Used: [Major unused features] (reason)
💡 Recommended: [Features suitable for next task]
─────────────────────────────────────────────────
\`\`\`

### bkit Features to Report:

**1. PDCA Skill (Priority) - Unified PDCA Management:**
/pdca plan, /pdca design, /pdca do, /pdca analyze, /pdca iterate, /pdca report, /pdca status, /pdca next

**2. Task System (Priority):**
TaskCreate, TaskUpdate, TaskList, TaskGet

**3. Agents (Priority):**
gap-detector, pdca-iterator, code-analyzer, report-generator, starter-guide, design-validator, qa-monitor, pipeline-guide, bkend-expert, enterprise-expert, infra-architect

**4. Core Skills (21):**
- **PDCA**: /pdca (plan, design, do, analyze, iterate, report, status, next)
- **Level**: /starter, /dynamic, /enterprise
- **Pipeline**: /development-pipeline (start, next, status)
- **Phase**: /phase-1-schema ~ /phase-9-deployment
- **Utility**: /code-review, /zero-script-qa, /claude-code-learning, /mobile-app, /desktop-app, /bkit-templates, /bkit-rules

**5. Tools (when relevant):**
AskUserQuestion, SessionStart Hook, Read, Write, Edit, Bash

### Reporting Rules:

1. **Required**: Report at the end of every response (incomplete without report)
2. **Used features**: List bkit features actually used in this response
3. **Unused explanation**: Briefly explain why major features were not used
4. **Recommendation**: Suggest next skill based on current PDCA phase

### PDCA Phase Recommendations:

| Current Status | Recommended Skill |
|----------------|-------------------|
| No PDCA | "Start with /pdca plan {feature}" |
| Plan completed | "Design with /pdca design {feature}" |
| Design completed | "Start implementation or /pdca do {feature}" |
| Do completed | "Gap analysis with /pdca analyze {feature}" |
| Check < 90% | "Auto-improve with /pdca iterate {feature}" |
| Check ≥ 90% | "Completion report with /pdca report {feature}" |

`;
}

/**
 * Build the full additionalContext string for the SessionStart hook response.
 *
 * ENH-238 (Issue #81 Phase B): ui.contextInjection.enabled + sections[] opt-out gate.
 * Mirrors the dashboard 3-way toggle pattern from hooks/session-start.js:89-104.
 *
 * ENH-240 (Issue #81 Phase B): applies context budget guard before return.
 *
 * @param {object} _input - Hook input (unused, reserved for future use)
 * @param {object} context - Context from onboarding module { onboardingData, triggerTable }
 * @returns {string} The complete additionalContext string
 */
function build(_input, context) {
  const { onboardingData, triggerTable } = context;
  const detectedLevel = detectLevel();

  // ENH-238: contextInjection opt-out + per-section opt-in gate
  // v2.1.20 F10 (ENH-323): added 'ccVersionAdvisory' default section.
  let _ciEnabled = true;
  let _ciSections = [
    'ccVersionAdvisory',
    'onboarding', 'agentTeams', 'outputStyles', 'bkendMcp',
    'enterpriseBatch', 'pdcaCoreRules', 'automation', 'versionEnhancements',
  ];
  let _ciMaxChars;
  let _ciPriorityPreserve;
  try {
    const _ui = getUIConfig();
    if (_ui && _ui.contextInjection) {
      _ciEnabled = _ui.contextInjection.enabled !== false;
      if (Array.isArray(_ui.contextInjection.sections)) {
        _ciSections = _ui.contextInjection.sections;
      }
      if (Number.isFinite(_ui.contextInjection.maxChars)) {
        _ciMaxChars = _ui.contextInjection.maxChars;
      }
      if (Array.isArray(_ui.contextInjection.priorityPreserve)) {
        _ciPriorityPreserve = _ui.contextInjection.priorityPreserve;
      }
    }
  } catch (_e) {
    // fail-open: keep defaults → preserve prior behavior
  }

  // v2.1.10 (ENH-167): removed hard-coded strings, uses BKIT_VERSION
  // v2.1.11 (FR-α2-c): + One-Liner verbatim for SSoT compliance and first-run identity
  const header = `# bkit Vibecoding Kit v${BKIT_VERSION} - Session Startup\n\n> ${ONE_LINER_EN}\n\n`;

  if (!_ciEnabled) {
    return header;
  }

  let additionalContext = header;

  // v2.1.20 F10 (ENH-323): CC version advisory — surfaces first if CC < v2.1.143.
  // Placed before other sections so the warning is not budget-trimmed.
  if (_ciSections.includes('ccVersionAdvisory'))   additionalContext += buildCCVersionAdvisoryContext();
  if (_ciSections.includes('onboarding'))          additionalContext += buildOnboardingContext(onboardingData);
  if (_ciSections.includes('agentTeams'))          additionalContext += buildAgentTeamsContext(detectedLevel);
  if (_ciSections.includes('outputStyles'))        additionalContext += buildOutputStylesAndMemoryContext(detectedLevel);
  if (_ciSections.includes('bkendMcp'))            additionalContext += buildBkendMcpContext(detectedLevel);
  if (_ciSections.includes('enterpriseBatch'))     additionalContext += buildEnterpriseBatchContext(detectedLevel);
  if (_ciSections.includes('pdcaCoreRules'))       additionalContext += buildPdcaCoreRules();
  if (_ciSections.includes('automation'))          additionalContext += buildAutomationContext(triggerTable);
  if (_ciSections.includes('versionEnhancements')) additionalContext += buildVersionEnhancementsContext(detectedLevel);

  // ENH-240: Context budget guard (CC 10,000-char cap defense)
  try {
    const budgetOpts = {};
    if (_ciMaxChars != null) budgetOpts.maxChars = _ciMaxChars;
    if (_ciPriorityPreserve) budgetOpts.priorityPreserve = _ciPriorityPreserve;
    additionalContext = applyBudget(additionalContext, budgetOpts);
  } catch (_e) {
    // fail-open: return original
  }

  return additionalContext;
}

module.exports = {
  build,
  // v2.1.20 F10 (ENH-323): exported for E2E test (test/e2e/cc-min-version.test.js).
  detectCCVersion,
  buildCCVersionAdvisoryContext,
  // Constants exported for test assertions only.
  CC_MIN_VERSION,
  CC_VERSION_CACHE_TTL_MS,
  CC_VERSION_DETECT_TIMEOUT_MS,
  // ENH-368 (v2.1.25): re-exported for model-floor advisory boundary tests.
  FABLE_MODEL_FLOOR,
};
