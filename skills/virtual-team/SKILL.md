---
name: virtual-team
classification: workflow
classification-reason: team-of-agents operating model (PM + PL + QA + designer + developer) independent of model capability evolution
deprecation-risk: none
effort: high
description: |
  Hire a team and work: run a product build as a simulated company team from one session. PM = main session (design, decisions, host runs); PL and QA = named Claude teammates (mutation-proven review, runtime receipts); designer and developer = codex exec workers; file board, planning minutes, per-slice gates, sprint reports. Multi-host: Claude Code today, Codex host via bkit-codex. One-shot, systematic work; continuous operation and monitoring belong to bkit Studio.
  Triggers: virtual team, team, hire a team, run it as a team, PM, PL, QA, sprint with roles, 팀으로 진행, 팀 시뮬레이션, 에이전트 팀
argument-hint: "[init <app> <pl> <qa> <designer> <fe> | sprint <n> | resume]"
user-invocable: true
agents:
---

# virtual-team

**You are the PM and the only mind with thinking on. Design, contracts, decisions and dispatch stay in this session. Workers execute; a reviewer is never the author of what it reviews; a green gate is not evidence until the real binary, host, or browser has run.**

## 1. Roles (fixed shape, names are the user's choice)

| Role | Runtime | Why this runtime |
|---|---|---|
| PM | main session | thinking on; owns scope, minutes, decisions, board, STATE, host runs, captures |
| PL (review, integration) | named Claude subagent via Agent `name:` (teammate, long-lived) | needs SendMessage back-and-forth; runs mutations with per-file backups |
| QA (runtime harness) | named Claude subagent (teammate) | read-only on evidence while PL mutates; writes qa plans and reports |
| Designer (contracts, visual review) | `codex exec` one-shot runs | writes design authorities and receipt contracts; reviews rasters |
| FE / daemon dev (build) | `codex exec` one-shot runs | writes code and its own daily report; sandbox cannot bind ports, run binaries or npm install |
| Capture agent | Claude subagent `model: sonnet`, named | browser work is 3+ calls; returns compact receipts JSON |

Teammate protocol (put in every PL/QA dispatch): ack in one line -> work -> send the verdict with SendMessage -> idle. Absolute paths, never `cd`, in every prompt.

## 2. Files (the board is the resume authority)

```
<repo>/<app>/team/
  STATE.md                 resume authority; read first after compaction
  SPRINT-<n>-brief.md      PM proposal + questions Q1..Qk
  SPRINT-1-tasks.md        board: one row per item, status todo/doing/blocked/review/done, evidence column
  roles/<role>.md          role cards (assets/roles-*.md)
  meetings/planning-<n>.md positions -> PM minutes LOCKED -> decisions D<n>-k; post-lock gaps appended as D<n>-k+
  meetings/retro-<n>.md    rules R<n>-k adopted; carried debt
  reports/daily-<worker>-<n>.md  review-<pl>-<n>.md (+Addendum k)  qa-plan-/qa-report-<n>-s<m>.md  design-review-<n>.md
  design/<authority>.md    design authorities and receipt contracts (data-* names, thresholds, widths, locales)
<repo>/intent/verbatim.md  owner-only bible: cards of the owner's own words; the assistant never writes here
```

`scripts/init-team.sh <repo> <app> <pl> <qa> <designer> <fe>` scaffolds this from `assets/`.

## 3. Sprint loop (gates are visible files, not feelings)

```
1 brief        PM writes SPRINT-<n>-brief.md from the owner's verbatim card
2 positions    every role writes planning-<n>-<role>.md in parallel (PL/QA via SendMessage, designer/FE via codex)
3 minutes      PM writes planning-<n>.md, LOCKED, decisions D<n>-k; PL gap review -> D<n>-k+ appended
4 slices       owner's 1.5x rule: cut 1.5x more slices than first instinct; generation vs assembly never in one slice
5 per slice    build (codex) -> PM host gates -> PL review with mutations -> PM/capture agent captures
               -> designer review -> QA runtime -> fix rounds (budget 2; a 3rd needs a root-cause line for the retro)
               -> close: board row done, STATE, sync docs
6 close        retro-<n>.md (rules), team-daily-<n>.md, sprint-<n>-report.md, deferred owner decisions listed
```

Gate for step 5 "done": PL PASS + designer SIGN-OFF yes + QA PASS on the same evidence chain, each written to a file. Missing any one -> not done.

## 4. Standing rules (adopted from real failures; do not relax)

- **Reviewer != author.** PL reviews with mutations: per-file backup, mutate, run the test that must fail, restore, `diff -q`, full suite after; inner deadline shorter than the outer on anything that can hang.
- **Mutual exclusivity gates need a computed cascade or a named runtime check** (not two booleans).
- **Runtime measurement closes responsive and connection gates**; rasters approve intent only.
- **No mutation testing and runtime walks on the same tree at once.** Studio-file mutations wait for "captures done".
- **A gate that cannot observe its own defense is not a gate**: every done-item names the test that fails without it; host-only tests (sockets, binaries) are run by the PM on the host before every review.
- **The runner never does the daemon's job.** Evidence must be produced by the real code path (no hand-written events, no copied files as "replica").
- **Owner words outrank everything.** Bible cards are verbatim; the assistant proposes in chat and never edits the bible. Owner-only actions (repos, accounts, deploys, second physical machine, cloud) are deferred to a list.
- **Overnight autonomy**: decide gaps yourself, record them, never stop to ask; report all deferred decisions at close.
- Browser: one route per capture invocation, trusted events, in-app navigation for state; never resize the user's window; never send proof screenshots the user can open themselves.

Details and the dispatch texts: `references/dispatch-templates.md`. Review and QA discipline in full: `references/review-and-gates.md`.

## 5. Resume after compaction

```
1 Read <app>/team/STATE.md, then the board
2 Re-spawn PL and QA as named teammates (they do not survive), send a one-line context pointer
3 Check codex logs <app>/team/.<worker>-*.log for runs that finished while you were away
4 Continue at the first non-done board row
```

## 6. Do not

- Do not let a subagent lead (thinking off, cannot spawn).
- Do not accept "tests green" from a sandboxed run as proof for anything the sandbox skipped.
- Do not fold two roles into one run to save a dispatch; the second lens is the value.
- Do not write bible content, commit, push, deploy, or create external accounts.
