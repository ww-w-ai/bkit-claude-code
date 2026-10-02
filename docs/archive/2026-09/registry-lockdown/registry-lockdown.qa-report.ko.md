# registry-lockdown QA 보고서

**Version:** 1.0
**Date:** 2026-09-07
**Feature:** registry-lockdown
**실행 주체:** bkit:qa-lead (L4 자율 실행 — AskUserQuestion 금지)
**설계 문서:** docs/02-design/features/registry-lockdown.design.md §8
**브랜치:** fix/misc_fixes_972026 · **Node:** v20.19.2 (lookbehind 지원)
**영문 형제 파일:** registry-lockdown.qa-report.en.md

---

## 판정: QA_PASS

| 기준 | 임계값 | 측정값 | 결과 |
|---|---|---|---|
| 피처 레이어 통과율 | >= 95% | 100% (86/86 TC) | PASS |
| 배터리 통과율 | >= 95% | 99.9% (5350/5355, 0 FAIL) | PASS |
| Critical 발견 항목 | 0 | 0 | PASS |
| L1 단위 테스트 | 100% | 31/31 | PASS |
| L2 훅 파이프라인 | >= 95% | 4/4 | PASS |
| L3 e2e 라이프사이클 | >= 90% | 11/11 | PASS |
| L4 성능 (훅 실행 시간) | < 5000 ms | 최악 82.8 ms | PASS |
| L5 보안 | >= 90% | 40/40 | PASS |

---

## 측정된 것 vs 측정되지 않은 것

**측정됨:** L1 단위 스위트 (3개 파일, 31 TC), L2 합성 stdin 훅 파이프라인 (4 TC),
L3 시뮬레이션 fire-to-archive 라이프사이클 (11 TC), L5 가드/보안 스위트 (40 TC),
L4 훅 호출 실행 시간 (훅당 7회), 전체 배터리 (`node test/run-all.js`, 5355 TC).

**측정되지 않음 (0%가 아닌 "측정 안 됨"으로 명시):**

- Chrome MCP / Playwright 브라우저 레이어 — **스킵, 해당 없음**: UI 없음, HTTP 서버
  없음, Chrome MCP 미연결. 실패가 아닌 사유와 함께 스킵으로 기록. 동일 사유로
  Chrome capability 프로브(Phase 2.5)도 수행하지 않음.
- 실제 Claude Code 내 `/pdca` 스킬 발화 — **측정 안 됨**; L3은 훅이 사용하는 동일한
  effects 러너를 통해 CC 프로세스를 제외한 전체 경로를 시뮬레이션함 (설계 §8.4).
- 배터리의 스킵 5건 (성능 4, 계약 1)은 개별 식별하지 않음 — 본 피처의 스위트에는
  해당 없음 (전체 0 FAIL).
- 런타임 로그 증거 수집(qa-monitor) — **스킵**: 관찰 대상 실행 중 서비스 없음
  (서버 없음; 훅은 단명 프로세스).

---

## 레이어별 결과 (요약 라인 원문)

### L1 단위 — 31/31 PASS

```text
destructive-detector.registry-lockdown.test.js: 14 passed, 0 failed
pdca-archive-cli.test.js: 7 passed, 0 failed
skill-invocation-effects.test.js: 10 passed, 0 failed
```

### L2 훅 파이프라인 (실제 훅 스크립트에 합성 stdin 주입) — 4/4 PASS

```text
registry-lockdown.hooks.test.js: 4 passed, 0 failed
```

설계 §8.3 커버: 레지스트리 Write는 `/pdca` 스킬 발화 경로를 안내하는 차단,
레지스트리 경로 문구를 포함한 `.md` 문서 쓰기는 엔드투엔드 허용, Bash 레지스트리
쓰기도 차단 (Write 경로와 패리티).

### L3 E2E 라이프사이클 — 11/11 PASS

```text
registry-lockdown.e2e.test.js: 11 passed, 0 failed
```

수동 레지스트리 쓰기 0으로 fire-to-archive 완주, 격리 임시 프로젝트 (issue-135 방식).

### L4 성능 — PASS

프로브 `/tmp/l4-hook-perf.js`: 훅 호출 전체(spawn + 실행 + 종료)를 hrtime으로
측정, 페이로드는 L2와 동일, 훅당 7회, 예산 = 5000ms PreToolUse 타임아웃.

```text
pre-write.js         : cold=79.0ms warm-min=75.3ms warm-median=78.2ms warm-max=82.8ms
unified-bash-pre.js  : cold=79.2ms warm-min=71.2ms warm-median=75.7ms warm-max=76.4ms
```

관측된 최악 값 82.8 ms = 예산의 1.7%; 측정 중 차단 판정 확인됨.

### L5 보안 — 40/40 PASS

```text
destructive-rules.test.js: Total: 25 | Pass: 25 | Fail: 0
security-by-default-v2.test.js: 15/15 PASS, 0 FAIL, 0 SKIP
```

---

## 전체 배터리 (`node test/run-all.js`)

종료 코드 0. 최종 요약 라인 원문:

```text
> Total: 5355 TC, 5350 PASS, 0 FAIL, 5 SKIP
|  **Total**  | **5355** | **5350** | **0** | **5** | **99.9%** |

**ALL TESTS PASSED** - bkit v2.1.38 is ready for release.
```

피처 스위트 5개 모두 배터리 내에서 0 FAIL로 통과 (unit 3개, integration 2개).
배터리가 docs/04-report/features/bkit-v200-test.report.md를 재작성했으며,
실행 직후 `git checkout --`로 복원 확인함.

---

## 후속 작업 (Carry Items)

1. **CHANGELOG 항목** — 아카이브 이후 추가 예정; 미출시(unreleased) 헤딩 사용,
   버전 번호는 프로젝트 규칙에 따라 유지보수자가 지정 (에이전트 버전 bump 금지).
2. **수용된 설계 이탈** (docs/03-analysis/registry-lockdown.analysis.md):
   - #7 (Minor, 수용): 문서 이동에 `git mv` 미사용 — `renameSync` + EXDEV 동등물,
     git이 rename을 감지함.
   - #9 (Minor, 수용): FR-03 스프린트 경계를 스킬 텍스트에 미반영 — 스프린트
     아카이브는 자체 승인된 writer
     (`lib/application/sprint-lifecycle/archive-sprint.usecase.js`)로 흐르며,
     G-020이 스프린트 상태 파일을 커버함.
   - #11 (Minor, 수용): 테스트 주석 번호 체계, 외관상 문제.
3. **관찰 기록 (본 브랜치의 결함 아님):** QA 중 이 세션 자신의 읽기 전용 Bash 호출
   (`cat <registry> 2>/dev/null | head`)이 라이브 세션 훅에 의해 G-019로 차단됨.
   본 브랜치의 L1/L2 스위트는 수정된 디텍터가 디스크립터 리다이렉트 읽기 형태를
   허용함을 증명하며, 라이브 훅은 본 브랜치 수정 이전의 디텍터 사본을 사용한 것으로
   보임. 원인은 세션 내 미검증 — 오퍼레이터 참고용 기록.

---

*2026-09-07 bkit:qa-lead가 이 세션의 실제 테스트 실행으로부터 생성함.*
