# 03. API 스펙

Base: `/api`. 모든 응답 JSON. 에러: `{ error: { code, message } }`.

## 머천트 관리 (대시보드용)

### POST /merchants
가맹점 온보딩. Body: `{ name, category, items: [{name, priceKrw, stock, unit, category}] }`
→ 201 `{ merchant }` (지갑 키페어 서버 생성, pubkey만 노출)

### GET /merchants → `{ merchants: [...] }`
### GET /merchants/{id} → `{ merchant, orders, ledger }`

## 헤드리스 머천트 (에이전트용 공개 엔드포인트)

### GET /m/{id}/catalog
기계용 카탈로그.
```json
{ "protocol": "jangbogo/v1", "payment": ["x402"], "network": "solana-devnet",
  "merchant": {"id","name","category","wallet"},
  "items": [{"id","name","priceUsdc","priceKrw","stock","unit","category"}] }
```

### POST /m/{id}/quote  (A2A 메시지 구조 차용)
Req: `{ "message": { "role": "buyer-agent", "parts": [{"kind":"text","text":"원두 5kg"}],
        "metadata": { "category": "식자재", "maxUnitPriceUsdc": 12 } } }`
Res: `{ "message": { "role": "merchant-agent", "parts": [{"kind":"data","data":{
        "quotes":[{"itemId","name","unitPriceUsdc","qtyAvailable","subtotalUsdc","note"}]}}] } }`

### POST /m/{id}/buy  — x402 플로우
Body: `{ cart: {items:[{itemId, qty}]}, mandates: { intent: IntentMandate, cart: CartMandate } }`

1) `X-PAYMENT` 헤더 없음 → **402**
```json
{ "x402Version": 1, "error": "payment_required",
  "accepts": [{ "scheme": "exact", "network": "solana-devnet",
    "asset": "<mockUsdcMint>", "amount": "12.500000", "payTo": "<merchantAta>",
    "nonce": "<orderNonce>", "memo": "<orderNonce>", "expiresInSec": 300 }] }
```
2) 재요청 + `X-PAYMENT: base64(JSON{ signature, payer })` →
   온체인 검증(금액·수취인·memo=nonce) + 정책 5단 검증 →
   **200** `{ order: {..., txSig, explorerUrl}, receipt: { merchantSigned } }`
   실패 → **403** `{ error: { code: MANDATE_* | PAYMENT_* } }`

## 에이전트·시스템

### POST /agent/run  (SSE 스트림)
Body: `{ goal, categories[], budgetUsdc, maxUnitPriceUsdc?, expiresInDays }`
→ `text/event-stream`: `{step, level, message, data?}` 이벤트 연쇄.
단계: `setup → mandate_issued → discover → quote(가맹점별) → decide → pay → x402_retry → receipt → done|blocked`

### POST /setup
devnet 부트스트랩(멱등): payer airdrop → mock USDC mint → buyer 지갑 충전.
→ `{ mode: "devnet"|"sandbox", mint, buyer: {pubkey, usdc}, ... }`

### GET /state
대시보드 폴링용 전체 상태 스냅샷 `{ mode, merchants, orders, ledger, agentWallet }`

## Mandate 스키마 (AP2 준거 축약)

```ts
IntentMandate {
  ver: "ap2-lite/1", principalPubkey, agentPubkey,
  scopeCategories: string[], budgetUsdc: number,
  issuedAt, expiresAt, humanNotPresent: true,
  sigB58  // principal ed25519 서명(정규화 JSON)
}
CartMandate {
  ver: "ap2-lite/1", intentHash,       // sha256(정규화 intent)
  merchantId, items: [{itemId, qty, unitPriceUsdc}], totalUsdc,
  issuedAt, sigB58  // agent 서명
}
```
검증 순서(결정론): intent 서명 → cart 서명 → intentHash 일치 → 만료 → 카테고리 →
누적예산(MandateSpend) → 온체인 지불금액 = cart.totalUsdc
