# registry-lockdown 완료 보고서

> **요약**: 브로커 전용 PDCA 레지스트리 완성 — 전 라우터 액션의 fire 기반 페이즈 전진,
> 샌션드 아카이브 CLI, 문서 예외가 적용된 G-020 가드, MCP 우선 상태 조회.
>
> **프로젝트**: bkit-claude-code · **버전**: 2.1.38
> **작성**: dizzybeaver (오퍼레이터 지시) / Claude Code
> **완료일**: 2026-09-07 · **브랜치**: fix/misc_fixes_972026 (베이스 `bc86602`)
> **상태**: 완료 — QA_PASS (캐리 1건: CHANGELOG 항목, 아카이브 직후)
> **영문 원본**: registry-lockdown.report.md

---

## Executive Summary

### 1.1 개요

| 항목 | 내용 |
|------|------|
| 피처 | registry-lockdown — 브로커 전용 PDCA 레지스트리 |
| 기간 | 2026-09-07, 단일 세션 L4 자율 사이클 (AskUserQuestion 금지) |
| 피처 커밋 | `2eaacb2` `89e937c` `acebfd9` `9cfab07` `b062840` `3f9f0ba` `ef8e30c` (+기반 `0a59691`) |

### 1.2 결과 요약

| 지표 | 결과 |
|------|------|
| 매치 레이트 | 73.5% → **95.0%** (게이트 ≥90%: PASS, Act 반복 1회) |
| QA 판정 | **QA_PASS** — 피처 TC 86/86 (L1/L2/L3/L5) |
| 전체 배터리 | 5,355 TC, **0 FAIL**, 5 SKIP (99.9%) |
| 사이클 중 수동 레지스트리 기록 | **0건** — 본 사이클 자체가 신규 메커니즘으로 전진됨 |

### 1.3 전달 가치

| 관점 | 내용 |
|------|------|
| **문제** | 에이전트가 `.bkit/state/pdca-status.json`을 손으로 수정한 뒤 페이즈를 건너뛰었고, 유일한 강제장치는 제거된 브로커를 가리키는 머신 로컬 Python 가드 — 제어가 아닌 교착 상태였다. |
| **해법** | bkit 내부에 브로커 기록 경로 완성: 라우터 액션은 fire 시점에 기록, 샌션드 아카이브 CLI가 `lifecycle.archiveFeature`를 감쌈, G-020이 에이전트 상태 기록을 차단(단, `.md`/`.txt` 예외를 최우선 평가), MCP가 읽기 표면. |
| **기능/UX 효과** | 페이즈는 skill fire로만 전진; 한 번의 명령으로 아카이브(dry-run 기본); 문서 작성은 차단되지 않음; 상태 조회는 `bkit_pdca_status` 경유. 훅 비용: 중앙값 ~76–78ms, 최악 82.8ms = 5초 예산의 1.7%. |
| **핵심 가치** | 구조적으로 신뢰 가능한 레지스트리 — 단일 기록자, 검증된 읽기 경로, 모든 설치 환경에 이식 가능 — 실증: 본 사이클이 수동 기록 0으로 Report까지 도달. |

---

## 1.4 성공 기준 최종 상태

| # | 기준 | 상태 | 근거 |
|---|------|:----:|------|
| SC-1 | 전 FR 구현 (FR-01…07) | ✅ | §3.1 참조 (FR-08은 별도 추적) |
| SC-2 | 단위 테스트 통과 | ✅ | L1 31/31 |
| SC-3 | 전체 스위트 그린 | ✅ | `node test/run-all.js` → 5,355 TC, 0 FAIL |
| SC-4 | 문서 갱신 (SKILL.md, MCP 도구, doc-sync) | ✅ | `acebfd9`, `89e937c` (불변식 21 rules / 64 scripts) |
| SC-5 | 시뮬레이션 사이클 수동 기록 0 | ✅ | e2e 11/11; 본 사이클이 실증(도그푸드) |
| SC-6 | 가드: 상태 차단 + 문서 허용 | ✅ | 디텍터 14 TC + 훅 4/4 (`.md` 허용) |
| SC-7 | 린트 에러 0, 신규 억제 없음 | ✅ | 스위트 그린, linting exception 미추가 |
| SC-8 | CHANGELOG 항목 (FR-08) | ⏳ 캐리 | 아카이브 직후 반영, 버전 번호는 메인테이너 소관 |

