# QA 보고서 — fix-preflight-hookdrop-mislead

**날짜:** 2026-09-19
**브랜치:** fix/misc_fixes_972026 (대상 커밋 b0f0533)
**판정:** QA_PASS

## 검증 범위

- lib/infra/cc-version-checker.js — KNOWN_ISSUES `fork-default-agent-spawn` 비인과(non-causality) 문구
- lib/core/hook-reachability.js — 신규 export `buildReachabilityWarning(missing, stale, reachFile)`
- hooks/session-start.js — 빌더 위임 호출부; 가드/감사 로직은 미변경
- test/unit/preflight-hookdrop-disambiguation.test.js (4 TC, run-all.js:171 등록)
- CHANGELOG.md `[Unreleased]` 항목
- 설치 캐시 동기화 (파일 3개, 플러그인 캐시 2.1.38)

## L1 — 단위 테스트 (핵심)

```
$ node --test test/unit/preflight-hookdrop-disambiguation.test.js \
    test/unit/cc-version-checker.test.js test/unit/preflight.test.js \
    test/unit/hook-reachability.test.js
--- Results: 4/4 passed, 0 failed ---
ℹ tests 36
ℹ pass 36
ℹ fail 0
```

네 스위트 전체(disambiguation 4, cc-version-checker 8, preflight,
hook-reachability) 36/36 통과.

## L1 — 인접 스위트 회귀 스윕

존재 확인 결과: `test/unit/hook-dispatch.test.js` 없음 — 기록 후 스킵.
`test/unit/skill-name.test.js` 존재.

```
$ node --test test/unit/skill-name.test.js
--- Results: 11/11 passed, 0 failed ---
```

11/11 통과. 전체 배터리(T-05, 1984 TC)는 구현 직후 메인 세션에서
통과했으며, 본 스윕은 인접 부분집합을 재검증한 것이다.

## 뮤테이션 검증 (true-test 원칙, T-06 역방향)

lib/infra/cc-version-checker.js의 summary 비인과 접미사만 제거
(변이 전 `git diff`를 /tmp/mut.patch에 캡처 — 비어 있어 깨끗한
베이스라인 확인):

```
- + '(subagent-spawn semantics ONLY — this is NOT a hook failure; hooks and /pdca skill fires are unaffected)',
+ + '(subagent semantics may change)',
```

변이체 실행 — RED, 해당 문구를 검사하는 두 테스트만 실패:

```
FAIL T-01: fork-default-agent-spawn summary/detail carry non-causality clauses
  The input did not match the regular expression /NOT a hook failure/i.
FAIL T-02: renderCCVersionWarning known-issues branch renders the clause
  The input did not match the regular expression /NOT a hook failure/i.
--- Results: 2/4 passed, 2 failed ---
```

(T-03/T-04 — reachability 측 TC — 는 변이 범위 밖이므로 정상적으로
통과 상태 유지.)

복원 후 재실행 — GREEN:

```
$ git checkout -- lib/infra/cc-version-checker.js
$ node --test test/unit/preflight-hookdrop-disambiguation.test.js
--- Results: 4/4 passed, 0 failed ---
```

수정이 깨지면 테스트가 실패한다 — true test임이 입증됨.

## 캐시 동기화 검증

```
$ diff -q lib/infra/cc-version-checker.js ~/.claude/plugins/cache/bkit-marketplace/bkit/2.1.38/lib/infra/cc-version-checker.js
IDENTICAL
$ diff -q lib/core/hook-reachability.js .../lib/core/hook-reachability.js
IDENTICAL
$ diff -q hooks/session-start.js .../hooks/session-start.js
IDENTICAL
```

3/3 동일 — 작업 트리와 설치된 플러그인 캐시 일치.

## 라이브 프로브 (T-06)

참고: `renderCCVersionWarning`는 cc-version-checker가 아니라
`hooks/startup/preflight.js`에서 export됨 — 프로브 임포트를 그에
맞게 수정했음.

```
renderCCVersionWarning(checkCCVersion()):
CC v2.1.278: fork mode is on by default and the Agent tool loses its
`run_in_background` parameter (subagent-spawn semantics ONLY — this is NOT
a hook failure; hooks and /pdca skill fires are unaffected). bkit
recommends v2.1.220; run `/bkit` or see docs/06-guide/cc-compatibility.guide.md ...

buildReachabilityWarning(['skill_post'], [], <reachFile>):
⚠️ bkit hook reachability check: missing=[skill_post] stale=[]. CC
plugin-hook drop (#57317) suspected — evidence: /project/.bkit/runtime/
hook-reachability.json (a real drop takes the bash_post/write_post canaries
down too; FRESH canary stamps mean hooks ARE firing — if a PDCA registry is
stalled while canaries are fresh, suspect skipped /pdca <phase> skill fires,
not a hook drop). ...
```

어서션: 렌더된 줄에 "NOT a hook failure" 포함 — 참; "fork mode" 포함 — 참;
reachability 줄에 "skill" 언급 — 참; 증거 경로 포함 — 참. 프로브 exit 0.

## CHANGELOG 검증

`## [Unreleased]`가 8행에, 첫 릴리스 헤딩(`## [2.1.39]`, 21행) 위에
위치하며 `### Fixed — fix-preflight-hookdrop-mislead`와 session-start
preflight disambiguation 항목을 포함함.

## L2-L5

L2 (API), L3 (E2E), L4 (UX Flow), L5 (Data Flow): **해당 없음 — 서버/UI
없음 (Node CLI 플러그인 저장소)**. 이는 폴백이 아닌 범위 판정이다.

## 요약

| 검사 | 결과 |
|------|------|
| L1 핵심 (4 스위트) | 36/36 통과 |
| L1 회귀 스윕 | 11/11 통과 (hook-dispatch.test.js 부재 — 스킵) |
| 뮤테이션 RED/GREEN | 변이체에서 T-01/T-02 RED; 복원 후 4/4 GREEN |
| 캐시 동기화 | 3/3 동일 |
| 라이브 프로브 T-06 | 모든 어서션 성립 |
| CHANGELOG | 존재 및 위치 올바름 |

**QA_PASS** — L1 통과, 뮤테이션 검증 입증, 캐시 동일, 프로브 어서션 성립.
