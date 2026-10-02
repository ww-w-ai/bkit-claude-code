# registry-lockdown 기획 문서 (한국어)

> **요약**: 브로커 소유 PDCA 레지스트리 — 모든 bkit 워크플로에서 스킬 실행 기반
> 단계 진행, MCP 전용 상태 공개, 자동 아카이브, 문서 파일을 절대 차단하지 않는
> 이식 가능한 JS 상태 가드.
>
> 이 문서는 `registry-lockdown.plan.md`(영어 본문)의 한국어 짝이며 내용은 동일하다.

| 항목 | 값 |
|------|-----|
| **프로젝트** | bkit-claude-code |
| **버전** | 2.1.38 |
| **일자** | 2026-09-07 |
| **상태** | Draft |

---

## Executive Summary

| 관점 | 내용 |
|------|------|
| **문제** | 에이전트가 `.bkit/state/pdca-status.json`을 직접 수정(또는 시도)한 뒤 단계를 건너뛰고 스킬 단계를 무시한다. 유일한 봉쇄 장치는 폐기된 플러그인과 함께 제거된 브로커를 가리키는 머신 로컬 Python 가드였다 — 제어가 아니라 교착 상태. 레지스트리가 실제와 다르게 기록될 수 있으며, 이식 가능한 공식 진행/읽기 경로가 없었다. |
| **해결** | bkit 자체적으로 브로커 쓰기 경로를 완성한다: 아카이브를 포함한 모든 라우터 액션의 실행 시점 쓰기(기존 `lib/pdca/lifecycle.js` `archiveFeature` 연결), 상태 읽기의 MCP 서버 공개면 제공, `.txt`/`.md` 면제를 갖춘 JS 가드를 bkit 훅으로 포팅. |
| **기능/UX 효과** | 단계 상태는 스킬 실행으로만 진행한다; 에이전트는 파일 대신 `bkit_pdca_status` MCP 도구로 상태를 조회한다; 아카이브는 손 수정 없이 한 명령이다; 문서 작성이 가드에 걸리지 않는다. |
| **핵심 가치** | PDCA 레지스트리가 구조적으로 신뢰 가능해진다 — 단일 작성기, 검증된 독자, 에이전트 손 수정 없음, 환경 의존 교착 없음. |

---

## Context Anchor

| 키 | 값 |
|-----|-----|
| **WHY** | 손 수정된 단계 상태가 단계 건너뛰기와 미검증 작업을 가능하게 했다; 머신 레벨 가드는 보호 대신 공식 작업을 교착시켰다. |
| **WHO** | 모든 설치 환경에서 PDCA / Sprint / Pipeline 주기를 실행하는 bkit 사용자(에이전트와 운영자). |
| **RISK** | 과도한 가드가 원래 교착(정상 문서 쓰기 차단)을 재현하는 것; 단계 게이트(requireDocs, TaskCompleted 자동 진행)의 조용한 회귀. |
| **SUCCESS** | 전체 PDCA 주기가 손 수정 없이 `archived`에 도달; 가드가 실제 상태 쓰기를 차단하면서 `.txt`/`.md` 생성을 허용; 전체 스위트 통과(0 FAIL). |
| **SCOPE** | 4개 모듈: (1) 진행 일반화, (2) MCP 공개, (3) 자동 아카이브, (4) 가드 포팅 + 면제. |

---

## 1. 개요

### 1.1 목적

`.bkit/state/pdca-status.json`을 실제 브로커 소유 레지스트리로 만든다: 에이전트는
스킬 실행으로만 진행하고, MCP 서버로만 읽고, 직접 수정할 수 없다 — 동시에
문서 작업(`.md`, `.txt`)은 봉쇄 대상이 아니다.

### 1.2 배경

현장 증거(`work/pdca-skill-fire-test-results.md`, 2026-09-07): 실제 스킬 실행 3회가
훅 레이어에서 감지되었지만 아무것도 기록하지 못했다. `runSkillInvocationEffects`가
`pdca` 라우터가 설계상 `null`로 선언하는 정적 프론트매터에 쓰기를 걸었기 때문이다.
`pm|plan|design|do|qa|report` + 별칭(`analyze→check`, `iterate→act`)은 커밋
`ef8e30c` 및 후속 별칭 확장(작업 트리)으로 수정되었다. 운영자는 다른 세션에서의
역방향 실패(에이전트가 레지스트리를 손 수정한 뒤 단계 건너뛰기)도 보고했고, 이에
따라 이 기능은 머신 로컬 가드 대신 bkit 내부에서 이식 가능하게 잠근다.

