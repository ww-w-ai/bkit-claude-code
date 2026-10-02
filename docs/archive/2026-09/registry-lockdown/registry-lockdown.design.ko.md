# registry-lockdown 설계 문서 (한국어)

> **요약**: 모든 라우터 액션의 실행 시점 레지스트리 진행, 공식 아카이브 CLI,
> MCP 우선 상태 공개, 문서를 절대 차단하지 않는 이식 가능한 가드.
> 영어 본문(`registry-lockdown.design.md`)의 한국어 짝이며 내용은 동일하다.

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
| **문제** | 레지스트리 쓰기/읽기가 에이전트 손 수정과 파일 직접 읽기로 이루어짐; 봉쇄 장치는 머신 로컬이며 고장 상태 |
| **해결** | 옵션 C: 단일 디텍터 엔진 확장(G-020 + G-019 수정), `lifecycle.archiveFeature` 기반 공식 아카이브 CLI, MCP 우선 공개 |
| **기능/UX 효과** | 스킬 실행이 단계를 진행; 한 명령으로 아카이브; 문서 미차단; `bkit_pdca_status`로 상태 조회 |
| **핵심 가치** | 구조적으로 신뢰 가능한 레지스트리, 모든 설치에 이식 가능 |

---

## Context Anchor

| 키 | 값 |
|-----|-----|
| **WHY** | 손 수정된 단계 상태가 단계 건너뛰기를 가능하게 함; 머신 가드는 보호 대신 교착 |
| **WHO** | 모든 설치에서 PDCA/Sprint/Pipeline을 실행하는 bkit 사용자 |
| **RISK** | 과잉 가드의 교착 재현; 단계 게이트의 조용한 회귀 |
| **SUCCESS** | 전체 주기가 손 수정 없이 `archived` 도달; 가드가 상태 쓰기 차단 + `.txt`/`.md` 허용; 스위트 통과 |
| **SCOPE** | 4개 모듈: 진행 일반화, MCP 공개, 자동 아카이브, 가드 포팅 + 면제 |

---

## 1. 개요

### 1.1 설계 목표

1. 모든 bkit 워크플로에서 손 수정 없는 레지스트리
2. 모든 진입점(Bash, Write, Edit)을 판정하는 단일 규칙 엔진
3. 문서 파일(`.md`, `.txt`)이 상태 가드 규칙에 절대 거부되지 않음
4. MCP 서버가 에이전트용 상태 읽기면

### 1.2 설계 원칙

