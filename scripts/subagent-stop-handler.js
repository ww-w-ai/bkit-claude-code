#!/usr/bin/env node
/**
 * subagent-stop-handler.js - SubagentStop Hook Handler (v1.5.3)
 *
 * When a subagent terminates:
 * 1. updateTeammateStatus(name, "completed"|"failed")
 * 2. Call updateProgress()
 * 3. Check session end when all teammates complete
 *
 * Design Reference: docs/02-design/features/team-visibility.design.md Section 5.2
 */


// v2.1.12 Sprint C-2 (#9/#10/#8): bare-require guard — when this script
// is require()-d instead of executed as a hook entrypoint, return
// immediately so no stale stdout (decisions, advisory messages) is emitted
// without a real hook payload. CommonJS module body is implicitly an IIFE,
// so top-level return is valid.
if (require.main !== module) { module.exports = {}; return; }

const { readStdinSync, outputAllow } = require('../lib/core/io');
const { debugLog } = require('../lib/core/debug');

function main() {
  debugLog('SubagentStop', 'Hook started');

  let hookContext = {};
  try {
    const input = readStdinSync();
    hookContext = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (e) {
    debugLog('SubagentStop', 'Failed to parse context', { error: e.message });
    outputAllow('SubagentStop processed.', 'SubagentStop');
    return;
  }

  let teamModule = null;
  try {
    teamModule = require('../lib/team');
  } catch (e) {
    outputAllow('SubagentStop processed.', 'SubagentStop');
    return;
  }

  // v1.5.9: ENH-74 agent_id/agent_type extraction
  //
  // ENH-376: SubagentStop carries `agent_id` and `agent_type` but no
  // `agent_name` (verified against CC v2.1.220), so the old fallback chain
  // always produced the opaque id. Address the roster row by id — the same
  // identity SubagentStart registers — and keep the readable type for display.
  const agentId = hookContext.agent_id || null;
  const agentType = hookContext.agent_type || 'unknown';
  const agentName = agentType !== 'unknown' ? agentType : (agentId || 'unknown');

  // Determine exit status (transcript_path exists = normal exit)
  const isSuccess = hookContext.transcript_path != null
    || hookContext.exit_code === 0
    || hookContext.exit_code === undefined;
  const status = isSuccess ? 'completed' : 'failed';

  // Update status
  try {
    teamModule.updateTeammateStatus({ id: agentId, name: agentName }, status, null);
  } catch (e) {
    debugLog('SubagentStop', 'Status update failed (non-fatal)', { error: e.message });
  }

  // Update progress
  try {
    const state = teamModule.readAgentState();
    if (state && state.feature) {
      const progress = teamModule.getTeamProgress(state.feature, state.pdcaPhase);
      teamModule.updateProgress(progress);
    }
  } catch (e) {
    debugLog('SubagentStop', 'Progress update failed (non-fatal)', { error: e.message });
  }

  // v2.1.10 Sprint 5.5: cc-regression attribution (fail-silent)
  try {
    const cc = require('../lib/cc-regression');
    const ccVersion = cc.detectCCVersion();
    if (ccVersion) {
      cc.recordEvent({
        hookEvent: 'SubagentStop',
        ccVersion,
        sessionId: hookContext.session_id || null,
        timestamp: new Date().toISOString(),
        context: { agentType, status },
      });
    }
  } catch (_e) { /* fail-silent */ }

  // v2.1.14 Sub-Sprint 1 (ENH-292): caching-cost.port emit for sub-agent
  // dispatch warmup detection. Fail-silent — sub-agent-dispatcher tolerates
  // missing samples (cold-start safety branch). See lib/orchestrator/
  // cache-cost-analyzer.js MIN_SAMPLES_FOR_TREND.
  try {
    const usage = hookContext.usage || hookContext.token_usage || null;
    if (usage && (usage.cache_creation_input_tokens != null || usage.cache_read_input_tokens != null)) {
      const { createCachingCostCli, buildMetrics } = require('../lib/infra/caching-cost-cli');
      const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const port = createCachingCostCli({ projectRoot });
      const sessionHash = String(hookContext.session_id || hookContext.session_hash || '');
      const metrics = buildMetrics({
        cacheCreationTokens: Number(usage.cache_creation_input_tokens) || 0,
        cacheReadTokens: Number(usage.cache_read_input_tokens) || 0,
        requestTokens: Number(usage.input_tokens) || 0,
        sessionHash,
        agent: agentType,
        dispatchMode: hookContext.dispatch_mode || 'sequential',
      });
      // Fire-and-forget — port.emit is fail-silent on IO errors.
      port.emit(metrics).catch(() => { /* fail-silent */ });
    }
  } catch (_e) { /* fail-silent */ }

  // v2.1.10 Sprint 7c (G-J-06): Next Action suggestion on SubagentStop
  let nextActionHint = null;
  try {
    const { generateSubagentStop } = require('../lib/orchestrator/next-action-engine');
    const { getPdcaStatusFull } = require('../lib/pdca/status');
    const pdcaStatus = (typeof getPdcaStatusFull === 'function') ? getPdcaStatusFull() : null;
    nextActionHint = generateSubagentStop({ agentName, status, pdcaStatus });
  } catch (_e) { /* fail-silent */ }

  const response = {
    /*
     * registry-lockdown follow-up (field report 2026-09-08): the next-action
     * hint stays on the systemMessage (orchestrator/user surface) ONLY.
     * It used to also ride additionalContext, which CC injects into the
     * STOPPING SUBAGENT's own context — and no PDCA subagent has the Skill
     * tool (gap-detector is Read/Glob/Grep/Explore), so "Next: /pdca …" was
     * un-actionable where it landed. The gap-detector in the field declined
     * the identical suggestion six times across six stop→re-prompt cycles.
     * The orchestrator, which CAN fire skills, still sees the hint once per
     * subagent stop via systemMessage.
     */
    systemMessage: `Subagent ${agentName} stopped (${status})${nextActionHint ? '\n' + nextActionHint : ''}`,
    hookSpecificOutput: {
      hookEventName: "SubagentStop",
      agentId,
      agentName,
      agentType,
      status,
    }
  };

  console.log(JSON.stringify(response));
  process.exit(0);
}

main();
