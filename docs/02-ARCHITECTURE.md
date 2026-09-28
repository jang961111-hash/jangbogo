# 02. 설계 — 아키텍처

## 1. 시스템 개요

단일 Next.js(App Router) 앱이 3개 역할을 동시 수행 (해커톤 데모 최적화 모놀리스):

```
┌────────────────────────────────────────────────────────────┐
│  JangBogo (Next.js, Cloud Run 배포 가능)                     │
│                                                            │
│  [대시보드 UI]         [머천트 게이트웨이]      [구매 에이전트]  │
│  온보딩 위저드          /api/m/{id}/catalog    /api/agent/run │
│  주문·정산 뷰   ◄────►  /api/m/{id}/quote  ◄──► 견적 비교      │
│  에이전트 콘솔(SSE)     /api/m/{id}/buy(x402)   정책 엔진      │
│                        mandate 검증기          USDC 지불      │
└───────────────┬────────────────────────────┬───────────────┘
                │ verify tx                  │ transfer
                ▼                            ▼
        ┌──────────────────────────────────────────┐
        │  Solana Devnet  (mock USDC SPL mint)      │
        │  — 폴백: 내장 sandbox 체인 (명시 라벨)       │
        └──────────────────────────────────────────┘
```

LLM: Gemini(`VERTEX_PROJECT` 또는 `GEMINI_API_KEY` 존재 시) — 선택 사유 2문장 생성만 담당. 견적 매칭은 키워드 규칙(`quote.ts`), 선택은 최저 단가 규칙(`agent.ts`)이다. (2026-09-28 정정)
결제 승인·한도 검증은 **항상 결정론적 코드**(프롬프트 인젝션 면역 경계).

## 2. 모듈 설계

```
src/lib/
├── chain.ts      체인 어댑터. devnet(웹3.js) ↔ sandbox(인메모리+파일) 동일 인터페이스
│                 setupDevnet(): payer 키 생성→airdrop→mock USDC mint→에이전트 지갑 충전
│                 transferUsdc(from,to,amount,memo) / verifyPayment(sig,expect)
├── mandate.ts    AP2 준거 mandate. ed25519(tweetnacl) 서명
│                 IntentMandate {principal, agentPubkey, scopeCategories[], budgetUsdc,
│                                expiresAt, humanNotPresent:true} — principal 키 서명
│                 CartMandate {intentHash, merchantId, items[], totalUsdc} — agent 키 서명
│                 verifyMandatePair() → {ok, reason}
├── x402.ts       PaymentRequirements 생성(스킴 exact/solana-devnet/mint/payTo/amount/nonce)
│                 X-PAYMENT 헤더 파싱, 온체인 검증 위임
├── policy.ts     판매자측 결정론 정책: 서명→만료→카테고리→카트 정합성→누적예산 (6단계 온체인 지불 검증은 buy/route.ts)
├── store.ts      JSON 파일 저장(data/db.json): merchants, orders, ledger, mandateSpend
├── agent.ts      구매 에이전트 상태기계: DISCOVER→QUOTE→DECIDE→PAY→RETRY(x402)→RECEIPT
├── llm.ts        Gemini 래퍼(선택 사유 2문장) + 템플릿 폴백. 선택 자체는 agent.ts의 최저 단가 규칙
└── fx.ts         KRW↔USDC 고정 데모 환율(1 USDC = 1,450 KRW, 화면에 '데모 환율' 라벨)
```

## 3. 핵심 플로우 시퀀스

### 3-1. x402 구매 (성공 경로)
```
Agent                    Merchant GW                 Solana Devnet
  │ POST /buy {cart,mandates}  │                          │
  │───────────────────────────►│                          │
  │        402 Payment Required│ (requirements+nonce)     │
  │◄───────────────────────────│                          │
  │ transferUsdc(memo=nonce)   │                          │
  │───────────────────────────────────────────────────────►│ sig
  │ POST /buy + X-PAYMENT{sig} │                          │
  │───────────────────────────►│ getTransaction(sig) 검증  │
  │                            │─────────────────────────►│
  │                            │ 6단계 검증 통과            │
  │   200 {order, receipt}     │ 재고 차감·정산 원장 기록    │
  │◄───────────────────────────│                          │
```

### 3-2. 거절 경로 (네거티브 데모 3종)
- 예산 초과: 누적지출+주문액 > budgetUsdc → 402/403 `MANDATE_BUDGET_EXCEEDED`
- 만료: expiresAt < now → `MANDATE_EXPIRED`
- 범위 밖: 상품 카테고리 ∉ scopeCategories → `MANDATE_SCOPE_VIOLATION`
- (+ 서명 위조, 금액 불일치도 동일 계층에서 거절)

## 4. 데이터 모델

```ts
Merchant { id, name, category, wallet(pubkey), items: Item[], createdAt }
Item     { id, name, priceKrw, priceUsdc, stock, unit, category }
Order    { id, merchantId, itemId, qty, totalUsdc, txSig, agentPubkey,
           intentHash, status: 'paid', explorerUrl, createdAt }
LedgerEntry { orderId, grossUsdc, feeUsdc(0.5%), netUsdc, netKrw, settledAt(sim) }
MandateSpend { intentHash → cumulativeUsdc }   // 판매자측 예산 집행 카운터
```

## 5. 체인 전략 (운영진 공식 권장 준수)

1. 기본: **devnet + 자체 발행 mock USDC**(decimals 6) — faucet 한도 회피, 운영진 권장.
2. airdrop 실패(faucet 한도) 시: sandbox 모드 자동 폴백 — `chain.ts` 인터페이스는 같지만 전송·검증은 파일 DB 안의 모의 원장으로 처리하는 별도 분기, UI에 "SANDBOX" 배지 명시.
3. 키 관리: `data/db.json` 한 파일에 평문 저장 (gitignore). demo 전용, 실자산 없음.

## 6. 기술 스택

Next.js 15 (App Router, TS) · Tailwind CSS · @solana/web3.js + @solana/spl-token ·
tweetnacl(ed25519) · Gemini API(선택) · vitest(단위) + tsx 스크립트(통합) · Docker(Cloud Run)
