// ESLint v9+ flat configuration.
//
// Migrated from the legacy `.eslintrc.json` format. This config is
// self-contained: it imports NO external packages. Rationale and the one
// deliberate behavior change are documented inline below.
//
// Why import-free:
//   This repo is a Claude Code plugin with zero runtime dependencies (no
//   package.json — see .github/workflows/contract-check.yml: "bkit runtime
//   deps = 0"). ESLint is installed globally. ESLint v9 flat configs are
//   loaded as ESM, and Node's ESM resolver does not search the global
//   node_modules, so a flat config that imports @eslint/js, globals, or any
//   plugin fails with ERR_MODULE_NOT_FOUND. Keeping the config import-free is
//   the only way it works under this project's tooling model. Consequences:
//     - The `eslint:recommended` ruleset is applied by inlining the subset of
//       recommended rules the original config relied on (see below).
//     - Node globals are inlined as a literal object.
//
// DELIBERATE BEHAVIOR CHANGE — lib/domain + lib/cc-regression purity rule:
//   The legacy config used `no-restricted-modules` to forbid fs/child_process/
//   net/http/https in the domain layer. That rule was REMOVED in ESLint v9.
//   Its successor `no-restricted-imports` only inspects ESM `import`
//   statements — it does NOT inspect CommonJS `require()`. This entire repo is
//   CommonJS (require/module.exports only), so `no-restricted-imports` would
//   catch nothing here (verified: require('fs') in lib/domain is not flagged).
//   Enforcing the boundary against require() would require eslint-plugin-n's
//   `n/no-restricted-require` rule, which cannot be loaded under the
//   import-free / global-tooling constraint above.
//   The purity boundary is therefore NOT re-encoded here. It is enforced at
//   runtime by scripts/check-domain-purity.js, which runs in the
//   contract-check CI workflow — that is the authoritative gate. The legacy
//   ESLint rule was always secondary defense; removing it loses no real
//   enforcement, only a redundant (and, post-migration, no-op) check.

// Node.js globals — inline equivalent of the `globals` package's node set.
// ESLint v9 languageOptions.globals accepts a plain object, so a literal works.
const nodeGlobals = {
  __dirname: "readonly",
  __filename: "readonly",
  Buffer: "readonly",
  clearImmediate: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  exports: "writable",
  global: "readonly",
  module: "readonly",
  process: "readonly",
  queueMicrotask: "readonly",
  require: "readonly",
  setImmediate: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  atob: "readonly",
  btoa: "readonly",
  fetch: "readonly",
  MessageChannel: "readonly",
  MessageEvent: "readonly",
  MessagePort: "readonly",
  structuredClone: "readonly",
};

export default [
  {
    // Ignore generated / local state directories.
    ignores: [
      "node_modules/**",
      ".venv/**",
      ".bkit/**",
      ".remember/**",
      "work/**",
      "docs/**",
    ],
  },

  // Base config applied to every linted file (was: root of .eslintrc.json).
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: nodeGlobals,
    },
    rules: {
      // Inline `eslint:recommended` subset (the rules the original config
      // relied on at their default severities).
      "no-cond-assign": "error",
      "no-constant-condition": "error",
      "no-control-regex": "error",
      "no-debugger": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-empty-character-class": "error",
      "no-ex-assign": "error",
      "no-extra-boolean-cast": "error",
      "no-fallthrough": "error",
      "no-func-assign": "error",
      "no-inner-declarations": "error",
      "no-invalid-regexp": "error",
      "no-irregular-whitespace": "error",
      "no-misleading-character-class": "error",
      "no-mixed-spaces-and-tabs": "error",
      "no-redeclare": "error",
      "no-regex-spaces": "error",
      "no-sparse-arrays": "error",
      "no-undef": "error",
      "no-unexpected-multiline": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      "no-unsafe-negation": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "use-isnan": "error",
      "valid-typeof": "error",

      // Project-specific rule (from original .eslintrc.json).
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },

  // Override (was: overrides[0]) — infra / scripts / hooks / servers may use
  // otherwise-restricted imports. Kept for forward-compat: if ESM is ever
  // adopted, this frees those subtrees from any future import restrictions.
  {
    files: ["lib/infra/**", "scripts/**", "hooks/**", "servers/**"],
    rules: {
      "no-restricted-imports": "off",
    },
  },

  // Override (was: overrides[1]) — UI / dashboard code may use console freely.
  {
    files: ["lib/ui/**", "lib/dashboard/**"],
    rules: {
      "no-console": "off",
    },
  },

  // Override — the flat config itself (br292). It is ESM (`export default`)
  // but the base block above lints every **/*.js with sourceType "script",
  // so eslint fails to parse its own config. Scope module semantics to this
  // one file.
  {
    files: ["eslint.config.js"],
    languageOptions: { sourceType: "module" },
  },

  // Override — jest test files (br289). package.json jest `testMatch` covers
  // test-scripts/{unit,integration,regression}/** (br016, a8ba937), but the
  // flat config never declared the jest globals those files run with, so
  // every describe/it/expect reference was a no-undef (210 errors). Inlined
  // literal (not the `globals` package jest set) per the import-free
  // constraint documented at the top of this file.
  {
    files: ["test-scripts/**/*.test.js"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        jest: "readonly",
      },
    },
  },

  // NOTE: overrides[2] from the legacy config (lib/domain + lib/cc-regression
  // purity rule) is intentionally NOT reproduced — see the DELIBERATE BEHAVIOR
  // CHANGE note at the top of this file. That boundary is enforced by CI
  // (scripts/check-domain-purity.js in contract-check.yml), not by ESLint.
];
