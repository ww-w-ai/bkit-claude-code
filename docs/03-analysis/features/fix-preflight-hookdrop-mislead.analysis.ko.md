# fix-preflight-hookdrop-mislead — 갭 분석 (Check 단계)

> **매치율**: 100% (정적 전용 공식: Structural 100 × 0.2 + Functional 100 × 0.4 + Contract 100 × 0.4)
> **기준선**: 90% — 통과
> **날짜**: 2026-09-19
> **생성**: gap-detector 에이전트 (커밋 b0f0533)
> **관련 문서**: [Plan](../../01-plan/features/fix-preflight-hookdrop-mislead.plan.md) · [Design](../../02-design/features/fix-preflight-hookdrop-mislead.design.md)

---

## Context Anchor

| 키 | 값 |
|-----|-------|
| **WHY** | 두 개의 독립 경고가 "2.1.278 > 2.1.220 ⇒ 훅 드롭 ⇒ 레지스트리 정지"라는 허위 인과로 융합되어 무효 br004와 PDCA 정지 초래 |
| **WHO** | bkit 프리플라이트 출력으로 레지스트리/아카이브 장애를 진단하는 다운스트림 Claude 세션 |
| **RISK** | 기존 문자열 단언 테스트 — 사전 grep + 의도적 갱신으로 완화 |
| **SUCCESS** | 양쪽 렌더 경고에 비인과 절 존재, 녹색 테스트로 잠금; CI 게이트 녹색; 아카이브 |
| **SCOPE** | 소스 2파일(문자열만), 신규 테스트 1파일, CHANGELOG; 로직 변경 0 |

---

## 1. 구조 매치 — 100%

| Design §4 항목 | 예상 위치 | 있음 | 근거 |
|---|---|:---:|---|
| §4.1 KNOWN_ISSUES summary 절 | lib/infra/cc-version-checker.js `fork-default-agent-spawn.summary` | ✅ | :123-125 — "subagent-spawn semantics ONLY — this is NOT a hook failure; hooks and /pdca skill fires are unaffected" |
| §4.1 KNOWN_ISSUES detail 전체 절 | 동일 항목 `.detail` | ✅ | :134-137 — "NOT a plugin-hook drop (#57317)... read .bkit/runtime/hook-reachability.json (fresh bash_post/write_post canary stamps = hooks firing)" |
| §4.2 도달성 warnMsg 재작성 | hooks/session-start.js 호출점 | ✅ | session-start.js:450 빌더 위임; 빌더 텍스트(lib/core/hook-reachability.js:114-119) §4.2와 일치 |
| §4.3 신규 테스트 파일 | test/unit/preflight-hookdrop-disambiguation.test.js | ✅ | T-01..T-04 존재 (:37-74) |
| §4.3 테스트 등록 | test/run-all.js | ✅ | run-all.js:171 `unit/preflight-hookdrop-disambiguation.test.js` |
| §4.4 추출 빌더 | `buildReachabilityWarning` 익스포트 | ✅ | lib/core/hook-reachability.js:113-124 (익스포트); session-start.js:429,450 소비 |
| FR-05 CHANGELOG | CHANGELOG.md `## [Unreleased]` | ✅ | CHANGELOG.md:8-19; provisional 헤딩은 scanVersions 건너뜀 |

## 2. 기능 매치 — 100%

- 변경 파일 전체에 placeholder/TODO 없음; 모든 편집은 완성된 문자열 콘텐츠 + 순수 빌더.
- 렌더된 CC 권고(라이브 프로브)에 비인과 절, 증거 파일 경로, 카나리 의미론, `/bkit` + 가이드 포인터 포함 — Plan §4.1 FR-01/FR-02 의도와 일치.
- 렌더된 도달성 경고에 증거 경로(`.bkit/runtime/hook-reachability.json`), 카나리 상관 규칙("a real drop takes the bash_post/write_post canaries down too; FRESH canary stamps mean hooks ARE firing"), 진단 포인터("suspect skipped /pdca <phase> skill fires, not a hook drop"), v2114 문서 참조 포함 — FR-03과 일치.
- 세션 감사 호출과 try/shouldWarn 가드 미변경(session-start.js:415-454) — 동작 형태 불변 유지.
- 로직 변경 0 확인: 빌더는 순수 문자열 조합; 렌더러(hooks/startup/preflight.js:49-74)는 새 summary 텍스트 소비 외 변경 없음.

## 3. 계약 매치 — 100%

