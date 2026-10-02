/**
 * DocsCodeIndexPort implementation — measures filesystem inventory and cross-checks docs.
 *
 * Design Ref: bkit-v2110-integrated-enhancement.design.md §3.3.5 (Sprint 4)
 * Plan SC: ENH-241 Docs=Code cross-check — single source of truth is `EXPECTED_COUNTS`
 *   in `lib/domain/rules/docs-code-invariants.js`. Scanner returns measured counts;
 *   the domain rule compares and emits discrepancies.
 *
 * @module lib/infra/docs-code-scanner
 *
 * @version 2.1.12
 */

const fs = require('fs');
const path = require('path');
// v2.1.18: frontmatter helpers centralized in lib/util/frontmatter (CO-5).
const { hasDeprecatedInFrontmatter } = require('../util/frontmatter');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/** @typedef {import('../domain/ports/docs-code-index.port').InventoryMeasurement} InventoryMeasurement */
/** @typedef {import('../domain/ports/docs-code-index.port').Discrepancy} Discrepancy */

/**
 * Count entries in skills/ directory (direct children that contain SKILL.md).
 * @returns {number}
 */
function countSkills() {
  const dir = path.join(PROJECT_ROOT, 'skills');
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir)
    .filter((d) => {
      try {
        const sub = path.join(dir, d);
        return fs.statSync(sub).isDirectory() && fs.existsSync(path.join(sub, 'SKILL.md'));
      } catch {
        return false;
      }
    }).length;
}

/**
 * v2.1.17: Active agent count — excludes deprecation tombstones with
 * `deprecatedIn` frontmatter. Tombstones exist to satisfy contract baseline
 * L4 governance (see docs/06-guide/contract-baseline-rollforward.guide.md)
 * but are NOT invocable agents and must be excluded from inventory counts.
 *
 * v2.1.18 (CO-5): hasDeprecatedInFrontmatter helper imported from lib/util/frontmatter.
 */
function countAgents() {
  const dir = path.join(PROJECT_ROOT, 'agents');
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => {
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        return !hasDeprecatedInFrontmatter(content);
      } catch {
        return true;
      }
    }).length;
}

function countHooks() {
  const hooksJson = path.join(PROJECT_ROOT, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksJson)) return { events: 0, blocks: 0 };
  const data = JSON.parse(fs.readFileSync(hooksJson, 'utf8'));
  const events = Object.keys(data.hooks || {}).length;
  let blocks = 0;
  for (const [, entries] of Object.entries(data.hooks || {})) {
    blocks += entries.length;
  }
  return { events, blocks };
}

function countMCPServers() {
  const dir = path.join(PROJECT_ROOT, 'servers');
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir)
    .filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).length;
}

function countMCPTools() {
  const dir = path.join(PROJECT_ROOT, 'servers');
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const servers = fs.readdirSync(dir).filter((s) => fs.statSync(path.join(dir, s)).isDirectory());
  for (const server of servers) {
    const indexPath = path.join(dir, server, 'index.js');
    if (!fs.existsSync(indexPath)) continue;
    const source = fs.readFileSync(indexPath, 'utf8');
    const matches = source.match(/(?:^|[\s{,])["']?name["']?\s*:\s*['"](bkit_[a-z_]+)['"]/gm) || [];
    const names = new Set();
    for (const m of matches) {
      const inner = m.match(/['"](bkit_[a-z_]+)['"]/);
      if (inner) names.add(inner[1]);
    }
    total += names.size;
  }
  return total;
}

function countLibModules() {
  const dir = path.join(PROJECT_ROOT, 'lib');
  if (!fs.existsSync(dir)) return 0;
  // Count all .js files recursively in lib/.
  function walk(p) {
    let n = 0;
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) n += walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) n++;
    }
    return n;
  }
  return walk(dir);
}

function countScripts() {
  const dir = path.join(PROJECT_ROOT, 'scripts');
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).length;
}

/**
 * v2.1.22 (S5 ENH-358): count direct subdirectories of lib/.
 *
 * Added so the Docs=Code scanner auto-measures the `lib subdirs` metric that
 * the v2.1.22 docs-sync had to correct manually (README/AI-NATIVE/README-FULL
 * had stale 16/19 vs measured 22). Informational like libModules/scripts —
 * surfaced in measure() but NOT added to the crossCheck gate (internal
 * structure varies per release; same exclusion rationale as libModules).
 *
 * @returns {number}
 */
function countLibSubdirs() {
  const dir = path.join(PROJECT_ROOT, 'lib');
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}

/**
 * Measure the current inventory.
 *
 * @returns {Promise<InventoryMeasurement>}
 */
