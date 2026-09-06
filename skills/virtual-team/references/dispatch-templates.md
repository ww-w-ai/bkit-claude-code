# Dispatch templates (copy, fill, send)

## Codex worker run (designer or FE)

```bash
printf '%s' "You are <Name>, <role> on the <team> team. Working dir <abs repo> (absolute paths only; never cd; no git; no npm install; write only <allowed paths> and <report path>). <TASK>. Read first: <authorities>. Gates to run and paste: <commands>. Report in <report path>: done-list table (item / evidence / receipt / the test that fails without it), stubs, exact host commands. Never cd." | codex exec -C <abs repo> -s workspace-write --skip-git-repo-check - > <app>/team/.<worker>-<slice>.log 2>&1
```

- Run in the background; read the log tail when the task notification arrives.
- Images for the designer: `-i` list must be a zsh ARRAY; keep captures in `<app>/team/design/<slice>/`.
- The sandbox cannot bind ports, run the product binaries, or install packages: the PM runs builds, verifiers, spikes and live runners on the host and files the evidence paths back.
- Two codex runs must never write the same report file; give the second a new file.

## Named teammate spawn (PL or QA)

Agent tool, `name: <pl-name>`, `run_in_background: true`, prompt = the role card + this:

```
Protocol: ack in one line, do the work, send the verdict with SendMessage to team-lead, then idle.
Absolute paths only, never cd. Write only <allowed paths>. Bash: one line, no heredoc.
```

## PL review dispatch

```
Review <slice> per your s<k>-review-plan. Build: <daily report path>. Host gates now: <counts>.
Live evidence: <out dir> (what it proves, in one line per fact).
Failed runs are evidence too: <paths> — say which new test now catches each defect.
Mutations: <list: what to remove/flip -> which test must fail>. Mutate each guard independently
(defense-in-depth hides single-guard removal). Per-file backups, diff -q, full suite after, inner deadlines.
ORDER: non-UI-tree mutations first; UI-tree mutations only after I send "captures done".
Nobody else edits <trees> until your verdict. Write review-<pl>-<n>.md, verdict PASS or NEEDS FIX with exact corrections.
```

## QA runtime dispatch (read-only while PL mutates)

```
Runtime pass per your qa-plan-<n>-s<m>. Read-only: no edits under <trees>, no reruns; if a check needs a rerun,
give me the exact command and I run it on the host. Evidence: <paths>. For each item: five receipts, PASS/FAIL,
recomputed from the raw files (not from summary.json). Deferred items: name the command and when.
```

## Capture agent dispatch (sonnet, named)

```
Capture <routes> at <widths> x <locales> into <design dir>/<round>/ with receipts.json. Verify the backend state
with curl first (retry up to 20 s). One route per aside invocation, fresh tab per capture, locale via localStorage,
widths < 1440 through /emu.html?w=<px>&u=<encoded> reading the iframe document, wait 4000 ms, trusted clicks
for panels. Collect: <data-* list>, visible label text, scrollWidth vs innerWidth. Never cd, no window resizing,
Bash one line (write helper scripts with Write). Compact report: matrix coverage, receipt values vs contract, mismatches.
```

## Designer review dispatch

```
Review <slice> against your <contract>.md. Evidence: <captures dir> + receipts.json; facts from the capture: <list>.
Open the PNGs. Judge first-screen hierarchy per width (R5-5), state exclusivity, anatomy, locale line breaks,
visual continuity vs <baselines>. Rows without evidence: PENDING, do not guess. Score, SIGN-OFF yes/no/conditional,
exact corrections (file/element/copy). Terse, English, no emoji.
```

## Fix round dispatch

```
<slice> FIX ROUND <k> (budget: 2; this is round 3 -> add one root-cause sentence for the retro). Read <review paths>
first. Items: (1)... each with the test that must fail without it. Do not run <live runner>. Gates: <commands>, paste counts.
Append '## Fix round <k>' to <daily report> with file:line per item.
```
