# 06. QA 리포트

QA 일시: 2026-08-03 · 환경: macOS · Node 26 · 브라우저(localhost:3402) · 체인 모드: **devnet** (1차 QA는 sandbox, 이후 faucet 수령 후 devnet 재검증 완료)

## ✅ Devnet 실트랜잭션 검증 (최종)

- faucet 5 SOL 수령(GitHub 인증) → **sandbox → devnet 자동 전환 성공** (mock USDC mint `8VTrHAV23qKjjCoE8CZ7KhaCWP6znAikKgb8yoKpA6AD` devnet 발행)
- 에이전트 풀사이클 6.3s 완주, 실제 온체인 결제. Solana Explorer 확인 결과:
  - Status **Success / Finalized**, TransferChecked **65.517240** mock USDC → 성수 로스터리 ATA
  - **Memo = 주문 nonce** (`ord_msd6yf8u…`) 온체인 바인딩 확인
  - tx: `5yqKUxtroZiKAFfavT6sLZwgb9BuFxdP881vgtTKBBPPbrjezxoGyMFL4wZyzYYRDvBzxBA7qZTJp21hTNSVFPEq` (2026-08-03 21:14 KST)
- **통합 테스트 20/20을 devnet 모드로 재실행 전부 통과** (과소지불 공격도 실제 온체인 검증으로 거절)
- 대시보드: Devnet 배지·Explorer 링크 정상, 기존 sandbox 주문은 sandbox 라벨로 구분 표시

## 자동화 테스트

| 스위트 | 결과 |
|---|---|
| 단위 (vitest, 11 케이스 — 서명 위조·만료·범위·예산 경계값·카트 단가 조작·헤더 라운드트립·환율 정밀도) | **11/11 통과** |
| 통합 (I1~I7, 20 체크 — 카탈로그/견적·풀사이클·네거티브 3종·과소지불 공격·리플레이 공격) | **20/20 통과** |

## 브라우저 QA (수동 클릭스루)

| 시나리오 | 결과 |
|---|---|
| 첫 접속 자동 부트스트랩(키 생성·시딩) + 모드 배지 표시 | ✅ |
| 에이전트 실행 풀사이클: mandate 발급 → 가맹점 4곳 탐색 → 견적 3건 비교(성수 13.10 / 제주 14.14 / 강릉 14.83 USDC) → 최저가 선택+사유 → 402 수신 → USDC 전송 → 주문 확정·영수증 — 1.1s, 사람 승인 0회 | ✅ |
| 헤더 지갑 잔액 실시간 갱신 (921.38 → 855.86 USDC) | ✅ |
| 네거티브: 예산 초과(50 USDC 위임으로 65.52 주문) → `MANDATE_BUDGET_EXCEEDED` 결제 전 차단, 잔액 불변 | ✅ |
| 네거티브: 만료·범위 밖 — 통합 테스트로 검증(I4·I5) | ✅ |
| 가맹점 온보딩(을지로 베이커리) → 즉시 엔드포인트 발급 + 목록 반영 | ✅ |
| 재고 차감 반영 (성수 블렌드 120→110kg, 주문 2건 × 5kg) | ✅ |
| 주문·정산 탭: 총 거래액 131.03 / 수수료 0.66(0.5%) / 정산 130.38 USDC ≈ ₩189,050 | ✅ |
| 카탈로그 엔드포인트 JSON 응답 | ✅ (통합 I1) |

## 발견 및 수정한 결함

1. **예산 초과 상세 메시지가 micro 원시값으로 노출** (`누적 0 + 주문 65517240 > 예산 50000000`) → USDC 단위 포맷으로 수정 후 단위 테스트 재통과 확인. (`src/lib/policy.ts`)
2. **sandbox→devnet 자동 복귀 실패 버그**: sandbox 폴백 시 저장된 placeholder mint 주소가 base58 파싱에 실패해 devnet 셋업이 무한 폴백 → placeholder 감지 시 실제 mint 재발행하도록 수정, 라이브 전환으로 검증 완료. (`src/lib/chain.ts`)

## 알려진 제약 (정직 고지)

1. ~~devnet 미전환~~ → **해소**: faucet 수령 후 자동 전환·실트랜잭션 검증 완료 (상단 최종 검증 참조).
2. ~~Gemini 미사용~~ → **해소**: `GEMINI_API_KEY` 설정 후 `사유(gemini)` 생성 확인 (모델
   `gemini-flash-latest` — 구버전 모델이 신규 계정에 404라 latest 별칭으로 변경). Gemini 사유 +
   devnet 실결제 풀사이클 11.1s 완주 검증 (2026-08-03).
3. ~~Cloud Run 미배포~~ → **해소**: 라이브 배포·검증 완료 (2026-08-03 밤).
   - **라이브 URL: https://jangbogo-748897460867.asia-northeast3.run.app** (서울 리전, SOLANA 프로젝트)
   - 라이브에서 devnet 실결제 풀사이클 5.3~10.5s 완주 + `사유(gemini)` 생성 확인
   - 배포 중 발견·수정한 결함 2건:
     (a) 프록시 뒤 self-fetch 실패 → `SELF_URL` 루프백 도입 (`agent/run/route.ts`)
     (b) AI Studio 키 무료 티어가 데이터센터 IP에 미적용(429) → **Vertex AI 전환**
         (메타데이터 서버 토큰 + `gemini-3-flash-preview` global 엔드포인트, `llm.ts`) —
         로컬은 기존 API 키 경로 유지(폴백 체인: Vertex → API 키 → 결정론)

## 제출 전 잔여 작업 (권장)

- [x] payer에 devnet SOL 입금 → devnet 전환 라이브 확인 → Explorer 검증 완료 (2026-08-03)
- [x] `GEMINI_API_KEY` 설정 후 Gemini 사유 생성 확인 완료 (2026-08-03)
- [x] Cloud Run 배포 → 라이브 URL 검증 완료 (2026-08-03)
- [x] 프로덕트 소개서 PPT 10장 완성 (`submission/장보고_소개서.pptx`, 수익모델 포함)
- [ ] 데모 영상 녹화
- [ ] PPT에 라이브 URL 추가 반영 (선택)
