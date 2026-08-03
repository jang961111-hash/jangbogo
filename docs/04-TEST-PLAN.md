# 04. 테스트 계획

## 단위 테스트 (vitest — `npm test`)

| ID | 대상 | 케이스 |
|---|---|---|
| U1 | mandate.ts | 정상 서명 생성→검증 통과 |
| U2 | mandate.ts | intent 서명 위조 → 거절 |
| U3 | mandate.ts | cart의 intentHash 불일치 → 거절 |
| U4 | policy.ts | 만료된 mandate → MANDATE_EXPIRED |
| U5 | policy.ts | 카테고리 범위 밖 → MANDATE_SCOPE_VIOLATION |
| U6 | policy.ts | 누적지출+주문 > 예산 → MANDATE_BUDGET_EXCEEDED |
| U7 | policy.ts | 경계값: 누적+주문 = 예산 → 통과 |
| U8 | x402.ts | 402 requirements 생성/파싱 라운드트립 |
| U9 | fx.ts | KRW→USDC 변환 정밀도(소수 6자리) |

## 통합 테스트 (`npm run test:integration` — 서버+체인 실구동)

| ID | 시나리오 | 기대 |
|---|---|---|
| I1 | setup → 온보딩 3가맹점 → catalog/quote 조회 | 200, 견적 반환 |
| I2 | 자율 구매 풀사이클(mandate 발급→견적 3건→결제→x402 재시도→영수증) | 주문 확정 + tx 검증 통과 |
| I3 | 예산 초과 구매 시도 | 403 MANDATE_BUDGET_EXCEEDED, 주문 미생성 |
| I4 | 만료 mandate | 403 MANDATE_EXPIRED |
| I5 | 범위 밖 카테고리 | 403 MANDATE_SCOPE_VIOLATION |
| I6 | 지불 금액 < 주문 금액 (악의적 과소 지불) | 403 PAYMENT_AMOUNT_MISMATCH |
| I7 | 동일 tx 서명 재사용(리플레이) | 403 PAYMENT_REPLAYED |

devnet 불가 시 sandbox 모드로 동일 스위트 실행(모드는 리포트에 명기).

## QA (브라우저 — 06-QA-REPORT.md에 결과 기록)

- 온보딩 위저드 → 가맹점 생성 → 엔드포인트 URL 표시
- 데모 콘솔에서 에이전트 실행 → 로그 스트림 → 주문·정산 반영
- tx 해시 링크가 Solana Explorer(devnet)로 연결
- 네거티브 데모 버튼 3종 동작
- 반응형(데스크톱 기준) · 로딩/에러 상태