- **브로커 전용 쓰기**: 유일한 작성기는 훅이 호출하는 lib 함수, 공식 아카이브 CLI, 라이프사이클 기계
- **매칭 전 면제**: 문서 경로 면제를 상태 토큰 논리보다 먼저 평가
- **SSoT 재사용**: 단계 표는 `PDCA_ACTION_PHASES` + 소형 별칭 맵 (#135 교훈)
- **중요부분 fail-closed, 그 외 fail-open**: 상태 쓰기는 오류시 거부; `critical`은 권한 모드로 억제 불가

---

## 2. 아키텍처 옵션

| | 옵션 A — 최소 | 옵션 B — 서비스 계층 | 옵션 C — 실용 균형 (선택) |
|---|---|---|---|
| 가드 | G-019 정규식만 수정 | 신규 state-guard 모듈 + 별도 훅 | destructive-detector 확장(G-020) + 쓰기 경로 면제 |
| 아카이브 | 손 수정 유지 + 문구만 | ArchiveService + MCP 쓰기 도구 | `lifecycle.archiveFeature` 래퍼 CLI |
| 공개 | 스킬 텍스트만 | MCP 리소스 구독 | 스킬 텍스트 + 도구 설명 보강 |
| 복잡도 | 낮음 | 높음(이중 엔진) | 중-저 |
| 노력 | ~0.5일 | ~3일 | ~1일 |
| 위험 | 오탐 잔존, Write/Edit 미커버 | 훅 전반 통합 위험 | 낮음 — 추가 규칙 + 스크립트 1개 |

**선택: 옵션 C.** 계획서 §7.2와 일치. A는 에이전트가 손 수정에 쓰는 Write/Edit 경로를
커버하지 못하고, B는 규칙 엔진을 이중화해 표류를 유발한다.

### 컴포넌트 다이어그램

```
스킬 실행 (Skill tool / slash)
   ├─ PostToolUse(Skill) → skill-post.js ──┐
   ├─ UserPromptExpansion → 확장 핸들러 ───┤
   │                                      ▼
   │      lib/orchestrator/skill-invocation-effects.js (별칭, 아카이브 훅 지점)
   │                                      ▼
   │      lib/pdca/status-core.js · lifecycle.js        [유일한 작성기]
   │   /pdca archive → scripts/pdca-archive.js ─────────┘ (--dry-run 기본)
   ├─ PreToolUse(Bash|Write|Edit) → 어댑터 → lib/control/destructive-detector.js
   │      G-020 레지스트리 쓰기 거부(critical) + 문서 면제(.md/.txt 최우선)
   │      + G-019 리다이렉트 수정 ((?<![0-9&])>>?)
   └─ MCP 클라이언트 → bkit-pdca-server · bkit_pdca_status [읽기 전용]
```

---

## 3. 데이터 모델

스키마 변경 없음. G-020은 훅 입력만 읽는다.

```js
{ id:'G-020', name:'Registry state write',
  면제: /\.(md|txt)$/i — 상태 논리 전 최우선 평가,
  거부: /\.bkit[\\/]state[\\/].+\.(json|jsonl)$/i — 정확한 대상 매칭(부분문자열 아님),
  severity:'critical', defaultAction:'deny' }
```

---

## 4. API 명세

### 신규 CLI: `scripts/pdca-archive.js`

| 항목 | 값 |
|------|-----|
| 명령 | `node scripts/pdca-archive.js <feature> [--summary] [--apply]` (dry-run 기본) |
| 설명 | 게이트 검증 → 문서 이동 → 레지스트리 기록의 공식 아카이브 경로 |
| 매개변수 | `feature`(필수) · `--summary` · `--apply`(변경 시 필수) |
| 성공 | dry-run: 계획 JSON / apply: `{archived:true, archivePath, summaryMode}` |
| 오류 | 2 미등록 · 3 게이트 실패 · 4 문서 누락 |

---

## 5. UI/UX

해당 없음 (UI 없음).

---

## 6. 오류 처리

| 코드 | 의미 | 동작 |
|------|------|------|
| E-GUARD-REGISTRY | 레지스트리 쓰기 시도 | 거부 + 스킬 실행 경로 안내 |
| E-ARCH-NOTFOUND | 미등록 기능 | fail-closed, 파일시스템 변경 없음 |
| E-ARCH-GATE | completed 아님 & <90% | fail-closed |
| E-ARCH-DOCS | 문서 누락 | fail-closed, 누락 목록 보고 |

dry-run은 게이트 평가와 문서 발견만 수행 — 변경 없음.

---

## 7. 보안 고려사항

- G-020은 `critical` — v2.1.37 권한 모드 정책으로 억제되지 않음
- 면제는 대상 확장자 기반, 최우선 평가 — 상태 파일에 악용 불가(`.md` 경로는 레지스트리 경로가 아님)
- G-019 수정은 좁히기만 함(stdout 형태만, `2>`/`&>` 제외)
- 아카이브 CLI는 `--apply` 없이 변경 거부(되돌릴 수 없는 문서 이동)

---

## 8. 테스트 계획

| 계층 | 내용 |
|------|------|
| L1 | 가드 규칙, 별칭, 아카이브 CLI, MCP 문서 — 단위 |
| L2 | 합성 stdin으로 어댑터 파이프라인 종단 |
| L3 | 시뮬레이션 전체 수명주기(fire→archive), 손 수정 0 회 검증 |

모든 신규 테스트는 `mkdtempSync` + `CLAUDE_PROJECT_DIR` 격리(issue-135 교훈).

---

## Detailed Design (상세 설계)

### G-019 리다이렉트 수정

양쪽 분기의 `>>?`를 `(?<![0-9&])>>?`로 교체. `2>`/`1>`/`&>`/`>&`는 기술자
리다이렉트 형태로 취급하지 않는다(실측 오탐 수정). 순수 좁히기 — 이전에 거부된
쓰기가 허용되지 않음을 변이 테스트로 확인.

### G-020 레지스트리 쓰기

1. **면제 최우선**: 대상이 `.md`/`.txt` → 상태 확인 전 `allow`
2. **거부**: 대상이 `.bkit/state/*.json(onl)` → `deny`(critical), 안내: 단계는 스킬
   실행으로만 진행, 읽기는 `bkit_pdca_status` MCP 도구
3. 그 외: 의견 없음(기존 규칙 유지)

Python 원본 가드(`~/.claude/hooks/pdca-guard`)는 의미론만 포팅 — 부분문자열/내용
매칭(문서 파일을 오탐한 원인)을 정확한 대상 매칭으로 교체.

### 아카이브 CLI 흐름

등록 확인 → 게이트(completed 또는 matchRate≥90) → 문서 발견(findDoc) →
dry-run 계획 출력 → `--apply`시 문서 이동 + `_INDEX.md` 갱신 + `archiveFeature`.
레지스트리 쓰기는 오직 `lib/pdca/lifecycle.js` 경유.

### 공개

- `/pdca status` 1단계: `bkit_pdca_status` MCP 도구 우선, MCP 불가시 lib API 폴백(원시 파일 읽기 불가)
- MCP 도구 설명에 "공식 읽기면" 문구 추가

---

## Implementation Order (구현 순서)

1. G-019 리다이렉트 수정 + 테스트
2. G-020 규칙 + 면제 + 단위 테스트
3. 아카이브 CLI + 단위 테스트
4. 스킬 텍스트 갱신(archive 단계, status MCP 우선) + MCP 설명
5. sprint/pipeline 경계 검증(FR-01/FR-03)
6. L3 수명주기 테스트
7. 전체 배터리 + 커밋

---

## 11. 구현 가이드

파일 구조와 모듈 맵은 영어 본문 §11 참조:
module-1 가드 · module-2 아카이브 CLI · module-3 공개/경계 · module-4 L3+배터리.
권장 세션: 단일 세션(약 1일, module 1–2가 임계 경로).

---

## Version History

| 버전 | 일자 | 변경 | 작성자 |
|------|------|------|--------|
| 1.0 | 2026-09-07 | 최초 설계, 옵션 C 선택 | Claude Code / dizzybeaver |