### 1.3 관련 문서

- 현장 보고서: `work/pdca-skill-fire-test-results.md`
- 영어 본문: `docs/01-plan/features/registry-lockdown.plan.md`
- 참조 가드(Python, 머신 로컬): `~/.claude/hooks/pdca-guard`
- 선행 구현: `lib/control/destructive-detector.js` (G-019), `scripts/gap-detector-stop.js`, `scripts/pdca-task-completed.js`

---

## 2. 범위

### 2.1 포함

- [ ] FR-01 모든 bkit 워크플로 라우터의 실행 시점 레지스트리 쓰기 (pdca 완료; sprint/pipeline 매핑 또는 명시적 경계)
- [ ] FR-02 자동 아카이브: `/pdca archive`가 공식 경로로 `lifecycle.archiveFeature`를 호출 — 손 수정 없음
- [ ] FR-03 sprint(및 해당 시 pipeline) 아카이브 동등성 또는 문서화된 경계
- [ ] FR-04 MCP 공개: `bkit_pdca_status` 도구로 상태 읽기; 스킬 텍스트에 MCP 우선 지시
- [ ] FR-05 가드 포팅: Python pdca-guard의 JS 포팅을 bkit 훅에 연결, `.bkit/state/pdca-status.json` 에이전트 쓰기 거부
- [ ] FR-06 가드 면제: `.txt`/`.md` 대상 절대 차단 없음; G-019의 리다이렉트 오탐(`2>`) 수정
- [ ] FR-07 모든 FR에 대한 진위 테스트(기능이 깨지면 실패)
- [ ] FR-08 CONTRIBUTING.md에 따른 CHANGELOG 항목 (버전 번호는 유지자 소관)

### 2.2 제외

- MCP 서버 쓰기 도구화 (단계 쓰기는 설계상 훅 구동 유지)
- 폐기된 `.bkit-memory.json` 경로 회고적 수정
- 머신 로컬 `~/.claude/hooks` 봉쇄 계층 제거 (운영자 영역)
- 기존 단일 언어 문서 번역 (신규 파일 한정 규칙)

---

## 3. 요구사항

### 3.1 기능 요구사항

| ID | 요구 | 우선순위 | 상태 |
|----|------|----------|------|
| FR-01 | 모든 라우터 스킬의 단계 진행 액션이 실행 시점에 레지스트리를 쓴다; 손 수정 필요 액션 없음 | High | 부분 (pdca 착지) |
| FR-02 | `/pdca archive`가 검증 후 공식 경로로 `archiveFeature`(또는 `--summary`시 `archiveFeatureToSummary`) 호출; archive 단계 7–8은 확인 전용으로 변경 | High | Pending |
| FR-03 | sprint 아카이브가 동일 기준에 도달하거나 근거와 함께 경계 문서화 | Medium | Pending |
| FR-04 | 에이전트는 `bkit_pdca_status` MCP 도구로 상태 읽기; `/pdca status` 단계가 MCP 우선 지시 (MCP 불가시 파일 폴백) | High | Pending (도구 존재, 스킬 텍스트 미갱신) |
| FR-05 | JS 가드 훅(Write/Edit/Bash PreToolUse)이 상태 파일 에이전트 쓰기를 거부하고 스킬 실행 경로를 안내; bkit 내부 작성기는 영향 없음 | High | Pending |
| FR-06 | 가드는 `.txt`/`.md`(및 docs/ 경로) Write/Edit을 절대 거부하지 않고, Bash 규칙 패턴이 `2>`/`&>` 리다이렉트를 쓰기 동사로 취급하지 않는다 | High | Pending |
| FR-07 | FR별 단위+통합 테스트, 변이 검증(깨지면 RED, 고치면 GREEN) | High | Pending |
| FR-08 | CHANGELOG.md 항목이 CONTRIBUTING.md를 따름 (버전 올림 없음) | Medium | Pending |

