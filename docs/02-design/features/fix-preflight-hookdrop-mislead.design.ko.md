# fix-preflight-hookdrop-mislead 설계 문서

> **요약**: 두 세션 시작 경고 이미터의 정밀한 문구 변경 + 내용 어서션 회귀 테스트로, 프리플라이트 계층이 "최신 CC 버전 = 훅 드롭"으로 오독될 수 없게 합니다.
>
> **프로젝트**: bkit-claude-code · **날짜**: 2026-09-19 · **상태**: 승인 (옵션 C, L4 자동 선택)

---

## Context Anchor

| 키 | 값 |
|----|-----|
| **WHY** | 두 독립 알림이 "2.1.278 &gt; 2.1.220 이면 훅 드롭, 레지스트리 정체"로 융합되어 무효 br004와 PDCA 정체 초래 |
| **WHO** | bkit 프리플라이트 출력으로 레지스트리/아카이브 실패를 진단하는 다운스트림 세션 |
| **RISK** | 구 문자열 어서션 테스트 — 사전 grep + 의도적 갱신으로 완화 |
| **SUCCESS** | 두 경고 모두 명확화 조항 포함(테스트 잠금), CI 그린, 아카이브 |
| **SCOPE** | 소스 2개 파일(문자열만), 신규 테스트 1개, CHANGELOG; 로직 변경 0 |

---

## 1. 개요

### 1.1 목적

- CC 버전 알려진 이슈 알림: 측정된 이슈(Agent 도구 fork 의미론)는 훅 실패가 아니며, 버전-추천 비교는 훅 드롭의 증거가 아님을 명시.
- 도달성 경고: 증거 파일 지목, 카나리아 상관 규칙 명시, 정체 레지스트리의 비훅 원인(/pdca 페이즈 파이어 생략) 지목.

### 1.3 관련 문서

- 계획: docs/01-plan/features/fix-preflight-hookdrop-mislead.plan.ko.md
- 종결 보고: br004b
- lib/core/hook-reachability.js (#126)

---

## 2. 범위

### 2.1 범위 내

- [ ] lib/infra/cc-version-checker.js — fork-default-agent-spawn: summary 컴팩트 조항 + detail 장문 조항
- [ ] hooks/session-start.js — warnMsg 재작성
- [ ] test/unit/preflight-hookdrop-disambiguation.test.js — 신규
- [ ] CHANGELOG.md — Unreleased 항목

### 2.2 범위 외

게이트/상태머신/훅 디스패치 로직; RECOMMENDED_VERSION; 항목 존재; python_infrastructure 복구.

---

## 3. 아키텍처 (옵션 C)

| 결정 | 선택 | 근거 |
|------|------|------|
| 조항 위치 | summary + detail | 렌더 라인이 다운스트림이 실제 읽는 것 |
| summary 길이 | 약 200자 이내 | 경고 신뢰 예산 |
| 도달성 텍스트 | warnMsg 전체 재작성 | 리프 문자열, 소비자 1개 |
| 테스트 | 내용 어서션 + buildReachabilityWarning 추출 | 훅 생성 없이 검증 가능 |

### 데이터 흐름 (변경 없음)

```
KNOWN_ISSUES[0].summary → checkCCVersion().knownIssues → renderCCVersionWarning
hook-reachability.json → evaluateReachability → session-start.js warnMsg
```

---

## 4. 상세 설계

### 4.1 cc-version-checker.js

summary에 "(subagent-spawn semantics ONLY — this is NOT a hook failure; hooks and /pdca skill fires are unaffected)" 추가. detail에 전체 비인과 조항 + 증거 파일 안내 추가.

### 4.2 session-start.js

warnMsg에 증거 경로(reachFile), 카나리아 규칙("실제 드롭은 bash_post/write_post도 함께 죽임; 최신 카나리아 스탬프 = 훅 작동 중"), 진단 포인터("카나리아 최신 + 레지스트리 정체 이면 /pdca 페이즈 파이어 생략 의심") 포함.

### 4.3/4.4 테스트 + 추출

buildReachabilityWarning(missing, stale, reachFile)를 session-start.js에서 named export로 추출(동작 동일), 테스트가 직접 임포트. 테스트 T-01~T-04는 regex 내용 어서션.

---

## 5. 테스트 계획

| ID | 레벨 | 내용 | 기대 |
|----|------|------|------|
| T-01 | L1 | KNOWN_ISSUES 조항 | 정규식 일치 |
| T-02 | L1 | renderCCVersionWarning 출력 | "NOT a hook failure" 포함 |
| T-03 | L1 | behind-recommended 분기 보존 | 업그레이드 조언 렌더 |
| T-04 | L1 | buildReachabilityWarning | 증거 경로 + "skill fires" 포함 |
| T-05 | L1 | 기존 배터리 회귀 없음 | run-all --unit |
| T-06 | 라이브 | 실제 checkCCVersion + 렌더 | 조항 가시 |

---

## 6. 구현 가이드

1. 구 문자열 grep 후 테스트 어서션 열거
2. 두 이미터 편집 + 빌더 추출
3. 테스트 작성 + run-all.js 등록
4. node test/run-all.js --unit + eslint + CI 게이트
5. CHANGELOG Unreleased
6. 설치 캐시 동기화(백업 선행)
7. T-06 라이브 프로브 후 Check - QA - Report - Archive

---

## 9. 세션 가이드

단일 세션 범위(module-1): 약 120줄.

---

## 버전 이력

| 버전 | 날짜 | 변경 | 작성자 |
|------|------|------|--------|
| 0.1 | 2026-09-19 | 초기 설계 (옵션 C) | dizzybeaver (agent) |