async function measure() {
  const hooks = countHooks();
  return {
    skills: countSkills(),
    agents: countAgents(),
    hookEvents: hooks.events,
    hookBlocks: hooks.blocks,
    mcpServers: countMCPServers(),
    mcpTools: countMCPTools(),
    libModules: countLibModules(),
    libSubdirs: countLibSubdirs(),
    scripts: countScripts(),
  };
}

/**
 * Scan a document for any explicit inventory count references.
 *
 * Patterns recognised:
 *   "39 Skills", "36 Agents", "21 Hook Events", "24 blocks",
 *   "16 MCP tools", "2 MCP Servers", "101 Lib modules", "43 Scripts"
 *
 * Returns discrepancies compared to measured values (not EXPECTED_COUNTS).
 *
 * @param {string} docPath - absolute or project-relative path
 * @returns {Promise<Discrepancy[]>}
 */
async function crossCheck(docPath) {
  const full = path.isAbsolute(docPath) ? docPath : path.join(PROJECT_ROOT, docPath);
  if (!fs.existsSync(full)) return [];

  const content = fs.readFileSync(full, 'utf8');
  const actual = await measure();
  const discrepancies = [];

  // Sprint 4 scope: Invocation Contract surface only (immutable under Minor).
  // Internal implementation sizes (libModules, scripts) vary naturally per release
  // and are excluded from Docs=Code gate to avoid false positives. Use --strict
  // CLI flag (future) to include them if needed for a full audit.
  const PATTERNS = [
    { re: /(\d+)\s+Skills\b/gi, field: 'skills' },
    { re: /(\d+)\s+Agents\b/gi, field: 'agents' },
    { re: /(\d+)\s+Hook\s+Events\b/gi, field: 'hookEvents' },
    { re: /(\d+)\s+(?:hook\s+)?blocks\b/gi, field: 'hookBlocks' },
    { re: /(\d+)\s+MCP\s+(?:tool|Tool)s?\b/gi, field: 'mcpTools' },
    { re: /(\d+)\s+MCP\s+Server/gi, field: 'mcpServers' },
  ];

  for (const { re, field } of PATTERNS) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const declared = parseInt(m[1], 10);
      if (declared !== actual[field]) {
        discrepancies.push({ docPath, field, declared, actual: actual[field] });
      }
    }
  }

  return discrepancies;
}

/**
 * v2.1.10 Sprint 6 NEW 6-6 (ENH-276): BKIT_VERSION invariant scan.
 *
 * Cross-checks version declarations across:
 *   - bkit.config.json:version (single source of truth)
 *   - .claude-plugin/plugin.json:version
 *   - README.md badge `Version-X.Y.Z`
 *   - CHANGELOG.md latest `## [X.Y.Z]` header
 *   - hooks.json description string (approximate)
 *
 * Reports the canonical version + any file whose declared version disagrees.
 *
 * @returns {Promise<{canonical:string|null, bkitConfig:string|null, pluginJson:string|null, readme:string|null, changelog:string|null, hooksJson:string|null, mismatches:Array<{file:string, field:string, declared:string|null}>}>}
 */
async function scanVersions() {
  function readJSONField(relPath, field) {
    try {
      const full = path.join(PROJECT_ROOT, relPath);
      if (!fs.existsSync(full)) return null;
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      return data && typeof data[field] === 'string' ? data[field] : null;
    } catch {
      return null;
    }
  }

  const bkitConfig = readJSONField('bkit.config.json', 'version');
  const pluginJson = readJSONField('.claude-plugin/plugin.json', 'version');

  let readme = null;
  try {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, 'README.md'), 'utf8');
    const m = content.match(/Version-(\d+\.\d+\.\d+)/);
    readme = m ? m[1] : null;
  } catch {}

  let changelog = null;
  try {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, 'CHANGELOG.md'), 'utf8');
    // Skip provisional/unreleased headings — the maintainer assigns release
    // numbers at release time (CLAUDE.md versioning policy); the top-most
    // RELEASED heading is the version the scanner should compare.
    const headings = [...content.matchAll(/^\s*##\s*\[?(\d+\.\d+\.\d+)\]?([^\n]*)/gm)];
    const released = headings.find(([, , rest]) => !/unreleased|provisional/i.test(rest));
    changelog = released ? released[1] : (headings.length ? headings[0][1] : null);
  } catch {}

  let hooksJson = null;
  try {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, 'hooks', 'hooks.json'), 'utf8');
    const m = content.match(/v(\d+\.\d+\.\d+)/);
    hooksJson = m ? m[1] : null;
  } catch {}

  const canonical = bkitConfig; // single source of truth
  const mismatches = [];
  if (canonical) {
    if (pluginJson !== null && pluginJson !== canonical) mismatches.push({ file: '.claude-plugin/plugin.json', field: 'version', declared: pluginJson });
    if (readme !== null && readme !== canonical) mismatches.push({ file: 'README.md', field: 'badge', declared: readme });
    if (changelog !== null && changelog !== canonical) mismatches.push({ file: 'CHANGELOG.md', field: 'top-header', declared: changelog });
    if (hooksJson !== null && hooksJson !== canonical) mismatches.push({ file: 'hooks/hooks.json', field: 'description', declared: hooksJson });
  }

  return { canonical, bkitConfig, pluginJson, readme, changelog, hooksJson, mismatches };
}

