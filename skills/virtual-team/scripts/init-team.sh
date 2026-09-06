#!/bin/zsh
# init-team.sh <repo-abs> <app-subdir> <PL> <QA> <DESIGNER> <FE>
# Scaffolds <repo>/<app>/team from the skill assets and <repo>/intent/verbatim.md (owner-only bible).
set -e
REPO=$1; APP=$2; PL=$3; QA=$4; DES=$5; FE=$6
if [ -z "$FE" ]; then echo "usage: init-team.sh <repo-abs> <app-subdir> <PL> <QA> <DESIGNER> <FE>"; exit 2; fi
A=$(dirname "$0")/../assets
T="$REPO/$APP/team"
mkdir -p "$T/roles" "$T/meetings" "$T/reports" "$T/design" "$REPO/intent"
sub() { sed -e "s/<PL_NAME>/$PL/g" -e "s/<QA_NAME>/$QA/g" -e "s/<DESIGNER_NAME>/$DES/g" -e "s/<FE_NAME>/$FE/g" -e "s#<repo>#$REPO#g" -e "s/<fe>/$FE/g" "$1"; }
[ -f "$T/STATE.md" ] || sub "$A/STATE.md" > "$T/STATE.md"
[ -f "$T/SPRINT-1-tasks.md" ] || sub "$A/board.md" > "$T/SPRINT-1-tasks.md"
[ -f "$T/SPRINT-1-brief.md" ] || sub "$A/brief.md" > "$T/SPRINT-1-brief.md"
[ -f "$T/roles/pl.md" ] || sub "$A/roles-pl.md" > "$T/roles/pl.md"
[ -f "$T/roles/qa.md" ] || sub "$A/roles-qa.md" > "$T/roles/qa.md"
[ -f "$T/roles/designer.md" ] || sub "$A/roles-designer.md" > "$T/roles/designer.md"
[ -f "$T/roles/fe.md" ] || sub "$A/roles-fe.md" > "$T/roles/fe.md"
[ -f "$REPO/intent/verbatim.md" ] || printf '%s\n' "# Owner intent — verbatim cards (owner writes; the assistant never edits this file)" "" > "$REPO/intent/verbatim.md"
echo "team scaffolded at $T (bible: $REPO/intent/verbatim.md)"
