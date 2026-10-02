# fix-preflight-hookdrop-mislead 완료 보고서

> **Status**: Complete (아카이브 진행 중 — 본 보고서 직후 실행, 원격 푸시는 운영자 지시)
>
> **Project**: bkit-claude-code
> **Version**: 2.1.38 (릴리스 버전은 메인테이너가 지정)
> **Author**: dizzybeaver (agent-executed)
> **Completion Date**: 2026-09-19
> **PDCA Cycle**: fix/misc_fixes_972026

---

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | 소비 세션이 bkit의 서로 독립적인 두 세션 시작 경고를 "CC 2.1.278 > 권장 2.1.220 ⇒ 플러그인 훅 드랍(#57317) ⇒ 레지스트리 qa 정체"라는 단일 인과 사슬로 융합하고, check/report 페이즈를 직접 에이전트 디스패치로 흉내 내어 무효 버그 리포트 br004와 정체된 PDCA 사이클을 만들었다. 트랜스크립트 포렌식(종결된 br004b)은 훅이 정상임(신선한 카나리 스탬프)을 입증했고, 실제 원인은 생략된 `/pdca <phase>` 스킬 파이어였다. |
| **Solution** | 두 경고의 문구를 각각 인과의 문을 닫도록 재작성: KNOWN_ISSUES `fork-default-agent-spawn`에 summary+detail 비인과 조항 추가, 훅 도달성 경고에 증거 파일 경로·카나리 의미론·"/pdca 스킬 파이어 생략 의심" 진단 포인터 추가 (커밋 b0f0533). |
| **Function/UX Effect** | 경고 2/2 명확화, 기존 두 경고 형태 유지(새 소음 없음); 신규 콘텐츠 잠금 테스트 4개, 대상 스위트 36/36 통과, 전체 유닛 배터리 1984 TC 전부 통과, 라이브 프로브에서 두 조항 렌더링 확인. 이후 에이전트는 "카나리 신선 ⇒ 훅 정상 ⇒ 페이즈 파이어 확인"으로 읽게 된다. |
| **Core Value** | 잘못된 범인을 지목하는 경고는 완전한 오진 사이클(br004, 운영자 시간, PDCA 정체)을 초래했다. 이제 프리플라이트 계층이 자기 명확화되고 변이 검증되어 동일 실수가 재발할 수 없다. |

### 1.3 Value Delivered

- **명확화된 경고**: 2/2 (CC 버전 권고 + 훅 도달성 경고)
- **테스트**: 신규 4 TC (run-all.js:171 등록), 대상 36/36 통과, 전체 배터리 1984 TC 전부 통과
- **Check 매치율**: 100% (구조/기능/계약 모두 100); 갭 2건 Minor, 모두 수용
- **QA**: QA_PASS — 변이 RED/GREEN 입증, 캐시 3/3 동일, 라이브 프로브 전 단언 통과, CI 게이트 그린

---

## 1.4 성공 기준 최종 상태

> Plan §4.1 Definition of Done 기준.

| # | 기준 | 상태 | 증거 |
|---|------|:----:|------|
| SC-1 | FR-01/02/03 구현 (두 경고 재작성) | ✅ | b0f0533; 분석 §1 구조 100% |
| SC-2 | FR-04 테스트 그린 + 등록 | ✅ | preflight-hookdrop-disambiguation.test.js 4/4; run-all.js:171 |
| SC-3 | FR-05 CHANGELOG `[Unreleased]` 항목 | ✅ | CHANGELOG.md:8-19 |
| SC-4 | 신규 docs 바일링구엘 페어 (.en/.ko) | ✅ | plan/design/analysis/report 페어 존재 |
| SC-5 | CI 게이트 그린 (purity/guards/docs-sync/test-tracking) | ✅ | b0f0533 포함 버그픽스 웨이브 그린 |
| SC-6 | 플러그인 캐시 동기화 | ✅ | QA diff: 3/3 IDENTICAL |
| SC-7 | 신규 린트 오류 0 | ✅ | ESLint v10.11.0 클린 (52bf736) |
| SC-8 | 전체 유닛 배터리 그린 | ✅ | 1984 TC 전부 통과 (메인 세션) |
| SC-9 | PDCA 아카이브까지 + 원격 푸시 | ⏳ | 아카이브는 본 보고서 직후, 푸시는 운영자 지시 |

**성공률**: 8/9 충족, 1건 진행 중 (SC-9 아카이브/푸시, 보고 시점상 정상)

## 1.5 의사결정 기록 요약

| 출처 | 결정 | 준수? | 결과 |
|------|------|:-----:|------|
| [Plan] | 비인과 조항을 KNOWN_ISSUES summary(요약)와 detail(전문) 모두에 배치 | ✅ | 양쪽 렌더링, T-01 잠금, 라이브 프로브 확인 |
| [Design] | 옵션 C — 현장 문자열 편집 + 콘텐츠 잠금 테스트, 공유 상수 모듈 없음 | ✅ | 메시지별 단일 소스 유지, 계약 100% |
| [Design] | 테스트 가능성 위해 `buildReachabilityWarning(missing, stale, reachFile)` 추출 | ✅ (위치 편차) | hooks/session-start.js가 아닌 lib/core/hook-reachability.js로 추출 — session-start.js는 메인 가드 없이 `process.exit(0)` 호출로 테스트 require 불안전. 문서화됨; 시그니처/텍스트/소비자는 설계와 정확히 일치. Minor 갭 #1로 수용. |