/**
 * v2.1.11 Sprint α NEW (FR-α2-f): One-Liner SSoT cross-check.
 *
 * Verifies the bkit One-Liner (defined in `lib/infra/branding.js`) is
 * synchronised across the 5 authoritative locations:
 *
 *   1. `.claude-plugin/plugin.json`       — `description` field
 *   2. `README.md`                         — top-of-file paragraph
 *   3. `README-FULL.md`                    — top-of-file paragraph (FR-α1)
 *   4. `hooks/startup/session-context.js` — SessionStart intro literal
 *   5. `CHANGELOG.md`                      — v2.1.11 Highlights block
 *
 * Each location reports a `status`:
 *   - `sync`     — file exists and contains the expected One-Liner verbatim
 *   - `drift`    — file exists but does NOT contain the expected One-Liner
 *                  (CI MUST FAIL on drift)
 *   - `missing`  — file does not exist yet (FR-α1 / FR-α2-e in progress)
 *                  (CI MAY warn but not fail; allows incremental rollout)
 *
 * The CI consumer (`scripts/docs-code-sync.js`) treats drift as fatal and
 * missing as a progress indicator. Once all 5 locations are filled, callers
 * can enforce strict mode by requiring `pendingCount === 0`.
 *
 * @returns {Promise<{
 *   expected: string,
 *   results: Array<{name:string, path:string, status:'sync'|'drift'|'missing'}>,
 *   mismatches: Array<{name:string, path:string}>,
 *   pending: Array<{name:string, path:string}>,
 *   syncCount: number
 * }>}
 */
async function scanOneLiner() {
  const { ONE_LINER_EN } = require('./branding');

  const SOURCES = [
    { name: 'plugin.json',         path: '.claude-plugin/plugin.json' },
    { name: 'README.md',           path: 'README.md' },
    { name: 'README-FULL.md',      path: 'README-FULL.md' },
    { name: 'session-context.js',  path: 'hooks/startup/session-context.js' },
    { name: 'CHANGELOG.md',        path: 'CHANGELOG.md' },
  ];

  // JS files satisfy the SSoT contract by importing from branding.js and
  // referencing ONE_LINER_EN. This is stricter than a verbatim substring check
  // because it forbids inline string copies of the One-Liner — a duplicated
  // literal in a JS file would silently pass a substring scan but the import
  // requirement keeps branding.js the single source.
  function isJsFile(p) { return p.endsWith('.js'); }
  function hasBrandingImport(c) {
    return /require\(['"][^'"]*branding['"]\)/.test(c) ||
           /\bfrom\s+['"][^'"]*branding['"]/.test(c);
  }
  function hasOneLinerIdentifier(c) {
    return /\bONE_LINER_EN\b/.test(c);
  }

  const results = [];
  for (const src of SOURCES) {
    const full = path.join(PROJECT_ROOT, src.path);
    if (!fs.existsSync(full)) {
      results.push({ ...src, status: 'missing' });
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      results.push({ ...src, status: 'missing' });
      continue;
    }
    let status;
    if (isJsFile(src.path)) {
      status = (hasBrandingImport(content) && hasOneLinerIdentifier(content)) ? 'sync' : 'drift';
    } else {
      status = content.includes(ONE_LINER_EN) ? 'sync' : 'drift';
    }
    results.push({ ...src, status });
  }

  const mismatches = results.filter((r) => r.status === 'drift').map(({ name, path: p }) => ({ name, path: p }));
  const pending    = results.filter((r) => r.status === 'missing').map(({ name, path: p }) => ({ name, path: p }));
  const syncCount  = results.filter((r) => r.status === 'sync').length;

  return { expected: ONE_LINER_EN, results, mismatches, pending, syncCount };
}

module.exports = {
  measure,
  crossCheck,
  scanVersions,   // Sprint 6 NEW 6-6
  scanOneLiner,   // v2.1.11 Sprint α NEW (FR-α2-f)
  // helpers (for testing)
  countSkills,
  countAgents,
  countHooks,
  countMCPServers,
  countMCPTools,
  countLibModules,
  countLibSubdirs,
  countScripts,
};
