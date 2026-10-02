#!/usr/bin/env node
/**
 * Destructive Operation Detector (FR-10)
 * Detects destructive operations before execution using 21 guardrail rules.
 *
 * Rules G-001 to G-020 cover recursive delete, force push, hard reset,
 * protected branch modification, env file modification, secret key access,
 * mass file deletion, root directory operations, SQL/NoSQL drops, obfuscated
 * execution, raw-device writes, find-based deletion, remote-script piping,
 * untracked-file deletion, uncommitted-change discard, reflog destruction,
 * broker-state modification, and registry state writes.
 *
 * @version 2.1.10
 * @module lib/control/destructive-detector
 */

/**
 * @typedef {Object} GuardrailRule
 * @property {string} id - Rule identifier (G-001 to G-020)
 * @property {string} name - Human-readable rule name
 * @property {RegExp} pattern - Detection pattern
 * @property {'critical'|'high'|'medium'} severity - Rule severity
 * @property {'deny'|'ask'|'allow'} defaultAction - Default action when triggered
 */

/**
 * @typedef {Object} DetectionResult
 * @property {boolean} detected - Whether a destructive operation was detected
 * @property {Array<{id: string, name: string, severity: string, pattern: string}>} rules - Matched rules
 * @property {number} confidence - Detection confidence 0-1
 */

/**
 * Guardrail rules for destructive operation detection
 * @type {GuardrailRule[]}
 */