### 3.2 비기능 요구사항

| 범주 | 기준 | 측정 방법 |
|------|------|-----------|
| 성능 | 신규/변경 훅이 PreToolUse 5초 예산 내 | 통합 테스트의 훅 타이밍 |
| 보안 | 가드는 상태 파일 쓰기에 fail-closed, 그 외 fail-open; `critical`은 권한 모드로 억제되지 않음 | 단위 테스트 + v2.1.37 권한 모드 정책 테스트 |
| 호환성 | `updatePdcaStatus`/`archiveFeature` 공개 API 불변; hooks.json 추가만 | 기존 스위트(5,355 TC) 통과 |
| 이식성 | 가드가 bkit 내부에 탑재(모든 설치에서 동작); 머신 로컬 경로 참조 없음 | 코드 리뷰 + grep |

---

## 4. 성공 기준

### 4.1 완료 정의

- [ ] 모든 기능 요구사항 구현
- [ ] 단위 테스트 작성 및 통과
- [ ] 전체 스위트 통과 (`node test/run-all.js`, 0 FAIL)
- [ ] 문서 갱신 (SKILL.md 단계, MCP 도구 문서, CHANGELOG)

### 4.2 품질 기준

- [ ] 시뮬레이션 전체 주기(fire plan → … → fire archive)가 손 수정 없이 레지스트리 진행, 테스트로 검증
- [ ] 같은 스위트에서 `.md` 문서 쓰기는 허용되고 상태 파일 쓰기는 거부됨을 증명
- [ ] 린트 오류 0; 새 억제 없음

---

## 5. 리스크 및 완화

| 리스크 | 영향 | 가능성 | 완화 |
|--------|------|--------|------|
| 가드 과잉으로 문서 차단 교착 재현 | High | Medium | 면제 목록(`txt`, `md`, docs/ 경로)을 상태 토큰 매칭보다 먼저 검사; 전용 테스트 |
| 리다이렉트 형태 오탐(G-019 `>>?`가 `2>` 매칭) | Medium | High (실측) | `>`가 숫자/`&` 앞에 오지 않는 stdout 리다이렉트 형태만 인정; 변이 테스트 |
| sprint 상태 저장소 차이로 별칭 파손 | Medium | Medium | sprint 쓰기는 pdca 맵이 아닌 sprint SSoT 어댑터로 라우팅; 동등성 불가시 FR-03 경계 허용 |
| 아카이브 자동화가 검증 전 문서를 되돌릴 수 없게 이동 | High | Low | 단계 게이트 통과시에만 실행; 검증이 파일 이동에 선행; `--dry-run` 기본 |
| slash와 Skill-tool 양 경로 동시 발화 이중 쓰기 | Low | Medium | 기존 I-10 중복 제거 키가 교차 경로 중복을 이미 처리 (단위 테스트 5) |

---

## 6. 영향 분석

### 6.1 변경 자원

| 자원 | 유형 | 변경 |
|------|------|------|
| `lib/orchestrator/skill-invocation-effects.js` | Lib | 라우터 별칭 맵 + 아카이브 오케스트레이션 훅 지점 |
| `lib/pdca/lifecycle.js` | Lib | `archiveFeature`에 CLI 도달 래퍼 (시그니처 불변) |
| `scripts/` (신규 어댑터) | 훅 스크립트 | 아카이브 호출 경로 + 가드 어댑터 |
| `hooks/hooks.json` | 설정 | 가드용 PreToolUse 항목 추가 |
| `servers/bkit-pdca-server/index.js` | MCP | `bkit_pdca_status` 문서만 (도구 추가 없음) |
| `skills/pdca/SKILL.md` | 스킬 계약 | 레지스트리 단계 확인 전용화(8단계 이미 트리에서 수정); archive/status 갱신 |
| `lib/control/destructive-detector.js` | Lib | G-019 패턴 수정: 리다이렉트 형태 제외 |

### 6.2 현재 소비자

