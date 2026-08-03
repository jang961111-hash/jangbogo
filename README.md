# ⛵ 장보고 (JangBogo) — Agent Commerce Gateway

> **"상품 목록만 붙여넣으면, 5분 만에 당신의 가게가 AI 에이전트에게 물건을 파는 헤드리스 상점이 됩니다."**
>
> Google x Solana AI Agentic Hackathon 제출작.
> 가맹점 → x402 결제 엔드포인트 자동 발급 + **판매자측 AP2 mandate 검증**(신뢰 레이어) + A2A 견적 교환 + Solana devnet USDC 정산.

## 왜 장보고인가

- 에이전트 커머스의 병목은 구매자가 아니라 **판매자**다: 33만 VAN/PG 가맹점 중 에이전트 고객을 받을 수 있는 곳은 0곳.
- 자율 결제가 열리는 순간 가맹점의 질문은 "이 에이전트를 믿어도 되나" — 장보고는 **가맹점이 직접 위임장(AP2 mandate)을 검증**하고, 예산·범위·만료를 어기는 주문은 결제 전에 거절한다.
- 검증은 전부 **결정론적 코드**로: 프롬프트 인젝션은 근본적으로 완전 방어가 불가능하므로(arXiv:2605.17634), 한도 집행은 LLM 판단이 아닌 정책 엔진이 한다. LLM(Gemini)은 견적 비교 사유 서술에만 쓴다.

## 데모 (3분)

**🌐 라이브: https://jangbogo-748897460867.asia-northeast3.run.app** (Cloud Run 서울 · devnet 실결제 · Vertex AI Gemini)

```bash
npm install && npm run dev   # 로컬: http://localhost:3402
```

1. **에이전트 콘솔** 탭 → `▶ 에이전트 실행` — "카페 블렌드 원두 5kg" 조달을 mandate 발급 → 3개 가맹점 A2A 견적 비교 → 최저가 선택 → x402(402→USDC 지불→검증) → 영수증까지 **사람 승인 0회**로 완주. 전 과정 로그 실시간 스트리밍.
2. **네거티브 데모 3종** — 예산 초과/만료 위임장/범위 밖 구매가 **결제 이전에** 거절되는 것을 확인 (자금 미이동).
3. **주문·정산** 탭 — 트랜잭션 해시(Explorer 링크), 수수료 0.5% 차감, 원화 정산 시뮬레이션.
4. **가맹점** 탭 — 새 가맹점을 직접 온보딩해 즉시 에이전트 상점 엔드포인트 발급.

## 프로토콜 스택 (3-프로토콜 풀 데모)

| 레이어 | 구현 |
|---|---|
| 신원·의도 증명 | **AP2 준거** Intent/Cart Mandate (ed25519 서명, `ap2-lite/1`) — 판매자측 검증이 차별점 |
| 에이전트 통신 | **A2A 메시지 구조** 차용 견적 교환 (buyer-agent ↔ merchant-agent) |
| 결제 레일 | **x402** (HTTP 402 → X-PAYMENT 재시도), Solana devnet **mock USDC**(운영진 권장), memo=nonce 바인딩, 리플레이 차단 |
| AI | Gemini(선택) — 의사결정 사유 생성. 결제 승인 경로에는 불개입 |

## 테스트

- 단위 11 케이스: `npm test` (서명 위조·만료·범위·예산 경계값·헤더 라운드트립)
- 통합 20 케이스: `npm run test:integration` (풀사이클 + 네거티브 3종 + 과소지불·리플레이 공격)

## 문서

`docs/00-CONTEXT.md`(기획 선정 근거) · `01-PRD` · `02-ARCHITECTURE` · `03-API-SPEC` · `04-TEST-PLAN` · `05-DEPLOY`(Cloud Run) · `06-QA-REPORT`

## 정직 고지

- devnet faucet 한도 시 sandbox 모드로 자동 폴백하며 UI에 명시된다 (동일 코드 경로). payer 지갑에 devnet SOL을 넣으면 자동 복귀.
- 원화 정산은 고정 환율 시뮬레이션. pay.sh는 호환 설계만 반영(실연동 아님). AP2/A2A는 스펙 구조 준거 축약 구현.

## 수익모델

거래 수수료 0.5% + 정산 SaaS(월 29,000원) + (확장) 온체인 매출 이력 기반 선정산 팩토링.