**성공률**: 측정 가능한 7/7 충족. SC-8은 오퍼레이터 지시로 캐리.

---

## 1.5 의사결정 기록 요약

| 출처 | 결정 | 이행 | 결과 |
|------|------|:----:|------|
| [Plan] | 강제장치를 bkit 내부로 (머신 로컬 아님) | ✅ | G-020을 공유 디텍터에 탑재, shipped 코드에 `~/.claude` 경로 없음 |
| [Design] | 옵션 C — 단일 디텍터 엔진 확장 | ✅ | G-019 수정 + G-020을 한 엔진에, 제2 규칙 엔진 없음 |
| [Design] | lifecycle을 감싸는 CLI 아카이브 (MCP는 읽기 전용 유지) | ✅ | `scripts/pdca-archive.js`; dry-run 기본, 변경 전 게이트 |
| [Design] | 페이즈 테이블은 `PDCA_ACTION_PHASES` + 별칭 맵 | ✅ | 페이즈 테이블 중복 없음 (#135 교훈) |
| [Design] | 매칭 전 예외 평가 | ✅ | `docTargetExempt`가 Write/Edit·Bash 양경로에서 최우선 |
| [Design] | `requireDocs:false`는 라우터 fire에 한함 | ✅ | 정적 페이즈 스킬은 #89 게이트 유지 |

---

## 2. 관련 문서

| 페이즈 | 문서 | 상태 |
|-------|------|------|
| Plan | [registry-lockdown.plan.md](../01-plan/features/registry-lockdown.plan.md) | ✅ 확정 |
| Design | [registry-lockdown.design.md](../02-design/features/registry-lockdown.design.md) | ✅ 확정 |
| Check | [registry-lockdown.analysis.md](../03-analysis/registry-lockdown.analysis.md) | ✅ 95.0% PASS |
| QA | [registry-lockdown.qa-report.md](../05-qa/registry-lockdown.qa-report.md) | ✅ QA_PASS |
| Act/Report | 본 문서 | ✅ 완료 |

---

## 3. 완료 항목

### 3.1 기능 요구사항

| ID | 요구사항 | 상태 | 비고 |
|----|----------|:----:|------|
| FR-01 | 전 라우터 액션의 fire 시점 레지스트리 기록 | ✅ | pdca 완료 (전 액션 + `analyze→check`, `iterate→act`); `ef8e30c`가 필드 리포트 수정 |
| FR-02 | 샌션드 CLI 자동 아카이브 | ✅ | `scripts/pdca-archive.js`; 게이트(completed/≥90%)가 이동 전, `--apply` 필요 |
| FR-03 | Sprint 아카이브 동등성 또는 경계 문서화 | ✅ | 경계 문서화 (수용 편차 #9): sprint는 자체 샌션드 기록자 사용 |
| FR-04 | MCP 우선 상태 공개 | ✅ | SKILL.md status 스텝 + `bkit_pdca_status` 설명 |
| FR-05 | JS 가드의 에이전트 레지스트리 기록 차단 | ✅ | G-020, critical, Write/Edit·Bash 양경로; 차단 안내에 샌션드 경로 명시 |
| FR-06 | 문서 예외 + 리다이렉트 형태 수정 | ✅ | `.md`/`.txt`/`docs/` 최우선; G-019 `(?<![0-9&])>>?`로 stdout 형태만 매칭 |
| FR-07 | FR별 트루 테스트, 변이 검증 | ✅ | Do에서 +35 TC; L2 훅 테스트는 `9cfab07` 전 RED, 후 GREEN |
| FR-08 | CONTRIBUTING.md 준수 CHANGELOG | ⏳ | 아카이브 직후 반영 (버전 번호는 메인테이너 소관) |

### 3.2 비기능 요구사항

| 항목 | 목표 | 달성 | 상태 |
|------|------|------|:----:|
| 훅 성능 | < 5000ms | 중앙값 78.2 / 75.7ms, 최악 82.8ms | ✅ |
| 보안 | 상태 fail-closed, 문서 fail-open, critical 미억압 | L5 40/40 | ✅ |
| 호환성 | API 무변경, 스위트 그린 | 5,355 TC / 0 FAIL | ✅ |
| 이식성 | 머신 로컬 경로 없음 | G-020은 저장소 내부 전용 | ✅ |

---

## 4. 미완료 항목

### 4.1 캐리

| 항목 | 사유 | 우선순위 |
|------|------|----------|
| CHANGELOG 항목 (FR-08) | 아카이브 직후 반영, 버전 번호는 메인테이너가 지정 | High |

### 4.2 수용 편차 (분석 문서 기준)

| # | 편차 | 사유 |
|---|------|------|
| #7 | `git mv` 대신 `renameSync` | EXDEV 동등, git이 rename 감지 |
| #9 | 스킬 텍스트에 sprint 경계 미기재 | 본 문서·분석 문서에 문서화, G-020이 sprint 상태 파일 커버 |
| #11 | 테스트 주석 번호 | 외관상 사소 |

---

## 5. 품질 지표

### 5.1 갭 / 반복 스토리

1차 패스(gap-detector): **73.5%** — Critical 2건(Write 경로가 G-020을 표기만 하고 기록 허용;
감사가 실제 차단과 무관하게 `destructive_blocked` 기록), Important 3건, Minor 4건.
Act 반복 `9cfab07`: deny 액션 판정이 실제 차단, 감사 정직화, 샌션드 경로 안내 추가,
L2 합성-stdin 훅 테스트 신설(RED→GREEN). 2차 재검증: **95.0%** ≥ 90% 게이트 PASS.
Act 반복 1회, 회귀 없음.

| 축 | 구조 | 기능 | 계약 | 의도 | 행위 | 런타임 |
|----|:---:|:---:|:---:|:---:|:---:|:---:|
| 비율 | 98% | 95% | 96% | 92% | 93% | 100% |

### 5.2 QA 측정 레이어 (QA_PASS)

| 레이어 | 결과 |
|--------|------|
| L1 단위 | 31/31 |
| L2 훅 파이프라인 (합성 stdin) | 4/4 |
| L3 e2e 라이프사이클 (fire→archive, 수동 기록 0) | 11/11 |
| L4 성능 | 중앙값 78.2 / 75.7ms, 최악 82.8ms = 5초 예산의 1.7% |
| L5 보안 | 40/40 |
| 전체 배터리 | 5,355 TC, 0 FAIL, 5 SKIP |

브라우저 레이어(Chrome MCP/Playwright)는 UI·HTTP 서버가 없어 해당 없음으로 생략.
실제 CC 내 skill-fire는 미측정; L3가 동일 이펙트 러너로 전 경로 시뮬레이션 (설계 §8.4).

---

## 6. 교훈

### 6.1 잘 된 점
- 실제 훅 스크립트 대상 라이브 프로브(`test/helpers/hook-runner.js`)가 단위 테스트만으로는 놓칠 Critical 버그를 실증적으로 포착.
- Act 수정과 함께 L2 합성-stdin 테스트를 추가하여, 버그를 숨겼던 바로 그 맹점을 영구 회귀 방지망으로 전환.
- 옵션 C의 단일 엔진 설계 덕에 기능 전체가 additive로 유지 — 제2 엔진·드리프트 리스크 없음.

### 6.2 개선점
- Critical 갭의 원인은 훅에 end-to-end(합성 stdin) 테스트가 없었던 것 — lib 단위 테스트만으로는 깨진 파이프라인을 합격으로 인증했다.
- 삭제된 머신 로컬 가드는 수 주간 정당한 작업을 교착시켰다 — 과잉 강제는 무강제보다 나쁘다.

### 6.3 다음에 시도할 것
- 새 가드 규칙은 같은 커밋에 L2 훅 파이프라인 테스트를 동반.
- 본 피처의 아카이브를 `scripts/pdca-archive.js`로 수행 (dry-run 후 `--apply`).

---

## 7. 다음 단계

1. `/pdca archive registry-lockdown` — 신규 CLI가 수행하는 첫 아카이브 (도그푸드).
2. 아카이브 직후: CHANGELOG 항목(미출시 헤딩, 버전은 메인테이너 소관).
3. 오퍼레이터 메모 (QA 발췌, 본 브랜치 결함 아님): 라이브 세션 훅이 한때 `2>/dev/null` 읽기를
   차단 — 브랜치 외부의 구버전 디텍터 사본 추정, 원인 미검증.

---

## 버전 이력

| 버전 | 날짜 | 변경 | 작성 |
|------|------|------|------|
| 1.0 | 2026-09-07 | 전체 업스트림 체인(plan/design/analysis/QA) 기반 완료 보고서 | Claude Code |
