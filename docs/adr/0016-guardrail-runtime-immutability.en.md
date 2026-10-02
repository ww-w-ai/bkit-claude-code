# ADR 0016 — Guardrail rules are immutable at runtime

- **Status**: Accepted
- **Date**: 2026-08-12
- **Context**: bkit v2.1.36, GitHub issue [#148](https://github.com/popup-studio-ai/bkit-claude-code/issues/148)
- **Supersedes**: nothing
- **Related**: ADR 0006 (CC Upgrade Policy), `lib/control/destructive-detector.js`, `test/security/integrity-verification.test.js` (IV-09)

## Context

The Destructive Detector refuses commands that match one of 21 known-pattern
rules. When it refuses, it must tell the user what to do next.

Until v2.1.36 the refusal message said:

> To proceed, adjust guardrail settings in bkit.config.json or use manual override.

Neither route existed:

1. `lib/control/destructive-detector.js` never reads `bkit.config.json`. The
   string appeared exactly once in the module — inside that message.
2. `disableRule()` sets `rule._disabled = true`, but `detect()` never consults
   the flag. Measured: the matched-rule list is identical before and after
   `disableRule('G-001')`.

Issue #148 reported this alongside the false positives, and asked the reasonable
question: wire the config, or stop pointing at it?

Investigating turned up something that changes the answer.
`test/security/integrity-verification.test.js` IV-09 asserts the inertness
**on purpose**, in a test named *"disableRule does not remove rule from
detection"*, with the assertion message *"Disabled rule should still detect
(detect does not check _disabled flag)"*. The behaviour is a locked security
property, not an unfinished feature.

## Decision

**Guardrail rules cannot be disabled at runtime, and the refusal message now
says so.**

Concretely:

- `detect()` continues to ignore `_disabled`. IV-09 stands unmodified.
- `disableRule()` / `addCustomRule()` are retained for API compatibility and
  documented as annotations, not switches. They have no production callers.
- `guardrails.destructiveDetection` in `bkit.config.json` is documented as
  declarative. It is **not** wired to an off-switch.
- The refusal message lists only recourse that actually works, per rule: narrow the
  target, split the chained command, or state the intent explicitly and have the
  user confirm.

## Rationale

A guard that a session can switch off protects nothing against the failure mode
it exists for. The detector runs inside the same agent loop whose commands it
inspects; an in-session disable path is a request the agent could issue itself.

The pressure for an off-switch came from false positives, and that pressure is
better answered by precision than by an escape hatch. In this same release, a
16-rule audit measured 12 false positives; matching rules per command segment
rather than against the whole input reduced that to 1 — and that 1 is an
intended grading change, not a refusal. The same fix closed three false
negatives, including `chmod 777 / ; ls`, which was previously detected by
nothing at all.

Had an off-switch shipped instead, the honest description of this release would
have been "we gave users a way to turn off a guard that was wrong 12 times",
rather than "we made the guard right".

## Consequences

**Positive**

- The refusal message is actionable. Every route it names exists.
- The security property is written down, so a future change cannot overturn it
  by accident while making a test green.
- `bkit.config.json` no longer implies control it does not have.

**Negative**

- A user facing a residual false positive has no configuration escape. Their
  recourse is to rephrase, or to report it — as @Sinclair-Seo did, which is how
  this release happened. Reports are absorbed as permanent regression tests
  (`test/e2e/external-dogfood/`).
- An unattended run that hits a genuine `ask` still stops for an answer.
  Reducing false positives shrinks how often that happens but does not remove
  it. Giving unattended runs a deterministic non-prompting mode is a separate
  design question, deliberately out of scope here.

**Revisit if**

- A measured, reproducible false positive survives the precision work and cannot
  be fixed by narrowing a rule. That would be evidence the denylist approach has
  reached its limit, and would justify reopening the escape-hatch question with
  data.
- The detector is ever run outside the agent loop it polices, which would change
  the trust boundary this decision rests on.
