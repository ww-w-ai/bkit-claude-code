# Sprint board (PM-owned; one row per work item, status updated as it moves)

Status: todo / doing / blocked / review / done. Evidence = file paths and verdicts, never prose.

| # | Stage | Item | Owner | Depends | Status | Evidence |
|---|---|---|---|---|---|---|
| S1-1 | Plan | PM brief | PM | - | todo | team/SPRINT-1-brief.md |
| S1-2 | Review | Planning meeting: positions -> minutes -> lock | PM + team | S1-1 | todo | meetings/planning-1.md |
| S1-3 | Do | Slices per minutes | <FE_NAME> | S1-2 | todo | reports/daily-<fe>-N.md |
| S1-4 | Check | PL review, designer sign-off, QA runtime per slice | <PL_NAME>, <DESIGNER_NAME>, <QA_NAME> | S1-3 | todo | reports/review-*, design-review-*, qa-report-* |
| S1-5 | Report | Retro, team daily, sprint report | PM | S1-4 | todo | meetings/retro-1.md, reports/sprint-1-report.md |