---

## 2. 관련 문서

| 페이즈 | 문서 | 상태 |
|--------|------|------|
| Plan | [fix-preflight-hookdrop-mislead.plan.md](../../01-plan/features/fix-preflight-hookdrop-mislead.plan.md) | ✅ 확정 |
| Design | [fix-preflight-hookdrop-mislead.design.md](../../02-design/features/fix-preflight-hookdrop-mislead.design.md) | ✅ 확정 |
| Check | [fix-preflight-hookdrop-mislead.analysis.ko.md](../../03-analysis/features/fix-preflight-hookdrop-mislead.analysis.ko.md) | ✅ 100% |
| QA | [fix-preflight-hookdrop-mislead.qa-report.en.md](../../05-qa/fix-preflight-hookdrop-mislead.qa-report.en.md) | ✅ QA_PASS |
| Act | 현재 문서 | ✅ 완료 |
| 종결 포렌식 | `bug_reports/completed/BR/br004b-...completed.md` | ✅ 종결 |

---

## 3. 완료 항목

| ID | 항목 | 상태 | 증거 |
|----|------|------|------|
| FR-01 | KNOWN_ISSUES 비인과 조항 (summary + detail) | ✅ | cc-version-checker.js:123-125, 134-137 |
| FR-02 | 중복 문구 없음; 렌더러가 체커 데이터에서 조합 | ✅ | preflight.js:68 `i.summary` 변경 없음 |
| FR-03 | 도달성 경고 재작성 (증거 경로 + 카나리 규칙 + 스킬 파이어 포인터) | ✅ | hook-reachability.js:114-119; session-start.js:450 |
| FR-04 | 콘텐츠 단언 회귀 TC 4개, 등록 완료 | ✅ | run-all.js:171; 변이 RED/GREEN 입증 |
| FR-05 | CHANGELOG `[Unreleased]` 항목 | ✅ | CHANGELOG.md:8-19 |

---

## 4. 미완료 항목

| 항목 | 사유 | 우선순위 | 담당 |
|------|------|----------|------|
| PDCA 아카이브 | 공식 아카이브 CLI를 본 보고서 직후 실행 | 상 | /pdca archive |
| 원격 푸시 | 운영자 지시 다음 단계 | 상 | 운영자 |

---

## 5. 품질 지표

| 지표 | 목표 | 최종 |
|------|------|------|
| 설계 매치율 | ≥90% | 100% (스태틱 전용: S100/F100/C100) |
| 대상 스위트 | 통과 | 36/36 |
| 신규 TC | 등록 | 4/4 |
| 전체 유닛 배터리 | 그린 | 1984 TC 전부 통과 |
| 변이 검증 | RED/GREEN | 입증 (변이 하 T-01/T-02 RED; 복원 후 GREEN) |
| 캐시 동기화 | 동일 | 3/3 파일 |
| Critical/Important 갭 | 0 | 0 |

## 5.2 해결된 이슈

| 이슈 | 해결 | 결과 |
|------|------|------|
| 오도하는 융합 인과 사슬 | 양 경고에 비인과 조항 | ✅ 테스트로 잠금 |
| 테스트 불가한 인라인 warnMsg | 빌더를 lib/core/hook-reachability.js로 추출 | ✅ 테스트 임포트 가능 |

---

## 6. 교훈

### 6.1 잘된 점
- 증거 기반 문구(파일 경로 + 카나리 의미론)는 어떤 독자든 프로브 한 번으로 검증 가능.
- 변이 검증(RED/GREEN)으로 신규 테스트가 우회 통과가 아닌 진짜 테스트임을 입증.
- 소규모 범위로 로직 변경 0 유지 — 1984 TC 배터리에서 회귀 없음.

### 6.2 개선 필요
- 설계 §4.4가 session-start.js의 메인 가드/종료 동작 확인 없이 빌더 위치를 스케치 — Do에서 발견, 선언된 편차 비용.
- 오진 자체: 소비 세션이 한 사이클을 소진하기 전까지 경고 문구에 인과의 문이 없었음 (br004).

### 6.3 다음 시도
- 테스트용 문자열 추출 설계 시 모듈 최상위 동작(가드, exit)을 설계 섹션 작성 전에 확인.
- 동일 오독 가능성에 대해 나머지 KNOWN_ISSUES 항목 감사 (T-01 정규식은 향후 항목에도 확장).

---

## 7. 다음 단계

- `/pdca archive fix-preflight-hookdrop-mislead` 실행 (CLI, dry-run 후 --apply).
- 운영자: fix/misc_fixes_972026 브랜치 원격 푸시.
- 선택: 아카이브 시점에 빌더 위치 편차 노트를 설계 문서에 반영.

---

## 9. Changelog

### Fixed
- 세션 시작 프리플라이트 경고가 더 이상 "버전 > 권장 ⇒ 훅 드랍" 오인과 사슬을 지지하지 않음: `fork-default-agent-spawn` 권고에 명시적 비인과 조항, 훅 도달성 경고에 증거 파일·카나리 의미론·"/pdca 스킬 파이어 생략" 진단 포인터 추가 (b0f0533).

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-09-19 | 완료 보고서 작성 | dizzybeaver (agent) |