const GUARDRAIL_RULES = [
  {
    id: 'G-001',
    name: 'Recursive delete',
    // Design Ref: §3 Fix 1 (RB-003) — judge only the Bash `command` field. A
    // Write/Edit whose content MENTIONS a delete command executes nothing.
    targetFields: ['command'],
    pattern: /\b(rm\s+-(r|rf|fr)\b|rm\s+--recursive|rimraf|shutil\.rmtree|Remove-Item\s+-Recurse)/i,
    severity: 'critical',
    defaultAction: 'deny',
    /*
     * v2.1.34 (D9) — severity depends on WHAT is being deleted.
     *
     * This rule matched `rm -r` regardless of target, so deleting a scoped
     * temporary directory was refused exactly as hard as deleting `/`. The
     * refusal then advised "Scope the command to a specific path instead of a
     * broad or root target" — advice the rule made impossible to act on, since
     * scoping changed nothing. Guidance a user cannot follow is how a guard
     * teaches people to switch it off, and both cases below were hit doing
     * ordinary work on this release.
     *
     * A dangerous target still denies. A specific one asks.
     */
    severityFor: (text) => (deleteTargetIsBroad(text) ? 'critical' : 'high'),
  },
  {
    id: 'G-002',
    name: 'Force push',
    pattern: /\bgit\s+push\s+.*(-f|--force|--force-with-lease)\b/i,
    severity: 'critical',
    defaultAction: 'deny',
    // ENH-462 (v2.1.36): grade by target. A protected branch denies; a topic
    // branch asks. See pushTargetIsProtected().
    severityFor: (text) => (pushTargetIsProtected(text) ? 'critical' : 'high'),
  },
  {
    id: 'G-003',
    name: 'Hard reset',
    pattern: /\bgit\s+reset\s+--hard\b/i,
    severity: 'high',
    defaultAction: 'ask'
  },
  {
    id: 'G-004',
    name: 'Protected branch modification',
    /*
     * ENH-442 (v2.1.36) — `(?!-)` excludes hyphenated sub-commands.
     *
     * `\b` is satisfied by a hyphen, so `merge` matched `merge-base` and the
     * read-only `git merge-base origin/master HEAD` was graded as a protected
     * branch modification. Reported in issue #148; `merge-tree` and `merge-file`
     * were measured to have the same defect and are covered by the same guard.
     *
     * The hyphenated spellings are git's plumbing (`merge-base`, `merge-tree`,
     * `merge-file`, `commit-tree`) — they compute and report, they do not move a
     * branch. The porcelain commands that DO move a branch are exactly the
     * un-hyphenated four, so excluding the hyphen form is the whole fix.
     */
    pattern: /\bgit\s+(commit|merge|rebase|push)(?!-)\b.*\b(main|master|release|production)\b/i,
    severity: 'high',
    defaultAction: 'ask'
  },
  {
    id: 'G-005',
    name: 'Environment file modification',
    /*
     * ENH-477 (v2.1.37) — this rule had never fired for the filename it names.
     *
     * The old pattern was /\b(\.env|\.env\.\w+)\b/i. `\b` is a transition
     * between a word and a non-word character, and the character before a
     * leading `.` is a space, a `/`, or the start of the string — all non-word.
     * So `\b\.env` could not match `.env` as it is actually written. Measured
     * against the shipped rule:
     *
     *   cat .env               -> no match      git add -f .env.production -> no match
     *   ./.env, foo/.env       -> no match      myapp.env                  -> MATCH
     *
     * It matched only when a word character preceded the dot, which is close to
     * never for a real environment file. Same class as ENH-263 and ENH-469:
     * shipped, asserted by tests that checked the rule existed, and never once
     * triggered by the thing it was written for.
     *
     * It was wrong in BOTH directions at once, which is why neither showed up as
     * a complaint. Measured against the shipped rule:
     *
     *   .env, cat .env, ./.env      -> no match   (blind to the secret store)
     *   process.env.NODE_ENV        -> MATCH      (ordinary JavaScript)
     *   import.meta.env.VITE_KEY    -> MATCH      (ordinary JavaScript)
     *   config.env.production       -> MATCH      (correct)
     *
     * v2.1.36's false-positive audit did not catch the second half because its
     * corpus was Bash commands, and `process.env.X` arrives through `content` on
     * an Edit. Editing any file that reads an environment variable prompted.
     *
     * The blast radius of the false NEGATIVE was one surface: `Write`/`Edit` to
     * `.env` is guarded by the `.env*` deny glob in scope-limiter.js:34 and that
     * one works. What went unguarded was the Bash surface this detector owns.
     *
     * The replacement drops `\b` — which cannot express "start of a filename"
     * when the filename starts with a dot — and matches the whole dotted chain,
     * so both spellings are covered: the leading-dot file (`.env.production`)
     * and the prefixed one (`config.env.production`, which DT-005 asserts).
     * `(?![\w-])` keeps `.envrc` out; the two suppressors below keep templates
     * and runtime env access out.
     */
    pattern: /\.env(?:\.[\w-]+)*(?![\w-])/i,
    severity: 'high',
    defaultAction: 'ask',
    suppressIf: isBenignEnvMention,
  },
  {
    id: 'G-006',
    name: 'Secret key access',
    pattern: /\b[\w/.-]+(\.key|\.pem|\.p12|\.pfx|\.jks|\.keystore)\b/i,
    severity: 'high',
    defaultAction: 'ask',
    // ENH-445 (v2.1.36): listing a key file is not accessing it. See
    // isMetadataOnlyAccess(). Readers and copiers are unaffected.
    suppressIf: isMetadataOnlyAccess,
  },
  {
    id: 'G-007',
    name: 'Mass file deletion',
    pattern: /\b(rm|del|delete|remove)\b.*(\s+\S+){5,}/i,
    severity: 'medium',
    defaultAction: 'ask',
    // ENH-447 (v2.1.36): SQL's `DELETE FROM` is not a filesystem deletion. The
    // SQL rules own that language; G-010b still catches an unscoped DELETE.
    // ENH-470 (v2.1.37): and the verb has to be the command, not just a word that
    // appears in it. See isNotACommandLevelDelete().
    suppressIf: (text) => looksLikeSqlStatement(text) || isNotACommandLevelDelete(text),
  },
  {
    id: 'G-008',
    name: 'Root directory operations',
    pattern: /\b(rm|mv|cp|chmod|chown)\s+.*\s+\/\s*$/,
    severity: 'critical',
    defaultAction: 'deny'
  },
  // v2.1.12 Sprint E-1 (defect #19 fix): DB destruction patterns previously
  // were not matched (e.g. `DROP TABLE users` returned isDestructive=false).
  // Added SQL DDL/DML destruction + NoSQL drop patterns.
  {
    id: 'G-009',
    name: 'SQL table/database drop',
    // matches DROP TABLE / DROP DATABASE / DROP SCHEMA / DROP INDEX / DROP VIEW
    pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|TRIGGER|PROCEDURE|FUNCTION)\b/i,
    severity: 'critical',
    defaultAction: 'deny',
    // ENH-440: SQL statements end at `;`, not at a newline. See splitCommandSegments().
    segmentOn: 'sql'
  },
  {
    id: 'G-010',
    name: 'SQL TRUNCATE / ALTER DROP COLUMN',
    pattern: /\b(TRUNCATE\s+TABLE\b|ALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN)\b/i,
    severity: 'critical',
    defaultAction: 'deny',
    segmentOn: 'sql'
  },
  {
    id: 'G-010b',
    name: 'DELETE without WHERE clause',
    /*
     * Matches `DELETE FROM <ident>` only when no WHERE clause follows it.
     *
     * ENH-446 (v2.1.36) — the lookahead is unchanged, but it is now evaluated
     * against ONE statement instead of the whole input. Previously a WHERE
     * belonging to an unrelated later statement suppressed the match, so an
     * unscoped DELETE went undetected. Measured on v2.1.35:
     *
     *   DELETE FROM audit_log; SELECT 1 FROM t WHERE x=1   -> not detected
     *   DELETE FROM audit_log -- WHERE                     -> not detected
     *
     * Both now segment at `;` (and the comment case matches within its own
     * statement), so the lookahead only sees the DELETE's own clause.
     */
    pattern: /\bDELETE\s+FROM\s+[\w.]+(?![\s\S]*\bWHERE\b)/i,
    severity: 'critical',
    defaultAction: 'deny',
    segmentOn: 'sql'
  },
  {
    id: 'G-011',
    name: 'NoSQL collection drop',
    // MongoDB `db.collection.drop()` / `dropDatabase()` / Redis FLUSHALL/FLUSHDB
    pattern: /\b(db\.\w+\.drop\s*\(\s*\)|dropDatabase\s*\(\s*\)|FLUSHALL\b|FLUSHDB\b)/i,
    severity: 'critical',
    defaultAction: 'deny',
    segmentOn: 'sql'
  },
  /*
   * G-012 ~ G-015 (v2.1.34) — bypasses proven against the shipped v2.1.33 rules.
   *
   * The rules above are a denylist of literal shapes, so they hold only for the
   * spellings someone thought to write down. Probing the live PreToolUse handler
   * showed which spellings were missing: the recursive-delete rules caught the
   * plain form, a variable-indirected form, an xargs form and `shutil.rmtree`,
   * but these four went straight through with `decision: allow`.
   *
   * A denylist is never complete, and these additions do not make it so. They
   * close the specific holes that were demonstrated rather than imagined, and
   * each ships with a regression test in
   * test/regression/destructive-bypass.test.js. The honest framing of this
   * subsystem is a known-pattern guard, not a complete defense — the docs now
   * say that.
   */
  {
    id: 'G-012',
    name: 'Obfuscated command execution',
    // `eval "$(echo <base64> | base64 -d)"`, `... | base64 --decode | sh`, and
    // the `bash <(...)` process-substitution form. The payload is unknowable at
    // match time, which is exactly why executing it cannot be waved through.
    pattern: /\b(base64\s+(-d|-D|--decode)\b[\s\S]*\|\s*(ba)?sh\b|eval\s+"?\$\(|(ba)?sh\s+<\(|\|\s*eval\b)/i,
    severity: 'critical',
    defaultAction: 'deny'
  },
  {
    id: 'G-013',
    name: 'Find-based mass deletion',
    // Design Ref: §3 Fix 1 (RB-003) — same targetFields scoping as G-001: prose
    // about find -delete in file content is not a deletion.
    targetFields: ['command'],
    // `find / -delete` and `find . -exec rm {} \;` delete recursively without
    // ever containing the token `rm -rf`, so G-001 and G-007 both miss them.
    pattern: /\bfind\s+[\s\S]*?(-delete\b|-exec\s+(rm|unlink|shred)\b|-execdir\s+(rm|unlink|shred)\b|\|\s*xargs\s+(-\S+\s+)*(rm|unlink|shred)\b)/i,
    severity: 'critical',
    defaultAction: 'deny',
    // ENH-443 (v2.1.36): grade by target, matching G-001. A broad target still
    // denies; a scoped one asks. See findTargetIsBroad() for the measured
    // asymmetry this removes.
    severityFor: (text) => (findTargetIsBroad(text) ? 'critical' : 'high'),
  },
  {
    id: 'G-014',
    name: 'Raw device or disk write',
    // `dd of=/dev/disk0`, `mkfs`, `> /dev/sda`. Destroys a volume outright and
    // shares no token with any delete rule.
    pattern: /\b(dd\s+[\s\S]*\bof=\s*\/dev\/|mkfs(\.\w+)?\s|>\s*\/dev\/(disk|sd|nvme|hd)\w*|\bwipefs\b|\bblkdiscard\b)/i,
    severity: 'critical',
    defaultAction: 'deny'
  },
  {
    id: 'G-015',
    name: 'Remote script piped to a shell',
    // `curl … | sh`, `wget -O- … | bash`. Executes code nobody in this session
    // has read, from a host nobody has vetted.
    pattern: /\b(curl|wget|fetch)\b[\s\S]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/i,
    severity: 'critical',
    defaultAction: 'deny'
  },
  /*
   * G-016 ~ G-018 (v2.1.37, ENH-477) — git commands that destroy work, measured
   * against the shipped v2.1.36 rules and found to pass unguarded.
   *
   * The trigger was Claude Code v2.1.229 removing auto-approval from 56 git/gh
   * spellings in `/commit-push-pr`. That list is NOT the model for these rules,
   * and copying it would have been a mistake: it carves dangerous commands out
   * of one skill's auto-approval, whereas this detector asks a human about
   * destruction anywhere. The two answer different questions.
   *
   * So each candidate was graded by one test — does it destroy work that cannot
   * be recovered? Of the four the analysis named, two failed that test and are
   * deliberately NOT here:
   *
   *   --amend      rewrites the last commit, and the original stays in the
   *                reflog. The dangerous half is publishing it, which needs a
   *                force push, which is G-002. On its own it is routine.
   *   --no-verify  skips git's own hooks. It bypasses a check; it destroys
   *                nothing.
   *
   * Adding those would have regressed the work v2.1.36 did — twelve measured
   * false positives down to one — by prompting on ordinary commits. A guard that
   * fires on routine work is how people learn to switch guards off.
   *
   * `git add -f` is likewise absent: it stages an ignored file, which is a leak
   * rather than a destruction, and the leak that matters (`git add -f .env`) is
   * now caught by G-005, whose word-boundary defect this release fixes.
   */
  {
    id: 'G-016',
    name: 'Untracked file deletion',
    /*
     * `git clean` with `-f` plus `-d` or `-x` deletes untracked files outright.
     * It is the most irreversible command in ordinary git use: unlike `reset
     * --hard` (G-003) there is no reflog entry, because the files were never in
     * the object store. Nothing in G-001 or G-013 sees it — the token `rm` never
     * appears.
     *
     * `-f` alone (no `-d`/`-x`) still deletes untracked files in the current
     * directory, so the force flag is matched anywhere in a short cluster, in
     * any order: `-fd`, `-df`, `-xdf`, `--force -d`. The first attempt anchored
     * `f` immediately after the dashes and missed `-xdf`, which is the spelling
     * most people actually type.
     */
    pattern: /\bgit\s+clean\b(?=[\s\S]*(?:--force\b|-[a-zA-Z]*f))/i,
    severity: 'critical',
    defaultAction: 'deny',
    // `-n` / `--dry-run` prints what WOULD be removed and removes nothing.
    // Prompting for a preview is the unfollowable friction ENH-445 removed
    // elsewhere; git itself treats the combination as a preview.
    suppressIf: isGitCleanDryRun,
    // Graded like G-001 and G-013: a broad target denies, a scoped one asks.
    // `git clean -fdx` at the repo root is not the same act as `git clean -fd ./build`.
    severityFor: (text) => (gitCleanTargetIsBroad(text) ? 'critical' : 'high'),
  },
  {
    id: 'G-017',
    name: 'Uncommitted change discard',
    /*
     * The three spellings that throw away the working tree without touching
     * history: `git checkout -f`, `git restore` against the worktree, and
     * `git switch --discard-changes`. Same consequence as `git reset --hard`,
     * which has been an `ask` since G-003 — so these are an `ask` too, rather
     * than three rules that grade one act differently depending on which verb
     * the user reached for.
     *
     * `git restore --staged` alone only unstages and is excluded: the file
     * content survives in the working tree. That exclusion lives in
     * isStagedOnlyRestore() rather than in a negative lookahead — the first
     * attempt used `(?![\s\S]*--staged\s*$)`, which only held when the flag was
     * the last token, so `git restore --staged .` still matched.
     */
    pattern: /\bgit\s+(?:checkout\s+(?:-f\b|--force\b)|switch\b[\s\S]*--discard-changes\b|restore\b)/i,
    severity: 'high',
    defaultAction: 'ask',
    suppressIf: isStagedOnlyRestore,
  },
  {
    id: 'G-018',
    name: 'Recovery history destruction',
    /*
     * The reflog is what makes `git reset --hard`, `git branch -D` and an
     * amended commit recoverable — it is the reason those are graded `ask` or
     * left alone. Expiring it and pruning immediately removes that safety net,
     * which is why this is here and plain `git gc` is not: the danger is the
     * combination of expiring NOW and pruning NOW.
     *
     * Deleting the backups is a bigger act than any single deletion they cover.
     */
    pattern: /\bgit\s+(?:reflog\s+expire\b[\s\S]*--expire(?:-unreachable)?=(?:now|all)\b|gc\b[\s\S]*--prune=now\b)/i,
    severity: 'critical',
    defaultAction: 'deny',
  },
  /*
   * G-019 (operator patch 2026-09-04, from the Inventory PDCA_GUARD_REDTEST
   * red-team engagement) — broker state modification.
   *
   * `.bkit/state/` holds the PDCA phase registry and is broker-only-writable:
   * phases advance through a Skill fire of /pdca, never through a hand edit.
   * The red test proved plain redirects are caught, but `sort -o` (a mutating
   * flag on a read-only verb), wildcard dir globs (`.??it`), and payloads
   * hidden in script files all slip past text matching that only looks for
   * the literal path. This rule matches the write FORMS around any bkit/pdca
   * token — either order — plus the deep-glob spellings, so the flag and
   * glob classes are denied at the bkit layer in every project.
   *
   * Out-of-session execution (cron etc.) and zero-literal payloads remain
   * beyond any command-text rule; those need filesystem verification
   * (PostToolUse revert) or OS-level protection of the state directory.
   */
  {
    id: 'G-019',
    name: 'Broker state modification',
    pattern: new RegExp(
      '(' +
      // write-verb form then broker-state token (round-10: anchored to
      // `.bkit/state` / pdca-status / the `.??it` glob spelling ONLY —
      // bare `state/`, prose `.bkit`, and /tmp probes are not tokens)
      '((?<![0-9&])>>?|\\btee\\b|\\bcp\\b|\\bmv\\b|\\brm\\b|\\bchmod\\b|\\btruncate\\b|dd\\s+of=|sort\\s+[^|;&]*-o\\s|find\\s+[^|;&]*-(delete|fprintf|fprint|fls)\\b|python3?\\b|\\bnode\\b|\\bperl\\b)' +
      '[^;|&\\n]{0,200}' +
      '(\\.bkit[\\s/\\\\]{1,3}state|pdca[-_]?status|\\.\\?[?*]?\\w{0,4}(?=\\s|/|$))' +
      '|' +
      // broker-state token then write-verb form
      '(\\.bkit[\\s/\\\\]{1,3}state|pdca[-_]?status|\\.\\?[?*]?\\w{0,4}(?=\\s|/|$))' +
      '[^;|&\\n]{0,200}' +
      '((?<![0-9&])>>?|\\btee\\b|\\bcp\\b|\\bmv\\b|\\brm\\b|\\bchmod\\b|\\btruncate\\b|dd\\s+of=|sort\\s+[^|;&]*-o\\s|find\\s+[^|;&]*-(delete|fprintf|fprint|fls)\\b)' +
      ')', 'i'),
    severity: 'critical',
    defaultAction: 'deny',
    /*
     * registry-lockdown (2026-09-07): state-guard rules are exempt when the
     * tool TARGET is a documentation file — see detect()'s docTargetExempt.
     */
    stateGuard: true,
  },
  /*
   * G-020 (registry-lockdown, 2026-09-07) — registry state write.
   *
   * Port of the machine-local ~/.claude/hooks/pdca-status-guard.py PRE-EXEC
   * semantics for the Write/Edit path: the phase registry (.bkit/state/*.json)
   * is broker-only-writable. Phases advance through a Skill fire of /pdca
   * (runSkillInvocationEffects → updatePdcaStatus) or the sanctioned archive
   * CLI (scripts/pdca-archive.js → lifecycle.archiveFeature) — never an agent
   * file edit. The Bash surface is G-019's job; this rule declares
   * targetFields so it only ever judges the tool's TARGET path, never the
   * payload content (a design doc whose prose demonstrates a state-path
   * command must not be denied — the FP class the operator reported).
   */
  {
    id: 'G-020',
    name: 'Registry state write',
    targetFields: ['file_path', 'filePath'],
    stateGuard: true,
    pattern: /\.bkit[\/\\]state[\/\\][^\s"']*\.(json|jsonl)$/i,
    severity: 'critical',
    defaultAction: 'deny',
  }
];

/**
 * Fields of a parsed hook input that can carry a destructive operation.
 * Anything not listed here (ids, booleans, metadata) is not worth matching and
 * only adds noise.
 */
const MATCHABLE_FIELDS = ['command', 'file_path', 'filePath', 'content', 'old_string', 'oldString', 'new_string', 'newString'];

/**
 * Normalize an input into the list of strings the rules should run against.
 *
 * ENH-389 (v2.1.33): this used to be `JSON.stringify(toolInput)` for anything
 * that was not already a string, which quietly broke every anchored pattern.
 * `{"command":"chmod 777 /"}` ends with `"}`, so G-008's `\/\s*$` never
 * matched and commands aimed at the filesystem root were invisible. Measured
 * before the fix:
 *   detect('Bash', 'chmod 777 /')              -> G-008 critical
 *   detect('Bash', { command: 'chmod 777 /' }) -> not detected
 *
 * Fixing only the call site would have left the trap armed for the next caller
 * (`scripts/pre-write.js:217` passes a parsed object today). Each field is
 * matched separately so per-field anchors behave exactly as they do for a bare
 * string, rather than being concatenated into one blob.
 *
 * @param {string|object|null|undefined} toolInput
 * @returns {string[]}
 */
function toMatchableStrings(toolInput) {
  if (typeof toolInput === 'string') return [toolInput];
  if (!toolInput || typeof toolInput !== 'object') return [''];
  const parts = [];
  for (const key of MATCHABLE_FIELDS) {
    const v = toolInput[key];
    if (typeof v === 'string' && v.length > 0) parts.push(v);
  }
  // Nothing recognizable — fall back to the raw values so a novel shape is not
  // silently exempt from every rule.
  if (parts.length === 0) {
    for (const v of Object.values(toolInput)) {
      if (typeof v === 'string' && v.length > 0) parts.push(v);
    }
  }
  return parts.length > 0 ? parts : [''];
}

/**
 * Targets that make a recursive delete catastrophic rather than routine.
 *
 * Deliberately conservative: anything not recognised as specific is treated as
 * broad. Being wrong in this direction costs a confirmation prompt; being wrong
 * in the other direction costs the user their data.
 */
const BROAD_DELETE_TARGETS = [
  /(^|\s)\/(\s|$)/,                       // the filesystem root
  /(^|\s)~(\/?\s|\/?$)/,                  // home
  /\$(HOME|PWD|CWD|ROOT|PROJECT_ROOT)\b/, // an env var standing in for a root
  /(^|\s)\.\.?(\s|$)/,                    // bare . or ..
  /(^|\s)\/(etc|usr|var|bin|sbin|lib|opt|boot|dev|sys|proc|System|Library|Applications|Users|home)(\/|\s|$)/i,
  /(^|\s)[A-Za-z]:\\(\s|$)/,              // a Windows drive root
  /(^|\s)\/\*/,                           // a glob directly under root
  /(^|\s)\*(\s|$)/,                       // a bare glob
  /(^|\s)["']?\$\{?\w+\}?["']?(\s|$)/,    // an unresolved variable as the whole target
];

/**
 * Does this recursive-delete command aim at something broad?
 *
 * An unparseable command counts as broad — the point is to be sure the target
 * is specific before relaxing, never to guess that it is.
 *
 * @param {string} text - the command that matched the recursive-delete pattern
 * @returns {boolean}
 */
function deleteTargetIsBroad(text) {
  if (typeof text !== 'string') return true;

  /*
   * The target list runs from the delete verb to the next command separator —
   * NOT to the end of the input.
   *
   * The first version used `(.*)$` with the `s` flag, which swallowed every
   * subsequent line of a multi-command block, so anything appearing later in
   * the script was read as an operand of the delete. Reproduced while working
   * on v2.1.34, on a block of the shape:
   *
   *   cd "$JOB/tmp" && rm -rf degtest && mkdir degtest
   *   ...
   *   printf ... | CLAUDE_PROJECT_DIR="$PWD" node r.js
   *
   * `$PWD` on the last line matched the "env var standing in for a root" rule,
   * so a delete of one scoped directory was graded `critical` and refused —
   * while advising the user to "scope the command to a specific path", which
   * they had already done. A guard that refuses correct commands and gives
   * unfollowable advice is one people switch off, and then it protects nothing.
   */
  const m = text.match(/\b(?:rm|rimraf|Remove-Item)\b([^\n;|&]*)/i);
  if (!m) return true; // shutil.rmtree(...) and friends: not parsed, stay strict
  const operands = m[1]
    .split(/\s+/)
    .filter((tok) => tok && !tok.startsWith('-'));

  if (operands.length === 0) return true; // no target found — do not relax

  return operands.some((operand) => {
    const target = ' ' + operand.replace(/^["']|["']$/g, '') + ' ';
    return BROAD_DELETE_TARGETS.some((re) => re.test(target));
  });
}

/**
 * Commands that report a file's METADATA without reading its contents.
 *
 * ENH-445 (v2.1.36) — G-006 fires on any mention of a key-file extension, so
 * `ls -la ./certs/server.pem` was graded "Secret key access" and prompted. The
 * rule exists to notice a secret being READ or moved; a directory listing does
 * neither, and prompting for it is the kind of unfollowable friction that
 * teaches people to switch the guard off.
 *
 * Deliberately a short allowlist of commands whose entire job is metadata. Any
 * verb not on it — including every reader (`cat`, `head`, `openssl`, `base64`)
 * and every copier (`cp`, `scp`, `rsync`) — still fires.
 */
const METADATA_ONLY_COMMANDS = [
  'ls', 'll', 'stat', 'file', 'find', 'basename', 'dirname', 'realpath',
  'readlink', 'test', 'wc', 'du',
];

/**
 * Conventional `.env` template suffixes — files whose entire purpose is to be
 * committed. Kept identical to the closed list ENH-464 (v2.1.36) settled on for
 * the write path in lib/control/scope-limiter.js, so the two surfaces cannot
 * disagree about one file.
 */
const ENV_TEMPLATE_SUFFIXES = ['example', 'sample', 'template', 'dist'];

/**
 * Runtime objects whose `.env` is a variable map, not a file.
 *
 * `process.env.NODE_ENV` is how every Node program reads configuration, and the
 * shipped G-005 pattern matched it — so editing any file that reads an
 * environment variable prompted. A closed list, in the style of
 * METADATA_ONLY_COMMANDS: anything not named here still fires.
 */
const RUNTIME_ENV_ACCESSORS = ['process', 'meta', 'deno', 'bun', 'globalthis'];

/**
 * Every `.env` in this segment is harmless.
 *
 * ENH-477 (v2.1.37). Two harmless shapes, and the suppression holds only when
 * EVERY occurrence is one of them — `cp .env.example .env` mentions a template
 * and a real secret store, and the second is the reason to ask.
 *
 *   template       `.env.example`, `.env.local.example` — exists to be
 *                  committed. Judged on the LAST segment of the dotted chain, so
 *                  a nested template is still a template; the first attempt read
 *                  only the first segment and prompted on `.env.local.example`,
 *                  which an existing regression control caught.
 *   runtime access `process.env.PORT` — a variable read, not a file.
 *
 * @param {string} text - the segment that matched
 * @returns {boolean}
 */
function isBenignEnvMention(text) {
  if (typeof text !== 'string') return false;
  // Greedy on the prefix, deliberately: a lazy `*?` matches empty every time and
  // the accessor is never captured, so `process.env.PORT` reads as a bare file.
  const re = /([\w.]*)\.env((?:\.[\w-]+)*)(?![\w-])/gi;
  let m;
  let seen = 0;
  while ((m = re.exec(text)) !== null) {
    seen++;
    const prefix = (m[1] || '').split('.').filter(Boolean).pop() || '';
    if (RUNTIME_ENV_ACCESSORS.includes(prefix.toLowerCase())) continue;
    const chain = (m[2] || '').split('.').filter(Boolean);
    const last = (chain[chain.length - 1] || '').toLowerCase();
    if (ENV_TEMPLATE_SUFFIXES.includes(last)) continue;
    return false; // this one is a real environment file
  }
  return seen > 0;
}

/**
 * Is this segment nothing but a metadata query over its operands?
 *
 * @param {string} text - the segment that matched
 * @returns {boolean} true when the leading command only reports metadata
 */
function isMetadataOnlyAccess(text) {
  if (typeof text !== 'string') return false;
  const m = text.trim().match(/^([\w./-]+)/);
  if (!m) return false;
  const verb = m[1].split('/').pop(); // /bin/ls -> ls
  return METADATA_ONLY_COMMANDS.includes(verb.toLowerCase());
}

/**
 * Wrappers that stand in front of the real command without changing what it is.
 * `sudo rm …` is still an `rm`; the guard has to see through them.
 */
const COMMAND_WRAPPERS = ['sudo', 'command', 'env', 'nice', 'nohup', 'time', 'exec', 'doas'];

/**
 * Commands that can only read and report. Deliberately short.
 *
 * `echo` and `printf` are NOT here, and that is the whole design of this list:
 * they are how a payload gets built (`echo "…" | sh`), so treating them as inert
 * would open the hole this guard exists to close. Only search tools qualify —
 * they have no write mode at all.
 */
const SEARCH_ONLY_COMMANDS = ['grep', 'egrep', 'fgrep', 'rg', 'ripgrep', 'ag', 'ack'];

/**
 * Does this segment contain a shell metacharacter OUTSIDE quotes?
 *
 * The quote-awareness is not a nicety. A search pattern routinely contains the
 * very characters that would otherwise disqualify it — `grep -rlE "DROP|rm" lib`
 * has a `|` inside a quoted regex, and reading that as a pipe would leave the
 * commonest form of this false positive unfixed while claiming to have fixed it.
 *
 * Scanning follows splitCommandSegments(): a backslash escapes the next
 * character, single and double quotes toggle, and only unquoted text counts. An
 * unbalanced quote means the segment cannot be parsed with confidence, so it is
 * reported as escaping — the conservative answer.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasUnquotedShellEscape(text) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (c === '|' || c === '>' || c === '<' || c === '`' || c === ';' || c === '&') return true;
    if (c === '$' && text[i + 1] === '(') return true;
  }
  // Unbalanced quoting — do not claim to understand this segment.
  return inSingle || inDouble;
}

/**
 * Is this segment a search that provably cannot execute or delete anything?
 *
 * ENH-473 (v2.1.37). Every rule in this table matches text, so a command that
 * merely *contains* a dangerous string is graded as if it performed one. Searching
 * for the string is the clearest case: this was hit twice while writing v2.1.37,
 * once when a `grep` for two rule patterns was refused as "Recursive delete; SQL
 * table drop". Nothing was deleted and nothing could have been — grep has no
 * write mode.
 *
 * Same defect class as ENH-470 one level up: ENH-470 stopped G-007 reading a WORD
 * as a delete command, and this stops any rule reading a search ARGUMENT as an
 * operation.
 *
 * The bound is deliberately severe, because the failure direction here is a false
 * negative — a real destructive command passing unseen — and that is much worse
 * than the false positive it fixes. Both conditions must hold:
 *
 *   1. the command head is a search tool with no write mode (not `echo`, which is
 *      how `echo "…" | sh` starts), and
 *   2. the segment contains no character through which a shell could be reached.
 *
 * With both, the segment cannot do anything but print. `grep -rn "…" . | sh`
 * fails (2), `echo "…" | sh` fails (1), and a redirection to a file that is later
 * executed fails (2). Negative controls for all three ship with this change.
 *
 * @param {string} text - one command segment
 * @returns {boolean} true when no rule should be matched against this segment
 */
function isInertSearchInvocation(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (hasUnquotedShellEscape(trimmed)) return false;

  let rest = trimmed;
  while (true) {
    const m = rest.match(/^(\S+)\s+([\s\S]*)$/);
    if (!m) break;
    const head = m[1];
    const isAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(head);
    const isWrapper = COMMAND_WRAPPERS.includes(head.split('/').pop().toLowerCase());
    if (!isAssignment && !isWrapper) break;
    rest = m[2].trim();
  }

  const command = (rest.split(/\s+/)[0] || '').split('/').pop().toLowerCase();
  return SEARCH_ONLY_COMMANDS.includes(command);
}

/** The verbs G-007 is written about. */
const DELETE_VERBS = ['rm', 'del', 'delete', 'remove'];

/**
 * Is the delete verb something OTHER than this segment's command?
 *
 * ENH-470 (v2.1.37). G-007 is named "Mass file deletion" and counts operands
 * after the token `rm`/`del`/`delete`/`remove`. Its pattern lets that token sit
 * anywhere in the segment, so anything that merely *mentions* deletion and takes
 * five or more arguments matched. Measured on v2.1.36, after issue #148's
 * segment-scoping fix had already landed:
 *
 *   grep -rn delete src a b c d e            -> G-007, ask   (read-only)
 *   npm remove lodash react vue axios dayjs  -> G-007, ask   (package manager)
 *
 * Neither deletes a file. The first cannot delete anything at all. This is the
 * same defect class issue #148 reported — an operand list read past its own
 * boundaries — surviving one level down: #148 fixed reading across command
 * separators, and this fixes reading across the command name itself.
 *
 * The rule stands down unless the segment's command head is a delete verb, after
 * looking through `VAR=value` prefixes, the wrappers above, and a path
 * (`/bin/rm` reads as `rm`). `npm remove …` therefore stops matching, because the
 * command is `npm`.
 *
 * This narrows G-007 only, and G-007 is the weakest rule in the table
 * (`medium`/`ask`). A genuine `rm a b c d e f` still matches here; a recursive
 * delete is G-001's; a find-driven delete is G-013's; an unscoped SQL DELETE is
 * G-010b's. Regression controls for all four ship alongside this change, because
 * a narrowing without them is indistinguishable from a hole.
 *
 * @param {string} text - one command segment
 * @returns {boolean} true when G-007 should stand down
 */
function isNotACommandLevelDelete(text) {
  if (typeof text !== 'string') return false;
  let rest = text.trim();
  if (!rest) return false;

  // Strip leading `VAR=value` assignments and transparent wrappers, repeatedly:
  // `sudo NODE_ENV=x /bin/rm …` has both.
  while (true) {
    const m = rest.match(/^(\S+)\s+([\s\S]*)$/);
    if (!m) break;
    const head = m[1];
    const isAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(head);
    const isWrapper = COMMAND_WRAPPERS.includes(head.split('/').pop().toLowerCase());
    if (!isAssignment && !isWrapper) break;
    rest = m[2].trim();
  }

  const command = (rest.split(/\s+/)[0] || '').split('/').pop().toLowerCase();
  return !DELETE_VERBS.includes(command);
}

/**
 * Does this segment read as a SQL statement rather than a shell command?
 *
 * ENH-447 (v2.1.36) — G-007 ("Mass file deletion") counts operands after the
 * token `delete`, and SQL's `DELETE FROM` supplies it. Measured on v2.1.35, the
 * safe, scoped statement
 *
 *   DELETE FROM audit_log WHERE id = 1
 *
 * was reported as a filesystem mass-deletion. The SQL rules (G-009, G-010,
 * G-010b, G-011) are the ones that own this language; G-007 has nothing useful
 * to say about it and should stand down rather than double-report.
 *
 * This suppresses G-007 only. It does not weaken the SQL rules — a genuinely
 * unscoped `DELETE FROM audit_log` is still caught by G-010b, which is the rule
 * written for it.
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeSqlStatement(text) {
  if (typeof text !== 'string') return false;
  return /\b(DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+[\w.]+\s+SET|TRUNCATE\s+TABLE|DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW)|SELECT\s+[\s\S]*\bFROM\b)\b/i.test(text);
}

/**
 * Branch names a force push must never quietly overwrite.
 *
 * Mirrors G-004's protected set, so "which branches matter" is stated once in
 * spirit even though the two rules match different shapes.
 */
const PROTECTED_BRANCHES = /\b(main|master|release|production)\b/i;

/**
 * Is this force push aimed at a protected branch?
 *
 * ENH-462 (v2.1.36) — G-002 had no `severityFor`, so every force push denied,
 * including the routine one:
 *
 *   git push --force-with-lease origin my-topic-branch   ->  critical / deny
 *
 * Rewriting your own topic branch after a rebase is ordinary work, and
 * `--force-with-lease` is the careful spelling of it — it refuses if upstream
 * moved. Denying that outright is the "refuses correct commands" failure this
 * release is about, and it is why bkit's own push-event-guard already
 * distinguishes upstream from fork while this rule did not.
 *
 * A protected target still denies. Anything else asks, so the push is confirmed
 * rather than refused. An unparseable target counts as protected: when the
 * branch cannot be read, `git push --force` with no refspec pushes the current
 * branch, which may well be main.
 *
 * @param {string} text - the segment that matched the force-push pattern
 * @returns {boolean}
 */
function pushTargetIsProtected(text) {
  if (typeof text !== 'string') return true;
  const m = text.match(/\bgit\s+push\b([^\n;|&]*)/i);
  if (!m) return true;
  const operands = m[1]
    .split(/\s+/)
    .filter((tok) => tok && !tok.startsWith('-'));
  // No remote/refspec given: git pushes the current branch, which is unknown here.
  if (operands.length === 0) return true;
  return operands.some((tok) => PROTECTED_BRANCHES.test(tok));
}

/**
 * Does this find-based deletion aim at something broad?
 *
 * ENH-443 (v2.1.36) — G-013 had no `severityFor`, so it graded every match
 * `critical` and denied outright. That produced the asymmetry issue #148 called
 * out, measured on v2.1.35:
 *
 *   rm -rf /tmp/scratch/build                       -> G-001 / high     / ask
 *   find /tmp/scratch -type f -name '*.tmp' -delete -> G-013 / critical / deny
 *
 * The strictly narrower operation was refused harder, and the refusal advised
 * "scope the command to a specific path" — which the user had already done.
 *
 * find's paths are the operands before the first expression token, so the search
 * stops at the first `-flag`. A find with no path defaults to the working
 * directory, which `BROAD_DELETE_TARGETS` already treats as broad; an
 * unparseable command stays broad for the same reason `deleteTargetIsBroad()`
 * does — be sure the target is specific before relaxing, never guess that it is.
 *
 * @param {string} text - the segment that matched the find-based deletion pattern
 * @returns {boolean}
 */
/**
 * Is this `git clean` a preview rather than a deletion?
 *
 * ENH-477 (v2.1.37). `-n` / `--dry-run` prints what would be removed and removes
 * nothing, and git accepts it alongside `-f`. Prompting for a preview is the
 * unfollowable friction ENH-445 removed from G-006.
 *
 * @param {string} text - the segment that matched
 * @returns {boolean}
 */
function isGitCleanDryRun(text) {
  if (typeof text !== 'string') return false;
  return /(^|\s)(--dry-run\b|-[a-zA-Z]*n(?![a-zA-Z]))/.test(text);
}

/**
 * Is this `git restore` only unstaging?
 *
 * ENH-477 (v2.1.37). `--staged` on its own moves content out of the index and
 * leaves the working tree untouched, so nothing is lost. Paired with
 * `--worktree` it DOES overwrite the working tree, which is the act G-017
 * exists for.
 *
 * Only `restore` is inspected: the other two spellings the rule matches
 * (`checkout -f`, `switch --discard-changes`) have no such harmless form.
 *
 * @param {string} text - the segment that matched
 * @returns {boolean}
 */
function isStagedOnlyRestore(text) {
  if (typeof text !== 'string') return false;
  if (!/\bgit\s+restore\b/i.test(text)) return false;
  const staged = /(^|\s)(--staged|-S)(\s|$)/.test(text);
  const worktree = /(^|\s)(--worktree|-W)(\s|$)/.test(text);
  return staged && !worktree;
}

/**
 * Does this `git clean` invocation target the whole repository?
 *
 * ENH-477 (v2.1.37). Graded the same way as G-001 and G-013: a broad target
 * denies, a scoped one asks. `git clean -fd ./build` is a build-directory reset;
 * `git clean -fdx` at the root deletes every untracked file in the repository,
 * including local config the user never intended to lose.
 *
 * With no path operand git cleans from the current directory down, so the
 * absence of a path is the broad case, not the narrow one — the same default
 * findTargetIsBroad() takes for `find`.
 *
 * @param {string} text - the segment that matched
 * @returns {boolean}
 */
function gitCleanTargetIsBroad(text) {
  if (typeof text !== 'string') return true;

  const m = text.match(/\bgit\s+clean\b([^\n;]*)/i);
  if (!m) return true;

  const paths = [];
  for (const tok of m[1].split(/\s+/)) {
    if (!tok) continue;
    if (tok === '--') continue;
    if (tok.startsWith('-')) continue; // flags may precede or follow the path
    paths.push(tok);
  }

  if (paths.length === 0) return true; // implicit cwd — cleans everything below it

  return paths.some((operand) => {
    const target = ' ' + operand.replace(/^["']|["']$/g, '') + ' ';
    return BROAD_DELETE_TARGETS.some((re) => re.test(target));
  });
}

function findTargetIsBroad(text) {
  if (typeof text !== 'string') return true;

  const m = text.match(/\bfind\b([^\n;]*)/i);
  if (!m) return true;

  const paths = [];
  for (const tok of m[1].split(/\s+/)) {
    if (!tok) continue;
    if (tok.startsWith('-')) break; // expressions start here; paths are done
    paths.push(tok);
  }

  if (paths.length === 0) return true; // implicit cwd, or nothing parseable

  return paths.some((operand) => {
    const target = ' ' + operand.replace(/^["']|["']$/g, '') + ' ';
    return BROAD_DELETE_TARGETS.some((re) => re.test(target));
  });
}

/**
 * Remove heredoc BODIES before rule matching.
 *
 * A heredoc body is data on a program's stdin, not a command line. Matching
 * rules against it produces false positives that are indistinguishable from
 * real findings — writing a commit message that merely *mentions* `find -delete`
 * or `curl | sh`, or piping documentation text through `python3 - <<'PY'`, was
 * enough to be refused as critical. Both happened during work on v2.1.34, and a
 * guard that blocks ordinary work is a guard people switch off.
 *
 * This does not create a bypass. The heredoc-as-bypass vector — a heredoc piped
 * into an interpreter, or a command substitution alongside one — is the whole
 * subject of `lib/defense/heredoc-detector.js`, which inspects the command
 * STRUCTURE and still sees everything here. What this strips is only the inert
 * payload, and the delimiter line itself is kept so structural rules can still
 * see that a heredoc was present.
 *
 * Handles the `<<EOF`, `<<-EOF`, `<<'EOF'` and `<<"EOF"` spellings.
 *
 * @param {string} command
 * @returns {string} the command with heredoc bodies elided
 */
/**
 * Find a heredoc opener on a line, ignoring any `<<` that sits inside quotes.
 *
 * v2.1.34: an earlier version matched `<<` anywhere on the line, which is a
 * bypass rather than a nicety. `echo "example: cmd << EOF"` starts a bogus
 * elision, and every line up to the next `EOF` is discarded — including a real
 * destructive command. Measured against that earlier version:
 *
 *   echo "example: cmd << EOF"   →  stripped to the echo alone
 *   rm -rf ~/                        (elided)
 *   EOF                              detect: []
 *
 * Quote tracking is deliberately simple — single and double quotes, with
 * backslash escapes — because the only decision it feeds is "may this line be
 * treated as an opener". Anything it cannot parse confidently is left alone,
 * which keeps evidence rather than removing it.
 *
 * @param {string} line
 * @returns {string|null} the delimiter, or null when this line opens no heredoc
 */
function findHeredocDelimiter(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { i++; continue; }
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (c !== '<' || line[i + 1] !== '<') continue;
    // `<<<` is a here-STRING, not a heredoc — it has no body and no terminator.
    if (line[i + 2] === '<') continue;
    const m = line.slice(i).match(/^<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/);
    if (m) return m[1] || m[2] || m[3];
    return null;
  }
  return null;
}

function stripHeredocBodies(command) {
  if (typeof command !== 'string' || !command.includes('<<')) return command;
  const lines = command.split('\n');
  const out = [];
  let delimiter = null;
  let terminated = true;
  for (const line of lines) {
    if (delimiter === null) {
      out.push(line);
      const found = findHeredocDelimiter(line);
      if (found) { delimiter = found; terminated = false; }
      continue;
    }
    /*
     * Inside a body: drop the content, but keep the terminator line WHOLE. A
     * known bypass writes the exec vector on that line (`EOF-1 | bash`), so
     * truncating at the delimiter would remove the very thing worth matching.
     * Prefix match, not equality, for the same reason.
     */
    if (line.trim() === delimiter || line.trimStart().startsWith(delimiter)) {
      out.push(line);
      delimiter = null;
      terminated = true;
    }
  }
  // No terminator found — there is no trustworthy body boundary, so match
  // against everything. This helper may remove noise, never evidence.
  if (!terminated) return command;
  return out.join('\n');
}

/**
 * Strip SQL comments so a commented-out keyword cannot stand in for a real clause.
 *
 * ENH-446 (v2.1.36) — G-010b fires only when no WHERE follows the DELETE, so any
 * occurrence of the WORD `WHERE` suppresses it. A comment is not a clause.
 * Measured on v2.1.35:
 *
 *   DELETE FROM audit_log -- WHERE     -> not detected
 *
 * A comment introducer must be `--` followed by WHITESPACE or end-of-input.
 * Without that condition this helper destroys evidence: the first version
 * treated the shell flag `--command` as a comment, so
 *
 *   wrangler d1 execute db --command "DROP TABLE audit_log"
 *
 * was truncated to `wrangler d1 execute db` and G-009 stopped firing — a real
 * DROP went undetected. That regression was caught by the negative controls
 * before it left the working tree, which is precisely why they are run on every
 * change. `--WHERE` (no space) is therefore left intact; keeping a token we are
 * unsure about costs a prompt, discarding one costs a table.
 *
 * Quote-aware for the same reason as everywhere else in this file — a literal
 * `'--'` inside a string is data, not a comment introducer.
 *
 * @param {string} text
 * @returns {string} the statement with `--` line comments and block comments removed
 */
function stripSqlComments(text) {
  if (typeof text !== 'string' || (!text.includes('--') && !text.includes('/*'))) return text;

  let out = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { out += c + (text[i + 1] || ''); i++; continue; }
    if (c === "'" && !inDouble) { inSingle = !inSingle; out += c; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; out += c; continue; }
    if (!inSingle && !inDouble) {
      if (c === '-' && text[i + 1] === '-' && /^(\s|$)/.test(text[i + 2] || '')) {
        const nl = text.indexOf('\n', i);
        if (nl === -1) break;
        i = nl;
        out += '\n';
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end === -1) break;
        i = end + 1;
        out += ' ';
        continue;
      }
    }
    out += c;
  }
  return out;
}

/**
 * Split a command into the segments a rule may legitimately span.
 *
 * ENH-440 (v2.1.36) — every rule below is written as a single command's shape,
 * but they were matched against the WHOLE input. `.*` and `[\s\S]*` therefore ran
 * past `&&`, `;` and newlines, so tokens belonging to *other* commands in a chain
 * were read as operands of the dangerous one. G-001 already solved this for
 * itself at `deleteTargetIsBroad()` by cutting at `[^\n;|&]`; this generalizes
 * that cut so every rule gets it, instead of nine near-copies of the same regex.
 *
 * Measured on v2.1.35, this defect ran in BOTH directions:
 *
 *   false positives — a safe command refused because a later command supplied
 *   the incriminating token:
 *     git push origin feature-x && rm -f /tmp/scratch/note.txt   -> G-002 deny
 *     cp a.txt b.txt && ls /                                     -> G-008 deny
 *     dd if=/dev/zero of=./scratch.img && echo "of=/dev/null"     -> G-014 deny
 *
 *   false negatives — a real threat hidden because a later command pushed an
 *   end-anchor out of reach or satisfied a negative lookahead:
 *     chmod 777 / ; ls                     -> NOTHING detected (G-008 defeated)
 *     DELETE FROM audit_log; SELECT 1 WHERE x=1 -> G-010b defeated
 *
 * The false negatives are why this is a correctness fix and not a comfort fix.
 *
 * `|` is deliberately NOT a split point. A pipe is how several rules' threat is
 * expressed — `curl … | sh` (G-015), `base64 -d … | sh` (G-012),
 * `find … | xargs rm` (G-013) are each ONE dangerous construct, not two safe
 * ones. Splitting there would blind exactly the rules that exist to catch it.
 * `||` is a sequencer, not a pipe, and does split.
 *
 * Quote tracking mirrors `findHeredocDelimiter()`: single and double quotes with
 * backslash escapes, so `echo "a && b"` stays one segment. Anything the tracker
 * cannot parse confidently is left joined — this helper may narrow a window,
 * never hide evidence.
 *
 * A newline separates SHELL commands but NOT SQL statements, which end at `;`.
 * Splitting SQL on newlines would refuse the ordinary
 *
 *   DELETE FROM audit_log
 *   WHERE id = 1
 *
 * because segment 1 has no WHERE — turning a fix for one false positive into a
 * new one. Hence `mode`: rules written in SQL declare `segmentOn: 'sql'` and are
 * cut at `;` only. Measured on v2.1.35, that statement is correctly clean today,
 * and it must stay clean.
 *
 * @param {string} text
 * @param {'shell'|'sql'} [mode='shell'] which separators terminate a statement
 * @returns {string[]} one entry per segment; the original text when it contains
 *   no top-level separator
 */
function splitCommandSegments(text, mode) {
  if (typeof text !== 'string' || text.length === 0) return [''];
  const sqlMode = mode === 'sql';

  const segments = [];
  let start = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;

    let sepLen = 0;
    if (c === ';') sepLen = 1;
    else if (!sqlMode && c === '\n') sepLen = 1;
    else if (!sqlMode && ((c === '&' && text[i + 1] === '&') || (c === '|' && text[i + 1] === '|'))) sepLen = 2;

    if (sepLen > 0) {
      segments.push(text.slice(start, i));
      i += sepLen - 1;
      start = i + 1;
    }
  }
  segments.push(text.slice(start));

  const trimmed = segments.map((s) => s.trim()).filter((s) => s.length > 0);
  return trimmed.length > 0 ? trimmed : [text];
}

/**
 * Detect destructive operations in a tool invocation
 * @param {string} toolName - Name of the tool being invoked
 * @param {string|object} toolInput - Command string, or a parsed tool input whose
 *   command/path/content fields are matched individually (see toMatchableStrings)
 * @returns {DetectionResult}
 */
/**
 * Resolve the action a matched rule calls for, from its declaration and its
 * graded severity.
 *
 * `critical` always denies. Otherwise the rule's own `defaultAction` stands —
 * except when the rule graded ITSELF down from `critical` (G-001 on a scoped
 * target). There the declaration describes the worst case, not this match, so
 * `deny` relaxes exactly one tier, to `ask`. It never relaxes to silence.
 *
 * @param {object} rule - the rule as declared in GUARDRAIL_RULES
 * @param {string} severity - the severity this particular match graded to
 * @returns {'deny'|'ask'|'allow'}
 */
function resolveAction(rule, severity) {
  if (severity === 'critical') return 'deny';
  const declared = rule.defaultAction || 'ask';
  const gradedDown = typeof rule.severityFor === 'function' && rule.severity === 'critical';
  if (declared === 'deny') return gradedDown ? 'ask' : 'deny';
  return declared;
}

function detect(toolName, toolInput) {
  /*
   * registry-lockdown (2026-09-07): documentation-target exemption.
   *
   * A Write/Edit whose TARGET is a .md/.txt file never trips a state-guard
   * rule, regardless of what its payload contains. This is the operator's
   * reported FP class: prose in a design doc legitimately demonstrates
   * state-path commands (`echo x > .bkit/state/...`), and a rule matching
   * payload fields denied the doc itself. Exemption runs BEFORE any
   * state-token matching so ordering can never defeat it (design §7).
   */
  const docTarget = (toolName === 'Write' || toolName === 'Edit'
    || toolName === 'MultiEdit' || toolName === 'NotebookEdit')
    ? String((toolInput && (toolInput.file_path || toolInput.filePath
        || toolInput.notebook_path)) || '')
    : '';
  const docTargetExempt = /\.(md|txt)$/i.test(docTarget)
    || /(^|[\/\\])docs[\/\\]/.test(docTarget);

  const inputs = toMatchableStrings(toolInput).map(stripHeredocBodies);
  // Kept for the tool-specific checks below, which only need substring semantics.
  const input = inputs.join('\n');

  /*
   * ENH-440 (v2.1.36) — match each rule against single command/statement
   * segments rather than the whole input. See splitCommandSegments() for why
   * this fixes false positives and false negatives at the same time, and why
   * `|` is not a split point.
   *
   * Both segmentations are computed once and reused across the rule table; a rule
   * picks the one matching the language it is written in.
   */
  /*
   * ENH-473 (v2.1.37): a segment that provably cannot execute or delete anything
   * is dropped before any rule sees it. Applied to both segmentations, because a
   * shell `grep` invocation is still present in the SQL-mode split and would
   * otherwise be matched by the SQL rules against its own search pattern.
   */
  const inert = isInertSearchInvocation;
  const segmentsByMode = {
    shell: inputs.flatMap((s) => splitCommandSegments(s, 'shell')).filter((s) => !inert(s)),
    // Comments are stripped BEFORE splitting so a `--` comment cannot hide a
    // statement separator, and a commented-out keyword cannot satisfy a
    // negative lookahead (ENH-446).
    sql: inputs.flatMap((s) => splitCommandSegments(stripSqlComments(s), 'sql')).filter((s) => !inert(s)),
  };
  const matchedRules = [];

  for (const rule of GUARDRAIL_RULES) {
    // registry-lockdown: state-guard rules stand down entirely for doc targets.
    if (docTargetExempt && rule.stateGuard) continue;
    /*
     * registry-lockdown: a rule may declare targetFields — it then judges ONLY
     * those payload fields (raw, unsegmented), never the whole input. G-020
     * uses this so a registry-path mention in content/old_string/new_string is
     * not a write, while the same string as file_path is.
     */
    if (Array.isArray(rule.targetFields) && toolInput && typeof toolInput === 'object') {
      const hitField = rule.targetFields
        .map((f) => toolInput[f])
        .filter((v) => typeof v === 'string' && v.length > 0)
        .find((v) => rule.pattern.test(v));
      if (hitField !== undefined) {
        /*
         * ENH-443 parity fix (GP-11): a targetFields rule that grades itself
         * (severityFor) must grade here too. This branch pushed rule.severity
         * directly, so G-001/G-013's target-based grading was dead on the
         * Bash-command path — `rm -rf /tmp/scratch/build` denied critical
         * instead of asking high, exactly the asymmetry ENH-443 removed on
         * the segmented path. Same contract as the segmented branch below:
         * the graded severity decides the action via resolveAction().
         */
        const severity = typeof rule.severityFor === 'function'
          ? rule.severityFor(hitField)
          : rule.severity;
        matchedRules.push({
          id: rule.id,
          name: rule.name,
          severity,
          action: resolveAction(rule, severity),
          pattern: rule.pattern.source
        });
      }
      continue;
    }
    const segments = segmentsByMode[rule.segmentOn === 'sql' ? 'sql' : 'shell'];
    /*
     * A rule may declare `suppressIf` for contexts where its pattern provably
     * says nothing useful — a metadata-only listing for G-006, a SQL statement
     * for G-007. Suppression is evaluated per segment, so a chain that also
     * contains a genuine match still reports it.
     *
     * This is deliberately narrower than grading: `severityFor` cannot help a
     * rule whose declared action is already `ask`, because resolveAction()
     * returns a non-critical rule's declared action unchanged and there is no
     * tier below `ask` short of silence.
     */
    const hit = segments.find(
      (s) => rule.pattern.test(s)
        && !(typeof rule.suppressIf === 'function' && rule.suppressIf(s))
    );
    if (hit !== undefined) {
      // A rule may grade itself from the matched text — see G-001, where the
      // target decides whether a recursive delete is catastrophic or routine.
      const severity = typeof rule.severityFor === 'function'
        ? rule.severityFor(hit)
        : rule.severity;
      matchedRules.push({
        id: rule.id,
        name: rule.name,
        severity,
        /*
         * v2.1.34 — the action the rule table declares for this match.
         *
         * `defaultAction` has been on every rule since the table was written,
         * but nothing read it: the hook branched on `severity === 'critical'`
         * and did nothing at all otherwise. Ten rules declared `ask` and none
         * of them ever asked. Surfacing it here makes the table the single
         * place that decides deny-vs-ask.
         *
         * A graded rule outranks its own declaration in the dangerous
         * direction only: G-001 declares `deny`, and a scoped delete grades to
         * `high`, so it asks — but a broad delete grades back to `critical`
         * and denies. Grading never turns a `deny` into silence.
         */
        action: resolveAction(rule, severity),
        pattern: rule.pattern.source
      });
    }
  }

  /*
   * A second look at the two file rules against the UN-segmented input, for a
   * Write or an Edit whose payload a segment boundary could have split.
   *
   * ENH-481 (v2.1.37) — this used to test `rule.pattern` and nothing else. It
   * skipped `suppressIf`, so both suppressors that guard these two rules were
   * dead on this path while working on the Bash path:
   *
   *   G-006  ENH-445's isMetadataOnlyAccess — `ls -la ./certs/server.pem` is
   *          suppressed for a Bash command and was NOT suppressed here.
   *   G-005  every exemption below, including `.env.example`.
   *
   * The same class as ENH-441, which v2.1.36 fixed for `isDestructive()`: two
   * entry points answering differently about one input, with the difference
   * invisible until someone routed a payload through the other one. It was found
   * while fixing G-005, when a suppressor that returned `true` for its segment
   * did not suppress the rule.
   *
   * The purpose of the second look is kept — segmentation can split a payload —
   * but it now applies the same predicate the main loop does.
   */
  if (toolName === 'Write' || toolName === 'Edit') {
    for (const id of ['G-005', 'G-006']) {
      const rule = GUARDRAIL_RULES.find((r) => r.id === id);
      if (!rule || matchedRules.some((r) => r.id === id)) continue;
      if (!rule.pattern.test(input)) continue;
      if (typeof rule.suppressIf === 'function' && rule.suppressIf(input)) continue;
      const severity = typeof rule.severityFor === 'function'
        ? rule.severityFor(input)
        : rule.severity;
      matchedRules.push({
        id: rule.id,
        name: rule.name,
        severity,
        action: resolveAction(rule, severity),
        pattern: rule.pattern.source,
      });
    }
  }

  const confidence = matchedRules.length > 0
    ? Math.min(1, 0.5 + matchedRules.length * 0.2)
    : 0;

  return {
    detected: matchedRules.length > 0,
    rules: matchedRules,
    confidence
  };
}

/**
 * Quick check whether a Bash command is destructive
 * @param {string} command - Bash command string
 * @returns {boolean}
 */
function isDestructive(command) {
  if (!command || typeof command !== 'string') return false;
  /*
   * ENH-441 (v2.1.36): segment and suppress exactly as detect() does.
   *
   * This used to test each pattern against the whole command, so the two
   * exported entry points answered differently for the same input — `git push
   * origin feature-x && rm -f note.txt` was clean under detect() and destructive
   * here. It has no production callers today, which is precisely why the
   * divergence could sit unnoticed until someone wired it up and inherited the
   * false positives this release removes.
   */
  const shell = splitCommandSegments(stripHeredocBodies(command), 'shell');
  const sql = splitCommandSegments(stripSqlComments(stripHeredocBodies(command)), 'sql');
  return GUARDRAIL_RULES.some((rule) => {
    const segments = rule.segmentOn === 'sql' ? sql : shell;
    return segments.some(
      (s) => rule.pattern.test(s)
        && !(typeof rule.suppressIf === 'function' && rule.suppressIf(s))
    );
  });
}

/**
 * Recovery advice that fits the rule that actually fired.
 *
 * ENH-459 (v2.1.36) — the refusal offered the same three lines for every rule,
 * led by "Scope the command to a specific path instead of a broad or root
 * target". That is followable for a recursive delete. It is meaningless for
 * `curl … | sh` (G-015), for `DROP TABLE users` (G-009), for `dd of=/dev/disk0`
 * (G-014) — there is no path to scope. So most refusals ended with advice the
 * user could not act on, which is the exact failure the v2.1.34 comment on
 * G-001 warned about and issue #148 quoted back:
 *
 *   "A guard that refuses correct commands and gives unfollowable advice is one
 *    people switch off, and then it protects nothing."
 *
 * Scoping advice is now offered only by the two rules where scoping changes the
 * outcome — G-001 and G-013 both grade by target, so narrowing genuinely turns a
 * denial into a confirmation. Everything else gets advice that matches what it
 * refused, and G-014 gets none, because a raw-device write has no safer form
 * worth suggesting.
 *
 * @param {Array<{id: string}>} rules - the matched rules
 * @returns {string[]} advice, most specific first, always non-empty
 */
function alternativesFor(rules) {
  const ids = new Set((rules || []).map((r) => r && r.id).filter(Boolean));
  const out = [];
  const add = (line) => { if (!out.includes(line)) out.push(line); };

  // Rules that grade by target: narrowing the target is a real remedy.
  if (ids.has('G-001') || ids.has('G-013')) {
    add('Narrow the target to a specific path — a scoped target is confirmed rather than refused');
  }
  if (ids.has('G-008')) {
    add('Name the directory you mean instead of operating on the filesystem root');
  }
  if (ids.has('G-002') || ids.has('G-003') || ids.has('G-004')) {
    add('Target a topic branch, or drop the force flag and reconcile the histories instead');
  }
  if (ids.has('G-005') || ids.has('G-006')) {
    add('Read the value from the environment or a secret store rather than the file itself');
  }
  if (ids.has('G-009') || ids.has('G-010')) {
    add('Run this against a disposable copy of the schema, and keep a dump you can restore from');
  }
  if (ids.has('G-010b')) {
    add('Add a WHERE clause naming the rows you mean to remove');
  }
  if (ids.has('G-011')) {
    add('Drop a single collection or key by name instead of the whole store');
  }
  if (ids.has('G-012') || ids.has('G-015')) {
    add('Download the script to a file, read it, then run the local copy — do not pipe it straight into a shell');
  }
  if (ids.has('G-007')) {
    add('Delete the files you mean by name, or list them first and confirm the set');
  }
  /*
   * registry-lockdown (2026-09-07): the brokered registry's sanctioned paths.
   * A denied state write is not something to rephrase — it is something to
   * route through the writer that owns the state. Without these entries the
   * deny message's only advice was "ask the user", which is how the guard
   * taught users to bypass it.
   */
  if (ids.has('G-019') || ids.has('G-020')) {
    add('Phases advance ONLY by firing the skill: /pdca <phase> <feature> (Skill tool or slash command)');
    add('To archive a completed feature: node scripts/pdca-archive.js <feature> (dry-run first, --apply to mutate)');
    add('To READ state, use the bkit_pdca_status MCP tool — do not write or open the registry file');
  }
  // G-014 (raw device / mkfs) is deliberately absent: there is no scoped form of
  // overwriting a volume, and inventing one would be the unfollowable advice
  // this function exists to remove.

  add('Ask the user for explicit confirmation if this is intended');
  return out;
}

/**
 * Generate a human-readable block message for matched rules
 * @param {Array<{id: string, name: string, severity: string, pattern: string}>} rules - Matched rules
 * @returns {string}
 */
function getBlockMessage(rules) {
  if (!rules || rules.length === 0) {
    return 'No destructive operations detected.';
  }

  const lines = [
    '⛔ Destructive operation blocked by bkit guardrails:',
    ''
  ];

  for (const rule of rules) {
    const severityTag = rule.severity === 'critical' ? '[CRITICAL]'
      : rule.severity === 'high' ? '[HIGH]'
        : '[MEDIUM]';
    lines.push(`  ${severityTag} ${rule.id}: ${rule.name}`);
  }

  lines.push('');
  /*
   * ENH-448 (v2.1.36) — this used to read "To proceed, adjust guardrail settings
   * in bkit.config.json or use manual override."
   *
   * Neither route existed. This module never reads bkit.config.json (that string
   * appeared exactly once in the file — inside the message), and `disableRule()`
   * sets a flag `detect()` does not consult, by design (see its own docs). So the
   * message named two recoveries, both imaginary, to a user who had just been
   * refused. Issue #148 called this out, and it is the same class of defect as
   * the rules themselves: a guard giving advice nobody can act on.
   *
   * It shares alternativesFor() with the hook rather than keeping its own copy.
   * The first attempt at this fix rewrote the wording HERE alone and reported the
   * user-facing message as corrected — but this function has no production
   * callers, so nothing changed for anyone. The text users actually see is built
   * in scripts/unified-bash-pre.js. One helper, both call sites, no way for the
   * two to disagree again.
   */
  lines.push('Ways forward:');
  for (const alt of alternativesFor(rules)) lines.push(`  - ${alt}`);
  lines.push('  - Split a chained command: each segment is judged on its own.');
  lines.push('');
  lines.push('These rules cannot be switched off at runtime — that is deliberate, not an oversight.');

  return lines.join('\n');
}

/**
 * Get the default action for a specific rule
 * @param {string} ruleId - Rule ID (e.g., 'G-001')
 * @returns {'deny'|'ask'|'allow'|null}
 */
function getRuleAction(ruleId) {
  const rule = GUARDRAIL_RULES.find(r => r.id === ruleId);
  return rule ? rule.defaultAction : null;
}

/**
 * Get all guardrail rules
 * @returns {GuardrailRule[]}
 */
function getRules() {
  return GUARDRAIL_RULES.map(r => ({
    id: r.id,
    name: r.name,
    severity: r.severity,
    defaultAction: r.defaultAction,
    pattern: r.pattern.source
  }));
}

/**
 * Add a custom guardrail rule at runtime
 * @param {{ id: string, name: string, severity: string, pattern: RegExp, defaultAction: string }} rule
 */
function addCustomRule(rule) {
  if (!rule || !rule.id || !rule.pattern) return;
  const existing = GUARDRAIL_RULES.find(r => r.id === rule.id);
  if (!existing) {
    GUARDRAIL_RULES.push(rule);
  }
}

/**
 * Mark a guardrail rule disabled — WITHOUT removing it from detection.
 *
 * ENH-449 (v2.1.36) — read the name and you expect the rule to stop firing. It
 * does not, and that is intentional: `detect()` never consults `_disabled`, so a
 * rule cannot be switched off from inside a running session. The property is
 * locked by test/security/integrity-verification.test.js IV-09, whose assertion
 * says so explicitly.
 *
 * The flag is therefore an annotation — it records that someone asked — and this
 * function is retained for that and for API compatibility. It has no production
 * callers. Do not "fix" the flag to be honoured without deliberately overturning
 * IV-09; the immutability is the security property, and the false-positive
 * pressure that motivates an off-switch is answered by rule precision instead
 * (see splitCommandSegments and the grading helpers above).
 *
 * @param {string} ruleId - Rule ID to annotate
 * @param {string} [reason] - Reason recorded alongside the annotation
 * @returns {boolean} True if the rule exists (NOT that detection changed)
 */
function disableRule(ruleId, reason) {
  const rule = GUARDRAIL_RULES.find(r => r.id === ruleId);
  if (rule) {
    rule._disabled = true;
    rule._disableReason = reason || 'unknown';
    return true;
  }
  return false;
}

module.exports = {
  detect,
  isDestructive,
  getBlockMessage,
  // ENH-459 (v2.1.36): shared with scripts/unified-bash-pre.js so the advice a
  // user is given matches the rule that refused them, and so the hook and this
  // module cannot drift into offering different remedies for the same block.
  alternativesFor,
  getRuleAction,
  getRules,
  addCustomRule,
  disableRule,
  stripHeredocBodies,
  // ENH-440/446 (v2.1.36): exported so their behaviour can be asserted directly
  // rather than only inferred from detect() outcomes. The `--command` regression
  // below was a helper-level defect that a detect()-only test would have found
  // only by luck.
  splitCommandSegments,
  stripSqlComments,
  // ENH-470 (v2.1.37): same reason as the two above — a predicate that decides
  // whether a rule stands down is worth asserting directly, not only through the
  // outcome of detect().
  isNotACommandLevelDelete,
  isInertSearchInvocation,
  GUARDRAIL_RULES
};