| 계약 항목 | 설계 | 구현 | 판정 |
|---|---|---|:---:|
| `buildReachabilityWarning` 시그니처 | `(missing, stale, reachFile)` — 3 인자 | lib/core/hook-reachability.js:113 정확 일치 | ✅ |
| 빌더 소비자 | session-start 호출점 | session-start.js:450 `buildReachabilityWarning(missing, stale, reachFile)` | ✅ |
| 빌더 익스포트 | named export, 테스트 임포트 가능 | hook-reachability.js:122-128 `module.exports` 포함 | ✅ |
| 테스트 소비자 | 빌더 직접 임포트 | 테스트 :33 lib/core/hook-reachability에서 require | ✅ |
| 렌더러 조합 | `summary` 그대로 렌더 | preflight.js:68 `i.summary` 매핑; 프로브 출력에 절 인라인 확인 | ✅ |

## 4. 설계 편차 (선언됨, 수용)

`buildReachabilityWarning`은 §4.4 스케치(hooks/session-start.js)와 달리 lib/core/hook-reachability.js에 위치. 사유: session-start.js는 main-guard가 없고 `process.exit(0)`(:538)을 호출하므로 테스트에서 require하는 것이 안전하지 않음. 빌더는 순수 함수이며 hook-reachability.js가 자연스러운 도메인 모듈(#126 평가기가 이미 거주). 편차는 구조적 위치에 한정; 시그니처·텍스트·소비자는 설계와 정확히 일치. 테스트 파일 헤더(:14-17)와 session-start.js:447-449에 기록됨.

## 5. 런타임 검증 (L1)

**대상 단위 실행** (`node --test test/unit/preflight-hookdrop-disambiguation.test.js test/unit/cc-version-checker.test.js test/unit/preflight.test.js test/unit/hook-reachability.test.js`):
36 테스트, 36 통과, 0 실패, exit 0. 파일별: hookdrop-disambiguation 4/4 (T-01..T-04), hook-reachability 11/11, 나머지 21개는 cc-version-checker + preflight 스위트. 전체 배터리: 메인 세션 1984 unit TC ALL PASS (주어진 증거).

**T-06 라이브 프로브** (exit 0):
- 렌더된 권고: `CC v2.1.278: fork mode ... (subagent-spawn semantics ONLY — this is NOT a hook failure; hooks and /pdca skill fires are unaffected). bkit recommends v2.1.220; run /bkit or see docs/06-guide/cc-compatibility.guide.md ...`
- 렌더된 도달성 경고: 증거 경로, 카나리 규칙, 스킬-파이어 포인터, v2114 참조 모두 존재.

## 6. Plan 성공 기준

| 기준 | 상태 | 근거 |
|---|:---:|---|
| §4.1 FR-01/02/03 구현 | ✅ 충족 | 상기 §1 표 |
| §4.1 FR-04 테스트 녹색 + 등록 | ✅ 충족 | run-all.js:171; 4/4 통과 |
| §4.1 FR-05 CHANGELOG 항목 | ✅ 충족 | CHANGELOG.md:8-19 |
| §4.1 이중언어 문서 쌍 | ✅ 충족 | plan/design `.ko.md` 형제 존재; 본 분석도 `.en.md`/`.ko.md` 쌍으로 발행 |
| §4.1 CI 게이트 녹색 | ✅ 충족 (주어진 증거) | 메인 세션이 버그픽스 웨이브 게이트 녹색 보고 (본 커밋 포함) |
| §4.1 플러그인 캐시 동기화 | ⚠️ 여기서 미검증 | 본 Check 파일 범위 밖; 부모 세션 확인 필요 |
| §4.1 아카이브까지 PDCA 완료 | ⏳ 진행 중 | 본 Check가 해당 사이클의 단계 |
| §4.2 신규 린트 에러 0 | ✅ 충족 (주어진 증거) | ESLint v10.11.0 버그픽스 웨이브 클린 (커밋 52bf736) |
| §4.2 전체 단위 배터리 녹색 | ✅ 충족 (주어진 증거) | 1984 unit TC ALL PASS (메인 세션) |

## 7. 갭 목록

| # | 심각도 | 항목 | 처리 |
|---|---|---|---|
| — | Critical | 없음 | — |
| — | Important | 없음 | — |
| 1 | Minor | 빌더 위치가 설계 §4.4 스케치와 다름 (lib/core/hook-reachability.js vs hooks/session-start.js) | 수용된 편차, 코드 + 테스트 헤더에 기록; 원하면 아카이브 시 설계 문서 갱신 |
| 2 | Minor | Plan §6.3 "문자열 콘텐츠 외 동작 변경 없음" 체크박스가 Plan 내 미검증 | 여기서 검증: 빌더 순수, 렌더러 무변경, 36/36 + 1984 TC 녹색 |

## 8. 결론

반복(iterate) 불필요. 매치율 100% ≥ 90% — QA 단계로 진행 (`/pdca qa fix-preflight-hookdrop-mislead`).
