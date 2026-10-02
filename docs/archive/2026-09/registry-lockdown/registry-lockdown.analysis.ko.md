# registry-lockdown 갭 분석 (Check 단계, 한국어)

> **기능**: registry-lockdown · **단계**: Check (2차, Act 후) · **일자**: 2026-09-07
> 영어 본문(`registry-lockdown.analysis.md`)의 한국어 짝이며 내용은 동일하다.

## Executive Summary

| 관점 | 내용 |
|------|------|
| **문제** | 구현이 설계가 규정한 브로커 전용 레지스트리를 실제로 구현했는가? |
| **1차 결과** | 73.5% — Critical 1건: Write/Edit 훅 경로가 G-020 탐지를 주석(annotation)으로만 남기고 쓰기를 허용하며, 거짓 `destructive_blocked` 감사 기록 |
| **해결 (Act)** | 커밋 `9cfab07`: deny 액션 탐지 차단(ENH-398 패턴), 감사 정직성, 공식 경로 안내, L2 훅 테스트(RED→GREEN) |
| **최종 판정** | **95.0% ≥ 90% 게이트 통과** (기능 테스트 36/36; 전체 배터리 5,356 TC, 0 FAIL) |

---

## 1차 갭 목록 (73.5%) — 요약

| # | 심각도 | 갭 | 처리 |
|---|--------|-----|------|
| 1 | Critical | Write 경로: 탐지 결과가 자문(advisory)일 뿐 — G-020 탐지 후에도 쓰기 허용 | **수정** `9cfab07`: deny 액션 규칙이 `{block:true}` 판정 반환, main이 공식 경로 안내와 함께 차단 |
| 2 | Critical | 거짓 감사: 쓰기가 실행되는데도 `blocked` 기록 | **수정**: 실제 차단에만 `blocked`; 자문은 `destructive_detected`/`advisory` |
| 3 | Important | CHANGELOG 항목 없음 (FR-08) | **연기** — 아카이브 후 착지 (운영자 지시) |
| 4 | Important | L2 합성-stdin 훅 테스트 없음 (갭 1을 숨긴 사각지대) | **수정**: `registry-lockdown.hooks.test.js` (4 TC) |
| 5 | Important | 차단 안내 부재 — alternativesFor에 G-019/G-020 항목 없음 | **수정**: `/pdca <phase> <feature>`, 아카이브 CLI, `bkit_pdca_status` 안내 |
| 6 | Minor | CLI JSON 필드 드리프트 | **수정**: 설계 §4.1에 정렬 (archivePath, phase) |
| 7 | Minor | git mv 미사용 | **수용**: renameSync+EXDEV 동등 |
| 8 | Minor | 문서 면제가 .md/.txt뿐 | **수정**: docs/ 경로 세그먼트 면제 추가 |
| 9 | Minor | sprint 경계 미기재 | **수용**: 본 문서에 기록 — sprint 아카이브는 자체 공식 작성기 경유, G-020이 sprint 상태 파일 커버 |
| 10 | Minor | 낡은 규칙 수 주석 (8/19 → 실제 21) | **수정** (+ session-context 시작 문자열 — 2차 후 수정) |
| 11 | Minor | 테스트 주석 번호 | **수용**: 표면적 |

## 실측 프로브 (1차)

- 레지스트리 Write (pre-write.js): 주석만, **decision 없음** (Critical 1 확정)
- 상태 경로 산문을 담은 .md Write: **조용히 허용** (면제 종단 확인)
- Bash 레지스트리 쓰기: **차단** (`decision:"block"`)
- 상태 토큰 근처 `2>/dev/null` 읽기: **허용** (G-019 리다이렉트 수정 실측)

## 2차 재검증 (95.0%)

| 축 | 비율 |
|----|:----:|
| Structural | 98% |
| Functional | 95% |
| Contract | 96% |
| Intent | 92% |
| Behavioral | 93% |
| Runtime | 100% (36/36; 배터리 5,356 TC, 0 FAIL) |

모든 Critical/Important 갭이 파일:줄 증거로 수정 확인; 수정이 도입한 기능 회귀 없음.

## 전략 정합성 확인

핵심 문제(손 수정 단계 상태) 해결 ✅ · 계획 성공 기준 4/4 ✅ · 설계 결정 준수 ✅ (이탈 없음)

## 종합 점수

**일치율 95.0%** — 90% 게이트 **통과**.

## 권장 조치

1. `/pdca qa registry-lockdown` 진행
2. `/pdca report registry-lockdown`
3. `/pdca archive registry-lockdown` (신규 CLI 도그푸드)
4. 아카이브 후: CONTRIBUTING.md에 따른 CHANGELOG; 세션 산출물 `work/` 정리

## Next Steps

QA → Report → Archive → CHANGELOG → 정리 (운영자 지시 2026-09-07).

## Version History

| 버전 | 일자 | 변경 | 작성자 |
|------|------|------|--------|
| 1.0 | 2026-09-07 | 1차 갭 목록(73.5%) + Act 수정 + 2차 재검증(95.0%) | gap-detector ×2 / Claude Code |