| 자원 | 연산 | 코드 경로 | 영향 |
|------|------|-----------|------|
| `runSkillInvocationEffects` | 실행 | skill-post.js, user-prompt-expansion-handler.js | 추가적(신규 별칭 분기); 기존 경로 불변 |
| `updatePdcaStatus` | 호출 | gap-detector-stop, iterator-stop, pre-write, lifecycle, batch-orchestrator, full-auto-do | 없음 |
| `archiveFeature` | 호출 | 현재 없음(미연결) | 신규 단일 소비자(공식 아카이브 경로) |
| hooks.json PreToolUse | 로드 | CC 호스트 | 추가 항목; 계약 테스트가 불변식 검증 |
| `bkit_pdca_status` | 읽기 | MCP 클라이언트 | 없음 |
| SKILL.md | 파싱 | check-skills-docs-code-sync.test.js, lint-skill-md.js | 검증 필요 — 동기화 테스트 유지 |

### 6.3 검증

- [ ] 위 소비자 전수 검증
- [ ] 인가/권한 변경 없음
- [ ] 필드 추가/제거로 인한 쿼리 파손 없음

---

## 7. 아키텍처 고려사항

### 7.1 프로젝트 레벨

엔터프라이즈(플러그인 lib 트리) — scripts(어댑터) → lib(도메인) → servers(공개면) 분리 유지.

### 7.2 핵심 결정

| 결정 | 옵션 | 선택 | 근거 |
|------|------|------|------|
| 가드 위치 | 신규 스크립트 / destructive-detector 확장 / state-store 내부 검사 | destructive-detector 확장 + 쓰기 경로 면제 | 단일 규칙 엔진이 모든 진입점(Bash + Write/Edit)을 이미 담당 |
| 아카이브 호출 | CLI 스크립트 / MCP 쓰기 도구 / TaskCompleted 훅 | CLI 스크립트(`--dry-run` 기본) | 저장소 어댑터 패턴 일치; MCP는 읽기 전용 유지; TaskCompleted는 `--summary` 의미를 전달 못 함 |
| 라우터 단계 SSot | 정적 프론트매터 / 별칭 맵 / runtime-guidance 재사용 | `PDCA_ACTION_PHASES` 재사용 + 소형 별칭 표 | #135 선례; 단계 표 중복 없음 |
| MCP 공개 | 신규 도구 / 기존 `bkit_pdca_status` 문서화 | 문서화 + 스킬 텍스트 지침 | 읽기 도구가 이미 존재; 두 번째 도구가 아니라 지시가 필요 |
| `/pdca status` 읽기 경로 | 파일 직접 읽기(현행) / MCP 우선 | MCP 우선 + lib 폴백 | 운영자 지시; lib API는 폴백이자 훅 내부 경로로 유지 |

### 7.3 구조

```
scripts/        → 훅 어댑터 (I/O만: stdin → lib → stdout 판정)
lib/control/    → 가드 규칙 (destructive-detector + 신규 상태 가드 규칙)
lib/pdca/       → 레지스트리 작성기 (status-core, lifecycle) — 유일한 작성기
lib/orchestrator/ → 실행 효과 조합 (진행, 별칭, 아카이브 훅 지점)
servers/        → 읽기 전용 MCP 공개면
skills/         → 계약 (확인 전용 레지스트리 단계, MCP 우선 읽기)
```

---

## 8. 선행 컨벤션

기존 컨벤션 준수(CLAUDE.md, eslint.config.js, node test 독립 실행형 러너).
신규 환경 변수 없음. 파이프라인 통합 해당 없음(플러그인 기능).

---

## Next Steps

1. `/pdca design registry-lockdown` — 아키텍처 옵션 선택
2. `/pdca do registry-lockdown` — FR-02…FR-08 구현
3. `/pdca analyze registry-lockdown` — 갭 분석
4. `/pdca qa registry-lockdown` — L1–L5 검증
5. `/pdca report registry-lockdown` — 완료 보고서
6. `/pdca archive registry-lockdown` — 신규 자동 경로로 첫 아카이브(도그푸드)

---

## Version History

| 버전 | 일자 | 변경 | 작성자 |
|------|------|------|--------|
| 1.0 | 2026-09-07 | 운영자 지시(L4 자율 실행)에 따른 최초 기획 | Claude Code / dizzybeaver |
