# Review and gate discipline (what "done" means)

## Evidence tiers

```
1 static gates      typecheck, unit tests, architecture import gates, verifier scripts   -> necessary, never sufficient
2 host gates        the same suites on the host, incl. tests the sandbox skipped (sockets, binaries, EPERM)
3 live run          the real binary / real process driven by a runner that only calls the product's own code paths
4 browser receipts  DOM data-* values + geometry collected per route/width/locale on the served live state
5 rasters           designer judges intent; rasters never close a measured gate
```

A slice closes only when tiers 2-5 exist as files and three independent verdicts (PL, designer, QA) are PASS on the same evidence chain.

## Mutation protocol (PL)

```
for each guard G named in the done-list:
  cp <file> <backup>            # per file
  mutate G only                 # value swap / result discard / comparison flip — never delete lines that orphan imports
  build (with vet) before judging; a build failure is a mutation failure, not a caught bug
  run the test that must fail   # with -count=1 / no cache, --test-timeout, inner deadline < outer
  restore: cp <backup> <file>; diff -q <backup> <file>
full suite after the last restore; tree clean (git status or find backups)
```

- Mutate each guard independently. Defense-in-depth hides a single removal; two layers removed together only proves the pair.
- A prompt-rejected "no failures" is not a pass: first prove the runner can report a failure with a probe mutation.
- UI-tree mutations wait for "captures done" (hot reload corrupts captures).

## Runtime protocol (QA)

- Recompute from raw files (JSONL logs, receipts.json), never from a summary.
- Five receipts per done-item: what was asserted, where (path:line or file), the raw value, the bound, PASS/FAIL.
- Mark PENDING with the exact missing evidence; never infer a pass from source alone.
- Deferred items carry the command and the moment to run it.

## Host-run protocol (PM)

- Runners must: wait on monotonic counters or events, never on transient state; write summary.json with step and failureReason on every exit; keep timing waits that are part of the receipt.
- Before every review: run the full suites on the host (sandbox skips are silent).
- While a live runner is up: `lsof -iTCP -sTCP:LISTEN -P -n` for the no-inbound-port claim.
- Cost: real model turns cost money; recordings become fixtures; rerun live only on contract change or a failed round.

## Fix-round budget

Two rounds per slice. A third round is allowed only with a one-line root cause written for the retro. Observed root causes so far: a gate that could not observe its own defense; a runner doing the daemon's job; sandbox-skipped tests; transient state that no poll can see (add monotonic counters).

## Owner decisions

Keep one list of deferred owner decisions in the sprint report; never resolve them silently. Typical: hosting location, second physical machine, acceptance-language bar, native review of locales, TLS before remote use.
